/**
 * Modul: Das Blatt "Neue Aufgabe" (Quick-Add, 2026-10-29, Task 7)
 * Zweck: Der erste Blick zeigt nur Titel (mit Mikrofon), Wer, die drei kleinen
 *        Knoepfe Faelligkeit / Erinnerung / Notiz, "Mehr" und "Aufgabe
 *        hinzufuegen". Alles andere kommt erst, wenn jemand danach fragt -
 *        und beim Bearbeiten steht jeder gesetzte Wert offen da.
 *        Geprueft wird das echte Markup von renderModalContent(), die
 *        Verdrahtung an einer Attrappe und das Speichern ueber __apiStub:
 *          - Anlegen: keine Etiketten, Punkte, Sperre, Markdown, Sync-Ziel und
 *            kein Vorlauf-Auswahlfeld mehr; die Abschnitte sind zu;
 *          - Bearbeiten und Entwurf: gesetzte Abschnitte sind offen, die
 *            Erinnerung steht als feste Uhrzeit der Haushaltszone da;
 *          - Speichern: eine Erinnerung braucht keine Faelligkeit, eine
 *            unberuehrte schickt nichts, eine entfernte wird geloescht.
 * Zone: Geraet Asia/Yekaterinburg, Haushalt Europe/Warsaw - ein Rechenfehler
 *       in der Geraetezone liegt so nicht zufaellig richtig.
 * Ausfuehren: npm run test:task-sheet
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
const { renderUserMultiSelect } = await import('../public/components/user-multi-select.js');
const { setHouseholdSize } = await import('../public/utils/household.js');
const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const { __test: tasks } = await import('../public/pages/tasks.js');

setDisplayTimeZone('Europe/Warsaw');
setHouseholdSize(2);

const WOJTEK = { id: 1, display_name: 'Wojtek', avatar_color: '#2F6FDB' };
const MARIOLA = { id: 2, display_name: 'Mariola', avatar_color: '#D9467A' };

/** Die echte Personenauswahl statt des leeren Loader-Stubs - die Chips sind Teil des ersten Blicks. */
function withChips(run) {
  globalThis.__renderUserMultiSelect = renderUserMultiSelect;
  try { return run(); } finally { delete globalThis.__renderUserMultiSelect; }
}

/** Der Aufklapper "Mehr" mit erkennbarem Markup (der Loader stubt ihn sonst weg). */
function withMore(run) {
  globalThis.__advancedSection = (inner, { label = '' } = {}) => (
    `<details class="form-advanced"><summary>${label}</summary>${inner}</details>`);
  globalThis.__renderRRuleFields = (prefix) => `<select id="${prefix}-rrule-freq"></select>`;
  try { return run(); } finally {
    delete globalThis.__advancedSection;
    delete globalThis.__renderRRuleFields;
  }
}

const sheet = (opts) => withChips(() => withMore(() => tasks.renderModalContent({ users: [WOJTEK, MARIOLA], ...opts })));

/** Der oeffnende Tag des Abschnitts `name`. */
function sectionTag(html, name) {
  const m = html.match(new RegExp(`<[a-z]+\\b[^>]*data-section="${name}"[^>]*>`));
  assert.ok(m, `der Abschnitt "${name}" steht im Markup`);
  return m[0];
}
const isHidden = (tag) => /\shidden(\s|>|=)/.test(tag);
const tagOf = (html, id) => html.match(new RegExp(`<[a-z-]+\\b[^>]*id="${id}"[^>]*>`))?.[0] ?? '';
const valueOf = (html, id) => tagOf(html, id).match(/\svalue="([^"]*)"/)?.[1] ?? null;

/** Rechte fuer die Dauer des Aufrufs - bei einem Promise bis zu dessen Ende, nicht bis zum ersten await. */
function withAccess(modules, run) {
  setPermissions({ admin: false, modules, widgets: {}, capabilities: {} });
  let result;
  try {
    result = run();
  } catch (err) {
    clearPermissions();
    throw err;
  }
  if (typeof result?.then === 'function') return result.finally(() => clearPermissions());
  clearPermissions();
  return result;
}

// --------------------------------------------------------------------------
// Erster Blick
// --------------------------------------------------------------------------

test('create: title with the mic, who, the three reveal buttons and More', () => {
  const html = sheet({ task: null });
  assert.match(html, /id="task-title"/);
  const mic = html.match(/<button\b[^>]*data-action="dictate"[^>]*>/)?.[0] ?? '';
  assert.match(mic, /aria-label="tasks\.sayIt"/, 'the mic is named');
  const field = html.slice(html.lastIndexOf('<div class="form-field', html.indexOf('id="task-title"')), html.indexOf('form-field__error'));
  assert.ok(field.includes('data-action="dictate"'), 'the mic sits inside the title field');
  assert.match(html, /data-ms-input="task_assigned"/, 'the who chips');
  assert.match(html, /tasks\.whoLabel/, 'labelled "Who"');
  for (const name of ['due', 'reminder', 'note']) {
    assert.match(html, new RegExp(`data-reveal="${name}"`), `the ${name} button`);
  }
  assert.match(html, /class="form-advanced"/, 'More');
  assert.match(html, /tasks\.more/, 'labelled "More"');
  assert.match(html, /id="task-submit-btn"[^>]*>\s*tasks\.addTask\s*</, 'Add task');
});

test('create: due, reminder and note are folded away until asked for', () => {
  const html = sheet({ task: null });
  for (const name of ['due', 'reminder', 'note']) {
    assert.equal(isHidden(sectionTag(html, name)), true, `${name} starts hidden`);
    assert.match(html, new RegExp(`data-remove="${name}"`), `${name} can be folded away again`);
  }
  for (const name of ['due', 'reminder', 'note']) {
    const button = html.match(new RegExp(`<button\\b[^>]*data-reveal="${name}"[^>]*>`))[0];
    assert.equal(isHidden(button), false, `the ${name} button shows`);
    assert.match(button, /type="button"/, 'a reveal button never submits');
  }
});

