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
  const sentences = paragraphs[0].split(/(?<=[.!?])\s+(?=[A-ZĄĆĘŁŃÓŚŹŻ0-9])/u);
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
