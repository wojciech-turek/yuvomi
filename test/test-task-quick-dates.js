/**
 * Tests: Schnellwahl fuer Faelligkeit und Erinnerung (public/utils/task-quick-dates.js)
 * Rein: Datum `YYYY-MM-DD`, Uhrzeit `HH:MM`, Haushaltszone Europe/Warsaw.
 * 2026-10-29 ist ein Donnerstag; die Sommerzeit endete am 25.10.2026.
 * Ausfuehren: node test/test-task-quick-dates.js
 */
process.env.TZ = 'Asia/Yekaterinburg'; // Geraetezone != Haushaltszone

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { setDisplayTimeZone } = await import('../public/utils/timezone.js');
const { dueQuickPick, reminderQuickPicks, defaultReminder } = await import('../public/utils/task-quick-dates.js');

setDisplayTimeZone('Europe/Warsaw');

const flat = (picks) => picks.map((p) => [p.key, p.date, p.time]);

test('dueQuickPick: heute, morgen, Wochenende', () => {
  assert.equal(dueQuickPick('today', '2026-10-29'), '2026-10-29');
  assert.equal(dueQuickPick('tomorrow', '2026-10-29'), '2026-10-30');
  assert.equal(dueQuickPick('tomorrow', '2026-10-31'), '2026-11-01');
  assert.equal(dueQuickPick('weekend', '2026-10-29'), '2026-10-31'); // Do -> Sa
  assert.equal(dueQuickPick('weekend', '2026-10-30'), '2026-10-31'); // Fr -> Sa
  assert.equal(dueQuickPick('weekend', '2026-10-31'), '2026-10-31'); // Sa bleibt
  assert.equal(dueQuickPick('weekend', '2026-11-01'), '2026-11-01'); // So bleibt
  assert.equal(dueQuickPick('weekend', '2026-11-02'), '2026-11-07'); // Mo -> Sa
});

test('dueQuickPick: unbekannter Schluessel oder Datum ergibt leer', () => {
  assert.equal(dueQuickPick('nope', '2026-10-29'), '');
  assert.equal(dueQuickPick('today', 'kaputt'), '');
});

test('reminderQuickPicks: ohne Faelligkeit keine Vorschlaege', () => {
  assert.deepEqual(reminderQuickPicks({ dueDate: '', dueTime: '' }), []);
  assert.deepEqual(reminderQuickPicks({}), []);
});

test('reminderQuickPicks: ohne Uhrzeit Basis 09:00, keine Stunde vorher', () => {
  assert.deepEqual(flat(reminderQuickPicks({ dueDate: '2026-10-30', dueTime: '' })),
    [['at_due', '2026-10-30', '09:00'], ['day_before', '2026-10-29', '09:00']]);
});

test('reminderQuickPicks: mit Uhrzeit auch eine Stunde vorher', () => {
  assert.deepEqual(flat(reminderQuickPicks({ dueDate: '2026-10-30', dueTime: '18:00' })), [
    ['at_due', '2026-10-30', '18:00'],
    ['hour_before', '2026-10-30', '17:00'],
    ['day_before', '2026-10-29', '18:00'],
  ]);
  // Stunde vorher ueber Mitternacht
  assert.deepEqual(flat(reminderQuickPicks({ dueDate: '2026-10-30', dueTime: '00:30' }))[1],
    ['hour_before', '2026-10-29', '23:30']);
});

// 10:00 UTC = 11:00 in Warschau, am Tag vor der Faelligkeit.
const BEFORE_DUE = new Date('2026-10-29T10:00:00Z');

test('defaultReminder: mit Faelligkeit der at_due-Vorschlag', () => {
  assert.deepEqual(defaultReminder({ dueDate: '2026-10-30', dueTime: '18:00', now: BEFORE_DUE }), { date: '2026-10-30', time: '18:00' });
  assert.deepEqual(defaultReminder({ dueDate: '2026-10-30', now: BEFORE_DUE }), { date: '2026-10-30', time: '09:00' });
});

