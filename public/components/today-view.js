/**
 * Modul: Dziś - the view (design v2, 2026-10-27; One Today, 2026-11-02)
 * Zweck: Draws the home screen from the model in /utils/dzis-plan.js, top to
 *        bottom as spec section 3 has it: the header (the date with the
 *        weather in one line, the greeting and the viewer's disc), Next up
 *        (the one heavy card), the compact calendar of today, the pending
 *        tasks in their groups (tickable), the notes and the next birthdays.
 *        Wiring is one delegated listener on the page root
 *        (pages/dashboard.js); a tap's meaning comes from `data-day-action`,
 *        else from the link's `data-route`.
 * Abhängigkeiten: /i18n.js, /utils/html.js, /utils/person-color.js,
 *                 /utils/today-plan.js
 *
 * Markup is built as strings with esc() on every value and goes in through
 * insertAdjacentHTML (house rule: no innerHTML writes). Icons are Lucide
 * placeholders; the caller runs createIcons on the root afterwards.
 *
 * WHAT IS GONE (2026-10-27, v2): the Teraz card, the dinner card, the day plan
 * (it repeated the ongoing event), Zakupy, Jutro, the question of the week,
 * the preview tiles, extension widgets and "Dostosuj Dziś". The wall keeps its
 * own view (components/wall-view.js).
 * ONE TODAY (2026-11-02): the weather card and its rain chart (the weather is
 * one line in the header now), "Wkrótce" (the Birthdays card replaces it) and
 * "Dodaj zadanie" at the foot of the tasks (the + adds).
 *
 * DOM ORDER IS THE READING ORDER: head, Next up, Kalendarz, Zadania,
 * Notatki, Urodziny. A wide screen places them in columns by CSS alone.
 */

import { t, getTimeFormat } from '/i18n.js';
import { esc } from '/utils/html.js';
import { loadingSpinnerHtml } from '/utils/skeleton.js';
import { personToken, personDisc } from '/utils/person-color.js';
import { firstName } from '/utils/today-plan.js';

// --------------------------------------------------------
// Small pieces
// --------------------------------------------------------

function icon(name, cls = '') {
  return `<i data-lucide="${esc(name)}"${cls ? ` class="${esc(cls)}"` : ''} aria-hidden="true"></i>`;
}

/**
 * The person dot of a calendar row: one colour, two for "razem", grey for
 * nobody. The dot is the brighter dot shade of the v2 tokens
 * (`--person-N-dot`, tokens.css), not the disc ink.
 */
function dots(people, household) {
  if (!people?.length) return '<span class="dz-dots" aria-hidden="true"><span class="dz-dot dz-dot--none"></span></span>';
  const dot = (person, cls = '') => {
    // Someone outside the household has no dot shade: the neutral ink.
    const { slot, ink } = personToken(person, household);
    return `<span class="dz-dot${cls}" style="--dot: ${slot ? `var(--person-${slot}-dot)` : ink}"></span>`;
  };
  return `<span class="dz-dots${people.length > 1 ? ' dz-dots--pair' : ''}" aria-hidden="true">${dot(people[0])}${people[1] ? dot(people[1], ' dz-dot--second') : ''}</span>`;
}

/**
 * The head of a section: an h3 under the greeting's h2, the count beside it
 * (never in the heading's name), the link at the end.
 */
function sectionHead(id, title, link, count = '') {
  return `
      <div class="dz-sec__head">
        <h3 class="dz-sec__title" id="${esc(id)}">${esc(title)}</h3>${count !== '' ? `
        <span class="dz-sec__count">${esc(count)}</span>` : ''}
        ${link ? `<a class="dz-sec__link" href="${esc(link.route)}" data-route="${esc(link.route)}">${esc(link.label)}</a>` : ''}
      </div>`;
}

// --------------------------------------------------------
// Header
// --------------------------------------------------------

/**
 * The date and, on the same line, the weather ("10° · bez deszczu do
 * wieczora") - one link to the weather detail the old card opened. Below: the
 * greeting (the page's h2) and the viewer's disc, the way to the profile.
 */
function renderHeader(state) {
  const me = state.user ?? {};
  const name = firstName(me.display_name);
  const avatar = personDisc(me, { size: 'md', household: state.household });
  const weather = state.weatherLine;
  return `
    <header class="dz-head">
      <div class="dz-head__line">
        <p class="dz-head__date">${esc(state.dateLabel)}</p>${weather ? `
        <a class="dz-head__weather" href="/settings/personal/weather" data-route="/settings/personal/weather">${icon(weather.icon, 'dz-head__weather-icon')}<span class="dz-head__weather-text">${esc(weather.text)}</span></a>` : ''}
      </div>
      <h2 class="dz-head__greeting">${esc(t(state.greetingKey, { name }))}</h2>
      <a class="dz-head__me" href="/settings" data-route="/settings" aria-label="${esc(t('today.profileLink', { name }))}">${avatar}</a>
    </header>`;
}

// --------------------------------------------------------
// Next up
// --------------------------------------------------------

/**
 * The one heavy card: when (violet), what (large), what after (grey). The
 * whole card is one link to that thing; its h3 is for the ear only - the eye
 * reads the card itself.
 */
