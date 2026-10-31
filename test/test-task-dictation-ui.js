/**
 * Modul: Diktat in der App - Mikrofon, Hoerblatt, das Formular fuellt sich
 *        (Quick-Add, 2026-10-29, Task 9)
 * Zweck: Sprechen -> das Blatt "Neue Aufgabe" ist ausgefuellt -> die Person
 *        prueft und tippt "Aufgabe hinzufuegen". Gespeichert wird NIE ohne
 *        diesen Tipp. Geprueft wird:
 *          - utils/speech.js: Safaris Erkennung, immer pl-PL, Zwischenstaende
 *            live, Fehlercodes durchgereicht, ein gestoppter Erkenner bleibt still;
 *          - utils/task-draft.js: EIN Aufruf von POST /tasks/parse je "Fertig";
 *            ohne KI (aus, Fehler, kein Netz) fuellt der lokale Parser, und die
 *            Person landet immer im gefuellten Blatt;
 *          - components/task-dictation.js: das Hoerblatt (Entwurf TaskSpoken),
 *            das Textfeld, wenn die Erkennung fehlt oder scheitert, kein Mikrofon,
 *            das nach dem Schliessen weiterlaeuft;
 *          - pages/tasks.js: Mikrofon nur beim Anlegen (R10), Mikrofon und
 *            "Noch einmal sagen" oeffnen das Hoerblatt, "Fertig" ersetzt das Blatt
 *            durch ein gefuelltes, ein diktiertes Blatt fragt beim Wegwischen
 *            "Verwerfen?" - gefragt wird der ECHTE Dirty-Waechter aus modal.js.
 * Zone: Haushalt Europe/Warsaw.
 * Ausfuehren: npm run test:task-dictation-ui
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

const { setDisplayTimeZone } = await import('../public/utils/timezone.js');
const { setHouseholdSize } = await import('../public/utils/household.js');
const { speechSupported, startListening } = await import('../public/utils/speech.js');
const { draftFromSentence } = await import('../public/utils/task-draft.js');
const { openDictationSheet } = await import('../public/components/task-dictation.js');
const { __test: tasks, openNewTaskFrom } = await import('../public/pages/tasks.js');
// Der Loader stubt '/components/modal.js' fuer die Seiten; hier steht das ECHTE
// Modul, damit der Dirty-Waechter selbst gefragt wird und nicht seine Attrappe.
const realModal = await import('../public/components/modal.js');

setDisplayTimeZone('Europe/Warsaw');
setHouseholdSize(2);

const WOJTEK = { id: 1, display_name: 'Wojtek' };
const MARIOLA = { id: 2, display_name: 'Mariola' };
const MEMBERS = [WOJTEK, MARIOLA];
const NOW = new Date('2026-10-29T10:00:00Z'); // Donnerstag, 11:00 in Warschau

// --------------------------------------------------------------------------
// Attrappen
// --------------------------------------------------------------------------

/** Ein Erkenner wie Safaris `webkitSpeechRecognition`; jede Instanz merkt sich, was mit ihr geschah. */
function fakeWindow() {
  const instances = [];
  class FakeRecognition {
    constructor() {
      this.started = 0;
      this.aborted = 0;
      this.stopped = 0;
      instances.push(this);
    }
    start() { this.started += 1; }
    stop() { this.stopped += 1; }
    abort() { this.aborted += 1; }
    /** `[[text, isFinal], ...]` als SpeechRecognitionEvent. */
    say(...parts) {
      const results = parts.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal }));
      this.onresult?.({ resultIndex: 0, results });
    }
    fail(error) { this.onerror?.({ error }); }
    end() { this.onend?.(); }
  }
  return { win: { webkitSpeechRecognition: FakeRecognition }, instances };
}

