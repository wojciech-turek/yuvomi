/**
 * Modul: „Diese Woche" - die Wochendaten von /dashboard
 * Zweck: `weekEvents` kommt ueber /dashboard mit denselben Rechten und
 *        Optionen wie die Terminliste (Modul gesperrt, Token-Scope, „nur
 *        meine", Geburtstage ab, Sichtbarkeit); der Tag-Link des Kalenders
 *        (/calendar?date=) oeffnet einen Tag ohne Termin.
 *
 * TAFLA (2026-10-24): hier stand auch der Wochenstreifen des Kalender-Widgets
 * (2x1) - Modell (utils/week-strip.js buildWeekStrip), Renderer und die
 * Tageszuordnung der Uebersicht (eventOccurrenceDateKey, calendarEventRoute).
 * Er ist mit dem Raster gegangen; die Antwort traegt `weekEvents` weiter.
 *
 * DIE BROWSER-ZONE IST HIER ABSICHTLICH EINE ANDERE ALS DIE DES HAUSHALTS.
 * In der UTC-CI fallen alle drei Zonen zusammen, und ein Test ohne eigene
 * Vorgabe waere dort gruen und blind (dieselbe Lehre wie
 * test-calendar-timezone-window.js). Tokio liegt sieben Stunden oestlich von
 * Berlin: ein Termin um 23:30 Berliner Zeit ist dort schon der Folgetag.
 *
 * Ausfuehren: node --experimental-sqlite --test test/test-dashboard-week.js
 */
process.env.TZ = 'Asia/Tokyo';
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'dashboard-week-test-secret';

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { register } from 'node:module';
import http from 'node:http';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

register('./test-browser-loader.mjs', import.meta.url);

const HOUSEHOLD = 'Europe/Berlin';

// --------------------------------------------------------------------------
// Teil 1: Vorbedingung und der Tag-Link des Kalenders
// --------------------------------------------------------------------------

test('Vorbedingung: Browser und Haushalt liegen in verschiedenen Zonen', () => {
  // Ohne diese Probe koennte die Suite in einer Umgebung laufen, in der
  // `process.env.TZ` nicht greift - dann waere jede Zusicherung unten gruen,
  // weil Browser und Haushalt denselben Tag sehen.
  const instant = new Date('2026-09-24T21:30:00Z');
  assert.equal(instant.getDate(), 25, 'in Tokio ist 21:30Z schon der naechste Tag');
});

test('der Kalender kennt den Tag-Link: /calendar?date= ohne Termin oeffnet diesen Tag', async () => {
  const { __test: cal } = await import('../public/pages/calendar.js');
  assert.equal(typeof cal.dayDeepLinkDate, 'function', 'der Kalender liest date nur zusammen mit open');
  assert.equal(cal.dayDeepLinkDate(new URLSearchParams('date=2026-09-24')), '2026-09-24');
  // Mit Termin bleibt es der bestehende Termin-Link (Vorkommen dieses Tages).
  assert.equal(cal.dayDeepLinkDate(new URLSearchParams('open=7&date=2026-09-24')), '');
  assert.equal(cal.dayDeepLinkDate(new URLSearchParams('date=24.09.2026')), '');
  assert.equal(cal.dayDeepLinkDate(new URLSearchParams('')), '');
});

// --------------------------------------------------------------------------
// Teil 2: die Daten ueber /dashboard - Rechte und Optionen
// --------------------------------------------------------------------------

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { todayKey: serverTodayKey, shiftDateKey, localToUTC } = await import('../server/utils/timezone.js');

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
const database = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(database);
moduleDatabase.close();

database.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', ?)").run(HOUSEHOLD);

