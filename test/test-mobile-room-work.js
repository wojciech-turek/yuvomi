/**
 * Test: Mobil gehoert der Platz dem Inhalt - Aufgaben, Kalender, Notizen (R9)
 *
 * Zweck: Die Re-Critique 2026-09-27 (P1 #3) mass auf 390x844, dass die
 *        Arbeitsmodule ihren Platz an Bedienung statt an Inhalt gaben. Diese
 *        Suite haelt die Umbauten fest, die das zurueckgeben:
 *          - M1 Aufgabenzeile: der Titel spannt mobil ueber beide Spalten, die
 *            Personenwahl verlaesst die Zeile, die Metazeile endet mit Ellipse;
 *          - M2 Kanban: mobil eine Spalte je Seite mit Scroll-Snap, Punkte
 *            zeigen die Spalte und fuehren per Tipp dorthin;
 *          - M5 Kalender: die Ansichtswahl steht mobil im Werkzeugmenue
 *            (`menuitemradio`), Termintitel der Woche brechen nach Blockhoehe um;
 *          - M13 Notizen: die Karte oeffnet selbst, der Titel ist nicht
 *            kleiner als der Text, mobil passt mehr als eine Notiz auf den
 *            Schirm.
 *        CSS wird ueber `eachRule()` gelesen (der Regelscanner kennt den
 *        @media-Kontext), Markup an den echten Renderern gemessen.
 *
 * Ausfuehren: node --loader ./test/test-browser-loader.mjs --test test/test-mobile-room-work.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eachRule } from './css-rules.js';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};
globalThis.document = globalThis.document ?? {
  documentElement: { classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } } },
};

const { __test: tasks } = await import('../public/pages/tasks.js');

const css = (file) => readFileSync(new URL(`../public/styles/${file}`, import.meta.url), 'utf8');
const tasksCss = css('tasks.css');

/** Alle Deklarationen eines Selektors, getrennt nach Kontext. */
function declarations(source, selector, { media = null } = {}) {
  const out = {};
  for (const rule of eachRule(source)) {
    const parts = rule.selector.split(',').map((p) => p.trim().replace(/\s+/g, ' '));
    if (!parts.includes(selector)) continue;
    const inMedia = rule.at.some((a) => a.startsWith('@media'));
    if (media === null ? inMedia : !rule.at.some((a) => a.includes(media))) continue;
    for (const m of rule.body.matchAll(/([\w-]+)\s*:\s*([^;]+)/g)) out[m[1]] = m[2].trim();
  }
  return out;
}

const MOBILE = 'max-width: 639px';

// --------------------------------------------------------------------------
// M1 Aufgabenzeile
// --------------------------------------------------------------------------

// TAFLA (2026-10-20): die R9-Antwort auf "der Titel hat keinen Platz" war ein
// Raster nur fuer Mobil (Stapel in der Metazeile, Titel ueber zwei Spalten).
// Tafla nimmt die Platzfresser aus der Zeile - kein Prioritaetswort, kein
// Avatar-Stapel (eine 20er-Scheibe nach der Personenregel), auf Touch kein
// Mehr-Knopf und kein Griff - und baut EINE Flexzeile fuer jede Breite: Kreis
// in einer 28er-Spalte, 12 Luft, Titel bei x=56. Gemessen 390x844: Titel
// 254-282 von 358px wie zuvor, ohne zweite Bauart je Breite.
test('Tafla: die Aufgabenzeile ist eine Flexzeile, Titel bei 56, hinten nur Fahne und Person', () => {
  const row = declarations(tasksCss, '.tasks-page .task-card__main');
  assert.equal(row.display, 'flex');
  assert.equal(row.gap, 'var(--space-3)', '12 Luft nach der 28er-Spalte');
  assert.match(row.padding ?? '', /var\(--space-4\)$/, '16 Polster an den Kanten');
  assert.equal(row['min-block-size'], '64px', 'zweizeilig 64 hoch');
  assert.equal(declarations(tasksCss, '.tasks-page .task-card--single > .task-card__main')['min-block-size'], '48px',
    'ohne Metazeile 48');
  assert.deepEqual(declarations(tasksCss, '.task-card__main', { media: MOBILE }), {},
    'kein eigenes Mobil-Raster mehr');
  const card = tasks.renderTaskCard({
    id: 4, title: 'Zahnarzt', status: 'open', priority: 'high', visibility: 'all',
    due_date: null, subtasks: [], assigned_users: [{ id: 99, display_name: 'Wojtek' }],
  });
  assert.doesNotMatch(card, /avatar-stack|priority-badge/, 'kein Stapel, kein Prioritaetswort');
  assert.match(card, /class="task-card__flag task-card__flag--high"/, 'die Fahne nur fuer Hoch und Dringend');
  assert.match(card, /class="person-disc person-disc--sm"/, 'die Aufgabe einer anderen Person traegt ihre Scheibe');
});

