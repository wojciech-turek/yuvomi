/**
 * Tests: Rollen & Rechte (server/permissions.js)
 * Fokus:
 *   1. Auflösung: Admin-Bypass, Standard = Vollzugriff (rückwärtskompatibel),
 *      Rollen-Profil, Mitglied-Override gewinnt. Keine Rechte pro Kachel (Migration 255).
 *   2. Session-Enforcement-Map: nur Abweichungen, null bei Vollzugriff/Admin.
 *   3. Speicherung: Sparse (Standard nicht gespeichert), Validierung, atomarer
 *      Ersatz, „von Rolle erben" via leerer Eingabe.
 * Hintergrund: Discussion #467.
 * Ausführen: node --experimental-sqlite --test test/test-permissions.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import {
  resolvePermissions,
  buildSessionModuleAccess,
  moduleAccessVerdict,
  clientPermissions,
  permissionCatalog,
  getSubjectPermissions,
  replaceSubjectPermissions,
  normalizePermissionInput,
  isValidFamilyRole,
  PERMISSION_MODULES,
  PERMISSION_CAPABILITIES,
} from '../server/permissions.js';
import { effectiveCapabilityAccess, isPermissionDeviation } from '../public/utils/permission-group.js';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATIONS_SQL[1]);   // users
  db.exec(MIGRATIONS_SQL[74]);  // access_permissions
  db.exec(MIGRATIONS_SQL[175]); // capability resource type
  return db;
}

function addUser(db, { id, role = 'member', family_role = 'other', name = 'U' }) {
  db.prepare('INSERT INTO users (id, username, display_name, password_hash, role, family_role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, `user${id}`, name, 'x', role, family_role);
  return db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(id);
}

test('migration 175 preserves overrides and permits capability resources', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATIONS_SQL[74]);
  db.prepare(`
    INSERT INTO access_permissions
      (subject_type, subject_id, resource_type, resource_key, access, updated_at)
    VALUES ('role', 'child', 'module', 'notes', 'read', '2024-01-02T03:04:05Z')
  `).run();

  db.exec(MIGRATIONS_SQL[175]);

  assert.deepEqual(
    { ...db.prepare(`
      SELECT subject_type, subject_id, resource_type, resource_key, access, updated_at
      FROM access_permissions
    `).get() },
    {
      subject_type: 'role',
      subject_id: 'child',
      resource_type: 'module',
      resource_key: 'notes',
      access: 'read',
      updated_at: '2024-01-02T03:04:05Z',
    },
  );
  assert.doesNotThrow(() => db.prepare(`
    INSERT INTO access_permissions
      (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', '42', 'capability', 'example', 'allow')
  `).run());
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM access_permissions WHERE resource_type = 'capability'").get().count,
    1,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_access_permissions_subject'").get().count,
    1,
  );
  db.close();
});

// ── Auflösung ────────────────────────────────────────────────────────────────

test('Admin: Vollzugriff, admin-Flag, kein Scoping', () => {
  const db = freshDb();
  const admin = addUser(db, { id: 1, role: 'admin', family_role: 'dad' });
  const r = resolvePermissions(db, admin);
  assert.equal(r.admin, true);
  for (const m of PERMISSION_MODULES) assert.equal(r.modules[m.key], 'write');
  assert.ok(!('widgets' in r), 'es gibt keine Widget-Achse mehr');
  assert.equal(buildSessionModuleAccess(r), null);
});

test('Standard ohne Konfiguration: Vollzugriff (rückwärtskompatibel)', () => {
  const db = freshDb();
  const member = addUser(db, { id: 2, role: 'member', family_role: 'child' });
  const r = resolvePermissions(db, member);
  assert.equal(r.admin, false);
  assert.equal(r.modules.budget, 'write');
  assert.equal(r.capabilities.notes_manage_household_categories, 'none');
  assert.equal(r.capabilities.health_use_fasting, 'allow');
  assert.equal(buildSessionModuleAccess(r), null); // nichts eingeschränkt
});

test('Fasting is default-on but explicit role and member denials still win', () => {
  const db = freshDb();
  const member = addUser(db, { id: 21, role: 'member', family_role: 'child' });
  assert.equal(resolvePermissions(db, member).capabilities.health_use_fasting, 'allow');

  replaceSubjectPermissions(db, 'role', 'child', {
    capabilities: { health_use_fasting: 'none' },
  });
  assert.equal(resolvePermissions(db, member).capabilities.health_use_fasting, 'none');

  replaceSubjectPermissions(db, 'role', 'child', { capabilities: {} });
  replaceSubjectPermissions(db, 'user', member.id, {
    capabilities: { health_use_fasting: 'none' },
  });
  assert.equal(resolvePermissions(db, member).capabilities.health_use_fasting, 'none');
  db.close();
});

test('permission sheet resolves each capability from its own default', () => {
  const fasting = { default: 'allow' };
  assert.equal(effectiveCapabilityAccess(fasting, { mode: 'role' }), 'allow');
  assert.equal(effectiveCapabilityAccess(fasting, { mode: 'user' }), 'allow');
  assert.equal(effectiveCapabilityAccess(fasting, { mode: 'user', inherited: 'none' }), 'none');
  assert.equal(effectiveCapabilityAccess(fasting, { mode: 'user', draft: 'none', inherited: 'allow' }), 'none');
  assert.equal(effectiveCapabilityAccess({ default: 'none' }, { mode: 'role' }), 'none');
});

test('Haushaltskategorien: Admin darf immer verwalten', () => {
  const db = freshDb();
  const admin = addUser(db, { id: 20, role: 'admin', family_role: 'other' });
  const r = resolvePermissions(db, admin);
  assert.equal(r.capabilities.notes_manage_household_categories, 'allow');
});

test('Haushaltskategorien: Rolle kann erlauben, Mitglied-Override kann verbieten', () => {
  const db = freshDb();
  const child = addUser(db, { id: 21, family_role: 'child' });
  replaceSubjectPermissions(db, 'role', child.family_role, {
    capabilities: { notes_manage_household_categories: 'allow' },
  });
  assert.equal(resolvePermissions(db, child).capabilities.notes_manage_household_categories, 'allow');

  replaceSubjectPermissions(db, 'user', child.id, {
    capabilities: { notes_manage_household_categories: 'none' },
  });
  assert.equal(resolvePermissions(db, child).capabilities.notes_manage_household_categories, 'none');
});

test('Rollen-Profil greift für alle Mitglieder der Rolle', () => {
  const db = freshDb();
  const child = addUser(db, { id: 3, role: 'member', family_role: 'child' });
  replaceSubjectPermissions(db, 'role', 'child', { modules: { budget: 'none', housekeeping: 'read' } });
  const r = resolvePermissions(db, child);
  assert.equal(r.modules.budget, 'none');
  assert.equal(r.modules.housekeeping, 'read');
  assert.equal(r.modules.tasks, 'write'); // unkonfiguriert = Standard
  assert.deepEqual(buildSessionModuleAccess(r), { budget: 'none', housekeeping: 'read' });
});

test('Mitglied-Override gewinnt gegen Rollen-Profil', () => {
  const db = freshDb();
  const child = addUser(db, { id: 4, role: 'member', family_role: 'child' });
  replaceSubjectPermissions(db, 'role', 'child', { modules: { budget: 'none' } });
  replaceSubjectPermissions(db, 'user', 4, { modules: { budget: 'read' } });
  const r = resolvePermissions(db, child);
  assert.equal(r.modules.budget, 'read'); // Override statt Rollen-none
});

test('Alte Widget-Zeilen in access_permissions wirken nicht mehr (Migration 255 raeumt sie ab)', () => {
  const db = freshDb();
  const child = addUser(db, { id: 5, role: 'member', family_role: 'child' });
  db.prepare("INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access) VALUES ('user', '5', 'widget', 'cycle', 'none')").run();
  replaceSubjectPermissions(db, 'role', 'child', { modules: { health: 'none' } });
  const r = resolvePermissions(db, child);
  assert.equal(r.modules.health, 'none', 'der Modulzugriff gilt weiter');
  assert.ok(!('widgets' in r));
  assert.deepEqual(Object.keys(getSubjectPermissions(db, 'user', 5)).sort(), ['capabilities', 'modules']);
});

test('Ein altes widgets-Feld im Body wird ignoriert, nicht abgewiesen, nichts wird gespeichert', () => {
  const db = freshDb();
  addUser(db, { id: 6, role: 'member', family_role: 'dad' });
  replaceSubjectPermissions(db, 'role', 'dad', { modules: { budget: 'none' }, widgets: { cycle: 'none', nope: 'x' } });
  const rows = db.prepare("SELECT resource_type, resource_key FROM access_permissions WHERE subject_id = 'dad'").all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ resource_type: 'module', resource_key: 'budget' }]);
});

// ── Session-Enforcement-Map ──────────────────────────────────────────────────

test('buildSessionModuleAccess: nur Abweichungen, write wird ausgelassen', () => {
  const db = freshDb();
  const child = addUser(db, { id: 8, role: 'member', family_role: 'child' });
  replaceSubjectPermissions(db, 'role', 'child', { modules: { budget: 'none', calendar: 'read', tasks: 'write' } });
  const map = buildSessionModuleAccess(resolvePermissions(db, child));
  assert.deepEqual(map, { budget: 'none', calendar: 'read' });
  assert.equal('tasks' in map, false);
});

// ── Speicherung / Validierung ────────────────────────────────────────────────

// ── Durchsetzung (geteilt von /api/v1 und MCP, #823) ─────────────────────────

test('moduleAccessVerdict: null lässt alles durch (Admin/unbeschränkt)', () => {
  assert.equal(moduleAccessVerdict(null, 'tasks', 'write'), 'allow');
  assert.equal(moduleAccessVerdict(undefined, 'tasks', 'write'), 'allow');
});

test('moduleAccessVerdict: Deny-Liste — nicht gelistete Module bleiben offen', () => {
  const map = { tasks: 'none' };
  assert.equal(moduleAccessVerdict(map, 'calendar', 'write'), 'allow');
  // Auch ein Pfad ohne Modulzuordnung darf nicht stillschweigend zufallen,
  // sonst wäre die App für eingeschränkte Mitglieder unbedienbar.
  assert.equal(moduleAccessVerdict(map, null, 'read'), 'allow');
});

test('moduleAccessVerdict: none sperrt beide Zugriffsarten', () => {
  const map = { tasks: 'none' };
  assert.equal(moduleAccessVerdict(map, 'tasks', 'read'), 'none');
  assert.equal(moduleAccessVerdict(map, 'tasks', 'write'), 'none');
});

test('moduleAccessVerdict: read erlaubt Lesen, weist Schreiben ab', () => {
  const map = { tasks: 'read' };
  assert.equal(moduleAccessVerdict(map, 'tasks', 'read'), 'allow');
  assert.equal(moduleAccessVerdict(map, 'tasks', 'write'), 'read-only');
});

test('Sparse: Standard-Werte werden nicht gespeichert', () => {
  const db = freshDb();
  addUser(db, { id: 9, role: 'member', family_role: 'parent' });
  replaceSubjectPermissions(db, 'role', 'parent', {
    modules: { budget: 'write', health: 'none' }, // write = Standard ⇒ verworfen
  });
  const stored = getSubjectPermissions(db, 'role', 'parent');
  assert.deepEqual(stored.modules, { health: 'none' });
});

test('replaceSubjectPermissions ersetzt atomar (kein Merge)', () => {
  const db = freshDb();
  addUser(db, { id: 10, role: 'member', family_role: 'relative' });
  replaceSubjectPermissions(db, 'role', 'relative', { modules: { budget: 'none' } });
  replaceSubjectPermissions(db, 'role', 'relative', { modules: { health: 'read' } });
  const stored = getSubjectPermissions(db, 'role', 'relative');
  assert.deepEqual(stored.modules, { health: 'read' }); // budget-Sperre ist weg
});

test('replaceSubjectPermissions erhält Capability-Zeilen beim Speichern von Modulen', () => {
  const db = freshDb();
  db.exec(MIGRATIONS_SQL[175]);
  db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('role', 'child', 'capability', 'notes.categories', 'allow')
  `).run();

  replaceSubjectPermissions(db, 'role', 'child', { modules: { budget: 'none' } });

  assert.deepEqual(
    db.prepare(`
      SELECT resource_type, resource_key, access
      FROM access_permissions
      WHERE subject_type = 'role' AND subject_id = 'child'
      ORDER BY resource_type, resource_key
    `).all().map((row) => ({ ...row })),
    [
      { resource_type: 'capability', resource_key: 'notes.categories', access: 'allow' },
      { resource_type: 'module', resource_key: 'budget', access: 'none' },
    ],
  );
});

test('replaceSubjectPermissions ersetzt Capabilities nur bei ausdrücklichem Feld', () => {
  const db = freshDb();
  db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('role', 'child', 'capability', 'notes_manage_household_categories', 'allow')
  `).run();

  replaceSubjectPermissions(db, 'role', 'child', { modules: {} });
  assert.deepEqual(getSubjectPermissions(db, 'role', 'child').capabilities, {
    notes_manage_household_categories: 'allow',
  });

  replaceSubjectPermissions(db, 'role', 'child', { capabilities: {} });
  assert.deepEqual(getSubjectPermissions(db, 'role', 'child').capabilities, {});
});

test('Leere Eingabe leert die alten Achsen und lässt ausgelassene Capabilities bestehen', () => {
  const db = freshDb();
  addUser(db, { id: 11, role: 'member', family_role: 'child' });
  replaceSubjectPermissions(db, 'user', 11, {
    modules: { budget: 'none' },
    capabilities: { notes_manage_household_categories: 'allow' },
  });
  replaceSubjectPermissions(db, 'user', 11, {}); // zurücksetzen
  assert.deepEqual(getSubjectPermissions(db, 'user', 11), {
    modules: {},
    capabilities: { notes_manage_household_categories: 'allow' },
  });
  replaceSubjectPermissions(db, 'user', 11, { capabilities: {} });
  assert.deepEqual(getSubjectPermissions(db, 'user', 11), { modules: {}, capabilities: {} });
});

test('normalizePermissionInput: unbekannte/ungültige Werte werfen', () => {
  assert.throws(() => normalizePermissionInput({ modules: { nope: 'read' } }), /Unknown module/);
  assert.throws(() => normalizePermissionInput({ modules: { budget: 'bogus' } }), /Invalid module access/);
});

test('Capability-Defaults bleiben bei Rollen sparse, Nutzer dürfen geerbtes allow aufheben', () => {
  const db = freshDb();
  const child = addUser(db, { id: 15, role: 'member', family_role: 'child' });

  replaceSubjectPermissions(db, 'role', 'child', {
    capabilities: { notes_manage_household_categories: 'none' },
  });
  assert.deepEqual(getSubjectPermissions(db, 'role', child.family_role).capabilities, {});

  replaceSubjectPermissions(db, 'role', child.family_role, {
    capabilities: { notes_manage_household_categories: 'allow' },
  });
  replaceSubjectPermissions(db, 'user', child.id, {
    capabilities: { notes_manage_household_categories: 'none' },
  });
  assert.deepEqual(getSubjectPermissions(db, 'user', child.id).capabilities, {
    notes_manage_household_categories: 'none',
  });
  assert.equal(resolvePermissions(db, child).capabilities.notes_manage_household_categories, 'none');
});

test('isValidFamilyRole', () => {
  assert.equal(isValidFamilyRole('child'), true);
  assert.equal(isValidFamilyRole('nope'), false);
});

test('permissionCatalog liefert Module, Faehigkeiten, Rollen, Levels', () => {
  const cat = permissionCatalog();
  assert.ok(cat.modules.some((m) => m.key === 'budget'));
  assert.ok(!('widgets' in cat) && !('widgetAccessLevels' in cat), 'der Katalog kennt keine Widgets');
  assert.ok(cat.roles.includes('child'));
  assert.deepEqual(cat.moduleAccessLevels, ['none', 'read', 'write']);
  assert.ok(cat.capabilities.some((item) => item.key === 'notes_manage_household_categories'));
  assert.equal(cat.capabilities.find((item) => item.key === 'notes_manage_household_categories').default, 'none');
  assert.equal(cat.capabilities.find((item) => item.key === 'health_use_fasting').default, 'allow');
  assert.deepEqual(cat.capabilityAccessLevels, ['none', 'allow']);
  assert.equal(cat.capabilities.find((item) => item.key === 'housekeeping_view_amounts').default, 'allow');
  assert.equal(cat.capabilities.find((item) => item.key === 'housekeeping_view_amounts').module, 'housekeeping');
  // R20: die Betraege der Haushaltshilfe sind eine eigene Capability, Standard
  // `allow` - jedes bestehende Konto sieht sie weiter.
  assert.deepEqual(PERMISSION_CAPABILITIES.map((item) => item.key), ['notes_manage_household_categories', 'health_use_fasting', 'housekeeping_view_amounts']);
});

test('capability summary compares against each capability default', () => {
  const optIn = { key: 'notes_manage_household_categories', default: 'none' };
  const optOut = { key: 'health_use_fasting', default: 'allow' };

  assert.equal(isPermissionDeviation(optIn, 'none'), false);
  assert.equal(isPermissionDeviation(optIn, 'allow'), true);
  assert.equal(isPermissionDeviation(optOut, 'allow'), false);
  assert.equal(isPermissionDeviation(optOut, 'none'), true);
});

test('clientPermissions: kompakte Payload mit admin-Flag', () => {
  const db = freshDb();
  const child = addUser(db, { id: 12, role: 'member', family_role: 'child' });
  replaceSubjectPermissions(db, 'role', 'child', { modules: { budget: 'read' } });
  const p = clientPermissions(db, child);
  assert.equal(p.admin, false);
  assert.equal(p.modules.budget, 'read');
  assert.ok(!('widgets' in p));
});

// --------------------------------------------------------
// Guard: es gibt keine Widget-Rechte mehr
// --------------------------------------------------------

test('die Rechte-Oberflaeche und der Server fuehren keine Widget-Liste mehr', () => {
  const ui = readFileSync(new URL('../public/settings/pages/admin-permissions.js', import.meta.url), 'utf-8');
  assert.doesNotMatch(ui, /WIDGET_LABEL_KEYS|widgetRowHtml|state\.draft\.widgets/);
  const server = readFileSync(new URL('../server/permissions.js', import.meta.url), 'utf-8');
  assert.doesNotMatch(server, /PERMISSION_WIDGETS|WIDGET_ACCESS/);
});
