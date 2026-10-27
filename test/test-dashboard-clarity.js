/**
 * Tests: Dashboard-Klarheit (Critique 2026-09-23)
 * Zweck: Stellen, an denen die Uebersicht etwas anderes sagte, als sie meinte.
 *        TAFLA (2026-10-19): die Widgets des Rasters (Badges, Familienkarte,
 *        Geburtstags-, Countdown-, Budget-, Zyklus- und Mahlzeiten-Kachel), das
 *        Heute-Blatt und der Anpassen-Modus sind mit Dziś und der Wand
 *        gegangen - und mit ihnen ihre Faelle. Hier bleibt, was weiter gilt:
 *        `relativeDateLabel` (utils/day-label.js), die Zeile der
 *        Haushaltshilfe im Plan (heute das Modell der Wand), die Ziele einer
 *        Zeile (#1821) und der Fokus beim stillen Neuaufbau. Die Kennzahlen
 *        der Vorschau-Kacheln (`metricTileFor`) sind mit Dziś v2 gegangen
 *        (2026-10-27).
 *        Zeit und Zone sind festgenagelt: Berlin wie die Demo-Saat UND je ein
 *        Gegenlauf in einer Zone, die den Tag verschiebt.
 * Ausfuehren: npm run test:dashboard-clarity
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./test-browser-loader.mjs', import.meta.url);

const tz = await import('/utils/timezone.js');
const { __test } = await import('../public/pages/dashboard.js');
const { relativeDateLabel, housekeepingSinceLabel } = await import('/utils/day-label.js');
const { buildPlan, planContext } = await import('/utils/today-plan.js');

// --------------------------------------------------------
// Festgenagelte Zeit und Zone
// --------------------------------------------------------
const RealDate = Date;

function at(iso, zone, fn) {
  const fixed = RealDate.parse(iso);
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }

    static now() { return fixed; }
  }
  globalThis.Date = FixedDate;
  tz.setDisplayTimeZone(zone);
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
    tz.setDisplayTimeZone(null);
  }
}

// Tag+Monat und volles Datum sind im Browser-Stub beide `String(d)`. Damit der
// Test sieht, WELCHER der beiden gerufen wurde, markiert er die Kurzform.
globalThis.__formatDayMonth = (d) => `DM:${d}`;

// --------------------------------------------------------
// #1821: eine Zeile, die EINEN Eintrag zeigt, fuehrt zu ihm
// --------------------------------------------------------

// Notiz-, Geburtstags- und Entsorgungs-Kachel mit ihren Zeilen-Zielen sind mit
// dem Raster gegangen (Tafla, 2026-10-19).

// 2026-10-27, v2: der Abschnitt „Zakupy" ist mit Dziś v2 gegangen (Entwurf
// „Main"), und mit ihm sein Ziel (`shoppingSoleListRoute`, #1821). Der Einkauf
// steht an der Wand; ihre Zahl misst test-dashboard-shopping-selection.js.

// --------------------------------------------------------
// #1821: eine Zeile mit Query im Ziel waermt ihr Modul vor
// --------------------------------------------------------

test('#1821 Prefetch: die Query faellt auch von `data-route` ab', async () => {
  const { prefetchPathOf } = await import('../public/utils/router-navigate.js');
  // Bis #1821 fiel sie nur von `data-nav-href` ab: diese Ziele fanden keine Route.
  assert.equal(prefetchPathOf({ route: '/shopping?list=7' }), '/shopping');
  assert.equal(prefetchPathOf({ route: '/calendar?open=3&date=2026-10-08' }), '/calendar');
  assert.equal(prefetchPathOf({ route: '/waste?type=2' }), '/waste');
  assert.equal(prefetchPathOf({ route: '/tasks' }), '/tasks');
  assert.equal(prefetchPathOf({ route: '/schedule/patterns' }), '/schedule/patterns');
  // `data-nav-href` gewinnt, wie beim Klick der Navigation.
  assert.equal(prefetchPathOf({ navHref: '/meals?week=1', route: '/kitchen' }), '/meals');
  assert.equal(prefetchPathOf({ route: '/notes#x' }), '/notes');
  assert.equal(prefetchPathOf({}), null);
  assert.equal(prefetchPathOf(null), null);
  assert.equal(prefetchPathOf({ route: '?x=1' }), null);

  // Der Aufrufer: der Hover-/Press-Handler der Shell reicht genau das weiter.
  const { readFileSync } = await import('node:fs');
  const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  const handler = router.slice(router.indexOf('const prefetchFromEvent = (e) => {'));
  const body = handler.slice(0, handler.indexOf('};')).replace(/^\s*\/\/.*$/gm, '');
  assert.match(body, /prefetchRoute\(prefetchPathOf\(el\.dataset\)\)/);
  assert.doesNotMatch(body, /dataset\.route\)/, 'kein zweiter Weg mit der rohen Route');
});

test('#1821 Suche: ein Geburtstags-Treffer fuehrt zu SEINEM Anlass', async () => {
  const { SEARCH_SECTIONS } = await import('../public/utils/search-sections.js');
  const route = (bucket, item) => SEARCH_SECTIONS.find((s) => s.bucket === bucket).route(item, {});
  assert.equal(route('birthdays', { id: 4 }), '/birthdays?open=4');
  // Derselbe Parameter wie bei den Nachbarn mit Tiefenlink.
  assert.equal(route('notes', { id: 4 }), '/notes?open=4');
  assert.equal(route('contacts', { id: 4 }), '/contacts?open=4');
});

// --------------------------------------------------------
// #1821: wohin der Router den Fokus nach einer Navigation legt
// --------------------------------------------------------

/** Die echte Funktion des Routers, mit einem Dokument, das nur den Fokus kennt. */
async function navigateFocus({ path = '/', active, overlayOpen = false, inMain = [], atFrame = null }) {
  const { focusMainAfterNavigation } = await import('../public/utils/router-navigate.js');
  const frames = [];
  const focused = [];
  const doc = { activeElement: active };
  const main = {
    contains: (el) => el === main || inMain.includes(el),
    focus(options) { focused.push(options); doc.activeElement = main; },
  };
  doc.getElementById = (id) => (id === 'main-content' ? main : null);
  let overlay = overlayOpen;
  focusMainAfterNavigation(path, {
    document: doc,
    requestAnimationFrame: (cb) => { frames.push(cb); },
    hasOpenOverlay: () => overlay,
  });
  const queued = frames.length;
  const focusedBeforeFrame = focused.length;
  // Zwischen Aufbau und Frame: jemand tabbt in die Seite, die Seite oeffnet einen Dialog.
  atFrame?.({ doc, main, openOverlay: () => { overlay = true; } });
  frames.forEach((cb) => cb());
  return { queued, focusedBeforeFrame, focused, activeIsMain: doc.activeElement === main, active: doc.activeElement };
}