// Re-Critique 2026-09-28 (P8 / A3 P2-2): am Desktop stand die Personenwahl
// als zweites Leading-Control neben jedem Statuskreis - "wer hat erledigt"
// ist erst NACH dem Erledigen eine Frage. Die Regel gilt jetzt auf jeder
// Breite; der Weg bleibt Detail-Fuss, Kontextmenue und Long-Press.
test('M1/P8: auf keiner Breite nimmt die Personenwahl der Zeile Platz, bleibt aber Anker ihres Menues', () => {
  const doer = declarations(tasksCss, '.task-card__main > .task-doer-btn');
  assert.equal(doer.position, 'absolute', 'aus dem Fluss - der Titel bekommt ihre 44px');
  assert.equal(doer.visibility, 'hidden', 'unsichtbar und aus der Tab-Folge; der Tastaturweg ist das Detail');
  assert.notEqual(doer.display, 'none',
    'nicht display:none - das Menue richtet sich am Ausloeser aus und ginge sonst an der Fensterecke auf');
});

test('Tafla: der Statuskreis ist die 28er-Spalte, trifft aber weiter voll', () => {
  const btn = declarations(tasksCss, '.tasks-page .task-card__main > .task-status-btn');
  assert.equal(btn.width, '28px', 'die Box ist die Spalte, nicht die Trefflaeche - sonst waere die Zeile 52 statt 48');
  const hit = declarations(tasksCss, '.tasks-page .task-card__main > .task-status-btn::before');
  assert.match(hit['inset-inline-start'] ?? '', /var\(--target-base\)/,
    'die Trefflaeche bleibt --target-base und steht zentriert ueber dem Ring');
  assert.match(hit['inset-block-start'] ?? '', /var\(--target-base\)/);
});

