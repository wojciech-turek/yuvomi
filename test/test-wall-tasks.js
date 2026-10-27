/**
 * Modul: Wand - die Aufgaben von heute unter jeder Person (#1817)
 * Zweck: Drei Dinge, jedes gegen das echte Stueck Code:
 *
 *        1. SERVER (`wallTasks` in GET /dashboard, echter Router, migrierte
 *           In-Memory-DB, festgenagelte Uhr und Haushaltszone): Titel je
 *           Mitglied ohne den Fuenfer-Deckel von `urgentTasks`; nur
 *           `visibility = 'all'`, auch wenn die betrachtende Person die
 *           Aufgabe selbst angelegt hat und ihr zugewiesen ist; Erledigtes von
 *           heute (faellig heute, oder ueberfaellig und HEUTE abgehakt - der Tag
 *           ist der des Haushalts, mit Los Angeles als Gegenlauf).
 *        2.-5. MIT TAFLA (2026-10-19) IM RUHESTAND: „Wer heute dran ist"
 *           samt Leiter und Abstieg ist von der Wand gegangen; wer dran ist,
 *           sagt die Scheibe an jeder Zeile (Begruendung im Abschnitt).
 *
 *        6. GETEILTE FLAECHE (`audience=household`): die ganze Antwort fuer die
 *           Wand traegt nur, was der ganze Haushalt sehen darf - Aufgaben UND
 *           Termine, beide Sichtbarkeitsachsen der Termine (Stufe der Zeile,
 *           ICS-Abo), in jeder Scheibe, auch aus der Sitzung der Person, der
 *           die Zeile gehoert. Ohne den Parameter bleibt die Antwort
 *           persoenlich. Und die gebaute Wand zeigt davon an keiner Stelle
 *           etwas.
 *        7. PERSOENLICHE BEITRAEGE: was dem Betrachter allein gilt - die eigene
 *           Dosis, die eigene Schicht, die eigene Erinnerung, wartende
 *           Freigaben - steht in der Haushaltsfassung gar nicht, aus keiner
 *           Sitzung; ohne den Parameter bleibt es stehen; und die Wand ist aus
 *           jeder Sitzung dieselbe wie auf einem gekoppelten Display.
 *        8. ALLOWLIST: die Haushaltsfassung traegt nur die Schluessel, die die
 *           Wand zeichnet (`HOUSEHOLD_AUDIENCE_SHOWS`); Notizen, Budget,
 *           geteilte Ausgaben, Schnellzugriffe, Countdowns und der offene Lohn
 *           der Haushaltshilfe kommen leer, als Text wie als Zahl, und werden
 *           nicht gelesen. DRIFT-GUARD: die Schluessel der ECHTEN Antwort
 *           gegen die Allowlist und eine hier gefuehrte Bewusst-leer-Liste -
 *           ein neuer Schluessel der Route ist rot, bis jemand entscheidet.
 *
 * Ausfuehren: npm run test:wall-tasks
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { register } from 'node:module';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

register('./test-browser-loader.mjs', import.meta.url);

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'wall-tasks-test-secret';

const { resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { default: remindersRouter } = await import('../server/routes/reminders.js');
const { DISPLAY_SCOPES } = await import('../server/services/display-accounts.js');

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

function addUser(name, role = 'member') {
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
    VALUES (?, ?, 'hash', '#7C3AED', ?, 'parent')
  `).run(`wall-${name}-${randomUUID()}`, name, role).lastInsertRowid);
}
const ANNA = addUser('Anna', 'admin');
const BEN = addUser('Ben');
const CLEO = addUser('Cleo');

let viewer = ANNA;
/** Ein gekoppeltes Display: Methode, Scopes und Rechte wie `requireAuth` sie setzt. */
let asDisplay = false;
const app = express();
app.use((req, _res, next) => {
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(viewer);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.session = { userId: user.id, role: user.role };
  if (asDisplay) { req.authMethod = 'display'; req.authScopes = [...DISPLAY_SCOPES]; }
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(db, user, { isDisplay: asDisplay }));
  next();
});
app.use('/reminders', remindersRouter);
app.use('/', dashboardRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

// `wallTasks` rechnet die Route nur fuer die geteilte Flaeche (2026-10-24):
// `audience=household` oder ein gekoppeltes Display. Die persoenliche Antwort
// traegt das Feld leer.
async function wallTasksFor(userId = ANNA) {
  viewer = userId;
  const res = await fetch(`${base}/?audience=household`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.wallTasks), 'Reichweite: die Antwort traegt wallTasks');
  return Object.fromEntries(body.wallTasks.map((entry) => [entry.user_id, entry]));
}

// Nur `Date` wird gemockt; die Zone ist die des HAUSHALTS, nicht die des Rechners.
function withClock(iso, zone, fn) {
  return async () => {
    db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', ?)").run(zone);
    db.prepare('DELETE FROM tasks').run();
    mock.timers.enable({ apis: ['Date'], now: new Date(iso) });
    try {
      await fn();
    } finally {
      mock.timers.reset();
    }
  };
}

