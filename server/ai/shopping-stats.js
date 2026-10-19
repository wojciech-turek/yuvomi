/**
 * Modul: AI - shopping statistics
 * Zweck: What the household buys, how often, and what is probably due again,
 *        learned from the purchase log. Pure functions: callers pass the rows
 *        and "now", nothing here reads the clock or the database.
 *
 * WHY STATISTICS AND NOT A MODEL: on repeat-purchase data like groceries,
 * frequency and inter-purchase intervals are rarely beaten by learned models,
 * and they explain themselves ("every ~5 days, last 6 days ago").
 */

const DAY_MS = 86_400_000;
/** A purchase from 60 days ago counts about a third of one from today. */
const RECENCY_DAYS = 60;

/** SQLite's datetime('now') ("2026-10-19 08:15:00") is UTC without a zone mark. */
function toMs(value) {
  if (typeof value === 'number') return value;
  const s = String(value ?? '');
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Groups purchase events by name key.
 * @param {{name_key: string, name: string, category?: string|null, quantity?: string|null, purchased_at: string}[]} events
 */
export function groupPurchases(events) {
  const byKey = new Map();
  for (const e of events) {
    const at = toMs(e.purchased_at);
    if (!e.name_key || at == null) continue;
    let g = byKey.get(e.name_key);
    if (!g) {
      g = { key: e.name_key, name: e.name, category: e.category ?? null, quantity: e.quantity ?? null, times: [], lastAt: at };
      byKey.set(e.name_key, g);
    }
    g.times.push(at);
    if (at >= g.lastAt) {
      g.lastAt = at;
      g.name = e.name;
      g.category = e.category ?? g.category;
      g.quantity = e.quantity ?? g.quantity;
    }
  }
  for (const g of byKey.values()) g.times.sort((a, b) => a - b);
  return byKey;
}

/** Recency-weighted purchase count: how strongly this item belongs to the household now. */
export function weight(times, nowMs) {
  let w = 0;
  for (const t of times) w += Math.exp(-Math.max(0, nowMs - t) / (RECENCY_DAYS * DAY_MS));
  return w;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Purchase rhythm of one item: median days between purchases (same-day repeats
 * collapse into one trip), days since the last one, and how due it is (1 = on time).
 * Needs at least three trips; returns null otherwise.
 */
export function cadence(times, nowMs) {
  const trips = [];
  for (const t of times) {
    if (!trips.length || t - trips.at(-1) >= DAY_MS / 2) trips.push(t);
  }
  if (trips.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < trips.length; i++) gaps.push((trips[i] - trips[i - 1]) / DAY_MS);
  const everyDays = median(gaps);
  if (!(everyDays >= 1)) return null;
  const sinceDays = (nowMs - trips.at(-1)) / DAY_MS;
  return { everyDays, sinceDays, due: sinceDays / everyDays, trips: trips.length };
}

/**
 * Items that are probably due again and not already open on a list.
 * @param {Map} groups - from groupPurchases
 * @param {number} nowMs
 * @param {Set<string>} openKeys - name keys currently open on any list
 * @param {number} [limit]
 */
export function dueItems(groups, nowMs, openKeys, limit = 6) {
  const out = [];
  for (const g of groups.values()) {
    if (openKeys.has(g.key)) continue;
    const c = cadence(g.times, nowMs);
    // Due from 90% of the usual gap; long overdue (3x) means the habit stopped.
    if (!c || c.due < 0.9 || c.due > 3) continue;
    out.push({ name: g.name, key: g.key, category: g.category, quantity: g.quantity, everyDays: Math.round(c.everyDays), sinceDays: Math.floor(c.sinceDays), due: c.due });
  }
  return out.sort((a, b) => b.due - a.due).slice(0, limit);
}
