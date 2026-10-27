/**
 * Modul: Dashboard-API-Test
 * Zweck: Validiert die Dashboard-Aggregationsabfragen mit node:sqlite
 * Ausführen: node --experimental-sqlite test-dashboard.js
 */

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import * as nodeAssert from 'node:assert/strict';
import express from 'express';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import { addLocalDays, toLocalDateKey } from '../public/utils/date.js';
import { withoutBlockComments } from './source-text.js';

// Dynamisch geladen, weil beide Module inzwischen server/db.js in ihren
// Import-Graphen ziehen: statische Imports laufen vor der DB_PATH-Zuweisung
// oben, sodass db.js eine echte yuvomi.db im Repo anlegen würde
// (`test:db-isolation` wacht darüber).
const { hydrateBirthday, syncBirthdayArtifacts } = await import('../server/services/birthdays.js');
const { getUpcomingEvents } = await import('../server/services/calendar-event-reader.js');
const { expandRecurringEvents } = await import('../server/services/calendar-events.js');

register('./test-browser-loader.mjs', import.meta.url);

let passed = 0;
let failed = 0;
const pendingTests = [];

function test(name, fn) {
  pendingTests.push(Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`);
      passed++;
    })
    .catch((err) => {
      console.error(`  ✗ ${name}: ${err.message}`);
      failed++;
    }));
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion fehlgeschlagen');
}

// --------------------------------------------------------
// DB aufbauen
// --------------------------------------------------------
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
`);
db.exec(MIGRATIONS_SQL[1]);
db.exec(MIGRATIONS_SQL[2]);  // sync_config - traegt die Haushaltszone (siehe unten)
db.exec(MIGRATIONS_SQL[85]); // calendar_event_exceptions (EXDATE, #489)
db.exec(MIGRATIONS_SQL[174]); // birthday/name-day membership exclusions
db.exec(`
  ALTER TABLE calendar_events ADD COLUMN target_google_calendar_id TEXT;
  ALTER TABLE calendar_events ADD COLUMN target_caldav_account_id INTEGER;
  CREATE TABLE housekeeping_work_sessions (id INTEGER PRIMARY KEY, calendar_event_id INTEGER);
`);
db.exec(MIGRATIONS_SQL[245]);
// Migration 246 (#1935) hat ein Funktions-up und steht nicht im Spiegel.
db.exec('ALTER TABLE calendar_events ADD COLUMN series_authored INTEGER NOT NULL DEFAULT 0 CHECK(series_authored IN (0, 1));');

// Testdaten einfügen
const u1 = db.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color, role)
  VALUES ('admin', 'Anna Admin', 'x', '#007AFF', 'admin')`).run();
const u2 = db.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color)
  VALUES ('max', 'Max Muster', 'x', '#34C759')`).run();

const uid1 = u1.lastInsertRowid;
const uid2 = u2.lastInsertRowid;

// Lokale Kalendertage, nicht UTC: die Route liest Mahlzeitendatum, due_date und
// Geburtstage als lokale Kalenderwerte. Seedete der Test dagegen den UTC-Tag,
// fielen beide oestlich von UTC in den fruehen Morgenstunden auseinander und die
// Suite war zwischen 00:00 und 02:00 CEST rot - in UTC (CI) dagegen immer gruen.
// `inOneHour` bleibt ein echter Instant und damit korrekt in UTC.
const today = toLocalDateKey();
const tomorrow = addLocalDays(today, 1);

// DIE HAUSHALTSZONE MUSS DIESELBE SEIN, AUS DER DIE SAAT IHREN TAG NIMMT.
// Serverseitig beantwortet `todayKey()` die Frage "welcher Tag ist heute" aus
// `sync_config.household_timezone`; fehlt der Eintrag, faellt es still auf die
// Zone des RECHNERS zurueck. Genau dieser stille Rueckfall hat hier zweimal
// zugeschlagen (siehe den Kommentar oben zu 00:00-02:00 CEST, und #1076). Er
// stimmte bisher nur zufaellig mit `toLocalDateKey()` ueberein - jetzt steht es
// da, und der Waechter darunter faellt, wenn es jemand auseinanderzieht.
db.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?)')
  .run('household_timezone', Intl.DateTimeFormat().resolvedOptions().timeZone);
const currentMonth = today.slice(0, 7);
const inOneHour = new Date(Date.now() + 3600000).toISOString();
const in30h = toLocalDateKey(new Date(Date.now() + 30 * 3600000));
const in72h = toLocalDateKey(new Date(Date.now() + 72 * 3600000));

// Aufgaben
db.prepare(`INSERT INTO tasks (title, priority, status, due_date, created_by, assigned_to)
  VALUES ('Urgent Task', 'urgent', 'open', ?, ?, ?)`).run(today, uid1, uid2);
db.prepare(`INSERT INTO tasks (title, priority, status, due_date, created_by)
  VALUES ('High Task morgen', 'high', 'open', ?, ?)`).run(tomorrow, uid1);
db.prepare(`INSERT INTO tasks (title, priority, status, due_date, created_by)
  VALUES ('High Task in 3 Tagen', 'high', 'open', ?, ?)`).run(in72h, uid1);
db.prepare(`INSERT INTO tasks (title, priority, status, due_date, created_by)
  VALUES ('Done Task', 'urgent', 'done', ?, ?)`).run(today, uid1);

// Kalender-Events
const evMeeting = db.prepare(`INSERT INTO calendar_events (title, start_datetime, created_by, assigned_to, color)
  VALUES ('Morgen-Meeting', ?, ?, ?, '#007AFF')`).run(inOneHour, uid1, uid2);
db.prepare(`INSERT INTO calendar_events (title, start_datetime, created_by)
  VALUES ('Event in 3 Tagen', ?, ?)`).run(in72h + 'T10:00:00Z', uid1);

// Multi-Assignments für Morgen-Meeting (uid1 + uid2 sind zugewiesen)
db.prepare(`INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)`).run(evMeeting.lastInsertRowid, uid1);
db.prepare(`INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)`).run(evMeeting.lastInsertRowid, uid2);

// Mahlzeiten
db.prepare(`INSERT INTO meals (date, meal_type, title, created_by)
  VALUES (?, 'breakfast', 'Haferbrei', ?)`).run(today, uid1);
db.prepare(`INSERT INTO meals (date, meal_type, title, created_by)
  VALUES (?, 'dinner', 'Pasta', ?)`).run(today, uid1);
db.prepare(`INSERT INTO meals (date, meal_type, title, created_by)
  VALUES (?, 'lunch', 'Salat morgen', ?)`).run(tomorrow, uid1);

// Notizen
db.prepare(`INSERT INTO notes (content, title, pinned, color, created_by)
  VALUES ('Wichtige Info', 'Pinnwand-Notiz', 1, '#FFEB3B', ?)`).run(uid1);
db.prepare(`INSERT INTO notes (content, pinned, color, created_by)
  VALUES ('Nicht angepinnt', 0, '#E3F2FF', ?)`).run(uid1);

// Geburtstage
db.prepare(`INSERT INTO birthdays (name, birth_date, created_by)
  VALUES ('Heute Geburtstag', ?, ?)`).run(`2012-${today.slice(5)}`, uid1);
db.prepare(`INSERT INTO birthdays (name, birth_date, created_by)
  VALUES ('Morgen Geburtstag', ?, ?)`).run(`2010-${tomorrow.slice(5)}`, uid1);
db.prepare(`INSERT INTO birthdays (name, birth_date, created_by)
  VALUES ('Anderer Nutzer', ?, ?)`).run(`2011-${today.slice(5)}`, uid2);

// Budget
db.prepare(`INSERT INTO budget_entries (title, amount, category, subcategory, date, created_by)
  VALUES ('Salary', 3000, 'Erwerbseinkommen', '', ?, ?)`).run(`${currentMonth}-05`, uid1);
db.prepare(`INSERT INTO budget_entries (title, amount, category, subcategory, date, created_by)
  VALUES ('Rent', -1200, 'housing', 'rent_mortgage', ?, ?)`).run(`${currentMonth}-06`, uid1);
db.prepare(`INSERT INTO budget_entries (title, amount, category, subcategory, date, created_by)
  VALUES ('Groceries', -450, 'food', 'supermarket', ?, ?)`).run(`${currentMonth}-07`, uid1);

console.log('\n[Dashboard-Test] API-Abfragen\n');

// 2026-10-27, v2: hier stand „Das Erfassen bietet nur an, was der Betrachter
// anlegen darf (#1208, Tafla)" - die Typen des globalen Erfassen-Blatts folgten
// den Rechten. Blatt und + sind weg: jede Seite legt in ihrem Kopf an, und ihr
// Knopf folgt dort den Rechten des Moduls (test:module-readonly-ui). Dziś
// selbst traegt keinen Anlege-Knopf und ruft kein Erfassen mehr.
test('Dziś traegt keinen eigenen Anlege-Knopf und ruft kein globales Erfassen (v2)', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const { readFile } = await import('node:fs/promises');
  assert(__test.renderFab() === '', 'kein Speed-Dial, kein Knopf');
  const src = await readFile(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  assert(!/openCapture|capture-sheet/.test(src), 'Dziś ruft kein globales Erfassen mehr');
});

/* „Heute"/„Morgen" an einem echten ZEITPUNKT (#829, Nachlese #851).
 *
 * Hier stand `d.toDateString() === new Date().toDateString()` - beide Seiten in
 * der Browser-Zone. `d` ist an dieser Stelle oft ein synchronisierter Termin,
 * also ein Instant mit eigener Zone: ein Geraet in einer anderen Zone nannte
 * denselben Termin „Heute", waehrend er im Haushalt morgen liegt. Anders als bei
 * `formatDueDate` wird hier wirklich UMGERECHNET, denn ein Instant traegt seine
 * Zone selbst - das ist der Unterschied, den utils/timezone.js fuehrt.
 *
 * Geprueft wird die EIGENSCHAFT ueber ein Raster, nicht ein konstruierter
 * Einzelfall: „das Label heisst genau dann heute, wenn der Tag des Zeitpunkts in
 * der Anzeigezone der heutige ist". Eine erste Fassung setzte einen einzelnen
 * Zeitpunkt und war gruen und blind - er fiel zufaellig in BEIDEN Zonen auf
 * heute, also unterschied er die Fassungen nicht. Ein Raster ueber zwei Tage
 * trifft die Abweichung zwangslaeufig, sobald die Zonen auseinanderliegen. */
test('relativeDateLabel benennt einen Zeitpunkt in der Anzeigezone', async () => {
  const tz = await import('/utils/timezone.js');
  // TAFLA (2026-10-24): die Uebersicht reicht den Helfer nicht mehr durch (ihre
  // Kacheln sind gegangen) - geprueft wird er dort, wo er lebt.
  const { relativeDateLabel } = await import('../public/utils/day-label.js');
  const shiftDay = (key, days) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
  };

  try {
    for (const zone of ['Pacific/Honolulu', 'Pacific/Kiritimati']) {
      tz.setDisplayTimeZone(zone);
      const n = tz.nowFields();
      const p2 = (x) => String(x).padStart(2, '0');
      const today = `${n.year}-${p2(n.month)}-${p2(n.day)}`;

      let sawToday = 0;
      let sawTomorrow = 0;
      // Alle zwei Stunden ueber zwei Tage, ab jetzt.
      for (let h = 0; h < 48; h += 2) {
        const d = new Date(Date.now() + h * 3600000);
        const dayInZone = tz.zonedDateKey(d);
        const label = relativeDateLabel(d);

        if (dayInZone === today) {
          nodeAssert.equal(label, 'common.today',
            `${zone}: +${h}h faellt in der Anzeigezone auf heute (${dayInZone}), heisst aber "${label}"`);
          sawToday += 1;
        } else if (dayInZone === shiftDay(today, 1)) {
          nodeAssert.equal(label, 'common.tomorrow',
            `${zone}: +${h}h faellt auf morgen (${dayInZone}), heisst aber "${label}"`);
          sawTomorrow += 1;
        } else {
          nodeAssert.ok(label !== 'common.today' && label !== 'common.tomorrow',
            `${zone}: +${h}h faellt auf ${dayInZone}, traegt aber "${label}"`);
        }
      }
      // Sonst haette das Raster nichts geprueft.
      nodeAssert.ok(sawToday > 0 && sawTomorrow > 0,
        `${zone}: das Raster traf weder heute noch morgen - es prueft nichts`);
    }
  } finally {
    tz.setDisplayTimeZone(null);
  }
});

test('relativeDateLabel benennt einen Datums-Key ohne ihn umzurechnen', async () => {
  const tz = await import('/utils/timezone.js');
  const { relativeDateLabel } = await import('../public/utils/day-label.js');
  try {
    for (const zone of ['Pacific/Honolulu', 'Pacific/Kiritimati']) {
      tz.setDisplayTimeZone(zone);
      const n = tz.nowFields();
      const p2 = (x) => String(x).padStart(2, '0');
      const today = `${n.year}-${p2(n.month)}-${p2(n.day)}`;
      const shift = (days) => {
        const [y, m, d] = today.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
      };
      nodeAssert.equal(relativeDateLabel(today), 'common.today', zone);
      nodeAssert.equal(relativeDateLabel(shift(1)), 'common.tomorrow', zone);
      nodeAssert.ok(!['common.today', 'common.tomorrow'].includes(relativeDateLabel(shift(3))), zone);
      nodeAssert.equal(relativeDateLabel(null), '', 'kein Wert, kein Label');
    }
  } finally {
    tz.setDisplayTimeZone(null);
  }
});

/* Eine feste Uhrzeit von heute: die Wand waehlt ihre Szene nach der Uhr
 * (Noc ab 22:00), also stehen ihre Faelle unten auf einer festen Stunde.
 * TAFLA (2026-10-24): hier standen die Faelle des Heute-Blatts
 * (buildTodayCockpitModel). Das Blatt ist mit dem Raster gegangen; seine
 * Quellen liest Dziś ueber utils/today-plan.js (test:dashboard-tafla). */
function todayAt(hour, minute = 0) {
  const now = new Date();
  now.setHours(hour, minute, 0, 0);
  return now;
}

// --------------------------------------------------------
// Tests: Dringende Aufgaben
// --------------------------------------------------------
const deadline48h = new Date(Date.now() + 48 * 3600000).toISOString().slice(0, 10);

test('Dringende Aufgaben: nur high/urgent mit Fälligkeit ≤ 48h und nicht done', () => {
  const tasks = db.prepare(`
    SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color
    FROM tasks t
    LEFT JOIN users u ON t.assigned_to = u.id
    WHERE t.priority IN ('high', 'urgent')
      AND t.status != 'done'
      AND (t.due_date IS NULL OR t.due_date <= ?)
    ORDER BY CASE t.priority WHEN 'urgent' THEN 0 ELSE 1 END, t.due_date ASC
    LIMIT 10
  `).all(deadline48h);

  assert(tasks.length === 2, `Erwartet 2 Aufgaben, erhalten ${tasks.length}`);
  assert(tasks[0].priority === 'urgent', 'Urgent zuerst');
  assert(tasks[0].assigned_name === 'Max Muster', 'assigned_name korrekt');
  assert(tasks[0].assigned_color === '#34C759', 'assigned_color korrekt');
});

test('Dringende Aufgaben: erledigte Aufgaben werden nicht angezeigt', () => {
  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE priority IN ('high', 'urgent') AND status != 'done' AND due_date <= ?
  `).all(deadline48h);
  const doneTask = tasks.find((t) => t.title === 'Done Task');
  assert(!doneTask, 'Erledigte Aufgaben sollten gefiltert sein');
});

test('Dringende Aufgaben: Task mit Fälligkeit in 3 Tagen wird ausgeschlossen', () => {
  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE priority IN ('high', 'urgent') AND status != 'done' AND due_date <= ?
  `).all(deadline48h);
  const farTask = tasks.find((t) => t.title === 'High Task in 3 Tagen');
  assert(!farTask, 'Aufgabe in 72h sollte nicht erscheinen');
});

// --------------------------------------------------------
// Tests: Anstehende Termine
// --------------------------------------------------------
test('Anstehende Termine: zukünftige Events, sortiert, max 5', () => {
  const now = new Date().toISOString();
  const events = db.prepare(`
    SELECT ce.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color
    FROM calendar_events ce
    LEFT JOIN users u ON ce.assigned_to = u.id
    WHERE ce.start_datetime >= ?
    ORDER BY ce.start_datetime ASC
    LIMIT 5
  `).all(now);

  assert(events.length === 2, `Erwartet 2 Events, erhalten ${events.length}`);
  assert(events[0].title === 'Morgen-Meeting', 'Erstes Event ist das nächste');
  assert(events[0].assigned_color === '#34C759', 'assigned_color vom Join');
});