// Integration R9 (Sonde 4 der Dokument-Guards, mobil): der Titel mass 267x20
// und nahm die Spacing-Ausnahme, obwohl ueber ihm 8px Zeilenpolster leer
// stehen. Sein ::before sollte die Flaeche heben, aber `overflow: hidden` (die
// Ellipse) beschneidet es auf die Textzeile - im Raster wie vorher im Fluss.
// Die Flaeche waechst deshalb per Polster und hebt es mit dem Rand wieder auf:
// der Text bleibt, wo er ist, die Box reicht bis an die Zeilenkante.
// Tafla: dieselbe Regel gilt jetzt auf JEDER Breite (die Zeile hat keine
// Mobil-Fassung mehr) - die Basisregel des Titels traegt Polster und Rand.
test('M1: die Trefferflaeche des Titels reicht ins Zeilenpolster, trotz Ellipse', () => {
  // Seit R19 setzt die EINE Titelregel in typography.css die Kappung
  // (hoechstens zwei Zeilen, `overflow: hidden`), nicht mehr tasks.css - die
  // Voraussetzung liest deshalb dort. Sie gilt unveraendert: was kappt, klippt
  // auch ein ::before.
  const base = declarations(css('typography.css'), '.task-card__title');
  assert.equal(base.overflow, 'hidden', 'Voraussetzung: die Ellipse beschneidet ein ::before');
  const title = declarations(tasksCss, '.task-card__title');
  const pad = title['padding-block-start'];
  assert.match(pad ?? '', /var\(--list-row-pad/, 'die Box waechst um das Zeilenpolster nach oben');
  assert.equal(title['margin-block-start'], `calc(-1 * ${pad})`, 'und der Rand nimmt es wieder zurueck - der Text bleibt stehen');
  assert.equal(title['padding-block-end'], 'var(--space-0h)', 'unten bis an die Metazeile, keinen Pixel weiter');
  assert.equal(title['margin-block-end'], '0');
  assert.equal(declarations(tasksCss, '.tasks-page .task-card__main')['--list-row-pad'], 'var(--space-2)',
    'das Polster, an dem die Flaeche haengt, steht an der Zeile');
});

test('M1: die Metazeile endet mit Ellipse statt mit einem Schnitt', () => {
  const card = tasks.renderTaskCard({
    id: 3, title: 'Zahnarzt', status: 'open', priority: 'high', visibility: 'all',
    due_date: '2026-09-01', subtasks: [], assigned_users: [],
  });
  // Tafla: das Wann steht als Wort im Text der Metazeile ("od pt 16 paź"),
  // ueberfaellig als Pille davor - der Text ist der Traeger der Ellipse.
  assert.match(card, /<span class="task-card__meta-text">/, 'der Text der Metazeile hat einen eigenen Traeger');
  const text = declarations(tasksCss, '.task-card__meta-text');
  assert.equal(text['text-overflow'], 'ellipsis');
  assert.equal(text['min-width'], '0', 'ohne min-width 0 schrumpft der Flex-Text nie und die Zeile klippt');
  assert.equal(declarations(tasksCss, '.task-card__meta')['white-space'], 'nowrap');
  assert.equal(declarations(tasksCss, '.status-pill').flex, 'none', 'die Pille gibt nicht nach, der Text schon');
});

// --------------------------------------------------------------------------
// M2 Kanban mobil
// --------------------------------------------------------------------------

test('M2: mobil blaettert das Brett spaltenweise mit Scroll-Snap', () => {
  const board = declarations(tasksCss, '.kanban-board', { media: MOBILE });
  assert.equal(board['grid-auto-flow'], 'column', 'die Spalten stehen nebeneinander, nicht untereinander');
  assert.equal(board['grid-auto-columns'], '100%', 'eine Spalte je Seite');
  assert.equal(board['scroll-snap-type'], 'x mandatory');
  assert.equal(board['overflow-x'], 'auto');
  assert.equal(declarations(tasksCss, '.kanban-col', { media: MOBILE })['scroll-snap-align'], 'start');
  assert.equal(declarations(tasksCss, '.kanban-pager').display, 'none', 'ab 640px keine Punkte');
  assert.equal(declarations(tasksCss, '.kanban-pager', { media: MOBILE }).display, 'flex');
});

test('M2: die Karte ist mobil so flach wie eine Zeile - Avatar und Status in derselben Zeile', () => {
  assert.equal(declarations(tasksCss, '.kanban-card', { media: MOBILE }).display, 'grid');
  assert.equal(declarations(tasksCss, '.kanban-card__footer', { media: MOBILE }).display, 'contents',
    'die Fusszeile loest sich auf - Avatar und Knopf werden Rasterzellen neben dem Titel');
  assert.equal(declarations(tasksCss, '.kanban-card__status-btn', { media: MOBILE })['grid-row'], '1 / span 2');
});

test('M2: je Spalte ein Punkt, benannt nach der Spalte, der erste ist aktuell', () => {
  const cols = tasks.KANBAN_COLS();
  const html = tasks.kanbanPagerHtml(cols);
  const dots = [...html.matchAll(/data-kanban-page="([\w_]+)"\s+aria-label="([^"]*)"(\s+aria-current="true")?/g)];
  assert.deepEqual(dots.map((m) => m[1]), cols.map((c) => c.status), 'ein Punkt je Spalte, in Brettreihenfolge');
  assert.deepEqual(dots.map((m) => m[2]), cols.map((c) => c.label), 'jeder Punkt nennt seine Spalte');
  assert.deepEqual(dots.map((m) => Boolean(m[3])), cols.map((_, i) => i === 0), 'genau einer ist aktuell');
});

test('M2: ein Tipp auf einen Punkt blaettert zu dessen Spalte und markiert ihn', () => {
  const cols = tasks.KANBAN_COLS();
  const listeners = {};
  const left = { open: 16, in_progress: 386, done: 756, archived: 1126 };
  const scrolled = [];
  const dots = cols.map((c) => {
    const attrs = {};
    return {
      dataset: { kanbanPage: c.status },
      setAttribute(k, v) { attrs[k] = v; }, removeAttribute(k) { delete attrs[k]; }, attrs,
      closest() { return this; },
    };
  });
  const colEls = Object.fromEntries(cols.map((c) => [c.status, {
    dataset: { status: c.status }, getBoundingClientRect: () => ({ left: left[c.status] }),
  }]));
  const board = {
    scrollWidth: 1468, clientWidth: 358,
    getBoundingClientRect: () => ({ left: 16 }),
    querySelector: (sel) => colEls[/data-status="([\w_]+)"/.exec(sel)?.[1]] ?? null,
    querySelectorAll: () => Object.values(colEls),
    scrollBy: (opts) => scrolled.push(opts),
    addEventListener() {},
  };
  const pager = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    querySelectorAll: () => dots,
  };
  const container = { querySelector: (sel) => (sel === '.kanban-board' ? board : sel === '.kanban-pager' ? pager : null) };
  const vorher = globalThis.window;
  globalThis.window = { ...(vorher ?? {}), matchMedia: () => ({ matches: true }) };
  try {
    tasks.wireKanbanPager(container);
    const done = dots[cols.findIndex((c) => c.status === 'done')];
    listeners.click({ target: done });
    assert.deepEqual(scrolled.at(-1), { left: 740, behavior: 'auto' },
      'um genau den Abstand der Spalte zum Traeger - ohne Animation bei reduzierter Bewegung');
    assert.equal(done.attrs['aria-current'], 'true', 'der getippte Punkt ist jetzt der aktuelle');
    assert.equal(dots[0].attrs['aria-current'], undefined, 'und nur er');
  } finally {
    globalThis.window = vorher;
  }
});

