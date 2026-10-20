/**
 * Modul: Dostosuj Dziś - the customise sheet (Tafla, 2026-10-19)
 * Zweck: What the start page shows and in which order. "Teraz" and "Plan dnia"
 *        always stay; the sections below them (Zakupy, Jutro, Pytanie
 *        tygodnia, Wkrótce) and the optional extras (Budżet, Notatki ...) can
 *        be switched off and reordered. Replaces the widget board's
 *        customise mode; it writes the same per-person layout
 *        (`dashboard_widgets`), so nothing anybody arranged is lost.
 * Abhängigkeiten: /i18n.js, /utils/html.js, /components/modal.js
 *
 * EVERY CHANGE APPLIES AT ONCE, like an iOS settings sheet: a switch or a move
 * goes to the page (`onChange`), which saves it and redraws Dziś behind the
 * sheet. "Gotowe" only closes - there is no unsaved state to lose and no
 * second "Anuluj".
 *
 * REORDER: drag the grip (pointer events, so a finger works too) or focus it
 * and use the arrow keys; the new place is announced.
 */

import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { openModal, closeModal } from '/components/modal.js';

function icon(name) {
  return `<i data-lucide="${esc(name)}" aria-hidden="true"></i>`;
}

function switchButton({ id, label, checked }) {
  return `<button type="button" class="day-switch" role="switch" aria-checked="${checked ? 'true' : 'false'}"
      aria-label="${esc(label)}" data-switch="${esc(id)}"><span class="day-switch__track"><span class="day-switch__knob"></span></span></button>`;
}

function sectionRow(item) {
  return `
    <li class="day-sheet__row" data-section-id="${esc(item.id)}">
      <button type="button" class="day-sheet__grip" data-grip aria-label="${esc(t('today.reorderAria', { name: item.label }))}"
        aria-describedby="day-sheet-reorder-hint">${icon('grip-vertical')}</button>
      <span class="day-sheet__name">
        <span class="day-sheet__title">${esc(item.label)}</span>
        ${item.note ? `<span class="day-sheet__note">${esc(item.note)}</span>` : ''}
      </span>
      ${switchButton({ id: item.id, label: item.label, checked: item.visible })}
    </li>`;
}

function fixedRow(label) {
  return `
    <li class="day-sheet__row">
      <span class="day-sheet__spacer" aria-hidden="true"></span>
      <span class="day-sheet__name"><span class="day-sheet__title">${esc(label)}</span></span>
      <span class="day-sheet__value">${esc(t('today.always'))}</span>
    </li>`;
}

function actionRow({ action, label, glyph }) {
  return `
    <li class="day-sheet__row">
      <button type="button" class="day-sheet__action" data-sheet-action="${esc(action)}">
        <span class="day-sheet__glyph" aria-hidden="true">${icon(glyph)}</span>
        <span class="day-sheet__title">${esc(label)}</span>
        <span class="day-sheet__chevron" aria-hidden="true">${icon('chevron-right')}</span>
      </button>
    </li>`;
}

/**
 * @param {object} opts
 * @param {{id: string, label: string, visible: boolean, note?: string}[]} opts.sections in their order
 * @param {{visible: boolean}|null} opts.weather the header weather switch, null when there is no weather
 * @param {(next: {order: string[], visible: Record<string, boolean>}) => void} opts.onChange
 * @param {{ canPublish?: boolean, followsDefault?: boolean, onPublish?: Function, onReset?: Function, onWall?: Function,
 *           filters?: string[], onFilter?: (id: string) => void }} [opts.actions]
 */
