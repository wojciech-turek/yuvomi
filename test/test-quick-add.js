/**
 * Test: Powiedz - ein Satz wird zu einer Aufgabe, einem Termin oder Einkaeufen (Haiku)
 * Zweck: Service `parseQuickAddSentence` mit falschem Claude-Client (kein Netz) und
 *        Route `POST /api/v1/quick-add/parse` (Form `{ data: { source, kind, fields } }`).
 *        Der Router speichert nichts; das passende Blatt oeffnet sich gefuellt.
 *        Der Aufgabenweg bleibt byte-gleich mit `parseTaskSentence` (Mikrofon im
 *        Aufgabenblatt, `POST /tasks/parse`).
 * Ausfuehren: npm run test:quick-add
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { format } from 'node:util';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'quick-add-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: quickAddRouter, createQuickAddRouter } = await import('../server/routes/quick-add.js');
const { parseQuickAddSentence } = await import('../server/services/quick-add.js');
const { parseTaskSentence } = await import('../server/services/task-dictation.js');
const { createClaude } = await import('../server/ai/claude.js');

const moduleDatabase = get();
const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
for (const m of MIGRATIONS) {
  if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
  if (typeof m.afterUp === 'function') m.afterUp(db);
  db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
}
_setTestDatabase(db);
moduleDatabase.close();

function seedUser(name, role = 'member') {
  return db.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES (?, ?, 'hash', '#007AFF', ?)`).run(name.toLowerCase(), name, role).lastInsertRowid;
}
const WOJTEK = seedUser('Wojtek', 'admin');
const MARIOLA = seedUser('Mariola');
const KUCHNIA = seedUser('Kuchnia');
db.prepare('INSERT INTO display_accounts (user_id) VALUES (?)').run(KUCHNIA);
db.prepare(`INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Warsaw')`).run();

/** Ein Claude-Client, dessen "API" `answer` liefert; `sent` sammelt die Anfragen, `features` die Schalter. */
function fakeClaude(answer) {
  const sent = [];
  const features = [];
  const api = { messages: { create: async (params) => {
    sent.push(params);
    if (answer instanceof Error) throw answer;
    return {
      stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 },
      content: [{ type: 'text', text: typeof answer === 'string' ? answer : JSON.stringify(answer) }],
    };
  } } };
  const client = createClaude({
    getApiKey: () => 'k', guard: (feature) => features.push(feature), record: () => {}, clientFactory: () => api,
  });
  return { client, sent, features };
}

/** Eine vollstaendige Antwort: jedes Feld "nicht gesagt". */
const blank = {
  kind: 'task', title: '',
  due_date: '', due_time: '', remind_date: '', remind_time: '', assignees: [], for_speaker: false,
  event_date: '', start_time: '', end_time: '', location: '', reminder_minutes: '', people: [],
  items: [],
};
const answer = (fields) => ({ ...blank, ...fields });
// Donnerstag, 29.10.2026, 11:00 in Warschau.
const NOW = new Date('2026-10-29T10:00:00Z');

async function parse(fields, opts = {}) {
  const fake = fakeClaude(answer(fields));
  const out = await parseQuickAddSentence({
    text: opts.text ?? 'x', userId: opts.userId ?? WOJTEK, kind: opts.kind ?? null, kinds: opts.kinds,
    now: opts.now ?? NOW, database: db, client: fake.client,
  });
  return { out, ...fake };
}

// ---------------------------------------------------------------- service

test('routes "kup mleko i chleb" to shopping; one Haiku call on the dictation switch', async () => {
  const { out, sent, features } = await parse({
    kind: 'shopping', items: [{ name: 'mleko', amount: '' }, { name: 'chleb', amount: '' }],
  }, { text: 'kup mleko i chleb' });
  assert.equal(out.kind, 'shopping');
  assert.deepEqual(out.fields.items, [{ name: 'mleko', quantity: null }, { name: 'chleb', quantity: null }]);
  assert.deepEqual(Object.keys(out.fields), ['items']);
  assert.equal(sent.length, 1, 'one call per sentence');
  assert.deepEqual(features, ['task_dictation']);
  assert.equal(sent[0].model, 'claude-haiku-5-5');
  assert.equal(sent[0].max_tokens, 600);
  assert.equal(sent[0].output_config.effort, 'low');
  assert.deepEqual(sent[0].thinking, { type: 'disabled' });
  assert.match(sent[0].messages[0].content[0].text, /kup mleko i chleb/);
});