function renderNextUp(next) {
  return `
    <section class="dz-next" aria-labelledby="dz-next-h">
      <h3 class="sr-only" id="dz-next-h">${esc(t('today.nextUpTitle'))}</h3>
      <a class="dz-next__card" href="${esc(next.route)}" data-route="${esc(next.route)}">
        <span class="dz-next__lead">${esc(next.lead)}</span>
        <span class="dz-next__title">${esc(next.title)}</span>${next.then ? `
        <span class="dz-next__then">${esc(next.then)}</span>` : ''}
      </a>
    </section>`;
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
              ${row.person ? personDisc(row.person, { label: true, household: state.household }) : ''}
            </span>
          </li>`;
}

/**
 * The tasks under their small labels ("Zaległe" in the attention tone, then
 * "Dziś", "Jutro", "Później", "Bez terminu"); each group is a list named by
 * its label. Nothing here adds a task - the + of the page does.
 */
function renderTasks(state) {
  const { groups, rows, total } = state.tasks;
  const body = rows.length
    ? groups.map((group) => `
        <p class="dz-group${group.id === 'late' ? ' dz-group--late' : ''}" id="dz-group-${esc(group.id)}">${esc(group.label)}</p>
        <ul class="dz-tasks__list" aria-labelledby="dz-group-${esc(group.id)}">${group.rows.map((row) => taskRow(row, state)).join('')}
        </ul>`).join('')
    : `<p class="dz-tasks__empty">${esc(t('tasks.allDoneText'))}</p>`;
  return `
    <section class="dz-sec dz-sec--tasks" aria-labelledby="dz-tasks-h">
      ${sectionHead('dz-tasks-h', t('nav.tasks'), { route: '/tasks', label: t('common.all') }, total > 0 ? String(total) : '')}
      <div class="dz-card dz-tasks">${body}
      </div>
    </section>`;
}

// --------------------------------------------------------
// Notes
// --------------------------------------------------------

/** Up to three notes: the title and one plain line under it, no icon. */
function renderNotes(notes) {
  return `
    <section class="dz-sec dz-sec--notes" aria-labelledby="dz-notes-h">
      ${sectionHead('dz-notes-h', t('nav.notes'), { route: '/notes', label: t('common.all') })}
      <ul class="dz-card dz-list">${notes.map((note) => `
        <li class="dz-list__row"><a class="dz-note" href="${esc(note.route)}" data-route="${esc(note.route)}">
          <span class="dz-note__title">${esc(note.title)}</span>${note.line ? `
          <span class="dz-note__line">${esc(note.line)}</span>` : ''}
        </a></li>`).join('')}
      </ul>
    </section>`;
}

// --------------------------------------------------------
// Birthdays
// --------------------------------------------------------

/**
 * The next three birthdays or name days. Today's stands in the attention
 * wash with the cake and "Dziś"; the others say the day and how far it is.
 */
function birthdayRow(row) {
  const when = row.today
    ? `<span class="dz-bday__pill">${icon('cake', 'dz-bday__cake')}<span>${esc(t('today.groupToday'))}</span></span>`
    : `<span class="dz-bday__when">
            <span class="dz-bday__date">${esc(row.date)}</span>
            <span class="dz-bday__far">${esc(row.far)}</span>
          </span>`;
  return `
        <li class="dz-list__row"><a class="dz-bday${row.today ? ' dz-bday--today' : ''}" href="${esc(row.route)}" data-route="${esc(row.route)}">
          <span class="dz-bday__text">
            <span class="dz-bday__name">${esc(row.name)}</span>
            <span class="dz-bday__sub">${esc(row.sub)}</span>
          </span>
          ${when}
        </a></li>`;
}

function renderBirthdays(rows) {
  return `
    <section class="dz-sec dz-sec--birthdays" aria-labelledby="dz-birthdays-h">
      ${sectionHead('dz-birthdays-h', t('nav.birthdays'), { route: '/birthdays', label: t('common.all') })}
      <ul class="dz-card dz-list">${rows.map(birthdayRow).join('')}
      </ul>
    </section>`;
}

// --------------------------------------------------------
// The page
// --------------------------------------------------------

/**
 * The whole page body. `state` is assembled by the page (pages/dashboard.js):
 * { user, household, dateLabel, greetingKey, weatherLine, nextUp, calendar,
 *   tasks, notes, birthdays, earlierOpen, canCheck } - a section whose module
 * is off comes as null (birthdays as []) and is not drawn; so are Next up,
 * the notes and the birthdays when there is nothing to show.
 */
export function renderTodayPage(state) {
  return `
    <div class="dz" data-today>
      ${renderHeader(state)}
      ${state.nextUp ? renderNextUp(state.nextUp) : ''}
      ${state.calendar ? renderCalendar(state) : ''}
      ${state.tasks ? renderTasks(state) : ''}
      ${state.notes?.length ? renderNotes(state.notes) : ''}
      ${state.birthdays?.length ? renderBirthdays(state.birthdays) : ''}
    </div>`;
}

/** The page before the data: one quiet spinner (fades in after 400 ms). */
export function renderTodaySkeleton() {
  return loadingSpinnerHtml();
}
