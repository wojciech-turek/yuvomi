/**
 * Modul: Notizzeile (One Today)
 * Zweck: firstLine/noteLines machen aus Markdown die schlichte Zeile fuer die
 *        Notiz-Karte auf Heute: Ueberschrift-#, Listenmarker, Checkboxen, Fett,
 *        Kursiv, Code, Links und Bilder fallen weg; Leerzeilen zaehlen nicht;
 *        hoechstens 160 Zeichen.
 * Ausfuehren: npm run test:note-line
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { firstLine, noteLines, NOTE_LINE_MAX } = await import('../public/utils/note-line.js');

test('the first non-empty line, heading and list markers gone', () => {
  assert.equal(firstLine('# Święta\n- [ ] Kraków'), 'Święta');
  assert.equal(firstLine('\n\n  ## Plan  \nx'), 'Plan');
  assert.equal(firstLine('- [x] Kupić choinkę'), 'Kupić choinkę');
  assert.equal(firstLine('* Mleko'), 'Mleko');
  assert.equal(firstLine('1. Pierwszy krok'), 'Pierwszy krok');
  assert.equal(firstLine('> cytat'), 'cytat');
});

test('emphasis, code, links and images become their text', () => {
  assert.equal(firstLine('**Ważne** i __też__ oraz _to_ i *tamto*'), 'Ważne i też oraz to i tamto');
  assert.equal(firstLine('Wifi: `kuchnia2026`'), 'Wifi: kuchnia2026');
  assert.equal(firstLine('Zobacz [mapę](https://example.com/x) tutaj'), 'Zobacz mapę tutaj');
  assert.equal(firstLine('![zdjęcie](a.png) podpis'), 'zdjęcie podpis');
  assert.equal(firstLine('snake_case_word stays'), 'snake_case_word stays');
});

test('empty, fences and rules are skipped; spaces collapse; the cut is 160', () => {
  assert.equal(firstLine(''), '');
  assert.equal(firstLine(null), '');
  assert.equal(firstLine('---\n```\n```\n\nPo   kresce'), 'Po kresce');
  assert.equal(firstLine('a'.repeat(300)).length, NOTE_LINE_MAX);
  assert.deepEqual(noteLines('# A\n\nB\r\n- C', 3), ['A', 'B', 'C']);
  assert.deepEqual(noteLines('# A\n\nB\r\n- C'), ['A', 'B'], 'two lines by default');
});

test('fenced code is skipped with its language tag; trailing heading hashes go', () => {
  assert.equal(firstLine('```js\nconst a = 1;\n```\nPo kodzie'), 'Po kodzie');
  assert.equal(firstLine('~~~\nx\n~~~\nY'), 'Y');
  assert.equal(firstLine('Przed\n```\nwewnątrz\n```'), 'Przed');
  assert.deepEqual(noteLines('```\na\n```\nB\nC\nD', 2), ['B', 'C']);
  assert.equal(firstLine('## Plan ##'), 'Plan');
  assert.equal(firstLine('# C#'), 'C#', 'a hash glued to a word stays');
});

test('a long line is cut on a code point with an ellipsis, never inside a surrogate pair', () => {
  const line = firstLine('😀'.repeat(200));
  assert.equal(Array.from(line).length, NOTE_LINE_MAX);
  assert.ok(line.endsWith('…'));
  assert.doesNotMatch(line, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  assert.equal(firstLine('a'.repeat(160)), 'a'.repeat(160), 'exactly 160 is not cut');
});