test('Anstehende Termine: Dashboard-Mapping erzeugt assigned_users Array (Issue #284)', () => {
  const raw = getUpcomingEvents(cdb, { userId: cuTheo, limit: 10 });
  const mapped = raw.map(({ assigned_users_json, ...event }) => {
    event.assigned_users = assigned_users_json ? JSON.parse(assigned_users_json) : [];
    return event;
  });

  const soccer = mapped.find((e) => e.title === 'Theodore Soccer Game');
  assert(soccer, 'Theodore Soccer Game muss im Ergebnis sein');
  assert(!('assigned_users_json' in soccer), 'assigned_users_json darf nicht im Ergebnis sein');
  assert(Array.isArray(soccer.assigned_users), 'assigned_users muss ein Array sein');
  assert(soccer.assigned_users.length === 2, `Erwartet 2 Einträge, erhalten ${soccer.assigned_users.length}`);
  assert('avatar_data' in soccer.assigned_users[0], 'avatar_data muss im User-Objekt enthalten sein');

  const fieldTrip = mapped.find((e) => e.title === 'Sofia Field Trip');
  assert(fieldTrip, 'Sofia Field Trip muss erscheinen');
  assert(Array.isArray(fieldTrip.assigned_users) && fieldTrip.assigned_users.length === 0,
    'Event ohne Zuweisung hat leeres assigned_users Array');
});

// --------------------------------------------------------
// Tests: Heutige Mahlzeiten
// --------------------------------------------------------
test('Heutige Mahlzeiten: nur heute, in korrekter Reihenfolge', () => {
  const meals = db.prepare(`
    SELECT * FROM meals WHERE date = ?
    ORDER BY CASE meal_type
      WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1
      WHEN 'dinner' THEN 2 WHEN 'snack' THEN 3 END
  `).all(today);

  assert(meals.length === 2, `Erwartet 2 Mahlzeiten, erhalten ${meals.length}`);
  assert(meals[0].meal_type === 'breakfast', 'Frühstück zuerst');
  assert(meals[1].meal_type === 'dinner', 'Abendessen danach');
});

test('Heutige Mahlzeiten: morgige Mahlzeit nicht enthalten', () => {
  const meals = db.prepare(`SELECT * FROM meals WHERE date = ?`).all(today);
  const wrongMeal = meals.find((m) => m.title === 'Salat morgen');
  assert(!wrongMeal, 'Morgige Mahlzeit sollte nicht erscheinen');
});

// --------------------------------------------------------
// Tests: Angepinnte Notizen
// --------------------------------------------------------
test('Angepinnte Notizen: nur pinned=1, max 3', () => {
  const notes = db.prepare(`
    SELECT n.*, u.display_name AS author_name, u.avatar_color AS author_color
    FROM notes n
    LEFT JOIN users u ON n.created_by = u.id
    WHERE n.pinned = 1
    ORDER BY n.updated_at DESC
    LIMIT 3
  `).all();

  assert(notes.length === 1, `Erwartet 1 Notiz, erhalten ${notes.length}`);
  assert(notes[0].title === 'Pinnwand-Notiz', 'Korrekte Notiz');
  assert(notes[0].author_name === 'Anna Admin', 'author_name vom Join');
});

test('Angepinnte Notizen: nicht angepinnte werden ausgeschlossen', () => {
  const notes = db.prepare(`SELECT * FROM notes WHERE pinned = 1`).all();
  const unpinned = notes.find((n) => n.content === 'Nicht angepinnt');
  assert(!unpinned, 'Nicht angepinnte Notiz sollte gefiltert sein');
});

// --------------------------------------------------------
// Tests: Geburtstage
// --------------------------------------------------------
test('Saattag und Haushaltstag sind derselbe Tag', async () => {
  // Der Nagel, auf dem die halbe Datei haengt: 36 Stellen saeen ihre Daten mit
  // `toLocalDateKey()`, und der Server liest sie ueber die Haushaltszone zurueck.
  // Laufen die beiden auseinander, faellt nicht dieser Test, sondern irgendein
  // anderer, ein paar Stunden am Tag, und die Ursache steht nirgends. Deshalb
  // hier, mit Namen, und zwar an BEIDEN Enden des Tages.
  const { todayKey } = await import('../server/utils/timezone.js');
  for (const stunde of ['00:00:01', '12:00:00', '23:59:59']) {
    nodeAssert.equal(
      todayKey(db, new Date(`${today}T${stunde}`)),
      today,
      `Haushaltszone und Saatzone driften auseinander (${stunde}): ` +
      `sync_config sagt ${db.prepare("SELECT value FROM sync_config WHERE key='household_timezone'").get()?.value}`
    );
  }
});

/* Nachgesehen, weil ein Testfehler ueber Kalendertage sonst leicht einen
 * Produktfehler versteckt: hier ist keiner dahinter. Alle Aufrufer von
 * `hydrateBirthday` (server/routes/birthdays.js dreimal, server/routes/
 * dashboard.js ueber `hydrateBirthdayOccurrences`) uebergeben gar kein `from`
 * und bekommen `new Date()` - einen echten Zeitpunkt, den `todayKey` korrekt
 * in den Haushaltstag umrechnet. Nur der Test baute sich einen Zeitpunkt, der
 * nicht der Tag war, den er meinte.
 */
test('Geburtstage: haushaltsweit, sortiert nach nächstem Geburtstag', () => {
  const rows = db.prepare('SELECT * FROM birthdays ORDER BY name COLLATE NOCASE ASC').all();
  const birthdays = rows
    // Mittag des gesaeten Tages in der HAUSHALTSZONE, nicht 12:00 UTC. Mit dem
    // `Z` stand hier ein Instant, der ab einem Zonenversatz von +12 schon auf dem
    // FOLGETAG liegt: unter Pacific/Kiritimati (+14) hielt `hydrateBirthday` den
    // 11. fuer heute, waehrend die Saat auf dem 10. lag, und "Morgen Geburtstag"
    // bekam `days_until: 0`. Ohne das `Z` liest `new Date` lokal, also in
    // derselben Zone, aus der `toLocalDateKey()` den Saattag genommen hat.
    .map((row) => hydrateBirthday(db, row, new Date(`${today}T12:00:00`)))
    .sort((a, b) => a.days_until - b.days_until || a.name.localeCompare(b.name))
    .slice(0, 3);

  assert(rows.length === 3, `Erwartet 3 Geburtstage, erhalten ${rows.length}`);
  assert(birthdays[0].days_until === 0, 'Ein heutiger Geburtstag steht zuerst');
  assert(birthdays.some((birthday) => birthday.name === 'Heute Geburtstag' && birthday.days_until === 0),
    'Eigener heutiger Geburtstag muss enthalten sein');
  assert(birthdays.some((birthday) => birthday.name === 'Anderer Nutzer'), 'Geburtstag eines anderen Nutzers muss enthalten sein');
});

/* Und die Zone einmal WEG von der des Rechners.
 *
 * Die geteilte Datenbank oben setzt `household_timezone` bewusst auf die Zone
 * der Maschine, damit Saattag und Haushaltstag zusammenfallen. Der Preis dafuer
 * ist, dass in dieser Datenbank beide Uhren dasselbe sagen: ob `hydrateBirthday`
 * den Stichtag aus der HAUSHALTSZONE nimmt oder einfach aus der des Servers,
 * ist dort nicht zu unterscheiden. Der Waechter `Saattag und Haushaltstag sind
 * derselbe Tag` bliebe gruen, wenn jemand die Haushaltszone ganz herausnaehme.
 *
 * Diese Probe stellt deshalb eine eigene Datenbank hin, in der die
 * Haushaltszone NICHT die der Maschine ist, und liest EINEN Zeitpunkt zweimal,
 * in zwei Zonen beiderseits der Datumsgrenze. Weil beide Antworten aus
 * demselben Zeitpunkt kommen und sich unterscheiden MUESSEN, kann keine
 * Fassung sie erfuellen, die stattdessen die Zone der Maschine liest - die ist
 * innerhalb eines Laufs konstant.
 */
test('Geburtstage: der Stichtag folgt der Haushaltszone, nicht der des Servers', () => {
  const zdb = new DatabaseSync(':memory:');
  zdb.exec('PRAGMA foreign_keys = ON;');
  zdb.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
  `);
  zdb.exec(MIGRATIONS_SQL[1]);
  zdb.exec(MIGRATIONS_SQL[2]); // sync_config - traegt die Haushaltszone, hier bewusst eine fremde

  const zoneUser = zdb.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color)
    VALUES ('zonen-test', 'Zonen Test', 'x', '#FF9500')`).run().lastInsertRowid;
  zdb.prepare(`INSERT INTO birthdays (name, birth_date, created_by)
    VALUES ('Zonenkind', '2012-06-16', ?)`).run(zoneUser);
  const row = zdb.prepare('SELECT * FROM birthdays').get();

  const setZone = (zone) => zdb.prepare(`
    INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(zone);

  // EIN Zeitpunkt, der die Zonen trennt: 2026-06-15T12:00:00Z ist in Kiritimati
  // (+14) bereits der 16. um 02:00, in Los Angeles (-7) noch der 15. um 05:00.
  const at = new Date('2026-06-15T12:00:00Z');

  setZone('Pacific/Kiritimati');
  const east = hydrateBirthday(zdb, row, at);
  assert(east.days_until === 0,
    `Haushalt auf Kiritimati: am 16. ist der Geburtstag heute, erhalten days_until=${east.days_until} (next_birthday ${east.next_birthday})`);

  setZone('America/Los_Angeles');
  const west = hydrateBirthday(zdb, row, at);
  assert(west.days_until === 1,
    `Haushalt auf Los Angeles: derselbe Zeitpunkt ist noch der 15., der Geburtstag also morgen, erhalten days_until=${west.days_until} (next_birthday ${west.next_birthday})`);

  // Und die beiden muessen sich unterscheiden - sonst hat die Zone gar nichts
  // entschieden und beide Zweige lasen dieselbe (Server-)Uhr.
  assert(east.days_until !== west.days_until,
    'derselbe Zeitpunkt muss in beiden Haushaltszonen einen anderen Stichtag ergeben');
});

test('Dashboard-Geburtstagswidget lädt Geburtstage haushaltsweit (Issue #406)', async () => {
  const { get } = await import('../server/db.js');
  const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
  const routeDb = get();

  routeDb.prepare("DELETE FROM reminders WHERE created_by IN (SELECT id FROM users WHERE username LIKE 'dashboard-birthday-%')").run();
  routeDb.prepare("DELETE FROM calendar_events WHERE created_by IN (SELECT id FROM users WHERE username LIKE 'dashboard-birthday-%')").run();
  routeDb.prepare("DELETE FROM birthdays WHERE created_by IN (SELECT id FROM users WHERE username LIKE 'dashboard-birthday-%')").run();
  routeDb.prepare("DELETE FROM users WHERE username LIKE 'dashboard-birthday-%'").run();

  const routeUser1 = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-birthday-owner', 'Owner', 'x', '#007AFF', 'admin')
  `).run().lastInsertRowid;
  const routeUser2 = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-birthday-other', 'Other', 'x', '#34C759', 'member')
  `).run().lastInsertRowid;

  routeDb.prepare('INSERT INTO birthdays (name, birth_date, name_day, created_by) VALUES (?, ?, ?, ?)')
    .run('Widget Owner Today', `2012-${today.slice(5)}`, today.slice(5), routeUser1);
  routeDb.prepare('INSERT INTO birthdays (name, birth_date, created_by) VALUES (?, ?, ?)')
    .run('Widget Other Today', `2011-${today.slice(5)}`, routeUser2);

  const app = express();
  app.use((req, _res, next) => {
    req.authUserId = routeUser1;
    req.session = { userId: routeUser1 };
    next();
  });
  app.use('/', dashboardRouter);

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
    const body = await response.json();
    const names = body.birthdays.map((birthday) => birthday.name);

    nodeAssert.equal(response.status, 200);
    nodeAssert.equal(body.birthdayCount, 2);
    // Die Kachel-Badge zaehlt Anlaesse, nicht Personen: zwei Menschen, einer
    // davon mit Namenstag, sind drei Zeilen (Critique 2026-09-23).
    nodeAssert.equal(body.birthdayTotal, 3);
    nodeAssert.ok(names.includes('Widget Other Today'), 'Dashboard widget must include birthdays created by other users');
    const ownerRows = body.birthdays.filter((item) => item.name === 'Widget Owner Today');
    nodeAssert.deepEqual(
      ownerRows.map((item) => item.kind).sort(),
      ['birthday', 'name_day'],
      'the same person appears as separate birthday and name-day occurrences',
    );
    const nameDay = ownerRows.find((item) => item.kind === 'name_day');
    nodeAssert.equal(nameDay.days_until, 0);
    nodeAssert.equal(nameDay.next_date, today);
    nodeAssert.equal(nameDay.next_age, null);
    nodeAssert.equal(body.birthdaySoonCount, 3, 'the three-day badge counts both occurrence kinds exactly once');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Dashboard-Endpoint filtert heutige Mahlzeiten nach sichtbaren Typen', async () => {
  const { get } = await import('../server/db.js');
  const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
  const routeDb = get();
  const previousMealTypes = routeDb.prepare('SELECT value FROM sync_config WHERE key = ?').get('visible_meal_types')?.value ?? null;

  routeDb.prepare("DELETE FROM meals WHERE created_by IN (SELECT id FROM users WHERE username LIKE 'dashboard-meals-%')").run();
  routeDb.prepare("DELETE FROM users WHERE username LIKE 'dashboard-meals-%'").run();

  const routeUser = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-meals-owner', 'Meal Owner', 'x', '#007AFF', 'admin')
  `).run().lastInsertRowid;

  routeDb.prepare(`
    INSERT INTO meals (date, meal_type, title, created_by)
    VALUES (?, ?, ?, ?)
  `).run(today, 'breakfast', 'Hidden Breakfast', routeUser);
  routeDb.prepare(`
    INSERT INTO meals (date, meal_type, title, created_by)
    VALUES (?, ?, ?, ?)
  `).run(today, 'dinner', 'Visible Dinner', routeUser);
  routeDb.prepare(`
    INSERT INTO sync_config (key, value)
    VALUES ('visible_meal_types', 'dinner')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run();

  const app = express();
  app.use((req, _res, next) => {
    req.authUserId = routeUser;
    req.session = { userId: routeUser };
    next();
  });
  app.use('/', dashboardRouter);

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
    const body = await response.json();

    nodeAssert.equal(response.status, 200);
    nodeAssert.deepEqual(body.todayMeals.map((meal) => meal.meal_type), ['dinner']);
    nodeAssert.equal(body.todayMeals[0].title, 'Visible Dinner');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousMealTypes === null) {
      routeDb.prepare('DELETE FROM sync_config WHERE key = ?').run('visible_meal_types');
    } else {
      routeDb.prepare(`
        INSERT INTO sync_config (key, value)
        VALUES ('visible_meal_types', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(previousMealTypes);
    }
    routeDb.prepare("DELETE FROM meals WHERE created_by IN (SELECT id FROM users WHERE username LIKE 'dashboard-meals-%')").run();
    routeDb.prepare("DELETE FROM users WHERE username LIKE 'dashboard-meals-%'").run();
  }
});

