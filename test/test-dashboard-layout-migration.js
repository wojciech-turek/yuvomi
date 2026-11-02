/**
 * Test: Kein Layout pro Person fuer Heute (Migration 254)
 * Zweck: Heute ist fuer alle dasselbe (One-Today-Runde, 2026-11-02). Die
 *        gespeicherten Anordnungs-Schluessel (haushaltweit, Vorgabe, je Person)
 *        loescht die Migration; alles andere in sync_config bleibt stehen.
 * Ausführen: node --experimental-sqlite --test test/test-dashboard-layout-migration.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const dbmod = await import('../server/db.js');
const migration = dbmod.MIGRATIONS.find((m) => m.version === 254);

const REMOVED = [
  'dashboard_widgets',
  'dashboard_today_glance',
  'dashboard_widgets_default',
  'dashboard_today_glance_default',
  'dashboard_widgets:user:1',
  'dashboard_widgets:user:42',
  'dashboard_today_glance:user:2',
];
const KEPT = [
  'language',
  'wall_allow_ticking',
  'module_order:user:1',
  'dashboard_widgets_backup',
  'my_dashboard_widgets:user:1',
];

/** Bestands-DB vor der Migration: nur die Tabelle, die sie anfasst. */
function household() {
  const conn = new DatabaseSync(':memory:');
  conn.exec('CREATE TABLE sync_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
  const insert = conn.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?)');
  for (const key of [...REMOVED, ...KEPT]) insert.run(key, '[]');
  return conn;
}

const run = (conn) => (typeof migration.up === 'function' ? migration.up(conn) : conn.exec(migration.up));
const keys = (conn) => conn.prepare('SELECT key FROM sync_config ORDER BY key').all().map((r) => r.key);

test('die Migration 254 existiert und heisst wie versprochen', () => {
  assert.ok(migration, 'Version 254 fehlt');
  assert.equal(migration.description, 'remove per-person home layout preferences');
});

test('alle sechs Schluesselformen sind danach weg', () => {
  const conn = household();
  run(conn);
  const left = keys(conn);
  for (const key of REMOVED) assert.ok(!left.includes(key), `${key} blieb stehen`);
});

test('andere sync_config-Zeilen bleiben unberuehrt', () => {
  const conn = household();
  run(conn);
  assert.deepEqual(keys(conn), [...KEPT].sort());
});

test('zweiter Lauf aendert nichts', () => {
  const conn = household();
  run(conn);
  const once = keys(conn);
  run(conn);
  assert.deepEqual(keys(conn), once);
});

test('Quellguard: dashboard-widgets.js behaelt die vier Abruf-Namen, die Layout-Funktionen sind weg', async () => {
  const { existsSync } = await import('node:fs');
  const widgets = await import('../public/utils/dashboard-widgets.js');
  for (const name of ['dashboardRequest', 'fetchPendingReminders', 'forgetPendingReminders', 'dashboardQueryFiltersCounts']) {
    assert.equal(typeof widgets[name], 'function', `${name} fehlt`);
  }
  // Was Heute je Person ordnete, gibt es nicht mehr. (Der Katalog, den
  // utils/extension-widgets.js noch importiert, geht mit Aufgabe 2.)
  for (const name of ['normalizeDashboardConfig', 'dashboardQuery', 'normalizeShoppingListSelection', 'DEFAULT_WIDGET_CONFIG']) {
    assert.equal(name in widgets, false, `${name} ist zurueck`);
  }
  assert.equal(existsSync(new URL('../public/utils/dashboard-layout-hint.js', import.meta.url)), false);
});
