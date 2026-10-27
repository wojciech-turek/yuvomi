import test from 'node:test';
import assert from 'node:assert/strict';

// TAFLA (2026-10-19): the birthday widget of the old board is gone. Upcoming
// birthdays and name days stand in "Wkrótce" of Dziś - the same three
// promises hold there.
// 2026-10-27, v2: "Wkrótce" is drawn from birthdaysSoon (utils/dzis-plan.js)
// as "Name · 70. urodziny" / "sob 1 lis · za 5 dni"; buildSoon is gone.
const { planContext } = await import('../public/utils/today-plan.js');
const { birthdaysSoon } = await import('../public/utils/dzis-plan.js');

const ctx = planContext({ now: new Date('2026-04-22T10:00:00Z') });
const soon = (birthday) => birthdaysSoon({ birthdays: [birthday] }, ctx);

test('Wkrótce shows a name day as its own labelled occurrence', () => {
  const [row] = soon({
    id: 7,
    kind: 'name_day',
    name: 'Jiří',
    next_date: '2026-04-24',
    days_until: 2,
    next_age: null,
  });

  assert.equal(row.name, 'Jiří');
  assert.equal(row.kind, 'today.nameDayKind');
  assert.doesNotMatch(row.kind, /birthdays\.heroAge/);
  assert.match(row.when, / · birthdays\.inDays\{"count":2\}$/);
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

  assert.equal(row.kind, 'birthdays.heroAge{"age":36}');
});

test('legacy birthday data without an age does not render an empty age label', () => {
  const [row] = soon({
    id: 9,
    name: 'Bez věku',
    next_birthday: '2026-04-26',
    days_until: 4,
    next_age: null,
  });

  assert.equal(row.name, 'Bez věku');
  assert.equal(row.kind, 'today.birthdayKind', 'the word, not an empty age');
  assert.doesNotMatch(`${row.name} ${row.kind}`, /null/);
});

// #1821: a row that names ONE occasion opens it - the birthdays page reads
// `?open=<id>` in the split view and below the column threshold.
test('a Wkrótce row opens its own occasion, a name day included', () => {
  assert.equal(soon({ id: 8, kind: 'birthday', name: 'Mila', days_until: 4, next_age: 36 }).at(0).route, '/birthdays?open=8');
  assert.equal(soon({ id: 7, kind: 'name_day', name: 'Jiří', days_until: 2, next_age: null }).at(0).route, '/birthdays?open=7');
  // Without an id there is nothing to open: the page itself.
  assert.equal(soon({ kind: 'birthday', name: 'Ohne Id', days_until: 3, next_age: 40 }).at(0).route, '/birthdays');
});
