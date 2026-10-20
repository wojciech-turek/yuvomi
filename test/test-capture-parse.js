/**
 * Modul: Capture parser (utils/capture-parse.js)
 * Zweck: Pins the local rules of the global capture sheet - Polish and
 *        English relative dates, times, members, shopping lists with amounts
 *        and the auto type - against a fixed `now` (Monday 2026-10-19 12:00).
 * Ausfuehren: node --test test/test-capture-parse.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseCapture, CAPTURE_TYPES } = await import('../public/utils/capture-parse.js');

const now = new Date(2026, 9, 19, 12, 0); // Monday
const members = [
  { id: 1, display_name: 'Wojtek' },
  { id: 2, display_name: 'Ola' },
];
const p = (text, opts = {}) => parseCapture(text, { now, members, ...opts });
const kinds = (r) => r.tokens.map((tok) => tok.kind);

test('the types are the five capture chips', () => {
  assert.deepEqual(CAPTURE_TYPES, ['task', 'event', 'shopping', 'meal', 'note']);
});

test('artboard: "jutro 18 fryzjer Ola" is an event tomorrow at 18:00 for Ola', () => {
  const r = p('jutro 18 fryzjer Ola');
  assert.equal(r.type, 'event');
  assert.equal(r.inferred, true);
  assert.equal(r.title, 'Fryzjer');
  assert.equal(r.date, '2026-10-20');
  assert.equal(r.time, '18:00');
  assert.equal(r.endTime, null);
  assert.deepEqual(r.assignee, { id: 2, name: 'Ola' });
  assert.deepEqual(kinds(r), ['date', 'time', 'person']);
  assert.deepEqual(r.tokens.map((tok) => tok.text), ['jutro', '18', 'Ola']);
  assert.equal(r.leftover, 'Fryzjer');
});

test('artboard: a comma list is three shopping items', () => {
  const r = p('mleko, jajka, masło');
  assert.equal(r.type, 'shopping');
  assert.deepEqual(r.items, [
    { name: 'Mleko', quantity: null, unit: null },
    { name: 'Jajka', quantity: null, unit: null },
    { name: 'Masło', quantity: null, unit: null },
  ]);
  assert.equal(r.date, null);
  assert.equal(r.time, null);
  assert.deepEqual(p('milk, eggs, butter').items.map((i) => i.name), ['Milk', 'Eggs', 'Butter']);
  assert.equal(p('chleb\nser\nkawa').items.length, 3, 'newlines separate items too');
});

test('artboard: "pizza w piątek" is a dinner on Friday', () => {
  const r = p('pizza w piątek');
  assert.equal(r.type, 'meal');
  assert.equal(r.mealType, 'dinner');
  assert.equal(r.date, '2026-10-23');
  assert.equal(r.title, 'Pizza');
  assert.equal(r.tokens[0].text, 'w piątek', 'the connector belongs to the date');
  const explicit = p('pizza w piątek', { type: 'meal' });
  assert.equal(explicit.inferred, false);
  assert.equal(explicit.mealType, 'dinner');
});

test('a meal word sets the slot: "obiad jutro spaghetti"', () => {
  const r = p('obiad jutro spaghetti');
  assert.equal(r.type, 'meal');
  assert.equal(r.mealType, 'lunch');
  assert.equal(r.date, '2026-10-20');
  assert.equal(r.title, 'Spaghetti');
  assert.equal(p('śniadanie w sobotę naleśniki').mealType, 'breakfast');
  assert.equal(p('drugie śniadanie jutro').mealType, 'snack');
  assert.equal(p('na kolację w czwartek gulasz').title, 'Gulasz');
  assert.equal(p('dinner on friday tacos').mealType, 'dinner');
});

test('amounts: "2 mleka" is shopping with quantity, never a time', () => {
  const r = p('2 mleka');
  assert.equal(r.type, 'shopping');
  assert.equal(r.time, null);
  assert.deepEqual(r.items, [{ name: 'Mleka', quantity: 2, unit: null }]);
  assert.deepEqual(r.tokens, [{ kind: 'amount', text: '2', value: { quantity: 2, unit: null } }]);
});

test('amounts with units, decimals and multipliers', () => {
  assert.deepEqual(p('500 g mąki').items, [{ name: 'Mąki', quantity: 500, unit: 'g' }]);
  const r = p('1,5 kg ziemniaków, chleb x2, 3 szt. jajka, 2x masło');
  assert.equal(r.type, 'shopping');
  assert.deepEqual(r.items, [
    { name: 'Ziemniaków', quantity: 1.5, unit: 'kg' },
    { name: 'Chleb', quantity: 2, unit: null },
    { name: 'Jajka', quantity: 3, unit: 'szt' },
    { name: 'Masło', quantity: 2, unit: null },
  ]);
  assert.deepEqual(r.tokens.map((tok) => tok.text), ['1,5 kg', 'x2', '3 szt.', '2x']);
  assert.deepEqual(p('mąka 2 kg').items, [{ name: 'Mąka', quantity: 2, unit: 'kg' }]);
});

test('explicit shopping splits on "i"/"and" and leaves date words in the item', () => {
  assert.deepEqual(p('mleko i chleb', { type: 'shopping' }).items.map((i) => i.name), ['Mleko', 'Chleb']);
  assert.deepEqual(p('milk and bread', { type: 'shopping' }).items.map((i) => i.name), ['Milk', 'Bread']);
  assert.equal(p('mleko i chleb').type, 'shopping', 'auto: a single grocery phrase');
  assert.equal(p('mleko i chleb').items.length, 1, 'auto does not split on "i"');
  const r = p('jutro 2 mleka', { type: 'shopping' });
  assert.equal(r.date, null);
  assert.deepEqual(r.items, [{ name: 'Jutro 2 mleka', quantity: null, unit: null }]);
});

test('single groceries are shopping; other single phrases are tasks', () => {
  assert.equal(p('mleko').type, 'shopping');
  assert.equal(p('papier toaletowy').type, 'shopping');
  assert.equal(p('toilet paper').type, 'shopping');
  assert.equal(p('zadzwonić do hydraulika').type, 'task');
  assert.equal(p('18 fryzjer').type, 'task', 'a number before a non-grocery is not an amount');
  assert.equal(p('serwis auta').type, 'task', 'grocery words match whole, "ser" is not "serwis"');
});

test('relative dates: dziś, jutro, pojutrze, za N dni, in a week', () => {
  assert.equal(p('dziś pranie').date, '2026-10-19');
  assert.equal(p('dzisiaj pranie').date, '2026-10-19');
  assert.equal(p('pojutrze').date, '2026-10-21');
  assert.equal(p('pojutrze').title, '');
  const za = p('za 3 dni dentysta');
  assert.equal(za.type, 'task');
  assert.equal(za.date, '2026-10-22');
  assert.equal(za.title, 'Dentysta');
  assert.equal(p('za dwa dni x').date, '2026-10-21');
  assert.equal(p('za tydzień przegląd').date, '2026-10-26');
  assert.equal(p('za 2 tygodnie urlop').date, '2026-11-02');
  assert.equal(p('in a week review').date, '2026-10-26');
  assert.equal(p('in 3 days review').date, '2026-10-22');
  assert.equal(p('day after tomorrow gym').date, '2026-10-21');
  assert.equal(p('na jutro pranie').title, 'Pranie');
});

test('weekdays: next occurrence; the same weekday is today only for a later time', () => {
  assert.equal(p('w piątek kino').date, '2026-10-23');
  assert.equal(p('pt kino').date, '2026-10-23');
  assert.equal(p('do piątku raport').date, '2026-10-23');
  assert.equal(p('w środę basen').date, '2026-10-21');
  assert.equal(p('we wtorek x').date, '2026-10-20');
  assert.equal(p('w niedzielę obiad u mamy').date, '2026-10-25');
  assert.equal(p('on sunday brunch').date, '2026-10-25');
  // Monday on a Monday at 12:00
  assert.equal(p('w poniedziałek o 18 joga').date, '2026-10-19');
  assert.equal(p('w poniedziałek o 9 joga').date, '2026-10-26');
  assert.equal(p('w poniedziałek joga').date, '2026-10-26');
  assert.equal(p('monday 6pm yoga').date, '2026-10-19');
});

test('"next"/"przyszły" pushes a day of this week into the next', () => {
  assert.equal(p('next friday party').date, '2026-10-30');
  assert.equal(p('w przyszłą środę o 9 lekarz').date, '2026-10-28');
  assert.equal(p('next monday x').date, '2026-10-26');
});

test('ambiguous abbreviations need context: "sun cream" is not Sunday', () => {
  assert.equal(p('sun cream').date, null);
  assert.equal(p('w so sprzątanie').date, '2026-10-24');
});

test('absolute dates roll over to next year once passed', () => {
  const r = p('15.11 przegląd auta');
  assert.equal(r.date, '2026-11-15');
  assert.equal(r.title, 'Przegląd auta');
  assert.equal(p('15.10 przegląd').date, '2027-10-15');
  assert.equal(p('19.10 dziś').date, '2026-10-19', 'today has not passed');
  assert.equal(p('15/11 x').date, '2026-11-15');
  assert.equal(p('15.11.2027 y').date, '2027-11-15');
  assert.equal(p('15 listopada urodziny').date, '2026-11-15');
  assert.equal(p('3 lis x').date, '2026-11-03');
  assert.equal(p('15th nov z').date, '2026-11-15');
  assert.equal(p('november 15th a').date, '2026-11-15');
  assert.equal(p('31.02 x').date, null, 'no 31 February');
  const both = p('wtorek 20.10 kino');
  assert.equal(both.date, '2026-10-20');
  assert.equal(both.time, null, 'a date next to a weekday is not a time');
});

test('times: markers, colon, dot, am/pm and ranges', () => {
  assert.equal(p('o 18 zebranie').time, '18:00');
  assert.equal(p('o godz. 18 zebranie').title, 'Zebranie');
  assert.equal(p('jutro o 18.30 kino').time, '18:30');
  assert.equal(p('jutro 18.30 kino').time, '18:30', 'next to a date word a dot reads as a time');
  assert.equal(p('18h basen').time, '18:00');
  const pm = p('tomorrow 6pm dentist');
  assert.equal(pm.type, 'event');
  assert.equal(pm.date, '2026-10-20');
  assert.equal(pm.time, '18:00');
  assert.equal(pm.title, 'Dentist');
  assert.equal(p('today at 7 pm d').time, '19:00');
  assert.equal(p('at 6:30 pm e').time, '18:30');
  assert.equal(p('12am x', { type: 'event' }).time, '00:00');
  const range = p('18:00–19:30 trening');
  assert.deepEqual([range.time, range.endTime], ['18:00', '19:30']);
  const od = p('od 18 do 19:30 spotkanie');
  assert.deepEqual([od.time, od.endTime, od.title], ['18:00', '19:30', 'Spotkanie']);
  assert.deepEqual([p('jutro 18-19 x').time, p('jutro 18-19 x').endTime], ['18:00', '19:00']);
  assert.deepEqual([p('jutro 18 do 19 x').time, p('jutro 18 do 19 x').endTime], ['18:00', '19:00']);
  assert.deepEqual([p('6-7pm yoga').time, p('6-7pm yoga').endTime], ['18:00', '19:00']);
  assert.equal(p('o 25 nic').time, null, 'hours stop at 23');
  assert.equal(p('18-19 x').time, null, 'a bare range without a date word stays text');
  assert.equal(p('jutro 2 kg').time, null, 'a number before a unit is an amount');
});

test('members: inflected names and connectors become the assignee', () => {
  const r = p('o 18:30 basen z Wojtkiem');
  assert.deepEqual(r.assignee, { id: 1, name: 'Wojtek' });
  assert.equal(r.title, 'Basen');
  assert.equal(r.type, 'event');
  assert.equal(p('dla Wojtka: odebrać paczkę').title, 'Odebrać paczkę');
  assert.equal(p('dla Wojtka: odebrać paczkę').tokens[0].text, 'dla Wojtka');
  assert.deepEqual(p('spotkanie z Olą jutro').assignee, { id: 2, name: 'Ola' });
  assert.equal(p('spotkanie z Olą jutro').title, 'Spotkanie');
  assert.deepEqual(p('@ola zadzwoń do mamy').assignee, { id: 2, name: 'Ola' });
  assert.deepEqual(p('kupić prezent dla Oli').assignee, { id: 2, name: 'Ola' });
  assert.deepEqual(
    parseCapture('przypomnij Marioli', { now, members: [{ id: 3, display_name: 'Mariola Turek' }] }).assignee,
    { id: 3, name: 'Mariola Turek' },
  );
});

test('members: everyday forms of a name find the member (Ola -> Mariola, Wojtek -> Wojciech)', () => {
  const household = [{ id: 1, display_name: 'Wojciech' }, { id: 2, display_name: 'Mariola' }];
  const q = (text) => parseCapture(text, { now, members: household });
  assert.deepEqual(q('jutro 18 fryzjer Ola').assignee, { id: 2, name: 'Mariola' });
  assert.equal(q('jutro 18 fryzjer Ola').title, 'Fryzjer');
  assert.deepEqual(q('kupić prezent dla Oli').assignee, { id: 2, name: 'Mariola' });
  assert.deepEqual(q('basen z Wojtkiem o 18').assignee, { id: 1, name: 'Wojciech' });
  assert.equal(q('kupić olej').assignee, null, 'a nickname still matches whole words only');
});

test('members: names inside other words do not match', () => {
  assert.equal(p('Olaf przyjdzie').assignee, null);
  assert.equal(p('kupić kola').assignee, null);
  assert.equal(p('wojtkowy plan').assignee, null);
  assert.equal(p('kupić olej').assignee, null, '"olej" is oil, not Ola');
  assert.equal(p('zadzwonić', { members: [] }).assignee, null);
});

test('explicit types win over inference; note keeps the text as typed', () => {
  const ev = p('pt 18 kino', { type: 'event' });
  assert.equal(ev.inferred, false);
  assert.equal(ev.date, '2026-10-23');
  assert.equal(ev.time, '18:00');
  const task = p('jutro o 18 basen', { type: 'task' });
  assert.equal(task.type, 'task');
  assert.equal(task.time, '18:00');
  const note = p('jutro kupić prezent', { type: 'note' });
  assert.equal(note.type, 'note');
  assert.equal(note.title, 'Jutro kupić prezent');
  assert.equal(note.date, null);
  assert.deepEqual(note.tokens, []);
  assert.equal(p('jutro kupić prezent').type, 'task', 'note is never inferred');
});

test('empty input and odd options never throw', () => {
  const r = p('   ');
  assert.equal(r.type, 'task');
  assert.equal(r.title, '');
  assert.deepEqual(r.items, []);
  assert.equal(p('', { type: 'event' }).type, 'event');
  assert.equal(p(null).type, 'task');
  assert.equal(p('x', { type: 'bogus' }).type, 'task');
  assert.equal(parseCapture('jutro x', { now, members: [{ id: 9 }, null].filter(Boolean) }).date, '2026-10-20');
});

test('tokens come back in source order with their source text', () => {
  const r = p('kolacja o 19 z Olą');
  assert.deepEqual(kinds(r), ['meal', 'time', 'person']);
  assert.deepEqual(r.tokens.map((tok) => tok.text), ['kolacja', 'o 19', 'z Olą']);
  assert.deepEqual(r.tokens[1].value, { time: '19:00', endTime: null });
});
