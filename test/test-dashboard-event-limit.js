/**
 * Modul: Uebersicht - wie viele Termine die Kalender-Kachel listet (#1680)
 * Zweck: Die Kachel zeigte fest fuenf Kommende, und fuenf stand an zwei
 *        Stellen (Route und Renderer). Seit #1680 waehlt jede Person 5, 8 oder
 *        12 im Optionen-Dialog der Kachel. Geprueft wird der ganze Weg:
 *
 *        1. Route: `events_limit` liefert die Stufe, alles ausserhalb der
 *           Allowlist ist fuenf, ohne Parameter bleibt die Antwort wie zuvor.
 *           Beendete von heute zaehlen nicht mit, `familyEvents` und
 *           `weekEvents` folgen der Stufe nicht.
 *        2. Ablage: die Option geht durch `PUT /preferences` (Form, nicht
 *           Bedeutung), gehoert der Person, reist mit der Haushaltsvorgabe und
 *           faellt beim Zuruecksetzen auf sie zurueck.
 *        3. Browser: der Dialog bietet die drei Stufen, speichert nur die
 *           Abweichung; die Anfrage traegt sie. (TAFLA 2026-10-24: die Kachel,
 *           die n Zeilen renderte, ist mit dem Raster gegangen; der Dialog
 *           steht als Kalender-Filter in „Dostosuj Dziś“.)
 *
 *        Uhr und Zone sind festgenagelt (Berlin wie die Demo-Saat) mit einem
 *        Gegenlauf in einer Zone, die den Tag verschiebt.
 *
 *        4. Was die Stufe NICHT sein darf (Codex-Review zu PR #1684): ein
 *           Filter fuer die Zahlen der Navigation - sonst holt der Router die
 *           Antwort bei jedem Kaltstart ein zweites Mal -, und beim
 *           Veroeffentlichen als Haushaltsvorgabe darf die alte Antwort nicht
 *           stehen bleiben.
 *
 * Ausfuehren: npm run test:dashboard-event-limit
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { register } from 'node:module';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';
import { readFileSync } from 'node:fs';

register('./test-browser-loader.mjs', import.meta.url);

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'dashboard-event-limit-test-secret';

const { resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');
const { dashboardPaths } = await import('../server/openapi/paths/dashboard.js');
const widgets = await import('../public/utils/dashboard-widgets.js');
const limits = await import('../public/utils/dashboard-event-limit.js');

function buildMigratedDatabase(migrations) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) {
    if (typeof migration.up === 'function') migration.up(database);
    else database.exec(migration.up);
    if (typeof migration.afterUp === 'function') migration.afterUp(database);
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  }
  return database;
}

const moduleDatabase = get();
const db = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(db);
moduleDatabase.close();

const addUser = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
  VALUES (?, ?, 'hash', '#7C3AED', ?, ?)
`);
const ADMIN = Number(addUser.run(`limit-admin-${randomUUID()}`, 'Anna', 'admin', 'parent').lastInsertRowid);
const LEO = Number(addUser.run(`limit-leo-${randomUUID()}`, 'Leo', 'member', 'child').lastInsertRowid);

let currentUser = ADMIN;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(currentUser);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.session = { userId: user.id, role: user.role };
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(db, user));
  next();
});
app.use('/preferences', preferencesRouter);
app.use('/', dashboardRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

async function getJson(path) {
  const res = await fetch(`${base}${path}`);
  assert.equal(res.status, 200, `${path}: ${res.status}`);
  return res.json();
}

function withClock(iso, zone, fn) {
  return async () => {
    db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', ?)").run(zone);
    mock.timers.enable({ apis: ['Date'], now: new Date(iso) });
    try {
      await fn();
    } finally {
      mock.timers.reset();
    }
  };
}

const insertEvent = db.prepare(`
  INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, visibility, created_by, recurrence_rule)
  VALUES (?, ?, ?, 0, 'all', ?, NULL)
`);
const addEvent = (title, start, end) => Number(insertEvent.run(title, start, end, ADMIN).lastInsertRowid);
const clearEvents = () => db.prepare('DELETE FROM calendar_events').run();
const titles = (events) => events.map((e) => e.title);
const pad = (n) => String(n).padStart(2, '0');

// Donnerstag, 24.09.2026, 14:00 in Berlin.
const THU_14_BERLIN = '2026-09-24T12:00:00Z';

/** Drei beendete von heute, dann vierzehn Kommende - einer je Tag ab morgen. */
function seedFullCalendar() {
  clearEvents();
  for (const h of ['08', '09', '10']) addEvent(`Vorbei ${h}`, `2026-09-24T${h}:00`, `2026-09-24T${h}:30`);
  for (let i = 1; i <= 14; i += 1) {
    const day = `2026-${i <= 6 ? '09' : '10'}-${pad(i <= 6 ? 24 + i : i - 6)}`;
    addEvent(`Kommt ${pad(i)}`, `${day}T10:00`, `${day}T11:00`);
  }
}
const ahead = (events) => titles(events).filter((title) => title.startsWith('Kommt'));
const firstAhead = (n) => Array.from({ length: n }, (_, i) => `Kommt ${pad(i + 1)}`);

