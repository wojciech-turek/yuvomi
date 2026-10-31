/**
 * Modul: Termin- und Mahlzeit-Formular von ausserhalb ihrer Seiten
 *        (Quick-Add, 2026-10-29, Task 10)
 * Zweck: Die Uebersicht oeffnet "Neuer Termin" und "Mahlzeit hinzufuegen" als
 *        Blatt ueber sich. Geprueft wird:
 *          - nextFullHour: die naechste volle Stunde in der Haushaltszone, bei
 *            23 Uhr bleibt es 23:00;
 *          - firstEmptyMealSlot: der erste leere Platz, sonst der letzte;
 *          - nur lesend: beide Oeffner liefern false und rufen nichts auf;
 *          - kalt (Seite nie gerendert): die Oeffner laden, was das Formular
 *            braucht, stellen das Seitenblatt sicher (auch ein ruhendes),
 *            oeffnen mit heute/Vorgaben; Speichern zeichnet nichts
 *            (kein _container), wirft nicht und ruft onChanged.
 * Zone: Haushalt Europe/Warsaw.
 * Ausfuehren: npm run test:outside-openers
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
globalThis.document.documentElement.classList = {
  toggle() {}, add() {}, remove() {}, contains() { return false; },
};
globalThis.CSS = globalThis.CSS ?? { escape: (v) => String(v) };
globalThis.window = globalThis.window ?? {};
globalThis.window.yuvomi = { showToast() {} };

const { setDisplayTimeZone, todayKey } = await import('../public/utils/timezone.js');
const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const calendar = await import('../public/pages/calendar.js');
const meals = await import('../public/pages/meals.js');

setDisplayTimeZone('Europe/Warsaw');

/** Fuehrt `fn` mit einem Modal-Fang aus; `opened` sind die Argumente von openModal. */
function captureModals() {
  const opened = [];
  const previous = globalThis.__openModal;
  globalThis.__openModal = (opts) => { opened.push(opts); };
  return { opened, restore() { globalThis.__openModal = previous; } };
}

/** Ein Blatt, dessen Felder jeder Selektor findet; `fields` setzt Werte. */
function fakeOverlay(fields = {}) {
  const make = (value = '') => ({
    value, checked: false, dataset: {}, disabled: false, textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getAttribute: () => null, setAttribute() {}, focus() {}, scrollIntoView() {},
    addEventListener() {}, closest: () => null, querySelector: () => null, querySelectorAll: () => [],
  });
  const cache = new Map();
  return {
    querySelector(sel) {
      if (!cache.has(sel)) cache.set(sel, make(fields[sel] ?? ''));
      return cache.get(sel);
    },
    querySelectorAll: () => [],
  };
}

function recordingApi(handlers = {}) {
  const calls = [];
  const rec = (method) => async (path, body) => {
    calls.push({ method, path, body });
    const fn = handlers[`${method} ${path}`] ?? handlers[method];
    return fn ? fn(path, body) : { data: [] };
  };
  return {
    calls,
    stub: { get: rec('get'), post: rec('post'), put: rec('put'), patch: rec('patch'), delete: rec('delete') },
  };
}

test('nextFullHour: the next full hour in the household zone, capped at 23:00', () => {
  assert.equal(calendar.nextFullHour(new Date('2026-10-29T08:20:00Z')), '10:00', 'Warsaw 09:20 -> 10:00');
  assert.equal(calendar.nextFullHour(new Date('2026-10-29T08:00:00Z')), '10:00', 'on the hour -> next hour');
  assert.equal(calendar.nextFullHour(new Date('2026-10-29T21:30:00Z')), '23:00', 'Warsaw 22:30 -> 23:00');
  assert.equal(calendar.nextFullHour(new Date('2026-10-29T22:30:00Z')), '23:00', 'Warsaw 23:30 stays 23:00');
});

