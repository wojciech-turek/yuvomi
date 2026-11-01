/**
 * Modul: Einkaufsblatt von der Uebersicht aus (Quick-Add, 2026-10-29, Task 11)
 * Zweck: Die Zakupy-Leiste (ein Feld, "Często", Gangvermutung) lebt in
 *        utils/shopping-entry.js und components/shopping-add-sheet.js; die
 *        Uebersicht oeffnet sie als kleines Blatt. Geprueft wird:
 *          - pickShoppingList: gemerkte Liste, sonst die erste, bei werfendem
 *            Speicher die erste, ohne Listen null;
 *          - nur lesend: false, kein API-Aufruf, kein Blatt;
 *          - ohne Liste: Hinweis und false;
 *          - "2 mleka" geht als { name, quantity, position: 'top' } an die
 *            gemerkte Liste, das Feld leert sich und behaelt den Fokus;
 *          - der Kopf traegt den Listennamen, die Auswahl nur bei mehr als
 *            einer Liste; ein Antippen von "Często" legt den Artikel an;
 *          - guessAisle fragt /shopping/category-guess;
 *          - der Bestand der Liste (F2): "Często" zeigt nichts Offenes, ein
 *            abgehakter Name kommt zurueck (PATCH + Toast) statt ein zweites
 *            Mal angelegt zu werden - dieselben Helfer wie Zakupy.
 * Ausfuehren: npm run test:shopping-add-sheet
 */
import test from 'node:test';
import assert from 'node:assert/strict';
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

const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const { pickShoppingList, rememberShoppingList, guessAisle, parseQuickEntry, visibleFrequent, tickedItemNamed } = await import('../public/utils/shopping-entry.js');
const { openShoppingAddFrom } = await import('../public/components/shopping-add-sheet.js');

const LISTS = [{ id: 1, name: 'Biedronka' }, { id: 2, name: 'Rynek' }];

test('pickShoppingList: the remembered list, else the first', () => {
  store.clear();
  assert.deepEqual(pickShoppingList(LISTS, 7), { id: 1, name: 'Biedronka' }, 'nothing stored');
  rememberShoppingList(7, 2);
  assert.equal(store.get('yuvomi.shopping.lastList.7'), '2', 'key per user');
  assert.equal(pickShoppingList([{ id: 1 }, { id: 2 }], 7).id, 2);
  assert.equal(pickShoppingList([{ id: 1 }, { id: 2 }], 8).id, 1, 'another user has no memory');
  rememberShoppingList(7, 99);
  assert.equal(pickShoppingList([{ id: 1 }, { id: 2 }], 7).id, 1, 'a list that is gone');
  assert.equal(pickShoppingList([], 7), null, 'no lists');
});

test('pickShoppingList and rememberShoppingList survive a throwing storage', () => {
  const real = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
  };
  try {
    assert.doesNotThrow(() => rememberShoppingList(7, 2));
    assert.equal(pickShoppingList([{ id: 1 }, { id: 2 }], 7).id, 1);
  } finally { globalThis.localStorage = real; }
});

test('guessAisle asks /shopping/category-guess and answers a category or null', async () => {
  const asked = [];
  assert.equal(await guessAisle('mleko', { get: async (p) => { asked.push(p); return { data: { category: 'Nabiał' } }; } }), 'Nabiał');
  assert.deepEqual(asked, ['/shopping/category-guess?name=mleko']);
  assert.equal(await guessAisle('x', { get: async () => ({ data: null }) }), null);
  assert.equal(await guessAisle('x', { get: async () => { throw new Error('offline'); } }), null);
});

/** Ein Blatt, dessen Felder jeder Selektor findet; Eingabefeld und Formular merken Listener. */
function fakePanel() {
  const cache = new Map();
  const make = (sel) => ({
    sel, value: '', dataset: {}, disabled: false, hidden: false, textContent: '', innerHTML: '', listeners: {}, focused: 0, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    removeEventListener() {}, focus() { this.focused += 1; }, setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    insertAdjacentHTML(_where, html) { this.innerHTML += html; }, replaceChildren() { this.innerHTML = ''; },
    querySelector: (s) => panel.querySelector(s), querySelectorAll: () => [],
  });
  const panel = {
    querySelector(sel) { if (!cache.has(sel)) cache.set(sel, make(sel)); return cache.get(sel); },
    querySelectorAll: () => [],
  };
  return panel;
}

