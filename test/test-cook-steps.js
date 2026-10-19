/**
 * Cook mode: recipe notes become steps, step text yields timers.
 * Run: npm run test:cook-steps
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSteps, findTimers, formatTimer } from '../public/utils/cook-steps.js';

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