// Die Rangfolge nach Punkten ist mit der Critique 2026-09-23 entfallen: wer
// freigibt, sieht die Kinder nach NAMEN, und die Sicht haengt an der Rolle
// (authRole). Die Sichten einzeln prueft test/test-dashboard-rewards.js.
test('Dashboard-Endpoint: Belohnungen liefert Punktestand, Teilnehmerzahl und offene Freigaben', async () => {
  const { get } = await import('../server/db.js');
  const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
  const routeDb = get();

  routeDb.prepare("DELETE FROM users WHERE username LIKE 'dashboard-rewards-%'").run();

  const parent = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-rewards-parent', 'Rewards Parent', 'x', '#007AFF', 'admin')
  `).run().lastInsertRowid;
  const kidA = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-rewards-kid-a', 'Kid A', 'x', '#34C759', 'member')
  `).run().lastInsertRowid;
  const kidB = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-rewards-kid-b', 'Kid B', 'x', '#FF9500', 'member')
  `).run().lastInsertRowid;

  for (const uid of [kidA, kidB]) {
    routeDb.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(uid);
  }
  routeDb.prepare("INSERT INTO reward_ledger (user_id, delta, type) VALUES (?, 30, 'earn')").run(kidA);
  routeDb.prepare("INSERT INTO reward_ledger (user_id, delta, type) VALUES (?, 80, 'earn')").run(kidB);
  routeDb.prepare(`INSERT INTO reward_redemptions (user_id, reward_name, cost, status)
    VALUES (?, 'Kino', 50, 'pending')`).run(kidB);

  const app = express();
  app.use((req, _res, next) => { req.authUserId = parent; req.authRole = 'admin'; req.session = { userId: parent }; next(); });
  app.use('/', dashboardRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).json();
    const names = body.rewards.standings.map((s) => s.display_name);
    nodeAssert.equal(body.rewards.view, 'approver');
    nodeAssert.equal(names[0], 'Kid A', 'nach Namen, nicht nach Saldo - Kid B hat mehr und steht nicht vorn');
    nodeAssert.ok(names.includes('Kid A'), 'zweiter Teilnehmer ist enthalten');
    nodeAssert.ok(!names.includes('Rewards Parent'), 'Nicht-Teilnehmer erscheinen nicht');
    nodeAssert.equal(body.rewards.standings.find((s) => s.display_name === 'Kid B').balance, 80);
    nodeAssert.equal(body.rewards.participantCount, 2);
    nodeAssert.equal(body.rewards.pending, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    routeDb.prepare("DELETE FROM users WHERE username LIKE 'dashboard-rewards-%'").run();
  }
});

test('Dashboard-Endpoint: Gesundheit zählt heute fällige eigene Dosen und Nachbestellungen', async () => {
  const { get } = await import('../server/db.js');
  const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
  const routeDb = get();

  routeDb.prepare("DELETE FROM users WHERE username LIKE 'dashboard-health-%'").run();
  const owner = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-health-owner', 'Health Owner', 'x', '#007AFF', 'admin')
  `).run().lastInsertRowid;
  const other = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-health-other', 'Health Other', 'x', '#34C759', 'member')
  `).run().lastInsertRowid;

  // Familiensichtbares Medikament mit täglichem Plan (days_mask NULL) → heute fällig.
  const famMed = routeDb.prepare(`
    INSERT INTO medications (user_id, name, active, visibility) VALUES (?, 'Vitamin D', 1, 'family')
  `).run(owner).lastInsertRowid;
  routeDb.prepare(`
    INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, active) VALUES (?, '08:00', NULL, 1)
  `).run(famMed);
  // Familiensichtbar, niedriger Bestand, ohne Plan → zählt als Nachbestellung, nicht als Dosis.
  routeDb.prepare(`
    INSERT INTO medications (user_id, name, active, visibility, stock_qty, refill_threshold)
    VALUES (?, 'Ibuprofen', 1, 'family', 2, 5)
  `).run(owner);
  // Eigenes privates Medikament mit Plan → zählt auf dem persönlichen Dashboard mit.
  const privMed = routeDb.prepare(`
    INSERT INTO medications (user_id, name, active, visibility) VALUES (?, 'Privat-Med', 1, 'private')
  `).run(owner).lastInsertRowid;
  routeDb.prepare(`
    INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, active) VALUES (?, '09:00', NULL, 1)
  `).run(privMed);
  // Fremdes Medikament, familiensichtbar, früheste Zeit + niedriger Bestand → darf weder
  // als Dosis noch als nextDose noch als Nachbestellung erscheinen (Issue #592).
  const foreignMed = routeDb.prepare(`
    INSERT INTO medications (user_id, name, active, visibility, stock_qty, refill_threshold)
    VALUES (?, 'Fremd-Med', 1, 'family', 0, 5)
  `).run(other).lastInsertRowid;
  routeDb.prepare(`
    INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, active) VALUES (?, '05:00', NULL, 1)
  `).run(foreignMed);

  // Lokaler Tagesschlüssel wie im Handler (lokales Kalenderdatum), damit die
  // medication_logs-Zuordnung (substr(scheduled_at,1,10)) auch westlich von UTC greift.
  const localKey = toLocalDateKey(new Date());

  // Zusätzlicher familiensichtbarer Med mit gesetzter days_mask=127 (jeder Wochentag) →
  // deckt den Nicht-NULL-Maskenzweig ab und ist mit 07:00 die früheste offene Dosis.
  const dailyMed = routeDb.prepare(`
    INSERT INTO medications (user_id, name, active, visibility) VALUES (?, 'Tagesmed', 1, 'family')
  `).run(owner).lastInsertRowid;
  routeDb.prepare(`
    INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, active) VALUES (?, '07:00', 127, 1)
  `).run(dailyMed);
  // Plan startet erst in ferner Zukunft → heute nicht fällig (start_date-Zweig).
  const futureMed = routeDb.prepare(`
    INSERT INTO medications (user_id, name, active, visibility) VALUES (?, 'Zukunftsmed', 1, 'family')
  `).run(owner).lastInsertRowid;
  routeDb.prepare(`
    INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, start_date, active) VALUES (?, '06:00', NULL, '2099-12-31', 1)
  `).run(futureMed);
  // Plan bereits abgelaufen → heute nicht fällig (end_date-Zweig).
  const endedMed = routeDb.prepare(`
    INSERT INTO medications (user_id, name, active, visibility) VALUES (?, 'Abgelaufenmed', 1, 'family')
  `).run(owner).lastInsertRowid;
  routeDb.prepare(`
    INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, end_date, active) VALUES (?, '06:30', NULL, '2000-01-01', 1)
  `).run(endedMed);
  // Fällig + heute bereits genommen → zählt als dosesTaken, nicht als nextDose.
  const takenMed = routeDb.prepare(`
    INSERT INTO medications (user_id, name, active, visibility) VALUES (?, 'Genommenmed', 1, 'family')
  `).run(owner).lastInsertRowid;
  routeDb.prepare(`
    INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, active) VALUES (?, '10:00', NULL, 1)
  `).run(takenMed);
  routeDb.prepare(`
    INSERT INTO medication_logs (medication_id, scheduled_at, status) VALUES (?, ?, 'taken')
  `).run(takenMed, `${localKey}T10:00:00`);
  // Fällig + heute ausgelassen → zählt als dosesSkipped.
  const skippedMed = routeDb.prepare(`
    INSERT INTO medications (user_id, name, active, visibility) VALUES (?, 'Ausgelassenmed', 1, 'family')
  `).run(owner).lastInsertRowid;
  routeDb.prepare(`
    INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, active) VALUES (?, '11:00', NULL, 1)
  `).run(skippedMed);
  routeDb.prepare(`
    INSERT INTO medication_logs (medication_id, scheduled_at, status) VALUES (?, ?, 'skipped')
  `).run(skippedMed, `${localKey}T11:00:00`);

  const app = express();
  app.use((req, _res, next) => { req.authUserId = owner; req.session = { userId: owner }; next(); });
  app.use('/', dashboardRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).json();
    nodeAssert.equal(body.health.hasMeds, true);
    // Fällig heute: Tagesmed (07:00), Vitamin D (08:00), Privat-Med (09:00),
    // Genommenmed (10:00), Ausgelassenmed (11:00). Zukunfts-/Abgelaufen-Plan zählen
    // nicht; das fremde Med (05:00) ist trotz visibility='family' ausgeschlossen.
    nodeAssert.equal(body.health.dosesTotal, 5, 'fünf eigene, heute fällige Dosen (zukunft/abgelaufen/fremd ausgeschlossen)');
    nodeAssert.equal(body.health.dosesTaken, 1, 'die geloggte Einnahme zählt als genommen');
    nodeAssert.equal(body.health.dosesSkipped, 1, 'die geloggte Auslassung zählt als ausgelassen');
    nodeAssert.equal(body.health.nextDose.name, 'Tagesmed', 'früheste eigene offene Dosis (07:00) ist die nächste');
    nodeAssert.equal(body.health.lowStockCount, 1, 'nur der eigene niedrige Bestand wird gezählt');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    routeDb.prepare("DELETE FROM users WHERE username LIKE 'dashboard-health-%'").run();
  }
});

test('Dashboard-Endpoint: Haushaltshilfe meldet Anwesenheit, Monatsbesuche und offenen Betrag', async () => {
  const { get } = await import('../server/db.js');
  const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
  const routeDb = get();

  routeDb.prepare("DELETE FROM users WHERE username LIKE 'dashboard-hk-%'").run();
  const owner = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-hk-owner', 'HK Owner', 'x', '#007AFF', 'admin')
  `).run().lastInsertRowid;
  const helperUser = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-hk-helper', 'Maria', 'x', '#34C759', 'member')
  `).run().lastInsertRowid;
  const workerId = routeDb.prepare(`
    INSERT INTO housekeeping_workers (user_id, daily_rate) VALUES (?, 40)
  `).run(helperUser).lastInsertRowid;

  // Offene Sitzung heute → Anwesenheit. check_in mit lokalem Monat.
  routeDb.prepare(`
    INSERT INTO housekeeping_work_sessions (check_in, check_out, daily_rate, extras, worker_id, created_by)
    VALUES (?, NULL, 40, 0, ?, ?)
  `).run(`${today}T09:00:00`, workerId, owner);
  // Abgeschlossene, unbezahlte Sitzung diesen Monat.
  routeDb.prepare(`
    INSERT INTO housekeeping_work_sessions (check_in, check_out, daily_rate, extras, paid_at, worker_id, created_by)
    VALUES (?, ?, 40, 10, NULL, ?, ?)
  `).run(`${currentMonth}-01T09:00:00`, `${currentMonth}-01T13:00:00`, workerId, owner);

  const app = express();
  app.use((req, _res, next) => { req.authUserId = owner; req.session = { userId: owner }; next(); });
  app.use('/', dashboardRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).json();
    nodeAssert.equal(body.housekeeping.configured, true);
    nodeAssert.equal(body.housekeeping.present, true);
    nodeAssert.equal(body.housekeeping.workerName, 'Maria');
    nodeAssert.equal(body.housekeeping.visitsThisMonth, 1, 'nur abgeschlossene Sitzungen zählen als Besuch');
    nodeAssert.equal(body.housekeeping.unpaidAmount, 50, 'daily_rate 40 + extras 10, unbezahlt');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    routeDb.prepare("DELETE FROM users WHERE username LIKE 'dashboard-hk-%'").run();
  }
});

test('Dashboard-Endpoint: dringende Aufgaben, anstehende Termine, Einkaufslisten und Sparziel', async () => {
  const { get } = await import('../server/db.js');
  const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
  const routeDb = get();

  routeDb.prepare("DELETE FROM budget_plans WHERE category = '__savings__'").run();
  routeDb.prepare("DELETE FROM users WHERE username LIKE 'dashboard-widgets-%'").run();
  const owner = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-widgets-owner', 'Widget Owner', 'x', '#007AFF', 'admin')
  `).run().lastInsertRowid;

  // Offene, dringende Aufgabe mit Zuweisung → deckt die urgentTasks-Map + addAssignedUsers.
  const taskId = routeDb.prepare(`
    INSERT INTO tasks (title, priority, status, due_date, visibility, created_by, assigned_to)
    VALUES ('Widget Urgent', 'urgent', 'open', ?, 'all', ?, ?)
  `).run(today, owner, owner).lastInsertRowid;
  routeDb.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(taskId, owner);

  // Abgelegte Aufgabe (#688): steht weiter auf 'open' und wäre damit vor dem Fix
  // in "Heute auf einen Blick" gelandet - dort ließ sie sich aber nicht öffnen,
  // weil die Liste sie ausblendet.
  routeDb.prepare(`
    INSERT INTO tasks (title, priority, status, due_date, visibility, created_by, assigned_to, archived_at)
    VALUES ('Widget Abgelegt', 'urgent', 'open', ?, 'all', ?, ?, '2026-08-01T10:00:00Z')
  `).run(today, owner, owner);

  // Anstehender Termin mit Zuweisung → deckt die upcomingEvents-Map (assigned_users).
  const eventId = routeDb.prepare(`
    INSERT INTO calendar_events (title, start_datetime, visibility, created_by, assigned_to)
    VALUES ('Widget Termin', ?, 'all', ?, ?)
  `).run(`${in72h}T09:00:00`, owner, owner).lastInsertRowid;
  routeDb.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(eventId, owner);

  // Einkaufsliste mit offenen Artikeln → deckt die innere Items-Schleife.
  const listId = routeDb.prepare(`
    INSERT INTO shopping_lists (name, created_by) VALUES ('Widget Einkauf', ?)
  `).run(owner).lastInsertRowid;
  routeDb.prepare('INSERT INTO shopping_items (list_id, name, is_checked) VALUES (?, ?, 0)').run(listId, 'Milch');
  routeDb.prepare('INSERT INTO shopping_items (list_id, name, is_checked) VALUES (?, ?, 0)').run(listId, 'Brot');
  routeDb.prepare('INSERT INTO shopping_items (list_id, name, is_checked) VALUES (?, ?, 1)').run(listId, 'Butter (erledigt)');

  // Heute fällige, bereits erledigte Aufgabe → deckt tasksDoneToday („Alles
  // erledigt"-Zustand des Tagesprogramms). Lokaler Datumsschlüssel, nicht UTC:
  // der Server vergleicht mit todayLocalKey (exakte Gleichheit).
  routeDb.prepare(`
    INSERT INTO tasks (title, priority, status, due_date, visibility, created_by, assigned_to)
    VALUES ('Widget Erledigt', 'medium', 'done', ?, 'all', ?, ?)
  `).run(toLocalDateKey(new Date()), owner, owner);

  // Monats-Sparziel (Budgetplan) → deckt den savingsGoal-Zweig.
  routeDb.prepare("INSERT INTO budget_plans (category, amount) VALUES ('__savings__', 500)").run();

  const app = express();
  app.use((req, _res, next) => { req.authUserId = owner; req.session = { userId: owner }; next(); });
  app.use('/', dashboardRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).json();

    const urgent = body.urgentTasks.find((t) => t.title === 'Widget Urgent');
    nodeAssert.ok(urgent, 'dringende Aufgabe erscheint im Widget');
    nodeAssert.ok(Array.isArray(urgent.assigned_users), 'assigned_users ist ein Array (addAssignedUsers lief)');
    nodeAssert.equal(urgent.assigned_users.length, 1, 'die eine Zuweisung ist enthalten');
    nodeAssert.equal(urgent.assigned_users_json, undefined, 'das rohe JSON-Feld wird entfernt');
    // Die Uebersicht zeigt "begonnen" aus diesem Feld (#1251) - faellt es aus
    // der Abfrage, sieht jede Aufgabe wieder offen aus.
    nodeAssert.equal(urgent.status, 'open', 'der Status wird mitgeliefert (#1251)');
    nodeAssert.equal(
      body.urgentTasks.find((t) => t.title === 'Widget Abgelegt'),
      undefined,
      'abgelegte Aufgaben bleiben aus "Heute auf einen Blick" (#688)',
    );

    const upcoming = body.upcomingEvents.find((e) => e.title === 'Widget Termin');
    nodeAssert.ok(upcoming, 'anstehender Termin erscheint im Widget');
    nodeAssert.ok(Array.isArray(upcoming.assigned_users), 'assigned_users am Termin ist ein Array');

    const list = body.shoppingLists.find((l) => l.name === 'Widget Einkauf');
    nodeAssert.ok(list, 'Einkaufsliste mit offenen Artikeln erscheint');
    nodeAssert.equal(list.open_count, 2, 'nur die zwei offenen Artikel zählen');
    nodeAssert.equal(list.items.length, 2, 'die innere Items-Liste enthält nur offene Artikel');
    nodeAssert.ok(list.items.every((i) => i.is_checked === 0), 'kein erledigter Artikel in der Items-Liste');

    nodeAssert.equal(body.budget.savingsGoal, 500, 'Sparziel wird aus dem Budgetplan gelesen');

    // „Heute dran"-Karte: die Pro-Mitglied-Last kommt serverseitig aggregiert,
    // nicht aus dem 5er-Limit von urgentTasks.
    const memberLoad = body.memberTodayTasks.find((m) => m.user_id === owner);
    nodeAssert.ok(memberLoad, 'Pro-Mitglied-Zeile für den Owner vorhanden');
    nodeAssert.equal(memberLoad.open_count, 1, 'genau die eine offene, heute fällige Aufgabe zählt (Abgelegtes zählt nicht)');

    nodeAssert.equal(body.tasksDoneToday, 1, 'heute fällige erledigte Aufgabe wird gezählt');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    routeDb.prepare("DELETE FROM budget_plans WHERE category = '__savings__'").run();
    routeDb.prepare("DELETE FROM users WHERE username LIKE 'dashboard-widgets-%'").run();
  }
});

