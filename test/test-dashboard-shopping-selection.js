/**
 * Modul: Uebersicht - welche Einkaufslisten die Einkaufs-Kachel zeigt (#1818, aus D#1624)
 * Zweck: Die Kachel zeigte die drei zuletzt geaenderten Listen mit Offenem, und
 *        welche das sind, war keine Wahl. Seit #1818 bietet der Optionen-Dialog
 *        der Kachel "alle Listen" (nichts gespeichert, Verhalten wie zuvor) oder
 *        eine Auswahl bestimmter Listen, je Person. Geprueft wird der ganze Weg:
 *
 *        1. Route: `shopping_list` fuellt ein EIGENES Feld (`shoppingTile`):
 *           die gewaehlten Listen vor dem Deckel, die offenen Artikel darin und
 *           die Zahl der gewaehlten Listen. Die geteilten Felder
 *           (`shoppingLists`, `shoppingOpenCount`, `shoppingOpenLists`) bleiben
 *           ungefiltert - die Auswahl gilt NUR der Kachel. Eine gewaehlte Liste
 *           steht auch ohne Offenes da. Geloeschte und erfundene Ids fallen
 *           weg; bleibt keine uebrig, antwortet die Route wie ohne Parameter -
 *           nie leer, nie ein Fehler. Wer Einkauf nicht sehen darf, bekommt die
 *           leere Fassung, was immer der Parameter nennt.
 *        2. Ablage: die Auswahl geht durch `PUT /preferences`, gehoert der
 *           Person und reist mit der Haushaltsvorgabe.
 *        3. Browser: die Anfrage traegt die Auswahl, der Parameter aendert
 *           keine Zahl der Navigation; der Dialog zeigt die Listen, hakt die
 *           gespeicherten an, speichert nur eine echte Auswahl, und sein echter
 *           Lader laesst bei einem Fehler die Auswahl stehen.
 *        4. Dziś und Wand: mit gesetzter Auswahl dieselbe Zahl wie ohne, und
 *           zwar die des Servers ueber alle Listen.
 *
 *        TAFLA (2026-10-24): die Einkaufs-Kachel des alten Rasters
 *        (renderShoppingTile) und das Heute-Blatt (buildTodayCockpitModel)
 *        sind gegangen, ihre Tests mit ihnen. Dziś zeigt den Einkauf als
 *        Abschnitt, die Wand als Karte (utils/wall-plan.js) - beide lesen die
 *        ungefilterten Felder.
 *
 * Ausfuehren: npm run test:dashboard-shopping-selection
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { register } from 'node:module';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

register('./test-browser-loader.mjs', import.meta.url);

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'dashboard-shopping-selection-test-secret';

const { resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: dashboardRouter, normalizeShoppingListFilter } = await import('../server/routes/dashboard.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');
const { dashboardPaths } = await import('../server/openapi/paths/dashboard.js');
const widgets = await import('../public/utils/dashboard-widgets.js');

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
const ADMIN = Number(addUser.run(`shop-admin-${randomUUID()}`, 'Anna', 'admin', 'parent').lastInsertRowid);
const LEO = Number(addUser.run(`shop-leo-${randomUUID()}`, 'Leo', 'member', 'child').lastInsertRowid);

let currentUser = ADMIN;
/** Ein gekoppeltes Display: Methode und Scopes wie `requireAuth` sie setzt, sonst null. */
let displayScopes = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(currentUser);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.session = { userId: user.id, role: user.role };
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(db, user));
  if (displayScopes) { req.authMethod = 'display'; req.authScopes = displayScopes; }
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

