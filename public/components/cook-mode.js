/**
 * Modul: Cook mode (Tafla, 2026-10-19: the dark stage)
 * Zweck: A full-screen kitchen view of one recipe, one step at a time, read
 *        from a step away and used with wet hands. Artboard "Gotowanie": the
 *        stage is #141311 in BOTH themes (no glare at the stove at night), the
 *        step number in rounded violet, the step text large with its timers as
 *        pills inside the sentence, "Do tego kroku" (the ingredients this step
 *        names), "Następnie" (the next step), a timer band with presets when
 *        idle, a five-segment progress bar and big tap zones: the left third of
 *        the stage goes back, the right two thirds go on. The end is
 *        "Smacznego!"; opened from the kitchen wall it returns to the wall by
 *        itself two minutes later.
 * Abhängigkeiten: /utils/cook-steps.js, /i18n.js, /utils/html.js, /api.js,
 *                 /utils/overlay-history.js
 *
 * Nothing here writes to the server. Timers and ticked ingredients live only as
 * long as the view is open. Entry points stay as they were: `openCookMode`
 * (recipe page) and `openCookForMeal` (Dziś, the wall).
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { splitSteps, formatTimer, stepSegments, stepIngredientIndexes } from '/utils/cook-steps.js';
import { attachOverlay } from '/utils/overlay-history.js';

const STYLE_HREF = '/styles/cook-mode.css';
/** The presets of the idle timer band, in minutes (as on the wall). */
export const COOK_TIMER_PRESETS = Object.freeze([3, 5, 10, 15]);
/** Opened from the wall, the end screen gives the wall back after this long. */
export const COOK_RETURN_MS = 2 * 60 * 1000;
/** The band shows at most this many timers; older ones wait behind. */
const BAND_TIMERS = 2;
/** The ring of a running timer: radius 33 in a 72 box, stroke 6. */
const RING_R = 33;
const RING_C = 2 * Math.PI * RING_R;

/** Replaces an element's content with markup whose data went through esc(). */
function setHtml(el, html) {
  el.replaceChildren();
  el.insertAdjacentHTML('beforeend', html);
}

function icon(name, cls = '') {
  return `<i data-lucide="${esc(name)}"${cls ? ` class="${esc(cls)}"` : ''} aria-hidden="true"></i>`;
}