test('Dashboard-Endpoint: fehlender Auth-Kontext führt zu 500 (kritischer Fehlerpfad)', async () => {
  const { default: dashboardRouter } = await import('../server/routes/dashboard.js');

  const app = express();
  // Middleware setzt weder authUserId noch session → der Handler wirft beim Lesen von
  // req.session.userId und der äußere try/catch liefert die 500-Antwort.
  app.use((req, _res, next) => { next(); });
  app.use('/', dashboardRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
    nodeAssert.equal(response.status, 500);
    const body = await response.json();
    nodeAssert.equal(body.code, 500);
    nodeAssert.equal(body.error, 'Dashboard could not be loaded.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// --------------------------------------------------------
// Tests: Budget
// --------------------------------------------------------
test('Budget: Monatswerte für Einnahmen, Ausgaben, Saldo und Top-Ausgabe', () => {
  const from = `${currentMonth}-01`;
  const to = `${currentMonth}-31`;
  const totals = db.prepare(`
    SELECT
      SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
      SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expenses,
      SUM(amount) AS balance,
      COUNT(*) AS entry_count
    FROM budget_entries
    WHERE date BETWEEN ? AND ?
  `).get(from, to);

  const topExpense = db.prepare(`
    SELECT category, SUM(amount) AS amount
    FROM budget_entries
    WHERE amount < 0 AND date BETWEEN ? AND ?
    GROUP BY category
    ORDER BY ABS(SUM(amount)) DESC
    LIMIT 1
  `).get(from, to);

  assert(totals.income === 3000, `Einnahmen sollten 3000 sein, erhalten ${totals.income}`);
  assert(Math.abs(totals.expenses) === 1650, `Ausgaben sollten 1650 sein, erhalten ${totals.expenses}`);
  assert(totals.balance === 1350, `Saldo sollte 1350 sein, erhalten ${totals.balance}`);
  assert(totals.entry_count === 3, `Erwartet 3 Einträge, erhalten ${totals.entry_count}`);
  assert(topExpense.category === 'housing', 'Wohnen sollte Top-Ausgabenkategorie sein');
});

// --------------------------------------------------------
// Tests: getUpcomingEvents (geteilte Dashboard/Kalender-Logik)
// Regression für Issue #224: wiederkehrende Termine, deren Master-Start in
// der Vergangenheit liegt, müssen auf der Übersicht erscheinen.
// --------------------------------------------------------

// Eigene DB mit vollständigem Kalender-Schema (subscription_id, calendar_ref_id).
const cdb = new DatabaseSync(':memory:');
cdb.exec('PRAGMA foreign_keys = ON;');
cdb.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL, avatar_color TEXT NOT NULL DEFAULT '#007AFF',
    avatar_data TEXT
  );
  CREATE TABLE external_calendars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL DEFAULT 'google', external_id TEXT,
    name TEXT NOT NULL, color TEXT
  );
  -- color gehoert dazu: sie ist die GEERBTE Farbe eines Abos und wird seit #891
  -- als cal_color mitgelesen, weil ein Abo-Termin keinen external_calendars-
  -- Eintrag hat. Fehlt sie hier, misst dieses verkuerzte Schema an der echten
  -- Abfrage vorbei. Dasselbe gilt fuer source/external_id und die beiden
  -- target_*-Spalten unten: SOURCE_CALENDAR_JOIN loest darueber die Quelle
  -- eines noch nicht hochgeladenen Termins auf (#1064).
  CREATE TABLE ics_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, color TEXT, shared INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, description TEXT,
    start_datetime TEXT NOT NULL, end_datetime TEXT,
    all_day INTEGER NOT NULL DEFAULT 0, location TEXT,
    color TEXT NOT NULL DEFAULT '#007AFF', icon TEXT NOT NULL DEFAULT 'calendar',
    assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
    external_source TEXT NOT NULL DEFAULT 'local',
    recurrence_rule TEXT,
    subscription_id INTEGER REFERENCES ics_subscriptions(id) ON DELETE CASCADE,
    calendar_ref_id INTEGER REFERENCES external_calendars(id) ON DELETE SET NULL,
    target_google_calendar_id TEXT, target_caldav_calendar_url TEXT, outbound_move_to TEXT,
    visibility TEXT NOT NULL DEFAULT 'all',
    recurrence_parent_id INTEGER REFERENCES calendar_events(id) ON DELETE CASCADE,
    recurrence_id TEXT,
    overridden_fields TEXT,
    attachment_data TEXT
  );
  CREATE TABLE event_assignments (
    event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (event_id, user_id)
  );
  CREATE TABLE calendar_event_exceptions (
    event_id       INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
    exception_date TEXT    NOT NULL,
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (event_id, exception_date)
  );
  -- Für den LEFT JOIN in getUpcomingEvents (Geburtstags-Lokalisierung, Issue #524).
  CREATE TABLE birthdays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, birth_date TEXT NOT NULL,
    calendar_event_id INTEGER REFERENCES calendar_events(id) ON DELETE SET NULL,
    name_day TEXT,
    name_day_calendar_event_id INTEGER REFERENCES calendar_events(id) ON DELETE SET NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE CASCADE
  );
`);

cdb.exec(`
  ALTER TABLE calendar_events ADD COLUMN target_caldav_account_id INTEGER;
  CREATE TABLE housekeeping_work_sessions (id INTEGER PRIMARY KEY, calendar_event_id INTEGER);
`);
cdb.exec(MIGRATIONS_SQL[245]);
// Migration 246 (#1935) hat ein Funktions-up und steht nicht im Spiegel.
cdb.exec('ALTER TABLE calendar_events ADD COLUMN series_authored INTEGER NOT NULL DEFAULT 0 CHECK(series_authored IN (0, 1));');

const cu1 = cdb.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color)
  VALUES ('theodore', 'Theodore', 'x', '#34C759')`).run();
const cu2 = cdb.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color)
  VALUES ('sofia', 'Sofia', 'x', '#AF52DE')`).run();
const cuTheo = cu1.lastInsertRowid;
const cuSofia = cu2.lastInsertRowid;

function insertEvent(fields) {
  const cols = Object.keys(fields);
  const placeholders = cols.map(() => '?').join(', ');
  const r = cdb.prepare(`INSERT INTO calendar_events (${cols.join(', ')}) VALUES (${placeholders})`)
    .run(...cols.map((c) => fields[c]));
  return r.lastInsertRowid;
}

const isoIn = (ms) => new Date(Date.now() + ms).toISOString().slice(0, 19);
const HOUR = 3600000;
const DAY = 24 * HOUR;
// Kalendertag in der LOKALEN Zone, als YYYY-MM-DD.
//
// Diese Datei prueft ab Zeile ~1950 selbst, dass die Dashboard-ROUTE ihren
// Kalendertag nicht aus `toISOString()` zieht - und benutzte fuer ihre eigenen
// Testdaten genau dieses Muster. `getUpcomingEvents` vergleicht gegen den
// lokalen Tag, `insertEvent` speichert Wanduhrzeit ohne Zone: ein aus UTC
// gebildetes Datum liegt oestlich von UTC zwischen lokaler und UTC-Mitternacht
// einen Tag zu frueh. Zwischen 00:00 und 02:00 MESZ fielen drei Tests um und
// rissen die gesamte npm-test-Kette mit, waehrend die CI in UTC laeuft und
// davon nie etwas sah. Das ist die Falle aus CLAUDE.md, nur spiegelverkehrt:
// dort kippt der Tag westlich von UTC, hier oestlich.
const localDateKey = (date = new Date()) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

// Tagesbeginn heute: immer "heute" und nie in der Zukunft, anders als now-Nh.
const todayStartIso = () => `${localDateKey()}T00:00:00`;

// Wiederkehrender Wochentermin, dessen Master-Start 14 Tage in der Vergangenheit liegt.
// Die nächste Instanz liegt in 7 Tagen relativ zum Master, also innerhalb des Fensters.
const recurStart = isoIn(-14 * DAY + 5 * HOUR);
const recurId = insertEvent({
  title: "Sofia Field Trip",
  start_datetime: recurStart,
  recurrence_rule: 'FREQ=WEEKLY;INTERVAL=1',
  created_by: cuSofia,
  assigned_to: cuSofia,
});

// Nicht-wiederkehrender Termin in der Vergangenheit -> darf NICHT erscheinen.
insertEvent({ title: 'Past one-off', start_datetime: isoIn(-2 * DAY), created_by: cuTheo });

// Termin von heute Morgen (Vergangenheit, aber noch heute) -> bei fromToday erscheinen.
insertEvent({ title: 'Morning Meeting Today', start_datetime: todayStartIso(), created_by: cuTheo });

// Nicht-wiederkehrender Termin in der Zukunft -> erscheint.
// Beiden Nutzern (Theo + Sofia) zugewiesen – für Issue #284 (assigned_users im Dashboard).
const soccerId = insertEvent({ title: 'Theodore Soccer Game', start_datetime: isoIn(3 * DAY), created_by: cuTheo });
cdb.prepare(`INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)`).run(soccerId, cuTheo);
cdb.prepare(`INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)`).run(soccerId, cuSofia);

test('upcoming expansion stops after eligible occurrences, without counting EXDATE or expired slots', () => {
  const events = expandRecurringEvents([{
    id: 1, start_datetime: '2090-01-01T09:00:00Z', recurrence_rule: 'FREQ=DAILY',
  }], '2090-01-01', '9999-12-31', new Map([[1, new Set(['2090-01-03'])]]), {
    maxOccurrencesPerSeries: 2,
    occurrenceFilter: (event) => event.start_datetime >= '2090-01-02T12:00:00Z',
  });
  nodeAssert.deepEqual(events.map((event) => event.start_datetime), [
    '2090-01-04T09:00:00Z', '2090-01-05T09:00:00Z',
  ]);
});

test('getUpcomingEvents reaches an old daily series and fills the limit after expired slots', () => {
  cdb.exec('SAVEPOINT old_upcoming');
  try {
    const id = insertEvent({
      title: 'Old daily series', start_datetime: '2080-01-01T09:00:00Z',
      recurrence_rule: 'FREQ=DAILY', created_by: cuTheo,
    });
    cdb.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, cuTheo);
    cdb.prepare('INSERT INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)')
      .run(id, '2090-01-02');
    const events = getUpcomingEvents(cdb, {
      userId: cuTheo, assignedTo: cuTheo, limit: 2, windowDays: null,
      now: new Date('2090-01-01T12:00:00Z'),
    });
    nodeAssert.deepEqual(events.map((event) => event.start_datetime), [
      '2090-01-03T09:00:00Z', '2090-01-04T09:00:00Z',
    ]);
  } finally {
    cdb.exec('ROLLBACK TO old_upcoming; RELEASE old_upcoming');
  }
});

test('getUpcomingEvents limits by effective instant after merging moved occurrences and filters', () => {
  cdb.exec('SAVEPOINT limited_upcoming');
  try {
    const series = insertEvent({
      title: 'Late UTC series', start_datetime: '2090-01-01T11:00:00Z',
      recurrence_rule: 'FREQ=DAILY', created_by: cuTheo,
    });
    const moved = insertEvent({
      title: 'Moved earlier', start_datetime: '2090-01-01T12:00:00+02:00',
      recurrence_parent_id: series, recurrence_id: '2090-01-03',
      overridden_fields: '["title","start_datetime"]', created_by: cuTheo,
    });
    cdb.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(series, cuTheo);
    const birthday = insertEvent({
      title: 'Birthday before everything', start_datetime: '2090-01-01T08:00:00Z',
      recurrence_rule: 'FREQ=YEARLY', created_by: cuTheo,
    });
    cdb.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(birthday, cuTheo);
    cdb.prepare('INSERT INTO birthdays (name, birth_date, calendar_event_id) VALUES (?, ?, ?)')
      .run('Birthday fixture', '2000-01-01', birthday);
    insertEvent({
      title: 'Unassigned before everything', start_datetime: '2090-01-01T07:00:00Z',
      recurrence_rule: 'FREQ=DAILY', created_by: cuTheo,
    });
    const events = getUpcomingEvents(cdb, {
      userId: cuTheo, assignedTo: cuTheo, includeBirthdays: false,
      limit: 2, now: new Date('2090-01-01T06:00:00Z'),
    });
    nodeAssert.deepEqual(events.map((event) => Number(event.id)), [Number(moved), Number(series)]);
  } finally {
    cdb.exec('ROLLBACK TO limited_upcoming; RELEASE limited_upcoming');
  }
});

test('getUpcomingEvents: wiederkehrender Termin mit Vergangenheits-Start erscheint (Issue #224)', () => {
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 10 });
  const sofia = events.find((e) => e.title === 'Sofia Field Trip');
  assert(sofia, 'Wiederkehrender "Sofia Field Trip" muss in den anstehenden Terminen erscheinen');
  assert(sofia.start_datetime >= new Date().toISOString(), 'Die expandierte Instanz liegt in der Zukunft');
  assert(sofia.id === recurId, 'Behält die Original-Event-ID der Serie');
});

test('getUpcomingEvents: vergangene Einzeltermine erscheinen nicht', () => {
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 10 });
  assert(!events.find((e) => e.title === 'Past one-off'), 'Vergangener Einzeltermin darf nicht erscheinen');
  assert(!events.find((e) => e.title === 'Morning Meeting Today'), 'Vergangener Heute-Termin ohne fromToday nicht erscheinen');
});

test('getUpcomingEvents: fromToday=true zeigt heutige vergangene Termine (Issue #230)', () => {
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 10, fromToday: true });
  assert(events.find((e) => e.title === 'Morning Meeting Today'),
    'Heute-Morgen-Termin muss mit fromToday=true erscheinen');
  assert(!events.find((e) => e.title === 'Past one-off'),
    'Termin von gestern darf auch mit fromToday nicht erscheinen');
});

/* #1449: DAS FUENFER-LIMIT ZAEHLT NUR, WAS NOCH KOMMT. Gemessen im Issue: um
 * 19:28 lieferte die Abfrage fuenf laengst vorbeie Termine und liess den um
 * 21:00 fallen. Beendete Termine von heute kommen weiter mit (die Kachel zeigt
 * sie zurueckgetreten), aber AUSSERHALB des Deckels. Wanduhrzeit ohne Zone plus
 * ein `now` aus derselben lokalen Uhr: die Haushaltszone faellt hier auf die
 * Serverzone zurueck (keine sync_config), beide Seiten lesen also dieselbe. */
test('getUpcomingEvents: das Limit zaehlt nur Kommendes, Beendetes von heute kommt ausserhalb mit (#1449)', () => {
  cdb.exec('SAVEPOINT ended_today');
  try {
    // EIN TAG OHNE FIXTURE-TERMINE: die Wochenserie "Sofia Field Trip" beginnt
    // relativ zur echten Uhr und traf so jede Woche einen Tag lang genau diesen
    // Tag (samt Vortag, windowDays 1) - der Test war dann rot, ohne dass sich
    // am Code etwas geaendert hatte. Gesucht wird ab 2091-03-10 der erste Tag,
    // an dem ohne die eigenen Termine nichts ansteht.
    const eveningOf = (key) => {
      const [y, m, d] = key.split('-').map(Number);
      return new Date(y, m - 1, d, 19, 28);
    };
    const nothingDue = (key) => getUpcomingEvents(cdb, {
      userId: cuTheo, limit: 20, fromToday: true, windowDays: 1, now: eveningOf(key), keepEndedToday: 20,
    }).length === 0;
    let day = '2091-03-10';
    for (let tries = 0; !nothingDue(day); tries++) {
      nodeAssert.ok(tries < 14, 'in zwei Wochen ab 2091-03-10 muss ein Tag ohne Fixture-Termine liegen');
      const next = eveningOf(day);
      next.setDate(next.getDate() + 1);
      day = localDateKey(next);
    }
    const ended = ['06:00', '07:00', '08:00', '09:00', '10:00'].map((time, index) => insertEvent({
      title: `Vorbei ${index + 1}`, start_datetime: `${day}T${time}:00`,
      end_datetime: `${day}T${time.slice(0, 2)}:30:00`, created_by: cuTheo,
    }));
    const running = insertEvent({
      title: 'Laeuft noch', start_datetime: `${day}T19:00:00`, end_datetime: `${day}T20:00:00`, created_by: cuTheo,
    });
    const evening = insertEvent({ title: 'Abendtermin', start_datetime: `${day}T21:00:00`, created_by: cuTheo });
    const allDay = insertEvent({ title: 'Ganztags', start_datetime: day, all_day: 1, created_by: cuTheo });
    const now = eveningOf(day);

    const plain = getUpcomingEvents(cdb, { userId: cuTheo, limit: 5, fromToday: true, windowDays: 1, now });
    nodeAssert.ok(!plain.some((e) => Number(e.id) === Number(evening)),
      'Vorbedingung: ohne die Option verdraengen die beendeten Termine den Abendtermin');

    const events = getUpcomingEvents(cdb, {
      userId: cuTheo, limit: 2, fromToday: true, windowDays: 1, now, keepEndedToday: 20,
    });
    const ids = events.map((e) => Number(e.id));
    for (const id of ended) nodeAssert.ok(ids.includes(Number(id)), 'beendete Termine von heute bleiben dabei');
    // Der Deckel von 2 gilt dem, was noch kommt: der laufende Termin zaehlt
    // als kommend, der ganztaegige endet nie am eigenen Tag - beide passen,
    // der Abendtermin ist der dritte und faellt heraus.
    nodeAssert.ok(ids.includes(Number(running)), 'ein laufender Termin zaehlt als kommend');
    nodeAssert.ok(ids.includes(Number(allDay)), 'ein Ganztagstermin endet nicht an seinem eigenen Tag');
    nodeAssert.equal(events.length, ended.length + 2, 'das Limit zaehlt nur die zwei kommenden');
    nodeAssert.ok(!ids.includes(Number(evening)), 'der dritte kommende faellt unter den Deckel');

    const five = getUpcomingEvents(cdb, {
      userId: cuTheo, limit: 5, fromToday: true, windowDays: 1, now, keepEndedToday: 20,
    });
    nodeAssert.ok(five.some((e) => Number(e.id) === Number(evening)),
      'mit Fuenfer-Deckel steht der Abendtermin wieder drin (Abnahme aus #1449)');
  } finally {
    cdb.exec('ROLLBACK TO ended_today; RELEASE ended_today');
  }
});

test('getUpcomingEvents: zukünftige Termine sortiert und auf limit begrenzt', () => {
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 10 });
  assert(events.find((e) => e.title === 'Theodore Soccer Game'), 'Zukünftiger Einzeltermin erscheint');
  for (let i = 1; i < events.length; i++) {
    assert(events[i - 1].start_datetime <= events[i].start_datetime, 'Aufsteigend nach Startzeit sortiert');
  }
  const limited = getUpcomingEvents(cdb, { userId: cuTheo, limit: 1 });
  assert(limited.length === 1, `limit=1 liefert genau 1 Event, erhalten ${limited.length}`);
});

test('getUpcomingEvents: assigned_users_json enthält avatar_data (Issue #284)', () => {
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 10 });
  const soccer = events.find((e) => e.title === 'Theodore Soccer Game');
  assert(soccer, 'Theodore Soccer Game muss erscheinen');
  assert('assigned_users_json' in soccer, 'assigned_users_json muss im rohen Event enthalten sein');
  const users = JSON.parse(soccer.assigned_users_json);
  assert(Array.isArray(users) && users.length === 2,
    `Erwartet 2 zugewiesene User, erhalten ${users.length}`);
  assert(users.every((u) => 'avatar_data' in u),
    'Jeder User im assigned_users_json muss avatar_data enthalten');
  const theo  = users.find((u) => u.display_name === 'Theodore');
  const sofia = users.find((u) => u.display_name === 'Sofia');
  assert(theo,  'Theodore muss in assigned_users sein');
  assert(sofia, 'Sofia muss in assigned_users sein');
});

test('getUpcomingEvents: Event ohne Assignments hat leeres assigned_users_json Array (Issue #284)', () => {
  // Morning Meeting Today wurde ohne event_assignments eingefügt.
  const mornEvents = getUpcomingEvents(cdb, { userId: cuTheo, limit: 10, fromToday: true });
  const mm = mornEvents.find((e) => e.title === 'Morning Meeting Today');
  assert(mm, 'Morning Meeting Today mit fromToday=true vorhanden');
  const users = JSON.parse(mm.assigned_users_json ?? '[]');
  assert(Array.isArray(users) && users.length === 0,
    'Event ohne Zuweisung hat leeres assigned_users_json Array');
});

test('getUpcomingEvents resolves a moved linked occurrence with inherited projections and owners', () => {
  const dateKey = (days) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return localDateKey(date);
  };
  const originalDate = dateKey(4);
  const movedDate = dateKey(7);
  const masterId = Number(insertEvent({
    title: 'Upcoming master',
    description: 'Current upcoming description',
    start_datetime: `${originalDate}T09:00:00`,
    end_datetime: `${originalDate}T10:00:00`,
    recurrence_rule: 'FREQ=DAILY;COUNT=4',
    assigned_to: cuTheo,
    created_by: cuTheo,
  }));
  cdb.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)')
    .run(masterId, cuTheo);
  const childId = Number(insertEvent({
    title: 'Upcoming linked override',
    description: 'Stale upcoming description',
    start_datetime: `${movedDate}T11:00:00`,
    end_datetime: `${movedDate}T12:00:00`,
    assigned_to: cuSofia,
    created_by: cuTheo,
    visibility: 'assignees',
    recurrence_parent_id: masterId,
    recurrence_id: originalDate,
    overridden_fields: '["title","start_datetime","end_datetime","assignments","visibility","attachment","reminders"]',
  }));
  cdb.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)')
    .run(childId, cuSofia);
  cdb.prepare(`
    INSERT INTO calendar_event_exceptions (event_id, exception_date)
    VALUES (?, ?)
  `).run(masterId, originalDate);

  const events = getUpcomingEvents(cdb, {
    userId: cuSofia,
    limit: 20,
    fromToday: true,
  });
  const linked = events.find((event) => Number(event.id) === childId);

  assert(linked, 'the moved linked occurrence must be loaded by displayed date');
  assert(linked.description === 'Current upcoming description', 'unmarked description must inherit');
  assert(linked.start_datetime === `${movedDate}T11:00:00`, 'moved start must stay resolved');
  assert(linked.series_id === masterId, 'series identity must point to the master');
  assert(linked.recurrence_id === originalDate, 'recurrence identity must stay on the original slot');
  assert(linked.assignment_owner_id === childId, 'assignment owner must stay on the child');
  assert(linked.attachment_owner_id === childId, 'attachment owner must stay on the child');
  assert(linked.reminder_owner_id === childId, 'reminder owner must stay on the child');
  assert(!events.some((event) => Number(event.id) === masterId
    && event.recurrence_identity === originalDate), 'the original EXDATE slot must stay suppressed');
});

test('getUpcomingEvents liest keine großen attachment_data-Bodies', () => {
  const eventId = insertEvent({
    title: 'Upcoming large attachment',
    start_datetime: isoIn(5 * DAY),
    created_by: cuTheo,
    attachment_data: 'A'.repeat(1024 * 1024),
  });
  const originalPrepare = cdb.prepare.bind(cdb);
  const statements = [];
  cdb.prepare = (sql) => {
    statements.push(String(sql));
    return originalPrepare(sql);
  };
  let events;
  try {
    events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 100 });
  } finally {
    delete cdb.prepare;
  }

  assert(events.some((event) => Number(event.id) === Number(eventId)), 'Termin fehlt');
  const calendarReads = statements.filter((sql) => /\b(?:FROM|JOIN)\s+calendar_events\b/i.test(sql));
  assert(calendarReads.length > 0, 'keine Kalenderabfrage aufgezeichnet');
  assert(calendarReads.every((sql) => !/\be\.\*|\battachment_data\b/i.test(sql)),
    `Attachment-Body in kompakter Kalenderabfrage: ${calendarReads.join('\n---\n')}`);
});

test('getUpcomingEvents: private ICS-Termine fremder User werden ausgeblendet', () => {
  const sub = cdb.prepare(`INSERT INTO ics_subscriptions (name, shared, created_by) VALUES ('Privat', 0, ?)`)
    .run(cuSofia).lastInsertRowid;
  insertEvent({
    title: 'Sofias privater ICS-Termin',
    start_datetime: isoIn(2 * DAY),
    external_source: 'ics',
    subscription_id: sub,
    created_by: cuSofia,
  });
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 20 });
  assert(!events.find((e) => e.title === 'Sofias privater ICS-Termin'),
    'Privates ICS-Abo eines anderen Users darf nicht erscheinen');
  const ownerEvents = getUpcomingEvents(cdb, { userId: cuSofia, limit: 20 });
  assert(ownerEvents.find((e) => e.title === 'Sofias privater ICS-Termin'),
    'Eigentümer sieht seinen privaten ICS-Termin');
});

// --------------------------------------------------------
// Bug #360: Geburtstag mit reminder_offset='' darf nicht als Kalender-Event existieren
// --------------------------------------------------------
{
  const bdb = new DatabaseSync(':memory:');
  bdb.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL, avatar_color TEXT NOT NULL DEFAULT '#007AFF',
      avatar_data TEXT
    );
    CREATE TABLE calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, description TEXT,
      start_datetime TEXT NOT NULL, end_datetime TEXT,
      all_day INTEGER NOT NULL DEFAULT 0, location TEXT,
      color TEXT NOT NULL DEFAULT '#007AFF', icon TEXT NOT NULL DEFAULT 'calendar',
      assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
      external_source TEXT NOT NULL DEFAULT 'local',
      recurrence_rule TEXT,
      subscription_id INTEGER,
      calendar_ref_id INTEGER,
      visibility TEXT NOT NULL DEFAULT 'all',
      -- Migration 246 (#1935): das Anlegen eines Geburtstagstermins setzt die Marke.
      series_authored INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE birthdays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, birth_date TEXT NOT NULL, notes TEXT,
      photo_data TEXT, created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
      calendar_event_id INTEGER REFERENCES calendar_events(id) ON DELETE SET NULL,
      name_day TEXT,
      name_day_calendar_event_id INTEGER REFERENCES calendar_events(id) ON DELETE SET NULL,
      reminder_offset TEXT, reminder_custom_amount TEXT, reminder_custom_unit TEXT,
      updated_at TEXT
    );
    CREATE TABLE event_assignments (
      event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (event_id, user_id)
    );
    CREATE TABLE ics_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, color TEXT, shared INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL,
      remind_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
  `);
  const bUserId = bdb.prepare(
    `INSERT INTO users (username, display_name, password_hash, avatar_color) VALUES ('bert', 'Bert', 'x', '#ff0')`
  ).run().lastInsertRowid;

  test('syncBirthdayArtifacts: reminder_offset="" → kein calendar_event_id (Issue #360)', () => {
    const bdId = bdb.prepare(
      `INSERT INTO birthdays (name, birth_date, created_by, reminder_offset) VALUES ('Max', '1990-05-10', ?, '')`
    ).run(bUserId).lastInsertRowid;
    const bd = bdb.prepare('SELECT * FROM birthdays WHERE id = ?').get(bdId);
    syncBirthdayArtifacts(bdb, bd);
    const updated = bdb.prepare('SELECT calendar_event_id FROM birthdays WHERE id = ?').get(bdId);
    assert(updated.calendar_event_id === null, 'Geburtstag ohne Benachrichtigung darf kein Kalender-Event haben');
    const evCount = bdb.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n;
    assert(evCount === 0, 'Keine Kalender-Events in der DB erwartet');
  });

  test('syncBirthdayArtifacts: vorhandenes Event wird bei reminder_offset="" gelöscht (Issue #360)', () => {
    const evId = bdb.prepare(
      `INSERT INTO calendar_events (title, start_datetime, all_day, created_by) VALUES ('Geburtstag Hans', '1985-03-15', 1, ?)`
    ).run(bUserId).lastInsertRowid;
    const bdId = bdb.prepare(
      `INSERT INTO birthdays (name, birth_date, created_by, calendar_event_id, reminder_offset) VALUES ('Hans', '1985-03-15', ?, ?, '')`
    ).run(bUserId, evId).lastInsertRowid;
    const bd = bdb.prepare('SELECT * FROM birthdays WHERE id = ?').get(bdId);
    syncBirthdayArtifacts(bdb, bd);
    const ev = bdb.prepare('SELECT * FROM calendar_events WHERE id = ?').get(evId);
    assert(!ev, 'Vorhandenes Kalender-Event muss gelöscht worden sein');
    const updated = bdb.prepare('SELECT calendar_event_id FROM birthdays WHERE id = ?').get(bdId);
    assert(updated.calendar_event_id === null, 'calendar_event_id in birthdays muss NULL sein');
  });

  test('syncBirthdayArtifacts: reminder_offset gesetzt → Kalender-Event wird angelegt (Issue #360)', () => {
    const bdId = bdb.prepare(
      `INSERT INTO birthdays (name, birth_date, created_by, reminder_offset) VALUES ('Lisa', '1992-07-20', ?, '1440')`
    ).run(bUserId).lastInsertRowid;
    const bd = bdb.prepare('SELECT * FROM birthdays WHERE id = ?').get(bdId);
    syncBirthdayArtifacts(bdb, bd);
    const updated = bdb.prepare('SELECT calendar_event_id FROM birthdays WHERE id = ?').get(bdId);
    assert(updated.calendar_event_id !== null, 'Geburtstag mit Erinnerung muss ein Kalender-Event haben');
    const ev = bdb.prepare('SELECT * FROM calendar_events WHERE id = ?').get(updated.calendar_event_id);
    assert(ev, 'Kalender-Event muss existieren');
    assert(ev.all_day === 1, 'Geburtstags-Event muss ganztägig sein');
  });
}