// --------------------------------------------------------------------------
// Die Saat: fuenf Listen. Vier mit Offenem, in dieser Reihenfolge zuletzt
// geaendert (juengste zuerst): Drogerie, Baumarkt, Wocheneinkauf, Garten.
// "Fest" ist vollstaendig abgehakt - ohne Auswahl steht sie nie auf der Kachel.
// --------------------------------------------------------------------------
const insertList = db.prepare('INSERT INTO shopping_lists (name, created_by, updated_at) VALUES (?, ?, ?)');
const insertItem = db.prepare('INSERT INTO shopping_items (list_id, name, is_checked) VALUES (?, ?, ?)');
function addList(name, updatedAt, open, done = 0) {
  const id = Number(insertList.run(name, ADMIN, updatedAt).lastInsertRowid);
  for (let i = 0; i < open; i += 1) insertItem.run(id, `${name} offen ${i + 1}`, 0);
  for (let i = 0; i < done; i += 1) insertItem.run(id, `${name} erledigt ${i + 1}`, 1);
  // KEIN nachtraegliches UPDATE: `trg_shopping_lists_updated_at` schreibt bei
  // jeder Aenderung der Liste "jetzt" hinein und ebnete die Saat ein.
  return id;
}
const GARTEN = addList('Garten', '2026-10-01T08:00:00Z', 1);
const WOCHE = addList('Wocheneinkauf', '2026-10-02T08:00:00Z', 8, 2);
const BAUMARKT = addList('Baumarkt', '2026-10-03T08:00:00Z', 2);
const DROGERIE = addList('Drogerie', '2026-10-04T08:00:00Z', 3);
const FEST = addList('Fest', '2026-10-05T08:00:00Z', 0, 4);

const names = (body) => body.shoppingLists.map((list) => list.name);
const numbers = (body) => [body.shoppingOpenCount, body.shoppingOpenLists];
/** Die Fassung der Kachel: Namen, offene Artikel in der Auswahl, gewaehlte Listen. */
const tileNames = (body) => body.shoppingTile?.lists.map((list) => list.name) ?? null;
const tileNumbers = (body) => (body.shoppingTile ? [body.shoppingTile.openCount, body.shoppingTile.listCount] : null);
const query = (...ids) => `/?${ids.map((id) => `shopping_list=${id}`).join('&')}`;
/** Was jeder ANDERE Leser sieht: die drei geteilten Felder, ganz. */
const shared = (body) => JSON.stringify([body.shoppingLists, body.shoppingOpenCount, body.shoppingOpenLists]);

// --------------------------------------------------------------------------
// 1. Die Route
// --------------------------------------------------------------------------

test('ohne shopping_list bleibt die Antwort wie zuvor: drei Listen mit Offenem, die juengste zuerst', async () => {
  const body = await getJson('/');
  assert.deepEqual(names(body), ['Drogerie', 'Baumarkt', 'Wocheneinkauf']);
  assert.deepEqual(numbers(body), [14, 4], 'gezaehlt wird ueber alle Listen');
  assert.ok(!names(body).includes('Fest'), 'eine ganz abgehakte Liste steht ohne Auswahl nicht da');
  assert.equal('shoppingTile' in body, false, 'ohne Auswahl gibt es keine eigene Kachel-Fassung');
});

test('mit Auswahl traegt die Kachel-Fassung nur die gewaehlten Listen - auch wenn eine andere juenger ist', async () => {
  const body = await getJson(query(GARTEN, WOCHE));
  // Garten ist die aelteste der vier und stand ohne Auswahl hinter dem Deckel.
  assert.deepEqual(tileNames(body), ['Wocheneinkauf', 'Garten']);
  assert.deepEqual(tileNumbers(body), [9, 2], 'und die Zahlen der Kachel zaehlen in der Auswahl');
  assert.deepEqual(body.shoppingTile.lists[0].items.length, 6, 'der Deckel von sechs Artikeln bleibt');
});

test('die Auswahl gilt NUR der Kachel: was Wand, Heute-Blatt und Navigation lesen, bleibt ungefiltert', async () => {
  // Der Fehler der ersten Fassung: die Auswahl filterte `shoppingLists` und
  // `shoppingOpenCount`. Das Wandtablet eines Haushalts, dessen Vorgabe eine
  // Liste waehlt, zeigte "1 offen" bei vierzehn - und mit nur der fertig
  // gekauften Liste verschwand die Zeile ganz.
  const plain = await getJson('/');
  for (const path of [query(GARTEN), query(FEST), query(GARTEN, WOCHE), query(FEST, GARTEN, WOCHE, BAUMARKT, DROGERIE)]) {
    const body = await getJson(path);
    assert.equal(shared(body), shared(plain), `${path}: die geteilten Felder sind die der ungefilterten Antwort`);
    assert.deepEqual(numbers(body), [14, 4], path);
  }
});

