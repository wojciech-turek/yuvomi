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
 *          - guessAisle fragt /shopping/category-guess.
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
const { pickShoppingList, rememberShoppingList, guessAisle, parseQuickEntry } = await import('../public/utils/shopping-entry.js');
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

function setup({ lists = LISTS, frequent = [], permissions = { admin: false, modules: { shopping: 'write' } } } = {}) {
  const calls = [];
  const opened = [];
  globalThis.__apiStub = {
    get: async (path) => {
      calls.push({ method: 'get', path });
      if (path === '/shopping') return { data: lists };
      if (path === '/shopping/frequent') return { data: frequent };
      return { data: null };
    },
    post: async (path, body) => { calls.push({ method: 'post', path, body }); return { data: { id: 50, ...body } }; },
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
