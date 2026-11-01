/**
 * Test: Alle Aufgaben entsperrt (Migration 253)
 * Zweck: Die App kennt das Sperren einer Aufgabe nicht mehr (Quick-Add-Runde,
 *        2026-10-29). Der Server-Code dafuer ruht, bleibt aber erreichbar -
 *        deshalb setzt die Migration jede bestehende Sperre zurueck, sonst
 *        bliebe eine Aufgabe fuer alle ausser ihrem Ersteller und Admins
 *        geschlossen, ohne dass irgendwo ein Schalter sie wieder oeffnet.
 * Ausführen: node --experimental-sqlite --test test/test-task-unlock-migration.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const dbmod = await import('../server/db.js');
const migration = dbmod.MIGRATIONS.find((m) => m.version === 253);

/** Bestands-DB vor der Migration: nur die Tabelle, die sie anfasst. */
function household() {
  const conn = new DatabaseSync(':memory:');
  conn.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, locked INTEGER NOT NULL DEFAULT 0)');
  conn.prepare('INSERT INTO tasks (id, title, locked) VALUES (1, ?, 1), (2, ?, 0), (3, ?, 1)').run('a', 'b', 'c');
  return conn;
}

const run = (conn) => (typeof migration.up === 'function' ? migration.up(conn) : conn.exec(migration.up));

test('die Migration 253 existiert', () => {
  assert.ok(migration, 'Version 253 fehlt');
});

test('eine vorher gesperrte Aufgabe liest nach der Migration locked = 0', () => {
  const conn = household();
  run(conn);
  const rows = conn.prepare('SELECT id, locked FROM tasks ORDER BY id').all();
  assert.deepEqual(rows.map((r) => r.locked), [0, 0, 0]);
});

test('zweiter Lauf aendert nichts', () => {
  const conn = household();
  run(conn);
  run(conn);
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM tasks WHERE locked <> 0').get().n, 0);
});
