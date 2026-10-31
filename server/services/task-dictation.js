/**
 * Modul: Diktat - ein gesprochener Satz wird zu Aufgabenfeldern
 * Zweck: Das iPhone macht aus Sprache Text (Claude nimmt kein Audio); hier macht
 *        Haiku aus dem Satz die Felder des Neue-Aufgabe-Blatts. NICHTS wird
 *        gespeichert - die Person prueft das Formular und tippt "Dodaj zadanie".
 *
 * Der Server vertraut der Antwort nicht: Datum und Uhrzeit muessen echt sein,
 * Namen muessen aus der Mitgliederliste stammen (nie ein Wandtablett, nie ein
 * Kind ohne Konto), alles Unklare wird null. Der Satz ist privater Haustext und
 * wird nicht geloggt.
 */

import * as db from '../db.js';
import { claude } from '../ai/index.js';
import { householdMemberSql } from './household-members.js';
import { householdTimeZone, todayKey, utcToWall } from '../utils/timezone.js';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function memberNames(database) {
  return database.prepare(
    `SELECT u.id, u.display_name FROM users u
     WHERE ${householdMemberSql('u')} AND TRIM(COALESCE(u.display_name, '')) <> ''
     ORDER BY u.id`,
  ).all();
}

function schemaFor(names) {
  return {
    type: 'object',
    properties: {
      title: { type: 'string' },
      due_date: { type: 'string' },
      due_time: { type: 'string' },
      remind_date: { type: 'string' },
      remind_time: { type: 'string' },
      assignees: {
        type: 'array',
        items: { type: 'string', enum: names },
      },
      for_speaker: { type: 'boolean' },
    },
    required: ['title', 'due_date', 'due_time', 'remind_date', 'remind_time', 'assignees', 'for_speaker'],
    additionalProperties: false,
  };
}

function cleanDate(value) {
  const m = DATE_RE.exec(String(value ?? '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  const real = probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
  return real ? m[0] : null;
}

function cleanTime(value) {
  const s = String(value ?? '').trim();
  return TIME_RE.test(s) ? s : null;
}

function cleanTitle(value, fallback) {
  const raw = String(value ?? '').trim() || String(fallback ?? '').trim();
  if (!raw) return '';
  return raw.charAt(0).toLocaleUpperCase('pl') + raw.slice(1);
}

function systemPrompt({ today, weekday, time, zone, names, speaker }) {
  return [
    'You turn one sentence, dictated by a person in a Polish household, into the fields of a to-do task. The sentence was produced by speech recognition, so ignore small recognition slips.',
    'Answer in the language of the sentence (normally Polish). Never guess a missing part: an empty string means "not said".',
    `Today in the household is ${today} (${weekday}), the wall clock shows ${time}, the time zone is ${zone}. Resolve relative days from today: "dzisiaj" is today, "jutro" tomorrow, "pojutrze" the day after tomorrow, a weekday name ("w piątek") its next occurrence after today. Dates are YYYY-MM-DD, times are 24-hour HH:MM.`,
    `People with an account in this household: ${names.join(', ')}. The person speaking is ${speaker || 'unknown'}.`,
    'title: the task itself, short, without command filler. Drop "dodaj zadanie", "zapisz", "nowe zadanie", "przypomnij mi żeby" and similar when they only introduce the task. Keep other people\'s names in the title (children and relatives without an account, e.g. "Marysi") and keep the sentence\'s own wording otherwise. Drop the day and time words that went into the date fields.',
    'due_date / due_time: only when a day (or an hour) is said for doing the task. Use due_time only together with a day or when an hour is clearly the deadline.',
    'remind_date / remind_time: only when a reminder is asked for ("przypomnienie", "przypomnij"). "Przypomnij mi jutro o 7:30" gives remind_date tomorrow and remind_time 07:30. If a reminder names only an hour, the reminder day is the due day, or today when there is none.',
    `assignees: only names from the list above, in any Polish case (${names.map((n) => `"${n}"`).join(', ')} and their inflected forms) when the sentence gives the task to that person. Never put anyone else there; a name that is not on the list ("Marysia", "Marysi") stays in the title.`,
    'for_speaker: true when the sentence is in the first person ("muszę", "przypomnij mi", "mam", "chcę"), meaning the person speaking should do it.',
    'Examples:',
    '"Dodaj zadanie ubezpiecz samochód" -> title "Ubezpiecz samochód", every other string empty, assignees [], for_speaker false.',
    '"Weź jutro Marysi spodenki do przedszkola, ustaw przypomnienie na jutro 7:30" (today 2026-10-29) -> title "Weź Marysi spodenki do przedszkola", due_date "2026-10-30", due_time "", remind_date "2026-10-30", remind_time "07:30", assignees [], for_speaker false.',
    '"Wyrzuć śmieci" -> title "Wyrzuć śmieci", every other string empty, assignees [], for_speaker false.',
  ].join('\n');
}

/**
 * @param {{text: string, userId: number, now?: Date, database?: object, client?: {json: Function}}} opts
 * @returns {Promise<{title: string, due_date: string|null, due_time: string|null, remind_date: string|null, remind_time: string|null, assigned_to: number[]}>}
 * @throws {AiError} from the client, unchanged
 */
export async function parseTaskSentence({ text, userId, now = new Date(), database = db.get(), client = claude }) {
  const sentence = String(text ?? '').trim();
  const members = memberNames(database);
  const names = members.map((m) => m.display_name);
  const zone = householdTimeZone(database);
  const wall = utcToWall(now.toISOString(), zone);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long' }).format(now);
  const speaker = database.prepare('SELECT display_name FROM users WHERE id = ?').get(userId)?.display_name ?? '';

  const out = await client.json({
    feature: 'task_dictation',
    tier: 'fast',
    userId,
    system: systemPrompt({
      today: todayKey(database, now), weekday, time: wall?.time?.slice(0, 5) ?? '', zone, names, speaker,
    }),
    text: `Zdanie: ${sentence}`,
    schema: schemaFor(names),
    maxTokens: 400,
    effort: 'low',
  });

  const ids = new Set();
  for (const name of Array.isArray(out?.assignees) ? out.assignees : []) {
    const hit = members.find((m) => m.display_name.toLocaleLowerCase('pl') === String(name).trim().toLocaleLowerCase('pl'));
    if (hit) ids.add(hit.id);
  }
  if (out?.for_speaker === true && members.some((m) => m.id === userId)) ids.add(userId);

  return {
    title: cleanTitle(out?.title, sentence),
    due_date: cleanDate(out?.due_date),
    due_time: cleanTime(out?.due_time),
    remind_date: cleanDate(out?.remind_date),
    remind_time: cleanTime(out?.remind_time),
    assigned_to: [...ids],
  };
}