/** Ein Element, wie die Verdrahtung es braucht. */
function fakeEl(props = {}) {
  const attrs = new Map(Object.entries(props.attrs ?? {}));
  const el = {
    value: '', hidden: false, disabled: false, dataset: {}, listeners: {}, textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    ...props,
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    removeAttribute(name) { attrs.delete(name); },
    hasAttribute(name) { return attrs.has(name); },
    toggleAttribute(name, force) { if (force) attrs.set(name, ''); else attrs.delete(name); },
    addEventListener(type, fn) { (el.listeners[type] ??= []).push(fn); },
    closest: (sel) => (props.closest ? props.closest(sel) : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() { el.focused = true; },
  };
  return el;
}

/**
 * Das Hoerblatt als Attrappe. Was im Rumpf steht, kommt aus dem ECHTEN Markup
 * (`content` von openModal, danach `innerHTML` des Wirts) - ein Knoten, den
 * das Markup nicht nennt, gibt es hier nicht.
 */
function dictationPanel(content) {
  const host = fakeEl();
  host.innerHTML = content;
  host.replaceChildren = () => { host.innerHTML = ''; };
  host.insertAdjacentHTML = (position, html) => {
    assert.equal(position, 'beforeend');
    host.innerHTML += html;
  };
  const nodes = new Map();
  const node = (key, props) => {
    if (!nodes.has(key)) nodes.set(key, fakeEl(props));
    return nodes.get(key);
  };
  const inBody = (needle) => host.innerHTML.includes(needle);
  const textarea = () => {
    const el = node(`textarea:${host.innerHTML.length}`);
    if (!el.seeded) {
      el.seeded = true;
      el.value = host.innerHTML.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)?.[1] ?? '';
    }
    return el;
  };
  const panel = {
    host,
    listeners: {},
    addEventListener(type, fn) { (panel.listeners[type] ??= []).push(fn); },
    querySelector(sel) {
      if (sel === '[data-dictation-body]') return host;
      if (sel === '[data-dictation-done]') return node('done');
      if (sel === '[data-dictation-type]') return node('type');
      if (sel === '[data-dictation-status]') return inBody('data-dictation-status') ? node(`status:${host.innerHTML.length}`) : null;
      if (sel === '[data-dictation-transcript]') return inBody('data-dictation-transcript') ? node(`transcript:${host.innerHTML.length}`) : null;
      if (sel === '[data-dictation-mic]') return inBody('data-dictation-mic') ? node(`mic:${host.innerHTML.length}`) : null;
      if (sel === '#dictation-text') return inBody('id="dictation-text"') ? textarea() : null;
      return null;
    },
    querySelectorAll: () => [],
    /** Ein Klick auf das Element zu `sel`, wie ihn die Delegation am Panel sieht. */
    click(sel) {
      const target = panel.querySelector(sel);
      assert.ok(target, `${sel} steht im Blatt`);
      target.closest = (wanted) => (wanted.split(',').map((s) => s.trim()).includes(sel) ? target : null);
      for (const fn of panel.listeners.click ?? []) fn({ target, preventDefault() {} });
      return target;
    },
  };
  return panel;
}

/** openDictationSheet oeffnen und die Optionen von openModal einfangen. */
function openSheet(opts = {}) {
  let seen = null;
  const previous = globalThis.__openModal;
  globalThis.__openModal = (options) => { seen = options; };
  try {
    openDictationSheet({ members: MEMBERS, ...opts });
  } finally {
    globalThis.__openModal = previous;
  }
  assert.ok(seen, 'das Hoerblatt geht ueber openModal auf');
  return seen;
}

