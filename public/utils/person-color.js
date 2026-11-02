/**
 * Modul: Personenfarbe und Personenscheibe
 * Zweck: Ordnet ein Haushaltsmitglied einem der sechs kuratierten Farbpaare
 *        zu (--person-N / --person-N-tint, tokens.css Abschnitt 4c) und baut
 *        die EINE Personenscheibe (Bild, sonst Initialen in der Tinte auf der
 *        Toenung) sowie die geteilte "Razem"-Scheibe.
 * Abhaengigkeiten: html-escape.js, initials.js
 *
 * DIE FARBE FOLGT DER HAUSHALTSREIHENFOLGE (One Today, 2026-11-02). Niemand
 * waehlt sie: der Platz ist die Stelle der Person in der Reihenfolge, die die
 * Familien-Einstellungen pflegen (`sort_order`, #1644; bei Gleichstand und
 * fuer Unplatzierte die id, damit ein neuer Name keine Farbe aendert), mod 6.
 * Die gespeicherte `users.avatar_color` liest hier nichts mehr - sie war frei
 * waehlbar, und dieselbe Person trug je Bildschirm eine andere Farbe.
 *
 * DIE REIHENFOLGE KOMMT EINMAL FUER ALLE. `setHouseholdOrder()` haelt sie
 * (api.js aus jeder Auth-Antwort, `householdOrder`; Today und die Wand aus
 * ihrer Mitgliederliste). Eine Seite ohne eigene Liste bekommt damit dieselbe
 * Antwort wie eine mit; wer eine Liste mitgibt, bekommt sie nach derselben
 * Regel geordnet.
 *
 * WER NICHT DARIN STEHT, IST NEUTRAL: Gaeste geteilter Ausgaben, Ehemalige,
 * Hauspersonal - die Scheibe in --color-text-secondary auf --color-fill.
 *
 * NUR FUER IDENTITAET: Initial, 3pt-Terminkante, 6pt-Punkt. Nichts anderes
 * traegt Personenfarbe. Eigene Eintraege zeigen gar keinen Avatar.
 */

import { esc } from './html-escape.js';
import { initials, compactInitials } from './initials.js';

/** Die sechs Plaetze. `hue` ist der Farbton der Tinte (HSL-Grad), fuer den
 * Abstandstest der Palette (test:person-color).
 * v2 (2026-10-27): nur noch hell; Blau und Rose tragen die Scheiben aus
 * Foundations.dc.html. */
export const PERSON_PALETTE = Object.freeze([
  Object.freeze({ slot: 1, key: 'blue', hue: 219, ink: '#1F4FA8', tint: '#E3ECFB' }),
  Object.freeze({ slot: 2, key: 'rose', hue: 340, ink: '#A3264F', tint: '#FBE4EC' }),
  Object.freeze({ slot: 3, key: 'green', hue: 144, ink: '#2A6E45', tint: '#E0EFE5' }),
  Object.freeze({ slot: 4, key: 'terracotta', hue: 19, ink: '#A3461C', tint: '#F6E5DA' }),
  Object.freeze({ slot: 5, key: 'plum', hue: 294, ink: '#8F4398', tint: '#F2E4F4' }),
  Object.freeze({ slot: 6, key: 'teal', hue: 187, ink: '#146B77', tint: '#DCEDEF' }),
]);

/** Wer nicht im Haushalt steht: ruhige Tinte auf der Fuellung. */
const NEUTRAL_INK = 'var(--color-text-secondary)';
const NEUTRAL_TINT = 'var(--color-fill)';

const idOf = (user) => {
  const id = Number.parseInt(user?.id, 10);
  return Number.isFinite(id) ? id : null;
};

const positionOf = (user) => (Number.isInteger(user?.sort_order) ? user.sort_order : null);

/**
 * Die ids der Mitglieder in der Haushaltsreihenfolge: Platzierte nach
 * `sort_order`, dahinter Unplatzierte; bei Gleichstand die id. Ein Konto mit
 * `is_household_member: false` (Listen wie /auth/users) steht nicht darin.
 */
function orderOf(users) {
  const members = (Array.isArray(users) ? users : [])
    .filter((user) => user && idOf(user) != null && user.is_household_member !== false);
  members.sort((a, b) => {
    const pa = positionOf(a);
    const pb = positionOf(b);
    if (pa !== pb) {
      if (pa === null) return 1;
      if (pb === null) return -1;
      return pa - pb;
    }
    return idOf(a) - idOf(b);
  });
  return [...new Set(members.map(idOf))];
}

