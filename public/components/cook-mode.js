/**
 * Modul: Cook mode
 * Zweck: A full-screen kitchen view of one recipe: the ingredients as a
 *        checklist, one step at a time in large type, timers taken from the
 *        step text, and the screen kept awake. Built for the kitchen iPad and
 *        usable with wet hands: big targets, swipe or tap to move between steps.
 * Abhängigkeiten: /utils/cook-steps.js, /i18n.js, /utils/html.js
 *
 * Nothing here writes to the server. Timers and ticked ingredients live only as
 * long as the view is open.
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { splitSteps, findTimers, formatTimer } from '/utils/cook-steps.js';
import { attachOverlay } from '/utils/overlay-history.js';

const STYLE_HREF = '/styles/cook-mode.css';

/** Replaces an element's content with markup whose data went through esc(). */
function setHtml(el, html) {
  el.replaceChildren();
  el.insertAdjacentHTML('beforeend', html);
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

/**
 * Opens cook mode.
 * @param {object} recipe
 * @param {string} recipe.title
 * @param {{name: string, quantity?: string|null}[]} [recipe.ingredients]
 * @param {string} [recipe.notes] - free-text instructions
 * @returns {() => void} close function
 */
export function openCookMode({ title, ingredients = [], notes = '' }) {
  ensureStyle();
  const steps = splitSteps(notes);
  const opener = document.activeElement;
  const alarm = makeAlarm();
  const timers = []; // { id, label, endsAt, done }
  let stepIdx = 0;
  let wakeLock = null;
  let tickHandle = null;
  let closed = false;

  // A native <dialog> in the top layer: it opens above any modal underneath
  // (the recipe sheet is one), which no z-index could promise.
  const root = document.createElement('dialog');
  root.className = 'cook-mode';
  root.setAttribute('aria-label', t('cook.title', { title }));
  setHtml(root, `
    <header class="cook-mode__head">
      <div class="cook-mode__titles">
        <span class="cook-mode__eyebrow">${esc(t('cook.eyebrow'))}</span>
        <h2 class="cook-mode__title">${esc(title)}</h2>
      </div>
      <div class="cook-mode__timers" aria-live="polite"></div>
      <button type="button" class="cook-mode__close" aria-label="${esc(t('cook.close'))}">
        <i data-lucide="x" aria-hidden="true"></i>
      </button>
    </header>
    <div class="cook-mode__body">
      <aside class="cook-mode__ingredients" aria-label="${esc(t('cook.ingredients'))}">
        <h3>${esc(t('cook.ingredients'))}</h3>
        ${ingredients.length ? `<ul>${ingredients.map((ing, i) => `
          <li><button type="button" class="cook-mode__ing" data-idx="${i}" aria-pressed="false">
            <span class="cook-mode__ing-name">${esc(ing.name)}</span>
            ${ing.quantity ? `<span class="cook-mode__ing-qty">${esc(ing.quantity)}</span>` : ''}
          </button></li>`).join('')}</ul>` : `<p class="cook-mode__muted">${esc(t('cook.noIngredients'))}</p>`}
      </aside>
      <section class="cook-mode__steps" aria-live="polite"></section>
    </div>
    <footer class="cook-mode__nav">
      <button type="button" class="cook-mode__navbtn" data-nav="prev">
        <i data-lucide="arrow-left" aria-hidden="true"></i><span>${esc(t('cook.prev'))}</span>
      </button>
      <span class="cook-mode__counter"></span>
      <button type="button" class="cook-mode__navbtn cook-mode__navbtn--primary" data-nav="next">
        <span>${esc(t('cook.next'))}</span><i data-lucide="arrow-right" aria-hidden="true"></i>
      </button>
    </footer>`);

  const stepsEl = root.querySelector('.cook-mode__steps');
  const counterEl = root.querySelector('.cook-mode__counter');
  const timersEl = root.querySelector('.cook-mode__timers');
  const prevBtn = root.querySelector('[data-nav="prev"]');
  const nextBtn = root.querySelector('[data-nav="next"]');

  function renderStep() {
    if (!steps.length) {
      setHtml(stepsEl, `<p class="cook-mode__muted">${esc(t('cook.noSteps'))}</p>`);
      counterEl.textContent = '';
      prevBtn.hidden = true;
      nextBtn.hidden = true;
      return;
    }
    const step = steps[stepIdx];
    const found = findTimers(step);
    setHtml(stepsEl, `
      <p class="cook-mode__stepno">${esc(t('cook.stepOf', { n: stepIdx + 1, total: steps.length }))}</p>
      <p class="cook-mode__step">${esc(step)}</p>
      ${found.length ? `<div class="cook-mode__timer-chips">${found.map((tm) => `
        <button type="button" class="cook-mode__timer-chip" data-seconds="${tm.seconds}" data-label="${esc(tm.label)}">
          <i data-lucide="timer" aria-hidden="true"></i>${esc(t('cook.startTimer', { label: tm.label }))}
        </button>`).join('')}</div>` : ''}
      ${stepIdx + 1 < steps.length ? `<p class="cook-mode__upnext"><span>${esc(t('cook.upNext'))}</span> ${esc(steps[stepIdx + 1])}</p>` : ''}`);
    counterEl.textContent = `${stepIdx + 1} / ${steps.length}`;
    prevBtn.disabled = stepIdx === 0;
    nextBtn.hidden = false;
    nextBtn.querySelector('span').textContent = stepIdx + 1 < steps.length ? t('cook.next') : t('cook.done');
    window.lucide?.createIcons({ el: stepsEl });
  }

  function renderTimers() {
    const now = Date.now();
    setHtml(timersEl, timers.map((tm) => {
      const left = Math.max(0, Math.round((tm.endsAt - now) / 1000));
      return `<button type="button" class="cook-mode__timer${tm.done ? ' cook-mode__timer--done' : ''}" data-timer="${tm.id}"
        aria-label="${esc(tm.done ? t('cook.timerDoneAria', { label: tm.label }) : t('cook.timerAria', { label: tm.label, left: formatTimer(left) }))}">
        <i data-lucide="${tm.done ? 'bell-ring' : 'timer'}" aria-hidden="true"></i>
        <span>${tm.done ? esc(t('cook.timerDone')) : formatTimer(left)}</span>
        <small>${esc(tm.label)}</small>
      </button>`;
    }).join(''));
    window.lucide?.createIcons({ el: timersEl });
  }

  function tick() {
    const now = Date.now();
    let rang = false;
    for (const tm of timers) {
      if (!tm.done && tm.endsAt <= now) { tm.done = true; rang = true; }
    }
    if (rang) alarm.ring();
    renderTimers();
  }

  function startTimer(seconds, label) {
    alarm.unlock();
    timers.push({ id: `${Date.now()}-${timers.length}`, label, endsAt: Date.now() + seconds * 1000, done: false });
    tickHandle ??= setInterval(tick, 1000);
    renderTimers();
  }

  function go(delta) {
    if (!steps.length) return;
    if (delta > 0 && stepIdx + 1 >= steps.length) { close(); return; }
    stepIdx = Math.min(steps.length - 1, Math.max(0, stepIdx + delta));
    renderStep();
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

  let touchX = null;
  root.addEventListener('touchstart', (e) => { touchX = e.touches[0]?.clientX ?? null; }, { passive: true });
  root.addEventListener('touchend', (e) => {
    if (touchX == null) return;
    const dx = (e.changedTouches[0]?.clientX ?? touchX) - touchX;
    touchX = null;
    if (Math.abs(dx) > 70 && !e.target.closest('.cook-mode__ingredients')) go(dx < 0 ? 1 : -1);
  });

  root.addEventListener('click', (e) => {
    const ing = e.target.closest('.cook-mode__ing');
    if (ing) {
      const on = ing.getAttribute('aria-pressed') !== 'true';
      ing.setAttribute('aria-pressed', String(on));
      return;
    }
    const chip = e.target.closest('.cook-mode__timer-chip');
    if (chip) { startTimer(Number(chip.dataset.seconds), chip.dataset.label); return; }
    const timer = e.target.closest('.cook-mode__timer');
    if (timer) {
      // Tapping a finished timer clears it; tapping a running one cancels it.
      const idx = timers.findIndex((tm) => tm.id === timer.dataset.timer);
      if (idx >= 0) timers.splice(idx, 1);
      renderTimers();
      return;
    }
    const nav = e.target.closest('[data-nav]');
    if (nav) go(nav.dataset.nav === 'next' ? 1 : -1);
    if (e.target.closest('.cook-mode__close')) close();
  });

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(tickHandle);
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
  renderTimers();
  window.lucide?.createIcons({ el: root });
  root.querySelector('.cook-mode__close').focus();
  keepAwake();
  return close;
}

/**
 * Cook mode for a planned meal: its recipe when it has one, otherwise the meal's
 * own ingredients and notes. Used by the kitchen wall.
 * @param {{mealId?: string|number, recipeId?: string|number, date?: string}} ref
 */
export async function openCookForMeal({ mealId, recipeId, date }) {
  if (recipeId) {
    const res = await api.get('/recipes');
    const recipe = (res.data ?? []).find((r) => String(r.id) === String(recipeId));
    if (recipe) return openCookMode({ title: recipe.title, ingredients: recipe.ingredients ?? [], notes: recipe.notes ?? '' });
  }
  const res = await api.get(`/meals?week=${encodeURIComponent(date || '')}`);
  const meal = (res.data ?? []).find((m) => String(m.id) === String(mealId));
  if (!meal) throw new Error('meal not found');
  return openCookMode({ title: meal.title, ingredients: meal.ingredients ?? [], notes: meal.notes ?? '' });
}
