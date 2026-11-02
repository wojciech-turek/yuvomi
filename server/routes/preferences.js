/**
 * Modul: Haushalt-Einstellungen (Preferences)
 * Zweck: REST-API fuer haushaltweite Praeferenzen (via sync_config-Tabelle)
 * Abhängigkeiten: express, server/db.js
 */

import { createLogger } from '../logger.js';
import { pickDisplayPreferences } from '../display-scopes.js';
import express from 'express';
import * as db from '../db.js';
import * as holidays from '../services/holidays.js';
import { str, MAX_SHORT } from '../middleware/validate.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { getSupportedLocales, isRegionTag, isSupportedLocale, resolveHouseholdLocale, supportedLocaleFor } from '../utils/i18n.js';
import { householdTimeZone, isValidTimeZone } from '../utils/timezone.js';
import { retitleBirthdayEvents } from '../services/birthdays.js';
import { resolveWeatherSource } from '../services/weather-source.js';
import { DEFAULT_OVERDUE_GRACE_DAYS } from '../services/countdowns.js';
import { syncPreventionRemindersForSubject } from '../services/prevention-reminders.js';
import { syncAllFastingReminders } from '../services/fasting-reminders.js';
import { isScreensaverEnabled } from './screensaver.js';
import { normalizeWallSections, parseWallSections } from '../services/wall-settings.js';
// Geteilte isomorphe Util (#620, Allowlist in test/test-layer-boundary.js):
// dasselbe Kennungsformat, das Event-Modal und Einstellungen verwenden.
import { parseSyncTargetValue } from '../../public/utils/sync-target.js';
// Der Vorrat waehlbarer Waehrungen - eine Liste fuer Server und Browser
// (#841, Allowlist in test/test-layer-boundary.js).
import { CURRENCY_CODES } from '../../public/utils/currency-codes.js';

const log = createLogger('Preferences');

const router = express.Router();

const VALID_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];
const DEFAULT_MEAL_TYPES = VALID_MEAL_TYPES.join(',');

/* HAUSHALTSNAMEN DER VIER SLOTS (#1058).
 *
 * Ein Name je Slot, wie der Haushalt ihn tippt - KEINE Uebersetzung. Er steht
 * in jeder Sprache so da, wie er eingegeben wurde: `fr`, `fr-CA` und `fr-BE`
 * sind sich beim Abendessen nicht einig, und keine Locale-Datei kann das je
 * Haushalt aufloesen. Ein leerer Name heisst "nimm das eingebaute Wort".
 *
 * ALS JSON, NICHT KOMMASEPARIERT wie `visible_meal_types` nebenan: ein Name
 * darf ein Komma enthalten ("Znuni, spaet"), und ein `split(',')` machte
 * daraus zwei. Derselbe Grund, aus dem ein Doppelpunkt-Schluessel kein
 * `split(':')` vertraegt.
 *
 * Der Slot-SCHLUESSEL bleibt unberuehrt - `meals.meal_type` traegt eine
 * CHECK-Constraint, Rezept-Eignung und die Mealie/Tandoor-Zuordnung haengen
 * daran. Umbenennen ist deshalb ein Anzeigename ueber einem stabilen Wert und
 * migriert nichts (#514). */
const MAX_MEAL_TYPE_NAME = 40;

/** Gespeicherte Namen als Objekt - unbekannte Slots und leere Werte fallen weg. */
function parseMealTypeNames(raw) {
  if (!raw) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  // Allowlist statt Denylist: ein Slot, den es nicht (mehr) gibt, kommt nicht
  // durch, egal was in der Zeile steht.
  for (const type of VALID_MEAL_TYPES) {
    const value = typeof parsed[type] === 'string' ? parsed[type].trim() : '';
    if (value) out[type] = value.slice(0, MAX_MEAL_TYPE_NAME);
  }
  return out;
}

const DEFAULT_CURRENCY = 'EUR';
const DEFAULT_APP_NAME = 'Yuvomi';

const VALID_DATE_FORMATS = ['mdy', 'dmy', 'ymd', 'mdy_dot', 'dmy_dot', 'dmy_slash', 'dmy_dash', 'ymd_dot', 'ymd_slash'];
// Default an die übrigen europäischen Defaults (EUR, 24h) und den Client-i18n-
// Default (dmy) angeglichen: ein nicht konfigurierter Account zeigt 30.06.2026
// statt 06/30/2026. US-Nutzer können in den Einstellungen weiterhin mdy wählen.
const DEFAULT_DATE_FORMAT = 'dmy';
const VALID_TIME_FORMATS = ['24h', '12h'];

// Wochenstart (haushaltweit): mit welchem Wochentag Kalender-Ansichten beginnen.
// Montag = bisheriges Fixverhalten; Sonntag/Samstag auf mehrfachen Nutzerwunsch
// (#484, #465). Als Klartext gespeichert – der Client mappt auf den getDay()-Index.
const VALID_WEEK_STARTS = ['monday', 'sunday', 'saturday'];
const DEFAULT_WEEK_START = 'monday';
// Budget-Modus (#476/#505): 'shared' = ein Haushaltsbudget (Altverhalten),
// 'personal' = persönliche/geteilte Einträge mit Mein/Haushalt-Ansicht.
const VALID_BUDGET_MODES = ['shared', 'personal'];
const DEFAULT_BUDGET_MODE = 'shared';

// Datensprache des Haushalts (#631, #632): in welcher Sprache der Server Inhalte
// *speichert*, die er selbst erzeugt - heute die Titel und Beschreibungen der
// Geburtstags-Termine. Anders als die UI-Sprache (per-user im localStorage) muss
// das haushaltweit sein: eine calendar_events-Zeile hat genau einen Titel, und
// den lesen REST-API, ICS-Feed, CalDAV-/Google-Outbound und die Suche.
// Nicht gesetzt = aus der Region abgeleitet, sonst Englisch (resolveHouseholdLocale).
const VALID_LANGUAGES = getSupportedLocales();

// Region ist nur ein Anzeige-Hinweis (Locale-Code wie "fr-FR" oder "custom").
// Der Client fällt bei unbekanntem Wert ohnehin auf detectRegion() zurück, daher
// genügt eine Formprüfung statt einer festen Liste.
//
// Die Form kommt aus `isRegionTag` in utils/i18n.js und steht nicht mehr als
// eigenes Literal hier: dieselbe Form wird beim Ableiten der Datensprache, beim
// Zahlenformat und bei der Regionsabfrage GELESEN. Ein Muster, das nur hier
// weiter wird, lässt einen Wert in die Datenbank, den keiner dieser Leser
// wiedererkennt - er wäre gespeichert und zugleich wirkungslos.
//
// `custom` steht daneben und nicht darin: es ist kein Regions-Tag, sondern die
// Abwesenheit einer Region, und genau deshalb liest es keiner der drei Leser.
const isValidRegionValue = (value) => value === 'custom' || isRegionTag(value);
const DEFAULT_TIME_FORMAT = '24h';

// Zeitzone des Haushalts (#829, haushaltweit). Bis hierher war die einzige
// Antwort auf "wo lebt dieser Haushalt" die Container-Variable `TZ` - ein
// Compose-Schalter, den man auf Umbrel, TrueNAS oder Unraid als Nutzer nicht
// erreicht, und der zugleich Logzeitstempel und Backup-Cron steuert. Als
// Einstellung ist sie änderbar, überlebt ein Deployment, das die Env verliert,
// und lässt sich prüfen.
//
// Leerer Wert = nicht gesetzt = der bisherige Rückfall (TZ → Systemzone → UTC),
// damit ein Bestandshaushalt beim Update nichts merkt.
//
// Geprüft wird gegen ICU (`isValidTimeZone`), nicht gegen eine Liste im Repo:
// eine gepflegte Konstante liefe von dem, was `Intl` tatsächlich kennt,
// auseinander, und zwar genau dort, wo es niemandem auffällt. Bewusst nicht
// gegen `Intl.supportedValuesOf('timeZone')` - das gibt nur die kanonischen
// Namen zurück und wiese einen gültigen Alias wie `Europe/Kiev` ab. Die Liste
// fürs Dropdown baut der Client aus seinem eigenen ICU; ein Wert, den nur er
// kennt, bekommt hier ein 400 statt still zu landen.

// Standard-Termindauer (Minuten): setzt das Ende neuer Kalender-Termine relativ
// zum Start und dient dem Modal als Ausgangs-Dauer. Grenzen: 5 Min bis 24 h.
const DEFAULT_CALENDAR_DURATION = 60;
const MIN_CALENDAR_DURATION = 5;
const MAX_CALENDAR_DURATION = 1440;

// Standard-Erinnerungen für neue Termine (#497, per-user): erlaubte Offsets in
// Minuten vor Terminbeginn (deckt sich mit den Presets im Event-Modal). Cap = 5,
// analog MAX_REMINDERS_PER_ENTITY in server/routes/reminders.js.
const VALID_REMINDER_OFFSETS = [0, 15, 60, 1440, 2880, 10080, 20160];
const MAX_DEFAULT_REMINDERS = 5;

