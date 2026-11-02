/**
 * Modul: Das "+" auf Dziś und sein Menue (Quick-Add, 2026-10-29, Task 12)
 * Zweck: Der Owner: "a '+' sign bottom right that lets me pick what i want to
 *        add and then opens the correct bottom sheet". Geprueft wird:
 *          - addMenuItems: welche Zeilen das Schreibrecht der Module erlaubt,
 *            in der Reihenfolge Say it, Task, Event, Shopping item (One Today,
 *            Task 14: Meal ist aus dem Menue; Say it steht, sobald eine der drei
 *            Zeilen darunter steht - der Satz wird, was er ist);
 *          - openAddMenu: EIN Blatt (Titel, klein, ohne Dirty-Waechter), "Say
 *            it" hervorgehoben oben mit Beispielsatz, darunter die Zeilen;
 *          - ein Tipp schliesst das Menue und oeffnet das passende Blatt mit
 *            `user` und `onChanged` - "Say it" noch IM Tipp (Safari startet
 *            die Erkennung nur in der Geste) und mit den Rechten, ein Fehler
 *            wird eine Meldung;
 *          - Dziś baut den Knopf `fab-add` nur mit einer Zeile und nie am
 *            Display (Kuchnia-Tablet);
 *          - die Quelltext-Zusagen: task-dictation.js (startQuickAdd) kommt
 *            statisch in add-menu.js herein, die drei anderen Blaetter per
 *            import() wie "Dodaj zadanie"; Dziś laedt das Menue erst beim Tipp
 *            auf das +.
 * Ausfuehren: npm run test:add-menu
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installMiniDom } from './mini-dom.js';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};
installMiniDom();
globalThis.window = globalThis.window ?? {};
const toasts = [];
globalThis.window.yuvomi = { showToast: (...args) => { toasts.push(args); } };

const { addMenuItems, openAddMenu, __test: menu } = await import('../public/components/add-menu.js');
const { startQuickAdd, startTaskDictation } = await import('../public/components/task-dictation.js');
const { __test: dash } = await import('../public/pages/dashboard.js');

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const ALL_WRITE = { tasks: 'write', calendar: 'write', shopping: 'write' };
const NONE = { tasks: 'none', calendar: 'none', shopping: 'none' };

test('addMenuItems: Task, Event, Shopping item each need write on their module; Say it stands with any of them; no Meal', () => {
  assert.deepEqual(addMenuItems({ tasks: 'write', calendar: 'read', shopping: 'write' }).map((i) => i.id),
    ['say', 'task', 'shopping']);
  assert.deepEqual(addMenuItems(NONE), []);
  assert.deepEqual(addMenuItems(ALL_WRITE).map((i) => i.id), ['say', 'task', 'event', 'shopping'], 'in the mockup order');
  assert.deepEqual(addMenuItems({ tasks: 'read', calendar: 'write', shopping: 'read' }).map((i) => i.id),
    ['say', 'event'], 'Say it routes: an event sentence lands in the calendar');
  assert.deepEqual(addMenuItems({ tasks: 'none', calendar: 'none', shopping: 'write' }).map((i) => i.id), ['say', 'shopping']);
  assert.deepEqual(addMenuItems({ ...NONE, meals: 'write' }), [], 'Meal left the menu: meals alone offers nothing');
  assert.deepEqual(addMenuItems({}), [], 'nothing known, nothing offered');
  assert.deepEqual(addMenuItems(), []);
});

/** Ein Blatt mit EINEM Container, der Klick-Listener merkt; Zeilen sind Ziele mit data-add. */
function fakePanel() {
  const root = {
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    removeEventListener() {},
  };
  return {
    root,
    querySelector: (sel) => (sel === '[data-add-menu]' ? root : null),
    querySelectorAll: () => [],
    rows: {},
    /** Ein Tipp auf die Zeile `id`: das Ziel ist ihr Zeichen, `closest` findet die Zeile. */
    tap(id) {
      const attrs = new Map();
      const row = this.rows[id] ??= {
        dataset: { add: id },
        attrs,
        setAttribute: (name, value) => { attrs.set(name, String(value)); },
        removeAttribute: (name) => { attrs.delete(name); },
        getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
      };
      const target = { closest: (sel) => (sel === '[data-add]' ? row : null) };
      for (const fn of root.listeners.click ?? []) fn({ target, preventDefault() {} });
    },
  };
}