function setup({ lists = LISTS, frequent = [], items = {}, permissions = { admin: false, modules: { shopping: 'write' } } } = {}) {
  const calls = [];
  const opened = [];
  let nextId = 50;
  globalThis.__apiStub = {
    get: async (path) => {
      calls.push({ method: 'get', path });
      if (path === '/shopping') return { data: lists };
      if (path === '/shopping/frequent') return { data: frequent };
      const m = /^\/shopping\/(\d+)\/items$/.exec(path);
      if (m) return { data: (items[m[1]] ?? []).map((i) => ({ ...i })) };
      return { data: null };
    },
    post: async (path, body) => { calls.push({ method: 'post', path, body }); return { data: { id: nextId++, is_checked: 0, ...body } }; },
    patch: async (path, body) => { calls.push({ method: 'patch', path, body }); return { data: { ...body } }; },
  };
  globalThis.__openModal = (opts) => { opened.push(opts); };
  setPermissions(permissions);
  return {
    calls, opened,
    done() { clearPermissions(); delete globalThis.__apiStub; delete globalThis.__openModal; store.clear(); toasts.length = 0; },
  };
}

test('read-only: false, no API call, no sheet', async () => {
  const s = setup({ permissions: { admin: false, modules: { shopping: 'read' } } });
  try {
    assert.equal(await openShoppingAddFrom({ user: { id: 7 } }), false);
    assert.equal(s.calls.length, 0);
    assert.equal(s.opened.length, 0);
  } finally { s.done(); }
});

test('no list yet: a toast and false, no empty sheet', async () => {
  const s = setup({ lists: [] });
  try {
    assert.equal(await openShoppingAddFrom({ user: { id: 7 } }), false);
    assert.equal(s.opened.length, 0);
    assert.equal(toasts.length, 1, 'says so');
  } finally { s.done(); }
});

test('the sheet is titled with the remembered list; the switcher only with several lists', async () => {
  rememberShoppingList(7, 2);
  const s = setup();
  try {
    assert.equal(await openShoppingAddFrom({ user: { id: 7 } }), true);
    const [modal] = s.opened;
    assert.equal(modal.title, 'Rynek');
    assert.equal(modal.dirtyGuard, false);
    assert.ok(modal.content.includes('enterkeyhint="done"'), 'one field, done key');
    assert.ok(modal.content.includes('<select'), 'two lists: a switcher');
    assert.ok(!modal.content.includes('item-qty'), 'no quantity field');
  } finally { s.done(); }
  const one = setup({ lists: [LISTS[0]] });
  try {
    await openShoppingAddFrom({ user: { id: 7 } });
    assert.ok(!one.opened[0].content.includes('<select'), 'one list: no switcher');
  } finally { one.done(); }
});

test('"2 mleka" is posted to the remembered list as a top row; the field empties and keeps focus', async () => {
  rememberShoppingList(7, 2);
  const s = setup();
  const changed = [];
  try {
    await openShoppingAddFrom({ user: { id: 7 }, onChanged: () => changed.push(1) });
    const modal = s.opened[0];
    const panel = fakePanel();
    await modal.onSave(panel);
    const input = panel.querySelector('#shopping-sheet-input');
    const form = panel.querySelector('#shopping-sheet-form');
    input.value = '2 mleka';
    const expected = parseQuickEntry('2 mleka');
    let prevented = 0;
    for (const fn of form.listeners.submit) await fn({ preventDefault() { prevented += 1; } });
    assert.equal(prevented, 1);
    const post = s.calls.find((c) => c.method === 'post');
    assert.equal(post.path, '/shopping/2/items');
    assert.equal(post.body.name, expected.name);
    assert.equal(post.body.quantity, expected.quantity);
    assert.equal(post.body.position, 'top');
    assert.ok(post.body.category && post.body.category_source, 'category and source travel');
    assert.equal(input.value, '', 'cleared');
    assert.ok(input.focused > 0, 'focus stays for the next item');
    assert.equal(changed.length, 0, 'not before the sheet closes');
    modal.onClose();
    assert.equal(changed.length, 1, 'onChanged on close');
  } finally { s.done(); }
});