function addTask(title, assignees, {
  due = '2026-10-08', status = 'open', visibility = 'all', createdBy = ANNA,
  completedAt = null, parent = null, archived = null, start = null, dueTime = null,
} = {}) {
  const id = Number(db.prepare(`
    INSERT INTO tasks (title, status, due_date, due_time, created_by, visibility, parent_task_id, archived_at, start_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, status, due, dueTime, createdBy, visibility, parent, archived, start).lastInsertRowid);
  for (const userId of [].concat(assignees)) {
    db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(id, userId);
  }
  if (completedAt) {
    db.prepare('INSERT INTO task_completions (task_id, series_id, user_id, completed_at) VALUES (?, ?, ?, ?)')
      .run(id, id, [].concat(assignees)[0] ?? ANNA, completedAt);
  }
  return id;
}
const titles = (list) => (list ?? []).map((task) => task.title);

// Donnerstag, 08.10.2026, 12:00 in Berlin.
const NOON_BERLIN = '2026-10-08T10:00:00Z';

// --------------------------------------------------------------------------
// 1. Server
// --------------------------------------------------------------------------

test('Server: Titel je Mitglied, ohne den Fuenfer-Deckel des Haushalts', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  for (let i = 1; i <= 6; i++) addTask(`Anna ${i}`, ANNA);
  addTask('Bens siebte', BEN);
  const by = await wallTasksFor();
  assert.equal(by[ANNA].open_count, 6);
  assert.deepEqual(titles(by[ANNA].open), ['Anna 1', 'Anna 2', 'Anna 3', 'Anna 4', 'Anna 5', 'Anna 6']);
  assert.deepEqual(titles(by[BEN].open), ['Bens siebte'], 'die siebte Aufgabe des Haushalts steht unter ihrer Person');
}));

test('Server: die Zahl ist ungekappt, die Titel sind es nicht', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  for (let i = 1; i <= 9; i++) addTask(`Viel ${i}`, BEN);
  const by = await wallTasksFor();
  assert.equal(by[BEN].open_count, 9);
  assert.equal(by[BEN].open.length, 6);
}));

test('Server: nur haushaltssichtbare Aufgaben - auch aus der Sitzung der zugewiesenen Person', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  addTask('Fuer alle', BEN);
  addTask('Nur Zugewiesene', BEN, { visibility: 'assignees', createdBy: BEN });
  addTask('Privat', BEN, { visibility: 'private', createdBy: BEN });
  addTask('Erledigt und privat', BEN, { visibility: 'assignees', createdBy: BEN, status: 'done' });
  for (const who of [ANNA, BEN]) {
    const by = await wallTasksFor(who);
    assert.deepEqual(titles(by[BEN].open), ['Fuer alle'], `Betrachter ${who === BEN ? 'Ben selbst' : 'Anna'}`);
    assert.equal(by[BEN].open_count, 1);
    assert.equal(by[BEN].done_count, 0);
  }
}));

test('Server: ueberfaellig zaehlt zu heute, morgen nicht', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  addTask('Von gestern', CLEO, { due: '2026-10-07' });
  addTask('Heute', CLEO);
  addTask('Morgen', CLEO, { due: '2026-10-09' });
  addTask('Ohne Datum', CLEO, { due: null });
  const by = await wallTasksFor();
  assert.deepEqual(titles(by[CLEO].open), ['Von gestern', 'Heute'], 'das Aeltere zuerst');
}));

test('Server: das Aeltere zuerst - nach Faelligkeit, nicht nach Anlage', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  addTask('Heute, zuerst angelegt', CLEO);
  addTask('Von vorgestern, spaeter angelegt', CLEO, { due: '2026-10-06' });
  addTask('Heute um neun', CLEO, { dueTime: '09:00' });
  const by = await wallTasksFor();
  assert.deepEqual(titles(by[CLEO].open), ['Von vorgestern, spaeter angelegt', 'Heute um neun', 'Heute, zuerst angelegt']);
}));

test('Server: Begonnenes ist offen', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  addTask('Angefangen', BEN, { status: 'in_progress' });
  const by = await wallTasksFor();
  assert.deepEqual(titles(by[BEN].open), ['Angefangen']);
  assert.equal(by[BEN].open_count, 1);
  assert.equal(by[BEN].done_count, 0);
}));

test('Server: die Kategorie-Auswahl der Uebersicht gilt auch fuer die Wand', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  const school = addTask('Schule', BEN);
  const home = addTask('Haushalt', BEN);
  const doneHome = addTask('Haushalt erledigt', BEN, { status: 'done' });
  db.prepare("UPDATE tasks SET category = 'school' WHERE id = ?").run(school);
  db.prepare("UPDATE tasks SET category = 'household' WHERE id IN (?, ?)").run(home, doneHome);
  viewer = ANNA;
  const all = Object.fromEntries((await (await fetch(`${base}/?audience=household`)).json()).wallTasks.map((e) => [e.user_id, e]));
  assert.equal(all[BEN].open_count, 2, 'Vorbedingung: ohne Auswahl beide');
  const filtered = Object.fromEntries((await (await fetch(`${base}/?audience=household&tasks_category=school`)).json()).wallTasks.map((e) => [e.user_id, e]));
  assert.deepEqual(titles(filtered[BEN].open), ['Schule']);
  assert.equal(filtered[BEN].done_count, 0, 'auch das Erledigte folgt der Auswahl');
}));

test('Server: heute faellig und erledigt behaelt den Haken auch OHNE Abschlusszeile', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  // Zwei Schreiber setzen `status = 'done'`, ohne `task_completions` zu fuellen
  // (der Abgleich mit CalDAV-Erinnerungen, die Haushaltshilfe). Der Tag der
  // Faelligkeit traegt den Haken dann allein.
  const id = addTask('In Erinnerungen abgehakt', BEN, { status: 'done' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_completions WHERE task_id = ?').get(id).n, 0, 'Vorbedingung: keine Abschlusszeile');
  // Die bekannte Grenze daneben: war sie UEBERFAELLIG, fehlt ohne Abschlusszeile
  // der Tag, an dem sie erledigt wurde - sie steht dann nicht mehr an der Wand.
  addTask('Ueberfaellig, ohne Abschlusszeile abgehakt', BEN, { due: '2026-10-07', status: 'done' });
  const by = await wallTasksFor();
  assert.deepEqual(titles(by[BEN].done), ['In Erinnerungen abgehakt']);
}));

test('Server: mehrere Zugewiesene - die Aufgabe steht unter jeder Person', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  addTask('Zusammen', [BEN, CLEO]);
  const by = await wallTasksFor();
  assert.deepEqual(titles(by[BEN].open), ['Zusammen']);
  assert.deepEqual(titles(by[CLEO].open), ['Zusammen']);
}));

test('Server: Unteraufgaben, Abgelegtes und noch nicht Begonnenes stehen nicht an der Wand', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  const parent = addTask('Eltern', BEN);
  addTask('Kind', BEN, { parent });
  addTask('Abgelegt', BEN, { archived: '2026-10-08T08:00:00Z' });
  addTask('Beginnt morgen', BEN, { start: '2026-10-09' });
  const by = await wallTasksFor();
  assert.deepEqual(titles(by[BEN].open), ['Eltern']);
}));

test('Server: Erledigtes von heute kommt mit - faellig heute, oder ueberfaellig und heute abgehakt', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  addTask('Offen', BEN);
  addTask('Heute faellig, erledigt', BEN, { status: 'done', completedAt: '2026-10-08T07:00:00Z' });
  addTask('Gestern faellig, heute abgehakt', BEN, { due: '2026-10-07', status: 'done', completedAt: '2026-10-08T08:00:00Z' });
  addTask('Gestern faellig, gestern abgehakt', BEN, { due: '2026-10-07', status: 'done', completedAt: '2026-10-07T15:00:00Z' });
  addTask('Morgen faellig, heute abgehakt', BEN, { due: '2026-10-09', status: 'done', completedAt: '2026-10-08T08:00:00Z' });
  const by = await wallTasksFor();
  assert.deepEqual(titles(by[BEN].open), ['Offen']);
  assert.deepEqual(titles(by[BEN].done).sort(), ['Gestern faellig, heute abgehakt', 'Heute faellig, erledigt']);
  assert.equal(by[BEN].done_count, 2);
}));

test('Server: wer alles erledigt hat, bleibt bis zum Tageswechsel stehen - und nicht laenger', async () => {
  const seed = () => addTask('Geschafft', CLEO, { status: 'done', completedAt: '2026-10-08T09:00:00Z' });
  await withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
    seed();
    const by = await wallTasksFor();
    assert.deepEqual(titles(by[CLEO].done), ['Geschafft']);
    assert.equal(by[CLEO].open_count, 0);
  })();
  // 09.10. 00:30 in Berlin.
  await withClock('2026-10-08T22:30:00Z', 'Europe/Berlin', async () => {
    seed();
    const by = await wallTasksFor();
    assert.equal(by[CLEO], undefined, 'mit dem neuen Tag ist die Spalte leer');
  })();
});

test('Server: der Tag einer Erledigung ist der des Haushalts, nicht der UTC-Tag', async () => {
  // Abgehakt am 07.10. um 23:30 UTC: in Berlin der 08.10. 01:30, in Los Angeles der 07.10. 16:30.
  const seed = () => addTask('Spaet abgehakt', BEN, { due: '2026-10-06', status: 'done', completedAt: '2026-10-07T23:30:00Z' });
  await withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
    seed();
    assert.deepEqual(titles((await wallTasksFor())[BEN]?.done), ['Spaet abgehakt'], 'Berlin: das war heute');
  })();
  // 08.10. 09:00 in Los Angeles.
  await withClock('2026-10-08T16:00:00Z', 'America/Los_Angeles', async () => {
    seed();
    assert.equal((await wallTasksFor())[BEN], undefined, 'Los Angeles: das war gestern');
  })();
});

// --------------------------------------------------------------------------
// 2.-5. Plan, Flaeche, Verdrahtung, Nacht von „Wer heute dran ist":
//       MIT TAFLA (2026-10-19) IM RUHESTAND
// --------------------------------------------------------------------------
//
// Hier standen die Leiter (`planWallWhoLines`, `WALL_WHO_LADDER`), der Abstieg
// (`fitWallWho`) und die Nachtstufen der Aufgaben unter den Gesichtern. Die
// Tafla-Wand hat keinen Abschnitt „Wer heute dran ist" mehr (Artboard „Ściana",
// Owner-Entscheidung 2026-10-19: „no duplicate Who's up") - wer dran ist, sagt
// die Scheibe an jeder Zeile der Dziś-Karte. Die Absicht der Leiter - die Wand
// scrollt nicht, also folgt die Zeilenzahl dem Platz - lebt im Hoehenbudget
// der Dziś-Karte weiter (`planWallRows`/`fitWallLists`, test:wall-tafla). Der
// Server liefert `wallTasks` weiter fuer API-Nutzer (Abschnitt 1); die Wand
// zeichnet es nicht mehr und bekommt es nicht (Abschnitt 8).

const { __test: dash } = await import('../public/pages/dashboard.js');
const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const { setHouseholdSize, clearHouseholdSize } = await import('../public/utils/household.js');

function onWall(fn) {
  return async () => {
    const prevWindow = global.window;
    const prevDocument = global.document;
    global.window = { yuvomi: { isModuleDisabled: () => false }, innerHeight: 800 };
    global.document = { documentElement: { classList: { toggle() {}, add() {}, remove() {} } } };
    setPermissions({ admin: true, modules: {}, widgets: {}, capabilities: {} });
    setHouseholdSize(4);
    try {
      await fn();
    } finally {
      clearHouseholdSize();
      clearPermissions();
      global.window = prevWindow;
      global.document = prevDocument;
    }
  };
}

test('Tafla: die Wand zeichnet keinen Abschnitt „Wer heute dran ist" mehr - die Scheiben an den Zeilen sagen es', onWall(() => {
  const html = dash.renderWallSurface({
    planTasks: [{ id: 1, title: 'Tisch decken', status: 'open', due_date: '2026-10-08', assigned_users: [{ id: 7, display_name: 'Cleo' }] }],
    users: [{ id: 7, display_name: 'Cleo', avatar_color: '#7C3AED' }],
  }, null, { now: new Date('2026-10-08T10:00:00Z') });
  assert.match(html, /Tisch decken/, 'Reichweite: die Wand ist gebaut');
  assert.ok(!/wall__who|wall-who__member/.test(html), 'kein zweiter Ort fuer „wer ist dran"');
  assert.match(html, /aria-label="Cleo"/, 'die Zeile traegt Cleos Scheibe');
  assert.ok(!('planWallWhoLines' in dash) && !('WALL_WHO_LADDER' in dash), 'die Leiter ist nicht mehr exportiert');
}));

// --------------------------------------------------------------------------
// 6. Die Wand ist eine geteilte Flaeche: `audience=household`
// --------------------------------------------------------------------------

const { dashboardRequest, dashboardQueryFiltersCounts } = await import('../public/utils/dashboard-widgets.js');
const tzClient = await import('/utils/timezone.js');

async function overview(userId, query = '') {
  viewer = userId;
  const res = await fetch(`${base}/${query}`);
  assert.equal(res.status, 200);
  return res.json();
}

function addEvent(title, { start = '2026-10-08T18:00', end = '2026-10-08T19:00', visibility = 'all', createdBy = ANNA, assignees = [], subscription = null } = {}) {
  const id = Number(db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, visibility, created_by, subscription_id, external_source)
    VALUES (?, ?, ?, 0, ?, ?, ?, ?)
  `).run(title, start, end, visibility, createdBy, subscription, subscription ? 'ics' : 'local').lastInsertRowid);
  for (const userId of assignees) db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, userId);
  return id;
}
function addSubscription(name, { shared, createdBy }) {
  return Number(db.prepare('INSERT INTO ics_subscriptions (name, url, shared, created_by) VALUES (?, ?, ?, ?)')
    .run(name, `https://example.invalid/${randomUUID()}.ics`, shared ? 1 : 0, createdBy).lastInsertRowid);
}
function seedSharedSurface() {
  db.prepare('DELETE FROM calendar_events').run();
  db.prepare('DELETE FROM ics_subscriptions').run();
  addTask('Aufgabe fuer alle', BEN);
  addTask('Aufgabe nur Zugewiesene', BEN, { visibility: 'assignees', createdBy: BEN });
  addTask('Aufgabe privat', BEN, { visibility: 'private', createdBy: BEN });
  addTask('Erledigt nur Zugewiesene', BEN, { visibility: 'assignees', createdBy: BEN, status: 'done' });
  addEvent('Termin fuer alle', { assignees: [ANNA] });
  addEvent('Termin nur Zugewiesene', { visibility: 'assignees', createdBy: BEN, assignees: [BEN] });
  addEvent('Termin privat', { visibility: 'private', createdBy: BEN });
  addEvent('Aus Bens eigenem Abo', { subscription: addSubscription('Bens Dienstplan', { shared: false, createdBy: BEN }), createdBy: BEN });
  addEvent('Aus dem geteilten Abo', { subscription: addSubscription('Schulferien', { shared: true, createdBy: BEN }), createdBy: BEN });
}
const PRIVATE_TITLES = ['Aufgabe nur Zugewiesene', 'Aufgabe privat', 'Erledigt nur Zugewiesene',
  'Termin nur Zugewiesene', 'Termin privat', 'Aus Bens eigenem Abo'];
