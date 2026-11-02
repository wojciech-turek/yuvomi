/**
 * Modul: Terminfarbe → Anzeigefarbe
 * Zweck: EINE Regel, wie ein Termin zu seiner Farbe kommt - an genau einer
 *        Stelle. Die Farbe eines Termins sind seine Leute (One Today, spec 7).
 * Ausfuehren: node --experimental-sqlite --test test/test-calendar.js
 * Dependencies: ./person-color.js (Personentinte, geteilte Scheibe)
 *
 * DIE REGEL
 *   - eine Person zugewiesen: ihre Tinte (person-color.js, Haushaltsreihenfolge);
 *   - zwei Personen: geteilt - die Flaeche im gemeinsamen Ton, die Kante und der
 *     Punkt in beiden Tinten, hart geschnitten wie die geteilte Scheibe;
 *   - drei und mehr: der gemeinsame Ton (Akzent), wie die Razem-Scheibe;
 *   - niemand: neutral, derselbe ruhige Ton wie eine Scheibe ausserhalb des
 *     Haushalts. Ein Besuch der Haushaltshilfe ist deshalb neutral, auch wenn
 *     er noch eine alte Kalenderfarbe traegt.
 *
 * GESPEICHERTE FARBEN ZEICHNET NIEMAND MEHR. `calendar_events.color`, die
 * Farbe eines Kalenders oder Abos, die vom Anbieter (Google, CalDAV, Outlook)
 * - die Spalten bleiben, der Abgleich schreibt sie weiter, aber gelesen werden
 * sie hier nicht. Bis One Today stand die eigene Terminfarbe vorn (#815, #891);
 * dieselbe Person trug damit je Termin eine andere Farbe.
 *
 * Der Server liest dieselbe Regel (services/countdowns.js), deshalb steht die
 * Datei in der Allowlist von test:layer-boundary und importiert relativ.
 */

import { personToken, razemBackground } from './person-color.js';

/** Niemand zugewiesen: der ruhige Ton einer Scheibe ausserhalb des Haushalts. */
export const EVENT_FALLBACK_COLOR = personToken(null).ink;

/** Mehrere Personen: der gemeinsame Ton der Razem-Scheibe. */
export const EVENT_SHARED_COLOR = 'var(--color-accent)';

/** Die Personen eines Termins ohne Luecken und Doppelte, in ihrer Reihenfolge. */
function peopleOf(ev) {
  const list = (Array.isArray(ev?.assigned_users) ? ev.assigned_users : [])
    .filter((person) => person && person.id != null);
  return [...new Map(list.map((person) => [Number(person.id), person])).values()];
}

/**
 * Wie die Leute einen Termin faerben.
 *
 * @param {{ assigned_users?: Array<{ id: number|string }> }|null} ev
 * @param {{ household?: object[] }} [opts] die Mitglieder (sonst die gehaltene Reihenfolge)
 * @returns {{ kind: 'none'|'person'|'split'|'shared', color: string, fill: string, edge: string|null }}
 *   `color` der eine Ton fuer Flaeche, Schrift und Kante; `fill` der Hintergrund
 *   eines Punkts (bei zwei Personen die geteilte Scheibe); `edge` das Bild der
 *   Kante bei zwei Personen (beide Tinten, oben die erste), sonst null.
 */
export function eventTone(ev, { household = [] } = {}) {
  const people = peopleOf(ev);
  if (!people.length) {
    return { kind: 'none', color: EVENT_FALLBACK_COLOR, fill: EVENT_FALLBACK_COLOR, edge: null };
  }
  if (people.length === 1) {
    const { ink } = personToken(people[0], household);
    return { kind: 'person', color: ink, fill: ink, edge: null };
  }
  if (people.length === 2) {
    const [a, b] = people.map((person) => personToken(person, household).ink);
    return {
      kind: 'split',
      color: EVENT_SHARED_COLOR,
      fill: razemBackground(people[0], people[1], household),
      edge: `linear-gradient(${a} 0 50%, ${b} 50% 100%)`,
    };
  }
  return { kind: 'shared', color: EVENT_SHARED_COLOR, fill: EVENT_SHARED_COLOR, edge: null };
}

/**
 * Die Anzeigefarbe eines Termins: der eine Ton aus `eventTone()`.
 * @param {object|null} ev
 * @param {{ household?: object[] }} [opts]
 * @returns {string}
 */
export function resolveEventColor(ev, opts = {}) {
  return eventTone(ev, opts).color;
}

/**
 * Dieselbe Regel, aber `null`, wenn niemand zugewiesen ist - fuer Aufrufer mit
 * einem besseren Notnagel als dem neutralen Ton (die Countdown-Kachel faellt
 * auf den Ton ihres Moduls zurueck).
 * @param {object|null} ev
 * @param {{ household?: object[] }} [opts]
 * @returns {string|null}
 */
export function resolveEventColorOrNull(ev, opts = {}) {
  const tone = eventTone(ev, opts);
  return tone.kind === 'none' ? null : tone.color;
}