// --------------------------------------------------------------------------
// 1. Die Route
// --------------------------------------------------------------------------

test('ohne events_limit bleibt es bei fuenf Kommenden', withClock(THU_14_BERLIN, 'Europe/Berlin', async () => {
  seedFullCalendar();
  assert.deepEqual(ahead((await getJson('/')).upcomingEvents), firstAhead(5));
}));

for (const step of [8, 12]) {
  test(`events_limit=${step} liefert ${step} Kommende`, withClock(THU_14_BERLIN, 'Europe/Berlin', async () => {
    seedFullCalendar();
    assert.deepEqual(ahead((await getJson(`/?events_limit=${step}`)).upcomingEvents), firstAhead(step));
  }));
}

test('events_limit=5 ist die Vorgabe und liefert dasselbe wie kein Parameter', withClock(THU_14_BERLIN, 'Europe/Berlin', async () => {
  seedFullCalendar();
  assert.deepEqual(ahead((await getJson('/?events_limit=5')).upcomingEvents), firstAhead(5));
}));

test('alles ausserhalb der Allowlist ist fuenf - kein Bereich, kein Runden', withClock(THU_14_BERLIN, 'Europe/Berlin', async () => {
  seedFullCalendar();
  const outside = [
    'events_limit=500', 'events_limit=7', 'events_limit=abc', 'events_limit=', 'events_limit=0', 'events_limit=-8',
    'events_limit=8.0', 'events_limit=%208', 'events_limit=08', 'events_limit=1e1', 'events_limit=12abc',
    // Express macht aus dem doppelten Parameter ein Array und aus der Klammer ein Objekt.
    'events_limit=8&events_limit=12', 'events_limit[]=12', 'events_limit[a]=12',
  ];
  for (const query of outside) {
    assert.deepEqual(ahead((await getJson(`/?${query}`)).upcomingEvents), firstAhead(5), `?${query} darf nicht mehr als fuenf liefern`);
  }
}));

test('beendete Termine von heute kommen obendrauf und verbrauchen die Stufe nicht (#1449)', withClock(THU_14_BERLIN, 'Europe/Berlin', async () => {
  seedFullCalendar();
  const events = (await getJson('/?events_limit=12')).upcomingEvents;
  assert.deepEqual(titles(events).filter((title) => title.startsWith('Vorbei')), ['Vorbei 08', 'Vorbei 09', 'Vorbei 10']);
  assert.equal(ahead(events).length, 12, 'zwoelf Kommende NEBEN den drei beendeten');
}));

test('weniger Termine als die Stufe: die Antwort ist kuerzer, nicht aufgefuellt', withClock(THU_14_BERLIN, 'Europe/Berlin', async () => {
  clearEvents();
  for (let i = 1; i <= 6; i += 1) addEvent(`Kommt ${pad(i)}`, `2026-09-${24 + i}T10:00`, `2026-09-${24 + i}T11:00`);
  assert.deepEqual(ahead((await getJson('/?events_limit=12')).upcomingEvents), firstAhead(6));
}));

test('die Stufe gilt der Liste: weekEvents und familyEvents bleiben, wie sie sind', withClock(THU_14_BERLIN, 'Europe/Berlin', async () => {
  seedFullCalendar();
  const plain = await getJson('/');
  const twelve = await getJson('/?events_limit=12');
  assert.deepEqual(twelve.weekEvents, plain.weekEvents);
  assert.deepEqual(twelve.familyEvents, plain.familyEvents);
}));

