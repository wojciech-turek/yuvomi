/**
 * Modul: Globales Erfassen (Tafla „Szybkie dodawanie")
 * Zweck: Das abgesetzte + neben der Tab-Kapsel, sein Langdruck-Menue und das
 *        EINE Erfassen-Blatt. Es loest den Speed-Dial der Uebersicht und die
 *        eigenen FAB-Bedeutungen der Seiten ab (spec-navigation.txt, Rollout
 *        Schritt 3). Artboard: SzybkieDodawanie.dc.html.
 *
 * LOKAL ZUERST. utils/capture-parse.js liest Datum, Uhrzeit, Person, Listen und
 * Mengen im Browser; gespeichert wird ueber die bestehende API des Typs. Keine
 * Anfrage wartet auf ein Modell, offline aendert sich an der Lesart nichts -
 * nur das Speichern meldet dann, dass es nicht durchkam, und das Blatt behaelt
 * den Text.
 *
 * DER KONTEXT WAEHLT DEN TYP VOR: auf Zadania steht „Zadanie" schon gedrueckt,
 * auf Dziś „Auto". Angeboten werden nur Typen, deren Modul der Haushalt
 * eingeschaltet hat und die dieses Mitglied beschreiben darf.
 *
 * Gebaut wird mit DOM-APIs; die statischen Teile als Zeichenkette gehen durch
 * esc() (kein innerHTML, Hausregel).
 */
import { api } from '/api.js';
import { t, getLocale, getNumberFormat } from '/i18n.js';
import { esc } from '/utils/html.js';
import { openModal, closeModal, captureModalContext } from '/components/modal.js';
import { navModuleAccess } from '/permissions.js';
import { parseCapture } from '/utils/capture-parse.js';
import { todayKey, addLocalDays } from '/utils/date.js';
import { relativeDateLabel } from '/utils/day-label.js';
import { moduleIconEl } from '/nav-icons.js';
import { assigneeSyncTarget } from '/utils/sync-target.js';
import { initials } from '/utils/initials.js';
import { mealTypeLabel, ensureMealTypeNames } from '/utils/meal-types.js';
import { errorSentence } from '/utils/friendly-error.js';
import { personToken } from '/utils/person-color.js';

/** Die Typen des Blattes, in der Reihenfolge des Artboards. */
export const CAPTURE_KINDS = Object.freeze([
  { key: 'task',     module: 'tasks',    route: '/tasks',    icon: 'circle-check-big' },
  { key: 'event',    module: 'calendar', route: '/calendar', icon: 'calendar' },
  { key: 'shopping', module: 'shopping', route: '/shopping', icon: 'shopping-cart' },
  { key: 'meal',     module: 'meals',    route: '/meals',    icon: 'utensils' },
  { key: 'note',     module: 'notes',    route: '/notes',    icon: 'sticky-note' },
]);

const ROUTE_TYPE = Object.freeze({
  '/tasks': 'task',
  '/calendar': 'event',
  '/shopping': 'shopping',
  '/meals': 'meal',
  '/notes': 'note',
});

/**
 * Welcher Typ auf einer Route vorgewaehlt ist. Seiten ohne eigenen Typ
 * (Dziś, Przepisy, Budżet …) starten mit „Auto".
 * @param {string} path
 * @returns {'auto'|'task'|'event'|'shopping'|'meal'|'note'}
 */
export function captureTypeForRoute(path) {
  return ROUTE_TYPE[path] ?? 'auto';
}

/** Darf dieses Mitglied in diesem Modul anlegen, und gibt es das Modul? */
function canWrite(module) {
  if (globalThis.window?.yuvomi?.isModuleDisabled?.(module)) return false;
  return navModuleAccess(module) === 'write';
}

/** Die Typen, die dieses Mitglied hier erfassen kann. */
export function availableCaptureKinds() {
  return CAPTURE_KINDS.filter((kind) => canWrite(kind.module));
}

