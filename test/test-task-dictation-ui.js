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
 *            durch ein gefuelltes (mit dem eben gehoerten Satz), ein diktiertes
 *            Blatt fragt beim Wegwischen "Verwerfen?" - gefragt wird der ECHTE
 *            Dirty-Waechter aus modal.js;
 *          - "Say it" (startQuickAdd, One Today Task 14): neutrale Worte im
 *            Hoerblatt, der Satz wird Aufgabe, Termin oder Einkauf (gesprochen,
 *            mit dem gehoerten Satz); wo die Art nicht beschreibbar ist, die
 *            Aufgabe mit dem Satz als Titel, sonst eine Meldung.
 * Zone: Haushalt Europe/Warsaw.
 * Ausfuehren: npm run test:task-dictation-ui
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

const { setDisplayTimeZone } = await import('../public/utils/timezone.js');
const { setHouseholdSize } = await import('../public/utils/household.js');
const { speechSupported, startListening } = await import('../public/utils/speech.js');
const { draftFromSentence, DICTATION_TIMEOUT_MS } = await import('../public/utils/task-draft.js');
const { openDictationSheet, startQuickAdd, quickAddCopy } = await import('../public/components/task-dictation.js');
const { __test: tasks } = await import('../public/pages/tasks.js');
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

// F6: eine Anfrage, die haengt, hielte "Fertig" bis zu zwei Minuten am
// Drehen (gemeinsamer Client: 60 s Zeitlimit, eine Wiederholung). Nach rund
// acht Sekunden bricht das Blatt ab und fuellt lokal.
test('draft: a hanging AI call is given up after ~8 s - the local parser fills, the request is aborted', async () => {
  assert.equal(DICTATION_TIMEOUT_MS, 8000);
  let signal = null;
  const post = (_path, _body, opts = {}) => {
    signal = opts.signal ?? null;
    return new Promise(() => {}); // antwortet nie
  };
  const started = Date.now();
  const result = await draftFromSentence('Wyrzuć śmieci jutro', { members: MEMBERS, now: NOW, post, timeoutMs: 30 });
  assert.ok(Date.now() - started < 1000, 'does not wait for the server');
  assert.deepEqual(result, { source: 'local', draft: { ...EMPTY, title: 'Wyrzuć śmieci', due_date: '2026-10-30' } });
  assert.ok(signal, 'the request carries a signal');
  assert.equal(signal.aborted, true, 'and is aborted, not left running');
});