test('shopping items: amount kept as said, names trimmed, empty names dropped, at most 20', async () => {
  const { out } = await parse({
    kind: 'shopping',
    items: [{ name: ' sok ', amount: ' 2 l ' }, { name: '  ', amount: '3' }, { name: 'pomidory', amount: '' }],
  }, { text: 'kup 2 l soku i pomidory' });
  assert.deepEqual(out.fields.items, [{ name: 'sok', quantity: '2 l' }, { name: 'pomidory', quantity: null }]);
  const many = Array.from({ length: 25 }, (_, i) => ({ name: `rzecz ${i + 1}`, amount: '' }));
  const { out: capped } = await parse({ kind: 'shopping', items: many });
  assert.equal(capped.fields.items.length, 20);
  assert.equal(capped.fields.items[19].name, 'rzecz 20');
});

test('shopping with no usable item becomes a task with the sentence as its title', async () => {
  const { out } = await parse({ kind: 'shopping', items: [{ name: ' ', amount: '' }] }, { text: 'kup coś dobrego' });
  assert.equal(out.kind, 'task');
  assert.equal(out.fields.title, 'Kup coś dobrego');
});

test('event with day and hour is timed; end falls back to null', async () => {
  const { out } = await parse({
    kind: 'event', title: 'Trening Leo', event_date: '2026-11-05', start_time: '17:00', end_time: '',
  }, { text: 'Trening Leo w czwartek o 17' });
  assert.equal(out.kind, 'event');
  assert.deepEqual(out.fields, {
    title: 'Trening Leo', date: '2026-11-05', start_time: '17:00', end_time: null, all_day: false,
    location: null, assigned_to: [], reminder_minutes: null,
  });
});

test('event end: kept when after the start, dropped when not after it or without a start', async () => {
  const ok = await parse({ kind: 'event', title: 'Basen', event_date: '2026-11-01', start_time: '10:00', end_time: '12:00' });
  assert.equal(ok.out.fields.end_time, '12:00');
  const before = await parse({ kind: 'event', title: 'Basen', event_date: '2026-11-01', start_time: '10:00', end_time: '09:00' });
  assert.equal(before.out.fields.end_time, null);
  const same = await parse({ kind: 'event', title: 'Basen', event_date: '2026-11-01', start_time: '10:00', end_time: '10:00' });
  assert.equal(same.out.fields.end_time, null);
  const bad = await parse({ kind: 'event', title: 'Basen', event_date: '2026-11-01', start_time: '10:00', end_time: '25:00' });
  assert.equal(bad.out.fields.end_time, null);
  const noStart = await parse({ kind: 'event', title: 'Basen', event_date: '2026-11-01', start_time: '', end_time: '12:00' });
  assert.equal(noStart.out.fields.end_time, null);
});

test('event with a day and no hour is all day', async () => {
  const { out } = await parse({
    kind: 'event', title: 'Wycieczka przedszkolna Marysi', event_date: '2026-10-30', start_time: '',
  }, { text: 'Jutro wycieczka przedszkolna Marysi' });
  assert.equal(out.kind, 'event');
  assert.equal(out.fields.date, '2026-10-30');
  assert.equal(out.fields.start_time, null);
  assert.equal(out.fields.end_time, null);
  assert.equal(out.fields.all_day, true);
});