// --------------------------------------------------------
// Haushalt und KI-Status, je Sitzung zwischengespeichert
// --------------------------------------------------------

const MEMBERS_TTL = 5 * 60 * 1000;
let _members = null;
let _membersAt = 0;

async function loadMembers() {
  if (_members && Date.now() - _membersAt < MEMBERS_TTL) return _members;
  try {
    const res = await api.get('/family/members');
    _members = (res.data ?? []).filter((m) => m && m.id && m.display_name);
    _membersAt = Date.now();
  } catch {
    _members = _members ?? [];
  }
  return _members;
}

let _aiStatus = null;
async function pantryPhotoAvailable() {
  if (!canWrite('pantry')) return false;
  if (!_aiStatus) {
    _aiStatus = api.get('/ai/status').then((res) => res.data ?? {}).catch(() => ({}));
  }
  const status = await _aiStatus;
  return Boolean(status?.features?.pantry_photo);
}

/** Beim Abmelden: nichts vom vorigen Mitglied mitnehmen. */
export function forgetCaptureCache() {
  _shoppingList = null;
  _members = null;
  _membersAt = 0;
  _aiStatus = null;
}

// --------------------------------------------------------
// Kleine Helfer
// --------------------------------------------------------

function svgIcon(name) {
  return moduleIconEl(name, 'capture-icon');
}

function lucideIcon(name) {
  const i = document.createElement('i');
  i.dataset.lucide = name;
  i.setAttribute('aria-hidden', 'true');
  return i;
}

function paintIcons(root) {
  window.lucide?.createIcons({ el: root });
}