test('eine einzelne Liste: der Parameter als einzelner Wert', async () => {
  const body = await getJson(query(GARTEN));
  assert.deepEqual(tileNames(body), ['Garten']);
  assert.deepEqual(tileNumbers(body), [1, 1]);
});

test('eine gewaehlte Liste ohne Offenes bleibt stehen, hinter denen mit Offenem', async () => {
  // "Fest" ist die juengste Liste - ohne die Regel "Offenes zuerst" stuende
  // sie vorn und draengte am Deckel eine volle Liste hinaus.
  const body = await getJson(query(FEST, GARTEN));
  assert.deepEqual(tileNames(body), ['Garten', 'Fest']);
  const fest = body.shoppingTile.lists.find((list) => list.name === 'Fest');
  assert.deepEqual([fest.open_count, fest.total_count, fest.items.length], [0, 4, 0]);
  assert.deepEqual(tileNumbers(body), [1, 2], 'ein offener Artikel, ZWEI gewaehlte Listen - auch die leere zaehlt als Liste');

  const only = await getJson(query(FEST));
  assert.deepEqual(tileNames(only), ['Fest'], 'auch allein: die Kachel ist nicht leer');
  assert.deepEqual(tileNumbers(only), [0, 1]);
});

test('der Deckel von drei Listen bleibt, und JEDE gewaehlte Liste zaehlt - auch die abgeschnittene ohne Offenes', async () => {
  // Vier gewaehlt, drei mit Offenem, eine fertig gekauft: drei stehen da, und
  // `listCount` sagt vier - daraus macht die Kachel "+1 weitere Liste". Zaehlte
  // die Route nur Listen mit Offenem, fehlte "Fest" stumm.
  const four = await getJson(query(FEST, GARTEN, WOCHE, BAUMARKT));
  assert.deepEqual(tileNames(four), ['Baumarkt', 'Wocheneinkauf', 'Garten']);
  assert.deepEqual(tileNumbers(four), [11, 4]);

  const five = await getJson(query(FEST, GARTEN, WOCHE, BAUMARKT, DROGERIE));
  assert.deepEqual(tileNames(five), ['Drogerie', 'Baumarkt', 'Wocheneinkauf']);
  assert.deepEqual(tileNumbers(five), [14, 5]);
});

test('eine geloeschte Liste in der Auswahl faellt weg, die uebrigen bleiben', async () => {
  const gone = addList('Wird geloescht', '2026-10-06T08:00:00Z', 2);
  assert.deepEqual(tileNames(await getJson(query(gone, GARTEN))), ['Wird geloescht', 'Garten']);
  db.prepare('DELETE FROM shopping_lists WHERE id = ?').run(gone);
  const body = await getJson(query(gone, GARTEN));
  assert.deepEqual(tileNames(body), ['Garten']);
  assert.deepEqual(tileNumbers(body), [1, 1], 'die geloeschte zaehlt auch nicht als "+1"');
});

test('ist JEDE gewaehlte Liste geloescht, antwortet die Route wie ohne Auswahl - nie leer', async () => {
  const gone = addList('Auch geloescht', '2026-10-07T08:00:00Z', 1);
  db.prepare('DELETE FROM shopping_lists WHERE id = ?').run(gone);
  const plain = await getJson('/');
  const body = await getJson(query(gone));
  assert.equal('shoppingTile' in body, false, 'keine Kachel-Fassung: die Kachel zeigt alle Listen');
  assert.equal(shared(body), shared(plain));
  assert.deepEqual(names(body), ['Drogerie', 'Baumarkt', 'Wocheneinkauf']);
});