// R16: eine Stunde ohne Tag ist heute, wenn sie noch kommt, sonst morgen. Die
// laufende Minute zaehlt als vorbei. NOW = 11:00 in Warschau.
test('event hour without day: today if ahead, else tomorrow (R16)', async () => {
  const cases = [
    ['12:00', '2026-10-29', 'still ahead: today'],
    ['11:01', '2026-10-29', 'the next minute is still ahead'],
    ['11:00', '2026-10-30', 'the current minute counts as passed'],
    ['08:00', '2026-10-30', 'passed: tomorrow'],
  ];
  for (const [start_time, date, why] of cases) {
    const { out } = await parse({ kind: 'event', title: 'Spotkanie z księgową', event_date: '', start_time });
    assert.equal(out.kind, 'event', why);
    assert.deepEqual([out.fields.date, out.fields.start_time, out.fields.all_day], [date, start_time, false], why);
  }
  // Der Tag ist der des Haushalts: 23:30 UTC ist in Warschau schon 00:30 am 30.
  const { out } = await parse({ kind: 'event', title: 'x', event_date: '', start_time: '00:15' }, { now: new Date('2026-10-29T23:30:00Z') });
  assert.equal(out.fields.date, '2026-10-31');
  const { out: ahead } = await parse({ kind: 'event', title: 'x', event_date: '', start_time: '07:00' }, { now: new Date('2026-10-29T23:30:00Z') });
  assert.equal(ahead.fields.date, '2026-10-30');
});

test('event with neither day nor hour becomes a task with the same title', async () => {
  const { out } = await parse({ kind: 'event', title: 'Wizyta u dentysty', event_date: '', start_time: '' }, { text: 'Wizyta u dentysty' });
  assert.equal(out.kind, 'task');
  assert.deepEqual(out.fields, {
    title: 'Wizyta u dentysty', due_date: null, due_time: null, remind_date: null, remind_time: null, assigned_to: [],
  });
  // Ein unlesbarer Tag zaehlt als nicht gesagt.
  const { out: bad } = await parse({ kind: 'event', title: 'Wizyta u dentysty', event_date: '2026-02-30', start_time: '7' });
  assert.equal(bad.kind, 'task');
});

test('event people are household members only; "me" adds the speaker', async () => {
  const { out, sent } = await parse({ kind: 'event', title: 'Kolacja', event_date: '2026-10-30', start_time: '19:00', people: ['Mariola', 'Marysia', 'Kuchnia', 'Mariola'] });
  assert.deepEqual(out.fields.assigned_to, [MARIOLA]);
  const schema = sent[0].output_config.format.schema;
  assert.deepEqual(schema.properties.people.items.enum, ['Wojtek', 'Mariola']);
  assert.deepEqual(schema.properties.assignees.items.enum, ['Wojtek', 'Mariola']);
  assert.doesNotMatch(JSON.stringify(schema), /Kuchnia/);
  const me = await parse({ kind: 'event', title: 'Wizyta', event_date: '2026-10-30', start_time: '10:00', people: ['Mariola'], for_speaker: true });
  assert.deepEqual([...me.out.fields.assigned_to].sort(), [WOJTEK, MARIOLA].sort());
  const wall = await parse({ kind: 'event', title: 'Wizyta', event_date: '2026-10-30', start_time: '10:00', for_speaker: true }, { userId: KUCHNIA });
  assert.deepEqual(wall.out.fields.assigned_to, [], 'the wall account is never an assignee');
});

test('event place and reminder: trimmed place or null, reminder whole minutes >= 0 or null', async () => {
  const { out } = await parse({
    kind: 'event', title: 'Trening Leo', event_date: '2026-11-05', start_time: '17:00', location: '  Basen przy Polnej ', reminder_minutes: '60',
  });
  assert.equal(out.fields.location, 'Basen przy Polnej');
  assert.equal(out.fields.reminder_minutes, 60);
  for (const [said, expected] of [['0', 0], ['1440', 1440], ['', null], ['  ', null], ['-5', null], ['1.5', null], ['godzina', null], ['999999', null]]) {
    const r = await parse({ kind: 'event', title: 'x', event_date: '2026-11-05', start_time: '17:00', reminder_minutes: said });
    assert.equal(r.out.fields.reminder_minutes, expected, `reminder_minutes ${JSON.stringify(said)}`);
  }
  const blankPlace = await parse({ kind: 'event', title: 'x', event_date: '2026-11-05', start_time: '17:00', location: '   ' });
  assert.equal(blankPlace.out.fields.location, null);
});

