/**
 * Modul: Notizzeile
 * Zweck: Aus dem Markdown einer Notiz die erste (oder zweite) Zeile als
 *        schlichten Text - fuer Zeilen auf Heute, wo kein Markdown gezeichnet
 *        wird. Rein, ohne DOM.
 * Abhaengigkeiten: keine
 */

/** The longest line a row ever shows. */
export const NOTE_LINE_MAX = 160;

function plain(line) {
  return String(line)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/\s+#+\s*$/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*\[[ xX]\]\s*/, '')
    .replace(/`+/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/(^|[\s(])[*_]+|[*_]+(?=$|[\s).,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cut to `NOTE_LINE_MAX` code points (never inside a surrogate pair), "…" when cut. */
function cut(line) {
  const points = Array.from(line);
  return points.length > NOTE_LINE_MAX ? `${points.slice(0, NOTE_LINE_MAX - 1).join('')}…` : line;
}

/**
 * The first `limit` plain, non-empty lines of a note, each cut to
 * `NOTE_LINE_MAX`. Fenced code blocks (and their fences) and rules are
 * skipped; reading stops once `limit` lines are found.
 */
export function noteLines(markdown, limit = 2) {
  const text = String(markdown ?? '');
  const out = [];
  let inFence = false;
  let start = 0;
  while (start <= text.length && out.length < limit) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const raw = text.slice(start, end).replace(/\r$/, '');
    start = end + 1;
    if (/^\s*(?:`{3,}|~{3,})/.test(raw)) { inFence = !inFence; continue; }
    if (inFence || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) continue;
    const line = plain(raw);
    if (line) out.push(cut(line));
  }
  return out;
}

/** The first non-empty line as plain text ('' for an empty note). */
export function firstLine(markdown) {
  return noteLines(markdown)[0] ?? '';
}
