/**
 * Modul: Powiedz - ein Satz wird zu einer Aufgabe, einem Termin oder Einkaeufen
 * Zweck: "Powiedz" im "+"-Menue (One Today, 2026-11-02): EIN Aufruf an Haiku
 *        entscheidet die Art und fuellt deren Felder; das passende Blatt oeffnet
 *        sich gefuellt. NICHTS wird gespeichert - die Person prueft das Blatt
 *        und tippt dessen Hinzufuegen-Knopf.
 *
 * Derselbe KI-Schalter wie das Aufgabendiktat (`task_dictation`), kein neuer.
 * Der Aufgabenweg ist der des Aufgabenblatts (`taskFieldsFrom` aus
 * task-dictation.js): dieselbe Antwort ergibt dieselben Felder.
 *
 * Der Server vertraut der Antwort nicht: Datum und Uhrzeit muessen echt sein,
 * Namen muessen aus der Mitgliederliste stammen (nie das Wandtablett), alles
 * Unklare wird null. Ein Satz, der nirgends passt, wird eine Aufgabe mit dem
 * Satz als Titel - nie nichts. Der Satz ist privater Haustext und wird nicht
 * geloggt.
 */

import * as db from '../db.js';
import { claude } from '../ai/index.js';
import {
  addDays, cleanDate, cleanTime, cleanTitle, dictationContext, householdLines, memberIdsFrom,
  taskFieldRules, taskFieldsFrom,
} from './task-dictation.js';

/** Die Arten, in die ein Satz gehen kann, in der Reihenfolge des Schemas. */
export const QUICK_ADD_KINDS = Object.freeze(['task', 'event', 'shopping']);

/** Das Modul, dessen Schreibrecht eine Art braucht (Rechte-Schluessel). */
export const KIND_MODULE = Object.freeze({ task: 'tasks', event: 'calendar', shopping: 'shopping' });

/** Hoechstens so viele Artikel aus einem Satz. */
const MAX_ITEMS = 20;
/** Was POST /shopping/:id/items annimmt (validate.js: MAX_TITLE, MAX_SHORT). */
const ITEM_NAME_MAX = 200;
const ITEM_QUANTITY_MAX = 100;
/** Was der Kalender als Ort annimmt (MAX_TITLE). */
const PLACE_MAX = 200;
/** Eine gesprochene Erinnerung reicht hoechstens einen Monat vor den Beginn. */
const REMINDER_MAX_MINUTES = 30 * 24 * 60;

function schemaFor(names, kinds) {
  const text = { type: 'string' };
  // Ohne Namen kein enum (leeres enum ist kein gueltiges Schema); der
  // Server-Filter haelt die Antwort trotzdem sauber.
  const people = { type: 'array', items: names.length ? { type: 'string', enum: names } : { type: 'string' } };
  const properties = {
    kind: { type: 'string', enum: [...kinds] },
    title: text,
    due_date: text,
    due_time: text,
    remind_date: text,
    remind_time: text,
    assignees: people,
    for_speaker: { type: 'boolean' },
    event_date: text,
    start_time: text,
    end_time: text,
    location: text,
    reminder_minutes: text,
    people,
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: text, amount: text },
        required: ['name', 'amount'],
        additionalProperties: false,
      },
    },
  };
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

/** Der naechste Wochentag NACH dem Haushaltstag (0 = Sonntag), wie der Prompt es verlangt. */
function nextWeekday(today, weekday) {
  const [y, m, d] = today.split('-').map(Number);
  const current = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(today, ((weekday - current + 7) % 7) || 7);
}

