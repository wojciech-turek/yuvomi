/**
 * Modul: AI - Claude client
 * Zweck: One call shape for every Claude feature: a system prompt, user content
 *        (text and optional images) and a JSON schema; the answer comes back as
 *        parsed JSON. Haiku 5.5 does quick work, Sonnet 5.5 does photos and
 *        planning. Opus is never used (household decision, 2026-10-19).
 * Abhängigkeiten: @anthropic-ai/sdk; settings, cost cap and usage log are passed in.
 *
 * Every call goes through `guard(feature)` first (switch, key, monthly cap) and
 * `record(...)` after, so the usage page and the cap see the real token counts.
 */

import Anthropic from '@anthropic-ai/sdk';
import { AiError } from './errors.js';

export const MODELS = Object.freeze({
  fast: 'claude-haiku-5-5',
  smart: 'claude-sonnet-5-5',
});

// USD per million tokens (platform.claude.com, checked 2026-10). Haiku's rate
// is for prompts up to 100K tokens; our prompts are far below that.
export const PRICES = Object.freeze({
  'claude-haiku-5-5': { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.10, cacheWrite: 2.5 },
});

/** Dollar cost of one response's usage block. */
export function costUsd(model, usage = {}) {
  const p = PRICES[model];
  if (!p) return 0;
  const perToken = (rate, n) => (rate * (n || 0)) / 1_000_000;
  return perToken(p.input, usage.input_tokens)
    + perToken(p.output, usage.output_tokens)
    + perToken(p.cacheRead, usage.cache_read_input_tokens)
    + perToken(p.cacheWrite, usage.cache_creation_input_tokens);
}

/**
 * @param {object} deps
 * @param {() => string|null} deps.getApiKey
 * @param {(feature: string) => void} deps.guard - throws AiError when the call may not run
 * @param {(entry: object) => void} deps.record - logs usage and cost
 * @param {() => {fast: string, smart: string}} [deps.getModels]
 * @param {(apiKey: string) => object} [deps.clientFactory] - for tests
 */
export function createClaude({ getApiKey, guard, record, getModels = () => MODELS, clientFactory }) {
  const makeClient = clientFactory ?? ((apiKey) => new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000 }));
  let cached = { key: null, client: null };

  function client() {
    const key = getApiKey();
    if (!key) throw new AiError('not_configured', 'No Anthropic API key is set.');
    if (cached.key !== key) cached = { key, client: makeClient(key) };
    return cached.client;
  }

  /**
   * @param {object} opts
   * @param {string} opts.feature - usage label, e.g. 'meal-ingredients'
   * @param {'fast'|'smart'} [opts.tier]
   * @param {string} opts.system
   * @param {string} opts.text - the user message text
   * @param {{mediaType: string, data: string}[]} [opts.images] - base64 images
   * @param {object} opts.schema - JSON schema of the answer (object at the root)
   * @param {number} [opts.maxTokens]
   * @param {'low'|'medium'|'high'} [opts.effort]
   * @param {number|null} [opts.userId] - who asked, for the usage log
   */
  async function json({ feature, tier = 'fast', system, text, images = [], schema, maxTokens = 2000, effort = 'low', userId = null }) {
    guard(feature);
    const api = client();
    const model = getModels()[tier] ?? MODELS[tier];
    const content = [
      ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
      { type: 'text', text },
    ];
    const params = {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content }],
      output_config: { effort, format: { type: 'json_schema', schema } },
    };
    // Haiku answers short structured questions; thinking would only add latency.
    // Sonnet keeps adaptive thinking (it cannot be disabled there) at low effort.
    if (model === MODELS.fast) params.thinking = { type: 'disabled' };

    let res;
    try {
      res = await api.messages.create(params);
    } catch (err) {
      throw AiError.fromProvider(err);
    }
    record({ feature, provider: 'anthropic', model, usage: res.usage, usd: costUsd(model, res.usage), userId });
    if (res.stop_reason === 'refusal') throw new AiError('refused', 'The model declined this request.');
    if (res.stop_reason === 'max_tokens') throw new AiError('truncated', 'The answer was cut off.');
    const out = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    try {
      return JSON.parse(out);
    } catch {
      throw new AiError('bad_output', 'The model returned malformed JSON.');
    }
  }

  return { json };
}
