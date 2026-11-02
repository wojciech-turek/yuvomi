/**
 * Modul: Dziś v2 - the model (2026-10-27)
 * Zweck: What the home screen shows, as plain data: the weather card with the
 *        rain of the day, the calendar of today (earlier, now, ahead and a peek
 *        at tomorrow), the pending tasks and the birthdays soon. Drawn by
 *        components/today-view.js, wired in pages/dashboard.js.
 * Abhängigkeiten: /i18n.js, /utils/today-plan.js, /utils/date.js,
 *                 /utils/day-label.js, /utils/note-line.js
 *
 * ONE TODAY (2026-11-02) adds the data of the new page: weatherLine, nextUp,
 * the task groups of pendingTasks, birthdaysNext and notesCard.
 *
 * THE OWNER'S ORDER (design v2, "Main" and "DzisFull"): the weather first,
 * because "will it rain today" is the question of the morning; then the
 * calendar, compact, with the ongoing event marked in place instead of
 * repeated in a second card; then the tasks that are waiting, tickable; the
 * birthdays last and quiet. There is no Teraz card, no dinner card and no day
 * plan any more - the wall keeps its own model (utils/wall-plan.js).
 */

import { t, formatTime, getLocale, getTimeFormat, getNumberFormat } from '/i18n.js';
import { buildPlan, buildTomorrow, firstName, minutesOf, MEAL_TIMES } from '/utils/today-plan.js';
import { addLocalDays } from '/utils/date.js';
import { shortDayMonth, shortWeekdayDayMonth } from '/utils/day-label.js';
import { firstLine, noteLines } from '/utils/note-line.js';

/** A chance of rain from this many percent counts as rain (as the server). */
export const RAIN_POP = 40;
/** The bars of the hourly chart: the hour before, now and twelve ahead. */
export const CHART_BARS = 14;
/** Tallest bar of the chart, in px (the chart is 24 high). */
const BAR_MAX = 24;
const BAR_MIN = 3;
/** How many tasks the card lists (the server sends the five most pressing). */
export const TASK_ROWS = 5;
/** Birthdays: how far ahead and how many. */
export const SOON_DAYS = 30;
export const SOON_ROWS = 3;
/** From this minute of the day "no rain until evening" would be a lie. */
const EVENING_MIN = 17 * 60;

const hhmm = (hour) => `${String(hour).padStart(2, '0')}:00`;

/**
 * The hour under a bar of the chart: "15" (in the region's digits), "3PM" for
 * a 12-hour clock - a full "15:00" is wider than three bars.
 */