function systemPrompt({ today, weekday, time, zone, names, speaker, kind, only = false, kinds = QUICK_ADD_KINDS }) {
  const tomorrow = addDays(today, 1);
  const friday = nextWeekday(today, 5);
  const thursday = nextWeekday(today, 4);
  const saturday = nextWeekday(today, 6);
  const sunday = nextWeekday(today, 0);
  return [
    'You sort one sentence, dictated by a person in a Polish household, into one of three kinds and fill the fields of that kind: a to-do task (kind "task"), a calendar event (kind "event") or things to buy for the shopping list (kind "shopping"). The sentence was produced by speech recognition, so ignore small recognition slips.',
    'Answer in the language of the sentence (normally Polish). Never guess a missing part: an empty string means "not said". Fill only the fields of the kind you choose; every other string stays empty, every other list empty, for_speaker false unless that kind uses it.',
    ...householdLines({ today, weekday, time, zone, names, speaker }),
    'How to choose the kind:',
    '- shopping: the sentence asks to buy something ("kup", "kupić", "dokup", "dodaj do zakupów", "dodaj do listy", "na listę zakupów") or is only a list of groceries or household things ("mleko, chleb, masło").',
    '- event: something that happens at a time or at a place and that people go to or take part in: an appointment, a training, a lesson, a visit, a meeting, a party, a trip ("wizyta", "trening", "spotkanie", "zebranie", "urodziny Zosi w sobotę o 15", "wyjazd").',
    '- task: everything else, something a person has to do ("zadzwonić", "zapłacić", "umówić", "wyrzucić", "zabrać"), also when a day or an hour is said for doing it.',
    '- An event needs a day or an hour. A sentence with neither a day nor an hour is never an event: it is a task.',
    '- When unsure: task.',
    ...(kind && !only ? [`This sentence comes from the ${kind} form, so kind is always "${kind}": fill the fields of that kind even when the sentence sounds like another kind or names neither a day nor an hour.`] : []),
    ...(kind && only ? [`Only "${kind}" can be added for this person, so kind is always "${kind}": fill the fields of that kind even when the sentence sounds like another kind or names neither a day nor an hour.`] : []),
    ...(!kind && kinds.length < QUICK_ADD_KINDS.length ? [`Only these kinds can be chosen here: ${kinds.map((k) => `"${k}"`).join(', ')}. A sentence that sounds like another kind takes the closest of these${kinds.includes('task') ? ' (normally "task", with the day and hour said as its due date and time)' : ''}.`] : []),
    'Task fields (kind "task"):',
    ...taskFieldRules({ time, names }),
    'Event fields (kind "event"):',
    'title: what happens, short, without command filler ("dodaj wydarzenie", "zapisz w kalendarzu") and without the day, time and place words that went into other fields. Keep the names of people without an account in the title ("Leo", "Marysi").',
    'event_date: the day, only when a day is said ("jutro", "w czwartek", "5 listopada"). Leave it empty when only an hour is said: the app then takes today when the hour is still ahead, otherwise tomorrow.',
    'start_time: the hour it starts, only when an hour is said. A day without an hour makes an all-day event.',
    'end_time: only when an end or a length is said ("do 18", "od 17 do 18:30", "przez dwie godziny" counted from the start). Otherwise empty: the app uses its usual length.',
    'location: the place when one is named, as a place name ("w Fikolandii" -> "Fikolandia"; "u babci" stays "u babci"), else empty.',
    `people: only names from the list above, in any Polish case (${names.map((n) => `"${n}"`).join(', ')} and their inflected forms), when the sentence says that person takes part. A name that is not on the list stays in the title. for_speaker: true when the person speaking takes part ("mam wizytę", "idę", "jadę").`,
    'reminder_minutes: only when a reminder is asked for, as whole minutes before the start, digits only ("przypomnij godzinę wcześniej" -> "60", "pół godziny przed" -> "30", "dzień wcześniej" -> "1440"). Empty when no reminder is asked for.',
    'Shopping fields (kind "shopping"):',
    `items: one entry per thing to buy, split on commas and on "i" / "oraz", at most ${MAX_ITEMS}. name: the thing in its basic form as written on a shopping list ("2 l mleka" -> "mleko"), without the buying words. amount: the amount as said ("2 l", "3", "kilo", "dwa opakowania"), or empty. title stays empty.`,
    'Examples (every field not named is empty, assignees, people and items are [], for_speaker is false):',
    '"Dodaj zadanie ubezpiecz samochód" -> kind "task", title "Ubezpiecz samochód".',
    `"Zapłacić za przedszkole w piątek" (today ${today}) -> kind "task", title "Zapłacić za przedszkole", due_date "${friday}" (something to do by a day is a task).`,
    `"Przypomnij mi jutro żeby zadzwonić do lekarza" (today ${today}) -> kind "task", title "Zadzwonić do lekarza", remind_date "${tomorrow}", remind_time "09:00", for_speaker true.`,
    `"Trening Leo w czwartek o 17" (today ${today}) -> kind "event", title "Trening Leo", event_date "${thursday}", start_time "17:00".`,
    `"Jutro wycieczka przedszkolna Marysi" (today ${today}) -> kind "event", title "Wycieczka przedszkolna Marysi", event_date "${tomorrow}", start_time "" (a day without an hour: all day).`,
    '"Spotkanie z księgową o 15, przypomnij pół godziny wcześniej" -> kind "event", title "Spotkanie z księgową", event_date "", start_time "15:00" (an hour without a day), reminder_minutes "30".',
    `"Urodziny Zosi w sobotę o 15 w Fikolandii" (today ${today}) -> kind "event", title "Urodziny Zosi", event_date "${saturday}", start_time "15:00", location "Fikolandia".`,
    `"Basen z dziećmi w niedzielę od 10 do 12" (today ${today}) -> kind "event", title "Basen z dziećmi", event_date "${sunday}", start_time "10:00", end_time "12:00".`,
    '"Wizyta u dentysty" -> kind "task", title "Wizyta u dentysty" (neither a day nor an hour, so not an event).',
    '"kup mleko, chleb i 2 l soku" -> kind "shopping", items [{"name":"mleko","amount":""},{"name":"chleb","amount":""},{"name":"sok","amount":"2 l"}].',
    '"dodaj do zakupów pomidory" -> kind "shopping", items [{"name":"pomidory","amount":""}].',
  ].join('\n');
}

