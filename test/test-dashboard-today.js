/**
 * Modul: Uebersicht - was heute ist (Server)
 * Zweck: Die Stellen, an denen GET /dashboard „heute" und „diesen Monat"
 *        anders zaehlte als der Haushalt sie erlebt, jede gegen den echten
 *        Router und eine migrierte In-Memory-DB, mit festgenagelter Uhr und
 *        Haushaltszone (Berlin wie die Demo-Saat) und je einem Gegenlauf in
 *        einer Zone, die den Tag oder den Monat verschiebt:
 *
 *        1. Haushaltshilfe (#1451): Besuche und offener Betrag des Monats
 *           zaehlten den UTC-Monat von `check_in` (`substr(check_in, 1, 7)`).
 *        2. Mehrtaegige Termine (#1457): `upcomingEvents` waehlte nach dem
 *           BEGINN, und was gestern begann und heute noch laeuft, fehlte.
 *        3. Familienkarte (#1449): sie lieh sich die Liste der Termin-Kachel
 *           - fuenf Kommende und deren „nur meine" - und verlor damit den
 *           Abendtermin eines Mitglieds an einem vollen Tag (`familyEvents`).
 *        6. Kinder-Standards (R20): die Vorgabe der Kacheln, und dass die
 *           Seite den Betrachter setzt, den der Tagesplan fragt.
 *
 *        TAFLA (2026-10-24): die Browser-Haelften (Termin-Kachel,
 *        Tagesprogramm, Familienkarte, Heute-Blatt, „heute bis" #1534,
 *        Kalendername #1698, Kinder-Reihenfolge R20) sind mit dem Raster der
 *        Uebersicht gegangen. Dziś baut seinen Tag aus utils/today-plan.js
 *        (test:dashboard-tafla).
 *
 * Ausfuehren: npm run test:dashboard-today
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

register('./test-browser-loader.mjs', import.meta.url);

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'dashboard-today-test-secret';

const { resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { default: housekeepingRouter } = await import('../server/routes/housekeeping.js');

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

const ADMIN = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
  VALUES (?, 'Anna', 'hash', '#7C3AED', 'admin', 'parent')
`).run(`today-admin-${randomUUID()}`).lastInsertRowid;

const app = express();
app.use((req, _res, next) => {
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(ADMIN);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.session = { userId: user.id, role: user.role };
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(db, user));
  next();
});
app.use('/housekeeping', housekeepingRouter);
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

// Die Uhr steht fest; nur `Date` wird gemockt, die Timer des HTTP-Servers
// laufen weiter. Die Zone ist die des HAUSHALTS (sync_config), nicht die des
// Rechners - die Suite laeuft in jeder Maschinenzone gleich.
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

// --------------------------------------------------------------------------
// 1. Haushaltshilfe: der Monat des Haushalts (#1451)
// --------------------------------------------------------------------------

const HELPER = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, avatar_color, role)
  VALUES (?, 'Maria', 'hash', '#34C759', 'member')
`).run(`today-helper-${randomUUID()}`).lastInsertRowid;
const WORKER = db.prepare('INSERT INTO housekeeping_workers (user_id, daily_rate) VALUES (?, 40)').run(HELPER).lastInsertRowid;

// `check_in` in der Form, die der Check-in schreibt: `toISOString()`.
function seedVisit(checkIn, checkOut, { rate = 40, extras = 0, paid = false } = {}) {
  db.prepare(`
    INSERT INTO housekeeping_work_sessions (check_in, check_out, daily_rate, extras, paid_at, worker_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(checkIn, checkOut, rate, extras, paid ? checkOut : null, WORKER, ADMIN);
}
const clearVisits = () => db.prepare('DELETE FROM housekeeping_work_sessions').run();

test('#1451 Berlin: ein Besuch am Ersten um 00:30 zaehlt in diesem Monat, nicht im Vormonat',
  withClock('2026-10-01T08:00:00Z', 'Europe/Berlin', async () => {
    clearVisits();
    // 01.10. 00:30 bis 03:30 in Berlin - als Instant noch der 30.09.
    seedVisit('2026-09-30T22:30:00.000Z', '2026-10-01T01:30:00.000Z', { extras: 10 });
    // Kontrolle: ein Besuch mitten im September zaehlt nicht.
    seedVisit('2026-09-15T07:00:00.000Z', '2026-09-15T11:00:00.000Z');
    const { housekeeping } = await getJson('/');
    assert.equal(housekeeping.visitsThisMonth, 1, 'der Besuch vom 01.10. ist ein Oktober-Besuch');
    assert.equal(housekeeping.unpaidAmount, 50, 'daily_rate 40 + extras 10 im Oktober');
  }));

test('#1451 Los Angeles: ein Besuch am Letzten abends zaehlt in diesem Monat, nicht im naechsten',
  withClock('2026-10-01T03:00:00Z', 'America/Los_Angeles', async () => {
    clearVisits();
    // 30.09. 18:00 bis 21:00 in Los Angeles - als Instant schon der 01.10.
    seedVisit('2026-10-01T01:00:00.000Z', '2026-10-01T04:00:00.000Z');
    const { housekeeping } = await getJson('/');
    assert.equal(housekeeping.visitsThisMonth, 1, 'es ist noch September - der Besuch gehoert dazu');
    assert.equal(housekeeping.unpaidAmount, 40);
  }));

test('#1451: zonenlose Wanduhrzeit zaehlt in ihrem eigenen Monat', withClock('2026-10-01T08:00:00Z', 'Europe/Berlin', async () => {
  clearVisits();
  // Beide Formen, die `check_in` tragen kann (householdMonthOf im Modul):
  // zonenlos steht die Ziffernfolge schon in der Haushaltszone.
  seedVisit('2026-10-01T00:30:00', '2026-10-01T03:30:00');
  seedVisit('2026-09-30T23:30:00', '2026-10-01T01:00:00');
  const { housekeeping } = await getJson('/');
  assert.equal(housekeeping.visitsThisMonth, 1, 'nur der Besuch vom 01.10. gehoert in den Oktober');
}));

test('#1451: Uebersicht und Modul zaehlen dieselben abgeschlossenen Besuche', withClock('2026-10-01T08:00:00Z', 'Europe/Berlin', async () => {
  clearVisits();
  seedVisit('2026-09-30T22:30:00.000Z', '2026-10-01T01:30:00.000Z');
  seedVisit('2026-10-01T05:00:00.000Z', '2026-10-01T07:00:00.000Z', { paid: true });
  seedVisit('2026-09-30T20:00:00.000Z', '2026-09-30T21:30:00.000Z'); // 22:00 Berlin, noch September
  const { housekeeping } = await getJson('/');
  const module = (await getJson('/housekeeping/dashboard')).data;
  assert.equal(module.visits_this_month, 2, 'Vorbedingung: das Modul zaehlt zwei Oktober-Besuche');
  assert.equal(housekeeping.visitsThisMonth, module.visits_this_month, 'Uebersicht und Modul sagen dieselbe Zahl');
}));

// `check_in` traegt mehrere Schreibweisen: `toISOString()` vom Check-in,
// '…SSZ' aus scripts/seed-demo.js und - von Hand eingespielt - zonenlose
// Wanduhrzeit. `ORDER BY check_in DESC LIMIT 1` sortierte sie als Text, und die
// Kachel nannte einen anderen "letzten Besuch" als die Modulseite.
function seedVisitFor(workerId, checkIn, checkOut) {
  db.prepare(`
    INSERT INTO housekeeping_work_sessions (check_in, check_out, daily_rate, extras, worker_id, created_by)
    VALUES (?, ?, 40, 0, ?, ?)
  `).run(checkIn, checkOut, workerId, ADMIN);
}

test('Haushaltshilfe: letzter Besuch und offene Sitzung sind der spaeteste Zeitpunkt, nicht der groesste Text',
  withClock('2031-07-15T12:00:00Z', 'Europe/Berlin', async () => {
    const prevTz = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo'; // der Prozess bewusst in einer dritten Zone
    const otherUser = db.prepare(`
      INSERT INTO users (username, display_name, password_hash, avatar_color, role)
      VALUES (?, 'Jonas', 'hash', '#34C759', 'member')
    `).run(`today-helper-${randomUUID()}`).lastInsertRowid;
    const other = db.prepare('INSERT INTO housekeeping_workers (user_id, daily_rate) VALUES (?, 40)').run(otherUser).lastInsertRowid;
    try {
      clearVisits();
      // Abgeschlossen: 11:00 in Berlin (zonenlos) gegen 12:00 in Berlin (Instant) -
      // als Text ist '…T11' groesser als '…T10'.
      seedVisitFor(WORKER, '2031-07-15T11:00:00', '2031-07-15T11:30:00');
      seedVisitFor(WORKER, '2031-07-15T10:00:00.000Z', '2031-07-15T10:30:00.000Z');
      // Offen: Jonas seit 09:00 in Berlin (zonenlos), Maria seit 09:30 in Berlin (Instant).
      seedVisitFor(other, '2031-07-15T09:00:00', null);
      seedVisitFor(WORKER, '2031-07-15T07:30:00.000Z', null);
      const { housekeeping } = await getJson('/');
      assert.equal(housekeeping.lastVisit, '2031-07-15T10:00:00.000Z', 'der Besuch von 12:00, nicht der von 11:00');
      assert.equal(housekeeping.presentSince, '2031-07-15T07:30:00.000Z', 'die zuletzt begonnene offene Sitzung');
      assert.equal(housekeeping.workerName, 'Maria', 'und ihr Name');
      const module = (await getJson('/housekeeping/dashboard')).data;
      // Das Modul fragt nach dem letzten Besuch ueberhaupt, die Kachel nach dem
      // letzten ABGESCHLOSSENEN - ohne die offenen sagen beide denselben.
      db.prepare('DELETE FROM housekeeping_work_sessions WHERE check_out IS NULL').run();
      const moduleClosed = (await getJson('/housekeeping/dashboard')).data;
      assert.equal(module.last_visit.check_in, '2031-07-15T10:00:00.000Z', 'Vorbedingung: das Modul nennt denselben Besuch');
      assert.equal(moduleClosed.last_visit.check_in, housekeeping.lastVisit, 'Uebersicht und Modul sagen denselben letzten Besuch');

      // Dieselbe Sekunde in den zwei Schreibweisen echter Schreibwege: 'Z' sortiert hinter '.'.
      clearVisits();
      seedVisitFor(WORKER, '2031-07-15T09:00:00Z', '2031-07-15T09:10:00Z');
      seedVisitFor(WORKER, '2031-07-15T09:00:00.500Z', '2031-07-15T09:10:00.000Z');
      assert.equal((await getJson('/')).housekeeping.lastVisit, '2031-07-15T09:00:00.500Z', 'eine halbe Sekunde spaeter ist spaeter');
    } finally {
      clearVisits();
      db.prepare('DELETE FROM housekeeping_workers WHERE id = ?').run(other);
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    }
  }));

// --------------------------------------------------------------------------
// 2. Was gestern begann und heute laeuft (#1457)
// --------------------------------------------------------------------------

const { getUpcomingEvents } = await import('../server/services/calendar-event-reader.js');

const insertEvent = db.prepare(`
  INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, visibility, created_by, recurrence_rule)
  VALUES (?, ?, ?, ?, 'all', ?, ?)
`);
function addEvent(title, start, end = null, { allDay = 0, rrule = null } = {}) {
  return Number(insertEvent.run(title, start, end, allDay, ADMIN, rrule).lastInsertRowid);
}
const clearEvents = () => db.prepare('DELETE FROM calendar_events').run();
const titles = (events) => events.map((e) => e.title);

// Donnerstag, 24.09.2026, 10:00 in Berlin.
const THU_10_BERLIN = '2026-09-24T08:00:00Z';

test('#1457: laufende mehrtaegige Termine stehen heute in upcomingEvents', withClock(THU_10_BERLIN, 'Europe/Berlin', async () => {
  clearEvents();
  addEvent('Reise', '2026-09-23T18:00', '2026-09-25T12:00');
  addEvent('Klassenfahrt', '2026-09-23', '2026-09-25', { allDay: 1 });
  addEvent('Synchronisiert', '2026-09-23T16:00:00.000Z', '2026-09-25T10:00:00.000Z');
  addEvent('Nachtschicht', '2026-09-23T18:00', '2026-09-24T08:00');
  addEvent('Gestern vorbei', '2026-09-23T10:00', '2026-09-23T12:00');
  addEvent('Ganztag gestern', '2026-09-23', '2026-09-23', { allDay: 1 });
  addEvent('Heute abend', '2026-09-24T19:00', '2026-09-24T20:00');
  const { upcomingEvents } = await getJson('/');
  const got = titles(upcomingEvents);
  for (const title of ['Reise', 'Klassenfahrt', 'Synchronisiert', 'Nachtschicht', 'Heute abend']) {
    assert.ok(got.includes(title), `${title} fehlt in upcomingEvents: ${got.join(', ')}`);
  }
  for (const title of ['Gestern vorbei', 'Ganztag gestern']) {
    assert.ok(!got.includes(title), `${title} ist gestern zu Ende und gehoert nicht in heute: ${got.join(', ')}`);
  }
}));

test('#1457: der Deckel von fuenf zaehlt den laufenden Termin, nicht den heute beendeten', withClock(THU_10_BERLIN, 'Europe/Berlin', async () => {
  clearEvents();
  addEvent('Nachtschicht', '2026-09-23T18:00', '2026-09-24T08:00');
  for (let i = 1; i <= 5; i += 1) addEvent(`Kommt ${i}`, `2026-09-24T1${i}:00`, `2026-09-24T1${i}:30`);
  const { upcomingEvents } = await getJson('/');
  const got = titles(upcomingEvents);
  assert.deepEqual(got, ['Nachtschicht', 'Kommt 1', 'Kommt 2', 'Kommt 3', 'Kommt 4', 'Kommt 5'],
    'die heute beendete Nachtschicht steht ausserhalb des Deckels, alle fuenf kommenden bleiben');
}));

test('#1457: auch das Vorkommen einer Serie, das gestern begann, laeuft heute', withClock(THU_10_BERLIN, 'Europe/Berlin', async () => {
  clearEvents();
  // Taeglich 23:00 bis 11:00 am Folgetag: das Vorkommen von gestern laeuft um 10:00 noch.
  addEvent('Bereitschaft', '2026-09-20T23:00', '2026-09-21T11:00', { rrule: 'FREQ=DAILY' });
  const { upcomingEvents } = await getJson('/');
  const starts = upcomingEvents.filter((e) => e.title === 'Bereitschaft').map((e) => String(e.start_datetime).slice(0, 16));
  assert.ok(starts.includes('2026-09-23T23:00'), `das laufende Vorkommen von gestern fehlt: ${starts.join(', ')}`);
  assert.ok(starts.includes('2026-09-24T23:00'), 'und das von heute Abend steht weiter da');
}));

test('#1457: ob ein Termin in heute reicht, entscheidet die Haushaltszone', async () => {
  // Endet um 01:00Z: in Berlin nach Mitternacht (03:00) - heute beendet; in
  // Los Angeles am Vortag um 18:00, also gestern vorbei.
  const setup = () => {
    clearEvents();
    addEvent('Ueber Mitternacht', '2026-09-23T16:00:00.000Z', '2026-09-24T01:00:00.000Z');
  };
  await withClock('2026-09-24T15:00:00Z', 'Europe/Berlin', async () => {
    setup();
    assert.ok(titles((await getJson('/')).upcomingEvents).includes('Ueber Mitternacht'), 'Berlin: heute beendet, steht da');
  })();
  await withClock('2026-09-24T15:00:00Z', 'America/Los_Angeles', async () => {
    setup();
    assert.ok(!titles((await getJson('/')).upcomingEvents).includes('Ueber Mitternacht'), 'Los Angeles: gestern vorbei');
  })();
});

test('#1457: /calendar/upcoming und MCP (ohne fromToday) bleiben „ab jetzt"', withClock(THU_10_BERLIN, 'Europe/Berlin', async () => {
  clearEvents();
  addEvent('Reise', '2026-09-23T18:00', '2026-09-25T12:00');
  addEvent('Heute abend', '2026-09-24T19:00', '2026-09-24T20:00');
  assert.deepEqual(titles(getUpcomingEvents(db, { userId: ADMIN, limit: 5 })), ['Heute abend']);
}));

const { __test: dash } = await import('../public/pages/dashboard.js');

// --------------------------------------------------------------------------
// 3. Die Familienkarte hat eigene Termine je Mitglied (#1449)
// --------------------------------------------------------------------------

const LEO = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
  VALUES (?, 'Leo', 'hash', '#FF9500', 'member', 'child')
`).run(`today-leo-${randomUUID()}`).lastInsertRowid;
const assign = db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)');
function addAssigned(title, start, end, userIds) {
  const id = addEvent(title, start, end);
  for (const uid of userIds) assign.run(id, uid);
  return id;
}
// 14:00 in Berlin. Leo hatte fuenf Termine am Morgen und hat einen am Abend;
// Anna hat fuenf am Nachmittag - genug, um den Deckel der Kachel zu fuellen.
const THU_14_BERLIN = '2026-09-24T12:00:00Z';
function seedBusyDay() {
  clearEvents();
  for (const h of ['06', '07', '08', '09', '10']) addAssigned(`Leo ${h}`, `2026-09-24T${h}:00`, `2026-09-24T${h}:30`, [LEO]);
  addAssigned('Leo Abend', '2026-09-24T21:00', '2026-09-24T22:00', [LEO]);
  for (const h of ['15', '16', '17', '18', '19']) addAssigned(`Anna ${h}`, `2026-09-24T${h}:00`, `2026-09-24T${h}:30`, [ADMIN]);
}

test('#1449: familyEvents traegt den Abendtermin, den der Deckel der Kachel abschneidet', withClock(THU_14_BERLIN, 'Europe/Berlin', async () => {
  seedBusyDay();
  const body = await getJson('/');
  assert.ok(!titles(body.upcomingEvents).includes('Leo Abend'), 'Vorbedingung: die Kachel zeigt fuenf Kommende, Leos Abend ist der sechste');
  const family = titles(body.familyEvents ?? []);
  assert.ok(family.includes('Leo Abend'), `familyEvents fehlt Leos Abendtermin: ${family.join(', ')}`);
  assert.ok(family.includes('Leo 10'), 'die heute beendeten kommen mit - sonst hiesse es „frei" statt „fuer heute durch"');
}));

test('#1449: „nur meine" der Kachel gilt nicht fuer die Familienkarte', withClock(THU_14_BERLIN, 'Europe/Berlin', async () => {
  seedBusyDay();
  const body = await getJson('/?events_scope=mine');
  assert.deepEqual([...new Set(titles(body.upcomingEvents).map((t) => t.split(' ')[0]))], ['Anna'], 'Vorbedingung: die Kachel zeigt nur Annas');
  assert.ok(titles(body.familyEvents ?? []).includes('Leo Abend'), 'die Karte zeigt jedes Mitglied - Leo ist nicht „frei"');
}));

// --------------------------------------------------------------------------
// 6. Kinder-Standards (R20): eigene Aufgaben zuerst, Punkte vor Budget
// --------------------------------------------------------------------------

const KIND = { id: 3, family_role: 'child', display_name: 'Emma' };
const MAMA = { id: 1, family_role: 'mom', display_name: 'Linda' };

test('R20: die Kinder-Vorgabe der Kacheln - Punkte zuerst und sichtbar, Budget aus, nur bei gefolgter Vorgabe', async () => {
  const { childDefaultWidgetConfig, DEFAULT_WIDGET_CONFIG } = await import('../public/utils/dashboard-widgets.js');
  const kid = childDefaultWidgetConfig(DEFAULT_WIDGET_CONFIG);
  assert.equal(kid[0].id, 'rewards');
  assert.equal(kid[0].visible, true);
  assert.equal(kid.find((w) => w.id === 'budget').visible, false);
  assert.deepEqual(kid.map((w) => w.order), kid.map((_, i) => i));
  assert.equal(kid.length, DEFAULT_WIDGET_CONFIG.length, 'keine Kachel verschwindet aus dem Anpassen-Tray');
  assert.equal(DEFAULT_WIDGET_CONFIG.find((w) => w.id === 'budget').visible, true, 'die Eingabe bleibt unberuehrt');

  assert.deepEqual(dash.childDefaultFor(DEFAULT_WIDGET_CONFIG, KIND, true), kid);
  assert.equal(dash.childDefaultFor(DEFAULT_WIDGET_CONFIG, KIND, false), DEFAULT_WIDGET_CONFIG, 'ein eigenes Layout bleibt');
  assert.equal(dash.childDefaultFor(DEFAULT_WIDGET_CONFIG, MAMA, true), DEFAULT_WIDGET_CONFIG, 'Erwachsene bekommen die Haushaltsvorgabe');
});

test('R20: die Seite setzt den Betrachter, den der Tagesplan fragt', () => {
  // TAFLA (2026-10-24): der Plan von Dziś (utils/today-plan.js) liest den
  // Betrachter aus seinem Kontext - eigene Aufgaben eines Kindes zuerst. Diese
  // Zeile haelt fest, dass der echte Aufrufer ihn hineinreicht.
  // 2026-10-27, v2: die Modulvariable `dashboardViewer` las niemand mehr (sie
  // ist gegangen); der Betrachter reist allein im Kontext des Plans.
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /dashboardViewer/);
  assert.match(src, /planContext\(\{ now: new Date\(\), viewer: user,/, 'Dziś fragt den Plan mit dem Betrachter');
});