test('#1821 Router-Fokus: nach einer Navigation aus Seitenleiste oder Tableiste bekommt <main> den Fokus', async () => {
  // Der Zweck der Funktion - und der Rueckschritt, der mit den Ausnahmen unten
  // nicht passieren darf: der Fokus bliebe auf dem Link, der die Seite oeffnete.
  const navLink = { name: 'nav' };
  const fromNav = await navigateFocus({ active: navLink });
  assert.equal(fromNav.queued, 1, 'genau ein Frame');
  assert.equal(fromNav.focusedBeforeFrame, 0, 'gefragt und fokussiert wird IM Frame, nicht davor');
  assert.deepEqual(fromNav.focused, [{ preventScroll: true }]);
  assert.equal(fromNav.activeIsMain, true);

  // Die Zeile der ALTEN Seite ist mit ihr verschwunden: der Fokus liegt auf <body>.
  const body = { name: 'body' };
  assert.equal((await navigateFocus({ active: body })).activeIsMain, true);
  assert.equal((await navigateFocus({ active: null })).activeIsMain, true);
  // Ein Element ausserhalb von <main>, das kein Overlay ist (Suchfeld der Shell).
  assert.equal((await navigateFocus({ active: { name: 'shell-search' } })).activeIsMain, true);
});

test('#1821 Router-Fokus: wer schon auf einer Zeile der neuen Seite steht, bleibt dort', async () => {
  const row = { name: 'row' };
  // Schon beim Aufruf dort ...
  const there = await navigateFocus({ active: { name: 'nav' }, inMain: [row], atFrame: ({ doc }) => { doc.activeElement = row; } });
  assert.deepEqual(there.focused, [], '<main> zieht den Fokus nicht von der Zeile ab');
  assert.equal(there.active, row);
  // ... und <main> selbst zaehlt nicht als "in der Seite".
  const onMain = await navigateFocus({ active: null, atFrame: ({ doc, main }) => { doc.activeElement = main; } });
  assert.equal(onMain.focused.length, 1);
});

test('#1821 Router-Fokus: ein Dialog, den die neue Seite oeffnet, behaelt den Fokus', async () => {
  // `/notes?open=5` im verdeckten Tab: der Dialog nimmt den Fokus, der Frame
  // des Routers ruht bis zum Zeigen des Tabs. Das Overlay liegt AUSSERHALB von
  // <main> - `main.focus()` zoege den Fokus hinter den offenen Dialog.
  const dialogButton = { name: 'dialog-close' };
  const opened = await navigateFocus({
    active: { name: 'nav' },
    atFrame: ({ doc, openOverlay }) => { openOverlay(); doc.activeElement = dialogButton; },
  });
  assert.deepEqual(opened.focused, []);
  assert.equal(opened.active, dialogButton);
  // Auch wenn der Dialog den Fokus (noch) nicht hat: hinter ihn gehoert er nicht.
  const pending = await navigateFocus({ active: { name: 'body' }, overlayOpen: true });
  assert.deepEqual(pending.focused, []);
});

test('#1821 Router-Fokus: Anmeldung und Einrichtung bleiben unberuehrt, und der Router ruft genau diese Funktion', async () => {
  assert.equal((await navigateFocus({ path: '/login', active: null })).queued, 0);
  assert.equal((await navigateFocus({ path: '/setup', active: null })).queued, 0);

  // router.js laesst sich nicht importieren; sein Anteil ist das Hereinreichen.
  const { readFileSync } = await import('node:fs');
  const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  const fn = router.slice(router.indexOf('function focusMainContentAfterNavigation('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 2).replace(/\s+/g, ' ');
  assert.equal(body,
    'function focusMainContentAfterNavigation(path) { focusMainAfterNavigation(path, { document, requestAnimationFrame: (cb) => requestAnimationFrame(cb), hasOpenOverlay, }); }',
    'der Router fuegt keine eigene Bedingung hinzu - jede Regel steht in der gemessenen Funktion');
  assert.match(router, /focusMainContentAfterNavigation, showToast, t,/, 'und reicht sie an navigate() weiter');
});

// --------------------------------------------------------
// #1821: der Fokus auf einer Inhaltszeile ueberlebt den stillen Neuaufbau
// --------------------------------------------------------

/** Ein Element, wie `focusKeyOf` es liest - ohne DOM, mit benannten Vorfahren. */
function fakeEl({ attrs = {}, classes = [], ancestors = {}, matches = [] } = {}) {
  const el = {
    id: attrs.id ?? '',
    classList: classes,
    dataset: Object.fromEntries(Object.entries(attrs)
      .filter(([k]) => k.startsWith('data-'))
      .map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v])),
    hasAttribute: (name) => name in attrs,
    getAttribute: (name) => attrs[name] ?? null,
    ownerDocument: { querySelectorAll: () => matches },
    closest(selector) {
      for (const part of selector.split(',').map((x) => x.trim())) {
        if (part in ancestors) return ancestors[part];
        const own = /^\[([a-z-]+)\]$/.exec(part);
        if (own && own[1] in attrs) return el;
      }
      return null;
    },
  };
  return el;
}

