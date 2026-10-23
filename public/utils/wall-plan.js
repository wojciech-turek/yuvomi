/**
 * Modul: The kitchen wall as a model (Tafla, 2026-10-19)
 * Zweck: What the wall says, without markup: its scene (Rano, Dzień, Kolacja,
 *        Wieczór, Noc), the header's Teraz line, tonight's dinner as the hero
 *        from 15:00 until dinner + 2h, the Dziś card's rows with their person
 *        discs, the shopping card, "Jutro" in the evening, the weekly question
 *        on Sunday evenings and whether the data is stale. The view
 *        (components/wall-view.js) only draws what this returns.
 * Abhängigkeiten: /i18n.js, /utils/today-plan.js, /utils/timezone.js,
 *                 /utils/wall-mode.js (the night window)
 *
 * THE WALL IS NOBODY'S SCREEN. It is built with no viewer, so every row that
 * belongs to somebody carries their disc (Dziś leaves your own rows bare - on
 * the wall there is no "you"), a row of two people the split disc. The data is
 * the household answer of GET /dashboard (`audience=household`): only what
 * everybody may see.
 *
 * NO ROW CAP. The old wall stopped at four rows (WALL_ROW_CAP). The Dziś card
 * now lists every open row and the view fits it to the height it has
 * (`fitWallLists` in wall-view.js): what does not fit becomes "+N więcej".
 * `planWallRows` is that decision as a pure function.
 */

import { t, formatTime } from '/i18n.js';
import { zonedDateKey, zonedTimeKey } from '/utils/timezone.js';
import { isWallNight } from '/utils/wall-mode.js';
import {
  planContext, buildDay, buildTomorrow, dayClosed, minutesOf, firstName, MEAL_TIMES, DINNER_FROM, DINNER_LINGER_MIN,
} from '/utils/today-plan.js';

/** Until when it is morning on the wall. */
export const MORNING_UNTIL = '10:00';
/** From when the wall's day turns into the evening (without a dinner window). */
export const EVENING_FROM = '17:00';
/** The weekly question shows on Sunday from this time until the night. */
export const QUESTION_FROM = '18:00';
/** After this many minutes without a successful load the wall says so. */
export const STALE_AFTER_MIN = 12;
/** The wall reloads its data this often (it is looked at, not used). */
export const WALL_REFRESH_MS = 5 * 60 * 1000;
/** How many rows "Jutro" shows on the evening wall. */
export const WALL_TOMORROW_ROWS = 3;
/** How many items the shopping card names before "+N". */
export const WALL_SHOPPING_NAMES = 3;

/** The sections the household can switch (services/wall-settings.js). */
export const WALL_SECTION_IDS = Object.freeze(['dinner', 'plan', 'shopping', 'timers', 'weather']);

/** Every section on unless the household said otherwise. */
export function normalizeWallSections(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return Object.fromEntries(WALL_SECTION_IDS.map((id) => [id, source[id] !== false]));
}

/**
 * The scene by the clock:
 *   noc      22:00-06:00 (the night window of wall-mode.js)
 *   kolacja  a dinner is planned and it is 15:00 until dinner + 2h
 *   rano     06:00-10:00
 *   wieczor  from 17:00, or after the dinner window
 *   dzien    the rest of the day
 */
export function wallScene({ night = false, nowMin, dinnerWindow = false, dinnerOver = false }) {
  if (night) return 'noc';
  if (dinnerWindow) return 'kolacja';
  if (nowMin < minutesOf(MORNING_UNTIL)) return 'rano';
  if (dinnerOver || nowMin >= minutesOf(EVENING_FROM)) return 'wieczor';
  return 'dzien';
}

/**
 * The height budget as a decision: `fits` rows of `total` have room. When not
 * all fit, the last room goes to the "+N więcej" line - but never the only one.
 * @returns {{ shown: number, more: number }}
 */
