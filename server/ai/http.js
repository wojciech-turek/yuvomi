/**
 * Modul: AI - HTTP answers
 * Zweck: One way for every route to answer an AI failure: the AiError's status
 *        and a stable `reason` (`ai_cap_reached`, `ai_not_configured`, ...) the
 *        browser turns into a sentence. Anything else is logged and a 500.
 */

import { createLogger } from '../logger.js';
import { AiError, AI_ERROR_STATUS } from './errors.js';

const log = createLogger('AI');

export function sendAiError(res, err, context = 'AI') {
  if (err instanceof AiError) {
    const status = AI_ERROR_STATUS[err.code] ?? 502;
    if (status >= 500) log.warn(`${context}: ${err.code}`);
    return res.status(status).json({ error: err.message, code: status, reason: `ai_${err.code}` });
  }
  log.error(`${context} error:`, err?.message || err);
  return res.status(500).json({ error: 'Internal server error.', code: 500 });
}