// --------------------------------------------------------------------------
// M5 Kalender mobil
// --------------------------------------------------------------------------

const { __test: calendar } = await import('../public/pages/calendar.js');
const calendarCss = css('calendar.css');

test('M5: der Kopf traegt ein Ansichtsmenue mit genau einer gewaehlten Ansicht', () => {
  const vorher = calendar.state.view;
  calendar.state.view = 'week';
  try {
    const html = calendar.toolbarHtml();
    assert.match(html, /id="cal-views-menu"[^>]*popovertarget="cal-views-menu-panel"[^>]*aria-haspopup="menu"/,
      'der Ausloeser oeffnet das Menue und kuendigt es an');
    const items = [...html.matchAll(/role="menuitemradio" aria-checked="(true|false)"[\s\S]*?data-cal-view="(\w+)"\s+aria-keyshortcuts="(\w)"/g)];
    assert.deepEqual(items.map((m) => m[2]), ['month', 'week', 'day', 'agenda'], 'alle vier Ansichten, Reihenfolge des Segments');
    assert.deepEqual(items.filter((m) => m[1] === 'true').map((m) => m[2]), ['week'], 'genau die aktuelle ist gewaehlt');
    assert.deepEqual(items.map((m) => m[3]), ['m', 'w', 'd', 'a'], 'die Eintraege sagen ihre Kuerzel an wie die Tabs');
    assert.match(html, /role="tablist"/, 'das Segment bleibt fuer breite Schirme im Markup');
  } finally {
    calendar.state.view = vorher;
  }
});