/** „wt 20 paź" - kurz, ohne Punkte. Die Lesart bestaetigt, was „jutro" heisst. */
function shortDateLabel(dateKey) {
  if (!dateKey) return '';
  const [y, m, d] = dateKey.split('-').map(Number);
  try {
    return new Intl.DateTimeFormat(getLocale(), { weekday: 'short', day: 'numeric', month: 'short' })
      .format(new Date(y, m - 1, d, 12))
      .replace(/[.,]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return dateKey;
  }
}

/** Der lange Name eines Tages fuer Vorlesehilfen: „wtorek, 20 października". */
function longDateLabel(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  try {
    return new Intl.DateTimeFormat(getLocale(), { weekday: 'long', day: 'numeric', month: 'long' })
      .format(new Date(y, m - 1, d, 12));
  } catch {
    return dateKey;
  }
}

/** Eine Stunde nach `time`, mit Datumswechsel ueber Mitternacht. */
function plusOneHour(dateKey, time) {
  const [h, min] = time.split(':').map(Number);
  const next = h + 1;
  if (next < 24) return { date: dateKey, time: `${String(next).padStart(2, '0')}:${String(min).padStart(2, '0')}` };
  return { date: addLocalDays(dateKey, 1), time: `00:${String(min).padStart(2, '0')}` };
}

function timeRangeLabel(p) {
  if (!p.time) return '';
  return p.endTime ? `${p.time}-${p.endTime}` : p.time;
}

function kindOf(key) {
  return CAPTURE_KINDS.find((kind) => kind.key === key) ?? CAPTURE_KINDS[0];
}

// --------------------------------------------------------
// Speichern je Typ - die bestehenden APIs
// --------------------------------------------------------

function quantityText(item) {
  if (item.quantity == null) return undefined;
  let n;
  try {
    n = getNumberFormat({ maximumFractionDigits: 3 }).format(item.quantity);
  } catch {
    n = String(item.quantity);
  }
  return item.unit && item.unit !== 'x' && item.unit !== '×' ? `${n} ${item.unit}` : n;
}

async function eventSyncTarget(assigneeIds) {
  if (!assigneeIds.length) return {};
  try {
    const res = await api.get('/calendar/sync-targets');
    const target = assigneeSyncTarget({ google: res.data?.google ?? [], caldav: res.data?.caldav ?? [] }, assigneeIds).value;
    if (target?.startsWith('google:')) return { target_google_calendar_id: target.slice('google:'.length) };
    if (target?.startsWith('caldav:')) {
      const [accountId, calendarUrl] = target.slice('caldav:'.length).split('|');
      if (accountId && calendarUrl) {
        return { target_caldav_account_id: parseInt(accountId, 10), target_caldav_calendar_url: calendarUrl };
      }
    }
  } catch { /* lokal speichern ist die sichere Antwort */ }
  return {};
}

/** Die Liste, auf die das Erfassen schreibt: die erste, wie der Einkauf sie oeffnet. */
let _shoppingList = null;
async function firstShoppingList({ fresh = true } = {}) {
  if (!fresh && _shoppingList) return _shoppingList;
  const lists = await api.get('/shopping');
  _shoppingList = (lists.data ?? [])[0] ?? null;
  return _shoppingList;
}

const SAVERS = {
  async task(p, text) {
    const date = p.date ?? (p.time ? todayKey() : null);
    const res = await api.post('/tasks', {
      title: p.title || text,
      due_date: date,
      due_time: p.time ?? null,
      assigned_to: p.assignee ? [p.assignee.id] : [],
    });
    const id = res.data?.id;
    const detail = [date ? relativeDateLabel(date) : '', p.time].filter(Boolean).join(' ');
    return { message: t('capture.saved.task'), detail, undo: () => api.delete(`/tasks/${id}`) };
  },

  async event(p, text) {
    const date = p.date ?? todayKey();
    const assignees = p.assignee ? [p.assignee.id] : [];
    let body;
    if (p.time) {
      const end = p.endTime ? { date, time: p.endTime } : plusOneHour(date, p.time);
      body = {
        title: p.title || text,
        start_datetime: `${date}T${p.time}`,
        end_datetime: `${end.date}T${end.time}`,
        all_day: false,
      };
    } else {
      body = { title: p.title || text, start_datetime: date, end_datetime: date, all_day: true };
    }
    Object.assign(body, { assigned_to: assignees, visibility: 'all' }, await eventSyncTarget(assignees));
    const res = await api.post('/calendar', body);
    const id = res.data?.id;
    const detail = [relativeDateLabel(date), p.time].filter(Boolean).join(' ');
    return { message: t('capture.saved.event'), detail, undo: () => api.delete(`/calendar/${id}`) };
  },

  async shopping(p, text) {
    const list = await firstShoppingList();
    if (!list) throw Object.assign(new Error('no shopping list'), { code: 'capture_no_list' });
    const items = p.items?.length ? p.items : [{ name: text, quantity: null, unit: null }];
    const ids = [];
    for (const item of items) {
      const res = await api.post(`/shopping/${list.id}/items`, {
        name: item.name,
        quantity: quantityText(item),
        category_source: 'default',
      });
      if (res.data?.id) ids.push(res.data.id);
    }
    const message = items.length === 1
      ? t('capture.saved.shoppingOne', { name: items[0].name })
      : t('capture.saved.shoppingMany', { count: items.length });
    return {
      message,
      detail: list.name ?? '',
      undo: () => Promise.all(ids.map((id) => api.delete(`/shopping/items/${id}`))),
    };
  },

  async meal(p, text) {
    const date = p.date ?? todayKey();
    const body = { date, meal_type: p.mealType ?? 'dinner', title: p.title || text };
    if (p.assignee) body.cook_user_id = p.assignee.id;
    const res = await api.post('/meals', body);
    const id = res.data?.id;
    return { message: t('capture.saved.meal'), detail: relativeDateLabel(date), undo: () => api.delete(`/meals/${id}`) };
  },

  async note(_p, text) {
    const res = await api.post('/notes', { content: text });
    const id = res.data?.id;
    return { message: t('capture.saved.note'), detail: '', undo: () => api.delete(`/notes/${id}`) };
  },
};

// --------------------------------------------------------
// Das Langdruck-Menue (auch der Kamera-Kreis im Blatt)
// --------------------------------------------------------

/**
 * Die Wege, die mit einem Bild beginnen - nur die, die es heute gibt:
 * die Spiżarnia aus einem Foto (KI-Funktion des Haushalts) und ein Dokument
 * hochladen. Einen Paragon-Weg gibt es noch nicht; er steht nicht im Menue.
 * @returns {Promise<Array<{key: string, label: string, icon: string, run: (picked?: File) => Promise<void>|void, picksFile?: boolean}>>}
 */
async function photoActions() {
  const actions = [];
  if (await pantryPhotoAvailable()) {
    actions.push({
      key: 'pantry-photo',
      label: t('capture.menu.pantryPhoto'),
      icon: 'camera',
      picksFile: true,
      run: async (file) => {
        await window.yuvomi?.navigate('/pantry');
        const page = await import('/pages/pantry.js');
        await page.scanPantryPhoto?.(file);
      },
    });
  }
  if (canWrite('documents')) {
    actions.push({
      key: 'document',
      label: t('capture.menu.document'),
      icon: 'file-text',
      run: async () => {
        await window.yuvomi?.navigate('/documents');
        document.getElementById('fab-new-document')?.click();
      },
    });
  }
  return actions;
}

/** Ein Bild waehlen - synchron im Tipp, sonst verweigert der Browser den Dialog. */
function pickPhoto(onPicked) {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.setAttribute('capture', 'environment');
  picker.hidden = true;
  document.body.appendChild(picker);
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.remove();
    if (file) onPicked(file);
  }, { once: true });
  picker.click();
  // Abgebrochen feuert kein `change`; der Knoten raeumt sich beim naechsten Mal.
  setTimeout(() => { if (!picker.files?.length) picker.remove(); }, 60_000);
}