function setup() {
  const opened = [];
  const closed = [];
  const calls = [];
  globalThis.__openModal = (opts) => { opened.push(opts); };
  globalThis.__closeModal = (opts) => { closed.push(opts); calls.push('close'); return true; };
  const openers = {};
  for (const id of ['say', 'task', 'event', 'shopping']) {
    openers[id] = (opts) => { calls.push(id); openers[id].got = opts; return id === 'say' ? true : Promise.resolve(true); };
  }
  return {
    opened, closed, calls, openers,
    done() { delete globalThis.__openModal; delete globalThis.__closeModal; toasts.length = 0; },
  };
}

test('openAddMenu: one small sheet, "Say it" highlighted on top with its example, then the rows - no Meal', () => {
  const s = setup();
  try {
    assert.equal(openAddMenu({ user: { id: 1 }, onChanged() {}, access: ALL_WRITE }, { openers: s.openers }), true);
    assert.equal(s.opened.length, 1);
    const [opts] = s.opened;
    assert.equal(opts.title, 'dashboard.addMenuTitle');
    assert.equal(opts.size, 'sm');
    assert.equal(opts.dirtyGuard, false, 'a menu has nothing to lose');
    const html = opts.content;
    const order = ['data-add="say"', 'data-add="task"', 'data-add="event"', 'data-add="shopping"'].map((m) => html.indexOf(m));
    assert.ok(order.every((pos) => pos >= 0), `every row is drawn: ${order}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'in the mockup order');
    assert.match(html, /<button type="button" class="add-menu__say" data-add="say"/, 'the highlighted row is a button');
    assert.match(html, /data-lucide="mic"/);
    assert.match(html, />quickAdd\.title</, '"Say it" - no longer "Say a task"');
    assert.doesNotMatch(html, /tasks\.dictation\.title/);
    assert.match(html, />dashboard\.addMenuSayHint</, 'the example sentence under it');
    assert.match(html, /aria-describedby="add-menu-say-hint"/, 'the example is a description, not part of the name');
    for (const key of ['dashboard.fabTask', 'dashboard.fabCalendar', 'dashboard.addMenuShopping']) {
      assert.match(html, new RegExp(`>${key.replace('.', '\\.')}<`), `${key} names its row`);
    }
    assert.doesNotMatch(html, /data-add="meal"|newLabel\.meals|data-lucide="utensils"/, 'Meal left the menu');
    assert.equal((html.match(/<button type="button"/g) || []).length, 4, 'four rows, four buttons');
  } finally { s.done(); }
});

test('openAddMenu: only the rows the access allows; none -> no sheet', () => {
  const s = setup();
  try {
    openAddMenu({ user: { id: 1 }, access: { tasks: 'read', calendar: 'write', shopping: 'none' } }, { openers: s.openers });
    const html = s.opened[0].content;
    assert.match(html, /data-add="event"/);
    assert.match(html, /class="add-menu__say" data-add="say"/, 'Say it stands with the event row: it can fill it');
    for (const gone of ['task', 'shopping', 'meal']) assert.doesNotMatch(html, new RegExp(`data-add="${gone}"`));
    assert.equal(openAddMenu({ user: { id: 1 }, access: NONE }, { openers: s.openers }), false);
    assert.equal(openAddMenu({ user: { id: 1 }, access: { ...NONE, meals: 'write' } }, { openers: s.openers }), false, 'meals alone: nothing to add');
    assert.equal(s.opened.length, 1, 'nothing to add, no sheet');
  } finally { s.done(); }
});

test('a tap closes the menu, then opens its sheet with user and onChanged', async () => {
  const user = { id: 7, display_name: 'Wojtek' };
  const onChanged = () => {};
  for (const id of ['task', 'event', 'shopping']) {
    const s = setup();
    try {
      openAddMenu({ user, onChanged, access: ALL_WRITE }, { openers: s.openers });
      const panel = fakePanel();
      s.opened[0].onSave(panel);
      panel.tap(id);
      assert.deepEqual(s.calls, ['close', id], `${id}: the menu closes first`);
      assert.deepEqual(s.closed, [{ force: true }], `${id}: closed without asking`);
      assert.equal(s.openers[id].got.user, user, `${id}: the user goes along (shopping remembers its list per user)`);
      assert.equal(s.openers[id].got.onChanged, onChanged, `${id}: Dziś refreshes after a save`);
    } finally { s.done(); }
  }
});

test('"Say it" starts inside the tap: no await, no promise between the tap and the opener; it gets the rights', () => {
  const s = setup();
  try {
    const user = { id: 1 };
    const onChanged = () => {};
    const access = { tasks: 'write', calendar: 'read', shopping: 'write' };
    openAddMenu({ user, onChanged, access }, { openers: s.openers });
    const panel = fakePanel();
    s.opened[0].onSave(panel);
    panel.tap('say');
    // Synchron gemessen: haette der Handler vor dem Oeffner gewartet, stuende
    // hier erst 'close' (oder gar nichts) - Safari meldete `not-allowed`.
    assert.deepEqual(s.calls, ['close', 'say'], 'the opener ran before the handler returned');
    assert.equal(s.openers.say.got.user, user);
    assert.equal(s.openers.say.got.onChanged, onChanged);
    assert.deepEqual(s.openers.say.got.access, access, 'Say it routes only to what may be written');
  } finally { s.done(); }
});

test('a sheet that fails to open says so in a toast, and a tap beside the rows does nothing', async () => {
  const s = setup();
  const errors = [];
  const realError = console.error;
  console.error = (...args) => { errors.push(args); };
  try {
    s.openers.event = () => Promise.reject(Object.assign(new Error('Failed to fetch dynamically imported module'), { status: 0 }));
    s.openers.say = () => { throw new Error('boom'); };
    openAddMenu({ user: { id: 1 }, access: ALL_WRITE }, { openers: s.openers });
    const panel = fakePanel();
    s.opened[0].onSave(panel);
    panel.tap('event');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0][1], 'danger');
    assert.doesNotMatch(toasts[0][0], /dynamically imported/, 'the browser text never reaches the toast');
    panel.tap('say');
    assert.equal(toasts.length, 2, 'a throwing opener is reported too');
    assert.equal(errors.length, 2, 'and logged');
    const before = s.calls.length;
    for (const fn of panel.root.listeners.click) fn({ target: { closest: () => null } });
    assert.equal(s.calls.length, before, 'between the rows: nothing closes, nothing opens');
  } finally { console.error = realError; s.done(); }
});

// --------------------------------------------------------------------------
// F8: die drei Blaetter laden nach - bis dahin dreht die getippte Zeile, und
// wer inzwischen weitergegangen ist, bekommt das Blatt nicht mehr.
// --------------------------------------------------------------------------

/** Ein Oeffner mit Lade- und Oeffnungsschritt, dessen Laden der Test freigibt. */
function deferredOpener(calls, id, { opened = true } = {}) {
  let release;
  const loaded = new Promise((resolve) => { release = resolve; });
  const entry = {
    load: () => { calls.push(`load:${id}`); return loaded; },
    open: (mod, opts) => { calls.push(`open:${id}`); entry.got = { mod, opts }; return Promise.resolve(opened); },
    release: (mod = { id }) => release(mod),
  };
  return entry;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

function withLocation(pathname, run) {
  const prev = globalThis.location;
  globalThis.location = { pathname, search: '', hash: '' };
  return Promise.resolve().then(run).finally(() => { globalThis.location = prev; });
}

test('a sheet that still loads keeps the menu open with the tapped row busy; then the sheet takes over', () => withLocation('/', async () => {
  const s = setup();
  let menuOpen = true;
  globalThis.__isOwnModalOpen = () => menuOpen;
  try {
    const user = { id: 7 };
    const onChanged = () => {};
    s.openers.event = deferredOpener(s.calls, 'event');
    s.openers.event.open = (mod, opts) => { s.calls.push('open:event'); s.openers.event.got = { mod, opts }; menuOpen = false; return Promise.resolve(true); };
    openAddMenu({ user, onChanged, access: ALL_WRITE }, { openers: s.openers });
    const panel = fakePanel();
    s.opened[0].onSave(panel);
    panel.tap('event');
    assert.deepEqual(s.calls, ['load:event'], 'loading - the menu is not closed yet');
    assert.equal(panel.rows.event.getAttribute('aria-busy'), 'true', 'the tapped row says it is busy');
    // Ein zweiter Tipp waehrend des Ladens oeffnet nichts dazu.
    panel.tap('task');
    assert.deepEqual(s.calls, ['load:event'], 'one sheet at a time');
    s.openers.event.release({ openNewEventFrom: true });
    await flush();
    assert.deepEqual(s.calls, ['load:event', 'open:event'], 'the sheet replaces the menu (openModal closes it itself)');
    assert.equal(s.openers.event.got.opts.user, user);
    assert.equal(s.openers.event.got.opts.onChanged, onChanged);
    assert.equal(panel.rows.event.getAttribute('aria-busy'), 'false', 'busy ends');
    assert.deepEqual(s.closed, [], 'the menu was replaced, not closed by hand');
  } finally { delete globalThis.__isOwnModalOpen; s.done(); }
}));

test('the route changed while the sheet loaded: nothing opens over the new page', () => withLocation('/', async () => {
  const s = setup();
  try {
    s.openers.event = deferredOpener(s.calls, 'event');
    openAddMenu({ user: { id: 1 }, access: ALL_WRITE }, { openers: s.openers });
    const panel = fakePanel();
    s.opened[0].onSave(panel);
    panel.tap('event');
    globalThis.location = { pathname: '/shopping', search: '', hash: '' };
    s.openers.event.release();
    await flush();
    assert.ok(!s.calls.includes('open:event'), 'the opener is dropped');
  } finally { s.done(); }
}));

test('the menu was closed while the sheet loaded: nothing opens', () => withLocation('/', async () => {
  const s = setup();
  let menuOpen = true;
  globalThis.__isOwnModalOpen = () => menuOpen;
  try {
    s.openers.shopping = deferredOpener(s.calls, 'shopping');
    openAddMenu({ user: { id: 1 }, access: ALL_WRITE }, { openers: s.openers });
    const panel = fakePanel();
    s.opened[0].onSave(panel);
    panel.tap('shopping');
    menuOpen = false; // weggewischt
    s.openers.shopping.release();
    await flush();
    assert.ok(!s.calls.includes('open:shopping'));
    assert.equal(panel.rows.shopping.getAttribute('aria-busy'), 'false');
  } finally { delete globalThis.__isOwnModalOpen; s.done(); }
}));

test('the route changed while the opener fetched its data: the sheet it opened is closed again', () => withLocation('/', async () => {
  const s = setup();
  let menuOpen = true;
  globalThis.__isOwnModalOpen = () => menuOpen;
  try {
    s.openers.task = deferredOpener(s.calls, 'task');
    s.openers.task.open = async () => {
      s.calls.push('open:task');
      globalThis.location = { pathname: '/calendar', search: '', hash: '' }; // weitergegangen, waehrend geladen wurde
      menuOpen = false; // das Blatt hat das Menue ersetzt
      return true;
    };
    openAddMenu({ user: { id: 1 }, access: ALL_WRITE }, { openers: s.openers });
    const panel = fakePanel();
    s.opened[0].onSave(panel);
    panel.tap('task');
    s.openers.task.release();
    await flush();
    assert.deepEqual(s.calls, ['load:task', 'open:task', 'close'], 'dropped: the sheet does not stay over /calendar');
  } finally { delete globalThis.__isOwnModalOpen; s.done(); }
}));

test('an opener that opens nothing (no list, read only) or fails closes the menu; a failure says so', () => withLocation('/', async () => {
  const s = setup();
  const realError = console.error;
  console.error = () => {};
  try {
    s.openers.shopping = deferredOpener(s.calls, 'shopping', { opened: false });
    openAddMenu({ user: { id: 1 }, access: ALL_WRITE }, { openers: s.openers });
    let panel = fakePanel();
    s.opened[0].onSave(panel);
    panel.tap('shopping');
    s.openers.shopping.release();
    await flush();
    assert.deepEqual(s.calls, ['load:shopping', 'open:shopping', 'close'], 'nothing replaced the menu: it goes');
    assert.equal(toasts.length, 0, 'the opener said why itself');

    s.calls.length = 0;
    s.openers.event = { load: () => Promise.reject(Object.assign(new Error('Failed to fetch dynamically imported module'), { status: 0 })), open() { s.calls.push('open:event'); } };
    openAddMenu({ user: { id: 1 }, access: ALL_WRITE }, { openers: s.openers });
    panel = fakePanel();
    s.opened[1].onSave(panel);
    panel.tap('event');
    await flush();
    assert.deepEqual(s.calls, ['close']);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0][1], 'danger');
    assert.equal(panel.rows.event.getAttribute('aria-busy'), 'false');
  } finally { console.error = realError; s.done(); }
}));

test('the busy row shows a ring only after a short wait, and stands still for reduced motion', () => {
  const css = read('../public/styles/dashboard.css');
  const rule = css.slice(css.indexOf('.add-menu__row[aria-busy="true"]::after'));
  assert.ok(rule.length < css.length, 'a ring on the busy row');
  assert.match(rule.slice(0, 900), /animation[^;]*app-spin/);
  assert.match(css, /prefers-reduced-motion: reduce\)\s*\{[^}]*\.add-menu__row\[aria-busy="true"\]::after/);
});

test('Dziś: the + is fab-add, named "Add", only with something to add and never on the display', () => {
  const member = { id: 1, access_scope: 'full' };
  const fab = dash.todayAddFab({ user: member, access: { ...NONE, tasks: 'write' }, onClick() {} });
  assert.ok(fab, 'a member with tasks write gets the +');
  assert.equal(fab.id, 'fab-add');
  assert.equal(fab.className, 'page-fab');
  assert.equal(fab.getAttribute('aria-label'), 'dashboard.addMenuLabel');
  assert.equal(fab.dataset.dockLabel, 'dashboard.addMenuLabel');
  assert.match(fab.innerHTML, /data-lucide|<i/, 'it carries the plus glyph');
  assert.equal(fab.listener, 'click', 'the tap is wired');
  assert.equal(dash.todayAddFab({ user: { id: 9, access_scope: 'display' }, access: ALL_WRITE, onClick() {} }), null,
    'the Kuchnia tablet gets no +');
  assert.equal(dash.todayAddFab({ user: member, access: NONE, onClick() {} }), null, 'nothing to add, no +');
  assert.equal(dash.todayAddFab({ user: member, access: { ...NONE, shopping: 'write' }, onClick() {} })?.id, 'fab-add');
  assert.equal(dash.todayAddFab({ user: member, access: { ...NONE, meals: 'write' }, onClick() {} }), null,
    'Meal left the menu: meals alone gives no +');
});

test('loadAddMenu: one import for the pointerdown and the tap; a failed one is tried again', async () => {
  const a = dash.loadAddMenu();
  const b = dash.loadAddMenu();
  assert.equal(a, b, 'the tap waits for the import the finger started');
  const mod = await a;
  assert.equal(typeof mod.openAddMenu, 'function');
  assert.match(read('../public/pages/dashboard.js'), /menuModule = null/, 'a failed import is forgotten, the next tap tries again');
});

test('the say row is startQuickAdd itself; each other row has its own opener; no Meal opener', () => {
  assert.equal(menu.OPENERS.say, startQuickAdd, '"Say it" maps to startQuickAdd, not a wrapper with a promise');
  assert.notEqual(menu.OPENERS.say, startTaskDictation, 'Say it routes; it no longer only says a task');
  assert.deepEqual(Object.keys(menu.OPENERS), ['say', 'task', 'event', 'shopping']);
  for (const id of ['task', 'event', 'shopping']) {
    assert.notEqual(menu.OPENERS[id], startQuickAdd, `${id} opens its own sheet`);
  }
});

test('Dziś shows the + exactly when the menu has a row (the rule without loading the menu)', () => {
  const levels = ['write', 'read', 'none'];
  const member = { id: 1, access_scope: 'full' };
  let combos = 0;
  for (const tasks of levels) for (const calendar of levels) for (const shopping of levels) {
    const access = { tasks, calendar, shopping };
    combos += 1;
    assert.equal(Boolean(dash.todayAddFab({ user: member, access, onClick() {} })), addMenuItems(access).length > 0,
      JSON.stringify(access));
  }
  assert.equal(combos, 27);
});

test('the access comes from the same place as the rest of Dziś: module rights, a switched-off module is none', async () => {
  const { setPermissions, clearPermissions } = await import('../public/permissions.js');
  const prevYuvomi = globalThis.window.yuvomi;
  try {
    setPermissions({ admin: false, modules: { tasks: 'write', calendar: 'read', shopping: 'write', meals: 'write' } });
    globalThis.window.yuvomi = { ...prevYuvomi, isModuleDisabled: (m) => m === 'shopping' };
    assert.deepEqual(dash.todayAddAccess(), { tasks: 'write', calendar: 'read', shopping: 'none' }, 'no meals: Meal left the menu');
  } finally { clearPermissions(); globalThis.window.yuvomi = prevYuvomi; }
});

test('source: dictation is a static import in the menu, the sheets and the menu itself load on demand; Dziś builds the + in the synchronous part', () => {
  const menu = read('../public/components/add-menu.js');
  assert.match(menu, /^import \{ startQuickAdd \} from '\/components\/task-dictation\.js';$/m,
    'static - a dynamic import would put a promise between the tap and start()');
  assert.doesNotMatch(menu, /import\('\/components\/task-dictation\.js'\)/);
  for (const [mod, fn] of [['/pages/tasks.js', 'openNewTaskFrom'], ['/pages/calendar.js', 'openNewEventFrom'],
    ['/components/shopping-add-sheet.js', 'openShoppingAddFrom']]) {
    const esc = mod.replace(/[./]/g, '\\$&');
    assert.match(menu, new RegExp(`load: \\(\\) => import\\('${esc}'\\), open: \\(mod, opts\\) => mod\\.${fn}\\(opts\\)`), `${fn} from ${mod}`);
  }
  assert.doesNotMatch(menu, /\/pages\/meals\.js|openNewMealFrom/, 'no Meal opener left');
  const dashboard = read('../public/pages/dashboard.js');
  // The menu loads on the way to the tap on the + (pointerdown, F8), not at
  // startup; the mic needs the gesture only on "Say it", and by then the
  // menu - and with it task-dictation.js - is loaded.
  assert.doesNotMatch(dashboard, /^import [^;]*from '\/components\/add-menu\.js';$/m, 'no static import: the menu is not part of the startup');
  assert.match(dashboard, /import\('\/components\/add-menu\.js'\)/);
  assert.match(dashboard, /const \{ openAddMenu \} = await loadAddMenu\(\);/);
  const mountFn = dashboard.slice(dashboard.indexOf('function mountTodayAdd('), dashboard.indexOf('async function openTodayAddMenu('));
  assert.match(mountFn, /addEventListener\('pointerdown', \(\) => \{ loadAddMenu\(\)/, 'the finger on the + starts loading the menu');
  const preload = read('../public/index.html');
  for (const mod of ['/components/add-menu.js', '/components/task-dictation.js', '/utils/speech.js', '/utils/task-draft.js', '/utils/quick-draft.js', '/utils/capture-parse.js']) {
    assert.ok(!preload.includes(`href="${mod}"`), `${mod} is not preloaded at startup`);
  }
  const render = dashboard.slice(dashboard.indexOf('export async function render('));
  const firstAwait = render.indexOf('await ');
  const mount = render.indexOf('mountTodayAdd(');
  assert.ok(mount > 0 && mount < firstAwait, 'the + stands with the skeleton, before the data (the router adopts it right after render starts)');
  // One Today (2026-11-02): the "Add task" row in the Tasks card is gone - the
  // + is the one way to add on Today (spec section 3).
  assert.doesNotMatch(read('../public/components/today-view.js'), /data-day-action="add-task"|dz-tasks__add/);
});