test('#1821 Fokus: eine Zeile nennt sich ueber Ziel und Stelle', () => {
  const hadCss = 'CSS' in globalThis;
  const prevCss = globalThis.CSS;
  // Node kennt `CSS.escape` nicht; die Probe braucht nur, dass die Werte
  // unveraendert im Selektor ankommen.
  globalThis.CSS = { escape: (v) => String(v) };
  try {
    const shellOf = (matches) => ({ querySelectorAll: () => matches });

    // Bis #1821 hatte eine Inhaltszeile KEINEN Schluessel: der stille Neuaufbau
    // (Rueckkehr in den Tab, Viertelstundentakt) liess den Fokus auf <body>.
    // Seit Tafla gibt es keine Kacheln mehr, in deren Rahmen die Zeile steht.
    const row = fakeEl({ attrs: { 'data-route': '/shopping?list=7' } });
    row.closest = ((orig) => (sel) => (sel === '#dashboard-shell' ? shellOf([row]) : orig(sel)))(row.closest);
    assert.deepEqual(__test.focusKeyOf(row), {
      selector: '[data-route="/shopping?list=7"]',
      index: 0,
      preventScroll: true,
    });

    // Mehrere Zeilen mit demselben Ziel (Schichtplan): die Stelle entscheidet.
    const other = {};
    const third = fakeEl({ attrs: { 'data-route': '/schedule/patterns' } });
    third.closest = ((orig) => (sel) => (sel === '#dashboard-shell' ? shellOf([other, other, third]) : orig(sel)))(third.closest);
    assert.equal(__test.focusKeyOf(third).index, 2);
    assert.equal(__test.focusKeyOf(third).selector, '[data-route="/schedule/patterns"]');

    // Der Tabstopp der Notizkarte ist ein KIND der Zeile.
    const card = fakeEl({ attrs: { 'data-route': '/notes?open=5' } });
    const body = fakeEl({ classes: ['note-item__body'], ancestors: { '[data-route]': card } });
    assert.equal(__test.focusKeyOf(body).selector, '[data-route="/notes?open=5"] .note-item__body');
    // Die Stelle zaehlt das KIND, nicht die Zeile: liegt der Fokus auf dem
    // zweiten Treffer des Kind-Selektors, ist es der zweite - die Zeile selbst
    // steht in dieser Trefferliste gar nicht.
    const otherBody = {};
    card.closest = ((orig) => (sel) => (sel === '#dashboard-shell' ? { querySelectorAll: () => [otherBody, body] } : orig(sel)))(card.closest);
    assert.equal(__test.focusKeyOf(body).index, 1);

    // Eine Aufgabenzeile fuehrt nirgendhin, sie oeffnet ein Objekt.
    const task = fakeEl({ attrs: { 'data-task-id': '31' } });
    assert.equal(__test.focusKeyOf(task).selector, '[data-task-id="31"]');

    // Die Heute-Zeile einer Aufgabe: Ziel UND Objekt, sonst traefe `/tasks` die erste.
    const cockpit = fakeEl({ attrs: { 'data-route': '/tasks', 'data-object-kind': 'task', 'data-object-id': '31' } });
    assert.equal(__test.focusKeyOf(cockpit).selector, '[data-route="/tasks"][data-object-kind="task"][data-object-id="31"]');

    // Was vorher galt, gilt weiter: Id zuerst. Die Bearbeiten-Attribute des
    // Rasters sind gegangen; ein Knopf von Dziś ist seine Handlung, in einer
    // Zeile mit deren Schluessel - der Kreis von „Zamówić tort" findet sich wieder.
    assert.equal(__test.focusKeyOf(fakeEl({ attrs: { id: 'dashboard-customize-btn', 'data-route': '/x' } })), '#dashboard-customize-btn');
    assert.equal(__test.focusKeyOf(fakeEl({ attrs: { 'data-day-action': 'check', 'data-row-key': 'task:31' } })),
      '[data-day-action="check"][data-row-key="task:31"]');
    assert.equal(__test.focusKeyOf(fakeEl({ attrs: { 'data-day-action': 'customize' } })), '[data-day-action="customize"]');
    // Und was keine Zeile ist, bekommt keinen Schluessel.
    assert.equal(__test.focusKeyOf(fakeEl({ classes: ['widget__title'] })), null);
  } finally {
    if (hadCss) globalThis.CSS = prevCss; else delete globalThis.CSS;
  }
});

/**
 * Eine Flaeche fuer captureRebuildFocus/restoreFocusAfterRebuild: `nodes` sind
 * die Elemente, die `selector` jeweils trifft - wie der Neuaufbau sie liefert.
 */
function fakeSurface(nodes) {
  const log = [];
  const make = (name, extra = {}) => ({ name, disabled: false, focus(options) { log.push([name, options]); }, ...extra });
  const table = Object.fromEntries(Object.entries(nodes).map(([selector, list]) => [selector,
    list.map((entry) => (typeof entry === 'string' ? make(entry) : make(entry.name, entry)))]));
  return {
    log,
    table,
    querySelector: (selector) => table[selector]?.[0] ?? null,
    querySelectorAll: (selector) => table[selector] ?? [],
  };
}

