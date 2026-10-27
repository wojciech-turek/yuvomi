/**
 * Modul: Belohnungen-Widget der Uebersicht (Critique 2026-09-23, Persona Emma)
 * Zweck: Das Widget zeigte jedem Betrachter eine Rangliste der Geschwister
 *        ("1 Leo 60 / 2 Emma 30"). Aus Sicht eines neunjaehrigen Kindes ist
 *        das Wettbewerb statt Fortschritt. Diese Suite haelt die drei Sichten
 *        fest, die das Widget seitdem kennt:
 *          - wer freigeben darf (dieselbe Rolle, die das Modul fuer
 *            "Bestaetigen/Ablehnen" fragt: isAdminRequest), sieht jedes
 *            teilnehmende Kind nebeneinander, ohne Platz, plus die offenen
 *            Freigaben;
 *          - wer selbst Punkte sammelt und nicht freigibt, sieht NUR sich:
 *            Stand, Fortschritt zur naechsten Praemie, zuletzt Verdientes;
 *          - wer weder das eine noch das andere ist (Wandtablett, Grosseltern
 *            ohne Teilnahme), sieht die Familie ohne Platz und ohne Freigaben.
 *        Server (Auswahl der Daten) und Anzeige werden getrennt geprueft: eine
 *        Anzeige, die nur die eigene Zeile zeigt, waehrend die Antwort alle
 *        Kinder mitliefert, waere eine Rangliste im Netzwerk-Tab.
 *
 *        TAFLA (2026-10-24): das Widget des alten Rasters (renderRewardsWidget)
 *        ist mit dem Raster gegangen, seine Renderer-Tests mit ihm. Was Dziś
 *        davon zeigt, ist die Vorschaukachel (metricTileFor 'rewards'); die
 *        offenen Freigaben stehen als Zeile im Tagesplan (Quelle 'approvals').
 * Ausfuehren: node --experimental-sqlite --test test/test-dashboard-rewards.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'dashboard-rewards-test-secret';

register('./test-browser-loader.mjs', import.meta.url);

const { get } = await import('../server/db.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');

// --------------------------------------------------------------------------
// Server: welche Daten gehen an wen
// --------------------------------------------------------------------------

const d = get();

function user(username, displayName, role) {
  return d.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES (?, ?, 'x', '#34C759', ?)
  `).run(username, displayName, role).lastInsertRowid;
}

const PARENT = user('rw-parent', 'Linda', 'admin');
const EMMA = user('rw-emma', 'Emma', 'member');
const LEO = user('rw-leo', 'Leo', 'member');
const OMA = user('rw-oma', 'Oma Erna', 'member');

for (const uid of [EMMA, LEO]) {
  d.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(uid);
}
d.prepare("INSERT INTO reward_ledger (user_id, delta, type, reason, created_at) VALUES (?, 20, 'earn', 'Zimmer aufraeumen', '2026-09-20T08:00:00Z')").run(EMMA);
d.prepare("INSERT INTO reward_ledger (user_id, delta, type, reason, created_at) VALUES (?, 10, 'bonus', NULL, '2026-09-21T08:00:00Z')").run(EMMA);
d.prepare("INSERT INTO reward_ledger (user_id, delta, type, reason, created_at) VALUES (?, 60, 'earn', 'Rasen maehen', '2026-09-21T09:00:00Z')").run(LEO);
d.prepare("INSERT INTO reward_catalog (name, cost, is_active) VALUES ('Kinoabend', 45, 1)").run();
d.prepare("INSERT INTO reward_catalog (name, cost, is_active) VALUES ('Alter Gutschein', 5, 0)").run();
d.prepare("INSERT INTO reward_redemptions (user_id, reward_name, cost, status) VALUES (?, 'Eis', 10, 'pending')").run(LEO);
d.prepare("INSERT INTO reward_redemptions (user_id, reward_name, cost, status) VALUES (?, 'Eis', 10, 'pending')").run(EMMA);

async function dashboardAs(userId, authRole) {
  const app = express();
  app.use((req, _res, next) => {
    req.authUserId = userId;
    req.authRole = authRole;
    req.session = { userId };
    next();
  });
  app.use('/', dashboardRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await (await fetch(`http://127.0.0.1:${server.address().port}/`)).json();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('Server: ein Kind bekommt nur die eigene Zeile, eigene Anfragen und eigene Buchungen', async () => {
  const body = await dashboardAs(EMMA, 'member');
  const r = body.rewards;
  assert.equal(r.view, 'self', 'ein teilnehmendes Kind ohne Freigaberecht sieht die eigene Sicht');
  assert.deepEqual(r.standings.map((s) => s.id), [EMMA], 'die Geschwister gehen gar nicht erst ueber die Leitung');
  assert.equal(r.standings[0].balance, 30);
  assert.ok(!('rank' in r.standings[0]), 'eine Platzierung gibt es nicht');
  assert.equal(r.pending, 1, 'gezaehlt wird die EIGENE offene Anfrage, nicht die des Bruders');
  assert.deepEqual(r.recent.map((row) => row.delta), [10, 20], 'zuletzt verdient: nur eigene Gutschriften, neueste zuerst');
  assert.deepEqual(r.catalog.map((c) => c.name), ['Kinoabend'], 'nur einloesbare Praemien sind ein Ziel');
});

test('Server: wer freigeben darf, sieht jedes Kind alphabetisch, ohne Rang, mit allen offenen Freigaben', async () => {
  const body = await dashboardAs(PARENT, 'admin');
  const r = body.rewards;
  assert.equal(r.view, 'approver');
  assert.deepEqual(r.standings.map((s) => s.display_name), ['Emma', 'Leo'],
    'nach Namen, nicht nach Punkten - Leo hat mehr und steht trotzdem nicht vorn');
  assert.ok(r.standings.every((s) => !('rank' in s)));
  assert.equal(r.pending, 2);
  assert.deepEqual(r.recent, [], 'die eigene Buchungsliste gehoert nur der eigenen Sicht');
});

test('Server: wer weder sammelt noch freigibt, sieht die Familie, aber keine fremden Anfragen', async () => {
  const body = await dashboardAs(OMA, 'member');
  const r = body.rewards;
  assert.equal(r.view, 'family');
  assert.deepEqual(r.standings.map((s) => s.display_name), ['Emma', 'Leo']);
  assert.equal(r.pending, 0, 'offene Anfragen anderer sind Sache der Eltern');
});

// --------------------------------------------------------------------------
// Dziś: was davon erscheint
// --------------------------------------------------------------------------

test('der Tagesplan nennt offene Geld-Anfragen mit, und weiter nur fuer den, der freigibt', async () => {
  const { TODAY_SHEET_SOURCES } = await import('../public/utils/today-sheet.js');
  const approvals = TODAY_SHEET_SOURCES.find((source) => source.id === 'approvals');
  assert.ok(approvals, 'die Quelle der Freigaben');
  const title = (rewards) => approvals.collect({ rewards })[0]?.title.replace(/&quot;/g, '"');
  assert.match(title({ view: 'approver', pending: 1, moneyPending: 2 }), /"count":3/);
  assert.match(title({ view: 'approver', pending: 0, moneyPending: 1 }), /"count":1/);
  assert.equal(title({ view: 'approver', pending: 0, moneyPending: 0 }), undefined);
  assert.equal(title({ view: 'self', pending: 0, moneyPending: 2 }), undefined, 'die eigene Bitte eines Kindes ist keine Freigabe');
});

// 2026-10-27, v2: Dziś zeichnet keine Punkte-Kachel mehr (Entwurf „Main":
// Wetter, Kalender, Aufgaben, Wkrótce). Was die Kachel zusagte - das Kind
// sieht Stand und Ziel, niemand einen Spitzenreiter, die Freigaben stehen
// nicht doppelt - ging mit ihr; die Freigaben bleiben eine Zeile des
// Tagesplans (oben) und das Ziel EINE Regel.
test('Verdrahtung: das Ziel kommt aus EINER Regel, und Dziś v2 rechnet keines', () => {
  const dash = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  assert.doesNotMatch(dash, /reward-goal|metricTileFor/, 'Dziś v2 hat keine Punkte-Kachel');
  const page = readFileSync(new URL('../public/pages/rewards.js', import.meta.url), 'utf8');
  assert.ok(/from '\/utils\/reward-goal\.js'/.test(page), 'rewards.js rechnet das naechste Ziel ueber utils/reward-goal.js');
});

// --------------------------------------------------------
// Die Seite: Kopf und Inhalt teilen je Reiter eine Kante
// (Re-Critique 2026-09-27, A3 P2-5 / R10 L7)
//
// Gemessen bei 1440x900: Punktestand bis 972, sein Kopfknopf bis 1408; das
// Ledger 1156px breit mit dem Punktwert 1100px vom Grund; im Katalog endete
// die Kopfpille bei 972, das Raster bei 1408. Jetzt: Zeilenlisten auf dem
// Lesemass, das Raster breit, und die Kopfpille an der Kante ihres Inhalts.
// --------------------------------------------------------

// Die Seite liest `window.yuvomi` und `window.lucide` beim Zeichnen. Bis v2
// (2026-10-27) setzte der Test der Punkte-Kachel von Dziś dieses Fenster im
// Vorbeigehen; die Kachel ist gegangen, also steht es hier ausdruecklich.
global.window = { yuvomi: null };
const { __test: rewardsPage } = await import('../public/pages/rewards.js');

/** Ein Inhaltsknoten, der das Markup einsammelt - mehr fassen die Renderer nicht an. */
function markupEl() {
  return {
    html: '',
    replaceChildren() { this.html = ''; },
    insertAdjacentHTML(_pos, html) { this.html += html; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

test('Belohnungen: nur der Katalog ist ein breiter Abschnitt, Uebersicht und Verlauf stehen auf dem Lesemass', () => {
  const s = rewardsPage.state;
  const vorher = { user: s.user, overview: s.overview, catalog: s.catalog, ledger: s.ledger, redemptions: s.redemptions };
  try {
    s.user = { id: 1, role: 'admin' };
    s.overview = { me: 1, balances: [{ id: 2, display_name: 'Emma', balance: 30 }] };
    s.catalog = [{ id: 7, name: 'Kinoabend', cost: 100, is_active: 1 }];
    s.ledger = [{ id: 1, type: 'earn', delta: 5, reason: 'Zimmer', user_name: 'Emma', created_at: '2026-09-20' }];
    s.redemptions = [];
    const wide = /class="rw-section rw-section--wide"/g;
    for (const [name, render] of [['renderOverview', rewardsPage.renderOverview], ['renderLedger', rewardsPage.renderLedger]]) {
      const el = markupEl();
      render(el);
      assert.match(el.html, /class="rw-section"/, `${name}: der Abschnitt steht da`);
      assert.doesNotMatch(el.html, wide, `${name}: eine Zeilenliste ist kein breiter Abschnitt`);
    }
    const katalog = markupEl();
    rewardsPage.renderCatalog(katalog);
    assert.equal((katalog.html.match(wide) || []).length, 1, 'das Katalograster ist der eine breite Abschnitt');
  } finally {
    Object.assign(s, vorher);
  }
});

// Critique R16 (2026-10-05): der Kopf folgte dem Reiter (`--wide` nur im
// Katalog), die angedockte Pille sprang zwischen Katalog (1408) und Verlauf
// (972) um 431px. Jetzt fuehrt die SEITE das breite Mass, und Uebersicht und
// Verlauf fuellen es mit einer Seitenspalte.
test('Belohnungen: eine Kante fuer alle Reiter - die Seite fuehrt das breite Mass, der Kopf schaltet nicht um', () => {
  const page = readFileSync(new URL('../public/pages/rewards.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/styles/rewards.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(page, /class="rewards-page app-page app-page--dashboard app-page--columns" data-composition="dashboard"/,
    'die Seitenwurzel fuehrt das breite Mass und ist der Container der Spalten');
  // R19: dazu `page-toolbar--tabs-title` (die Reiter stehen unter 1024px in
  // der Titelzeile) - die Kante haengt weiter an --narrow.
  assert.match(page, /<header class="page-toolbar page-toolbar--narrow\b[^"]*\brewards-toolbar">/,
    '--narrow bleibt: der Kopf endet am Mass der Seite, in jedem Reiter am selben');
  assert.equal(rewardsPage.syncToolbarMeasure, undefined, 'kein Umschalter am Kopf mehr');
  assert.doesNotMatch(page, /rewards-toolbar--wide/, 'der Kopf-Modifier je Reiter ist weg');
  assert.doesNotMatch(css, /rewards-toolbar--wide/, 'und seine Regeln auch');
  assert.match(css, /\.rewards-page \.rw-section\s*\{[^}]*max-width:\s*var\(--page-measure/,
    'jeder Abschnitt endet am Mass der Seite - auch das Katalograster');
});

test('Belohnungen: Uebersicht und Verlauf stehen im Spaltenraster, die Seitenspalte nimmt nur vorhandene Daten', () => {
  const s = rewardsPage.state;
  const vorher = { user: s.user, overview: s.overview, catalog: s.catalog, ledger: s.ledger, redemptions: s.redemptions, recentLedger: s.recentLedger };
  const buchung = { id: 1, type: 'earn', delta: 5, reason: 'Zimmer', user_name: 'Emma', created_at: '2026-09-20' };
  try {
    s.user = { id: 1, role: 'admin' };
    s.overview = { me: 1, balances: [{ id: 2, display_name: 'Emma', balance: 30 }] };
    s.catalog = [{ id: 7, name: 'Kinoabend', cost: 100, is_active: 1 }];
    s.ledger = [buchung];
    s.redemptions = [];

    // Uebersicht mit Buchungen: Punktestaende links, die letzten Buchungen rechts.
    s.recentLedger = [buchung];
    let el = markupEl();
    rewardsPage.renderOverview(el);
    const [main, rail] = el.html.split('<div class="page-columns__rail">');
    assert.match(main, /<div class="page-columns__main">[\s\S]*rw-standings/, 'die Punktestaende stehen in der Listenspalte');
    assert.ok(rail, 'mit Buchungen gibt es eine Seitenspalte');
    assert.match(rail, /class="section-title-link rw-section__more"[^>]*>rewards\.tabLedger/, 'der Abschnittstitel ist der Weg in den Verlauf');
    assert.match(rail, /<ul class="rw-ledger row-carrier">[\s\S]*list-row rw-ledger-row/, 'derselbe Zeilenbaustein wie im Verlauf');

    // Ohne Antwort (null) und ohne Buchung ([]) entfaellt die Spalte - kein
    // Leerzustand, der "keine Buchungen" behauptet, wenn die Abfrage scheiterte.
    for (const leer of [null, []]) {
      s.recentLedger = leer;
      el = markupEl();
      rewardsPage.renderOverview(el);
      assert.match(el.html, /page-columns__main/);
      assert.doesNotMatch(el.html, /page-columns__rail/, `recentLedger=${JSON.stringify(leer)}: keine Seitenspalte`);
    }

    // Verlauf: Buchungen links, Punktestaende in Kurzform rechts.
    el = markupEl();
    rewardsPage.renderLedger(el);
    const [lMain, lRail] = el.html.split('<div class="page-columns__rail">');
    assert.match(lMain, /<ul class="rw-ledger row-carrier">/, 'die Buchungen stehen in der Listenspalte');
    assert.match(lRail ?? '', /rw-standing--compact[\s\S]*Emma/, 'die Punktestaende stehen in der Seitenspalte');
    assert.doesNotMatch(lRail ?? '', /rw-redeem-open|rw-progress__track/, 'Kurzform: kein Fortschritt, kein Einloesen');
  } finally {
    Object.assign(s, vorher);
  }
});

test('Belohnungen: der Einrichtungsschritt „Praemien" wechselt wirklich in den Katalog', () => {
  // Er suchte `[data-rw-tab="catalog"]` - ein Attribut, das es nie gab; die
  // Reiter tragen `data-tab-id` (tabButton). Der Klick lief ins Leere.
  let gefragt = null;
  let geklickt = false;
  const vorher = globalThis.document;
  globalThis.document = { querySelector: (sel) => { gefragt = sel; return /data-tab-id="catalog"/.test(sel) ? { click() { geklickt = true; } } : null; } };
  try {
    rewardsPage.handleSetupStep('catalog');
  } finally {
    globalThis.document = vorher;
  }
  assert.ok(geklickt, `gesucht wurde ${gefragt} - der Reiter heisst data-tab-id="catalog"`);
});

test('Belohnungen: eine Buchung ohne Grund zeigt den Namen ihres Typs, keine leere Zeile', () => {
  // Der Server liefert `reason: null`, wenn die Aufgabe hinter einer Buchung
  // fuer die betrachtende Person nicht sichtbar ist (routes/rewards.js). Die
  // Zeile bleibt dann stehen - mit Betrag und Person - und braucht einen Text,
  // der nichts verraet: den Namen des Buchungstyps. Ohne den Rueckfall staende
  // dort "null" oder nichts.
  const s = rewardsPage.state;
  const vorher = { user: s.user, overview: s.overview, ledger: s.ledger, ledgerFilter: s.ledgerFilter };
  try {
    s.user = { id: 1, role: 'member' };
    s.overview = { me: 1, balances: [{ id: 2, display_name: 'Emma', balance: 30 }] };
    s.ledgerFilter = null;
    const reasonOf = (row) => {
      s.ledger = [{ id: 1, delta: 5, user_name: 'Emma', created_at: '2026-09-20', ...row }];
      const el = markupEl();
      rewardsPage.renderLedger(el);
      return el.html.match(/<p class="list-row__name rw-ledger-row__reason">([^<]*)<\/p>/)?.[1];
    };
    const named = reasonOf({ type: 'earn', reason: 'Zimmer', task_id: 7 });
    assert.equal(named, 'Zimmer');
    for (const type of ['earn', 'reversal']) {
      const masked = reasonOf({ type, reason: null, task_id: null });
      assert.ok(masked && masked.trim(), `${type}: die Zeile hat keinen Text`);
      assert.notEqual(masked, 'null', `${type}: die Zeile zeigt das Wort null`);
      assert.match(masked, new RegExp(`ledgerType\\.${type}$`), `${type}: der Text ist nicht der Name des Typs (${masked})`);
    }
    // Betrag und Person stehen in der maskierten Zeile weiter da.
    s.ledger = [{ id: 1, type: 'earn', delta: 5, reason: null, task_id: null, user_name: 'Emma', created_at: '2026-09-20' }];
    const el = markupEl();
    rewardsPage.renderLedger(el);
    assert.match(el.html, /rw-ledger-row__meta">Emma/);
    assert.match(el.html, /rw-delta--pos/);
  } finally {
    Object.assign(s, vorher);
  }
});

test('Belohnungen: Verlaufs-Chips sind Kanon-Filterchips mit aria-pressed (Re-Critique 2026-09-28 P2-6)', () => {
  // `.rw-chip` war ein eigener Dialekt: 31px hoch, kein Zustand fuer den
  // Screenreader (aria-pressed fehlte). Kanon ist `.filter-chip` (40/48px,
  // Tonrezept) plus aria-pressed.
  const s = rewardsPage.state;
  const vorher = { user: s.user, overview: s.overview, ledger: s.ledger, ledgerFilter: s.ledgerFilter };
  try {
    s.user = { id: 1, role: 'admin' };
    s.overview = { me: 1, balances: [{ id: 2, display_name: 'Emma', balance: 30 }, { id: 3, display_name: 'Leo', balance: 10 }] };
    s.ledger = [{ id: 1, type: 'earn', delta: 5, reason: 'Zimmer', user_name: 'Leo', created_at: '2026-09-20' }];
    s.ledgerFilter = 3;
    const el = markupEl();
    rewardsPage.renderLedger(el);
    const chips = [...el.html.matchAll(/<button[^>]*data-filter="([^"]*)"[^>]*>/g)];
    assert.equal(chips.length, 3, 'Alle + zwei Personen');
    for (const [tag, id] of chips) {
      assert.match(tag, /class="[^"]*\bfilter-chip\b/, `Chip ${id}: .filter-chip`);
      assert.doesNotMatch(tag, /rw-chip/, `Chip ${id}: kein eigener Dialekt`);
      const pressed = tag.match(/aria-pressed="(true|false)"/);
      assert.ok(pressed, `Chip ${id}: aria-pressed fehlt`);
      assert.equal(pressed[1], String(id === '3'), `Chip ${id}: aria-pressed folgt dem Filter`);
      assert.equal(/filter-chip--active/.test(tag), id === '3', `Chip ${id}: Aktivklasse folgt dem Filter`);
    }
  } finally {
    Object.assign(s, vorher);
  }
  const css = readFileSync(new URL('../public/styles/rewards.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /\.rw-chip\b/, 'rewards.css baut keinen eigenen Chip mehr');
});

// Re-Critique 2026-09-28 (P5, A3 P2-5): mobil fiel die Punktestandzeile auf
// eine Spalte mit voller Einloesen-Kapsel - eine Person pro Bildschirm (Leo
// 455-623, ca. 180px). Jetzt wie die Apple-Health-Zusammenfassung: Person und
// Punkte links, Einloesen als kompakte Kapsel rechts, die duenne Leiste
// darunter ueber die volle Zeile. Die offene Anfrage stapelt ihren Avatar
// nicht mehr allein ueber dem Titel.
test('Belohnungen mobil: Punktestand als Zeile mit Trailing-Kapsel, Anfrage mit Avatar in der Zeile', async () => {
  const { eachRule } = await import('./css-rules.js');
  const rules = [...eachRule(readFileSync(new URL('../public/styles/rewards.css', import.meta.url), 'utf8'))];
  const mobil = (sel) => rules.filter((r) => r.selector.trim() === sel && r.at.some((a) => /max-width:\s*639px/.test(a)))
    .map((r) => r.body).join(';');
  assert.match(mobil('.rw-standing'), /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/, 'Person | Kapsel');
  assert.match(mobil('.rw-standing'), /grid-template-areas:\s*"id actions"\s*"progress progress"/);
  assert.doesNotMatch(mobil('.rw-standing__actions .btn'), /flex:\s*1 1 auto/, 'keine volle Kapselbreite mehr');
  assert.match(mobil('.rw-standing__progress'), /grid-area:\s*progress/);
  assert.match(mobil('.rw-pending'), /grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)/, 'Avatar und Titel in einer Zeile');
  assert.match(mobil('.rw-pending__actions'), /grid-column:\s*2/, 'die Knoepfe stehen unter dem Titel, nicht unter dem Avatar');
});

// --------------------------------------------------------
// Negativer Punktestand (#1607)
//
// Seit das Wiederoeffnen einer Aufgabe gegenbucht statt die Gutschrift zu
// loeschen, ist ein Saldo unter null ein gewoehnlicher Zustand: die Punkte der
// wieder geoeffneten Aufgabe stecken schon in einer Praemie. Drei Dinge duerfen
// dann nicht passieren - kein NaN, kein Balken unter null, kein Minus ohne
// einen Satz, der es erklaert.
// --------------------------------------------------------

const lesbar = (html) => html.replace(/&quot;/g, '"').replace(/&amp;/g, '&');

test('Server: eine zurueckgenommene Gutschrift steht nicht mehr unter "zuletzt verdient" (#1607)', async () => {
  // Gebucht wird ueber den Dienst: die Gegenbuchung zeigt auf ihre Gutschrift
  // (`reverses_id`), und eine von Hand eingefuegte Zeile truege den Bezug nicht.
  const { syncTaskRewards } = await import('../server/services/rewards.js');
  const kid = user('rw-mia', 'Mia', 'member');
  d.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(kid);
  const task = d.prepare("INSERT INTO tasks (title, status, created_by, points) VALUES ('Muell', 'open', ?, 60)").run(PARENT).lastInsertRowid;
  d.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(task, kid);
  syncTaskRewards(d, task, 'open', 'done', PARENT, null, { now: new Date('2026-09-22T08:00:00Z') });
  d.prepare("INSERT INTO reward_ledger (user_id, delta, type, reason, created_at) VALUES (?, -50, 'redeem', 'Eis', '2026-09-22T09:00:00Z')").run(kid);
  syncTaskRewards(d, task, 'done', 'open', PARENT);

  const zurueckgenommen = (await dashboardAs(kid, 'member')).rewards;
  assert.equal(zurueckgenommen.standings[0].balance, -50, 'der Saldo geht unveraendert als Zahl hinaus');
  assert.deepEqual(zurueckgenommen.recent, [], 'die Aufgabe ist wieder offen - verdient ist hier nichts');

  // Erneut erledigt: die NEUE Gutschrift gilt, die alte bleibt zurueckgenommen.
  syncTaskRewards(d, task, 'open', 'done', PARENT, null, { now: new Date('2026-09-22T11:00:00Z') });
  const neu = (await dashboardAs(kid, 'member')).rewards;
  assert.deepEqual(neu.recent.map((r) => r.created_at), ['2026-09-22T11:00:00Z']);

  d.prepare('DELETE FROM reward_participants WHERE user_id = ?').run(kid);
});

test('Server: auch nach dem Loeschen der Aufgabe bleibt die zurueckgenommene Gutschrift draussen (#1607)', async () => {
  // Das Loeschen setzt task_id an BEIDEN Zeilen auf NULL (ON DELETE SET NULL).
  // Ein Bezug ueber die Aufgabe traefe danach nie mehr, und die zurueckgenommene
  // Gutschrift stuende wieder unter "zuletzt verdient". Gebucht wird hier ueber
  // den Dienst, damit die Zeilen so entstehen wie im Betrieb.
  const { syncTaskRewards } = await import('../server/services/rewards.js');
  const kid = user('rw-noa', 'Noa', 'member');
  d.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(kid);
  const task = d.prepare("INSERT INTO tasks (title, status, created_by, points) VALUES ('Flur', 'open', ?, 15)").run(PARENT).lastInsertRowid;
  d.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(task, kid);
  syncTaskRewards(d, task, 'open', 'done', PARENT);
  syncTaskRewards(d, task, 'done', 'open', PARENT);
  d.prepare('DELETE FROM tasks WHERE id = ?').run(task);
  assert.deepEqual(
    d.prepare('SELECT delta, task_id FROM reward_ledger WHERE user_id = ? ORDER BY id').all(kid),
    [{ delta: 15, task_id: null }, { delta: -15, task_id: null }],
    'Vorbedingung: beide Zeilen haben die Aufgabe verloren',
  );

  assert.deepEqual((await dashboardAs(kid, 'member')).rewards.recent, []);
  d.prepare('DELETE FROM reward_participants WHERE user_id = ?').run(kid);
});

test('Belohnungsseite: Punktestandzeile, Anfrage und Verlauf erklaeren das Minus (#1607)', () => {
  const s = rewardsPage.state;
  const vorher = { user: s.user, overview: s.overview, catalog: s.catalog, redemptions: s.redemptions, prevBalances: s.prevBalances };
  const mia = { id: 3, display_name: 'Mia', avatar_color: '#34C759', balance: -50 };
  const tom = { id: 4, display_name: 'Tom', avatar_color: '#FF9500', balance: 20 };
  try {
    s.user = { role: 'admin' };
    s.overview = { me: 1, balances: [mia, tom] };
    s.catalog = [{ id: 11, name: 'Kinoabend', cost: 60, is_active: 1, remaining: null }];
    s.prevBalances = new Map();
    s.redemptions = [
      { id: 1, user_id: 3, user_name: 'Mia', reward_name: 'Eis', cost: 50 },
      { id: 2, user_id: 4, user_name: 'Tom', reward_name: 'Eis', cost: 50 },
    ];

    const zeile = lesbar(rewardsPage.renderStandingRow(mia));
    assert.doesNotMatch(zeile, /NaN|undefined/);
    assert.match(zeile, /aria-valuenow="0"/);
    assert.match(zeile, /--rw-progress:0"/, 'keine negative Balkenbreite');
    assert.match(zeile, /rw-progress__label[^>]*>rewards\.balanceBelowZero</, 'der sichtbare Satz erklaert das Minus');
    assert.match(lesbar(rewardsPage.renderStandingRow(tom)), /rewards\.remainingToReward/, 'ein Saldo ueber null bleibt unveraendert');

    // Ohne Katalog stand dort "noch keine Praemien" - neben einer -50.
    s.catalog = [];
    assert.match(lesbar(rewardsPage.renderStandingRow(mia)), /rewards\.balanceBelowZero/);

    // Der Hinweis neben der offenen Anfrage: nur fuer Entscheidende, nur bei wem er zutrifft.
    const anfragen = lesbar(rewardsPage.renderPendingPanel());
    const hinweise = anfragen.match(/rewards\.pendingBalanceBelowZero\{[^}]*\}/g) || [];
    assert.equal(hinweise.length, 1, 'Mia ist im Minus, Tom nicht');
    assert.match(hinweise[0], /"points":"-50"/);
    assert.match(anfragen, /data-decide="fulfill" data-id="1"/, 'ein Hinweis, keine Sperre: freigeben bleibt moeglich');
    s.user = { role: 'member' };
    assert.doesNotMatch(lesbar(rewardsPage.renderPendingPanel()), /pendingBalanceBelowZero/, 'das Kind liest seinen Stand in der eigenen Zeile');

    // Verlauf: die Gegenbuchung sagt, was geschah - die Einloese-Rueckbuchung bleibt, wie sie war.
    assert.equal(lesbar(rewardsPage.ledgerReason({ type: 'reversal', delta: -60, reason: 'Muell' })), 'rewards.ledgerTaskReopenedNamed{"task":"Muell"}');
    assert.equal(rewardsPage.ledgerReason({ type: 'reversal', delta: -60, reason: null }), 'rewards.ledgerTaskReopened');
    assert.equal(rewardsPage.ledgerReason({ type: 'reversal', delta: 50, reason: 'Eis' }), 'Eis');
    assert.equal(rewardsPage.ledgerReason({ type: 'earn', delta: 60, reason: 'Muell' }), 'Muell');
  } finally {
    Object.assign(s, vorher);
  }
});

test('Genehmigungsliste: der Saldo kommt mit der Anfrage, nicht aus der Teilnehmerliste (#1623)', () => {
  const s = rewardsPage.state;
  const vorher = { user: s.user, overview: s.overview, redemptions: s.redemptions };
  try {
    s.user = { role: 'admin' };
    // Mia ist ausgetragen: `balances` fuehrt sie nicht mehr.
    s.overview = { me: 1, balances: [{ id: 4, display_name: 'Tom', balance: 20 }] };
    s.redemptions = [
      { id: 1, user_id: 3, user_name: 'Mia', reward_name: 'Eis', cost: 50, user_balance: -50 },
      { id: 2, user_id: 4, user_name: 'Tom', reward_name: 'Eis', cost: 50, user_balance: 20 },
    ];
    const hinweise = lesbar(rewardsPage.renderPendingPanel()).match(/rewards\.pendingBalanceBelowZero\{[^}]*\}/g) || [];
    assert.equal(hinweise.length, 1, 'Mia ist im Minus, auch ohne Zeile in balances');
    assert.match(hinweise[0], /"points":"-50"/);
    // Die Anfrage gewinnt gegen die Teilnehmerliste, wenn beide etwas sagen.
    s.redemptions = [{ id: 2, user_id: 4, user_name: 'Tom', reward_name: 'Eis', cost: 50, user_balance: -5 }];
    assert.match(lesbar(rewardsPage.renderPendingPanel()), /pendingBalanceBelowZero\{"points":"-5"\}/);
    s.user = { role: 'member' };
    assert.doesNotMatch(lesbar(rewardsPage.renderPendingPanel()), /pendingBalanceBelowZero/);
  } finally {
    Object.assign(s, vorher);
  }
});

/** Ein Inhaltsknoten, der dazu merkt, was `wireOverview` an welchen Knopf haengt. */
function wiredEl() {
  const el = markupEl();
  el.clicks = new Map();
  el.querySelector = (selector) => {
    const cls = selector.startsWith('.') ? selector.slice(1) : null;
    // Nur ein Knopf, den das Markup wirklich traegt, laesst sich verdrahten.
    if (!cls || !new RegExp(`class="[^"]*\\b${cls}\\b`).test(el.html)) return null;
    return { addEventListener: (type, fn) => { if (type === 'click') el.clicks.set(cls, fn); } };
  };
  return el;
}

test('Uebersicht: "Bonus vergeben" steht im Kopf der Punktestaende und oeffnet den Bonus-Dialog (#1787)', async () => {
  // Der Bonus war nur ueber den FAB im Reiter Verlauf zu erreichen; Eltern
  // suchen ihn dort, wo die Punktestaende stehen.
  const { setPermissions, clearPermissions } = await import('../public/permissions.js');
  const s = rewardsPage.state;
  const vorher = { user: s.user, overview: s.overview, catalog: s.catalog, redemptions: s.redemptions, open: globalThis.__openModal };
  const dialoge = [];
  globalThis.__openModal = (options) => { dialoge.push(options); };
  const kopf = (html) => (html.match(/<div class="rw-section__head">\s*<h2[^>]*>rewards\.standings<\/h2>([\s\S]*?)<\/div>\s*<ul class="row-carrier rw-standings">/) || [])[1];
  try {
    s.user = { id: 1, role: 'admin' };
    s.overview = { me: 1, balances: [{ id: 2, display_name: 'Emma', balance: 30 }] };
    s.catalog = [];
    s.redemptions = [];

    const el = wiredEl();
    rewardsPage.renderOverview(el);
    const head = kopf(el.html);
    assert.ok(head, 'Vorbedingung: der Kopf der Punktestaende steht da');
    const knoepfe = [...head.matchAll(/<button class="([^"]*)" type="button">[\s\S]*?<\/i>([^<]*)<\/button>/g)].map(([, cls, label]) => ({ cls, label }));
    assert.deepEqual(knoepfe.map((k) => k.label), ['rewards.manageParticipants', 'rewards.grantBonus'],
      'zwei beschriftete Kopfaktionen, der Bonus am Ende');
    assert.match(knoepfe[1].cls, /\bbtn--secondary\b/, 'der Bonus ist die staerkere der beiden');
    assert.match(knoepfe[0].cls, /\bbtn--ghost\b/, 'Teilnehmer verwalten bleibt leise');
    assert.equal((el.html.match(/rw-grant-bonus/g) || []).length, 1, 'genau EIN Knopf - keiner je Personenzeile');

    assert.equal(typeof el.clicks.get('rw-grant-bonus'), 'function', 'der Knopf ist verdrahtet');
    el.clicks.get('rw-grant-bonus')({ type: 'click' });
    assert.equal(dialoge.length, 1, 'ein Klick oeffnet einen Dialog');
    assert.equal(dialoge[0].title, 'rewards.grantBonus');
    assert.match(dialoge[0].content, /id="rw-bonus-form"/, 'und zwar den vorhandenen Bonus-Dialog');
    assert.match(dialoge[0].content, /<option value="2">Emma/);

    // Kind: weder Knopf noch Verdrahtung.
    s.user = { id: 2, role: 'member' };
    const kind = wiredEl();
    rewardsPage.renderOverview(kind);
    assert.ok(kopf(kind.html) !== undefined, 'Vorbedingung: das Kind sieht die Punktestaende');
    assert.doesNotMatch(kind.html, /rw-grant-bonus|rewards\.grantBonus/);
    assert.equal(kind.clicks.has('rw-grant-bonus'), false);

    // Nur lesen: der Zustand bleibt, die Handlung geht - auch fuer ein Elternteil.
    s.user = { id: 1, role: 'admin' };
    setPermissions({ admin: false, modules: { rewards: 'read' }, widgets: {}, capabilities: {} });
    try {
      const ro = wiredEl();
      rewardsPage.renderOverview(ro);
      assert.match(ro.html, /rewards\.standings/);
      assert.doesNotMatch(ro.html, /rw-grant-bonus|rewards\.grantBonus/);
    } finally {
      clearPermissions();
    }

    // Ohne Teilnehmende gibt es keinen Kopf und damit keinen Knopf (gewollt).
    const { installMiniDom } = await import('./mini-dom.js');
    const domZurueck = installMiniDom();
    try {
      s.overview = { me: 1, balances: [], setup: { participantCount: 0, catalogCount: 1, pointedTaskCount: 1 } };
      const leer = wiredEl();
      rewardsPage.renderOverview(leer);
      assert.match(leer.html, /rewards\.emptyOverviewTitle/);
      assert.doesNotMatch(leer.html, /rw-grant-bonus/);
    } finally {
      domZurueck();
    }
  } finally {
    const { open, ...rest } = vorher;
    Object.assign(s, rest);
    globalThis.__openModal = open;
  }
});

test('Uebersicht ohne Teilnehmende: die offene Anfrage steht trotzdem da und ist entscheidbar (#1623)', async () => {
  // Der haerteste Fall: die Anfragende war die LETZTE Teilnehmende und wurde
  // ausgetragen. `balances` ist leer, die Uebersicht kehrte mit dem
  // Leerzustand zurueck - vor dem Anfragen-Panel.
  const { setPermissions, clearPermissions } = await import('../public/permissions.js');
  // Der Leerzustand BAUT Knoten (emptyStateHTML): dafuer das Mini-DOM, nur hier.
  const { installMiniDom } = await import('./mini-dom.js');
  const domZurueck = installMiniDom();
  const s = rewardsPage.state;
  const vorher = { user: s.user, overview: s.overview, catalog: s.catalog, redemptions: s.redemptions };
  try {
    s.user = { id: 1, role: 'admin' };
    s.overview = { me: 1, balances: [], setup: { participantCount: 0, catalogCount: 1, pointedTaskCount: 1 } };
    s.catalog = [];
    s.redemptions = [{ id: 9, user_id: 3, user_name: 'Mia', reward_name: 'Eis', cost: 50, user_balance: -50 }];
    const el = markupEl();
    rewardsPage.renderOverview(el);
    const html = lesbar(el.html);
    assert.doesNotMatch(html, /NaN|undefined/);
    assert.match(html, /rw-pending-panel/, 'das Panel steht ohne Punktestaende');
    assert.match(html, /Mia/);
    assert.match(html, /pendingBalanceBelowZero\{"points":"-50"\}/, 'samt Hinweis auf das Minus');
    assert.match(html, /data-decide="fulfill" data-id="9"/, 'genehmigen ist erreichbar');
    assert.match(html, /data-decide="reject" data-id="9"/, 'ablehnen auch');
    assert.match(html, /rewards\.emptyOverviewTitle/, 'der Leerzustand bleibt daneben stehen');
    assert.ok(html.indexOf('rw-pending-panel') < html.indexOf('rewards.emptyOverviewTitle'), 'das Dringende zuerst');

    // Nur lesen: der Zustand bleibt als Zeichen, die Handlung geht.
    setPermissions({ admin: false, modules: { rewards: 'read' }, widgets: {}, capabilities: {} });
    try {
      const ro = markupEl();
      rewardsPage.renderOverview(ro);
      assert.match(ro.html, /rw-pending-panel/);
      assert.doesNotMatch(ro.html, /data-decide=/);
      assert.doesNotMatch(ro.html, /rw-manage-participants/);
    } finally {
      clearPermissions();
    }

    // Ohne offene Anfrage bleibt es beim blossen Leerzustand.
    s.redemptions = [];
    const leer = markupEl();
    rewardsPage.renderOverview(leer);
    assert.doesNotMatch(leer.html, /rw-pending/);
    assert.match(leer.html, /rewards\.emptyOverviewTitle/);
  } finally {
    Object.assign(s, vorher);
    domZurueck();
  }
});

// R19 (Critique 2026-10-16, Persona Emma): die eigenen Punkte eines Kindes
// standen als zweite Zeile unter denen des Bruders, an der Faltkante. Wer
// selbst sammelt und kein Elternteil ist, sieht oben "Deine Punkte" mit dem
// Weg zur naechsten Praemie; die Punktestaende nennen die anderen.
test('R19: ein Kind sieht oben die eigene Karte "Deine Punkte", Eltern nicht', () => {
  const s = rewardsPage.state;
  const vorher = { user: s.user, overview: s.overview, catalog: s.catalog, ledger: s.ledger, redemptions: s.redemptions, recentLedger: s.recentLedger };
  try {
    s.overview = { me: 3, balances: [{ id: 2, display_name: 'Leo', balance: 60 }, { id: 3, display_name: 'Emma', balance: 30 }] };
    s.catalog = [{ id: 7, name: 'Zocken', cost: 40, is_active: 1 }];
    s.ledger = []; s.redemptions = []; s.recentLedger = [];
    s.user = { id: 3, role: 'member' };
    const kind = markupEl();
    rewardsPage.renderOverview(kind);
    const own = kind.html.indexOf('rewards.yourPoints');
    assert.ok(own > 0, 'die eigene Karte steht da');
    assert.ok(own < kind.html.indexOf('rewards.standings'), 'vor den Punktestaenden der anderen');
    const ownList = kind.html.slice(own, kind.html.indexOf('</section>', own));
    // R20: die eigene Karte nennt den Stand, nicht den eigenen Namen - die
    // Ueberschrift "Deine Punkte" sagt schon, wessen er ist.
    assert.match(ownList, /data-countup="30"/, 'mit dem eigenen Stand');
    assert.match(ownList, /rw-progress__track/, 'und dem Weg zur naechsten Praemie');
    const rest = kind.html.slice(kind.html.indexOf('rewards.standings'));
    assert.doesNotMatch(rest, /aria-label="Emma,/, 'die eigene Zeile steht nicht doppelt');
    s.user = { id: 1, role: 'admin' };
    const eltern = markupEl();
    rewardsPage.renderOverview(eltern);
    assert.doesNotMatch(eltern.html, /rewards\.yourPoints/, 'Eltern sehen die gleichwertige Liste');
  } finally {
    Object.assign(s, vorher);
  }
});

// R20 (Kinder-Standards): wer selbst sammelt, sieht oben seine eigene Karte -
// Stand, naechstes Ziel mit Name und Preis, Balken, und die Handlung nur,
// wenn der Stand fuer eine Praemie reicht. Keine Rangzeile mit einem Eintrag.
test('Belohnungen: das Kind sieht seine eigene Karte "Deine Punkte -> naechste Praemie" vor den anderen', () => {
  const s = rewardsPage.state;
  const vorher = { user: s.user, overview: s.overview, catalog: s.catalog, ledger: s.ledger, redemptions: s.redemptions, recentLedger: s.recentLedger };
  try {
    s.user = { id: 3, role: 'member', family_role: 'child' };
    s.overview = { me: 3, balances: [{ id: 3, display_name: 'Emma', balance: 30 }, { id: 4, display_name: 'Leo', balance: 60 }] };
    s.catalog = [
      { id: 7, name: 'Kinoabend', icon: '🎬', cost: 40, is_active: 1 },
      { id: 8, name: 'Zoo', cost: 120, is_active: 1 },
    ];
    s.redemptions = [];
    s.recentLedger = [];
    let el = markupEl();
    rewardsPage.renderOverview(el);
    const own = el.html.indexOf('class="rw-own"');
    const others = el.html.indexOf('rewards.standings');
    assert.ok(own > 0, 'die eigene Karte steht da');
    assert.ok(own < others, 'vor den Punktestaenden der anderen');
    const card = el.html.slice(own, others);
    assert.match(card, /rw-own__value" data-countup="30"/, 'der eigene Stand als grosse Zahl');
    assert.match(card, /rw-own__target-name">Kinoabend</, 'das naechste Ziel mit Namen');
    assert.match(card, /rw-own__target-cost">rewards\.pointsCount|rw-own__target-cost">[^<]*40/, 'und seinem Preis');
    assert.match(card, /role="progressbar"[^>]*aria-valuenow="75"/, '30 von 40 - der Weg als Balken');
    assert.doesNotMatch(card, /rw-redeem-open/, '30 reicht fuer nichts: kein Einloese-Knopf');
    assert.match(card, /rw-own__history/, 'der eigene Verlauf bleibt erreichbar');
    assert.doesNotMatch(card, /rw-standing__id/, 'keine Rangzeile in der eigenen Karte');
    assert.doesNotMatch(el.html.slice(others), /data-member="3"/, 'unten stehen nur die anderen');

    // Reicht der Stand, steht die Handlung als Primaerknopf in der Karte.
    s.overview.balances[0].balance = 45;
    el = markupEl();
    rewardsPage.renderOverview(el);
    assert.match(el.html, /class="btn btn--primary rw-redeem-open" type="button" data-member="3"/);

    // Der Elternteil sieht keine eigene Karte, sondern alle Staende.
    s.user = { id: 1, role: 'admin' };
    s.overview.me = 1;
    el = markupEl();
    rewardsPage.renderOverview(el);
    assert.doesNotMatch(el.html, /class="rw-own"/);
  } finally {
    Object.assign(s, vorher);
  }
});