export function chartHourLabel(hour) {
  if (getTimeFormat() === '12h') return `${hour % 12 || 12}${hour >= 12 ? 'PM' : 'AM'}`;
  return getNumberFormat({ useGrouping: false }).format(hour);
}
const minutesToTime = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** "Wtorek, 27 października" in the household zone. */
export function headerDate(dateKey) {
  const text = new Intl.DateTimeFormat(getLocale(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
    .format(new Date(`${dateKey}T12:00:00Z`));
  return text ? text[0].toLocaleUpperCase(getLocale()) + text.slice(1) : text;
}

/** "Dzień dobry" until six in the evening, "Dobry wieczór" after. */
export function greetingKey(nowMin) {
  return nowMin >= 5 * 60 && nowMin < 18 * 60 ? 'dashboard.greetingMorning' : 'dashboard.greetingEvening';
}

// --------------------------------------------------------
// Weather
// --------------------------------------------------------

/**
 * The weather card, or null without weather. The rain line and the chart look
 * at the REST of the day (from the current hour); the server's day summary
 * covers the whole day and stays true for its cached half hour.
 */
export function weatherCard(weather, ctx) {
  if (!weather?.current) return null;
  const openMeteo = weather.provider === 'open-meteo';
  const describe = (desc) => (openMeteo ? t(desc) : String(desc ?? ''));
  const nowHour = Math.floor((Number.isFinite(ctx.nowMin) ? ctx.nowMin : 0) / 60);
  const hours = (Array.isArray(weather.today_hours) ? weather.today_hours : [])
    .filter((h) => Number.isInteger(h?.hour));
  const byHour = new Map(hours.map((h) => [h.hour, h]));
  const ahead = hours.filter((h) => h.hour >= nowHour && Number.isFinite(h.pop));
  const wet = ahead.filter((h) => h.pop >= RAIN_POP);

  let rain = null;
  if (wet.length) {
    const from = wet[0].hour;
    const to = wet[wet.length - 1].hour;
    const popMax = Math.max(...wet.map((h) => h.pop));
    let label;
    if (from <= nowHour) label = t('today.rainUntil', { time: formatTime(hhmm(to)) });
    else if (from === to) label = t('today.rainAt', { time: formatTime(hhmm(from)) });
    else label = t('today.rainWindow', { from: formatTime(hhmm(from)), to: formatTime(hhmm(to)) });
    const bars = [];
    for (let hour = nowHour - 1; hour < nowHour - 1 + CHART_BARS; hour += 1) {
      if (hour < 0 || hour > 23) continue;
      const pop = byHour.get(hour)?.pop;
      const known = Number.isFinite(pop);
      bars.push({
        hour,
        now: hour === nowHour,
        wet: known && pop >= RAIN_POP,
        height: known ? Math.max(BAR_MIN, Math.round((BAR_MAX * pop) / 100)) : BAR_MIN,
        // Every third hour is named; the two after "teraz" stay empty, so the
        // word has three bars of room in every language.
        label: hour === nowHour
          ? t('today.chartNow')
          : (hour % 3 === 0 && (hour < nowHour || hour > nowHour + 2) ? chartHourLabel(hour) : ''),
      });
    }
    rain = { label, chance: t('today.rainChance', { pop: popMax }), bars };
  }
  const dry = !rain && ahead.length
    ? {
      label: t(ctx.nowMin >= EVENING_MIN ? 'today.dryRestOfDay' : 'today.dryEvening'),
      chance: t('today.rainChance', { pop: Math.max(...ahead.map((h) => h.pop)) }),
    }
    : null;

  const temp = Number(weather.current.temp);
  const hi = Number(weather.today?.temp_max);
  const lo = Number(weather.today?.temp_min);
  const feels = Number(weather.current.feels_like);
  const deg = (n) => `${Math.round(n)}°`;
  const meta = [
    Number.isFinite(hi) && Number.isFinite(lo) && weather.today?.temp_max != null ? `${deg(hi)} / ${deg(lo)}` : '',
    Number.isFinite(feels) ? t('today.feelsLike', { temp: deg(feels) }) : '',
  ].filter(Boolean).join(' · ');
  return {
    icon: openMeteo ? String(weather.current.icon || 'cloud') : 'cloud',
    temp: Number.isFinite(temp) ? deg(temp) : '',
    desc: describe(weather.current.desc),
    meta,
    rain,
    dry,
  };
}

/** "11° · bez deszczu do wieczora" for the head of the page, or null without weather. */
export function weatherLine(weather, ctx) {
  const card = weatherCard(weather, ctx);
  if (!card) return null;
  const phrase = card.rain?.label || card.dry?.label || '';
  const lower = phrase ? phrase[0].toLocaleLowerCase(getLocale()) + phrase.slice(1) : '';
  return { icon: card.icon, text: [card.temp, lower].filter(Boolean).join(' · ') };
}

// --------------------------------------------------------
// Calendar
// --------------------------------------------------------

/** The dots of an event: the colour of each of the first two people. */
function eventPeople(event) {
  const list = (Array.isArray(event?.assigned_users) ? event.assigned_users : []).filter((p) => p && p.id != null);
  return [...new Map(list.map((p) => [p.id, p])).values()].slice(0, 2);
}

/** The second line of a row: the place, else whose it is, else its calendar. */
function eventMeta(row, ctx) {
  const event = row.event ?? {};
  if (event.location) return String(event.location);
  if (row.who?.kind === 'razem') return t('today.together');
  if (row.who?.kind === 'person') return firstName(row.who.person?.display_name);
  return String(event.source_calendar_name ?? '').trim() || String(event.cal_name ?? '').trim();
}

function eventRoute(row, dayKey) {
  return row.id != null
    ? `/calendar?open=${encodeURIComponent(String(row.id))}&date=${encodeURIComponent(dayKey)}`
    : `/calendar?date=${encodeURIComponent(dayKey)}`;
}

/**
 * Today's calendar: what is over folds into one "N wcześniej" line, what runs
 * now stands highlighted with its end, the rest follows by time (all-day
 * first), and the last line peeks at tomorrow.
 */
export function calendarDay(data, ctx) {
  const plan = buildPlan({ planEvents: Array.isArray(data?.planEvents) ? data.planEvents : [] }, { ...ctx, moduleOff: (m) => m !== 'calendar' || Boolean(ctx.moduleOff?.(m)) });
  const rows = plan.all.filter((row) => row.kind === 'event' && !row.event?.birthday_name).map((row) => {
    const ends = Number.isFinite(row.endMin) && row.endMin < 24 * 60;
    const ongoing = !row.past && (row.running || (row.allDay && ends && row.endMin > ctx.nowMin));
    return {
      key: row.key,
      id: row.id,
      title: row.title,
      allDay: row.allDay && !ongoing,
      time: row.allDay ? '' : row.time,
      timeLabel: row.allDay ? (ongoing ? '' : t('today.allDay')) : formatTime(row.time),
      startMin: Number.isFinite(row.startMin) ? row.startMin : -1,
      past: row.past,
      ongoing,
      until: ongoing && ends ? t('today.nowUntil', { time: formatTime(minutesToTime(row.endMin)) }) : '',
      people: eventPeople(row.event),
      meta: eventMeta(row, ctx),
      route: eventRoute(row, ctx.todayKey),
    };
  });
  const earlier = rows.filter((row) => row.past).sort((a, b) => a.startMin - b.startMin);
  const ahead = rows.filter((row) => !row.past)
    .sort((a, b) => (a.allDay === b.allDay ? a.startMin - b.startMin : (a.allDay ? -1 : 1)) || a.title.localeCompare(b.title));
  const last = earlier[earlier.length - 1];
  const tomorrowEvents = buildTomorrow({ planEvents: data?.planEvents ?? [] }, { ...ctx, moduleOff: (m) => m !== 'calendar' || Boolean(ctx.moduleOff?.(m)) })
    .rows.filter((row) => row.kind === 'event' && !row.event?.birthday_name);
  const first = tomorrowEvents[0];
  return {
    earlier: {
      rows: earlier,
      label: earlier.length
        ? [t('today.earlierCount', { n: earlier.length }), [last.timeLabel, last.title].filter(Boolean).join(' ')].join(' · ')
        : '',
    },
    rows: ahead,
    tomorrow: first ? {
      text: [
        [first.time ? formatTime(first.time) : '', first.title].filter(Boolean).join(' '),
        tomorrowEvents.length > 1 ? t('today.tomorrowMore', { n: tomorrowEvents.length - 1 }) : '',
      ].filter(Boolean).join(' · '),
      route: `/calendar?date=${encodeURIComponent(ctx.tomorrowKey)}`,
    } : null,
    empty: !earlier.length && !ahead.length,
  };
}

// --------------------------------------------------------
// Next up
// --------------------------------------------------------

/** The minute a row happens, meals by their slot (they carry no clock time). */
function rowMinute(row) {
  if (row.kind === 'meal') return minutesOf(MEAL_TIMES[row.meal?.meal_type] ?? MEAL_TIMES.dinner);
  return row.sortMin;
}

/** Where a tap on the row goes: events by id and day, the rest by their own route. */
const routeOf = (row, ctx) => (row.kind === 'event' ? eventRoute(row, row.dayKey ?? ctx.todayKey) : String(row.route ?? ''));

/** Next up knows events, meals, timed tasks and a household help visit - no reminders, shifts, doses. */
const NEXT_UP_ROWS = (row) => row.kind === 'event' || row.kind === 'meal' || row.kind === 'task'
  || (row.kind === 'info' && row.sourceKind === 'housekeeping');

const clockOf = (min) => formatTime(minutesToTime(min));

/**
 * The one thing that comes next: the first open row of today that is running
 * or still ahead and has a time (household help counts, no cap), with its
 * lead ("Za 25 min · 12:30") and the following timed row ("Potem ..."). With
 * nothing left today, the first timed row of tomorrow ("Jutro 08:00"). Null
 * when there is nothing at all.
 */
export function nextUp(data, ctx) {
  const ahead = buildPlan(data ?? {}, ctx).open.filter((row) => {
    const min = rowMinute(row);
    return NEXT_UP_ROWS(row) && Number.isFinite(min) && !row.overdue && !row.done && (row.running || min > ctx.nowMin);
  });
  const row = ahead[0];
  if (row) {
    const min = rowMinute(row);
    const time = clockOf(min);
    const away = Math.ceil(min - ctx.nowMin);
    let lead;
    if (row.running) lead = t('today.nowRunning');
    else if (away < 60) lead = t('today.inMinutesAt', { minutes: Math.max(1, away), time });
    else lead = t('today.atTimeOnly', { time });
    const following = ahead.slice(1).find((r) => rowMinute(r) > ctx.nowMin);
    return {
      lead,
      title: row.title,
      then: following ? t('today.thenShort', { time: clockOf(rowMinute(following)), title: following.title }) : null,
      route: routeOf(row, ctx),
      kind: row.kind,
    };
  }
  const tomorrow = buildTomorrow(data ?? {}, ctx, { limit: Infinity }).rows
    .filter(NEXT_UP_ROWS)
    .map((r) => ({ r, min: rowMinute(r) }))
    .filter(({ min }) => Number.isFinite(min) && min >= 0 && min < 24 * 60)
    .sort((a, b) => a.min - b.min)[0];
  if (!tomorrow) return null;
  return {
    lead: t('today.tomorrowAt', { time: clockOf(tomorrow.min) }),
    title: tomorrow.r.title,
    then: null,
    route: routeOf(tomorrow.r, ctx),
    kind: tomorrow.r.kind,
  };
}

// --------------------------------------------------------
// Tasks
// --------------------------------------------------------

/** "wczoraj", "3 dni temu", "dziś", "jutro", "czw", "12 lis" - or '' without a date. */
export function dueLabel(dueDate, ctx) {
  const due = String(dueDate ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return '';
  const diff = Math.round((Date.parse(`${due}T12:00:00Z`) - Date.parse(`${ctx.todayKey}T12:00:00Z`)) / 86_400_000);
  if (diff === -1) return t('calendar.relDay.yesterday');
  if (diff < -1) return t('calendar.relDay.daysAgo', { count: -diff });
  if (diff === 0) return t('calendar.relDay.today');
  if (diff === 1) return t('calendar.relDay.tomorrow');
  if (diff < 7) {
    return new Intl.DateTimeFormat(getLocale(), { weekday: 'short', timeZone: 'UTC' })
      .format(new Date(`${due}T12:00:00Z`)).replace(/\.$/, '');
  }
  return shortDayMonth(due);
}

const TASK_GROUPS = [
  ['late', 'today.groupLate'],
  ['today', 'today.groupToday'],
  ['tomorrow', 'today.groupTomorrow'],
  ['later', 'today.groupLater'],
  ['none', 'today.groupNone'],
];

function taskGroup(due, ctx) {
  if (!due) return 'none';
  if (due < ctx.todayKey) return 'late';
  if (due === ctx.todayKey) return 'today';
  if (due === ctx.tomorrowKey) return 'tomorrow';
  return 'later';
}

/**
 * The tasks that wait, sorted into groups (late, today, tomorrow, later, no
 * date; empty ones dropped). A group names the day, so a row says its date
 * only when late ("wczoraj") or later ("czw 6 lis"). `rows` is the same list
 * flat, in group order. Inside a group the server's order stays.
 */
export function pendingTasks(data, ctx) {
  const open = (Array.isArray(data?.urgentTasks) ? data.urgentTasks : []).filter((task) => task && task.status !== 'done');
  const made = open.slice(0, TASK_ROWS).map((task) => {
    const due = String(task.due_date ?? '').slice(0, 10);
    const group = taskGroup(due, ctx);
    const people = Array.isArray(task.assigned_users) ? task.assigned_users.filter((p) => p && p.id != null) : [];
    let dueText = '';
    if (group === 'late') dueText = dueLabel(due, ctx);
    else if (group === 'later') dueText = shortWeekdayDayMonth(due, { year: false });
    return {
      key: `task:${task.id}`,
      id: task.id,
      title: String(task.title ?? ''),
      group,
      due: dueText,
      late: group === 'late',
      flag: task.priority === 'high' || task.priority === 'urgent',
      person: people[0] ?? null,
      task,
    };
  });
  const groups = TASK_GROUPS
    .map(([id, label]) => ({ id, label: t(label), rows: made.filter((row) => row.group === id) }))
    .filter((group) => group.rows.length);
  const rows = groups.flatMap((group) => group.rows);
  const total = Number(data?.openTaskCount);
  return { rows, groups, total: Number.isFinite(total) && total >= rows.length ? total : rows.length };
}

// --------------------------------------------------------
// Birthdays
// --------------------------------------------------------

/** "Babcia Halina · 70. urodziny", "sob 1 lis · za 5 dni" - the next 30 days, three at most. */
export function birthdaysSoon(data, ctx) {
  return (Array.isArray(data?.birthdays) ? data.birthdays : [])
    .filter((b) => Number.isFinite(Number(b?.days_until)) && Number(b.days_until) >= 0 && Number(b.days_until) <= SOON_DAYS)
    .slice(0, SOON_ROWS)
    .map((b) => {
      const days = Number(b.days_until);
      const age = Number(b.next_age);
      const kind = b.kind === 'name_day'
        ? t('today.nameDayKind')
        : (Number.isFinite(age) && age > 0 ? t('birthdays.heroAge', { age }) : t('today.birthdayKind'));
      const when = days === 0 ? t('calendar.relDay.today') : days === 1 ? t('calendar.relDay.tomorrow') : t('birthdays.inDays', { count: days });
      return {
        key: `birthday:${b.id}:${b.kind}`,
        id: b.id,
        name: String(b.name ?? ''),
        kind,
        when: `${shortWeekdayDayMonth(addLocalDays(ctx.todayKey, days))} · ${when}`,
        route: b.id != null ? `/birthdays?open=${encodeURIComponent(String(b.id))}` : '/birthdays',
      };
    });
}

/**
 * The next three birthdays or name days, however far away (the server sends
 * five occurrences, sorted by days). "kończy 36 · sob 1 lis · za 5 dni".
 */
export function birthdaysNext(data, ctx) {
  return (Array.isArray(data?.birthdays) ? data.birthdays : [])
    .filter((b) => Number.isFinite(Number(b?.days_until)) && Number(b.days_until) >= 0)
    .slice(0, 3)
    .map((b) => {
      const days = Number(b.days_until);
      const age = Number(b.next_age);
      let sub;
      if (b.kind === 'name_day') sub = t('today.nameDayKind');
      else if (Number.isFinite(age) && age > 0) sub = t('birthdays.turnsAge', { age });
      else sub = firstLine(b.notes) || t('today.birthdayKind');
      return {
        key: `birthday:${b.id}:${b.kind}`,
        id: b.id,
        name: String(b.name ?? ''),
        today: days === 0,
        sub,
        date: shortWeekdayDayMonth(addLocalDays(ctx.todayKey, days), { year: false }),
        far: days === 0 ? '' : days === 1 ? t('calendar.relDay.tomorrow') : t('birthdays.inDays', { count: days }),
        route: b.id != null ? `/birthdays?open=${encodeURIComponent(String(b.id))}` : '/birthdays',
      };
    });
}

// --------------------------------------------------------
// Notes
// --------------------------------------------------------

/**
 * Up to three notes in the server's order (pinned first, then recently
 * changed): the title (else the first line of the text) and one line under
 * it; null without notes.
 */
export function notesCard(data) {
  const notes = (Array.isArray(data?.pinnedNotes) ? data.pinnedNotes : []).filter((n) => n && n.id != null).slice(0, 3);
  if (!notes.length) return null;
  return notes.map((note) => {
    const title = String(note.title ?? '').trim();
    const lines = noteLines(note.content, 2);
    return {
      id: note.id,
      title: title || lines[0] || t('today.noteUntitled'),
      line: (title ? lines[0] : lines[1]) ?? '',
      route: `/notes?open=${encodeURIComponent(String(note.id))}`,
    };
  });
}

/** What changes by the clock alone - the page rebuilds only when this does. */
export function clockStamp(calendar, weather, ctx, next = null) {
  return JSON.stringify([
    ctx.todayKey,
    calendar?.earlier?.rows.map((row) => row.key),
    calendar?.rows.map((row) => `${row.key}:${row.ongoing}`),
    Math.floor(ctx.nowMin / 60),
    weather?.dry?.label ?? '',
    next?.lead ?? '',
  ]);
}