test('#1821 Fokus: der Neuaufbau gibt der Zeile den Fokus zurueck - an ihrer Stelle, ohne zu scrollen', () => {
  const hadCss = 'CSS' in globalThis;
  const prevCss = globalThis.CSS;
  globalThis.CSS = { escape: (v) => String(v) };
  try {
    // VORHER: die dritte Schichtplan-Zeile hat den Fokus.
    const body = {};
    const rowsBefore = [{}, {}, null];
    const row = fakeEl({ attrs: { 'data-route': '/schedule/patterns' } });
    rowsBefore[2] = row;
    const shellBefore = { contains: (el) => el === row, querySelectorAll: () => rowsBefore };
    row.closest = ((orig) => (sel) => (sel === '#dashboard-shell' ? shellBefore : orig(sel)))(row.closest);
    const before = __test.captureRebuildFocus(shellBefore, row, body);
    assert.equal(before.had, true);
    assert.deepEqual(before.key, { selector: '[data-route="/schedule/patterns"]', index: 2, preventScroll: true },
      'die Erfassung gibt den Zeilenschluessel weiter');

    // NACHHER: neue Elemente, derselbe Selektor. Die dritte bekommt den Fokus.
    const after = fakeSurface({ '[data-route="/schedule/patterns"]': ['erste', 'zweite', 'dritte'] });
    const got = __test.restoreFocusAfterRebuild(after, [before.key]);
    assert.equal(got?.name, 'dritte');
    assert.deepEqual(after.log, [['dritte', { preventScroll: true }]]);

    // Die Zeile gibt es nach dem Neuaufbau nicht mehr (eine weniger): kein Fokus, kein Wurf.
    const fewer = fakeSurface({ '[data-route="/schedule/patterns"]': ['erste', 'zweite'] });
    assert.equal(__test.restoreFocusAfterRebuild(fewer, [before.key]), null);
    assert.deepEqual(fewer.log, []);
  } finally {
    if (hadCss) globalThis.CSS = prevCss; else delete globalThis.CSS;
  }
});

test('#1821 Fokus: ausserhalb der Flaeche oder auf <body> wird nichts erfasst', () => {
  const body = {};
  const outside = fakeEl({ attrs: { id: 'nav-link' } });
  const shell = { contains: () => false };
  assert.deepEqual(__test.captureRebuildFocus(shell, outside, body), { key: null, had: false });
  assert.deepEqual(__test.captureRebuildFocus({ contains: () => true }, body, body), { key: null, had: false });
  assert.deepEqual(__test.captureRebuildFocus({ contains: () => true }, null, body), { key: null, had: false });
  // In der Flaeche, aber ohne Identitaet: Fokus war da, einen Schluessel gibt es nicht.
  assert.deepEqual(__test.captureRebuildFocus({ contains: () => true }, fakeEl({ classes: ['widget__title'] }), body), { key: null, had: true });
});

test('#1821 Fokus: Selektor-Kandidaten des Anpassen-Modus gelten weiter - erster Treffer, mit Scrollen, in Reihenfolge', () => {
  // Was vor #1821 galt: Ids und Bearbeiten-Knoepfe sind Selektoren. Ihr Fokus
  // darf scrollen (die Geste hat ihn ausgeloest), und es gilt der ERSTE Treffer.
  const surface = fakeSurface({
    '#dashboard-customize-cancel': ['abbrechen'],
    '#dashboard-customize-btn': ['anpassen'],
    '[data-widget-hide="notes"]': ['ausblenden-a', 'ausblenden-b'],
    '#gesperrt': [{ name: 'gesperrt', disabled: true }],
  });
  assert.equal(__test.restoreFocusAfterRebuild(surface, ['[data-widget-hide="notes"]', '#dashboard-customize-btn']).name, 'ausblenden-a');
  assert.deepEqual(surface.log.at(-1), ['ausblenden-a', undefined], 'ohne preventScroll');
  // Der erste Kandidat fehlt nach dem Aufbau: der naechste ist dran.
  assert.equal(__test.restoreFocusAfterRebuild(surface, [null, '#gibt-es-nicht', '#dashboard-customize-cancel', '#dashboard-customize-btn']).name, 'abbrechen');
  // Ein gesperrter Knopf wird uebersprungen.
  assert.equal(__test.restoreFocusAfterRebuild(surface, ['#gesperrt', '#dashboard-customize-btn']).name, 'anpassen');
  assert.equal(__test.restoreFocusAfterRebuild(surface, []), null);
  assert.equal(__test.restoreFocusAfterRebuild(surface, null), null);
  assert.equal(surface.log.length, 3);
});

