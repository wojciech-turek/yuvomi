/**
 * Modul: Dziś - the view (Tafla, 2026-10-19)
 * Zweck: Draws the start page from the model in /utils/today-plan.js: the
 *        header (date, greeting, weather, the viewer's avatar), the Teraz card,
 *        "Plan dnia" with its "Wcześniej" row, then the sections in the
 *        viewer's order (Zakupy, Jutro, Pytanie tygodnia, Wkrótce, extras) and
 *        the quiet "Dostosuj Dziś" link. Wiring is one delegated listener on
 *        the page root; what a tap DOES comes in from the page as handlers.
 * Abhängigkeiten: /i18n.js, /utils/html.js, /utils/person-color.js,
 *                 /utils/today-plan.js
 *
 * Markup is built as strings with esc() on every value and goes in through
 * insertAdjacentHTML (house rule: no innerHTML writes). Icons are Lucide
 * placeholders; the caller runs createIcons on the root afterwards.
 */

import { t, formatTime, getLocale, getNumberFormat } from '/i18n.js';
import { esc } from '/utils/html.js';
import { personToken } from '/utils/person-color.js';
import { firstName, earlierLabel, minutesOf, MEAL_TIMES } from '/utils/today-plan.js';
import { recipeThumbHtml } from '/utils/recipe-thumb.js';
import { initials, compactInitials } from '/utils/initials.js';

// --------------------------------------------------------
// Small pieces
// --------------------------------------------------------

function icon(name, cls = '') {
  return `<i data-lucide="${esc(name)}"${cls ? ` class="${esc(cls)}"` : ''} aria-hidden="true"></i>`;
}

/**
 * The characters on a person disc - the ONE initials rule (utils/initials.js,
 * with the household's "LI"/"LE" where two people share a letter). The 20 and
 * 24 discs carry 13px type: two Latin letters fit, two Hangul/Han glyphs do
 * not, so they take the compact form, as the avatar stack does.
 */
function discText(name, size) {
  return size >= 36 ? initials(name, '?') : compactInitials(name, '?');
}

/**
 * A person disc: photo when there is one, else the initial on the person tint.
 * `size` is 20 (rows), 24 (meta) or 36 (header).
 */
export function personDisc(person, { size = 20, label = true } = {}) {
  if (!person) return '';
  const name = person.display_name ?? '';
  const token = personToken(person);
  const a11y = label ? ` role="img" aria-label="${esc(name)}" title="${esc(name)}"` : ' aria-hidden="true"';
  const style = `--disc-ink: ${token.ink}; --disc-tint: ${token.tint}`;
  if (person.avatar_data) {
    return `<span class="day-disc day-disc--${size} day-disc--photo"${a11y} style="${style}"><img src="${esc(person.avatar_data)}" alt="" loading="lazy"></span>`;
  }
  return `<span class="day-disc day-disc--${size}"${a11y} style="${style}">${esc(discText(name, size))}</span>`;
}

/** The split "razem" disc: the two first people's colours, diagonally. */
function razemDisc(people) {
  const [a, b] = people;
  const ta = personToken(a);
  const tb = personToken(b ?? a);
  const names = people.map((p) => p.display_name ?? '').filter(Boolean).join(', ');
  return `<span class="day-disc day-disc--20 day-disc--razem" role="img" aria-label="${esc(t('today.togetherWith', { names }))}" title="${esc(t('today.together'))}" style="--disc-a: ${ta.ink}; --disc-b: ${tb.ink}"></span>`;
}

/** The trailing disc of a row by the person rule (none / initial / razem). */
function whoMarkup(who) {
  if (!who || who.kind === 'none') return '';
  if (who.kind === 'person') return personDisc(who.person);
  return razemDisc(who.people);
}

function pill(p) {
  if (!p) return '';
  return `<span class="day-pill day-pill--${esc(p.tone)}">${esc(p.text)}</span>`;
}

/** "214 zł" with the currency in ink-2 is the view's job; titles stay text. */
function meter(total, have) {
  const segments = Array.from({ length: total }, (_, i) => `<span class="day-meter__seg${i < have ? '' : ' day-meter__seg--missing'}"></span>`).join('');
  return `<span class="day-meter" aria-hidden="true">${segments}</span>`;
}

