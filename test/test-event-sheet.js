/**
 * Modul: Das Blatt "Neues Wydarzenie" im geteilten Aufbau (One Today, Task 10)
 * Zweck: Das Terminformular steht wie das Aufgabenblatt da: Titel mit
 *        Mikrofon (nur beim Anlegen), Personen, die kompakten Zeilen Kiedy /
 *        Gdzie / Przypomnienie, „Więcej" fuer den Rest und EIN Knopf, der die
 *        Sache nennt ("Dodaj wydarzenie"). Kein Abbrechen - x und Wischen
 *        schliessen das Blatt. Nichts, was das Formular vorher konnte, geht
 *        verloren: jede Feld-id behaelt ihre Bedeutung, das Speichern schickt
 *        denselben Koerper wie vorher (Schnappschuss aus dem Stand vor dem
 *        Umbau) und dieselbe Erinnerung.
 *
 *        Gemessen wird am ECHTEN Markup von buildEventModalContent(): ein
 *        kleiner Baum-Bauer macht daraus Knoten mit Eltern, Kindern,
 *        Attributen und Ereignissen, und wireEventForm/saveEvent laufen
 *        darauf wie im Browser (kein jsdom, siehe test/mini-dom.js).
 * Zone: Geraet Asia/Yekaterinburg, Haushalt Europe/Warsaw.
 * Ausfuehren: npm run test:event-sheet
 */
process.env.TZ = 'Asia/Yekaterinburg';

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
const { addLocalDays } = await import('../public/utils/date.js');
const { renderUserMultiSelect } = await import('../public/components/user-multi-select.js');
const { setHouseholdSize } = await import('../public/utils/household.js');
const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const { __test: calendar } = await import('../public/pages/calendar.js');

setDisplayTimeZone('Europe/Warsaw');
setHouseholdSize(2);

const ANNA = { id: 1, display_name: 'Anna Berg' };
const BEN = { id: 2, display_name: 'Ben Berg' };
const TODAY = todayKey();
const TOMORROW = addLocalDays(TODAY, 1);
const IN_FIVE = addLocalDays(TODAY, 5);

calendar.state.users = [ANNA, BEN];
calendar.state.currentUserId = ANNA.id;
calendar.state.today = TODAY;
calendar.state.defaultDuration = 60;
calendar.state.defaultReminders = [];
calendar.state.defaultAssignMe = false;
calendar.state.localCalendars = [];
calendar.state.defaultSyncTarget = '';

// --------------------------------------------------------------------------
// Ein Baum aus dem Markup: Tags, Attribute, Text, Eltern und Kinder
// --------------------------------------------------------------------------

const VOID = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const decode = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

let active = null;

class FakeText {
  constructor(text) { this.text = decode(text); this.parentNode = null; }
  get textContent() { return this.text; }
}

class FakeEl {
  constructor(tag) {
    this.localName = String(tag).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.attrs = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = {};
    this.events = [];
    this.style = {};
    this.dataset = {};
    this.checked = false;
    this.disabled = false;
    this.selected = false;
    this._value = '';
  }

  get id() { return this.attrs.get('id') ?? ''; }
  get type() { return this.attrs.get('type') ?? ''; }
  get className() { return this.attrs.get('class') ?? ''; }
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    const write = (items) => this.attrs.set('class', items.join(' '));
    return {
      contains: (c) => list().includes(c),
      add: (...cs) => write([...new Set([...list(), ...cs])]),
      remove: (...cs) => write(list().filter((c) => !cs.includes(c))),
      toggle: (c, on) => {
        const want = on ?? !list().includes(c);
        if (want) write([...new Set([...list(), c])]); else write(list().filter((x) => x !== c));
        return want;
      },
    };
  }
  get hidden() { return this.attrs.has('hidden'); }
  set hidden(v) { if (v) this.attrs.set('hidden', ''); else this.attrs.delete('hidden'); }

  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    this.attrs.set(key, String(value));
    if (key.startsWith('data-')) this.dataset[camel(key.slice(5))] = String(value);
    if (key === 'style') {
      for (const decl of String(value).split(';')) {
        const [prop, val] = decl.split(':').map((s) => s?.trim());
        if (prop) this.style[camel(prop)] = val ?? '';
      }
    }
  }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name) { return this.attrs.has(name); }
  removeAttribute(name) { this.attrs.delete(name); }
  toggleAttribute(name, force) {
    const on = force ?? !this.attrs.has(name);
    if (on) this.attrs.set(name, ''); else this.attrs.delete(name);
    return on;
  }

  get children() { return this.childNodes.filter((n) => n instanceof FakeEl || (n && n.tagName)); }
  get lastElementChild() { return this.children.at(-1) ?? null; }
  get textContent() { return this.childNodes.map((n) => n.textContent ?? '').join(''); }
  set textContent(v) { this.childNodes = [new FakeText(String(v ?? ''))]; }

  get options() {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        const name = child.localName ?? String(child.tagName ?? '').toLowerCase();
        if (name === 'option') out.push(child);
        else if (name === 'optgroup') walk(child);
      }
    };
    walk(this);
    return out;
  }
  get value() {
    if (this.localName === 'select') {
      const options = this.options;
      const chosen = options.find((o) => o.selected) ?? options[0];
      return chosen ? String(chosen.value ?? '') : '';
    }
    if (this.localName === 'option') return this.attrs.has('value') ? this.attrs.get('value') : this.textContent;
    return this._value;
  }
  set value(v) {
    if (this.localName === 'select') {
      const target = this.options.find((o) => String(o.value) === String(v));
      for (const option of this.options) option.selected = option === target;
      return;
    }
    this._value = String(v ?? '');
  }

  append(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'string' ? new FakeText(n) : n); }
  appendChild(node) {
    if (node.parentNode?.childNodes) node.parentNode.childNodes = node.parentNode.childNodes.filter((c) => c !== node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); }
  remove() {
    if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((c) => c !== this);
    this.parentNode = null;
  }
  insertAdjacentHTML(position, html) {
    const nodes = parseHtml(html);
    if (position === 'afterbegin') {
      for (const n of nodes.reverse()) { n.parentNode = this; this.childNodes.unshift(n); }
    } else {
      for (const n of nodes) this.appendChild(n);
    }
  }

  matches(selector) { return splitList(selector).some((s) => matchesComplex(this, s)); }
  closest(selector) {
    for (let node = this; node instanceof FakeEl; node = node.parentNode) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (!(child instanceof FakeEl)) continue;
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  addEventListener(type, fn, opts) { (this.listeners[type] ??= []).push({ fn, capture: !!(opts === true || opts?.capture) }); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l.fn !== fn); }
  dispatchEvent(event) {
    const ev = {
      type: event.type, target: this, bubbles: event.bubbles !== false, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.stopped = true; },
    };
    this.events.push(event.type);
    for (let node = this; node instanceof FakeEl; node = node.parentNode) {
      ev.currentTarget = node;
      for (const { fn } of [...(node.listeners[event.type] ?? [])]) fn(ev);
      if (ev.stopped || !ev.bubbles) break;
    }
    return !ev.defaultPrevented;
  }
  click() { this.dispatchEvent({ type: 'click', bubbles: true }); }
  focus() { active = this; }
  blur() { if (active === this) active = null; }
  scrollIntoView() {}
}

function parseHtml(html) {
  const root = new FakeEl('#root');
  const stack = [root];
  const token = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
  for (const m of String(html).matchAll(token)) {
    const top = stack.at(-1);
    if (m[1]) {
      const at = stack.findLastIndex((n) => n.localName === m[1].toLowerCase());
      if (at > 0) stack.length = at;
    } else if (m[2]) {
      const el = new FakeEl(m[2]);
      const attrText = m[3].replace(/\/\s*$/, '');
      for (const a of attrText.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g)) {
        el.setAttribute(a[1], decode(a[2] ?? a[3] ?? a[4] ?? ''));
      }
      el.checked = el.attrs.has('checked');
      el.disabled = el.attrs.has('disabled');
      el.selected = el.attrs.has('selected');
      if (el.attrs.has('value') && el.localName !== 'option') el._value = el.attrs.get('value');
      top.appendChild(el);
      if (!VOID.has(el.localName) && !/\/\s*$/.test(m[3])) stack.push(el);
    } else if (m[4]) {
      top.appendChild(new FakeText(m[4]));
    }
  }
  // Ein <textarea> traegt seinen Wert als Inhalt.
  for (const area of root.querySelectorAll('textarea')) area._value = area.textContent;
  const nodes = [...root.childNodes];
  for (const n of nodes) n.parentNode = null;
  return nodes;
}

