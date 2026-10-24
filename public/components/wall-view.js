/**
 * Modul: The kitchen wall - the view (Tafla, 2026-10-19)
 * Zweck: Draws the wall from the model in /utils/wall-plan.js: the header
 *        band (poster clock or the running timer, date, Teraz line, weather),
 *        the stage (tonight's dinner as the hero, the Dziś card, the shopping
 *        card, Jutro, the weekly question) and the dock (the way out and the
 *        timer discs). Read from two metres: nothing under 24px.
 * Abhängigkeiten: /i18n.js, /utils/html.js, /utils/person-color.js,
 *                 /utils/recipe-thumb.js, /components/wall-timer.js
 *
 * Markup as strings with esc() on every value, inserted with
 * insertAdjacentHTML by the page (house rule: no innerHTML writes). Icons are
 * Lucide placeholders; the page runs createIcons afterwards. What a tap DOES
 * lives in pages/dashboard.js - the elements carry `data-wall-*` hooks.
 */

import { t, getLocale } from '/i18n.js';
import { esc } from '/utils/html.js';
import { personDisc, razemDisc, personToken } from '/utils/person-color.js';
import { initials } from '/utils/initials.js';
import { recipeThumbHtml } from '/utils/recipe-thumb.js';
import { planWallRows } from '/utils/wall-plan.js';
import { renderWallTimer } from '/components/wall-timer.js';

function icon(name, cls = '') {
  return `<i data-lucide="${esc(name)}"${cls ? ` class="${esc(cls)}"` : ''} aria-hidden="true"></i>`;
}