test('#1821 Fokus: der Neuaufbau der Seite ruft Erfassen und Wiederfokus, um das setHtml herum', async () => {
  // rebuildDashboard() lebt im Abschluss von render() und laesst sich nicht
  // rufen. Was die beiden Funktionen TUN, messen die Tests darueber; hier steht
  // nur, dass der Abschluss sie in dieser Reihenfolge und mit diesen Werten ruft.
  // TAFLA (2026-10-19): ausserhalb der Wand baut renderToday() die Seite; die
  // Nachfolger einer Geste (der naechste Kreis nach einem Haken) stehen in
  // `todayFocus`, der Anpassen-Knopf von frueher ist das Blatt „Dostosuj Dziś".
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('  function renderToday(shell) {'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  const capture = body.indexOf('const { key: keepFocus } = captureRebuildFocus(shell, document.activeElement, document.body);');
  // 2026-10-27, v2: der Zustand heisst `dzisState`, der Nachfolger `dzisFocus`.
  const paint = body.indexOf('setHtml(shell, renderTodayPage(dzisState))');
  const restore = body.indexOf('restoreFocusAfterRebuild(container, [keepFocus, ...(dzisFocus ?? [])]);');
  assert.ok(capture > 0, 'erfasst wird vor dem Aufbau');
  assert.ok(paint > capture, 'dann wird gebaut');
  assert.ok(restore > paint, 'und danach wieder fokussiert: eigener Schluessel, dann der Nachfolger der Geste');
  assert.match(src, /function rebuildDashboard\(cfg\) \{[\s\S]*?renderToday\(shell\);/, 'jeder Neuaufbau ausserhalb der Wand geht durch renderToday()');
});

// 2026-10-27, v2: die Vorschau-Kacheln von Dziś („Kafelek podglądu",
// metricTileFor: Dosen, Besuche, Monatssaldo) sind mit Dziś v2 gegangen. Was
// sie ueber die Haushaltshilfe sagten, sagt die Zeile des Plans (#1452 unten).

// --------------------------------------------------------
// 2. Relative Daten: heute, morgen, Wochentag, Datum ohne Jahr
// --------------------------------------------------------

// Mittwoch, 23.09.2026, 21:18 in Berlin - der Stand der Critique.
const CRITIQUE_NOW = '2026-09-23T19:18:00Z';

// Der erwartete Kurzname aus Intl selbst: ob „Sa" oder „Sa." dasteht, haengt an
// der ICU-Version, nicht an der App. Dass es ein NAME ist und kein Datum, prueft
// der Test daneben.
const wd = (key, locale = 'de') => {
  const name = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${key}T12:00:00Z`));
  assert.doesNotMatch(name, /\d/, `Vorbedingung: ${name} ist ein Wochentagsname`);
  return name;
};

test('relativeDateLabel: innerhalb von sechs Tagen der Wochentag, danach Datum ohne Jahr', () => {
  at(CRITIQUE_NOW, 'Europe/Berlin', () => {
    globalThis.__locale = 'de';
    const label = relativeDateLabel;
    assert.equal(label('2026-09-23'), 'common.today');
    assert.equal(label('2026-09-24'), 'common.tomorrow');
    assert.equal(label('2026-09-26'), wd('2026-09-26'), 'uebermorgen+1 heisst Samstag, nicht 26.09.2026');
    assert.equal(label('2026-09-29'), wd('2026-09-29'), 'sechs Tage voraus traegt noch den Wochentag');
    assert.equal(label('2026-09-30'), 'DM:2026-09-30', 'ab sieben Tagen waere der Wochentag mehrdeutig');
    assert.equal(label('2026-09-20'), 'DM:2026-09-20', 'Vergangenes bekommt nie einen Wochentag');
    assert.equal(label('2027-01-05'), '2027-01-05', 'ein anderes Jahr steht mit Jahr da');
    // Ein Zeitpunkt wird umgerechnet: 08:00Z am Samstag ist in Berlin Samstag.
    assert.equal(label('2026-09-26T08:00:00Z'), wd('2026-09-26'));
    globalThis.__locale = 'en';
    assert.equal(label('2026-09-26'), wd('2026-09-26', 'en'), 'der Name folgt der App-Sprache');
  });
  globalThis.__locale = undefined;
});

test('relativeDateLabel: die Haushaltszone entscheidet, welcher Tag heute ist', () => {
  // Derselbe Zeitpunkt ist auf Kiritimati (UTC+14) schon Donnerstag, 09:18.
  at(CRITIQUE_NOW, 'Pacific/Kiritimati', () => {
    const label = relativeDateLabel;
    assert.equal(label('2026-09-24'), 'common.today');
    assert.equal(label('2026-09-25'), 'common.tomorrow');
    assert.equal(label('2026-09-30'), wd('2026-09-30'), 'von Donnerstag aus sind es sechs Tage');
    assert.equal(label('2026-10-01'), 'DM:2026-10-01');
  });
});

test('relativeDateLabel: ueber den Jahreswechsel zaehlt der Abstand, nicht das Jahr', () => {
  at('2026-12-30T12:00:00Z', 'Europe/Berlin', () => {
    const label = relativeDateLabel;
    assert.equal(label('2027-01-02'), wd('2027-01-02'),'drei Tage voraus, auch im neuen Jahr');
    assert.equal(label('2027-01-10'), '2027-01-10', 'im neuen Jahr und ausser Reichweite: mit Jahr');
  });
});

// Familienkarte, Raster-Hinweis, FLIP der Kacheln und der Anpassen-Modus mit
// seinem Raster sind mit dem Raster der Uebersicht gegangen (Tafla,
// 2026-10-19). Dziś zeigt Erwachsene erst ab drei als Karte mit offenen
// Aufgaben (test-dashboard-a11y.js), ohne Termine.

// --------------------------------------------------------
// Groessennamen sagen, was passiert (Re-Critique 2026-09-27, W2)
// --------------------------------------------------------
// „Schmal (2×1)" hiess die Groesse, die eine Kachel ZWEI Spalten breit macht -
// wer woertlich liest, bekam das Gegenteil. Im Japanischen hiessen 2×1 und 1×2
// beide „縦長". Die Regel: 2×1 heisst in de/en „breit", und in keiner Sprache
// tragen zwei waehlbare Groessen denselben Namen.
test('die Groessennamen der Uebersicht sagen die Form, in jeder Sprache verschieden', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { WIDGET_SIZE_PRESETS } = await import('../public/utils/dashboard-widgets.js');
  const dir = new URL('../public/locales/', import.meta.url);
  // Umbenannt ist nur der Name, nie der gespeicherte Wert: Nutzer- und
  // Haushalts-Layouts (DB, Layout-Hinweis im Geraet) tragen '2x1' - wanderte der
  // Wert mit, verloeren Bestandsinstallationen ihre Kachelgroessen.
  assert.deepEqual(WIDGET_SIZE_PRESETS.map((p) => p.value), ['1x1', '2x1', '1x2', '2x2'],
    'die gespeicherten Groessenwerte bleiben, wie sie sind');
  const wide = WIDGET_SIZE_PRESETS.find((p) => p.value === '2x1');
  assert.ok(wide, '2x1 ist keine waehlbare Groesse mehr - der Test prueft dann nichts');
  assert.doesNotMatch(wide.labelKey, /narrow/i, '2 Spalten x 1 Zeile ist breit, nicht schmal');
  const label = (locale, key) => key.split('.').reduce((o, k) => o?.[k],
    JSON.parse(readFileSync(new URL(`${locale}.json`, dir), 'utf8')));
  assert.match(label('de', wide.labelKey), /^Breit\b/);
  assert.match(label('en', wide.labelKey), /^Wide\b/);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const locale = file.slice(0, -5);
    const names = WIDGET_SIZE_PRESETS.map((p) => label(locale, p.labelKey).replace(/\s*\(.*\)$/, ''));
    assert.equal(new Set(names).size, names.length, `${locale}: zwei Groessen heissen gleich (${names.join(', ')})`);
  }
});

// „Standard (2×2)" hiess die groesste der vier Formen - aber keine Kachel
// beginnt in ihr (#1723). Ein Name, der einen Ausgangswert behauptet, den es
// nicht gibt, ist dieselbe Sorte Fehler wie „Schmal" fuer zwei Spalten.
test('2×2 heisst nach seiner Form, nicht „Standard" - keine Kachel beginnt in dieser Groesse', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { WIDGET_SIZE_PRESETS, WIDGET_IDS, defaultWidgetSize } = await import('../public/utils/dashboard-widgets.js');
  const square = WIDGET_SIZE_PRESETS.find((p) => p.value === '2x2');
  assert.ok(square, '2x2 ist keine waehlbare Groesse mehr - der Test prueft dann nichts');
  // Die Voraussetzung des Namens, gemessen statt behauptet: sobald ein Widget
  // wieder in 2x2 beginnt, ist diese Zeile rot und der Name neu zu entscheiden.
  assert.ok(WIDGET_IDS.length > 5, 'zu wenige Widgets gelesen');
  assert.deepEqual(WIDGET_IDS.filter((id) => defaultWidgetSize(id) === '2x2'), [],
    'ein Widget beginnt in 2x2');
  assert.doesNotMatch(square.labelKey, /standard|default/i, 'der Schluessel nennt 2x2 den Ausgangswert');
  const dir = new URL('../public/locales/', import.meta.url);
  const label = (file) => square.labelKey.split('.').reduce((o, k) => o?.[k],
    JSON.parse(readFileSync(new URL(file, dir), 'utf8')));
  assert.equal(label('de.json'), 'Quadrat (2×2)');
  assert.equal(label('en.json'), 'Square (2×2)');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const { dashboard } = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    assert.equal(dashboard.widgetSizeStandard, undefined, `${file}: der alte Name ist als toter Schluessel geblieben`);
    // Das Malzeichen und die Ziffern der Sprache bleiben, wie die Nachbarn sie fuehren.
    assert.match(label(file), /\s\((2×2|۲×۲)\)$/u, `${file}: die Massangabe fehlt (${label(file)})`);
  }
});

// Faelligkeit (formatDueDate), leerer Mahlzeiten-Slot, Budget-Sparquote (#1455)
// und die Zeilen der Geburtstags- und Countdown-Kachel (#1454) sind mit ihren
// Widgets gegangen; der letzte Besuch der Haushaltshilfe mit der Vorschau-
// Kachel (2026-10-27, v2).

// --------------------------------------------------------
// Dziś: ein Check-in von gestern nennt sein Datum (#1452)
// --------------------------------------------------------
// Die Kennzahl-Kachel sagte „23.09., 08:30", das Heute-Blatt fuer dieselbe
// offene Sitzung nur „seit 08:30" und sortierte sie zwischen die heutigen
// 08:00- und 09:00-Zeilen - als waere die Hilfe heute frueh gekommen. Beide
// lesen jetzt EINEN Helfer (utils/day-label.js), und ein Beginn vor heute
// steht nicht auf einer Uhrzeit des heutigen Tages. TAFLA: die Zeile steht
// im Plan von Dziś (utils/today-plan.js, aus der Quelle in today-sheet.js).
async function withSheet(fn) {
  const { setPermissions, clearPermissions } = await import('../public/permissions.js');
  const prevWindow = global.window;
  global.window = { yuvomi: { isModuleDisabled: () => false } };
  setPermissions({ admin: true, modules: {}, widgets: {}, capabilities: {} });
  try {
    return fn();
  } finally {
    clearPermissions();
    global.window = prevWindow;
  }
}

const SINCE_YESTERDAY = '2026-09-23T06:30:00.000Z'; // 08:30 in Berlin
const hkRow = (now) => buildPlan({
  housekeeping: { configured: true, present: true, presentSince: SINCE_YESTERDAY, workerName: 'Maria', visitsThisMonth: 9 },
}, planContext({ now })).all.find((row) => row.sourceKind === 'housekeeping');
const timeParam = (text) => JSON.parse(String(text).replace(/^[^{]*/, '')).time;

test('#1452: der Check-in von gestern steht in Dziś mit Datum und ohne heutige Uhrzeit', () => withSheet(() => {
  at('2026-09-24T19:18:00Z', 'Europe/Berlin', () => {
    const row = hkRow(new Date());
    assert.ok(row, 'Reichweite: die Haushaltshilfe steht im Plan');
    assert.match(row.timeLabel, /DM:2026-09-23, /, `das Datum steht da, bekam ${row.timeLabel}`);
    // 2026-10-27, v2: die Kennzahl-Kachel, mit der die Zeile verglichen wurde,
    // ist gegangen; der Helfer, den beide lasen, bleibt die eine Quelle.
    assert.equal(timeParam(row.timeLabel), housekeepingSinceLabel(SINCE_YESTERDAY));
    assert.equal(row.time, '', 'ein Beginn vor heute sortiert nicht auf 08:30 in den heutigen Tag');
  });
}));

test('#1452: am selben Tag bleibt es bei der Uhrzeit', () => withSheet(() => {
  at('2026-09-23T19:18:00Z', 'Europe/Berlin', () => {
    const row = hkRow(new Date());
    assert.equal(timeParam(row.timeLabel), SINCE_YESTERDAY, 'nur die Uhrzeit (Formatierer-Stub: der Wert selbst)');
    assert.equal(row.time, '08:30');
  });
}));

test('#1452: ob der Check-in von heute ist, entscheidet die Haushaltszone', () => withSheet(() => {
  // Derselbe Zeitpunkt, 2026-09-23T20:00Z, und derselbe Check-in (06:30Z):
  // in Berlin ist beides der 23. (08:30 und 22:00) - heute, nur die Uhrzeit;
  // in Honolulu begann die Sitzung am 22. um 20:30, und jetzt ist der 23.
  at('2026-09-23T20:00:00Z', 'Europe/Berlin', () => {
    const row = hkRow(new Date());
    assert.equal(timeParam(row.timeLabel), SINCE_YESTERDAY, 'Berlin: heute, nur die Uhrzeit');
    assert.equal(row.time, '08:30');
  });
  at('2026-09-23T20:00:00Z', 'Pacific/Honolulu', () => {
    const row = hkRow(new Date());
    assert.match(row.timeLabel, /DM:2026-09-22, /, `Honolulu: gestern, mit Datum - bekam ${row.timeLabel}`);
    assert.equal(row.time, '');
  });
}));

// --------------------------------------------------------
// #1607: die Budget-Kachel fuehrt auf die Monatsuebersicht
// --------------------------------------------------------
// Das Budget merkt sich seinen zuletzt offenen Reiter (Modul-Singleton). Wer
// zuletzt in der Statistik stand, landete ueber „Eintrag hinzufuegen" der
// Kachel dort - auf einem Reiter ohne Anlegen. Die Kachel zeigt Einnahmen,
// Ausgaben und Saldo des Monats, also nennt jeder ihrer Wege diesen Reiter.
// Das Budget-Widget ist mit dem Raster gegangen; die Vorschau-Kachel bleibt.

// 2026-10-27, v2: die Kachel „Monatssaldo" ist mit Dziś v2 gegangen; der
// Reiter, auf den sie fuehrte, bleibt ein Ziel, das das Budget kennt.
test('#1607: der Reiter aus der Kachel ist einer, den das Budget kennt', async () => {
  globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
  globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
  globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {} };
  const { __test: budget } = await import('../public/pages/budget.js');
  assert.equal(budget.tabFromQuery('?tab=budget'), 'budget');
});

/* ZAHLEN TABELLARISCH (Critique R18, 2026-10-07). Gemessen trugen auf der
 * Uebersicht 20 von 62 Textknoten mit Ziffern `tabular-nums`: der Budgetsaldo
 * ja, die beiden Betraege darunter nicht; die Uhrzeit des Termins ja, die der
 * Familienkarte nicht. Die Liste nennt die Traeger von Geld, Zeit und Zaehlern
 * der Uebersicht; jeder muss von EINER tabular-Regel gedeckt sein (eigene
 * Klasse im letzten Glied, `font-variant-numeric` erbt auf die Kinder) und im
 * Markup der Uebersicht vorkommen - sonst prueft die Liste Luft. */
test('R18: Geld, Zeit und Zaehler der Uebersicht stehen in tabular-nums', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const tabular = new Set();
  for (const file of ['dashboard.css', 'panel.css', 'layout.css']) {
    for (const rule of eachRule(read(`../public/styles/${file}`))) {
      if (!/font-variant-numeric:\s*tabular-nums/.test(rule.body)) continue;
      for (const part of rule.selector.split(',')) {
        const last = part.trim().split(/[\s>+~]+/).pop();
        for (const cls of last.match(/\.[\w-]+/g) ?? []) tabular.add(cls.slice(1));
      }
    }
  }
  // TAFLA (2026-10-19): die Traeger des Rasters sind gegangen. Dziś und die
  // Wand setzen die tabellarischen Ziffern an ihrer Wurzel - jede Zahl darin
  // erbt sie, auch eine, die spaeter dazukommt.
  const roots = {
    // 2026-10-27, v2: die Wurzel von Dziś heisst `.dz`.
    dz: [read('../public/components/today-view.js'), /<div class="dz" data-today>/],
    wall: [read('../public/components/wall-view.js'), /<div class="wall" id="wall-surface"/],
  };
  for (const [cls, [source, root]] of Object.entries(roots)) {
    assert.ok(tabular.has(cls), `.${cls} traegt keine tabular-nums`);
    assert.match(source, root, `.${cls} ist die Wurzel im Markup`);
  }
});

// Critique R19: das Onboarding nannte am Desktop einen "+-Knopf unten rechts".
// Ab der Breite, ab der die Seitenleiste steht, dockt der Router den FAB als
// Pille in den Modulkopf oben rechts (dockFabIntoToolbar/isDesktopViewport).
// Die Desktop-Fassung beschreibt diesen Ort, in jeder Sprache, und beide Seiten
// schalten an derselben Breite.
test('Onboarding Schritt 3 nennt am Desktop den Knopf oben rechts, nicht unten (Critique R19)', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dashboard = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  const steps = dashboard.slice(dashboard.indexOf('function getOnboardingSteps'), dashboard.indexOf('function showOnboarding'));
  const onboardingBreak = /matchMedia\('\(min-width: (\d+)px\)'\)/.exec(steps)?.[1];
  const dockBreak = /function isDesktopViewport\(\) \{\s*return window\.matchMedia\('\(min-width: (\d+)px\)'\)/.exec(router)?.[1];
  assert.ok(onboardingBreak && dockBreak, 'Breakpoints nicht gefunden');
  assert.equal(onboardingBreak, dockBreak, 'Onboarding und angedockter Knopf schalten an verschiedenen Breiten');
  const bottom = { de: /unten/, en: /bottom/, fr: /\ben bas\b/, es: /inferior/, nl: /onder/, it: /in basso/ };
  const top = { de: /oben rechts/, en: /top right/, fr: /en haut/, es: /arriba/, nl: /rechtsboven/, it: /in alto/ };
  const dir = new URL('../public/locales/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const loc = file.slice(0, -5);
    const text = JSON.parse(readFileSync(new URL(file, dir), 'utf8')).onboarding.step3BodyDesktop;
    if (bottom[loc]) assert.doesNotMatch(text, bottom[loc], `${loc}: ${text}`);
    if (top[loc]) assert.match(text, top[loc], `${loc}: ${text}`);
  }
});

// Re-Critique 2026-10-17 (A1, Shell): der Rundgang war austauschbar - ein
// Lucide-Haus statt der Bildmarke, und Leiste und Plus-Knopf nur beschrieben.
// Schritt 1 traegt die Marke aus utils/brand-mark.js, Schritt 2 und 3 zeigen
// per Lichtring auf das echte Bedienelement, das ihr Text nennt. Der Ring ist
// Anzeige: das Overlay faengt weiter die Klicks, und die Tafel liegt ueber
// seinem Abdunkler (positioniert), sonst stuende sie selbst im Grau.
test('Onboarding: Bildmarke im ersten Schritt, Lichtring auf Leiste und Plus-Knopf (Re-Critique 2026-10-17)', async () => {
  const { readFileSync } = await import('node:fs');
  const dashboard = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const steps = dashboard.slice(dashboard.indexOf('function getOnboardingSteps'), dashboard.indexOf('function showOnboarding'));
  // Bis zum Ende der Funktion selbst: der Anpassen-Hinweis, der hier folgte,
  // ist mit dem Kopf der alten Uebersicht gegangen.
  const showAt = dashboard.indexOf('function showOnboarding');
  const show = dashboard.slice(showAt, dashboard.indexOf('\n}\n', showAt) + 2);
  assert.doesNotMatch(steps, /icon:\s*'home'/, 'kein generisches Haus als Zeichen des Produkts');
  assert.match(dashboard, /import \{ brandMarkSvg \} from '\/utils\/brand-mark\.js'/);
  assert.match(steps, /\{ mark: true,[^\n]*step1Title/, 'Schritt 1 traegt die Bildmarke');
  assert.match(show, /brandMarkSvg\(\)/);
  assert.match(steps, /step2Title[^\n]*\n\s*target: \(\) => document\.querySelector\(desktop \? '\.nav-sidebar' : '\.nav-bottom__items'\)/,
    'Schritt 2 zeigt auf die Seitenleiste bzw. die Kapsel');
  // Tafla: das globale + der Shell (Telefon) oder die Pille im Kopf (Desktop).
  assert.match(steps, /step3Title[^\n]*\n(?:\s*\/\/[^\n]*\n)?\s*target: \(\) => \[\.\.\.document\.querySelectorAll\('\.capture-plus, \.page-fab'\)\]/,
    'Schritt 3 zeigt auf den sichtbaren Plus-Knopf');
  assert.match(show, /function placeSpotlight\(\)/);
  assert.match(show, /classList\.toggle\('onboarding-overlay--spot', shown\)/, 'ohne sichtbares Ziel bleibt die Unschaerfe');
  assert.match(show, /spot\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(show, /removeEventListener\('resize', onResize\)/, 'der Ring haengt nach dem Rundgang an keinem Resize mehr');
  const rule = (sel) => (css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`)) || [])[1] || '';
  assert.match(rule('.onboarding-overlay--spot'), /backdrop-filter:\s*none/);
  assert.match(rule('.onboarding-spotlight'), /pointer-events:\s*none/);
  assert.match(rule('.onboarding-spotlight'), /box-shadow:[^;]*100vmax/);
  assert.match(rule('.onboarding-card'), /position:\s*relative/, 'die Tafel liegt ueber dem Abdunkler');
});