const eventTitles = (list) => (list ?? []).map((event) => event.title).sort();

test('Geteilte Flaeche: ohne den Parameter bleibt die Uebersicht persoenlich', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedSharedSurface();
  const mine = await overview(BEN);
  assert.deepEqual(titles(mine.urgentTasks).sort(), ['Aufgabe fuer alle', 'Aufgabe nur Zugewiesene', 'Aufgabe privat']);
  assert.deepEqual(eventTitles(mine.upcomingEvents),
    ['Aus Bens eigenem Abo', 'Aus dem geteilten Abo', 'Termin fuer alle', 'Termin nur Zugewiesene', 'Termin privat']);
  assert.equal(mine.openTaskCount, 3);
  assert.equal(mine.tasksDoneToday, 1);
  assert.deepEqual(mine.wallTasks, [], 'die persoenliche Antwort rechnet das Feld der geteilten Flaeche nicht');
}));

test('Geteilte Flaeche: die Haushaltsfassung traegt in KEINER Scheibe etwas Eingeschraenktes - auch nicht fuer die Besitzerin', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedSharedSurface();
  for (const who of [BEN, ANNA]) {
    const wall = await overview(who, '?audience=household');
    const label = who === BEN ? 'Sitzung des Besitzers' : 'Sitzung eines anderen Mitglieds';
    // TAFLA: die Wand liest den Tagesplan (planTasks, planEvents) - in der
    // Haushaltsfassung. Programm-Felder des alten Wand-Layouts kommen leer.
    assert.deepEqual(titles(wall.planTasks), ['Aufgabe fuer alle'], label);
    assert.deepEqual(eventTitles(wall.planEvents), ['Aus dem geteilten Abo', 'Termin fuer alle'], label);
    assert.deepEqual(wall.urgentTasks, [], label);
    assert.equal(wall.tasksDoneToday, 0, label);
    // `wallTasks` (#1817) kommt mit - nur haushaltssichtbar, wie der Plan.
    const named = wall.wallTasks.flatMap((entry) => [...entry.open, ...entry.done]).map((task) => task.title);
    assert.deepEqual(named, ['Aufgabe fuer alle'], label);
    assert.deepEqual(eventTitles(wall.upcomingEvents), ['Aus dem geteilten Abo', 'Termin fuer alle'], label);
    // Was die Wand nicht zeichnet, kommt seit der Allowlist leer (Abschnitt 8):
    // die Zahlen der Kacheln, der Wochenstreifen, die Familienkarte.
    assert.equal(wall.openTaskCount, 0, label);
    assert.equal(wall.overdueTaskCount, 0, label);
    assert.deepEqual(wall.memberTodayTasks, [], label);
    assert.deepEqual(wall.weekEvents, [], label);
    assert.deepEqual(wall.familyEvents, [], label);
    const text = JSON.stringify([wall.planTasks, wall.planEvents, wall.upcomingEvents, wall.weekEvents, wall.familyEvents]);
    for (const title of PRIVATE_TITLES) assert.ok(!text.includes(title), `${label}: „${title}" reist nicht mit`);
  }
}));

// Ein Parameter, der zweimal in der Adresse steht, kommt als LISTE an. Der
// Vergleich mit dem einen Wort fiel dann durch, und die Antwort war wieder die
// persoenliche - ein Schalter, der nur verengt, darf beim Stolpern nicht weiter
// oeffnen als verlangt.
test('Geteilte Flaeche: der Parameter gilt auch, wenn er doppelt in der Adresse steht', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedSharedSurface();
  const wall = await overview(BEN, '?audience=household&audience=household');
  assert.deepEqual(titles(wall.planTasks), ['Aufgabe fuer alle']);
  assert.equal(wall.openTaskCount, 0);
  assert.deepEqual(eventTitles(wall.upcomingEvents), ['Aus dem geteilten Abo', 'Termin fuer alle']);
  // Ein anderes Wort bleibt, was es war: keine Haushaltsfassung.
  assert.equal((await overview(BEN, '?audience=me')).openTaskCount, 3);
}));

test('Geteilte Flaeche: beide Fassungen sagen jedem Mitglied dasselbe', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedSharedSurface();
  const pick = (body) => [titles(body.planTasks), eventTitles(body.planEvents), eventTitles(body.upcomingEvents)];
  assert.deepEqual(pick(await overview(BEN, '?audience=household')), pick(await overview(CLEO, '?audience=household')));
}));

test('Geteilte Flaeche: „nur meine" gilt an der Wand nicht - sie ist niemandes', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedSharedSurface();
  const personal = await overview(BEN, '?events_scope=mine');
  assert.deepEqual(eventTitles(personal.upcomingEvents), ['Termin nur Zugewiesene'], 'Vorbedingung: persoenlich greift die Auswahl');
  const wall = await overview(BEN, '?events_scope=mine&audience=household');
  assert.deepEqual(eventTitles(wall.upcomingEvents), ['Aus dem geteilten Abo', 'Termin fuer alle']);
}));

test('Geteilte Flaeche: die gebaute Wand zeigt nichts davon, und wer nur darueber dran waere, traegt keine Scheibe', async () => {
  let wall;
  let personal;
  await withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
    db.prepare('DELETE FROM calendar_events').run();
    db.prepare('DELETE FROM ics_subscriptions').run();
    // Ben ist NUR ueber Eingeschraenktes dran, Cleo ueber etwas fuer alle.
    addTask('Geheime Aufgabe', BEN, { visibility: 'assignees', createdBy: BEN });
    addEvent('Geheimer Termin', { visibility: 'assignees', createdBy: BEN, assignees: [BEN] });
    addTask('Tisch decken', CLEO);
    wall = await overview(BEN, '?audience=household');
    personal = await overview(BEN);
  })();
  await onWall(() => {
    mock.timers.enable({ apis: ['Date'], now: new Date(NOON_BERLIN) });
    tzClient.setDisplayTimeZone('Europe/Berlin');
    try {
      const now = new Date();
      const before = dash.renderWallSurface(personal, null, { now });
      assert.ok(before.includes('Geheime Aufgabe') && before.includes('Geheimer Termin'),
        'Reichweite: aus der persoenlichen Antwort gebaut, stuende beides an der Wand');
      const html = dash.renderWallSurface(wall, null, { now });
      assert.match(html, /Tisch decken/, 'Reichweite: die Wand ist gebaut und zeigt, was alle sehen duerfen');
      assert.ok(!html.includes('Geheime Aufgabe'), 'die eingeschraenkte Aufgabe steht an keiner Stelle der Wand');
      assert.ok(!html.includes('Geheimer Termin'), 'der eingeschraenkte Termin auch nicht');
      assert.match(html, /aria-label="Cleo"/, 'Cleos Zeile traegt ihre Scheibe');
      assert.ok(!html.includes('aria-label="Ben"'), 'wer nur ueber Eingeschraenktes dran waere, erscheint an keiner Zeile');
    } finally {
      tzClient.setDisplayTimeZone(null);
      mock.timers.reset();
    }
  })();
});

