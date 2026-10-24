/**
 * Cook mode: recipe notes become steps, step text yields timers.
 * Run: npm run test:cook-steps
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSteps, findTimers, formatTimer, stepSegments, stepIngredientIndexes } from '../public/utils/cook-steps.js';

test('numbered lines are steps; unnumbered lines continue the step before', () => {
  assert.deepEqual(
    splitSteps('1. Pokrój cebulę.\n2. Smaż 5 minut na złoto.\nDodaj czosnek.\n3) Gotuj 15 minut.'),
    ['Pokrój cebulę.', 'Smaż 5 minut na złoto. Dodaj czosnek.', 'Gotuj 15 minut.'],
  );
});

test('bullets and "Krok N" markers count as steps', () => {
  assert.deepEqual(splitSteps('- jeden\n- dwa'), ['jeden', 'dwa']);
  assert.deepEqual(splitSteps('Krok 1: Umyj ryż\nKrok 2: Gotuj'), ['Umyj ryż', 'Gotuj']);
});

test('paragraphs are steps; one long paragraph splits into sentences', () => {
  assert.deepEqual(splitSteps('Pierwszy akapit.\n\nDrugi akapit\nciąg dalszy.'), ['Pierwszy akapit.', 'Drugi akapit ciąg dalszy.']);
  const steps = splitSteps('Rozgrzej piekarnik do 200 stopni i wyłóż blachę papierem do pieczenia. Ziemniaki obierz i pokrój w ćwiartki. Piecz 40 min.');
  assert.ok(steps.length >= 2, steps.join(' | '));
});

test('empty notes give no steps', () => {
  assert.deepEqual(splitSteps(''), []);
  assert.deepEqual(splitSteps(null), []);
});

test('timers in Polish and English, ranges use the upper end', () => {
  assert.deepEqual(findTimers('Gotuj 15-20 minut'), [{ label: '15-20 minut', seconds: 1200 }]);
  assert.deepEqual(findTimers('piecz 1 godz.').map((x) => x.seconds), [3600]);
  assert.deepEqual(findTimers('odstaw na 30 sekund').map((x) => x.seconds), [30]);
  assert.deepEqual(findTimers('simmer for 2 hours, rest 5 min').map((x) => x.seconds), [7200, 300]);
  assert.deepEqual(findTimers('1,5 godziny').map((x) => x.seconds), [5400]);
});

test('numbers that are not durations make no timer', () => {
  assert.deepEqual(findTimers('Rozgrzej do 200 stopni, dodaj 2 łyżki mąki'), []);
});

test('timer display', () => {
  assert.equal(formatTimer(45), '0:45');
  assert.equal(formatTimer(900), '15:00');
  assert.equal(formatTimer(3725), '1:02:05');
});

test('a step splits into text and timer pieces, in order (Tafla: the timer is a pill in the sentence)', () => {
  assert.deepEqual(stepSegments('Duś 20 min na małym ogniu.'), [
    { text: 'Duś ' }, { timer: { label: '20 min', seconds: 1200 } }, { text: ' na małym ogniu.' },
  ]);
  assert.deepEqual(stepSegments('Wymieszaj.'), [{ text: 'Wymieszaj.' }]);
  assert.equal(stepSegments('Gotuj 2-3 minuty, potem piecz 1 godz.').filter((p) => p.timer).length, 2);
});

test('"Do tego kroku": the ingredients a step mentions, across Polish endings and diacritics', () => {
  const ingredients = [
    { name: 'makaron spaghetti' }, { name: 'Passata' }, { name: 'Sól' }, { name: 'pieprz' },
    { name: 'oregano' }, { name: 'mięso mielone' }, { name: 'cebula' }, { name: 'śmietanka' },
  ];
  assert.deepEqual(stepIngredientIndexes('Wlej passatę, dopraw solą, pieprzem i oregano.', ingredients), [1, 2, 3, 4]);
  assert.deepEqual(stepIngredientIndexes('Dodaj mięso mielone i smaż.', ingredients), [5]);
  assert.deepEqual(stepIngredientIndexes('Posiekaj cebulę.', ingredients), [6]);
  assert.deepEqual(stepIngredientIndexes('Ugotuj makaron al dente.', ingredients), [0]);
  assert.deepEqual(stepIngredientIndexes('Odstaw na chwilę.', ingredients), [], 'a step without ingredients names none');
});