test('an empty field posts nothing; a "Często" chip adds its item', async () => {
  const s = setup({ frequent: [{ name: 'masło', quantity: null, category: 'Nabiał' }] });
  try {
    await openShoppingAddFrom({ user: { id: 7 } });
    const panel = fakePanel();
    await s.opened[0].onSave(panel);
    const form = panel.querySelector('#shopping-sheet-form');
    for (const fn of form.listeners.submit) await fn({ preventDefault() {} });
    assert.equal(s.calls.filter((c) => c.method === 'post').length, 0);
    const chips = panel.querySelector('#shopping-sheet-frequent');
    assert.ok(s.opened[0].content.includes('data-name="masło"'), 'the chip is drawn');
    const chip = { dataset: { name: 'masło' }, disabled: false, remove() {} };
    for (const fn of chips.listeners.click) await fn({ target: { closest: () => chip } });
    const post = s.calls.find((c) => c.method === 'post');
    assert.equal(post.body.name, 'masło');
    assert.equal(post.body.category, 'Nabiał');
    assert.equal(post.body.position, 'top');
  } finally { s.done(); }
});

test('a caller without a user gets a console warning and the first list', async () => {
  rememberShoppingList(7, 2);
  const s = setup();
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a);
  try {
    assert.equal(await openShoppingAddFrom({}), true);
    assert.equal(s.opened[0].title, 'Biedronka');
    assert.equal(warns.length, 1);
  } finally { console.warn = realWarn; s.done(); }
});

// --------------------------------------------------------------------------
// Was auf der Liste steht (F2): dieselben Regeln wie Zakupy, aus
// utils/shopping-entry.js - "Często" zeigt nichts, was offen auf der Liste
// steht, und ein abgehakter Name kommt zurueck statt ein zweites Mal.
// --------------------------------------------------------------------------

const row = (id, name, extra = {}) => ({ id, name, is_checked: 0, sort_order: 0, quantity: null, category: 'Nabiał', ...extra });

test('visibleFrequent: no chip for a name already open on the list (case and spaces aside); ticked ones stay', () => {
  const frequent = [{ name: 'Mleko' }, { name: 'masło' }, { name: 'Chleb' }, { name: 'Jajka' }];
  const items = [row(1, ' mleko '), row(2, 'Masło', { is_checked: 1 }), row(3, 'Ser')];
  assert.deepEqual(visibleFrequent(frequent, items).map((i) => i.name), ['masło', 'Chleb', 'Jajka']);
  assert.deepEqual(visibleFrequent(frequent, items, { limit: 2 }).map((i) => i.name), ['masło', 'Chleb']);
  assert.deepEqual(visibleFrequent(frequent, []).length, 4);
  assert.deepEqual(visibleFrequent(null, null), []);
  // Zakupy fragt seine Absichten (ein eben getippter Haken) statt is_checked.
  const isChecked = (i) => (i.id === 1 ? 1 : i.is_checked);
  assert.deepEqual(visibleFrequent(frequent, items, { isChecked }).map((i) => i.name), ['Mleko', 'masło', 'Chleb', 'Jajka']);
});