// --------------------------------------------------------
// Bug-Fixes: ganztägige Termine + Geburtstags-Filterung
// --------------------------------------------------------
test('getUpcomingEvents: ganztägiger Termin heute erscheint mit fromToday=true (Issue #360)', () => {
  const todayDate = localDateKey();
  insertEvent({
    title: 'Ganztägiger Termin heute',
    start_datetime: todayDate, // kein T-Teil – genau das war das Problem
    all_day: 1,
    created_by: cuTheo,
  });
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 20, fromToday: true });
  assert(events.find((e) => e.title === 'Ganztägiger Termin heute'),
    'Heutiger ganztägiger Termin muss im Dashboard erscheinen (start_datetime ohne Zeit-Teil)');
});

test('getUpcomingEvents: ganztägiger Termin in der Zukunft erscheint (Issue #360)', () => {
  const futureDate = localDateKey(new Date(Date.now() + 3 * DAY));
  insertEvent({
    title: 'Ganztägiger Zukunfts-Termin',
    start_datetime: futureDate,
    all_day: 1,
    created_by: cuTheo,
  });
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 20, fromToday: true });
  assert(events.find((e) => e.title === 'Ganztägiger Zukunfts-Termin'),
    'Zukünftiger ganztägiger Termin muss im Dashboard erscheinen');
});

// --------------------------------------------------------
// Tests: maybeUpdateAutoLocation (Per-User-Wetter-Standort)
// --------------------------------------------------------
test('maybeUpdateAutoLocation writes weather_user and ignores role', async () => {
  const { maybeUpdateAutoLocation } = await import('../public/pages/dashboard.js');
  const calls = [];
  const geolocation = {
    getCurrentPosition: (resolve) => resolve({ coords: { latitude: 52.5200, longitude: 13.4100 } }),
  };
  const ok = await maybeUpdateAutoLocation({
    autoLocateEnabled: true,
    geolocation,
    putPreferences: (body) => { calls.push(body); return Promise.resolve(); },
  });
  nodeAssert.equal(ok, true);
  nodeAssert.equal(calls.length, 1);
  nodeAssert.deepEqual(calls[0], { weather_user: { lat: '52.5200', lon: '13.4100', city: null } });
});

test('maybeUpdateAutoLocation skips when disabled', async () => {
  const { maybeUpdateAutoLocation } = await import('../public/pages/dashboard.js');
  const ok = await maybeUpdateAutoLocation({
    autoLocateEnabled: false,
    geolocation: { getCurrentPosition: () => { throw new Error('should not be called'); } },
    putPreferences: () => { throw new Error('should not be called'); },
  });
  nodeAssert.equal(ok, false);
});

// --------------------------------------------------------
// Wand-Modus (Block D)
// --------------------------------------------------------

/** Programmzeilen für einen vollen Tag: N fällige Aufgaben mit Uhrzeit. */
function wallTasks(count, { assignTo = null, from = 8 } = {}) {
  const todayStr = toLocalDateKey(new Date());
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    title: `Aufgabe ${i + 1}`,
    due_date: todayStr,
    due_time: `${String(from + i).padStart(2, '0')}:00`,
    status: 'open',
    assigned_users: assignTo?.(i) ? [assignTo(i)] : [],
  }));
}

/** Der Wand-Modus rendert ohne DOM; `window.yuvomi` fragt er nur nach Modulen. */
async function withWallWindow(fn) {
  const prevWindow = global.window;
  global.window = { yuvomi: null };
  try {
    return await fn();
  } finally {
    global.window = prevWindow;
  }
}

test('Wand-Modus: die Zeilen der Dziś-Karte sind reine Anzeige - kein Link, und ohne den Schalter kein Knopf', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  await withWallWindow(() => {
    // TAFLA: die Wand liest den Tagesplan (planTasks), standardmaessig ohne
    // Ringe - „Pozwól odhaczać na ścianie" ist aus.
    // Mittags: nachts zeigt die Wand nur die Uhr (Szene Noc).
    const html = __test.renderWallSurface({ planTasks: wallTasks(3), users: [] }, null, { now: todayAt(12) });
    const list = html.slice(html.indexOf('wall-plan__list'), html.indexOf('</ul>'));
    // Reichweite zuerst: ein Selektor, der nichts findet, meldet sonst
    // fehlerfrei „keine Verstöße".
    const rows = list.match(/data-wall-row>/g) ?? [];
    nodeAssert.equal(rows.length, 3, 'drei Zeilen gelesen');
    nodeAssert.ok(!/<a\b|href=|data-route=|<button/.test(list),
      'eine Zeile der Wand navigiert nicht und hakt ohne den Schalter nichts ab');
    nodeAssert.match(html, /id="wall-exit"/, 'der Ausstieg ist da');
    const ticking = __test.renderWallSurface({ planTasks: wallTasks(3), users: [] }, null, { mayWrite: true, now: todayAt(12) });
    nodeAssert.equal((ticking.match(/data-wall-tick=/g) ?? []).length, 3, 'mit dem Schalter traegt jede Aufgabe ihren Ring');
  });
});
test('Wand-Modus: der Ausstieg steht in JEDEM Zustand im DOM', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  await withWallWindow(() => {
    const states = {
      laden:  __test.renderWallSurface(null, null, { loading: true }),
      fehler: __test.renderWallSurface(null, null, { failed: true }),
      normal: __test.renderWallSurface({ urgentTasks: wallTasks(1), users: [] }, null, {}),
      leer:   __test.renderWallSurface({ urgentTasks: [], upcomingEvents: [], users: [] }, null, {}),
    };
    const ohne = Object.entries(states).filter(([, html]) => !/id="wall-exit"/.test(html)).map(([k]) => k);
    nodeAssert.equal(Object.keys(states).length, 4, 'vier Zustände geprüft');
    nodeAssert.deepEqual(ohne, [], 'ein unsichtbarer Ausstieg wäre eine Falle');
  });
});

