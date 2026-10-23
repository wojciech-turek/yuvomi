/**
 * Modul: Cook mode - steps and timers
 * Zweck: Turns a recipe's free-text notes into numbered steps and finds the
 *        timers a step mentions ("gotuj 15 minut", "piecz 1 godz.", "simmer
 *        for 2-3 minutes"). Pure: no DOM, no clock.
 *
 * Recipes have no structured steps: instructions live in `notes`. A step is a
 * numbered line ("1." / "1)" / "Krok 1"), a bullet, or a paragraph. A single
 * paragraph without breaks is split into sentences so the iPad shows bites, not
 * a wall of text.
 */

const NUMBERED = /^\s*(?:krok\s+|step\s+)?(\d{1,2})\s*[.):-]\s*/i;
const BULLET = /^\s*[-•*\u2013]\s+/;

/** @returns {string[]} steps in order, trimmed, without their markers */
export function splitSteps(notes) {
  const text = String(notes ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const lines = text.split('\n').map((l) => l.trim());

  const marked = lines.filter((l) => NUMBERED.test(l) || BULLET.test(l)).length;
  if (marked >= 2) {
    const steps = [];
    for (const line of lines) {
      if (!line) continue;
      if (NUMBERED.test(line) || BULLET.test(line)) steps.push(line.replace(NUMBERED, '').replace(BULLET, '').trim());
      else if (steps.length) steps[steps.length - 1] += ` ${line}`;
      else steps.push(line); // an intro line before the first marker
    }
    return steps.filter(Boolean);
  }

  const paragraphs = text.split(/\n\s*\n/).map((p) => p.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (paragraphs.length >= 2) return paragraphs;
  // One block: sentences, grouped so a step is not a three-word fragment.
  // Sentences end at . ! or ? (no lookbehind: Safari 14.1 is the floor).
  const sentences = (paragraphs[0].match(/[^.!?]+(?:[.!?]+|$)/g) ?? [paragraphs[0]]).map((x) => x.trim()).filter(Boolean);
  const steps = [];
  for (const s of sentences) {
    if (steps.length && steps.at(-1).length < 60) steps[steps.length - 1] += ` ${s}`;
    else steps.push(s);
  }
  return steps;
}

const UNIT_SECONDS = [
  [/^(?:godz(?:in[ayę]?|\.)?|h|hours?|hrs?)$/i, 3600],
  [/^(?:min(?:ut[ay]?|\.)?|minutes?|mins?)$/i, 60],
  [/^(?:sek(?:und[ay]?|\.)?|s|seconds?|secs?)$/i, 1],
];

const DURATION = /(\d+(?:[.,]\d+)?)(?:\s*[-\u2013]\s*(\d+(?:[.,]\d+)?))?\s*(godz(?:in[ayę]?|\.)?|h\b|hours?|hrs?|min(?:ut[ay]?|\.)?|minutes?|mins?|sek(?:und[ay]?|\.)?|seconds?|secs?)/giu;

/**
 * Timers mentioned in a step. A range ("2-3 minuty") uses its upper end.
 * @returns {{label: string, seconds: number}[]}
 */
export function findTimers(step) {
  const timers = [];
  for (const m of String(step ?? '').matchAll(DURATION)) {
    const unit = m[3].replace(/\.$/, '.');
    const factor = UNIT_SECONDS.find(([re]) => re.test(unit) || re.test(unit.replace(/\.$/, '')))?.[1];
    if (!factor) continue;
    const value = parseFloat((m[2] ?? m[1]).replace(',', '.'));
    const seconds = Math.round(value * factor);
    if (seconds < 10 || seconds > 12 * 3600) continue;
    timers.push({ label: m[0].trim(), seconds });
  }
  return timers;
}

/** "1:05:00", "12:00", "0:45" */
export function formatTimer(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/**
 * A step as text and timer pieces, in order: "Duś 20 min na małym ogniu" ->
 * [{text: 'Duś '}, {timer: {label: '20 min', seconds: 1200}}, {text: ' na małym ogniu'}].
 * Cook mode draws each timer as a pill inside the sentence (Tafla, Gotowanie).
 * @returns {({text: string}|{timer: {label: string, seconds: number}})[]}
 */
export function stepSegments(step) {
  const text = String(step ?? '');
  const parts = [];
  let at = 0;
  for (const m of text.matchAll(DURATION)) {
    const [timer] = findTimers(m[0]);
    if (!timer) continue;
    if (m.index > at) parts.push({ text: text.slice(at, m.index) });
    parts.push({ timer });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/** Lower case without diacritics: "Sól" -> "sol", "passatę" -> "passate". */
function plain(word) {
  return String(word ?? '').toLocaleLowerCase('pl').replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * The ingredients a step mentions, by a stem of each name's first word - the
 * step says "Wlej passatę, dopraw solą", the list says "passata", "sól". The
 * stem drops the last two letters (Polish endings), never below three.
 * @param {string} step
 * @param {{name: string}[]} ingredients
 * @returns {number[]} indexes into `ingredients`, in list order
 */
export function stepIngredientIndexes(step, ingredients) {
  const words = plain(step).split(/[^a-z0-9]+/).filter(Boolean);
  const out = [];
  (Array.isArray(ingredients) ? ingredients : []).forEach((ingredient, index) => {
    const first = plain(ingredient?.name).split(/[^a-z0-9]+/).find(Boolean);
    if (!first) return;
    const stem = first.slice(0, Math.max(3, first.length - 2));
    if (words.some((word) => word.startsWith(stem))) out.push(index);
  });
  return out;
}
