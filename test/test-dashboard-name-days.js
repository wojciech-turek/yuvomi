import test from 'node:test';
import assert from 'node:assert/strict';

// TAFLA (2026-10-19): the birthday widget of the old board is gone. Upcoming
// birthdays and name days now stand in "Wkrótce" of Dziś (buildSoon in
// utils/today-plan.js) - the same three promises hold there.
const { buildSoon, planContext } = await import('../public/utils/today-plan.js');

const ctx = planContext({ now: new Date('2026-04-22T10:00:00Z') });
const soon = (birthday) => buildSoon({ birthdays: [birthday] }, ctx);

test('Wkrótce shows a name day as its own labelled occurrence', () => {
  const [row] = soon({
    id: 7,
    kind: 'name_day',
    name: 'Jiří',
    next_date: '2026-04-24',
    days_until: 2,
    next_age: null,
  });

  assert.equal(row.title, 'Jiří');
  assert.equal(row.meta, 'birthdays.nameDay');
  assert.doesNotMatch(row.title, /today\.birthdayAge/);
  assert.equal(row.date, '2026-04-24');
});

test('a birthday occurrence continues to show the upcoming age', () => {
  const [row] = soon({
    id: 8,
    kind: 'birthday',
    name: 'Mila',
    next_date: '2026-04-26',
    days_until: 4,
    next_age: 36,
  });

  assert.match(row.title, /today\.birthdayAge/);
  assert.notEqual(row.meta, 'birthdays.nameDay');
});

test('legacy birthday data without an age does not render an empty age label', () => {
  const [row] = soon({
    id: 9,
    name: 'Bez věku',
    next_birthday: '2026-04-26',
    days_until: 4,
    next_age: null,
  });

  assert.equal(row.title, 'Bez věku');
  assert.doesNotMatch(row.title, /null/);
  assert.doesNotMatch(row.title, /today\.birthdayAge/);
});
