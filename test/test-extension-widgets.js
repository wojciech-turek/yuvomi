/**
 * Test: Extension module list (client utils)
 * Run: node --test test/test-extension-widgets.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ext = await import('../public/utils/extension-widgets.js');

test('setExtensionModules keeps the list getExtensionModules hands back, and ignores a non-array', () => {
  const list = [{ id: 'demo-ext', enabled: true, status: 'enabled' }];
  ext.setExtensionModules(list);
  assert.deepEqual(ext.getExtensionModules(), list);
  ext.setExtensionModules(null);
  assert.deepEqual(ext.getExtensionModules(), []);
});

test('the dashboard widget catalog is gone: only the module list helpers are exported', () => {
  assert.deepEqual(Object.keys(ext).sort(), ['getExtensionModules', 'selectThirdPartyModuleList', 'setExtensionModules']);
});

test('selectThirdPartyModuleList keeps the previous list when the request fails', () => {
  const previous = [{ id: 'akahu', enabled: true, status: 'enabled' }];
  assert.deepEqual(
    ext.selectThirdPartyModuleList(previous, { ok: false }),
    previous,
  );
  assert.deepEqual(
    ext.selectThirdPartyModuleList(previous, { ok: false, data: [] }),
    previous,
  );
});

test('selectThirdPartyModuleList treats a successful empty array as "no modules exist"', () => {
  const previous = [{ id: 'akahu', enabled: true, status: 'enabled' }];
  assert.deepEqual(ext.selectThirdPartyModuleList(previous, { ok: true, data: [] }), []);
});

test('selectThirdPartyModuleList keeps previous when a successful body is not an array', () => {
  const previous = [{ id: 'akahu' }];
  assert.deepEqual(ext.selectThirdPartyModuleList(previous, { ok: true, data: null }), previous);
  assert.deepEqual(ext.selectThirdPartyModuleList(previous, { ok: true, data: { id: 'x' } }), previous);
});

test('syncThirdPartyModules uses selectThirdPartyModuleList instead of clearing on error', () => {
  const raw = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  const start = raw.indexOf('async function syncThirdPartyModules');
  const end = raw.indexOf('function moduleSnapshot', start);
  assert.ok(start >= 0 && end > start, 'syncThirdPartyModules must precede moduleSnapshot');
  const body = raw.slice(start, end).replace(/^\s*\/\/.*$/gm, '');
  assert.equal(body.includes('selectThirdPartyModuleList'), true);
  assert.equal(/catch\s*\{[^}]*_thirdPartyModules\s*=\s*\[\]/.test(body), false);
});
