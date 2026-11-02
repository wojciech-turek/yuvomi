/**
 * Modul: Dziś v2 (2026-10-27) - the model and the view of the home screen
 * Zweck: The owner's design ("Main", "DzisFull") as guards:
 *   1. the weather card: the rain window of the REST of the day, "do 85%",
 *      fourteen bars from the hour before now, blue from 40 %, "teraz" and
 *      every third hour named; dry: "Bez deszczu do wieczora";
 *   2. the calendar: what is over folds into "1 wcześniej · 08:00 ...", the
 *      ongoing event stands in place ("teraz · do 11:00") instead of in a
 *      second card, "razem" has two dots, the last line peeks at tomorrow;
 *   3. the tasks: the server's order (overdue, dated, undated), five rows, the
 *      due word ("wczoraj", "dziś", "czw"), late in its own tone, the flag only
 *      for high and urgent, the total from the server;
 *   4. Wkrótce: the next 30 days, three at most, each a deep link;
 *   5. the view: one h2 greeting, the weather card links to the weather
 *      settings, every check circle has a name, read-only viewers get no
 *      circles and no "Dodaj zadanie", user text is escaped, and nothing of
 *      the Tafla page (Teraz, dinner, plan, customise) is left.
 * Ausfuehren: npm run test:dashboard-dzis
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('./test-browser-loader.mjs', import.meta.url);

const { setDisplayTimeZone } = await import('../public/utils/timezone.js');
setDisplayTimeZone('Europe/Warsaw');
const plan = await import('../public/utils/today-plan.js');
const dzis = await import('../public/utils/dzis-plan.js');
const view = await import('../public/components/today-view.js');

const W = { id: 1, display_name: 'Wojtek', avatar_color: '#007AFF' };
const M = { id: 2, display_name: 'Mariola', avatar_color: '#FF2D55' };

/** The household clock on Tuesday 27 October 2026 (Warsaw, UTC+1). */
function at(hhmm, fn) {
  const now = new Date(`2026-10-27T${hhmm}:00+01:00`);
  mock.timers.enable({ apis: ['Date'], now });
  try {
    return fn(plan.planContext({ now, viewer: W, users: [W, M] }));
  } finally {
    mock.timers.reset();
  }
}

// --------------------------------------------------------------------------
// 1. Weather
// --------------------------------------------------------------------------

const POPS = [0, 0, 0, 0, 0, 0, 0, 5, 5, 10, 10, 15, 25, 55, 80, 85, 70, 45, 20, 10, 5, 5, 5, 5];
const weather = (pops = POPS, extra = {}) => ({
  provider: 'open-meteo',
  current: { temp: 11.3, feels_like: 9.4, desc: 'weather.cloudy', icon: 'cloud-drizzle' },
  today: { temp_max: 14.2, temp_min: 7.6 },
  today_hours: pops.map((pop, hour) => ({ hour, pop, mm: pop > 40 ? 0.4 : 0 })),
  ...extra,
});

test('weather: the rain window of the rest of the day, its chance, and the head of the card', () => {
  const card = at('09:30', (ctx) => dzis.weatherCard(weather(), ctx));
  assert.equal(card.temp, '11°');
  assert.equal(card.desc, 'weather.cloudy', 'Open-Meteo sends a key, the card translates it');
  assert.equal(card.icon, 'cloud-drizzle');
  assert.equal(card.meta, '14° / 8° · today.feelsLike{"temp":"9°"}');
  assert.equal(card.rain.label, 'today.rainWindow{"from":"13:00","to":"17:00"}', 'first to last hour from 40 %');
  assert.equal(card.rain.chance, 'today.rainChance{"pop":85}');
  assert.equal(card.dry, null);
});

