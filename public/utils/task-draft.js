/**
 * Modul: Ein gesprochener Satz wird zum Entwurf einer Aufgabe (Quick-Add, 2026-10-29)
 * Zweck: Der Satz geht EINMAL an `POST /tasks/parse` (Haiku, server/services/
 *        task-dictation.js); die Antwort fuellt das Blatt "Neue Aufgabe". Ist
 *        die KI aus, ohne Schluessel, am Limit, scheitert sie oder fehlt das
 *        Netz, fuellt der lokale polnische Parser (utils/capture-parse.js), was
 *        er kann. Die Person landet IMMER im gefuellten Blatt und prueft dort -
 *        gespeichert wird hier nichts.
 *
 * Der Entwurf hat genau die Schluessel, die openTaskModal({ draft }) kennt:
 *   { title, due_date, due_time, remind_date, remind_time, assigned_to }.
 *
 * Lokale Regeln (test:task-dictation-ui), wo moeglich dieselben wie am Server:
 *   - ein fuehrendes "Dodaj zadanie" ist Fuellwort und faellt weg;
 *   - findet der Parser nur einen Titel, ist der ganze Satz der Titel - der
 *     Parser liest sonst etwa "obiad" als Mahlzeit und nimmt es heraus;
 *   - Daten in der Zone des Haushalts, nicht des Geraets;
 *   - eine Uhrzeit ohne Tag faellt weg (wie am Server);
 *   - "…, ustaw przypomnienie na jutro 7:30": die Zeitangabe hinter
 *     "przypomnienie" ist die Erinnerung, nicht die Faelligkeit. Ein Tag ohne
 *     Stunde erinnert um 09:00, eine Stunde ohne Tag am Faelligkeitstag oder
 *     heute - die Regeln des Server-Prompts.
 */
import { api } from '/api.js';
import { parseCapture } from '/utils/capture-parse.js';
import { nowFields, todayKey } from '/utils/timezone.js';

/** Fuellwort am Satzanfang ("Dodaj zadanie: ..."). */
const LEADING_FILLER = /^\s*dodaj\s+(?:nowe\s+)?zadanie\b[\s,:;.-]*/iu;
/** Der Erinnerungsteil eines Satzes und was danach kommt ("…, ustaw przypomnienie na jutro 7:30"). */
const REMINDER_CLAUSE = /[\s,;]*(?:\b(?:i|oraz)\s+)?(?:\bustaw\s+)?\bprzypomnienie\b(.*)$/isu;
/** Uhrzeit einer Erinnerung, die nur einen Tag nennt (wie der Server-Prompt). */
const DAY_ONLY_REMINDER_TIME = '09:00';

const blankDraft = () => ({
  title: '', due_date: null, due_time: null, remind_date: null, remind_time: null, assigned_to: [],
});

/** Gross am Anfang, ohne Satzpunkt am Ende, ohne doppelte Leerzeichen. */
function tidyTitle(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim().replace(/[\s.,;:]+$/u, '');
  return s ? s.charAt(0).toLocaleUpperCase('pl') + s.slice(1) : '';
}

/**
 * Ein `Date`, dessen LOKALE Felder die Wanduhr des Haushalts sind - der Parser
 * rechnet mit `getHours()` & Co., und "jutro" soll der morgige Tag des
 * Haushalts sein, nicht der des Geraets.
 */
function householdWallClock(now) {
  const f = nowFields(now);
  return f ? new Date(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) : now;
}

function localDraft(sentence, { members, now }) {
  const wallNow = householdWallClock(now);
  const text = sentence.replace(LEADING_FILLER, '');
  const clause = REMINDER_CLAUSE.exec(text);
  const main = clause ? text.slice(0, clause.index) : text;
  const opts = { now: wallNow, members, type: 'task' };
  const parsed = parseCapture(main, opts);

  const draft = blankDraft();
  if (parsed.date) {
    draft.due_date = parsed.date;
    draft.due_time = parsed.time ?? null;
  }
  if (parsed.assignee?.id != null) draft.assigned_to = [parsed.assignee.id];
  if (clause) {
    const when = parseCapture(clause[1], { ...opts, members: [] });
    if (when.date || when.time) {
      draft.remind_date = when.date ?? draft.due_date ?? todayKey(now);
      draft.remind_time = when.time ?? DAY_ONLY_REMINDER_TIME;
    }
  }

  const foundMore = draft.due_date || draft.assigned_to.length || draft.remind_date;
  draft.title = tidyTitle(foundMore ? parsed.title : main) || tidyTitle(main) || tidyTitle(sentence);
  return draft;
}

/**
 * @param {string} text - der Satz, wie die Erkennung oder die Tastatur ihn lieferte
 * @param {{members?: Array<{id: number, display_name: string}>, now?: Date,
 *          post?: (path: string, body: object) => Promise<any>}} [opts]
 * @returns {Promise<{draft: object, source: 'ai'|'local'}>}
 */
export async function draftFromSentence(text, { members = [], now = new Date(), post = (path, body) => api.post(path, body) } = {}) {
  const sentence = String(text ?? '').trim();
  try {
    const res = await post('/tasks/parse', { text: sentence });
    const data = res?.data;
    if (data?.source === 'ai' && data.fields && typeof data.fields === 'object') {
      return { source: 'ai', draft: { ...data.fields } };
    }
  } catch { /* KI nicht erreichbar - der lokale Parser fuellt */ }
  try {
    return { source: 'local', draft: localDraft(sentence, { members, now }) };
  } catch {
    return { source: 'local', draft: { ...blankDraft(), title: tidyTitle(sentence) } };
  }
}