// D1 (Critique 2026-10-16), seit Tafla (2026-10-24): der Ausloeser ist der
// Kreis der Ansicht (`.cal-toolbar__view-menu`) und folgt mit der Lupe dem
// Titel in Zeile 1 (DOM-Reihenfolge der Werkzeuggruppe); der Zeitraum rueckt
// per `order` als eigene Zeile dahinter.
test('M5: mobil ersetzt das Menue das Segment, und der Kopf hat zwei Zeilen', () => {
  assert.equal(declarations(calendarCss, '.cal-toolbar__view-menu').display, 'none', 'am Desktop waehlt das Segment');
  assert.equal(declarations(calendarCss, '.cal-toolbar__view-menu', { media: MOBILE }).display, 'inline-flex');
  assert.equal(declarations(calendarCss, '.cal-toolbar__views', { media: MOBILE }).display, 'none');
  const bar = declarations(calendarCss, '.page-toolbar--period-title.cal-toolbar > .cal-toolbar__bar', { media: MOBILE });
  assert.equal(bar.display, 'contents', 'die Bar-Zeile loest sich auf - ihre Werkzeuge ruecken in die Titelzeile');
  const center = declarations(calendarCss, '.page-toolbar.cal-toolbar.page-toolbar--wrap > .page-toolbar__center', { media: MOBILE });
  assert.equal(center['flex-basis'], '100%', 'der Zeitraum behaelt die zweite Zeile fuer sich (Label nicht angeschnitten)');
  assert.equal(center.order, '2', 'Werkzeuge vor dem Zeitraum: sie stehen in Zeile 1');
  const stepper = declarations(calendarCss, '.cal-toolbar__stepper', { media: MOBILE });
  assert.equal(stepper.flex, '1 1 0', 'der Stepper nimmt die Zeile des Zeitraums');
});

test('M5: Termintitel der Woche brechen nach Blockhoehe um statt nowrap', () => {
  const title = declarations(calendarCss, '.week-event__title');
  assert.notEqual(title['white-space'], 'nowrap', 'nowrap schnitt jeden Titel nach einem Wort ab');
  const span = declarations(calendarCss, '.week-event__title > span:last-child');
  assert.match(span['-webkit-line-clamp'] ?? '', /var\(--ev-title-lines, 1\)/, 'ohne Hoehe bleibt es eine Zeile');
  const stufen = [];
  for (const rule of eachRule(calendarCss)) {
    const at = rule.at.find((a) => a.startsWith('@container ev-block'));
    if (!at || rule.selector.trim() !== '.week-event__title') continue;
    const lines = /--ev-title-lines:\s*(\d)/.exec(rule.body);
    if (lines) stufen.push(Number(lines[1]));
  }
  assert.deepEqual(stufen, [2, 3, 4], 'zwei bis vier Zeilen, gestaffelt nach der Hoehe des Blocks');
});

// --------------------------------------------------------------------------
// M13 Notizen mobil
// --------------------------------------------------------------------------

const { __test: notes } = await import('../public/pages/notes.js');
const notesCss = css('notes.css');

test('M13: die Karte oeffnet selbst - der Oeffnen-Knopf ist kein Kreis in der Fusszeile mehr', () => {
  const html = notes.renderNoteCard({ id: 5, title: 'Einkauf', content: 'Milch', color: '#ffcc00', pinned: 0 });
  const open = /<button type="button" class="note-card__open" data-action="open" data-id="5"\s+aria-label="([^"]+)"><\/button>/.exec(html);
  assert.ok(open, 'ein leerer Knopf ohne Icon - er traegt nur Namen und Flaeche');
  assert.ok(open[1].length > 0, 'sein Name nennt die Notiz fuer Tastatur und Vorlesehilfe');
  const footer = html.slice(html.indexOf('note-card__footer'));
  assert.doesNotMatch(footer, /note-card__open/, 'in der Fusszeile stehen nur noch Urheber und Loeschen');
  assert.ok(html.indexOf('note-card__open') < html.indexOf('note-card__pin'),
    'er kommt vor der Nadel: in der Tab-Folge zuerst die Karte, dann ihre Aktionen');

  const btn = declarations(notesCss, '.note-card__open');
  assert.equal(btn.position, 'absolute');
  assert.equal(btn.inset, '0', 'er liegt ueber der ganzen Karte');
  assert.equal(declarations(notesCss, '.note-card__pin')['z-index'], '1', 'die Nadel liegt darueber');
  const oben = declarations(notesCss, '.note-card__content .note-md-box');
  assert.equal(oben['z-index'], '1', 'Checklisten-Haken bleiben antippbar, ohne die Notiz zu oeffnen (#704)');
});