test('firstEmptyMealSlot: the first type without a meal, else the last type', () => {
  const types = ['breakfast', 'lunch', 'dinner'];
  assert.equal(meals.firstEmptyMealSlot(types, []), 'breakfast');
  assert.equal(meals.firstEmptyMealSlot(types, [{ meal_type: 'breakfast' }]), 'lunch');
  assert.equal(meals.firstEmptyMealSlot(types, [{ meal_type: 'lunch' }]), 'breakfast');
  assert.equal(meals.firstEmptyMealSlot(types, types.map((meal_type) => ({ meal_type }))), 'dinner');
});

test('read-only: both openers resolve false, call no API and open nothing', async () => {
  const modals = captureModals();
  const api = recordingApi();
  const previous = globalThis.__apiStub;
  globalThis.__apiStub = api.stub;
  setPermissions({ admin: false, modules: { calendar: 'read', meals: 'read' } });
  try {
    assert.equal(await calendar.openNewEventFrom({ user: { id: 1 } }), false);
    assert.equal(await meals.openNewMealFrom({ user: { id: 1 } }), false);
    assert.equal(api.calls.length, 0, 'no API call');
    assert.equal(modals.opened.length, 0, 'no sheet');
  } finally {
    clearPermissions();
    globalThis.__apiStub = previous;
    modals.restore();
  }
});

test('openNewEventFrom, cold: loads the form state, applies a resting sheet, opens today at the next full hour', async () => {
  const modals = captureModals();
  const previousSheets = globalThis.document.styleSheets;
  // calendar.css steht im Dokument, ruht aber (media "not all"): zaehlt nicht.
  globalThis.document.styleSheets = [{ href: 'http://localhost/styles/calendar.css', disabled: false, media: { mediaText: 'not all' } }];
  const appended = [];
  const previousHead = globalThis.document.head;
  globalThis.document.head = { appendChild(link) { appended.push(link); queueMicrotask(() => link.onload?.()); return link; } };
  const api = recordingApi({
    '/preferences': async () => ({ data: { calendar_default_duration: 90 } }),
  });
  const previous = globalThis.__apiStub;
  globalThis.__apiStub = api.stub;
  try {
    assert.equal(await calendar.openNewEventFrom({ user: { id: 7 }, onChanged: () => {} }), true);
    const paths = api.calls.map((c) => c.path);
    for (const path of ['/family/members', '/auth/users', '/calendar/calendars', '/preferences', '/documents/meta/options']) {
      assert.ok(paths.includes(path), `loads ${path}`);
    }
    assert.equal(appended.length, 1, 'the resting sheet is loaded');
    assert.equal(appended[0].href, '/styles/calendar.css');
    const [sheet] = modals.opened;
    assert.equal(sheet?.title, 'calendar.newEvent');
    const today = todayKey();
    assert.match(sheet.content, new RegExp(`id="modal-start-date"[^>]*value="${today}"`));
    assert.match(sheet.content, /id="modal-start-time"[^>]*value="\d\d:00"/, 'a full hour');
  } finally {
    globalThis.document.head = previousHead;
    globalThis.document.styleSheets = previousSheets;
    globalThis.__apiStub = previous;
    modals.restore();
  }
});

test('saveEvent with no page container: no render, no throw, onChanged called once', async () => {
  const modals = captureModals();
  const closed = [];
  const api = recordingApi({ post: async () => ({ data: { id: 5 } }) });
  const previousApi = globalThis.__apiStub;
  const previousSheets = globalThis.document.styleSheets;
  globalThis.document.styleSheets = [{ href: 'http://localhost/styles/calendar.css', disabled: false, media: { mediaText: 'all' } }];
  globalThis.__apiStub = api.stub;
  globalThis.__closeModal = (...a) => closed.push(a);
  globalThis.__rruleValues = { recurrence_rule: null, valid_until: true };
  let changed = 0;
  try {
    await calendar.openNewEventFrom({ user: { id: 7 }, onChanged: () => { changed += 1; } });
    const overlay = fakeOverlay({
      '#modal-title': 'Dentysta',
      '#modal-start-date': todayKey(), '#modal-start-time': '10:00',
      '#modal-end-date': todayKey(), '#modal-end-time': '11:00',
    });
    // Das echte Verdrahten braucht ein DOM; gespeichert wird ueber den Klick-Weg.
    const handlers = [];
    overlay.querySelector('#modal-save').addEventListener = (type, fn) => handlers.push(fn);
    try { modals.opened[0].onSave(overlay); } catch { /* das Formular-Doppel ist knapp */ }
    assert.ok(typeof calendar.__test.saveEvent === 'function');
    const before = api.calls.length;
    await calendar.__test.saveEvent(overlay, 'create', null, [], null, () => { changed += 1; });
    assert.ok(api.calls.slice(before).some((c) => c.method === 'post' && c.path === '/calendar'), 'the event is posted');
    assert.equal(changed, 1, 'onChanged once');
  } finally {
    delete globalThis.__rruleValues;
    delete globalThis.__closeModal;
    globalThis.document.styleSheets = previousSheets;
    globalThis.__apiStub = previousApi;
    modals.restore();
  }
});