// Der Server nimmt ein `remind_at` in der Vergangenheit an, und der naechste
// Takt der Benachrichtigungen schickt es sofort: Sekunden nach dem Speichern
// kaeme ein Push, spaeter keiner mehr. Eine Vorgabe liegt deshalb nie zurueck.
test('defaultReminder: ein at_due-Vorschlag, der nicht nach jetzt liegt, faellt auf die Regel ohne Faelligkeit zurueck', () => {
  // 13:00 UTC = 14:00 in Warschau
  const at14 = new Date('2026-10-29T13:00:00Z');
  // heute faellig ohne Uhrzeit: 09:00 ist vorbei -> naechste volle Stunde
  assert.deepEqual(defaultReminder({ dueDate: '2026-10-29', now: at14 }), { date: '2026-10-29', time: '15:00' });
  // heute faellig um 12:00 - auch vorbei
  assert.deepEqual(defaultReminder({ dueDate: '2026-10-29', dueTime: '12:00', now: at14 }), { date: '2026-10-29', time: '15:00' });
  // genau jetzt ist nicht "danach"
  assert.deepEqual(defaultReminder({ dueDate: '2026-10-29', dueTime: '14:00', now: at14 }), { date: '2026-10-29', time: '15:00' });
  // eine Minute spaeter liegt danach und bleibt
  assert.deepEqual(defaultReminder({ dueDate: '2026-10-29', dueTime: '14:01', now: at14 }), { date: '2026-10-29', time: '14:01' });
  // heute faellig um 18:00 - liegt noch vor uns
  assert.deepEqual(defaultReminder({ dueDate: '2026-10-29', dueTime: '18:00', now: at14 }), { date: '2026-10-29', time: '18:00' });
  // ueberfaellig (vorgestern)
  assert.deepEqual(defaultReminder({ dueDate: '2026-10-27', now: at14 }), { date: '2026-10-29', time: '15:00' });
});

test('defaultReminder: eine vergangene Faelligkeit spaet am Abend -> morgen 09:00', () => {
  // 20:30 UTC = 21:30 in Warschau, heute faellig ohne Uhrzeit
  assert.deepEqual(defaultReminder({ dueDate: '2026-10-29', now: new Date('2026-10-29T20:30:00Z') }), { date: '2026-10-30', time: '09:00' });
});

test('defaultReminder: ohne Faelligkeit heute zur naechsten vollen Stunde (Haushaltszone)', () => {
  // 10:15 UTC = 11:15 in Warschau (CET)
  assert.deepEqual(defaultReminder({ now: new Date('2026-10-29T10:15:00Z') }), { date: '2026-10-29', time: '12:00' });
  // genau voll: die naechste volle Stunde
  assert.deepEqual(defaultReminder({ now: new Date('2026-10-29T10:00:00Z') }), { date: '2026-10-29', time: '12:00' });
});

test('defaultReminder: nach 21:00 morgen 09:00, "heute" ist das Haushaltsdatum', () => {
  assert.deepEqual(defaultReminder({ now: new Date('2026-10-29T21:30:00Z') }), { date: '2026-10-30', time: '09:00' });
  // 23:30 UTC ist in Warschau schon der 30., 00:30 -> heute (30.) um 01:00, nicht der UTC-Tag
  assert.deepEqual(defaultReminder({ now: new Date('2026-10-29T23:30:00Z') }), { date: '2026-10-30', time: '01:00' });
  // 20:30 Ortszeit (19:30 UTC) -> 21:00 noch heute
  assert.deepEqual(defaultReminder({ now: new Date('2026-10-29T19:30:00Z') }), { date: '2026-10-29', time: '21:00' });
});

test('defaultReminder: genau 21:00 ist schon "nach 21:00" -> morgen 09:00', () => {
  // 20:00 UTC = 21:00:00 in Warschau
  assert.deepEqual(defaultReminder({ now: new Date('2026-10-29T20:00:00Z') }), { date: '2026-10-30', time: '09:00' });
  // eine Minute davor: 21:00 noch heute
  assert.deepEqual(defaultReminder({ now: new Date('2026-10-29T19:59:00Z') }), { date: '2026-10-29', time: '21:00' });
});