test('Geteilte Flaeche: die Wand fragt die Haushaltsfassung ab, die Uebersicht nicht', async () => {
  assert.equal(dashboardRequest('/dashboard', { wall: true }), '/dashboard?audience=household');
  assert.equal(dashboardRequest('/dashboard?tasks_category=school', { wall: true }), '/dashboard?tasks_category=school&audience=household');
  assert.equal(dashboardRequest('/dashboard?events_scope=mine', { wall: false }), '/dashboard?events_scope=mine');
  assert.equal(dashboardRequest('/dashboard'), '/dashboard');
  // Die Zahlen der Haushaltsfassung sind nicht die der Person: sie gelten dem
  // Speicher der Navigations-Badges als gefiltert und werden dort nie angenommen.
  assert.equal(dashboardQueryFiltersCounts(dashboardRequest('/dashboard', { wall: true })), true);
  assert.equal(dashboardQueryFiltersCounts(dashboardRequest('/dashboard?events_limit=8', { wall: true })), true);
  assert.equal(dashboardQueryFiltersCounts(dashboardRequest('/dashboard', { wall: false })), false);
  // JEDER Abruf der Seite geht durch diese eine Stelle - auch der stille
  // Refresh, sonst stuende nach einer Viertelstunde wieder die persoenliche
  // Fassung an der Wand.
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  // 2026-10-27, v2: die Seite fragt die Route ohne die Optionen der alten
  // Kacheln (`DASHBOARD_QUERY`) - es bleiben Start und stiller Refresh; das
  // Nachholen mit den Optionen und das Speichern der Optionen sind gegangen.
  const calls = [...page.matchAll(/api\.get\(([^\n]*(?:DASHBOARD_QUERY|dashboardQuery|layoutHintQuery)[^\n]*)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 2, `nur ${calls.length} Abrufe der Uebersicht gefunden - misst der Leser noch?`);
  const bare = calls.filter((call) => !call.startsWith('overviewRequest('));
  assert.deepEqual(bare, [], 'Abruf der Uebersicht an `overviewRequest` vorbei');
  assert.match(page, /const overviewRequest = \(query\) => dashboardRequest\(query, \{ wall: wallMode \}\);/);
});

// --------------------------------------------------------------------------
// 7. Die Wand laesst persoenliche Beitraege weg - wie das Display
// --------------------------------------------------------------------------
//
// #1838 hat Aufgaben und Termine auf „was jeder sehen darf" gestellt. Uebrig
// blieben die Beitraege zum Tagesprogramm, die keinem Sichtbarkeitsfeld folgen,
// sondern dem BETRACHTER gelten: die eigene Dosis, die eigene Schicht, die
// eigene Erinnerung, die Freigaben, die nur ein Admin entscheidet. Ein
// gekoppeltes Display bekam sie nie, eine Wand aus der Sitzung eines Mitglieds
// schon (gemessen an der Demo-Saat: „2 zu bestaetigen" und „Eisen 20:00").

const DISPLAY = addUser('Wandtablett');

async function reminders(userId, query = '') {
  viewer = userId;
  const res = await fetch(`${base}/reminders/pending${query}`);
  assert.equal(res.status, 200);
  return (await res.json()).data;
}
async function asCoupledDisplay(fn) {
  asDisplay = true;
  try { return await fn(); } finally { asDisplay = false; }
}

function seedPersonal() {
  for (const table of ['reminders', 'medication_schedules', 'medications', 'schedule_extra_shifts',
    'schedule_shift_types', 'reward_redemptions', 'reward_participants', 'calendar_events', 'ics_subscriptions']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  // Der Haushalt dieser Tests nutzt jedes Modul: ab Werk ist der Schichtplan
  // abgeschaltet, und eine Schicht, die gar nicht erst geliefert wird, kann
  // nicht zeigen, dass die Wand sie weglaesst.
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES ('disabled_modules', '[]')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run();
  // Etwas fuer alle - die Wand ist nie leer, und Cleo ist darueber dran.
  addTask('Tisch decken', CLEO);
  // Bens Dosis heute Abend.
  const med = db.prepare("INSERT INTO medications (user_id, name, active, visibility) VALUES (?, 'Eisen', 1, 'private')").run(BEN).lastInsertRowid;
  db.prepare("INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, active) VALUES (?, '20:00', NULL, 1)").run(med);
  // Bens Schicht heute.
  const shift = db.prepare(`
    INSERT INTO schedule_shift_types (name, short_code, start_time, end_time, color, created_by)
    VALUES ('Fruehdienst', 'F', '06:00', '14:00', '#00668F', ?)
  `).run(ANNA).lastInsertRowid;
  db.prepare('INSERT INTO schedule_extra_shifts (user_id, date_key, shift_type_id, created_by) VALUES (?, ?, ?, ?)')
    .run(BEN, '2026-10-08', shift, ANNA);
  // Bens Erinnerung an eine Aufgabe, die JEDER sehen darf und die heute nicht
  // im Programm steht: die Aufgabe ist Haushaltssache, die Erinnerung ist seine.
  const later = addTask('Steuer abgeben', BEN, { due: '2026-10-20' });
  db.prepare('INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES (?, ?, ?, ?)')
    .run('task', later, '2026-10-08T06:00:00Z', BEN);
  // Cleo sammelt Punkte und wartet auf eine Praemie und eine Auszahlung; Anna (Admin) gibt frei.
  db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(CLEO);
  db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(BEN);
  db.prepare("INSERT INTO reward_redemptions (user_id, reward_name, cost, status) VALUES (?, 'Kinoabend', 10, 'pending')").run(CLEO);
  db.prepare("INSERT INTO reward_redemptions (user_id, reward_name, cost, status, kind, currency) VALUES (?, 'Auszahlung', 5, 'pending', 'withdrawal', 'EUR')").run(CLEO);
}
const PERSONAL_WORDS = ['Eisen', 'Fruehdienst', 'Steuer abgeben', 'Kinoabend'];
/** Die Dziś-Karte der gebauten Wand - ohne Uhr und Dock. */
function wallParts(body) {
  const html = dash.renderWallSurface(body, null, { now: new Date() });
  return { html, program: (/<section class="wall-card wall-plan"[\s\S]*?<\/section>/.exec(html) || [''])[0] };
}
function onWallAt(iso, fn) {
  return onWall(() => {
    mock.timers.enable({ apis: ['Date'], now: new Date(iso) });
    tzClient.setDisplayTimeZone('Europe/Berlin');
    try { return fn(); } finally { tzClient.setDisplayTimeZone(null); mock.timers.reset(); }
  });
}

test('Persoenliches: ohne den Parameter bleibt die Uebersicht persoenlich', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedPersonal();
  const ben = await overview(BEN);
  assert.equal(ben.health.dosesTotal, 1);
  assert.deepEqual(ben.health.nextDose, { name: 'Eisen', time: '20:00' });
  assert.deepEqual(ben.myShiftsToday.map((entry) => entry.shift_type.name), ['Fruehdienst']);
  assert.deepEqual((await reminders(BEN)).map((row) => row.entity_title), ['Steuer abgeben']);
  const anna = await overview(ANNA);
  assert.equal(anna.rewards.view, 'approver');
  assert.equal(anna.rewards.pending, 1);
  assert.equal(anna.rewards.moneyPending, 1);
  const cleo = await overview(CLEO);
  assert.equal(cleo.rewards.view, 'self');
  assert.equal(cleo.rewards.pending, 1);
  assert.deepEqual(cleo.rewards.standings.map((row) => row.id), [CLEO], 'Vorbedingung: ein Kind bekommt nur die eigene Zeile');
}));

test('Persoenliches: die Haushaltsfassung traegt es gar nicht - auch nicht fuer die Person, der es gilt', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedPersonal();
  const display = await asCoupledDisplay(() => overview(DISPLAY));
  assert.equal(display.health.dosesTotal, 0, 'Massstab: ein Display bekommt keine Dosen');
  assert.deepEqual(display.myShiftsToday, [], 'Massstab: und keine Schicht');
  for (const [who, label] of [[BEN, 'Ben, dem Dosis, Schicht und Erinnerung gelten'], [ANNA, 'Anna, die freigibt'], [CLEO, 'Cleo, die wartet']]) {
    const wall = await overview(who, '?audience=household');
    assert.deepEqual(wall.health, display.health, `${label}: Dosen in der leeren Fassung des Displays`);
    assert.deepEqual(wall.fasting, display.fasting, label);
    assert.deepEqual(wall.nutrition, display.nutrition, label);
    assert.deepEqual(wall.myShiftsToday, [], `${label}: keine Schicht`);
    assert.equal(wall.rewards.view, null, `${label}: keine Sicht auf Belohnungen`);
    assert.equal(wall.rewards.pending, 0, `${label}: keine wartende Praemie`);
    // Als ZAHL, wie in jeder anderen Fassung der Scheibe - die leere Form
    // liess das Feld aus (Codex an #1900).
    assert.equal(wall.rewards.moneyPending, 0, `${label}: keine wartende Auszahlung`);
    // Der Parameter verengt nur: aus der Sitzung eines Kindes oeffnet er nicht
    // die Zeilen der Geschwister, die die Sicht `self` zurueckhaelt.
    assert.deepEqual(wall.rewards.standings, [], `${label}: keine Staende`);
    assert.deepEqual(wall.rewards.recent, [], label);
    assert.deepEqual(await reminders(who, '?audience=household'), [], `${label}: keine Erinnerung`);
    const text = JSON.stringify(wall);
    for (const word of ['Eisen', 'Fruehdienst', 'Kinoabend']) assert.ok(!text.includes(word), `${label}: „${word}" reist nicht mit`);
    assert.ok(titles(wall.planTasks).includes('Tisch decken'), `${label}: Reichweite - was alle sehen duerfen, steht da`);
  }
}));

