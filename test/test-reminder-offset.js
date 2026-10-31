/**
 * Tests: Erinnerungs-Zeitpunkte (public/utils/reminder-offset.js)
 * Fokus: Issue #354 — `remind_at` liegt als naiv-UTC in der Datenbank und muss
 *        als UTC gelesen werden, auch in einer Nicht-UTC-Zeitzone. Vorher wurde
 *        es als Lokalzeit gelesen, wodurch sich der Zonen-Offset bei jedem
 *        Speichern aufaddierte. Dazu die feste Erinnerung des Blatts „Neue
 *        Aufgabe" (Quick-Add): Datum + Uhrzeit der Haushaltszone <-> naiv-UTC.
 *        Die Vorlauf-Presets des alten Aufgaben-Dialogs sind mit Quick-Add
 *        entfallen (Ruling R2) und mit ihnen ihre Tests.
 *
 * Wir setzen TZ vor jedem Date-Gebrauch auf UTC+5 (Asia/Yekaterinburg), genau
 * die Konstellation des Bug-Reports (300 min Drift).
 * Ausführen: node test/test-reminder-offset.js
 */
process.env.TZ = 'Asia/Yekaterinburg'; // UTC+5, fester DST-freier Offset

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseRemindAtAsUtc, naiveUtc } = await import('../public/utils/reminder-offset.js');

test('parseRemindAtAsUtc: ein naiver Wert ist UTC, nicht Geraetezeit (#354)', () => {
  assert.equal(parseRemindAtAsUtc('2026-06-12T07:00:00').toISOString(), '2026-06-12T07:00:00.000Z');
  assert.equal(parseRemindAtAsUtc('2026-06-12T07:00:00Z').toISOString(), '2026-06-12T07:00:00.000Z');
  assert.equal(parseRemindAtAsUtc('2026-06-12T09:00:00+02:00').toISOString(), '2026-06-12T07:00:00.000Z');
});

test('naiveUtc: schreibt, was der Server ablegt - auch mehrfach ohne Drift', () => {
  let value = '2026-06-12T07:00:00';
  for (let i = 0; i < 5; i++) value = naiveUtc(value);
  assert.equal(value, '2026-06-12T07:00:00');
  assert.equal(naiveUtc('2026-06-12T07:00:00Z'), '2026-06-12T07:00:00');
  assert.equal(naiveUtc(''), null);
  assert.equal(naiveUtc('kaputt'), null);
});

test('die Vorlauf-Presets sind weg - kein Aufrufer rechnet mehr aus der Faelligkeit', async () => {
  const mod = await import('../public/utils/reminder-offset.js');
  for (const name of ['resolveReminderPreset', 'remindAtFromPreset', 'parseOffsetMsFromReminder']) {
    assert.equal(name in mod, false, `${name} ist entfallen`);
  }
});

// --------------------------------------------------------------------------
// Feste Uhrzeit statt Vorlauf (Quick-Add, Task 6): Datum + Uhrzeit in der
// Haushaltszone <-> naiv-UTC `remind_at`. Prozess in UTC+5, Haushalt in
// Warschau - ein Rechenfehler ueber die Geraetezone faellt so auf.
// --------------------------------------------------------------------------
const { setDisplayTimeZone } = await import('../public/utils/timezone.js');
const { remindAtFromWallTime, wallTimeFromRemindAt } = await import('../public/utils/reminder-offset.js');

function inWarsaw(fn) {
  setDisplayTimeZone('Europe/Warsaw');
  try { return fn(); } finally { setDisplayTimeZone(null); }
}

test('remindAtFromWallTime: Wanduhrzeit des Haushalts als naiv-UTC (Winter- und Sommerzeit)', () => inWarsaw(() => {
  assert.equal(remindAtFromWallTime('2026-10-30', '07:30'), '2026-10-30T06:30:00'); // CET nach dem 25.10.
  assert.equal(remindAtFromWallTime('2026-07-01', '07:30'), '2026-07-01T05:30:00'); // CEST
}));

test('remindAtFromWallTime: unlesbare Eingaben ergeben null', () => inWarsaw(() => {
  assert.equal(remindAtFromWallTime('2026-10-30', '25:00'), null);
  assert.equal(remindAtFromWallTime('2026-10-30', ''), null);
  assert.equal(remindAtFromWallTime('', '07:30'), null);
  assert.equal(remindAtFromWallTime('30.10.2026', '07:30'), null);
  assert.equal(remindAtFromWallTime(undefined, undefined), null);
}));

test('wallTimeFromRemindAt: die Gegenrichtung, auch ueber Mitternacht', () => inWarsaw(() => {
  assert.deepEqual(wallTimeFromRemindAt('2026-10-30T06:30:00'), { date: '2026-10-30', time: '07:30' });
  assert.deepEqual(wallTimeFromRemindAt('2026-10-30T23:30:00'), { date: '2026-10-31', time: '00:30' });
  assert.equal(wallTimeFromRemindAt(''), null);
  assert.equal(wallTimeFromRemindAt('kaputt'), null);
}));

test('Roundtrip ueber Datum und Uhrzeit bleibt stehen', () => inWarsaw(() => {
  const at = remindAtFromWallTime('2026-10-25', '08:15');
  assert.deepEqual(wallTimeFromRemindAt(at), { date: '2026-10-25', time: '08:15' });
}));