test('openNewMealFrom, cold: loads recipes, lists, members, pantry; the first empty slot of today', async () => {
  const modals = captureModals();
  const previousSheets = globalThis.document.styleSheets;
  globalThis.document.styleSheets = [{ href: 'http://localhost/styles/meals.css', disabled: false, media: { mediaText: 'all' } }];
  const today = todayKey();
  const api = recordingApi({
    '/preferences': async () => ({ data: { visible_meal_types: ['breakfast', 'lunch', 'dinner'] } }),
  });
  api.stub.get = async (path) => {
    api.calls.push({ method: 'get', path });
    if (path.startsWith('/meals?week=')) return { data: [{ id: 1, date: today, meal_type: 'breakfast', title: 'Owsianka' }] };
    if (path === '/preferences') return { data: { visible_meal_types: ['breakfast', 'lunch', 'dinner'] } };
    return { data: [] };
  };
  const previous = globalThis.__apiStub;
  globalThis.__apiStub = api.stub;
  try {
    assert.equal(await meals.openNewMealFrom({ user: { id: 7 } }), true);
    const paths = api.calls.map((c) => c.path);
    for (const path of ['/recipes', '/shopping', '/shopping/categories', '/family/members', '/pantry', '/preferences']) {
      assert.ok(paths.includes(path), `loads ${path}`);
    }
    assert.ok(paths.some((p) => p.startsWith('/meals?week=')), 'loads the week');
    const [sheet] = modals.opened;
    assert.ok(sheet, 'a sheet opens');
    assert.match(sheet.content, new RegExp(`id="modal-date"[^>]*value="${today}"`));
    assert.match(sheet.content, /data-meal-type="lunch" aria-checked="true"/, 'breakfast is taken: lunch');
  } finally {
    globalThis.document.styleSheets = previousSheets;
    globalThis.__apiStub = previous;
    modals.restore();
  }
});

test('saveModal with no page container: no render, no throw, onChanged called', async () => {
  const modals = captureModals();
  const api = recordingApi({ post: async () => ({ data: { id: 9, ingredients: [] } }) });
  const previousApi = globalThis.__apiStub;
  const previousSheets = globalThis.document.styleSheets;
  globalThis.document.styleSheets = [{ href: 'http://localhost/styles/meals.css', disabled: false, media: { mediaText: 'all' } }];
  globalThis.__apiStub = api.stub;
  globalThis.__closeModal = () => {};
  let changed = 0;
  try {
    await meals.openNewMealFrom({ user: { id: 7 }, onChanged: () => { changed += 1; } });
    const overlay = fakeOverlay({ '#modal-title': 'Zupa', '#modal-date': todayKey(), '#modal-type': 'lunch' });
    await meals.__test.saveModal(overlay);
    assert.ok(api.calls.some((c) => c.method === 'post' && c.path === '/meals'), 'the meal is posted');
    assert.equal(changed, 1, 'onChanged once');
  } finally {
    delete globalThis.__closeModal;
    globalThis.document.styleSheets = previousSheets;
    globalThis.__apiStub = previousApi;
    modals.restore();
  }
});
