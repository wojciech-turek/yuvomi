/**
 * Modul: Gemeinsame Bausteine der Blaetter (One Today, Task 9)
 * Zweck: utils/sheet-parts.js liefert dasselbe Markup, das pages/tasks.js davor
 *        selbst baute (Schnappschuss aus dem Stand vor dem Umbau), die Zeile mit
 *        dem gehoerten Satz, und die Regeln dazu stehen in layout.css statt in
 *        tasks.css (das laedt nur auf /tasks). openTaskModal zeigt die Zeile
 *        nur bei `spoken` UND `heard`, ueber dem Titelfeld.
 * Ausfuehren: npm run test:sheet-parts
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
globalThis.document.documentElement.classList = {
  toggle() {}, add() {}, remove() {}, contains() { return false; },
};
globalThis.CSS = globalThis.CSS ?? { escape: (v) => String(v) };
globalThis.window = globalThis.window ?? {};
globalThis.window.yuvomi = { showToast() {} };

const parts = await import('../public/utils/sheet-parts.js');
const { __test: tasks } = await import('../public/pages/tasks.js');

const ROW_OPTS = {
  icons: { due: 'calendar', reminder: 'bell', note: 'pencil' },
  labels: { due: 'tasks.dueShort', reminder: 'reminders.sectionTitle', note: 'tasks.descriptionLabel' },
  removeLabels: { due: 'tasks.removeDue', reminder: 'reminders.removeReminder', note: 'tasks.removeNote' },
};

// Schnappschuss: so stand die Zeile in tasks.js vor dem Umbau (Stub-i18n: Schluessel roh).
const DUE_ROW = `
        <div class="task-sheet__row" data-row="due">
          <button type="button" class="task-sheet__row-main" data-expand="due" aria-expanded="false" aria-controls="task-due-body">
            <i data-lucide="calendar" class="icon-md" aria-hidden="true"></i>
            <span data-fit="reminders.sectionTitle" class="task-sheet__row-label">tasks.dueShort</span>
            <span class="task-sheet__row-value">Jutro</span>
          </button>
          <button type="button" class="task-sheet__row-remove" data-remove="due" aria-label="tasks.removeDue">
            <i data-lucide="x" class="icon-md" aria-hidden="true"></i>
          </button>
        </div>`;

test('sheetRowHtml: the due row is byte for byte what tasks.js built before', () => {
  assert.equal(parts.sheetRowHtml('due', 'Jutro', ROW_OPTS), DUE_ROW);
});

test('sheetRowHtml: the id prefix reaches aria-controls, the value is escaped', () => {
  const html = parts.sheetRowHtml('due', '<b>x</b>', { ...ROW_OPTS, idPrefix: 'event' });
  assert.match(html, /aria-controls="event-due-body"/);
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;') && !html.includes('<b>'));
});

test('sheetSectionHtml: section, row and body carry the prefix; without a row the body is open', () => {
  const closed = parts.sheetSectionHtml('due', { open: false, labelledBy: 'task-due-heading' }, '<i>inner</i>');
  assert.equal(closed, `
      <div class="task-sheet__section" data-section="due" role="group" aria-labelledby="task-due-heading" hidden>
        <div class="task-sheet__body" id="task-due-body"><i>inner</i>
        </div>
      </div>`);
  const withRow = parts.sheetSectionHtml('due', {
    open: true, row: 'Jutro', idPrefix: 'event', rowOptions: ROW_OPTS,
  }, 'x');
  assert.ok(withRow.includes('aria-controls="event-due-body"'));
  assert.ok(withRow.includes('<div class="task-sheet__body" id="event-due-body" hidden>'));
});

test('sheetSectionHead / revealButtonHtml / longestLabel keep their shape', () => {
  assert.match(parts.sheetSectionHead('note', 'T'), /data-remove="note">tasks\.removeField<\/button>/);
  assert.ok(!parts.sheetSectionHead('note', 'T', { removable: false }).includes('data-remove'));
  assert.match(parts.revealButtonHtml('due', 'tasks.addDue', false), /^<button type="button" class="task-sheet__chip" data-reveal="due">\s*<i data-lucide="calendar"/);
  assert.match(parts.revealButtonHtml('due', 'tasks.addDue', true), /data-reveal="due" hidden>/);
  assert.equal(parts.longestLabel({ a: 'abc', b: 'abcdef', c: 'ab' }), 'abcdef');
  assert.equal(parts.longestLabel({}), '');
});

test('titleFieldHtml: the mic sits in the field only when asked', () => {
  const withMic = parts.titleFieldHtml({
    id: 'x-title', name: 'title', value: 'A "b"', placeholder: 'p', labelKey: 'l', mic: { labelKey: 'tasks.sayIt' },
  });
  assert.match(withMic, /^<div class="form-field task-sheet__title task-sheet__title--mic">/);
  assert.match(withMic, /id="x-title" name="title"\s+value="A &quot;b&quot;"/);
  assert.match(withMic, /class="task-sheet__mic" data-action="dictate" aria-label="tasks\.sayIt"/);
  const plain = parts.titleFieldHtml({ id: 'x-title', name: 'title', labelKey: 'l' });
  assert.match(plain, /^<div class="form-field task-sheet__title">/);
  assert.ok(!plain.includes('task-sheet__mic'));
});

test('heardLineHtml: the sentence in a quote line, escaped; empty gives nothing', () => {
  const html = parts.heardLineHtml('Kup mleko');
  assert.ok(html.includes('class="sheet-heard"'));
  assert.ok(html.includes('data-lucide="mic"'));
  assert.ok(html.includes('Kup mleko'));
  assert.ok(parts.heardLineHtml('<img onerror=x>').includes('&lt;img onerror=x&gt;'));
  assert.ok(!parts.heardLineHtml('<img onerror=x>').includes('<img'));
  assert.equal(parts.heardLineHtml(''), '');
  assert.equal(parts.heardLineHtml('   '), '');
  assert.equal(parts.heardLineHtml(null), '');
});

test('css: the shared sheet rules live in layout.css, not in tasks.css', () => {
  const layout = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
  const tasksCss = readFileSync(new URL('../public/styles/tasks.css', import.meta.url), 'utf8');
  for (const selector of ['.task-sheet__row', '.task-sheet__title', '.task-sheet__mic', '.task-sheet__pill', '.task-sheet__chip',
    '.task-sheet__section', '.task-sheet__submit', '.task-sheet__reveals', '.task-sheet__who', '.sheet-heard']) {
    assert.ok(layout.includes(`\n${selector} `) || layout.includes(`\n${selector},`), `${selector} is in layout.css`);
  }
  assert.ok(!/^\.task-sheet__row \{/m.test(tasksCss), 'no .task-sheet__row rule left in tasks.css');
  assert.ok(/^\.task-sheet__row \{/m.test(layout));
  assert.ok(!/^\.task-sheet__(mic|submit|chip|section-head) \{/m.test(tasksCss));
  assert.ok(/^\.task-sheet__when \{/m.test(tasksCss), 'the due/reminder layout stays with the task page');
});

function openWith(opts) {
  let seen = null;
  globalThis.__openModal = (options) => { seen = options; };
  try {
    tasks.openTaskModal({ users: [{ id: 1, display_name: 'Wojtek' }], ...opts }, null);
  } finally {
    delete globalThis.__openModal;
  }
  return seen;
}

test('openTaskModal: the heard line shows above the title when spoken and heard', () => {
  const opened = openWith({ draft: { title: 'Kup mleko' }, spoken: true, heard: 'Kup mleko' });
  assert.ok(opened.content.includes('sheet-heard'));
  assert.ok(opened.content.indexOf('sheet-heard') < opened.content.indexOf('task-title'));
});

test('openTaskModal: no heard line without spoken, without heard, or when editing', () => {
  assert.ok(!openWith({ draft: { title: 'x' }, heard: 'x' }).content.includes('sheet-heard'));
  assert.ok(!openWith({ draft: { title: 'x' }, spoken: true }).content.includes('sheet-heard'));
  const task = { id: 4, title: 'x', status: 'open', priority: 'low', category: 'household', visibility: 'all', assigned_users: [] };
  assert.ok(!openWith({ task, spoken: true, heard: 'x' }).content.includes('sheet-heard'));
});