test('event title: first letter upper case, the sentence when empty, clipped at 200', async () => {
  const { out } = await parse({ kind: 'event', title: '', event_date: '2026-11-05', start_time: '17:00' }, { text: ' trening Leo w czwartek o 17 ' });
  assert.equal(out.fields.title, 'Trening Leo w czwartek o 17');
  const long = await parse({ kind: 'event', title: 'a'.repeat(260), event_date: '2026-11-05', start_time: '17:00' });
  assert.equal(long.out.fields.title.length, 200);
});

// Der Aufgabenweg ist der des Aufgabenblatts: dieselbe Antwort ergibt dieselben Felder.
test('task kind returns exactly what parseTaskSentence returns for the same AI answer', async () => {
  const answers = [
    { title: 'Weź Marysi spodenki do przedszkola', due_date: '2026-10-30', remind_date: '2026-10-30', remind_time: '07:30' },
    { title: 'Zapłacić rachunek', assignees: ['Mariola', 'Mariola'], for_speaker: true, due_date: '2026-11-02', due_time: '09:05' },
    { title: 'x', remind_date: '2026-10-29', remind_time: '08:00' },
    { title: 'x', remind_date: '2026-10-29', remind_time: '' },
    { title: 'x', due_date: '2026-13-40', due_time: '7:3', remind_date: '2026-02-30', remind_time: '24:00' },
    { title: '   ', due_time: '09:00' },
    { title: `Zadzwoń ${'do przedszkola w sprawie wycieczki '.repeat(8)}`.trim(), assignees: ['Marysia', 'Kuchnia'] },
  ];
  for (const fields of answers) {
    const text = ' wyrzuć śmieci ';
    const quick = await parse({ ...fields, kind: 'task' }, { text });
    const task = fakeClaude(answer({ ...fields, kind: 'task' }));
    const expected = await parseTaskSentence({ text, userId: WOJTEK, now: NOW, database: db, client: task.client });
    assert.equal(quick.out.kind, 'task');
    assert.deepEqual(quick.out.fields, expected, JSON.stringify(fields));
  }
});

test('an unknown kind in the answer is a task, never nothing', async () => {
  const { out } = await parse({ kind: 'meal', title: 'Spaghetti' });
  assert.equal(out.kind, 'task');
  assert.equal(out.fields.title, 'Spaghetti');
});

test('a forced kind narrows the schema and is kept, even for an event without day or hour', async () => {
  const ev = await parse({ kind: 'event', title: 'Wizyta u dentysty' }, { kind: 'event' });
  assert.deepEqual(ev.sent[0].output_config.format.schema.properties.kind.enum, ['event']);
  assert.match(ev.sent[0].system, /kind is always "event"/);
  assert.equal(ev.out.kind, 'event');
  assert.deepEqual([ev.out.fields.date, ev.out.fields.start_time, ev.out.fields.all_day], [null, null, false]);
  // Der Satz gehoert dem Blatt, aus dem er kommt, was immer das Modell sagt.
  const shop = await parse({ kind: 'task', title: 'Mleko', items: [] }, { kind: 'shopping' });
  assert.equal(shop.out.kind, 'shopping');
  assert.deepEqual(shop.out.fields, { items: [] });
  const task = await parse({ kind: 'event', title: 'Trening', event_date: '2026-11-05', start_time: '17:00' }, { kind: 'task' });
  assert.equal(task.out.kind, 'task');
  assert.equal(task.out.fields.title, 'Trening');
  // Ohne Vorgabe stehen alle drei Arten zur Wahl.
  const free = await parse({ kind: 'task', title: 'x' });
  assert.deepEqual(free.sent[0].output_config.format.schema.properties.kind.enum, ['task', 'event', 'shopping']);
  assert.doesNotMatch(free.sent[0].system, /kind is always/);
});

