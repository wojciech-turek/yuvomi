/**
 * Modul: Powiedz (Quick-add)
 * Zweck: POST /api/v1/quick-add/parse - ein gesprochener oder getippter Satz
 *        wird zu den Feldern einer Aufgabe, eines Termins oder von Einkaeufen
 *        (services/quick-add.js). Gespeichert wird nichts.
 * Abhängigkeiten: express, server/db.js, server/ai
 *
 * RECHTE STEHEN HIER, NICHT NUR IM PFAD-GUARD. `/quick-add` gehoert keinem
 * Modul (server/scopes.js): ein gescoptes Token und ein Wandtablett kommen am
 * globalen Guard nicht vorbei, ein Mitglied mit nur Leserechten aber schon.
 * Die Route fragt deshalb selbst `mayWriteModule()` fuer jede Art.
 */

import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { mayWriteModule } from '../permissions.js';
import { refuseWallWrite } from '../services/wall-settings.js';
import { AiError, claude } from '../ai/index.js';
import { KIND_MODULE, QUICK_ADD_KINDS, parseQuickAddSentence } from '../services/quick-add.js';

const log = createLogger('QuickAdd');

// Derselbe Satz wie der Modul-Guard in server/index.js: die App uebersetzt
// ueber den Grund (public/utils/friendly-error.js).
const READ_ONLY = { error: 'You have read-only access to this module.', code: 403, reason: 'module_read_only' };

/**
 * @param {{ client?: { json: Function } }} [deps] - the Claude client (tests pass a fake)
 */
export function createQuickAddRouter({ client = claude } = {}) {
  const router = express.Router();

  // --------------------------------------------------------
  // POST /api/v1/quick-add/parse (One Today, 2026-11-02)
  // Body: { text: string (1-500 after trim), kind?: 'task'|'event'|'shopping' }
  // "Powiedz": one sentence, one Haiku call, the kind and its fields. `kind`
  // is a sheet's own mic and forces that kind. Nothing is saved here; the
  // matching sheet opens filled in and the person adds it. An AI failure
  // (switch, key, limit, network) answers 200 with `unavailable`, like
  // POST /tasks/parse. A kind the member may not write comes back as a task
  // when they may write tasks, else 403. The sentence is private and is not
  // logged.
  // Response: { data: { source: 'ai', kind, fields } } | { data: { source: null, unavailable } }
  // --------------------------------------------------------
  router.post('/parse', async (req, res) => {
    if (refuseWallWrite(req, res, { db: db.get() })) return;
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text || text.length > 500) {
      return res.status(400).json({ error: 'Text must be 1 to 500 characters.', code: 400 });
    }
    const kind = req.body?.kind ?? null;
    if (kind !== null && !QUICK_ADD_KINDS.includes(kind)) {
      return res.status(400).json({ error: 'Kind must be task, event or shopping.', code: 400 });
    }
    // Vor dem Aufruf: wer nichts davon schreiben darf, kostet keine KI.
    const writable = QUICK_ADD_KINDS.filter((k) => mayWriteModule(req, KIND_MODULE[k]));
    if (kind ? !writable.includes(kind) : writable.length === 0) return res.status(403).json(READ_ONLY);
    try {
      const result = await parseQuickAddSentence({
        text, userId: req.authUserId || req.session?.userId, kind, kinds: writable, client,
      });
      if (!result) return res.status(403).json(READ_ONLY);
      res.json({ data: { source: 'ai', kind: result.kind, fields: result.fields } });
    } catch (err) {
      if (err instanceof AiError) return res.json({ data: { source: null, unavailable: err.code } });
      log.error('POST /parse error:', err);
      res.status(500).json({ error: 'Internal server error.', code: 500 });
    }
  });

  return router;
}

export default createQuickAddRouter();
