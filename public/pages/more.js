/**
 * Modul: Więcej (Tafla, 2026-10-20)
 * Zweck: The fifth tab as a page. Large title, the search field (it opens the
 *        global search), "Sprawy domowe" - the few household things that need
 *        someone, each with ONE plain verb that does the job through the
 *        module's own API -, the profile row, "Przypięte" preview tiles, then
 *        every enabled module that has no tab of its own, grouped (Dom ·
 *        Pieniądze i zdrowie · Na co dzień), the kitchen wall and Ustawienia.
 * Abhängigkeiten: /api.js, /i18n.js, /utils/html.js, /utils/person-color.js,
 *                 /utils/page-layout.js, /utils/toast-show.js, /permissions.js
 *
 * ONLY WHAT EXISTS. Every value comes from an endpoint the module already
 * has (mostly the one `/dashboard` answer, which follows the household
 * switches and the viewer's rights on the server). A switched-off module
 * never appears: its group row, tile and inbox items are all derived from
 * the router's own navigation targets (`window.yuvomi.navDestinations`).
 *
 * Markup is built as strings with esc() on every value and goes in through
 * insertAdjacentHTML (house rule: no innerHTML writes).
 */

import { api } from '/api.js';
import { t, formatTime, getLocale, getNumberFormat } from '/i18n.js';
import { esc } from '/utils/html.js';
import { personToken } from '/utils/person-color.js';
import { getHouseholdSize } from '/utils/household.js';
import { navModuleAccess } from '/permissions.js';
import { showToast } from '/utils/toast-show.js';
import { openModal, closeModal } from '/components/modal.js';
import { enterWallMode } from '/utils/wall-mode.js';
import { createPageController } from '/utils/page-lifecycle.js';
import { renderAppPage, renderPageHeader, renderPageTitle, renderPageBody } from '/utils/page-layout.js';

// --------------------------------------------------------
// What lives where
// --------------------------------------------------------

/** Modules with a tab of their own (or the start page) are not listed here. */
const TAB_MODULES = new Set(['dashboard', 'settings', 'calendar', 'tasks']);

/** The three groups of the artboard, in their order. Unknown modules (an
 * installed extension) join "Na co dzień". */
const GROUPS = [
  { id: 'home', labelKey: 'more.groupHome', modules: ['housekeeping', 'documents', 'contacts', 'inventory', 'waste'] },
  { id: 'money', labelKey: 'more.groupMoney', modules: ['budget', 'health'] },
  { id: 'daily', labelKey: 'more.groupDaily', modules: ['notes', 'birthdays', 'rewards', 'schedule'] },
];

/** One bare glyph per module (ink-2, as in the artboards). */
const GLYPH = {
  housekeeping: 'spray-can',
  documents: 'file-text',
  contacts: 'contact',
  inventory: 'package',
  waste: 'recycle',
  budget: 'wallet',
  health: 'heart-pulse',
  notes: 'sticky-note',
  birthdays: 'cake',
  rewards: 'award',
  schedule: 'calendar-clock',
  'split-expenses': 'arrow-left-right',
};

/** Tiles someone can pin, in the order the defaults are taken from. */
export const PIN_IDS = ['notes', 'budget', 'birthdays', 'health', 'housekeeping', 'documents', 'waste', 'split-expenses'];
export const PIN_MAX = 4;
/** The module that gates a tile. */
const PIN_MODULE = { 'split-expenses': 'budget' };

/** At most this many inbox rows before "Jeszcze N". */
const INBOX_VISIBLE = 3;

const DOCUMENT_SOON_DAYS = 30;

// --------------------------------------------------------
// Small pieces
// --------------------------------------------------------

function icon(name) {
  return `<i data-lucide="${esc(name)}" aria-hidden="true"></i>`;
}

const chevron = () => `<span class="more-row__chevron" aria-hidden="true">${icon('chevron-right')}</span>`;

/**
 * The money format of the page: no cents on a whole amount ("360 zł", not
 * "360,00 zł") nor from 1000 up, as the artboards write it; `whole` rounds.
 */
function moneyFormat(amount, currency, { whole = false } = {}) {
  const value = Number(amount) || 0;
  const noCents = whole || Math.abs(value) >= 1000 || Number.isInteger(value);
  return getNumberFormat({
    style: 'currency',
    currency: currency || 'EUR',
    ...(noCents ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}),
  });
}

/** "2504 zł" with the currency part in ink-2 (money is ink, the unit steps back). */
function moneyHtml(amount, currency, opts = {}) {
  return moneyFormat(amount, currency, opts).formatToParts(Number(amount) || 0)
    .map((part) => (part.type === 'currency' ? `<span class="more-quiet">${esc(part.value)}</span>` : esc(part.value)))
    .join('');
}

function moneyText(amount, currency, opts = {}) {
  return moneyFormat(amount, currency, opts).format(Number(amount) || 0);
}

/**
 * A translated sentence with markup in its placeholders: the text is escaped,
 * the given HTML goes in where the placeholder stood.
 */
function tHtml(key, vars = {}, html = {}) {
  const marks = {};
  let i = 0;
  for (const name of Object.keys(html)) marks[name] = `${i++}`;
  const text = t(key, { ...vars, ...marks });
  return text.split(/(\d+)/).map((part) => {
    const m = /^(\d+)$/.exec(part);
    return m ? html[Object.keys(html)[Number(m[1])]] : esc(part);
  }).join('');
}

function localKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dayDiff(fromKey, toKey) {
  const a = Date.UTC(...fromKey.split('-').map((n, idx) => Number(n) - (idx === 1 ? 1 : 0)));
  const b = Date.UTC(...toKey.split('-').map((n, idx) => Number(n) - (idx === 1 ? 1 : 0)));
  return Math.round((b - a) / 86400000);
}

function addDays(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  return localKey(new Date(y, m - 1, d + days));
}

/** "dziś", "jutro", "za 8 dni". */
function whenLabel(days) {
  if (days === 0) return t('more.today');
  if (days === 1) return t('more.tomorrow');
  return t('more.inDays', { days: t('dashboard.daysLeft', { count: days }) });
}

/** "wt 27 paź" - short weekday, day, short month, without trailing dots. */
function shortDate(key) {
  const date = new Date(`${key}T12:00:00Z`);
  const part = (opts) => new Intl.DateTimeFormat(getLocale(), { ...opts, timeZone: 'UTC' }).format(date).replace(/\.$/, '');
  return `${part({ weekday: 'short' })} ${part({ day: 'numeric' })} ${part({ month: 'short' })}`;
}

/** "15 i 17 paź" for a few days of one month, else "15 paź, 2 lis". */
function daysList(keys) {
  const dates = keys.map((key) => new Date(`${key}T12:00:00Z`));
  const fmt = (opts, d) => new Intl.DateTimeFormat(getLocale(), { ...opts, timeZone: 'UTC' }).format(d).replace(/\.$/, '');
  const sameMonth = dates.every((d) => d.getUTCMonth() === dates[0].getUTCMonth());
  if (sameMonth && dates.length > 1) {
    const days = dates.map((d) => fmt({ day: 'numeric' }, d));
    const list = new Intl.ListFormat(getLocale(), { style: 'long', type: 'conjunction' }).format(days);
    return `${list} ${fmt({ month: 'short' }, dates[0])}`;
  }
  return new Intl.ListFormat(getLocale(), { style: 'narrow', type: 'unit' })
    .format(dates.map((d) => `${fmt({ day: 'numeric' }, d)} ${fmt({ month: 'short' }, d)}`));
}

function firstName(name) {
  return String(name ?? '').trim().split(/\s+/)[0] ?? '';
}

// --------------------------------------------------------
// The handled list ("Wystawione" has no server state)
// --------------------------------------------------------

/* PUTTING THE BIN OUT IS NOT STORED ANYWHERE. The waste module has no
 * "put out" state, so the verb hides the row for that pickup on this device
 * only (per person, per day), and Cofnij brings it back. Old days fall out. */
function handledKey(user) {
  return `yuvomi:more:handled:${user?.id ?? 'anon'}`;
}

