/**
 * Modul: AI - errors
 * Zweck: One error type for every AI path, with a stable `code` the routes map
 *        to HTTP answers and the UI maps to a sentence.
 *
 * Codes: disabled (switch off), not_configured (no key), cap_reached (monthly
 * limit), rate_limited, provider_error, refused, truncated, bad_output, timeout.
 */

export class AiError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'AiError';
    this.code = code;
  }

  /** Maps an SDK or fetch failure to an AiError without leaking the key or body. */
  static fromProvider(err) {
    if (err instanceof AiError) return err;
    const status = err?.status ?? err?.statusCode;
    if (status === 401 || status === 403) return new AiError('not_configured', 'The API key was rejected.');
    if (status === 429) return new AiError('rate_limited', 'The provider is rate limiting requests.');
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || /timed? ?out/i.test(err?.message ?? '')) {
      return new AiError('timeout', 'The provider did not answer in time.');
    }
    return new AiError('provider_error', `Provider error${status ? ` (${status})` : ''}.`);
  }
}

/** HTTP status for each code; the body carries `reason: code`. */
export const AI_ERROR_STATUS = Object.freeze({
  disabled: 409,
  not_configured: 409,
  cap_reached: 429,
  rate_limited: 429,
  refused: 422,
  truncated: 502,
  bad_output: 502,
  timeout: 504,
  provider_error: 502,
});