test('die Stufe vertraegt sich mit „nur meine" und greift NACH dem Filter', withClock(THU_14_BERLIN, 'Europe/Berlin', async () => {
  seedFullCalendar();
  const assign = db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)');
  const rows = db.prepare("SELECT id, title FROM calendar_events WHERE title LIKE 'Kommt %' ORDER BY title").all();
  // Jeder zweite gehoert Anna: sieben eigene unter vierzehn.
  rows.forEach((row, index) => { if (index % 2 === 1) assign.run(row.id, ADMIN); });
  const mine = ahead((await getJson('/?events_scope=mine&events_limit=8')).upcomingEvents);
  assert.deepEqual(mine, ['02', '04', '06', '08', '10', '12', '14'].map((n) => `Kommt ${n}`),
    'acht ist der Deckel NACH dem Filter - sonst blieben vier von acht');
}));

// Gegenlauf: in Honolulu ist derselbe Augenblick noch der Vormittag des 24.,
// und die drei „beendeten" enden dort ebenfalls vor jetzt (02:00 Ortszeit waere
// es nicht) - die Stufe haengt an keiner Tagesgrenze.
test('Gegenlauf Honolulu: die Stufe zaehlt dort genauso', withClock('2026-09-25T02:00:00Z', 'Pacific/Honolulu', async () => {
  seedFullCalendar();
  assert.equal(ahead((await getJson('/?events_limit=8')).upcomingEvents).length, 8);
  assert.equal(ahead((await getJson('/')).upcomingEvents).length, 5);
}));

test('OpenAPI nennt den Parameter mit genau den Stufen der Route', () => {
  const params = dashboardPaths()['/api/v1/dashboard'].get.parameters;
  const param = params.find((p) => p.name === 'events_limit' && p.in === 'query');
  assert.ok(param, 'events_limit fehlt in der OpenAPI-Beschreibung von GET /dashboard');
  assert.deepEqual(param.schema.enum, [...limits.EVENT_LIMIT_STEPS]);
  assert.equal(param.schema.default, limits.EVENT_LIMIT_DEFAULT);
  assert.equal(param.required, false);
});

// --------------------------------------------------------------------------
// 2. Die Ablage: Form statt Bedeutung, je Person, mit Haushaltsvorgabe
// --------------------------------------------------------------------------