/** Oeffnen, verdrahten, Attrappe zurueck. */
function mountSheet(opts = {}) {
  const options = openSheet(opts);
  const panel = dictationPanel(options.content);
  options.onSave(panel);
  return { options, panel };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function recordingPost(answer) {
  const calls = [];
  const post = async (path, body) => {
    calls.push({ path, body });
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer(path, body) : answer;
  };
  return { calls, post };
}

const DISABLED = { data: { source: null, unavailable: 'disabled' } };
const EMPTY = { title: '', due_date: null, due_time: null, remind_date: null, remind_time: null, assigned_to: [] };

// --------------------------------------------------------------------------
// utils/speech.js
// --------------------------------------------------------------------------

test('speech: supported only where the browser has a recognizer', () => {
  assert.equal(speechSupported({}), false);
  assert.equal(speechSupported(null), false);
  assert.equal(speechSupported({ webkitSpeechRecognition: class {} }), true, 'Safari');
  assert.equal(speechSupported({ SpeechRecognition: class {} }), true, 'the standard name');
});

test('speech: Polish, live interim text, one utterance; final text and the end are passed on', () => {
  const { win, instances } = fakeWindow();
  const heard = [];
  let ended = null;
  startListening({ onText: (text, isFinal) => heard.push([text, isFinal]), onEnd: (text) => { ended = text; } }, win);
  const [rec] = instances;
  assert.equal(rec.lang, 'pl-PL', 'Polish by default');
  assert.equal(rec.interimResults, true);
  assert.equal(rec.continuous, false, 'stops on a pause');
  assert.equal(rec.started, 1);
  rec.say(['Wyrzuć', false]);
  rec.say(['Wyrzuć śmieci', true]);
  rec.end();
  assert.deepEqual(heard, [['Wyrzuć', false], ['Wyrzuć śmieci', true]]);
  assert.equal(ended, 'Wyrzuć śmieci');
});

test('speech: several result pieces read as one sentence; the end keeps text that never turned final', () => {
  const { win, instances } = fakeWindow();
  const heard = [];
  let ended = null;
  startListening({ onText: (text, isFinal) => heard.push([text, isFinal]), onEnd: (text) => { ended = text; } }, win);
  instances[0].say(['Weź jutro', true], [' Marysi spodenki', false]);
  instances[0].end();
  assert.deepEqual(heard, [['Weź jutro Marysi spodenki', false]]);
  assert.equal(ended, 'Weź jutro Marysi spodenki', 'Safari may end without a final result');
});

test('speech: error codes are passed on as they are', () => {
  const { win, instances } = fakeWindow();
  const codes = [];
  startListening({ onError: (code) => codes.push(code) }, win);
  instances[0].fail('not-allowed');
  instances[0].fail('no-speech');
  assert.deepEqual(codes, ['not-allowed', 'no-speech']);
});

test('speech: stop() aborts the recognizer and nothing is reported after it', () => {
  const { win, instances } = fakeWindow();
  const events = [];
  const handle = startListening({
    onText: () => events.push('text'), onEnd: () => events.push('end'), onError: () => events.push('error'),
  }, win);
  handle.stop();
  assert.equal(instances[0].aborted, 1, 'the mic is released at once');
  instances[0].say(['za późno', true]);
  instances[0].fail('aborted');
  instances[0].end();
  assert.deepEqual(events, []);
});

test('speech: lang can be set; a recognizer that refuses to start reports an error instead of throwing', async () => {
  const { win, instances } = fakeWindow();
  startListening({ lang: 'en-US' }, win);
  assert.equal(instances[0].lang, 'en-US');
  const codes = [];
  const broken = { webkitSpeechRecognition: class { start() { throw new Error('InvalidStateError'); } } };
  assert.doesNotThrow(() => startListening({ onError: (code) => codes.push(code) }, broken));
  await flush();
  assert.equal(codes.length, 1, 'one error');
  const missing = [];
  startListening({ onError: (code) => missing.push(code) }, {});
  await flush();
  assert.equal(missing.length, 1, 'no recognizer at all is an error too');
});

// --------------------------------------------------------------------------
// utils/task-draft.js
// --------------------------------------------------------------------------

test('draft: AI off -> the local parser fills the sheet ("Wyrzuć śmieci jutro")', async () => {
  const { calls, post } = recordingPost(DISABLED);
  const result = await draftFromSentence('Wyrzuć śmieci jutro', { members: MEMBERS, now: NOW, post });
  assert.deepEqual(result, { source: 'local', draft: { ...EMPTY, title: 'Wyrzuć śmieci', due_date: '2026-10-30' } });
  assert.deepEqual(calls, [{ path: '/tasks/parse', body: { text: 'Wyrzuć śmieci jutro' } }], 'one call with the sentence');
});

test('draft: the AI call throws (network, 400, 500) -> local, same result', async () => {
  const { calls, post } = recordingPost(new Error('offline'));
  const result = await draftFromSentence('Wyrzuć śmieci jutro', { members: MEMBERS, now: NOW, post });
  assert.deepEqual(result, { source: 'local', draft: { ...EMPTY, title: 'Wyrzuć śmieci', due_date: '2026-10-30' } });
  assert.equal(calls.length, 1, 'tried once, no retry');
});

test('draft: the AI answer is the draft', async () => {
  const fields = {
    title: 'Weź Marysi spodenki do przedszkola', due_date: '2026-10-30', due_time: null,
    remind_date: '2026-10-30', remind_time: '07:30', assigned_to: [],
  };
  const { calls, post } = recordingPost({ data: { source: 'ai', fields } });
  const sentence = 'Weź jutro Marysi spodenki do przedszkola, ustaw przypomnienie na jutro 7:30';
  const result = await draftFromSentence(sentence, { members: MEMBERS, now: NOW, post });
  assert.deepEqual(result, { source: 'ai', draft: fields });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.text, sentence, 'the whole sentence goes to the server, filler and all');
});

test('draft: local drops a leading "Dodaj zadanie" ("Dodaj zadanie ubezpiecz samochód")', async () => {
  const { post } = recordingPost(DISABLED);
  const { draft } = await draftFromSentence('Dodaj zadanie ubezpiecz samochód', { members: MEMBERS, now: NOW, post });
  assert.deepEqual(draft, { ...EMPTY, title: 'Ubezpiecz samochód' });
});

test('draft: local with nothing but a title keeps the whole sentence ("Ugotuj obiad dla dzieci")', async () => {
  // Der Parser liest "obiad" als Mahlzeit und nimmt es aus dem Titel - ohne
  // Datum, Uhrzeit oder Person ist der ganze Satz der Titel.
  const { post } = recordingPost(DISABLED);
  const { draft } = await draftFromSentence('Ugotuj obiad dla dzieci.', { members: MEMBERS, now: NOW, post });
  assert.deepEqual(draft, { ...EMPTY, title: 'Ugotuj obiad dla dzieci' });
});