/* --- Selektoren: Tag, #id, .klasse, [attr], [attr="wert"], Nachfahre, Liste */

function splitList(selector) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const c = selector[i];
    if (c === '[' || c === '(') depth += 1;
    else if (c === ']' || c === ')') depth -= 1;
    else if (c === ',' && depth === 0) { out.push(selector.slice(from, i).trim()); from = i + 1; }
  }
  out.push(selector.slice(from).trim());
  return out.filter(Boolean);
}

function parseCompound(text) {
  const parts = [];
  const re = /^([a-zA-Z][\w-]*)|^#([\w-]+)|^\.([\w-]+)|^\[([\w-]+)(?:="([^"]*)"|=([\w-]+))?\]/;
  let rest = text;
  while (rest) {
    const m = re.exec(rest);
    if (!m) throw new Error(`Selektor nicht unterstuetzt: "${text}"`);
    if (m[1]) parts.push((el) => el.localName === m[1].toLowerCase());
    else if (m[2]) parts.push((el) => el.id === m[2]);
    else if (m[3]) parts.push((el) => el.classList.contains(m[3]));
    else if (m[4]) {
      const want = m[5] ?? m[6];
      parts.push((el) => el.attrs.has(m[4]) && (want === undefined || el.attrs.get(m[4]) === want));
    }
    rest = rest.slice(m[0].length);
  }
  return (el) => parts.every((p) => p(el));
}

function matchesComplex(el, selector) {
  if (/[>+~]/.test(selector.replace(/\[[^\]]*\]/g, ''))) throw new Error(`Kombinator nicht unterstuetzt: "${selector}"`);
  const chain = selector.split(/\s+/).filter(Boolean).map(parseCompound);
  if (!chain.at(-1)(el)) return false;
  let node = el.parentNode;
  for (let i = chain.length - 2; i >= 0; i -= 1) {
    while (node instanceof FakeEl && !chain[i](node)) node = node.parentNode;
    if (!(node instanceof FakeEl)) return false;
    node = node.parentNode;
  }
  return true;
}

/** Das Blatt als Baum unter einem Panel, wie openModal es hinstellt. */
function panelFrom(html) {
  const panel = new FakeEl('div');
  panel.setAttribute('class', 'modal-panel');
  for (const node of parseHtml(html)) panel.appendChild(node);
  return panel;
}

// --------------------------------------------------------------------------
// Markup-Helfer
// --------------------------------------------------------------------------

/** Rechte fuer die Dauer des Aufrufs. */
function withAccess(modules, run) {
  setPermissions({ admin: false, modules, widgets: {}, capabilities: {} });
  try { return run(); } finally { clearPermissions(); }
}

/**
 * Das Blatt wie im Browser: die echte Personenauswahl, ein erkennbarer
 * Aufklapper (der Loader stubt modal.js), eine erkennbare Wiederholung (der
 * Loader stubt rrule-ui.js). `advanced` haelt fest, was der Aufklapper bekam.
 */
/** Die Wiederholung, wie der Loader sie stubt - mit der Regel, die sie bekam. */
const rruleStub = (prefix, rule) => `<div class="rrule-fields" data-rule="${rule ?? ''}"><select class="form-input" id="${prefix}-rrule-freq"><option value="">x</option></select></div>`;
/** „Więcej", erkennbar: ein <details> wie advancedSection() es baut. */
const advancedStub = (inner, opts = {}) => `<details class="form-advanced"${opts.open ? ' open' : ''}><summary class="form-advanced__summary">${opts.label ?? ''}</summary><div class="form-advanced__body">${inner}</div></details>`;

function render({
  mode = 'create', event = null, date = TODAY, time = '10:00', reminder = [], documents = 'write',
  draft = null, spoken = false, heard = '',
} = {}) {
  let advanced = null;
  globalThis.__renderUserMultiSelect = renderUserMultiSelect;
  globalThis.__renderRRuleFields = rruleStub;
  globalThis.__advancedSection = (inner, opts = {}) => {
    advanced = { inner: String(inner), opts };
    return advancedStub(inner, opts);
  };
  try {
    const html = withAccess({ calendar: 'write', documents }, () => calendar.buildEventModalContent(
      mode === 'create' ? { mode, date, time, reminder, draft, spoken, heard } : { mode, event, reminder }));
    return { html, advanced };
  } finally {
    delete globalThis.__renderUserMultiSelect;
    delete globalThis.__renderRRuleFields;
    delete globalThis.__advancedSection;
  }
}

const tagOf = (html, attr) => html.match(new RegExp(`<[a-z-]+\\b[^>]*${attr}[^>]*>`))?.[0] ?? '';

/** Die Stellen der Marken im Markup - alle gefunden und aufsteigend. */
function assertInOrder(html, marks, what) {
  const at = marks.map((m) => html.indexOf(m));
  assert.ok(at.every((i) => i >= 0), `${what}: nicht gerendert: ${marks.filter((_, i) => at[i] < 0).join(', ')}`);
  assert.ok(at.every((i, k) => k === 0 || at[k - 1] < i),
    `${what}: Reihenfolge ist ${marks.slice().sort((a, b) => html.indexOf(a) - html.indexOf(b)).join(' < ')}`);
}

const EDIT_BASE = {
  id: 9, title: 'Elternabend', start_datetime: `${TOMORROW}T17:00`, end_datetime: `${TOMORROW}T18:30`,
  visibility: 'all', created_by: ANNA.id, all_day: 0, assigned_users: [], recurrence_rule: null,
};

// --------------------------------------------------------------------------
// Der erste Blick: Anlegen
// --------------------------------------------------------------------------

test('create: title with the mic, people, the rows When/Where/Reminder, More - and one Add button', () => {
  const { html } = render();
  assertInOrder(html, [
    'id="modal-title"', 'data-action="dictate"', 'data-ms-name="cal_assigned"',
    'data-row="when"', 'data-row="where"', 'data-row="reminder"', '<details class="form-advanced"',
  ], 'Blatt');
  assert.match(tagOf(html, 'data-action="dictate"'), /class="task-sheet__mic"/, 'the mic sits in the title field');
  assert.match(html, /class="form-field task-sheet__title task-sheet__title--mic"/);
  assert.doesNotMatch(html, /id="modal-cancel"/, 'no Cancel: x and swipe close the sheet');
  assert.doesNotMatch(html, /id="modal-delete"/, 'nothing to delete yet');
  const save = html.match(/<button[^>]*id="modal-save"[^>]*>([^<]*)<\/button>/);
  assert.ok(save, 'one Save button');
  assert.match(save[0], /class="btn btn--primary task-sheet__submit"/, 'full width, like "Dodaj zadanie"');
  assert.match(save[0], /type="button"/);
  assert.equal(save[1].trim(), 'calendar.addEvent', 'the button names the thing');
  assert.equal((html.match(/id="modal-save"/g) ?? []).length, 1);
});