// --------------------------------------------------------
// Critique R19 (layout): die Uebersicht steht auf derselben Inhaltsspalte wie
// jedes Modul. Bis R19 war sie bis 1680px breit mit eigenem Polster; bei 1920
// begann sie bei x 270, die Module bei x 430. Ein eigenes Hoechstmass oder ein
// fester Seitenrand am Desktop liesse die Kante wieder springen.
// --------------------------------------------------------
test('die Uebersicht polstert am Desktop mit --page-inline-pad und kennt kein eigenes Hoechstmass', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const root = [...eachRule(css)].filter((r) => r.selector.trim() === '.dashboard');
  const desktop = root.filter((r) => r.at.some((a) => /min-width:\s*(\d+)px/.test(a) && Number(/min-width:\s*(\d+)px/.exec(a)[1]) >= 1024));
  assert.ok(desktop.length >= 1, 'keine Desktop-Regel fuer .dashboard');
  for (const rule of desktop) {
    const pad = /padding(?:-inline)?:\s*([^;]+);/.exec(rule.body)?.[1] ?? '';
    assert.match(pad, /var\(--page-inline-pad\)/, `${rule.at.join(' ')}: die Uebersicht polstert mit "${pad}" statt mit der Kante der Module`);
  }
  // Die zuletzt geltende Breite ohne At-Regel: kein festes Mass.
  const widths = root.filter((r) => !r.at.length && /max-width:/.test(r.body)).map((r) => /max-width:\s*([^;]+);/.exec(r.body)[1].trim());
  assert.equal(widths.at(-1), 'none', `die Uebersicht deckelt sich auf ${widths.at(-1)} - ihre Kante wiche von den Modulen ab`);
});

