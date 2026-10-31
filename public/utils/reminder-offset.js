/**
 * Erinnerungs-Zeitpunkte (rein, ohne DOM/i18n)
 * Zweck: `remind_at` lesen und schreiben - als Zeitpunkt (Kalender,
 *        Leseansicht) und als feste Wanduhrzeit der Haushaltszone (das Blatt
 *        „Neue Aufgabe", Quick-Add 2026-10-29).
 *
 * Wichtig: `remind_at` wird als UTC abgelegt (ohne abschließendes "Z"). Daher
 * muss es hier ebenfalls als UTC interpretiert werden — sonst entsteht ein
 * doppelter Zeitzonen-Offset, der sich bei jedem Speichern erneut aufaddiert
 * (Issue #354).
 *
 * Die Vorlauf-Auswahl des Aufgaben-Dialogs (Presets, Rueckrechnung aus der
 * Faelligkeit) ist mit Quick-Add entfallen: eine Aufgaben-Erinnerung ist eine
 * feste Uhrzeit und wandert nicht mit der Faelligkeit.
 */
import { wallTimeToInstantMs, zonedFields } from './timezone.js';

const TZ_SUFFIX = /[zZ]|[+-]\d{2}:?\d{2}$/;

/**
 * Parst einen gespeicherten `remind_at`-Wert als UTC, falls keine
 * Zeitzonenangabe vorhanden ist.
 * @param {string} value
 * @returns {Date}
 */
export function parseRemindAtAsUtc(value) {
  return new Date(TZ_SUFFIX.test(value) ? value : `${value}Z`);
}

/**
 * Schreibt einen `remind_at`-Wert so, wie ihn der Server ablegt: naiv-UTC ohne
 * Zonen-Suffix (siehe `parseRemindAtAsUtc`). Auch der Kalender-Dialog reicht
 * damit einen gespeicherten Zeitpunkt durch, statt ihn neu zu rechnen (#1260).
 * @param {string} value
 * @returns {string|null}
 */
export function naiveUtc(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const date = TZ_SUFFIX.test(text) ? new Date(text) : new Date(`${text}Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Eine feste Erinnerung: Datum + Uhrzeit als Wanduhr der Haushaltszone, abgelegt
 * als naiv-UTC wie `remind_at` (siehe `parseRemindAtAsUtc`).
 * @param {string} date `YYYY-MM-DD`
 * @param {string} time `HH:MM`
 * @returns {string|null} `YYYY-MM-DDTHH:MM:SS` in UTC, null bei unlesbarer Eingabe
 */
export function remindAtFromWallTime(date, time) {
  if (!DATE_RE.test(String(date ?? '')) || !TIME_RE.test(String(time ?? ''))) return null;
  const ms = wallTimeToInstantMs(`${date}T${time}:00`);
  if (ms === null || Number.isNaN(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19);
}

/**
 * Die Gegenrichtung: ein gespeichertes `remind_at` als Datum + Uhrzeit der
 * Haushaltszone.
 * @param {string} remindAt naiv-UTC (oder mit Zonen-Suffix)
 * @returns {{date: string, time: string}|null}
 */
export function wallTimeFromRemindAt(remindAt) {
  if (!remindAt) return null;
  const when = parseRemindAtAsUtc(String(remindAt));
  if (Number.isNaN(when.getTime())) return null;
  const f = zonedFields(when);
  if (!f) return null;
  return {
    date: `${f.year}-${pad2(f.month)}-${pad2(f.day)}`,
    time: `${pad2(f.hour)}:${pad2(f.minute)}`,
  };
}
