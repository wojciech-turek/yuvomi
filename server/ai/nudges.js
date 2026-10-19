/**
 * Modul: AI - the daily heads-up
 * Zweck: At most one push a day, and only when something matters: nothing is
 *        planned for tomorrow although the household plans meals, or several
 *        things are probably running out. The checks are plain rules on the
 *        household's own data - no model call, no tokens - and the texts are
 *        fixed sentences in the household language, never model-written.
 *        Health data plays no part.
 */

import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { pushService } from '../services/push.js';
import { isActiveAccount } from '../services/household-members.js';
import { translate, resolveHouseholdLocale } from '../utils/i18n.js';
import { shiftDateKey } from '../utils/timezone.js';
import { nameKey } from '../utils/name-key.js';
import { groupPurchases, dueItems } from './shopping-stats.js';

const log = createLogger('AI');
const MAIN_MEALS = ['lunch', 'dinner'];

/** Does the household plan meals at all? (3+ in the last two weeks) */
function plansMeals(today) {
  return db.get().prepare('SELECT COUNT(*) AS c FROM meals WHERE date >= ? AND date <= ?').get(shiftDateKey(today, -14), today).c >= 3;
}

function tomorrowHasMainMeal(tomorrow) {
  return Boolean(db.get().prepare(`SELECT 1 FROM meals WHERE date = ? AND meal_type IN (${MAIN_MEALS.map(() => '?').join(',')})`).get(tomorrow, ...MAIN_MEALS));
}

function dueShopping(nowMs) {
  const recent = db.get().prepare('SELECT COUNT(*) AS c FROM shopping_purchases WHERE purchased_at >= ?').get(new Date(nowMs - 30 * 86_400_000).toISOString()).c;
  if (recent < 10) return [];
  const purchases = db.get().prepare('SELECT name, name_key, category, quantity, purchased_at FROM shopping_purchases WHERE purchased_at >= ?')
    .all(new Date(nowMs - 365 * 86_400_000).toISOString());
  const open = new Set(db.get().prepare('SELECT name FROM shopping_items WHERE is_checked = 0').all().map((r) => nameKey(r.name)));
  return dueItems(groupPurchases(purchases), nowMs, open, 3);
}

/**
 * The one thing worth saying today, or null.
 * @param {{today: string, now?: Date, features: {nudges: boolean, shopping_smart: boolean}}} opts
 * @returns {{kind: string, title: string, body: string, url: string}|null}
 */
export function pickNudge({ today, now = new Date(), features }) {
  if (!features.nudges) return null;
  const locale = resolveHouseholdLocale(db.get());
  const tomorrow = shiftDateKey(today, 1);
  if (plansMeals(today) && !tomorrowHasMainMeal(tomorrow)) {
    return {
      kind: 'no-plan',
      title: translate(locale, 'ai.pushNoPlanTitle'),
      body: translate(locale, 'ai.pushNoPlanBody'),
      url: `/meals?ideas=${tomorrow}`,
    };
  }
  if (features.shopping_smart) {
    const due = dueShopping(now.getTime());
    if (due.length >= 3) {
      return {
        kind: 'running-low',
        title: translate(locale, 'ai.pushRunningLowTitle'),
        body: translate(locale, 'ai.pushRunningLowBody', { items: due.map((d) => d.name).join(', ') }),
        url: '/shopping',
      };
    }
  }
  return null;
}

/** Adults with a push subscription. */
function recipients() {
  return db.get().prepare(`
    SELECT DISTINCT ps.user_id AS id FROM push_subscriptions ps
    JOIN users u ON u.id = ps.user_id
    WHERE COALESCE(u.family_role, '') != 'child'
  `).all().map((r) => r.id).filter((id) => isActiveAccount(id));
}

/** Sends one heads-up to every adult who gets push. Returns how many devices got it. */
export async function sendNudge(nudge) {
  let sent = 0;
  for (const userId of recipients()) {
    try {
      sent += await pushService.sendPushToUser(userId, { title: nudge.title, body: nudge.body, url: nudge.url, tag: `ai-${nudge.kind}` });
    } catch (err) {
      log.warn('heads-up push failed:', err?.message || err);
    }
  }
  return sent;
}
