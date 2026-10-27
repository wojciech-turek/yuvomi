/**
 * Modul: Dziś v2 - the model (2026-10-27)
 * Zweck: What the home screen shows, as plain data: the weather card with the
 *        rain of the day, the calendar of today (earlier, now, ahead and a peek
 *        at tomorrow), the pending tasks and the birthdays soon. Drawn by
 *        components/today-view.js, wired in pages/dashboard.js.
 * Abhängigkeiten: /i18n.js, /utils/today-plan.js, /utils/date.js,
 *                 /utils/day-label.js
 *
 * THE OWNER'S ORDER (design v2, "Main" and "DzisFull"): the weather first,
 * because "will it rain today" is the question of the morning; then the
 * calendar, compact, with the ongoing event marked in place instead of
 * repeated in a second card; then the tasks that are waiting, tickable; the
 * birthdays last and quiet. There is no Teraz card, no dinner card and no day
 * plan any more - the wall keeps its own model (utils/wall-plan.js).
 */

import { t, formatTime, getLocale, getTimeFormat, getNumberFormat } from '/i18n.js';
import { buildPlan, buildTomorrow, firstName } from '/utils/today-plan.js';
import { addLocalDays } from '/utils/date.js';
import { shortDayMonth, shortWeekdayDayMonth } from '/utils/day-label.js';

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
  const rows = plan.all.filter((row) => row.kind === 'event').map((row) => {
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
    .rows.filter((row) => row.kind === 'event');
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

/**
 * The tasks that wait, in the server's order (overdue, then by date, undated
 * last): title, due text, a flag for high/urgent, and whose it is.
 */
export function pendingTasks(data, ctx) {
  const open = (Array.isArray(data?.urgentTasks) ? data.urgentTasks : []).filter((task) => task && task.status !== 'done');
  const rows = open.slice(0, TASK_ROWS).map((task) => {
    const due = String(task.due_date ?? '').slice(0, 10);
    const people = Array.isArray(task.assigned_users) ? task.assigned_users.filter((p) => p && p.id != null) : [];
    return {
      key: `task:${task.id}`,
      id: task.id,
      title: String(task.title ?? ''),
      due: dueLabel(due, ctx),
      late: Boolean(due) && due < ctx.todayKey,
      flag: task.priority === 'high' || task.priority === 'urgent',
      person: people[0] ?? null,
      task,
    };
  });
  const total = Number(data?.openTaskCount);
  return { rows, total: Number.isFinite(total) && total >= rows.length ? total : rows.length };
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

/** What changes by the clock alone - the page rebuilds only when this does. */
export function clockStamp(calendar, weather, ctx) {
  return JSON.stringify([
    ctx.todayKey,
    calendar?.earlier?.rows.map((row) => row.key),
    calendar?.rows.map((row) => `${row.key}:${row.ongoing}`),
    Math.floor(ctx.nowMin / 60),
    weather?.dry?.label ?? '',
  ]);
}