function ensureStyle() {
  if (document.querySelector(`link[href="${STYLE_HREF}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = STYLE_HREF;
  document.head.append(link);
}

/** A short beep pattern; the AudioContext is created from a tap, so iOS lets it play. */
function makeAlarm() {
  let ctx = null;
  return {
    unlock() {
      try {
        ctx ??= new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
      } catch { ctx = null; }
    },
    ring() {
      try { navigator.vibrate?.([300, 150, 300, 150, 300]); } catch { /* no vibration */ }
      if (!ctx) return;
      const start = ctx.currentTime;
      for (let i = 0; i < 6; i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = i % 2 ? 660 : 880;
        gain.gain.setValueAtTime(0.0001, start + i * 0.35);
        gain.gain.exponentialRampToValueAtTime(0.4, start + i * 0.35 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + i * 0.35 + 0.3);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start + i * 0.35);
        osc.stop(start + i * 0.35 + 0.32);
      }
    },
    close() { try { ctx?.close(); } catch { /* already closed */ } },
  };
}

/** "Passata 500 ml" - the name with a capital, then the amount. */
function ingredientLabel(ing) {
  const name = String(ing?.name ?? '').trim();
  const head = name ? name[0].toLocaleUpperCase() + name.slice(1) : '';
  return [head, ing?.quantity ? String(ing.quantity).trim() : ''].filter(Boolean).join(' ');
}

/** The progress segments: one per step, filled up to the current one. */
export function progressMarkup(stepIdx, total) {
  if (total <= 0) return '';
  const segments = Array.from({ length: total }, (_, i) => `<span class="cook__seg${i <= stepIdx ? ' cook__seg--done' : ''}"></span>`).join('');
  return `<span class="cook__progress" aria-hidden="true">${segments}</span>`;
}

/** The step text with each duration as a start pill inside the sentence. */
export function stepTextMarkup(step, n = 0) {
  // The running timer is named after its step ("Krok 3"): the countdown
  // already says how long, the name says what it is for.
  const label = (timer) => (n ? t('cook.stepTimer', { n }) : timer.label);
  return stepSegments(step).map((part) => (part.timer
    ? `<button type="button" class="cook__inline-timer" data-cook-timer="${part.timer.seconds}" data-cook-label="${esc(label(part.timer))}"
        aria-label="${esc(t('cook.startTimer', { label: part.timer.label }))}">${icon('play')}<span>${esc(part.timer.label)}</span></button>`
    : esc(part.text))).join('');
}

/**
 * Opens cook mode.
 * @param {object} recipe
 * @param {string} recipe.title
 * @param {{name: string, quantity?: string|null}[]} [recipe.ingredients]
 * @param {string} [recipe.notes] - free-text instructions
 * @param {{wall?: boolean}} [options] opened from the kitchen wall: the end
 *        screen says "Wróć do ściany" and closes itself after two minutes.
 * @returns {() => void} close function
 */
export function openCookMode({ title, ingredients = [], notes = '' }, { wall = false } = {}) {
  ensureStyle();
  const steps = splitSteps(notes);
  const opener = document.activeElement;
  const alarm = makeAlarm();
  const timers = []; // { id, label, endsAt, total, done }
  const ticked = new Set();
  let stepIdx = 0;
  let ended = false;
  let showAll = false;
  let wakeLock = null;
  let tickHandle = null;
  let returnHandle = null;
  let closed = false;

  // A native <dialog> in the top layer: it opens above any modal underneath
  // (the recipe sheet is one), which no z-index could promise.
  const root = document.createElement('dialog');
  root.className = 'cook';
  root.setAttribute('aria-label', t('cook.title', { title }));
  setHtml(root, `
    <header class="cook__top">
      <div class="cook__top-start">
        <button type="button" class="cook__pill" data-cook-close aria-label="${esc(t('cook.close'))}">
          ${icon('x')}<span>${esc(t('cook.finish'))}</span>
        </button>
      </div>
      <div class="cook__top-mid">
        <p class="cook__heading"><span class="cook__heading-title">${esc(title)}</span><span class="cook__heading-step"></span></p>
        <span class="cook__progress-slot"></span>
      </div>
      <div class="cook__top-end"></div>
    </header>
    <main class="cook__main">
      <section class="cook__panel" aria-labelledby="cook-panel-title"></section>
      <section class="cook__stage" aria-live="polite"></section>
    </main>
    <footer class="cook__bottom">
      <section class="cook__band" aria-label="${esc(t('cook.timers'))}"></section>
      <nav class="cook__nav" aria-label="${esc(t('cook.stepsNav'))}">
        <button type="button" class="cook__back" data-nav="prev" aria-label="${esc(t('cook.prev'))}">${icon('chevron-left')}</button>
        <button type="button" class="cook__next" data-nav="next"><span></span>${icon('chevron-right')}</button>
      </nav>
    </footer>
    <section class="cook__end" hidden aria-live="polite"></section>`);

  const panelEl = root.querySelector('.cook__panel');
  const stageEl = root.querySelector('.cook__stage');
  const bandEl = root.querySelector('.cook__band');
  const headingStep = root.querySelector('.cook__heading-step');
  const progressSlot = root.querySelector('.cook__progress-slot');
  const prevBtn = root.querySelector('[data-nav="prev"]');
  const nextBtn = root.querySelector('[data-nav="next"]');
  const endEl = root.querySelector('.cook__end');

  function renderPanel() {
    const forStep = steps.length ? stepIngredientIndexes(steps[stepIdx], ingredients) : [];
    // Without a match (a step that names nothing, or no steps at all) the
    // panel lists everything - an empty "Do tego kroku" would read as broken.
    const all = showAll || !forStep.length;
    const indexes = all ? ingredients.map((_, i) => i) : forStep;
    const rows = indexes.map((i) => {
      const on = ticked.has(i);
      return `<li><button type="button" class="cook__ing" data-cook-ing="${i}" aria-pressed="${on ? 'true' : 'false'}">
        <span class="cook__ring">${icon('check')}</span><span class="cook__ing-name">${esc(ingredientLabel(ingredients[i]))}</span></button></li>`;
    }).join('');
    const switcher = forStep.length && ingredients.length > forStep.length
      ? `<button type="button" class="cook__panel-more" data-cook-all>${esc(showAll
        ? t('cook.stepIngredients')
        : t('cook.allIngredients', { n: ingredients.length }))}<span aria-hidden="true">›</span></button>`
      : '';
    setHtml(panelEl, `
      <h2 class="cook__label" id="cook-panel-title">${esc(all ? t('cook.ingredients') : t('cook.forStep'))}</h2>
      ${ingredients.length ? `<ul class="cook__ings">${rows}</ul>` : `<p class="cook__muted">${esc(t('cook.noIngredients'))}</p>`}
      ${switcher ? `<div class="cook__panel-foot">${switcher}</div>` : ''}`);
    window.lucide?.createIcons({ el: panelEl });
  }

  function renderStep() {
    if (!steps.length) {
      setHtml(stageEl, `<p class="cook__step-text">${esc(t('cook.noSteps'))}</p>`);
      headingStep.textContent = '';
      setHtml(progressSlot, '');
      prevBtn.disabled = true;
      nextBtn.querySelector('span').textContent = t('cook.done');
      renderPanel();
      return;
    }
    const step = steps[stepIdx];
    const next = steps[stepIdx + 1];
    setHtml(stageEl, `
      <p class="cook__num u-rounded" aria-hidden="true">${stepIdx + 1}</p>
      <p class="cook__step-text"><span class="sr-only">${esc(t('cook.stepOf', { n: stepIdx + 1, total: steps.length }))}: </span>${stepTextMarkup(step, stepIdx + 1)}</p>
      ${next ? `<p class="cook__then"><span class="cook__then-label">${esc(t('cook.upNext'))}</span> ${esc(next)}</p>` : ''}`);
    headingStep.textContent = ` · ${t('cook.stepOf', { n: stepIdx + 1, total: steps.length })}`;
    setHtml(progressSlot, progressMarkup(stepIdx, steps.length));
    prevBtn.disabled = stepIdx === 0;
    nextBtn.querySelector('span').textContent = stepIdx + 1 < steps.length ? t('cook.next') : t('cook.done');
    window.lucide?.createIcons({ el: stageEl });
    renderPanel();
  }

  function renderBand() {
    const now = Date.now();
    const shown = timers.slice(-BAND_TIMERS);
    if (!shown.length) {
      setHtml(bandEl, `
        <div class="cook__presets" role="group" aria-labelledby="cook-presets-label">
          <span class="cook__label" id="cook-presets-label">${esc(t('dashboard.wallTimerLabel'))}</span>
          ${COOK_TIMER_PRESETS.map((m) => `<button type="button" class="cook__preset" data-cook-timer="${m * 60}" data-cook-label="${esc(t('cook.presetTimer', { n: m }))}"
              aria-label="${esc(t('cook.startTimer', { label: t('cook.presetTimer', { n: m }) }))}">
              <span class="cook__preset-num u-rounded">${m}</span><span class="cook__preset-unit">${esc(t('wall.minutesShort'))}</span></button>`).join('')}
        </div>`);
      return;
    }
    setHtml(bandEl, shown.map((tm, i) => {
      if (tm.done) {
        return `${i ? '<span class="cook__band-rule" aria-hidden="true"></span>' : ''}
          <button type="button" class="cook__timer cook__timer--done" data-cook-dismiss="${esc(tm.id)}"
            aria-label="${esc(t('cook.timerDoneAria', { label: tm.label }))}">${esc(t('cook.timerReady', { label: tm.label }))}</button>`;
      }
      const left = Math.max(0, Math.round((tm.endsAt - now) / 1000));
      const share = tm.total > 0 ? Math.min(1, left / tm.total) : 0;
      return `${i ? '<span class="cook__band-rule" aria-hidden="true"></span>' : ''}
        <div class="cook__timer" data-cook-running="${esc(tm.id)}">
          <svg class="cook__timer-ring" viewBox="0 0 72 72" aria-hidden="true">
            <circle class="cook__timer-track" cx="36" cy="36" r="${RING_R}"></circle>
            <circle class="cook__timer-arc" cx="36" cy="36" r="${RING_R}" transform="rotate(-90 36 36)"
              stroke-dasharray="${(share * RING_C).toFixed(1)} ${RING_C.toFixed(1)}"></circle>
          </svg>
          <span class="cook__timer-text">
            <span class="cook__timer-label">${esc(tm.label)}</span>
            <span class="cook__timer-left u-rounded" role="timer">${esc(formatTimer(left))}</span>
          </span>
          <button type="button" class="cook__pill cook__pill--small" data-cook-plus="${esc(tm.id)}"
            aria-label="${esc(t('cook.addMinuteAria', { label: tm.label }))}">${esc(t('cook.addMinute'))}</button>
          <button type="button" class="cook__plain" data-cook-stop="${esc(tm.id)}"
            aria-label="${esc(t('cook.stopAria', { label: tm.label }))}">${esc(t('cook.stop'))}</button>
        </div>`;
    }).join(''));
  }

  /** The second tick touches only the numbers and rings, not the band's markup. */
  function tick() {
    const now = Date.now();
    let rang = false;
    for (const tm of timers) {
      if (!tm.done && tm.endsAt <= now) { tm.done = true; rang = true; }
    }
    if (rang) {
      alarm.ring();
      renderBand();
      return;
    }
    for (const tm of timers) {
      const el = bandEl.querySelector(`[data-cook-running="${CSS.escape(tm.id)}"]`);
      if (!el) continue;
      const left = Math.max(0, Math.round((tm.endsAt - now) / 1000));
      el.querySelector('.cook__timer-left').textContent = formatTimer(left);
      const share = tm.total > 0 ? Math.min(1, left / tm.total) : 0;
      el.querySelector('.cook__timer-arc')?.setAttribute('stroke-dasharray', `${(share * RING_C).toFixed(1)} ${RING_C.toFixed(1)}`);
    }
    if (!timers.length) { clearInterval(tickHandle); tickHandle = null; }
  }

  function startTimer(seconds, label) {
    alarm.unlock();
    timers.push({ id: `${Date.now()}-${timers.length}`, label, endsAt: Date.now() + seconds * 1000, total: seconds, done: false });
    tickHandle ??= setInterval(tick, 1000);
    renderBand();
  }

  function removeTimer(id) {
    const idx = timers.findIndex((tm) => tm.id === id);
    if (idx >= 0) timers.splice(idx, 1);
    renderBand();
  }

  function showEnd() {
    ended = true;
    root.classList.add('cook--ended');
    setHtml(endEl, `
      <p class="cook__end-title u-rounded">${esc(t('cook.enjoy'))}</p>
      <p class="cook__end-sub">${esc(title)}</p>
      <div class="cook__end-actions">
        <button type="button" class="cook__next cook__next--end" data-cook-close>${esc(wall ? t('cook.backToWall') : t('cook.finish'))}</button>
        <button type="button" class="cook__plain" data-cook-resume>${esc(t('cook.backToSteps'))}</button>
      </div>
      ${wall ? `<p class="cook__end-note">${esc(t('cook.autoReturn'))}</p>` : ''}`);
    endEl.hidden = false;
    endEl.querySelector('[data-cook-close]')?.focus();
    // Opened from the wall: the wall comes back by itself (Tafla, Gotowanie).
    if (wall) returnHandle = setTimeout(close, COOK_RETURN_MS);
  }

  function resume() {
    ended = false;
    clearTimeout(returnHandle);
    returnHandle = null;
    root.classList.remove('cook--ended');
    endEl.hidden = true;
    nextBtn.focus();
  }

  function go(delta) {
    if (ended) return;
    if (delta > 0 && (!steps.length || stepIdx + 1 >= steps.length)) { showEnd(); return; }
    const before = stepIdx;
    stepIdx = Math.min(Math.max(steps.length - 1, 0), Math.max(0, stepIdx + delta));
    if (before !== stepIdx) {
      showAll = false;
      renderStep();
    }
  }

  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen');
    } catch { wakeLock = null; }
  }
  const onVisible = () => { if (!closed && document.visibilityState === 'visible') keepAwake(); };

  function onKey(e) {
    // Escape closes cook mode only; the wall underneath also listens for it.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
  }

  root.addEventListener('click', (e) => {
    const target = e.target;
    if (target.closest('[data-cook-close]')) { close(); return; }
    if (target.closest('[data-cook-resume]')) { resume(); return; }
    const ing = target.closest('[data-cook-ing]');
    if (ing) {
      const idx = Number(ing.dataset.cookIng);
      if (ticked.has(idx)) ticked.delete(idx); else ticked.add(idx);
      ing.setAttribute('aria-pressed', String(ticked.has(idx)));
      return;
    }
    if (target.closest('[data-cook-all]')) { showAll = !showAll; renderPanel(); return; }
    const start = target.closest('[data-cook-timer]');
    if (start) { startTimer(Number(start.dataset.cookTimer), start.dataset.cookLabel); return; }
    const plus = target.closest('[data-cook-plus]');
    if (plus) {
      const tm = timers.find((x) => x.id === plus.dataset.cookPlus);
      if (tm) { tm.endsAt += 60_000; tm.total += 60; tick(); }
      return;
    }
    const stop = target.closest('[data-cook-stop]');
    if (stop) { removeTimer(stop.dataset.cookStop); return; }
    const dismiss = target.closest('[data-cook-dismiss]');
    if (dismiss) { removeTimer(dismiss.dataset.cookDismiss); return; }
    const nav = target.closest('[data-nav]');
    if (nav) { go(nav.dataset.nav === 'next' ? 1 : -1); return; }
    // THE TAP ZONES (Tafla): a tap anywhere on the step that is not a button -
    // the left third goes back, the right two thirds go on. Wet hands hit a
    // big area, not a button.
    if (target.closest('.cook__stage') && !target.closest('button')) {
      const box = stageEl.getBoundingClientRect();
      go(e.clientX < box.left + box.width / 3 ? -1 : 1);
    }
  });

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(tickHandle);
    clearTimeout(returnHandle);
    alarm.close();
    try { wakeLock?.release(); } catch { /* released already */ }
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onVisible);
    document.documentElement.classList.remove('cook-mode-open');
    try { root.close(); } catch { /* not open */ }
    root.remove();
    opener?.focus?.();
  }

  document.body.append(root);
  root.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  root.showModal();
  // The back swipe closes cook mode instead of changing the page underneath (#871).
  attachOverlay(root, close);
  document.documentElement.classList.add('cook-mode-open');
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('visibilitychange', onVisible);
  renderStep();
  renderBand();
  window.lucide?.createIcons({ el: root });
  nextBtn.focus();
  keepAwake();
  return close;
}

/**
 * Cook mode for a planned meal: its recipe when it has one, otherwise the meal's
 * own ingredients and notes. Used by Dziś and the kitchen wall.
 * @param {{mealId?: string|number, recipeId?: string|number, date?: string}} ref
 * @param {{wall?: boolean}} [options] see openCookMode
 */
export async function openCookForMeal({ mealId, recipeId, date }, options = {}) {
  if (recipeId) {
    const res = await api.get('/recipes');
    const recipe = (res.data ?? []).find((r) => String(r.id) === String(recipeId));
    if (recipe) return openCookMode({ title: recipe.title, ingredients: recipe.ingredients ?? [], notes: recipe.notes ?? '' }, options);
  }
  const res = await api.get(`/meals?week=${encodeURIComponent(date || '')}`);
  const meal = (res.data ?? []).find((m) => String(m.id) === String(mealId));
  if (!meal) throw new Error('meal not found');
  return openCookMode({ title: meal.title, ingredients: meal.ingredients ?? [], notes: meal.notes ?? '' }, options);
}