test('kinds the caller may not get: a task in their place, or nothing when tasks are out too', async () => {
  const asTask = await parse({ kind: 'event', title: 'Trening Leo', event_date: '2026-11-05', start_time: '17:00' }, { kinds: ['task', 'shopping'], text: 'Trening Leo w czwartek o 17' });
  assert.equal(asTask.out.kind, 'task');
  assert.equal(asTask.out.fields.title, 'Trening Leo');
  const none = await parse({ kind: 'event', title: 'Trening Leo', event_date: '2026-11-05', start_time: '17:00' }, { kinds: ['shopping'] });
  assert.equal(none.out, null);
  const fine = await parse({ kind: 'shopping', items: [{ name: 'mleko', amount: '' }] }, { kinds: ['shopping'] });
  assert.equal(fine.out.kind, 'shopping');
});

test('the schema is strict: every property required, no others', async () => {
  const { sent } = await parse({ kind: 'task', title: 'x' });
  const schema = sent[0].output_config.format.schema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
  for (const key of ['event_date', 'start_time', 'end_time', 'location', 'reminder_minutes']) {
    assert.equal(schema.properties[key].type, 'string', key);
  }
  const item = schema.properties.items.items;
  assert.equal(item.additionalProperties, false);
  assert.deepEqual([...item.required].sort(), ['amount', 'name']);
});

test('the prompt: household day, weekday, time, zone, names, speaker, rules and Polish examples', async () => {
  const { sent } = await parse({ kind: 'task', title: 'x' }, { text: 'Zadzwoń do lekarza', userId: MARIOLA, now: new Date('2026-10-29T23:30:00Z') });
  const system = sent[0].system;
  assert.match(system, /Today in the household is 2026-10-30 \(Friday\)/, 'Warsaw is already on the 30th');
  assert.match(system, /00:30/);
  assert.match(system, /Europe\/Warsaw/);
  assert.match(system, /Wojtek, Mariola/);
  assert.match(system, /The person speaking is Mariola/);
  assert.doesNotMatch(`${system}\n${sent[0].messages[0].content[0].text}`, /Kuchnia/);
  assert.match(system, /When unsure: task/);
  assert.match(system, /neither a day nor an hour/);
  for (const words of ['"kup"', '"dodaj do zakupów"', '"wizyta"', '"trening"']) assert.ok(system.includes(words), `decision word ${words}`);
  // Die Beispiele rechnen vom Haushaltstag (Freitag, 30.10.): Donnerstag ist der 5.11., morgen der 31.10.
  const examples = [
    ['Dodaj zadanie ubezpiecz samochód', /kind "task", title "Ubezpiecz samochód"/],
    ['Trening Leo w czwartek o 17', /kind "event", title "Trening Leo", event_date "2026-11-05", start_time "17:00"/],
    ['Jutro wycieczka przedszkolna Marysi', /kind "event", title "Wycieczka przedszkolna Marysi", event_date "2026-10-31", start_time ""/],
    ['Spotkanie z księgową o 15, przypomnij pół godziny wcześniej', /event_date "", start_time "15:00".*reminder_minutes "30"/],
    ['Wizyta u dentysty', /kind "task", title "Wizyta u dentysty"/],
    ['kup mleko, chleb i 2 l soku', /kind "shopping".*\{"name":"mleko","amount":""\},\{"name":"chleb","amount":""\},\{"name":"sok","amount":"2 l"\}/],
    ['dodaj do zakupów pomidory', /kind "shopping".*\{"name":"pomidory","amount":""\}/],
  ];
  for (const [sentence, expected] of examples) {
    const line = system.split('\n').find((l) => l.startsWith(`"${sentence}"`));
    assert.ok(line, `worked example: ${sentence}`);
    assert.match(line, expected, sentence);
  }
  // Die Regeln des Aufgabenblatts gelten unveraendert.
  assert.match(system, /day but no hour gets remind_time "09:00"/);
  assert.match(system, /reminder hour that has already passed today \(at or before 00:30\) is for tomorrow/);
});

