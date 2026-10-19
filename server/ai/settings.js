/**
 * Modul: AI - settings
 * Zweck: The household's AI switches: a master switch (off by default), the API
 *        keys, the model for bigger jobs, a monthly cost cap and one switch per
 *        feature. Stored in sync_config; an env var overrides a stored key (like
 *        IMMICH_API_KEY), and the API only ever reports whether a key is set.
 *
 * Models: quick work always runs on Haiku 5.5; bigger jobs (photos, meal ideas)
 * on Sonnet 5.5 unless the household switches them to Haiku. Never Opus.
 */

import * as db from '../db.js';
import { MODELS } from './claude.js';

export const FEATURES = Object.freeze([
  'shopping_smart',   // aisle for new items, "probably needed" chips
  'meal_ingredients', // ingredient suggestions for a meal
  'pantry_photo',     // add pantry items from a photo
  'meal_ideas',       // ideas for empty meal slots
  'nudges',           // a daily heads-up when something matters
  'questions',        // an occasional question that teaches the memory
]);

export const SMART_MODELS = Object.freeze([MODELS.smart, MODELS.fast]);
export const DEFAULT_CAP_USD = 5;
export const MAX_CAP_USD = 200;

const KEY = {
  enabled: 'ai_enabled',
  anthropicKey: 'ai_anthropic_api_key',
  jevKey: 'ai_jev_api_key',
  cap: 'ai_monthly_cap_usd',
  smartModel: 'ai_smart_model',
  features: 'ai_features',
};

function cfgGet(key) {
  return db.get().prepare('SELECT value FROM sync_config WHERE key = ?').get(key)?.value ?? '';
}

function cfgSet(key, value) {
  db.get().prepare(`INSERT INTO sync_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`).run(key, value);
}

function envAnthropicKey() {
  return String(process.env.ANTHROPIC_API_KEY || '').trim();
}

function envJevKey() {
  return String(process.env.TYPESAFE_API_KEY || '').trim();
}

/** The full settings, keys included. Server-side only; never send this to a browser. */
export function aiSettings() {
  let features = {};
  try { features = JSON.parse(cfgGet(KEY.features) || '{}'); } catch { features = {}; }
  const capRaw = Number.parseFloat(cfgGet(KEY.cap));
  const smart = cfgGet(KEY.smartModel);
  return {
    enabled: cfgGet(KEY.enabled) === '1',
    anthropicKey: envAnthropicKey() || cfgGet(KEY.anthropicKey).trim(),
    jevKey: envJevKey() || cfgGet(KEY.jevKey).trim(),
    capUsd: Number.isFinite(capRaw) && capRaw >= 0 ? capRaw : DEFAULT_CAP_USD,
    smartModel: SMART_MODELS.includes(smart) ? smart : MODELS.smart,
    // A feature is on unless switched off: the master switch is the real opt-in.
    features: Object.fromEntries(FEATURES.map((f) => [f, features[f] !== false])),
    envControlled: { anthropicKey: Boolean(envAnthropicKey()), jevKey: Boolean(envJevKey()) },
  };
}

/** What a browser may see: no keys, only whether they are set. */
export function publicSettings() {
  const s = aiSettings();
  return {
    enabled: s.enabled,
    anthropicKeySet: Boolean(s.anthropicKey),
    jevKeySet: Boolean(s.jevKey),
    capUsd: s.capUsd,
    smartModel: s.smartModel,
    smartModels: [...SMART_MODELS],
    features: s.features,
    envControlled: s.envControlled,
  };
}

/** True when the household switched AI on and this feature is not switched off. */
export function featureOn(feature) {
  const s = aiSettings();
  return s.enabled && s.features[feature] !== false;
}

/**
 * Applies a settings patch from the admin page. Unknown fields are ignored;
 * env-controlled keys cannot be changed here.
 * @returns {string|null} an error sentence, or null when saved
 */
export function updateSettings(body = {}) {
  if (body.capUsd !== undefined) {
    const cap = Number(body.capUsd);
    if (!Number.isFinite(cap) || cap < 0 || cap > MAX_CAP_USD) return `The monthly limit must be between 0 and ${MAX_CAP_USD} USD.`;
  }
  if (body.smartModel !== undefined && !SMART_MODELS.includes(body.smartModel)) return 'Unknown model.';
  for (const field of ['anthropicKey', 'jevKey']) {
    if (typeof body[field] === 'string' && body[field].length > 500) return 'The API key is too long.';
  }

  if (typeof body.enabled === 'boolean') cfgSet(KEY.enabled, body.enabled ? '1' : '0');
  if (body.capUsd !== undefined) cfgSet(KEY.cap, String(Number(body.capUsd)));
  if (body.smartModel !== undefined) cfgSet(KEY.smartModel, body.smartModel);
  if (typeof body.anthropicKey === 'string' && body.anthropicKey.trim() && !envAnthropicKey()) cfgSet(KEY.anthropicKey, body.anthropicKey.trim());
  if (body.clearAnthropicKey === true && !envAnthropicKey()) cfgSet(KEY.anthropicKey, '');
  if (typeof body.jevKey === 'string' && body.jevKey.trim() && !envJevKey()) cfgSet(KEY.jevKey, body.jevKey.trim());
  if (body.clearJevKey === true && !envJevKey()) cfgSet(KEY.jevKey, '');
  if (body.features && typeof body.features === 'object') {
    const current = aiSettings().features;
    for (const f of FEATURES) if (typeof body.features[f] === 'boolean') current[f] = body.features[f];
    cfgSet(KEY.features, JSON.stringify(current));
  }
  return null;
}