test('create: the When row names the day and the hours; its fields fold behind it', () => {
  const { html } = render({ date: TOMORROW, time: '17:00' });
  const panel = panelFrom(html);
  const section = panel.querySelector('[data-section="when"]');
  assert.ok(section, 'a When section');
  assert.equal(section.hidden, false, 'an event always has a when');
  const row = section.querySelector('[data-row="when"]');
  assert.equal(row.hidden, false, 'the row stands');
  assert.equal(row.querySelector('.task-sheet__row-value').textContent, 'common.tomorrow, 17:00-18:00',
    'day and hours, an unspaced hyphen between the hours (R3)');
  assert.equal(row.querySelector('.task-sheet__row-label').textContent, 'calendar.whenLabel');
  assert.equal(row.querySelector('[data-remove]'), null, 'an event cannot lose its when: no x on this row');
  const body = section.querySelector('.task-sheet__body');
  assert.equal(body.hidden, true, 'the fields wait behind the row');
  assert.deepEqual(body.querySelectorAll('[data-day-pick]').map((b) => [b.dataset.dayPick, b.getAttribute('aria-pressed'), b.textContent.trim()]), [
    ['today', 'false', 'common.today'], ['tomorrow', 'true', 'common.tomorrow'], ['pick', 'false', 'tasks.duePick'],
  ]);
  const ids = ['modal-start-date', 'modal-start-time', 'modal-end-date', 'modal-end-time', 'modal-allday', 'allday-fields'];
  for (const id of ids) assert.ok(body.querySelector(`#${id}`), `#${id} lives in the When fields`);
  const bodyHtml = html.slice(html.indexOf('id="event-when-body"'));
  assertInOrder(bodyHtml, ['data-day-pick="today"', 'id="modal-start-date"', 'id="modal-end-time"', 'id="modal-allday"'],
    'Kiedy: pills, from-to, all-day switch');
});

test('create: Where and Reminder wait as add-chips until asked for', () => {
  const { html } = render();
  const panel = panelFrom(html);
  for (const name of ['where', 'reminder']) {
    assert.equal(panel.querySelector(`[data-section="${name}"]`).hidden, true, `${name}: folded away while empty`);
    const chip = panel.querySelector(`[data-reveal="${name}"]`);
    assert.ok(chip, `${name}: an add-chip`);
    assert.equal(chip.hidden, false);
    assert.equal(chip.getAttribute('type'), 'button');
  }
  assert.equal(panel.querySelector('[data-reveal="where"]').textContent.trim(), 'calendar.whereLabel');
  assert.equal(panel.querySelector('[data-reveal="reminder"]').textContent.trim(), 'reminders.sectionTitle');
  assert.equal(panel.querySelector('#modal-reminder-toggle').checked, false);
  assert.equal(panel.querySelector('#modal-location').value, '');
});

test('create: a household default reminder stands as a Reminder row', () => {
  calendar.state.defaultReminders = [60];
  try {
    const panel = panelFrom(render().html);
    const section = panel.querySelector('[data-section="reminder"]');
    assert.equal(section.hidden, false);
    assert.equal(section.querySelector('.task-sheet__row-value').textContent, 'reminders.offset1hour');
    assert.equal(panel.querySelector('[data-reveal="reminder"]').hidden, true, 'no chip next to its row');
    assert.equal(panel.querySelector('#modal-reminder-toggle').checked, true);
    assert.equal(panel.querySelector('.js-reminder-offset').value, '60');
  } finally {
    calendar.state.defaultReminders = [];
  }
});

test('More holds repeat, calendar, note, visibility, countdown, icon, sync target and attachment - in that order', () => {
  calendar.state.localCalendars = [{ id: 1, name: 'Yuvomi', is_default: true }, { id: 2, name: 'Praca' }];
  try {
    const { html, advanced } = render();
    assert.ok(advanced, 'More is built through advancedSection()');
    assert.equal(advanced.opts.label, 'tasks.more', 'it reads "Więcej"');
    assert.equal(advanced.opts.open, false, 'a new event keeps More shut');
    const inside = ['id="event-rrule-freq"', 'id="event-local-calendar"', 'id="modal-description"', 'id="modal-visibility"',
      'id="modal-countdown"', 'id="modal-icon"', 'id="event-sync-target"', 'id="modal-attachment"'];
    assertInOrder(advanced.inner, inside, 'Więcej');
    const outside = html.replace(advanced.inner, '');
    for (const m of inside) assert.ok(!outside.includes(m), `${m} stands outside More`);
    assert.ok(advanced.opts.hint, 'the More line still names what lies behind it (#647)');
  } finally {
    calendar.state.localCalendars = [];
  }
});

// --------------------------------------------------------------------------
// Bearbeiten
// --------------------------------------------------------------------------

test('edit: no mic, Delete and Save, no Cancel; set values stand as rows', () => {
  const event = { ...EDIT_BASE, location: 'Hala <A>' };
  const reminder = [{ remind_at: `${TOMORROW}T15:00:00` }];
  const { html } = render({ mode: 'edit', event, reminder });
  assert.doesNotMatch(html, /data-action="dictate"/, 'no mic while editing (R10)');
  assert.doesNotMatch(html, /id="modal-cancel"/);
  assert.match(html, /<button[^>]*id="modal-delete"/, 'edit keeps Delete');
  const save = html.match(/<button[^>]*id="modal-save"[^>]*>([^<]*)<\/button>/);
  assert.equal(save[1].trim(), 'common.save');
  const panel = panelFrom(html);
  assert.equal(panel.querySelector('#modal-title').value, 'Elternabend');
  const where = panel.querySelector('[data-section="where"]');
  assert.equal(where.hidden, false);
  assert.equal(where.querySelector('.task-sheet__row-value').textContent, 'Hala <A>', 'escaped in, read back as text');
  assert.equal(panel.querySelector('#modal-location').value, 'Hala <A>');
  assert.equal(panel.querySelector('[data-reveal="where"]').hidden, true);
  const remind = panel.querySelector('[data-section="reminder"]');
  assert.equal(remind.hidden, false);
  assert.ok(remind.querySelector('.task-sheet__row-value').textContent, 'the reminder row names its reminder');
  assert.equal(panel.querySelector('[data-section="when"] .task-sheet__row-value').textContent, 'common.tomorrow, 17:00-18:30');
});

test('edit: an all-day event reads "<day>, all day"; several days read "<from>-<to>, all day"', () => {
  const one = panelFrom(render({ mode: 'edit', event: { ...EDIT_BASE, all_day: 1, start_datetime: TOMORROW, end_datetime: TOMORROW } }).html);
  assert.equal(one.querySelector('[data-row="when"] .task-sheet__row-value').textContent, 'common.tomorrow, calendar.whenAllDay');
  assert.equal(one.querySelector('#modal-allday').checked, true);
  const span = panelFrom(render({ mode: 'edit', event: { ...EDIT_BASE, all_day: 1, start_datetime: TODAY, end_datetime: TOMORROW } }).html);
  assert.equal(span.querySelector('[data-row="when"] .task-sheet__row-value').textContent, 'common.today-common.tomorrow, calendar.whenAllDay');
});

test('edit: a timed event over several days names both days', () => {
  const panel = panelFrom(render({ mode: 'edit', event: { ...EDIT_BASE, start_datetime: `${TOMORROW}T22:00`, end_datetime: `${IN_FIVE}T09:00` } }).html);
  const value = panel.querySelector('[data-row="when"] .task-sheet__row-value').textContent;
  assert.match(value, /^common\.tomorrow, 22:00-.+, 09:00$/, value);
});

