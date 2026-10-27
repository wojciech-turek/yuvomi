/**
 * Modul: Einstellungen - die Werte in den Zeilen der Wurzel (Tafla, 2026-10-20)
 * Zweck: "Wie ist das eingestellt?" beantwortet die Liste selbst: am Ende
 *        jeder Zeile steht ihr Wert (Wygląd "Automatyczny", Domownicy
 *        "2 osoby", Asystent AI "Włączony" ...). Jeder Wert kommt aus einer
 *        Quelle, die es schon gibt; fehlt sie (kein Recht, kein Netz, nach
 *        einem Neustart unbekannt), bleibt die Zeile ohne Wert - nie mit einem
 *        erfundenen.
 * Abhängigkeiten: /api.js, /i18n.js, /push.js, /utils/household.js,
 *                 /utils/person-color.js, ./module-order.js
 *
 * Bewusst NICHT da, weil es das nicht gibt: Ruhezeiten, ein Haushaltsname,
 * ein Geraetename.
 */

import { api } from '/api.js';
import { t, formatDate, formatTime } from '/i18n.js';
import { pushStatus, pushSupported } from '/push.js';
import { getHouseholdSize } from '/utils/household.js';
import { todayKey, zonedDateKey } from '/utils/timezone.js';
import { personSlot, PERSON_PALETTE } from '/utils/person-color.js';
import { BUILT_IN_MODULES, KITCHEN_CHILD_IDS } from './module-order.js';
import { getPreferences } from './preferences-cache.js';

/** Name und Tinte der eigenen Personenfarbe (dieselbe Zuordnung wie ueberall). */
export function colorValue(user, household = []) {
  if (!user) return null;
  const slot = personSlot(user, household);
  const entry = PERSON_PALETTE[slot - 1];
  if (!entry) return null;
  return { text: t(`settings.colorName.${entry.key}`), ink: `var(--person-${slot})` };
}

/** Wie viele Module der Haushalt an hat - die Kueche zaehlt als eines. */
export function enabledModuleCount(disabled = []) {
  const off = new Set(Array.isArray(disabled) ? disabled : []);
  const plain = BUILT_IN_MODULES.filter((m) => !m.locked && !off.has(m.id)).length;
  const kitchen = KITCHEN_CHILD_IDS.some((id) => !off.has(id)) ? 1 : 0;
  return plain + kitchen;
}

/** "dziś 03:00", "wczoraj 03:00" oder das Datum - Tage im Haushalt gezaehlt. */
export function whenValue(timestamp, now = new Date()) {
  const key = zonedDateKey(timestamp);
  if (!key) return '';
  const today = todayKey(now);
  const [y, m, d] = today.split('-').map(Number);
  const before = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  const time = formatTime(timestamp);
  if (key === today) return t('settings.valueTodayAt', { time });
  if (key === before) return t('settings.valueYesterdayAt', { time });
  return formatDate(timestamp);
}

/** Die letzte Sicherung, so wie der Server sie kennt - oder null. */
export function backupValue(scheduler) {
  if (!scheduler) return null;
  if (scheduler.enabled === false && !scheduler.webdav?.lastUpload) return t('settings.valueOff');
  const last = scheduler.lastBackup?.timestamp
    ? scheduler.lastBackup
    : (scheduler.webdav?.lastUpload ? { timestamp: scheduler.webdav.lastUpload, success: true } : null);
  if (!last) return null;
  return last.success === false
    ? t('settings.valueBackupFailed', { when: whenValue(last.timestamp) })
    : whenValue(last.timestamp);
}

/** Ist ein Tablett gekoppelt? Ein Geraet ohne Widerruf zaehlt. */
export function tabletValue(displays) {
  if (!Array.isArray(displays) || !displays.length) return null;
  const paired = displays.some((d) => (d.devices ?? []).some((device) => !device.revoked_at));
  return paired ? t('settings.valueTabletPaired') : t('settings.valueTabletNotPaired');
}

/**
 * Laedt die Werte und reicht jeden einzeln an `put(key, value)`, sobald er da
 * ist - eine langsame Quelle haelt die anderen nicht auf.
 * @param {object} user
 * @param {(key: string, value: string|{text: string, ink?: string}) => void} put
 */
export function loadOverviewValues(user, put) {
  const admin = user?.role === 'admin';
  const safe = (promise) => promise.catch(() => null);

  // (Die Zeile Wygląd nannte bis v2 das Theme dieses Geraets - es gibt nur
  // noch das helle, 2026-10-27.)

  const size = getHouseholdSize();
  if (size) put('members', t('more.peopleAtHome', { count: size }));

  const jobs = [];
  jobs.push(safe(getPreferences()).then((prefs) => {
    if (!prefs) return;
    const personal = prefs.weather_user?.city;
    if (personal) put('weather-personal', personal);
    if (prefs.weather_city) put('weather', prefs.weather_city);
    if (admin) put('modules', t('settings.valueModulesOn', { count: enabledModuleCount(prefs.disabled_modules) }));
  }));
  // Die Farbe haengt am Haushalt (zwei Menschen teilen nie eine), also mit
  // der Liste der Mitglieder; ohne sie gilt die eigene Vorliebe.
  jobs.push(safe(api.get('/auth/users')).then((res) => {
    const members = (Array.isArray(res?.data) ? res.data : []).filter((u) => u.is_household_member !== false);
    const color = colorValue(user, members);
    if (color) put('color', color);
  }));
  if (pushSupported()) {
    jobs.push(safe(pushStatus()).then((status) => {
      if (!status || status.available === false) return;
      put('push', status.subscribed ? t('settings.valuePushOn') : t('settings.valuePushOff'));
    }));
  }
  jobs.push(safe(api.get('/ai/status')).then((res) => {
    if (res?.data) put('ai', res.data.enabled ? t('settings.valueOnMasc') : t('settings.valueOffMasc'));
  }));
  if (admin) {
    jobs.push(safe(api.get('/displays')).then((res) => {
      const value = tabletValue(res?.data);
      if (value) put('tablet', value);
    }));
    jobs.push(safe(api.get('/backup/status')).then((res) => {
      const value = backupValue(res?.data?.scheduler);
      if (value) put('backup', value);
    }));
  }
  return Promise.all(jobs);
}