// Standard-Sync-Ziel für eigene neue Termine (#620, per-user). Gespeichert wird
// exakt die Kennung, die das Event-Modal ohnehin führt: '' (lokal speichern),
// 'google:<calendarId>' oder 'caldav:<accountId>|<calendarUrl>'. Geprüft wird mit
// parseSyncTargetValue aus dem geteilten Util - dieselbe Funktion, mit der das
// Frontend die Kennung baut und liest, damit Server und Client nicht getrennte
// Vorstellungen vom Format entwickeln.
//
// Geprüft wird nur die FORM, nicht die Existenz. Ein Kalender kann deaktiviert,
// gelöscht oder auf nur-lesend gestellt werden, lange nachdem jemand ihn hier
// gewählt hat; eine Existenzprüfung beim Speichern würde das nicht verhindern,
// aber einen Google-API-Aufruf in jeden Einstellungs-Save ziehen. Stattdessen
// entscheidet das Modal beim Öffnen: steht das Ziel nicht mehr in der Liste,
// bleibt die Vorauswahl auf "Lokal" (siehe applyDefaultSyncTarget).
//
// Per-user, kein Admin-Gate: die Nachbarschlüssel calendar_default_reminders und
// calendar_default_assign_me liegen aus demselben Grund pro Nutzer (#497/#498) -
// wer welchen Kalender bespielt, ist eine persönliche Entscheidung.
const MAX_CALENDAR_TARGET_LENGTH = 500;

// Obergrenze für die Countdown-Nachfrist in Tagen (#969, haushaltweit). Der
// Standard selbst kommt aus services/countdowns.js - eine Kopie hier wäre eine
// zweite Antwort, die von der ersten abweichen könnte (docs/DECISIONS.md #2).
const MAX_COUNTDOWN_GRACE_DAYS = 90;

