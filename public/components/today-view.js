/**
 * Modul: Dziś - the view (design v2, 2026-10-27)
 * Zweck: Draws the home screen from the model in /utils/dzis-plan.js, top to
 *        bottom as the owner's design has it: the header (date, greeting, the
 *        viewer's avatar), the weather card with the rain of the day, the
 *        compact calendar of today, the pending tasks (tickable), and the
 *        birthdays soon. Wiring is one delegated listener on the page root
 *        (pages/dashboard.js); a tap's meaning comes from `data-day-action`.
 * Abhängigkeiten: /i18n.js, /utils/html.js, /utils/person-color.js,
 *                 /utils/initials.js, /utils/today-plan.js
 *
 * Markup is built as strings with esc() on every value and goes in through
 * insertAdjacentHTML (house rule: no innerHTML writes). Icons are Lucide
 * placeholders; the caller runs createIcons on the root afterwards.
 *
 * WHAT IS GONE (2026-10-27, v2): the Teraz card, the dinner card, the day plan
 * (it repeated the ongoing event), Zakupy, Jutro, the question of the week,
 * the preview tiles, extension widgets and "Dostosuj Dziś". The wall keeps its
 * own view (components/wall-view.js).
 */

import { t, getTimeFormat } from '/i18n.js';
import { esc } from '/utils/html.js';
import { personToken } from '/utils/person-color.js';
import { initials, compactInitials } from '/utils/initials.js';
import { firstName } from '/utils/today-plan.js';

// --------------------------------------------------------
// Small pieces
// --------------------------------------------------------

function icon(name, cls = '') {
  return `<i data-lucide="${esc(name)}"${cls ? ` class="${esc(cls)}"` : ''} aria-hidden="true"></i>`;
}

/**
 * The characters on a person disc - the ONE initials rule (utils/initials.js,
 * with the household's "LI"/"LE" where two people share a letter). The 20 and
 * 24 discs carry small type: two Latin letters fit, two Hangul/Han glyphs do
 * not, so they take the compact form, as the avatar stack does.
 */
function discText(name, size) {
  return size >= 36 ? initials(name, '?') : compactInitials(name, '?');
}

/**
 * A person disc: photo when there is one, else the initial on the person tint.
 * `size` is 20 (rows) or 36 (header). With the household list the colour is
 * the person's place in it, so two people never share one (person-color.js).
 */
export function personDisc(person, { size = 20, label = true, household = [] } = {}) {
  if (!person) return '';
  const name = person.display_name ?? '';
  const token = personToken(person, household);
  const a11y = label ? ` role="img" aria-label="${esc(name)}" title="${esc(name)}"` : ' aria-hidden="true"';
  const style = `--disc-ink: ${token.ink}; --disc-tint: ${token.tint}`;
  if (person.avatar_data) {
    return `<span class="day-disc day-disc--${size} day-disc--photo"${a11y} style="${style}"><img src="${esc(person.avatar_data)}" alt="" loading="lazy"></span>`;
  }
  return `<span class="day-disc day-disc--${size}"${a11y} style="${style}">${esc(discText(name, size))}</span>`;
}

/**
 * The person dot of a calendar row: one colour, two for "razem", grey for
 * nobody. The dot takes the brighter dot shade of the v2 tokens
 * (`--person-N-dot`) where it exists, else the person's ink.
 */
function dots(people, household) {
  if (!people?.length) return '<span class="dz-dots" aria-hidden="true"><span class="dz-dot dz-dot--none"></span></span>';
  const dot = (person, cls = '') => {
    const { slot, ink } = personToken(person, household);
    return `<span class="dz-dot${cls}" style="--dot: var(--person-${slot}-dot, ${ink})"></span>`;
  };
  return `<span class="dz-dots${people.length > 1 ? ' dz-dots--pair' : ''}" aria-hidden="true">${dot(people[0])}${people[1] ? dot(people[1], ' dz-dot--second') : ''}</span>`;
}

function sectionHead(id, title, link, count = '') {
  return `
      <div class="dz-sec__head">
        <h2 class="dz-sec__title" id="${esc(id)}">${esc(title)}${count !== '' ? ` <span class="dz-sec__count">${esc(count)}</span>` : ''}</h2>
        ${link ? `<a class="dz-sec__link" href="${esc(link.route)}" data-route="${esc(link.route)}">${esc(link.label)}</a>` : ''}
      </div>`;
}

// --------------------------------------------------------
// Header
// --------------------------------------------------------