/** Getrimmter Text, hoechstens `max` Zeichen; leer wird null. */
function cleanText(value, max) {
  const s = String(value ?? '').trim().slice(0, max).trim();
  return s || null;
}

/** Ganze Minuten vor dem Beginn, 0 bis ein Monat; alles andere null. */
function cleanMinutes(value) {
  const s = String(value ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const minutes = Number(s);
  return minutes <= REMINDER_MAX_MINUTES ? minutes : null;
}

/**
 * Die Felder eines neuen Termins. Ein Tag und eine Stunde: mit Uhrzeit; ein
 * Tag ohne Stunde: ganztaegig; eine Stunde ohne Tag: heute, wenn sie noch
 * kommt, sonst morgen (wie R16, die laufende Minute zaehlt als vorbei). Kein
 * Ende gesagt (oder keins nach dem Beginn): null, das Formular nimmt seine
 * uebliche Dauer.
 */
function eventFieldsFrom(out, { members, userId, today, nowTime, sentence }) {
  const start = cleanTime(out?.start_time);
  let date = cleanDate(out?.event_date);
  if (!date && start) date = start > nowTime ? today : addDays(today, 1);
  const end = start ? cleanTime(out?.end_time) : null;
  return {
    title: cleanTitle(out?.title, sentence),
    date,
    start_time: start,
    end_time: end && end > start ? end : null,
    all_day: Boolean(date) && !start,
    location: cleanText(out?.location, PLACE_MAX),
    assigned_to: memberIdsFrom(out?.people, { members, userId, forSpeaker: out?.for_speaker === true }),
    reminder_minutes: cleanMinutes(out?.reminder_minutes),
  };
}

/** Die Artikel fuer die Einkaufsliste: Name getrimmt, Leeres faellt weg, hoechstens MAX_ITEMS. */
function shoppingFieldsFrom(out) {
  const items = [];
  for (const item of Array.isArray(out?.items) ? out.items : []) {
    const name = cleanText(item?.name, ITEM_NAME_MAX);
    if (!name) continue;
    items.push({ name, quantity: cleanText(item?.amount, ITEM_QUANTITY_MAX) });
    if (items.length === MAX_ITEMS) break;
  }
  return { items };
}

function fieldsFor(kind, out, base) {
  if (kind === 'event') return eventFieldsFrom(out, base);
  if (kind === 'shopping') return shoppingFieldsFrom(out);
  return taskFieldsFrom(out, base);
}

/**
 * @param {object} opts
 * @param {string} opts.text - the sentence (trimmed here)
 * @param {number} opts.userId - who speaks
 * @param {'task'|'event'|'shopping'|null} [opts.kind] - a sheet's own mic: the answer is always this kind
 * @param {string[]} [opts.kinds] - kinds the caller may get when `kind` is not given (writable and switched on);
 *        the schema offers only these, one alone is forced; any other kind comes back as a task when
 *        'task' is among them, else the result is null
 * @returns {Promise<{kind: 'task'|'event'|'shopping', fields: object}|null>}
 * @throws {AiError} from the client, unchanged
 */
export async function parseQuickAddSentence({
  text, userId, kind = null, kinds = QUICK_ADD_KINDS, now = new Date(), database = db.get(), client = claude,
}) {
  const sentence = String(text ?? '').trim();
  const ctx = dictationContext({ userId, now, database });
  // Das Modell waehlt nur unter den Arten, die der Aufrufer bekommen darf (in
  // der Reihenfolge des Schemas); bleibt nur eine, ist sie vorgegeben wie das
  // Mikrofon eines Blatts.
  const allowed = QUICK_ADD_KINDS.filter((k) => kinds.includes(k));
  const only = !kind && allowed.length === 1;
  const forced = kind ?? (only ? allowed[0] : null);

  const out = await client.json({
    feature: 'task_dictation',
    tier: 'fast',
    userId,
    system: systemPrompt({
      today: ctx.today, weekday: ctx.weekday, time: ctx.nowTime, zone: ctx.zone, names: ctx.names, speaker: ctx.speaker,
      kind: forced, only, kinds: allowed,
    }),
    text: `Zdanie: ${sentence}`,
    schema: schemaFor(ctx.names, forced ? [forced] : allowed),
    maxTokens: 600,
    effort: 'low',
  });

  const base = { members: ctx.members, userId, today: ctx.today, nowTime: ctx.nowTime, sentence };
  // Das Mikrofon eines Blatts fuellt dieses Blatt, was immer das Modell sagt.
  if (forced) return { kind: forced, fields: fieldsFor(forced, out, base) };

  let routed = QUICK_ADD_KINDS.includes(out?.kind) ? out.kind : 'task';
  let fields = fieldsFor(routed, out, base);
  // Ein Termin braucht einen Tag oder eine Stunde, eine Einkaufsliste einen
  // Artikel. Was das nicht hat, wird eine Aufgabe - nie nichts.
  if ((routed === 'event' && !fields.date) || (routed === 'shopping' && !fields.items.length)) routed = 'task';
  // Wer die Art nicht schreiben darf, bekommt das Aufgabenblatt - wenn er
  // Aufgaben schreiben darf.
  if (!kinds.includes(routed)) {
    if (!kinds.includes('task')) return null;
    if (routed === 'event') return { kind: 'task', fields: eventAsTaskFields(out, fields, base) };
    routed = 'task';
  }
  if (routed === 'task') fields = taskFieldsFrom(out, base);
  return { kind: routed, fields };
}

/**
 * Ein Termin, den die Person nicht in den Kalender schreiben darf, wird eine
 * Aufgabe, die Tag und Stunde behaelt: der Tag des Termins (mit seiner Regel
 * fuer eine Stunde ohne Tag) wird der Faelligkeitstag, der Beginn die
 * Faelligkeitszeit. Beide sind schon geprueft (cleanDate, cleanTime); eine
 * Zeit ohne Tag gibt es hier nicht, der Termin hat immer einen Tag.
 */
function eventAsTaskFields(out, event, base) {
  const task = taskFieldsFrom(out, base);
  return { ...task, due_date: event.date, due_time: event.date ? event.start_time : null };
}
