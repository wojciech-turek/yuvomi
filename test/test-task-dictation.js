/**
 * Test: Diktat - ein gesprochener Satz wird zu Aufgabenfeldern (Haiku)
 * Zweck: Service `parseTaskSentence` mit falschem Claude-Client (kein Netz) und
 *        Route `POST /api/v1/tasks/parse` (Form `{ data: { source, fields } }`).
 *        Die Route speichert nichts; die Person prueft das Formular.
 * Ausfuehren: npm run test:task-dictation
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'task-dictation-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { parseTaskSentence } = await import('../server/services/task-dictation.js');
const { createClaude } = await import('../server/ai/claude.js');
const { FEATURES, aiSettings, featureOn } = await import('../server/ai/settings.js');

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

/** Ein Claude-Client, dessen "API" `answer` liefert; `sent` sammelt die Anfragen. */
function fakeClaude(answer) {
  const sent = [];
  const api = { messages: { create: async (params) => {
    sent.push(params);
    return {
      stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 },
      content: [{ type: 'text', text: typeof answer === 'string' ? answer : JSON.stringify(answer) }],
    };
  } } };
  const client = createClaude({ getApiKey: () => 'k', guard: () => {}, record: () => {}, clientFactory: () => api });
  return { client, sent };
}

const base = {
  title: 'Ubezpiecz samochód', due_date: '', due_time: '', remind_date: '', remind_time: '',
  assignees: [], for_speaker: false,
};
const NOW = new Date('2026-10-29T10:00:00Z');

test('the spec example: title, due and reminder map to fields', async () => {
  const { client, sent } = fakeClaude({
    title: 'Weź Marysi spodenki do przedszkola', due_date: '2026-10-30', due_time: '',
    remind_date: '2026-10-30', remind_time: '07:30', assignees: [], for_speaker: false,
  });
  const out = await parseTaskSentence({
    text: 'Weź jutro Marysi spodenki do przedszkola, ustaw przypomnienie na jutro 7:30',
    userId: WOJTEK, now: NOW, database: db, client,
  });
  assert.deepEqual(out, {
    title: 'Weź Marysi spodenki do przedszkola', due_date: '2026-10-30', due_time: null,
    remind_date: '2026-10-30', remind_time: '07:30', assigned_to: [],
  });
  assert.equal(sent.length, 1, 'one call per sentence');
  assert.equal(sent[0].max_tokens, 400);
  assert.equal(sent[0].output_config.effort, 'low');
  assert.equal(sent[0].model, 'claude-haiku-5-5');
});

