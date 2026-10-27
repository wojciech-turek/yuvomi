/**
 * Modul: Vorrat - Dashboard-Widget „Läuft bald ab"
 * Zweck: Die Kachel, die die Critique vom 2026-09-23 als fehlend fand: der
 *        Vorrat ist das einzige Küchenmodul mit echten täglichen Fristen und
 *        hatte keine. Geprüft werden vier Dinge, jedes an seiner eigenen Naht:
 *
 *        1. Registrierung - Widget-Liste, Standardgröße, ab Werk AUSgeblendet,
 *           Modulzuordnung für Rechte und Modulschalter, Renderer im Dispatch.
 *        2. Payload - `pantryExpiring` aus GET /dashboard: abgelaufen zuerst,
 *           dann nach Resttagen; Horizont = EXPIRY_SOON_DAYS (inklusiv);
 *           ohne MHD und leere Chargen fallen heraus; Deckel der Liste, aber
 *           die Zahlen zählen ungedeckelt.
 *        3. Tagesgrenze - „heute" ist der Tag der HAUSHALTSZONE, nicht der
 *           UTC-Tag; gemessen mit einer Uhr kurz nach Mitternacht Berlin und
 *           einer kurz vor Mitternacht Los Angeles.
 *        4. Rechte - Modul `none` und ein Token ohne Vorrats-Scope liefern die
 *           leere Form; `read` ist keine Sperre.
 *        Dazu der Filter-Deep-Link der Vorratsseite, auf den die Zeilen
 *        zeigen, und die Zeile „Läuft heute ab" im Tagesplan von Dziś.
 *
 *        TAFLA (2026-10-24): die Kachel des alten Rasters (renderPantryWidget)
 *        ist mit dem Raster gegangen; ihre Renderer-Tests mit ihr. Dziś zeigt
 *        den Vorrat als Vorschaukachel (todayTile) und als Zeile im Plan
 *        (utils/today-plan.js über utils/today-sheet.js).
 *
 *        Die Datenbasis ist bewusst die Charge (eine `pantry_items`-Zeile):
 *        das Haushalts-Produkt über der Charge (#1448) steht noch aus, die
 *        Kachel gruppiert deshalb nichts.
 * Ausführen: npm run test:dashboard-pantry
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { register } from 'node:module';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

register('./test-browser-loader.mjs', import.meta.url);

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'dashboard-pantry-test-secret';

const widgets = await import('../public/utils/dashboard-widgets.js');
const { PERMISSION_WIDGETS, resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const { EXPIRY_SOON_DAYS, pantryFilterFromSearch } = await import('../public/utils/pantry-status.js');
const { PANTRY_EXPIRING_ROW_CAP } = await import('../server/services/pantry-expiring.js');
const { planContext, buildPlan } = await import('../public/utils/today-plan.js');

const src = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

// --------------------------------------------------------------------------
// 1. Registrierung
// --------------------------------------------------------------------------

test('Registrierung: pantry steht in WIDGET_IDS, ab Werk ausgeblendet, als hohe Liste', () => {
  assert.ok(widgets.WIDGET_IDS.includes('pantry'), 'WIDGET_IDS fehlt pantry');
  // Eine Id, die in DEFAULT_HIDDEN_WIDGETS FEHLT, ist nach dem Update in jedem
  // bestehenden Haushalt eingeblendet (normalizeDashboardConfig ergänzt sie mit
  // defaultWidgetVisible) - die Anti-Referenz ist das überladene Dashboard.
  assert.ok(widgets.DEFAULT_HIDDEN_WIDGETS.has('pantry'), 'pantry muss ein Opt-in im Anpassen-Tray sein');
  assert.equal(widgets.DEFAULT_WIDGET_CONFIG.find((w) => w.id === 'pantry')?.visible, false,
    'das Standard-Layout zeigt die Kachel nicht');
  assert.equal(widgets.defaultWidgetSize('pantry'), '1x2', 'eine Liste braucht Höhe, nicht Breite (wie waste/birthdays)');
});

test('Registrierung: ein Bestandslayout ohne pantry bekommt die Kachel ausgeblendet dazu', () => {
  const bestand = widgets.DEFAULT_WIDGET_CONFIG
    .filter((w) => w.id !== 'pantry')
    .map((w, i) => ({ ...w, order: i }));
  const merged = widgets.normalizeDashboardConfig(bestand);
  const pantry = merged.find((w) => w.id === 'pantry');
  assert.ok(pantry, 'die neue Id wird ergänzt');
  assert.equal(pantry.visible, false, 'und zwar AUSgeblendet');
  // `isUserOrderedConfig` gibt es seit dem dichten Raster nicht mehr (a1); was
  // bleibt, ist die Default-Position des Neuzugangs: hinter dem Einkauf.
  const ids = merged.map((w) => w.id);
  assert.equal(ids.indexOf('pantry'), ids.indexOf('shopping') + 1, 'die Ergänzung steht an ihrer Default-Position');
});

test('Registrierung: Rechte hängen am Modul pantry', () => {
  assert.deepEqual(PERMISSION_WIDGETS.find((w) => w.id === 'pantry'), { id: 'pantry', module: 'pantry' },
    'ein gesperrter Vorrat muss auch die Kachel sperren (#467)');
});

test('Registrierung: die Rechteverwaltung nennt die Kachel; Dziś v2 zeigt keine Vorschaukachel', () => {
  // 2026-10-27, v2: Dziś zeichnet nur noch Wetter, Kalender, Aufgaben und
  // Wkrótce (Entwurf „Main"). Die Vorschaukachel des Vorrats, ihr Modulschalter
  // (MODULE_FOR_WIDGET) und ihre Beschriftung (widgetLabel) sind mit ihr
  // gegangen; die Felder der Route bleiben (Abschnitt unten), das Recht auch.
  const page = src('../public/pages/dashboard.js');
  assert.doesNotMatch(page, /MODULE_FOR_WIDGET|today\.pantryExpiring|\/pantry\?filter=soon/);
  const admin = src('../public/settings/pages/admin-permissions.js');
  assert.match(admin, /pantry: 'dashboard\.pantryExpiringTitle'/, 'die Rechteverwaltung nennt die Kachel beim selben Namen');
});

// --------------------------------------------------------------------------
// Server: echter Router gegen eine migrierte In-Memory-DB
// --------------------------------------------------------------------------

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');

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

const MEMBER = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
  VALUES (?, 'Mitglied', 'hash', '#7C3AED', 'member', 'parent')
`).run(`pantry-member-${randomUUID()}`).lastInsertRowid;

let tokenScopes = null;
const app = express();
app.use((req, _res, next) => {
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(MEMBER);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.session = { userId: user.id, role: user.role };
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(db, user));
  req.authScopes = tokenScopes;
  next();
});
app.use('/', dashboardRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

async function dashboard() {
  const res = await fetch(endpoint);
  assert.equal(res.status, 200);
  return res.json();
}

// Die Uhr steht fest - „heute" darf nicht mit dem Kalender kippen, und die
// Zonen-Tests brauchen einen Zeitpunkt, an dem Haushaltstag und UTC-Tag
// auseinanderfallen. Nur `Date` wird gemockt; die Timer des HTTP-Servers
// laufen weiter.
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

const LOC_FRIDGE = db.prepare("SELECT id FROM pantry_locations WHERE name = 'Kühlschrank'").get().id;

function seedItem(name, expiresOn, { quantity = 1, unit = 'pcs', location = LOC_FRIDGE, notes = null } = {}) {
  return db.prepare(`
    INSERT INTO pantry_items (name, quantity, unit, location_id, expires_on, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, quantity, unit, location, expiresOn, notes, MEMBER).lastInsertRowid;
}

function clearItems() {
  db.prepare('DELETE FROM pantry_items').run();
}

// Bezugstag des Haushalts in allen Payload-Tests: 2026-09-23 (Europe/Berlin,
// 12:00 Uhr - weit weg von jeder Tagesgrenze).
const NOON_BERLIN = '2026-09-23T10:00:00.000Z';

test('Payload: abgelaufen zuerst, dann nach Resttagen - mit days_left aus dem Haushaltstag', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  clearItems();
  seedItem('Joghurt', '2026-09-26');
  seedItem('Milch', '2026-09-22');
  seedItem('Sahne', '2026-09-23');
  seedItem('Quark', '2026-09-10');
  seedItem('Butter', '2026-09-24');

  const { pantryExpiring } = await dashboard();
  assert.deepEqual(pantryExpiring.items.map((i) => [i.name, i.days_left]), [
    ['Quark', -13], ['Milch', -1], ['Sahne', 0], ['Butter', 1], ['Joghurt', 3],
  ]);
  assert.equal(pantryExpiring.total, 5);
  assert.equal(pantryExpiring.expiredCount, 2);
  assert.equal(pantryExpiring.todayCount, 1);
}));

test('Payload: Horizont ist EXPIRY_SOON_DAYS inklusiv - Tag 7 drin, Tag 8 draussen', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  assert.equal(EXPIRY_SOON_DAYS, 7, 'Vorbedingung: die Schwelle der Vorratsseite');
  clearItems();
  seedItem('Tag sieben', '2026-09-30');
  seedItem('Tag acht', '2026-10-01');
  seedItem('In zwanzig Tagen', '2026-10-13');

  const { pantryExpiring } = await dashboard();
  assert.deepEqual(pantryExpiring.items.map((i) => i.name), ['Tag sieben'],
    'die Kachel zeigt genau das, was die Vorratsseite als „läuft bald ab" markiert');
  assert.equal(pantryExpiring.total, 1);
}));

test('Payload: ohne MHD und leere Chargen stehen nicht in der Liste', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  clearItems();
  seedItem('Salz', null);
  seedItem('Aufgebraucht', '2026-09-24', { quantity: 0 });
  seedItem('Eier', '2026-09-25', { quantity: 6 });

  const { pantryExpiring } = await dashboard();
  assert.deepEqual(pantryExpiring.items.map((i) => i.name), ['Eier'],
    'eine leere Charge hat nichts mehr, das ablaufen könnte');
  assert.equal(pantryExpiring.total, 1);
}));

test('Payload: die Liste ist gedeckelt, die Zahlen nicht', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  clearItems();
  for (let i = 0; i < 9; i += 1) seedItem(`Artikel ${i}`, i < 7 ? '2026-09-20' : '2026-09-23');

  const { pantryExpiring } = await dashboard();
  assert.equal(pantryExpiring.items.length, PANTRY_EXPIRING_ROW_CAP,
    'der Server liefert den Deckel der Liste, nicht mehr');
  assert.equal(pantryExpiring.total, 9, 'die Gesamtzahl zählt über den Deckel hinaus');
  assert.equal(pantryExpiring.expiredCount, 7);
  assert.equal(pantryExpiring.todayCount, 2);
  // Heute ablaufende stehen hinter sieben abgelaufenen und damit ausserhalb der
  // Liste - das Heute-Blatt bekommt sie trotzdem, aus einem eigenen Feld.
  assert.deepEqual(pantryExpiring.todayItems.map((i) => i.name).sort(), ['Artikel 7', 'Artikel 8']);
}));

test('Payload: schlank - nur die Felder, die Kachel und Heute-Blatt brauchen', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  clearItems();
  seedItem('Frischkäse', '2026-09-23', { quantity: 200, unit: 'g', notes: 'Notiz bleibt auf der Vorratsseite' });

  const { pantryExpiring } = await dashboard();
  assert.deepEqual(Object.keys(pantryExpiring.items[0]).sort(),
    ['days_left', 'expires_on', 'id', 'location_icon', 'location_name', 'name', 'quantity', 'unit']);
  assert.equal(pantryExpiring.items[0].location_name, 'Kühlschrank');
  assert.ok(!JSON.stringify(pantryExpiring).includes('Notiz bleibt'), 'Notizen reisen nicht mit');
  assert.deepEqual(pantryExpiring.todayItems, [{ id: pantryExpiring.items[0].id, name: 'Frischkäse', quantity: 200, unit: 'g' }]);
}));

// --------------------------------------------------------------------------
// 3. Tagesgrenze der Haushaltszone
// --------------------------------------------------------------------------

test('Zonenrand: 00:30 in Berlin ist schon der 24. - der UTC-Tag (23.) wäre falsch', withClock('2026-09-23T22:30:00.000Z', 'Europe/Berlin', async () => {
  clearItems();
  seedItem('Gestern', '2026-09-23');
  seedItem('Heute', '2026-09-24');
  seedItem('Tag sieben', '2026-10-01');

  const { pantryExpiring } = await dashboard();
  assert.deepEqual(pantryExpiring.items.map((i) => [i.name, i.days_left]),
    [['Gestern', -1], ['Heute', 0], ['Tag sieben', 7]],
    'nach UTC stünde „Gestern" auf heute und „Tag sieben" ausserhalb des Horizonts');
  assert.equal(pantryExpiring.expiredCount, 1);
  assert.equal(pantryExpiring.todayCount, 1);
}));

test('Zonenrand: 20:00 in Los Angeles ist noch der 23. - UTC ist dort schon am 24.', withClock('2026-09-24T03:00:00.000Z', 'America/Los_Angeles', async () => {
  clearItems();
  seedItem('Heute', '2026-09-23');
  seedItem('Morgen', '2026-09-24');

  const { pantryExpiring } = await dashboard();
  assert.deepEqual(pantryExpiring.items.map((i) => [i.name, i.days_left]), [['Heute', 0], ['Morgen', 1]]);
  assert.equal(pantryExpiring.expiredCount, 0, 'nach UTC wäre „Heute" schon abgelaufen');
}));

// --------------------------------------------------------------------------
// 4. Rechte
// --------------------------------------------------------------------------

function setModuleAccess(access) {
  db.prepare(`
    INSERT OR REPLACE INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'pantry', ?)
  `).run(String(MEMBER), access);
}

function clearModuleAccess() {
  db.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(MEMBER));
}

const EMPTY = { items: [], todayItems: [], total: 0, expiredCount: 0, todayCount: 0 };

test('Rechte: Vorrat auf none liefert die leere Form, kein Name auf der Leitung', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  clearItems();
  seedItem('Geheimer Kuchen', '2026-09-23');
  assert.equal((await dashboard()).pantryExpiring.total, 1, 'Vorbedingung: ohne Sperre steht er da');

  setModuleAccess('none');
  try {
    const body = await dashboard();
    assert.deepEqual(body.pantryExpiring, EMPTY);
    assert.ok(!JSON.stringify(body).includes('Geheimer Kuchen'));
  } finally {
    clearModuleAccess();
  }
}));

test('Rechte: nur lesen ist keine Sperre', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  clearItems();
  seedItem('Brot', '2026-09-24');
  setModuleAccess('read');
  try {
    assert.equal((await dashboard()).pantryExpiring.items[0]?.name, 'Brot');
  } finally {
    clearModuleAccess();
  }
}));

test('Rechte: ein Token ohne pantry-Scope bekommt die leere Form, mit pantry:read die Liste', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  clearItems();
  seedItem('Brot', '2026-09-24');
  tokenScopes = ['dashboard:read'];
  try {
    assert.deepEqual((await dashboard()).pantryExpiring, EMPTY);
    tokenScopes = ['dashboard:read', 'pantry:read'];
    assert.equal((await dashboard()).pantryExpiring.items[0]?.name, 'Brot');
  } finally {
    tokenScopes = null;
  }
}));

test('Fehlerpfad: eine scheiternde Vorratsabfrage setzt null und lässt den Rest stehen', withClock(NOON_BERLIN, 'Europe/Berlin', async () => {
  db.exec('ALTER TABLE pantry_items RENAME TO pantry_items_unavailable');
  try {
    const body = await dashboard();
    assert.equal(body.pantryExpiring, null, 'null ist der Fehler-Sentinel: die Kachel zeigt „erneut versuchen"');
    assert.ok(Array.isArray(body.users), 'der Rest der Übersicht kommt an');
  } finally {
    db.exec('ALTER TABLE pantry_items_unavailable RENAME TO pantry_items');
  }
}));

// --------------------------------------------------------------------------
// Der Filter-Deep-Link der Vorratsseite
// --------------------------------------------------------------------------

test('Vorratsseite: ?filter= öffnet den passenden Chip, Unbekanntes bleibt bei „Alle"', () => {
  assert.equal(pantryFilterFromSearch('?filter=expired'), 'expired');
  assert.equal(pantryFilterFromSearch('?filter=soon'), 'soon');
  assert.equal(pantryFilterFromSearch('?filter=low'), 'low');
  assert.equal(pantryFilterFromSearch('?filter=__proto__'), null);
  assert.equal(pantryFilterFromSearch(''), null);
  const page = src('../public/pages/pantry.js');
  assert.match(page, /pantryFilterFromSearch\(window\.location\.search\)/, 'die Seite liest den Link beim Rendern');
});

// --------------------------------------------------------------------------
// Tagesplan von Dziś: „Läuft heute ab" dockt am Beitrags-Vertrag an (Integration)
// --------------------------------------------------------------------------

/* Was HEUTE abläuft, ist eine Sache von heute. Dziś baut seinen Plan
 * (utils/today-plan.js) und nimmt die Zeilen der übrigen Module über den
 * Beitrags-Vertrag von utils/today-sheet.js: die Quelle spricht nach denselben
 * Riegeln wie jede andere (Modul an, Modulrecht, Widget-Recht). Das Kein-Echo
 * gegen die Vorrats-Kachel gibt es nicht mehr - Dziś hat keine Modulkacheln
 * (TAFLA, 2026-10-19), der Plan fragt ohne Anordnung. */
