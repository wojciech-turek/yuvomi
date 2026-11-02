/**
 * Modul: Termin-Formular von ausserhalb seiner Seite
 *        (Quick-Add, 2026-10-29, Task 10)
 * Zweck: Die Uebersicht oeffnet "Neuer Termin" als Blatt ueber sich. Geprueft
 *        wird:
 *          - nextFullHour: die naechste volle Stunde in der Haushaltszone, bei
 *            23 Uhr bleibt es 23:00;
 *          - nur lesend: der Oeffner liefert false und ruft nichts auf;
 *          - kalt (Seite nie gerendert): der Oeffner laedt, was das Formular
 *            braucht, stellt das Seitenblatt sicher (auch ein ruhendes),
 *            oeffnet mit heute/Vorgaben; Speichern zeichnet nichts
 *            (kein _container), wirft nicht und ruft onChanged.
 *        Mit "Say it" (One Today, Task 14) ging die Mahlzeit aus dem "+" auf
 *        Dziś; ihr Oeffner von aussen (openNewMealFrom) ist entfallen, Food
 *        oeffnet sein Blatt selbst.
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

test('read-only: the opener resolves false, calls no API and opens nothing', async () => {
  const modals = captureModals();
  const api = recordingApi();
  const previous = globalThis.__apiStub;
  globalThis.__apiStub = api.stub;
  setPermissions({ admin: false, modules: { calendar: 'read' } });
  try {
    assert.equal(await calendar.openNewEventFrom({ user: { id: 1 } }), false);
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