test('Wand-Modus: Einstieg und Ausstieg sind Gegenstücke auf derselben Seite (#915)', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  await withWallWindow(() => {
    // Der Modus wurde nur unter Einstellungen -> Persönlich -> Darstellung
    // eingeschaltet und hier verlassen: man ging dort hinaus, wo man nicht
    // hineinkam. Geprüft wird deshalb das PAAR, nicht der neue Knopf allein -
    // verschwindet eine der beiden Hälften, ist die Einbahnstraße zurück.
    //
    // TAFLA (2026-10-19): der Einstieg stand in „Dostosuj Dziś".
    // 2026-10-27, v2: Dziś hat kein Anpassen mehr; der Einstieg steht in
    // „Więcej" (Tablet w kuchni) und fuehrt auf `/` - auf die Seite, die die
    // Wand wieder verlaesst. Das Paar bleibt die Zusage.
    const more = readFileSync(new URL('../public/pages/more.js', import.meta.url), 'utf8');
    nodeAssert.match(more, /data-more-action="wall"/, 'Więcej traegt den Einstieg');
    nodeAssert.match(more, /if \(action === 'wall'\) \{\s*enterWallMode\(\);\s*window\.yuvomi\?\.navigate\?\.\('\/'\);/,
      'und fuehrt auf die Uebersicht');
    const wand = __test.renderWallSurface({ urgentTasks: wallTasks(1), users: [] }, null, {});
    nodeAssert.match(wand, /id="wall-exit"/, 'die Wand trägt den Ausstieg');
  });
});

test('Wand-Modus: der Fehlerzustand trägt keinen Retry-Knopf, aber die Uhr', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  await withWallWindow(() => {
    const html = __test.renderWallSurface(null, null, { failed: true });
    nodeAssert.match(html, /wall__error-title/, 'der Fehler spricht als eigener Zustand');
    // Am Wandtablet drückt niemand „erneut versuchen" - geheilt wird von selbst.
    nodeAssert.ok(!/dashboard-retry|widget-retry/.test(html), 'kein Retry-Knopf auf zwei Metern');
    nodeAssert.match(html, /class="wall__clock/, 'die Uhr bleibt: sie braucht kein Netz');
    nodeAssert.match(html, /data-wall-timer-start/, 'und der Minutnik auch');
  });
});
/* SPERRZONEN FUER MELDUNGEN (#1917). Der Hinweis beim Einschalten lag bis rund
 * 834px Breite acht Sekunden auf der Uhr. Die Toast-Lage weicht jetzt allem,
 * was ihr Attribut traegt - hier steht, DASS die Wand es setzt: an den beiden
 * Zeilen der Uhr (nicht an ihrem Rahmen, der so breit ist wie die Flaeche) und
 * am Fuss. Der Name kommt aus dem Modul, das ihn liest, nicht aus dem Test. */
test('Wand-Modus: Uhrzeit, Datum und Fuss sind Sperrzonen der Toast-Lage (#1917)', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const { KEEPOUT_SELECTOR } = await import('../public/utils/toast-placement.js');
  const attr = KEEPOUT_SELECTOR.replace(/^\[|\]$/g, '');
  nodeAssert.match(attr, /^data-[\w-]+$/, 'Reichweite: die Lage liest ein Attribut');
  await withWallWindow(() => {
    for (const options of [{}, { failed: true }, { loading: true }]) {
      const html = __test.renderWallSurface({ urgentTasks: wallTasks(1), users: [] }, null, options);
      const marked = [...html.matchAll(/<(\w+)\b[^>]*>/g)].map((m) => m[0])
        .filter((tag) => new RegExp(`\\s${attr}(?=[\\s>])`).test(tag))
        .map((tag) => tag.match(/class="([^"]+)"/)?.[1] ?? '');
      // TAFLA: die Uhr, die Textspalte des Kopfs (Datum und Teraz-Zeile) und
      // das Dock - der Rahmen des Kopfs nicht, er ist so breit wie die Flaeche.
      nodeAssert.deepEqual(marked.sort(), ['wall__clock u-rounded', 'wall__dock', 'wall__head-text'],
        `in jedem Zustand der Wand (${JSON.stringify(options)})`);
    }
    // TAFLA (2026-10-24): hier stand die Gegenprobe an der Uhr-KACHEL des
    // Rasters (keine Sperrzone mitten im Inhalt). Raster und Kachel-Uhr sind
    // gegangen; die Uhr steht nur noch an der Wand.
  });
});

/* EIN LAUFENDER TIMER NIMMT EINE ZEILE (Integration 2026-09-23, Browser-Abnahme
 * bei 1280x800). Der Deckel von vier Zeilen ist fuer eine Flaeche OHNE die
 * Timer-Anzeige gerechnet; die Anzeige kostet 64px plus Abstand, und an einem
 * vollen Tag schob sie Fuss samt „Timer abbrechen" und Ausstieg auf 808-856px -
 * unter den Bildrand einer Flaeche, die nicht scrollt. Solange der Timer steht,
 * zeigt das Programm eine Zeile weniger, und „+N weitere" zaehlt sie mit. */
// TAFLA (2026-10-19): hier stand „ein laufender Timer nimmt dem Programm eine Zeile" (WALL_ROW_CAP - 1). Die Tafla-Wand (Artboard „Ściana") hat keinen Zeilendeckel mehr: der laufende Minutnik
// nimmt den Platz der Uhr, und die Dziś-Karte passt sich ihrer Hoehe an
// (planWallRows/fitWallLists, test:wall-tafla).
// TAFLA (2026-10-19): hier stand „der Deckel greift, und der Überlauf sagt die Wahrheit". Die Tafla-Wand (Artboard „Ściana") zeigt, was in die Hoehe der Karte passt; der Rest ist
// „+N więcej" aus derselben Zahl (planWallRows, test:wall-tafla).
// TAFLA (2026-10-19): hier stand „Wer heute dran ist zählt den ganzen Tag". Die Tafla-Wand (Artboard „Ściana") hat den Abschnitt nicht mehr - die Scheibe an jeder Zeile
// sagt, wer dran ist (test:wall-tasks, Abschnitt 2-5).
test('Wand-Modus: leerer Tag spricht, statt zu verschwinden', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  await withWallWindow(() => {
    const html = __test.renderWallSurface({ planTasks: [], planEvents: [], users: [] }, null, { now: todayAt(12) });
    // Eine leere Fläche liest sich aus zwei Metern wie ein Defekt.
    nodeAssert.match(html, /wall-plan__state/, 'der leere Tag bekommt seine eigene Zeile');
  });
});
test('Wand-Modus und Dziś erzählen denselben Tag (ein Modell, zwei Formen)', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const plan = await import('../public/utils/today-plan.js');
  await withWallWindow(() => {
    // TAFLA: beide lesen den Tagesplan aus utils/today-plan.js - die Wand
    // ohne Betrachter, Dziś fuer die angemeldete Person.
    const data = { planTasks: wallTasks(3), users: [] };
    const titles = (html) => (html.match(/Aufgabe \d+/g) ?? []);
    const wand = titles(__test.renderWallSurface(data, null, { now: todayAt(12) }));
    const dzis = plan.buildPlan(data, plan.planContext({ viewer: null, now: todayAt(12) })).open.map((row) => row.title);
    nodeAssert.equal(wand.length, 3, 'Reichweite: die Wand hat drei Zeilen gelesen');
    nodeAssert.deepEqual(wand, dzis, 'dieselben Zeilen in derselben Reihenfolge - keine zweite Wahrheit');
  });
});
test('Wand-Modus: das Nachtfenster läuft über Mitternacht (22:00 bis 06:00)', async () => {
  const { isWallNight, isWallRoute, WALL_NIGHT_FROM, WALL_NIGHT_TO } = await import('../public/utils/wall-mode.js');
  const at = (h, m = 0) => new Date(2026, 7, 11, h, m);
  const probe = [
    [21, 59, false], [22, 0, true], [23, 30, true],
    [0, 15, true], [3, 0, true], [5, 59, true], [6, 0, false], [12, 0, false],
  ];
  const falsch = probe.filter(([h, m, soll]) => isWallNight(at(h, m)) !== soll)
    .map(([h, m]) => `${h}:${String(m).padStart(2, '0')}`);
  nodeAssert.equal(probe.length, 8, 'acht Uhrzeiten geprüft');
  nodeAssert.deepEqual(falsch, [], 'ODER statt UND - sonst reißt das Fenster um Mitternacht');
  nodeAssert.equal(WALL_NIGHT_FROM, 22);
  nodeAssert.equal(WALL_NIGHT_TO, 6);

  // Der Modus ist ein Zustand DES DASHBOARDS, keine eigene Route.
  nodeAssert.equal(isWallRoute('/'), true);
  nodeAssert.deepEqual(['/tasks', '/settings', '/calendar'].filter(isWallRoute), []);
});

/* #1453: NACH EINEM RELOAD IN DER NACHT BLIEB DIE WAND HELL.
 *
 * 2026-10-27, v2: light only. Es gibt kein dunkles Theme mehr: theme-init.js
 * raeumt eine gespeicherte Wahl (`yuvomi-theme`) ab und setzt nie
 * `data-theme`; die Nachtszene malt ihr Dunkel selbst (--wall-night-*) und
 * haengt allein an `data-wall-night`. Die Zusage von #1453 bleibt in dieser
 * Form: nach dem Laden und im Minutentakt ist es Nacht, um 06:00 nicht mehr -
 * und ein frueher gespeichertes 'dark' schaltet nichts mehr dunkel.
 *
 * Bis v2:
 * Drei Stellen fassen beim Laden die Wurzel an: theme-init.js setzt nachts
 * `data-wall-night` und erzwingt `data-theme="dark"`, die Router-Init stellt
 * das gespeicherte Theme wieder her („Automatisch" entfernt `data-theme`,
 * „Hell" setzt `light`), und `syncWallMode` las `wasNight` aus dem Attribut -
 * Nacht und schon Nacht, also kein Zweig, und die helle Flaeche blieb bis
 * 06:00. Nachgespielt wird die Reihenfolge mit einer Stub-Wurzel: theme-init
 * als echtes Skript, die Router-Init als ihre Drei-Wege-Logik (router.js,
 * Initialisierung), dann der echte `syncWallMode` samt Minutentakt.
 */
test('Wand-Modus: nach einem Reload in der Nacht bleibt die Wand in der Nacht (#1453)', async () => {
  const wall = await import('../public/utils/wall-mode.js');
  const tz = await import('/utils/timezone.js');
  const themeInit = readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8');

  function makeStorage(entries) {
    const map = new Map(Object.entries(entries));
    return {
      get length() { return map.size; },
      key: (i) => [...map.keys()][i] ?? null,
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => { map.set(k, String(v)); },
      removeItem: (k) => { map.delete(k); },
    };
  }
  function makeRoot() {
    const attrs = new Map();
    return {
      attrs,
      setAttribute: (k, v) => { attrs.set(k, String(v)); },
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      removeAttribute: (k) => { attrs.delete(k); },
      hasAttribute: (k) => attrs.has(k),
      toggleAttribute: (k, force) => {
        const on = force === undefined ? !attrs.has(k) : Boolean(force);
        if (on) attrs.set(k, ''); else attrs.delete(k);
        return on;
      },
    };
  }
  const RealDate = Date;
  function atInstant(iso, fn) {
    const fixed = RealDate.parse(iso);
    class FixedDate extends RealDate {
      constructor(...args) { if (args.length === 0) super(fixed); else super(...args); }
      static now() { return fixed; }
    }
    globalThis.Date = FixedDate;
    try { return fn(); } finally { globalThis.Date = RealDate; }
  }

  // Die Nacht: 23:00 in Berlin (Haushalt) - und auf der Geraeteuhr, die
  // theme-init liest, ebenfalls Nacht, damit alle drei Stellen dasselbe sehen.
  const NIGHT = '2026-09-23T21:00:00Z';
  const MORNING = '2026-09-24T04:00:00Z'; // 06:00 in Berlin
  const deviceNight = class extends RealDate { getHours() { return 23; } };

  const results = [];
  for (const stored of [null, 'light', 'dark']) {
    const root = makeRoot();
    const storage = makeStorage({ 'yuvomi-wall-mode': '1', ...(stored ? { 'yuvomi-theme': stored } : {}) });
    // `localStorage` per Deskriptor tauschen, nicht per Zuweisung: Node fuehrt
    // es als Accessor ohne Setter (ab Node 25 eingebaut), eine Zuweisung wirft
    // im Modul-Code - und zwar VOR dem try, sodass document/location/window des
    // Stubs fuer die Nachbarfaelle stehen blieben (der Solo-Fall fiel mit).
    const prev = { document: globalThis.document, location: globalThis.location, window: globalThis.window };
    const prevStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    try {
      globalThis.document = { documentElement: root, querySelectorAll: () => [] };
      Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
      globalThis.location = { pathname: '/' };
      globalThis.window = { yuvomi: { restoreThemeColor: () => {} } };
      tz.setDisplayTimeZone('Europe/Berlin');
      // 1. theme-init.js, das echte Skript
      new Function('localStorage', 'sessionStorage', 'document', 'location', 'Date', themeInit)(
        storage, makeStorage({}), globalThis.document, globalThis.location, deviceNight,
      );
      nodeAssert.ok(root.hasAttribute('data-wall-night'), 'Vorbedingung: theme-init setzt nachts data-wall-night');
      // 2. (Die Router-Init stellte bis v2 das gespeicherte Theme her - entfallen.)
      // 3. syncWallMode aus der Navigation, danach ein Minutentakt in der Nacht
      atInstant(NIGHT, () => wall.syncWallMode('/'));
      const afterLoad = root.getAttribute('data-theme');
      const nightAfterLoad = root.hasAttribute('data-wall-night');
      atInstant(NIGHT, () => wall.syncWallMode('/'));
      const afterTick = root.getAttribute('data-theme');
      const night = nightAfterLoad && root.hasAttribute('data-wall-night');
      // 4. der Takt um 06:00 stellt die Wahl des Nutzers zurueck
      atInstant(MORNING, () => wall.syncWallMode('/'));
      results.push({
        stored,
        afterLoad, afterTick, night,
        morning: root.getAttribute('data-theme'),
        morningNight: root.hasAttribute('data-wall-night'),
        kept: storage.getItem('yuvomi-theme'),
      });
    } finally {
      tz.setDisplayTimeZone(null);
      Object.assign(globalThis, prev);
      if (prevStorage) Object.defineProperty(globalThis, 'localStorage', prevStorage);
      else delete globalThis.localStorage;
    }
  }
  nodeAssert.deepEqual(results, [
    { stored: null, afterLoad: null, afterTick: null, night: true, morning: null, morningNight: false, kept: null },
    { stored: 'light', afterLoad: null, afterTick: null, night: true, morning: null, morningNight: false, kept: null },
    { stored: 'dark', afterLoad: null, afterTick: null, night: true, morning: null, morningNight: false, kept: null },
  ], `nachts Nacht nach dem Laden und im Takt, morgens Tag, nie data-theme, eine alte Wahl ist weg - bekam ${JSON.stringify(results)}`);
});

// --------------------------------------------------------
// Widget-Konfiguration (public/utils/dashboard-widgets.js)
//
// ANLASS: `normalizeDashboardConfig` sortiert eine inzwischen neu bekannte
// Widget-Id an ihrer Default-Position ein, nicht hinten. Bis 2026-09-23 hing
// daran zusaetzlich die Packung des Rasters (`isUserOrderedConfig` schaltete
// umsortierte Layouts auf die Quellordnung); das Raster packt seitdem immer
// dicht, die Einsortierung bleibt der Ort, an dem ein Neuzugang erscheint.
// --------------------------------------------------------

const widgets = await import('../public/utils/dashboard-widgets.js');

// Ein Bestandslayout, dem genau `missing` fehlt - sonst der unveraenderte
// Default, so wie es ein Haushalt gespeichert hat, bevor es diese Id gab.
function layoutOhne(missing) {
  return widgets.DEFAULT_WIDGET_CONFIG
    .filter((w) => w.id !== missing)
    .map((w, i) => ({ ...w, order: i }));
}