test('draft: an answer in time is used; the timer does not abort it afterwards', async () => {
  let signal = null;
  const fields = { ...EMPTY, title: 'Wyrzuć śmieci' };
  const post = async (_path, _body, opts = {}) => {
    signal = opts.signal ?? null;
    return { data: { source: 'ai', fields } };
  };
  const result = await draftFromSentence('Wyrzuć śmieci', { members: MEMBERS, now: NOW, post, timeoutMs: 20 });
  assert.deepEqual(result, { source: 'ai', draft: fields });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(signal.aborted, false);
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

// Ruling R16: eine Erinnerung, die NUR eine Stunde nennt und deren Stunde heute
// schon vorbei ist, erinnert morgen - gespeichert ginge sie sonst sofort raus.
// NOW = 11:00 in Warschau.
test('draft: local - an hour-only reminder already passed today rolls to tomorrow', async () => {
  const { post } = recordingPost(DISABLED);
  const passed = await draftFromSentence('Zapłać rachunek, ustaw przypomnienie na 8:00', { members: MEMBERS, now: NOW, post });
  assert.deepEqual([passed.draft.remind_date, passed.draft.remind_time], ['2026-10-30', '08:00']);
  const thisMinute = await draftFromSentence('Zapłać rachunek, ustaw przypomnienie na 11:00', { members: MEMBERS, now: NOW, post });
  assert.deepEqual([thisMinute.draft.remind_date, thisMinute.draft.remind_time], ['2026-10-30', '11:00'], 'the current minute counts as passed');
  const ahead = await draftFromSentence('Zapłać rachunek, ustaw przypomnienie na 11:30', { members: MEMBERS, now: NOW, post });
  assert.deepEqual([ahead.draft.remind_date, ahead.draft.remind_time], ['2026-10-29', '11:30'], 'still ahead: today');
  // Faellig heute, Erinnerung nur mit Stunde: auch dann morgen.
  const dueToday = await draftFromSentence('Zapłać rachunek dzisiaj, przypomnienie o 8:00', { members: MEMBERS, now: NOW, post });
  assert.deepEqual([dueToday.draft.due_date, dueToday.draft.remind_date, dueToday.draft.remind_time], ['2026-10-29', '2026-10-30', '08:00']);
  // Ein ausdruecklich gesagter Tag bleibt - das Speichern ruegt ihn (R15).
  const saidToday = await draftFromSentence('Zapłać rachunek przypomnij mi dzisiaj o 8', { members: MEMBERS, now: NOW, post });
  assert.deepEqual([saidToday.draft.remind_date, saidToday.draft.remind_time], ['2026-10-29', '08:00']);
});

test('draft: local - a title longer than 200 characters is clipped on a word boundary (F5)', async () => {
  const { post } = recordingPost(DISABLED);
  const sentence = `Zadzwoń ${'do przedszkola w sprawie wycieczki '.repeat(8)}`.trim();
  assert.ok(sentence.length > 200);
  const { draft } = await draftFromSentence(sentence, { members: MEMBERS, now: NOW, post });
  assert.ok(draft.title.length <= 200, `${draft.title.length} characters`);
  assert.ok(sentence.startsWith(draft.title));
  assert.match(sentence.slice(draft.title.length), /^\s/, 'cut where a word ends');
});

test('draft: a due time without a day is left empty locally (like the server)', async () => {
  const { post } = recordingPost(DISABLED);
  const { draft } = await draftFromSentence('Zadzwonić do lekarza o 18', { members: MEMBERS, now: NOW, post });
  assert.equal(draft.due_date, null);
  assert.equal(draft.due_time, null);
});

// Der Boden des lokalen Wegs: schlimmstenfalls ist der Satz der Titel - kein
// Wort geht verloren, das nicht als Datum, Uhrzeit, Person oder Erinnerung
// gelesen wurde.
const LOCAL_CASES = [
  ['Wyślij przypomnienie do przedszkola', { title: 'Wyślij przypomnienie do przedszkola' }],
  ['Wyślij przypomnienie o fakturze do Kasi jutro', { title: 'Wyślij przypomnienie o fakturze do Kasi', due_date: '2026-10-30' }],
  ['Ugotuj obiad jutro', { title: 'Ugotuj obiad', due_date: '2026-10-30' }],
  ['Ugotuj obiad dla Wojtka w piątek', { title: 'Ugotuj obiad', due_date: '2026-10-30', assigned_to: [WOJTEK.id] }],
  // Die drei Beispiele der Spec.
  ['Dodaj zadanie ubezpiecz samochód', { title: 'Ubezpiecz samochód' }],
  ['Weź jutro Marysi spodenki do przedszkola, ustaw przypomnienie na jutro 7:30',
    { title: 'Weź Marysi spodenki do przedszkola', due_date: '2026-10-30', remind_date: '2026-10-30', remind_time: '07:30' }],
  ['Wyrzuć śmieci', { title: 'Wyrzuć śmieci' }],
  // Gesprochen kommt oft kein Komma.
  ['Weź jutro Marysi spodenki do przedszkola ustaw przypomnienie na jutro 7:30',
    { title: 'Weź Marysi spodenki do przedszkola', due_date: '2026-10-30', remind_date: '2026-10-30', remind_time: '07:30' }],
  ['Zapłać rachunek przypomnij mi jutro o 8', { title: 'Zapłać rachunek', remind_date: '2026-10-30', remind_time: '08:00' }],
];

for (const [sentence, expected] of LOCAL_CASES) {
  test(`draft: local "${sentence}"`, async () => {
    const { post } = recordingPost(DISABLED);
    const { source, draft } = await draftFromSentence(sentence, { members: MEMBERS, now: NOW, post });
    assert.equal(source, 'local');
    assert.deepEqual(draft, { ...EMPTY, ...expected });
  });
}

test('draft: a reminder clause that is more than a time stays in the title', async () => {
  const { post } = recordingPost(DISABLED);
  const { draft } = await draftFromSentence('Zapłać rachunek, ustaw przypomnienie na jutro rano', { members: MEMBERS, now: NOW, post });
  assert.match(draft.title, /przypomnienie/, 'not cut - "rano" is not understood as a time');
  assert.match(draft.title, /rano/);
  assert.equal(draft.remind_date, null);
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

test('sheet words: Say it and the event and shopping mics pass neutral words - title, status and text label never say "task"', () => {
  const { win, instances } = fakeWindow();
  const listening = openSheet({ win, copy: quickAddCopy() });
  assert.equal(listening.title, 'quickAdd.title');
  assert.match(listening.content, /quickAdd\.listening/);
  assert.doesNotMatch(listening.content, /tasks\.dictation\.(title|listening|textLabel)/);
  const typed = openSheet({ win: {}, copy: quickAddCopy() });
  assert.match(typed.content, />quickAdd\.textLabel</, 'the text box is named neutrally too');
  assert.doesNotMatch(typed.content, /tasks\.dictation\.textLabel/);
  // Neu zuhoeren und ins Textfeld wechseln behalten die Worte.
  const { panel } = mountSheet({ win, copy: quickAddCopy() });
  instances.at(-1).fail('no-speech');
  instances.at(-1).end();
  panel.click('[data-dictation-mic]');
  assert.equal(panel.querySelector('[data-dictation-status]').textContent, 'quickAdd.listening', 'listening again: still neutral');
  instances.at(-1).fail('network');
  assert.match(panel.host.innerHTML, />quickAdd\.textLabel</, 'the text box after an error: still neutral');
  assert.equal(quickAddCopy().title, 'quickAdd.title');
});

test('sheet words: without words of its own the sheet says a task (the task sheet\'s mic and "Powtórz")', () => {
  const typed = openSheet({ win: {} });
  assert.equal(typed.title, 'tasks.dictation.title');
  assert.match(typed.content, />tasks\.dictation\.textLabel</);
  const { win } = fakeWindow();
  assert.match(openSheet({ win }).content, /tasks\.dictation\.listening/);
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

test('sheet: the mic ring does nothing while Done is pending - the transcript stays', async () => {
  const { win, instances } = fakeWindow();
  const post = () => new Promise(() => {});
  const { panel } = mountSheet({ win, post });
  instances[0].say(['Wyrzuć śmieci', false]);
  panel.click('[data-dictation-done]');
  await flush();
  panel.click('[data-dictation-mic]');
  assert.equal(instances.length, 1, 'no new recognizer');
  assert.equal(panel.querySelector('[data-dictation-transcript]').textContent, 'Wyrzuć śmieci');
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
  for (let i = 0; i < 5; i += 1) await flush();
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
    assert.ok(filled.content.includes('sheet.heardQuote{&quot;text&quot;:&quot;Kupić mleko jutro&quot;}'), 'the heard sentence above the fields');
    assert.match(filled.content, /data-row/, 'set values stand as rows');
    assert.equal(modals.opened.length, 3, 'nothing else opened - and nothing saved');
  } finally {
    modals.restore();
    globalThis.__apiStub = previousApi;
  }
});

/**
 * Ein Blatt, in dem schon gewaehlt wurde: Mariola, faellig am 03.11. um 18:00,
 * eine Erinnerung, eine Notiz und hinter "Mehr" Prioritaet, Kategorie,
 * Sichtbarkeit, Startdatum, Status und Countdown.
 */
function chosenPanel(title = 'Kupić') {
  const panel = taskPanel(title);
  const nodes = {
    '[data-section="due"]': fakeEl({ hidden: false }),
    '#task-due-date': fakeEl({ value: '2026-11-03' }),
    '#task-due-time': fakeEl({ value: '18:00' }),
    '[data-section="reminder"]': fakeEl({ hidden: false }),
    '#task-remind-date': fakeEl({ value: '2026-11-03' }),
    '#task-remind-time': fakeEl({ value: '17:00' }),
    '[data-section="note"]': fakeEl({ hidden: false }),
    '#task-description': fakeEl({ value: 'Tylko bez laktozy' }),
    '#task-priority': fakeEl({ value: 'high' }),
    '#task-category': fakeEl({ value: 'garden' }),
    '#task-visibility': fakeEl({ value: 'assignees' }),
    '#task-start-date': fakeEl({ value: '2026-11-01' }),
    '#task-status': fakeEl({ value: 'in_progress' }),
    '#task-countdown': fakeEl({ checked: true }),
  };
  const own = panel.querySelector;
  panel.querySelector = (sel) => own(sel) ?? nodes[sel] ?? null;
  return panel;
}

/** Das Mikrofon im Titelfeld (oder "Say again"), das Diktat mit `fields` als Antwort; liefert das gefuellte Blatt. */
async function dictateFrom(panelFor, fields, { sayAgain = false } = {}) {
  const modals = captureModals();
  const previousApi = globalThis.__apiStub;
  const previousCategories = tasks.state.categories;
  tasks.state.categories = [{ key: 'household' }, { key: 'garden' }];
  globalThis.__apiStub = { post: async (path) => (path === '/tasks/parse' ? { data: { source: 'ai', fields } } : { data: null }) };
  globalThis.__getSelectedUserIds = () => [MARIOLA.id];
  globalThis.__renderUserMultiSelect = (_people, selected) => `<div data-who="${selected.join(',')}"></div>`;
  globalThis.__rruleValues = { is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY', recurrence_from_completion: 0, valid_until: true };
  globalThis.__renderRRuleFields = (_prefix, rule) => `<div data-rrule="${rule ?? ''}"></div>`;
  try {
    tasks.openTaskModal({ users: MEMBERS, ...(sayAgain ? { draft: { title: 'Kupić' }, spoken: true } : {}) }, null);
    const panel = panelFor();
    modals.opened[0].onSave(panel);
    if (sayAgain) modals.opened[0].headerAction.onClick();
    else for (const fn of panel.mic.listeners.click ?? []) fn({ preventDefault() {} });
    await finishDictation(modals.opened[1], 'Kupić mleko');
    return modals.opened[2]?.content ?? '';
  } finally {
    modals.restore();
    globalThis.__apiStub = previousApi;
    tasks.state.categories = previousCategories;
    delete globalThis.__getSelectedUserIds;
    delete globalThis.__renderUserMultiSelect;
    delete globalThis.__rruleValues;
    delete globalThis.__renderRRuleFields;
  }
}

const selectedOption = (html, id) => html.match(new RegExp(`<select[^>]*id="${id}"[\\s\\S]*?</select>`))?.[0]
  .match(/<option value="([^"]*)"\s+selected/)?.[1] ?? null;
const valueIn = (html, id) => html.match(new RegExp(`<[a-z-]+\\b[^>]*id="${id}"[^>]*>`))?.[0].match(/\svalue="([^"]*)"/)?.[1] ?? null;

// F9: das Mikrofon im Titelfeld fuellt, was der Satz sagt - und laesst stehen,
// was schon gewaehlt war und der Satz nicht beruehrt.
test('the title mic keeps what was chosen and the sentence does not set: who, due, reminder, note and More', async () => {
  const html = await dictateFrom(() => chosenPanel(), { ...EMPTY, title: 'Kupić mleko' });
  assert.match(html, /value="Kupić mleko"/, 'the sentence is the title');
  assert.match(html, /data-who="2"/, 'Mariola stays chosen');
  assert.equal(valueIn(html, 'task-due-date'), '2026-11-03');
  assert.equal(valueIn(html, 'task-due-time'), '18:00');
  assert.equal(valueIn(html, 'task-remind-date'), '2026-11-03');
  assert.equal(valueIn(html, 'task-remind-time'), '17:00');
  assert.match(html, />Tylko bez laktozy<\/textarea>/, 'the note stays');
  assert.equal(selectedOption(html, 'task-priority'), 'high');
  assert.equal(selectedOption(html, 'task-category'), 'garden');
  assert.equal(selectedOption(html, 'task-visibility'), 'assignees');
  assert.equal(selectedOption(html, 'task-status'), 'in_progress');
  assert.equal(valueIn(html, 'task-start-date'), '2026-11-01');
  assert.match(html, /id="task-countdown"[^>]*checked/);
  assert.match(html, /data-rrule="FREQ=WEEKLY"/, 'the repeat stays');
});

test('the title mic: what the sentence DOES set wins over the sheet', async () => {
  const html = await dictateFrom(() => chosenPanel(), {
    ...EMPTY, title: 'Kupić mleko', due_date: '2026-10-30', remind_date: '2026-10-30', remind_time: '07:30', assigned_to: [WOJTEK.id],
  });
  assert.match(html, /data-who="1"/);
  assert.equal(valueIn(html, 'task-due-date'), '2026-10-30');
  assert.equal(valueIn(html, 'task-due-time'), '', 'a said day brings its own (empty) time');
  assert.equal(valueIn(html, 'task-remind-time'), '07:30');
  assert.equal(selectedOption(html, 'task-priority'), 'high', 'More is never said - it stays');
});

test('the title mic: a folded-away section is not carried (it holds nothing)', async () => {
  const html = await dictateFrom(() => {
    const panel = chosenPanel();
    const own = panel.querySelector;
    const folded = fakeEl({ hidden: true });
    panel.querySelector = (sel) => (['[data-section="due"]', '[data-section="reminder"]', '[data-section="note"]'].includes(sel) ? folded : own(sel));
    return panel;
  }, { ...EMPTY, title: 'Kupić mleko' });
  assert.equal(valueIn(html, 'task-due-date'), '');
  assert.doesNotMatch(html, /Tylko bez laktozy/);
});

test('"Say again" still replaces the sheet: nothing chosen before is carried', async () => {
  const html = await dictateFrom(() => chosenPanel(), { ...EMPTY, title: 'Kupić mleko' }, { sayAgain: true });
  assert.match(html, /value="Kupić mleko"/);
  assert.match(html, /data-who=""/, 'nobody chosen');
  assert.equal(valueIn(html, 'task-due-date'), '');
  assert.equal(selectedOption(html, 'task-priority'), 'none');
  assert.doesNotMatch(html, /Tylko bez laktozy/);
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
    tasks.openTaskModal({ users: MEMBERS, draft: { title: 'Wyrzuć smieci' }, spoken: true, heard: 'Wyrzuć smieci' }, null);
    const [sheet] = modals.opened;
    assert.equal(typeof sheet.headerAction?.onClick, 'function', '"Say again" is wired');
    const panel = taskPanel('Wyrzuć smieci');
    sheet.onSave(panel);
    sheet.headerAction.onClick();
    const dictation = modals.opened[1];
    assert.equal(dictation?.title, 'tasks.dictation.title', 'the task sheet keeps the task words');
    await finishDictation(dictation, 'Wyrzuć śmieci w piątek');
    const filled = modals.opened[2]?.content ?? '';
    assert.match(filled, /value="Wyrzuć śmieci"/);
    assert.ok(filled.includes('sheet.heardQuote{&quot;text&quot;:&quot;Wyrzuć śmieci w piątek&quot;}'), 'the NEW sentence is the one heard');
    assert.doesNotMatch(filled, /Wyrzuć smieci/, 'not the old one');
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

// --------------------------------------------------------------------------
// Von aussen (Heute "+"): das Hoerblatt geht IM TIPP auf - Helfer fuer "Say it" unten
// --------------------------------------------------------------------------

/** Ein Erkenner, der sich merkt, ob start() noch vor der ersten Mikroaufgabe lief. */
function syncProbe() {
  const { win, instances } = fakeWindow();
  const probe = { microtask: false, startedInCall: null };
  const Base = win.webkitSpeechRecognition;
  win.webkitSpeechRecognition = class extends Base {
    start() { probe.startedInCall = !probe.microtask; super.start(); }
  };
  queueMicrotask(() => { probe.microtask = true; });
  return { win, instances, probe };
}

/** openModal wie das echte: onSave laeuft synchron in openModal. */
function syncModals() {
  const opened = [];
  const previous = globalThis.__openModal;
  globalThis.__openModal = (options) => {
    const panel = dictationPanel(options.content ?? '');
    opened.push({ options, panel });
    options.onSave?.(panel);
  };
  return { opened, restore() { globalThis.__openModal = previous; } };
}

/** Ein Ersatz fuer pages/tasks.js, dessen Vorbereitung der Test aufloest. */
function fakeTasksModule() {
  const sheets = [];
  let resolvePrep;
  let rejectPrep;
  const prep = new Promise((resolve, reject) => { resolvePrep = resolve; rejectPrep = reject; });
  const mod = {
    prepareNewTask: () => prep,
    openPreparedNewTask: (opts) => { sheets.push(opts); },
  };
  return { mod, sheets, resolvePrep, rejectPrep };
}

test('the listening sheet is styled off the Tasks page too: its rules live in layout.css, linked by index.html', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.match(read('../public/index.html'), /<link rel="stylesheet" href="\/styles\/layout\.css"/);
  const layout = read('../public/styles/layout.css');
  for (const cls of ['.dictation__body', '.dictation__transcript', '.dictation__mic', '.dictation__mic-core', '.dictation__footer']) {
    assert.ok(layout.includes(`${cls} {`) || layout.includes(`${cls},`), `${cls} in layout.css`);
  }
  // tasks.css ist ein Seitenblatt: abseits von /tasks steht es auf inaktiv,
  // bis ensureTaskStyles es holt - zu spaet fuer ein Blatt, das im Tipp aufgeht.
  assert.doesNotMatch(read('../public/styles/tasks.css'), /\.dictation/);
});

// --------------------------------------------------------------------------
// "Say it" (One Today, Task 14): ein Satz wird Aufgabe, Termin oder Einkauf
// --------------------------------------------------------------------------

const ALL_WRITE = { tasks: 'write', calendar: 'write', shopping: 'write' };
const aiAnswer = (kind, fields) => ({ data: { source: 'ai', kind, fields } });
const EVENT_FIELDS = {
  title: 'Trening Leo', date: '2026-11-05', start_time: '17:00', end_time: null, all_day: false,
  location: null, assigned_to: [], reminder_minutes: null,
};

/** Ersatz fuer pages/calendar.js und components/shopping-add-sheet.js: merkt Ladevorgaenge und Oeffnungen. */
function fakeSheetModules({ opened = true } = {}) {
  const loads = [];
  const events = [];
  const shopping = [];
  const calendar = { openNewEventFrom: async (opts) => { events.push(opts); return opened; } };
  const sheet = { openShoppingAddFrom: async (opts) => { shopping.push(opts); return opened; } };
  return {
    loads, events, shopping,
    loadCalendar: async () => { loads.push('calendar'); return calendar; },
    loadShopping: async () => { loads.push('shopping'); return sheet; },
  };
}

/** "Say it" starten, den Satz sagen, "Done" tippen und warten, bis geroutet ist. */
async function sayIt(sentence, { access = ALL_WRITE, answer = DISABLED, user = WOJTEK, onChanged = () => {}, sheets = fakeSheetModules(), prep = MEMBERS } = {}) {
  const { win, instances } = fakeWindow();
  const modals = syncModals();
  const tasksModule = fakeTasksModule();
  const loadedTasks = [];
  const { calls, post } = recordingPost(answer);
  try {
    const opened = startQuickAdd({ user, onChanged, access }, {
      win, post,
      loadTasks: async () => { loadedTasks.push('tasks'); return tasksModule.mod; },
      loadCalendar: sheets.loadCalendar,
      loadShopping: sheets.loadShopping,
    });
    assert.equal(opened, true, 'the listening sheet opened');
    if (prep instanceof Error) tasksModule.rejectPrep(prep);
    else tasksModule.resolvePrep(prep);
    instances[0].say([sentence, true]);
    modals.opened[0].panel.click('[data-dictation-done]');
    for (let i = 0; i < 10; i += 1) await flush();
  } finally {
    modals.restore();
  }
  return { calls, tasks: tasksModule.sheets, loadedTasks, sheets, modals };
}

test('startQuickAdd: the listening sheet opens with neutral words and rec.start() runs inside the call - before any await', () => {
  const { win, instances, probe } = syncProbe();
  const modals = syncModals();
  try {
    const opened = startQuickAdd({ access: ALL_WRITE }, { win, loadTasks: () => new Promise(() => {}) });
    assert.equal(opened, true);
    assert.equal(modals.opened.length, 1, 'openModal ran in the call');
    assert.equal(modals.opened[0].options.title, 'quickAdd.title', '"Powiedz" - not "Powiedz zadanie"');
    assert.match(modals.opened[0].options.content, /quickAdd\.listening/);
    assert.equal(instances.length, 1);
    assert.equal(instances[0].lang, 'pl-PL');
    assert.equal(probe.startedInCall, true, 'start() ran before the first microtask - still inside the tap');
  } finally {
    modals.restore();
  }
});

test('startQuickAdd: nothing it could add (or no rights given) opens nothing - no sheet, no mic', () => {
  const { win, instances } = fakeWindow();
  const modals = syncModals();
  try {
    const never = () => { throw new Error('not loaded'); };
    assert.equal(startQuickAdd({ access: { tasks: 'read', calendar: 'none', shopping: 'read' } }, { win, loadTasks: never }), false);
    assert.equal(startQuickAdd({ access: { meals: 'write' } }, { win, loadTasks: never }), false);
    assert.equal(startQuickAdd({}, { win, loadTasks: never }), false);
    assert.equal(modals.opened.length, 0);
    assert.equal(instances.length, 0, 'no mic');
  } finally {
    modals.restore();
  }
});

test('startQuickAdd: an event sentence opens the event sheet - spoken, with the heard sentence; one parse call, nothing saved', async () => {
  const user = WOJTEK;
  const onChanged = () => {};
  const sentence = 'Trening Leo w czwartek o 17';
  const { calls, tasks: taskSheets, sheets } = await sayIt(sentence, { answer: aiAnswer('event', EVENT_FIELDS), user, onChanged });
  assert.deepEqual(calls, [{ path: '/quick-add/parse', body: { text: sentence } }], 'once, the kind left to the router');
  const [{ stillWanted, ...event }] = sheets.events;
  assert.deepEqual([event], [{ user, onChanged, draft: EVENT_FIELDS, spoken: true, heard: sentence }]);
  assert.equal(typeof stillWanted, 'function', 'the opener can ask whether the listening sheet still stands');
  assert.deepEqual(sheets.shopping, []);
  assert.deepEqual(taskSheets, [], 'no task sheet');
});

test('startQuickAdd: a shopping sentence opens the shopping sheet with the spoken items and the heard sentence', async () => {
  const user = WOJTEK;
  const onChanged = () => {};
  const fields = { items: [{ name: 'mleko', quantity: null }, { name: 'chleb', quantity: null }] };
  const { sheets, tasks: taskSheets } = await sayIt('Kup mleko i chleb', { answer: aiAnswer('shopping', fields), user, onChanged });
  const [{ stillWanted, ...shopping }] = sheets.shopping;
  assert.deepEqual([shopping], [{ user, onChanged, draft: fields, heard: 'Kup mleko i chleb' }]);
  assert.equal(typeof stillWanted, 'function');
  assert.deepEqual(sheets.events, []);
  assert.deepEqual(taskSheets, []);
});

test('startQuickAdd: without AI a buying sentence is still shopping (the local rule), never an event', async () => {
  const { sheets, calls } = await sayIt('Kup mleko, chleb');
  assert.equal(calls.length, 1);
  assert.deepEqual(sheets.shopping[0].draft, { items: [{ name: 'mleko', quantity: null }, { name: 'chleb', quantity: null }] });
  assert.equal(sheets.shopping[0].heard, 'Kup mleko, chleb');
});

test('startQuickAdd: a task sentence opens the New Task sheet - spoken, heard; the members reached the local parser', async () => {
  const onChanged = () => {};
  const { tasks: taskSheets, sheets } = await sayIt('Wojtek odbierze paczkę jutro', { onChanged });
  assert.equal(taskSheets.length, 1);
  assert.equal(taskSheets[0].onChanged, onChanged);
  assert.equal(taskSheets[0].spoken, true);
  assert.equal(taskSheets[0].heard, 'Wojtek odbierze paczkę jutro');
  assert.deepEqual(taskSheets[0].draft.assigned_to, [WOJTEK.id], 'the members arrived before the local parser ran');
  assert.deepEqual(sheets.loads, [], 'no other sheet loaded');
});

test('startQuickAdd: calendar read only + an event sentence -> the task sheet with the sentence as its title, no calendar', async () => {
  const sentence = 'Trening Leo w czwartek o 17';
  const { tasks: taskSheets, sheets } = await sayIt(sentence, {
    access: { tasks: 'write', calendar: 'read', shopping: 'write' }, answer: aiAnswer('event', EVENT_FIELDS),
  });
  assert.deepEqual(taskSheets.map(({ draft, spoken, heard }) => ({ draft, spoken, heard })),
    [{ draft: { title: sentence }, spoken: true, heard: sentence }]);
  assert.deepEqual(sheets.loads, [], 'the calendar is never loaded - nothing is written there');
  assert.deepEqual(sheets.events, []);
});

test('startQuickAdd: shopping read only + a buying sentence -> the task sheet with the sentence as its title', async () => {
  const { tasks: taskSheets, sheets } = await sayIt('Kup mleko, chleb', { access: { tasks: 'write', calendar: 'write', shopping: 'read' } });
  assert.deepEqual(taskSheets.map(({ draft }) => draft), [{ title: 'Kup mleko, chleb' }]);
  assert.deepEqual(sheets.shopping, []);
});

test('startQuickAdd: a sentence as title is clipped where the server stops (200); the heard line keeps it whole', async () => {
  const sentence = `Kup ${'mleko, chleb, '.repeat(20)}masło`;
  assert.ok(sentence.length > 200);
  const { tasks: taskSheets } = await sayIt(sentence, { access: { tasks: 'write', calendar: 'write', shopping: 'read' } });
  assert.equal(taskSheets[0].draft.title, sentence.slice(0, 200));
  assert.equal(taskSheets[0].heard, sentence);
});

test('startQuickAdd: a kind nobody here may write, and no tasks either -> a short message, the listening sheet goes, nothing opens', async () => {
  const toasts = [];
  const closes = [];
  const previousToast = globalThis.window.yuvomi.showToast;
  globalThis.window.yuvomi.showToast = (...args) => toasts.push(args);
  globalThis.__closeModal = (opts) => { closes.push(opts); };
  try {
    const { tasks: taskSheets, sheets, loadedTasks } = await sayIt('Zadzwonić do mamy', {
      access: { tasks: 'read', calendar: 'none', shopping: 'write' },
    });
    assert.deepEqual(toasts, [['quickAdd.noAccess', 'info']]);
    assert.deepEqual(closes, [{ force: true, context: 'test-modal-context' }], 'only the listening sheet it opened (#1997)');
    assert.deepEqual(taskSheets, []);
    assert.deepEqual(sheets.loads, []);
    assert.deepEqual(loadedTasks, [], 'tasks are not even loaded without write access');
  } finally {
    delete globalThis.__closeModal;
    globalThis.window.yuvomi.showToast = previousToast;
  }
});

test('startQuickAdd: a sheet that opens nothing (no shopping list) lets the listening sheet go', async () => {
  const closes = [];
  globalThis.__closeModal = (opts) => { closes.push(opts); };
  try {
    const sheets = fakeSheetModules({ opened: false });
    await sayIt('Kup mleko', { answer: aiAnswer('shopping', { items: [{ name: 'mleko', quantity: null }] }), sheets });
    assert.equal(sheets.shopping.length, 1, 'the opener was asked');
    assert.deepEqual(closes, [{ force: true, context: 'test-modal-context' }], 'it said why itself; the listening sheet goes');
  } finally {
    delete globalThis.__closeModal;
  }
});

test('startQuickAdd: a shopping sentence still opens its sheet when the task page cannot load', async () => {
  const { sheets, tasks: taskSheets } = await sayIt('Kup mleko', {
    answer: aiAnswer('shopping', { items: [{ name: 'mleko', quantity: null }] }), prep: new Error('tasks.loadError'),
  });
  assert.equal(sheets.shopping.length, 1);
  assert.deepEqual(taskSheets, []);
});

test('startQuickAdd: the listening sheet was closed while the sheet loaded - nothing opens', async () => {
  const { win, instances } = fakeWindow();
  const modals = syncModals();
  const sheets = fakeSheetModules();
  let open = true;
  globalThis.__isOwnModalOpen = () => open;
  const { post } = recordingPost(aiAnswer('event', EVENT_FIELDS));
  const tasksModule = fakeTasksModule();
  tasksModule.resolvePrep(MEMBERS);
  try {
    startQuickAdd({ access: ALL_WRITE }, {
      win, post, loadTasks: async () => tasksModule.mod,
      loadCalendar: async () => { open = false; return sheets.loadCalendar(); },
      loadShopping: sheets.loadShopping,
    });
    instances[0].say(['Trening Leo w czwartek o 17', true]);
    modals.opened[0].panel.click('[data-dictation-done]');
    for (let i = 0; i < 10; i += 1) await flush();
    assert.deepEqual(sheets.loads, ['calendar'], 'precondition: the draft was routed to the calendar');
    assert.deepEqual(sheets.events, [], 'swiped away: no sheet afterwards');
  } finally {
    delete globalThis.__isOwnModalOpen;
    modals.restore();
  }
});

// M6 (final review): the check above runs before the opener; the opener
// still fetches (slow network) and must not open once the listening sheet is
// gone. startQuickAdd hands each opener a `stillWanted` that says so.
test('startQuickAdd: closed while the event or shopping sheet fetches its data - the opener is told, nothing opens', async () => {
  for (const [kind, fields, sentence] of [
    ['event', EVENT_FIELDS, 'Trening Leo w czwartek o 17'],
    ['shopping', { items: [{ name: 'mleko', quantity: null }] }, 'kup mleko'],
  ]) {
    const { win, instances } = fakeWindow();
    const modals = syncModals();
    let open = true;
    globalThis.__isOwnModalOpen = () => open;
    const closes = [];
    globalThis.__closeModal = (opts) => { closes.push(opts); };
    let arrive;
    const slow = new Promise((resolve) => { arrive = resolve; });
    const seen = [];
    /** An opener like the real ones: fetch first (slow), then ask whether it is still wanted. */
    const slowOpener = async (opts) => {
      seen.push(opts);
      await slow;
      if (opts.stillWanted && !opts.stillWanted()) return false;
      return true;
    };
    const { post } = recordingPost(aiAnswer(kind, fields));
    const tasksModule = fakeTasksModule();
    tasksModule.resolvePrep(MEMBERS);
    try {
      startQuickAdd({ access: ALL_WRITE }, {
        win, post, loadTasks: async () => tasksModule.mod,
        loadCalendar: async () => ({ openNewEventFrom: slowOpener }),
        loadShopping: async () => ({ openShoppingAddFrom: slowOpener }),
      });
      instances[0].say([sentence, true]);
      modals.opened[0].panel.click('[data-dictation-done]');
      for (let i = 0; i < 10; i += 1) await flush();
      assert.equal(seen.length, 1, `${kind}: precondition, the opener is fetching`);
      assert.equal(typeof seen[0].stillWanted, 'function', `${kind}: the opener can ask`);
      assert.equal(seen[0].stillWanted(), true, `${kind}: wanted while the listening sheet stands`);
      open = false; // swiped away while the data loads
      assert.equal(seen[0].stillWanted(), false, `${kind}: not wanted once it is gone`);
      arrive();
      for (let i = 0; i < 6; i += 1) await flush();
      assert.equal(modals.opened.length, 1, `${kind}: nothing opened after the listening sheet`);
    } finally {
      delete globalThis.__isOwnModalOpen;
      delete globalThis.__closeModal;
      modals.restore();
    }
  }
});

test('startQuickAdd: Type instead opens the New Task sheet to type in, with what was said as its title', async () => {
  const { win, instances } = fakeWindow();
  const modals = syncModals();
  const { mod, sheets: taskSheets, resolvePrep } = fakeTasksModule();
  try {
    startQuickAdd({ access: ALL_WRITE }, { win, loadTasks: async () => mod });
    instances[0].say(['Zadzwonić do mamy', false]);
    modals.opened[0].panel.click('[data-dictation-type]');
    assert.equal(instances[0].aborted, 1, 'the mic stops at once');
    resolvePrep(MEMBERS);
    for (let i = 0; i < 4; i += 1) await flush();
    assert.deepEqual(taskSheets, [{ onChanged: taskSheets[0].onChanged, draft: { title: 'Zadzwonić do mamy' } }], 'typed, not spoken');
  } finally {
    modals.restore();
  }
});

test('startQuickAdd: Type instead without tasks opens the first sheet that may be written, with what was said', async () => {
  const { win, instances } = fakeWindow();
  const modals = syncModals();
  const sheets = fakeSheetModules();
  const user = WOJTEK;
  try {
    startQuickAdd({ user, access: { tasks: 'read', calendar: 'write', shopping: 'write' } }, {
      win, loadTasks: () => { throw new Error('not loaded'); }, loadCalendar: sheets.loadCalendar, loadShopping: sheets.loadShopping,
    });
    instances[0].say(['Basen w niedzielę', false]);
    modals.opened[0].panel.click('[data-dictation-type]');
    for (let i = 0; i < 6; i += 1) await flush();
    assert.equal(sheets.events.length, 1);
    assert.equal(sheets.events[0].user, user);
    assert.deepEqual(sheets.events[0].draft, { title: 'Basen w niedzielę' });
    assert.equal(sheets.events[0].spoken, undefined, 'typed, not spoken');
  } finally {
    modals.restore();
  }
});

test('startQuickAdd: Done keeps turning until the next sheet stands (it loads only now)', async () => {
  const { win, instances } = fakeWindow();
  const modals = syncModals();
  const steps = [];
  globalThis.__btnLoading = () => { steps.push('busy'); return () => steps.push('idle'); };
  let release;
  const calendar = { openNewEventFrom: async () => { steps.push('opened'); return true; } };
  const { post } = recordingPost(aiAnswer('event', EVENT_FIELDS));
  const tasksModule = fakeTasksModule();
  tasksModule.resolvePrep(MEMBERS);
  try {
    startQuickAdd({ access: ALL_WRITE }, {
      win, post, loadTasks: async () => tasksModule.mod,
      loadCalendar: () => new Promise((resolve) => { release = () => resolve(calendar); }),
    });
    instances[0].say(['Trening Leo w czwartek o 17', true]);
    modals.opened[0].panel.click('[data-dictation-done]');
    for (let i = 0; i < 6; i += 1) await flush();
    assert.deepEqual(steps, ['busy'], 'the answer is in, the calendar still loads: Done still turns');
    release();
    for (let i = 0; i < 6; i += 1) await flush();
    assert.deepEqual(steps, ['busy', 'opened', 'idle']);
  } finally {
    delete globalThis.__btnLoading;
    modals.restore();
  }
});

test('source: the event and shopping mics pass the neutral words; the task sheet keeps its own', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  for (const file of ['../public/pages/calendar.js', '../public/components/shopping-add-sheet.js']) {
    const src = read(file);
    assert.match(src, /openDictationSheet\(\{[\s\S]{0,400}?copy: quickAddCopy\(\),/, `${file}: neutral words`);
  }
  const tasksSrc = read('../public/pages/tasks.js');
  const over = tasksSrc.slice(tasksSrc.indexOf('async function dictateOverSheet('));
  assert.doesNotMatch(over.slice(0, over.indexOf('\n}\n')), /copy:/, 'the task sheet says a task');
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