let householdOrder = [];

/**
 * Haelt die Haushaltsmitglieder in ihrer Reihenfolge fuer jede Scheibe, die
 * ohne eigene Liste gezeichnet wird. Eine leere Liste (Abmelden, Gast) macht
 * jede solche Scheibe neutral.
 * @param {Array<{ id: number|string, sort_order?: number|null, is_household_member?: boolean }>} users
 */
export function setHouseholdOrder(users) {
  householdOrder = orderOf(users);
}

/**
 * Der Platz (1-6) einer Person, oder null, wenn sie nicht im Haushalt steht.
 * @param {{ id?: number|string }} user
 * @param {object[]} [household] - die Mitglieder; ohne sie gilt die gehaltene Reihenfolge
 * @returns {number|null}
 */
export function personSlot(user, household = []) {
  const order = Array.isArray(household) && household.length ? orderOf(household) : householdOrder;
  const id = idOf(user);
  const at = id == null ? -1 : order.indexOf(id);
  return at < 0 ? null : (at % PERSON_PALETTE.length) + 1;
}

/**
 * Die beiden Tokens einer Person: Tinte (Initial, Kante, Punkt) und Toenung
 * (Scheibe hinter dem Initial). Neutral fuer jemanden ausserhalb des Haushalts.
 * @returns {{ slot: number|null, ink: string, tint: string }}
 */
export function personToken(user, household = []) {
  const slot = personSlot(user, household);
  if (slot == null) return { slot: null, ink: NEUTRAL_INK, tint: NEUTRAL_TINT };
  return { slot, ink: `var(--person-${slot})`, tint: `var(--person-${slot}-tint)` };
}

/** Die drei Groessen mit eigener Klasse (layout.css): Zeile, Kopf, Wand. */
const NAMED_SIZES = { sm: 20, md: 36, lg: 40 };
const SIZE_CLASS = { 20: 'sm', 36: 'md', 40: 'lg' };
/** Der Rand von `--ring` (layout.css), je Seite. */
const RING_PX = 2;

function sizePx(size) {
  if (typeof size === 'string') return NAMED_SIZES[size] ?? NAMED_SIZES.sm;
  const px = Math.round(Number(size));
  return Number.isFinite(px) && px > 0 ? px : NAMED_SIZES.sm;
}

/** Die Schrift einer Scheibe: 12 bis 26px, darueber mit der Scheibe wachsend (36 -> 15, 40 -> 17). */
const fontPx = (px) => (px <= 28 ? 12 : Math.round(px * 0.42));

/**
 * Was auf einer Scheibe ohne Bild steht. Unter 20px nichts (11px waeren die
 * Untergrenze lesbarer Schrift, und die Farbe sagt es dort allein). Sonst die
 * Initialen aus dem EINEN Helfer, mit den Doppelten des Haushalts ("LI"/"LE");
 * zwei Geviert-Zeichen (Hangul, Han) nur, wo sie in die Scheibe passen
 * (#1607), sonst das kompakte eine.
 */
function discText(name, px, ring) {
  if (px < 20) return '';
  const inner = px - (ring ? 2 * RING_PX : 0);
  return inner >= 2 * fontPx(px) ? initials(name, '?') : compactInitials(name, '?');
}

function labelOf(user, label) {
  if (label === true) return String(user?.display_name ?? '');
  return typeof label === 'string' ? label : '';
}

/**
 * Die Bestandteile der Scheibe - fuer das Markup und fuer die DOM-Fassung.
 * `size`/`font` stehen nur bei einer Groesse ohne eigene Klasse.
 */
function discModel(user, { size = 'sm', label = '', household = [], ring = false, className = '' } = {}) {
  const px = sizePx(size);
  const named = SIZE_CLASS[px];
  const { ink, tint } = personToken(user, household);
  const photo = typeof user?.avatar_data === 'string' && user.avatar_data ? user.avatar_data : '';
  const classes = ['person-disc', named ? `person-disc--${named}` : '', ring ? 'person-disc--ring' : '',
    photo ? 'person-disc--photo' : '', className].filter(Boolean).join(' ');
  return {
    classes,
    label: labelOf(user, label),
    ink,
    tint,
    size: named ? '' : `${px}px`,
    font: named ? '' : `${fontPx(px)}px`,
    photo,
    text: photo ? '' : discText(String(user?.display_name ?? ''), px, ring),
  };
}