let _menu = null;

/**
 * Oeffnet das Menue ueber dem +. Ein natives Popover: Top-Layer, Klick daneben
 * und Esc schliessen, Pfeiltasten wandern.
 * @param {HTMLElement} anchor - der Knopf, zu dem der Fokus zurueckkehrt
 * @param {{ before?: () => Promise<void>|void }} [opts]
 * @returns {Promise<boolean>} ob es etwas zu zeigen gab
 */
export async function openCaptureMenu(anchor, { before } = {}) {
  const actions = await photoActions();
  if (!actions.length) return false;
  _menu?.remove();
  const menu = document.createElement('div');
  menu.className = 'popover-menu capture-menu';
  menu.id = 'capture-menu';
  // `manual`, nicht `auto`: das Menue oeffnet MITTEN in einem Druck (Langdruck),
  // und das Loslassen auf dem + zaehlte als Klick daneben - ein auto-Popover
  // schloss sich damit im selben Augenblick. Geschlossen wird unten selbst:
  // Druck daneben, Esc, Wahl eines Eintrags.
  menu.setAttribute('popover', 'manual');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', t('capture.menu.label'));
  for (const action of actions) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'popover-menu__item';
    item.setAttribute('role', 'menuitem');
    item.dataset.action = action.key;
    item.append(lucideIcon(action.icon));
    const span = document.createElement('span');
    span.textContent = action.label;
    item.append(span);
    item.addEventListener('click', () => {
      menu.hidePopover?.();
      if (action.picksFile) {
        pickPhoto(async (file) => {
          await before?.();
          await action.run(file);
        });
        return;
      }
      Promise.resolve(before?.()).then(() => action.run());
    });
    menu.append(item);
  }
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
      items[next]?.focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault();
      menu.hidePopover?.();
    }
  });
  // Ein Druck daneben schliesst - erst NACH dem Druck, der das Menue oeffnete.
  const outside = (e) => {
    if (!menu.contains(e.target)) menu.hidePopover?.();
  };
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  menu.addEventListener('toggle', (e) => {
    if (e.newState === 'closed') {
      document.removeEventListener('pointerdown', outside, true);
      menu.remove();
      if (_menu === menu) _menu = null;
      if (anchor?.isConnected && !document.querySelector('dialog[open]')) anchor.focus({ preventScroll: true });
    }
  });
  document.body.append(menu);
  _menu = menu;
  paintIcons(menu);
  if (typeof menu.showPopover === 'function') menu.showPopover();
  menu.querySelector('[role="menuitem"]')?.focus();
  return true;
}