test('edit: More opens for a set repeat (R8), and still for a note, a countdown, a restricted visibility', () => {
  const open = (extra) => render({ mode: 'edit', event: { ...EDIT_BASE, ...extra } }).advanced.opts.open;
  assert.equal(open({}), false, 'nothing set behind More');
  assert.equal(open({ recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO' }), true, 'a repeat is a set value');
  assert.equal(open({ description: 'Stifte' }), true);
  assert.equal(open({ countdown: 1 }), true);
  assert.equal(open({ visibility: 'private' }), true);
});

// --------------------------------------------------------------------------
// Verdrahtung am echten Markup
// --------------------------------------------------------------------------

/** Das Blatt aufbauen und verdrahten wie openModal({ onSave: wireEventForm }). */
async function openSheet({ mode = 'create', event = null, date = TODAY, time = '10:00', reminder = [], draft = null } = {}) {
  const { html } = render({ mode, event, date, time, reminder, draft, documents: 'none' });
  const panel = panelFrom(html);
  globalThis.__apiStub = { get: async () => ({ data: { google: [], caldav: [], outlook: [] } }) };
  try {
    calendar.wireEventForm(panel, { mode, event, reminder });
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    delete globalThis.__apiStub;
  }
  return panel;
}

test('wiring: a tap on the When row opens its fields; the focus goes to the chosen day', async () => {
  const panel = await openSheet({ date: TOMORROW, time: '17:00' });
  panel.querySelector('[data-expand="when"]').click();
  const section = panel.querySelector('[data-section="when"]');
  assert.equal(section.querySelector('[data-row]').hidden, true, 'the row gives way');
  assert.equal(section.querySelector('.task-sheet__body').hidden, false, 'to the fields');
  assert.equal(section.querySelector('[data-expand]').getAttribute('aria-expanded'), 'true');
  assert.equal(active?.dataset.dayPick, 'tomorrow', 'the focus lands on the pressed day');
});

test('wiring: Tomorrow writes the start day, the end follows, the pill is pressed; Pick opens the date', async () => {
  const panel = await openSheet({ date: TODAY, time: '10:00' });
  panel.querySelector('[data-expand="when"]').click();
  panel.querySelector('[data-day-pick="tomorrow"]').click();
  assert.equal(panel.querySelector('#modal-start-date').value, TOMORROW);
  assert.equal(panel.querySelector('#modal-end-date').value, TOMORROW, 'the end moves with the start');
  assert.equal(panel.querySelector('#modal-allday-start').value, TOMORROW, 'the all-day start too');
  assert.equal(panel.querySelector('#modal-start-time').value, '10:00', 'the hour stays');
  const pressed = () => panel.querySelectorAll('[data-day-pick]').map((b) => b.getAttribute('aria-pressed'));
  assert.deepEqual(pressed(), ['false', 'true', 'false']);
  panel.querySelector('[data-day-pick="today"]').click();
  assert.equal(panel.querySelector('#modal-start-date').value, TODAY);
  assert.deepEqual(pressed(), ['true', 'false', 'false']);
  panel.querySelector('[data-day-pick="pick"]').click();
  assert.deepEqual(pressed(), ['false', 'false', 'true'], 'Pick stays pressed even on today');
  assert.equal(active, panel.querySelector('#modal-start-date'), 'the start date takes the focus');
});

test('wiring: with all day on, a day pill writes the all-day start', async () => {
  const panel = await openSheet({ date: TODAY });
  const allday = panel.querySelector('#modal-allday');
  allday.checked = true;
  allday.dispatchEvent({ type: 'change', bubbles: true });
  assert.equal(panel.querySelector('#time-fields').style.display, 'none');
  panel.querySelector('[data-day-pick="tomorrow"]').click();
  assert.equal(panel.querySelector('#modal-allday-start').value, TOMORROW);
  assert.equal(panel.querySelector('#modal-allday-end').value, TOMORROW, 'the all-day end follows');
});

test('wiring: the Where chip opens the place field; its x clears it and brings the chip back', async () => {
  const panel = await openSheet();
  const chip = panel.querySelector('[data-reveal="where"]');
  chip.click();
  const section = panel.querySelector('[data-section="where"]');
  assert.equal(section.hidden, false);
  assert.equal(section.querySelector('.task-sheet__body').hidden, false, 'the field, not an empty row');
  assert.equal(chip.hidden, true);
  assert.equal(active, panel.querySelector('#modal-location'), 'typing is the intent');
  panel.querySelector('#modal-location').value = 'Hala';
  section.querySelector('.task-sheet__body [data-remove="where"]').click();
  assert.equal(panel.querySelector('#modal-location').value, '', 'Remove clears the place');
  assert.equal(section.hidden, true);
  assert.equal(chip.hidden, false);
  assert.equal(active, chip, 'the focus goes back to the chip');
});

test('wiring: the x on a Where row clears the place, like Remove', async () => {
  const panel = await openSheet({ mode: 'edit', event: { ...EDIT_BASE, location: 'Hala' } });
  panel.querySelector('[data-row="where"] [data-remove="where"]').click();
  assert.equal(panel.querySelector('#modal-location').value, '');
  assert.equal(panel.querySelector('[data-section="where"]').hidden, true);
  assert.equal(panel.querySelector('[data-reveal="where"]').hidden, false);
});

test('wiring: the Reminder chip switches the reminder on; Remove switches it off', async () => {
  const panel = await openSheet();
  const toggle = panel.querySelector('#modal-reminder-toggle');
  const fields = panel.querySelector('#modal-reminder-fields');
  panel.querySelector('[data-reveal="reminder"]').click();
  assert.equal(toggle.checked, true);
  assert.equal(fields.style.display, '', 'its rows show');
  assert.equal(panel.querySelectorAll('[data-reminder-row]').length, 1, 'one row to start with');
  assert.equal(active, panel.querySelector('.js-reminder-offset'), 'the focus goes to its lead time');
  panel.querySelector('[data-section="reminder"] .task-sheet__body [data-remove="reminder"]').click();
  assert.equal(toggle.checked, false);
  assert.equal(fields.style.display, 'none');
  assert.equal(panel.querySelector('[data-section="reminder"]').hidden, true);
  assert.equal(panel.querySelector('[data-reveal="reminder"]').hidden, false);
});

// --------------------------------------------------------------------------
// Speichern: derselbe Koerper wie vor dem Umbau
// --------------------------------------------------------------------------

/**
 * Faehrt saveEvent auf dem Blatt; zurueck kommen die Anfragen. Die Personen
 * und die Wiederholung liefern die Loader-Haken (beide Bausteine sind dort
 * gestubbt), alles andere liest saveEvent aus den Feldern des Markups.
 */
async function save(panel, { mode = 'create', event = null, assigned = [2], rrule = null, fail = false } = {}) {
  const calls = [];
  const errors = [];
  globalThis.__apiStub = {
    get: async (path) => { calls.push({ method: 'get', path }); return { data: [] }; },
    post: async (path, body) => {
      calls.push({ method: 'post', path, body });
      if (fail) throw Object.assign(new Error('x'), { data: { error: 'Kaputt' } });
      return { data: { id: 5 } };
    },
    put: async (path, body) => { calls.push({ method: 'put', path, body }); return { data: { id: event?.id ?? 5 } }; },
    delete: async (path) => { calls.push({ method: 'delete', path }); return { data: null }; },
  };
  globalThis.__getSelectedUserIds = () => assigned;
  globalThis.__rruleValues = { recurrence_rule: rrule, valid_until: true };
  globalThis.__closeModal = () => {};
  globalThis.__reportFieldError = (input, message) => errors.push({ input, message });
  try {
    await calendar.saveEvent(panel, mode, event, [], null);
  } finally {
    delete globalThis.__apiStub;
    delete globalThis.__getSelectedUserIds;
    delete globalThis.__rruleValues;
    delete globalThis.__closeModal;
    delete globalThis.__reportFieldError;
  }
  return { calls, errors };
}

const plain = (body) => JSON.parse(JSON.stringify(body));

/*
 * DER SCHNAPPSCHUSS (aufgenommen am Stand vor dem Umbau, 9a958e4): ein neuer
 * Termin am 17.01.2035, 17:00-18:30, in der Halle, Ben zugewiesen,
 * woechentlich, eine Erinnerung eine Stunde vorher (Winterzeit: 16:00 in
 * Warschau ist 15:00 UTC); dazu ein ganztaegiger Termin ueber fuenf Tage, der
 * bearbeitet wird. Der Umbau aendert das Blatt, nicht das, was es schickt.
 */
const NO_SYNC_TARGET = {
  target_google_calendar_id: null,
  target_caldav_account_id: null,
  target_caldav_calendar_url: null,
  target_outlook_account_id: null,
  target_outlook_calendar_id: null,
};
const CREATE_BODY = {
  title: 'Trening Leo', description: null,
  start_datetime: '2035-01-17T17:00', end_datetime: '2035-01-17T18:30', all_day: false,
  location: 'Hala', icon: 'calendar', assigned_to: [2], visibility: 'all', countdown: false,
  recurrence_rule: 'FREQ=WEEKLY;BYDAY=TH', ...NO_SYNC_TARGET,
};
const CREATE_REMINDER_PUT = {
  method: 'put', path: '/reminders?entity_type=event&entity_id=5', body: { remind_ats: ['2035-01-17T15:00:00'] },
};
const EDIT_BODY = {
  title: 'Urlop', description: 'Kuchen',
  start_datetime: '2035-01-17', end_datetime: '2035-01-21', all_day: true,
  location: 'Dom', icon: 'calendar', assigned_to: [1, 2], visibility: 'all', countdown: false,
  recurrence_rule: null, ...NO_SYNC_TARGET,
};

test('save: a filled new event posts the same body as before, and the same reminder PUT', async () => {
  const panel = panelFrom(render({ date: '2035-01-17', time: '17:00' }).html);
  panel.querySelector('#modal-title').value = '  Trening Leo ';
  panel.querySelector('#modal-end-time').value = '18:30';
  panel.querySelector('#modal-location').value = 'Hala';
  panel.querySelector('#modal-reminder-toggle').checked = true;
  panel.querySelector('.js-reminder-offset').value = '60';
  const { calls, errors } = await save(panel, { rrule: 'FREQ=WEEKLY;BYDAY=TH' });
  assert.deepEqual(errors, []);
  const post = calls.find((c) => c.method === 'post' && c.path === '/calendar');
  assert.ok(post, 'the event is posted');
  assert.deepEqual(plain(post.body), CREATE_BODY);
  const put = calls.find((c) => c.method === 'put' && c.path.startsWith('/reminders'));
  assert.deepEqual(plain(put), CREATE_REMINDER_PUT);
});

test('save: editing an all-day event puts the same body as before; no reminder deletes them', async () => {
  const event = { ...EDIT_BASE, all_day: 1, start_datetime: '2035-01-17', end_datetime: '2035-01-21', location: 'Dom', description: 'Kuchen' };
  const panel = panelFrom(render({ mode: 'edit', event }).html);
  panel.querySelector('#modal-title').value = 'Urlop';
  const { calls, errors } = await save(panel, { mode: 'edit', event, assigned: [1, 2] });
  assert.deepEqual(errors, []);
  const put = calls.find((c) => c.method === 'put' && c.path === '/calendar/9');
  assert.ok(put, 'the event is saved');
  assert.deepEqual(plain(put.body), EDIT_BODY);
  assert.ok(calls.some((c) => c.method === 'delete' && c.path === '/reminders?entity_type=event&entity_id=9'),
    'no reminder in the sheet: the stored ones go, as before');
});

test('save: a refused save gives the button its name back', async () => {
  const panel = panelFrom(render().html);
  panel.querySelector('#modal-title').value = 'Dentysta';
  await save(panel, { fail: true });
  assert.equal(panel.querySelector('#modal-save').textContent, 'calendar.addEvent');
  assert.equal(panel.querySelector('#modal-save').disabled, false);
});

test('save: an error behind a folded row opens the row to show it', async () => {
  const event = { ...EDIT_BASE, start_datetime: `${TOMORROW}T17:00`, end_datetime: `${TOMORROW}T18:30` };
  const panel = panelFrom(render({ mode: 'edit', event }).html);
  panel.querySelector('#modal-end-time').value = '16:00';
  const { calls, errors } = await save(panel, { mode: 'edit', event });
  assert.equal(calls.filter((c) => c.method !== 'get').length, 0, 'nothing goes out');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].input, panel.querySelector('#modal-end-time'));
  const section = panel.querySelector('[data-section="when"]');
  assert.equal(section.querySelector('[data-row]').hidden, true, 'the row gives way');
  assert.equal(section.querySelector('.task-sheet__body').hidden, false, 'to the field that carries the error');
});

// --------------------------------------------------------------------------
// Nachgetragen aus dem Review zu Task 10: der Tag ueberlebt den
// Ganztags-Schalter, und eine entfernte Erinnerung geht beim Speichern
// --------------------------------------------------------------------------

const pressedPills = (panel) => panel.querySelectorAll('[data-day-pick]').map((b) => b.getAttribute('aria-pressed'));
const fire = (el, type = 'change') => el.dispatchEvent({ type, bubbles: true });

test('wiring: a day picked in the date field survives switching all day on, and back', async () => {
  const panel = await openSheet({ date: TODAY, time: '10:00' });
  panel.querySelector('[data-expand="when"]').click();
  // Der Kalender des Datepickers schreibt den Tag (ISO) und meldet `change`.
  const start = panel.querySelector('#modal-start-date');
  start.value = TOMORROW;
  fire(start);
  assert.equal(panel.querySelector('#modal-end-date').value, TOMORROW, 'precondition: the end followed');
  const allday = panel.querySelector('#modal-allday');
  allday.checked = true;
  fire(allday);
  assert.equal(panel.querySelector('#modal-allday-start').value, TOMORROW, 'the picked day goes along');
  assert.equal(panel.querySelector('#modal-allday-end').value, TOMORROW, 'the end follows it');
  assert.deepEqual(pressedPills(panel), ['false', 'true', 'false'], 'the pills show the picked day, not the stale one');

  const alldayStart = panel.querySelector('#modal-allday-start');
  alldayStart.value = IN_FIVE;
  fire(alldayStart);
  allday.checked = false;
  fire(allday);
  assert.equal(panel.querySelector('#modal-start-date').value, IN_FIVE, 'and back: the all-day day goes to the timed start');
  assert.equal(panel.querySelector('#modal-end-date').value, IN_FIVE, 'its end follows');
  assert.equal(panel.querySelector('#modal-start-time').value, '10:00', 'the hour stays');
  assert.equal(panel.querySelector('#modal-end-time').value, '11:00');
  assert.deepEqual(pressedPills(panel), ['false', 'false', 'true']);
});

test('save: an edit keeps its stored reminder when untouched, and deletes it after Remove or the row x', async () => {
  const event = { ...EDIT_BASE, start_datetime: '2035-01-17T17:00', end_datetime: '2035-01-17T18:30' };
  // Eine Stunde vorher: 16:00 in Warschau (Winterzeit) ist 15:00 UTC.
  const reminder = [{ remind_at: '2035-01-17T15:00:00' }];
  const reminderCalls = (calls) => calls.filter((c) => c.path.startsWith('/reminders')).map((c) => [c.method, c.body ?? null]);

  const untouched = await openSheet({ mode: 'edit', event, reminder });
  assert.equal(untouched.querySelector('#modal-reminder-toggle').checked, true, 'precondition: the stored reminder is on');
  const kept = await save(untouched, { mode: 'edit', event, assigned: [] });
  assert.deepEqual(kept.errors, []);
  assert.deepEqual(reminderCalls(kept.calls), [['put', { remind_ats: ['2035-01-17T15:00:00'] }]], 'the same reminder goes back');

  for (const remove of ['[data-section="reminder"] .task-sheet__body [data-remove="reminder"]', '[data-row="reminder"] [data-remove="reminder"]']) {
    const panel = await openSheet({ mode: 'edit', event, reminder });
    panel.querySelector(remove).click();
    assert.equal(panel.querySelector('#modal-reminder-toggle').checked, false, `${remove}: switched off`);
    const { calls, errors } = await save(panel, { mode: 'edit', event, assigned: [] });
    assert.deepEqual(errors, []);
    assert.ok(calls.some((c) => c.method === 'put' && c.path === '/calendar/9'), 'the event is saved');
    assert.deepEqual(reminderCalls(calls), [['delete', null]], `${remove}: the stored reminder goes`);
  }
});

// --------------------------------------------------------------------------
// Ein Entwurf aus einem Satz (Task 11): das Blatt steht gefuellt da
// --------------------------------------------------------------------------

/** Was POST /quick-add/parse fuer „Trening Leo, 18.01.2035 um 17" liefert (Task 8). */
const DRAFT = Object.freeze({
  title: 'Trening Leo', date: '2035-01-18', start_time: '17:00', end_time: null, all_day: false,
  location: null, assigned_to: [], reminder_minutes: null,
});
const valueOf = (panel, sel) => panel.querySelector(sel)?.value;
const personChecked = (panel, id) => panel.querySelector(`[data-ms-input="cal_assigned"][value="${id}"]`)?.checked;

test('draft: a timed event starts at its day and hour; with no end said it lasts the usual length', () => {
  const panel = panelFrom(render({ draft: DRAFT }).html);
  assert.equal(valueOf(panel, '#modal-title'), 'Trening Leo');
  assert.equal(panel.querySelector('#modal-allday').checked, false);
  assert.deepEqual(['#modal-start-date', '#modal-start-time', '#modal-end-date', '#modal-end-time'].map((s) => valueOf(panel, s)),
    ['2035-01-18', '17:00', '2035-01-18', '18:00'], 'end = start + 60 min');
  assert.match(panel.querySelector('[data-row="when"] .task-sheet__row-value').textContent, /, 17:00-18:00$/);

  const said = panelFrom(render({ draft: { ...DRAFT, end_time: '18:30' } }).html);
  assert.equal(valueOf(said, '#modal-end-time'), '18:30', 'a said end stands');

  calendar.state.defaultDuration = 90;
  try {
    assert.equal(valueOf(panelFrom(render({ draft: DRAFT }).html), '#modal-end-time'), '18:30', 'the household length counts');
  } finally {
    calendar.state.defaultDuration = 60;
  }
});

test('draft: a day without an hour is an all-day event on that day', async () => {
  const draft = { ...DRAFT, date: TOMORROW, start_time: null, all_day: true };
  const panel = await openSheet({ draft });
  assert.equal(panel.querySelector('#modal-allday').checked, true);
  assert.equal(valueOf(panel, '#modal-allday-start'), TOMORROW);
  assert.equal(valueOf(panel, '#modal-allday-end'), TOMORROW, 'one day');
  assert.equal(panel.querySelector('[data-row="when"] .task-sheet__row-value').textContent, 'common.tomorrow, calendar.whenAllDay');
  assert.equal(panel.querySelector('#time-fields').style.display, 'none', 'the hours wait behind the switch');
  assert.equal(panel.querySelector('#allday-fields').style.display, '', 'the day fields show');
  assert.deepEqual(pressedPills(panel), ['false', 'true', 'false']);
});

test('draft: a place, people and a reminder 60 minutes before stand as rows; the reminder is switched on', () => {
  const panel = panelFrom(render({ draft: { ...DRAFT, location: 'Hala <A>', assigned_to: [BEN.id], reminder_minutes: 60 } }).html);
  const where = panel.querySelector('[data-section="where"]');
  assert.equal(where.hidden, false);
  assert.equal(where.querySelector('.task-sheet__row-value').textContent, 'Hala <A>');
  assert.equal(valueOf(panel, '#modal-location'), 'Hala <A>');
  assert.equal(panel.querySelector('[data-reveal="where"]').hidden, true);
  assert.equal(personChecked(panel, BEN.id), true, 'Ben is chosen');
  assert.equal(personChecked(panel, ANNA.id), false);
  const remind = panel.querySelector('[data-section="reminder"]');
  assert.equal(remind.hidden, false);
  assert.equal(panel.querySelector('#modal-reminder-toggle').checked, true, 'the reminder is on');
  assert.equal(panel.querySelectorAll('[data-reminder-row]').length, 1, 'one reminder');
  assert.equal(valueOf(panel, '.js-reminder-offset'), '60');
  assert.equal(remind.querySelector('.task-sheet__row-value').textContent, 'reminders.offset1hour');
  assert.equal(panel.querySelector('[data-reveal="reminder"]').hidden, true);
});

test('draft: half an hour before is a lead of 30 minutes; its row names the moment, not "Custom"', () => {
  const panel = panelFrom(render({ draft: { ...DRAFT, reminder_minutes: 30 } }).html);
  assert.equal(valueOf(panel, '.js-reminder-offset'), 'custom');
  assert.equal(valueOf(panel, '.js-reminder-custom-amount'), '30');
  assert.equal(valueOf(panel, '.js-reminder-custom-unit'), 'minutes');
  const text = panel.querySelector('[data-section="reminder"] .task-sheet__row-value').textContent;
  assert.ok(text && !/offsetCustom/.test(text), `the row says when: ${text}`);
});

test('draft: a reminder that would already lie in the past is not preset (R15); household defaults do not step in', () => {
  calendar.state.defaultReminders = [15];
  try {
    const panel = panelFrom(render({ draft: { ...DRAFT, date: addLocalDays(TODAY, -1), start_time: '10:00', reminder_minutes: 60 } }).html);
    assert.equal(panel.querySelector('#modal-reminder-toggle').checked, false);
    assert.equal(panel.querySelector('[data-section="reminder"]').hidden, true);
    assert.equal(panel.querySelector('[data-reveal="reminder"]').hidden, false, 'the chip waits');
    const quiet = panelFrom(render({ draft: DRAFT }).html);
    assert.equal(valueOf(quiet, '.js-reminder-offset'), '15', 'no reminder said: the household default, as for any new event');
  } finally {
    calendar.state.defaultReminders = [];
  }
});

test('draft: no title, no day and no hour -> an empty title, the sheet\'s own day and hour; the rest still applies', () => {
  const draft = { title: null, date: null, start_time: null, end_time: null, all_day: false, location: 'Dom', assigned_to: [], reminder_minutes: null };
  const panel = panelFrom(render({ date: TOMORROW, time: '09:00', draft }).html);
  assert.equal(valueOf(panel, '#modal-title'), '', 'no title, no crash');
  assert.deepEqual(['#modal-start-date', '#modal-start-time', '#modal-end-date', '#modal-end-time'].map((s) => valueOf(panel, s)),
    [TOMORROW, '09:00', TOMORROW, '10:00']);
  assert.equal(valueOf(panel, '#modal-location'), 'Dom');
  // Ohne KI liefert das Mikrofon nur einen Titel.
  const titleOnly = panelFrom(render({ date: TODAY, time: '10:00', draft: { title: 'Dentysta' } }).html);
  assert.equal(valueOf(titleOnly, '#modal-title'), 'Dentysta');
  assert.equal(valueOf(titleOnly, '#modal-start-date'), TODAY);
});

test('draft: people named win over "assign me"; when nobody is named, "assign me" still holds', () => {
  calendar.state.defaultAssignMe = true;
  try {
    const named = panelFrom(render({ draft: { ...DRAFT, assigned_to: [BEN.id] } }).html);
    assert.equal(personChecked(named, BEN.id), true);
    assert.equal(personChecked(named, ANNA.id), false);
    const nobody = panelFrom(render({ draft: DRAFT }).html);
    assert.equal(personChecked(nobody, ANNA.id), true);
  } finally {
    calendar.state.defaultAssignMe = false;
  }
});

/** Fragt den ECHTEN Dirty-Waechter (components/modal.js) nach dem Blatt, wie es aufgeht. */
const realModal = await import('../public/components/modal.js');
function dirtyAfterOpen(html) {
  const tree = panelFrom(html);
  const fields = tree.querySelectorAll('input, select, textarea')
    .filter((el) => el.type !== 'file' && !el.hasAttribute('data-dirty-ignore'));
  const panel = { querySelectorAll: () => fields };
  realModal.__test.adoptOverlayForTest({ querySelector: () => panel });
  try {
    assert.ok(fields.length > 5, 'precondition: the fields were read from the markup');
    return realModal.__test.isFormDirty(panel);
  } finally {
    realModal.__test.releaseOverlayForTest();
  }
}

test('draft: the sheet counts as changed from the start (R11); a typed new sheet and an untouched edit do not', () => {
  const html = render({ draft: DRAFT, spoken: true, heard: 'Trening Leo' }).html;
  assert.match(html, /<input type="hidden" id="event-from-draft" value="1" data-dirty-base="">/);
  assert.equal(dirtyAfterOpen(html), true, 'swiping it away asks first');
  assert.equal(dirtyAfterOpen(render().html), false, 'an empty new event closes without asking');
  assert.equal(dirtyAfterOpen(render({ mode: 'edit', event: EDIT_BASE }).html), false);
});

/** openModal abfangen, solange `run` laeuft. */
async function capturing(run) {
  const opened = [];
  const previous = globalThis.__openModal;
  globalThis.__openModal = (options) => { opened.push(options); };
  try { return await run(opened); } finally { globalThis.__openModal = previous; }
}

test('spoken: the heard sentence stands above the title and "Powtórz" in the header; typed or editing shows neither', async () => {
  await capturing((opened) => withAccess({ calendar: 'write', documents: 'none' }, () => {
    calendar.openEventModal({ mode: 'create', date: TODAY, time: '10:00', draft: DRAFT, spoken: true, heard: 'Trening Leo <jutro> o 17' });
    calendar.openEventModal({ mode: 'create', date: TODAY, time: '10:00', draft: DRAFT });
    calendar.openEventModal({ mode: 'create', date: TODAY, time: '10:00', draft: DRAFT, spoken: true });
    calendar.openEventModal({ mode: 'edit', event: EDIT_BASE, draft: DRAFT, spoken: true, heard: 'x' });
    const [spoken, typed, noHeard, edit] = opened;
    assert.equal(spoken.title, 'calendar.newEvent');
    assert.equal(spoken.headerAction?.id, 'event-say-again');
    assert.equal(spoken.headerAction?.label, 'tasks.sayAgain', '"Powtórz"');
    assert.equal(typeof spoken.headerAction?.onClick, 'function');
    assertInOrder(spoken.content, ['class="sheet-heard"', 'Trening Leo &lt;jutro&gt; o 17', 'id="modal-title"'], 'heard line above the title, escaped');
    assert.equal(typed.headerAction, null, 'a typed draft has no "Powtórz"');
    assert.doesNotMatch(typed.content, /sheet-heard/);
    assert.equal(noHeard.headerAction?.id, 'event-say-again', 'spoken without a sentence: still "Powtórz"');
    assert.doesNotMatch(noHeard.content, /sheet-heard/, '... but no empty heard line');
    assert.equal(edit.headerAction, null, 'editing is never spoken');
    assert.doesNotMatch(edit.content, /sheet-heard|event-from-draft/);
  }));
});

// --------------------------------------------------------------------------
// Das Mikrofon im Titel und „Powtórz": der Satz geht als Termin an den Server
// --------------------------------------------------------------------------

const AI = (fields) => ({ data: { source: 'ai', kind: 'event', fields: { ...DRAFT, ...fields } } });
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0)); };