const { setPermissions, clearPermissions } = await import('../public/permissions.js');

function withSheet(perms, fn) {
  const prevWindow = global.window;
  global.window = { yuvomi: { isModuleDisabled: () => false } };
  setPermissions({ admin: false, modules: {}, widgets: {}, capabilities: {}, ...perms });
  try {
    return fn();
  } finally {
    clearPermissions();
    global.window = prevWindow;
  }
}

const expiringToday = (names, todayCount = names.length) => ({
  items: [], total: todayCount, expiredCount: 0, todayCount,
  todayItems: names.map((name, i) => ({ id: i + 1, name, quantity: 1, unit: 'l' })),
});
const birthdayToday = [{ id: 9, name: 'Oma Erna', days_until: 0, kind: 'birthday' }];
const plan = (data) => buildPlan(data, planContext({
  now: new Date('2026-09-23T10:00:00.000Z'),
  moduleOff: (module) => Boolean(global.window?.yuvomi?.isModuleDisabled?.(module)),
}));
const pantryRows = (p) => p.all.filter((row) => row.sourceKind === 'pantry');

test('Tagesplan: was heute abläuft, steht als eine offene Zeile im Plan', () => withSheet({}, () => {
  const p = plan({ birthdays: birthdayToday, pantryExpiring: expiringToday(['Milch', 'Joghurt']) });
  const rows = pantryRows(p);
  assert.equal(rows.length, 1, `zwei Chargen von heute sind eine Zeile, erhalten: ${p.all.map((r) => r.sourceKind ?? r.kind)}`);
  assert.match(rows[0].title, /Milch.*Joghurt/);
  assert.match(rows[0].meta, /pantry\.badgeExpiresToday/, 'der Text ist der der Vorratsseite (pantryExpiryPhrase(0))');
  assert.match(rows[0].route, /^\/pantry\?filter=soon$/, 'die Zeile öffnet den Vorrat mit dem passenden Filter');
  assert.ok(p.open.includes(rows[0]), 'sie steht offen im Tag, nicht unter „Wcześniej"');

  const nothing = plan({ birthdays: birthdayToday, pantryExpiring: expiringToday([]) });
  assert.equal(pantryRows(nothing).length, 0, 'Gegenprobe: ohne Ablauf keine Zeile');
}));