test('weather: fourteen bars from the hour before now - blue from 40 %, "teraz", every third hour named', () => {
  const { bars } = at('09:30', (ctx) => dzis.weatherCard(weather(), ctx)).rain;
  assert.equal(bars.length, dzis.CHART_BARS);
  assert.deepEqual(bars.map((bar) => bar.hour), [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  assert.deepEqual(bars.map((bar) => bar.label), ['', 'today.chartNow', '', '', '12', '', '', '15', '', '', '18', '', '', '21'],
    'as the design: "teraz" in the second column, 12, 15, 18, 21');
  assert.deepEqual(bars.filter((bar) => bar.wet).map((bar) => bar.hour), [13, 14, 15, 16, 17]);
  assert.deepEqual(bars.filter((bar) => bar.now).map((bar) => bar.hour), [9]);
  assert.equal(bars.find((bar) => bar.hour === 15).height, 20, '85 % of 24');
  assert.equal(bars.find((bar) => bar.hour === 8).height, 3, 'a dry hour keeps the 3px stub');
  // The two hours after "teraz" stay unnamed, whatever the clock: 11:00 would
  // put "12" right after the word.
  const late = at('11:10', (ctx) => dzis.weatherCard(weather(), ctx)).rain.bars;
  assert.deepEqual(late.slice(0, 6).map((bar) => bar.label), ['', 'today.chartNow', '', '', '', '15'],
    'no "12" next to "teraz"');
  // The day ends at 23: in the evening the chart is shorter, not wrapped.
  const evening = at('16:20', (ctx) => dzis.weatherCard(weather(), ctx)).rain.bars;
  assert.deepEqual(evening.map((bar) => bar.hour), [15, 16, 17, 18, 19, 20, 21, 22, 23]);
});

test('weather: raining now says until when, one wet hour says around when', () => {
  assert.equal(at('14:05', (ctx) => dzis.weatherCard(weather(), ctx)).rain.label, 'today.rainUntil{"time":"17:00"}');
  const one = POPS.map((pop, hour) => (hour === 16 ? 60 : Math.min(pop, 30)));
  assert.equal(at('09:30', (ctx) => dzis.weatherCard(weather(one), ctx)).rain.label, 'today.rainAt{"time":"16:00"}');
  // Rain that is over is not today's news any more.
  const card = at('18:30', (ctx) => dzis.weatherCard(weather(), ctx));
  assert.equal(card.rain, null);
  assert.equal(card.dry.label, 'today.dryRestOfDay', 'after five "until evening" would be a lie');
});

test('weather: a dry day says so with its highest chance; no hours, no line; no weather, no card', () => {
  const dry = POPS.map((pop) => Math.min(pop, 10));
  const card = at('09:30', (ctx) => dzis.weatherCard(weather(dry), ctx));
  assert.equal(card.rain, null);
  assert.deepEqual(card.dry, { label: 'today.dryEvening', chance: 'today.rainChance{"pop":10}' });
  const legacy = at('09:30', (ctx) => dzis.weatherCard(weather(POPS, { today_hours: undefined }), ctx));
  assert.equal(legacy.rain, null);
  assert.equal(legacy.dry, null, 'without hourly data the card makes no promise');
  assert.equal(at('09:30', (ctx) => dzis.weatherCard(null, ctx)), null);
  assert.equal(at('09:30', (ctx) => dzis.weatherCard({ provider: 'owm' }, ctx)), null);
});

// --------------------------------------------------------------------------
// 2. Calendar
// --------------------------------------------------------------------------

const ev = (id, title, start, end, users = [], extra = {}) => ({
  id, title, start_datetime: start, end_datetime: end, all_day: 0, assigned_users: users, ...extra,
});
const DAY = {
  planEvents: [
    ev(1, 'Przedszkole', '2026-10-27T08:00', '2026-10-27T08:30', [W]),
    ev(2, 'Spotkanie zespołu', '2026-10-27T09:30', '2026-10-27T11:00', [W]),
    ev(3, 'Pediatra', '2026-10-27T15:00', '2026-10-27T16:00', [M]),
    ev(4, 'Basen z dziećmi', '2026-10-27T17:30', '2026-10-27T18:30', [W, M]),
    ev(5, 'Urlop Marioli', '2026-10-27', '2026-10-28', [M], { all_day: 1 }),
    ev(6, 'Przedszkole', '2026-10-28T08:00', '2026-10-28T08:30', [W]),
    ev(7, 'Dentysta', '2026-10-28T12:00', '2026-10-28T13:00', [M]),
    ev(8, 'Kino', '2026-10-28T20:00', '2026-10-28T22:00', [W, M]),
  ],
  users: [W, M],
};

test('calendar: what is over folds into one line, the ongoing event stands in place, all-day first', () => {
  const cal = at('10:15', (ctx) => dzis.calendarDay(DAY, ctx));
  assert.equal(cal.earlier.label, 'today.earlierCount{"n":1} · 08:00 Przedszkole');
  assert.deepEqual(cal.earlier.rows.map((row) => row.title), ['Przedszkole']);
  assert.deepEqual(cal.rows.map((row) => row.title), ['Urlop Marioli', 'Spotkanie zespołu', 'Pediatra', 'Basen z dziećmi']);
  const [urlop, now, pediatra, basen] = cal.rows;
  assert.equal(urlop.timeLabel, 'today.allDay');
  assert.equal(now.ongoing, true);
  assert.equal(now.until, 'today.nowUntil{"time":"11:00"}', 'no second Teraz card: the row says it');
  assert.equal(pediatra.ongoing, false);
  assert.equal(pediatra.meta, 'Mariola', 'someone else\'s event names the person');
  assert.deepEqual(basen.people.map((p) => p.id), [1, 2], 'razem: both dots');
  assert.equal(basen.meta, 'today.together');
  assert.equal(now.route, '/calendar?open=2&date=2026-10-27');
  assert.equal(cal.empty, false);
});

test('calendar: the last line peeks at tomorrow; an empty day is one quiet line', () => {
  const cal = at('10:15', (ctx) => dzis.calendarDay(DAY, ctx));
  assert.deepEqual(cal.tomorrow, { text: '08:00 Przedszkole · today.tomorrowMore{"n":2}', route: '/calendar?date=2026-10-28' });
  const empty = at('10:15', (ctx) => dzis.calendarDay({ planEvents: [] }, ctx));
  assert.equal(empty.empty, true);
  assert.equal(empty.tomorrow, null);
  // Later the meeting has left for "wcześniej" too.
  const later = at('11:05', (ctx) => dzis.calendarDay(DAY, ctx));
  assert.equal(later.earlier.label, 'today.earlierCount{"n":2} · 09:30 Spotkanie zespołu');
  assert.notEqual(at('10:15', (ctx) => dzis.clockStamp(dzis.calendarDay(DAY, ctx), null, ctx)),
    at('11:05', (ctx) => dzis.clockStamp(dzis.calendarDay(DAY, ctx), null, ctx)), 'the page rebuilds when a row moves');
});

// --------------------------------------------------------------------------
// 3. Tasks
// --------------------------------------------------------------------------

const task = (id, title, due, extra = {}) => ({ id, title, status: 'open', due_date: due, priority: 'medium', assigned_users: [W], ...extra });
const TASKS = {
  urgentTasks: [
    task(1, 'Zapłacić za prąd', '2026-10-26', { priority: 'high' }),
    task(2, 'Kupić prezent dla babci', '2026-10-27', { assigned_users: [M] }),
    task(3, 'Umówić przegląd auta', '2026-10-28', { priority: 'urgent' }),
    task(4, 'Oddać książki', '2026-10-29', { priority: 'low' }),
    task(5, 'Wymienić żarówkę', null, { assigned_users: [] }),
    task(6, 'Szóste', null),
  ],
  openTaskCount: 9,
};

test('tasks: the server\'s order, five rows, the due word, late and flag where the design has them', () => {
  const { rows, total } = at('10:15', (ctx) => dzis.pendingTasks(TASKS, ctx));
  assert.equal(rows.length, dzis.TASK_ROWS);
  assert.deepEqual(rows.map((row) => row.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(rows.map((row) => row.due), ['calendar.relDay.yesterday', '', '', 'Do 29. Okt.', ''],
    'late keeps its word, today and tomorrow say nothing (the group says it), later is a short date');
  assert.deepEqual(rows.map((row) => row.late), [true, false, false, false, false]);
  assert.deepEqual(rows.map((row) => row.flag), [true, false, true, false, false], 'only high and urgent');
  assert.deepEqual(rows.map((row) => row.person?.id ?? null), [1, 2, 1, 1, null]);
  assert.equal(total, 9, 'the head counts every open task, not the five rows');
});

test('tasks: a done task never shows, and the due word reaches back and ahead', () => {
  const data = { urgentTasks: [task(9, 'Zrobione', '2026-10-27', { status: 'done' }), task(10, 'Stare', '2026-10-20'), task(11, 'Daleko', '2026-11-12')] };
  const { rows, total } = at('10:15', (ctx) => dzis.pendingTasks(data, ctx));
  assert.deepEqual(rows.map((row) => [row.title, row.due]), [
    ['Stare', 'calendar.relDay.daysAgo{"count":7}'],
    ['Daleko', 'Do 12. Nov.'],
  ]);
  assert.equal(total, 2, 'without the server\'s count the rows are the count');
});

// --------------------------------------------------------------------------
// 4. Wkrótce
// --------------------------------------------------------------------------

test('Wkrótce: the next 30 days, three at most, with age or kind, the day and a deep link', () => {
  const data = {
    birthdays: [
      { id: 1, name: 'Babcia Halina', kind: 'birthday', days_until: 5, next_age: 70 },
      { id: 2, name: 'Tomek', kind: 'birthday', days_until: 16, next_age: null },
      { id: 3, name: 'Ania', kind: 'name_day', days_until: 24 },
      { id: 4, name: 'Czwarty', kind: 'birthday', days_until: 28, next_age: 40 },
      { id: 5, name: 'Daleko', kind: 'birthday', days_until: 31, next_age: 40 },
    ],
  };
  const rows = at('10:15', (ctx) => dzis.birthdaysSoon(data, ctx));
  assert.deepEqual(rows.map((row) => row.name), ['Babcia Halina', 'Tomek', 'Ania']);
  assert.deepEqual(rows.map((row) => row.kind), ['birthdays.heroAge{"age":70}', 'today.birthdayKind', 'today.nameDayKind']);
  assert.equal(rows[0].when, 'So 1. Nov. · birthdays.inDays{"count":5}');
  assert.equal(rows[0].route, '/birthdays?open=1');
  const soon = at('10:15', (ctx) => dzis.birthdaysSoon({ birthdays: [{ id: 6, name: 'Dziś', kind: 'birthday', days_until: 0, next_age: 3 }] }, ctx));
  assert.match(soon[0].when, / · calendar\.relDay\.today$/);
});

// --------------------------------------------------------------------------
// 5. One Today (2026-11-02): next up, task groups, birthdays, notes, weather line
// --------------------------------------------------------------------------

const MEALS = {
  todayMeals: [
    { id: 1, meal_type: 'lunch', title: 'Zupa' },
    { id: 2, meal_type: 'dinner', title: 'Spaghetti' },
  ],
};

test('next up: the next timed row with its lead, and the one after as "Potem"', () => {
  const up = at('12:05', (ctx) => dzis.nextUp(MEALS, ctx));
  assert.equal(up.lead, 'today.inMinutesAt{"minutes":25,"time":"12:30"}');
  assert.match(up.title, /^today\.mealRow\{.*"title":"Zupa"\}$/);
  assert.equal(up.kind, 'meal');
  assert.equal(up.route, '/meals');
  assert.match(up.then, /^today\.thenShort\{"time":"18:30","title":".*Spaghetti.*"\}$/);
  const far = at('09:00', (ctx) => dzis.nextUp(MEALS, ctx));
  assert.equal(far.lead, 'today.atTimeOnly{"time":"12:30"}', 'an hour or more away is the time alone');
});

test('next up: a running event says "Teraz"; the row after is "Potem"', () => {
  const up = at('10:15', (ctx) => dzis.nextUp({ ...DAY, ...MEALS }, ctx));
  assert.equal(up.lead, 'today.nowRunning');
  assert.equal(up.title, 'Spotkanie zespołu');
  assert.equal(up.kind, 'event');
  assert.match(up.then, /^today\.thenShort\{"time":"12:30"/);
  assert.match(up.route, /^\/calendar\?open=2/);
});

test('next up: a household help visit at 14:00 counts, overdue and past rows do not', () => {
  const data = { housekeeping: { present: true, presentSince: '2026-10-27T14:00:00+01:00', workerName: 'Pani Ania' } };
  const up = at('12:05', (ctx) => dzis.nextUp(data, ctx));
  assert.equal(up.title, 'Pani Ania');
  assert.equal(up.lead, 'today.atTimeOnly{"time":"14:00"}');
  assert.equal(up.then, null);
  const over = { planTasks: [task(20, 'Stare', '2026-10-20', { due_time: '09:00' })] };
  assert.equal(at('12:05', (ctx) => dzis.nextUp(over, ctx)), null, 'overdue is not next up');
});

test('next up: nothing left today falls back to the first timed row of tomorrow; empty is null', () => {
  const data = { planEvents: DAY.planEvents };
  const up = at('20:00', (ctx) => dzis.nextUp(data, ctx));
  assert.equal(up.lead, 'today.tomorrowAt{"time":"08:00"}');
  assert.equal(up.title, 'Przedszkole');
  assert.equal(up.then, null);
  assert.equal(at('12:05', (ctx) => dzis.nextUp({}, ctx)), null);
  assert.equal(at('12:05', (ctx) => dzis.nextUp(undefined, ctx)), null);
});

test('next up: the clock stamp changes when the lead does', () => {
  const stamp = (hhmm) => at(hhmm, (ctx) => dzis.clockStamp(null, null, ctx, dzis.nextUp(MEALS, ctx)));
  assert.notEqual(stamp('12:05'), stamp('12:06'));
  assert.equal(stamp('12:05'), stamp('12:05'));
});

test('task groups: five rows in five groups, in order, empty ones dropped', () => {
  const data = {
    urgentTasks: [
      task(5, 'Bez terminu', null),
      task(4, 'Później', '2026-11-12'),
      task(3, 'Jutro', '2026-10-28'),
      task(2, 'Dziś', '2026-10-27'),
      task(1, 'Zaległe', '2026-10-20'),
    ],
  };
  const res = at('10:15', (ctx) => dzis.pendingTasks(data, ctx));
  assert.deepEqual(res.groups.map((g) => g.id), ['late', 'today', 'tomorrow', 'later', 'none']);
  assert.deepEqual(res.groups.map((g) => g.label), ['today.groupLate', 'today.groupToday', 'today.groupTomorrow', 'today.groupLater', 'today.groupNone']);
  assert.deepEqual(res.groups.map((g) => g.rows.map((r) => r.id)), [[1], [2], [3], [4], [5]]);
  assert.deepEqual(res.rows.map((r) => r.group), ['late', 'today', 'tomorrow', 'later', 'none'], 'rows stay flat too, in group order');
  assert.deepEqual(res.groups.map((g) => g.rows[0].due), ['calendar.relDay.daysAgo{"count":7}', '', '', 'Do 12. Nov.', '']);
  const only = at('10:15', (ctx) => dzis.pendingTasks({ urgentTasks: [task(7, 'A', '2026-10-27')] }, ctx));
  assert.deepEqual(only.groups.map((g) => g.id), ['today']);
  assert.deepEqual(at('10:15', (ctx) => dzis.pendingTasks({}, ctx)).groups, []);
});

test('birthdays next: three, however far; name day; today is flagged; the age, the note', () => {
  const data = {
    birthdays: [
      { id: 1, name: 'Dziś', kind: 'birthday', days_until: 0, next_age: 3 },
      { id: 2, name: 'Ania', kind: 'name_day', days_until: 1 },
      { id: 3, name: 'Babcia', kind: 'birthday', days_until: 200, next_age: null, notes: '**Tort** z malinami\nreszta' },
      { id: 4, name: 'Czwarty', kind: 'birthday', days_until: 201, next_age: 40 },
    ],
  };
  const rows = at('10:15', (ctx) => dzis.birthdaysNext(data, ctx));
  assert.deepEqual(rows.map((r) => r.name), ['Dziś', 'Ania', 'Babcia'], 'day 200 is in, the fourth is not');
  assert.deepEqual(rows.map((r) => r.today), [true, false, false]);
  assert.deepEqual(rows.map((r) => r.sub), ['birthdays.turnsAge{"age":3}', 'today.nameDayKind', 'Tort z malinami']);
  assert.deepEqual(rows.map((r) => r.far), ['', 'calendar.relDay.tomorrow', 'birthdays.inDays{"count":200}']);
  assert.equal(rows[2].date, 'Sa 15. Mai', 'weekday, day, month, no year');
  assert.equal(rows[0].route, '/birthdays?open=1');
  assert.equal(rows[1].key, 'birthday:2:name_day');
  assert.deepEqual(at('10:15', (ctx) => dzis.birthdaysNext({}, ctx)), []);
});

test('notes card: three of the server\'s order, title or first line, markdown stripped', () => {
  const data = {
    pinnedNotes: [
      { id: 1, title: 'Święta', content: '# Plan\n- [ ] Kraków' },
      { id: 2, title: '', content: '## **Wifi**\nhasło: `kuchnia`' },
      { id: 3, title: null, content: 'Samo\n' },
      { id: 4, title: 'Czwarta', content: 'x' },
    ],
  };
  const card = dzis.notesCard(data);
  assert.deepEqual(card.map((n) => n.id), [1, 2, 3]);
  assert.deepEqual(card.map((n) => n.title), ['Święta', 'Wifi', 'Samo']);
  assert.deepEqual(card.map((n) => n.line), ['Plan', 'hasło: kuchnia', ''], 'the title\'s line is the first line; a title taken from the text moves to the second');
  assert.equal(card[0].route, '/notes?open=1');
  assert.equal(dzis.notesCard({ pinnedNotes: [] }), null);
  assert.equal(dzis.notesCard({}), null);
});

test('weather line: temperature and the rain or dry phrase, lower case; no weather, null', () => {
  const rainy = at('09:30', (ctx) => dzis.weatherLine(weather(), ctx));
  assert.equal(rainy.icon, 'cloud-drizzle');
  assert.equal(rainy.text, '11° · today.rainWindow{"from":"13:00","to":"17:00"}');
  const dry = at('09:30', (ctx) => dzis.weatherLine(weather(POPS.map((p) => Math.min(p, 10))), ctx));
  assert.equal(dry.text, '11° · today.dryEvening');
  assert.equal(at('09:30', (ctx) => dzis.weatherLine(null, ctx)), null);
});

test('calendar: birthday events are not in the rows, earlier or the tomorrow peek', () => {
  const data = {
    planEvents: [
      ev(30, 'Urodziny Tomka', '2026-10-27', '2026-10-28', [], { all_day: 1, birthday_name: 'Tomek' }),
      ev(31, 'Urodziny Ani', '2026-10-28', '2026-10-29', [], { all_day: 1, birthday_name: 'Ania' }),
      ev(32, 'Pediatra', '2026-10-27T15:00', '2026-10-27T16:00', [M]),
    ],
  };
  const cal = at('10:15', (ctx) => dzis.calendarDay(data, ctx));
  assert.deepEqual(cal.rows.map((r) => r.title), ['Pediatra']);
  assert.equal(cal.tomorrow, null, 'a tomorrow with only a birthday has no peek');
  const late = at('23:00', (ctx) => dzis.calendarDay(data, ctx));
  assert.equal(late.earlier.rows.some((r) => r.title.startsWith('Urodziny')), false);
});

test('next up: only events, meals, timed tasks and help visits - never a reminder, shift, dose or all-day event', () => {
  const noise = {
    health: { doses: [{ medication_id: 1, schedule_id: 1, name: 'Lek', time: '13:00', status: 'pending' }] },
    shifts: [{ id: 1, start_time: '13:10', title: 'Zmiana' }],
    pendingReminders: [{ id: 5, entity_title: 'Przypomnienie', entity_type: 'task', due_at: '2026-10-27T13:20:00+01:00' }],
    planEvents: [ev(40, 'Cały dzień', '2026-10-27', '2026-10-28', [], { all_day: 1 })],
  };
  assert.equal(at('12:05', (ctx) => dzis.nextUp(noise, ctx)), null, 'none of these is Next up (tomorrow has nothing timed either)');
  const help = { ...noise, housekeeping: { present: true, presentSince: '2026-10-27T14:00:00+01:00', workerName: 'Pani Ania' } };
  assert.equal(at('12:05', (ctx) => dzis.nextUp(help, ctx)).title, 'Pani Ania');
  const timedTask = { planTasks: [task(30, 'Zadzwonić', '2026-10-27', { due_time: '13:00' })] };
  assert.equal(at('12:05', (ctx) => dzis.nextUp(timedTask, ctx)).title, 'Zadzwonić');
});

test('next up: a meal with an unknown slot uses the dinner time', () => {
  const up = at('12:05', (ctx) => dzis.nextUp({ todayMeals: [{ id: 9, meal_type: 'brunch', title: 'Coś' }] }, ctx));
  assert.equal(up.lead, 'today.atTimeOnly{"time":"18:30"}');
});

test('next up: tomorrow\'s timed row is found behind five untimed rows', () => {
  const data = {
    planEvents: [
      ...[1, 2, 3, 4, 5].map((n) => ev(50 + n, `Urodziny ${n}`, '2026-10-28', '2026-10-29', [], { all_day: 1, birthday_name: `X${n}` })),
      ev(60, 'Dentysta', '2026-10-28T09:30', '2026-10-28T10:00', [M]),
    ],
    wastePickups: [{ date_key: '2026-10-28', type_name: 'Papier' }],
  };
  const up = at('20:00', (ctx) => dzis.nextUp(data, ctx));
  assert.equal(up.lead, 'today.tomorrowAt{"time":"09:30"}');
  assert.equal(up.title, 'Dentysta');
});

test('next up: "Potem" is the next row that starts after now, not a second running event', () => {
  const data = {
    planEvents: [
      ev(70, 'Spotkanie A', '2026-10-27T09:30', '2026-10-27T11:00', [W]),
      ev(71, 'Spotkanie B', '2026-10-27T10:00', '2026-10-27T11:30', [W]),
      ev(72, 'Obiad u babci', '2026-10-27T13:00', '2026-10-27T14:00', [W]),
    ],
  };
  const up = at('10:15', (ctx) => dzis.nextUp(data, ctx));
  assert.equal(up.lead, 'today.nowRunning');
  assert.equal(up.title, 'Spotkanie A');
  assert.equal(up.then, 'today.thenShort{"time":"13:00","title":"Obiad u babci"}');
});

test('notes card: a note with no title and no text still has a title', () => {
  for (const content of ['', '- [ ]', '---', '```\ncode\n```']) {
    const [n] = dzis.notesCard({ pinnedNotes: [{ id: 1, title: '', content }] });
    assert.equal(n.title, 'today.noteUntitled', JSON.stringify(content));
    assert.equal(n.line, '');
  }
});

test('birthdays next: no age and no note says "birthday"; tomorrow says "jutro"', () => {
  const rows = at('10:15', (ctx) => dzis.birthdaysNext({
    birthdays: [{ id: 1, name: 'Tomek', kind: 'birthday', days_until: 1, next_age: null }],
  }, ctx));
  assert.equal(rows[0].sub, 'today.birthdayKind');
  assert.equal(rows[0].far, 'calendar.relDay.tomorrow');
});

test('the header: the long date with a capital, the greeting by the hour', () => {
  assert.equal(dzis.headerDate('2026-10-27'), 'Dienstag, 27. Oktober');
  assert.equal(dzis.greetingKey(7 * 60), 'dashboard.greetingMorning');
  assert.equal(dzis.greetingKey(17 * 60 + 59), 'dashboard.greetingMorning');
  assert.equal(dzis.greetingKey(18 * 60), 'dashboard.greetingEvening');
  assert.equal(dzis.greetingKey(4 * 60), 'dashboard.greetingEvening');
});

// --------------------------------------------------------------------------
// 5. The view
// --------------------------------------------------------------------------

function pageAt(hhmm, extra = {}, data = { ...DAY, ...TASKS }) {
  return at(hhmm, (ctx) => view.renderTodayPage({
    user: W,
    household: [W, M],
    dateLabel: dzis.headerDate(ctx.todayKey),
    greetingKey: dzis.greetingKey(ctx.nowMin),
    weather: dzis.weatherCard(weather(), ctx),
    calendar: dzis.calendarDay(data, ctx),
    tasks: dzis.pendingTasks(data, ctx),
    birthdays: dzis.birthdaysSoon({ birthdays: [{ id: 1, name: 'Babcia Halina', kind: 'birthday', days_until: 5, next_age: 70 }] }, ctx),
    earlierOpen: false,
    canCheck: true,
    canAddTask: true,
    ...extra,
  }));
}
const count = (html, re) => (html.match(re) || []).length;

test('the page, top to bottom: header, weather, Kalendarz, Zadania, Wkrótce - and nothing of the Tafla page', () => {
  const html = pageAt('10:15');
  const order = ['class="dz-head"', 'class="dz-card dz-weather"', 'dz-sec--calendar', 'dz-sec--tasks', 'class="dz-soon"'].map((mark) => html.indexOf(mark));
  assert.ok(order.every((pos) => pos > 0), `every part is drawn: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in the design\'s order');
  assert.equal(count(html, /<h2 class="dz-head__greeting"/g), 1, 'one greeting, the page\'s h2');
  assert.equal(count(html, /<h2\b/g), 1, 'the sections are h3 under it');
  assert.equal(count(html, /<h3 class="dz-(?:sec|soon)__title"/g), 3);
  assert.match(html, /<a class="dz-head__me" href="\/settings"/);
  // `page-fab` stays out of the page markup: the + of Quick-Add (2026-10-29)
  // is built by dashboard.js and lives in the shell layer (next test).
  for (const gone of [/day-now/, /day-plan/, /day-closed/, /data-day-action="cook"/, /data-day-action="customize"/, /page-fab/, /today\.planTitle/]) {
    assert.doesNotMatch(html, gone, `${gone} is gone with v2`);
  }
});

test('Quick-Add (2026-10-29): Dziś has exactly one +, fab-add, and none of the old capture or speed-dial names', () => {
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  const fabs = src.match(/createPageFab\(\{[^}]*\}\)/g) ?? [];
  assert.deepEqual(fabs.map((f) => /id: '([^']+)'/.exec(f)?.[1]), ['fab-add'], 'one FAB, and it is fab-add');
  assert.doesNotMatch(src, /pageFabHtml\(|class="page-fab"|page-fab-group/, 'no second FAB as markup, no speed-dial group');
  for (const gone of [/fab-main/, /capture-plus/, /openCapture/, /capture-sheet/, /FAB_ACTIONS/, /function wireNewMenu/]) {
    assert.doesNotMatch(src, gone, `${gone} stays gone`);
  }
  // One Today (Task 14): the + asks for tasks, calendar and shopping only -
  // Meal left the menu, so meals write alone no longer brings a +.
  assert.match(src, /const ADD_MENU_MODULES = Object\.freeze\(\['tasks', 'calendar', 'shopping'\]\);/);
  // The bottom bar still has no + (spec non-goal): the shell builds none.
  const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  assert.doesNotMatch(router, /capture-plus|createCapturePlus|nav-bottom__add|nav-sidebar__add/);
});

test('the weather card is one link to the weather settings; the chart is decoration for the eye only', () => {
  const html = pageAt('09:30');
  assert.match(html, /<a class="dz-card dz-weather" href="\/settings\/personal\/weather" data-route="\/settings\/personal\/weather">/);
  assert.match(html, /class="dz-chart" aria-hidden="true"/, 'the rain line says it in words; the bars repeat it');
  assert.equal(count(html, /class="dz-chart__bar[ "]/g), 14);
  assert.equal(count(html, /dz-chart__bar--now/g), 1);
  assert.equal(count(html, /dz-chart__bar--wet/g), 5);
  assert.match(html, /data-lucide="umbrella"/);
  assert.match(html, /today\.rainWindow\{&quot;from&quot;:&quot;13:00&quot;,&quot;to&quot;:&quot;17:00&quot;\}/);
  assert.doesNotMatch(pageAt('09:30', { weather: null }), /dz-weather/, 'no weather, no card');
});

test('Kalendarz: the fold is a real disclosure, the ongoing row is marked, Tydzień opens the week', () => {
  const html = pageAt('10:15');
  assert.match(html, /<button type="button" class="dz-cal__earlier" data-day-action="earlier" aria-expanded="false" aria-controls="dz-cal-earlier">/);
  assert.match(html, /<ul class="dz-cal__list dz-cal__list--earlier" id="dz-cal-earlier" hidden>/);
  assert.match(pageAt('10:15', { earlierOpen: true }), /aria-expanded="true"[\s\S]*id="dz-cal-earlier">/);
  assert.equal(count(html, /dz-cal__row--now/g), 1);
  assert.match(html, /href="\/calendar\?view=week"[^>]*>calendar\.viewWeek</);
  assert.equal(count(html, /dz-dots--pair/g), 1, 'razem draws both colours');
  assert.match(html, /style="--dot: var\(--person-1-dot\)"[\s\S]*style="--dot: var\(--person-2-dot\)"/, 'Wojtek blue, Mariola rose');
  assert.match(html, /class="dz-cal__tomorrow" href="\/calendar\?date=2026-10-28"/);
  const quiet = pageAt('10:15', {}, { planEvents: [], ...TASKS });
  assert.match(quiet, /<p class="dz-cal__empty">today\.calendarEmpty<\/p>/);
});

test('Zadania: every circle has a name, the flag is read out, late is marked; Dodaj zadanie ends the card', () => {
  const html = pageAt('10:15');
  const circles = [...html.matchAll(/<button type="button" class="day-check check-ring"[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(circles.length, 5);
  assert.equal(circles[0], 'tasks.markDone{&quot;title&quot;:&quot;Zapłacić za prąd&quot;}');
  assert.equal(count(html, /data-lucide="flag" class="dz-task__flag" role="img" aria-label="today\.priorityFlag"/g), 2);
  assert.equal(count(html, /dz-task__due--late/g), 1);
  assert.match(html, /<h3 class="dz-sec__title" id="dz-tasks-h">nav\.tasks<\/h3>\s*<span class="dz-sec__count">9<\/span>/,
    'the count stands beside the heading, not in its name');
  assert.match(html, /<a class="dz-sec__link" href="\/tasks"[^>]*>common\.all<\/a>/);
  assert.match(html, /<button type="button" class="dz-tasks__add" data-day-action="add-task">/);
});

test('read-only and display viewers see the tasks without circles and without Dodaj zadanie', () => {
  const html = pageAt('10:15', { canCheck: false, canAddTask: false });
  assert.doesNotMatch(html, /data-day-action="check"/);
  assert.doesNotMatch(html, /data-day-action="add-task"/);
  assert.equal(count(html, /dz-task__spacer/g), 5);
  assert.equal(count(html, /data-day-action="open"/g), 5, 'the title still opens the task to read');
});

test('a module that is off draws no section; user text is escaped everywhere', () => {
  const off = pageAt('10:15', { calendar: null, tasks: null, birthdays: [] });
  assert.doesNotMatch(off, /dz-sec--calendar|dz-sec--tasks|dz-soon/);
  const evil = '<img src=x onerror=alert(1)>';
  const data = {
    planEvents: [ev(20, evil, '2026-10-27T15:00', '2026-10-27T16:00', [], { cal_name: evil })],
    urgentTasks: [task(21, evil, '2026-10-27')],
  };
  const html = pageAt('10:15', {}, data);
  assert.ok(!html.includes('<img src=x'), 'no raw tag from user text');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  // #1698 (moved from test-dashboard-tafla.js): no span on Dziś - the start.
  const row = /<li class="dz-cal__row">[\s\S]*?<\/li>/.exec(html)?.[0] ?? '';
  assert.ok(row.includes('15:00') && !row.includes('16:00'), 'the start, not the end');
});

// --------------------------------------------------------------------------
// 6. Wiring the page leans on
// --------------------------------------------------------------------------

test('the styles: v2 card, the ongoing row in the accent wash, overdue in its tone, 44 hits', async () => {
  const { eachRule } = await import('./css-rules.js');
  const rules = [...eachRule(readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8'))];
  const body = (selector) => rules.filter((rule) => rule.at.length === 0 && rule.selector.split(',').map((s) => s.trim()).includes(selector)).map((rule) => rule.body).join(';');
  assert.match(body('.dz-card'), /border:\s*1px solid var\(--color-card-border\)/);
  assert.match(body('.dz-card'), /border-radius:\s*var\(--radius-card\)/);
  assert.doesNotMatch(body('.dz-card'), /box-shadow/, 'v2 cards carry no shadow');
  assert.match(body('.dz-cal__row--now .dz-cal__link'), /color-mix\(in srgb, var\(--color-accent\) var\(--tint-wash\)/);
  assert.match(body('.dz-task__due--late'), /color:\s*var\(--color-overdue\)/);
  assert.match(body('.dz-chart__bar--wet'), /background:\s*var\(--color-rain\)/);
  assert.match(body('.dz-chart__bar'), /background:\s*var\(--color-rain-soft\)/);
  assert.match(body('.day-check'), /inline-size:\s*var\(--target-base\)/);
  assert.match(body('.day-check'), /block-size:\s*var\(--target-base\)/);
  for (const sel of ['.dz-cal__earlier', '.dz-cal__tomorrow', '.dz-tasks__add', '.dz-soon__row']) {
    assert.match(body(sel), /min-block-size:\s*var\(--target-base\)/, `${sel} keeps a 44 hit`);
  }
  // The v2 type steps, not the Tafla ones (34/22/17/13).
  assert.match(body('.dz-head__greeting'), /font-size:\s*var\(--type-page\)/);
  assert.match(body('.dz-sec__title'), /font-size:\s*var\(--type-section\)/);
  assert.match(body('.dz-cal__title'), /font-size:\s*var\(--type-row\)/);
  assert.match(body('.dz-cal__meta'), /font-size:\s*var\(--type-meta\)/);
  // No hex on the page: the umbrella takes --color-rain-ink (tokens.css).
  const dzis = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8').split(' * DZIŚ (design v2, 2026-10-27)')[1];
  // Checked in the declaration blocks: a selector like `#fab-add` (the Quick-Add
  // +) is an id, not a colour.
  const declarations = (dzis.replace(/\/\*[\s\S]*?\*\//g, '').match(/\{[^{}]*\}/g) ?? []).join('\n');
  assert.ok(declarations.length > 1000, 'reach: the Dziś section has its rules');
  assert.equal(declarations.match(/#[0-9a-f]{3,8}\b/gi), null);
  assert.match(body('.dz-weather__rain-icon'), /color:\s*var\(--color-rain-ink\)/);
});

test('"Tydzień" lands in the week: the calendar takes ?view= for one visit, without saving it', () => {
  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  const branch = /\} else if \(VIEWS\.includes\(params\.get\('view'\)\)\) \{([\s\S]*?)\n {2}\}/.exec(src);
  assert.ok(branch, 'the ?view= branch after the day link');
  assert.match(branch[1], /state\.view = params\.get\('view'\);/);
  assert.doesNotMatch(branch[1], /setSavedCalendarView/, 'a link does not overwrite the remembered view');
});

test('the page ticks through the existing task API with an undo', () => {
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  assert.match(src, /await api\.patch\(`\/tasks\/\$\{task\.id\}\/status`, \{ status: 'done' \}\);/);
  assert.match(src, /showToast\(t\('today\.toastDone', \{ title: row\.title \}\), 'default', 5000, async \(\) => \{/);
  assert.match(src, /canCheck: !onDisplay && moduleAccess\('tasks'\) === 'write',/);
});

// 2026-10-27, v2 (after the chrome): the capture sheet and the global + are
// gone. "Dodaj zadanie" opens the SAME form as "Nowe zadanie" in the head of
// Zadania, and the card refreshes after the save.
test('"Dodaj zadanie" opens the Zadania create form and refreshes the card after the save', () => {
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  assert.match(src, /const \{ openNewTaskFrom \} = await import\('\/pages\/tasks\.js'\);\s*await openNewTaskFrom\(\{ user, onChanged: \(\) => refreshDashboardData\(\) \}\);/);
  assert.doesNotMatch(src, /openCapture|capture-sheet|capture-plus|yuvomi:captured/);
  const tasks = readFileSync(new URL('../public/pages/tasks.js', import.meta.url), 'utf8');
  const entry = tasks.slice(tasks.indexOf('export async function openNewTaskFrom('), tasks.indexOf('export async function openTaskById('));
  assert.match(entry, /if \(readOnly\(\)\) return false;/, 'read-only viewers get no form');
  // Quick-Add (2026-10-29): a draft can come along, and "Say a task" (`dictate`)
  // hands over to startTaskDictation BEFORE any await (Safari starts speech
  // only inside the tap); it ends in the same form (openPreparedNewTask).
  assert.match(entry, /openTaskModal\(\{ users: state\.users, onChanged, draft \}, null\);/, 'the one form of the page, not a second one');
  assert.match(entry, /if \(readOnly\(\)\) return false;\n\s*if \(dictate\) return startTaskDictation\(\{ user, onChanged \}\);/,
    'dictation starts before the first await');
  assert.match(tasks, /export function openPreparedNewTask\(\{[^\n]*\} = \{\}\) \{\n\s*openTaskModal\(\{ users: state\.users, onChanged, draft, spoken, heard \}, null\);/,
    'dictation fills that same form');
  const header = tasks.slice(tasks.indexOf('function openNewTaskForm('), tasks.indexOf('function wireNewTaskBtn('));
  assert.match(header, /openTaskModal\(\{ users: state\.users \}, container\);/, 'the head of Zadania opens the same modal');
  assert.match(tasks, /onSave\(panel\) \{[^}]*?\n\s*wireTaskForm\(panel, onChanged \? \{ task, container, onChanged \} : \{ task, container \}\);\n\s*\}/,
    'from outside, the caller refreshes its own surface instead of a list that is not there');
});

test('the saved options of the old tiles no longer filter Dziś: one plain /dashboard, start and refresh', () => {
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  assert.match(src, /const DASHBOARD_QUERY = '\/dashboard';/);
  assert.doesNotMatch(src, /dashboardQuery\(|layoutHintQuery|widgetConfig|dashboard_widgets/);
  const gets = [...src.matchAll(/api\.get\(overviewRequest\(([^)]*)\)\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(gets)], ['DASHBOARD_QUERY']);
  assert.ok(gets.length >= 2, 'the first load and the silent refresh');
});