test('M13: der Titel ist nicht kleiner als der Text, auf keiner Breite', () => {
  const size = (value) => ({ '--type-card-title': 17, '--type-body': 17, '--type-secondary': 15 })[/var\((--[\w-]+)\)/.exec(value ?? '')?.[1]];
  const titel = size(declarations(notesCss, '.note-card .note-card__title')['font-size']);
  assert.ok(titel, 'der Kartentitel setzt eine Rolle');
  assert.ok(titel >= size(declarations(notesCss, '.note-card__content')['font-size']), 'Desktop: Titel >= Text');
  assert.ok(titel >= size(declarations(notesCss, '.note-card__content', { media: MOBILE })['font-size'] ?? declarations(notesCss, '.note-card__content')['font-size']),
    'mobil: Titel >= Text');
});

// TAFLA (2026-10-20): the note is a 64 row (or a pinned tile) with a one-line
// preview, and on a phone it carries no pin and no "⋯" at all (spec "Lista
// grupowana + wiersz": on touch there is no ⋯). Pinning lives in the editor,
// deleting in the reader's footer. The old card rule (three preview lines,
// a more button hanging into the padding) described a card that is gone.
test('M13/Tafla: mobil ist die Notiz eine Zeile - eine Zeile Vorschau, keine Kreise am Finger', () => {
  const html = notes.renderNoteCard({ id: 5, title: 'Einkauf', content: 'Milch\nBrot', color: '#ffcc00', pinned: 0 });
  assert.match(html, /class="note-card note-card--row inset-row"/, 'die Notiz ist eine Zeile der gruppierten Liste');
  assert.match(html, /class="note-card__preview inset-row__meta">Milch, Brot</, 'die Vorschau ist eine Zeile');
  assert.doesNotMatch(html, /note-card__footer/, 'keine Fusszeile mehr');
  // Out of the picture, not out of the focus tree (frontend-audit: "Zeilen-
  // aktionen ziehen sich auf Touch zurueck, ohne unerreichbar zu werden").
  const touch = declarations(notesCss, '.note-card__pin:not(:focus-visible)', { media: '(hover: none)' });
  assert.equal(touch['clip-path'], 'inset(50%)', 'am Finger keine Nadel auf der Zeile');
  assert.equal(declarations(notesCss, '.note-card > .note-card__actions:not(:focus-within)', { media: '(hover: none)' })['clip-path'], 'inset(50%)',
    'und kein Mehr-Knopf');
});

// Re-Critique 2026-09-28 (P8 / A3 P3-2): mobil brach der Detail-Fuss einer
// Aufgabe auf zwei Reihen (Loeschen/Erledigen/Person, dann Starten/
// Archivieren - gemessen 133px, "Aufgabe archivieren" allein 188px breit).
// Starten und Archivieren gehen mobil in EIN Mehr-Menue; ihre Knoepfe bleiben
// im DOM (Sperrlogik der Statusknoepfe, Handler), das Menue loest sie aus.
test('P8: der Detail-Fuss einer Aufgabe ist eine Reihe - Starten und Archivieren im Mehr-Menue', () => {
  const dv = css('detail-view.css');
  const all = [...eachRule(dv)];
  // Re-Kritik 2026-10-17: bis dahin galt das Menue nur mobil ("am Desktop
  // passen alle Aktionen"). Mit Erledigen als Primaerknopf passten sie dort
  // nicht mehr (Spalte 756 > 670px bei 1440, Blatt bei 834px zwei Reihen) -
  // das Menue gilt jetzt in jeder Breite (test:master-detail).
  const hide = all.find((r) => r.selector.includes('.detail-view__footer:has(> .task-detail__more) > .task-detail__overflow'));
  assert.ok(hide && /display:\s*none/.test(hide.body), 'Starten und Archivieren treten in das Menue');
  const show = all.find((r) => r.selector.trim() === '.detail-view__footer > .task-detail__more');
  assert.match(show?.body ?? '', /display:\s*inline-flex/);
  const src = readFileSync(new URL('../public/components/task-detail.js', import.meta.url), 'utf8');
  assert.match(src, /id: MORE_BUTTON_ID/, 'der Mehr-Knopf ist eine Aktion des Fusses');
  assert.match(src, /classList\.add\('task-detail__overflow'\)/, 'Starten und Archivieren werden als ueberlaufend markiert');
  assert.match(src, /\.click\(\)/, 'ein Menueeintrag loest den echten Knopf aus - ein Handler, eine Sperrlogik');
});
