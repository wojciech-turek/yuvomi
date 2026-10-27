/**
 * Modul: Waste collection - Dashboard widget (#1063 Phase 4)
 * Zweck: die Registrierung des Waste-Widgets (Modul-Zuordnung, Refresh,
 *        Anpassen-Standardliste, Groessenklasse, Rechte) und der Typ-Dialog
 *        seiner Optionen.
 *
 *        TAFLA (2026-10-24): die Kachel des alten Rasters (renderWasteWidget)
 *        ist mit dem Raster gegangen, ihre Rendering-Tests mit ihr. Dziś nennt
 *        die Abfuhr im Plan (heute) und in „Jutro" (morgen) aus `wastePickups`
 *        der Antwort (utils/today-plan.js).
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-waste-dashboard.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('./test-browser-loader.mjs', import.meta.url);

const widgetsUtil = await import('../public/utils/dashboard-widgets.js');
const permissions = await import('../server/permissions.js');

const src = () => readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');

// -------------------------------------------------------------------------
// Registrierung (Quelltext-Verdrahtung, wie beim Schedule-Widget)
// -------------------------------------------------------------------------

test('der Refresh nimmt die Antwort als Ganzes, und der Plan liest die Abfuhr aus ihr', () => {
  const text = src();
  // 2026-10-27, v2: MODULE_FOR_WIDGET ist mit den Kacheln von Dziś gegangen;
  // die Abfuhr steht an der Wand (Plan und Jutro, utils/today-plan.js).
  assert.doesNotMatch(text, /MODULE_FOR_WIDGET/);
  // TAFLA (2026-10-19): Dziś zeichnet die Kachel nicht mehr und laedt ihren
  // Slice nicht; die Abfuhr spricht dort ueber `wastePickups` der Antwort -
  // heute im Plan, morgen (heute Abend rausstellen) in „Jutro". Ein stiller
  // Refresh nimmt die Antwort als Ganzes, ohne Slice von gestern.
  const refresh = text.slice(text.indexOf('async function refreshDashboardData'), text.indexOf('const refreshTimerId'));
  assert.doesNotMatch(refresh, /fresh\.waste\s*=\s*data\.waste;/);
  const plan = readFileSync(new URL('../public/utils/today-plan.js', import.meta.url), 'utf8');
  assert.match(plan, /data\?\.wastePickups/, 'Plan und Jutro lesen die Abfuhr aus der Antwort');
});

test('Dziś fragt die Abfuhr nur bei eingeschaltetem Modul (frueher ensureWasteSlice)', () => {
  // TAFLA (2026-10-19): der Slice der Kachel ist fort; dieselbe Zusage gilt
  // fuer Plan und Jutro - ein abgeschaltetes Modul spricht nicht.
  const plan = readFileSync(new URL('../public/utils/today-plan.js', import.meta.url), 'utf8');
  assert.match(plan, /if \(!off\('waste'\)\) \{\s*const today = /, 'der Plan fragt das Modul');
  assert.match(plan, /if \(!off\('waste'\)\) \{\s*const pickups = /, 'Jutro fragt das Modul');
});

// -------------------------------------------------------------------------
// Per-Typ-Widget-Option (#1063 Phase 10) - Quelltext-Verdrahtung, wie oben:
// ensureWasteSlice/openWidgetOptions sind private Closures innerhalb von
// render(), nicht ueber __test aufrufbar.
// -------------------------------------------------------------------------


// TAFLA (2026-10-19): die Typ-Option filtert nur die Kachel, die Dziś nicht
// mehr zeichnet - Plan und Jutro nennen jede Abholung (wie zuvor schon das
// Heute-Blatt, das die Option nie las). Die beiden Guards zum Filtern und
// Verwerfen des Kachel-Slices sind deshalb mit dem Slice gegangen.

test('das Waste-Widget ist in der Anpassen-Standardliste als Opt-in eingetragen, wie schedule/housekeeping', () => {
  assert(widgetsUtil.WIDGET_IDS.includes('waste'), 'WIDGET_IDS fehlt waste');
  assert(widgetsUtil.DEFAULT_HIDDEN_WIDGETS.has('waste'),
    'waste muss wie rewards/health/housekeeping/schedule erst im Anpassen-Tray auftauchen, nicht ab Werk sichtbar sein');
});

test('die Waste-Kachel defaultet auf 1x2 wie schedule/family, nicht auf 1x1', () => {
  assert.equal(widgetsUtil.defaultWidgetSize('waste'), '1x2',
    'eine Liste "naechste Abholung je Typ" braucht Hoehe, nicht Breite');
});

test('PERMISSION_WIDGETS kennt das Waste-Widget und bindet es an das waste-Modul', () => {
  const entry = permissions.PERMISSION_WIDGETS.find((w) => w.id === 'waste');
  assert(entry, 'PERMISSION_WIDGETS fehlt ein Eintrag fuer waste');
  assert.equal(entry.module, 'waste', 'ein gesperrtes waste-Modul muss auch das Widget sperren (#467)');
});