function seedUser(prefix, role = 'member') {
  return Number(database.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
    VALUES (?, ?, 'hash', '#7C3AED', ?, 'parent')
  `).run(`${prefix}-${randomUUID()}`, prefix, role).lastInsertRowid);
}

const ADMIN = seedUser('week-admin', 'admin');
const KID = seedUser('week-kid');

const TODAY = serverTodayKey(database);
const insertEvent = database.prepare(`
  INSERT INTO calendar_events (title, description, start_datetime, end_datetime, all_day, visibility, created_by, assigned_to)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
function addEvent({ title, start, end = null, allDay = 0, visibility = 'all', by = ADMIN, assignees = [] }) {
  const id = Number(insertEvent.run(title, `Beschreibung ${title}`, start, end, allDay, visibility, by, assignees[0] ?? null).lastInsertRowid);
  for (const userId of assignees) {
    database.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, userId);
  }
  return id;
}

// Heute 23:30 Haushaltszeit, gespeichert als Instant (synchronisiert).
addEvent({ title: 'Spaet heute', start: localToUTC(`${TODAY}T23:30:00`, HOUSEHOLD), assignees: [KID] });
addEvent({ title: 'In drei Tagen', start: `${shiftDateKey(TODAY, 3)}T10:00`, assignees: [ADMIN] });
addEvent({ title: 'Reise', start: shiftDateKey(TODAY, -2), end: `${shiftDateKey(TODAY, 1)}T00:00`, allDay: 1 });
addEvent({ title: 'Nach der Woche', start: `${shiftDateKey(TODAY, 12)}T10:00` });
addEvent({ title: 'Letzte Woche', start: `${shiftDateKey(TODAY, -5)}T10:00` });
addEvent({ title: 'Privat vom Admin', start: `${shiftDateKey(TODAY, 2)}T10:00`, visibility: 'private' });
const birthdayEventId = addEvent({ title: 'Birthday: Oma', start: shiftDateKey(TODAY, 4), end: shiftDateKey(TODAY, 4), allDay: 1 });
database.prepare('INSERT INTO birthdays (name, birth_date, calendar_event_id, created_by) VALUES (?, ?, ?, ?)')
  .run('Oma', '1950-01-01', birthdayEventId, ADMIN);
// Ein woechentlicher Termin, dessen Serie vor Wochen begann.
database.prepare(`
  INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, visibility, created_by, recurrence_rule)
  VALUES ('Turnen', ?, ?, 0, 'all', ?, 'FREQ=WEEKLY')
`).run(`${shiftDateKey(TODAY, -27)}T17:00`, `${shiftDateKey(TODAY, -27)}T18:00`, ADMIN);

let actor = ADMIN;
let tokenScopes = null;
const app = express();
app.use((req, _res, next) => {
  const user = database.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(actor);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.session = { userId: user.id, role: user.role };
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(database, user));
  req.authScopes = tokenScopes;
  next();
});
app.use('/', dashboardRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  database.close();
});

async function dashboardAs(userId, query = '') {
  actor = userId;
  const response = await fetch(`${endpoint}${query}`);
  assert.equal(response.status, 200);
  return response.json();
}
const titles = (body) => body.weekEvents.map((e) => e.title).sort();

test('/dashboard liefert die Termine der Woche - auch den ueberlappenden und die Serie', async () => {
  const body = await dashboardAs(ADMIN);
  assert.ok(Array.isArray(body.weekEvents), 'weekEvents fehlt in der Antwort');
  const got = titles(body);
  for (const title of ['Spaet heute', 'In drei Tagen', 'Reise', 'Privat vom Admin', 'Birthday: Oma', 'Turnen']) {
    assert.ok(got.includes(title), `${title} fehlt: ${got.join(', ')}`);
  }
  assert.ok(!got.includes('Nach der Woche'), 'zwoelf Tage voraus gehoert nicht in die Woche');
  assert.ok(!got.includes('Letzte Woche'), 'vergangene Termine gehoeren nicht in die Woche');
  const turnen = body.weekEvents.filter((e) => e.title === 'Turnen');
  assert.equal(turnen.length, 1, 'eine woechentliche Serie hat in sieben Tagen genau ein Vorkommen');
});

test('die Wochendaten sind schlank: keine Beschreibung, keine Anhaenge', async () => {
  const body = await dashboardAs(ADMIN);
  const event = body.weekEvents.find((e) => e.title === 'In drei Tagen');
  assert.equal(event.description, undefined);
  assert.equal(event.attachment_name, undefined);
  assert.ok(event.start_datetime && 'all_day' in event && Array.isArray(event.assigned_users));
});

test('Sichtbarkeit: ein privater Termin eines anderen erscheint nicht', async () => {
  const got = titles(await dashboardAs(KID));
  assert.ok(got.includes('Spaet heute'), `Vorbedingung: das Kind sieht die Woche - ${got.join(', ')}`);
  assert.ok(!got.includes('Privat vom Admin'), 'privater Termin durchgerutscht');
});

test('events_scope=mine gilt auch fuer die Woche', async () => {
  const got = titles(await dashboardAs(KID, '?events_scope=mine'));
  assert.deepEqual(got, ['Spaet heute']);
});

test('events_birthdays=hide gilt auch fuer die Woche', async () => {
  const got = titles(await dashboardAs(ADMIN, '?events_birthdays=hide'));
  assert.ok(!got.includes('Birthday: Oma'));
  assert.ok(got.includes('Reise'), 'ein normaler Ganztagstermin bleibt');
});

test('gesperrter Kalender: die Woche ist leer, die Form bleibt', async () => {
  database.prepare(`
    INSERT OR REPLACE INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'calendar', 'none')
  `).run(String(KID));
  try {
    const body = await dashboardAs(KID);
    assert.deepEqual(body.weekEvents, []);
    assert.ok(!JSON.stringify(body).includes('Spaet heute'));
  } finally {
    database.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(KID));
  }
});

test('nur-lesend darf die Woche lesen', async () => {
  database.prepare(`
    INSERT OR REPLACE INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'calendar', 'read')
  `).run(String(KID));
  try {
    assert.ok(titles(await dashboardAs(KID)).includes('Spaet heute'));
  } finally {
    database.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(KID));
  }
});

test('ein Token ohne Kalender-Scope bekommt keine Woche', async () => {
  tokenScopes = ['dashboard:read'];
  try {
    const body = await dashboardAs(ADMIN);
    assert.deepEqual(body.weekEvents, []);
  } finally {
    tokenScopes = null;
  }
});