/**
 * Ein Ablauf wie im Browser: openModal fangen (mit Kopfknopf, wie modal.js ihn
 * baut), die Bausteine stellen, die der Loader stubt, und POST mitschreiben.
 * `answer` ist die Antwort auf POST /quick-add/parse.
 */
async function voiceFlow(run, { answer = AI({}), selected = [], rule = null } = {}) {
  const posts = [];
  globalThis.__renderUserMultiSelect = renderUserMultiSelect;
  globalThis.__getSelectedUserIds = () => selected;
  globalThis.__renderRRuleFields = rruleStub;
  globalThis.__rruleValues = { recurrence_rule: rule, valid_until: true };
  globalThis.__advancedSection = advancedStub;
  globalThis.__closeModal = () => {};
  globalThis.__apiStub = {
    get: async () => ({ data: { google: [], caldav: [], outlook: [] } }),
    post: async (path, body) => { posts.push({ path, body }); return answer; },
  };
  setPermissions({ admin: false, modules: { calendar: 'write', documents: 'none' }, widgets: {}, capabilities: {} });
  try {
    return await capturing((opened) => run({ opened, posts }));
  } finally {
    clearPermissions();
    for (const key of ['__renderUserMultiSelect', '__getSelectedUserIds', '__renderRRuleFields', '__rruleValues', '__advancedSection', '__closeModal', '__apiStub']) {
      delete globalThis[key];
    }
  }
}

