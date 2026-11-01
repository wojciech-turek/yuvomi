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
 * Lokale Regeln (test:task-dictation-ui), wo moeglich dieselben wie am Server.
 * DER BODEN: schlimmstenfalls ist der Satz der Titel. Aus dem Titel faellt nur,
 * was als Datum, Uhrzeit, Person oder Erinnerung gelesen wurde.
 *   - ein fuehrendes "Dodaj zadanie" ist Fuellwort und faellt weg;
 *   - findet der Parser nur einen Titel, ist der ganze Satz der Titel;
 *   - Mahlzeit-Woerter ("obiad", "kolację") nimmt der Parser auch bei
 *     `type: 'task'` heraus - dann wird der Titel aus dem Satz gebaut, ohne nur
 *     die Spannen von Datum, Uhrzeit und Person;
 *   - Daten in der Zone des Haushalts, nicht des Geraets;
 *   - eine Uhrzeit ohne Tag faellt weg (wie am Server);
 *   - "… ustaw przypomnienie na jutro 7:30", "… przypomnij mi o 8",
 *     "…, przypomnienie jutro": ist die Angabe dahinter NUR eine Zeit, ist sie
 *     die Erinnerung, nicht die Faelligkeit. Ein Tag ohne Stunde erinnert um
 *     09:00, eine Stunde ohne Tag am Faelligkeitstag oder heute - ist sie
 *     heute schon vorbei, morgen (R16) - die Regeln des Servers. Alles andere
 *     ("Wyślij przypomnienie do przedszkola") bleibt Teil des Titels.
 */
import { api } from '/api.js';
import { parseCapture } from '/utils/capture-parse.js';
import { nowFields, todayKey } from '/utils/timezone.js';

/** Fuellwort am Satzanfang ("Dodaj zadanie: ..."). */
const LEADING_FILLER = /^\s*dodaj\s+(?:nowe\s+)?zadanie\b[\s,:;.-]*/iu;
/**
 * Der Wunsch nach einer Erinnerung hinter der Aufgabe: "ustaw/dodaj
 * przypomnienie", "przypomnij (mi)" - oder das nackte "przypomnienie", dann
 * aber nur hinter Komma, Semikolon oder "i/oraz". Gruppe 1 ist gesetzt, wenn
 * es das nackte Wort ist.
 */
const REMINDER_ASK = /[\s,;]+(?:(?:i|oraz)\s+)?(?:(?:ustaw|dodaj)\s+przypomnienie|przypomnij(?:\s+mi)?|(przypomnienie))\b/giu;
/** Was in der Zeitangabe einer Erinnerung neben Tag und Uhrzeit stehen darf. */
const WHEN_FILLER = new Set(['na', 'o', 'w', 'we', 'mi']);
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

const pad2 = (n) => String(n).padStart(2, '0');

/** `HH:MM` jetzt, nach der Uhr des Haushalts. */
function wallTime(now) {
  const f = nowFields(now);
  return f ? `${pad2(f.hour)}:${pad2(f.minute)}` : '';
}

/** Der Tag nach `dateKey` (Kalenderarithmetik in UTC - frei von Zeitumstellungen). */
function nextDay(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
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

/**
 * Trennt den Erinnerungswunsch ab - nur, wenn hinter ihm NICHTS als eine
 * Zeitangabe steht. `when` ist dann das Ergebnis des Parsers fuer sie.
 */
function splitReminder(text, opts) {
  for (const m of text.matchAll(REMINDER_ASK)) {
    const bare = m[1] !== undefined;
    if (bare && !/[,;]|\s(?:i|oraz)\s/iu.test(m[0])) continue;
    const main = text.slice(0, m.index);
    if (!main.trim()) continue;
    const when = parseCapture(text.slice(m.index + m[0].length), { ...opts, members: [] });
    if (!when.date && !when.time) continue;
    const leftover = when.title.toLowerCase().replace(/[.,;:!?]/g, ' ').split(/\s+/).filter(Boolean);
    if (leftover.some((word) => !WHEN_FILLER.has(word))) continue;
    return { main, when };
  }
  return { main: text, when: null };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Der Text ohne die Spannen, die Datum, Uhrzeit oder Person wurden - alles andere bleibt. */
function withoutReadSpans(text, tokens) {
  let out = text;
  for (const token of tokens ?? []) {
    if (!['date', 'time', 'person'].includes(token.kind) || !token.text) continue;
    out = out.replace(new RegExp(`(^|[\\s,;:])${escapeRe(token.text)}(?=$|[\\s,;:.!?])`, 'u'), '$1');
  }
  return out;
}

function localDraft(sentence, { members, now }) {
  const opts = { now: householdWallClock(now), members, type: 'task' };
  const text = sentence.replace(LEADING_FILLER, '');
  const { main, when } = splitReminder(text, opts);
  const parsed = parseCapture(main, opts);

  const draft = blankDraft();
  if (parsed.date) {
    draft.due_date = parsed.date;
    draft.due_time = parsed.time ?? null;
  }
  if (parsed.assignee?.id != null) draft.assigned_to = [parsed.assignee.id];
  if (when) {
    const today = todayKey(now);
    draft.remind_date = when.date ?? draft.due_date ?? today;
    draft.remind_time = when.time ?? DAY_ONLY_REMINDER_TIME;
    // NUR EINE STUNDE, UND DIE IST HEUTE SCHON VORBEI (Ruling R16): morgen zu
    // dieser Stunde. Gespeichert ginge eine vergangene Erinnerung sofort als
    // Push raus. Die laufende Minute zaehlt als vorbei. Ein ausdruecklich
    // gesagter Tag bleibt - das Speichern ruegt ihn (R15).
    if (!when.date && draft.remind_date === today && draft.remind_time <= wallTime(now)) {
      draft.remind_date = nextDay(today);
    }
  }

  const found = draft.due_date || draft.assigned_to.length || draft.remind_date;
  // Der Parser nimmt Mahlzeit-Woerter auch aus einem Aufgabentitel heraus.
  const ateWords = (parsed.tokens ?? []).some((token) => token.kind === 'meal');
  let title = main;
  if (found) title = ateWords ? withoutReadSpans(main, parsed.tokens) : parsed.title;
  draft.title = tidyTitle(title) || tidyTitle(main) || tidyTitle(sentence);
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