export function planWallRows(total, fits) {
  const rows = Math.max(0, Math.floor(Number(total) || 0));
  const room = Math.max(0, Math.floor(Number(fits) || 0));
  if (rows <= room) return { shown: rows, more: 0 };
  const shown = Math.max(1, room - 1);
  return { shown: Math.min(shown, rows), more: rows - Math.min(shown, rows) };
}

/** Minutes since the last good load, or null when it is fresh (or never loaded). */
export function staleMinutes(lastLoadedAt, now = new Date()) {
  if (!lastLoadedAt) return null;
  const minutes = Math.floor((now.getTime() - new Date(lastLoadedAt).getTime()) / 60_000);
  return minutes >= STALE_AFTER_MIN ? minutes : null;
}

function isSunday(dayKey) {
  return new Date(`${dayKey}T12:00:00Z`).getUTCDay() === 0;
}

/** "Za 19 min" / "O 18:30" / "Teraz" for something at `time` that is `minutes` away. */
function leadFor(minutes, time) {
  if (minutes <= 0) return t('today.now');
  if (minutes < 60) return t('today.inMinutes', { minutes });
  return t('today.atTime', { time: formatTime(time) });
}

function clockTime(min) {
  const h = Math.floor(min / 60) % 24;
  return `${String(h).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/**
 * The header's Teraz line: a violet lead ("Za 19 min") and the rest in ink
 * ("kolacja · 20:00 Wieczór filmowy"). Null when there is nothing to say.
 */
export function terazLine(now, plan, { closed = false } = {}) {
  const tail = (then) => (then?.row ? ` · ${then.row.timeLabel} ${then.row.title}`.replace(/\s+/g, ' ') : '');
  if (!now) return null;
  if (now.mode === 'event') {
    const lead = now.row.running ? t('today.now') : leadFor(now.minutes, now.row.time);
    return { lead, text: `${now.row.title}${tail(now.then)}` };
  }
  if (now.mode === 'dinner') {
    return { lead: leadFor(now.minutes, MEAL_TIMES.dinner), text: `${t('today.dinnerShort')}${tail(now.then)}` };
  }
  if (now.mode === 'next') {
    return { lead: leadFor(now.minutes, now.row.time), text: `${now.row.title}${tail(now.then)}` };
  }
  if (now.mode === 'timer') {
    return now.then?.row ? { lead: now.then.row.timeLabel, text: now.then.row.title } : null;
  }
  if (closed) return { lead: '', text: t('wall.allDone') };
  if (now.evening) return { lead: '', text: t('today.freeEvening') };
  if (now.then?.row) return { lead: now.then.row.timeLabel, text: now.then.row.title };
  return plan?.open?.length ? null : { lead: '', text: t('today.nothingLeft') };
}

/** The edge of a row: violet for "razem", the person's ink for one person, none otherwise. */
function rowEdge(row) {
  if (row.kind !== 'event') return null;
  if (row.who.kind === 'razem') return 'accent';
  if (row.who.kind === 'person') return 'person';
  return null;
}

/** A plan row as the wall draws it. */
function wallRow(row, { canTick }) {
  const timed = Number.isFinite(row.sortMin) && Boolean(row.time) && !row.overdue;
  return {
    key: row.key,
    kind: row.kind,
    id: row.id,
    title: row.title,
    time: timed ? row.timeLabel : '',
    pill: row.overdue ? row.pill : null,
    who: row.who,
    people: row.people ?? [],
    edge: rowEdge(row),
    checkable: canTick && row.kind === 'task' && row.checkable && !row.done,
  };
}

function dinnerCard(now, data, ctx) {
  const meal = now.meal;
  const cook = now.cook ?? null;
  const ingredients = now.ingredients && now.ingredients.total > 0 ? now.ingredients : null;
  let caption = '';
  if (ingredients) {
    const parts = [t('today.haveOf', { have: ingredients.have, total: ingredients.total })];
    const missing = ingredients.missing ?? [];
    const onList = ingredients.on_list ?? [];
    if (missing.length) parts.push(t('today.toBuy', { items: missing.join(', ') }));
    else if (onList.length) parts.push(t('today.alreadyOnList', { items: onList.join(', ') }));
    caption = parts.join(' · ');
  }
  return {
    meal,
    title: String(meal.title ?? ''),
    eyebrow: t('wall.dinnerAt', { time: formatTime(MEAL_TIMES.dinner) }),
    cook,
    cookLine: cook ? t('today.cooks', { name: firstName(cook.display_name) }) : '',
    meter: ingredients ? { total: ingredients.total, have: ingredients.have, caption } : null,
    minutes: now.minutes,
    date: meal.date ?? ctx.todayKey,
    household: data?.users ?? [],
  };
}

function dinnerOfToday(data) {
  return (Array.isArray(data?.todayMeals) ? data.todayMeals : []).find((meal) => meal.meal_type === 'dinner') ?? null;
}

/**
 * The whole wall.
 *
 * @param {object} data the household /dashboard answer (or null while loading)
 * @param {object} opts
 * @param {Date}   [opts.now]
 * @param {object} [opts.sections]   wall_sections from /preferences
 * @param {boolean} [opts.mayWrite]  the household allows ticking on the wall
 * @param {boolean} [opts.isDisplay] the session is the paired display account
 * @param {{state: string, remainingMs: number}} [opts.timer]
 * @param {Date|null} [opts.lastLoadedAt]
 * @param {string[]} [opts.predictions] names that are probably running out
 * @param {object|null} [opts.question] the open weekly question
 * @param {(module: string) => boolean} [opts.moduleOff]
 * @param {(key: string) => string} [opts.mealLabel]
 */
export function buildWall(data, {
  now = new Date(), sections = null, mayWrite = false, isDisplay = false, timer = { state: 'idle', remainingMs: 0 },
  lastLoadedAt = null, predictions = [], question = null, moduleOff = () => false, mealLabel = (key) => key,
  tickers = null,
} = {}) {
  const on = normalizeWallSections(sections);
  const ctx = planContext({ now, viewer: null, users: data?.users ?? [], moduleOff, mealLabel });
  const night = isWallNight(now);
  const timerShown = timer?.state === 'running' || timer?.state === 'done';
  const base = {
    scene: 'dzien',
    night,
    todayKey: ctx.todayKey,
    nowTime: ctx.nowTime,
    sections: on,
    timer: timerShown ? timer : null,
    timers: on.timers,
    stale: staleMinutes(lastLoadedAt, now),
    teraz: null,
    hero: null,
    dinner: null,
    plan: null,
    tomorrow: null,
    shopping: null,
    question: null,
    canTick: false,
    household: data?.users ?? [],
  };
  if (!data) {
    base.scene = night ? 'noc' : 'dzien';
    return base;
  }

  const { plan, now: teraz } = buildDay(data, ctx, { timer: timerShown ? timer : null });
  const dinner = !moduleOff('meals') && on.dinner ? dinnerOfToday(data) : null;
  const dinnerMin = minutesOf(MEAL_TIMES.dinner);
  const dinnerWindow = Boolean(dinner) && ctx.nowMin >= minutesOf(DINNER_FROM) && ctx.nowMin < dinnerMin + DINNER_LINGER_MIN;
  const dinnerOver = Boolean(dinner) && ctx.nowMin >= dinnerMin + DINNER_LINGER_MIN;
  const scene = wallScene({ night, nowMin: ctx.nowMin, dinnerWindow, dinnerOver });
  const closed = dayClosed(plan);
  // Ticking needs a household yes AND, on the display, somebody it may tick
  // for - the view asks `tickers` (GET /displays/people, can_tick_off).
  const canTick = mayWrite && (!isDisplay || (Array.isArray(tickers) && tickers.length > 0));

  const model = { ...base, scene, canTick };
  model.teraz = terazLine(teraz, plan, { closed });

  // Tonight's dinner: the hero in the Kolacja scene, a quiet card before it.
  if (dinner && (scene === 'kolacja' || scene === 'rano' || scene === 'dzien')) {
    const dinnerNow = teraz.mode === 'dinner' && teraz.meal?.id === dinner.id
      ? teraz
      : {
        meal: dinner,
        cook: dinner.cook_user_id
          ? (ctx.users.find((u) => u.id === dinner.cook_user_id)
            ?? { id: dinner.cook_user_id, display_name: dinner.cook_name ?? '', avatar_color: dinner.cook_color ?? null })
          : null,
        minutes: dinnerMin - ctx.nowMin,
        ingredients: data?.dinnerPlan && data.dinnerPlan.meal_id === dinner.id ? data.dinnerPlan : null,
      };
    const card = dinnerCard(dinnerNow, data, ctx);
    if (scene === 'kolacja') model.hero = card;
    else model.dinner = card;
  }

  if (on.plan && scene !== 'noc') {
    // The hero shows tonight's dinner; it is not a row as well. Before the
    // window the dinner card does the same.
    const rows = plan.open
      .filter((row) => !(row.kind === 'meal' && dinner && row.id === dinner.id && (model.hero || model.dinner)))
      .map((row) => wallRow(row, { canTick }));
    model.plan = { rows, closed, empty: !plan.hasAnything };
  }

  if (scene === 'wieczor' || scene === 'noc') {
    const tomorrow = buildTomorrow(data, ctx);
    const rows = (tomorrow.rows ?? []).slice(0, WALL_TOMORROW_ROWS).map((row) => ({
      key: row.key,
      title: row.title,
      time: Number.isFinite(row.sortMin) && row.time ? row.timeLabel : '',
      who: row.who,
    }));
    model.tomorrow = rows.length ? { rows, total: tomorrow.total ?? rows.length } : null;
  }

  if (on.shopping && !moduleOff('shopping') && scene !== 'noc') {
    const lists = Array.isArray(data?.shoppingLists) ? data.shoppingLists : [];
    const items = lists.flatMap((list) => (list.items ?? []).map((item) => ({ ...item, list_id: list.id })));
    const count = Number(data?.shoppingOpenCount) || 0;
    const names = items.slice(0, WALL_SHOPPING_NAMES).map((item) => String(item.name ?? '')).filter(Boolean);
    const running = (Array.isArray(predictions) ? predictions : []).map(String).filter(Boolean).slice(0, 3);
    if (count > 0 || running.length) {
      model.shopping = {
        count,
        names,
        more: Math.max(0, count - names.length),
        runningOut: running,
        listId: lists[0]?.id ?? null,
      };
    }
  }

  // The weekly question: Sunday evening, while the AI has one open and the
  // wall may answer (a person's own wall, or a display the household lets write).
  if (question && scene !== 'noc' && isSunday(ctx.todayKey) && ctx.nowMin >= minutesOf(QUESTION_FROM)
    && (!isDisplay || mayWrite)) {
    model.question = question;
  }

  return model;
}

/**
 * What a rebuild would change, as a stamp: the minute tick compares it and
 * redraws only when the wall would look different.
 */
export function wallFingerprint(model) {
  if (!model) return '';
  return JSON.stringify([
    model.scene, model.teraz, model.stale, model.timer?.state ?? null,
    model.hero?.minutes > 0 && model.hero?.minutes < 60 ? model.hero.minutes : null,
    model.plan?.rows.map((row) => [row.key, row.time, Boolean(row.pill)]), model.plan?.closed,
    model.tomorrow?.rows.map((row) => row.key), model.shopping, Boolean(model.question), model.dinner?.title ?? null,
  ]);
}

/** The household clock as "HH:MM" for the clock slot. */
export function wallClock(now = new Date()) {
  const time = zonedTimeKey(now) || clockTime(now.getHours() * 60 + now.getMinutes());
  return { time: formatTime(time), machine: time, dayKey: zonedDateKey(now) };
}