test('was keine Id ist oder keine Liste nennt, antwortet wie kein Parameter - nie mit einem Fehler', async () => {
  const plain = await getJson('/');
  const outside = [
    'shopping_list=', 'shopping_list=abc', 'shopping_list=0', 'shopping_list=-1', 'shopping_list=1.5',
    'shopping_list=1e3', 'shopping_list=%201', 'shopping_list=999999', 'shopping_list=99999999999999999999',
    `shopping_list=${GARTEN}abc`, 'shopping_list=1%20OR%201=1', "shopping_list=1'--",
    // Klammer-Schreibweisen: je nach Query-Parser ein Objekt, ein Array oder
    // ein anderer Schluessel - der Browser schreibt sie nie, keine gilt.
    `shopping_list[a]=${GARTEN}`, `shopping_list[]=${GARTEN}`,
  ];
  for (const raw of outside) {
    const body = await getJson(`/?${raw}`);
    assert.equal('shoppingTile' in body, false, raw);
    assert.equal(shared(body), shared(plain), raw);
  }
  // Unsinn NEBEN einer echten Id: die echte gilt.
  assert.deepEqual(tileNames(await getJson(`/?shopping_list=abc&shopping_list=${GARTEN}&shopping_list=999999`)), ['Garten']);
});

test('normalizeShoppingListFilter: positive ganze Zahlen, ohne Doppelte, hoechstens 50', () => {
  assert.deepEqual(normalizeShoppingListFilter(undefined), []);
  assert.deepEqual(normalizeShoppingListFilter('7'), [7]);
  assert.deepEqual(normalizeShoppingListFilter(['7', '3', '7']), [7, 3]);
  assert.deepEqual(normalizeShoppingListFilter(['7', 'abc', '', '0', '-1', '07', '1.5', { a: '1' }, 4]), [7]);
  assert.deepEqual(normalizeShoppingListFilter({ a: '1' }), []);
  assert.equal(normalizeShoppingListFilter(Array.from({ length: 80 }, (_, i) => String(i + 1))).length, 50);
});

test('wer Einkauf nicht sehen darf, bekommt die leere Fassung - mit und ohne Auswahl', async () => {
  const lock = () => db.prepare(`
    INSERT OR REPLACE INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'shopping', 'none')
  `).run(String(LEO));
  const unlock = () => db.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(LEO));
  currentUser = LEO;
  try {
    // Gegenprobe ohne Sperre: Leo sieht die gewaehlte Liste - sonst sagte die
    // leere Antwort unten nichts ueber die Sperre.
    assert.deepEqual(tileNames(await getJson(query(GARTEN))), ['Garten']);
    lock();
    assert.equal(resolvePermissions(db, db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(LEO)).modules.shopping, 'none',
      'Vorbedingung: der Einkauf ist fuer Leo gesperrt');
    for (const path of ['/', query(GARTEN), query(GARTEN, WOCHE, FEST)]) {
      const body = await getJson(path);
      assert.deepEqual(body.shoppingLists, [], path);
      assert.deepEqual(numbers(body), [0, 0], path);
      assert.equal('shoppingTile' in body, false, `${path}: auch keine Kachel-Fassung`);
      assert.ok(!JSON.stringify(body).includes('Garten'), `${path}: kein Listenname in der Antwort`);
    }
  } finally {
    unlock();
    currentUser = ADMIN;
  }
});

// TAFLA (2026-10-19): HIER STAND „ein gekoppeltes Display bekommt keinen
// Einkauf". Die Kuechenwand zeigt seitdem die Einkaufskarte („23 na liście ·
// mleko · śmietanka"), das Display liest den Einkauf (`shopping:read`,
// display-scopes.js). Was bleibt: es liest ihn nur LESEND und genau so, wie ein
// Mitglied ihn liest - dieselben Listen, dieselben Zahlen, auch mit der
// Auswahl der Haushaltsvorgabe.
test('ein gekoppeltes Display liest den Einkauf wie ein Mitglied - auch ueber die Auswahl der Haushaltsvorgabe', async () => {
  const { DISPLAY_SCOPES } = await import('../server/services/display-accounts.js');
  assert.ok(DISPLAY_SCOPES.includes('shopping:read'), 'Vorbedingung: das Display liest den Einkauf');
  assert.ok(!DISPLAY_SCOPES.includes('shopping:write'), 'und schreibt ihn nicht ueber ein Modul-Recht');
  const plain = {};
  for (const path of ['/', query(GARTEN), query(GARTEN, FEST)]) plain[path] = await getJson(path);
  displayScopes = [...DISPLAY_SCOPES];
  try {
    for (const path of ['/', query(GARTEN), query(GARTEN, FEST)]) {
      const body = await getJson(path);
      assert.deepEqual(body.shoppingLists, plain[path].shoppingLists, path);
      assert.deepEqual(numbers(body), numbers(plain[path]), path);
      assert.deepEqual(tileNames(body), tileNames(plain[path]), path);
    }
  } finally {
    displayScopes = null;
  }
});