test('Tagesplan: mehr als die gelieferten Chargen - der Rest steht als Zahl da', () => withSheet({}, () => {
  const p = plan({ pantryExpiring: expiringToday(['A', 'B', 'C', 'D', 'E'], 7) });
  assert.match(pantryRows(p)[0].title, /pantryExpiringMore.*"count":2/, 'todayCount ist ungedeckelt, die Liste nicht');
}));

test('Tagesplan: Rechte, Widget-Recht und Modulschalter halten die Zeile zurück', () => {
  const data = { pantryExpiring: expiringToday(['Milch']) };
  withSheet({}, () => {
    assert.equal(pantryRows(plan(data)).length, 1, 'Vorbedingung: ohne Riegel spricht die Quelle');
  });
  withSheet({ modules: { pantry: 'none' } }, () => {
    assert.equal(pantryRows(plan(data)).length, 0, 'ohne Vorratsrecht keine Zeile');
  });
  withSheet({ widgets: { pantry: 'none' } }, () => {
    assert.equal(pantryRows(plan(data)).length, 0, 'gesperrtes Widget heisst auch: keine Zeile (#467)');
  });
  withSheet({}, () => {
    global.window = { yuvomi: { isModuleDisabled: (m) => m === 'pantry' } };
    assert.equal(pantryRows(plan(data)).length, 0, 'abgeschaltetes Modul spricht nicht');
  });
  withSheet({}, () => {
    assert.equal(pantryRows(plan({ pantryExpiring: null })).length, 0, 'ein Ladefehler (null) ist keine Zeile');
  });
});