test('draft: local reads a member as the assignee; "Marysi" is nobody and stays in the title', async () => {
  const { post } = recordingPost(DISABLED);
  const wojtek = await draftFromSentence('Wojtek odbierze paczkę jutro', { members: MEMBERS, now: NOW, post });
  assert.deepEqual(wojtek.draft.assigned_to, [WOJTEK.id]);
  assert.equal(wojtek.draft.due_date, '2026-10-30');
  const marysia = await draftFromSentence('Weź jutro Marysi spodenki do przedszkola', { members: MEMBERS, now: NOW, post });
  assert.deepEqual(marysia.draft, { ...EMPTY, title: 'Weź Marysi spodenki do przedszkola', due_date: '2026-10-30' });
});

test('draft: local splits off "ustaw przypomnienie ..." - its time is the reminder, not the due time', async () => {
  const { post } = recordingPost(DISABLED);
  const { draft } = await draftFromSentence(
    'Weź jutro Marysi spodenki do przedszkola, ustaw przypomnienie na jutro 7:30',
    { members: MEMBERS, now: NOW, post },
  );
  assert.deepEqual(draft, {
    ...EMPTY, title: 'Weź Marysi spodenki do przedszkola', due_date: '2026-10-30',
    remind_date: '2026-10-30', remind_time: '07:30',
  });
});

test('draft: local reminder rules match the server - a day alone is 09:00, an hour alone takes the due day or today', async () => {
  const { post } = recordingPost(DISABLED);
  const dayOnly = await draftFromSentence('Zapłać rachunek, przypomnienie jutro', { members: MEMBERS, now: NOW, post });
  assert.deepEqual([dayOnly.draft.remind_date, dayOnly.draft.remind_time], ['2026-10-30', '09:00']);
  const hourWithDue = await draftFromSentence('Zapłać rachunek w piątek, przypomnienie o 8:00', { members: MEMBERS, now: NOW, post });
  assert.deepEqual([hourWithDue.draft.due_date, hourWithDue.draft.remind_date, hourWithDue.draft.remind_time], ['2026-10-30', '2026-10-30', '08:00']);
  const hourAlone = await draftFromSentence('Zapłać rachunek, ustaw przypomnienie na 20:00', { members: MEMBERS, now: NOW, post });
  assert.deepEqual([hourAlone.draft.due_date, hourAlone.draft.remind_date, hourAlone.draft.remind_time], [null, '2026-10-29', '20:00']);
  assert.equal(hourAlone.draft.title, 'Zapłać rachunek');
});

test('draft: a due time without a day is left empty locally (like the server)', async () => {
  const { post } = recordingPost(DISABLED);
  const { draft } = await draftFromSentence('Zadzwonić do lekarza o 18', { members: MEMBERS, now: NOW, post });
  assert.equal(draft.due_date, null);
  assert.equal(draft.due_time, null);
});

// --------------------------------------------------------------------------
// components/task-dictation.js - das Hoerblatt
// --------------------------------------------------------------------------

const tagOf = (html, re) => html.match(re)?.[0] ?? '';

test('sheet without speech: a text box and the keyboard hint, no live transcript', () => {
  const { content } = openSheet({ win: {}, initialText: 'Kupić mleko' });
  assert.match(content, /<textarea\b[^>]*id="dictation-text"/);
  assert.match(content, /tasks\.dictation\.keyboardHint/);
  assert.match(content, />Kupić mleko<\/textarea>/, 'the current title is in the box');
  assert.doesNotMatch(content, /aria-live/);
  assert.doesNotMatch(content, /data-dictation-mic/);
});

test('sheet with speech: status, live transcript (aria-live="polite"), the mic ring, Type instead and Done - no text box', () => {
  const { win } = fakeWindow();
  const { content, title } = openSheet({ win });
  assert.equal(title, 'tasks.dictation.title');
  assert.match(content, /tasks\.dictation\.listening/);
  assert.match(tagOf(content, /<p\b[^>]*data-dictation-transcript[^>]*>/), /aria-live="polite"/);
  assert.match(content, /data-dictation-mic/);
  assert.doesNotMatch(content, /<textarea/);
  for (const [attr, label] of [['data-dictation-type', 'tasks.dictation.typeInstead'], ['data-dictation-done', 'tasks.dictation.done']]) {
    const button = tagOf(content, new RegExp(`<button\\b[^>]*${attr}[^>]*>`));
    assert.match(button, /type="button"/, `${attr} never submits`);
    assert.ok(content.includes(label), label);
  }
});