export function openTodayCustomize({ sections, weather, onChange, actions = {} }) {
  let order = sections.map((s) => s.id);
  const visible = Object.fromEntries(sections.map((s) => [s.id, Boolean(s.visible)]));
  if (weather) visible['today-weather'] = Boolean(weather.visible);
  const byId = new Map(sections.map((s) => [s.id, s]));

  const emit = () => onChange?.({ order: [...order], visible: { ...visible } });

  const filterLabels = { tasks: t('today.customizeFilterTasks'), calendar: t('today.customizeFilterCalendar') };
  const filterGlyphs = { tasks: 'list-filter', calendar: 'calendar-search' };
  const advanced = [
    ...(actions.onFilter ? (actions.filters ?? []) : []).map((id) => actionRow({ action: `filter:${id}`, label: filterLabels[id] ?? id, glyph: filterGlyphs[id] ?? 'filter' })),
    actions.canPublish ? actionRow({ action: 'publish', label: t('today.customizePublish'), glyph: 'users' }) : '',
    actions.followsDefault === false ? actionRow({ action: 'reset', label: t('today.customizeReset'), glyph: 'rotate-ccw' }) : '',
    actions.onWall ? actionRow({ action: 'wall', label: t('dashboard.wallEnter'), glyph: 'maximize-2' }) : '',
  ].filter(Boolean).join('');

  const content = `
    <div class="day-sheet">
      <p class="day-sheet__hint">${esc(t('today.customizeHint'))}</p>
      <section class="day-sheet__group" aria-labelledby="day-sheet-always">
        <h3 class="day-sheet__heading" id="day-sheet-always">${esc(t('today.customizeAlways'))}</h3>
        <ul class="day-sheet__card">
          ${fixedRow(t('today.nowLabel'))}
          ${fixedRow(t('today.planTitle'))}
        </ul>
        <p class="day-sheet__footnote">${esc(t('today.customizePeopleNote'))}</p>
      </section>
      <section class="day-sheet__group" aria-labelledby="day-sheet-sections">
        <h3 class="day-sheet__heading" id="day-sheet-sections">${esc(t('today.customizeSections'))}</h3>
        <ul class="day-sheet__card" data-section-list>
          ${order.map((id) => sectionRow({ ...byId.get(id), visible: visible[id] })).join('')}
        </ul>
        <p class="day-sheet__footnote" id="day-sheet-reorder-hint">${esc(t('today.reorderHint'))}</p>
      </section>
      ${weather ? `
      <section class="day-sheet__group" aria-label="${esc(t('today.customizeWeather'))}">
        <ul class="day-sheet__card">
          <li class="day-sheet__row">
            <span class="day-sheet__glyph" aria-hidden="true">${icon('cloud')}</span>
            <span class="day-sheet__name"><span class="day-sheet__title">${esc(t('today.customizeWeather'))}</span></span>
            ${switchButton({ id: 'today-weather', label: t('today.customizeWeather'), checked: visible['today-weather'] })}
          </li>
        </ul>
      </section>` : ''}
      ${advanced ? `
      <section class="day-sheet__group" aria-labelledby="day-sheet-more">
        <h3 class="day-sheet__heading" id="day-sheet-more">${esc(t('today.customizeMore'))}</h3>
        <ul class="day-sheet__card">${advanced}</ul>
      </section>` : ''}
      <p class="day-sheet__live sr-only" aria-live="polite" data-sheet-live></p>
    </div>`;

  openModal({
    title: t('today.customize'),
    content,
    size: 'md',
    dirtyGuard: false,
    initialFocus: 'none',
    headerAction: { label: t('today.customizeDone'), onClick: () => closeModal() },
    onSave: (panel) => wireSheet(panel),
  });

  function announce(panel, text) {
    const live = panel.querySelector('[data-sheet-live]');
    if (live) live.textContent = text;
  }

  // The neighbour moves, never the row itself: the grip under the finger (or
  // the keyboard focus) stays in the document and keeps its pointer capture.
  function move(panel, id, delta) {
    const from = order.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) return false;
    order.splice(to, 0, ...order.splice(from, 1));
    const row = panel.querySelector(`[data-section-list] [data-section-id="${CSS.escape(id)}"]`);
    const list = row?.parentElement;
    if (row && list) {
      if (delta < 0 && row.previousElementSibling) list.insertBefore(row.previousElementSibling, row.nextElementSibling);
      if (delta > 0 && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
    }
    announce(panel, t('today.reorderDone', { name: byId.get(id)?.label ?? id, position: to + 1, total: order.length }));
    emit();
    return true;
  }

  function wireSheet(panel) {
    panel.addEventListener('click', (event) => {
      const sw = event.target.closest('[data-switch]');
      if (sw) {
        const id = sw.dataset.switch;
        visible[id] = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', visible[id] ? 'true' : 'false');
        emit();
        return;
      }
      const action = event.target.closest('[data-sheet-action]')?.dataset.sheetAction;
      if (action === 'publish') actions.onPublish?.();
      if (action === 'reset') actions.onReset?.();
      if (action === 'wall') { closeModal({ force: true }); actions.onWall?.(); }
      if (action?.startsWith('filter:')) actions.onFilter?.(action.slice('filter:'.length));
    });

    panel.addEventListener('keydown', (event) => {
      const grip = event.target.closest?.('[data-grip]');
      if (!grip || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      event.preventDefault();
      const id = grip.closest('[data-section-id]')?.dataset.sectionId;
      move(panel, id, event.key === 'ArrowUp' ? -1 : 1);
    });

    // Drag by the grip: the row follows the finger and swaps with a neighbour
    // once it passes that neighbour's middle.
    panel.addEventListener('pointerdown', (event) => {
      const grip = event.target.closest?.('[data-grip]');
      if (!grip || event.button > 0) return;
      const row = grip.closest('[data-section-id]');
      const list = row?.parentElement;
      if (!row || !list) return;
      event.preventDefault();
      grip.setPointerCapture?.(event.pointerId);
      row.classList.add('day-sheet__row--dragging');
      const id = row.dataset.sectionId;
      const onMove = (e) => {
        const prev = row.previousElementSibling;
        const next = row.nextElementSibling;
        if (prev) {
          const r = prev.getBoundingClientRect();
          if (e.clientY < r.top + r.height / 2) { move(panel, id, -1); return; }
        }
        if (next) {
          const r = next.getBoundingClientRect();
          if (e.clientY > r.top + r.height / 2) move(panel, id, 1);
        }
      };
      const onUp = () => {
        row.classList.remove('day-sheet__row--dragging');
        grip.removeEventListener('pointermove', onMove);
        grip.removeEventListener('pointerup', onUp);
        grip.removeEventListener('pointercancel', onUp);
      };
      grip.addEventListener('pointermove', onMove);
      grip.addEventListener('pointerup', onUp);
      grip.addEventListener('pointercancel', onUp);
    });
  }
}