test('Persoenliches: auch die Erinnerungen fallen bei doppeltem Parameter nicht auf die persoenliche Fassung zurueck', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedPersonal();
  assert.deepEqual(await reminders(BEN, '?audience=household&audience=household'), []);
  assert.equal((await overview(BEN, '?audience=household&audience=household')).health.dosesTotal, 0);
  // Ein anderes Wort bleibt, was es war.
  assert.equal((await reminders(BEN, '?audience=me')).length, 1);
  assert.equal((await overview(BEN, '?audience=me')).health.dosesTotal, 1);
}));

test('Persoenliches: das Display bekommt, was es bekam', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedPersonal();
  const display = await asCoupledDisplay(() => overview(DISPLAY));
  // Belohnungen sind eines der Module, die ein Display lesen darf: seine
  // normale Uebersicht behaelt die Sicht `family`, ohne fremde Anfragen.
  assert.equal(display.rewards.view, 'family');
  assert.equal(display.rewards.pending, 0);
  assert.equal(display.rewards.moneyPending, 0);
  assert.deepEqual(display.rewards.standings.map((row) => row.id).sort(), [BEN, CLEO].sort());
  assert.ok(titles(display.urgentTasks).includes('Tisch decken'));
}));

test('Persoenliches: die Wand ist aus jeder Sitzung dieselbe wie auf dem Display, die Uebersicht bleibt persoenlich', async () => {
  const personal = {};
  const wall = {};
  let wallReminders;
  let ownReminders;
  await withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
    seedPersonal();
    for (const [name, id] of [['ben', BEN], ['anna', ANNA], ['cleo', CLEO]]) {
      personal[name] = await overview(id);
      wall[name] = await overview(id, '?audience=household');
    }
    wall.display = await asCoupledDisplay(() => overview(DISPLAY, '?audience=household'));
    ownReminders = await reminders(BEN);
    wallReminders = await reminders(BEN, '?audience=household');
  })();
  await onWallAt(NOON_BERLIN, () => {
    // REICHWEITE: aus der persoenlichen Antwort gebaut, stuende es an der Wand.
    const before = wallParts({ ...personal.ben, pendingReminders: ownReminders });
    for (const word of ['Eisen', 'Fruehdienst', 'Steuer abgeben']) {
      assert.ok(before.program.includes(word), `Reichweite: persoenlich gebaut stuende „${word}" im Programm`);
    }

    const shown = wallParts({ ...wall.ben, pendingReminders: wallReminders });
    assert.match(shown.program, /Tisch decken/, 'Reichweite: die Wand ist gebaut');
    for (const word of PERSONAL_WORDS) assert.ok(!shown.html.includes(word), `„${word}" steht an keiner Stelle der Wand`);
    // EINE WAND: wer sie oeffnet, aendert nichts an ihr.
    for (const name of ['anna', 'cleo', 'display']) {
      const other = wallParts({ ...wall[name], pendingReminders: [] });
      assert.equal(other.program, shown.program, `Programm aus der Sitzung „${name}" ist dasselbe`);
    }
  })();
});

test('Persoenliches: genommene Dosen machen aus einem freien Tag an der Wand kein „Alles erledigt"', async () => {
  let personal;
  let wall;
  await withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
    seedPersonal();
    db.prepare('DELETE FROM tasks').run();
    db.prepare('DELETE FROM reminders').run();
    db.prepare('DELETE FROM schedule_extra_shifts').run();
    const med = db.prepare("SELECT id FROM medications WHERE name = 'Eisen'").get().id;
    db.prepare("INSERT INTO medication_logs (medication_id, scheduled_at, status) VALUES (?, '2026-10-08T20:00', 'taken')").run(med);
    personal = await overview(BEN);
    wall = await overview(BEN, '?audience=household');
    db.prepare('DELETE FROM medication_logs').run();
  })();
  assert.equal(personal.health.dosesTaken, 1, 'Vorbedingung: die Dosis ist genommen');
  await onWallAt(NOON_BERLIN, () => {
    assert.match(wallParts(personal).program, /wall\.allDone/, 'Reichweite: persoenlich gebaut sagte die Wand „Na dziś wszystko"');
    const program = wallParts(wall).program;
    assert.ok(!program.includes('wall.allDone'), 'die Wand sagt es nicht ueber die Dosen einer Person');
    assert.match(program, /today\.freeDay/, 'sie sagt „Nic pilnego"');
  })();
});