test('sheet: starts listening at once, in Polish whatever the UI language is', () => {
  const { win, instances } = fakeWindow();
  globalThis.__locale = 'en';
  try {
    mountSheet({ win });
  } finally {
    delete globalThis.__locale;
  }
  assert.equal(instances.length, 1);
  assert.equal(instances[0].lang, 'pl-PL');
  assert.equal(instances[0].started, 1);
});

test('sheet: what is heard shows live in the transcript', () => {
  const { win, instances } = fakeWindow();
  const { panel } = mountSheet({ win });
  instances[0].say(['Wyrzuć śmie', false]);
  assert.equal(panel.querySelector('[data-dictation-transcript]').textContent, 'Wyrzuć śmie');
  instances[0].say(['Wyrzuć śmieci', true]);
  assert.equal(panel.querySelector('[data-dictation-transcript]').textContent, 'Wyrzuć śmieci');
});

for (const code of ['not-allowed', 'service-not-allowed', 'audio-capture', 'network']) {
  test(`sheet: recognition error "${code}" -> the text box with the keyboard hint, the heard text kept`, () => {
    const { win, instances } = fakeWindow();
    const { panel } = mountSheet({ win, initialText: 'Kupić mleko' });
    assert.doesNotMatch(panel.host.innerHTML, /<textarea/);
    instances[0].fail(code);
    assert.match(panel.host.innerHTML, /<textarea\b[^>]*id="dictation-text"/, 'switched to the text box');
    assert.match(panel.host.innerHTML, /tasks\.dictation\.keyboardHint/);
    assert.match(panel.host.innerHTML, />Kupić mleko<\/textarea>/, 'nothing heard yet: the current title');
    assert.equal(instances[0].aborted, 1, 'the recognizer is let go');
  });
}

test('sheet: an error after some speech keeps what was heard in the text box', () => {
  const { win, instances } = fakeWindow();
  const { panel } = mountSheet({ win, initialText: 'Kupić mleko' });
  instances[0].say(['Wyrzuć śmieci', false]);
  instances[0].fail('network');
  assert.match(panel.host.innerHTML, />Wyrzuć śmieci<\/textarea>/);
});

test('sheet: "no-speech" stays in listening mode with a retry - the mic ring listens again', () => {
  const { win, instances } = fakeWindow();
  const { panel } = mountSheet({ win });
  instances[0].fail('no-speech');
  instances[0].end();
  assert.doesNotMatch(panel.host.innerHTML, /<textarea/, 'still the listening sheet');
  assert.equal(panel.querySelector('[data-dictation-status]').textContent, 'tasks.dictation.noSpeech');
  assert.equal(panel.querySelector('[data-dictation-mic]').getAttribute('aria-label'), 'tasks.sayAgain', 'the ring now says it listens again');
  panel.click('[data-dictation-mic]');
  assert.equal(instances.length, 2, 'a fresh recognizer');
  assert.equal(instances[1].started, 1);
  assert.equal(panel.querySelector('[data-dictation-status]').textContent, 'tasks.dictation.listening');
});

test('sheet: Done -> ONE parse call with what was heard, the mic is off, onDraft gets the draft', async () => {
  const { win, instances } = fakeWindow();
  const { calls, post } = recordingPost(DISABLED);
  const drafts = [];
  const { panel } = mountSheet({ win, post, onDraft: (draft) => drafts.push(draft) });
  instances[0].say(['Wyrzuć śmieci jutro', false]);
  panel.click('[data-dictation-done]');
  panel.click('[data-dictation-done]'); // ein zweiter Tipp waehrend der Anfrage
  assert.equal(instances[0].aborted, 1, 'the mic stops on Done');
  await flush();
  assert.equal(calls.length, 1, 'one AI call per Done');
  assert.equal(calls[0].body.text, 'Wyrzuć śmieci jutro');
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].title, 'Wyrzuć śmieci');
});

test('sheet: interim text never calls the server - only Done does', async () => {
  const { win, instances } = fakeWindow();
  const { calls, post } = recordingPost(DISABLED);
  mountSheet({ win, post });
  instances[0].say(['Wyrzuć', false]);
  instances[0].say(['Wyrzuć śmieci', true]);
  instances[0].end();
  await flush();
  assert.equal(calls.length, 0);
});

test('sheet: Done in the text box sends the typed sentence', async () => {
  const { calls, post } = recordingPost(DISABLED);
  const drafts = [];
  const { panel } = mountSheet({ win: {}, post, onDraft: (draft) => drafts.push(draft) });
  panel.querySelector('#dictation-text').value = 'Dodaj zadanie ubezpiecz samochód';
  panel.click('[data-dictation-done]');
  await flush();
  assert.deepEqual(calls.map((c) => c.body.text), ['Dodaj zadanie ubezpiecz samochód']);
  assert.deepEqual(drafts, [{ ...EMPTY, title: 'Ubezpiecz samochód' }]);
});

