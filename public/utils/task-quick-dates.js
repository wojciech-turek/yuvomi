/**
 * Schnellwahl fuer Faelligkeit und Erinnerung im Aufgaben-Dialog (rein, ohne DOM).
 * Datum `YYYY-MM-DD`, Uhrzeit `HH:MM`; "heute" liefert der Aufrufer bzw.
 * `defaultReminder` aus der Haushaltszone - nie aus dem UTC-Datum.
 */
import { zonedFields } from './timezone.js';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const pad2 = (n) => String(n).padStart(2, '0');

/** Kalenderarithmetik auf Tagen, in UTC gerechnet - frei von Zeitumstellungen. */
function addDays(dateKey, days) {
  const m = DATE_RE.exec(dateKey);
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}

/**
 * Das Datum hinter einer Schnellwahl der Faelligkeit.
 * Wochenende = heute, wenn heute Samstag/Sonntag ist, sonst der naechste Samstag.
 * @param {'today'|'tomorrow'|'weekend'} key
 * @param {string} today `YYYY-MM-DD`
 * @returns {string} `YYYY-MM-DD`, leer bei unbekanntem Schluessel oder Datum
 */
export function dueQuickPick(key, today) {
  const m = DATE_RE.exec(String(today ?? ''));
  if (!m) return '';
  if (key === 'today') return today;
  if (key === 'tomorrow') return addDays(today, 1);
  if (key === 'weekend') {
    const dow = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay(); // 0 = So
    if (dow === 0 || dow === 6) return today;
    return addDays(today, 6 - dow);
  }
  return '';
}

/**
 * Vorschlaege fuer eine feste Erinnerung, abgeleitet aus der Faelligkeit.
 * Ohne Faelligkeit keine; ohne Uhrzeit ist die Basis 09:00 und es gibt kein
 * "1 Stunde vorher".
 * @returns {Array<{key: 'at_due'|'hour_before'|'day_before', date: string, time: string}>}
 */
export function reminderQuickPicks({ dueDate, dueTime } = {}) {
  if (!DATE_RE.test(String(dueDate ?? ''))) return [];
  const hasTime = TIME_RE.test(String(dueTime ?? ''));
  const time = hasTime ? dueTime : '09:00';
  const picks = [{ key: 'at_due', date: dueDate, time }];
  if (hasTime) {
    const [h, min] = time.split(':').map(Number);
    const before = (h * 60 + min - 60 + 1440) % 1440;
    picks.push({
      key: 'hour_before',
      date: h === 0 ? addDays(dueDate, -1) : dueDate,
      time: `${pad2(Math.floor(before / 60))}:${pad2(before % 60)}`,
    });
  }
  picks.push({ key: 'day_before', date: addDays(dueDate, -1), time });
  return picks;
}

/**
 * Die Erinnerung, die der Dialog vorbelegt: mit Faelligkeit deren
 * "zur Faelligkeit"-Vorschlag, sonst heute zur naechsten vollen Stunde
 * (ab 21:00 morgen um 09:00) - "heute" nach der Uhr des Haushalts.
 *
 * EINE VORGABE LIEGT NIE ZURUECK. Der Server nimmt ein `remind_at` in der
 * Vergangenheit an, und der naechste Takt der Benachrichtigungen schickt es
 * sofort: heute faellig ohne Uhrzeit hiesse um 14:00 "heute 09:00" - ein Push
 * Sekunden nach dem Speichern und spaeter keiner. Liegt der Vorschlag nicht
 * NACH jetzt (Wanduhr des Haushalts, minutengenau), gilt die Regel ohne
 * Faelligkeit.
 * @returns {{date: string, time: string}}
 */
export function defaultReminder({ dueDate, dueTime, now = new Date() } = {}) {
  const f = zonedFields(now);
  const today = `${f.year}-${pad2(f.month)}-${pad2(f.day)}`;
  const due = reminderQuickPicks({ dueDate, dueTime })[0];
  if (due && `${due.date}T${due.time}` > `${today}T${pad2(f.hour)}:${pad2(f.minute)}`) {
    return { date: due.date, time: due.time };
  }
  const next = f.hour + 1;
  if (next > 21) return { date: addDays(today, 1), time: '09:00' };
  return { date: today, time: `${pad2(next)}:00` };
}
