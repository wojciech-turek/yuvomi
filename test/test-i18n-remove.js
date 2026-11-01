/**
 * Test: scripts/i18n-remove.mjs - die Schluessel-Regeln des Werkzeugs
 * Zweck: `a.*` nimmt die Sektion `a` mit, aber keine Nachbarn, die nur mit
 *        demselben Namen anfangen; Pluralformen gehen mit dem Schluessel;
 *        nur Sektionen, die durch den Lauf leer wurden, werden entfernt.
 * Ausfuehren: npm run test:i18n-remove
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { removeKeys } from '../scripts/i18n-remove.mjs';

const sample = () => ({
  a: { b: 'x', c: { d: 'y' } },
  aBadge: 'keep',
  s: { scope: { one: '1' }, scopeHint: 'keep', n: 'n', n_one: 'n1', n_few: 'nf', n_many: 'nm', n_other: 'no', n_zero: 'nz', n_two: 'nt', nOther: 'keep' },
  empty: {},
});

test('a.* entfernt die Sektion samt Teilbaum, aber nicht aBadge', () => {
  const d = sample();
  assert.equal(removeKeys(d, ['a.*']), 1);
  assert.equal('a' in d, false);
  assert.equal(d.aBadge, 'keep');
  const e = sample();
  removeKeys(e, ['s.scope.*']);
  assert.equal('scope' in e.s, false);
  assert.equal(e.s.scopeHint, 'keep');
  const f = sample();
  removeKeys(f, ['a.']);
  assert.equal(f.aBadge, 'keep');
});

test('a.b entfernt den Schluessel; eine dadurch leere Sektion geht mit', () => {
  const d = sample();
  removeKeys(d, ['a.c.d']);
  assert.deepEqual(d.a, { b: 'x' });
  removeKeys(d, ['a.b']);
  assert.equal('a' in d, false);
});

test('Pluralformen gehen mit dem Schluessel, Namensvettern nicht', () => {
  const d = sample();
  assert.equal(removeKeys(d, ['s.n']), 7);
  assert.deepEqual(Object.keys(d.s).sort(), ['nOther', 'scope', 'scopeHint']);
});

test('ein Stern ohne Punkt ist ein Praefix unter Geschwistern', () => {
  const d = sample();
  removeKeys(d, ['s.scope*']);
  assert.deepEqual(Object.keys(d.s).sort(), ['n', 'nOther', 'n_few', 'n_many', 'n_one', 'n_other', 'n_two', 'n_zero'].sort());
});

test('ohne Treffer bleibt alles, auch vorher leere Objekte', () => {
  const d = sample();
  assert.equal(removeKeys(d, ['nope', 'a.zzz', 'x.y.z']), 0);
  assert.deepEqual(d, sample());
});