// Persistierte Default-Reminder als sortiertes Zahlen-Array lesen (leer = keine).
function parseDefaultReminders(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return [...new Set(arr.map(Number).filter((n) => VALID_REMINDER_OFFSETS.includes(n)))]
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * Persistierte Countdown-Nachfrist lesen. `0` ist ein gültiger, bewusst
 * gesetzter Wert ("keine Nachfrist") und fällt nicht auf den Standard zurück.
 */
function parseCountdownGraceDays(raw) {
  if (raw === null || raw === undefined) return DEFAULT_OVERDUE_GRACE_DAYS;
  const n = Math.trunc(Number(raw));
  if (!Number.isInteger(n) || n < 0) return DEFAULT_OVERDUE_GRACE_DAYS;
  return Math.min(n, MAX_COUNTDOWN_GRACE_DAYS);
}

const VALID_WEATHER_PROVIDERS = ['open-meteo', 'openweathermap'];
const VALID_WEATHER_UNITS = ['metric', 'imperial'];

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const COUNTRY_ISO_RE = /^[A-Z]{2}$/;
const SUBDIVISION_RE = /^[A-Z]{2}-[A-Z0-9-]{1,10}$/;

// Welche Quickstart-Vorlagen der Schichtplan-Schnellstart anbietet
// (public/pages/schedule.js#PRESET_TEMPLATES) - haushaltweit und admin-only
// wie disabled_modules, nicht pro Nutzer wie hidden_modules: die Vorlagen
// legen geteilte Schichtarten an, dieselbe Reichweite gilt fuer die Frage,
// welche Knoepfe dafuer sichtbar sind. Ein Haushalt, der nur Arbeit braucht,
// soll nicht dauerhaft Schule/Uni-Knoepfe sehen (Nutzerwunsch).
const SCHEDULE_TEMPLATE_KEYS = ['work', 'school', 'university'];

// Modul-Slugs, die per Settings deaktiviert werden können.
// Dashboard und Settings sind absichtlich nicht enthalten — sie sind essentiell.
// Exportiert fuer test/test-disabled-module-reminders.js: jede Erinnerungs-
// Herkunft muss auf einen dieser Schluessel zeigen, sonst erreicht der
// Haushaltsschalter sie nie (#1279).
export const TOGGLEABLE_MODULES = [
  'tasks', 'calendar', 'meals', 'recipes', 'shopping', 'pantry', 'inventory',
  'birthdays', 'notes', 'contacts', 'budget', 'documents',
  'housekeeping', 'waste', 'health', 'schedule',
];
const MODULE_ORDER_RE = /^(dashboard|tasks|calendar|meals|recipes|shopping|pantry|inventory|birthdays|notes|contacts|budget|documents|housekeeping|waste|health|schedule|third-party-[a-z0-9][a-z0-9-]{1,62}[a-z0-9])$/;
const MOBILE_NAV_ORDER_RE = /^(tasks|calendar|kitchen|meals|recipes|shopping|pantry|inventory|birthdays|notes|contacts|budget|documents|housekeeping|waste|health|schedule|third-party-[a-z0-9][a-z0-9-]{1,62}[a-z0-9])$/;
const KITCHEN_NAV_IDS = new Set(['kitchen', 'meals', 'recipes', 'shopping', 'pantry']);

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------

function cfgGet(key) {
  const row = db.get().prepare('SELECT value FROM sync_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function cfgSet(key, value) {
  db.get().prepare(`
    INSERT INTO sync_config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                   updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).run(key, value);
}

function cfgDelete(key) {
  db.get().prepare('DELETE FROM sync_config WHERE key = ?').run(key);
}

function userCfgKey(key, userId) {
  return `${key}:user:${Number(userId)}`;
}

function cfgUserGet(key, userId) {
  if (!userId) return null;
  return cfgGet(userCfgKey(key, userId));
}

function cfgUserSet(key, userId, value) {
  if (!userId) return;
  cfgSet(userCfgKey(key, userId), value);
}
// Den eigenen Wert LOESCHEN heisst "ich folge wieder dem Haushalt" - und das
// bleibt es auch nach der naechsten Aenderung des Admins. Den Haushaltswert
// stattdessen zu KOPIEREN waere die naheliegende und die falsche Variante: sie
// friert den heutigen Stand auf dem Konto ein, und der Folger driftet ab der
// ersten spaeteren Aenderung still davon weg (#827).
function cfgUserDelete(key, userId) {
  if (!userId) return;
  cfgDelete(userCfgKey(key, userId));
}

// Drei Sichten auf den Zyklus-Tab (#760), nach demselben Muster wie `language`:
// was der Haushalt erlaubt, was ich für mich gewählt habe, und was am Ende gilt.
//
// Der Admin-Schalter ist der Haushalts-Default; das persönliche Opt-out kann ihn
// nur enger machen, nie weiter. Deshalb UND statt Override: wer den Zyklus
// haushaltweit abschaltet, blendet ihn für alle aus, und niemand holt ihn sich
// einzeln zurück. Fehlender Wert = an, damit Bestandskonten ihr Verhalten behalten.
export function healthCycleViews(userId) {
  const household = cfgGet('health_cycle_enabled') !== '0';
  const personal = cfgUserGet('health_cycle_enabled', userId) !== '0';
  return {
    health_cycle_enabled: household,
    health_cycle_enabled_user: personal,
    health_cycle_effective: household && personal,
  };
}

// Per-User-Wetter-Override lesen (null je Feld = erbt Haushalt).
function weatherUserOverride(userId) {
  const autoRaw = cfgUserGet('weather_auto_locate', userId);
  return {
    lat:   cfgUserGet('weather_lat', userId),
    lon:   cfgUserGet('weather_lon', userId),
    city:  cfgUserGet('weather_city', userId),
    units: cfgUserGet('weather_units', userId),
    auto_locate: autoRaw === null ? null : autoRaw === '1',
  };
}

// Woher das Wetter des HAUSHALTS kommt: 'db' (hier gespeichert), 'env'
// (`WEATHER_*`/`OPENWEATHER_*` aus der `.env`, z. B. vom Web-Installer) oder
// 'none'. Dieselbe Regel wie im Wetter-Proxy, damit die Admin-Seite nicht
// "Nicht konfiguriert" sagt, waehrend das Dashboard Wetter zeigt. Der
// Standort je Mitglied bleibt bewusst aussen vor - er ist keine
// Haushaltseinstellung. Ein API-Key steht nie in der Antwort.
function householdWeatherSource() {
  return resolveWeatherSource({
    provider: cfgGet('weather_provider'),
    lat:      cfgGet('weather_lat'),
    lon:      cfgGet('weather_lon'),
    city:     cfgGet('weather_city'),
    units:    cfgGet('weather_units'),
  });
}

function parseDisabledModules(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m) => typeof m === 'string' && TOGGLEABLE_MODULES.includes(m));
  } catch {
    return [];
  }
}

// ZWEI VERSCHIEDENE FRAGEN AN DIESELBE MODULLISTE (#673).
//
// `disabled_modules` (haushaltweit, Admin) heisst: dieses Modul gibt es hier
// nicht - es verschwindet aus der Navigation UND der Routen-Guard schickt jeden
// zurueck aufs Dashboard. `hidden_modules` (pro Nutzer, kein Admin-Check) heisst:
// ich brauche es nicht auf meinem Bildschirm. Es raeumt die Navigation auf und
// nimmt NICHTS weg: ein Deep-Link aus einer Benachrichtigung oder ein Sprung aus
// einem Dashboard-Widget oeffnet die Seite weiter. Wer wirklich etwas entziehen
// will, hat dafuer die Rechte in `member_permissions` - Verstecken ist Aufraeumen,
// kein Entzug, und die beiden duerfen nicht zu einer Mechanik verschmelzen.
//
// Dieselbe Allowlist wie beim Haushalts-Schalter: Uebersicht und Einstellungen
// sind auch persoenlich nicht wegblendbar, sonst versteckt sich jemand den Weg
// zurueck zu genau diesem Schalter.
function parseHiddenModules(raw) {
  return parseDisabledModules(raw);
}

/**
 * Die gepinnten Kacheln der Seite Więcej (Tafla) - pro Person, ohne
 * Admin-Check. `null` heisst "nie gewaehlt": dann nimmt die Seite ihre
 * Vorgabe aus den eingeschalteten Modulen. Ein leeres Array ist eine Wahl
 * (nichts gepinnt). Hoechstens vier, nur bekannte Kacheln, ohne Doppel.
 */
const MORE_PIN_IDS = ['notes', 'budget', 'birthdays', 'health', 'housekeeping', 'documents', 'waste', 'split-expenses'];
const MORE_PIN_MAX = 4;

function normalizeMorePins(list) {
  return [...new Set(list.filter((id) => typeof id === 'string' && MORE_PIN_IDS.includes(id)))].slice(0, MORE_PIN_MAX);
}

function parseMorePins(raw) {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeMorePins(parsed) : null;
  } catch {
    return null;
  }
}

function parseScheduleHiddenTemplates(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((key) => typeof key === 'string' && SCHEDULE_TEMPLATE_KEYS.includes(key));
  } catch {
    return [];
  }
}

function parseModuleOrder(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id) => typeof id === 'string' && MODULE_ORDER_RE.test(id)))];
  } catch {
    return [];
  }
}

function normalizeMobileNavOrder(order) {
  const normalized = [];

  for (const id of Array.isArray(order) ? order : []) {
    if (typeof id !== 'string' || !MOBILE_NAV_ORDER_RE.test(id)) continue;
    const normalizedId = KITCHEN_NAV_IDS.has(id) ? 'kitchen' : id;
    if (!normalized.includes(normalizedId)) normalized.push(normalizedId);
    if (normalized.length === 3) break;
  }

  return normalized;
}

function parseMobileNavOrder(raw) {
  if (!raw) return [];
  try {
    return normalizeMobileNavOrder(JSON.parse(raw));
  } catch {
    return [];
  }
}

// --------------------------------------------------------
// GET /api/v1/preferences
// Alle Haushalt-Praeferenzen lesen.
// Response: { data: { visible_meal_types: string[] } }
// --------------------------------------------------------

router.get('/', (req, res) => {
  try {
    const raw = cfgGet('visible_meal_types') ?? DEFAULT_MEAL_TYPES;
    const visibleMealTypes = raw.split(',').filter((t) => VALID_MEAL_TYPES.includes(t));
    const mealTypeNames = parseMealTypeNames(cfgGet('meal_type_names'));
    const currency = cfgGet('currency') ?? DEFAULT_CURRENCY;
    const dateFormat = VALID_DATE_FORMATS.includes(cfgGet('date_format')) ? cfgGet('date_format') : DEFAULT_DATE_FORMAT;
    const timeFormat = VALID_TIME_FORMATS.includes(cfgGet('time_format')) ? cfgGet('time_format') : DEFAULT_TIME_FORMAT;
    const weekStart = VALID_WEEK_STARTS.includes(cfgGet('week_start')) ? cfgGet('week_start') : DEFAULT_WEEK_START;
    const appName = cfgGet('app_name') ?? DEFAULT_APP_NAME;
    const disabledModules = parseDisabledModules(cfgGet('disabled_modules'));
    const hiddenModules = parseHiddenModules(cfgUserGet('hidden_modules', req.authUserId));
    const moduleOrder = parseModuleOrder(cfgUserGet('module_order', req.authUserId) ?? cfgGet('module_order'));
    const mobileNavOrder = parseMobileNavOrder(cfgUserGet('mobile_nav_order', req.authUserId));

    const data = {
        visible_meal_types: visibleMealTypes,
        meal_type_names: mealTypeNames,
        currency,
        date_format: dateFormat,
        time_format: timeFormat,
        week_start: weekStart,
        region: cfgGet('region') || null,
        // Zwei Sichten wie bei der Sprache: was ist gewählt (Select-Zustand) und
        // was gilt gerade. `timezone_effective` ist nie leer - ohne Einstellung
        // steht dort die Zone, auf die der Server zurückfällt, und genau die
        // muss die Oberfläche als Automatik-Label zeigen können (#829).
        timezone: cfgGet('household_timezone') || null,
        timezone_effective: householdTimeZone(db.get()),
        // Hat ein Admin die Frage "Zone des Browsers uebernehmen?" schon
        // beantwortet (#1607)? `timezone: null` allein sagt es nicht: "nie
        // gesetzt" und "bewusst Automatisch" sehen gleich aus. Haushaltsweit,
        // damit die Antwort fuer jeden Admin auf jedem Geraet gilt.
        timezone_hint_dismissed: cfgGet('household_timezone_hint_dismissed') === '1',
        // Drei Sichten auf dieselbe Einstellung, weil drei verschiedene Fragen
        // dahinterstecken: was ist gewählt (Select-Zustand), was gilt gerade
        // (API-Konsument), und was ergäbe die Automatik (Label der ersten Option).
        language: isSupportedLocale(cfgGet('language')) ? cfgGet('language') : null,
        language_effective: resolveHouseholdLocale(db.get()),
        language_auto: resolveHouseholdLocale(db.get(), { ignoreExplicit: true }),
        app_name: appName,
        disabled_modules: disabledModules,
        hidden_modules: hiddenModules,
        module_order: moduleOrder,
        mobile_nav_order: mobileNavOrder,
        more_pins: parseMorePins(cfgUserGet('more_pins', req.authUserId)),
        housekeeping_payment_tasks: cfgGet('housekeeping_payment_tasks') === '1',
        budget_mode: VALID_BUDGET_MODES.includes(cfgGet('budget_mode')) ? cfgGet('budget_mode') : DEFAULT_BUDGET_MODE,
        calendar_default_duration: Number(cfgGet('calendar_default_duration')) || DEFAULT_CALENDAR_DURATION,
        // Standardwerte für neue Termine (per-user, #497/#498).
        calendar_default_reminders: parseDefaultReminders(cfgUserGet('calendar_default_reminders', req.authUserId)),
        calendar_default_assign_me: cfgUserGet('calendar_default_assign_me', req.authUserId) === '1',
        calendar_default_target: cfgUserGet('calendar_default_target', req.authUserId) || '',
        // Modul-Feature-Schalter (haushaltweit). Default an: fehlender Wert =>
        // Feature aktiv, damit Bestandshaushalte ihr Verhalten behalten.
        ...healthCycleViews(req.authUserId),
        // Betreuungs-Fan-out fuer Vorsorge-Erinnerungen (D6/Review #1256) -
        // Opt-in wie cycle_settings.notify_partner_user_id: der Eigentuemer
        // veroeffentlicht bewusst, es teilt nichts von selbst.
        health_prevention_notify_caregivers: cfgUserGet('health_prevention_notify_caregivers', req.authUserId) === '1',
        tasks_subtasks_expanded: cfgGet('tasks_subtasks_expanded') === '1',
        // The kitchen wall (Tafla, 2026-10-19): may it tick things off, and
        // which sections does it show. Household-wide; the display reads both
        // (DISPLAY_PREFERENCE_KEYS) to draw itself, the routes enforce the first.
        wall_allow_ticking: cfgGet('wall_allow_ticking') === '1',
        wall_sections: parseWallSections(cfgGet('wall_sections')),
        countdown_grace_days: parseCountdownGraceDays(cfgGet('countdown_grace_days')),
        // Standard-Erinnerungsliste fuer neue Aufgaben (per-user, #695) -
        // dieselbe Form wie calendar_default_target, damit beide Dialoge ihr
        // Ziel gleich benennen.
        tasks_default_target: cfgUserGet('tasks_default_target', req.authUserId) || '',
        schedule_hidden_templates: parseScheduleHiddenTemplates(cfgGet('schedule_hidden_templates')),
        weather_provider: cfgGet('weather_provider') ?? null,
        weather_lat:      cfgGet('weather_lat')      ?? null,
        weather_lon:      cfgGet('weather_lon')      ?? null,
        weather_city:     cfgGet('weather_city')     ?? '',
        weather_units:    cfgGet('weather_units')    ?? 'metric',
        weather_auto_locate: cfgGet('weather_auto_locate') === '1',
        weather_user: weatherUserOverride(req.authUserId),
        weather_source: householdWeatherSource(),
        holiday_country:       cfgGet('holiday_country')       ?? null,
        holiday_subdivision:   cfgGet('holiday_subdivision')   ?? null,
        holiday_group:         cfgGet('holiday_group')         ?? null,
        holiday_show_public:   cfgGet('holiday_show_public')   === '1',
        holiday_show_school:   cfgGet('holiday_show_school')   === '1',
        holiday_public_color:  cfgGet('holiday_public_color')  ?? '#FF3B30',
        holiday_school_color:  cfgGet('holiday_school_color')  ?? '#34C759',
        holiday_last_sync:     cfgGet('holiday_last_sync')     ?? null,
        // A derived flag (#1766): true when Immich is configured and, for a
        // paired display, when an admin has switched the screensaver on for it.
        screensaver_enabled: isScreensaverEnabled() && (req.authMethod !== 'display' || req.displayShowsScreensaver === true),
    };
    // EIN WANDTABLETT BEKOMMT NUR DEN DARSTELLUNGSTEIL (#1208). Diese Antwort
    // ist die Sammelstelle des ganzen Haushalts - Wohnkoordinaten,
    // Budget-Betriebsart, Zyklus-Einstellungen, Sync-Ziele -, und sie steht dem
    // Display nur offen, weil die App ohne sie nicht startet. Was uebrig
    // bleibt, ist eine Allowlist in display-scopes.js.
    res.json({ data: req.authMethod === 'display' ? pickDisplayPreferences(data) : data });
  } catch (err) {
    log.error('GET /', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/preferences
// Haushalt-Praeferenzen aktualisieren.
// Body: { visible_meal_types: string[] }
// Response: { data: { visible_meal_types: string[] } }
//
// GANZE PATCH ODER NICHTS (#1622). Der Handler prueft und schreibt Feld fuer
// Feld, und jedes abgelehnte Feld verlaesst ihn ueber ein
// `return res.status(4xx)`. Damit die Felder davor dann nicht stehen bleiben,
// laeuft die ganze Feldfolge in EINER Transaktion: COMMIT steht genau einmal,
// hinter dem letzten Feld und der fertig gebauten Erfolgsantwort, unmittelbar
// vor dem Senden; jeder andere Ausgang
// (400, 401, 403, geworfener Fehler) findet im finally eine offene Transaktion
// vor und rollt sie zurueck. Ein neues Feld mit neuem fruehem `return` ist
// damit von selbst abgedeckt - es muss dafuer nichts nach oben gezogen werden.
//
// BEGIN/COMMIT von Hand statt `db.transaction(fn)`: der Helfer committet bei
// jedem normalen Ruecksprung, ein `return res.status(400)` waere fuer ihn ein
// Erfolg. Verschachtelte `db.transaction()`-Aufrufe weiter unten bleiben
// richtig - der Treiber macht aus ihnen Savepoints, sobald eine Transaktion
// offen ist. Der Treiber ist synchron und zwischen BEGIN und COMMIT steht kein
// `await`; kaeme eines dazu, laege die offene Transaktion ueber fremden Requests.
// --------------------------------------------------------

router.put('/', (req, res) => {
  let database = null;
  try {
    database = db.get();
    database.exec('BEGIN');
    const { visible_meal_types, meal_type_names, currency, date_format, time_format, week_start, region, timezone, timezone_hint_dismissed, language, app_name, disabled_modules, hidden_modules, module_order, mobile_nav_order, more_pins, housekeeping_payment_tasks, budget_mode, calendar_default_duration, calendar_default_reminders, calendar_default_assign_me, calendar_default_target, health_cycle_enabled, health_cycle_enabled_user, health_prevention_notify_caregivers, tasks_subtasks_expanded, wall_allow_ticking, wall_sections, tasks_default_target, schedule_hidden_templates, countdown_grace_days, weather_provider, weather_lat, weather_lon, weather_city, weather_units, weather_auto_locate, weather_user, holiday_country, holiday_subdivision, holiday_group, holiday_show_public, holiday_show_school, holiday_public_color, holiday_school_color } = req.body;

    // Welche Quickstart-Vorlagen der Schichtplan-Schnellstart zeigt - wie
    // disabled_modules haushaltweit und admin-only, nicht wie hidden_modules
    // pro Nutzer: die Vorlagen legen geteilte Schichtarten an. Der Check steht
    // hier ganz vorne, vor jedem Schreiben in diesem Request: er sass frueher
    // erst mitten im Handler, nachdem laengst schon andere Haushaltsfelder
    // geschrieben waren - ein gemischtes Payload eines Nicht-Admins wandte sich
    // dann teilweise an, bevor der 403 kam.
    // Seit #1622 nimmt die Transaktion um den Handler so eine Patch ohnehin ganz
    // zurueck; der Check bleibt oben stehen, weil er nichts kostet.
    if (schedule_hidden_templates !== undefined) {
      if (!isAdminRequest(req)) {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (!Array.isArray(schedule_hidden_templates)) {
        return res.status(400).json({ error: 'schedule_hidden_templates muss ein Array sein', code: 400 });
      }
    }

    // Der Merker zum Zonen-Hinweis ist aus demselben Grund hier oben geprueft
    // und erst weiter unten geschrieben.
    if (timezone_hint_dismissed !== undefined) {
      if (!isAdminRequest(req)) {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (typeof timezone_hint_dismissed !== 'boolean') {
        return res.status(400).json({ error: 'timezone_hint_dismissed muss true oder false sein.', code: 400 });
      }
    }

    if (visible_meal_types !== undefined) {
      if (!Array.isArray(visible_meal_types)) {
        return res.status(400).json({ error: 'visible_meal_types muss ein Array sein', code: 400 });
      }
      const filtered = visible_meal_types.filter((t) => VALID_MEAL_TYPES.includes(t));
      if (filtered.length === 0) {
        return res.status(400).json({ error: 'Mindestens ein Mahlzeit-Typ muss aktiv sein', code: 400 });
      }
      cfgSet('visible_meal_types', filtered.join(','));
    }

    if (meal_type_names !== undefined) {
      if (meal_type_names === null) {
        cfgSet('meal_type_names', '');
      } else if (typeof meal_type_names !== 'object' || Array.isArray(meal_type_names)) {
        return res.status(400).json({ error: 'meal_type_names muss ein Objekt sein', code: 400 });
      } else {
        // Jeder gesendete Wert muss ein String sein - eine Zahl oder ein
        // verschachteltes Objekt waere ein Aufruffehler und soll nicht still
        // als leerer Name durchgehen. Welche SLOTS gelten, entscheidet dagegen
        // die Allowlist in parseMealTypeNames(): ein unbekannter Slot ist kein
        // Fehler des Aufrufers, sondern nichts, was wir speichern.
        for (const [slot, value] of Object.entries(meal_type_names)) {
          if (value !== null && typeof value !== 'string') {
            return res.status(400).json({ error: `meal_type_names.${slot} muss ein String sein`, code: 400 });
          }
          if (typeof value === 'string' && value.trim().length > MAX_MEAL_TYPE_NAME) {
            return res.status(400).json({ error: `meal_type_names.${slot}: maximal ${MAX_MEAL_TYPE_NAME} Zeichen`, code: 400 });
          }
        }
        // Ueber parseMealTypeNames normalisiert speichern (getrimmt, leere
        // Namen fallen raus): so steht in der Zeile genau das, was der
        // Lesepfad ohnehin daraus machen wuerde, und ein leeres Objekt ist die
        // Rueckkehr zu den eingebauten Woertern.
        const names = parseMealTypeNames(JSON.stringify(meal_type_names));
        cfgSet('meal_type_names', Object.keys(names).length ? JSON.stringify(names) : '');
      }
    }

    if (currency !== undefined) {
      if (!CURRENCY_CODES.includes(currency)) {
        return res.status(400).json({ error: `Ungültige Währung. Erlaubt: ${CURRENCY_CODES.join(', ')}`, code: 400 });
      }
      cfgSet('currency', currency);
    }

    if (date_format !== undefined) {
      if (!VALID_DATE_FORMATS.includes(date_format)) {
        return res.status(400).json({ error: `Ungültiges Datumsformat. Erlaubt: ${VALID_DATE_FORMATS.join(', ')}`, code: 400 });
      }
      cfgSet('date_format', date_format);
    }

    if (time_format !== undefined) {
      if (!VALID_TIME_FORMATS.includes(time_format)) {
        return res.status(400).json({ error: `Invalid time format. Allowed: ${VALID_TIME_FORMATS.join(', ')}`, code: 400 });
      }
      cfgSet('time_format', time_format);
    }

    // Wochenstart — haushaltweit, von jedem Mitglied änderbar (wie date/time_format).
    if (week_start !== undefined) {
      if (!VALID_WEEK_STARTS.includes(week_start)) {
        return res.status(400).json({ error: `Ungültiger Wochenstart. Erlaubt: ${VALID_WEEK_STARTS.join(', ')}`, code: 400 });
      }
      cfgSet('week_start', week_start);
    }

    // Budget-Modus — haushaltweite Grundsatzentscheidung, nur Admin (#476/#505).
    if (budget_mode !== undefined) {
      if (!isAdminRequest(req)) {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (!VALID_BUDGET_MODES.includes(budget_mode)) {
        return res.status(400).json({ error: `Ungültiger Budget-Modus. Erlaubt: ${VALID_BUDGET_MODES.join(', ')}`, code: 400 });
      }
      cfgSet('budget_mode', budget_mode);
    }

    // Welche Region-Vorlage der Nutzer gewählt hat. Nötig, weil sich mehrere
    // Regionen dasselbe currency/date/time-Triple teilen und der Dropdown sonst
    // nach dem Speichern auf die falsche Region springt (#486).
    //
    // Seit die Datensprache aus der Region abgeleitet wird, ist das keine reine
    // Anzeige-Hilfe mehr: eine Region schiebt die Sprache, in der Geburtstags-
    // Termine gespeichert werden. Deshalb dasselbe Admin-Gate wie bei `language`
    // - sonst wäre der dortige Schutz über diesen Umweg zu umgehen. Die Oberfläche
    // behandelte die Region ohnehin immer als Admin-Feld, nur die Route nicht.
    if (region !== undefined) {
      if (!isAdminRequest(req)) {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (region !== null && !isValidRegionValue(region)) {
        return res.status(400).json({ error: 'Ungültige Region.', code: 400 });
      }
      cfgSet('region', region ?? '');
    }

    // Zeitzone des Haushalts (#829) - dieselbe Sorte Grundsatzentscheidung wie
    // Region und Datensprache, also dasselbe Admin-Gate. null/'' stellt auf
    // "automatisch" zurueck, dann gilt wieder TZ → Systemzone → UTC.
    //
    // Der Wert ist keine Anzeige-Hilfe: an ihm haengen der Kalendertag, den
    // Server-Jobs "heute" nennen, die Zone im ICS-Feed, den fremde Kalender
    // abonnieren, und die Wanduhrzeit, mit der Termine zu Google und Outlook
    // hinausgehen. Ein Mitglied darf ihn deshalb nicht fuer alle umstellen.
    if (timezone !== undefined) {
      if (!isAdminRequest(req)) {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (timezone !== null && timezone !== '' && !isValidTimeZone(timezone)) {
        return res.status(400).json({
          error: 'Ungültige Zeitzone. Erwartet wird eine IANA-Zone wie "Europe/Berlin".', code: 400,
        });
      }
      if (timezone === null || timezone === '') cfgDelete('household_timezone');
      else cfgSet('household_timezone', timezone);
      // Wer die Zone schreibt, hat entschieden - auch mit "Automatisch". Ohne
      // den Merker saehe ein bewusstes Zurueckstellen aus wie "nie gesetzt",
      // und der Hinweis kaeme fuer alle Admins wieder.
      cfgSet('household_timezone_hint_dismissed', '1');
    }

    // Der Merker zum Zonen-Hinweis (#1607): "So lassen" gilt fuer den ganzen
    // Haushalt, also dasselbe Admin-Gate wie die Zone selbst. Ein eigener
    // sync_config-Schluessel und keine Spalte: die Einstellung, zu der er
    // gehoert, liegt ebenfalls dort.
    // Admin-Gate und Typ sind am Anfang des Handlers geprueft.
    if (timezone_hint_dismissed !== undefined) {
      if (timezone_hint_dismissed) cfgSet('household_timezone_hint_dismissed', '1');
      else cfgDelete('household_timezone_hint_dismissed');
    }

    // Datensprache — haushaltweite Grundsatzentscheidung wie Region und Währung,
    // deshalb nur Admin. null/'' stellt auf "automatisch" zurück (aus der Region).
    if (language !== undefined) {
      if (!isAdminRequest(req)) {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (language !== null && language !== '' && !isSupportedLocale(language)) {
        return res.status(400).json({ error: `Ungültige Sprache. Erlaubt: ${VALID_LANGUAGES.join(', ')}`, code: 400 });
      }
      if (language === null || language === '') cfgDelete('language');
      else cfgSet('language', language);
    }

    if (app_name !== undefined) {
      const vAppName = str(app_name, 'Application name', { max: MAX_SHORT, required: false });
      if (vAppName.error) return res.status(400).json({ error: vAppName.error, code: 400 });
      if (vAppName.value) cfgSet('app_name', vAppName.value);
      else cfgDelete('app_name');
    }

    if (disabled_modules !== undefined) {
      if (!isAdminRequest(req)) {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (!Array.isArray(disabled_modules)) {
        return res.status(400).json({ error: 'disabled_modules muss ein Array sein', code: 400 });
      }
      const filtered = disabled_modules
        .filter((m) => typeof m === 'string' && TOGGLEABLE_MODULES.includes(m));
      const unique = [...new Set(filtered)];
      const healthChanged = parseDisabledModules(cfgGet('disabled_modules')).includes('health')
        !== unique.includes('health');
      db.transaction(() => {
        cfgSet('disabled_modules', JSON.stringify(unique));
        if (healthChanged) syncAllFastingReminders(db.get());
      });
    }

    // Persoenlich ausgeblendete Module (#673) - bewusst OHNE Admin-Check, das ist
    // der ganze Punkt: bisher konnte nur eine Adminin Module abschalten, und zwar
    // gleich fuer alle. Siehe parseHiddenModules fuer die Abgrenzung zum
    // Haushalts-Schalter darueber.
    if (hidden_modules !== undefined) {
      if (!Array.isArray(hidden_modules)) {
        return res.status(400).json({ error: 'hidden_modules muss ein Array sein', code: 400 });
      }
      const unique = [...new Set(
        hidden_modules.filter((m) => typeof m === 'string' && TOGGLEABLE_MODULES.includes(m)),
      )];
      cfgUserSet('hidden_modules', req.authUserId, JSON.stringify(unique));
    }

    if (module_order !== undefined) {
      if (!Array.isArray(module_order)) {
        return res.status(400).json({ error: 'module_order muss ein Array sein', code: 400 });
      }
      const unique = [...new Set(module_order.filter((id) => typeof id === 'string' && MODULE_ORDER_RE.test(id)))];
      cfgUserSet('module_order', req.authUserId, JSON.stringify(unique));
    }

    if (mobile_nav_order !== undefined) {
      if (!Array.isArray(mobile_nav_order)) {
        return res.status(400).json({ error: 'mobile_nav_order muss ein Array sein', code: 400 });
      }
      cfgUserSet(
        'mobile_nav_order',
        req.authUserId,
        JSON.stringify(normalizeMobileNavOrder(mobile_nav_order)),
      );
    }

    // Persoenlich wie hidden_modules: wer was in Więcej pinnt, betrifft nur ihn.
    if (more_pins !== undefined) {
      if (more_pins === null) {
        cfgUserDelete('more_pins', req.authUserId);
      } else if (!Array.isArray(more_pins)) {
        return res.status(400).json({ error: 'more_pins muss ein Array sein', code: 400 });
      } else {
        cfgUserSet('more_pins', req.authUserId, JSON.stringify(normalizeMorePins(more_pins)));
      }
    }

    if (housekeeping_payment_tasks !== undefined) {
      if (typeof housekeeping_payment_tasks !== 'boolean') {
        return res.status(400).json({ error: 'housekeeping_payment_tasks must be a boolean', code: 400 });
      }
      cfgSet('housekeeping_payment_tasks', housekeeping_payment_tasks ? '1' : '0');
    }

    if (calendar_default_duration !== undefined) {
      const minutes = Number(calendar_default_duration);
      if (!Number.isInteger(minutes) || minutes < MIN_CALENDAR_DURATION || minutes > MAX_CALENDAR_DURATION) {
        return res.status(400).json({ error: `calendar_default_duration must be an integer between ${MIN_CALENDAR_DURATION} and ${MAX_CALENDAR_DURATION}`, code: 400 });
      }
      cfgSet('calendar_default_duration', String(minutes));
    }

    // Standard-Erinnerungen für neue Termine (#497, per-user).
    if (calendar_default_reminders !== undefined) {
      if (!Array.isArray(calendar_default_reminders)) {
        return res.status(400).json({ error: 'calendar_default_reminders muss ein Array sein', code: 400 });
      }
      const nums = calendar_default_reminders.map(Number);
      if (nums.some((n) => !VALID_REMINDER_OFFSETS.includes(n))) {
        return res.status(400).json({ error: `calendar_default_reminders: erlaubte Offsets (Minuten): ${VALID_REMINDER_OFFSETS.join(', ')}`, code: 400 });
      }
      const unique = [...new Set(nums)].sort((a, b) => a - b);
      if (unique.length > MAX_DEFAULT_REMINDERS) {
        return res.status(400).json({ error: `Maximal ${MAX_DEFAULT_REMINDERS} Standard-Erinnerungen.`, code: 400 });
      }
      cfgUserSet('calendar_default_reminders', req.authUserId, JSON.stringify(unique));
    }

    // Neue Termine standardmäßig mir zuweisen (#498, per-user).
    if (calendar_default_assign_me !== undefined) {
      cfgUserSet('calendar_default_assign_me', req.authUserId, calendar_default_assign_me ? '1' : '0');
    }

    // Standard-Sync-Ziel für eigene neue Termine (#620, per-user).
    if (calendar_default_target !== undefined) {
      if (calendar_default_target !== null && typeof calendar_default_target !== 'string') {
        return res.status(400).json({ error: 'calendar_default_target muss ein String sein', code: 400 });
      }
      const target = (calendar_default_target ?? '').trim();
      if (target.length > MAX_CALENDAR_TARGET_LENGTH) {
        return res.status(400).json({ error: `calendar_default_target: maximal ${MAX_CALENDAR_TARGET_LENGTH} Zeichen`, code: 400 });
      }
      // Leer = "Lokal speichern" und damit das ausdrückliche Abwählen eines
      // zuvor gesetzten Ziels. parseSyncTargetValue liefert dafür {kind:'local'},
      // also einen gültigen Wert, und null nur bei echtem Formfehler.
      if (parseSyncTargetValue(target) === null) {
        return res.status(400).json({ error: 'calendar_default_target: erwartet "google:<id>", "caldav:<kontoId>|<url>" oder "outlook:<kontoId>|<kalenderId>"', code: 400 });
      }
      cfgUserSet('calendar_default_target', req.authUserId, target);
    }

    // Standard-Erinnerungsliste für eigene neue Aufgaben (#695, per-user).
    // Geprüft wird nur die Form; ob die Liste noch freigegeben ist, entscheidet
    // die Aufgaben-Route beim Anlegen. Ein Ziel hier hart abzuweisen, weil eine
    // Liste zwischenzeitlich abgewählt wurde, machte die Einstellung unspeicherbar,
    // ohne dass der Grund an dieser Stelle sichtbar wäre.
    if (tasks_default_target !== undefined) {
      if (tasks_default_target !== null && typeof tasks_default_target !== 'string') {
        return res.status(400).json({ error: 'tasks_default_target muss ein String sein', code: 400 });
      }
      const target = (tasks_default_target ?? '').trim();
      if (target.length > MAX_CALENDAR_TARGET_LENGTH) {
        return res.status(400).json({ error: `tasks_default_target: maximal ${MAX_CALENDAR_TARGET_LENGTH} Zeichen`, code: 400 });
      }
      const parsed = parseSyncTargetValue(target);
      if (parsed === null || parsed.kind === 'google') {
        return res.status(400).json({ error: 'tasks_default_target: erwartet "caldav:<kontoId>|<url>"', code: 400 });
      }
      cfgUserSet('tasks_default_target', req.authUserId, target);
    }

    // Validiert (Admin-Rolle, Array-Form) bereits ganz oben, vor jedem anderen
    // Schreiben in diesem Request - hier nur noch der eigentliche Schreibvorgang.
    if (schedule_hidden_templates !== undefined) {
      const unique = [...new Set(
        schedule_hidden_templates.filter((key) => typeof key === 'string' && SCHEDULE_TEMPLATE_KEYS.includes(key)),
      )];
      cfgSet('schedule_hidden_templates', JSON.stringify(unique));
    }

    // Haushaltweite Modul-Feature-Schalter — nur Admins.
    if (health_cycle_enabled !== undefined) {
      if (!isAdminRequest(req)) {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (typeof health_cycle_enabled !== 'boolean') {
        return res.status(400).json({ error: 'health_cycle_enabled must be a boolean', code: 400 });
      }
      cfgSet('health_cycle_enabled', health_cycle_enabled ? '1' : '0');
    }

    // Persönliches Opt-out (#760) - bewusst OHNE Admin-Gate: es betrifft nur die
    // eigene Ansicht, und derselbe Fehler (per-user-Wert hinter adminOnly) kostete
    // schon einmal fünf von sechs Familienmitgliedern ihre Einstellung
    // (Critique 2026-07-27, siehe calendar_default_reminders).
    if (health_cycle_enabled_user !== undefined) {
      if (typeof health_cycle_enabled_user !== 'boolean') {
        return res.status(400).json({ error: 'health_cycle_enabled_user must be a boolean', code: 400 });
      }
      cfgUserSet('health_cycle_enabled', req.authUserId, health_cycle_enabled_user ? '1' : '0');
    }

    // Betreuungs-Fan-out fuer Vorsorge-Erinnerungen (D6/Review #1256) - Opt-in,
    // Standard aus. Wirkt sofort: derselbe Sync, den caregivers.js nach einer
    // Betreuungs-Aenderung anstoesst, nicht erst der naechste periodische Lauf.
    if (health_prevention_notify_caregivers !== undefined) {
      if (typeof health_prevention_notify_caregivers !== 'boolean') {
        return res.status(400).json({ error: 'health_prevention_notify_caregivers must be a boolean', code: 400 });
      }
      cfgUserSet('health_prevention_notify_caregivers', req.authUserId, health_prevention_notify_caregivers ? '1' : '0');
      try { syncPreventionRemindersForSubject(db.get(), req.authUserId); } catch (err) {
        log.error('Error syncing prevention reminders after notify_caregivers change:', err.message);
      }
    }

    if (tasks_subtasks_expanded !== undefined) {
      if (!isAdminRequest(req)) {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (typeof tasks_subtasks_expanded !== 'boolean') {
        return res.status(400).json({ error: 'tasks_subtasks_expanded must be a boolean', code: 400 });
      }
      cfgSet('tasks_subtasks_expanded', tasks_subtasks_expanded ? '1' : '0');
    }

    // The kitchen wall (Tafla, 2026-10-19). Admin only: a household choice
    // about what a shared screen may do, not a personal view.
    if (wall_allow_ticking !== undefined) {
      if (!isAdminRequest(req)) {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (typeof wall_allow_ticking !== 'boolean') {
        return res.status(400).json({ error: 'wall_allow_ticking must be a boolean', code: 400 });
      }
      cfgSet('wall_allow_ticking', wall_allow_ticking ? '1' : '0');
    }

    if (wall_sections !== undefined) {
      if (!isAdminRequest(req)) {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      const sections = normalizeWallSections(wall_sections, parseWallSections(cfgGet('wall_sections')));
      if (!sections) {
        return res.status(400).json({ error: 'wall_sections must map known wall sections to booleans', code: 400 });
      }
      cfgSet('wall_sections', JSON.stringify(sections));
    }

    // Nachfrist für abgelaufene Countdowns (#969). 0 = keine Nachfrist.
    if (countdown_grace_days !== undefined) {
      if (!isAdminRequest(req)) {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      const days = Number(countdown_grace_days);
      if (!Number.isInteger(days) || days < 0 || days > MAX_COUNTDOWN_GRACE_DAYS) {
        return res.status(400).json({ error: `countdown_grace_days must be an integer between 0 and ${MAX_COUNTDOWN_GRACE_DAYS}`, code: 400 });
      }
      cfgSet('countdown_grace_days', String(days));
    }

    // Weather configuration — admin only
    if (
      weather_provider !== undefined ||
      weather_lat      !== undefined ||
      weather_lon      !== undefined ||
      weather_city     !== undefined ||
      weather_units    !== undefined ||
      weather_auto_locate !== undefined
    ) {
      if (!isAdminRequest(req)) {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (weather_provider !== undefined) {
        if (weather_provider !== null && !VALID_WEATHER_PROVIDERS.includes(weather_provider)) {
          return res.status(400).json({ error: `Ungültiger Anbieter. Erlaubt: ${VALID_WEATHER_PROVIDERS.join(', ')}`, code: 400 });
        }
        if (weather_provider === null) cfgDelete('weather_provider');
        else cfgSet('weather_provider', weather_provider);
      }
      // `null` loescht die Koordinaten des Haushalts. Ohne das blieben sie beim
      // Entfernen des Anbieters liegen, und der Proxy nahm sie weiter - die
      // `.env`-Werte kamen nie wieder zum Zug.
      if (weather_lat === null) {
        cfgDelete('weather_lat');
      } else if (weather_lat !== undefined) {
        const v = parseFloat(weather_lat);
        if (isNaN(v) || v < -90 || v > 90) {
          return res.status(400).json({ error: 'Ungültiger Breitengrad (–90 bis 90).', code: 400 });
        }
        cfgSet('weather_lat', String(v));
      }
      if (weather_lon === null) {
        cfgDelete('weather_lon');
      } else if (weather_lon !== undefined) {
        const v = parseFloat(weather_lon);
        if (isNaN(v) || v < -180 || v > 180) {
          return res.status(400).json({ error: 'Ungültiger Längengrad (–180 bis 180).', code: 400 });
        }
        cfgSet('weather_lon', String(v));
      }
      if (weather_city !== undefined) {
        const trimmed = String(weather_city).slice(0, 100).trim();
        if (trimmed) cfgSet('weather_city', trimmed);
        else cfgDelete('weather_city');
      }
      if (weather_units !== undefined) {
        if (!VALID_WEATHER_UNITS.includes(weather_units)) {
          return res.status(400).json({ error: `Ungültige Einheit. Erlaubt: ${VALID_WEATHER_UNITS.join(', ')}`, code: 400 });
        }
        cfgSet('weather_units', weather_units);
      }
      if (weather_auto_locate !== undefined) {
        if (typeof weather_auto_locate !== 'boolean') {
          return res.status(400).json({ error: 'weather_auto_locate muss ein Boolean sein.', code: 400 });
        }
        cfgSet('weather_auto_locate', weather_auto_locate ? '1' : '0');
      }
    }

    // Per-User-Wetter-Override — von jedem authentifizierten Nutzer schreibbar.
    if (weather_user !== undefined) {
      if (typeof weather_user !== 'object' || weather_user === null || Array.isArray(weather_user)) {
        return res.status(400).json({ error: 'weather_user muss ein Objekt sein.', code: 400 });
      }
      const uid = req.authUserId;
      if (!uid) {
        return res.status(401).json({ error: 'Authentifizierung erforderlich.', code: 401 });
      }
      const { lat, lon, city, units, auto_locate } = weather_user;

      if (lat !== undefined) {
        if (lat === null) cfgDelete(userCfgKey('weather_lat', uid));
        else {
          const v = parseFloat(lat);
          if (isNaN(v) || v < -90 || v > 90) {
            return res.status(400).json({ error: 'Ungültiger Breitengrad (–90 bis 90).', code: 400 });
          }
          cfgUserSet('weather_lat', uid, String(v));
        }
      }
      if (lon !== undefined) {
        if (lon === null) cfgDelete(userCfgKey('weather_lon', uid));
        else {
          const v = parseFloat(lon);
          if (isNaN(v) || v < -180 || v > 180) {
            return res.status(400).json({ error: 'Ungültiger Längengrad (–180 bis 180).', code: 400 });
          }
          cfgUserSet('weather_lon', uid, String(v));
        }
      }
      if (city !== undefined) {
        const trimmed = city === null ? '' : String(city).slice(0, 100).trim();
        if (trimmed) cfgUserSet('weather_city', uid, trimmed);
        else cfgDelete(userCfgKey('weather_city', uid));
      }
      if (units !== undefined) {
        if (units === null) cfgDelete(userCfgKey('weather_units', uid));
        else {
          if (!VALID_WEATHER_UNITS.includes(units)) {
            return res.status(400).json({ error: `Ungültige Einheit. Erlaubt: ${VALID_WEATHER_UNITS.join(', ')}`, code: 400 });
          }
          cfgUserSet('weather_units', uid, units);
        }
      }
      if (auto_locate !== undefined) {
        if (auto_locate === null) cfgDelete(userCfgKey('weather_auto_locate', uid));
        else {
          if (typeof auto_locate !== 'boolean') {
            return res.status(400).json({ error: 'weather_user.auto_locate muss ein Boolean sein.', code: 400 });
          }
          cfgUserSet('weather_auto_locate', uid, auto_locate ? '1' : '0');
        }
      }
    }

    // Holiday configuration — admin only
    if (
      holiday_country      !== undefined ||
      holiday_subdivision  !== undefined ||
      holiday_group        !== undefined ||
      holiday_show_public  !== undefined ||
      holiday_show_school  !== undefined ||
      holiday_public_color !== undefined ||
      holiday_school_color !== undefined
    ) {
      if (!isAdminRequest(req)) {
        return res.status(403).json({ error: 'Admin access required.', code: 403 });
      }
      if (holiday_country !== undefined) {
        if (holiday_country !== null && !COUNTRY_ISO_RE.test(holiday_country)) {
          return res.status(400).json({ error: 'Ungültiger Ländercode (2 Großbuchstaben, z. B. DE).', code: 400 });
        }
        if (holiday_country === null) {
          cfgDelete('holiday_country');
          cfgDelete('holiday_subdivision');
          cfgDelete('holiday_group');
        } else {
          // Anderes Land ohne mitgeschickte Gruppe: die gespeicherte gehoert zum
          // alten Land (BE-FR) und darf das neue nicht filtern (Review zu PR #1186).
          if (holiday_group === undefined && cfgGet('holiday_country') !== holiday_country) cfgDelete('holiday_group');
          cfgSet('holiday_country', holiday_country);
        }
      }
      if (holiday_subdivision !== undefined) {
        if (holiday_subdivision !== null && !SUBDIVISION_RE.test(holiday_subdivision)) {
          return res.status(400).json({ error: 'Ungültiger Regionscode (z. B. DE-BY).', code: 400 });
        }
        // Wird eine gespeicherte Subdivision entfernt, faellt ihre Schulferien-
        // Gruppe mit (CH-BE-VS gehoert zu CH-BE). War gar keine gespeichert, gehoert
        // eine gespeicherte Gruppe dem Land selbst (BE-FR, D#1182) und bleibt:
        // sonst loeschte ein Teil-Update nur mit `holiday_subdivision: null` still
        // die gewaehlte Gemeinschaft (Review zu PR #1186).
        if (holiday_subdivision === null) {
          const hadSubdivision = cfgGet('holiday_subdivision') != null;
          cfgDelete('holiday_subdivision');
          if (hadSubdivision) cfgDelete('holiday_group');
        } else {
          cfgSet('holiday_subdivision', holiday_subdivision);
        }
      }
      // Schulferien-Gruppe (z. B. CH-BE-VS) mehrsprachiger Kantone. Nutzt dieselbe
      // Grammatik wie ein Regionscode. NULL/leer = keine Gruppe gewählt. (#434)
      if (holiday_group !== undefined) {
        if (holiday_group !== null && holiday_group !== '' && !SUBDIVISION_RE.test(holiday_group)) {
          return res.status(400).json({ error: 'Ungültiger Gruppencode (z. B. CH-BE-VS).', code: 400 });
        }
        if (holiday_group === null || holiday_group === '') cfgDelete('holiday_group');
        else cfgSet('holiday_group', holiday_group);
      }
      if (holiday_show_public !== undefined) {
        if (typeof holiday_show_public !== 'boolean') {
          return res.status(400).json({ error: 'holiday_show_public must be a boolean.', code: 400 });
        }
        cfgSet('holiday_show_public', holiday_show_public ? '1' : '0');
      }
      if (holiday_show_school !== undefined) {
        if (typeof holiday_show_school !== 'boolean') {
          return res.status(400).json({ error: 'holiday_show_school must be a boolean.', code: 400 });
        }
        cfgSet('holiday_show_school', holiday_show_school ? '1' : '0');
      }
      if (holiday_public_color !== undefined) {
        if (!HEX_COLOR_RE.test(holiday_public_color)) {
          return res.status(400).json({ error: 'holiday_public_color muss ein gültiger Hex-Farbwert sein (z. B. #FF3B30).', code: 400 });
        }
        cfgSet('holiday_public_color', holiday_public_color);
      }
      if (holiday_school_color !== undefined) {
        if (!HEX_COLOR_RE.test(holiday_school_color)) {
          return res.status(400).json({ error: 'holiday_school_color muss ein gültiger Hex-Farbwert sein (z. B. #34C759).', code: 400 });
        }
        cfgSet('holiday_school_color', holiday_school_color);
      }
    }

    // DIE ANTWORT WIRD NOCH IN DER TRANSAKTION GEBAUT (#1622, Review zu #1627).
    // Sie liest aus der Datenbank zurueck, und manche dieser Lesewege fragen
    // weitere Tabellen ab. Wirft
    // einer davon NACH dem COMMIT, sagt die Antwort 500 und die Patch steht
    // trotzdem. Hier oben sieht das Lesen dieselben Werte - dieselbe Verbindung
    // liest ihre eigenen, noch nicht committeten Schreibungen -, und ein Wurf
    // findet die Transaktion noch offen.
    const rawMealTypes = cfgGet('visible_meal_types') ?? DEFAULT_MEAL_TYPES;
    const savedMealTypes = rawMealTypes.split(',').filter((t) => VALID_MEAL_TYPES.includes(t));
    const savedCurrency = cfgGet('currency') ?? DEFAULT_CURRENCY;
    const savedDateFormat = VALID_DATE_FORMATS.includes(cfgGet('date_format')) ? cfgGet('date_format') : DEFAULT_DATE_FORMAT;
    const savedTimeFormat = VALID_TIME_FORMATS.includes(cfgGet('time_format')) ? cfgGet('time_format') : DEFAULT_TIME_FORMAT;
    const savedWeekStart = VALID_WEEK_STARTS.includes(cfgGet('week_start')) ? cfgGet('week_start') : DEFAULT_WEEK_START;
    const savedAppName = cfgGet('app_name') ?? DEFAULT_APP_NAME;
    const savedDisabledModules = parseDisabledModules(cfgGet('disabled_modules'));
    const savedHiddenModules = parseHiddenModules(cfgUserGet('hidden_modules', req.authUserId));
    const savedModuleOrder = parseModuleOrder(cfgUserGet('module_order', req.authUserId) ?? cfgGet('module_order'));
    const savedMobileNavOrder = parseMobileNavOrder(cfgUserGet('mobile_nav_order', req.authUserId));
    const savedHousekeepingPaymentTasks = cfgGet('housekeeping_payment_tasks') === '1';
    // AUS DER DATENBANK ZURUECKLESEN, nicht aus dem Request: der Client sieht so
    // genau das, was gespeichert wurde - getrimmt, gekappt, unbekannte Slots
    // schon aussortiert - statt seiner eigenen Eingabe.
    const savedMealTypeNames = parseMealTypeNames(cfgGet('meal_type_names'));

    const payload = {
      data: {
        visible_meal_types: savedMealTypes,
        meal_type_names: savedMealTypeNames,
        currency: savedCurrency,
        date_format: savedDateFormat,
        time_format: savedTimeFormat,
        week_start: savedWeekStart,
        region: cfgGet('region') || null,
        timezone: cfgGet('household_timezone') || null,
        timezone_effective: householdTimeZone(db.get()),
        timezone_hint_dismissed: cfgGet('household_timezone_hint_dismissed') === '1',
        language: isSupportedLocale(cfgGet('language')) ? cfgGet('language') : null,
        language_effective: resolveHouseholdLocale(db.get()),
        language_auto: resolveHouseholdLocale(db.get(), { ignoreExplicit: true }),
        app_name: savedAppName,
        disabled_modules: savedDisabledModules,
        hidden_modules: savedHiddenModules,
        module_order: savedModuleOrder,
        mobile_nav_order: savedMobileNavOrder,
        more_pins: parseMorePins(cfgUserGet('more_pins', req.authUserId)),
        housekeeping_payment_tasks: savedHousekeepingPaymentTasks,
        budget_mode: VALID_BUDGET_MODES.includes(cfgGet('budget_mode')) ? cfgGet('budget_mode') : DEFAULT_BUDGET_MODE,
        calendar_default_duration: Number(cfgGet('calendar_default_duration')) || DEFAULT_CALENDAR_DURATION,
        calendar_default_reminders: parseDefaultReminders(cfgUserGet('calendar_default_reminders', req.authUserId)),
        calendar_default_assign_me: cfgUserGet('calendar_default_assign_me', req.authUserId) === '1',
        calendar_default_target: cfgUserGet('calendar_default_target', req.authUserId) || '',
        ...healthCycleViews(req.authUserId),
        // Betreuungs-Fan-out fuer Vorsorge-Erinnerungen (D6/Review #1256) -
        // Opt-in wie cycle_settings.notify_partner_user_id: der Eigentuemer
        // veroeffentlicht bewusst, es teilt nichts von selbst.
        health_prevention_notify_caregivers: cfgUserGet('health_prevention_notify_caregivers', req.authUserId) === '1',
        tasks_subtasks_expanded: cfgGet('tasks_subtasks_expanded') === '1',
        // The kitchen wall (Tafla, 2026-10-19): may it tick things off, and
        // which sections does it show. Household-wide; the display reads both
        // (DISPLAY_PREFERENCE_KEYS) to draw itself, the routes enforce the first.
        wall_allow_ticking: cfgGet('wall_allow_ticking') === '1',
        wall_sections: parseWallSections(cfgGet('wall_sections')),
        countdown_grace_days: parseCountdownGraceDays(cfgGet('countdown_grace_days')),
        // Standard-Erinnerungsliste fuer neue Aufgaben (per-user, #695) -
        // dieselbe Form wie calendar_default_target, damit beide Dialoge ihr
        // Ziel gleich benennen.
        tasks_default_target: cfgUserGet('tasks_default_target', req.authUserId) || '',
        schedule_hidden_templates: parseScheduleHiddenTemplates(cfgGet('schedule_hidden_templates')),
        weather_provider: cfgGet('weather_provider') ?? null,
        weather_lat:      cfgGet('weather_lat')      ?? null,
        weather_lon:      cfgGet('weather_lon')      ?? null,
        weather_city:     cfgGet('weather_city')     ?? '',
        weather_units:    cfgGet('weather_units')    ?? 'metric',
        weather_auto_locate: cfgGet('weather_auto_locate') === '1',
        weather_user: weatherUserOverride(req.authUserId),
        holiday_country:       cfgGet('holiday_country')       ?? null,
        holiday_subdivision:   cfgGet('holiday_subdivision')   ?? null,
        holiday_group:         cfgGet('holiday_group')         ?? null,
        holiday_show_public:   cfgGet('holiday_show_public')   === '1',
        holiday_show_school:   cfgGet('holiday_show_school')   === '1',
        holiday_public_color:  cfgGet('holiday_public_color')  ?? '#FF3B30',
        holiday_school_color:  cfgGet('holiday_school_color')  ?? '#34C759',
        holiday_last_sync:     cfgGet('holiday_last_sync')     ?? null,
      },
    };

    // Alle Felder sind durch und die Antwort steht - erst jetzt wird die Patch
    // wirksam. Hinter dem COMMIT kommt nur noch das Senden: kein Datenbankzugriff
    // und keine Berechnung, die einen 500 ueber eine gespeicherte Patch legen
    // koennte.
    database.exec('COMMIT');
    res.json(payload);
  } catch (err) {
    log.error('PUT /', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  } finally {
    // Noch offen heisst: der Handler ist NICHT ueber das COMMIT gegangen - ein
    // Feld wurde abgelehnt oder etwas hat geworfen. Dann gilt nichts aus dieser
    // Patch (#1622). Die Antwort ist zu diesem Zeitpunkt schon abgeschickt und
    // bleibt, wie sie ist; dazwischen liegt kein Yield-Punkt, an dem ein anderer
    // Request den halben Stand lesen koennte.
    if (database?.inTransaction) {
      try {
        database.exec('ROLLBACK');
      } catch (err) {
        log.error('PUT / - Rollback fehlgeschlagen', err);
      }
    }

    // Gespeicherte Geburtstags-Termine an die geltende Datensprache angleichen.
    //
    // Unbedingt statt nur bei erkannter Verschiebung: retitleBirthdayEvents
    // vergleicht ohnehin pro Zeile und schreibt nur, was abweicht. Ein Vergleich
    // vorher/nachher wäre ein zweiter Ort, an dem alle Wege zur Datensprache
    // (language, region, date_format) vollständig aufgezählt sein müssten.
    //
    // Im finally und NACH dem Rollback, in einer eigenen Transaktion: der Lauf
    // soll den Stand sehen, der wirklich gilt, und sein eigener Fehler darf die
    // Patch nicht mitreissen. Nach einer abgelehnten Patch hat sich die
    // Datensprache nicht bewegt, dann findet er nichts zu tun.
    //
    // Fehler beenden die Anfrage nicht: die Antwort ist zu diesem Zeitpunkt
    // längst gesendet, und die Präferenzen sind geschrieben. Der nächste PUT
    // versucht es erneut - der Lauf ist idempotent.
    try {
      db.transaction(() => retitleBirthdayEvents(db.get()));
    } catch (err) {
      log.error('PUT / - Geburtstags-Termine konnten nicht umbenannt werden', err);
    }
  }
});

// GET /api/v1/preferences/holidays/countries
router.get('/holidays/countries', async (_req, res) => {
  try {
    const countries = await holidays.getCountries();
    res.json({ data: countries });
  } catch (err) {
    log.error('GET /holidays/countries', err);
    res.status(502).json({ error: 'Fehler beim Abrufen der Länderliste.', code: 502 });
  }
});

// GET /api/v1/preferences/holidays/subdivisions/:countryCode?lang=
// `lang` ist die UI-Sprache des Lesers (#1723). Sie geht durch
// supportedLocaleFor(), also durch die Liste der Locale-Dateien: alles andere
// (unbekannter Code, Pfadzeichen, doppelter Parameter) wird zu null und damit
// zu Englisch - wie bei `lang` der Budget-Kategorien, kein 400.
router.get('/holidays/subdivisions/:countryCode', async (req, res) => {
  const { countryCode } = req.params;
  if (!COUNTRY_ISO_RE.test(countryCode)) {
    return res.status(400).json({ error: 'Ungültiger Ländercode.', code: 400 });
  }
  try {
    const subdivisions = await holidays.getSubdivisions(countryCode, supportedLocaleFor(req.query.lang));
    res.json({ data: subdivisions });
  } catch (err) {
    log.error('GET /holidays/subdivisions/:countryCode', err);
    res.status(502).json({ error: 'Fehler beim Abrufen der Regionsliste.', code: 502 });
  }
});

// GET /api/v1/preferences/holidays/groups/:countryCode
// Schulferien-Gruppen eines Landes ohne Subdivisionen (Belgien, D#1182). Leere
// Liste fuer jedes Land, das Subdivisionen fuehrt - dort gehoeren die Gruppen
// zur Region und kommen ueber die Route darunter.
router.get('/holidays/groups/:countryCode', async (req, res) => {
  const { countryCode } = req.params;
  if (!COUNTRY_ISO_RE.test(countryCode)) {
    return res.status(400).json({ error: 'Ungültiger Ländercode.', code: 400 });
  }
  try {
    const groups = await holidays.getGroups(countryCode, null);
    res.json({ data: groups });
  } catch (err) {
    log.error('GET /holidays/groups/:countryCode', err);
    res.status(502).json({ error: 'Fehler beim Abrufen der Ferien-Gruppen.', code: 502 });
  }
});

// GET /api/v1/preferences/holidays/groups/:countryCode/:subdivisionCode
// Schulferien-Gruppen einer Subdivision (mehrsprachige Kantone). Leere Liste,
// wenn die Subdivision nur ein Ferien-Regime kennt. (#434)
router.get('/holidays/groups/:countryCode/:subdivisionCode', async (req, res) => {
  const { countryCode, subdivisionCode } = req.params;
  if (!COUNTRY_ISO_RE.test(countryCode)) {
    return res.status(400).json({ error: 'Ungültiger Ländercode.', code: 400 });
  }
  if (!SUBDIVISION_RE.test(subdivisionCode)) {
    return res.status(400).json({ error: 'Ungültiger Regionscode.', code: 400 });
  }
  try {
    const groups = await holidays.getGroups(countryCode, subdivisionCode);
    res.json({ data: groups });
  } catch (err) {
    log.error('GET /holidays/groups/:countryCode/:subdivisionCode', err);
    res.status(502).json({ error: 'Fehler beim Abrufen der Ferien-Gruppen.', code: 502 });
  }
});

// POST /api/v1/preferences/holidays/sync  (admin only)
router.post('/holidays/sync', async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'Admin access required.', code: 403 });
  }
  try {
    await holidays.sync(true);
    res.json({ data: { last_sync: cfgGet('holiday_last_sync') ?? null } });
  } catch (err) {
    log.error('POST /holidays/sync', err);
    res.status(502).json({ error: 'Fehler bei der Feiertags-Synchronisierung: ' + err.message, code: 502 });
  }
});

export default router;
