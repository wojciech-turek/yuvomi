/**
 * Modul: AI - Jev client (TypeSafe "System One")
 * Zweck: Fast typed decisions with probabilities instead of generated text:
 *        which aisle a new shopping item belongs to, whether two names mean the
 *        same product. Answers arrive in ~0.1-0.5 s, cheap enough to call while
 *        someone is adding an item.
 * API: POST https://api.typesafe.ai/v1/systemone (docs.typesafe.ai, quick start)
 *   body { model, state, questions: { id: { type: 'choice', instructions, criteria: { label: description } } } }
 *   answer { model, answers: { id: { type, choice, confidence, probabilities } }, usage }
 *
 * Jev is optional: without a key every caller falls back to history or Haiku.
 */

import { AiError } from './errors.js';

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
export const JEV_PRICE_PER_MTOK = 0.042; // input only; output is free

/**
 * @param {object} deps
 * @param {() => string|null} deps.getApiKey
 * @param {(feature: string) => void} deps.guard
 * @param {(entry: object) => void} deps.record
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {number} [deps.timeoutMs]
 */
export function createJev({ getApiKey, guard, record, fetchImpl = globalThis.fetch, timeoutMs = 4000 }) {
  function configured() {
    return Boolean(getApiKey());
  }

  /**
   * Picks one option. Returns { choice, confidence, probabilities }.
   * @param {object} opts
   * @param {string} opts.feature
   * @param {string|object} opts.state - what to decide about
   * @param {string} opts.instructions
   * @param {Record<string, string>} opts.options - label -> description
   */
  async function choose({ feature, state, instructions, options, userId = null }) {
    const answers = await ask({ feature, userId, state, questions: { pick: { type: 'choice', instructions, criteria: options } } });
    const a = answers.pick;
    if (!a || typeof a.choice !== 'string') throw new AiError('bad_output', 'Jev returned no choice.');
    return { choice: a.choice, confidence: Number(a.confidence) || 0, probabilities: a.probabilities ?? {} };
  }

  /** Probability (0-1) that a statement about `state` is true. */
  async function probability({ feature, state, instructions, userId = null }) {
    const answers = await ask({ feature, userId, state, questions: { fact: { type: 'noul', instructions } } });
    const p = Number(answers.fact?.noul);
    if (!Number.isFinite(p)) throw new AiError('bad_output', 'Jev returned no probability.');
    return p;
  }

  async function ask({ feature, userId = null, state, questions }) {
    guard(feature);
    const key = getApiKey();
    if (!key) throw new AiError('not_configured', 'No Jev API key is set.');
    let res;
    try {
      res = await fetchImpl(JEV_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: JEV_MODEL, state, questions }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw AiError.fromProvider(err);
    }
    if (!res.ok) throw AiError.fromProvider({ status: res.status });
    let body;
    try {
      body = await res.json();
    } catch {
      throw new AiError('bad_output', 'Jev returned malformed JSON.');
    }
    const usage = body.usage ?? {};
    record({
      feature,
      provider: 'jev',
      model: body.model || JEV_MODEL,
      usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 },
      usd: ((usage.input_tokens ?? 0) * JEV_PRICE_PER_MTOK) / 1_000_000,
      userId,
    });
    return body.answers ?? {};
  }

  return { configured, choose, probability };
}
