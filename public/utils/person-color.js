/**
 * Modul: Person colours (Tafla token contract, 2026-10-19)
 * Zweck: Which of the six curated person colour pairs (`--person-N` ink on
 *        `--person-N-tint`, tokens.css) stands for a household member. The
 *        mapping is stable: it follows the member's avatar colour, so the disc
 *        in a row, the event edge and the dot in the week strip agree.
 * Abhängigkeiten: keine
 *
 * The six avatar colours the server hands out (server/auth.js) map one to one
 * onto the six pairs, blue first and rose second - the household default of
 * the Tafla mocks. Any other colour (a picked one) goes to the pair whose hue
 * is nearest; without a usable colour the id decides.
 */

const PAIR_COUNT = 6;

// The server's avatar palette, in the order of the curated pairs.
const AVATAR_TO_PAIR = Object.freeze({
  '#007aff': 1, // blue
  '#ff2d55': 2, // rose
  '#34c759': 3,
  '#ff9500': 4,
  '#af52de': 5,
  '#ff3b30': 6,
});

// Representative hues of the six pairs, for colours outside that palette.
const PAIR_HUES = [212, 335, 140, 32, 280, 5];

function hueOf(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex ?? '').trim());
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => parseInt(v, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.08) return null; // grey: no hue to go by
  const d = max - min;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/** The pair number (1-6) for a user. */
export function personIndex(user) {
  const color = String(user?.avatar_color ?? user?.color ?? '').toLowerCase();
  if (AVATAR_TO_PAIR[color]) return AVATAR_TO_PAIR[color];
  const hue = hueOf(color);
  if (hue != null) {
    let best = 0;
    let bestDist = Infinity;
    PAIR_HUES.forEach((h, i) => {
      const dist = Math.min(Math.abs(h - hue), 360 - Math.abs(h - hue));
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    return best + 1;
  }
  const id = Number(user?.id);
  return Number.isFinite(id) ? (((Math.abs(id) - 1) % PAIR_COUNT) + PAIR_COUNT) % PAIR_COUNT + 1 : 1;
}

/**
 * The person colour of a user as CSS values.
 * @returns {{ ink: string, tint: string, index: number }}
 */
export function personToken(user) {
  const n = personIndex(user);
  return { ink: `var(--person-${n})`, tint: `var(--person-${n}-tint)`, index: n };
}
