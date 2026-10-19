/**
 * Modul: AI - entry point
 * Zweck: The configured Claude and Jev clients every feature uses. Both read the
 *        household's settings on each call, so a key or switch changed in the
 *        settings page applies to the next call without a restart.
 */

import { createClaude, MODELS } from './claude.js';
import { createJev } from './jev.js';
import { aiSettings } from './settings.js';
import { guard, recordUsage } from './usage.js';

export const claude = createClaude({
  getApiKey: () => aiSettings().anthropicKey,
  guard,
  record: recordUsage,
  getModels: () => ({ fast: MODELS.fast, smart: aiSettings().smartModel }),
});

export const jev = createJev({
  getApiKey: () => aiSettings().jevKey,
  guard,
  record: recordUsage,
});

export { AiError, AI_ERROR_STATUS } from './errors.js';
export { featureOn } from './settings.js';