test('OpenAPI beschreibt den Parameter', () => {
  const parameter = dashboardPaths()['/api/v1/dashboard'].get.parameters.find((item) => item.name === 'shopping_list');
  assert.ok(parameter);
  assert.equal(parameter.in, 'query');
  assert.equal(parameter.schema.type, 'array');
  assert.equal(parameter.schema.items.type, 'integer');
  assert.equal(parameter.schema.items.minimum, 1);
  assert.equal(parameter.schema.maxItems, 50);
});

// --------------------------------------------------------------------------
// 2. Die Ablage: je Person, mit Haushaltsvorgabe
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
const shoppingTile = (options, visible = true) => [{ id: 'shopping', visible, order: 0, size: '1x2', ...(options ? { options } : {}) }];
const shoppingOptions = (config) => config.find((w) => w.id === 'shopping')?.options;

test('die Auswahl ueberlebt das Speichern, gehoert der Person und aendert nichts fuer die andere', async () => {
  clearDashboardPreferences();
  try {
    currentUser = ADMIN;
    assert.equal(await writePrefs({ dashboard_widgets: shoppingTile({ lists: [GARTEN, WOCHE] }) }), 200);
    const mine = (await readPrefs()).dashboard_widgets;
    assert.deepEqual(shoppingOptions(mine), { lists: [GARTEN, WOCHE] });
    assert.equal(widgets.dashboardQuery(mine), `/dashboard?shopping_list=${GARTEN}&shopping_list=${WOCHE}`);
    // Der ganze Weg: gespeicherte Anordnung -> Anfrage -> Antwort.
    assert.deepEqual(tileNames(await getJson(widgets.dashboardQuery(mine).replace('/dashboard', '/'))), ['Wocheneinkauf', 'Garten']);

    currentUser = LEO;
    const theirs = (await readPrefs()).dashboard_widgets;
    assert.deepEqual(theirs, [], 'Leos Anordnung bleibt unberuehrt');
    const leo = await getJson(widgets.dashboardQuery(theirs).replace('/dashboard', '/'));
    assert.equal(tileNames(leo), null, 'und Leo hat keine Kachel-Fassung');
    assert.deepEqual(names(leo), ['Drogerie', 'Baumarkt', 'Wocheneinkauf'], 'er sieht weiter alle Listen');
  } finally {
    currentUser = ADMIN;
    clearDashboardPreferences();
  }
});

test('die Vorgabe des Haushalts traegt die Auswahl, eine eigene Anordnung loest sie ab', async () => {
  clearDashboardPreferences();
  try {
    currentUser = ADMIN;
    assert.equal(await writePrefs({ dashboard_widgets_default: shoppingTile({ lists: [DROGERIE] }) }), 200);
    currentUser = LEO;
    assert.deepEqual(shoppingOptions((await readPrefs()).dashboard_widgets), { lists: [DROGERIE] });
    assert.equal(await writePrefs({ dashboard_widgets: shoppingTile() }), 200);
    assert.equal(shoppingOptions((await readPrefs()).dashboard_widgets), undefined);
  } finally {
    currentUser = ADMIN;
    clearDashboardPreferences();
  }
});

// --------------------------------------------------------------------------
// 3. Der Browser: Anfrage, Dialog, Kachel
// --------------------------------------------------------------------------

test('dashboardQuery: die Auswahl reist als wiederholter Parameter, wie jede andere Option', () => {
  const q = (options, visible) => widgets.dashboardQuery(shoppingTile(options, visible));
  assert.equal(q(undefined), '/dashboard');
  assert.equal(q({ lists: [] }), '/dashboard', 'keine Auswahl heisst alle und steht in keiner Anfrage');
  assert.equal(q({ lists: [7] }), '/dashboard?shopping_list=7');
  assert.equal(q({ lists: [7, 3] }), '/dashboard?shopping_list=7&shopping_list=3');
  assert.equal(q({ lists: ['7', 7, 'abc', 0, -2, 1.5, null] }), '/dashboard?shopping_list=7', 'Fremdwerte im Layout werden nicht zur Anfrage');
  assert.equal(q({ lists: 'alle' }), '/dashboard');
  // Keine Sichtbarkeits-Bedingung im Browser: die Route haelt die Auswahl von
  // allem ausser der Kachel fern, also braucht hier niemand daran zu denken.
  assert.equal(q({ lists: [7] }, false), '/dashboard?shopping_list=7');
});

