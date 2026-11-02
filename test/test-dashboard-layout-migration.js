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

test('Quellguard: dashboard-widgets.js exportiert genau die Abruf-Namen, kein Layout, kein Widget-Katalog', async () => {
  const { existsSync } = await import('node:fs');
  const widgets = await import('../public/utils/dashboard-widgets.js');
  assert.deepEqual(Object.keys(widgets).sort(), [
    'PENDING_SHARE_MS', 'dashboardQueryFiltersCounts', 'dashboardRequest', 'fetchPendingReminders', 'forgetPendingReminders',
  ]);
  assert.equal(typeof widgets.PENDING_SHARE_MS, 'number', 'der geteilte Abruf der Erinnerungen nutzt sie');
  assert.equal(existsSync(new URL('../public/utils/dashboard-layout-hint.js', import.meta.url)), false);
});

// ---------------------------------------------------------------------------
// Migration 255: keine Tablet-Schalter, keine Widget-Rechte
// ---------------------------------------------------------------------------

const migration255 = dbmod.MIGRATIONS.find((m) => m.version === 255);

function householdWithRights() {
  const conn = new DatabaseSync(':memory:');
  conn.exec(`
    CREATE TABLE sync_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE access_permissions (
      subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
      resource_type TEXT NOT NULL CHECK(resource_type IN ('module', 'widget', 'capability')),
      resource_key TEXT NOT NULL, access TEXT NOT NULL,
      PRIMARY KEY (subject_type, subject_id, resource_type, resource_key)
    );
  `);
  const cfg = conn.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?)');
  for (const key of ['wall_sections', 'wall_allow_ticking', 'language']) cfg.run(key, '1');
  const perm = conn.prepare('INSERT INTO access_permissions VALUES (?, ?, ?, ?, ?)');
  perm.run('role', 'child', 'widget', 'cycle', 'none');
  perm.run('user', '4', 'widget', 'today-soon', 'none');
  perm.run('user', '4', 'module', 'budget', 'none');
  perm.run('role', 'child', 'capability', 'health_use_fasting', 'none');
  return conn;
}

const run255 = (conn) => (typeof migration255.up === 'function' ? migration255.up(conn) : conn.exec(migration255.up));

test('Migration 255 existiert und heisst wie versprochen', () => {
  assert.ok(migration255, 'Version 255 fehlt');
  assert.equal(migration255.description, 'remove tablet section switches and widget permissions');
});

test('Migration 255 loescht wall_sections und nur die Widget-Zeilen', () => {
  const conn = householdWithRights();
  run255(conn);
  assert.deepEqual(
    conn.prepare('SELECT key FROM sync_config ORDER BY key').all().map((r) => r.key),
    ['language', 'wall_allow_ticking'],
  );
  assert.deepEqual(
    conn.prepare('SELECT resource_type, resource_key FROM access_permissions ORDER BY resource_type').all().map((r) => ({ ...r })),
    [{ resource_type: 'capability', resource_key: 'health_use_fasting' }, { resource_type: 'module', resource_key: 'budget' }],
    'Modul- und Faehigkeitsrechte bleiben',
  );
});

test('Migration 255: zweiter Lauf aendert nichts', () => {
  const conn = householdWithRights();
  run255(conn);
  const once = conn.prepare('SELECT COUNT(*) AS n FROM access_permissions').get().n;
  run255(conn);
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM access_permissions').get().n, once);
});