/** Ein abgefangenes Modal aufbauen und verdrahten (onSave), wie openModal es tut. */
function mount(options) {
  const head = options.headerAction
    ? `<div class="modal-panel__header"><button type="button" class="modal-panel__action" id="${options.headerAction.id}">${options.headerAction.label}</button></div>`
    : '';
  const panel = panelFrom(head + options.content);
  options.onSave?.(panel);
  return panel;
}

/** Im Hoerblatt (ohne Erkennung: das Textfeld) einen Satz sagen und "Done" tippen. */
async function say(listening, sentence) {
  const panel = mount(listening);
  panel.querySelector('#dictation-text').value = sentence;
  panel.querySelector('[data-dictation-done]').click();
  await settle();
}

test('the title mic: one parse call as an event; Done replaces the sheet with a spoken one, filled', async () => {
  await voiceFlow(async ({ opened, posts }) => {
    calendar.openEventModal({ mode: 'create', date: TODAY, time: '10:00' });
    const sheet = mount(opened[0]);
    sheet.querySelector('#modal-title').value = 'Trening';
    sheet.querySelector('.task-sheet__mic').click();
    const listening = opened[1];
    assert.equal(listening?.title, 'quickAdd.title', 'the mic opened the listening sheet - in neutral words, not "Say a task"');
    assert.match(listening.content, /quickAdd\.textLabel/, 'the text box is named neutrally too');
    assert.match(listening.content, />Trening<\/textarea>/, 'the current title goes along');
    await say(listening, 'Trening Leo w czwartek o 17 na hali');
    assert.deepEqual(posts.map(({ path, body }) => ({ path, body })),
      [{ path: '/quick-add/parse', body: { text: 'Trening Leo w czwartek o 17 na hali', kind: 'event' } }],
      'once, as an event - nothing is saved');
    const filled = opened[2];
    assert.ok(filled, 'Done opened the filled sheet');
    assert.equal(opened.length, 3);
    assert.equal(filled.title, 'calendar.newEvent');
    assert.equal(filled.headerAction?.id, 'event-say-again');
    assert.match(filled.content, /Trening Leo w czwartek o 17 na hali/, 'the heard sentence shows');
    const panel = mount(filled);
    assert.equal(valueOf(panel, '#modal-title'), 'Trening Leo');
    assert.equal(valueOf(panel, '#modal-start-date'), '2035-01-18');
    assert.equal(valueOf(panel, '#modal-start-time'), '17:00');
    assert.equal(panel.querySelector('#event-from-draft')?.getAttribute('data-dirty-base'), '', 'counted as changed');
    assert.equal(panel.querySelector('.modal-panel__action').getAttribute('data-action'), 'dictate');
  }, { answer: AI({ location: null }) });
});

