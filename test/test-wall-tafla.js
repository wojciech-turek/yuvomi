/**
 * Modul: The Tafla kitchen wall - model and view (2026-10-19)
 * Zweck: The wall was rebuilt after the approved artboard "Ściana". These
 *        guards hold what the artboard and the owner decided:
 *   1. the scene follows the clock (Rano, Dzień, Kolacja from 15:00 until
 *      dinner + 2h when a dinner is planned, Wieczór, Noc 22-6);
 *   2. the Teraz line ("Za 19 min kolacja · 20:00 Wieczór filmowy");
 *   3. no row cap: every open row is in the model, the view fits the height
 *      (`planWallRows` decides "+N więcej");
 *   4. the wall is nobody's screen - every assigned row carries its disc;
 *   5. READ-ONLY BY DEFAULT: no rings and no "+" chips unless the household
 *      allows ticking, and on the display only when it may tick for somebody;
 *      timers and Gotuj always there;
 *   6. the weekly question only on Sunday evening, and on the display only
 *      when the wall may write;
 *   7. the data stamp: "dane sprzed N min" once the last load is old;
 *   8. the markup: nothing navigates away, four timer discs, nothing on the
 *      wall below the 24px floor of the type steps.
 * Ausfuehren: npm run test:wall-tafla
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('./test-browser-loader.mjs', import.meta.url);

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { setDisplayTimeZone } = await import('../public/utils/timezone.js');
setDisplayTimeZone('Europe/Warsaw');
const wall = await import('../public/utils/wall-plan.js');
const view = await import('../public/components/wall-view.js');
const { WALL_TIMER_PRESETS } = await import('../public/components/wall-timer.js');

const W = { id: 1, display_name: 'Wojtek', avatar_color: '#007AFF' };
const M = { id: 2, display_name: 'Mariola', avatar_color: '#FF2D55' };
const at = (hhmm, day = '2026-10-19') => new Date(`${day}T${hhmm}:00+02:00`);

function household() {
  return {
    planTasks: [
      { id: 1, title: 'Oddać książki', status: 'open', due_date: '2026-10-16', assigned_users: [M] },
      { id: 2, title: 'Wynieść szkło i plastik', status: 'open', due_date: '2026-10-19', assigned_users: [W] },
      { id: 3, title: 'Zapłacić za prąd', status: 'open', due_date: '2026-10-19', assigned_users: [W] },
      { id: 4, title: 'Zamówić tort dla mamy', status: 'open', due_date: '2026-10-19', assigned_users: [M] },
      { id: 5, title: 'Odebrać paczkę', status: 'open', due_date: '2026-10-20', assigned_users: [M] },
      { id: 6, title: 'Bez osoby', status: 'open', due_date: '2026-10-19', assigned_users: [] },
    ],
    planEvents: [
      { id: 11, title: 'Wieczór filmowy', start_datetime: '2026-10-19T20:00', end_datetime: '2026-10-19T22:00', assigned_users: [W, M] },
      { id: 12, title: 'Przegląd auta', start_datetime: '2026-10-20T07:30', end_datetime: '2026-10-20T08:30', assigned_users: [W] },
    ],
    todayMeals: [{ id: 30, date: '2026-10-19', meal_type: 'dinner', title: 'Spaghetti bolognese', cook_user_id: 1, cook_name: 'Wojtek', recipe_id: 40 }],
    tomorrowMeals: [],
    dinnerPlan: { meal_id: 30, total: 6, have: 5, missing: [], on_list: ['śmietanka'] },
    shoppingOpenCount: 23,
    shoppingLists: [{ id: 9, name: 'Zakupy', items: [{ id: 91, name: 'mleko' }, { id: 92, name: 'śmietanka' }, { id: 93, name: 'brokuł' }, { id: 94, name: 'jajka' }] }],
    health: { doses: [] },
    wastePickups: [],
    users: [W, M],
  };
}

const sections = { dinner: true, plan: true, shopping: true, timers: true, weather: true };
const build = (hhmm, extra = {}, data = household(), day = '2026-10-19') => wall.buildWall(data, {
  now: at(hhmm, day), sections, ...extra,
});

// --------------------------------------------------------------------------
// 1. Scenes
// --------------------------------------------------------------------------

test('the scene follows the clock - Kolacja only with a planned dinner, from 15:00 until dinner + 2h', () => {
  assert.equal(build('07:30').scene, 'rano');
  assert.equal(build('12:00').scene, 'dzien');
  assert.equal(build('14:59').scene, 'dzien');
  assert.equal(build('15:00').scene, 'kolacja');
  assert.equal(build('18:11').scene, 'kolacja');
  assert.equal(build('20:29').scene, 'kolacja', 'dinner at 18:30 lingers two hours');
  assert.equal(build('20:30').scene, 'wieczor');
  assert.equal(build('22:41').scene, 'noc');
  assert.equal(build('03:00').scene, 'noc');
  const noDinner = { ...household(), todayMeals: [], dinnerPlan: null };
  assert.equal(build('18:11', {}, noDinner).scene, 'wieczor', 'no dinner, no Kolacja scene');
  assert.equal(build('16:00', {}, noDinner).scene, 'dzien');
  assert.equal(build('18:11', { sections: { ...sections, dinner: false } }).scene, 'wieczor', 'the household switched the dinner off');
});

test('Kolacja: the dinner is the hero (cook, meter) and not a row as well; before 15:00 it is a quiet card', () => {
  const m = build('18:11');
  assert.equal(m.hero.title, 'Spaghetti bolognese');
  assert.equal(m.hero.cook.id, W.id);
  assert.deepEqual(m.hero.meter, { total: 6, have: 5, caption: 'today.haveOf{"have":5,"total":6} · today.alreadyOnList{"items":"śmietanka"}' });
  assert.ok(!m.plan.rows.some((row) => row.kind === 'meal'), 'the hero is not repeated in Dziś');
  const morning = build('11:00');
  assert.equal(morning.hero, null);
  assert.equal(morning.dinner.title, 'Spaghetti bolognese', 'before the window: the dinner card');
  assert.equal(build('21:00').dinner, null, 'after the window no dinner card');
});

// --------------------------------------------------------------------------
// 2. Teraz
// --------------------------------------------------------------------------

test('the Teraz line: a violet lead and what follows', () => {
  const m = build('18:11');
  assert.deepEqual(m.teraz, {
    lead: 'today.inMinutes{"minutes":19}',
    text: 'today.dinnerShort · 20:00 Wieczór filmowy',
  });
  // Before the dinner window the dinner has its own card - the line names
  // what comes after it, not the dinner again.
  assert.deepEqual(build('11:00').teraz, { lead: '20:00', text: 'Wieczór filmowy' });
  // Everybody's events count on the wall, not only a viewer's: the film of
  // both of them runs at 20:45, after the dinner window.
  assert.deepEqual(build('20:45').teraz, { lead: 'today.now', text: 'Wieczór filmowy' });
  const evening = build('19:45', {}, { ...household(), todayMeals: [], dinnerPlan: null });
  assert.equal(evening.teraz.lead, 'today.inMinutes{"minutes":15}');
  assert.match(evening.teraz.text, /^Wieczór filmowy/);
});

// --------------------------------------------------------------------------
// 3. No row cap, a height budget
// --------------------------------------------------------------------------

test('no row cap: every open row of the day is in the model', () => {
  const many = household();
  for (let i = 0; i < 9; i += 1) {
    many.planTasks.push({ id: 100 + i, title: `Zadanie ${i}`, status: 'open', due_date: '2026-10-19', assigned_users: [] });
  }
  const m = build('12:00', {}, many);
  assert.equal(m.plan.rows.length, 15, 'six of the household plus nine more - nothing cut at four');
  const source = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  assert.ok(!/const WALL_ROW_CAP\s*=/.test(source), 'the fixed cap is gone');
});

test('planWallRows: what fits is shown, the last room says "+N więcej" - never instead of the only row', () => {
  assert.deepEqual(wall.planWallRows(4, 5), { shown: 4, more: 0 });
  assert.deepEqual(wall.planWallRows(5, 5), { shown: 5, more: 0 });
  assert.deepEqual(wall.planWallRows(9, 5), { shown: 4, more: 5 });
  assert.deepEqual(wall.planWallRows(3, 1), { shown: 1, more: 2 });
  assert.deepEqual(wall.planWallRows(0, 5), { shown: 0, more: 0 });
});

// --------------------------------------------------------------------------
// 4. Nobody's screen
// --------------------------------------------------------------------------

test('every assigned row carries its disc, a shared event the split disc and the violet edge', () => {
  const m = build('12:00');
  const by = (title) => m.plan.rows.find((row) => row.title === title);
  assert.equal(by('Zapłacić za prąd').who.kind, 'person', 'Wojtek\'s row: his disc, even though nobody is viewing');
  assert.equal(by('Zamówić tort dla mamy').who.kind, 'person');
  assert.equal(by('Bez osoby').who.kind, 'none');
  assert.equal(by('Wieczór filmowy').who.kind, 'razem');
  assert.equal(by('Wieczór filmowy').edge, 'accent');
  assert.equal(by('Wieczór filmowy').time, '20:00');
  assert.deepEqual(by('Oddać książki').pill, { tone: 'danger', text: 'today.overdue' });
  assert.equal(m.plan.rows[0].title, 'Oddać książki', 'overdue first');
});

// --------------------------------------------------------------------------
// 5. Read-only by default
// --------------------------------------------------------------------------

// The view escapes every value; the assertions read the text as the reader sees it.
const markup = (model) => view.renderWall(model, { clock: { time: '18:11', machine: '18:11' } }).replace(/&quot;/g, '"');

test('read-only by default: no rings, no "+" chips - the timer discs and Gotuj are there', () => {
  const m = build('18:11', { predictions: ['masło', 'kawa'] });
  assert.equal(m.canTick, false);
  assert.ok(m.plan.rows.every((row) => !row.checkable));
  const html = markup(m);
  assert.ok(!/data-wall-tick|wall-ring/.test(html), 'no check rings');
  assert.ok(!/data-wall-add/.test(html), 'no "+" chips');
  assert.match(html, /wall\.runningOut\{"items":"masło, kawa"\}/, '"Kończy się" is a quiet line');
  assert.match(html, /data-wall-cook/, 'Gotuj always works');
  assert.equal((html.match(/data-wall-timer-start=/g) ?? []).length, WALL_TIMER_PRESETS.length, 'the timer discs always work');
  assert.deepEqual(WALL_TIMER_PRESETS, [3, 5, 10, 15]);
});

test('with the switch on: rings on the task rows and "+" chips; on the display only with somebody to tick for', () => {
  const own = build('18:11', { mayWrite: true, predictions: ['masło'] });
  assert.equal(own.canTick, true, 'a person\'s own wall ticks as that person');
  const html = markup(own);
  assert.match(html, /data-wall-tick="task:3"/);
  assert.ok(!/data-wall-tick="event:/.test(html), 'events have no ring');
  assert.match(html, /data-wall-add="masło"/);

  assert.equal(build('18:11', { mayWrite: true, isDisplay: true, tickers: [] }).canTick, false,
    'a display nobody may be ticked for shows no rings');
  assert.equal(build('18:11', { mayWrite: true, isDisplay: true, tickers: null }).canTick, false);
  assert.equal(build('18:11', { mayWrite: true, isDisplay: true, tickers: [W] }).canTick, true);
  assert.equal(build('18:11', { mayWrite: false, isDisplay: true, tickers: [W] }).canTick, false, 'the household switch decides');
});

// --------------------------------------------------------------------------
// 6. The weekly question
// --------------------------------------------------------------------------

test('the weekly question: Sunday evening only, and on the display only when the wall may write', () => {
  const question = { id: 5, question: 'Czy jecie wieprzowinę?', options: ['Tak', 'Nie'] };
  const sunday = '2026-10-18';
  assert.equal(build('19:00', { question }, household(), sunday).question, question);
  assert.equal(build('17:59', { question }, household(), sunday).question, null, 'not before 18:00');
  assert.equal(build('19:00', { question }).question, null, 'not on a Monday');
  assert.equal(build('22:30', { question }, household(), sunday).question, null, 'not at night');
  assert.equal(build('19:00', { question, isDisplay: true }, household(), sunday).question, null, 'a read-only display does not answer');
  assert.equal(build('19:00', { question, isDisplay: true, mayWrite: true }, household(), sunday).question, question);
});

// --------------------------------------------------------------------------
// 7. Stale data
// --------------------------------------------------------------------------

test('the stale note: from twelve minutes without a good load', () => {
  const now = at('18:11');
  assert.equal(wall.staleMinutes(new Date(now.getTime() - 11 * 60_000), now), null);
  assert.equal(wall.staleMinutes(new Date(now.getTime() - 12 * 60_000), now), 12);
  assert.equal(wall.staleMinutes(null, now), null, 'never loaded is the loading state, not stale');
  const m = build('18:11', { lastLoadedAt: new Date(now.getTime() - 30 * 60_000) });
  assert.match(markup(m), /wall\.stale\{"minutes":30\}/);
});

// --------------------------------------------------------------------------
// 8. Markup
// --------------------------------------------------------------------------

test('the wall navigates nowhere, the night keeps only clock, date, tomorrow and the dock', () => {
  const html = markup(build('18:11', { mayWrite: true }));
  assert.ok(!/<a\b|href=|data-route=/.test(html), 'no link on the wall');
  const night = build('22:41');
  assert.equal(night.scene, 'noc');
  const nightHtml = markup(night);
  assert.match(nightHtml, /data-scene="noc"/);
  assert.ok(!/wall-hero|wall-plan|wall-shop/.test(nightHtml), 'no cards at night');
  assert.match(nightHtml, /today\.tomorrowPointer\{"what":"07:30 Przegląd auta"\}/);
  assert.match(nightHtml, /id="wall-exit"/);
});

test('a running timer takes the clock slot; the clock drops into the date line', () => {
  const m = build('18:11', { timer: { state: 'running', remainingMs: 522_000 } });
  const html = markup(m);
  assert.match(html, /class="wall__timer" data-state="running" role="timer"/);
  assert.match(html, /08:42/);
  assert.match(html, /wall__clock-small/);
  assert.ok(!/class="wall__clock u-rounded"/.test(html), 'the poster clock gave way');
});

test('the switches of the household hide their sections', () => {
  const off = build('18:11', { sections: { dinner: true, plan: false, shopping: false, timers: false, weather: false } });
  assert.equal(off.plan, null);
  assert.equal(off.shopping, null);
  const html = markup(off);
  assert.ok(!/data-wall-timer-start/.test(html), 'no discs with the timers off');
  assert.match(html, /wall-hero/);
});

test('nothing on the wall is set below the 24px floor: every font-size in the wall rules is a wall step', () => {
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const start = css.indexOf('Wand-Modus (Tafla, 2026-10-19)');
  const end = css.indexOf('/* ── Widget-Optionen (#814)');
  assert.ok(start > 0 && end > start, 'Reichweite: the wall block was found');
  const block = css.slice(start, end);
  const sizes = [...block.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(sizes.length >= 20, `Reichweite: ${sizes.length} font sizes read`);
  for (const size of sizes) {
    assert.match(size, /^var\(--wall-(display|title|body|label)\)$/, `font-size ${size} is not a wall step`);
  }
});
