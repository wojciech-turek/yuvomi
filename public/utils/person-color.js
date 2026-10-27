/**
 * Modul: Personenfarbe (Tafla)
 * Zweck: Ordnet ein Haushaltsmitglied einem der sechs kuratierten Farbpaare
 *        zu (--person-N / --person-N-tint, tokens.css Abschnitt 4c) und baut
 *        die geteilte "Razem"-Scheibe.
 * Abhaengigkeiten: html-escape.js
 *
 * WARUM NICHT DIE AVATARFARBE SELBST. users.avatar_color ist frei waehlbar
 * (Farbwaehler in den Einstellungen, iOS-Systemfarben als Vorgabe): auf
 * Papier haelt eine beliebige Farbe als Text oder 3pt-Kante keine Zusage.
 * Tafla nimmt deshalb die NAECHSTE kuratierte Farbe - jedes Paar ist
 * AA-gemessen (Initial auf der Toenung, Text auf Karte, Papier, Fill und
 * Herd). Die Farbe, die jemand gewaehlt hat, bleibt
 * die Richtung; die Palette liefert die lesbare Fassung davon.
 *
 * STABIL: dieselbe Person bekommt immer denselben Platz. Ohne Haushaltsliste
 * entscheidet allein der Farbton (der naechste Platz auf dem Farbkreis); mit
 * Liste waehlen die Mitglieder in der Reihenfolge ihrer id, und wer einen
 * besetzten Platz traefe, nimmt den naechstbesten freien - zwei Menschen in
 * einem Haushalt teilen nie eine Farbe (bis sechs Personen). Graue oder
 * fehlende Avatarfarben haben keinen Farbton; sie starten bei (id - 1) mod 6.
 *
 * NUR FUER IDENTITAET: Initial, 3pt-Terminkante, 6pt-Punkt. Nichts anderes
 * traegt Personenfarbe. Eigene Eintraege zeigen gar keinen Avatar.
 */

import { esc } from './html-escape.js';

/** Die sechs Plaetze. `hue` ist der Farbton der Tinte (HSL-Grad).
 * v2 (2026-10-27): nur noch hell - die dunklen Paare sind mit dem Dark Mode
 * gegangen; Blau und Rose tragen die Scheiben aus Foundations.dc.html. */
export const PERSON_PALETTE = Object.freeze([
  Object.freeze({ slot: 1, key: 'blue', hue: 219, ink: '#1F4FA8', tint: '#E3ECFB' }),
  Object.freeze({ slot: 2, key: 'rose', hue: 340, ink: '#A3264F', tint: '#FBE4EC' }),
  Object.freeze({ slot: 3, key: 'green', hue: 144, ink: '#2A6E45', tint: '#E0EFE5' }),
  Object.freeze({ slot: 4, key: 'terracotta', hue: 19, ink: '#A3461C', tint: '#F6E5DA' }),
  Object.freeze({ slot: 5, key: 'plum', hue: 294, ink: '#8F4398', tint: '#F2E4F4' }),
  Object.freeze({ slot: 6, key: 'teal', hue: 187, ink: '#146B77', tint: '#DCEDEF' }),
]);

/** Unter dieser Saettigung (HSL) hat eine Farbe keinen Ton, der zaehlt. */
const MIN_SATURATION = 0.15;

/** Farbton einer Hex-Farbe in Grad, oder null fuer Grau, Weiss, Schwarz und Unlesbares. */
export function avatarHue(color) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color ?? '').trim());
  if (!match) return null;
  const hex = match[1].length === 3 ? [...match[1]].map((c) => c + c).join('') : match[1];
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  if (delta === 0) return null;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  if (saturation < MIN_SATURATION || lightness < 0.08 || lightness > 0.95) return null;
  let hue;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return (hue * 60 + 360) % 360;
}

const hueDistance = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** Die Plaetze in der Reihenfolge, in der diese Person sie bevorzugt. */
function preference(user) {
  const hue = avatarHue(user?.avatar_color);
  if (hue == null) {
    const id = Number.parseInt(user?.id, 10);
    const start = Number.isFinite(id) && id > 0 ? (id - 1) % PERSON_PALETTE.length : 0;
    return PERSON_PALETTE.map((_, i) => PERSON_PALETTE[(start + i) % PERSON_PALETTE.length].slot);
  }
  return [...PERSON_PALETTE]
    .sort((a, b) => hueDistance(hue, a.hue) - hueDistance(hue, b.hue) || a.slot - b.slot)
    .map((entry) => entry.slot);
}

