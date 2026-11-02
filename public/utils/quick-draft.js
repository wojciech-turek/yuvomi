/**
 * Modul: Ein Satz wird zum Entwurf - Aufgabe, Termin oder Einkauf (One Today, Task 9)
 * Zweck: Der Satz geht EINMAL an `POST /quick-add/parse` (Haiku, ein Aufruf).
 *        Die Antwort sagt, was er ist (`kind`), und liefert die Felder dazu.
 *        Ist die KI aus, am Limit, nicht erreichbar oder nach `timeoutMs`
 *        still, entscheidet eine lokale Regel - sie kennt nie einen Termin:
 *          - Einkauf, wenn der Satz mit einem Kaufwort beginnt ("kup",
 *            "dodaj do zakupow", "na liste") oder eine Kommaliste kurzer
 *            Posten ohne Datum, Uhrzeit und Person ist;
 *          - sonst eine Aufgabe ueber `localDraft` (utils/task-draft.js).
 *        Ein erzwungenes `kind: 'event'` ohne KI gibt eine Aufgabe mit dem
 *        Satz als Titel: Termine braucht die KI.
 *        Gespeichert wird hier nichts; die Person landet im gefuellten Blatt.
 *        Genutzt von den Mikrofonen der Blaetter und von "Say it".
 *
 * Entwurf je Art (wie die Blaetter ihn kennen):
 *   task:     { title, due_date, due_time, remind_date, remind_time, assigned_to }
 *   event:    { title, date, start_time, end_time, all_day, location, assigned_to, reminder_minutes }
 *   shopping: { items: [{ name, quantity }] }
 */
import { api } from '/api.js';
import { parseCapture } from '/utils/capture-parse.js';
import { splitSpokenItems } from '/utils/shopping-entry.js';
import { localDraft, DICTATION_TIMEOUT_MS } from '/utils/task-draft.js';

const KINDS = ['task', 'event', 'shopping'];
const TITLE_MAX = 200;

/** Kaufwort am Satzanfang: "kup", "kupić", "kupcie", "dodaj do zakupów/listy", "na listę". */
const BUYING_WORD = /^\s*(?:kup(?:ić|ic|cie)?|dodaj\s+do\s+(?:zakup(?:ów|ow)|listy)|na\s+list(?:ę|e))(?=$|[\s,:;.!?])[\s,:;.-]*/iu;
/** Ein Posten der Kommaliste: ein bis drei Woerter. */
const SHORT_ITEM = /^\S+(?:\s+\S+){0,2}$/u;
/** Ein Infinitiv ("zadzwonić", "wyrzucić") ist ein Verb - keine Einkaufsliste. */
const INFINITIVE = /\p{L}+ć$/iu;

function taskTitleOnly(sentence) {
  return {
    title: sentence.slice(0, TITLE_MAX), due_date: null, due_time: null, remind_date: null, remind_time: null, assigned_to: [],
  };
}

/** Die lokale Regel: Einkauf oder Aufgabe - nie ein Termin. */
function localKindAndDraft(sentence, kind, { members, now }) {
  const shopping = () => {
    const items = splitSpokenItems(sentence.replace(BUYING_WORD, ''));
    return items.length ? { kind: 'shopping', draft: { items }, source: 'local' } : null;
  };
  if (kind === 'shopping') {
    const forced = shopping();
    if (forced) return forced;
  } else if (!kind) {
    if (BUYING_WORD.test(sentence)) {
      const bought = shopping();
      if (bought) return bought;
    } else if (/,/.test(sentence)) {
      const parts = sentence.split(/\s*,\s*|\s+(?:i|oraz)\s+/iu).filter(Boolean);
      const plainList = parts.length >= 2
        && parts.every((part) => SHORT_ITEM.test(part.trim()) && !INFINITIVE.test(part.trim().split(/\s+/)[0]));
      if (plainList) {
        const read = parseCapture(sentence, { members, type: 'task' });
        if (!read.date && !read.time && read.assignee?.id == null) {
          const listed = shopping();
          if (listed) return listed;
        }
      }
    }
  }
  if (kind === 'event') return { kind: 'task', draft: taskTitleOnly(sentence), source: 'local' };
  try {
    return { kind: 'task', draft: localDraft(sentence, { members, now }), source: 'local' };
  } catch {
    return { kind: 'task', draft: taskTitleOnly(sentence), source: 'local' };
  }
}

/**
 * @param {string} text - der Satz, wie die Erkennung oder die Tastatur ihn lieferte
 * @param {{members?: Array<{id: number, display_name: string}>, now?: Date,
 *          post?: (path: string, body: object, opts?: {signal?: AbortSignal}) => Promise<any>,
 *          timeoutMs?: number, kind?: 'task'|'event'|'shopping'|null}} [opts]
 *        `kind` erzwingt die Art (das Mikrofon eines Blatts weiss, was es ist).
 * @returns {Promise<{kind: 'task'|'event'|'shopping', draft: object, source: 'ai'|'local'}>}
 */
export async function quickDraftFromSentence(text, {
  members = [], now = new Date(), post = (path, body, opts) => api.post(path, body, opts),
  timeoutMs = DICTATION_TIMEOUT_MS, kind = null,
} = {}) {
  const sentence = String(text ?? '').trim();
  const forced = KINDS.includes(kind) ? kind : null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  try {
    const body = forced ? { text: sentence, kind: forced } : { text: sentence };
    const answer = Promise.resolve(post('/quick-add/parse', body, controller ? { signal: controller.signal } : {}));
    // Nach dem Abbruch scheitert die Anfrage noch - das hoert hier niemand mehr.
    answer.catch(() => {});
    // Das Rennen, nicht nur das Signal: auch ein `post`, das den Abbruch nicht
    // kennt, haelt das Blatt nicht auf.
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new Error('quick-add timeout'));
      }, timeoutMs);
    });
    const res = await Promise.race([answer, late]);
    const data = res?.data;
    if (data?.source === 'ai' && KINDS.includes(data.kind) && data.fields && typeof data.fields === 'object') {
      return { kind: data.kind, draft: { ...data.fields }, source: 'ai' };
    }
  } catch { /* KI nicht erreichbar oder zu langsam - die lokale Regel entscheidet */ } finally {
    clearTimeout(timer);
  }
  return localKindAndDraft(sentence, forced, { members, now });
}
