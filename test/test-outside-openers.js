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
 * Zone: Haushalt Europe/Warsaw, Prozesszone UTC (ein getHours() schluege hier fehl).
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
    getAttribute: () => null, setAttribute() {}, removeAttribute() {}, focus() {}, scrollIntoView() {},
    replaceChildren() {}, insertAdjacentHTML() {}, append() {}, appendChild() {}, remove() {}, style: {}, options: [], children: [],
    dispatchEvent() {}, removeEventListener() {}, matches: () => false, contains: () => false,
    listeners: {}, addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }, closest: () => make(), querySelector: () => make(), querySelectorAll: () => [],
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

/** Die Uhr auf `iso` stellen (Date ohne Argument), solange `fn` laeuft. */
async function atTime(iso, fn) {
  const RealDate = globalThis.Date;
  const fixed = new RealDate(iso).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  };
  try { return await fn(); } finally { globalThis.Date = RealDate; }
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

test('firstEmptyMealSlot: starts at the meal that is due now, never guesses the snack', () => {
  const all = ['breakfast', 'lunch', 'dinner', 'snack'];
  const planned = (...kinds) => kinds.map((meal_type) => ({ meal_type }));
  assert.equal(meals.firstEmptyMealSlot(all, [], 'breakfast'), 'breakfast', '07:00, nothing planned');
  assert.equal(meals.firstEmptyMealSlot(all, planned('breakfast'), 'lunch'), 'lunch', '12:00, breakfast planned');
  assert.equal(meals.firstEmptyMealSlot(all, planned('breakfast'), 'breakfast'), 'lunch', '07:00, breakfast planned: the next empty one');
  assert.equal(meals.firstEmptyMealSlot(all, planned('dinner'), 'dinner'), 'dinner', '19:00, dinner taken: stays on the due meal');
  assert.equal(meals.firstEmptyMealSlot(all, planned('breakfast', 'lunch', 'dinner'), 'lunch'), 'lunch', 'nothing free at or after: the due meal');
  assert.notEqual(meals.firstEmptyMealSlot(all, planned('breakfast', 'lunch', 'dinner'), 'breakfast'), 'snack', 'never the snack');
  assert.equal(meals.firstEmptyMealSlot(['snack'], [], 'dinner'), 'snack', 'unless it is the only type');
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
    // Das Blatt gilt nur, solange das Formular offen ist.
    appended[0].sheet = { media: { mediaText: 'all' } };
    assert.equal(typeof sheet.onClose, 'function', 'closing releases the sheet');
    sheet.onClose();
    assert.equal(appended[0].sheet.media.mediaText, 'not all', 'resting again after the form closes');
  } finally {
    globalThis.document.head = previousHead;
    globalThis.document.styleSheets = previousSheets;
    globalThis.__apiStub = previous;
    modals.restore();
  }
});