/** "poniedziałek, 19 października" for a household day key. */
export function wallDateLabel(dayKey) {
  return new Intl.DateTimeFormat(getLocale(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
    .format(new Date(`${dayKey}T12:00:00Z`));
}

/**
 * A person's 40pt wall disc: their initials from the ONE initials rule
 * (utils/initials.js - "W", and "LI"/"LE" where two people share a letter),
 * in their person colour. `label` names it for a screen reader.
 */
export function wallPersonDisc(person, household = [], { label = true } = {}) {
  const name = person?.display_name ?? '';
  return personDisc(person, { text: initials(name, '?'), label: label ? name : '', household, size: 'lg', className: 'wall-disc' });
}

/** The 40pt disc of a row: an initial, or the split disc of two people. */
function whoDisc(who, household) {
  if (!who || who.kind === 'none') return '';
  if (who.kind === 'person') return wallPersonDisc(who.person, household);
  const [a, b] = who.people;
  const names = who.people.map((p) => p.display_name ?? '').filter(Boolean).join(', ');
  return razemDisc(a, b ?? a, { label: t('today.togetherWith', { names }), household, size: 'lg', className: 'wall-disc' });
}

// --------------------------------------------------------
// Header
// --------------------------------------------------------

function renderWeather(weather, weatherIcon) {
  if (!weather?.current) return '';
  const describe = (desc) => (weather.provider === 'open-meteo' ? t(desc) : String(desc ?? ''));
  const temp = Number(weather.current.temp);
  const desc = describe(weather.current.desc);
  const lower = (text) => (text ? text[0].toLocaleLowerCase(getLocale()) + text.slice(1) : '');
  const hi = Number(weather.today?.temp_max);
  const lo = Number(weather.today?.temp_min);
  const range = Number.isFinite(hi) && Number.isFinite(lo) ? `${Math.round(hi)}° / ${Math.round(lo)}°` : '';
  const line = [lower(desc), range].filter(Boolean).join(' · ');
  return `
    <div class="wall__weather">
      <p class="wall__weather-now">
        ${weatherIcon(weather, weather.current.icon, 'wall__weather-icon', 64, desc)}
        <span class="wall__weather-temp">${Number.isFinite(temp) ? esc(`${Math.round(temp)}°`) : ''}</span>
      </p>
      ${line ? `<p class="wall__weather-line">${esc(line)}</p>` : ''}
    </div>`;
}

function renderHead(model, { clock, weather, weatherIcon, timer }) {
  const teraz = model.teraz
    ? `<p class="wall__teraz">${model.teraz.lead ? `<span class="wall__teraz-lead">${esc(model.teraz.lead)}</span> ` : ''}${esc(model.teraz.text)}</p>`
    : '';
  // A RUNNING TIMER TAKES THE CLOCK SLOT (spec "Minutnik"): the remaining time
  // stands at poster size, the clock drops to the date line.
  const main = timer.display
    ? timer.display
    : `<time class="wall__clock u-rounded" id="wall-clock" datetime="${esc(clock.machine)}" data-toast-keepout>${esc(clock.time)}</time>`;
  const small = timer.display
    ? `<time class="wall__clock-small u-rounded" id="wall-clock" datetime="${esc(clock.machine)}">${esc(clock.time)}</time> `
    : '';
  return `
    <header class="wall__head">
      <div class="wall__head-main">
        ${main}
        <div class="wall__head-text" data-toast-keepout>
          <p class="wall__date">${small}<span id="wall-date">${esc(wallDateLabel(model.todayKey))}</span></p>
          ${model.scene === 'noc' ? renderNightLine(model) : teraz}
        </div>
      </div>
      ${model.sections.weather && model.scene !== 'noc' ? renderWeather(weather, weatherIcon) : ''}
    </header>`;
}

function renderNightLine(model) {
  const first = model.tomorrow?.rows?.[0];
  if (!first) return '';
  return `<p class="wall__teraz">${esc(t('today.tomorrowPointer', { what: `${first.time ? `${first.time} ` : ''}${first.title}` }))}</p>`;
}

// --------------------------------------------------------
// Stage
// --------------------------------------------------------

function meterMarkup(meter) {
  const segments = Array.from({ length: meter.total }, (_, i) => `<span class="wall-meter__seg${i < meter.have ? '' : ' wall-meter__seg--missing'}"></span>`).join('');
  return `
    <div class="wall-hero__meter">
      <span class="wall-meter" aria-hidden="true">${segments}</span>
      <span class="wall-hero__meter-text">${esc(meter.caption)}</span>
    </div>`;
}

function cookButton(card, { primary = true } = {}) {
  return `<button type="button" class="wall-cook${primary ? ' wall-cook--primary' : ''}" data-wall-cook
      data-meal="${esc(String(card.meal.id ?? ''))}" data-recipe="${esc(String(card.meal.recipe_id ?? ''))}" data-date="${esc(String(card.date ?? ''))}"
      aria-label="${esc(t('wall.cookAria', { title: card.title }))}">${icon('chef-hat')}<span>${esc(t('today.cook'))}</span></button>`;
}

function cookLine(card, household) {
  if (!card.cook) return '';
  return `<p class="wall-hero__cook">${wallPersonDisc(card.cook, household, { label: false })}<span>${esc(card.cookLine)}</span></p>`;
}

function renderHero(card, household) {
  return `
    <section class="wall-hero" aria-labelledby="wall-hero-title">
      <div class="wall-hero__body">
        <div class="wall-hero__top">
          <div class="wall-hero__text">
            <p class="wall-hero__eyebrow">${esc(card.eyebrow)}</p>
            <h2 class="wall-hero__title" id="wall-hero-title">${esc(card.title)}</h2>
          </div>
          ${recipeThumbHtml({
            recipeId: card.meal.recipe_id ?? null,
            hasImage: Boolean(card.meal.recipe_has_image),
            hasOwnImage: Boolean(card.meal.recipe_has_own_image),
            className: 'wall-hero__plate',
            iconClass: 'wall-hero__plate-icon',
          })}
        </div>
        ${cookLine(card, household)}
        ${card.meter ? meterMarkup(card.meter) : ''}
      </div>
      ${cookButton(card)}
    </section>`;
}

function renderDinnerCard(card, household) {
  return `
    <section class="wall-card wall-card--hearth wall-dinner" aria-labelledby="wall-dinner-title">
      <p class="wall-card__label">${esc(card.eyebrow)}</p>
      <h2 class="wall-dinner__title" id="wall-dinner-title">${esc(card.title)}</h2>
      ${card.cook ? cookLine(card, household).replace('wall-hero__cook', 'wall-dinner__cook') : ''}
      ${cookButton(card)}
    </section>`;
}

function renderRow(row, household) {
  const edgeStyle = row.edge === 'person' && row.who.kind === 'person'
    ? ` style="--wall-row-edge: ${esc(personToken(row.who.person, household).ink)}"`
    : '';
  const ring = row.checkable
    ? `<button type="button" class="wall-ring" data-wall-tick="${esc(row.key)}" aria-label="${esc(t('today.markDoneAria', { title: row.title }))}">${icon('check', 'wall-ring__check')}</button>`
    : '';
  const pill = row.pill ? `<span class="wall-pill wall-pill--${esc(row.pill.tone)}">${esc(row.pill.text)}</span>` : '';
  // WITH THE SWITCH ON the ring takes the time rail, so every title still
  // starts on one line; a task's own time moves in front of its title.
  const rail = ring || `<span class="wall-row__time u-rounded">${esc(row.time)}</span>`;
  const inlineTime = ring && row.time ? `<span class="wall-row__time u-rounded">${esc(row.time)}</span>` : '';
  return `
    <li class="wall-row${row.edge ? ` wall-row--edge-${esc(row.edge)}` : ''}${ring ? ' wall-row--tick' : ''}" data-wall-row${edgeStyle}>
      ${rail}
      <span class="wall-row__main">${inlineTime}<span class="wall-row__title">${esc(row.title)}</span>${pill}</span>
      <span class="wall-row__who">${whoDisc(row.who, household)}</span>
    </li>`;
}

function renderPlan(plan, household) {
  let body;
  if (!plan.rows.length) {
    const text = plan.closed ? t('wall.allDone') : t('today.freeDay');
    body = `<p class="wall-plan__state">${icon(plan.closed ? 'circle-check' : 'sun', 'wall-plan__state-icon')}<span>${esc(text)}</span></p>`;
  } else {
    body = `
      <ul class="wall-plan__list" data-wall-fit>
        ${plan.rows.map((row) => renderRow(row, household)).join('')}
        <li class="wall-row wall-row--more" data-wall-more hidden><span class="wall-row__time"></span><span class="wall-row__main"><span class="wall-row__title"></span></span></li>
      </ul>`;
  }
  return `
    <section class="wall-card wall-plan" aria-labelledby="wall-plan-title">
      <h2 class="wall-card__label wall-card__label--ink" id="wall-plan-title">${esc(t('nav.dashboard'))}</h2>
      ${body}
    </section>`;
}

function renderTomorrow(tomorrow, household) {
  return `
    <section class="wall-card wall-tomorrow" aria-labelledby="wall-tomorrow-title">
      <h2 class="wall-card__label wall-card__label--ink" id="wall-tomorrow-title">${esc(t('today.tomorrow'))}</h2>
      <ul class="wall-plan__list">
        ${tomorrow.rows.map((row) => renderRow({ ...row, edge: null, pill: null, checkable: false }, household)).join('')}
      </ul>
    </section>`;
}

function renderShopping(shop, { canTick }) {
  const names = shop.names.length
    ? `<span class="wall-shop__names">${esc(shop.names.join(' · '))}</span>`
    : '';
  let low = '';
  if (shop.runningOut.length) {
    low = canTick
      ? `<div class="wall-shop__low wall-shop__low--chips" role="group" aria-labelledby="wall-shop-low">
          <span class="wall-shop__low-label" id="wall-shop-low">${icon('sparkles')}<span>${esc(t('wall.runningOutLabel'))}</span></span>
          ${shop.runningOut.map((name) => `<button type="button" class="wall-chip" data-wall-add="${esc(name)}" aria-label="${esc(t('today.addMissingAria', { items: name }))}">${icon('plus')}<span>${esc(name)}</span></button>`).join('')}
        </div>`
      : `<p class="wall-shop__low">${icon('sparkles')}<span>${esc(t('wall.runningOut', { items: shop.runningOut.join(', ') }))}</span></p>`;
  }
  return `
    <section class="wall-card wall-shop" aria-labelledby="wall-shop-title">
      <h2 class="sr-only" id="wall-shop-title">${esc(t('today.shoppingTitle'))}</h2>
      ${shop.count > 0 ? `<p class="wall-shop__line"><span class="wall-shop__count">${esc(t('wall.onList', { n: shop.count }))}</span>${names}</p>` : ''}
      ${low}
    </section>`;
}

function renderQuestion(question, settled) {
  if (settled) {
    return `
      <section class="wall-card wall-question" aria-labelledby="wall-question-title">
        <h2 class="wall-card__label" id="wall-question-title">${esc(t('today.questionTitle'))}</h2>
        <p class="wall-question__text" role="status">${esc(settled)}</p>
      </section>`;
  }
  return `
    <section class="wall-card wall-question" aria-labelledby="wall-question-title">
      <h2 class="wall-card__label" id="wall-question-title">${esc(t('today.questionTitle'))}</h2>
      <p class="wall-question__text">${esc(question.question)}</p>
      <div class="wall-question__options" role="group" aria-label="${esc(t('today.questionAnswers'))}">
        ${question.options.map((option, index) => `<button type="button" class="wall-option" data-wall-answer="${index}">${esc(option)}</button>`).join('')}
        <button type="button" class="wall-option wall-option--plain" data-wall-skip aria-label="${esc(t('today.questionSkipAria'))}">${esc(t('ai.questionSkip'))}</button>
      </div>
    </section>`;
}

function renderStage(model, ui) {
  const household = model.household;
  const aside = [];
  if (model.question || ui.questionSettled) aside.push(renderQuestion(model.question, ui.questionSettled));
  if (model.dinner) aside.push(renderDinnerCard(model.dinner, household));
  if (model.tomorrow && model.scene === 'wieczor') aside.push(renderTomorrow(model.tomorrow, household));
  if (model.shopping) aside.push(renderShopping(model.shopping, model));

  if (model.hero) {
    const right = [model.plan ? renderPlan(model.plan, household) : '', ...aside].filter(Boolean);
    return `
      <div class="wall__stage" data-layout="${right.length ? 'hero' : 'hero-only'}">
        ${renderHero(model.hero, household)}
        ${right.length ? `<div class="wall__aside">${right.join('')}</div>` : ''}
      </div>`;
  }
  const plan = model.plan ? renderPlan(model.plan, household) : '';
  if (plan && aside.length) {
    return `<div class="wall__stage" data-layout="split">${plan}<div class="wall__aside">${aside.join('')}</div></div>`;
  }
  if (plan || aside.length) {
    return `<div class="wall__stage" data-layout="single">${plan || `<div class="wall__aside wall__aside--wide">${aside.join('')}</div>`}</div>`;
  }
  return '<div class="wall__stage" data-layout="empty"></div>';
}

// --------------------------------------------------------
// Dock
// --------------------------------------------------------

function renderDock(model, { timer, screensaverEnabled }) {
  const stale = model.stale != null
    ? `<p class="wall__stale" role="status">${icon('triangle-alert')}<span>${esc(t('wall.stale', { minutes: model.stale }))}</span></p>`
    : '';
  const saver = screensaverEnabled && !model.timer
    ? `<button type="button" class="wall-ghost wall-ghost--icon" id="wall-screensaver-start"
        aria-label="${esc(t('dashboard.wallScreensaverStart'))}" title="${esc(t('dashboard.wallScreensaverStart'))}">${icon('image')}</button>`
    : '';
  return `
    <footer class="wall__dock" data-toast-keepout>
      <div class="wall__dock-start">
        <button type="button" class="wall-ghost" id="wall-exit">
          ${icon('minimize-2')}<span>${esc(t('dashboard.wallExit'))}</span>
        </button>
        ${saver}
        ${stale}
      </div>
      ${model.timers || model.timer ? `<div class="wall__dock-end">${timer.controls}</div>` : ''}
    </footer>`;
}

// --------------------------------------------------------
// The surface
// --------------------------------------------------------

/**
 * The whole wall.
 *
 * @param {object} model buildWall()
 * @param {object} opts
 * @param {{time: string, machine: string}} opts.clock
 * @param {object|null} [opts.weather]
 * @param {Function} [opts.weatherIcon] (weather, icon, cls, size, desc) => markup
 * @param {boolean} [opts.screensaverEnabled]
 * @param {'loading'|'failed'|null} [opts.state]
 * @param {{questionSettled?: string|null}} [opts.ui]
 */
export function renderWall(model, {
  clock, weather = null, weatherIcon = () => '', screensaverEnabled = false, state = null, ui = {},
} = {}) {
  const timer = renderWallTimer(model.timer ?? { state: 'idle', remainingMs: 0 });
  let stage;
  if (state === 'failed') {
    stage = `
      <div class="wall__stage" data-layout="single">
        <section class="wall-card wall__error" role="status">
          ${icon('cloud-off', 'wall__error-icon')}
          <p class="wall__error-title">${esc(t('dashboard.wallOffline'))}</p>
          <p class="wall__error-sub">${esc(t('dashboard.wallOfflineHint'))}</p>
        </section>
      </div>`;
  } else if (state === 'loading') {
    stage = '<div class="wall__stage" data-layout="single"><div class="wall__loading" aria-hidden="true"></div></div>';
  } else if (model.scene === 'noc') {
    stage = '<div class="wall__stage" data-layout="night"></div>';
  } else {
    stage = renderStage(model, ui);
  }
  return `
    <div class="wall" id="wall-surface" tabindex="-1" role="region" aria-label="${esc(t('settings.wallModeLabel'))}"
         data-scene="${esc(model.scene)}"${model.timer ? ` data-timer="${esc(model.timer.state)}"` : ''}>
      ${renderHead(model, { clock, weather, weatherIcon, timer })}
      ${stage}
      ${renderDock(model, { timer, screensaverEnabled })}
    </div>`;
}

/** The chooser "Kto to zrobił?" for a display: one big button per person. */
export function renderWhoChooser(title, people, household = []) {
  return `
    <p class="wall-pick__title" id="wall-pick-title">${esc(t('tasks.doneByPick', { title }))}</p>
    <div class="wall-pick__people" role="group" aria-labelledby="wall-pick-title">
      ${people.map((p) => `<button type="button" class="wall-option wall-pick__person" data-wall-pick="${esc(String(p.id))}">
        ${wallPersonDisc(p, household, { label: false })}<span>${esc(p.display_name ?? '')}</span></button>`).join('')}
      <button type="button" class="wall-option wall-option--plain" data-wall-pick-cancel>${esc(t('common.cancel'))}</button>
    </div>`;
}

// --------------------------------------------------------
// The height budget
// --------------------------------------------------------

/**
 * Fits every Dziś list on the wall to the room its card has: rows that do not
 * fit are hidden and the last line says "+N więcej" (planWallRows). Measured,
 * not computed - row height follows the fluid wall type. On a phone the card
 * grows with its rows and nothing is hidden.
 * @returns {number} how many rows were hidden in total
 */
export function fitWallLists(root) {
  let hiddenTotal = 0;
  for (const list of root?.querySelectorAll?.('[data-wall-fit]') ?? []) {
    const rows = [...list.querySelectorAll('[data-wall-row]')];
    const more = list.querySelector('[data-wall-more]');
    for (const row of rows) row.hidden = false;
    if (more) more.hidden = true;
    const overflows = () => list.scrollHeight > list.clientHeight + 1;
    if (!rows.length || !overflows()) continue;
    const rowHeight = rows[0].getBoundingClientRect().height || 1;
    const fits = Math.max(1, Math.floor((list.clientHeight + 1) / rowHeight));
    const plan = planWallRows(rows.length, fits);
    rows.forEach((row, index) => { row.hidden = index >= plan.shown; });
    if (more && plan.more > 0) {
      more.hidden = false;
      const title = more.querySelector('.wall-row__title');
      if (title) title.textContent = t('dashboard.shoppingMore', { count: plan.more });
    }
    // Rounding can leave one row too many; take it back while it still spills.
    let shown = plan.shown;
    while (overflows() && shown > 1) {
      shown -= 1;
      rows[shown].hidden = true;
      if (more) {
        more.hidden = false;
        const title = more.querySelector('.wall-row__title');
        if (title) title.textContent = t('dashboard.shoppingMore', { count: rows.length - shown });
      }
    }
    hiddenTotal += rows.length - shown;
  }
  return hiddenTotal;
}