test('Persoenliches: die Erinnerungen der Seite gehen durch dieselbe Stelle wie die Uebersicht', async () => {
  const asked = [];
  const get = async (path) => { asked.push(path); return { data: [{ id: 1 }] }; };
  assert.deepEqual(await dash.loadPendingReminders((path) => dashboardRequest(path, { wall: true }), get), [{ id: 1 }]);
  assert.deepEqual(await dash.loadPendingReminders((path) => dashboardRequest(path, { wall: false }), get), [{ id: 1 }]);
  assert.deepEqual(asked, ['/reminders/pending?audience=household', '/reminders/pending']);
  // Und die Seite reicht an BEIDEN Stellen ihre eine Regel herein - der stille
  // Refresh braechte sonst nach einer Viertelstunde die Erinnerungen zurueck.
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const calls = [...page.matchAll(/(?<!function )loadPendingReminders\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 2, `nur ${calls.length} Aufrufe gefunden - misst der Leser noch?`);
  assert.deepEqual(calls.filter((args) => args !== 'overviewRequest'), [], 'Erinnerungen an `overviewRequest` vorbei geladen');
});

// EIN ABRUF FUER GLOCKE UND UEBERSICHT (Critique R19, Nachlese 1b). Beim Start
// ging `/reminders/pending` zweimal hinaus: die Glocke fragte gleich nach der
// Anmeldung, das Heute-Blatt der Uebersicht 0,7 s spaeter dieselbe Adresse.
test('Erinnerungen: Glocke und Uebersicht teilen sich beim Start EINEN Abruf', async () => {
  const { fetchPendingReminders, forgetPendingReminders, PENDING_SHARE_MS: SHARE_MS } = await import('../public/utils/dashboard-widgets.js');
  forgetPendingReminders();
  const asked = [];
  const get = async (path) => { asked.push(path); return { data: [{ id: asked.length }] }; };
  const bell = fetchPendingReminders('/reminders/pending', { get, now: 1000 });
  const sheet = fetchPendingReminders('/reminders/pending', { get, now: 1700 });
  assert.equal(sheet, bell, 'dieselbe Adresse kurz danach bekommt denselben Abruf');
  await sheet;
  assert.deepEqual(asked, ['/reminders/pending']);
  await fetchPendingReminders('/reminders/pending?audience=household', { get, now: 1800 });
  assert.equal(asked.length, 2, 'eine andere Reichweite ist eine andere Frage');
  await fetchPendingReminders('/reminders/pending?audience=household', { get, now: 1800 + SHARE_MS });
  assert.equal(asked.length, 3, 'nach dem Fenster wird neu gefragt');
  await fetchPendingReminders('/reminders/pending?audience=household', { get, now: 1801 + SHARE_MS, fresh: true });
  assert.equal(asked.length, 4, 'frisch heisst frisch');
  forgetPendingReminders();
  await fetchPendingReminders('/reminders/pending?audience=household', { get, now: 1802 + SHARE_MS });
  assert.equal(asked.length, 5, 'vergessen heisst neu fragen');
  const broken = fetchPendingReminders('/reminders/pending', { get: async () => { throw new Error('weg'); }, now: 9000 });
  await assert.rejects(broken);
  await fetchPendingReminders('/reminders/pending', { get, now: 9001 });
  assert.equal(asked.length, 6, 'ein Fehler wird nicht weitergereicht');
  forgetPendingReminders();

  // Die Verdrahtung: beide Stellen gehen durch den geteilten Abruf, die Glocke
  // fragt nach einer eigenen Aenderung frisch und vergisst beim Wegklicken und
  // beim Abmelden.
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  assert.match(page, /async function loadPendingReminders\(request = \(path\) => path, get = \(path\) => fetchPendingReminders\(path, \{ get: \(p\) => api\.get\(p\) \}\)\)/);
  const bellSrc = readFileSync(new URL('../public/reminders.js', import.meta.url), 'utf8');
  assert.match(bellSrc, /await fetchPendingReminders\(dashboardRequest\('\/reminders\/pending', \{ wall \}\), \{ get: \(path\) => api\.get\(path\), fresh \}\)/);
  assert.doesNotMatch(bellSrc, /api\.get\(dashboardRequest\('\/reminders\/pending'/);
  assert.match(bellSrc, /function refresh\(\) \{\s*poll\(\{ fresh: true \}\);/);
  assert.match(bellSrc, /\/dismiss`, \{\}\);\s*forgetPendingReminders\(\);/);
  assert.match(bellSrc, /function stop\(\) \{[\s\S]*?forgetPendingReminders\(\);[\s\S]*?\n\}/);
});

// Die Glocke der Shell pollt denselben Endpunkt jede Minute und macht aus einer
// faelligen Erinnerung einen Toast (30 s) und eine Browser-Benachrichtigung -
// ueber der Wand eines Mitglieds stuende damit doch wieder, was nur ihm gilt
// (Codex an #1900). Ein gekoppeltes Display pollt gar nicht. Gemessen gegen die
// ECHTE Route: der Stub reicht die Anfrage der Glocke an den Server durch.
test('Persoenliches: die Glocke der Shell fragt ueber einer Wand die Haushaltsfassung ab - kein Toast, keine Benachrichtigung', async () => {
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.style = { setProperty() {} }; this.classList = { add() {} }; }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute(name, value) { this[name] = value; }
    addEventListener() {}
    querySelectorAll() { return []; }
    remove() {}
  }
  const surface = new El('div');
  const notifications = [];
  class FakeNotification {
    static permission = 'granted';
    constructor(title, options) { notifications.push({ title, options }); }
  }
  const asked = [];
  const store = new Map();
  const saved = {};
  const realSetTimeout = globalThis.setTimeout;
  const timers = [];
  const globals = {
    document: { createElement: (tag) => new El(tag), createElementNS: (_ns, tag) => new El(tag), getElementById: () => surface, querySelectorAll: () => [], documentElement: { hasAttribute: () => false } },
    window: { Notification: FakeNotification, yuvomi: {} },
    Notification: FakeNotification,
    localStorage: { getItem: (key) => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) },
    location: { pathname: '/' },
    setInterval: () => 2,
    clearInterval: () => {},
    // Der Toast raeumt sich nach 30 s selbst ab - der Timer hielte den Prozess
    // so lange offen und liefe dann in abgebaute Globals. Er laeuft echt (die
    // Anfragen an die Route brauchen ihre eigenen) und wird am Ende geloescht.
    setTimeout: (...args) => { const handle = realSetTimeout(...args); timers.push(handle); return handle; },
  };
  for (const [name, value] of Object.entries(globals)) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  // Die Anfragen laufen echt ueber HTTP; erst auf ihre Antworten warten, dann
  // die Mikrotasks der Glocke ablaufen lassen (sonst ein Wettlauf, z. B. unter Windows).
  const inflight = [];
  const settle = async () => {
    await Promise.allSettled(inflight.splice(0));
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const bell = await import('../public/reminders.js');
  try {
    await withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
      seedPersonal();
      viewer = BEN;
      globalThis.__apiStub = {
        get: (path) => {
          asked.push(path);
          const answer = fetch(`${base}${path}`).then((res) => res.json());
          inflight.push(answer);
          return answer;
        },
      };
      // An der Wand: Schalter an, Route der Uebersicht.
      store.set('yuvomi-wall-mode', '1');
      bell.init();
      await settle();
      assert.deepEqual(asked, ['/reminders/pending?audience=household']);
      assert.equal(surface.children.length, 0, 'kein Toast ueber der Wand');
      assert.equal(notifications.length, 0, 'keine Browser-Benachrichtigung');

      // Dieselbe Sitzung auf einer anderen Seite: der Schalter allein macht keine Wand.
      globalThis.location.pathname = '/tasks';
      bell.refresh();
      await settle();
      assert.equal(asked.at(-1), '/reminders/pending');
      assert.equal(surface.children.length, 1, 'Reichweite: ausserhalb der Wand kommt der Toast - und er war nicht als gezeigt verbucht');
      assert.equal(notifications.at(-1)?.options.body, 'Steuer abgeben');

      // Und ohne den Schalter auf der Uebersicht ebenso persoenlich.
      store.delete('yuvomi-wall-mode');
      globalThis.location.pathname = '/';
      bell.refresh();
      await settle();
      assert.equal(asked.at(-1), '/reminders/pending');

      // EINE PERSOENLICHE ANTWORT, DIE UNTERWEGS WAR, ALS DIE WAND AUFGING
      // (Codex an #1900, zweite Runde): gefragt auf /tasks, angekommen ueber
      // der Wand. Sie wird verworfen und nicht als gezeigt verbucht.
      bell.stop();
      surface.children.length = 0;
      notifications.length = 0;
      store.set('yuvomi-wall-mode', '1');
      globalThis.location.pathname = '/tasks';
      const direct = globalThis.__apiStub.get;
      globalThis.__apiStub.get = async (path) => {
        const answer = await direct(path);
        globalThis.location.pathname = '/';
        return answer;
      };
      bell.refresh();
      await settle();
      assert.equal(asked.at(-1), '/reminders/pending', 'Reichweite: gefragt wurde persoenlich');
      assert.equal(surface.children.length, 0, 'die unterwegs gewesene Antwort wird ueber der Wand kein Toast');
      assert.equal(notifications.length, 0);
      globalThis.__apiStub.get = direct;
      globalThis.location.pathname = '/tasks';
      bell.refresh();
      await settle();
      assert.equal(surface.children.length, 1, 'und sie war nicht verbraucht: zurueck auf der Seite kommt der Toast');
    })();
  } finally {
    bell.stop();
    for (const handle of timers) clearTimeout(handle);
    delete globalThis.__apiStub;
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

// --------------------------------------------------------------------------
// 8. ALLOWLIST: die Haushaltsfassung traegt nur, was die Wand zeichnet
// --------------------------------------------------------------------------
//
// #1838 und #1900 liessen bestimmte Module aus und alles andere durch - eine
// Denylist. Gemessen trug die Haushaltsfassung weiter angepinnte Notizen, das
// Budget, den Stand geteilter Ausgaben, Schnellzugriffe, Countdowns und den
// offenen Lohn der Haushaltshilfe: nichts davon zeichnet die Wand, alles davon
// lag auf dem Geraet. Jetzt gilt die Umkehrung, und diese Tests messen sie an
// der ECHTEN Route.

const visibility = await import('../server/services/visibility.js');

const HELGA = addUser('Helga');
let SHOPPING_LIST = null;

function seedWallSources() {
  seedPersonal();
  for (const table of ['notes', 'budget_entries', 'expense_ledger_entries', 'expense_group_members', 'expense_groups',
    'quick_links', 'housekeeping_work_sessions', 'housekeeping_workers', 'meals', 'shopping_items', 'shopping_lists',
    'waste_one_off_pickups', 'waste_types', 'pantry_items', 'birthdays']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  // WAS DIE WAND NICHT ZEICHNET.
  db.prepare("INSERT INTO notes (title, content, pinned, created_by) VALUES ('Kontonummer Sparbuch', 'DE00 1234', 1, ?)").run(ANNA);
  db.prepare("INSERT INTO budget_entries (title, amount, category, date, created_by) VALUES ('Gehalt', 4321.09, 'salary', '2026-10-05', ?)").run(ANNA);
  const group = db.prepare("INSERT INTO expense_groups (name, type, default_currency, created_by) VALUES ('Zuhause', 'general', 'EUR', ?)").run(ANNA).lastInsertRowid;
  for (const [userId, role] of [[ANNA, 'owner'], [BEN, 'admin']]) {
    db.prepare('INSERT INTO expense_group_members (group_id, user_id, role, invited_by) VALUES (?, ?, ?, ?)').run(group, userId, role, ANNA);
  }
  db.prepare(`
    INSERT INTO expense_ledger_entries (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
    VALUES (?, 'expense', 1, ?, ?, 98765, 'EUR', 'Pizzaabend', ?)
  `).run(group, ANNA, BEN, ANNA);
  db.prepare("INSERT INTO quick_links (name, url, visibility, created_by, position) VALUES ('Bankportal', 'https://bank.example/login', 'private', ?, 0)").run(ANNA);
  const countdown = addTask('Urlaub in Sicht', BEN, { due: '2026-10-20' });
  db.prepare('UPDATE tasks SET countdown = 1 WHERE id = ?').run(countdown);
  // Die Haushaltshilfe: ein bezahlbarer Besuch vom Dienstag (Geld), und heute da (Programm).
  const worker = db.prepare('INSERT INTO housekeeping_workers (user_id, daily_rate) VALUES (?, 87.5)').run(HELGA).lastInsertRowid;
  db.prepare("INSERT INTO housekeeping_work_sessions (check_in, check_out, daily_rate, worker_id, created_by) VALUES ('2026-10-06T07:00:00Z', '2026-10-06T11:00:00Z', 87.5, ?, ?)").run(worker, ANNA);
  db.prepare("INSERT INTO housekeeping_work_sessions (check_in, daily_rate, worker_id, created_by) VALUES ('2026-10-08T07:00:00Z', 87.5, ?, ?)").run(worker, ANNA);
  // WAS DIE WAND ZEICHNET.
  db.prepare("INSERT INTO meals (date, meal_type, title, created_by) VALUES ('2026-10-08', 'lunch', 'Linsensuppe', ?)").run(ANNA);
  SHOPPING_LIST = Number(db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Wochenmarkt', ?)").run(ANNA).lastInsertRowid);
  db.prepare("INSERT INTO shopping_items (list_id, name) VALUES (?, 'Tomaten')").run(SHOPPING_LIST);
  const bin = db.prepare("INSERT INTO waste_types (name, color, created_by) VALUES ('Biotonne', '#2E7D32', ?)").run(ANNA).lastInsertRowid;
  db.prepare("INSERT INTO waste_one_off_pickups (type_id, date, created_by) VALUES (?, '2026-10-08', ?)").run(bin, ANNA);
  db.prepare("INSERT INTO pantry_items (name, quantity, unit, expires_on, created_by) VALUES ('Joghurt', 1, 'Becher', '2026-10-08', ?)").run(ANNA);
  db.prepare("INSERT INTO birthdays (name, birth_date, created_by) VALUES ('Oma Erna', '1950-10-08', ?)").run(ANNA);
  addEvent('Elternabend', { assignees: [ANNA] });
}
/** Woerter und Zahlen, die an keiner Wand etwas verloren haben - als Text gesucht. */
const OFF_WALL_WORDS = ['Sparbuch', 'DE00 1234', '4321', '98765', 'Bankportal', 'bank.example', '87.5'];
const householdQuery = () => `?audience=household&shopping_list=${SHOPPING_LIST}`;

test('Allowlist: ohne den Parameter traegt die Antwort all das weiter (Reichweite der Saat)', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedWallSources();
  const anna = await overview(ANNA, `?shopping_list=${SHOPPING_LIST}`);
  assert.deepEqual(titles(anna.pinnedNotes), ['Kontonummer Sparbuch']);
  assert.equal(anna.pinnedNotesCount, 1);
  assert.equal(anna.notesTotal, 1);
  assert.equal(anna.budget.income, 4321.09);
  assert.equal(anna.budget.entryCount, 1);
  assert.ok(anna.splitBalance.net.length > 0, 'ein offener Stand geteilter Ausgaben');
  assert.deepEqual(anna.quicklinks.map((link) => link.name), ['Bankportal']);
  assert.deepEqual(titles(anna.countdowns), ['Urlaub in Sicht']);
  assert.equal(anna.countdownTotal, 1);
  assert.equal(anna.housekeeping.unpaidAmount, 87.5);
  assert.equal(anna.housekeeping.visitsThisMonth, 1);
  assert.ok(anna.housekeeping.lastVisit);
  assert.ok(anna.shoppingTile, 'die Auswahl der Einkaufs-Kachel');
  assert.ok(anna.openTaskCount > 0);
  assert.ok(anna.weekEvents.length > 0);
  assert.ok(anna.familyEvents.length > 0);
  assert.ok(anna.birthdayTotal > 0);
  const text = JSON.stringify(anna);
  for (const word of OFF_WALL_WORDS) assert.ok(text.includes(word), `Reichweite: „${word}" steht in der persoenlichen Antwort`);
}));

test('Allowlist: die Haushaltsfassung traegt nichts, was die Wand nicht zeichnet - nicht als Text, nicht als Zahl', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedWallSources();
  // DER MASSSTAB FUER „LEER": ein gekoppeltes Display hat weder Notizen noch
  // Budget, Haushaltshilfe, Vorrat oder Einkauf - es bekommt von der Route die
  // Fassung eines Kontos ohne das Modulrecht.
  const denied = await asCoupledDisplay(() => overview(DISPLAY));
  for (const who of [ANNA, BEN, CLEO]) {
    const personal = await overview(who, `?shopping_list=${SHOPPING_LIST}`);
    const wall = await overview(who, householdQuery());
    const text = JSON.stringify(wall);
    for (const word of OFF_WALL_WORDS) assert.ok(!text.includes(word), `Sitzung ${who}: „${word}" reist nicht mit`);

    for (const key of ['pinnedNotes', 'pinnedNotesCount', 'notesTotal', 'budget', 'splitBalance',
      'health', 'fasting', 'nutrition', 'myShiftsToday']) {
      assert.deepEqual(wall[key], denied[key], `Sitzung ${who}: „${key}" in der Fassung eines Kontos ohne das Modulrecht`);
    }
    // Den Einkauf liest ein Display seit Tafla (die Einkaufskarte der Wand):
    // die Listen traegt die Wand, die Zahl der Listen nicht.
    assert.equal(wall.shoppingOpenLists, 0);
    assert.deepEqual(wall.rewards, { view: null, standings: [], participantCount: 0, pending: 0, moneyPending: 0, catalog: [], recent: [] });
    // Was keinem Modul gehoert.
    assert.deepEqual(wall.countdowns, []);
    assert.equal(wall.countdownTotal, 0);
    assert.deepEqual(wall.quicklinks, []);
    assert.ok(!('shoppingTile' in wall), 'die Kachel-Auswahl fehlt, wie bei einem Konto ohne den Einkauf');
    // Scheiben erlaubter Module, die die Wand nicht zeichnet.
    assert.deepEqual(wall.familyEvents, []);
    assert.deepEqual(wall.weekEvents, []);
    assert.deepEqual(wall.memberTodayTasks, []);
    assert.deepEqual(wall.urgentTasks, [], 'das alte Programm zeichnet die Wand nicht mehr');
    // `wallTasks` traegt die Haushaltsfassung (nur fuer die geteilte Flaeche
    // gerechnet) - und nennt nichts, was der Tagesplan der Wand nicht ohnehin traegt.
    const planned = new Set(wall.planTasks.map((task) => task.title));
    const named = wall.wallTasks.flatMap((entry) => [...entry.open, ...entry.done]).map((task) => task.title);
    assert.ok(named.every((title) => planned.has(title)), `Sitzung ${who}: wallTasks nennt nur Geplantes (${named})`);
    assert.equal(wall.tasksDoneToday, 0);
    assert.equal(wall.openTaskCount, 0);
    assert.equal(wall.overdueTaskCount, 0);
    assert.equal(wall.birthdayCount, 0);
    assert.equal(wall.birthdayTotal, 0);
    assert.equal(wall.birthdaySoonCount, 0);
    // FELDER in einer erlaubten Scheibe: die Anwesenheit steht im Programm,
    // der offene Lohn nicht.
    assert.deepEqual(wall.housekeeping, {
      ...denied.housekeeping, present: true, presentSince: '2026-10-08T07:00:00Z', workerName: 'Helga',
    });
    // Den Vorrat liest ein Display seit Tafla (Zaehler am Abendessen), der
    // Massstab fuer die leeren Felder ist deshalb die leere Scheibe selbst.
    assert.deepEqual(wall.pantryExpiring, {
      items: [], total: 0, expiredCount: 0, todayItems: personal.pantryExpiring.todayItems, todayCount: 1,
    });
    assert.deepEqual(wall.pantryExpiring.todayItems.map((item) => item.name), ['Joghurt']);

    // KEIN FEHLENDER SCHLUESSEL: die Form der Antwort bleibt.
    assert.deepEqual(Object.keys(wall).sort(), Object.keys(personal).filter((key) => key !== 'shoppingTile').sort());
    for (const key of ['housekeeping', 'pantryExpiring', 'budget', 'rewards', 'health']) {
      const own = Object.keys(personal[key]).filter((field) => !(key === 'rewards' && field === 'me')).sort();
      assert.deepEqual(Object.keys(wall[key]).sort(), own, `„${key}" behaelt seine Felder`);
    }
  }
}));

/* DIE ZWEITE HAELFTE DES DRIFT-GUARDS, VON HAND GEFUEHRT: was die Route liefert
 * und die Wand bewusst leer bekommt. Die Schluessel der Antwort kommen unten
 * aus der ECHTEN Route und nicht aus einer Konstante des Servers - ein neues
 * Feld der Uebersicht steht dann in keiner der beiden Listen, und der Test ist
 * rot, bis jemand entschieden hat, ob eine Wand es zeigt. */
const DELIBERATELY_EMPTY_ON_THE_WALL = Object.freeze({
  // Kalender: die Familienkarte, der Wochenstreifen und die Zahlen der Kachel.
  familyEvents: 'calendar', weekEvents: 'calendar',
  birthdayCount: 'calendar', birthdayTotal: 'calendar', birthdaySoonCount: 'calendar',
  // Aufgaben: Kennzahlen der Kacheln und der Navigation.
  openTaskCount: 'tasks', overdueTaskCount: 'tasks', memberTodayTasks: 'tasks',
  // Einkauf: die Wand nennt die Zahl und die ersten Artikel (shoppingLists),
  // nicht die Zahl der Listen und nicht die Auswahl der Kachel.
  shoppingOpenLists: 'shopping', shoppingTile: 'shopping',
  pinnedNotes: 'notes', pinnedNotesCount: 'notes', notesTotal: 'notes',
  // Geld steht an keiner Wand.
  budget: 'budget', splitBalance: 'budget',
  // Was nur dem Betrachter gilt (#1900).
  rewards: 'rewards', health: 'health', fasting: 'health', nutrition: 'health', myShiftsToday: 'schedule',
  // Keinem Modul zugeordnet: nach der anfragenden Person geschnitten.
  countdowns: null, countdownTotal: null, quicklinks: null,
  // Das alte Wand-Programm (bis Tafla, 2026-10-19): die Tafla-Wand liest den
  // Tagesplan (planTasks, planEvents). `wallTasks` traegt sie dagegen - die
  // Route rechnet es nur noch fuer die geteilte Flaeche (2026-10-24).
  urgentTasks: 'tasks', tasksDoneToday: 'tasks',
});
const DELIBERATELY_EMPTY_FIELDS = Object.freeze({
  housekeeping: ['configured', 'visitsThisMonth', 'unpaidAmount', 'lastVisit'],
  pantryExpiring: ['items', 'total', 'expiredCount'],
});

test('Drift: jeder Schluessel, den die Route liefert, ist entschieden - gezeichnet oder bewusst leer', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedWallSources();
  const shows = visibility.HOUSEHOLD_AUDIENCE_SHOWS;
  assert.ok(shows && typeof shows === 'object', 'die Allowlist der Wand-Quellen ist benannt und exportiert');
  // Die volle Antwort: Admin, jedes Modul an, jede Quelle belegt, mit der Auswahl
  // der Einkaufs-Kachel (ihr Feld gibt es nur dann).
  const real = await overview(ANNA, `?shopping_list=${SHOPPING_LIST}`);
  const delivered = Object.keys(real).sort();
  assert.ok(delivered.length >= 30, `Reichweite: die Route liefert ihre Schluessel (${delivered.length})`);

  const undecided = delivered.filter((key) => !(key in shows) && !(key in DELIBERATELY_EMPTY_ON_THE_WALL));
  assert.deepEqual(undecided, [], 'neuer Schluessel in GET /dashboard: zeichnet die Wand ihn (HOUSEHOLD_AUDIENCE_SHOWS) oder bleibt er leer (diese Liste)?');
  const both = delivered.filter((key) => key in shows && key in DELIBERATELY_EMPTY_ON_THE_WALL);
  assert.deepEqual(both, [], 'ein Schluessel steht in beiden Listen');
  // Und keine Liste nennt etwas, das die Route nicht (mehr) liefert.
  assert.deepEqual(Object.keys(shows).filter((key) => !(key in real)), [], 'die Allowlist nennt einen Schluessel, den die Route nicht liefert');
  assert.deepEqual(Object.keys(DELIBERATELY_EMPTY_ON_THE_WALL).filter((key) => !(key in real)), []);

  // Dieselbe Frage eine Ebene tiefer, wo die Allowlist nur einzelne Felder nennt.
  const partial = Object.keys(shows).filter((key) => Array.isArray(shows[key])).sort();
  assert.deepEqual(partial, Object.keys(DELIBERATELY_EMPTY_FIELDS).sort());
  for (const key of partial) {
    const fields = Object.keys(real[key]).sort();
    assert.deepEqual([...shows[key], ...DELIBERATELY_EMPTY_FIELDS[key]].sort(), fields, `„${key}": jedes Feld ist entschieden`);
  }
}));

test('Drift: was die Haushaltsfassung traegt, ist genau das Gezeichnete - an der echten Antwort abgelesen', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedWallSources();
  const personal = await overview(ANNA, `?shopping_list=${SHOPPING_LIST}`);
  const wall = await overview(ANNA, householdQuery());
  // OHNE DIE KONSTANTE DES SERVERS: ein Schluessel „traegt", wenn er sich von
  // der Antwort desselben Haushalts ohne jede Zeile unterscheidet.
  for (const table of ['tasks', 'calendar_events', 'notes', 'budget_entries', 'expense_ledger_entries', 'quick_links',
    'housekeeping_work_sessions', 'meals', 'shopping_items', 'shopping_lists', 'waste_one_off_pickups', 'pantry_items',
    'birthdays', 'medication_schedules', 'medications', 'schedule_extra_shifts', 'reward_redemptions', 'reward_participants']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  const blank = await overview(ANNA, householdQuery());
  const differs = (a, b) => { try { assert.deepEqual(a, b); return false; } catch { return true; } };
  const carried = Object.keys(wall).filter((key) => differs(wall[key], blank[key])).sort();
  assert.deepEqual(carried, ['birthdays', 'housekeeping', 'pantryExpiring', 'planEvents', 'planTasks', 'shoppingLists',
    'shoppingOpenCount', 'todayMeals', 'upcomingEvents', 'wallTasks', 'wastePickups'], 'belegt in der Saat UND an der Wand gezeichnet');
  // `wallTasks` rechnet nur die geteilte Flaeche - persoenlich steht es leer.
  assert.deepEqual(personal.wallTasks, []);
  for (const key of carried.filter((name) => !['housekeeping', 'pantryExpiring', 'wallTasks'].includes(name))) {
    assert.deepEqual(wall[key], personal[key], `„${key}" kommt unveraendert`);
  }
  assert.deepEqual(wall.users, personal.users, 'die Gesichter kommen unveraendert');
  assert.ok(wall.users.length >= 3);
  // Reichweite der Messung: persoenlich traegt dieselbe Saat weit mehr.
  const blankPersonal = await overview(ANNA);
  const carriedPersonal = Object.keys(personal).filter((key) => differs(personal[key], blankPersonal[key]));
  for (const key of ['budget', 'splitBalance', 'pinnedNotes', 'quicklinks', 'countdowns', 'rewards', 'weekEvents', 'openTaskCount']) {
    assert.ok(carriedPersonal.includes(key), `Reichweite: persoenlich traegt „${key}"`);
  }
}));