test('create: nothing of the old form - no Markdown, points, lock, tags, sync target or lead-time picker', () => {
  const html = sheet({ task: null });
  for (const needle of ['Markdown', 'markdown', 'md-toolbar', 'task-points', 'task-locked', 'task-tag',
    'task-sync-target', 'reminder-offset', 'reminder-toggle', 'descriptionMarkdownHint', 'syncTarget']) {
    assert.ok(!html.includes(needle), `the sheet still contains "${needle}"`);
  }
});

test('create: the mic and every reveal control are plain buttons - none submits the form', () => {
  const html = sheet({ task: null });
  const controls = [...html.matchAll(/<button\b[^>]*data-(?:action="dictate"|reveal|remove|due-pick|reveal-time|remind-pick)[^>]*>/g)].map((m) => m[0]);
  assert.ok(controls.length >= 10, `found ${controls.length} controls`);
  for (const tag of controls) assert.match(tag, /type="button"/, tag);
});

test('create: More holds priority, category, repeat, visibility, start date, status, documents and countdown - in that order', () => {
  const html = sheet({ task: null });
  const start = html.indexOf('<details class="form-advanced"');
  const end = html.indexOf('</details>', start);
  const order = ['id="task-priority"', 'id="task-category"', 'id="task-rrule-freq"', 'id="task-visibility"',
    'id="task-start-date"', 'id="task-status"', 'data-doc-attach', 'id="task-countdown"']
    .map((needle) => [needle, html.indexOf(needle)]);
  for (const [needle, at] of order) assert.ok(at > start && at < end, `${needle} sits inside More`);
  const positions = order.map(([, at]) => at);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.ok(html.indexOf('id="task-title"') < start, 'the title stays outside');
  assert.ok(html.indexOf('data-ms-input="task_assigned"') < start, 'who stays outside');
});

test('create: due picks Today/Tomorrow/This weekend/Pick a date drive #task-due-date, "+ Time" reveals #task-due-time', () => {
  const html = sheet({ task: null });
  for (const key of ['today', 'tomorrow', 'weekend', 'pick']) assert.match(html, new RegExp(`data-due-pick="${key}"`));
  assert.match(html, /<yuvomi-datepicker\b[^>]*id="task-due-date"/);
  assert.match(html, /data-reveal-time/);
  assert.match(html, /<yuvomi-datepicker\b[^>]*type="time"[^>]*id="task-due-time"/);
  assert.match(html, /<yuvomi-datepicker\b[^>]*id="task-remind-date"/);
  assert.match(html, /<yuvomi-datepicker\b[^>]*type="time"[^>]*id="task-remind-time"/);
  assert.match(html, /<textarea\b[^>]*id="task-description"/);
  assert.match(tagOf(html, 'task-description'), /placeholder="tasks\.notePlaceholder"/);
});