test('openNewEventFrom with a spoken draft: the sheet opens filled, with the heard sentence and "Powtórz"', async () => {
  const modals = captureModals();
  const previousSheets = globalThis.document.styleSheets;
  globalThis.document.styleSheets = [{ href: 'http://localhost/styles/calendar.css', disabled: false, media: { mediaText: 'all' } }];
  const api = recordingApi({ 'get /preferences': async () => ({ data: { calendar_default_duration: 90 } }) });
  const previous = globalThis.__apiStub;
  globalThis.__apiStub = api.stub;
  try {
    const draft = {
      title: 'Trening Leo', date: '2035-01-18', start_time: '17:00', end_time: null, all_day: false,
      location: 'Hala', assigned_to: [], reminder_minutes: null,
    };
    assert.equal(await calendar.openNewEventFrom({ user: { id: 7 }, draft, spoken: true, heard: 'Trening Leo w czwartek o 17' }), true);
    const [sheet] = modals.opened;
    assert.match(sheet.content, /id="modal-title"[^>]*value="Trening Leo"/);
    assert.match(sheet.content, /id="modal-start-date"[^>]*value="2035-01-18"/);
    assert.match(sheet.content, /id="modal-start-time"[^>]*value="17:00"/);
    assert.match(sheet.content, /id="modal-end-time"[^>]*value="18:30"/, 'the household length (90 min)');
    assert.match(sheet.content, /id="modal-location"[^>]*value="Hala"/);
    assert.match(sheet.content, /class="sheet-heard"[\s\S]*Trening Leo w czwartek o 17/);
    assert.match(sheet.content, /data-dirty-base=""/, 'counted as changed (R11)');
    assert.equal(sheet.headerAction?.id, 'event-say-again');
    assert.equal(sheet.headerAction?.label, 'tasks.sayAgain');

    // Kein Tag, keine Stunde gesagt: heute zur naechsten vollen Stunde, wie ohne Entwurf.
    assert.equal(await calendar.openNewEventFrom({ user: { id: 7 }, draft: { ...draft, date: null, start_time: null } }), true);
    const quiet = modals.opened[1];
    assert.match(quiet.content, new RegExp(`id="modal-start-date"[^>]*value="${todayKey()}"`));
    assert.match(quiet.content, /id="modal-start-time"[^>]*value="\d\d:00"/);
    assert.equal(quiet.headerAction, null, 'not spoken: no "Powtórz"');
  } finally {
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
  const today = await atTime('2026-11-01T11:00:00Z', () => todayKey());
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
    assert.equal(await atTime('2026-11-01T11:00:00Z', () => meals.openNewMealFrom({ user: { id: 7 } })), true);
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

test('onChanged travels openEventModal -> wireEventForm -> saveEvent (the click on Save)', async () => {
  const modals = captureModals();
  const api = recordingApi({ post: async () => ({ data: { id: 5 } }) });
  const previousApi = globalThis.__apiStub;
  const previousSheets = globalThis.document.styleSheets;
  globalThis.document.styleSheets = [{ href: 'http://localhost/styles/calendar.css', disabled: false, media: { mediaText: 'all' } }];
  globalThis.__apiStub = api.stub;
  globalThis.__closeModal = () => {};
  globalThis.__rruleValues = { recurrence_rule: null, valid_until: true };
  let changed = 0;
  try {
    await calendar.openNewEventFrom({ user: { id: 7 }, onChanged: () => { changed += 1; } });
    const overlay = fakeOverlay({
      '#modal-title': 'Dentysta',
      '#modal-start-date': todayKey(), '#modal-start-time': '10:00',
      '#modal-end-date': todayKey(), '#modal-end-time': '11:00',
    });
    modals.opened[0].onSave(overlay);
    const [click] = overlay.querySelector('#modal-save').listeners.click ?? [];
    assert.equal(typeof click, 'function', 'the form wires the Save click');
    await click();
    assert.ok(api.calls.some((c) => c.method === 'post' && c.path === '/calendar'), 'the event is posted');
    assert.equal(changed, 1, 'onChanged once, through the form');
  } finally {
    delete globalThis.__rruleValues;
    delete globalThis.__closeModal;
    globalThis.document.styleSheets = previousSheets;
    globalThis.__apiStub = previousApi;
    modals.restore();
  }
});

test('cold meal save with ingredients, then the toast action: no throw, onChanged runs after the transfer', async () => {
  const modals = captureModals();
  const toasts = [];
  const previousToast = globalThis.window.yuvomi.showToast;
  globalThis.window.yuvomi.showToast = (...args) => { toasts.push(args); };
  const api = recordingApi();
  api.stub.get = async (path) => {
    api.calls.push({ method: 'get', path });
    if (path === '/shopping') return { data: [{ id: 3, name: 'Zakupy' }] };
    return { data: [] };
  };
  api.stub.post = async (path) => {
    api.calls.push({ method: 'post', path });
    if (path === '/meals') return { data: { id: 9, ingredients: [] } };
    return { data: { transferred: 2, added_ids: [1, 2] } };
  };
  const previousApi = globalThis.__apiStub;
  const previousSheets = globalThis.document.styleSheets;
  globalThis.document.styleSheets = [{ href: 'http://localhost/styles/meals.css', disabled: false, media: { mediaText: 'all' } }];
  globalThis.__apiStub = api.stub;
  globalThis.__closeModal = () => {};
  let changed = 0;
  try {
    await meals.openNewMealFrom({ user: { id: 7 }, onChanged: () => { changed += 1; } });
    const overlay = fakeOverlay({ '#modal-title': 'Zupa', '#modal-date': todayKey(), '#modal-type': 'lunch' });
    const chip = { dataset: { name: 'Mleko', qty: '1 l' }, getAttribute: () => 'true' };
    overlay.querySelectorAll = (sel) => (sel === '.ingredient-chip' ? [chip] : []);
    await meals.__test.saveModal(overlay);
    assert.equal(changed, 1, 'onChanged after the save');
    const saved = toasts.find((args) => args[3]?.onClick);
    assert.ok(saved, 'the success toast offers the shopping list');
    await saved[3].onClick();
    assert.ok(api.calls.some((c) => c.path === '/meals/9/to-shopping-list'), 'the transfer ran');
    assert.equal(toasts.some((args) => args[1] === 'danger'), false, 'no error toast');
    assert.equal(changed, 2, 'onChanged after the transfer');
  } finally {
    delete globalThis.__closeModal;
    globalThis.window.yuvomi.showToast = previousToast;
    globalThis.document.styleSheets = previousSheets;
    globalThis.__apiStub = previousApi;
    modals.restore();
  }
});