test('tickedItemNamed: the ticked row of that name, first by rank; never an open one', () => {
  const items = [row(5, 'Masło', { is_checked: 1, sort_order: 2 }), row(4, 'masło ', { is_checked: 1, sort_order: 1 }), row(6, 'Mleko')];
  assert.equal(tickedItemNamed(items, 'MASŁO')?.id, 4, 'the best-ranked of two');
  assert.equal(tickedItemNamed(items, 'Mleko'), undefined, 'open: not ticked');
  assert.equal(tickedItemNamed(items, '  '), undefined);
  assert.equal(tickedItemNamed(null, 'Masło'), undefined);
  assert.equal(tickedItemNamed(items, 'Mleko', { isChecked: (i) => (i.id === 6 ? 1 : i.is_checked) })?.id, 6);
});

async function openSheet(s, user = { id: 7 }) {
  await openShoppingAddFrom({ user });
  const panel = fakePanel();
  await s.opened[0].onSave(panel);
  return {
    panel,
    input: panel.querySelector('#shopping-sheet-input'),
    async submit(text) {
      panel.querySelector('#shopping-sheet-input').value = text;
      for (const fn of panel.querySelector('#shopping-sheet-form').listeners.submit) await fn({ preventDefault() {} });
    },
    async tapChip(name) {
      const chip = { dataset: { name }, disabled: false, remove() {} };
      for (const fn of panel.querySelector('#shopping-sheet-frequent').listeners.click) await fn({ target: { closest: () => chip } });
    },
    async switchTo(id) {
      const select = panel.querySelector('#shopping-sheet-list');
      for (const fn of select.listeners.change) await fn({ target: { value: String(id) } });
    },
  };
}

const writes = (calls) => calls.filter((c) => c.method !== 'get').map((c) => `${c.method.toUpperCase()} ${c.path}`);

test('sheet: loads the items of its list; "Często" leaves out what is already open there', async () => {
  rememberShoppingList(7, 2);
  const s = setup({
    frequent: [{ name: 'Mleko', category: 'Nabiał' }, { name: 'masło', category: 'Nabiał' }],
    items: { 2: [row(1, 'mleko'), row(2, 'Masło', { is_checked: 1 })] },
  });
  try {
    await openShoppingAddFrom({ user: { id: 7 } });
    assert.ok(s.calls.some((c) => c.method === 'get' && c.path === '/shopping/2/items'), 'the list it adds to');
    const { content } = s.opened[0];
    assert.ok(!content.includes('data-name="Mleko"'), 'open on the list: no chip');
    assert.ok(content.includes('data-name="masło"'), 'ticked: still a chip');
  } finally { s.done(); }
});

test('sheet: a name ticked on the list comes back (PATCH), with the toast Zakupy shows - no second row', async () => {
  rememberShoppingList(7, 2);
  const s = setup({ items: { 2: [row(8, 'Masło', { is_checked: 1, quantity: '1 szt.' })] } });
  try {
    const sheet = await openSheet(s);
    await sheet.submit('masło');
    assert.deepEqual(writes(s.calls), ['PATCH /shopping/items/8'], 'no POST');
    assert.deepEqual(s.calls.find((c) => c.method === 'patch').body, { is_checked: 0 }, 'an amount not typed stays as it was');
    assert.deepEqual(toasts.at(-1), ['shopping.itemBackToast{"name":"Masło"}', 'info'], 'the row\'s own name');
    assert.equal(sheet.input.value, '', 'cleared like an add');
    assert.ok(sheet.input.focused > 0);
    // Wieder offen: ein zweites "masło" ist jetzt neu - wie auf Zakupy.
    await sheet.submit('masło');
    assert.deepEqual(writes(s.calls), ['PATCH /shopping/items/8', 'POST /shopping/2/items']);
  } finally { s.done(); }
});

test('sheet: a typed amount travels with the revived row', async () => {
  rememberShoppingList(7, 2);
  const s = setup({ items: { 2: [row(8, 'Jajka', { is_checked: 1, quantity: '6 szt.' })] } });
  try {
    const sheet = await openSheet(s);
    await sheet.submit('jajka 10');
    const patch = s.calls.find((c) => c.method === 'patch');
    assert.equal(patch.path, '/shopping/items/8');
    assert.equal(patch.body.is_checked, 0);
    assert.equal(patch.body.quantity, parseQuickEntry('jajka 10').quantity);
    assert.ok(!('category' in patch.body), 'no aisle was chosen - the row keeps its own');
  } finally { s.done(); }
});