test('the schema offers member names only (no wall account) and is strict', async () => {
  const { client, sent } = fakeClaude(base);
  await parseTaskSentence({ text: 'Ubezpiecz samochód', userId: WOJTEK, now: NOW, database: db, client });
  const schema = sent[0].output_config.format.schema;
  assert.deepEqual(schema.properties.assignees.items.enum, ['Wojtek', 'Mariola']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
});

test('assignees map to ids; "for me" adds the speaker; no duplicates', async () => {
  const { client } = fakeClaude({ ...base, assignees: ['Mariola', 'Mariola'], for_speaker: true });
  const out = await parseTaskSentence({ text: 'Muszę, razem z Mariolą, zapłacić rachunek', userId: WOJTEK, now: NOW, database: db, client });
  assert.deepEqual([...out.assigned_to].sort(), [WOJTEK, MARIOLA].sort());
  const same = fakeClaude({ ...base, assignees: ['Wojtek'], for_speaker: true });
  const dup = await parseTaskSentence({ text: 'x', userId: WOJTEK, now: NOW, database: db, client: same.client });
  assert.deepEqual(dup.assigned_to, [WOJTEK]);
  const unknown = fakeClaude({ ...base, assignees: ['Marysia', 'Kuchnia'] });
  const none = await parseTaskSentence({ text: 'x', userId: WOJTEK, now: NOW, database: db, client: unknown.client });
  assert.deepEqual(none.assigned_to, []);
});

test('bad dates and times become null; real ones pass', async () => {
  const bad = fakeClaude({ ...base, due_date: '2026-13-40', due_time: '7:3', remind_date: '2026-02-30', remind_time: '24:00' });
  const out = await parseTaskSentence({ text: 'x', userId: WOJTEK, now: NOW, database: db, client: bad.client });
  assert.equal(out.due_date, null);
  assert.equal(out.due_time, null);
  assert.equal(out.remind_date, null);
  assert.equal(out.remind_time, null);
  const good = fakeClaude({ ...base, due_date: '2026-11-02', due_time: '09:05' });
  const ok = await parseTaskSentence({ text: 'x', userId: WOJTEK, now: NOW, database: db, client: good.client });
  assert.equal(ok.due_date, '2026-11-02');
  assert.equal(ok.due_time, '09:05');
});

test('a time without its day is dropped (reminder and due)', async () => {
  const { client } = fakeClaude({ ...base, due_time: '09:00', remind_time: '07:30' });
  const out = await parseTaskSentence({ text: 'x', userId: WOJTEK, now: NOW, database: db, client });
  assert.equal(out.due_time, null);
  assert.equal(out.remind_time, null);
  const withDay = fakeClaude({ ...base, remind_date: '2026-10-30', remind_time: '07:30' });
  const ok = await parseTaskSentence({ text: 'x', userId: WOJTEK, now: NOW, database: db, client: withDay.client });
  assert.deepEqual([ok.due_date, ok.due_time, ok.remind_date, ok.remind_time], [null, null, '2026-10-30', '07:30']);
});

test('a display account speaker is never added; shared display names map to nobody', async () => {
  const { client } = fakeClaude({ ...base, for_speaker: true });
  const out = await parseTaskSentence({ text: 'x', userId: KUCHNIA, now: NOW, database: db, client });
  assert.deepEqual(out.assigned_to, []);
  const twin = seedUser('Wojtek2');
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run('Wojtek', twin);
  try {
    const dup = fakeClaude({ ...base, assignees: ['Wojtek', 'Mariola'] });
    const r = await parseTaskSentence({ text: 'x', userId: MARIOLA, now: NOW, database: db, client: dup.client });
    assert.deepEqual(r.assigned_to, [MARIOLA], 'ambiguous name is not guessed');
    assert.deepEqual(dup.sent[0].output_config.format.schema.properties.assignees.items.enum, ['Wojtek', 'Mariola']);
  } finally {
    db.prepare('DELETE FROM users WHERE id = ?').run(twin);
  }
});

test('title: trimmed, first letter upper case, raw sentence when empty', async () => {
  const a = fakeClaude({ ...base, title: '  wyrzuć śmieci ' });
  assert.equal((await parseTaskSentence({ text: 'x', userId: WOJTEK, now: NOW, database: db, client: a.client })).title, 'Wyrzuć śmieci');
  const b = fakeClaude({ ...base, title: '   ' });
  assert.equal((await parseTaskSentence({ text: ' Wyrzuć śmieci ', userId: WOJTEK, now: NOW, database: db, client: b.client })).title, 'Wyrzuć śmieci');
});

test('the prompt carries the household day (not the UTC day), weekday, time, zone, names', async () => {
  const { client, sent } = fakeClaude(base);
  await parseTaskSentence({
    text: 'Zadzwoń do lekarza', userId: MARIOLA, now: new Date('2026-10-29T23:30:00Z'), database: db, client,
  });
  const prompt = `${sent[0].system}\n${sent[0].messages[0].content[0].text}`;
  assert.match(sent[0].system, /Today in the household is 2026-10-30 \(Friday\)/, 'Warsaw is already on the 30th');
  assert.doesNotMatch(sent[0].system, /Today in the household is 2026-10-29/);
  assert.doesNotMatch(sent[0].system, /today 2026-10-29/, 'examples use the live date');
  assert.match(prompt, /00:30/);
  assert.match(prompt, /Europe\/Warsaw/);
  assert.match(prompt, /Wojtek/);
  assert.match(prompt, /Mariola/);
  assert.doesNotMatch(prompt, /Kuchnia/);
  assert.match(sent[0].messages[0].content[0].text, /Zadzwoń do lekarza/);
  for (const example of ['Dodaj zadanie ubezpiecz samochód', 'Wyrzuć śmieci', 'ustaw przypomnienie na jutro 7:30']) {
    assert.ok(sent[0].system.includes(example), `worked example: ${example}`);
  }
});

test('dictation is a known feature and ON by default once AI is enabled', () => {
  assert.ok(FEATURES.includes('task_dictation'));
  assert.equal(aiSettings().features.task_dictation, true);
  assert.equal(featureOn('task_dictation'), false, 'master switch is off on a fresh install');
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('ai_enabled', '1')
    ON CONFLICT(key) DO UPDATE SET value = '1'`).run();
  assert.equal(featureOn('task_dictation'), true);
  db.prepare(`DELETE FROM sync_config WHERE key = 'ai_enabled'`).run();
});

test('an ai_features blob stored before task_dictation existed leaves it ON', () => {
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('ai_enabled', '1')
    ON CONFLICT(key) DO UPDATE SET value = '1'`).run();
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('ai_features', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify({ shopping_smart: false, nudges: true }));
  try {
    assert.equal(featureOn('task_dictation'), true);
    assert.equal(featureOn('shopping_smart'), false);
  } finally {
    db.prepare(`DELETE FROM sync_config WHERE key IN ('ai_enabled', 'ai_features')`).run();
  }
});

// ---------------------------------------------------------------- route

let actor = { id: WOJTEK, role: 'admin' };
let authMethod = 'session';
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.authMethod = authMethod;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/api/v1/tasks', tasksRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/api/v1/tasks/parse`;
test.after(() => { server.close(); db.close(); });

async function post(body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

test('route: AI off answers 200 with source null and the reason', async () => {
  const r = await post({ text: 'Wyrzuć śmieci' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { data: { source: null, unavailable: 'disabled' } });
});

test('route: text must be 1-500 characters after trimming', async () => {
  assert.equal((await post({ text: '   ' })).status, 400);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ text: 'a'.repeat(501) })).status, 400);
});

test('route: nothing is saved', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
  await post({ text: 'Wyrzuć śmieci' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, before);
});

test('route: a wall display with wall writes off is refused (403)', async () => {
  authMethod = 'display';
  try {
    const r = await post({ text: 'Wyrzuć śmieci' });
    assert.equal(r.status, 403);
    assert.equal(r.json.reason, 'wall_read_only');
  } finally { authMethod = 'session'; }
});
