/**
 * Modul: Wall settings (Tafla, 2026-10-19)
 * Zweck: The household's one choice for the kitchen wall - whether it may
 *        tick things off ("Pozwól odhaczać na ścianie"). It lives in
 *        `sync_config` next to every other household preference; this file
 *        reads it and answers the one question the write routes ask: may a
 *        paired display write right now? (The wall always draws one fixed
 *        set; there are no section switches.)
 * Abhängigkeiten: server/db.js (only through the `db` handed in or the default)
 *
 * READ-ONLY BY DEFAULT (owner decision, 2026-10-19). The wall shows; ticking a
 * task off, adding a running-out item or answering the weekly question there
 * is a household choice, off until an admin switches it on. Timers and "Gotuj"
 * write nothing and always work.
 *
 * ENFORCED AT THE ROUTE, NOT IN THE BROWSER. A display's write routes
 * (display-scopes.js, `DISPLAY_WRITE_ROUTES`) pass the global gates; each of
 * them asks `refuseWallWrite()` before it touches anything, so a tablet with
 * an old page (or a hand-made request) cannot tick while the switch is off.
 * The answer is 403 with `reason: 'wall_read_only'`, which the app translates.
 */

import * as dbModule from '../db.js';

const TICKING_KEY = 'wall_allow_ticking';

function cfg(database, key) {
  return database.prepare('SELECT value FROM sync_config WHERE key = ?').get(key)?.value ?? null;
}

/** Is ticking on the wall allowed in this household? Default: no. */
export function wallWritesAllowed({ db } = {}) {
  return cfg(db || dbModule.get(), TICKING_KEY) === '1';
}

/**
 * The one check every display write route makes. Sends the refusal and returns
 * true when the request comes from a paired display and the household has not
 * allowed writing on the wall; returns false (and sends nothing) otherwise.
 */
export function refuseWallWrite(req, res, { db } = {}) {
  if (req?.authMethod !== 'display') return false;
  if (wallWritesAllowed({ db })) return false;
  res.status(403).json({
    error: 'Ticking things off on the wall is switched off for this household.',
    code: 403,
    reason: 'wall_read_only',
  });
  return true;
}
