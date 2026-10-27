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
  assert.deepEqual(rows.map((row) => row.due), ['calendar.relDay.yesterday', 'calendar.relDay.today', 'calendar.relDay.tomorrow', 'Do', '']);
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
    ['Daleko', '12. Nov.'],
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
  assert.deepEqual(at('10:15', (ctx) => dzis.birthdaysSoon({ birthdays: [data.birthdays[4]] }, ctx)), []);
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
  assert.match(html, /<a class="dz-head__me" href="\/settings"/);
  for (const gone of [/day-now/, /day-plan/, /day-closed/, /data-day-action="cook"/, /data-day-action="customize"/, /page-fab/, /today\.planTitle/]) {
    assert.doesNotMatch(html, gone, `${gone} is gone with v2`);
  }
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
  assert.match(html, /style="--dot: var\(--person-\d-dot, var\(--person-\d\)\)"/);
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
  assert.match(html, /<h2 class="dz-sec__title" id="dz-tasks-h">nav\.tasks <span class="dz-sec__count">9<\/span><\/h2>/);
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
  assert.match(body('.dz-card'), /border:\s*1px solid var\(--dz-card-edge\)/);
  assert.match(body('.dz-card'), /border-radius:\s*var\(--dz-radius\)/);
  assert.doesNotMatch(body('.dz-card'), /box-shadow/, 'v2 cards carry no shadow');
  assert.match(body('.dz-cal__row--now .dz-cal__link'), /color-mix\(in srgb, var\(--color-accent\) var\(--tint-wash\)/);
  assert.match(body('.dz-task__due--late'), /color:\s*var\(--dz-late\)/);
  assert.match(body('.dz-chart__bar--wet'), /background:\s*var\(--dz-rain\)/);
  assert.match(body('.day-check'), /inline-size:\s*var\(--target-base\)/);
  assert.match(body('.day-check'), /block-size:\s*var\(--target-base\)/);
  for (const sel of ['.dz-cal__earlier', '.dz-cal__tomorrow', '.dz-tasks__add', '.dz-soon__row']) {
    assert.match(body(sel), /min-block-size:\s*var\(--target-base\)/, `${sel} keeps a 44 hit`);
  }
  // The v2 tokens win once they are there; the design's values only stand in.
  const root = body('.dz');
  for (const token of ['--type-page', '--type-section', '--type-row', '--type-meta', '--color-overdue', '--color-rain', '--color-rain-soft', '--radius-card']) {
    assert.match(root, new RegExp(`var\\(${token},`), `${token} is read first`);
  }
});

test('"Tydzień" lands in the week: the calendar takes ?view= for one visit, without saving it', () => {
  const src = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  const branch = /\} else if \(VIEWS\.includes\(params\.get\('view'\)\)\) \{([\s\S]*?)\n {2}\}/.exec(src);
  assert.ok(branch, 'the ?view= branch after the day link');
  assert.match(branch[1], /state\.view = params\.get\('view'\);/);
  assert.doesNotMatch(branch[1], /setSavedCalendarView/, 'a link does not overwrite the remembered view');
});

test('the page ticks through the existing task API with an undo, and adds through the existing sheet', () => {
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  assert.match(src, /await api\.patch\(`\/tasks\/\$\{task\.id\}\/status`, \{ status: 'done' \}\);/);
  assert.match(src, /showToast\(t\('today\.toastDone', \{ title: row\.title \}\), 'default', 5000, async \(\) => \{/);
  assert.match(src, /await openCaptureSheet\(\{ context: 'task' \}\);/);
  assert.match(src, /canCheck: !onDisplay && moduleAccess\('tasks'\) === 'write',/);
});
