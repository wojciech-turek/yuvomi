/**
 * Modul: Dziś - the day plan as a model (Tafla, 2026-10-19)
 * Zweck: What the start page says about today, without any markup: one
 *        time-ordered, checkable plan (tasks, events, doses, the bin, what the
 *        other modules contribute), the Teraz card with its priority rule,
 *        "Jutro", "Wkrótce" and who each row belongs to. The view
 *        (components/today-view.js) only draws what this returns.
 * Abhängigkeiten: /i18n.js, /utils/timezone.js, /utils/date.js,
 *                 /utils/today-sheet.js (the other modules' rows)
 *
 * THE ORDER OF THE PLAN (spec "Lista grupowana", artboard Dzis): overdue tasks
 * first (with a "zaległe" pill), then everything with a time in time order,
 * then what has no time. What is over - an ended event, a ticked task, a taken
 * dose, a meal long eaten - leaves the list and is counted in the "Wcześniej"
 * row at the top instead, which opens in place.
 *
 * WHOSE ROW IT IS (spec "Osoby"): the viewer's own rows carry no disc, another
 * person's carry their initial disc, a row shared by the viewer and someone
 * else the split "razem" disc. Unassigned rows carry nothing.
 */

import { t, formatTime } from '/i18n.js';
import { zonedDateKey, zonedTimeKey } from '/utils/timezone.js';
import { addLocalDays } from '/utils/date.js';
import { todaySheetContext, collectSourceRows, TODAY_SHEET_SOURCES } from '/utils/today-sheet.js';

/* Meals carry no clock time; these place them in the day. The dinner time is
 * also the one the Teraz card counts down to ("Kolacja za 19 min"). */
export const MEAL_TIMES = Object.freeze({ breakfast: '08:00', lunch: '12:30', snack: '15:30', dinner: '18:30' });

/** From when the Teraz card is about tonight's dinner, and how long after. */
export const DINNER_FROM = '15:00';
export const DINNER_LINGER_MIN = 120;
/** An event counts for Teraz when it starts within this many minutes. */
export const EVENT_SOON_MIN = 60;
/** The next timed row counts for Teraz within this many minutes. */
export const NEXT_SOON_MIN = 180;
/** From this hour an empty rest of the day is "Wolny wieczór". */
export const EVENING_FROM = '17:00';
/** A row without an end is over this long after its start. */
const EVENT_DEFAULT_MIN = 60;
/** How far ahead "Wkrótce" looks. */
export const SOON_DAYS = 14;
/** How many rows "Jutro" shows before "Cały jutrzejszy dzień". */
export const TOMORROW_ROWS = 4;
/** How many rows "Wkrótce" shows. */
export const SOON_ROWS = 4;

// The sources of today-sheet.js this plan draws itself, row by row: doses
// (one checkable row per dose instead of "2 open") and the bin (today's
// pickup here, tomorrow's put-out in "Jutro").
const OWN_SOURCES = new Set(['doses', 'waste']);

