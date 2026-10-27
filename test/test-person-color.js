/**
 * Personenfarbe (Tafla, 2026-10-19): utils/person-color.js und tokens.css 4c.
 *
 * Drei Zusagen:
 * 1. DIE ZUORDNUNG ist stabil und kollisionsfrei: die iOS-Vorgabefarben der
 *    Avatare landen auf ihrem naechsten Platz, graue Avatare starten bei
 *    (id - 1) mod 6, und zwei Mitglieder eines Haushalts teilen nie einen
 *    Platz - unabhaengig von der Reihenfolge der Liste.
 * 2. DIE PALETTE IM JS IST DIE IN tokens.css.
 * 3. JEDES PAAR HAELT AA: Tinte auf Karte, Papier, Fill, Herd und der eigenen
 *    Toenung; Weiss auf der Tinte.
 * 2026-10-27, v2: light only - die dunklen Paare (darkInk/darkTint und die
 * beiden Dark-Bloecke) sind gegangen; Blau und Rose tragen die Scheiben aus
 * Foundations.dc.html, und Platz 1/2 haben einen eigenen 8pt-Punkt.
 *
 * Ausfuehren: node --test test/test-person-color.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PERSON_PALETTE, avatarHue, personSlot, personToken, razemBackground, razemDisc, personDisc,
} from '../public/utils/person-color.js';
import { contrastRatio } from '../public/utils/contrast.js';

const TOKENS = readFileSync(new URL('../public/styles/tokens.css', import.meta.url), 'utf8');

test('die iOS-Vorgabefarben der Avatare landen auf ihrem naechsten Platz', () => {
  // server/auth.js: avatarColors = ['#007AFF', '#34C759', '#FF9500', '#FF3B30', '#AF52DE', '#FF2D55']
  const cases = [
    ['#007AFF', 1, 'blue'],
    ['#FF2D55', 2, 'rose'],
    ['#34C759', 3, 'green'],
    ['#FF9500', 4, 'terracotta'],
    ['#FF3B30', 4, 'terracotta'],
    ['#AF52DE', 5, 'plum'],
  ];
  for (const [color, slot, key] of cases) {
    assert.equal(personSlot({ id: 1, avatar_color: color }), slot, `${color} -> ${key}`);
  }
  // Jede Palettenfarbe ist ihr eigener Platz (2026-10-27, v2: light only -
  // die dunkle Tinte als Wahl entfaellt mit ihr).
  for (const entry of PERSON_PALETTE) {
    assert.equal(personSlot({ id: 9, avatar_color: entry.ink }), entry.slot, entry.key);
    assert.equal(personSlot({ id: 9, avatar_color: entry.ink.toLowerCase() }), entry.slot, `${entry.key} (klein geschrieben)`);
    assert.equal('darkInk' in entry || 'darkTint' in entry, false, `${entry.key}: kein dunkles Paar mehr`);
  }
  // Die v2-Punkte der Haushaltsfarben (Foundations "Wojtek" / "Mariola")
  // landen auf Blau und Rose.
  assert.equal(personSlot({ id: 1, avatar_color: '#2F6FDB' }), 1, 'Wojtek-Blau -> Platz 1');
  assert.equal(personSlot({ id: 1, avatar_color: '#D9467A' }), 2, 'Mariola-Rose -> Platz 2');
});

test('ein Avatar ohne Farbton startet bei (id - 1) mod 6', () => {
  for (const color of ['#888888', '#FFFFFF', '#000000', '', null, 'var(--color-accent)', '#12345']) {
    assert.equal(avatarHue(color), null, `${color} hat keinen Farbton`);
  }
  assert.equal(personSlot({ id: 1, avatar_color: '#808080' }), 1);
  assert.equal(personSlot({ id: 2 }), 2);
  assert.equal(personSlot({ id: 6 }), 6);
  assert.equal(personSlot({ id: 7 }), 1);
  assert.equal(personSlot({}), 1, 'ohne id und Farbe: der erste Platz');
});

test('zwei Mitglieder eines Haushalts teilen nie eine Farbe, egal in welcher Reihenfolge', () => {
  const wojtek = { id: 1, avatar_color: '#007AFF' };
  const mariola = { id: 2, avatar_color: '#0A84FF' }; // auch blau gewaehlt
  const kuchnia = { id: 3, avatar_color: '#8E8E93' }; // grau, Anzeigekonto
  const household = [kuchnia, mariola, wojtek];
  const slots = household.map((u) => personSlot(u, household));
  assert.equal(new Set(slots).size, 3, `Plaetze ${slots.join(', ')}`);
  assert.equal(personSlot(wojtek, household), 1, 'die kleinere id behaelt ihren Wunschplatz');
  assert.equal(personSlot(mariola, household), 6, 'die zweite Blaue nimmt den naechsten freien Ton (Petrol)');
  assert.deepEqual(household.map((u) => personSlot(u, [...household].reverse())), slots, 'die Reihenfolge der Liste zaehlt nicht');
  // Sechs Mitglieder mit derselben Farbe belegen alle sechs Plaetze.
  const six = [1, 2, 3, 4, 5, 6].map((id) => ({ id, avatar_color: '#FF2D55' }));
  assert.deepEqual(six.map((u) => personSlot(u, six)).sort(), [1, 2, 3, 4, 5, 6]);
  // Wer nicht in der Liste steht, waehlt hinter den Mitgliedern.
  assert.notEqual(personSlot({ id: 99, avatar_color: '#007AFF' }, [wojtek]), 1);
});

test('personToken liefert die beiden Tokens, die Scheiben bauen sicheres Markup', () => {
  assert.deepEqual(personToken({ id: 1, avatar_color: '#AD3568' }), {
    slot: 2, ink: 'var(--person-2)', tint: 'var(--person-2-tint)',
  });
  const a = { id: 1, avatar_color: '#2A64A8' };
  const b = { id: 2, avatar_color: '#AD3568' };
  assert.equal(razemBackground(a, b), 'linear-gradient(135deg, var(--person-1) 0 50%, var(--person-2) 50% 100%)');

  const disc = razemDisc(a, b, { label: 'Razem <b>"&' });
  assert.match(disc, /^<span class="person-disc person-disc--sm person-disc--razem" role="img" aria-label="Razem &lt;b&gt;&quot;&amp;"/);
  assert.match(disc, /style="background: linear-gradient\(135deg, var\(--person-1\) 0 50%, var\(--person-2\) 50% 100%\)"><\/span>$/);
  assert.match(razemDisc(a, b), /aria-hidden="true"/, 'ohne Label ist die Scheibe Dekor');
  assert.match(razemDisc(a, b, { size: 'xl' }), /person-disc--sm/, 'unbekannte Groesse faellt auf sm');

  const own = personDisc(b, { text: '<O>', label: 'Ola', size: 'md' });
  assert.match(own, /class="person-disc person-disc--md"/);
  assert.match(own, /style="--person-disc-ink: var\(--person-2\); --person-disc-tint: var\(--person-2-tint\)">&lt;O&gt;<\/span>$/);
  // Die Scheibe hat ihre Regel im geteilten Stylesheet.
  const layout = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
  for (const sel of ['.person-disc {', '.person-disc--md {', '.person-disc--lg {']) assert.ok(layout.includes(`\n${sel}`), sel);
});

// 2026-10-27, v2: light only - nur noch der helle Block; die Dark-Bloecke
// gibt es nicht mehr (und duerfen nicht zurueckkommen).
test('die Palette im JS ist die in tokens.css', () => {
  const code = TOKENS.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(code.includes('[data-theme="dark"]'), false, 'kein Dark-Block in tokens.css');
  assert.doesNotMatch(code, /prefers-color-scheme:\s*dark/, 'kein System-Dark-Block in tokens.css');
  const valueIn = (from, name) => {
    const re = new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6});`, 'g');
    re.lastIndex = from;
    return re.exec(TOKENS)?.[1]?.toUpperCase();
  };
  for (const { slot, ink, tint } of PERSON_PALETTE) {
    assert.equal(valueIn(0, `--_person-${slot}`), ink, `--_person-${slot}`);
    assert.equal(valueIn(0, `--_person-${slot}-tint`), tint, `--_person-${slot}-tint`);
    assert.match(TOKENS, new RegExp(`--person-${slot}:\\s*var\\(--_person-${slot}\\);`));
    assert.match(TOKENS, new RegExp(`--person-${slot}-tint:\\s*var\\(--_person-${slot}-tint\\);`));
    assert.match(TOKENS, new RegExp(`--person-${slot}-dot:`), `--person-${slot}-dot fehlt`);
  }
  // v2: die Punkte von Platz 1 und 2 sind die Foundations-Farben.
  assert.equal(valueIn(0, '--person-1-dot'), '#2F6FDB');
  assert.equal(valueIn(0, '--person-2-dot'), '#D9467A');
});

// 2026-10-27, v2: light only - die v2-Flaechen (Karte, Grund #F6F6F3, Fill
// #ECEBE7, Herd); die dunklen Paare sind gegangen.
test('jedes Paar haelt AA', () => {
  const light = { Karte: '#FFFFFF', Papier: '#F6F6F3', Fill: '#ECEBE7', Herd: '#FBEFE3' };
  for (const { key, ink, tint } of PERSON_PALETTE) {
    for (const [where, ground] of Object.entries(light)) {
      assert.ok(contrastRatio(ink, ground) >= 4.5, `${key} auf ${where}: ${contrastRatio(ink, ground).toFixed(2)}`);
    }
    assert.ok(contrastRatio(ink, tint) >= 4.5, `${key}: Initial auf der Toenung ${contrastRatio(ink, tint).toFixed(2)}`);
    assert.ok(contrastRatio('#FFFFFF', ink) >= 4.5, `${key}: Weiss auf der Tinte ${contrastRatio('#FFFFFF', ink).toFixed(2)}`);
  }
  // Sechs Plaetze, sechs verschiedene Toene, je mindestens 25 Grad auseinander.
  const hues = PERSON_PALETTE.map((p) => p.hue).sort((a, b) => a - b);
  for (let i = 0; i < hues.length; i += 1) {
    const next = i === hues.length - 1 ? hues[0] + 360 : hues[i + 1];
    assert.ok(next - hues[i] >= 25, `Toene ${hues[i]} und ${next % 360} liegen zu dicht`);
  }
});