// --------------------------------------------------------
// Das + der Shell
// --------------------------------------------------------

const LONG_PRESS_MS = 400;

/**
 * Baut das abgesetzte + (`.capture-plus`). Tippen oeffnet das Blatt, 400ms
 * halten (oder Kontextmenue-Taste / Shift+F10) das Bild-Menue.
 * @param {{ onOpen: () => void }} opts
 * @returns {HTMLButtonElement}
 */
export function createCapturePlus({ onOpen }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'capture-plus';
  btn.id = 'capture-plus';
  btn.setAttribute('aria-label', t('capture.add'));
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.append(lucideIcon('plus'));

  let timer = 0;
  let longPressed = false;
  let startX = 0;
  let startY = 0;
  const cancel = () => { clearTimeout(timer); timer = 0; };
  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    longPressed = false;
    startX = e.clientX;
    startY = e.clientY;
    cancel();
    timer = setTimeout(async () => {
      timer = 0;
      longPressed = true;
      navigator.vibrate?.(10);
      const shown = await openCaptureMenu(btn);
      if (!shown) longPressed = false;
    }, LONG_PRESS_MS);
  });
  btn.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > 10) cancel();
  });
  btn.addEventListener('pointerup', cancel);
  btn.addEventListener('pointercancel', cancel);
  btn.addEventListener('pointerleave', cancel);
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (longPressed) return;
    cancel();
    longPressed = true;
    openCaptureMenu(btn).then((shown) => { if (!shown) longPressed = false; });
  });
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      openCaptureMenu(btn);
    }
  });
  btn.addEventListener('click', (e) => {
    if (longPressed) {
      e.preventDefault();
      longPressed = false;
      return;
    }
    onOpen();
  });
  if (window.lucide) window.lucide.createIcons({ el: btn });
  return btn;
}

// --------------------------------------------------------
// Das Blatt
// --------------------------------------------------------

let _open = false;

/**
 * Oeffnet das Erfassen-Blatt.
 * @param {object} [opts]
 * @param {string} [opts.context='auto'] - vorgewaehlter Typ (captureTypeForRoute)
 * @param {{ label: string, run: () => void }|null} [opts.pageAction] - das volle
 *   Formular der Seite (ihr frueherer FAB), als Weg unter dem Fuss
 * @param {string} [opts.text] - vorbelegter Text (Tests, Suche)
 */