const idOf = (user) => {
  const id = Number.parseInt(user?.id, 10);
  return Number.isFinite(id) ? id : Number.MAX_SAFE_INTEGER;
};

/**
 * Der Platz (1-6) einer Person.
 * @param {{ id?: number|string, avatar_color?: string }} user
 * @param {Array<{ id?: number|string, avatar_color?: string }>} [household] - alle
 *   Mitglieder, deren Farben sich nicht doppeln duerfen (Reihenfolge egal)
 * @returns {number}
 */
export function personSlot(user, household = []) {
  const members = Array.isArray(household) ? household.filter(Boolean) : [];
  const userId = idOf(user);
  if (!members.some((m) => idOf(m) === userId)) members.push(user ?? {});
  members.sort((a, b) => idOf(a) - idOf(b));
  const taken = new Set();
  for (const member of members) {
    const order = preference(member);
    const slot = order.find((s) => !taken.has(s)) ?? order[0];
    taken.add(slot);
    if (idOf(member) === userId) return slot;
  }
  return preference(user)[0];
}

/**
 * Die beiden Tokens einer Person: Tinte (Initial, Kante, Punkt) und Toenung
 * (Scheibe hinter dem Initial).
 * @returns {{ slot: number, ink: string, tint: string }}
 */
export function personToken(user, household = []) {
  const slot = personSlot(user, household);
  return { slot, ink: `var(--person-${slot})`, tint: `var(--person-${slot}-tint)` };
}

const SIZES = ['sm', 'md', 'lg'];

/**
 * Markup der Personenscheibe: Initial in der Tinte auf der Toenung (layout.css,
 * `.person-disc`; sm 20, md 36, lg 40). Das Initial liefert der Aufrufer aus
 * dem EINEN Initialen-Helfer (utils/initials.js), der Name als Label.
 *
 * @param {object} user
 * @param {{ text?: string, label?: string, household?: object[], size?: 'sm'|'md'|'lg', className?: string }} [opts]
 * @returns {string} HTML-String (fuer insertAdjacentHTML; alles escapet)
 */
export function personDisc(user, { text = '', label = '', household = [], size = 'sm', className = '' } = {}) {
  const { ink, tint } = personToken(user, household);
  const classes = ['person-disc', `person-disc--${SIZES.includes(size) ? size : 'sm'}`, className].filter(Boolean).join(' ');
  const a11y = label ? `role="img" aria-label="${esc(label)}" title="${esc(label)}"` : 'aria-hidden="true"';
  return `<span class="${esc(classes)}" ${a11y} style="--person-disc-ink: ${ink}; --person-disc-tint: ${tint}">${esc(text)}</span>`;
}

/**
 * Der Hintergrund der geteilten Scheibe: links oben die eine, rechts unten
 * die andere Person, harte Kante bei 50 % (die zweite erlaubte Verlaufsform
 * neben dem Scroll-Rand-Fade).
 */
export function razemBackground(userA, userB, household = []) {
  const a = personToken(userA, household);
  const b = personToken(userB, household);
  return `linear-gradient(135deg, ${a.ink} 0 50%, ${b.ink} 50% 100%)`;
}

/**
 * Markup der "Razem"-Scheibe (geteilt). Ohne Buchstaben; der Name kommt als
 * Label vom Aufrufer (schon uebersetzt, aus dem i18n-Helfer), und die
 * Scheibe ist ein Bild mit diesem Namen - oder dekorativ, wenn kein Label
 * kommt, weil der Text daneben es schon sagt.
 *
 * @param {object} userA
 * @param {object} userB
 * @param {{ label?: string, household?: object[], size?: 'sm'|'md'|'lg', className?: string }} [opts]
 * @returns {string} HTML-String (fuer insertAdjacentHTML; alles escapet)
 */
export function razemDisc(userA, userB, { label = '', household = [], size = 'sm', className = '' } = {}) {
  const sizeClass = SIZES.includes(size) ? size : 'sm';
  const classes = ['person-disc', `person-disc--${sizeClass}`, 'person-disc--razem', className].filter(Boolean).join(' ');
  const a11y = label ? `role="img" aria-label="${esc(label)}" title="${esc(label)}"` : 'aria-hidden="true"';
  return `<span class="${esc(classes)}" ${a11y} style="background: ${esc(razemBackground(userA, userB, household))}"></span>`;
}
