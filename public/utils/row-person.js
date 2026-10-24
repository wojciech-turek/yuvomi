/**
 * Modul: Wem gehoert eine Zeile (Tafla-Personenregel fuer Listen)
 * Zweck: Die Regel aus DESIGN.md (Direction Contract, "The person-colour
 *        rule") fuer jede Zeile, die Personen traegt - Aufgaben, Termine,
 *        Aufgaben im Kalender: die eigene Zeile zeigt keine Scheibe, die einer
 *        anderen Person deren Initial in ihrer Personenfarbe, eine geteilte die
 *        Razem-Scheibe. Dazu die 3pt-Kante eines Termins (Person, violett fuer
 *        gemeinsam).
 * Abhaengigkeiten: utils/person-color.js (Farben, Markup), utils/initials.js
 *
 * Die Farben und das Markup stehen in person-color.js (Foundation); hier steht
 * nur die Entscheidung, WELCHE Scheibe eine Zeile bekommt. Die Startseite
 * rechnet dieselbe Regel in utils/today-plan.js (`whoOf`) fuer ihre Zeilen.
 */

import { personDisc, razemDisc, personToken } from '/utils/person-color.js';
import { initials } from '/utils/initials.js';

/** Das erste Wort eines Anzeigenamens ("Mariola Kowalska" -> "Mariola"). */
export function firstName(displayName) {
  const name = String(displayName ?? '').trim();
  return name.split(/\s+/)[0] || name;
}

/** Die Personen einer Zeile ohne Luecken und Doppelte. */
function peopleOf(people) {
  const list = (Array.isArray(people) ? people : []).filter((p) => p && p.id != null);
  return [...new Map(list.map((p) => [Number(p.id), p])).values()];
}

/**
 * Wer eine Zeile traegt, aus Sicht von `viewerId`:
 *   { kind: 'none' }               eigene oder niemandem zugewiesene Zeile
 *   { kind: 'person', person }     die Zeile einer anderen Person
 *   { kind: 'razem', people }      mehr als eine Person (geteilt)
 * Ohne Betrachter (Wandtablett) ist keine Zeile "eigene": jede Person zeigt
 * ihre Scheibe.
 */
export function whoOf(people, viewerId = null) {
  const list = peopleOf(people);
  if (!list.length) return { kind: 'none' };
  if (list.length === 1) {
    return viewerId != null && Number(list[0].id) === Number(viewerId)
      ? { kind: 'none' }
      : { kind: 'person', person: list[0] };
  }
  return { kind: 'razem', people: list };
}

/** Ist der Betrachter unter den Personen der Zeile? */
export function includesViewer(people, viewerId) {
  return viewerId != null && peopleOf(people).some((p) => Number(p.id) === Number(viewerId));
}

/**
 * Die Scheibe am Ende einer Zeile (20pt), oder ''.
 * @param {{kind: string, person?: object, people?: object[]}} who aus whoOf()
 * @param {{ household?: object[], razemLabel?: (people: object[]) => string }} [opts]
 *   `household` haelt die Plaetze der Personen auseinander (person-color.js);
 *   `razemLabel` liefert den uebersetzten Namen der geteilten Scheibe.
 */
export function whoDiscHtml(who, { household = [], razemLabel = () => '' } = {}) {
  if (!who || who.kind === 'none') return '';
  if (who.kind === 'person') {
    const name = String(who.person.display_name ?? '');
    return personDisc(who.person, { text: initials(firstName(name), '?'), label: name, household });
  }
  const [a, b] = who.people;
  return razemDisc(a, b ?? a, { label: razemLabel(who.people), household });
}

/**
 * Die 3pt-Kante eines Termins: die Personenfarbe bei einer Person, Violett bei
 * mehreren (blau und rosa mischen sich zu violett, "razem" braucht keinen
 * dritten Ton), '' ohne Person - dann entscheidet der Aufrufer.
 */
export function edgeColorOf(people, household = []) {
  const list = peopleOf(people);
  if (list.length === 1) return personToken(list[0], household).ink;
  if (list.length > 1) return 'var(--color-accent)';
  return '';
}