test('Allowlist: ein unbekannter Schluessel bekommt NEIN - auch einer, den es heute noch nicht gibt', () => {
  assert.equal(typeof visibility.householdAudienceAnswer, 'function');
  const empty = { users: [], budget: { income: 0 }, housekeeping: { present: false, unpaidAmount: 0 } };
  const answer = visibility.householdAudienceAnswer({
    users: [{ id: 1 }],
    budget: { income: 4321.09 },
    housekeeping: { present: true, unpaidAmount: 87.5, brandNewField: 'Lohnzettel' },
    brandNewModule: { secret: 'Kontostand' },
  }, empty);
  assert.deepEqual(answer, {
    users: [{ id: 1 }],
    budget: { income: 0 },
    housekeeping: { present: true, unpaidAmount: 0 },
  });
});

test('Allowlist: was die Wand nicht zeigt, wird auch nicht gelesen', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedWallSources();
  const OFF_WALL_TABLES = /\b(notes|budget_entries|expense_ledger_entries|quick_links|medications|reward_redemptions|schedule_extra_shifts)\b/;
  const original = db.prepare;
  let seen = [];
  db.prepare = function prepare(sql) { seen.push(String(sql)); return original.call(this, sql); };
  try {
    await overview(ANNA);
    const personalReads = seen.filter((sql) => OFF_WALL_TABLES.test(sql)).length;
    assert.ok(personalReads >= 5, `Reichweite: die persoenliche Fassung liest diese Tabellen (${personalReads})`);
    seen = [];
    await overview(ANNA, householdQuery());
    assert.ok(seen.length > 5, 'Reichweite: die Haushaltsfassung liest');
    assert.deepEqual(seen.filter((sql) => OFF_WALL_TABLES.test(sql)).map((sql) => sql.trim().slice(0, 60)), []);
  } finally {
    db.prepare = original;
  }
}));