test('the title mic keeps what was chosen and the sentence does not set: when, people, place, reminder, note and More', async () => {
  await voiceFlow(async ({ opened }) => {
    calendar.openEventModal({ mode: 'create', date: TOMORROW, time: '17:00' });
    const sheet = mount(opened[0]);
    sheet.querySelector('#modal-end-time').value = '18:30';
    sheet.querySelector('[data-reveal="where"]').click();
    sheet.querySelector('#modal-location').value = 'Hala';
    sheet.querySelector('[data-reveal="reminder"]').click();
    sheet.querySelector('.js-reminder-offset').value = '1440';
    sheet.querySelector('#modal-description').value = 'Stroje';
    sheet.querySelector('#modal-countdown').checked = true;
    sheet.querySelector('#modal-visibility').value = 'assignees';
    sheet.querySelector('.task-sheet__mic').click();
    await say(opened[1], 'Trening Leo');
    const panel = mount(opened[2]);
    assert.equal(valueOf(panel, '#modal-title'), 'Trening Leo', 'the sentence is the title');
    assert.deepEqual(['#modal-start-date', '#modal-start-time', '#modal-end-date', '#modal-end-time'].map((s) => valueOf(panel, s)),
      [TOMORROW, '17:00', TOMORROW, '18:30'], 'no day, no hour said: the chosen when stays');
    assert.equal(personChecked(panel, BEN.id), true, 'Ben stays chosen');
    assert.equal(valueOf(panel, '#modal-location'), 'Hala');
    assert.equal(panel.querySelector('#modal-reminder-toggle').checked, true);
    assert.equal(valueOf(panel, '.js-reminder-offset'), '1440', 'the chosen reminder stays');
    assert.equal(valueOf(panel, '#modal-description'), 'Stroje');
    assert.equal(panel.querySelector('#modal-countdown').checked, true);
    assert.equal(valueOf(panel, '#modal-visibility'), 'assignees');
    assert.equal(panel.querySelector('.rrule-fields').getAttribute('data-rule'), 'FREQ=WEEKLY', 'the repeat stays');
  }, { answer: AI({ title: 'Trening Leo', date: null, start_time: null }), selected: [BEN.id], rule: 'FREQ=WEEKLY' });
});