function renderHeader(state) {
  const me = state.user ?? {};
  const name = firstName(me.display_name);
  const avatar = personDisc({ ...me, avatar_color: me.avatar_color ?? me.color }, { size: 36, label: false, household: state.household });
  return `
    <header class="dz-head">
      <div class="dz-head__text">
        <p class="dz-head__date">${esc(state.dateLabel)}</p>
        <h2 class="dz-head__greeting">${esc(t(state.greetingKey, { name }))}</h2>
      </div>
      <a class="dz-head__me" href="/settings" data-route="/settings" aria-label="${esc(t('today.profileLink', { name }))}">${avatar}</a>
    </header>`;
}

// --------------------------------------------------------
// Weather
// --------------------------------------------------------

function renderChart(bars) {
  const cols = bars.map((bar) => `<span class="dz-chart__bar${bar.now ? ' dz-chart__bar--now' : bar.wet ? ' dz-chart__bar--wet' : ''}" style="--bar: ${bar.height}px"></span>`).join('');
  const labels = bars.map((bar) => `<span${bar.now ? ' class="dz-chart__now"' : ''}>${esc(bar.label)}</span>`).join('');
  return `
        <span class="dz-chart" aria-hidden="true">
          <span class="dz-chart__bars">${cols}</span>
          <span class="dz-chart__labels">${labels}</span>
        </span>`;
}

function renderWeather(w) {
  const line = w.rain ?? w.dry;
  return `
    <a class="dz-card dz-weather" href="/settings/personal/weather" data-route="/settings/personal/weather">
      <span class="dz-weather__now">
        ${icon(w.icon, 'dz-weather__icon')}
        <span class="dz-weather__temp">${esc(w.temp)}</span>
        <span class="dz-weather__text">
          <span class="dz-weather__desc">${esc(w.desc)}</span>
          ${w.meta ? `<span class="dz-weather__meta">${esc(w.meta)}</span>` : ''}
        </span>
        ${icon('chevron-right', 'dz-chevron')}
      </span>
      ${line ? `
      <span class="dz-weather__rain${w.rain ? '' : ' dz-weather__rain--dry'}">
        ${icon(w.rain ? 'umbrella' : 'sun', 'dz-weather__rain-icon')}
        <span class="dz-weather__rain-label">${esc(line.label)}</span>
        <span class="dz-weather__chance">${esc(line.chance)}</span>
      </span>` : ''}
      ${w.rain?.bars?.length ? renderChart(w.rain.bars) : ''}
    </a>`;
}

// --------------------------------------------------------
// Calendar
// --------------------------------------------------------

function calendarRow(row, household) {
  return `
          <li class="dz-cal__row${row.ongoing ? ' dz-cal__row--now' : ''}">
            <a class="dz-cal__link" href="${esc(row.route)}" data-route="${esc(row.route)}">
              <span class="dz-cal__time${row.allDay ? ' dz-cal__time--allday' : ''}">${esc(row.timeLabel)}</span>
              ${dots(row.people, household)}
              <span class="dz-cal__title">${esc(row.title)}</span>
              ${row.until ? `<span class="dz-cal__meta dz-cal__meta--now">${esc(row.until)}</span>` : row.meta ? `<span class="dz-cal__meta">${esc(row.meta)}</span>` : ''}
            </a>
          </li>`;
}

function renderCalendar(state) {
  const cal = state.calendar;
  const earlier = cal.earlier.rows.length ? `
        <button type="button" class="dz-cal__earlier" data-day-action="earlier" aria-expanded="${state.earlierOpen ? 'true' : 'false'}" aria-controls="dz-cal-earlier">
          <span>${esc(cal.earlier.label)}</span>${icon('chevron-down', 'dz-chevron dz-chevron--down')}
        </button>
        <ul class="dz-cal__list dz-cal__list--earlier" id="dz-cal-earlier"${state.earlierOpen ? '' : ' hidden'}>${cal.earlier.rows.map((row) => calendarRow(row, state.household)).join('')}
        </ul>` : '';
  const body = cal.empty
    ? `<p class="dz-cal__empty">${esc(t('today.calendarEmpty'))}</p>`
    : `${earlier}${cal.rows.length ? `
        <ul class="dz-cal__list">${cal.rows.map((row) => calendarRow(row, state.household)).join('')}
        </ul>` : ''}`;
  const tomorrow = cal.tomorrow ? `
        <a class="dz-cal__tomorrow" href="${esc(cal.tomorrow.route)}" data-route="${esc(cal.tomorrow.route)}">
          <span class="dz-cal__tomorrow-day">${esc(t('today.tomorrow'))}</span>
          <span class="dz-cal__tomorrow-text">${esc(cal.tomorrow.text)}</span>${icon('chevron-right', 'dz-chevron')}
        </a>` : '';
  return `
    <section class="dz-sec dz-sec--calendar" aria-labelledby="dz-cal-h">
      ${sectionHead('dz-cal-h', t('nav.calendar'), { route: '/calendar?view=week', label: t('calendar.viewWeek') })}
      <div class="dz-card dz-cal${getTimeFormat() === '12h' ? ' dz-cal--12h' : ''}">${body}${tomorrow}
      </div>
    </section>`;
}