test('sheet: a "Często" chip for a ticked name revives that row instead of posting', async () => {
  rememberShoppingList(7, 2);
  const s = setup({
    frequent: [{ name: 'masło', category: 'Nabiał' }],
    items: { 2: [row(8, 'Masło', { is_checked: 1 })] },
  });
  try {
    const sheet = await openSheet(s);
    await sheet.tapChip('masło');
    assert.deepEqual(writes(s.calls), ['PATCH /shopping/items/8']);
    assert.deepEqual(toasts.at(-1), ['shopping.itemBackToast{"name":"Masło"}', 'info']);
  } finally { s.done(); }
});

test('sheet: what was just added drops out of "Często" - a tap cannot add it twice', async () => {
  rememberShoppingList(7, 2);
  const s = setup({ frequent: [{ name: 'Mleko', category: 'Nabiał' }, { name: 'Chleb', category: 'Pieczywo' }] });
  try {
    const sheet = await openSheet(s);
    await sheet.submit('mleko');
    const chipRow = sheet.panel.querySelector('#shopping-sheet-frequent');
    assert.ok(!chipRow.innerHTML.includes('data-name="Mleko"'), 'typed, now open: its chip is gone');
    assert.ok(chipRow.innerHTML.includes('data-name="Chleb"'));
    await sheet.tapChip('Chleb');
    assert.ok(!chipRow.innerHTML.includes('data-name="Chleb"'));
    assert.equal(chipRow.hidden, true, 'nothing left to offer');
    await sheet.tapChip('Chleb');
    assert.deepEqual(writes(s.calls), ['POST /shopping/2/items', 'POST /shopping/2/items'], 'one row each');
  } finally { s.done(); }
});

test('sheet: a name already OPEN on the list is added again, as Zakupy does', async () => {
  rememberShoppingList(7, 2);
  const s = setup({ items: { 2: [row(1, 'Mleko')] } });
  try {
    const sheet = await openSheet(s);
    await sheet.submit('Mleko');
    assert.deepEqual(writes(s.calls), ['POST /shopping/2/items']);
  } finally { s.done(); }
});

test('sheet: switching the list loads its items; chips and revive follow the new list', async () => {
  rememberShoppingList(7, 1);
  const s = setup({
    frequent: [{ name: 'Mleko', category: 'Nabiał' }],
    items: { 1: [row(1, 'Mleko')], 2: [row(9, 'mleko', { is_checked: 1 })] },
  });
  try {
    const sheet = await openSheet(s);
    assert.ok(!s.opened[0].content.includes('data-name="Mleko"'), 'open on Biedronka');
    await sheet.switchTo(2);
    assert.ok(s.calls.some((c) => c.method === 'get' && c.path === '/shopping/2/items'));
    const chipRow = sheet.panel.querySelector('#shopping-sheet-frequent');
    assert.ok(chipRow.innerHTML.includes('data-name="Mleko"'), 'ticked on Rynek: offered');
    await sheet.submit('Mleko');
    assert.deepEqual(writes(s.calls), ['PATCH /shopping/items/9'], 'the ticked row on Rynek comes back');
  } finally { s.done(); }
});

test('sheet: when the items cannot be read it still adds (no revive to know of)', async () => {
  rememberShoppingList(7, 2);
  const s = setup({ frequent: [{ name: 'Mleko', category: 'Nabiał' }] });
  const realGet = globalThis.__apiStub.get;
  globalThis.__apiStub.get = async (path) => {
    if (/\/items$/.test(path)) throw new Error('offline');
    return realGet(path);
  };
  try {
    const sheet = await openSheet(s);
    assert.ok(s.opened[0].content.includes('data-name="Mleko"'), 'chips as before');
    await sheet.submit('Mleko');
    assert.deepEqual(writes(s.calls), ['POST /shopping/2/items']);
  } finally { s.done(); }
});