const readPrefs = async () => (await getJson('/preferences')).data;
async function writePrefs(body) {
  const res = await fetch(`${base}/preferences`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.status;
}
function clearDashboardPreferences() {
  db.prepare(`
    DELETE FROM sync_config
    WHERE key IN ('dashboard_widgets', 'dashboard_widgets_default')
       OR key LIKE 'dashboard_widgets:user:%'
  `).run();
}
const calendarTile = (options) => [{ id: 'calendar', visible: true, order: 0, size: '1x2', ...(options ? { options } : {}) }];
const calendarOptions = (config) => config.find((w) => w.id === 'calendar')?.options;

test('die Stufe ueberlebt das Speichern und gehoert der Person', async () => {
  clearDashboardPreferences();
  try {
    currentUser = ADMIN;
    assert.equal(await writePrefs({ dashboard_widgets: calendarTile({ limit: 8 }) }), 200);
    assert.deepEqual(calendarOptions((await readPrefs()).dashboard_widgets), { limit: 8 });
    assert.equal(widgets.dashboardQuery((await readPrefs()).dashboard_widgets), '/dashboard?events_limit=8');

    currentUser = LEO;
    assert.deepEqual((await readPrefs()).dashboard_widgets, [], 'Leos Kachel bleibt unberuehrt');
    assert.equal(widgets.dashboardQuery((await readPrefs()).dashboard_widgets), '/dashboard');
  } finally {
    currentUser = ADMIN;
    clearDashboardPreferences();
  }
});

test('die Vorgabe des Haushalts traegt die Stufe, und Zuruecksetzen fuehrt zu ihr zurueck', async () => {
  clearDashboardPreferences();
  try {
    currentUser = ADMIN;
    assert.equal(await writePrefs({ dashboard_widgets_default: calendarTile({ limit: 12 }) }), 200);

    currentUser = LEO;
    assert.deepEqual(calendarOptions((await readPrefs()).dashboard_widgets), { limit: 12 }, 'wer nichts Eigenes hat, bekommt die Vorgabe');
    assert.equal(await writePrefs({ dashboard_widgets: calendarTile({ limit: 8 }) }), 200);
    assert.deepEqual(calendarOptions((await readPrefs()).dashboard_widgets), { limit: 8 });
    assert.equal(await writePrefs({ dashboard_widgets: null }), 200);
    const back = await readPrefs();
    assert.deepEqual(calendarOptions(back.dashboard_widgets), { limit: 12 });
    assert.equal(back.dashboard_follows_default, true);
  } finally {
    currentUser = ADMIN;
    clearDashboardPreferences();
  }
});

test('ein gespeicherter Fremdwert wird nicht zur Anfrage: die Klemme sitzt hinter der Ablage', async () => {
  clearDashboardPreferences();
  try {
    currentUser = ADMIN;
    // Die Ablage prueft die Form (endliche Zahl) und kennt die Bedeutung nicht -
    // 500 kommt also hinein. Anfrage und Kachel klemmen.
    assert.equal(await writePrefs({ dashboard_widgets: calendarTile({ limit: 500 }) }), 200);
    const stored = (await readPrefs()).dashboard_widgets;
    assert.deepEqual(calendarOptions(stored), { limit: 500 });
    assert.equal(widgets.dashboardQuery(stored), '/dashboard');
  } finally {
    clearDashboardPreferences();
  }
});

// --------------------------------------------------------------------------
// 3. Der Browser: Klemme, Anfrage, Dialog
// --------------------------------------------------------------------------

test('clampEventLimit: nur 5, 8 und 12, als Zahl oder als genau diese Ziffern', () => {
  assert.deepEqual([...limits.EVENT_LIMIT_STEPS], [5, 8, 12]);
  assert.equal(limits.EVENT_LIMIT_DEFAULT, 5);
  for (const step of [5, 8, 12]) {
    assert.equal(limits.clampEventLimit(step), step);
    assert.equal(limits.clampEventLimit(String(step)), step);
  }
  for (const other of [undefined, null, '', 0, 7, 500, -8, 8.5, '8.0', ' 8', '08', 'abc', NaN, Infinity, true, [8], ['8', '12'], { a: 12 }]) {
    assert.equal(limits.clampEventLimit(other), 5, `${JSON.stringify(other)} ist keine Stufe`);
  }
});

test('dashboardQuery: die Stufe reist nur, wenn sie von der Vorgabe abweicht', () => {
  const q = (options) => widgets.dashboardQuery(calendarTile(options));
  assert.equal(q(undefined), '/dashboard');
  assert.equal(q({ limit: 5 }), '/dashboard', 'fuenf ist der Auslieferungszustand und steht in keiner Anfrage');
  assert.equal(q({ limit: 8 }), '/dashboard?events_limit=8');
  assert.equal(q({ limit: 12 }), '/dashboard?events_limit=12');
  assert.equal(q({ limit: 7 }), '/dashboard');
  assert.equal(q({ limit: 500 }), '/dashboard');
  assert.equal(q({ scope: 'mine', birthdays: 'hide', limit: 12 }),
    '/dashboard?events_scope=mine&events_birthdays=hide&events_limit=12');
});

// 2026-10-27, v2: hier stand der Dialog der Kalender-Filter (drei Stufen,
// vorgewaehlte Stufe, gespeichert nur die Abweichung) und dass „Als Vorgabe
// fuer alle" die Antwort neu holt. Beides stand in „Dostosuj Dziś", und das
// ist mit Dziś v2 gegangen. Eine gespeicherte Stufe gilt weiter (Abschnitt 1,
// dashboardQuery oben).

// --------------------------------------------------------------------------
// 4. Die Stufe ist kein Filter
// --------------------------------------------------------------------------

const badges = await import('../public/utils/nav-badges.js');

test('dashboardQueryFiltersCounts: events_limit allein ist kein Filter, alles andere schon', () => {
  const f = widgets.dashboardQueryFiltersCounts;
  assert.equal(f('/dashboard'), false);
  assert.equal(f('/dashboard?events_limit=8'), false);
  assert.equal(f('/dashboard?events_limit=12'), false);
  assert.equal(f(widgets.dashboardQuery(calendarTile({ limit: 12 }))), false, 'der Pfad, den die Seite wirklich baut');
  // Allowlist: was nicht bekannt zahlenneutral ist, gilt als Filter.
  assert.equal(f('/dashboard?tasks_category=household'), true);
  assert.equal(f('/dashboard?notes_category=3'), true);
  assert.equal(f('/dashboard?events_scope=mine'), true);
  assert.equal(f('/dashboard?events_birthdays=hide'), true);
  assert.equal(f('/dashboard?events_limit=12&tasks_category=household'), true, 'die Stufe entschuldigt keinen Filter daneben');
  assert.equal(f('/dashboard?events_scope=mine&events_limit=12'), true);
  assert.equal(f('/dashboard?something_new=1'), true);
  assert.equal(f(undefined), false);
});

test('die Zahlen der Navigation sind mit und ohne Stufe dieselben - und mit einem echten Filter andere', withClock(THU_14_BERLIN, 'Europe/Berlin', async () => {
  seedFullCalendar();
  db.prepare('DELETE FROM tasks').run();
  const addTask = db.prepare("INSERT INTO tasks (title, priority, status, category, due_date, created_by) VALUES (?, 'high', 'open', ?, ?, ?)");
  addTask.run('Haushalt ueberfaellig', 'household', '2026-09-20', ADMIN);
  addTask.run('Haushalt offen', 'household', '2026-09-30', ADMIN);
  addTask.run('Anderes ueberfaellig', 'other', '2026-09-21', ADMIN);
  try {
    const counts = (data) => ({
      module: badges.moduleCountsFrom(data, { isAdmin: true, shoppingVisible: true }),
      nav: badges.navBadgeCountsFrom(data),
    });
    const plain = counts(await getJson('/'));
    assert.equal(plain.module.tasks, 3, 'Vorbedingung: drei offene Aufgaben werden gezaehlt');
    assert.equal(plain.nav['/tasks'], 2, 'Vorbedingung: zwei davon ueberfaellig');
    for (const step of [8, 12]) {
      assert.deepEqual(counts(await getJson(`/?events_limit=${step}`)), plain, `events_limit=${step} darf keine Zahl bewegen`);
    }
    // Die Messung sieht einen Filter, wenn es einer ist - sonst waere das Gleichheitszeichen oben nichts wert.
    const filtered = counts(await getJson('/?tasks_category=household'));
    assert.equal(filtered.module.tasks, 2);
    assert.equal(filtered.nav['/tasks'], 1);
  } finally {
    db.prepare('DELETE FROM tasks').run();
  }
}));

// Beide Stellen sind Closures in `render()` und ohne Browser nicht aufrufbar
// (dieselbe Lage wie in test-waste-dashboard.js). Der Text haelt deshalb den
// AUFRUF fest; das Verhalten dahinter - die geteilte Funktion und die Zahlen -
// messen die zwei Tests darueber, den Ablauf die Browser-Probe im PR.
const pageSource = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
test('die Seite reicht dem Zahlenspeicher die Antwort nach der geteilten Regel, nicht nach „hat Parameter"', () => {
  const call = /primeModuleCountsFrom\?\.\(dashRes, \{\s*filtered: ([^\n]+?),?\s*\}\)/.exec(pageSource);
  assert.ok(call, 'der Aufruf von primeModuleCountsFrom ist nicht mehr zu finden');
  // Gefragt wird nach dem Pfad, der WIRKLICH abgerufen wurde: seit #1817 haengt
  // die Wand `audience=household` an (`overviewRequest`), und deren Zahlen sind
  // die des Haushalts, nicht die der Person - sie duerfen nie in den Speicher
  // der Navigations-Badges. Dass die Regel sie als gefiltert wertet, misst
  // test:wall-tasks.
  // 2026-10-27, v2: die Seite fragt die Route ohne die Optionen der alten
  // Kacheln (`DASHBOARD_QUERY`); die Stufe reist nicht mehr mit.
  assert.equal(call[1], 'dashboardQueryFiltersCounts(overviewRequest(DASHBOARD_QUERY))');
  assert.match(pageSource, /const DASHBOARD_QUERY = '\/dashboard';/);
});