// --------------------------------------------------------
// Tasks
// --------------------------------------------------------

function taskRow(row, state) {
  const check = state.canCheck
    ? `<button type="button" class="day-check check-ring${row.done ? ' day-check--done check-ring--done' : ''}" data-day-action="check" data-row-key="${esc(row.key)}"
            aria-pressed="${row.done ? 'true' : 'false'}" aria-label="${esc(t('tasks.markDone', { title: row.title }))}">${icon('check')}</button>`
    : '<span class="dz-task__spacer" aria-hidden="true"></span>';
  return `
          <li class="dz-task${row.done ? ' dz-task--done' : ''}" data-row-key="${esc(row.key)}" data-object-kind="task" data-object-id="${esc(String(row.id))}">
            ${check}
            <button type="button" class="dz-task__title" data-day-action="open" data-task-id="${esc(String(row.id))}">${esc(row.title)}</button>
            <span class="dz-task__aside">
              ${row.flag ? `<i data-lucide="flag" class="dz-task__flag" role="img" aria-label="${esc(t('today.priorityFlag'))}"></i>` : ''}
              ${row.due ? `<span class="dz-task__due${row.late ? ' dz-task__due--late' : ''}">${esc(row.due)}</span>` : ''}
              ${row.person ? personDisc(row.person, { household: state.household }) : ''}
            </span>
          </li>`;
}

function renderTasks(state) {
  const { rows, total } = state.tasks;
  const list = rows.length
    ? `<ul class="dz-tasks__list">${rows.map((row) => taskRow(row, state)).join('')}
        </ul>`
    : `<p class="dz-tasks__empty">${esc(t('tasks.allDoneText'))}</p>`;
  const add = state.canAddTask
    ? `<button type="button" class="dz-tasks__add" data-day-action="add-task">${icon('plus')}<span>${esc(t('dashboard.fabTaskLabel'))}</span></button>`
    : '';
  return `
    <section class="dz-sec dz-sec--tasks" aria-labelledby="dz-tasks-h">
      ${sectionHead('dz-tasks-h', t('nav.tasks'), { route: '/tasks', label: t('common.all') }, total > 0 ? String(total) : '')}
      <div class="dz-card dz-tasks">
        ${list}${add}
      </div>
    </section>`;
}

// --------------------------------------------------------
// Wkrótce
// --------------------------------------------------------

function renderSoon(rows) {
  return `
    <section class="dz-soon" aria-labelledby="dz-soon-h">
      <h2 class="dz-soon__title" id="dz-soon-h">${esc(t('today.soonTitle'))}</h2>
      <ul class="dz-soon__list">${rows.map((row) => `
        <li><a class="dz-soon__row" href="${esc(row.route)}" data-route="${esc(row.route)}">
          ${icon('cake', 'dz-soon__icon')}
          <span class="dz-soon__name">${esc(row.name)} <span class="dz-soon__kind">· ${esc(row.kind)}</span></span>
          <span class="dz-soon__when">${esc(row.when)}</span>
        </a></li>`).join('')}
      </ul>
    </section>`;
}

// --------------------------------------------------------
// The page
// --------------------------------------------------------

/**
 * The whole page body. `state` is assembled by the page (pages/dashboard.js):
 * { user, household, dateLabel, greetingKey, weather, calendar, tasks,
 *   birthdays, earlierOpen, canCheck, canAddTask } - a section whose module is
 * off comes as null and is not drawn.
 */
export function renderTodayPage(state) {
  return `
    <div class="dz" data-today>
      ${renderHeader(state)}
      ${state.weather ? renderWeather(state.weather) : ''}
      ${state.calendar ? renderCalendar(state) : ''}
      ${state.tasks ? renderTasks(state) : ''}
      ${state.birthdays?.length ? renderSoon(state.birthdays) : ''}
    </div>`;
}

/** The page before the data: header lines and the shapes of the cards. */
export function renderTodaySkeleton() {
  return `
    <div class="dz dz-skeleton" aria-hidden="true">
      <div class="dz-head">
        <div class="dz-head__text">
          <div class="skeleton skeleton-line skeleton-line--short"></div>
          <div class="skeleton dz-skeleton__title"></div>
        </div>
      </div>
      <div class="skeleton dz-skeleton__card dz-skeleton__card--weather"></div>
      <div class="skeleton dz-skeleton__card"></div>
      <div class="skeleton dz-skeleton__card"></div>
    </div>`;
}
