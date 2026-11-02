/**
 * Modul: Extension module list
 * Zweck: Holds the third-party module list from GET /api/v1/modules for the
 *        router and the API settings page. (The dashboard widget catalog that
 *        used to live here went with the per-person Today layout.)
 */

let _extensionModules = [];

export function setExtensionModules(modules) {
  _extensionModules = Array.isArray(modules) ? modules : [];
}

export function getExtensionModules() {
  return _extensionModules;
}

/** A failed /modules fetch is not a claim that no modules exist. */
export function selectThirdPartyModuleList(previous, { ok, data } = {}) {
  const prev = Array.isArray(previous) ? previous : [];
  if (!ok) return prev;
  return Array.isArray(data) ? data : prev;
}
