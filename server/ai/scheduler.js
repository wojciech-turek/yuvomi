/**
 * Modul: AI - schedule
 * Zweck: The only AI work that runs without someone asking for it, and it is
 *        small on purpose:
 *        - daily, from 17:30 household time: the heads-up (rules only, no tokens);
 *        - weekly, Sunday from 10:00: one question and the weekly learning
 *          (two short Haiku calls), and a push about the question if today's
 *          heads-up has not used the day's one push.
 *        It checks every ten minutes and remembers what it did per day/week in
 *        sync_config, so restarts never send twice.
 */

import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { runExternalJob } from '../utils/restore-state.js';
import { householdTimeZone, todayKey } from '../utils/timezone.js';
import { translate, resolveHouseholdLocale } from '../utils/i18n.js';
import { aiSettings } from './settings.js';
import { pickNudge, sendNudge } from './nudges.js';
import { generateQuestion, learnFromHistory } from './questions.js';

const log = createLogger('AI');
const DAILY_AT = { hour: 17, minute: 30 };
const WEEKLY = { weekday: 'Sun', hour: 10 };
const KEY_DAILY = 'ai_nudge_last_day';
const KEY_WEEKLY = 'ai_weekly_last';
const KEY_PUSHED = 'ai_push_last_day';

function cfgGet(key) {
  return db.get().prepare('SELECT value FROM sync_config WHERE key = ?').get(key)?.value ?? '';
}

function cfgSet(key, value) {
  db.get().prepare(`INSERT INTO sync_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`).run(key, value);
}

/** Household wall clock: { hour, minute, weekday } */
export function wallClock(now = new Date(), zone = householdTimeZone(db.get())) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { hour: Number(parts.hour), minute: Number(parts.minute), weekday: parts.weekday };
}

/** One tick. Exported for tests; `now` is injectable. */
export async function runAiTick(now = new Date()) {
  const s = aiSettings();
  if (!s.enabled) return { skipped: 'disabled' };
  const today = todayKey(db.get(), now);
  const clock = wallClock(now);
  const done = {};

  const afterDaily = clock.hour > DAILY_AT.hour || (clock.hour === DAILY_AT.hour && clock.minute >= DAILY_AT.minute);
  if (afterDaily && cfgGet(KEY_DAILY) !== today) {
    cfgSet(KEY_DAILY, today);
    const nudge = pickNudge({ today, now, features: s.features });
    if (nudge && await sendNudge(nudge) > 0) cfgSet(KEY_PUSHED, today);
    done.daily = nudge?.kind ?? 'nothing';
  }

  if (clock.weekday === WEEKLY.weekday && clock.hour >= WEEKLY.hour && cfgGet(KEY_WEEKLY) !== today && s.features.questions && s.anthropicKey) {
    cfgSet(KEY_WEEKLY, today);
    try {
      await learnFromHistory();
      const question = await generateQuestion();
      done.weekly = question ? 'question' : 'no-question';
      if (question && cfgGet(KEY_PUSHED) !== today) {
        const locale = resolveHouseholdLocale(db.get());
        const sent = await sendNudge({ kind: 'question', title: translate(locale, 'ai.pushQuestionTitle'), body: translate(locale, 'ai.pushQuestionBody'), url: '/' });
        if (sent > 0) cfgSet(KEY_PUSHED, today);
      }
    } catch (err) {
      done.weekly = `failed: ${err?.code || err?.message || err}`;
      log.warn('weekly AI run failed:', err?.code || err?.message || err);
    }
  }
  return done;
}

export function startAiScheduler() {
  const run = () => {
    runExternalJob(() => runAiTick()).catch((err) => log.error('AI scheduler error:', err?.message || err));
  };
  setTimeout(run, 30_000).unref();
  setInterval(run, 10 * 60_000).unref();
  log.info('AI scheduler active (every 10 min; off while AI is switched off).');
}
