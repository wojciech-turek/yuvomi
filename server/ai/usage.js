/**
 * Modul: AI - usage and cost cap
 * Zweck: Logs every model call (tokens and dollars) and refuses new calls once
 *        the month's spend reaches the household's cap. The month is the
 *        calendar month in UTC; at household scale the hour's difference at the
 *        turn of the month does not matter.
 */

import * as db from '../db.js';
import { aiSettings } from './settings.js';
import { AiError } from './errors.js';

/** First instant of the current UTC month, in the format created_at uses. */
export function monthStart(now = new Date()) {
  return `${now.toISOString().slice(0, 7)}-01T00:00:00Z`;
}

export function recordUsage({ feature, provider, model, usage = {}, usd = 0, userId = null }) {
  db.get().prepare(`
    INSERT INTO ai_usage (feature, provider, model, input_count, output_count, usd, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(feature, provider, model, usage.input_tokens ?? 0, usage.output_tokens ?? 0, usd, userId);
}

export function monthUsd(now = new Date()) {
  return db.get().prepare('SELECT COALESCE(SUM(usd), 0) AS usd FROM ai_usage WHERE created_at >= ?').get(monthStart(now)).usd;
}

export function usageSummary(now = new Date()) {
  const byFeature = db.get().prepare(`
    SELECT feature, COUNT(*) AS calls, COALESCE(SUM(usd), 0) AS usd
    FROM ai_usage WHERE created_at >= ? GROUP BY feature ORDER BY usd DESC
  `).all(monthStart(now));
  return { monthUsd: byFeature.reduce((sum, r) => sum + r.usd, 0), capUsd: aiSettings().capUsd, byFeature };
}

/**
 * Throws an AiError when a call for this feature may not run: AI switched off,
 * the feature switched off, or the month's cap reached. 'admin-test' bypasses
 * the feature switches (the settings page's connection test) but not the cap.
 */
export function guard(feature) {
  const s = aiSettings();
  if (feature !== 'admin-test') {
    if (!s.enabled) throw new AiError('disabled', 'AI is switched off.');
    if (s.features[feature] === false) throw new AiError('disabled', 'This AI feature is switched off.');
  }
  if (monthUsd() >= s.capUsd) throw new AiError('cap_reached', 'The monthly AI limit is reached.');
}