/* R19 (Entscheidung Ulas 2026-10-16, Critique P2 mobil): DIE UEBERSICHT AUF DEM
 * TELEFON. Das Wetter begann bei y 1438, ueber dem Gruss standen drei
 * Icon-Knoepfe. TAFLA: die Wetterzeile stand im Kopf von Dziś, der Wand-Modus
 * in „Dostosuj Dziś". 2026-10-27, v2: das Wetter ist die erste Karte unter dem
 * Kopf (die Frage des Morgens: regnet es heute?), der Wand-Modus steht in
 * „Więcej". (Die Avatar-Reihe der Familienkarte ging mit dem Raster.) */
test('R19 mobil: die Wetterkarte steht gleich unter dem Kopf von Dziś', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../public/components/today-view.js', import.meta.url), 'utf8');
  assert.match(view, /\$\{renderHeader\(state\)\}\s*\$\{state\.weather \? renderWeather\(state\.weather\) : ''\}/,
    'das Wetter ist das Erste nach dem Kopf');
  assert.match(src, /weather: weatherAvailable \? weatherCard\(weather, ctx\) : null,/);
});

test('R19 mobil: der Wand-Modus steht in „Więcej", nie am Display und nicht im Kopf von Dziś', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../public/components/today-view.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /enterWallMode|enterWallFromToday/, 'Dziś startet die Wand nicht selbst');
  assert.doesNotMatch(view, /data-day-action="(?:wall|customize)"/);
  const more = readFileSync(new URL('../public/pages/more.js', import.meta.url), 'utf8');
  const kitchen = more.slice(more.indexOf('function renderKitchen('), more.indexOf('function renderKitchen(') + 600);
  assert.match(kitchen, /if \(state\.user\?\.access_scope === 'display'\) return '';/, 'nie am Display');
  assert.match(kitchen, /data-more-action="wall"/);
});