/** "poniedziałek, 19 października" in the household zone. */
export function longDateLabel(dateKey) {
  return new Intl.DateTimeFormat(getLocale(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
    .format(new Date(`${dateKey}T12:00:00Z`));
}

/** "wt 20 paź" - short weekday, day, short month, without the trailing dots. */
export function shortDateLabel(dateKey) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  const part = (opts) => new Intl.DateTimeFormat(getLocale(), { ...opts, timeZone: 'UTC' }).format(date).replace(/\.$/, '');
  return `${part({ weekday: 'short' })} ${part({ day: 'numeric' })} ${part({ month: 'short' })}`;
}

function greetingKey(nowMin) {
  if (nowMin >= 5 * 60 && nowMin < 12 * 60) return 'dashboard.greetingMorning';
  if (nowMin >= 12 * 60 && nowMin < 18 * 60) return 'dashboard.greetingDay';
  return 'dashboard.greetingEvening';
}

// --------------------------------------------------------
// Header
// --------------------------------------------------------

const RAINY = /rain|drizzle|snow|lightning|^(09|10|11|13)[dn]$/;

function lowerFirst(text) {
  const s = String(text ?? '');
  return s ? s[0].toLocaleLowerCase(getLocale()) + s.slice(1) : s;
}

/**
 * "12° · pochmurno" and, when tomorrow turns wet while today is not, ", jutro
 * deszcz" - the next notable change the daily forecast can tell. No line
 * without weather.
 */
export function weatherLine(weather) {
  if (!weather?.current) return '';
  const describe = (desc) => (weather.provider === 'open-meteo' ? t(desc) : String(desc ?? ''));
  const temp = Number(weather.current.temp);
  const tempText = Number.isFinite(temp) ? `${getNumberFormat().format(temp)}°` : '';
  let text = [tempText, lowerFirst(describe(weather.current.desc))].filter(Boolean).join(' · ');
  const tomorrow = Array.isArray(weather.forecast) ? weather.forecast[0] : null;
  if (tomorrow && RAINY.test(String(tomorrow.icon ?? '')) && !RAINY.test(String(weather.current.icon ?? ''))) {
    text += `, ${t('today.weatherTomorrow', { what: lowerFirst(describe(tomorrow.desc)) })}`;
  }
  const glyph = weather.provider === 'open-meteo' ? String(weather.current.icon || 'cloud') : 'cloud';
  return `<p class="day-head__weather">${icon(glyph)}<span>${esc(text)}</span></p>`;
}

function renderHeader(state) {
  const { user, ctx, weather, showWeather } = state;
  const me = user ?? {};
  const name = firstName(me.display_name);
  const avatar = personDisc({ ...me, avatar_color: me.avatar_color ?? me.color }, { size: 36, label: false });
  return `
    <header class="day-head">
      <div class="day-head__top">
        <p class="day-head__date">${esc(longDateLabel(ctx.todayKey))}</p>
        <a class="day-head__me" href="/settings" data-route="/settings" aria-label="${esc(t('today.profileLink', { name }))}">${avatar}</a>
      </div>
      <h2 class="day-head__greeting">${esc(t(greetingKey(ctx.nowMin), { name }))}</h2>
      ${showWeather ? weatherLine(weather) : ''}
    </header>`;
}

// --------------------------------------------------------
// Teraz
// --------------------------------------------------------

function eyebrowFor(minutes, time) {
  if (minutes <= 0) return t('today.now');
  if (minutes < 60) return t('today.inMinutes', { minutes });
  return t('today.atTime', { time: formatTime(time) });
}

function thenFooter(then) {
  return then ? `<p class="day-now__then">${esc(then.text)}</p>` : '';
}

function plateMarkup(meal) {
  return recipeThumbHtml({
    recipeId: meal?.recipe_id ?? null,
    hasImage: Boolean(meal?.recipe_has_image),
    hasOwnImage: Boolean(meal?.recipe_has_own_image),
    className: 'day-now__plate',
    iconClass: 'day-now__plate-icon',
  });
}

function renderDinner(now, state) {
  const { meal, cook, ingredients } = now;
  const eyebrow = now.minutes <= 0
    ? t('today.dinnerNow')
    : now.minutes < 60 ? t('today.dinnerIn', { minutes: now.minutes }) : t('today.dinnerAt', { time: formatTime(MEAL_TIMES.dinner) });
  const cookLine = cook
    ? `<span class="day-now__meta">${now.cookWho.kind === 'none' ? '' : personDisc(cook, { label: false })}<span>${esc(cook.id === state.user?.id ? t('today.youCook') : t('today.cooks', { name: firstName(cook.display_name) }))}</span></span>`
    : '';
  let meterLine = '';
  let secondary = '';
  if (ingredients && ingredients.total > 0) {
    const missing = ingredients.missing ?? [];
    const onList = ingredients.on_list ?? [];
    const caption = [t('today.haveOf', { have: ingredients.have, total: ingredients.total })];
    if (missing.length) caption.push(t('today.toBuy', { items: missing.join(', ') }));
    else if (onList.length) caption.push(t('today.alreadyOnList', { items: onList.join(', ') }));
    meterLine = `<p class="day-now__meter">${meter(ingredients.total, ingredients.have)}<span>${esc(caption.join(' · '))}</span></p>`;
    if (missing.length && state.canWriteShopping) {
      const label = missing.length === 1 ? t('today.addMissingOne') : t('today.addMissing', { n: missing.length });
      secondary = `<button type="button" class="day-btn day-btn--secondary day-btn--on-hearth" data-day-action="add-missing"
        aria-label="${esc(t('today.addMissingAria', { items: missing.join(', ') }))}">${esc(label)}</button>`;
    }
  }
  const openRoute = meal.recipe_id ? `/recipes?open=${encodeURIComponent(String(meal.recipe_id))}` : '/meals';
  return `
    <section class="day-now day-now--dinner" aria-label="${esc(t('today.nowLabel'))}">
      <a class="day-now__lead" href="${esc(openRoute)}" data-route="${esc(openRoute)}">
        <span class="day-now__text">
          <span class="day-now__eyebrow">${esc(eyebrow)}</span>
          <span class="day-now__title">${esc(meal.title)}</span>
          ${cookLine}
        </span>
        ${plateMarkup(meal)}
      </a>
      ${meterLine}
      <div class="day-now__actions">
        <button type="button" class="day-btn day-btn--primary" data-day-action="cook">${icon('chef-hat')}<span>${esc(t('today.cook'))}</span></button>
        ${secondary}
      </div>
      ${thenFooter(now.then)}
    </section>`;
}

function rowOpenAttrs(row) {
  if (row.kind === 'task') return { tag: 'button', attrs: `type="button" data-day-action="open" data-row-key="${esc(row.key)}"` };
  const route = row.kind === 'event'
    ? `/calendar?${new URLSearchParams({ open: String(row.id), date: row.dayKey ?? '' }).toString()}`
    : row.kind === 'dose' ? '/health' : (row.route || '/');
  return { tag: 'a', attrs: `href="${esc(route)}" data-route="${esc(route)}"` };
}

function renderNowRow(now, state) {
  const { row } = now;
  const eyebrow = row.running ? t('today.runningUntil', { time: formatTime(`${String(row.endMin / 60 | 0).padStart(2, '0')}:${String(row.endMin % 60).padStart(2, '0')}`) })
    : eyebrowFor(now.minutes, row.time);
  const meta = [row.meta].filter(Boolean).join(' · ');
  const who = whoMarkup(row.who);
  const open = rowOpenAttrs(row);
  const canCheck = row.checkable && state.canCheck(row);
  const action = canCheck
    ? `<div class="day-now__actions"><button type="button" class="day-btn day-btn--primary" data-day-action="check" data-row-key="${esc(row.key)}">${icon('check')}<span>${esc(row.kind === 'dose' ? t('today.markTaken') : t('today.markDone'))}</span></button></div>`
    : '';
  return `
    <section class="day-now" aria-label="${esc(t('today.nowLabel'))}">
      <${open.tag} class="day-now__lead" ${open.attrs}>
        <span class="day-now__text">
          <span class="day-now__eyebrow">${esc(eyebrow)}</span>
          <span class="day-now__title">${esc(row.title)}</span>
          ${meta || who ? `<span class="day-now__meta">${who}<span>${esc(meta)}</span></span>` : ''}
        </span>
        <span class="day-now__plate day-now__plate--glyph" aria-hidden="true">${icon(row.kind === 'event' ? 'calendar' : row.kind === 'dose' ? 'pill' : row.icon || 'circle-check')}</span>
      </${open.tag}>
      ${action}
      ${thenFooter(now.then)}
    </section>`;
}

function formatTimer(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function renderTimer(now) {
  const done = now.timer.state === 'done';
  return `
    <section class="day-now" aria-label="${esc(t('today.nowLabel'))}">
      <div class="day-now__lead">
        <span class="day-now__text">
          <span class="day-now__eyebrow">${esc(t('today.timer'))}</span>
          <span class="day-now__clock" role="timer" data-day-timer>${esc(done ? t('today.timerDone') : formatTimer(now.timer.remainingMs))}</span>
        </span>
        <span class="day-now__plate day-now__plate--glyph" aria-hidden="true">${icon(done ? 'bell-ring' : 'timer')}</span>
      </div>
      <div class="day-now__actions">
        <button type="button" class="day-btn day-btn--plain" data-day-action="timer-stop">${esc(done ? t('today.timerAck') : t('today.timerStop'))}</button>
      </div>
      ${thenFooter(now.then)}
    </section>`;
}

function renderFree(now, state) {
  const title = now.evening ? t('today.freeEvening') : t('today.freeDay');
  const pointer = now.then?.text
    ?? (state.tomorrow.rows[0] ? t('today.tomorrowPointer', { what: tomorrowWhat(state.tomorrow.rows[0]) }) : '');
  return `
    <section class="day-now day-now--quiet" aria-label="${esc(t('today.nowLabel'))}">
      <div class="day-now__lead">
        <span class="day-now__text">
          <span class="day-now__title">${esc(title)}</span>
          ${pointer ? `<span class="day-now__meta"><span>${esc(pointer)}</span></span>` : ''}
        </span>
        <span class="day-now__plate day-now__plate--glyph" aria-hidden="true">${icon(now.evening ? 'moon' : 'sun')}</span>
      </div>
    </section>`;
}

function renderNow(state) {
  const now = state.now;
  if (!now) return '';
  if (now.mode === 'timer') return renderTimer(now);
  if (now.mode === 'dinner') return renderDinner(now, state);
  if (now.mode === 'event' || now.mode === 'next') return renderNowRow(now, state);
  return renderFree(now, state);
}

// --------------------------------------------------------
// The end of the day
// --------------------------------------------------------

function tomorrowWhat(row) {
  return [row.timeLabel && row.kind === 'event' ? row.timeLabel : '', row.title].filter(Boolean).join(' ');
}

/* The person edge of the Jutro peek, like a calendar row: everyone's own
 * colour - the viewer's too, it is a calendar edge, not a disc -, violet for
 * together, nothing for an unassigned row. */
function edgeOf(row) {
  const people = (row.people ?? []).filter((p) => p?.id != null);
  if (people.length === 1) return personToken(people[0]).ink;
  if (people.length > 1) return 'var(--color-accent)';
  return '';
}

function renderClosed(state) {
  const { plan } = state;
  const parts = [t('today.closedDone', { count: plan.checkDone })];
  if (plan.pastEvents.length) parts.push(t('today.earlierEvents', { count: plan.pastEvents.length }));
  const rows = state.tomorrow.rows.slice(0, 3);
  const peek = rows.length ? `
      <div class="day-closed__tomorrow">
        <p class="day-closed__label">${esc(t('today.tomorrow'))}</p>
        <ul class="day-closed__list">
          ${rows.map((row) => `
          <li class="day-closed__row${edgeOf(row) ? ' day-closed__row--edge' : ''}"${edgeOf(row) ? ` style="--edge: ${edgeOf(row)}"` : ''}>
            <span class="day-closed__when">${esc(row.kind === 'event' ? row.timeLabel : row.kind === 'meal' ? t('today.dinnerShort') : '')}</span>
            <span class="day-closed__what">${esc(row.kind === 'meal' ? row.meal?.title ?? row.title : row.title)}</span>
          </li>`).join('')}
        </ul>
      </div>` : '';
  return `
    <section class="day-closed" aria-label="${esc(t('today.closedTitle'))}">
      <div class="day-closed__head">
        <span class="day-closed__check" aria-hidden="true">${icon('check')}</span>
        <div class="day-closed__text">
          <h3 class="day-closed__title">${esc(t('today.closedTitle'))}</h3>
          <p class="day-closed__sub">${esc(parts.join(' · '))}</p>
        </div>
      </div>
      ${peek}
    </section>`;
}

// --------------------------------------------------------
// Plan dnia
// --------------------------------------------------------

function checkButton(row, state) {
  if (!row.checkable) {
    return `<span class="day-row__glyph" aria-hidden="true">${icon(row.icon || 'circle')}</span>`;
  }
  const label = row.done
    ? t(row.kind === 'dose' ? 'today.undoTakenAria' : 'today.reopenAria', { title: row.title })
    : t(row.kind === 'dose' ? 'today.markTakenAria' : 'today.markDoneAria', { title: row.title });
  const disabled = state.canCheck(row) ? '' : ' disabled';
  // The ring is the app's one check circle (`.check-ring`, list-row.css).
  return `<button type="button" class="day-check check-ring${row.done ? ' day-check--done check-ring--done' : ''}" data-day-action="check" data-row-key="${esc(row.key)}"
      aria-pressed="${row.done ? 'true' : 'false'}" aria-label="${esc(label)}"${disabled}>${icon('check')}</button>`;
}

function rowMeta(row) {
  const bits = [];
  if (row.pill) bits.push(pill(row.pill));
  if (row.repeats) bits.push(icon('repeat', 'day-row__meta-icon'));
  if (row.repeatLabel) bits.push(`<span class="day-row__meta-text">${esc(row.repeatLabel)}</span>`);
  if (row.meta) bits.push(`<span class="day-row__meta-text">${esc(row.meta)}</span>`);
  return bits.length ? `<span class="day-row__meta">${bits.join('')}</span>` : '';
}

export function renderPlanRow(row, state) {
  const open = rowOpenAttrs(row);
  const time = row.timeLabel && row.kind !== 'meal' ? `<span class="day-row__time">${esc(row.timeLabel)}</span>` : '';
  const who = whoMarkup(row.who);
  const twoLine = Boolean(row.meta || row.pill);
  return `
    <li class="day-row${twoLine ? '' : ' day-row--single'}${row.done ? ' day-row--done' : ''}${row.past ? ' day-row--past' : ''}" data-row-key="${esc(row.key)}" data-kind="${esc(row.kind)}"${row.kind === 'task' && row.id != null ? ` data-object-kind="task" data-object-id="${esc(String(row.id))}"` : ''}>
      ${checkButton(row, state)}
      <${open.tag} class="day-row__main" ${open.attrs}>
        <span class="day-row__body">
          <span class="day-row__title">${esc(row.title)}</span>
          ${rowMeta(row)}
        </span>
        ${time || who ? `<span class="day-row__trail">${time}${who}</span>` : ''}
      </${open.tag}>
    </li>`;
}

function renderPlan(state) {
  const { plan } = state;
  if (!plan.open.length && !plan.earlier.length) return '';
  const label = earlierLabel(plan);
  const earlierOpen = Boolean(state.earlierOpen);
  const earlier = label ? `
      <li class="day-earlier">
        <button type="button" class="day-earlier__toggle" data-day-action="earlier" aria-expanded="${earlierOpen ? 'true' : 'false'}" aria-controls="day-earlier-rows">
          <span class="day-earlier__lead" aria-hidden="true">${icon('chevron-up')}</span>
          <span class="day-earlier__label">${esc(label)}</span>
          <span class="day-earlier__chevron" aria-hidden="true">${icon('chevron-down')}</span>
        </button>
        <ul class="day-list day-list--earlier" id="day-earlier-rows"${earlierOpen ? '' : ' hidden'}>
          ${plan.earlier.map((row) => renderPlanRow(row, state)).join('')}
        </ul>
      </li>` : '';
  const count = plan.checkTotal > 0
    ? `<span class="day-section__count">${esc(t('today.countOf', { done: plan.checkDone, total: plan.checkTotal }))}</span>`
    : '';
  const nothingLeft = !plan.open.length && !state.closed
    ? `<li class="day-row day-row--single day-row--quiet"><span class="day-row__glyph" aria-hidden="true">${icon('check')}</span><span class="day-row__main"><span class="day-row__body"><span class="day-row__title">${esc(t('today.nothingLeft'))}</span></span></span></li>`
    : '';
  return `
    <section class="day-section day-plan" aria-labelledby="day-plan-title">
      <div class="day-section__head${state.closed ? ' sr-only' : ''}">
        <h3 class="day-section__title" id="day-plan-title">${esc(t('today.planTitle'))}</h3>
        ${count}
      </div>
      <ul class="day-list day-card">
        ${earlier}
        ${plan.open.map((row) => renderPlanRow(row, state)).join('')}
        ${nothingLeft}
      </ul>
    </section>`;
}

// --------------------------------------------------------
// Sections
// --------------------------------------------------------

function sectionHead(id, title, aside = '') {
  return `
      <div class="day-section__head">
        <h3 class="day-section__title" id="${esc(id)}">${esc(title)}</h3>
        ${aside}
      </div>`;
}

function renderShopping(state) {
  const s = state.shopping;
  if (!s || (!s.count && !s.predictions.length)) return '';
  const meta = s.predictions.length
    ? `<span class="day-row__meta">${icon('sparkles', 'day-row__meta-icon')}<span class="day-row__meta-text">${esc(t('today.probablyRunningLow', { items: s.predictions.join(', ') }))}</span></span>`
    : s.lists > 1 ? `<span class="day-row__meta"><span class="day-row__meta-text">${esc(t('today.onLists', { n: s.lists }))}</span></span>` : '';
  const title = s.count ? t('today.shoppingItems', { count: s.count }) : t('today.shoppingEmpty');
  return `
    <section class="day-section" aria-labelledby="day-shopping-title">
      ${sectionHead('day-shopping-title', t('today.shoppingTitle'))}
      <a class="day-link-row day-card" href="${esc(s.route)}" data-route="${esc(s.route)}">
        <span class="day-row__glyph" aria-hidden="true">${icon('shopping-cart')}</span>
        <span class="day-row__body">
          <span class="day-row__title">${esc(title)}</span>
          ${meta}
        </span>
        <span class="day-row__chevron" aria-hidden="true">${icon('chevron-right')}</span>
      </a>
    </section>`;
}

function renderTomorrow(state) {
  const { tomorrow, ctx } = state;
  if (!tomorrow.rows.length) return '';
  const route = `/calendar?date=${encodeURIComponent(ctx.tomorrowKey)}`;
  return `
    <section class="day-section" aria-labelledby="day-tomorrow-title">
      ${sectionHead('day-tomorrow-title', t('today.tomorrow'), `<span class="day-section__count">${esc(shortDateLabel(ctx.tomorrowKey))}</span>`)}
      <ul class="day-list day-card">
        ${tomorrow.rows.map((row) => renderPlanRow(row, state)).join('')}
        <li class="day-more">
          <a class="day-more__link" href="${esc(route)}" data-route="${esc(route)}">
            <span>${esc(t('today.tomorrowAll'))}</span>${icon('chevron-right')}
          </a>
        </li>
      </ul>
    </section>`;
}

function renderQuestion(state) {
  const q = state.question;
  if (!q) return '';
  if (q.settled) {
    return `<section class="day-question day-question--settled" aria-live="polite"><p class="day-question__done">${esc(q.settled)}</p></section>`;
  }
  const options = (q.options ?? []).map((label, i) => `
        <button type="button" class="day-chip${i === 0 ? ' day-chip--accent' : ''}" data-day-action="answer" data-option="${i}">${i === 0 ? icon('plus') : ''}<span>${esc(label)}</span></button>`).join('');
  return `
    <section class="day-question" aria-labelledby="day-question-title">
      <div class="day-question__head">
        <p class="day-question__label" id="day-question-title">${icon('sparkles')}<span>${esc(t('today.questionTitle'))}</span></p>
        <button type="button" class="day-btn day-btn--plain day-btn--compact" data-day-action="skip-question" aria-label="${esc(t('today.questionSkipAria'))}">${esc(t('ai.questionSkip'))}</button>
      </div>
      <p class="day-question__text">${esc(q.question)}</p>
      <div class="day-question__options" role="group" aria-label="${esc(t('today.questionAnswers'))}">${options}</div>
    </section>`;
}

function soonTrail(row) {
  if (row.days <= 3) {
    const text = row.days === 1 ? t('common.tomorrow').toLocaleLowerCase(getLocale()) : t('today.inDays', { days: row.days });
    return pill({ tone: 'warning', text });
  }
  return `<span class="day-row__time">${esc(t('today.inDays', { days: row.days }))}</span>`;
}

function renderSoon(state) {
  const rows = state.soon;
  if (!rows.length) return '';
  return `
    <section class="day-section" aria-labelledby="day-soon-title">
      ${sectionHead('day-soon-title', t('today.soonTitle'))}
      <ul class="day-list day-card">
        ${rows.map((row) => {
          const meta = [row.meta, row.date ? shortDateLabel(row.date) : ''].filter(Boolean).join(' · ');
          const attrs = row.taskId != null
            ? `type="button" data-day-action="open-task" data-task-id="${esc(String(row.taskId))}"`
            : `href="${esc(row.route)}" data-route="${esc(row.route)}"`;
          const tag = row.taskId != null ? 'button' : 'a';
          return `
        <li class="day-row" data-kind="${esc(row.kind)}">
          <span class="day-row__glyph" aria-hidden="true">${icon(row.icon)}</span>
          <${tag} class="day-row__main" ${attrs}>
            <span class="day-row__body">
              <span class="day-row__title">${esc(row.title)}</span>
              ${meta ? `<span class="day-row__meta"><span class="day-row__meta-text">${esc(meta)}</span></span>` : ''}
            </span>
            <span class="day-row__trail">${soonTrail(row)}</span>
          </${tag}>
        </li>`;
        }).join('')}
      </ul>
    </section>`;
}

/** Preview tiles ("Kafelek podglądu") for the optional extras, two to a row. */
function renderTiles(tiles) {
  if (!tiles.length) return '';
  return `
    <div class="day-tiles">
      ${tiles.map((tile) => `
      <a class="day-tile" href="${esc(tile.route)}" data-route="${esc(tile.route)}">
        <span class="day-tile__label">${icon(tile.icon)}<span>${esc(tile.label)}</span></span>
        <span class="day-tile__value">${esc(tile.value)}</span>
        ${tile.note ? `<span class="day-tile__note">${tile.noteTone === 'danger' ? pill({ tone: 'danger', text: tile.note }) : esc(tile.note)}</span>` : ''}
      </a>`).join('')}
    </div>`;
}

function renderFamily(state) {
  const members = state.family;
  if (!members?.length) return '';
  return `
    <section class="day-section" aria-labelledby="day-family-title">
      ${sectionHead('day-family-title', t('dashboard.familyTitle'))}
      <ul class="day-list day-card">
        ${members.map((m) => `
        <li class="day-row day-row--single">
          <span class="day-row__glyph">${personDisc(m, { size: 24, label: false })}</span>
          <span class="day-row__main">
            <span class="day-row__body"><span class="day-row__title">${esc(m.display_name ?? '')}</span></span>
            <span class="day-row__trail"><span class="day-row__time">${esc(m.open ? t('today.familyOpen', { n: m.open }) : t('today.familyFree'))}</span></span>
          </span>
        </li>`).join('')}
      </ul>
    </section>`;
}

/**
 * The sections below the plan, in the viewer's order. Consecutive extras
 * (preview tiles) share one 2-up grid.
 */
function renderSections(state) {
  const out = [];
  let tiles = [];
  const flushTiles = () => { if (tiles.length) out.push(renderTiles(tiles)); tiles = []; };
  for (const id of state.sections) {
    if (state.tiles.has(id)) { tiles.push(state.tiles.get(id)); continue; }
    flushTiles();
    if (id === 'today-shopping') out.push(renderShopping(state));
    else if (id === 'today-tomorrow' && !state.closed) out.push(renderTomorrow(state));
    else if (id === 'today-question') out.push(renderQuestion(state));
    else if (id === 'today-soon') out.push(renderSoon(state));
    else if (id === 'family') out.push(renderFamily(state));
    else if (state.extensions.has(id)) {
      out.push(`<section class="day-section day-ext" data-widget-id="${esc(id)}" aria-label="${esc(state.extensions.get(id))}"><div class="day-card day-ext__body" data-extension-widget-mount></div></section>`);
    }
  }
  flushTiles();
  return out.filter(Boolean).join('');
}

// --------------------------------------------------------
// Empty / first run
// --------------------------------------------------------

function renderFirstRun(state) {
  const chips = [
    { route: '/tasks', label: t('today.startTask'), module: 'tasks' },
    { route: '/calendar', label: t('today.startEvent'), module: 'calendar' },
    { route: '/meals', label: t('today.startDinner'), module: 'meals' },
  ].filter((chip) => !state.ctx.moduleOff(chip.module));
  return `
    <section class="day-empty" aria-labelledby="day-empty-title">
      <span class="day-empty__glyph" aria-hidden="true">${icon('sunrise')}</span>
      <h3 class="day-empty__title" id="day-empty-title">${esc(t('today.firstRunTitle'))}</h3>
      <p class="day-empty__text">${esc(t('today.firstRunText'))}</p>
      <div class="day-empty__chips">
        ${chips.map((chip) => `<a class="day-chip day-chip--accent" href="${esc(chip.route)}" data-route="${esc(chip.route)}">${icon('plus')}<span>${esc(chip.label)}</span></a>`).join('')}
      </div>
    </section>`;
}

// --------------------------------------------------------
// The page
// --------------------------------------------------------

/**
 * The whole page body. `state` is assembled by the page (pages/dashboard.js):
 *   user, ctx, weather, showWeather, plan, now, closed, tomorrow, soon,
 *   shopping, question, sections, tiles (Map id -> tile), extensions
 *   (Map id -> label), family, earlierOpen, firstRun, canCustomize,
 *   canCheck(row), canWriteShopping
 */
export function renderTodayPage(state) {
  const top = state.firstRun
    ? renderFirstRun(state)
    : `${state.closed ? renderClosed(state) : renderNow(state)}${renderPlan(state)}`;
  const customize = state.canCustomize
    ? `<div class="day-foot">
        <button type="button" class="day-btn day-btn--plain" data-day-action="customize" aria-haspopup="dialog">${esc(t('today.customize'))}</button>
      </div>`
    : '';
  return `
    <div class="day" data-today>
      ${renderHeader(state)}
      <div class="day-body">
        ${top}
        ${renderSections(state)}
        ${customize}
      </div>
    </div>`;
}

/**
 * The page before the data: the header lines and the shapes of the Teraz card
 * and the plan, so nothing jumps when the content arrives.
 */
export function renderTodaySkeleton() {
  const rows = Array.from({ length: 4 }, () => `
        <div class="day-skeleton__row"><span class="skeleton day-skeleton__dot"></span><span class="skeleton skeleton-line skeleton-line--medium"></span></div>`).join('');
  return `
    <div class="day day-skeleton" aria-hidden="true">
      <div class="day-head">
        <div class="skeleton skeleton-line skeleton-line--short"></div>
        <div class="skeleton day-skeleton__title"></div>
      </div>
      <div class="day-body">
        <div class="skeleton day-skeleton__card"></div>
        <div class="day-card day-skeleton__list">${rows}</div>
      </div>
    </div>`;
}

/** Re-renders only the ticking timer text, once a second, without a rebuild. */
export function updateTimerText(root, timer) {
  const el = root?.querySelector?.('[data-day-timer]');
  if (!el || !timer) return;
  el.textContent = timer.state === 'done' ? t('today.timerDone') : formatTimer(timer.remainingMs);
}

/** Minutes until a 'HH:MM' from `nowMin` (for tests and the page). */
export function minutesUntil(time, nowMin) {
  return minutesOf(time) - nowMin;
}