test('the title mic: what the sentence DOES set wins over the sheet; a sheet without a reminder keeps none', async () => {
  await voiceFlow(async ({ opened }) => {
    calendar.openEventModal({ mode: 'create', date: TOMORROW, time: '17:00' });
    const sheet = mount(opened[0]);
    sheet.querySelector('[data-reveal="where"]').click();
    sheet.querySelector('#modal-location').value = 'Hala';
    sheet.querySelector('.task-sheet__mic').click();
    await say(opened[1], 'Basen z Anną w niedzielę od 10 do 12');
    const panel = mount(opened[2]);
    assert.deepEqual(['#modal-start-date', '#modal-start-time', '#modal-end-time'].map((s) => valueOf(panel, s)), ['2035-01-21', '10:00', '12:00']);
    assert.equal(valueOf(panel, '#modal-location'), 'Basen');
    assert.equal(personChecked(panel, ANNA.id), true);
    assert.equal(personChecked(panel, BEN.id), false);
    assert.equal(panel.querySelector('#modal-reminder-toggle').checked, false, 'no reminder said, none chosen');
  }, {
    answer: AI({ title: 'Basen', date: '2035-01-21', start_time: '10:00', end_time: '12:00', location: 'Basen', assigned_to: [ANNA.id] }),
    selected: [BEN.id],
  });
});

test('the title mic without AI: the sentence becomes the title, the rest of the sheet stays', async () => {
  await voiceFlow(async ({ opened, posts }) => {
    calendar.openEventModal({ mode: 'create', date: TOMORROW, time: '17:00' });
    const sheet = mount(opened[0]);
    sheet.querySelector('.task-sheet__mic').click();
    await say(opened[1], 'Trening Leo w czwartek o 17');
    assert.equal(posts.length, 1);
    const panel = mount(opened[2]);
    assert.equal(valueOf(panel, '#modal-title'), 'Trening Leo w czwartek o 17', 'events need the AI: only the title');
    assert.equal(valueOf(panel, '#modal-start-date'), TOMORROW);
    assert.equal(valueOf(panel, '#modal-start-time'), '17:00');
    assert.equal(opened[2].headerAction?.id, 'event-say-again');
  }, { answer: { data: { source: null, unavailable: 'disabled' } } });
});

test('"Powtórz" replaces the sheet: nothing chosen is carried, and the new sentence is the one heard', async () => {
  await voiceFlow(async ({ opened, posts }) => {
    calendar.openEventModal({ mode: 'create', date: TODAY, time: '10:00', draft: { ...DRAFT, location: 'Hala' }, spoken: true, heard: 'Trening Leo na hali' });
    const sheet = mount(opened[0]);
    assert.equal(sheet.querySelector('.modal-panel__action').getAttribute('data-action'), 'dictate');
    opened[0].headerAction.onClick();
    const listening = opened[1];
    assert.equal(listening?.title, 'quickAdd.title');
    assert.match(listening.content, />Trening Leo<\/textarea>/, 'the current title goes along');
    await say(listening, 'Basen w niedzielę o 10');
    assert.equal(posts[0].body.kind, 'event');
    const filled = opened[2];
    assert.match(filled.content, /Basen w niedzielę o 10/, 'the new sentence shows');
    assert.doesNotMatch(filled.content, /Trening Leo na hali/, 'not the old one');
    assert.equal(filled.headerAction?.id, 'event-say-again');
    const panel = mount(filled);
    assert.equal(valueOf(panel, '#modal-title'), 'Basen');
    assert.equal(valueOf(panel, '#modal-location'), '', 'the old place is not carried');
    assert.equal(personChecked(panel, BEN.id), false, 'nor the chosen people');
    assert.equal(valueOf(panel, '#modal-start-date'), '2035-01-21');
  }, { answer: AI({ title: 'Basen', date: '2035-01-21', start_time: '10:00' }), selected: [BEN.id] });
});

test('"Powtórz" with neither a day nor an hour said keeps the sheet\'s own when', async () => {
  await voiceFlow(async ({ opened }) => {
    calendar.openEventModal({ mode: 'create', date: TODAY, time: '10:00', draft: { ...DRAFT, date: TOMORROW, start_time: '17:00', end_time: '19:00' }, spoken: true, heard: 'x' });
    mount(opened[0]);
    opened[0].headerAction.onClick();
    await say(opened[1], 'Trening Leo');
    const panel = mount(opened[2]);
    assert.deepEqual(['#modal-start-date', '#modal-start-time', '#modal-end-date', '#modal-end-time'].map((s) => valueOf(panel, s)),
      [TOMORROW, '17:00', TOMORROW, '19:00']);
  }, { answer: AI({ title: 'Trening Leo', date: null, start_time: null }) });
});

test('closing the listening sheet brings the sheet back as it was: nothing new opens', async () => {
  await voiceFlow(async ({ opened, posts }) => {
    calendar.openEventModal({ mode: 'create', date: TODAY, time: '10:00' });
    const sheet = mount(opened[0]);
    sheet.querySelector('.task-sheet__mic').click();
    mount(opened[1]);
    opened[1].onClose();
    await settle();
    assert.equal(opened.length, 2);
    assert.equal(posts.length, 0);
  });
});

test('Type instead brings the sheet back with what was said as its title', async () => {
  await voiceFlow(async ({ opened }) => {
    calendar.openEventModal({ mode: 'create', date: TODAY, time: '10:00' });
    const sheet = mount(opened[0]);
    sheet.querySelector('#modal-title').value = 'Tren';
    sheet.querySelector('.task-sheet__mic').click();
    const listening = mount(opened[1]);
    listening.querySelector('#dictation-text').value = 'Trening Leo';
    listening.querySelector('[data-dictation-type]').click();
    await settle();
    assert.equal(opened.length, 2, 'no new sheet - the parked one comes back');
    assert.equal(valueOf(sheet, '#modal-title'), 'Trening Leo');
    assert.equal(active, sheet.querySelector('#modal-title'), 'ready to type');
  });
});

test('a sheet opened from outside hands its close over to the sheet that replaces it (the calendar styles stay)', async () => {
  await voiceFlow(async ({ opened }) => {
    let released = 0;
    calendar.openEventModal({ mode: 'create', date: TODAY, time: '10:00', onClose: () => { released += 1; } });
    const sheet = mount(opened[0]);
    sheet.querySelector('.task-sheet__mic').click();
    await say(opened[1], 'Trening Leo w czwartek o 17');
    // openModal schliesst das alte Blatt, wenn das neue aufgeht.
    opened[0].onClose();
    assert.equal(released, 0, 'the replaced sheet does not release what the new one still needs');
    opened[2].onClose();
    assert.equal(released, 1, 'the new sheet releases it when it closes');
  });
});