/**
 * Die Personenscheibe - EIN Markup fuer jede Stelle (Zeilen, Kopf, Wand,
 * Chips, Stapel, Einstellungen): das hochgeladene Bild, sonst die Initialen in
 * der Tinte auf der Toenung (layout.css, `.person-disc`).
 *
 * @param {{ id?: number|string, display_name?: string, avatar_data?: string }} user
 * @param {{ size?: 'sm'|'md'|'lg'|number, label?: boolean|string, household?: object[],
 *           ring?: boolean, className?: string }} [opts]
 *   `size` 'sm' 20, 'md' 36, 'lg' 40 oder ein Mass in px; `label` true nennt die
 *   Person mit ihrem Namen, ein Text gilt so (sonst ist die Scheibe Schmuck neben
 *   dem Namen); `ring` legt einen 2px-Rand in der Kartenfarbe um die Scheibe
 *   (Stapel); `className` fuer Stellen mit eigener Groesse oder Lage.
 * @returns {string} HTML-String (fuer insertAdjacentHTML; alles escapet)
 */
export function personDisc(user, opts = {}) {
  if (!user) return '';
  const model = discModel(user, opts);
  const a11y = model.label
    ? `role="img" aria-label="${esc(model.label)}" title="${esc(model.label)}"`
    : 'aria-hidden="true"';
  const style = `--person-disc-ink: ${model.ink}; --person-disc-tint: ${model.tint}`
    + (model.size ? `; --person-disc-size: ${model.size}; --person-disc-font: ${model.font}` : '');
  const inner = model.photo ? `<img src="${esc(model.photo)}" alt="" loading="lazy">` : esc(model.text);
  return `<span class="${esc(model.classes)}" ${a11y} style="${esc(style)}">${inner}</span>`;
}

/**
 * Dieselbe Scheibe als Element, fuer Stellen, die ihr Markup mit
 * `document.createElement` bauen (Detailkopf, Ausweiskarte der Einstellungen).
 * @param {object} user
 * @param {object} [opts] wie personDisc()
 * @returns {HTMLElement|null}
 */
export function personDiscEl(user, opts = {}) {
  if (!user) return null;
  const model = discModel(user, opts);
  const el = document.createElement('span');
  el.className = model.classes;
  if (model.label) {
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', model.label);
    el.setAttribute('title', model.label);
  } else {
    el.setAttribute('aria-hidden', 'true');
  }
  el.style.setProperty('--person-disc-ink', model.ink);
  el.style.setProperty('--person-disc-tint', model.tint);
  if (model.size) {
    el.style.setProperty('--person-disc-size', model.size);
    el.style.setProperty('--person-disc-font', model.font);
  }
  if (model.photo) {
    const img = document.createElement('img');
    img.src = model.photo;
    img.alt = '';
    img.loading = 'lazy';
    el.appendChild(img);
  } else {
    el.textContent = model.text;
  }
  return el;
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
 * Markup der "Razem"-Scheibe (geteilt). Zwei Personen: beide Tinten im
 * harten Schnitt. Drei und mehr: der gemeinsame Ton (--color-accent) - drei
 * Farben in einer 20px-Scheibe liest niemand, und die Kante eines geteilten
 * Termins ist ohnehin violett. Ohne Buchstaben; der Name kommt als Label vom
 * Aufrufer (schon uebersetzt), sonst ist die Scheibe Dekor, weil der Text
 * daneben es schon sagt.
 *
 * @param {object[]} people
 * @param {{ label?: string, household?: object[], size?: 'sm'|'md'|'lg', className?: string }} [opts]
 * @returns {string} HTML-String (fuer insertAdjacentHTML; alles escapet)
 */
export function razemDisc(people, { label = '', household = [], size = 'sm', className = '' } = {}) {
  const list = (Array.isArray(people) ? people : []).filter(Boolean);
  if (!list.length) return '';
  const named = SIZE_CLASS[sizePx(size)] ?? 'sm';
  const classes = ['person-disc', `person-disc--${named}`, 'person-disc--razem', className].filter(Boolean).join(' ');
  const a11y = label ? `role="img" aria-label="${esc(label)}" title="${esc(label)}"` : 'aria-hidden="true"';
  const background = list.length > 2
    ? 'var(--color-accent)'
    : razemBackground(list[0], list[1] ?? list[0], household);
  return `<span class="${esc(classes)}" ${a11y} style="background: ${esc(background)}"></span>`;
}