function readHandled(user) {
  try {
    const raw = JSON.parse(localStorage.getItem(handledKey(user)) ?? '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeHandled(user, map) {
  const today = localKey();
  const kept = Object.fromEntries(Object.entries(map).filter(([, day]) => day >= today));
  try {
    localStorage.setItem(handledKey(user), JSON.stringify(kept));
  } catch {
    // A full or blocked storage only costs the hidden row.
  }
}

// --------------------------------------------------------
// The model
// --------------------------------------------------------

/**
 * Which modules this person sees in Więcej: the router's navigation targets
 * minus the tabs and the kitchen (its own tab). Order follows the groups.
 */
export function moreDestinations(destinations) {
  return (Array.isArray(destinations) ? destinations : [])
    .filter((d) => d && !d.kitchenGroup && !TAB_MODULES.has(d.module));
}

function groupOf(module) {
  return GROUPS.find((g) => g.modules.includes(module))?.id ?? 'daily';
}

/** Inbox items from the loaded data. Each item: { key, glyph, title (html),
 *  meta, verb, verbLabel, route, act, undo }. */
function buildInbox(state) {
  const { data, on, currency, user, extra } = state;
  const items = [];
  const today = localKey();
  const tomorrow = addDays(today, 1);

  // Sprzątanie: unpaid visits, one row per helper.
  if (on('housekeeping') && extra.unpaidVisits.length) {
    const byWorker = new Map();
    for (const visit of extra.unpaidVisits) {
      const id = visit.worker_id ?? 0;
      if (!byWorker.has(id)) byWorker.set(id, []);
      byWorker.get(id).push(visit);
    }
    for (const [workerId, visits] of byWorker) {
      const amount = visits.reduce((sum, v) => sum + (Number(v.total_amount) || 0), 0);
      if (!(amount > 0)) continue;
      const name = visits[0].worker_name || t('nav.housekeeping');
      const payable = visits.every((v) => v.can_mark_paid);
      const days = visits.map((v) => String(v.check_in ?? '').slice(0, 10)).filter(Boolean).sort();
      items.push({
        key: `housekeeping:${workerId}`,
        glyph: GLYPH.housekeeping,
        title: tHtml('more.housekeepingDue', { name }, { amount: moneyHtml(amount, currency) }),
        titleText: t('more.housekeepingDue', { name, amount: moneyText(amount, currency) }),
        meta: t('more.visitsOn', { visits: t('more.forVisits', { count: visits.length }), days: daysList(days.slice(0, 3)) }),
        route: '/housekeeping',
        verbLabel: payable ? t('more.verbPaid') : t('more.verbOpen'),
        act: payable ? async () => {
          for (const visit of visits) await api.post(`/housekeeping/visits/${visit.id}/pay`, {});
          return {
            message: t('more.paidDone', { name }),
            // Only an admin may take a payment back (POST /visits/:id/unpay).
            undo: user?.role === 'admin' ? async () => {
              for (const visit of visits) await api.post(`/housekeeping/visits/${visit.id}/unpay`, {});
            } : null,
          };
        } : null,
      });
    }
  }

  // Rozliczenia: what this person owes or is owed, per position.
  if (on('budget')) {
    const positions = Array.isArray(data.splitBalance?.positions) ? data.splitBalance.positions : [];
    for (const position of positions.slice(0, 2)) {
      const owe = position.direction === 'owe';
      const name = firstName(position.name);
      const amountHtml = moneyHtml(position.amount, position.currency);
      const canWrite = navModuleAccess('budget') !== 'read';
      items.push({
        key: `split:${position.groupId}:${position.userId}:${position.currency}`,
        glyph: GLYPH['split-expenses'],
        title: tHtml(owe ? 'more.splitYouOwe' : 'more.splitOwesYou', { name }, { amount: amountHtml }),
        titleText: t(owe ? 'more.splitYouOwe' : 'more.splitOwesYou', { name, amount: moneyText(position.amount, position.currency) }),
        meta: position.groupName || t('splitExpenses.title'),
        route: `/budget?tab=split-expenses&group=${encodeURIComponent(String(position.groupId))}`,
        verbLabel: canWrite ? t('more.verbSettle') : t('more.verbOpen'),
        act: canWrite ? async () => {
          const res = await api.post(`/split-expenses/groups/${position.groupId}/settlements`, {
            payer_id: owe ? user.id : position.userId,
            payee_id: owe ? position.userId : user.id,
            amount: position.amount,
            currency: position.currency,
          });
          const settlementId = res?.data?.id;
          return {
            message: t('more.settledDone', { name }),
            undo: settlementId ? async () => {
              await api.post(`/split-expenses/groups/${position.groupId}/settlements/${settlementId}/reverse`, {});
            } : null,
          };
        } : null,
      });
    }
  }

  // Odbiór odpadów: tomorrow's pickup (put the bin out tonight).
  if (on('waste')) {
    const handled = readHandled(user);
    const tomorrowPickups = (Array.isArray(data.wastePickups) ? data.wastePickups : [])
      .filter((p) => p.date_key === tomorrow);
    const key = `waste:${tomorrow}`;
    if (tomorrowPickups.length && !handled[key]) {
      const types = new Intl.ListFormat(getLocale(), { style: 'long', type: 'conjunction' })
        .format([...new Set(tomorrowPickups.map((p) => String(p.type_name ?? '').trim()).filter(Boolean))]);
      items.push({
        key,
        glyph: GLYPH.waste,
        title: esc(t('more.wasteTomorrow', { types })),
        titleText: t('more.wasteTomorrow', { types }),
        meta: t('more.wasteTonight'),
        route: '/waste',
        verbLabel: t('more.verbPutOut'),
        act: async () => {
          const map = readHandled(user);
          map[key] = tomorrow;
          writeHandled(user, map);
          return {
            message: t('more.putOutDone'),
            undo: async () => {
              const next = readHandled(user);
              delete next[key];
              writeHandled(user, next);
            },
          };
        },
      });
    }
  }

  // Dokumenty: what expires within 30 days (or already has).
  if (on('documents')) {
    const docs = extra.documents
      .map((doc) => ({ doc, key: String(doc.expires_at ?? '').slice(0, 10) }))
      .filter(({ key }) => /^\d{4}-\d{2}-\d{2}$/.test(key))
      .map(({ doc, key }) => ({ doc, days: dayDiff(today, key) }))
      .filter(({ days }) => days <= DOCUMENT_SOON_DAYS)
      .sort((a, b) => a.days - b.days);
    for (const { doc, days } of docs) {
      const title = String(doc.title ?? doc.name ?? '');
      const meta = days < 0 ? t('more.documentExpired') : t('more.documentExpires', { when: whenLabel(days) });
      items.push({
        key: `document:${doc.id}`,
        glyph: GLYPH.documents,
        title: esc(title),
        titleText: title,
        meta,
        shortText: t('more.documentShort', { title, when: days < 0 ? t('more.documentExpired') : whenLabel(days) }),
        route: `/documents?open=${encodeURIComponent(String(doc.id))}`,
        verbLabel: t('more.verbOpen'),
        act: null,
      });
    }
  }

  // Zdrowie: medicine running out.
  if (on('health')) {
    const low = Number(data.health?.lowStockCount) || 0;
    if (low > 0) {
      items.push({
        key: 'health:refill',
        glyph: GLYPH.health,
        title: esc(t('more.healthRefill')),
        titleText: t('more.healthRefill'),
        meta: t('dashboard.healthRefill', { count: low }),
        route: '/health',
        verbLabel: t('more.verbOpen'),
        act: null,
      });
    }
  }

  return items;
}

/** The nearest document that has not expired yet: { doc, days } or null. */
function nextDocument(extra) {
  const today = localKey();
  return extra.documents
    .map((doc) => ({ doc, key: String(doc.expires_at ?? '').slice(0, 10) }))
    .filter(({ key }) => /^\d{4}-\d{2}-\d{2}$/.test(key))
    .map(({ doc, key }) => ({ doc, days: dayDiff(today, key) }))
    .filter(({ days }) => days >= 0)
    .sort((a, b) => a.days - b.days)[0] ?? null;
}

/** The next pickup from the dashboard's two-day window: { days, types } or null. */
function nextPickup(data) {
  const today = localKey();
  const pickups = (Array.isArray(data.wastePickups) ? data.wastePickups : [])
    .filter((p) => String(p.date_key) >= today)
    .sort((a, b) => String(a.date_key).localeCompare(String(b.date_key)));
  if (!pickups.length) return null;
  const day = pickups[0].date_key;
  const types = new Intl.ListFormat(getLocale(), { style: 'narrow', type: 'unit' })
    .format([...new Set(pickups.filter((p) => p.date_key === day).map((p) => String(p.type_name ?? '').trim()).filter(Boolean))]);
  return { days: dayDiff(today, day), types };
}

/** The preview tile of a pinnable id, or null when it has nothing to say. */
function buildTile(id, state) {
  const { data, currency, extra } = state;
  switch (id) {
    case 'notes': {
      const total = Number(data.notesTotal) || 0;
      if (!total) return null;
      const notes = Array.isArray(data.pinnedNotes) ? data.pinnedNotes : [];
      const pinned = Number(data.pinnedNotesCount) || 0;
      const lead = notes.find((n) => n.pinned) ?? notes[0];
      const countText = t('more.notesCount', { count: total });
      return {
        id, route: '/notes', glyph: GLYPH.notes, label: t('nav.notes'),
        value: esc(lead?.title || countText),
        note: lead?.title
          ? (pinned ? `${countText} · ${t('dashboard.metricPinned', { count: pinned })}` : countText)
          : (pinned ? t('dashboard.metricPinned', { count: pinned }) : ''),
      };
    }
    case 'budget': {
      const budget = data.budget ?? {};
      if (!(Number(budget.entryCount) > 0)) return null;
      const income = Number(budget.income) || 0;
      const balance = Number(budget.balance) || 0;
      const expenses = Number(budget.expenses) || 0;
      if (income > 0) {
        const today = new Date();
        const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
        const left = daysInMonth - today.getDate() + 1;
        return {
          id, route: '/budget', glyph: GLYPH.budget, label: t('nav.budget'),
          value: tHtml('more.budgetLeft', {}, { amount: `<span class="more-tile__number">${moneyHtml(balance, currency, { whole: true })}</span>` }),
          ariaValue: t('more.budgetLeft', { amount: moneyText(balance, currency, { whole: true }) }),
          note: balance > 0 ? t('more.budgetPerDay', { amount: moneyText(balance / left, currency, { whole: true }) }) : '',
        };
      }
      return {
        id, route: '/budget', glyph: GLYPH.budget, label: t('nav.budget'),
        value: tHtml('more.budgetSpent', {}, { amount: moneyHtml(expenses, currency, { whole: true }) }),
        ariaValue: t('more.budgetSpent', { amount: moneyText(expenses, currency, { whole: true }) }),
        note: '',
      };
    }
    case 'birthdays': {
      const next = (Array.isArray(data.birthdays) ? data.birthdays : [])[0];
      if (!next) return null;
      const days = Number(next.days_until);
      const date = String(next.next_date ?? '').slice(0, 10);
      const age = next.kind !== 'name_day' && Number(next.next_age) > 0 ? t('more.turnsAge', { count: Number(next.next_age) }) : '';
      const kind = next.kind === 'name_day' ? t('birthdays.nameDay') : '';
      return {
        id, route: '/birthdays', glyph: GLYPH.birthdays, label: t('nav.birthdays'),
        value: esc(t('more.birthdayWhen', { name: next.name ?? '', when: Number.isFinite(days) ? whenLabel(days) : '' })),
        note: [/^\d{4}-\d{2}-\d{2}$/.test(date) ? shortDate(date) : '', age || kind].filter(Boolean).join(' · '),
      };
    }
    case 'health': {
      const h = data.health ?? {};
      const next = h.nextDose;
      const low = Number(h.lowStockCount) || 0;
      if (!next?.name && !low) return null;
      return {
        id, route: '/health', glyph: GLYPH.health, label: t('nav.health'),
        value: esc(next?.name ? (next.time ? t('more.doseAt', { name: next.name, time: formatTime(next.time) }) : next.name) : t('more.healthRefill')),
        note: low ? t('dashboard.healthRefill', { count: low }) : '',
      };
    }
    case 'housekeeping': {
      const hk = data.housekeeping ?? {};
      if (!hk.configured) return null;
      let value;
      if (hk.present) value = esc(hk.workerName ? t('more.housekeepingHere', { name: firstName(hk.workerName) }) : t('dashboard.housekeepingPresent'));
      else if (Number(hk.unpaidAmount) > 0) value = tHtml('more.housekeepingUnpaid', {}, { amount: moneyHtml(hk.unpaidAmount, currency) });
      else value = esc(t('dashboard.metricVisitsMonth', { count: Number(hk.visitsThisMonth) || 0 }));
      return { id, route: '/housekeeping', glyph: GLYPH.housekeeping, label: t('nav.housekeeping'), value, note: '' };
    }
    case 'documents': {
      const next = nextDocument(extra);
      if (!next) return null;
      return {
        id, route: `/documents?open=${encodeURIComponent(String(next.doc.id))}`, glyph: GLYPH.documents, label: t('nav.documents'),
        value: esc(String(next.doc.title ?? next.doc.name ?? '')),
        note: t('more.documentExpires', { when: whenLabel(next.days) }),
      };
    }
    case 'waste': {
      const next = nextPickup(data);
      if (!next) return null;
      return {
        id, route: '/waste', glyph: GLYPH.waste, label: t('nav.waste'),
        value: esc(t('more.wasteWhen', { when: whenLabel(next.days), types: next.types })),
        note: '',
      };
    }
    case 'split-expenses': {
      const position = (Array.isArray(data.splitBalance?.positions) ? data.splitBalance.positions : [])[0];
      if (!position) return null;
      const owe = position.direction === 'owe';
      return {
        id, route: `/budget?tab=split-expenses&group=${encodeURIComponent(String(position.groupId))}`,
        glyph: GLYPH['split-expenses'], label: t('splitExpenses.title'),
        value: moneyHtml(position.amount, position.currency),
        note: t(owe ? 'more.splitYouOweShort' : 'more.splitOwesYouShort', { name: firstName(position.name) }),
      };
    }
    default:
      return null;
  }
}

/** The value at the end of a module's row in the groups. */
function rowValue(module, state) {
  const { data, currency, extra } = state;
  switch (module) {
    case 'housekeeping': {
      const hk = data.housekeeping ?? {};
      if (hk.present) return hk.workerName ? t('more.housekeepingHere', { name: firstName(hk.workerName) }) : t('dashboard.housekeepingPresent');
      if (Number(hk.unpaidAmount) > 0) return t('more.housekeepingUnpaid', { amount: moneyText(hk.unpaidAmount, currency) });
      return '';
    }
    case 'documents': {
      const next = nextDocument(extra);
      return next ? t('more.documentShort', { title: String(next.doc.title ?? next.doc.name ?? ''), when: whenLabel(next.days) }) : '';
    }
    case 'contacts':
      return extra.counts.contacts > 0 ? getNumberFormat().format(extra.counts.contacts) : '';
    case 'inventory':
      return extra.counts.inventory > 0 ? getNumberFormat().format(extra.counts.inventory) : '';
    case 'waste': {
      const next = nextPickup(data);
      return next ? t('more.wasteWhen', { when: whenLabel(next.days), types: next.types }) : '';
    }
    case 'budget': {
      const budget = data.budget ?? {};
      if (!(Number(budget.entryCount) > 0) || !(Number(budget.income) > 0)) return '';
      return t('more.budgetLeftLower', { amount: moneyText(budget.balance, currency, { whole: true }) });
    }
    case 'health': {
      const next = data.health?.nextDose;
      return next?.name ? (next.time ? `${next.name} ${formatTime(next.time)}` : next.name) : '';
    }
    case 'notes':
      return Number(data.notesTotal) > 0 ? getNumberFormat().format(Number(data.notesTotal)) : '';
    case 'birthdays': {
      const next = (Array.isArray(data.birthdays) ? data.birthdays : [])[0];
      if (!next) return '';
      const date = String(next.next_date ?? '').slice(0, 10);
      return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${next.name} · ${shortDate(date).split(' ').slice(1).join(' ')}` : String(next.name ?? '');
    }
    default:
      return '';
  }
}

function pinsFor(state) {
  const candidates = PIN_IDS.filter((id) => state.on(PIN_MODULE[id] ?? id));
  const chosen = Array.isArray(state.pins) ? state.pins.filter((id) => candidates.includes(id)) : null;
  return { candidates, pins: chosen ?? candidates.slice(0, PIN_MAX) };
}

// --------------------------------------------------------
// The view
// --------------------------------------------------------

function renderInboxRow(item, index) {
  const verb = item.act
    ? `<button type="button" class="more-verb" data-inbox-act="${index}" aria-label="${esc(`${item.verbLabel}: ${item.titleText}`)}">${esc(item.verbLabel)}</button>`
    : `<a class="more-verb" href="${esc(item.route)}" data-route="${esc(item.route)}" aria-label="${esc(`${item.verbLabel}: ${item.titleText}`)}">${esc(item.verbLabel)}</a>`;
  return `
    <li data-inbox-key="${esc(item.key)}">
      <div class="more-row more-row--two">
        <span class="more-row__glyph">${icon(item.glyph)}</span>
        <a class="more-row__link" href="${esc(item.route)}" data-route="${esc(item.route)}">
          <span class="more-row__body">
            <span class="more-row__title">${item.title}</span>
            ${item.meta ? `<span class="more-row__meta">${esc(item.meta)}</span>` : ''}
          </span>
        </a>
        ${verb}
      </div>
    </li>`;
}

function renderInbox(items, { expanded }) {
  if (!items.length) return '';
  const visible = expanded ? items : items.slice(0, INBOX_VISIBLE);
  const rest = items.slice(INBOX_VISIBLE);
  const expander = rest.length && !expanded
    ? `<li>
        <button type="button" class="more-row more-row--expander" data-inbox-expand aria-expanded="false" aria-controls="more-inbox-list">
          <span class="more-row__glyph" aria-hidden="true"></span>
          <span class="more-row__body"><span class="more-row__title">${esc(t('more.inboxMore', { count: rest.length, first: rest[0].shortText ?? rest[0].titleText }))}</span></span>
          <span class="more-row__chevron" aria-hidden="true">${icon('chevron-down')}</span>
        </button>
      </li>`
    : '';
  return `
    <section class="more-section" aria-labelledby="more-inbox-title">
      <div class="more-section__head">
        <h2 class="more-section__title" id="more-inbox-title">${esc(t('more.inboxTitle'))}<span class="more-section__count">${esc(getNumberFormat().format(items.length))}</span></h2>
      </div>
      <ul class="more-card" id="more-inbox-list">
        ${visible.map((item, index) => renderInboxRow(item, index)).join('')}
        ${expander}
      </ul>
    </section>`;
}

function avatarHtml(user, household) {
  const token = personToken(user ?? {}, household);
  const style = `--avatar-ink: ${token.ink}; --avatar-tint: ${token.tint}`;
  if (user?.avatar_data) {
    return `<span class="more-avatar" aria-hidden="true" style="${esc(style)}"><img src="${esc(user.avatar_data)}" alt=""></span>`;
  }
  const initial = [...firstName(user?.display_name)][0] ?? '?';
  return `<span class="more-avatar" aria-hidden="true" style="${esc(style)}">${esc(initial.toLocaleUpperCase(getLocale()))}</span>`;
}

function renderProfile(state) {
  const { user, household } = state;
  const size = getHouseholdSize() ?? (household.length || null);
  const role = user?.role === 'admin' ? t('more.roleAdmin') : t('more.roleMember');
  const meta = size ? `${role} · ${t('more.peopleAtHome', { count: size })}` : role;
  const name = user?.display_name ?? '';
  return `
    <a class="more-profile" href="/settings?view=domains" data-route="/settings?view=domains"
      aria-label="${esc(t('more.profileLabel', { name, meta }))}">
      ${avatarHtml(user, household)}
      <span class="more-row__body">
        <span class="more-profile__name">${esc(name)}</span>
        <span class="more-row__meta">${esc(meta)}</span>
      </span>
      ${chevron()}
    </a>`;
}

function renderTiles(state) {
  const { candidates, pins } = pinsFor(state);
  if (!candidates.length) return '';
  const tiles = pins.map((id) => buildTile(id, state)).filter(Boolean);
  const body = tiles.length
    ? `<ul class="more-tiles">
        ${tiles.map((tile) => `
        <li>
          <a class="more-tile" href="${esc(tile.route)}" data-route="${esc(tile.route)}"${tile.ariaValue ? ` aria-label="${esc(`${tile.label}: ${tile.ariaValue}${tile.note ? `, ${tile.note}` : ''}`)}"` : ''}>
            <span class="more-tile__label">${icon(tile.glyph)}<span>${esc(tile.label)}</span></span>
            <span class="more-tile__text">
              <span class="more-tile__value">${tile.value}</span>
              ${tile.note ? `<span class="more-tile__note">${esc(tile.note)}</span>` : ''}
            </span>
          </a>
        </li>`).join('')}
      </ul>`
    : `<p class="more-row__meta more-tiles__empty">${esc(t('more.pinnedQuiet'))}</p>`;
  return `
    <section class="more-section" aria-labelledby="more-pinned-title">
      <div class="more-section__head">
        <h2 class="more-section__title" id="more-pinned-title">${esc(t('more.pinnedTitle'))}</h2>
        <button type="button" class="more-plain" data-more-action="pins" aria-haspopup="dialog" aria-label="${esc(t('more.pinnedEditLabel'))}">${esc(t('more.pinnedEdit'))}</button>
      </div>
      ${body}
    </section>`;
}

function moduleRow(dest, state) {
  const value = rowValue(dest.module, state);
  const glyph = GLYPH[dest.module] ?? dest.icon ?? 'box';
  const href = dest.navHref ?? dest.path;
  return `
    <li>
      <a class="more-row" href="${esc(href)}" data-route="${esc(href)}">
        <span class="more-row__glyph">${icon(glyph)}</span>
        <span class="more-row__body"><span class="more-row__title">${esc(dest.label)}</span></span>
        ${value ? `<span class="more-row__value">${esc(value)}</span>` : ''}
        ${chevron()}
      </a>
    </li>`;
}

function renderGroups(state) {
  const destinations = moreDestinations(state.destinations);
  return GROUPS.map((group) => {
    const rows = destinations.filter((d) => groupOf(d.module) === group.id);
    if (!rows.length) return '';
    // Known modules in the artboard's order, extensions after them.
    rows.sort((a, b) => {
      const ia = group.modules.indexOf(a.module);
      const ib = group.modules.indexOf(b.module);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return `
      <section class="more-group" aria-labelledby="more-group-${group.id}">
        <h2 class="more-group__title" id="more-group-${group.id}">${esc(t(group.labelKey))}</h2>
        <ul class="more-card">${rows.map((d) => moduleRow(d, state)).join('')}</ul>
      </section>`;
  }).join('');
}

function renderKitchen(state) {
  if (state.user?.access_scope === 'display') return '';
  const admin = state.user?.role === 'admin';
  return `
    <section class="more-group" aria-labelledby="more-group-tablet">
      <h2 class="more-group__title" id="more-group-tablet">${esc(t('more.groupTablet'))}</h2>
      <ul class="more-card">
        <li>
          <button type="button" class="more-row more-row--accent" data-more-action="wall">
            <span class="more-row__glyph">${icon('tablet')}</span>
            <span class="more-row__body"><span class="more-row__title">${esc(t('more.wallStart'))}</span></span>
          </button>
        </li>
        ${admin ? `
        <li>
          <a class="more-row" href="/settings/admin/displays" data-route="/settings/admin/displays">
            <span class="more-row__glyph">${icon('tablet-smartphone')}</span>
            <span class="more-row__body"><span class="more-row__title">${esc(t('more.tabletSettings'))}</span></span>
            ${chevron()}
          </a>
        </li>` : ''}
      </ul>
    </section>`;
}

function renderSystem() {
  return `
    <ul class="more-card">
      <li>
        <a class="more-row" href="/settings?view=domains" data-route="/settings?view=domains">
          <span class="more-row__glyph">${icon('settings')}</span>
          <span class="more-row__body"><span class="more-row__title">${esc(t('nav.settings'))}</span></span>
          ${chevron()}
        </a>
      </li>
      <li>
        <button type="button" class="more-row" data-more-action="help" aria-haspopup="dialog">
          <span class="more-row__glyph">${icon('circle-help')}</span>
          <span class="more-row__body"><span class="more-row__title">${esc(t('nav.help'))}</span></span>
        </button>
      </li>
      <li>
        <button type="button" class="more-row" data-more-action="changelog" aria-haspopup="dialog">
          <span class="more-row__glyph">${icon('history')}</span>
          <span class="more-row__body"><span class="more-row__title">${esc(t('nav.changelog'))}</span></span>
        </button>
      </li>
    </ul>`;
}

function renderSearch() {
  return `
    <button type="button" class="more-search" data-more-action="search" aria-label="${esc(t('more.searchLabel'))}">
      <span class="more-search__field">${icon('search')}<span>${esc(t('more.searchLabel'))}</span></span>
    </button>`;
}

function renderContent(state) {
  return `
    ${renderSearch()}
    ${renderInbox(state.inbox, { expanded: state.inboxExpanded })}
    ${renderProfile(state)}
    ${renderTiles(state)}
    ${renderGroups(state)}
    ${renderKitchen(state)}
    ${renderSystem()}`;
}

function renderSkeleton() {
  return `
    ${renderSearch()}
    <div class="more-skeleton" aria-hidden="true">
      <div class="skeleton more-skeleton__card"></div>
      <div class="more-skeleton__tiles"><div class="skeleton more-skeleton__tile"></div><div class="skeleton more-skeleton__tile"></div></div>
    </div>`;
}

// --------------------------------------------------------
// Loading
// --------------------------------------------------------

function currentMonthKey(offset = 0) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function loadExtra(data, on) {
  const extra = { unpaidVisits: [], documents: [], counts: {} };
  const jobs = [];
  // Unpaid visits: this month and the last one (a visit on the 31st is paid in
  // the next). Only asked when the dashboard says there is money open.
  if (on('housekeeping') && data.housekeeping?.configured && data.housekeeping.unpaidAmount !== null) {
    for (const month of [currentMonthKey(-1), currentMonthKey(0)]) {
      jobs.push(api.get(`/housekeeping/visits?month=${month}`).then((res) => {
        const visits = Array.isArray(res?.data?.visits) ? res.data.visits : [];
        extra.unpaidVisits.push(...visits.filter((v) => v.check_out && !v.paid_at && Number(v.total_amount) > 0));
      }).catch(() => {}));
    }
  }
  if (on('documents')) {
    jobs.push(api.get(`/documents?expiring=${DOCUMENT_SOON_DAYS}`).then((res) => {
      extra.documents = Array.isArray(res?.data) ? res.data : [];
    }).catch(() => {}));
  }
  await Promise.all(jobs);
  return extra;
}

/** The counts after the first paint: a list fetch each, so they come last. */
async function loadCounts(on, counts) {
  const jobs = [];
  if (on('contacts')) {
    jobs.push(api.get('/contacts').then((res) => {
      if (Array.isArray(res?.data)) counts.contacts = res.data.length;
    }).catch(() => {}));
  }
  if (on('inventory')) {
    jobs.push(api.get('/inventory/items').then((res) => {
      const items = Array.isArray(res?.data) ? res.data : (Array.isArray(res?.data?.items) ? res.data.items : null);
      if (items) counts.inventory = items.length;
    }).catch(() => {}));
  }
  await Promise.all(jobs);
}

// --------------------------------------------------------
// The pin sheet ("Edytuj")
// --------------------------------------------------------

function openPinSheet(state, onSaved) {
  const { candidates, pins } = pinsFor(state);
  let chosen = [...pins];
  const label = (id) => (id === 'split-expenses' ? t('splitExpenses.title') : t(`nav.${id}`));
  const row = (id) => `
    <li>
      <div class="more-row">
        <span class="more-row__glyph">${icon(GLYPH[id] ?? 'box')}</span>
        <span class="more-row__body"><span class="more-row__title">${esc(label(id))}</span></span>
        <button type="button" class="more-switch" role="switch" data-pin="${esc(id)}"
          aria-checked="${chosen.includes(id) ? 'true' : 'false'}" aria-label="${esc(label(id))}"
          ${!chosen.includes(id) && chosen.length >= PIN_MAX ? 'disabled' : ''}><span class="more-switch__track"><span class="more-switch__knob"></span></span></button>
      </div>
    </li>`;
  openModal({
    title: t('more.pinnedTitle'),
    content: `
      <div class="more-pin-sheet">
        <p class="more-pin-sheet__hint">${esc(t('more.pinnedHint', { count: PIN_MAX }))}</p>
        <ul class="more-card">${candidates.map(row).join('')}</ul>
      </div>`,
    size: 'md',
    dirtyGuard: false,
    initialFocus: 'none',
    headerAction: { label: t('today.customizeDone'), onClick: () => closeModal() },
    onSave: (panel) => {
      panel.addEventListener('click', async (event) => {
        const sw = event.target.closest('[data-pin]');
        if (!sw || sw.disabled) return;
        const id = sw.dataset.pin;
        const next = chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id];
        const ordered = PIN_IDS.filter((x) => next.includes(x));
        const before = chosen;
        chosen = ordered;
        const sync = () => {
          for (const el of panel.querySelectorAll('[data-pin]')) {
            const on = chosen.includes(el.dataset.pin);
            el.setAttribute('aria-checked', on ? 'true' : 'false');
            el.disabled = !on && chosen.length >= PIN_MAX;
          }
        };
        sync();
        try {
          await api.put('/preferences', { more_pins: chosen });
          state.pins = chosen;
          onSaved();
        } catch (error) {
          chosen = before;
          sync();
          showToast(error?.message || t('common.errorGeneric'), 'danger');
        }
      });
    },
  });
}

// --------------------------------------------------------
// Render
// --------------------------------------------------------

export async function render(container, { user, signal: routeSignal = null } = {}) {
  if (routeSignal?.aborted) return;
  const controller = createPageController(routeSignal);
  const { signal } = controller;

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', renderAppPage({
    mode: 'reading',
    className: 'more-page',
    legacyAlias: false,
    header: renderPageHeader({ className: 'more-toolbar', title: renderPageTitle(esc(t('nav.more'))) }),
    body: renderPageBody({ className: 'more', content: renderSkeleton() }),
  }));
  const body = container.querySelector('.more');
  window.lucide?.createIcons({ el: body });

  const destinations = window.yuvomi?.navDestinations?.() ?? [];
  const enabled = new Set(destinations.map((d) => d.module));
  const on = (module) => enabled.has(module);

  const state = {
    user, destinations, on, data: {}, currency: 'EUR', household: [], pins: null,
    extra: { unpaidVisits: [], documents: [], counts: {} }, inbox: [], inboxExpanded: false,
  };

  const paint = () => {
    if (signal.aborted || !body.isConnected) return;
    state.inbox = buildInbox(state);
    const focusKey = document.activeElement?.closest?.('[data-inbox-key]')?.dataset.inboxKey;
    body.replaceChildren();
    body.insertAdjacentHTML('beforeend', renderContent(state));
    window.lucide?.createIcons({ el: body });
    if (focusKey) body.querySelector(`[data-inbox-key="${CSS.escape(focusKey)}"] a, [data-inbox-key="${CSS.escape(focusKey)}"] button`)?.focus({ preventScroll: true });
  };

  const load = async () => {
    const [dashboard, prefs] = await Promise.all([
      api.get('/dashboard'),
      api.get('/preferences').catch(() => null),
    ]);
    state.data = dashboard ?? {};
    state.household = Array.isArray(dashboard?.users) ? dashboard.users : [];
    state.currency = prefs?.data?.currency ?? 'EUR';
    state.pins = Array.isArray(prefs?.data?.more_pins) ? prefs.data.more_pins : null;
    const counts = state.extra.counts;
    state.extra = await loadExtra(state.data, on);
    state.extra.counts = counts;
  };

  try {
    await load();
  } catch (error) {
    if (signal.aborted) return;
    body.replaceChildren();
    body.insertAdjacentHTML('beforeend', `${renderSearch()}<p class="more-row__meta" role="alert">${esc(error?.message || t('common.errorGeneric'))}</p>`);
    window.lucide?.createIcons({ el: body });
  }
  if (signal.aborted) return;
  paint();
  loadCounts(on, state.extra.counts).then(() => { if (!signal.aborted) paint(); });

  body.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-more-action]')?.dataset.moreAction;
    if (action === 'search') window.yuvomi?.openSearch?.();
    if (action === 'help') window.yuvomi?.showHelp?.();
    if (action === 'changelog') window.yuvomi?.showChangelog?.();
    if (action === 'pins') openPinSheet(state, paint);
    if (action === 'wall') {
      enterWallMode();
      window.yuvomi?.navigate?.('/');
      showToast(t('dashboard.wallEntered', { action: t('dashboard.wallExit') }), 'default', 8000);
    }

    if (event.target.closest('[data-inbox-expand]')) {
      state.inboxExpanded = true;
      paint();
      body.querySelectorAll('[data-inbox-key]')[INBOX_VISIBLE]?.querySelector('a, button')?.focus();
      return;
    }

    const actButton = event.target.closest('[data-inbox-act]');
    if (actButton) {
      const item = state.inbox[Number(actButton.dataset.inboxAct)];
      if (!item?.act) return;
      actButton.disabled = true;
      try {
        const result = await item.act();
        await load().catch(() => {});
        paint();
        window.yuvomi?.invalidateModuleCounts?.();
        showToast(result.message, 'success', 5000, result.undo ? async () => {
          try {
            await result.undo();
            await load().catch(() => {});
            paint();
          } catch (error) {
            showToast(error?.message || t('common.errorGeneric'), 'danger');
          }
        } : null);
      } catch (error) {
        if (actButton.isConnected) actButton.disabled = false;
        showToast(error?.message || t('common.errorGeneric'), 'danger');
      }
    }
  }, { signal });
}

export const __test = { buildInbox, buildTile, rowValue, pinsFor, moreDestinations, tHtml, daysList, whenLabel };