test('die Auswahl filtert keine Zahl der Navigation: kein zweiter Abruf, und die Badge zaehlt alle Listen', async () => {
  // Die Antwort der Seite gilt fuer die Navigation als ungefiltert ...
  assert.equal(widgets.dashboardQueryFiltersCounts('/dashboard?shopping_list=7'), false);
  assert.equal(widgets.dashboardQueryFiltersCounts('/dashboard?shopping_list=7&events_limit=8'), false);
  // (Reichweite: ein echter Filter daneben bleibt einer.)
  assert.equal(widgets.dashboardQueryFiltersCounts('/dashboard?shopping_list=7&tasks_category=x'), true);
  // ... und sie IST es: die Zahl, die die Badge liest, ist mit Auswahl dieselbe.
  const plain = await getJson('/');
  const picked = await getJson(query(GARTEN));
  assert.equal(picked.shoppingOpenCount, 14);
  assert.equal(picked.shoppingOpenCount, plain.shoppingOpenCount);
});

const { __test: dash } = await import('../public/pages/dashboard.js');

/** Den Dialog oeffnen, ohne DOM: der Stub faengt Inhalt und Speichern-Handler. */
async function openShoppingDialog(current, { lists, picked = [] }) {
  let content = null;
  let submit = null;
  const toasts = [];
  const prev = { open: globalThis.__openModal, close: globalThis.__closeModal, window: globalThis.window };
  const field = (selector) => {
    if (selector === '[data-action="cancel"]') return { addEventListener() {} };
    if (selector === '#widget-options-form') return { addEventListener: (_type, handler) => { submit = handler; } };
    return null;
  };
  globalThis.window = { yuvomi: { showToast: (message, type) => toasts.push([message, type]) } };
  globalThis.__openModal = (config) => {
    content = config.content;
    config.onSave({
      querySelector: field,
      querySelectorAll: (selector) => (selector === 'input[name="shopping-list"]:checked' ? picked.map((value) => ({ value: String(value) })) : []),
    });
  };
  globalThis.__closeModal = () => true;
  try {
    const result = dash.openWidgetOptions('shopping', current, { loadLists: async () => lists });
    await Promise.resolve();
    await Promise.resolve();
    if (content === null) return { content, saved: await result, toasts };
    assert.equal(typeof submit, 'function', 'der Dialog hat keinen Speichern-Handler verdrahtet');
    submit({ preventDefault() {} });
    return { content, saved: await result, toasts };
  } finally {
    globalThis.__openModal = prev.open;
    globalThis.__closeModal = prev.close;
    globalThis.window = prev.window;
  }
}
const choices = (content) => [...content.matchAll(/<input type="checkbox" name="shopping-list" value="(\d+)"\s+(checked)?>\s*<span>([^<]*)<\/span>/g)]
  .map((m) => ({ id: Number(m[1]), checked: Boolean(m[2]), name: m[3] }));
const CATALOG = [{ id: 1, name: 'Wocheneinkauf' }, { id: 7, name: 'Drogerie & "Bad"' }, { id: 9, name: 'Baumarkt' }];

/** Der Dialog mit dem ECHTEN Lader: nur die Netzschicht (`api.get`) ist ersetzt. */
async function openWithRealLoader(current, get) {
  const prev = { stub: globalThis.__apiStub, open: globalThis.__openModal, close: globalThis.__closeModal, window: globalThis.window };
  const calls = [];
  const toasts = [];
  let opened = false;
  globalThis.__apiStub = { get: (...args) => { calls.push(args); return get(...args); } };
  globalThis.__openModal = () => { opened = true; };
  globalThis.__closeModal = () => true;
  globalThis.window = { yuvomi: { showToast: (message, type) => toasts.push([message, type]) } };
  try {
    const pending = dash.openWidgetOptions('shopping', current);
    // Geht der Dialog auf, wartet er auf Speichern oder Schliessen; die Probe
    // braucht dann nur, DASS er aufging.
    const result = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve('offen'), 20))]);
    return { result, calls, toasts, opened };
  } finally {
    globalThis.__apiStub = prev.stub;
    globalThis.__openModal = prev.open;
    globalThis.__closeModal = prev.close;
    globalThis.window = prev.window;
  }
}

