/**
 * Modul: Dziś (Tafla, 2026-10-19) - server fields and the day-plan model
 * Zweck: The start page became one checkable day plan. These guards hold:
 *   1. /dashboard carries what the plan needs (planTasks, planEvents,
 *      tomorrowMeals, dinnerPlan, health.doses, users.family_role), only for
 *      the viewer, never for the wall's household answer, empty for a module
 *      that is off or denied;
 *   2. the model orders the plan (overdue first, then by time, then what has
 *      no time), folds what is over into "Wcześniej", counts "3 z 9";
 *   3. Teraz follows the spec's priority; "Dzień ogarnięty" only when nothing
 *      is left; the person rule (own: no disc, someone else's: initial,
 *      shared: razem);
 *   4. the view never draws the family card in a two-adult home and names
 *      every check circle.
 * Ausfuehren: npm run test:dashboard-tafla
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { register } from 'node:module';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

register('./test-browser-loader.mjs', import.meta.url);

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'dashboard-tafla-test-secret';

const { resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');

function buildMigratedDatabase(migrations) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) {
    if (typeof migration.up === 'function') migration.up(database);
    else database.exec(migration.up);
    if (typeof migration.afterUp === 'function') migration.afterUp(database);
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  }
  return database;
}

const moduleDatabase = get();
const db = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(db);
moduleDatabase.close();

const addUser = (name, color, role) => db.prepare(`
  INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
  VALUES (?, ?, 'hash', ?, ?, 'parent')
`).run(`tafla-${name}-${randomUUID()}`, name, color, role).lastInsertRowid;
const WOJTEK = addUser('Wojtek', '#007AFF', 'admin');
const MARIOLA = addUser('Mariola', '#FF2D55', 'member');

let viewer = MARIOLA;
const app = express();
app.use((req, _res, next) => {
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(viewer);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.session = { userId: user.id, role: user.role };
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(db, user));
  next();
});
app.use('/', dashboardRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

async function getJson(path) {
  const res = await fetch(`${base}${path}`);
  assert.equal(res.status, 200, `${path}: ${res.status}`);
  return res.json();
}

// Monday 19 October 2026, 18:10 in Warsaw.
const NOW = '2026-10-19T16:10:00Z';
function atNow(fn) {
  return async () => {
    db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Warsaw')").run();
    mock.timers.enable({ apis: ['Date'], now: new Date(NOW) });
    try { await fn(); } finally { mock.timers.reset(); }
  };
}

function addTask(title, { due = null, time = null, status = 'open', people = [], visibility = 'all', description = null, completedAt = null } = {}) {
  const id = db.prepare(`
    INSERT INTO tasks (title, description, due_date, due_time, status, created_by, visibility)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(title, description, due, time, status, WOJTEK, visibility).lastInsertRowid;
  for (const userId of people) db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(id, userId);
  if (completedAt) {
    db.prepare('INSERT INTO task_completions (task_id, series_id, completed_at, user_id) VALUES (?, ?, ?, ?)').run(id, id, completedAt, MARIOLA);
  }
  return id;
}

// --------------------------------------------------------------------------
// 1. The server fields
// --------------------------------------------------------------------------

test('planTasks: overdue, today, tomorrow and what was finished today - not later, not done yesterday', atNow(async () => {
  addTask('Oddać książki', { due: '2026-10-16', people: [MARIOLA] });
  addTask('Zamówić tort', { due: '2026-10-19', time: '19:00', people: [MARIOLA], description: 'cukiernia Lajkonik\nzadzwonić rano' });
  addTask('Odebrać paczkę', { due: '2026-10-20', people: [MARIOLA] });
  addTask('Za tydzień', { due: '2026-10-26' });
  addTask('Podlać kwiaty', { due: '2026-10-19', status: 'done', completedAt: '2026-10-19T08:00:00.000Z' });
  addTask('Wczoraj zrobione', { due: '2026-10-18', status: 'done', completedAt: '2026-10-18T08:00:00.000Z' });
  addTask('Prywatne Wojtka', { due: '2026-10-19', visibility: 'private' });
  viewer = MARIOLA;
  const { planTasks } = await getJson('/');
  const titles = planTasks.map((task) => task.title).sort();
  assert.deepEqual(titles, ['Odebrać paczkę', 'Oddać książki', 'Podlać kwiaty', 'Zamówić tort'].sort());
  const tort = planTasks.find((task) => task.title === 'Zamówić tort');
  assert.equal(tort.meta, 'cukiernia Lajkonik', 'the first line of the description is the meta');
  assert.equal(tort.description, undefined, 'the description itself stays in the task');
  assert.deepEqual(tort.assigned_users.map((user) => user.id), [MARIOLA]);
}));

test('planEvents: today and tomorrow with place and people, ended ones included', atNow(async () => {
  const add = (title, start, end, people = [], location = null) => {
    const id = db.prepare(`
      INSERT INTO calendar_events (title, start_datetime, end_datetime, location, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(title, start, end, location, WOJTEK).lastInsertRowid;
    for (const userId of people) db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, userId);
  };
  add('Joga', '2026-10-19T17:00', '2026-10-19T18:00', [MARIOLA]);
  add('Wieczór filmowy', '2026-10-19T20:00', '2026-10-19T22:00', [WOJTEK, MARIOLA], 'w domu');
  add('Przegląd auta', '2026-10-20T10:00', '2026-10-20T11:00', [WOJTEK]);
  add('Za dwa dni', '2026-10-21T10:00', '2026-10-21T11:00');
  const { planEvents } = await getJson('/');
  assert.deepEqual(planEvents.map((event) => event.title).sort(), ['Joga', 'Przegląd auta', 'Wieczór filmowy'].sort());
  const film = planEvents.find((event) => event.title === 'Wieczór filmowy');
  assert.equal(film.location, 'w domu');
  assert.deepEqual(film.assigned_users.map((user) => user.id).sort(), [WOJTEK, MARIOLA].sort());
}));

test('dinnerPlan: tonight\'s ingredients against the pantry and the open list', atNow(async () => {
  const recipe = db.prepare('INSERT INTO recipes (title, created_by) VALUES (?, ?)').run('Spaghetti bolognese', WOJTEK).lastInsertRowid;
  for (const name of ['makaron spaghetti', 'pomidory w puszce', 'cebula', 'śmietanka', 'parmezan']) {
    db.prepare('INSERT INTO recipe_ingredients (recipe_id, name) VALUES (?, ?)').run(recipe, name);
  }
  const meal = db.prepare(`
    INSERT INTO meals (date, meal_type, title, recipe_id, cook_user_id, created_by) VALUES ('2026-10-19', 'dinner', 'Spaghetti bolognese', ?, ?, ?)
  `).run(recipe, WOJTEK, WOJTEK).lastInsertRowid;
  db.prepare("INSERT INTO meals (date, meal_type, title, created_by) VALUES ('2026-10-20', 'dinner', 'Łosoś', ?)").run(WOJTEK);
  for (const name of ['makaron spaghetti', 'pomidory', 'cebula']) {
    db.prepare('INSERT INTO pantry_items (name, quantity, created_by) VALUES (?, 1, ?)').run(name, WOJTEK);
  }
  const list = db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Zakupy', ?)").run(WOJTEK).lastInsertRowid;
  db.prepare("INSERT INTO shopping_items (list_id, name) VALUES (?, 'Parmezan')").run(list);
  const { dinnerPlan, tomorrowMeals } = await getJson('/');
  assert.equal(dinnerPlan.meal_id, meal);
  assert.equal(dinnerPlan.total, 5);
  assert.equal(dinnerPlan.have, 3, '"pomidory" in the pantry covers "pomidory w puszce"');
  assert.deepEqual(dinnerPlan.missing, ['śmietanka']);
  assert.deepEqual(dinnerPlan.on_list, ['parmezan'], 'an open list item is not offered again');
  assert.deepEqual(tomorrowMeals.map((m) => m.title), ['Łosoś']);
}));

test('health.doses: each own dose of today with its log row, nobody else\'s', atNow(async () => {
  const med = db.prepare("INSERT INTO medications (user_id, name, active) VALUES (?, 'Żelazo', 1)").run(MARIOLA).lastInsertRowid;
  const morning = db.prepare("INSERT INTO medication_schedules (medication_id, time_of_day, active) VALUES (?, '08:00', 1)").run(med).lastInsertRowid;
  db.prepare("INSERT INTO medication_schedules (medication_id, time_of_day, active) VALUES (?, '21:00', 1)").run(med);
  db.prepare("INSERT INTO medication_logs (medication_id, schedule_id, scheduled_at, status, taken_at) VALUES (?, ?, '2026-10-19T08:00', 'taken', '2026-10-19T08:05')").run(med, morning);
  const other = db.prepare("INSERT INTO medications (user_id, name, active) VALUES (?, 'Wojtka', 1)").run(WOJTEK).lastInsertRowid;
  db.prepare("INSERT INTO medication_schedules (medication_id, time_of_day, active) VALUES (?, '09:00', 1)").run(other);
  viewer = MARIOLA;
  const { health } = await getJson('/');
  assert.deepEqual(health.doses.map((d) => [d.name, d.time, d.status]), [['Żelazo', '08:00', 'taken'], ['Żelazo', '21:00', 'pending']]);
  assert.ok(health.doses[0].log_id, 'a logged dose names its log row');
  assert.equal(health.doses[1].log_id, null);
}));

// TAFLA WALL (2026-10-19): this test said "the household answer carries none of
// the plan fields" - the old wall drew its own program. The Tafla wall draws
// the day plan of Dziś, so the household answer now carries the plan in its
// HOUSEHOLD version: only what everybody may see (visibility 'all'), never a
// private task, never anybody's doses. The guard keeps that intent.
test('the wall\'s household answer carries the plan - only what everybody may see, never doses', atNow(async () => {
  addTask('Dla wszystkich', { due: '2026-10-19', people: [MARIOLA] });
  addTask('Tylko przypisani', { due: '2026-10-19', people: [MARIOLA], visibility: 'assignees' });
  addTask('Prywatne', { due: '2026-10-19', visibility: 'private' });
  viewer = MARIOLA;
  const personal = await getJson('/');
  const answer = await getJson('/?audience=household');
  assert.ok(personal.planTasks.some((task) => task.title === 'Tylko przypisani'), 'Reichweite: Mariola sees her own');
  const titles = answer.planTasks.map((task) => task.title);
  assert.ok(titles.includes('Dla wszystkich'), 'the household plan has the shared task');
  assert.ok(!titles.includes('Tylko przypisani') && !titles.includes('Prywatne'), 'and nothing private, even from the session of its assignee');
  assert.deepEqual(answer.health.doses, [], 'doses never reach a shared surface');
}));

test('users carry family_role, so Dziś can count the adults', atNow(async () => {
  const { users } = await getJson('/');
  assert.ok(users.every((user) => typeof user.family_role === 'string'));
}));

// --------------------------------------------------------------------------
// 2.-3. The model
// --------------------------------------------------------------------------

const { setDisplayTimeZone } = await import('../public/utils/timezone.js');
setDisplayTimeZone('Europe/Warsaw');
const plan = await import('../public/utils/today-plan.js');

const W = { id: 1, display_name: 'Wojtek', avatar_color: '#007AFF' };
const M = { id: 2, display_name: 'Mariola', avatar_color: '#FF2D55' };
const ctxAt = (hhmm, extra = {}) => plan.planContext({
  now: new Date(`2026-10-19T${hhmm}:00+02:00`), viewer: M, users: [W, M], ...extra,
});

function sampleData() {
  return {
    planTasks: [
      { id: 1, title: 'Oddać książki', status: 'open', due_date: '2026-10-16', assigned_users: [M] },
      { id: 2, title: 'Zamówić tort', status: 'open', due_date: '2026-10-19', due_time: '19:00', assigned_users: [M], meta: 'cukiernia Lajkonik' },
      { id: 3, title: 'Zapłacić za prąd', status: 'open', due_date: '2026-10-19', assigned_users: [W] },
      { id: 4, title: 'Podlać kwiaty', status: 'done', due_date: '2026-10-19', assigned_users: [M] },
      { id: 5, title: 'Odebrać paczkę', status: 'open', due_date: '2026-10-20', assigned_users: [M] },
    ],
    planEvents: [
      { id: 10, title: 'Joga', start_datetime: '2026-10-19T17:00', end_datetime: '2026-10-19T18:00', assigned_users: [M] },
      { id: 11, title: 'Wieczór filmowy', start_datetime: '2026-10-19T20:00', end_datetime: '2026-10-19T22:00', location: 'w domu', assigned_users: [W, M] },
      { id: 12, title: 'Przegląd auta', start_datetime: '2026-10-20T10:00', end_datetime: '2026-10-20T11:00', assigned_users: [W] },
    ],
    health: { doses: [{ medication_id: 7, schedule_id: 8, name: 'Żelazo', time: '21:00', status: 'pending', log_id: null }] },
    todayMeals: [{ id: 30, meal_type: 'dinner', title: 'Spaghetti', cook_user_id: 1, cook_name: 'Wojtek', recipe_id: 40 }],
    tomorrowMeals: [{ id: 31, meal_type: 'dinner', title: 'Łosoś' }],
    dinnerPlan: { meal_id: 30, total: 6, have: 5, missing: ['śmietanka'], on_list: [] },
    wastePickups: [],
    users: [W, M],
  };
}

test('the plan: overdue first, then by time, then what has no time; the past folds into Wcześniej', () => {
  const ctx = ctxAt('18:10');
  const p = plan.buildPlan(sampleData(), ctx);
  assert.deepEqual(p.open.map((row) => row.title), [
    'Oddać książki', 'today.mealRow{"meal":"dinner","title":"Spaghetti"}', 'Zamówić tort', 'Wieczór filmowy', 'Żelazo', 'Zapłacić za prąd',
  ]);
  assert.deepEqual(p.earlier.map((row) => row.title), ['Podlać kwiaty', 'Joga']);
  assert.equal(p.open[0].pill?.tone, 'danger', 'overdue says so in a danger pill');
  assert.equal(p.checkTotal, 5, 'four tasks of today and the dose');
  assert.equal(p.checkDone, 1);
  assert.ok(!p.open.some((row) => row.title === 'Odebrać paczkę'), 'tomorrow\'s task is not today\'s plan');
});

test('the person rule: own rows no disc, someone else\'s their initial, shared ones razem', () => {
  const p = plan.buildPlan(sampleData(), ctxAt('18:10'));
  const by = (title) => p.all.find((row) => row.title === title);
  assert.equal(by('Zamówić tort').who.kind, 'none');
  assert.equal(by('Zapłacić za prąd').who.kind, 'person');
  assert.equal(by('Zapłacić za prąd').who.person.id, 1);
  assert.equal(by('Wieczór filmowy').who.kind, 'razem');
  assert.equal(by('Żelazo').who.kind, 'none', 'own medicine carries no disc');
});

test('Teraz: a running timer comes first, then an event of mine within the hour, then dinner, then the next item', () => {
  const data = sampleData();
  const at = (hhmm, extra) => {
    const ctx = ctxAt(hhmm);
    return plan.pickNow(data, plan.buildPlan(data, ctx), ctx, extra);
  };
  assert.equal(at('18:10', { timer: { state: 'running', remainingMs: 60_000 } }).mode, 'timer');
  assert.equal(at('19:30').mode, 'event', 'Wieczór filmowy at 20:00 is within the hour and shared');
  const dinner = at('18:10');
  assert.equal(dinner.mode, 'dinner');
  assert.equal(dinner.minutes, 20);
  assert.equal(dinner.ingredients.missing[0], 'śmietanka');
  assert.equal(at('13:30').mode, 'free', 'nothing within three hours at half past one');
  assert.equal(at('14:10').mode, 'next', 'Joga at 17:00 is within three hours');
  assert.equal(at('15:10').mode, 'dinner', 'dinner from 15:00');
  assert.equal(at('16:30').mode, 'event', 'Joga at 17:00 is mine and within the hour - it goes before dinner');
  const later = plan.pickNow({ ...data, todayMeals: [] }, plan.buildPlan({ ...data, todayMeals: [] }, ctxAt('18:10')), ctxAt('18:10'));
  assert.equal(later.mode, 'next');
  assert.equal(later.row.title, 'Zamówić tort');
});

test('Dzień ogarnięty only when every checkable row is done and nothing timed is ahead', () => {
  const data = sampleData();
  assert.equal(plan.dayClosed(plan.buildPlan(data, ctxAt('18:10'))), false);
  const done = {
    ...data,
    planTasks: data.planTasks.map((task) => ({ ...task, status: task.due_date <= '2026-10-19' ? 'done' : task.status })),
    health: { doses: [{ ...data.health.doses[0], status: 'taken', taken_at: '2026-10-19T21:02' }] },
  };
  assert.equal(plan.dayClosed(plan.buildPlan(done, ctxAt('22:30'))), true);
  assert.equal(plan.dayClosed(plan.buildPlan(done, ctxAt('19:00'))), false, 'the film at 20:00 is still ahead');
  assert.equal(plan.dayClosed(plan.buildPlan({}, ctxAt('22:30'))), false, 'an empty day is not a closed one');
});

test('Jutro: put-out tonight, tomorrow\'s events and tasks with their people, dinner last', () => {
  const data = { ...sampleData(), wastePickups: [{ date_key: '2026-10-20', type_name: 'bio' }] };
  const { rows } = plan.buildTomorrow(data, ctxAt('18:10'));
  assert.deepEqual(rows.map((row) => row.kind), ['waste', 'event', 'task', 'meal']);
  assert.equal(rows[1].who.kind, 'person', 'Wojtek\'s car service carries his disc');
});

test('Wkrótce: birthdays and countdowns within two weeks, nearest first', () => {
  const data = {
    birthdays: [{ id: 1, name: 'Mama', kind: 'birthday', days_until: 8, next_age: 60 }, { id: 2, name: 'Daleko', kind: 'birthday', days_until: 40 }],
    countdowns: [{ id: 3, source: 'event', title: 'Wyjazd', days_until: 2, date: '2026-10-21' }],
  };
  const rows = plan.buildSoon(data, ctxAt('18:10'));
  assert.deepEqual(rows.map((row) => row.days), [2, 8]);
});

// --------------------------------------------------------------------------
// 4. The view
// --------------------------------------------------------------------------

const view = await import('../public/components/today-view.js');

function pageFor(data, hhmm = '18:10', extra = {}) {
  const ctx = ctxAt(hhmm);
  const { plan: p, now } = plan.buildDay(data, ctx);
  return view.renderTodayPage({
    user: M, ctx, weather: null, showWeather: false, plan: p, now, closed: plan.dayClosed(p),
    tomorrow: plan.buildTomorrow(data, ctx), soon: [], shopping: null, question: null,
    sections: ['today-shopping', 'today-tomorrow', 'today-question', 'today-soon'], tiles: new Map(), extensions: new Map(),
    family: [], earlierOpen: false, firstRun: false, canCustomize: true, canCheck: () => true, canWriteShopping: true,
    ...extra,
  });
}

test('the page: every check circle has a name, the plan has its count, no family card in a two-adult home', () => {
  const html = pageFor(sampleData());
  const circles = [...html.matchAll(/class="day-check[^"]*"[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(circles.length >= 4);
  assert.ok(circles.every(Boolean));
  assert.match(html, /today\.countOf\{&quot;done&quot;:1,&quot;total&quot;:5\}/);
  assert.doesNotMatch(html, /data-row-key="meal:30"/, 'the dinner on the Teraz card is no second row');
  assert.doesNotMatch(html, /family-widget|dashboard\.familyTitle/, 'Jutro replaces the family card');
  assert.match(html, /today\.togetherWith/, 'the shared film night carries the razem disc');
  assert.match(html, /data-day-action="cook"/, 'dinner mode offers Gotuj');
});

test('the closed day draws the end card instead of Teraz, with a peek at tomorrow', () => {
  const data = sampleData();
  const done = {
    ...data,
    planTasks: data.planTasks.map((task) => ({ ...task, status: task.due_date <= '2026-10-19' ? 'done' : task.status })),
    health: { doses: [{ ...data.health.doses[0], status: 'taken' }] },
  };
  const html = pageFor(done, '22:30');
  assert.match(html, /class="day-closed"/);
  assert.match(html, /today\.closedTitle/);
  assert.doesNotMatch(html, /class="day-now/);
  assert.match(html, /day-closed__tomorrow/);
});

test('first run: Zacznij tutaj with starter chips, no Teraz and no plan', () => {
  const html = pageFor({}, '10:00', { firstRun: true });
  assert.match(html, /today\.firstRunTitle/);
  assert.doesNotMatch(html, /day-now|day-plan/);
});

// --------------------------------------------------------------------------
// What the old cockpit's browser tests protected, on Dziś (2026-10-26)
// --------------------------------------------------------------------------

const ev = (id, title, start, end, extra = {}) => ({ id, title, start_datetime: start, end_datetime: end, all_day: 0, assigned_users: [], ...extra });
const titlesOf = (rows) => rows.map((row) => row.title);

test('#1457: an event from yesterday stands today - running all day, ending today "do", ended folded away', () => {
  // 10:00 on a Thursday: a trip until tomorrow, a night shift until 08:00, the
  // way home until 12:00, a two-day all-day trip, and one this evening.
  const p = plan.buildPlan({ planEvents: [
    ev(1, 'Reise', '2026-10-18T18:00', '2026-10-20T12:00'),
    ev(2, 'Nachtschicht', '2026-10-18T18:00', '2026-10-19T08:00'),
    ev(3, 'Heimweg', '2026-10-18T20:00', '2026-10-19T12:00'),
    ev(4, 'Klassenfahrt', '2026-10-18', '2026-10-20', { all_day: 1 }),
    ev(5, 'Heute abend', '2026-10-19T19:00', '2026-10-19T20:00'),
  ] }, ctxAt('10:00'));
  const by = Object.fromEntries(p.all.map((row) => [row.title, row]));
  assert.equal(by.Reise.timeLabel, 'today.allDay', 'over today and beyond: all day, not the start of yesterday');
  assert.equal(by.Klassenfahrt.timeLabel, 'today.allDay');
  assert.equal(by.Heimweg.timeLabel, 'calendar.spanUntil{"time":"12:00"}', 'ends today: "do 12:00"');
  assert.deepEqual(titlesOf(p.earlier), ['Nachtschicht'], 'over at 08:00: in Wcześniej, not "all day" until midnight');
  assert.ok(!titlesOf(p.open).includes('Nachtschicht'));
  // After 12:00 the way home is over as well.
  const later = plan.buildPlan({ planEvents: [ev(3, 'Heimweg', '2026-10-18T20:00', '2026-10-19T12:00')] }, ctxAt('12:30'));
  assert.deepEqual(titlesOf(later.earlier), ['Heimweg']);
  // An end at exactly 00:00 closes the day before (#804): yesterday's party
  // until midnight is not on today's plan.
  const midnight = plan.buildPlan({ planEvents: [ev(6, 'Bis Mitternacht', '2026-10-17T18:00', '2026-10-19T00:00')] }, ctxAt('10:00'));
  assert.deepEqual(titlesOf(midnight.all), []);
});

test('#1457/#1534: the household zone decides the day and the time, not the device', () => {
  try {
    // 10:00 in Honolulu is 20:00 UTC. Both events as synchronised instants.
    setDisplayTimeZone('Pacific/Honolulu');
    const ctx = plan.planContext({ now: new Date('2026-09-24T20:00:00Z'), viewer: M, users: [W, M] });
    const p = plan.buildPlan({ planEvents: [
      ev(1, 'Reise', '2026-09-24T04:00:00.000Z', '2026-09-25T22:00:00.000Z'), // 23.09. 18:00 - 25.09. 12:00
      ev(2, 'Abend', '2026-09-25T05:00:00.000Z', '2026-09-25T06:00:00.000Z'), // 24.09. 19:00
    ] }, ctx);
    assert.deepEqual(p.open.map((row) => [row.title, row.time]), [['Abend', '19:00'], ['Reise', '']],
      'the evening at 19:00 household time, the trip running all day');
  } finally {
    setDisplayTimeZone('Europe/Warsaw');
  }
  // A task's due time is the wall time as typed (#1534) - no zone turns it.
  try {
    setDisplayTimeZone('America/New_York');
    const ctx = plan.planContext({ now: new Date('2026-10-19T12:00:00Z'), viewer: M, users: [W, M] });
    const p = plan.buildPlan({ planTasks: [
      { id: 1, title: 'Muell', status: 'open', due_date: '2026-10-19', due_time: '18:00', assigned_users: [] },
      { id: 2, title: 'Spaet', status: 'open', due_date: '2026-10-19', due_time: '23:30:00', assigned_users: [] },
      { id: 3, title: 'Frueh', status: 'open', due_date: '2026-10-19', due_time: '06:15', assigned_users: [] },
    ] }, ctx);
    assert.deepEqual(p.all.map((row) => [row.title, row.time]).sort(), [['Frueh', '06:15'], ['Muell', '18:00'], ['Spaet', '23:30']]);
  } finally {
    setDisplayTimeZone('Europe/Warsaw');
  }
});

test('#1698: an event row names its calendar - a place or "razem" comes first, and the view escapes it', () => {
  const p = plan.buildPlan({ planEvents: [
    ev(1, 'Frueh', '2026-10-19T14:00', '2026-10-19T22:00', { cal_name: 'Niklas Arbeitskalender', assigned_users: [M] }),
    ev(2, 'Sync', '2026-10-19T15:00', '2026-10-19T16:00', { cal_name: 'Haushalt', source_calendar_name: 'Google: Familie', assigned_users: [M] }),
    ev(3, 'Boese', '2026-10-19T16:00', '2026-10-19T17:00', { cal_name: '<img src=x>', assigned_users: [M] }),
    ev(4, 'Mit Ort', '2026-10-19T17:00', '2026-10-19T18:00', { cal_name: 'Kalender', location: 'Turnhalle', assigned_users: [M] }),
    ev(5, 'Nur in Yuvomi', '2026-10-19T18:00', '2026-10-19T19:00', { assigned_users: [M] }),
  ] }, ctxAt('10:00'));
  const meta = Object.fromEntries(p.all.map((row) => [row.title, row.meta]));
  assert.equal(meta.Frueh, 'Niklas Arbeitskalender');
  assert.equal(meta.Sync, 'Google: Familie', 'the synchronised source calendar first, as in the calendar module');
  assert.equal(meta['Mit Ort'], 'Turnhalle', 'a place is the better second line');
  assert.equal(meta['Nur in Yuvomi'], '', 'no calendar, no word');
  const html = view.renderPlanRow(p.all.find((row) => row.title === 'Boese'), { canCheck: () => false });
  assert.ok(html.includes('&lt;img src=x&gt;') && !html.includes('<img src=x>'), 'the name is user input and goes through esc()');
  const frueh = view.renderPlanRow(p.all.find((row) => row.title === 'Frueh'), { canCheck: () => false });
  assert.ok(frueh.includes('14:00') && !frueh.includes('22:00'), 'no span on Dziś: the start, not the end');
});