// ---------------------------------------------------------------- route

let actor = { id: WOJTEK, role: 'admin' };
let authMethod = 'session';
let moduleAccess = null;
let routeFake = fakeClaude(answer({ kind: 'task', title: 'Wyrzuć śmieci' }));

function appWith(router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = actor.id;
    req.authRole = actor.role;
    req.authMethod = authMethod;
    req.sessionModuleAccess = moduleAccess;
    req.session = { userId: actor.id, role: actor.role };
    next();
  });
  app.use('/api/v1/quick-add', router);
  return app;
}
// Der echte Router mit dem Claude des Haushalts (KI aus), und einer mit falschem Client.
const off = http.createServer(appWith(quickAddRouter));
const on = http.createServer(appWith(createQuickAddRouter({ client: { json: (opts) => routeFake.client.json(opts) } })));
await new Promise((r) => off.listen(0, '127.0.0.1', r));
await new Promise((r) => on.listen(0, '127.0.0.1', r));
test.after(() => { off.close(); on.close(); db.close(); });

async function post(server, body) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/quick-add/parse`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function as({ access = null, method = 'session', fake = null }, fn) {
  moduleAccess = access;
  authMethod = method;
  if (fake) routeFake = fake;
  try { return await fn(); } finally { moduleAccess = null; authMethod = 'session'; }
}

test('route: AI off answers 200 with source null and the reason', async () => {
  const r = await post(off, { text: 'Kup mleko' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { data: { source: null, unavailable: 'disabled' } });
});

test('route: the answer says the kind and carries its fields', async () => {
  const fake = fakeClaude(answer({ kind: 'shopping', items: [{ name: 'mleko', amount: '' }, { name: 'sok', amount: '2 l' }] }));
  const r = await as({ fake }, () => post(on, { text: 'kup mleko i 2 l soku' }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { data: { source: 'ai', kind: 'shopping', fields: { items: [{ name: 'mleko', quantity: null }, { name: 'sok', quantity: '2 l' }] } } });
  assert.equal(fake.sent.length, 1);
  const forced = fakeClaude(answer({ kind: 'event', title: 'Trening', event_date: '2026-11-05', start_time: '17:00' }));
  const ev = await as({ fake: forced }, () => post(on, { text: 'Trening w czwartek o 17', kind: 'event' }));
  assert.equal(ev.json.data.kind, 'event');
  assert.deepEqual(forced.sent[0].output_config.format.schema.properties.kind.enum, ['event']);
});

test('route: text must be a string of 1-500 characters after trimming', async () => {
  for (const body of [{ text: '' }, { text: '   ' }, {}, { text: 42 }, { text: 'a'.repeat(501) }]) {
    const r = await post(off, body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 40));
    assert.equal(r.json.code, 400);
    assert.equal(typeof r.json.error, 'string');
  }
  assert.equal((await post(off, { text: 'a'.repeat(500) })).status, 200);
});

test('route: kind must be task, event or shopping when given', async () => {
  for (const kind of ['meal', '', 'TASK', 1]) {
    const r = await post(off, { text: 'Kup mleko', kind });
    assert.equal(r.status, 400, JSON.stringify(kind));
    assert.equal(r.json.code, 400);
  }
  assert.equal((await post(off, { text: 'Kup mleko', kind: null })).status, 200);
});

test('route: a wall display with wall writes off is refused (403)', async () => {
  const fake = fakeClaude(answer({ kind: 'task', title: 'x' }));
  const r = await as({ method: 'display', fake }, () => post(on, { text: 'Wyrzuć śmieci' }));
  assert.equal(r.status, 403);
  assert.equal(r.json.reason, 'wall_read_only');
  assert.equal(fake.sent.length, 0, 'no AI call');
});

test('route: an event for a member who may not write the calendar opens as a task', async () => {
  actor = { id: MARIOLA, role: 'member' };
  try {
    const fake = fakeClaude(answer({ kind: 'event', title: 'Trening Leo', event_date: '2026-11-05', start_time: '17:00' }));
    const r = await as({ access: { calendar: 'read' }, fake }, () => post(on, { text: 'Trening Leo w czwartek o 17' }));
    assert.equal(r.status, 200);
    assert.equal(r.json.data.source, 'ai');
    assert.equal(r.json.data.kind, 'task');
    assert.equal(r.json.data.fields.title, 'Trening Leo');
    assert.deepEqual(Object.keys(r.json.data.fields).sort(), ['assigned_to', 'due_date', 'due_time', 'remind_date', 'remind_time', 'title']);
  } finally { actor = { id: WOJTEK, role: 'admin' }; }
});

test('route: the routed kind and tasks both closed answers 403', async () => {
  const fake = fakeClaude(answer({ kind: 'event', title: 'Trening Leo', event_date: '2026-11-05', start_time: '17:00' }));
  const r = await as({ access: { tasks: 'read', calendar: 'none' }, fake }, () => post(on, { text: 'Trening Leo w czwartek o 17' }));
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 403);
});

test('route: a member who may write none of tasks, calendar and shopping is refused before any AI call', async () => {
  const fake = fakeClaude(answer({ kind: 'task', title: 'x' }));
  const r = await as({ access: { tasks: 'read', calendar: 'read', shopping: 'read' }, fake }, () => post(on, { text: 'Wyrzuć śmieci' }));
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 403);
  assert.equal(r.json.reason, 'module_read_only');
  assert.equal(fake.sent.length, 0, 'no AI call');
});

test('route: a forced kind the member may not write is refused before any AI call', async () => {
  const fake = fakeClaude(answer({ kind: 'shopping', items: [] }));
  const r = await as({ access: { shopping: 'read' }, fake }, () => post(on, { text: 'mleko', kind: 'shopping' }));
  assert.equal(r.status, 403);
  assert.equal(fake.sent.length, 0);
  const ok = await as({ access: { shopping: 'read' }, fake }, () => post(on, { text: 'Wyrzuć śmieci', kind: 'task' }));
  assert.equal(ok.status, 200);
});

test('route: nothing is written to any table', async () => {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all().map((t) => t.name);
  const counts = () => Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n]));
  const before = counts();
  for (const fields of [
    { kind: 'task', title: 'Wyrzuć śmieci', due_date: '2026-10-30' },
    { kind: 'event', title: 'Trening Leo', event_date: '2026-11-05', start_time: '17:00', reminder_minutes: '60', people: ['Mariola'] },
    { kind: 'shopping', items: [{ name: 'mleko', amount: '' }] },
  ]) {
    const r = await as({ fake: fakeClaude(answer(fields)) }, () => post(on, { text: 'zdanie' }));
    assert.equal(r.status, 200);
    assert.equal(r.json.data.kind, fields.kind);
  }
  await post(off, { text: 'Kup mleko' });
  assert.deepEqual(counts(), before);
});

test('route: an unexpected failure is a 500 that never logs the sentence', async () => {
  const sentence = 'Prywatne zdanie o wizycie Mariolki';
  const broken = { json: async () => { throw new TypeError('boom'); } };
  const bare = http.createServer(appWith(createQuickAddRouter({ client: broken })));
  await new Promise((res) => bare.listen(0, '127.0.0.1', res));
  // Was der Logger schreibt (ausserhalb von production ueber die Konsole),
  // landet hier statt im Testlauf. stdout bleibt unberuehrt: darueber meldet
  // der Testlauf selbst seine Ergebnisse.
  const logged = [];
  const saved = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = (...args) => logged.push(format(...args));
  let r;
  try {
    r = await post(bare, { text: sentence });
  } finally {
    Object.assign(console, saved);
    bare.close();
  }
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { error: 'Internal server error.', code: 500 });
  assert.ok(logged.some((line) => line.includes('boom')), 'the failure is logged');
  assert.ok(!logged.some((line) => line.includes('Mariolki')), 'the sentence is not in the log');
});