// DIE LISTE STEHT HIER FEST, NICHT IHRE LAENGE, und der Unterschied ist die
// Lehre aus der Zahl, die vorher hier stand.
//
// Fest sein muss sie: ein Selektor, der aus `WIDGET_IDS` abgeleitet waere,
// koennte nie melden, dass sich `WIDGET_IDS` geaendert hat - er waere
// tautologisch und der Guard damit wertlos. Das war die Begruendung der Zahl,
// und sie gilt unveraendert.
//
// Eine ZAHL war trotzdem die falsche Form, und zwar genau am Merge: zwei
// Zweige, die je ein Widget ergaenzen, schreiben BEIDE `20` -> `21`. Git sieht
// zweimal dieselbe Aenderung und fuehrt sie konfliktfrei zusammen; danach hat
// `WIDGET_IDS` 22 Eintraege, hier steht 21, und die Suite ist auf main rot,
// obwohl jeder Zweig fuer sich gruen war.
//
// Die Liste loest beides auf einmal: sie meldet weiterhin JEDE Aenderung an
// WIDGET_IDS (ihr eigentlicher Zweck), und zwei Zweige, die je eine ANDERE Id
// ergaenzen, aendern dieselbe Zeile unterschiedlich - das ist ein Konflikt, den
// git meldet, statt ihn stillschweigend zu verschmelzen.
// TAFLA (2026-10-19): die fuenf Abschnitte von Dziś stehen vorn
// (TODAY_SECTION_IDS) - ein Bestandslayout bekommt sie oben, in dieser Folge.
const ERWARTETE_WIDGET_IDS = [
  'today-weather', 'today-shopping', 'today-tomorrow', 'today-question', 'today-soon',
  'tasks', 'calendar', 'meals', 'shopping', 'pantry', 'birthdays', 'countdown', 'budget',
  'rewards', 'health', 'cycle', 'fasting', 'nutrition', 'housekeeping', 'schedule',
  'waste', 'family', 'notes', 'weather', 'clock', 'metrics', 'quicklinks',
];

test('Widget-Merge: eine fehlende Id landet an ihrer Default-Position, nicht hinten', () => {
  assert(widgets.WIDGET_IDS.join(',') === ERWARTETE_WIDGET_IDS.join(','),
    `Reichweite: WIDGET_IDS ist ${widgets.WIDGET_IDS.join(',')}, erwartet ${ERWARTETE_WIDGET_IDS.join(',')}`);
  const falsch = widgets.WIDGET_IDS.filter((id) => {
    const merged = widgets.normalizeDashboardConfig(layoutOhne(id));
    return merged.map((w) => w.id).join(',') !== widgets.WIDGET_IDS.join(',');
  });
  assert(falsch.length === 0,
    `An die falsche Stelle einsortiert: ${falsch.join(', ')} - erwartet ist die Default-Position`);
});

test('Widget-Merge: zwei fehlende Ids behalten ihre Reihenfolge zueinander', () => {
  const zwei = widgets.DEFAULT_WIDGET_CONFIG
    .filter((w) => !['meals', 'shopping'].includes(w.id))
    .map((w, i) => ({ ...w, order: i }));
  const merged = widgets.normalizeDashboardConfig(zwei).map((w) => w.id);
  assert(merged.join(',') === widgets.WIDGET_IDS.join(','),
    `Zwei benachbarte Neuzugaenge kamen durcheinander: ${merged.join(',')}`);
});

test('Widget-Merge: eine fehlende Id am Anfang der Liste landet vorn, nicht hinten', () => {
  // Der Fall ohne Vorgaenger - seit Tafla ist `today-weather` WIDGET_IDS[0]
  // (vorher `tasks`). Die Rueckwaertssuche findet nichts und muss auf
  // Position 0 fallen.
  const first = widgets.WIDGET_IDS[0];
  const merged = widgets.normalizeDashboardConfig(layoutOhne(first));
  assert(merged[0].id === first, `Erste Id landete auf Position ${merged.findIndex((w) => w.id === first)}`);
});

test('Widget-Merge: ein umsortiertes Layout laesst den Neuzugang seinem Vorgaenger folgen', () => {
  // Der Anlassfall ist der Demo-Haushalt (gemessen 2026-08-13): `weather` steht
  // dort ganz vorn, `clock` und `metrics` fehlen. Ein umsortiertes Layout hat
  // keine Default-Position mehr, nur noch Nachbarn - der Neuzugang haengt sich
  // an seinen Vorgaenger, nicht ans Ende. Das ist die Entscheidung, und sie
  // steht hier, weil sie sonst niemandem auffaellt.
  const demo = ['weather', 'family', 'budget', 'birthdays', 'rewards', 'notes',
    'tasks', 'calendar', 'shopping', 'meals', 'housekeeping', 'health', 'cycle']
    .map((id, i) => ({ id, order: i, visible: i < 6, size: '1x1' }));
  const merged = widgets.normalizeDashboardConfig(demo);
  const sichtbar = merged.filter((w) => w.visible).map((w) => w.id);
  // `countdown` ist der zweite Neuzugang in diesem Layout (#647) und belegt
  // dieselbe Zusicherung ein zweites Mal: sein Vorgaenger in WIDGET_IDS ist
  // `birthdays`, und dorthin gehoert er - nicht ans Ende. Die fuenf
  // Tafla-Abschnitte (2026-10-19) haben keinen Vorgaenger und stehen vorn.
  assert(sichtbar.join(',') === 'today-weather,today-shopping,today-tomorrow,today-question,today-soon,weather,metrics,family,budget,birthdays,countdown,rewards,notes',
    `Neuzugang an unerwarteter Stelle: ${sichtbar.join(',')}`);
});

test('Widget-Optionen reisen durch die Normalisierung, ohne dass sie jemand kennt (#814)', () => {
  const gespeichert = widgets.DEFAULT_WIDGET_CONFIG.map((w) => (
    w.id === 'tasks' ? { ...w, options: { categories: ['household'], erfunden: true } } : { ...w }
  ));
  const merged = widgets.normalizeDashboardConfig(gespeichert);
  const tasks = merged.find((w) => w.id === 'tasks');
  assert(tasks.options?.categories?.[0] === 'household', 'die Auswahl ist unterwegs verlorengegangen');
  assert(tasks.options?.erfunden === true,
    'eine unbekannte Option muss durchgehen - sonst steht hier eine zweite Registry');
  // Und ein Widget ohne Optionen bekommt keine leere Klammer angehaengt.
  assert(!('options' in merged.find((w) => w.id === 'weather')),
    'ein leeres Optionsobjekt waere in jedem Layout dieselbe leere Klammer');
});

test('dashboardQuery uebersetzt Optionen in Parameter, die die Route versteht (#814)', () => {
  const mit = (id, options) => widgets.DEFAULT_WIDGET_CONFIG
    .map((w) => (w.id === id ? { ...w, options } : { ...w }));

  assert(widgets.dashboardQuery(widgets.DEFAULT_WIDGET_CONFIG) === '/dashboard',
    'ohne Optionen darf kein Parameter entstehen - sonst zahlt jeder Aufruf eine zweite Abfrage');
  assert(widgets.dashboardQuery(mit('calendar', { scope: 'mine' })) === '/dashboard?events_scope=mine',
    `Kalender-Parameter falsch: ${widgets.dashboardQuery(mit('calendar', { scope: 'mine' }))}`);
  assert(widgets.dashboardQuery(mit('calendar', { scope: 'all' })) === '/dashboard',
    '„alle" ist die Abwesenheit einer Einschraenkung, kein Parameter');
  // Die Geburtstags-Abwahl (#927) folgt derselben Regel, nur andersherum
  // notiert: gespeichert und geschickt wird das Wegnehmen, nicht das Haekchen.
  assert(widgets.dashboardQuery(mit('calendar', { birthdays: 'hide' })) === '/dashboard?events_birthdays=hide',
    `Geburtstags-Parameter falsch: ${widgets.dashboardQuery(mit('calendar', { birthdays: 'hide' }))}`);
  assert(widgets.dashboardQuery(mit('calendar', { birthdays: 'show' })) === '/dashboard',
    'die Zustimmung ist der Auslieferungszustand und braucht keinen Parameter');
  const beide = widgets.dashboardQuery(mit('calendar', { scope: 'mine', birthdays: 'hide' }));
  assert(beide === '/dashboard?events_scope=mine&events_birthdays=hide',
    `beide Kalender-Optionen zusammen falsch: ${beide}`);
  const zwei = widgets.dashboardQuery(mit('tasks', { categories: ['household', 'school'] }));
  assert(zwei === '/dashboard?tasks_category=household&tasks_category=school',
    `Kategorien falsch: ${zwei}`);
  assert(widgets.dashboardQuery(mit('tasks', { categories: [] })) === '/dashboard',
    'eine leere Auswahl ist keine Einschraenkung');
  const notes = widgets.dashboardQuery(mit('notes', { categories: [12, 34] }));
  assert(notes === '/dashboard?notes_category=12&notes_category=34',
    `Notiz-Kategorien falsch: ${notes}`);
  // Ein Layout, in dem es das Widget gar nicht gibt, darf nicht werfen.
  assert(widgets.dashboardQuery([]) === '/dashboard');
  assert(widgets.dashboardQuery(null) === '/dashboard');
});

test('isUserOrderedConfig gibt es nicht mehr - das Raster schaltet nach keiner Reihenfolge um', () => {
  // Gegenprobe zur Entscheidung vom 2026-09-23 (immer dicht): ein Aufrufer,
  // der die Unterscheidung zurueckholen wollte, faende sie hier nicht mehr.
  assert(!('isUserOrderedConfig' in widgets), 'isUserOrderedConfig ist zurueck');
});

test('Widget-Merge: gespeicherte Reihenfolge gewinnt ueber die Array-Position', () => {
  // `order` und Array-Position koennen auseinanderlaufen; eingefuegt wird an
  // einer Position, also muss vorher sortiert sein.
  const gemischt = widgets.DEFAULT_WIDGET_CONFIG
    .filter((w) => w.id !== 'notes')
    .map((w, i) => ({ ...w, order: i }))
    .reverse();
  const merged = widgets.normalizeDashboardConfig(gemischt).map((w) => w.id);
  assert(merged.join(',') === widgets.WIDGET_IDS.join(','),
    `Array-Position statt order gelesen: ${merged.join(',')}`);
});

test('Widget-Merge: Groesse und Sichtbarkeit eines Bestandseintrags bleiben unberuehrt', () => {
  const gespeichert = widgets.DEFAULT_WIDGET_CONFIG
    .filter((w) => w.id !== 'metrics')
    .map((w) => ({ ...w, visible: w.id === 'tasks' ? true : w.visible, size: w.id === 'tasks' ? '2x2' : w.size }));
  const merged = widgets.normalizeDashboardConfig(gespeichert);
  const tasks = merged.find((w) => w.id === 'tasks');
  assert(tasks.size === '2x2' && tasks.visible === true, 'gespeicherte Groesse/Sichtbarkeit ueberschrieben');
  // Der Neuzugang erbt dagegen seinen Default - Opt-in-Module erscheinen nicht ungefragt.
  const health = widgets.normalizeDashboardConfig(layoutOhne('health')).find((w) => w.id === 'health');
  assert(health.visible === false, 'ein neu ergaenztes Opt-in-Widget kam sichtbar herein');
});

// --------------------------------------------------------
// Schedule-Widget: Verdrahtung (Schedule v2)
// ANLASS: der Zyklus-Slice hat zwei Stellen, an denen `data` bei einem
// Refresh ersetzt wird (reloadIfQueryChanged, refreshDashboardData), und BEIDE
// muessen den eigenen Slice mitnehmen - sonst blitzt die Kachel bei jedem
// stillen 15-Minuten-Refresh kurz auf ihren Leerzustand zurueck. Der
// Schedule-Slice teilt sich denselben Mechanismus (ein eigener Slice, den
// /dashboard nie mitliefert, weil er - anders als bei cycle - keine
// Owner-Beschraenkung braucht) und denselben Zweiteiler.
// --------------------------------------------------------

test('das Schedule-Widget ist in der Anpassen-Standardliste als Opt-in eingetragen', async () => {
  const widgets = await import('../public/utils/dashboard-widgets.js');
  assert(widgets.WIDGET_IDS.includes('schedule'), 'WIDGET_IDS fehlt schedule');
  assert(widgets.DEFAULT_HIDDEN_WIDGETS.has('schedule'),
    'schedule muss wie rewards/health/housekeeping erst im Anpassen-Tray auftauchen, nicht ab Werk sichtbar sein');
});

// --------------------------------------------------------
// Schedule-Widget: Groessenklasse und Zeilendeckel (PR #930 review)
// ANLASS: `schedule` fiel durch defaultWidgetSize() auf 1x1, obwohl die
// Kachel eine Mitglieder-Liste ist (Avatar, Name, Schicht) wie `family` -
// gemessen rendert 1x1 218px, die Kachel selbst 318px, und zieht eine
// benachbarte Kachel in derselben Rasterzeile mit hoch. Zweiter Teil: der
// Renderer kannte gar keinen Zeilendeckel, `listRowCap` war die einzige
// Listenkachel ohne ihn - dieselbe Luecke, die #928 bei den Notizen schon
// hatte (renderPinnedNotes ist hier das Vorbild).
// --------------------------------------------------------

test('die Schedule-Kachel defaultet auf 1x2 wie family, nicht auf 1x1', async () => {
  const widgets = await import('../public/utils/dashboard-widgets.js');
  nodeAssert.equal(widgets.defaultWidgetSize('schedule'), '1x2',
    'eine Mitglieder-Liste braucht Hoehe, nicht Breite (PR #930 review)');
});

test('Kennzahlreihe ist eine Zeile, kein Block', async () => {
  const widgets = await import('../public/utils/dashboard-widgets.js');
  // 671px hoch fuer vier Zahlen war der Anlass; die Mitteilung zum Bau sagte
  // „in der Hoehe, die ein Widget-Kopf kostet".
  assert(widgets.defaultWidgetSize('metrics') === '2x1',
    'die Reihe startet als Zeile - 2x2 war der Block, der 671px fuer 80px Inhalt nahm');
});

// --------------------------------------------------------
// Wetterlage, Gangart und Temperaturband (#Wetter-Kur 2026-08-17)
// --------------------------------------------------------

// --------------------------------------------------------
// Kalendertag der Route: lokal, nie UTC
// --------------------------------------------------------

/* Die Dashboard-Route darf einen KALENDERTAG nicht aus `toISOString()` ziehen.
 *
 * CLAUDE.md fuehrt diese Falle: `.toISOString().slice(0,10)` liefert den
 * UTC-Tag, verglichen wird aber gegen Werte, die der Nutzer als lokalen
 * Kalendertag eingegeben hat (Mahlzeitendatum, due_date, Budget-Monat).
 * Oestlich von UTC lieferte das Dashboard dadurch in den fruehen Morgenstunden
 * die Mahlzeiten des VORTAGS, westlich davon am spaeten Abend die von morgen.
 *
 * Warum dieser Guard und nicht der Verhaltenstest daneben: der faellt nur auf,
 * wenn die Testmaschine gerade in einer Zone UND zu einer Stunde laeuft, in der
 * die beiden Tage auseinanderfallen. Die CI laeuft in UTC, wo sie IMMER gleich
 * sind - der Fehler war dort per Konstruktion unsichtbar und stand ueber
 * mehrere Releases gruen im Build.
 *
 * `.toISOString()` ohne den Datums-Schnitt bleibt erlaubt: ein echter Instant
 * (z.B. eine 48h-Grenze) ist in UTC korrekt aufgehoben. */
test('die Route zieht ihren Kalendertag lokal, nicht aus toISOString()', () => {
  const src = readFileSync(new URL('../server/routes/dashboard.js', import.meta.url), 'utf8');
  // Kommentare raus, sonst findet der Guard die Beschreibung der Falle im
  // Quelltext, die dort absichtlich steht.
  const code = withoutBlockComments(src)
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');

  const treffer = [...code.matchAll(/toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)/g)];
  assert(
    treffer.length === 0,
    `server/routes/dashboard.js zieht an ${treffer.length} Stelle(n) einen Kalendertag aus `
    + 'toISOString() - das ist der UTC-Tag. Fuer alles, was der Nutzer als Kalendertag '
    + 'eingegeben hat, gilt todayLocalKey.',
  );
});

// --------------------------------------------------------
// Wetter: ob Dziś eine Wetterzeile versprechen darf
// TAFLA (2026-10-24): hier standen die Faelle der Wetterkarte des Rasters
// (welcher Vorhersagetag „Heute" heisst, #851). Die Karte ist gegangen; Dziś
// und die Wand tragen eine Zeile ohne Vorhersage.
// --------------------------------------------------------