// --------------------------------------------------------------------------
// 4. Was die Auswahl NICHT anfasst: Dziś und Wand
// --------------------------------------------------------------------------

const { buildWall } = await import('../public/utils/wall-plan.js');

/** Die Einkaufskarte der Wand, gebaut wie die Seite sie baut - am Tag, nicht in der Nacht. */
async function wallShopping(data) {
  const { setPermissions, clearPermissions } = await import('../public/permissions.js');
  const prevWindow = globalThis.window;
  globalThis.window = { yuvomi: { isModuleDisabled: () => false }, matchMedia: () => ({ matches: false }) };
  setPermissions({ admin: true, modules: {}, widgets: {}, capabilities: {} });
  try {
    return buildWall(data, { now: new Date('2026-10-06T11:00:00Z') }).shopping;
  } finally {
    clearPermissions();
    globalThis.window = prevWindow;
  }
}

test('Dziś und Wand zaehlen ueber ALLE Listen - auch wenn ein Layout eine Auswahl traegt', async () => {
  // Das Kuechentablett, das einer Haushaltsvorgabe mit Auswahl folgt: die Wand
  // liest dieselbe Antwort. Mit der ersten Fassung: "1" bei einer gewaehlten
  // Liste, und mit nur der fertig gekauften verschwand der Einkauf.
  for (const path of ['/', query(GARTEN), query(FEST), query(GARTEN, WOCHE)]) {
    const card = await wallShopping(await getJson(path));
    assert.ok(card, `${path}: die Einkaufskarte steht da`);
    assert.equal(card.count, 14, `${path}: die Zahl des Servers ueber alle Listen`);
  }
  // Die Zahl des Servers, nicht die Summe der drei gelieferten Listen (Bestand
  // vor #1818: 13 bei vierzehn offenen in vier Listen).
  const plain = await getJson('/');
  assert.equal(plain.shoppingLists.reduce((sum, list) => sum + list.open_count, 0), 13, 'Vorbedingung: die Summe der drei ist kleiner');
  assert.equal((await wallShopping(plain)).count, 14);
  // Dziś liest dieselben Felder (buildTodayState in pages/dashboard.js).
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  assert.match(page, /count: Number\(data\?\.shoppingOpenCount\) \|\| 0,/, 'Dziś zaehlt mit der Zahl des Servers');
  assert.match(page, /route: shoppingSoleListRoute\(data\),/, 'und waehlt sein Ziel aus den ungefilterten Listen');
});

test('der Einkauf von Dziś waehlt sein Ziel aus den UNGEFILTERTEN Listen (#1821)', async () => {
  // `/shopping?list=<id>` gilt, wenn im HAUSHALT genau eine Liste Offenes hat -
  // nicht, wenn ein Layout genau eine Liste gewaehlt hat. Hier haben vier Listen
  // Offenes: das Ziel bleibt die Seite, auch mit einer einzelnen gewaehlten.
  // Filterte die Route die geteilten Felder, stuende hier `?list=<Garten>`.
  for (const path of ['/', query(GARTEN), query(FEST)]) {
    assert.equal(dash.shoppingSoleListRoute(await getJson(path)), '/shopping', path);
  }
  // Reichweite: mit genau einer Liste mit Offenem im Haushalt ist sie das Ziel -
  // auch wenn das Layout eine ANDERE gewaehlt hat.
  const one = { shoppingLists: [{ id: 7, name: 'Drogerie', open_count: 2, total_count: 2, items: [] }], shoppingOpenCount: 2, shoppingOpenLists: 1,
    shoppingTile: { lists: [{ id: 9, name: 'Fest', open_count: 0, total_count: 1, items: [] }], openCount: 0, listCount: 1 } };
  assert.equal(dash.shoppingSoleListRoute(one), '/shopping?list=7');
});