test('sheet: Done with nothing said asks again instead of calling the server', async () => {
  const { win } = fakeWindow();
  const { calls, post } = recordingPost(DISABLED);
  const { panel } = mountSheet({ win, post });
  panel.click('[data-dictation-done]');
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(panel.querySelector('[data-dictation-status]').textContent, 'tasks.dictation.noSpeech');
});

test('sheet: closing stops the recognizer (no hot mic) and nothing is drafted afterwards', async () => {
  const { win, instances } = fakeWindow();
  const { calls, post } = recordingPost(DISABLED);
  const seen = [];
  const { options, panel } = mountSheet({
    win, post, onDraft: () => seen.push('draft'), onCancel: () => seen.push('cancel'),
  });
  instances[0].say(['Wyrzuć śmieci', false]);
  options.onClose();
  assert.equal(instances[0].aborted, 1);
  assert.deepEqual(seen, ['cancel']);
  panel.click('[data-dictation-done]');
  await flush();
  assert.equal(calls.length, 0, 'a closed sheet sends nothing');
  assert.deepEqual(seen, ['cancel']);
});

test('sheet: closed while the parse runs -> no onDraft', async () => {
  const { win, instances } = fakeWindow();
  let release;
  const post = () => new Promise((resolve) => { release = () => resolve(DISABLED); });
  const seen = [];
  const { options, panel } = mountSheet({ win, post, onDraft: () => seen.push('draft') });
  instances[0].say(['Wyrzuć śmieci', true]);
  panel.click('[data-dictation-done]');
  options.onClose();
  release();
  await flush();
  assert.deepEqual(seen, []);
});

test('sheet: Type instead stops the mic and hands over; the close that follows is not a cancel', () => {
  const { win, instances } = fakeWindow();
  const seen = [];
  const { options, panel } = mountSheet({
    win, onTypeInstead: () => seen.push('type'), onCancel: () => seen.push('cancel'),
  });
  panel.click('[data-dictation-type]');
  assert.equal(instances[0].aborted, 1);
  options.onClose();
  assert.deepEqual(seen, ['type']);
});

// --------------------------------------------------------------------------
// pages/tasks.js - Mikrofon, "Noch einmal sagen", das gefuellte Blatt
// --------------------------------------------------------------------------

globalThis.__advancedSection = (inner) => inner;
const sheetHtml = (opts) => tasks.renderModalContent({ users: MEMBERS, ...opts });
const FULL_TASK = {
  id: 7, title: 'Ubezpieczyć samochód', status: 'open', priority: 'high', category: 'household',
  visibility: 'all', due_date: '2026-10-30', assigned_users: [WOJTEK], assigned_to: WOJTEK.id,
};

test('R10: the mic is in the title field when adding, and gone when editing', () => {
  assert.match(sheetHtml({ task: null }), /<button\b[^>]*class="task-sheet__mic"[^>]*data-action="dictate"/);
  const edit = sheetHtml({ task: FULL_TASK });
  assert.match(edit, /id="task-title"/, 'precondition: the edit form rendered');
  assert.doesNotMatch(edit, /data-action="dictate"|task-sheet__mic/);
});

/** openTaskModal oeffnen; jede Oeffnung landet in `opened`. */
function captureModals() {
  const opened = [];
  const previous = globalThis.__openModal;
  globalThis.__openModal = (options) => { opened.push(options); };
  return { opened, restore() { globalThis.__openModal = previous; } };
}

/** Das Aufgabenblatt als Attrappe: Titelfeld und Mikrofon. */
function taskPanel(title = '') {
  const mic = fakeEl();
  const titleEl = fakeEl({ value: title });
  const action = fakeEl();
  return {
    mic, titleEl, action,
    querySelector: (sel) => ({ '.task-sheet__mic': mic, '#task-title': titleEl, '.modal-panel__action': action }[sel] ?? null),
    querySelectorAll: () => [],
  };
}

async function finishDictation(sheetOptions, sentence) {
  const panel = dictationPanel(sheetOptions.content);
  sheetOptions.onSave(panel);
  const box = panel.querySelector('#dictation-text');
  if (box) box.value = sentence;
  panel.click('[data-dictation-done]');
  await flush();
  await flush();
}

