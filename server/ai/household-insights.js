/**
 * Modul: AI - what the household's history says
 * Zweck: Small, plain summaries of recent meals and purchases that the
 *        questions, the weekly learning and meal ideas put into their prompts.
 *        Names only - no people, no amounts of money, nothing from health.
 */

import * as db from '../db.js';
import { nameKey } from '../utils/name-key.js';

/** Meal titles of the last `days` days, most cooked first: [{ title, times, last }] */
export function recentMeals(days = 60, now = new Date()) {
  const from = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = db.get().prepare('SELECT title, date FROM meals WHERE date >= ? ORDER BY date DESC').all(from);
  const byKey = new Map();
  for (const r of rows) {
    const key = nameKey(r.title);
    if (!key) continue;
    const e = byKey.get(key) ?? { title: r.title, times: 0, last: r.date };
    e.times++;
    byKey.set(key, e);
  }
  return [...byKey.values()].sort((a, b) => b.times - a.times || (a.last < b.last ? 1 : -1));
}

/** Purchased item names of the last `days` days, most bought first: [{ name, times }] */
export function topPurchases(days = 90, now = new Date(), limit = 40) {
  const from = new Date(now.getTime() - days * 86_400_000).toISOString();
  return db.get().prepare(`
    SELECT MAX(name) AS name, COUNT(*) AS times FROM shopping_purchases
    WHERE purchased_at >= ? GROUP BY name_key ORDER BY times DESC LIMIT ?
  `).all(from, limit);
}

/** Pantry products with stock, names only. */
export function pantryNames(limit = 80) {
  return db.get().prepare('SELECT name FROM pantry_items WHERE quantity IS NULL OR quantity > 0 ORDER BY updated_at DESC LIMIT ?')
    .all(limit).map((r) => r.name);
}

/** A compact text block of the above for prompts. */
export function historyBlock({ meals = true, purchases = true, pantry = false } = {}) {
  const parts = [];
  if (meals) {
    const m = recentMeals().slice(0, 25);
    if (m.length) parts.push(`Posiłki z ostatnich 2 miesięcy (ile razy): ${m.map((x) => `${x.title} (${x.times})`).join(', ')}`);
  }
  if (purchases) {
    const p = topPurchases().slice(0, 30);
    if (p.length) parts.push(`Najczęstsze zakupy (ile razy): ${p.map((x) => `${x.name} (${x.times})`).join(', ')}`);
  }
  if (pantry) {
    const names = pantryNames();
    if (names.length) parts.push(`W spiżarni jest: ${names.join(', ')}`);
  }
  return parts.join('\n');
}