test('Allowlist: die gebaute Wand ist dieselbe wie zuvor - nichts, was sie zeichnet, ist weggefallen', async () => {
  let personal;
  let wall;
  await withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
    seedWallSources();
    personal = await overview(ANNA, `?shopping_list=${SHOPPING_LIST}`);
    wall = await overview(ANNA, householdQuery());
  })();
  await onWallAt(NOON_BERLIN, () => {
    // Der Stand vor der Allowlist: die volle Antwort, ohne das, was nur dem
    // Betrachter gilt (#1900) - und ohne Eingeschraenktes, das die Saat hier
    // nicht hat.
    const beforeData = {
      ...personal,
      health: wall.health, fasting: wall.fasting, nutrition: wall.nutrition, rewards: wall.rewards, myShiftsToday: [],
      pendingReminders: [],
    };
    const afterData = { ...wall, pendingReminders: [] };
    const before = wallParts(beforeData);
    // Die Biotonne ist um zwoelf schon abgeholt und steht nicht mehr im
    // offenen Plan - in beiden Fassungen gleich.
    for (const word of ['Elternabend', 'Tisch decken', 'Joghurt', 'Helga', 'Oma Erna', 'Tomaten']) {
      assert.ok(before.html.includes(word), `Reichweite: „${word}" steht an der Wand`);
    }
    const shown = wallParts(afterData);
    assert.equal(shown.html, before.html, 'die ganze Flaeche ist dieselbe');
    for (const word of OFF_WALL_WORDS) assert.ok(!shown.html.includes(word));
  })();
});

test('Allowlist: das Display ohne den Parameter bekommt, was es bekam', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  seedWallSources();
  const display = await asCoupledDisplay(() => overview(DISPLAY));
  assert.deepEqual(titles(display.countdowns), ['Urlaub in Sicht'], 'Countdowns bleiben der Uebersicht des Displays');
  assert.ok(display.openTaskCount > 0);
  assert.ok(display.weekEvents.length > 0);
  assert.equal(display.rewards.view, 'family');
  // Und an der Wand folgt auch das Display der Allowlist.
  const wall = await asCoupledDisplay(() => overview(DISPLAY, '?audience=household'));
  assert.deepEqual(wall.countdowns, []);
  assert.equal(wall.openTaskCount, 0);
  assert.deepEqual(wall.weekEvents, []);
  assert.ok(titles(wall.planTasks).includes('Tisch decken'), 'Reichweite: der Tagesplan steht');
}));