test('the mic in the New Task sheet opens dictation with the title; Done replaces the sheet with a spoken one', async () => {
  const modals = captureModals();
  const previousApi = globalThis.__apiStub;
  const fields = { ...EMPTY, title: 'Kupić mleko', due_date: '2026-10-30' };
  globalThis.__apiStub = { post: async (path) => (path === '/tasks/parse' ? { data: { source: 'ai', fields } } : { data: null }) };
  try {
    tasks.openTaskModal({ users: MEMBERS }, null);
    const [sheet] = modals.opened;
    assert.equal(sheet.headerAction, null, 'a typed sheet has no "Say again"');
    const panel = taskPanel('Kupić');
    sheet.onSave(panel);
    for (const fn of panel.mic.listeners.click ?? []) fn({ preventDefault() {} });
    const dictation = modals.opened[1];
    assert.equal(dictation?.title, 'tasks.dictation.title', 'the mic opened the dictation sheet');
    if (!/data-dictation-mic/.test(dictation.content)) {
      assert.match(dictation.content, />Kupić<\/textarea>/, 'the current title goes along');
    }
    await finishDictation(dictation, 'Kupić mleko jutro');
    const filled = modals.opened[2];
    assert.ok(filled, 'Done opened the filled sheet');
    assert.equal(filled.title, 'tasks.newTask');
    assert.equal(filled.headerAction?.label, 'tasks.sayAgain', 'spoken: "Say again" in the header');
    assert.match(filled.content, /value="Kupić mleko"/);
    assert.match(filled.content, /data-row/, 'set values stand as rows');
    assert.equal(modals.opened.length, 3, 'nothing else opened - and nothing saved');
  } finally {
    modals.restore();
    globalThis.__apiStub = previousApi;
  }
});

test('"Say again" in the header opens dictation with the current title; nothing is posted to /tasks', async () => {
  const modals = captureModals();
  const previousApi = globalThis.__apiStub;
  const posted = [];
  globalThis.__apiStub = {
    post: async (path, body) => {
      posted.push(path);
      return path === '/tasks/parse' ? { data: { source: 'ai', fields: { ...EMPTY, title: 'Wyrzuć śmieci' } } } : { data: null };
    },
  };
  try {
    tasks.openTaskModal({ users: MEMBERS, draft: { title: 'Wyrzuć smieci' }, spoken: true }, null);
    const [sheet] = modals.opened;
    assert.equal(typeof sheet.headerAction?.onClick, 'function', '"Say again" is wired');
    const panel = taskPanel('Wyrzuć smieci');
    sheet.onSave(panel);
    sheet.headerAction.onClick();
    const dictation = modals.opened[1];
    assert.equal(dictation?.title, 'tasks.dictation.title');
    await finishDictation(dictation, 'Wyrzuć śmieci');
    assert.match(modals.opened[2]?.content ?? '', /value="Wyrzuć śmieci"/);
    assert.deepEqual(posted, ['/tasks/parse'], 'only the parse - the task waits for "Add task"');
  } finally {
    modals.restore();
    globalThis.__apiStub = previousApi;
  }
});

test('closing the dictation sheet opened from a sheet opens nothing new (the sheet comes back as it was)', () => {
  const modals = captureModals();
  try {
    tasks.openTaskModal({ users: MEMBERS }, null);
    const panel = taskPanel('Kupić');
    modals.opened[0].onSave(panel);
    for (const fn of panel.mic.listeners.click ?? []) fn({ preventDefault() {} });
    const dictation = modals.opened[1];
    dictation.onSave(dictationPanel(dictation.content));
    dictation.onClose();
    assert.equal(modals.opened.length, 2);
  } finally {
    modals.restore();
  }
});

test('Type instead from a sheet brings it back with what was said as its title - nothing is lost', async () => {
  const modals = captureModals();
  try {
    tasks.openTaskModal({ users: MEMBERS }, null);
    const panel = taskPanel('Kupić');
    modals.opened[0].onSave(panel);
    for (const fn of panel.mic.listeners.click ?? []) fn({ preventDefault() {} });
    const dictation = modals.opened[1];
    const sheet = dictationPanel(dictation.content);
    dictation.onSave(sheet);
    sheet.querySelector('#dictation-text').value = 'Kupić mleko i chleb';
    sheet.click('[data-dictation-type]');
    await flush();
    assert.equal(modals.opened.length, 2, 'no new sheet - the parked one comes back');
    assert.equal(panel.titleEl.value, 'Kupić mleko i chleb');
    assert.equal(panel.titleEl.focused, true, 'ready to type');
  } finally {
    modals.restore();
  }
});