export async function openCaptureSheet({ context = 'auto', pageAction = null, text = '' } = {}) {
  if (_open) return;
  const kinds = availableCaptureKinds();
  if (!kinds.length && !pageAction) {
    window.yuvomi?.showToast(t('capture.nothingWritable'), 'warning');
    return;
  }
  _open = true;
  let chosen = kinds.some((kind) => kind.key === context) ? context : 'auto';
  let members = _members ?? [];
  let parse = null;
  let saving = false;
  let shoppingAsked = false;
  // Die Slot-Namen des Haushalts („Kolacja" oder ein eigenes Wort).
  ensureMealTypeNames?.();
  let stopKeyboardWatch = () => {};

  const chip = (key, label, pressed) => `
        <button type="button" class="capture-chip" data-type="${esc(key)}" aria-pressed="${pressed ? 'true' : 'false'}">${key === 'auto' ? '<i data-lucide="sparkles" aria-hidden="true"></i>' : ''}${esc(label)}</button>`;

  const content = `
    <div class="capture-sheet">
      <button type="button" class="capture-sheet__grabber" data-action="close-modal" aria-label="${esc(t('common.close'))}"></button>
      <div class="capture-sheet__top">
        <div class="capture-field">
          <input type="text" class="capture-field__input" id="capture-input" autocomplete="off" autocapitalize="sentences"
                 enterkeyhint="done" aria-label="${esc(t('capture.fieldLabel'))}" placeholder="${esc(t('capture.placeholder'))}"
                 aria-describedby="capture-parse-sub">
        </div>
        <div class="capture-chips" role="group" aria-label="${esc(t('capture.typeGroup'))}">${chip('auto', t('capture.type.auto'), chosen === 'auto')}${kinds.map((kind) => chip(kind.key, t(`capture.type.${kind.key}`), chosen === kind.key)).join('')}
        </div>
      </div>
      <div class="capture-parse" id="capture-parse" role="group" aria-label="${esc(t('capture.parseLabel'))}"></div>
      <p class="sr-only" id="capture-status" role="status" aria-live="polite"></p>
      <p class="capture-sheet__error" id="capture-error" role="alert"></p>
      <div class="capture-sheet__footer">
        <button type="button" class="capture-sheet__camera" id="capture-camera" hidden aria-label="${esc(t('capture.photoLabel'))}" aria-haspopup="menu"><i data-lucide="camera" aria-hidden="true"></i></button>
        <button type="button" class="capture-sheet__save" id="capture-save" disabled>${esc(t('capture.primary.auto'))}</button>
      </div>
      ${pageAction ? `<button type="button" class="capture-sheet__full" id="capture-full">${esc(t('capture.fullForm', { action: pageAction.label }))}</button>` : ''}
    </div>`;

  openModal({
    title: t('capture.title'),
    content,
    size: 'capture',
    onClose: () => {
      _open = false;
      stopKeyboardWatch();
    },
    onSave: (panel) => wire(panel),
  });

  function wire(panel) {
    const input = panel.querySelector('#capture-input');
    const card = panel.querySelector('#capture-parse');
    const status = panel.querySelector('#capture-status');
    const errorEl = panel.querySelector('#capture-error');
    const saveBtn = panel.querySelector('#capture-save');
    const chips = [...panel.querySelectorAll('.capture-chip')];
    if (text) input.value = text;

    const typeNow = () => (chosen === 'auto' ? (parse?.type ?? 'task') : chosen);

    let statusTimer = 0;
    const announce = (line) => {
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => { status.textContent = line; }, 700);
    };

    const removeToken = (tokenText) => {
      if (!tokenText) return;
      const at = input.value.indexOf(tokenText);
      if (at < 0) return;
      input.value = `${input.value.slice(0, at)} ${input.value.slice(at + tokenText.length)}`
        .replace(/\s+([,.;:])/g, '$1').replace(/\s{2,}/g, ' ').trim();
      input.focus({ preventScroll: true });
      update();
    };

    const tokenButton = ({ label, aria, tokenText, disc = null, person = null }) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'capture-token';
      b.setAttribute('aria-label', aria);
      if (disc) {
        const d = document.createElement('span');
        d.className = 'capture-token__disc';
        d.setAttribute('aria-hidden', 'true');
        d.textContent = disc;
        // Die Personenfarbe (person-color.js) - genau wie auf Dziś gerufen, damit
        // dieselbe Person auf beiden Flaechen dieselbe Farbe traegt.
        if (person) {
          const tok = personToken(person);
          d.style.backgroundColor = tok.tint;
          d.style.color = tok.ink;
        }
        b.append(d);
      }
      b.append(document.createTextNode(label));
      const x = document.createElement('span');
      x.className = 'capture-token__x';
      x.append(lucideIcon('x'));
      b.append(x);
      b.addEventListener('click', () => removeToken(tokenText));
      return b;
    };

    const staticToken = (label) => {
      const s = document.createElement('span');
      s.className = 'capture-token capture-token--static';
      s.textContent = label;
      return s;
    };

    function renderCard() {
      const value = input.value.trim();
      card.replaceChildren();
      if (!value) {
        const hint = document.createElement('p');
        hint.className = 'capture-sheet__hint';
        hint.id = 'capture-parse-sub';
        hint.textContent = t('capture.hint');
        card.append(hint);
        return;
      }
      const type = typeNow();
      const kind = kindOf(type);
      const head = document.createElement('div');
      head.className = 'capture-parse__head';
      const glyph = document.createElement('span');
      glyph.className = 'capture-parse__glyph';
      glyph.append(svgIcon(kind.icon));
      const textBox = document.createElement('div');
      textBox.className = 'capture-parse__text';
      const title = document.createElement('span');
      title.className = 'capture-parse__title';
      const sub = document.createElement('span');
      sub.className = 'capture-parse__sub';
      sub.id = 'capture-parse-sub';
      const typeLabel = t(`capture.type.${type}`);
      const by = chosen === 'auto' ? ` · ${t('capture.recognized')}` : '';
      const tokens = document.createElement('div');
      tokens.className = 'capture-parse__tokens';

      if (type === 'shopping') {
        const items = parse.items?.length ? parse.items : [{ name: value, quantity: null, unit: null }];
        title.textContent = items.length === 1 ? items[0].name : t('capture.shoppingCount', { count: items.length });
        // „Zakupy → Cotygodniowe": wohin es geht, sobald die Liste bekannt ist.
        sub.textContent = _shoppingList?.name ? `${typeLabel} → ${_shoppingList.name}${by}` : `${typeLabel}${by}`;
        if (!_shoppingList && !shoppingAsked) {
          shoppingAsked = true;
          firstShoppingList({ fresh: false }).then((list) => { if (list && input.isConnected) renderCard(); }).catch(() => {});
        }
        if (items.length > 1 || items[0].quantity != null) {
          for (const item of items) {
            const qty = quantityText(item);
            tokens.append(staticToken(qty ? `${qty} · ${item.name}` : item.name));
          }
        }
      } else if (type === 'note') {
        title.textContent = value.split('\n')[0];
        sub.textContent = `${typeLabel}${by}`;
      } else {
        title.textContent = parse.title || value;
        const mealPart = type === 'meal' ? ` · ${mealTypeLabel(parse.mealType ?? 'dinner')}` : '';
        sub.textContent = `${typeLabel}${mealPart}${by}`;
        const tokenText = (kindName) => parse.tokens.find((tk) => tk.kind === kindName)?.text;
        const date = parse.date ?? (type === 'event' || type === 'meal' || parse.time ? todayKey() : null);
        if (date) {
          const dateToken = tokenText('date');
          const label = shortDateLabel(date);
          tokens.append(dateToken
            ? tokenButton({ label, aria: t('capture.tokenDate', { value: longDateLabel(date) }), tokenText: dateToken })
            : staticToken(label));
        }
        if (parse.time && type !== 'meal') {
          const range = type === 'event' && !parse.endTime ? `${parse.time}-${plusOneHour(date, parse.time).time}` : timeRangeLabel(parse);
          tokens.append(tokenButton({ label: range, aria: t('capture.tokenTime', { value: range }), tokenText: tokenText('time') }));
        }
        if (parse.assignee) {
          const name = parse.assignee.name;
          tokens.append(tokenButton({
            label: name,
            aria: t('capture.tokenPerson', { value: name }),
            tokenText: tokenText('person'),
            disc: initials(name).slice(0, 1),
            person: members.find((m) => m.id === parse.assignee.id) ?? null,
          }));
        }
      }
      textBox.append(title, sub);
      head.append(glyph, textBox);
      card.append(head, tokens);
      paintIcons(card);
      announce([title.textContent, sub.textContent, ...[...tokens.children].map((c) => c.textContent)].join(', '));
    }

    function updateSave() {
      const value = input.value.trim();
      const type = typeNow();
      let label;
      if (!value) label = t('capture.primary.auto');
      else if (type === 'shopping') {
        const count = parse?.items?.length || 1;
        label = count > 1 ? t('capture.primary.shoppingMany', { count }) : t('capture.primary.shopping');
      } else label = t(`capture.primary.${type}`);
      saveBtn.textContent = label;
      saveBtn.disabled = !value || saving || !kinds.some((kind) => kind.key === type);
    }

    function update() {
      const value = input.value;
      parse = parseCapture(value, { members, type: chosen === 'auto' ? 'auto' : chosen });
      // „Auto" darf nur einen Typ treffen, den es hier auch gibt.
      if (chosen === 'auto' && !kinds.some((kind) => kind.key === parse.type)) {
        const fallback = kinds[0]?.key;
        if (fallback) parse = parseCapture(value, { members, type: fallback });
      }
      errorEl.textContent = '';
      renderCard();
      updateSave();
    }

    for (const c of chips) {
      c.addEventListener('click', () => {
        chosen = c.dataset.type;
        for (const other of chips) other.setAttribute('aria-pressed', other === c ? 'true' : 'false');
        update();
      });
    }

    async function save() {
      const value = input.value.trim();
      if (!value || saving) return;
      const type = typeNow();
      if (!kinds.some((kind) => kind.key === type)) return;
      saving = true;
      updateSave();
      const context = captureModalContext();
      try {
        const result = await SAVERS[type](parse, value);
        await closeModal({ force: true, context });
        const message = result.detail ? `${result.message} · ${result.detail}` : result.message;
        const kind = kindOf(type);
        window.yuvomi?.showToast(message, 'success', 4000, {
          label: t('common.undo'),
          onClick: async () => {
            try {
              await result.undo();
              window.dispatchEvent(new CustomEvent('yuvomi:captured', { detail: { type, route: kind.route, undone: true } }));
            } catch (err) {
              window.yuvomi?.showToast(errorSentence(err, 'capture.undoFailed'), 'danger');
            }
          },
        });
        window.dispatchEvent(new CustomEvent('yuvomi:captured', { detail: { type, route: kind.route } }));
      } catch (err) {
        saving = false;
        errorEl.textContent = err?.code === 'capture_no_list' ? t('capture.noShoppingList') : errorSentence(err, 'capture.saveFailed');
        updateSave();
      }
    }

    input.addEventListener('input', update);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        save();
      }
    });
    saveBtn.addEventListener('click', save);

    // Der Kamera-Kreis erscheint, sobald feststeht, dass es einen Bild-Weg gibt -
    // das Blatt wartet nicht darauf (der KI-Status ist ein Abruf).
    const camera = panel.querySelector('#capture-camera');
    camera?.addEventListener('click', (e) => {
      openCaptureMenu(e.currentTarget, { before: () => closeModal({ force: true }) });
    });
    photoActions().then((actions) => { if (camera?.isConnected) camera.hidden = actions.length === 0; });
    panel.querySelector('#capture-full')?.addEventListener('click', async () => {
      await closeModal({ force: true });
      pageAction?.run();
    });

    stopKeyboardWatch = watchKeyboard(panel.closest('.modal-overlay'));

    update();
    // Der Haushalt kommt nach: die Lesart erkennt Namen, sobald er da ist.
    loadMembers().then((list) => {
      if (!input.isConnected) return;
      members = list;
      update();
    });
  }
}

/**
 * DER FUSS REITET UEBER DER TASTATUR. iOS schiebt das Layout-Viewport nicht;
 * ohne Ausgleich laege die Primaeraktion unter der Tastatur. Die Hoehe der
 * Tastatur ist der Teil des Fensters, den das visuelle Viewport nicht zeigt.
 * @param {HTMLElement|null} overlay
 * @returns {() => void}
 */
function watchKeyboard(overlay) {
  const vv = window.visualViewport;
  if (!overlay || !vv) return () => {};
  const sync = () => {
    const covered = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
    overlay.style.setProperty('--capture-keyboard', `${Math.round(covered)}px`);
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  sync();
  return () => {
    vv.removeEventListener('resize', sync);
    vv.removeEventListener('scroll', sync);
  };
}

export const __test = { captureTypeForRoute, shortDateLabel, plusOneHour, quantityText };