test('Wetter-Verfuegbarkeit: der Grund des Proxys entscheidet, die Praeferenzen nur ohne Antwort', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const avail = __test.weatherAvailableFrom;
  const HH = { weather_source: { source: 'db' }, weather_user: {} };
  const NONE = { weather_source: { source: 'none' }, weather_user: { lat: null, lon: null } };
  const MEMBER = { weather_source: { source: 'none' }, weather_user: { lat: '51.5', lon: '7.4' } };
  assert(avail({ data: { current: {} } }, NONE) === true, 'Daten sind immer verfuegbar');
  assert(avail({ data: null, reason: 'upstream_error' }, NONE) === true, 'gescheitert heisst eingerichtet');
  assert(avail({ data: null, reason: 'not_configured' }, HH) === false,
    'der Proxy kennt die ganze Regel - sein "nicht eingerichtet" schlaegt die Haushaltsquelle');
  // Die Anfrage selbst scheiterte (`.catch` im Client): kein Grund, also die Praeferenzen.
  assert(avail({ data: null }, HH) === true, 'Haushalt eingerichtet');
  assert(avail({ data: null }, MEMBER) === true, 'Standort des Mitglieds zaehlt mit');
  assert(avail({ data: null }, NONE) === false, 'nichts eingerichtet');
  assert(avail(null, null) === false, 'vor dem Laden verspricht nichts eine Kachel');
});

test('Dashboard serialisiert linked occurrences ohne rohe Persistenzfelder', async () => {
  const { get } = await import('../server/db.js');
  const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
  const routeDb = get();
  const owner = routeDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES ('dashboard-occurrence-review', 'Occurrence Reviewer', 'x', '#007AFF', 'member')
  `).run().lastInsertRowid;
  const slot = addLocalDays(today, 1);
  const moved = addLocalDays(today, 2);
  const masterId = routeDb.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, recurrence_rule, created_by, visibility)
    VALUES ('Dashboard review master', ?, ?, 'FREQ=DAILY;COUNT=3', ?, 'all')
  `).run(`${slot}T09:00:00`, `${slot}T10:00:00`, owner).lastInsertRowid;
  const childId = routeDb.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, created_by, visibility,
       recurrence_parent_id, recurrence_id, overridden_fields)
    VALUES ('Dashboard review child', ?, ?, ?, 'all', ?, ?,
            '["title","start_datetime","end_datetime","assignments"]')
  `).run(`${moved}T11:00:00`, `${moved}T12:00:00`, owner, masterId, slot).lastInsertRowid;
  routeDb.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)')
    .run(childId, owner);
  routeDb.prepare('INSERT INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)')
    .run(masterId, slot);

  const app = express();
  app.use((req, _res, next) => {
    req.authUserId = owner;
    req.session = { userId: owner, role: 'member' };
    next();
  });
  app.use('/', dashboardRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/?events_scope=mine`)).json();
    const child = body.upcomingEvents.find((event) => Number(event.id) === Number(childId));
    nodeAssert.ok(child, 'linked occurrence musí být v dashboard odpovědi');
    nodeAssert.equal(child.series_id, Number(masterId));
    nodeAssert.equal(child.recurrence_id, slot);
    nodeAssert.equal(child.is_occurrence_override, true);
    nodeAssert.equal(child.can_override_occurrence, true);
    for (const key of ['recurrence_parent_id', 'recurrence_identity', 'overridden_fields']) {
      nodeAssert.equal(Object.hasOwn(child, key), false, `${key} nesmí uniknout z API`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    routeDb.prepare('DELETE FROM users WHERE id = ?').run(owner);
  }
});

test('Wand-Modus: Screensaver-Knopf erscheint mit screensaverEnabled, nicht ohne (#1766)', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  await withWallWindow(() => {
    const data = { urgentTasks: wallTasks(1), users: [] };
    const on  = __test.renderWallSurface(data, null, { screensaverEnabled: true });
    const off = __test.renderWallSurface(data, null, { screensaverEnabled: false });
    nodeAssert.match(on,  /id="wall-screensaver-start"/, 'mit Flag: Knopf da');
    nodeAssert.ok(!/id="wall-screensaver-start"/.test(off), 'ohne Flag: kein Knopf');
    // Der Ausstieg muss in beiden Faellen vorhanden sein.
    nodeAssert.match(on,  /id="wall-exit"/, 'Ausstieg bleibt mit Flag');
    nodeAssert.match(off, /id="wall-exit"/, 'Ausstieg bleibt ohne Flag');
  });
});

// `localStorage` fuer GENAU EINEN synchronen Aufruf ersetzen. Die Faelle dieser
// Datei laufen nebenlaeufig an (`test()` reiht sie nur ein): wer einen Stub ueber
// ein `await` hinweg stehen laesst, gibt ihn dem naechsten Fall als „vorher"
// mit, und der stellt ihn am Ende wieder her - nach der Suite meldete
// `localStorage` dann fuer jeden Schluessel einen laufenden Timer. Deshalb der
// Deskriptor statt des Werts (Node fuehrt `localStorage` als Accessor) und kein
// `await` zwischen Setzen und Zuruecksetzen.
function withLocalStorageSync(stub, fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete globalThis.localStorage;
  }
}

test('Wand-Modus: Screensaver-Knopf faellt weg, solange ein Timer laeuft (#1766)', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  await withWallWindow(() => {
    const data = { urgentTasks: wallTasks(1), users: [] };
    // Einen laufenden Timer eintragen: der Schluesseleintrag ist ein zukuenftiger Zeitstempel.
    const running = { getItem: () => String(Date.now() + 120_000), setItem() {}, removeItem() {} };
    const html = withLocalStorageSync(running, () => __test.renderWallSurface(data, null, { screensaverEnabled: true }));
    nodeAssert.match(html, /id="wall-timer-stop"/, 'Reichweite: der Timer laeuft in diesem Aufbau');
    nodeAssert.ok(!/id="wall-screensaver-start"/.test(html),
      'laufender Timer verdraengt den Screensaver-Knopf');
  });
});

test('Wand-Modus: der Schoner-Knopf traegt nur sein Zeichen, Name und Tooltip stehen am Knopf (#1766)', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  await withWallWindow(() => {
    const html = __test.renderWallSurface({ urgentTasks: wallTasks(1), users: [] }, null, { screensaverEnabled: true });
    const button = html.match(/<button[^>]*id="wall-screensaver-start"[\s\S]*?<\/button>/)?.[0] ?? '';
    nodeAssert.ok(button, 'Reichweite: der Knopf steht im Markup');
    nodeAssert.match(button, /aria-label="dashboard\.wallScreensaverStart"/, 'zugaenglicher Name');
    nodeAssert.match(button, /title="dashboard\.wallScreensaverStart"/, 'Tooltip fuer den Zeiger');
    nodeAssert.match(button, /class="wall-ghost wall-ghost--icon"/, 'die Icon-Form der Dock-Kapsel');
    nodeAssert.match(button, /data-lucide="image"/, 'das Zeichen');
    // Ein sichtbares Wort machte die Gruppe wieder so breit wie die Sprache
    // (gemessen: de 416px, die Startknoepfe rutschten um bis zu 100px).
    nodeAssert.ok(!/<span>/.test(button), 'kein sichtbares Wort im Schoner-Knopf');
    // Der Ausstieg daneben behaelt seines (#1559).
    const exit = html.match(/<button[^>]*id="wall-exit"[\s\S]*?<\/button>/)?.[0] ?? '';
    nodeAssert.match(exit, /<span>dashboard\.wallExit<\/span>/, 'der Ausstieg bleibt beschriftet');
  });
});

test('rebuildWall schreibt die Flaeche, die rebuildDashboard mit screensaverEnabled baut (Verdrahtungsschutz, #1766)', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const { readFileSync } = await import('node:fs');
  // TAFLA: render() baut das Markup (renderWallSurface, mit dem Flag) und
  // reicht es als `surface` an rebuildWall - der Fall darunter misst die ganze
  // Kette ueber render(). Hier: das Flag steht im Aufruf, und rebuildWall
  // schreibt genau die Flaeche, die es bekommt.
  const page = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  nodeAssert.match(page, /surface: renderWallSurface\(data, weather, \{ failed: loadFailed, updatedAt: lastLoadedAt, screensaverEnabled,/,
    'rebuildDashboard reicht screensaverEnabled an renderWallSurface');
  await withWallWindow(() => {
    let captured = '';
    const shell = {
      replaceChildren() { captured = ''; },
      insertAdjacentHTML(_pos, html) { captured += html; },
      querySelectorAll: () => [],
    };
    const container = { querySelector: () => null };
    const signal = { addEventListener() {} };
    const idle = { getItem: () => null, setItem() {}, removeItem() {} };
    for (const screensaverEnabled of [true, false]) {
      withLocalStorageSync(idle, () => __test.rebuildWall(container, shell, {
        surface: __test.renderWallSurface({ planTasks: wallTasks(1), users: [] }, null, { screensaverEnabled }),
        rerender: () => {}, signal, fit: { show() {} }, actions: {},
      }));
      nodeAssert.match(captured, /id="wall-exit"/, 'Reichweite: die Shell wurde neu gefuellt');
      nodeAssert.equal(/id="wall-screensaver-start"/.test(captured), screensaverEnabled, `screensaverEnabled:${screensaverEnabled}`);
    }
  });
});
// DIE DREI GELENKE DES SCHONER-KNOPFS, UEBER render() GEMESSEN (#1766).
// Die Faelle oben rufen `renderWallSurface` und `rebuildWall` direkt und reichen
// das Flag selbst hinein. Was die Seite daraus macht, sieht keiner von ihnen:
//   (a) render() reicht das Flag an rebuildWall weiter,
//   (b) es kommt aus `screensaver_enabled` der Praeferenzen,
//   (c) der Klick ruft preview() und sagt bei `false` den einen Satz.
// Jedes der drei liess sich einzeln abklemmen, ohne dass ein Fall rot wurde.
// Hier laeuft deshalb die echte Seite gegen eine Attrappe des Containers, und
// der Knopf, den `wireWallSurface` findet, ist der aus dem Markup, das die Seite
// gerade geschrieben hat: ein Handler an einer anderen ID bleibt ungebunden.
// `preview()` ist das echte aus components/photo-screensaver.js; gesteuert wird
// nur, was die Fotoroute antwortet.
//
// Der Fall haelt seine Globals ueber mehrere `await` und wartet deshalb zuerst
// auf alle Faelle davor - sonst saehen sie seine Attrappen.
const beforeScreensaverWiring = pendingTests.slice();
test('Wand-Modus: render() reicht screensaver_enabled bis zum Knopf, der Klick ruft preview() und meldet false (#1766)', async () => {
  await Promise.allSettled(beforeScreensaverWiring);
  const names = ['window', 'document', 'localStorage', 'location', 'history', 'MutationObserver', 'setTimeout', 'setInterval', '__apiStub'];
  const saved = Object.fromEntries(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  const timeouts = [];
  const intervals = [];

  const makeNode = () => {
    const attrs = new Map();
    const listeners = new Map();
    return {
      dataset: {},
      style: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      listeners,
      addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
      removeEventListener() {},
      setAttribute(name, value) { attrs.set(name, String(value)); },
      getAttribute: (name) => attrs.get(name) ?? null,
      removeAttribute(name) { attrs.delete(name); },
      hasAttribute: (name) => attrs.has(name),
      toggleAttribute(name, force) { if (force ?? !attrs.has(name)) attrs.set(name, ''); else attrs.delete(name); },
      querySelector: () => null,
      querySelectorAll: () => [],
      append() {},
      appendChild() {},
      remove() {},
      contains: () => false,
      focus() {},
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    };
  };

  // Der Container kennt genau das, was die Seite hineingeschrieben hat: die
  // Shell traegt das Markup des letzten Aufbaus, `.wall` gibt es, sobald es
  // darin steht, und ein Knopf existiert nur unter der ID aus diesem Markup.
  let shellHtml = '';
  let buttons = new Map();
  const shell = Object.assign(makeNode(), {
    replaceChildren() { shellHtml = ''; buttons = new Map(); },
    insertAdjacentHTML(_position, html) { shellHtml += html; },
  });
  const wall = Object.assign(makeNode(), {
    querySelector(selector) {
      const id = /^#([\w-]+)$/.exec(selector)?.[1];
      if (!id || !shellHtml.includes(`id="${id}"`)) return null;
      if (!buttons.has(id)) buttons.set(id, makeNode());
      return buttons.get(id);
    },
  });
  const container = Object.assign(makeNode(), {
    replaceChildren() { shellHtml = ''; buttons = new Map(); },
    insertAdjacentHTML(_position, html) { shellHtml += html; },
    querySelector(selector) {
      if (selector === '#dashboard-shell') return shell;
      if (selector === '.wall') return /class="wall"/.test(shellHtml) ? wall : null;
      return null;
    },
  });

  const toasts = [];
  const asked = [];
  let prefs = {};
  let photos = { data: { enabled: true, photos: [] } };
  const root = makeNode();
  root.setAttribute('data-wall-mode', '');
  const globals = {
    window: Object.assign(makeNode(), {
      yuvomi: { showToast: (...args) => toasts.push(args), isModuleDisabled: () => false },
      requestAnimationFrame: () => 0,
      cancelAnimationFrame() {},
      innerWidth: 1280,
      innerHeight: 800,
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    }),
    document: Object.assign(makeNode(), {
      documentElement: root,
      body: makeNode(),
      hidden: false,
      createElement: () => makeNode(),
      getElementById: () => null,
    }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { pathname: '/', search: '', hash: '', href: 'http://wall.test/' },
    // Die Wand haelt einen History-Marker fuer Zurueck (#1559, overlay-history.js).
    history: { state: null, pushState(state) { this.state = state; }, replaceState(state) { this.state = state; }, back() {}, go() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    // Der Schoner bewaffnet seinen Wartetimer schon beim Laden des Moduls
    // (fuenf Minuten) - er hielte den Prozess so lange offen. Die Timer laufen
    // echt und werden am Ende geloescht.
    setTimeout: (...args) => { const handle = realSetTimeout(...args); timeouts.push(handle); return handle; },
    setInterval: (...args) => { const handle = realSetInterval(...args); intervals.push(handle); return handle; },
    __apiStub: {
      get: async (path) => {
        asked.push(path);
        if (path === '/preferences') return { data: prefs };
        if (path === '/screensaver/photos') return photos;
        if (path.startsWith('/dashboard')) return { urgentTasks: wallTasks(1), upcomingEvents: [], users: [] };
        return { data: null };
      },
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const controller = new AbortController();
  try {
    const { render } = await import('../public/pages/dashboard.js');
    const user = { id: 1, role: 'admin', display_name: 'Anna' };

    // (b) Ohne das Flag in den Praeferenzen: eine Wand, aber kein Knopf.
    prefs = { screensaver_enabled: false };
    await render(container, { user, signal: controller.signal });
    await settle();
    nodeAssert.ok(asked.includes('/preferences'), 'Reichweite: render() hat die Praeferenzen geholt');
    nodeAssert.match(shellHtml, /id="wall-exit"/, 'Reichweite: die Wand ist aufgebaut');
    nodeAssert.ok(!/id="wall-screensaver-start"/.test(shellHtml), 'screensaver_enabled:false - kein Knopf');

    // (a) + (b) Mit dem Flag: der Knopf steht im Markup, das render() schreibt.
    prefs = { screensaver_enabled: true };
    await render(container, { user, signal: controller.signal });
    await settle();
    nodeAssert.match(shellHtml, /id="wall-screensaver-start"/,
      'screensaver_enabled:true kommt ueber render() und rebuildWall am Knopf an');

    // (c) Der Handler haengt am Knopf aus diesem Markup.
    const clicks = buttons.get('wall-screensaver-start')?.listeners.get('click') ?? [];
    nodeAssert.equal(clicks.length, 1, 'genau ein Klick-Handler am Schoner-Knopf');

    // preview() meldet false (keine Fotos): die Fotoroute wurde gefragt, und
    // der eine Satz kommt als Toast.
    asked.length = 0;
    await clicks[0]({ detail: 1 });
    nodeAssert.ok(asked.includes('/screensaver/photos'), 'der Klick ruft preview() - die Fotoroute wurde gefragt');
    nodeAssert.deepEqual(toasts, [['dashboard.wallScreensaverNone', 'info']], 'false: der Toast sagt es');

    // preview() meldet true (ein Foto): kein zweiter Toast.
    photos = { data: { enabled: true, photos: [{ id: 'p1', takenAt: null }] } };
    asked.length = 0;
    await clicks[0]({ detail: 1 });
    nodeAssert.ok(asked.includes('/screensaver/photos'), 'Reichweite: auch dieser Klick lief durch preview()');
    nodeAssert.equal(toasts.length, 1, 'true: der Schoner laeuft, kein Toast');
  } finally {
    controller.abort();
    for (const handle of timeouts) clearTimeout(handle);
    for (const handle of intervals) clearInterval(handle);
    for (const name of names) {
      if (saved[name]) Object.defineProperty(globalThis, name, saved[name]);
      else delete globalThis[name];
    }
  }
});

await Promise.all(pendingTests);

console.log(`\n[Dashboard-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