/** 'HH:MM' -> minutes since midnight, or NaN. */
export function minutesOf(time) {
  const m = /^(\d{2}):(\d{2})/.exec(String(time ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

/** Whole days between two 'YYYY-MM-DD' keys (b - a). */
export function dayDiff(a, b) {
  const ms = (key) => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

/** The context every builder reads; `now` decides "today" in the household zone. */
export function planContext({
  now = new Date(), viewer = null, users = [], moduleOff = () => false, mealLabel = (key) => key,
} = {}) {
  const todayKey = zonedDateKey(now);
  return {
    now,
    viewer,
    mealLabel,
    users: Array.isArray(users) ? users : [],
    todayKey,
    tomorrowKey: addLocalDays(todayKey, 1),
    nowTime: zonedTimeKey(now),
    nowMin: minutesOf(zonedTimeKey(now)),
    moduleOff,
  };
}

// --------------------------------------------------------
// People
// --------------------------------------------------------

/**
 * Who a row belongs to, as the view draws it:
 *   { kind: 'none' }                 own or unassigned - no disc
 *   { kind: 'person', person }       someone else's - their initial disc
 *   { kind: 'razem', people }        the viewer and someone else, or two others
 */
export function whoOf(people, viewer) {
  const list = (Array.isArray(people) ? people : []).filter((p) => p && p.id != null);
  const unique = [...new Map(list.map((p) => [p.id, p])).values()];
  if (!unique.length) return { kind: 'none' };
  const me = viewer?.id;
  if (unique.length === 1) {
    return unique[0].id === me ? { kind: 'none' } : { kind: 'person', person: unique[0] };
  }
  return { kind: 'razem', people: unique };
}

/** True when the viewer is among the people, or nobody is named (household). */
function concernsViewer(people, viewer) {
  const list = Array.isArray(people) ? people : [];
  return !list.length || list.some((p) => p?.id === viewer?.id);
}

// --------------------------------------------------------
// Rows
// --------------------------------------------------------

function eventDayKey(event) {
  const value = String(event?.start_datetime ?? '');
  if (!value) return '';
  return value.length <= 10 ? value.slice(0, 10) : (zonedDateKey(value) || value.slice(0, 10));
}

/** Does the event touch this day (multi-day and all-day ones included)? */
function eventTouches(event, dayKey) {
  const start = eventDayKey(event);
  if (!start) return false;
  if (start === dayKey) return true;
  if (start > dayKey) return false;
  const endRaw = String(event?.end_datetime ?? '');
  if (!endRaw) return false;
  // An all-day end is exclusive ("2026-10-20" ends before that day).
  const end = endRaw.length <= 10 ? addLocalDays(endRaw.slice(0, 10), -1) : (zonedDateKey(endRaw) || endRaw.slice(0, 10));
  return end >= dayKey;
}

function eventIsTimed(event, dayKey) {
  return !event.all_day && String(event.start_datetime ?? '').length > 10 && eventDayKey(event) === dayKey;
}

function eventCalendarName(event) {
  return String(event?.source_calendar_name ?? '').trim() || String(event?.cal_name ?? '').trim();
}

/** Minutes since midnight at which a timed event of today ends (NaN if not today). */
function eventEndMin(event, dayKey) {
  const startMin = minutesOf(zonedTimeKey(event.start_datetime));
  const endRaw = String(event.end_datetime ?? '');
  if (endRaw.length > 10) {
    const endDay = zonedDateKey(endRaw);
    if (endDay && endDay > dayKey) return 24 * 60;
    const endMin = minutesOf(zonedTimeKey(endRaw));
    if (Number.isFinite(endMin) && endMin > startMin) return endMin;
  }
  return startMin + EVENT_DEFAULT_MIN;
}

function eventMeta(event, viewer) {
  const parts = [];
  if (event.location) parts.push(String(event.location));
  const who = whoOf(event.assigned_users, viewer);
  if (who.kind === 'razem' && concernsViewer(event.assigned_users, viewer)) parts.push(t('today.together'));
  else if (!parts.length) {
    const cal = eventCalendarName(event);
    if (cal) parts.push(cal);
  }
  return parts.join(' · ');
}

function eventRow(event, ctx, dayKey = ctx.todayKey) {
  const timed = eventIsTimed(event, dayKey);
  const time = timed ? zonedTimeKey(event.start_datetime) : '';
  const startMin = timed ? minutesOf(time) : NaN;
  const endMin = timed ? eventEndMin(event, dayKey) : NaN;
  const past = dayKey === ctx.todayKey && timed && endMin <= ctx.nowMin;
  return {
    key: `event:${event.id}@${event.start_datetime}`,
    kind: 'event',
    id: event.id,
    title: event.birthday_name ? String(event.title ?? event.birthday_name) : String(event.title ?? ''),
    meta: eventMeta(event, ctx.viewer),
    pill: null,
    time,
    timeLabel: timed ? formatTime(time) : t('today.allDay'),
    sortMin: timed ? startMin : NaN,
    startMin,
    endMin,
    allDay: !timed,
    icon: event.birthday_name ? 'cake' : 'calendar',
    checkable: false,
    done: false,
    past,
    running: timed && startMin <= ctx.nowMin && ctx.nowMin < endMin,
    people: event.assigned_users ?? [],
    who: whoOf(event.assigned_users, ctx.viewer),
    mine: concernsViewer(event.assigned_users, ctx.viewer),
    event,
    dayKey,
  };
}

function taskRow(task, ctx) {
  const due = String(task.due_date ?? '').slice(0, 10);
  const done = task.status === 'done';
  const overdue = !done && due && due < ctx.todayKey;
  const dueTime = !overdue && task.due_time ? String(task.due_time).slice(0, 5) : '';
  const timed = /^\d{2}:\d{2}$/.test(dueTime);
  let pill = null;
  let since = '';
  if (overdue) {
    pill = { tone: 'danger', text: t('today.overdue') };
    const days = dayDiff(due, ctx.todayKey);
    since = days === 1 ? t('today.overdueSinceYesterday') : t('today.overdueSince', { days });
  }
  const metaParts = [since, task.meta].filter(Boolean);
  if (task.status === 'in_progress') metaParts.push(t('today.started'));
  return {
    key: `task:${task.id}`,
    kind: 'task',
    id: task.id,
    title: String(task.title ?? ''),
    meta: metaParts.join(' · '),
    pill,
    repeats: Boolean(task.is_recurring || task.recurrence_rule),
    // 'co tydzień' - the rhythm in words, as the task's own detail says it.
    repeatLabel: repeatLabel(task.recurrence_rule),
    time: timed ? dueTime : '',
    timeLabel: timed ? formatTime(dueTime) : '',
    sortMin: timed ? minutesOf(dueTime) : NaN,
    overdue: Boolean(overdue),
    overdueDays: overdue ? dayDiff(due, ctx.todayKey) : 0,
    icon: 'circle-check',
    checkable: true,
    done,
    past: done,
    people: task.assigned_users ?? [],
    who: whoOf(task.assigned_users, ctx.viewer),
    mine: concernsViewer(task.assigned_users, ctx.viewer),
    task,
  };
}

function doseRow(dose, ctx) {
  const time = String(dose.time ?? '').slice(0, 5);
  const taken = dose.status === 'taken';
  const skipped = dose.status === 'skipped';
  const takenAt = taken && dose.taken_at ? zonedTimeKey(dose.taken_at) || String(dose.taken_at).slice(11, 16) : '';
  return {
    key: `dose:${dose.medication_id}:${dose.schedule_id ?? ''}:${time}`,
    kind: 'dose',
    id: dose.medication_id,
    title: String(dose.name ?? ''),
    meta: taken
      ? [t('today.dose'), takenAt ? t('today.doseTakenAt', { time: formatTime(takenAt) }) : t('today.doseTaken')].join(' · ')
      : skipped ? [t('today.dose'), t('today.doseSkipped')].join(' · ') : t('today.dose'),
    pill: null,
    time,
    timeLabel: time ? formatTime(time) : '',
    sortMin: minutesOf(time),
    icon: 'pill',
    checkable: true,
    done: taken || skipped,
    past: taken || skipped,
    people: [],
    who: { kind: 'none' },
    mine: true,
    dose,
  };
}

function wasteTodayRow(pickups, ctx) {
  const names = [...new Set(pickups.map((p) => p.type_name).filter(Boolean))].join(', ');
  return {
    key: 'waste:today',
    kind: 'waste',
    id: null,
    title: t('today.wastePickup', { types: names }),
    meta: t('today.wasteToday'),
    pill: null,
    time: '',
    timeLabel: '',
    sortMin: NaN,
    icon: 'recycle',
    checkable: false,
    done: false,
    past: ctx.nowMin >= minutesOf('12:00'),
    people: [],
    who: { kind: 'none' },
    mine: true,
    route: `/waste${pickups[0]?.deep_link ?? ''}`,
  };
}

function mealRow(meal, ctx, dayKey = ctx.todayKey) {
  const time = MEAL_TIMES[meal.meal_type] ?? MEAL_TIMES.dinner;
  const cook = meal.cook_user_id
    ? (ctx.users.find((u) => u.id === meal.cook_user_id)
      ?? { id: meal.cook_user_id, display_name: meal.cook_name ?? '', avatar_color: meal.cook_color ?? null })
    : null;
  const people = cook ? [{ ...cook, color: cook.color ?? cook.avatar_color }] : [];
  return {
    key: `meal:${meal.id}`,
    kind: 'meal',
    id: meal.id,
    title: t('today.mealRow', { meal: ctx.mealLabel(meal.meal_type), title: String(meal.title ?? '') }),
    meta: !cook ? '' : cook.id === ctx.viewer?.id ? t('today.youCook') : t('today.cooks', { name: firstName(cook.display_name) }),
    pill: null,
    time: '',
    timeLabel: '',
    sortMin: minutesOf(time),
    icon: 'utensils',
    checkable: false,
    done: false,
    past: dayKey === ctx.todayKey && ctx.nowMin >= minutesOf(time) + DINNER_LINGER_MIN,
    people,
    who: whoOf(people, ctx.viewer),
    mine: true,
    meal,
    route: '/meals',
  };
}

/** A row from today-sheet.js (reminder, birthday, pantry, shift, help, approval). */
function sourceRow(row, ctx) {
  const time = /^\d{2}:\d{2}$/.test(row.sortKey) && !['00:00', '00:01', '00:02'].includes(row.sortKey) ? row.sortKey : '';
  return {
    key: `${row.kind}:${row.objectId ?? row.title}`,
    kind: 'info',
    sourceKind: row.kind,
    id: row.objectId ?? null,
    title: String(row.title ?? ''),
    meta: String(row.sub ?? ''),
    pill: null,
    time,
    timeLabel: row.timeLabel || '',
    sortMin: time ? minutesOf(time) : NaN,
    icon: row.icon || 'bell',
    checkable: false,
    done: false,
    past: false,
    people: row.who ? [row.who] : [],
    who: whoOf(row.who ? [row.who] : [], ctx.viewer),
    mine: true,
    route: row.route,
  };
}

/* The rhythm in one word for the common rules ('co tydzień'); anything more
 * elaborate keeps just the repeat glyph - the task's own detail spells it out
 * (rrule-ui.js), which is too heavy to load with the start page. */
const REPEAT_KEYS = { DAILY: 'today.repeatDaily', WEEKLY: 'today.repeatWeekly', MONTHLY: 'today.repeatMonthly', YEARLY: 'today.repeatYearly' };

function repeatLabel(rule) {
  const parts = Object.fromEntries(String(rule ?? '').replace(/^RRULE:/i, '').split(';')
    .map((part) => part.split('=')).filter(([k, v]) => k && v).map(([k, v]) => [k.toUpperCase(), v.toUpperCase()]));
  if (!REPEAT_KEYS[parts.FREQ] || (parts.INTERVAL && parts.INTERVAL !== '1')) return '';
  if (parts.FREQ === 'WEEKLY' && parts.BYDAY && parts.BYDAY.includes(',')) return '';
  return t(REPEAT_KEYS[parts.FREQ]);
}

/** First word of a display name ("Mariola Kowalska" -> "Mariola"). */
export function firstName(displayName) {
  return String(displayName ?? '').trim().split(/\s+/)[0] || String(displayName ?? '');
}

// --------------------------------------------------------
// The plan
// --------------------------------------------------------

const byTime = (a, b) => (a.sortMin - b.sortMin) || a.title.localeCompare(b.title);
const KIND_RANK = { task: 0, dose: 1, waste: 2, event: 3, meal: 4, info: 5 };

/**
 * Today's plan.
 *
 * @param {object} data the /dashboard answer
 * @param {object} ctx planContext()
 * @param {{ featuredDinner?: object|null }} [options] the meal the Teraz card
 *        shows - it is not repeated as a row
 * @returns {{
 *   open: object[], earlier: object[], all: object[],
 *   checkTotal: number, checkDone: number,
 *   pastEvents: object[], hasAnything: boolean,
 * }}
 */
export function buildPlan(data, ctx, { featuredDinner = null } = {}) {
  const rows = [];
  const off = (module) => Boolean(ctx.moduleOff?.(module));

  if (!off('tasks')) {
    for (const task of Array.isArray(data?.planTasks) ? data.planTasks : []) {
      const due = String(task.due_date ?? '').slice(0, 10);
      if (task.status !== 'done' && (!due || due > ctx.todayKey)) continue;
      rows.push(taskRow(task, ctx));
    }
  }
  if (!off('calendar')) {
    for (const event of Array.isArray(data?.planEvents) ? data.planEvents : []) {
      if (!eventTouches(event, ctx.todayKey)) continue;
      rows.push(eventRow(event, ctx));
    }
  }
  if (!off('health')) {
    for (const dose of Array.isArray(data?.health?.doses) ? data.health.doses : []) rows.push(doseRow(dose, ctx));
  }
  if (!off('waste')) {
    const today = (Array.isArray(data?.wastePickups) ? data.wastePickups : []).filter((p) => p.date_key === ctx.todayKey);
    if (today.length) rows.push(wasteTodayRow(today, ctx));
  }
  if (!off('meals')) {
    for (const meal of Array.isArray(data?.todayMeals) ? data.todayMeals : []) {
      if (featuredDinner && meal.id === featuredDinner.id) continue;
      if (meal.meal_type === 'snack') continue;
      rows.push(mealRow(meal, ctx));
    }
  }

  // The other modules (reminders, birthdays, pantry, shift, help, approvals)
  // through the shared contract - with no widget configuration, so no
  // "no echo" bolt applies: Dziś has no module widgets any more.
  const sheetCtx = todaySheetContext({
    todayKey: ctx.todayKey,
    tomorrowKey: ctx.tomorrowKey,
    nowTime: ctx.nowTime,
    cfg: [],
    viewer: ctx.viewer,
    isModuleDisabled: off,
    existing: rows.map((row) => ({ kind: row.kind, objectId: row.id })),
  });
  const sources = TODAY_SHEET_SOURCES.filter((source) => !OWN_SOURCES.has(source.id));
  for (const row of collectSourceRows(data, sheetCtx, sources).rows) rows.push(sourceRow(row, ctx));

  const open = rows.filter((row) => !row.past);
  const overdue = open.filter((row) => row.overdue).sort((a, b) => b.overdueDays - a.overdueDays || a.title.localeCompare(b.title));
  const timed = open.filter((row) => !row.overdue && Number.isFinite(row.sortMin)).sort(byTime);
  const untimed = open.filter((row) => !row.overdue && !Number.isFinite(row.sortMin))
    .sort((a, b) => (KIND_RANK[a.kind] - KIND_RANK[b.kind]) || a.title.localeCompare(b.title));
  const earlier = rows.filter((row) => row.past).sort((a, b) => {
    const am = Number.isFinite(a.sortMin) ? a.sortMin : -1;
    const bm = Number.isFinite(b.sortMin) ? b.sortMin : -1;
    return am - bm || a.title.localeCompare(b.title);
  });
  const checkable = rows.filter((row) => row.checkable);
  return {
    open: [...overdue, ...timed, ...untimed],
    earlier,
    all: rows,
    checkTotal: checkable.length,
    checkDone: checkable.filter((row) => row.done).length,
    pastEvents: earlier.filter((row) => row.kind === 'event'),
    hasAnything: rows.length > 0,
  };
}

/**
 * The words of the "Wcześniej" row: the last past event by name when there is
 * one, else how many; then how many are done. Null when nothing is earlier.
 */
export function earlierLabel(plan) {
  if (!plan.earlier.length) return null;
  const parts = [];
  const events = plan.pastEvents;
  if (events.length === 1) parts.push(`${events[0].title} ${events[0].timeLabel}`.trim());
  else if (events.length > 1) parts.push(t('today.earlierEvents', { count: events.length }));
  const done = plan.earlier.filter((row) => row.checkable && row.done).length;
  if (done) parts.push(t('today.earlierDone', { count: done }));
  const rest = plan.earlier.length - events.length - done;
  if (!parts.length && rest) parts.push(t('today.earlierOther', { n: rest }));
  return t('today.earlier', { what: parts.join(' · ') });
}

// --------------------------------------------------------
// Teraz
// --------------------------------------------------------

function dinnerOf(data) {
  return (Array.isArray(data?.todayMeals) ? data.todayMeals : []).find((meal) => meal.meal_type === 'dinner') ?? null;
}

/** "Potem: 20:00 Wieczór filmowy · razem" - the next timed thing after `after`. */
function thenLine(plan, ctx, afterMin, skipKey = null) {
  const next = plan.open.find((row) => Number.isFinite(row.sortMin) && row.sortMin > afterMin
    && row.key !== skipKey && !row.overdue && row.kind !== 'info');
  if (!next) return null;
  const tail = next.who.kind === 'razem' && next.mine ? ` · ${t('today.together')}` : '';
  return { row: next, text: t('today.then', { what: `${next.timeLabel} ${next.title}${tail}` }) };
}

/**
 * The Teraz card, by the spec's priority:
 *   running timer > your or a shared event within 60 min > dinner from 15:00
 *   until dinner + 2h > the next timed item within 3h > "Wolny wieczór".
 * "Dzień ogarnięty" (everything done) is decided by `dayClosed()` and drawn
 * instead of this card.
 *
 * @param {{ timer?: {state: string, remainingMs: number} }} [extra]
 */
export function pickNow(data, plan, ctx, { timer = null } = {}) {
  if (timer?.state === 'running' || timer?.state === 'done') {
    return { mode: 'timer', timer, then: thenLine(plan, ctx, ctx.nowMin) };
  }

  const soonEvent = plan.open.find((row) => row.kind === 'event' && !row.allDay && row.mine
    && (row.running || (row.startMin > ctx.nowMin && row.startMin - ctx.nowMin <= EVENT_SOON_MIN)));
  if (soonEvent) {
    return {
      mode: 'event',
      row: soonEvent,
      minutes: soonEvent.startMin - ctx.nowMin,
      then: thenLine(plan, ctx, soonEvent.startMin, soonEvent.key),
    };
  }

  const dinner = !ctx.moduleOff?.('meals') ? dinnerOf(data) : null;
  if (dinner) {
    const dinnerMin = minutesOf(MEAL_TIMES.dinner);
    if (ctx.nowMin >= minutesOf(DINNER_FROM) && ctx.nowMin < dinnerMin + DINNER_LINGER_MIN) {
      const cook = dinner.cook_user_id
        ? (ctx.users.find((u) => u.id === dinner.cook_user_id)
          ?? { id: dinner.cook_user_id, display_name: dinner.cook_name ?? '', avatar_color: dinner.cook_color ?? null })
        : null;
      const plan2 = data?.dinnerPlan && data.dinnerPlan.meal_id === dinner.id ? data.dinnerPlan : null;
      return {
        mode: 'dinner',
        meal: dinner,
        cook,
        cookWho: cook ? whoOf([cook], ctx.viewer) : { kind: 'none' },
        minutes: dinnerMin - ctx.nowMin,
        ingredients: plan2,
        then: thenLine(plan, ctx, Math.max(ctx.nowMin, dinnerMin)),
      };
    }
  }

  const next = plan.open.find((row) => Number.isFinite(row.sortMin) && !row.overdue && row.kind !== 'info'
    && row.sortMin >= ctx.nowMin && row.sortMin - ctx.nowMin <= NEXT_SOON_MIN);
  if (next) {
    return { mode: 'next', row: next, minutes: next.sortMin - ctx.nowMin, then: thenLine(plan, ctx, next.sortMin, next.key) };
  }

  const later = plan.open.find((row) => Number.isFinite(row.sortMin) && !row.overdue && row.kind !== 'info' && row.sortMin > ctx.nowMin);
  return {
    mode: 'free',
    evening: ctx.nowMin >= minutesOf(EVENING_FROM),
    then: later ? { row: later, text: t('today.then', { what: `${later.timeLabel} ${later.title}` }) } : null,
  };
}

/**
 * The plan and the Teraz card together. In dinner mode tonight's dinner is
 * the card, so it is not a row of the plan as well.
 * @returns {{ plan: object, now: object }}
 */
export function buildDay(data, ctx, { timer = null } = {}) {
  let plan = buildPlan(data, ctx);
  let now = pickNow(data, plan, ctx, { timer });
  if (now.mode === 'dinner') {
    plan = buildPlan(data, ctx, { featuredDinner: now.meal });
    now = pickNow(data, plan, ctx, { timer });
  }
  return { plan, now };
}

/**
 * The day is done ("Dzień ogarnięty"): something was on today, every checkable
 * row is ticked and nothing timed is still ahead. Info rows (a birthday, the
 * help being here) do not hold it up.
 */
export function dayClosed(plan) {
  if (!plan.hasAnything) return false;
  if (plan.checkTotal === 0 && !plan.pastEvents.length) return false;
  return !plan.open.some((row) => row.checkable || row.kind === 'event' || row.kind === 'meal' || row.kind === 'waste');
}

// --------------------------------------------------------
// Jutro
// --------------------------------------------------------

/**
 * The first things of tomorrow with who is on them: tonight's put-out for
 * tomorrow's pickup, the events, the tasks due, dinner. Replaces the old
 * family card - the discs already say who does what.
 */
export function buildTomorrow(data, ctx) {
  const rows = [];
  const off = (module) => Boolean(ctx.moduleOff?.(module));
  if (!off('waste')) {
    const pickups = (Array.isArray(data?.wastePickups) ? data.wastePickups : []).filter((p) => p.date_key === ctx.tomorrowKey);
    if (pickups.length) {
      const names = [...new Set(pickups.map((p) => p.type_name).filter(Boolean))].join(', ');
      rows.push({
        key: 'waste:tomorrow', kind: 'waste', id: null,
        title: t('today.wastePutOut', { types: names }),
        meta: t('today.wasteTonight'),
        pill: null, time: '', timeLabel: '', sortMin: -1, icon: 'recycle',
        checkable: false, done: false, people: [], who: { kind: 'none' }, mine: true,
        route: `/waste${pickups[0]?.deep_link ?? ''}`,
      });
    }
  }
  if (!off('calendar')) {
    const events = (Array.isArray(data?.planEvents) ? data.planEvents : [])
      .filter((event) => eventDayKey(event) === ctx.tomorrowKey)
      .map((event) => eventRow(event, ctx, ctx.tomorrowKey))
      .sort((a, b) => (Number.isFinite(a.sortMin) ? a.sortMin : -0.5) - (Number.isFinite(b.sortMin) ? b.sortMin : -0.5));
    rows.push(...events);
  }
  if (!off('tasks')) {
    for (const task of Array.isArray(data?.planTasks) ? data.planTasks : []) {
      if (task.status === 'done' || String(task.due_date ?? '').slice(0, 10) !== ctx.tomorrowKey) continue;
      const row = taskRow(task, { ...ctx, todayKey: ctx.tomorrowKey });
      row.sortMin = Number.isFinite(row.sortMin) ? row.sortMin : 24 * 60;
      rows.push(row);
    }
  }
  if (!off('meals')) {
    const dinner = (Array.isArray(data?.tomorrowMeals) ? data.tomorrowMeals : []).find((meal) => meal.meal_type === 'dinner');
    if (dinner) {
      const row = mealRow(dinner, ctx, ctx.tomorrowKey);
      row.sortMin = 24 * 60 + 1;
      rows.push(row);
    }
  }
  const timedFirst = rows.sort((a, b) => a.sortMin - b.sortMin);
  return { rows: timedFirst.slice(0, TOMORROW_ROWS), total: timedFirst.length };
}

// --------------------------------------------------------
// Wkrótce
// --------------------------------------------------------

/**
 * What is coming within two weeks, nearest first: birthdays, marked
 * countdowns, document expiries (fetched by the page when the module is on).
 * Hidden by the view when empty.
 */
export function buildSoon(data, ctx, { documents = [] } = {}) {
  const rows = [];
  const off = (module) => Boolean(ctx.moduleOff?.(module));
  if (!off('birthdays')) {
    for (const b of Array.isArray(data?.birthdays) ? data.birthdays : []) {
      const days = Number(b.days_until);
      if (!Number.isFinite(days) || days < 1 || days > SOON_DAYS) continue;
      const date = addLocalDays(ctx.todayKey, days);
      rows.push({
        key: `birthday:${b.id}:${b.kind}`, kind: 'birthday', days, date,
        title: b.kind !== 'name_day' && Number(b.next_age) > 0 ? t('today.birthdayAge', { name: b.name, count: Number(b.next_age) }) : String(b.name ?? ''),
        meta: b.kind === 'name_day' ? t('birthdays.nameDay') : '',
        icon: 'cake', route: '/birthdays',
      });
    }
  }
  for (const c of Array.isArray(data?.countdowns) ? data.countdowns : []) {
    const days = Number(c.days_until);
    if (!Number.isFinite(days) || days < 1 || days > SOON_DAYS) continue;
    if (off(c.source === 'task' ? 'tasks' : 'calendar')) continue;
    rows.push({
      key: `countdown:${c.source}:${c.id}`, kind: 'countdown', days, date: String(c.date ?? '').slice(0, 10),
      title: String(c.title ?? ''), meta: '', icon: c.source === 'task' ? 'circle-check' : 'calendar',
      route: c.source === 'task' ? '/tasks' : `/calendar?open=${encodeURIComponent(String(c.id))}&date=${encodeURIComponent(String(c.date ?? ''))}`,
      taskId: c.source === 'task' ? c.id : null,
    });
  }
  if (!off('documents')) {
    for (const doc of Array.isArray(documents) ? documents : []) {
      const key = String(doc.expires_at ?? '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      const days = dayDiff(ctx.todayKey, key);
      if (days < 0 || days > 30) continue;
      rows.push({
        key: `document:${doc.id}`, kind: 'document', days, date: key,
        title: String(doc.title ?? doc.name ?? ''), meta: t('today.documentExpires'),
        icon: 'file-text', route: `/documents?open=${encodeURIComponent(String(doc.id))}`,
      });
    }
  }
  rows.sort((a, b) => a.days - b.days || a.title.localeCompare(b.title));
  return rows.slice(0, SOON_ROWS);
}