test('who: only the household members passed in become chips', () => {
  const html = sheet({ task: null });
  const ids = [...html.matchAll(/class="user-ms__checkbox" value="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(ids, [WOJTEK.id, MARIOLA.id]);
  assert.doesNotMatch(html, /user-ms__checkbox" value="(\d+)" checked/, 'nobody is chosen by default');
});

// --------------------------------------------------------------------------
// Bearbeiten und Entwurf: was gesetzt ist, steht offen da
// --------------------------------------------------------------------------

const FULL_TASK = {
  id: 7, title: 'Ubezpieczyć samochód', status: 'open', priority: 'high', category: 'household',
  visibility: 'all', due_date: '2026-10-30', due_time: '08:00', description: 'Polisa OC',
  assigned_users: [WOJTEK], assigned_to: WOJTEK.id, recurrence_rule: null,
};

test('edit: a set due date and reminder are open, the reminder shows its fixed wall time', () => {
  const html = sheet({ task: FULL_TASK, reminder: { id: 3, remind_at: '2026-10-30T06:30:00' } });
  assert.equal(isHidden(sectionTag(html, 'due')), false, 'due is open');
  assert.equal(isHidden(sectionTag(html, 'reminder')), false, 'reminder is open');
  assert.equal(isHidden(sectionTag(html, 'note')), false, 'note is open');
  assert.equal(valueOf(html, 'task-due-date'), '2026-10-30');
  assert.equal(valueOf(html, 'task-due-time'), '08:00');
  assert.equal(valueOf(html, 'task-remind-date'), '2026-10-30');
  assert.equal(valueOf(html, 'task-remind-time'), '07:30', '06:30 UTC is 07:30 in Warsaw on 30 Oct');
  assert.match(html, />Polisa OC<\/textarea>/);
  const reveal = (name) => html.match(new RegExp(`<button\\b[^>]*data-reveal="${name}"[^>]*>`))[0];
  for (const name of ['due', 'reminder', 'note']) assert.equal(isHidden(reveal(name)), true, `no ${name} button while open`);
});

test('edit: a reminder made with the old lead-time picker shows as its date and time', () => {
  // 1 Tag vor einer Faelligkeit ohne Uhrzeit: 23:59:59 Warschau am Vortag.
  const html = sheet({ task: { ...FULL_TASK, due_time: null }, reminder: { id: 3, remind_at: '2026-10-29T22:59:59' } });
  assert.equal(valueOf(html, 'task-remind-date'), '2026-10-29');
  assert.equal(valueOf(html, 'task-remind-time'), '23:59');
});

/** Die Optionen, mit denen das Blatt "Mehr" baut (label, open). */
function moreOptions(opts) {
  const seen = [];
  globalThis.__renderUserMultiSelect = renderUserMultiSelect;
  globalThis.__advancedSection = (inner, options = {}) => { seen.push(options); return `<details class="form-advanced">${inner}</details>`; };
  try {
    tasks.renderModalContent({ users: [WOJTEK, MARIOLA], ...opts });
  } finally {
    delete globalThis.__renderUserMultiSelect;
    delete globalThis.__advancedSection;
  }
  assert.equal(seen.length, 1, 'More is built once');
  return seen[0];
}

// Ruling R8 (Spec: "Set values are shown open, as the form does today").
test('edit: More opens when it holds a set value, and its line names them', () => {
  const { label, open } = moreOptions({
    task: { ...FULL_TASK, status: 'in_progress', start_date: '2026-10-20', countdown: 1, recurrence_rule: 'FREQ=WEEKLY' },
  });
  assert.equal(open, true, 'something is set behind More - it shows open');
  assert.ok(label.startsWith('tasks.more · '), label);
  for (const needle of ['2026-10-20', 'tasks.countdownDetail', 'tasks.priority']) {
    assert.ok(label.includes(needle), `the summary names ${needle}: ${label}`);
  }
});

test('edit: each kind of set value opens More on its own', () => {
  const plain = { ...FULL_TASK, priority: 'none', category: 'misc', visibility: 'all', status: 'open',
    start_date: null, countdown: 0, recurrence_rule: null, documents: [] };
  for (const [name, over] of [
    ['priority', { priority: 'high' }], ['category', { category: 'household' }], ['repeat', { recurrence_rule: 'FREQ=WEEKLY' }],
    ['visibility', { visibility: 'private' }], ['start date', { start_date: '2026-10-20' }], ['status', { status: 'in_progress' }],
    ['documents', { documents: [{ id: 5, name: 'Polisa.pdf', mime_type: 'application/pdf' }] }], ['countdown', { countdown: 1 }],
  ]) {
    assert.equal(moreOptions({ task: { ...plain, ...over } }).open, true, `${name} set: More opens`);
  }
});

test('edit with nothing set behind More, and every create: More stays closed as plain "More"', () => {
  const nothing = moreOptions({ task: { ...FULL_TASK, priority: 'none', category: 'misc', status: 'open' } });
  assert.equal(nothing.open, false);
  assert.equal(nothing.label, 'tasks.more');
  for (const draft of [null, { title: 'Wyrzuć śmieci' }]) {
    const create = moreOptions({ task: null, draft });
    assert.equal(create.open, false, 'a new task opens with More closed');
    assert.equal(create.label, 'tasks.more');
  }
});

test('draft: a spoken sentence opens the sheet with title, due and reminder filled', () => {
  const html = sheet({
    task: null,
    draft: { title: 'Weź Marysi spodenki do przedszkola', due_date: '2026-10-30', remind_date: '2026-10-30', remind_time: '07:30', assigned_to: [MARIOLA.id] },
  });
  assert.equal(valueOf(html, 'task-title'), 'Weź Marysi spodenki do przedszkola');
  assert.equal(isHidden(sectionTag(html, 'due')), false);
  assert.equal(isHidden(sectionTag(html, 'reminder')), false);
  assert.equal(isHidden(sectionTag(html, 'note')), true, 'no note in the draft');
  assert.equal(valueOf(html, 'task-due-date'), '2026-10-30');
  assert.equal(valueOf(html, 'task-remind-time'), '07:30');
  assert.match(html, /class="user-ms__checkbox" value="2"\s+checked/, 'the spoken assignee is chosen');
});

// F3: ein Erinnerungstag ohne Stunde (ein Entwurf vom Server oder ein alter
// Client) faellt nicht weg - er erinnert um 09:00, wie R9 es sagt.
test('draft: a reminder day without a time opens the reminder at 09:00', () => {
  for (const remind_time of [null, '', undefined]) {
    const html = sheet({ task: null, draft: { title: 'Zapłać rachunek', remind_date: '2026-10-30', remind_time } });
    assert.equal(isHidden(sectionTag(html, 'reminder')), false, `remind_time ${remind_time}: the reminder is set`);
    assert.equal(valueOf(html, 'task-remind-date'), '2026-10-30');
    assert.equal(valueOf(html, 'task-remind-time'), '09:00');
  }
  const none = sheet({ task: null, draft: { title: 'Zapłać rachunek', remind_time: '07:30' } });
  assert.equal(isHidden(sectionTag(none, 'reminder')), true, 'a time without its day is still nothing');
});

test('draft: ignored when editing - a task keeps its own values', () => {
  const html = sheet({ task: FULL_TASK, draft: { title: 'Inny tytuł', due_date: '2026-12-24' } });
  assert.equal(valueOf(html, 'task-title'), FULL_TASK.title);
  assert.equal(valueOf(html, 'task-due-date'), '2026-10-30');
});

test('reminder quick picks follow the due date: none without one, three with a time', () => {
  const none = sheet({ task: null });
  assert.doesNotMatch(none, /data-remind-pick=/, 'without a due date there is nothing to count back from');
  const withDue = sheet({ task: { ...FULL_TASK, description: '' } });
  for (const key of ['at_due', 'hour_before', 'day_before']) assert.match(withDue, new RegExp(`data-remind-pick="${key}"`));
});

test('edit: a due time without a due date is shown, not hidden', () => {
  const html = sheet({ task: { ...FULL_TASK, due_date: null, due_time: '08:00', description: '' } });
  assert.equal(isHidden(sectionTag(html, 'due')), false, 'the server accepts a time alone - the sheet shows it');
  assert.equal(valueOf(html, 'task-due-time'), '08:00');
  assert.doesNotMatch(tagOf(html, 'task-due-time').length ? html.match(/<div\b[^>]*data-due-time-row[^>]*>/)[0] : '', /\shidden/);
  assert.equal(isHidden(html.match(/<button\b[^>]*data-reveal="due"[^>]*>/)[0]), true);
});

test('edit: a stored reminder whose time cannot be read is left alone', () => {
  const html = sheet({ task: FULL_TASK, reminder: { id: 3, remind_at: 'kaputt' } });
  assert.equal(isHidden(sectionTag(html, 'reminder')), true);
  assert.doesNotMatch(html, /data-stored-at/, 'no stored marker - an untouched save sends no DELETE');
});

// --------------------------------------------------------------------------
// Nach einem Diktat: gesetzte Werte als kompakte Zeilen mit x (Ruling R6,
// Entwurf TaskSpoken)
// --------------------------------------------------------------------------

const TOMORROW = (() => {
  const [y, m, d] = todayKey().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
})();
const SPOKEN_DRAFT = {
  title: 'Weź Marysi spodenki do przedszkola', due_date: TOMORROW, remind_date: TOMORROW, remind_time: '07:30',
};
const rowOf = (html, name) => html.match(new RegExp(`<div class="task-sheet__row" data-row="${name}">[\\s\\S]*?</button>\\s*</div>`))?.[0] ?? '';

test('spoken: due and reminder stand as compact rows with an x, their pickers folded away', () => {
  const html = sheet({ task: null, draft: SPOKEN_DRAFT, spoken: true });
  for (const [name, label, value, remove] of [
    ['due', 'tasks.dueShort', 'common.tomorrow', 'tasks.removeDue'],
    ['reminder', 'reminders.sectionTitle', 'common.tomorrow, 07:30', 'reminders.removeReminder'],
  ]) {
    assert.equal(isHidden(sectionTag(html, name)), false, `${name} is set`);
    const row = rowOf(html, name);
    assert.ok(row, `${name} has a row`);
    assert.match(row, new RegExp(`<button type="button" class="task-sheet__row-main" data-expand="${name}"`), 'the row opens its fields');
    assert.match(row, new RegExp(`task-sheet__row-label">${label.replace('.', '\\.')}<`));
    assert.match(row, new RegExp(`task-sheet__row-value">${value}<`));
    assert.match(row, new RegExp(`<button type="button" class="task-sheet__row-remove" data-remove="${name}" aria-label="${remove.replace('.', '\\.')}"`));
    assert.match(html, new RegExp(`<div class="task-sheet__body" id="task-${name}-body" hidden>`), `${name}: no expanded pickers`);
  }
  assert.equal(isHidden(sectionTag(html, 'note')), true, 'no note in the sentence, no note row');
  assert.doesNotMatch(html, /data-row="note"/);
  // Dieselben Felder wie sonst - das Speichern liest sie unveraendert.
  assert.equal(valueOf(html, 'task-due-date'), TOMORROW);
  assert.equal(valueOf(html, 'task-remind-time'), '07:30');
});

test('spoken: only a dictated draft gets rows - typed drafts and edits keep the open fields', () => {
  for (const opts of [{ task: null, draft: SPOKEN_DRAFT }, { task: FULL_TASK, spoken: true, reminder: { id: 3, remind_at: '2026-10-30T06:30:00' } }]) {
    const html = sheet(opts);
    assert.doesNotMatch(html, /data-row=|data-expand=/);
    assert.doesNotMatch(html, /class="task-sheet__body"[^>]*hidden/);
  }
});

test('spoken: a due time alone still reads as a row', () => {
  const html = sheet({ task: null, draft: { title: 'Zadzwonić', due_time: '18:00' }, spoken: true });
  assert.match(rowOf(html, 'due'), /task-sheet__row-value">18:00</);
});

// --------------------------------------------------------------------------
// Rechte am Kalender: die Erinnerung gehoert dem Kalender
// --------------------------------------------------------------------------

test('calendar: read shows an existing reminder read-only and offers no reminder button', () => {
  withAccess({ tasks: 'write', calendar: 'read' }, () => {
    const html = sheet({ task: FULL_TASK, reminder: { id: 3, remind_at: '2026-10-30T06:30:00' } });
    const section = sectionTag(html, 'reminder');
    assert.equal(isHidden(section), false);
    assert.doesNotMatch(html, /data-locked-due/, 'no due-date guard any more (Ruling R7)');
    assert.match(tagOf(html, 'task-remind-date'), /\sdisabled/);
    assert.match(tagOf(html, 'task-remind-time'), /\sdisabled/);
    assert.doesNotMatch(html, /data-remove="reminder"/, 'a locked reminder cannot be removed');
    assert.doesNotMatch(html, /data-reveal="reminder"/);
    assert.match(html, /reminders\.readOnlyNotice/);
    const none = sheet({ task: FULL_TASK, reminder: null });
    assert.doesNotMatch(none, /data-section="reminder"|data-reveal="reminder"/, 'nothing stored, nothing to show');
  });
});

test('calendar: none shows no reminder at all', () => {
  withAccess({ tasks: 'write', calendar: 'none' }, () => {
    for (const reminder of [null, { id: 3, remind_at: '2026-10-30T06:30:00' }]) {
      const html = sheet({ task: FULL_TASK, reminder });
      assert.doesNotMatch(html, /data-section="reminder"|data-reveal="reminder"|task-remind-/);
    }
  });
});

// --------------------------------------------------------------------------
// Verdrahtung an einer Attrappe
// --------------------------------------------------------------------------

/** Ein Element, wie die Verdrahtung es braucht: Wert, hidden, Attribute, Ereignisse. */
function fakeEl(props = {}) {
  const attrs = new Map(Object.entries(props.attrs ?? {}));
  const el = {
    value: '', hidden: false, dataset: {}, events: [], listeners: {},
    ...props,
    setAttribute(name, value) { attrs.set(name, String(value)); if (name === 'hidden') el.hidden = true; },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    removeAttribute(name) { attrs.delete(name); if (name === 'hidden') el.hidden = false; },
    hasAttribute(name) { return attrs.has(name); },
    toggleAttribute(name, force) { if (force) attrs.set(name, ''); else attrs.delete(name); if (name === 'hidden') el.hidden = !!force; },
    addEventListener(type, fn) { (el.listeners[type] ??= []).push(fn); },
    dispatchEvent(event) { el.events.push(event.type); for (const fn of el.listeners[event.type] ?? []) fn(event); return true; },
    closest: (sel) => (props.closest ? props.closest(sel) : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() { el.focused = true; },
    contains: () => true,
  };
  return el;
}

function fakePanel(nodes) {
  return {
    querySelector: (sel) => nodes[sel] ?? null,
    querySelectorAll: (sel) => (Array.isArray(nodes[`all:${sel}`]) ? nodes[`all:${sel}`] : []),
  };
}

const click = (form, target) => {
  const event = { type: 'click', target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  for (const fn of form.listeners.click ?? []) fn(event);
  return event;
};

test('wiring: Remove on the due section clears date and time and folds it away', () => {
  const form = fakeEl();
  const section = fakeEl({ dataset: { section: 'due' } });
  const reveal = fakeEl({ hidden: true, dataset: { reveal: 'due' } });
  const date = fakeEl({ value: '2026-10-30' });
  const time = fakeEl({ value: '08:00' });
  const panel = fakePanel({
    '#task-form': form, '[data-section="due"]': section, '[data-reveal="due"]': reveal,
    '#task-due-date': date, '#task-due-time': time,
  });
  tasks.wireTaskSheet(panel);
  const removeBtn = fakeEl({ dataset: { remove: 'due' } });
  removeBtn.closest = (sel) => (sel.includes('[data-remove]') ? removeBtn : null);
  click(form, removeBtn);
  assert.equal(date.value, '', 'the due date is cleared');
  assert.equal(time.value, '', 'the time is cleared');
  assert.equal(section.hidden, true, 'the section folds away');
  assert.equal(reveal.hidden, false, 'its button comes back');
  assert.ok(date.events.includes('change'), 'the countdown gate and reminder picks hear about it');
});

test('wiring: a reveal button opens its section and hides itself', () => {
  const form = fakeEl();
  const section = fakeEl({ hidden: true, dataset: { section: 'note' } });
  const note = fakeEl();
  const panel = fakePanel({ '#task-form': form, '[data-section="note"]': section, '#task-description': note });
  tasks.wireTaskSheet(panel);
  const reveal = fakeEl({ dataset: { reveal: 'note' } });
  reveal.closest = (sel) => (sel.includes('[data-reveal]') ? reveal : null);
  click(form, reveal);
  assert.equal(section.hidden, false);
  assert.equal(reveal.hidden, true);
  assert.equal(note.focused, true, 'the note field takes the focus');
});

test('wiring: opening an empty reminder fills a default time', () => {
  const form = fakeEl();
  const section = fakeEl({ hidden: true, dataset: { section: 'reminder' } });
  const date = fakeEl();
  const time = fakeEl();
  const panel = fakePanel({
    '#task-form': form, '[data-section="reminder"]': section,
    '#task-remind-date': date, '#task-remind-time': time,
    // Morgen: die Vorgabe liegt nie zurueck (F1), ein festes Datum glitte mit der Zeit in die Vergangenheit.
    '#task-due-date': fakeEl({ value: TOMORROW }), '#task-due-time': fakeEl({ value: '18:00' }),
  });
  tasks.wireTaskSheet(panel);
  const reveal = fakeEl({ dataset: { reveal: 'reminder' } });
  reveal.closest = (sel) => (sel.includes('[data-reveal]') ? reveal : null);
  click(form, reveal);
  assert.equal(section.hidden, false);
  assert.equal(date.value, TOMORROW, 'with a due date: at its time');
  assert.equal(time.value, '18:00');
});

test('wiring: a due quick pick writes the date', () => {
  const form = fakeEl();
  const date = fakeEl();
  const panel = fakePanel({ '#task-form': form, '#task-due-date': date, '[data-section="due"]': fakeEl() });
  tasks.wireTaskSheet(panel);
  const pick = fakeEl({ dataset: { duePick: 'today' } });
  pick.closest = (sel) => (sel.includes('[data-due-pick]') ? pick : null);
  click(form, pick);
  assert.match(date.value, /^\d{4}-\d{2}-\d{2}$/, 'today in the household zone');
  assert.ok(date.events.includes('change'));
});

test('wiring: the x on a spoken row clears the reminder and folds it away, like Remove', () => {
  const form = fakeEl();
  const section = fakeEl({ dataset: { section: 'reminder' } });
  const reveal = fakeEl({ hidden: true, dataset: { reveal: 'reminder' } });
  const date = fakeEl({ value: '2026-11-01' });
  const time = fakeEl({ value: '07:30' });
  const panel = fakePanel({
    '#task-form': form, '[data-section="reminder"]': section, '[data-reveal="reminder"]': reveal,
    '#task-remind-date': date, '#task-remind-time': time,
  });
  tasks.wireTaskSheet(panel);
  const x = fakeEl({ dataset: { remove: 'reminder' } });
  x.closest = (sel) => (sel.includes('[data-remove]') ? x : null);
  click(form, x);
  assert.equal(section.hidden, true);
  assert.equal(date.value, '');
  assert.equal(time.value, '');
  assert.equal(reveal.hidden, false, 'the Reminder button is back');
});

test('wiring: tapping a spoken row expands its fields; reopening after x shows the fields too', () => {
  const form = fakeEl();
  const row = fakeEl();
  const body = fakeEl({ hidden: true });
  const firstPick = fakeEl();
  // Das x der Zeile steht im DOM VOR den Feldern - der Fokus darf nicht dort
  // landen (verborgen), sondern auf dem ersten Vorschlag in den Feldern.
  const rowX = fakeEl({ dataset: { remove: 'due' } });
  body.querySelector = (sel) => (sel.includes('[data-due-pick]') ? firstPick : null);
  const section = fakeEl({ dataset: { section: 'due' } });
  section.querySelector = (sel) => ({ '[data-row]': row, '.task-sheet__body': body }[sel]
    ?? (sel.includes('[data-remove]') || sel.includes('[data-due-pick]') ? rowX : null));
  const panel = fakePanel({ '#task-form': form, '[data-section="due"]': section, '#task-due-date': fakeEl({ value: TOMORROW }) });
  tasks.wireTaskSheet(panel);
  const main = fakeEl({ dataset: { expand: 'due' } });
  main.closest = (sel) => (sel.includes('[data-expand]') ? main : null);
  click(form, main);
  assert.equal(row.hidden, true, 'the row gives way');
  assert.equal(body.hidden, false, 'to the full section');
  assert.equal(firstPick.focused, true, 'the focus goes into it');

  // x, then the Due date button again: the section comes back with its fields, not the old row.
  row.hidden = false;
  body.hidden = true;
  section.hidden = true;
  const reveal = fakeEl({ dataset: { reveal: 'due' } });
  reveal.closest = (sel) => (sel.includes('[data-reveal]') ? reveal : null);
  click(form, reveal);
  assert.equal(section.hidden, false);
  assert.equal(row.hidden, true);
  assert.equal(body.hidden, false);
});

test('wiring: a reminder quick pick keeps its buttons (and the focus) - only aria-pressed moves', () => {
  const form = fakeEl();
  const buttons = ['at_due', 'hour_before', 'day_before'].map((key) => fakeEl({ dataset: { remindPick: key } }));
  const host = fakeEl();
  host.querySelectorAll = () => buttons;
  let redrawn = 0;
  host.replaceChildren = () => { redrawn += 1; };
  host.insertAdjacentHTML = () => {};
  const date = fakeEl();
  const time = fakeEl();
  const panel = fakePanel({
    '#task-form': form, '[data-remind-picks]': host,
    '#task-due-date': fakeEl({ value: '2026-11-02' }), '#task-due-time': fakeEl({ value: '18:00' }),
    '#task-remind-date': date, '#task-remind-time': time,
  });
  tasks.wireTaskSheet(panel);
  const pick = buttons[1];
  pick.closest = (sel) => (sel.includes('[data-remind-pick]') ? pick : null);
  click(form, pick);
  assert.equal(date.value, '2026-11-02');
  assert.equal(time.value, '17:00');
  assert.equal(redrawn, 0, 'no redraw - the tapped button stays in the DOM');
  assert.deepEqual(buttons.map((b) => b.getAttribute('aria-pressed')), ['false', 'true', 'false']);
});

// --------------------------------------------------------------------------
// Speichern
// --------------------------------------------------------------------------

const feld = (value = '') => ({ value: String(value) });

/** Die Uhr der Speicher-Tests: Donnerstag, 29.10.2026, 13:00 in Warschau - vor allen Erinnerungen unten. */
const SUBMIT_NOW = new Date('2026-10-29T12:00:00Z');

async function submit({ taskId = '', byId = {}, fields = {}, defaultSyncTarget = '', now = SUBMIT_NOW } = {}) {
  const calls = [];
  const record = (method) => async (path, body) => {
    calls.push({ method, path, body });
    if (method === 'post' && path === '/tasks') return { data: { id: 41 } };
    return { data: { id: Number(taskId) || 41 } };
  };
  globalThis.__apiStub = {
    get: record('get'), post: record('post'), put: record('put'), patch: record('patch'), delete: record('delete'),
    getWithSource: async () => ({ data: { data: [] }, fromCache: false }),
  };
  globalThis.__rruleValues = { is_recurring: 0, recurrence_rule: null, recurrence_from_completion: 0, valid_until: true };
  const nodes = {
    'task-form-error': { hidden: true, textContent: '' },
    'task-submit-btn': { disabled: false, textContent: '', classList: { add() {}, remove() {} } },
    'task-id': feld(taskId),
  };
  const realDocument = globalThis.document;
  globalThis.document = { getElementById: (id) => nodes[id] ?? null, documentElement: realDocument.documentElement, addEventListener() {} };
  const form = { querySelector: (sel) => byId[sel] ?? null };
  const named = {
    title: 'Weź Marysi spodenki do przedszkola', description: '', priority: 'none', category: 'household',
    start_date: '', due_date: '', due_time: '', ...fields,
  };
  for (const [name, value] of Object.entries(named)) form[name] = feld(value);
  const previousTarget = tasks.state.defaultSyncTarget;
  tasks.state.defaultSyncTarget = defaultSyncTarget;
  const realNow = Date.now;
  Date.now = () => now.getTime();
  try {
    await tasks.handleFormSubmit({ preventDefault() {}, target: form }, { container: null, onChanged: async () => {} });
  } finally {
    Date.now = realNow;
    tasks.state.defaultSyncTarget = previousTarget;
    delete globalThis.__apiStub;
    delete globalThis.__rruleValues;
    globalThis.document = realDocument;
  }
  return { calls, error: nodes['task-form-error'].hidden ? null : nodes['task-form-error'].textContent };
}

const reminderCalls = (calls) => calls.filter((c) => String(c.path).startsWith('/reminders'));
const reminderNodes = ({ hidden = false, storedAt = '', date = '', time = '' } = {}) => ({
  '[data-section="reminder"]': { hidden, dataset: storedAt ? { storedAt } : {} },
  '#task-remind-date': feld(date),
  '#task-remind-time': feld(time),
});

test('submit create: a reminder without a due date is saved as a fixed time', async () => {
  const { calls, error } = await submit({ byId: reminderNodes({ date: '2026-10-30', time: '07:30' }) });
  assert.equal(error, null);
  const post = calls.find((c) => c.method === 'post' && c.path === '/tasks');
  assert.ok(post, 'the task goes out');
  for (const key of ['tags', 'points', 'locked']) assert.ok(!(key in post.body), `no ${key} in the payload`);
  assert.equal(post.body.due_date, null);
  const reminders = reminderCalls(calls);
  assert.deepEqual(reminders.map((c) => [c.method, c.path]), [['post', '/reminders']]);
  assert.deepEqual(reminders[0].body, { entity_type: 'task', entity_id: 41, remind_at: '2026-10-30T06:30:00' });
  assert.ok(calls.indexOf(post) < calls.indexOf(reminders[0]), 'the task first, then its reminder');
});

test('submit create: a folded-away reminder sends nothing', async () => {
  const { calls } = await submit({ byId: reminderNodes({ hidden: true, date: '2026-10-30', time: '07:30' }) });
  assert.deepEqual(reminderCalls(calls), []);
});

test('submit create: an open reminder without a time is not saved half', async () => {
  const { calls, error } = await submit({ byId: reminderNodes({ date: '2026-10-30', time: '' }) });
  assert.ok(error, 'the sheet says so');
  assert.deepEqual(calls.filter((c) => c.method !== 'get'), [], 'nothing goes out');
});

test('submit edit: an untouched reminder makes no /reminders call', async () => {
  const { calls, error } = await submit({
    taskId: '7', fields: { due_date: '2026-10-30' },
    byId: reminderNodes({ storedAt: '2026-10-30T06:30:00', date: '2026-10-30', time: '07:30' }),
  });
  assert.equal(error, null);
  assert.ok(calls.some((c) => c.method === 'put' && c.path === '/tasks/7'));
  assert.deepEqual(reminderCalls(calls), []);
});

test('submit edit: an untouched reminder from the old lead-time picker (with seconds) stays as it is', async () => {
  const { calls } = await submit({
    taskId: '7', fields: { due_date: '2026-10-30' },
    byId: reminderNodes({ storedAt: '2026-10-29T22:59:59', date: '2026-10-29', time: '23:59' }),
  });
  assert.deepEqual(reminderCalls(calls), [], 'opening and saving does not move it by a second');
});

test('submit edit: a changed reminder is written', async () => {
  const { calls } = await submit({
    taskId: '7',
    byId: reminderNodes({ storedAt: '2026-10-30T06:30:00', date: '2026-10-30', time: '08:15' }),
  });
  const reminders = reminderCalls(calls);
  assert.deepEqual(reminders.map((c) => c.method), ['post']);
  assert.equal(reminders[0].body.remind_at, '2026-10-30T07:15:00');
  assert.equal(String(reminders[0].body.entity_id), '7');
});

test('submit edit: removing the reminder section deletes the stored reminder', async () => {
  const { calls } = await submit({
    taskId: '7',
    byId: reminderNodes({ hidden: true, storedAt: '2026-10-30T06:30:00', date: '', time: '' }),
  });
  assert.deepEqual(reminderCalls(calls).map((c) => [c.method, c.path]),
    [['delete', '/reminders?entity_type=task&entity_id=7']]);
});

test('submit edit: no reminder before and none now - nothing to delete', async () => {
  const { calls } = await submit({ taskId: '7', byId: reminderNodes({ hidden: true }) });
  assert.deepEqual(reminderCalls(calls), []);
});

// Ruling R15: eine NEUE oder GEAENDERTE Erinnerung, deren Zeitpunkt schon
// vorbei ist, wird nicht gespeichert - der naechste Takt schickte sie sofort.
// Eine unberuehrte bleibt, wie sie ist (alte Aufgaben tragen vergangene).
function catchFieldErrors() {
  const reported = [];
  globalThis.__reportFieldError = (field, message) => { reported.push({ field, message }); };
  return { reported, done: () => { delete globalThis.__reportFieldError; } };
}

test('submit create: a reminder already past today is blocked at its time field - nothing goes out', async () => {
  const probe = catchFieldErrors();
  try {
    const nodes = reminderNodes({ date: '2026-10-29', time: '07:30' });
    const { calls, error } = await submit({ byId: nodes });
    assert.deepEqual(calls.filter((c) => c.method !== 'get'), [], 'no task, no reminder');
    assert.equal(error, null, 'not the form-wide error line - the reminder field says it');
    assert.equal(probe.reported.length, 1);
    assert.equal(probe.reported[0].field, nodes['#task-remind-time'], 'today, earlier: the time is what is wrong');
    assert.equal(probe.reported[0].message, 'tasks.reminderTimePassed');
  } finally { probe.done(); }
});

test('submit create: a reminder on a past day is blocked at its date field', async () => {
  const probe = catchFieldErrors();
  try {
    const nodes = reminderNodes({ date: '2026-10-28', time: '18:00' });
    const { calls } = await submit({ byId: nodes });
    assert.deepEqual(calls.filter((c) => c.method !== 'get'), []);
    assert.equal(probe.reported[0]?.field, nodes['#task-remind-date']);
  } finally { probe.done(); }
});

test('submit create: the current minute counts as past; the next one saves', async () => {
  const probe = catchFieldErrors();
  try {
    // 12:00:30 UTC = 13:00:30 in Warschau
    const now = new Date('2026-10-29T12:00:30Z');
    const blocked = await submit({ now, byId: reminderNodes({ date: '2026-10-29', time: '13:00' }) });
    assert.deepEqual(blocked.calls.filter((c) => c.method !== 'get'), []);
    const saved = await submit({ now, byId: reminderNodes({ date: '2026-10-29', time: '13:01' }) });
    assert.deepEqual(reminderCalls(saved.calls).map((c) => c.body.remind_at), ['2026-10-29T12:01:00']);
  } finally { probe.done(); }
});

test('submit: a past reminder collapsed to a spoken row opens its fields to show the error', async () => {
  const probe = catchFieldErrors();
  try {
    const row = { hidden: false };
    const body = { hidden: true };
    const nodes = reminderNodes({ date: '2026-10-29', time: '07:30' });
    nodes['[data-section="reminder"]'].querySelector = (sel) => ({ '[data-row]': row, '.task-sheet__body': body }[sel] ?? null);
    await submit({ byId: nodes });
    assert.equal(probe.reported.length, 1);
    assert.equal(row.hidden, true, 'the row gives way');
    assert.equal(body.hidden, false, 'to the fields that carry the error');
  } finally { probe.done(); }
});

test('submit edit: an untouched reminder already in the past is never blocked', async () => {
  const probe = catchFieldErrors();
  try {
    const { calls, error } = await submit({
      taskId: '7', now: new Date('2026-11-05T12:00:00Z'),
      byId: reminderNodes({ storedAt: '2026-10-30T06:30:00', date: '2026-10-30', time: '07:30' }),
    });
    assert.equal(error, null);
    assert.deepEqual(probe.reported, []);
    assert.ok(calls.some((c) => c.method === 'put' && c.path === '/tasks/7'), 'the task saves');
    assert.deepEqual(reminderCalls(calls), [], 'and its old reminder is left as it is');
  } finally { probe.done(); }
});

test('submit edit: a reminder changed to a past time is blocked', async () => {
  const probe = catchFieldErrors();
  try {
    const nodes = reminderNodes({ storedAt: '2026-10-30T06:30:00', date: '2026-10-29', time: '08:00' });
    const { calls } = await submit({ taskId: '7', byId: nodes });
    assert.deepEqual(calls.filter((c) => c.method !== 'get'), [], 'no PUT, no reminder');
    assert.equal(probe.reported[0]?.field, nodes['#task-remind-time']);
  } finally { probe.done(); }
});

test('submit edit: calendar read never touches the reminder', async () => {
  const { calls } = await withAccess({ tasks: 'write', calendar: 'read' }, () => submit({
    taskId: '7', fields: { due_date: '2026-10-30' },
    byId: reminderNodes({ storedAt: '2026-10-30T06:30:00', date: '2026-10-30', time: '09:00' }),
  }));
  assert.ok(calls.some((c) => c.method === 'put'));
  assert.deepEqual(reminderCalls(calls), []);
});

test('submit: sync target goes out only on create, and only when a default is set', async () => {
  const withDefault = await submit({ defaultSyncTarget: 'caldav:3|https://example.test/list/' });
  assert.equal(withDefault.calls.find((c) => c.path === '/tasks').body.sync_target, 'caldav:3|https://example.test/list/');
  const without = await submit({ defaultSyncTarget: '' });
  assert.ok(!('sync_target' in without.calls.find((c) => c.path === '/tasks').body));
  const edit = await submit({ taskId: '7', defaultSyncTarget: 'caldav:3|https://example.test/list/' });
  assert.ok(!('sync_target' in edit.calls.find((c) => c.path === '/tasks/7').body), 'an edit never moves a task between lists');
});

test('submit edit: the payload keeps due date, repeat, category and visibility as they are', async () => {
  globalThis.__getSelectedUserIds = () => [1];
  try {
    const { calls } = await submit({
      taskId: '7', fields: { due_date: '2026-10-30', due_time: '08:00', category: 'garden' },
      byId: { '#task-visibility': feld('assignees') },
    });
    const put = calls.find((c) => c.method === 'put').body;
    assert.equal(put.due_date, '2026-10-30');
    assert.equal(put.due_time, '08:00');
    assert.equal(put.category, 'garden');
    assert.equal(put.visibility, 'assignees');
    for (const key of ['tags', 'points', 'locked', 'sync_target']) assert.ok(!(key in put), `no ${key}`);
  } finally {
    delete globalThis.__getSelectedUserIds;
  }
});

// --------------------------------------------------------------------------
// Oeffnen: Entwurf und "Noch einmal sagen"
// --------------------------------------------------------------------------

function openWith(opts) {
  let seen = null;
  globalThis.__openModal = (options) => { seen = options; };
  const previous = tasks.state.users;
  try {
    tasks.openTaskModal({ users: [WOJTEK, MARIOLA], ...opts }, null);
  } finally {
    delete globalThis.__openModal;
    tasks.state.users = previous;
  }
  return seen;
}

test('openTaskModal: the draft reaches the sheet, "Say again" only when spoken', () => {
  const typed = openWith({ draft: { title: 'Wyrzuć śmieci' } });
  assert.equal(typed.title, 'tasks.newTask');
  assert.match(typed.content, /value="Wyrzuć śmieci"/);
  assert.ok(!typed.headerAction, 'typed: no "Say again"');

  const spoken = openWith({ draft: { title: 'Wyrzuć śmieci' }, spoken: true });
  assert.equal(spoken.headerAction?.label, 'tasks.sayAgain');
  const action = fakeEl();
  const panel = { querySelector: (sel) => (sel === '.modal-panel__action' ? action : null), querySelectorAll: () => [] };
  spoken.onSave(panel);
  assert.equal(action.getAttribute('data-action'), 'dictate', 'Task 9 wires it through data-action');
});