test('openNewTaskFrom({ dictate: true }) opens the dictation sheet first, Done opens the spoken New Task sheet', async () => {
  const modals = captureModals();
  const previousApi = globalThis.__apiStub;
  const previousSheets = globalThis.document.styleSheets;
  const previousUsers = tasks.state.users;
  const previousCategories = tasks.state.categories;
  globalThis.document.styleSheets = [{ href: 'http://localhost/styles/tasks.css', disabled: false, media: { mediaText: 'all' } }];
  tasks.state.users = MEMBERS;
  tasks.state.categories = [{ key: 'household' }];
  globalThis.__apiStub = { post: async () => DISABLED };
  try {
    assert.equal(await openNewTaskFrom({ dictate: true }), true);
    const [dictation] = modals.opened;
    assert.equal(dictation?.title, 'tasks.dictation.title', 'dictation first');
    await finishDictation(dictation, 'Wyrzuć śmieci jutro');
    const filled = modals.opened[1];
    assert.equal(filled?.title, 'tasks.newTask');
    assert.equal(filled.headerAction?.label, 'tasks.sayAgain');
    assert.match(filled.content, /value="Wyrzuć śmieci"/);

    // "Type instead": das Blatt zum Tippen, mit dem schon Gesagten als Titel.
    assert.equal(await openNewTaskFrom({ dictate: true }), true);
    const again = modals.opened[2];
    const sheet = dictationPanel(again.content);
    again.onSave(sheet);
    sheet.querySelector('#dictation-text').value = 'Zadzwonić do mamy';
    sheet.click('[data-dictation-type]');
    const typed = modals.opened[3];
    assert.equal(typed?.title, 'tasks.newTask');
    assert.equal(typed.headerAction, null, 'typed, not spoken');
    assert.match(typed.content, /value="Zadzwonić do mamy"/);
  } finally {
    modals.restore();
    globalThis.__apiStub = previousApi;
    globalThis.document.styleSheets = previousSheets;
    tasks.state.users = previousUsers;
    tasks.state.categories = previousCategories;
  }
});

// --------------------------------------------------------------------------
// Ein diktiertes Blatt geht nicht aus Versehen verloren
// --------------------------------------------------------------------------

/** Die Felder eines Markups so, wie der Waechter sie liest (input, select, textarea). */
function formFieldsOf(html) {
  const fields = [];
  for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = new Map([...m[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((a) => [a[1], a[2] ?? '']));
    if (attrs.get('type') === 'file' || attrs.has('data-dirty-ignore')) continue;
    fields.push({
      type: attrs.get('type') ?? m[1], id: attrs.get('id') ?? '', name: attrs.get('name') ?? '',
      value: attrs.get('value') ?? '', checked: attrs.has('checked'),
      hasAttribute: (name) => attrs.has(name), getAttribute: (name) => attrs.get(name) ?? null,
    });
  }
  return fields;
}

function dirtyAfterOpen(html) {
  const fields = formFieldsOf(html);
  const panel = { querySelectorAll: () => fields };
  realModal.__test.adoptOverlayForTest({ querySelector: () => panel });
  try {
    // Zweimal: der verzoegerte zweite Schnappschuss von openModal aendert nichts.
    realModal.__test.adoptOverlayForTest({ querySelector: () => panel });
    return realModal.__test.isFormDirty(panel);
  } finally {
    realModal.__test.releaseOverlayForTest();
  }
}

test('a sheet opened from a dictated draft counts as changed - closing it asks "Discard?"', () => {
  const spoken = sheetHtml({ task: null, draft: { title: 'Wyrzuć śmieci', due_date: '2026-10-30' }, spoken: true });
  assert.ok(formFieldsOf(spoken).length > 3, 'precondition: the fields were read from the markup');
  assert.equal(dirtyAfterOpen(spoken), true, 'dictated: swiping it away asks first');
  assert.equal(dirtyAfterOpen(sheetHtml({ task: null })), false, 'an empty New Task sheet closes without asking');
  assert.equal(dirtyAfterOpen(sheetHtml({ task: FULL_TASK })), false, 'an untouched edit closes without asking');
});

test('modal: a field with data-dirty-base counts as changed until it holds that value', () => {
  const marker = { type: 'hidden', id: 'm', name: '', value: '1', hasAttribute: (n) => n === 'data-dirty-base', getAttribute: (n) => (n === 'data-dirty-base' ? '' : null) };
  const plain = { type: 'text', id: 't', name: '', value: 'x' };
  const panel = { querySelectorAll: () => [plain, marker] };
  realModal.__test.adoptOverlayForTest({ querySelector: () => panel });
  try {
    assert.equal(realModal.__test.isFormDirty(panel), true);
    marker.value = '';
    assert.equal(realModal.__test.isFormDirty(panel), false, 'back at its base value');
    plain.value = 'y';
    assert.equal(realModal.__test.isFormDirty(panel), true, 'the other fields still count as before');
  } finally {
    realModal.__test.releaseOverlayForTest();
  }
});
