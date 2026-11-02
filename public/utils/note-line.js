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
    .replace(/^\s*>\s?/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*\[[ xX]\]\s*/, '')
    .replace(/`+/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/(^|[\s(])[*_]+|[*_]+(?=$|[\s).,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The plain, non-empty lines of a note, each cut to `NOTE_LINE_MAX`. */
export function noteLines(markdown) {
  return String(markdown ?? '').split(/\r?\n/)
    .filter((line) => !/^\s*(?:`{3,}|-{3,}|\*{3,}|_{3,})\s*$/.test(line))
    .map(plain)
    .filter(Boolean)
    .map((line) => line.slice(0, NOTE_LINE_MAX));
}

/** The first non-empty line as plain text ('' for an empty note). */
export function firstLine(markdown) {
  return noteLines(markdown)[0] ?? '';
}
