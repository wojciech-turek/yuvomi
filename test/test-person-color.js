/**
 * Personenfarbe: utils/person-color.js und tokens.css 4c.
 *
 * Seit One Today (2026-11-02) gibt es EINE Zuordnung und EINE Scheibe:
 * 1. DER PLATZ ist die Stelle in der Haushaltsreihenfolge (`sort_order`, bei
 *    Gleichstand die id), mod 6. Die gespeicherte Avatarfarbe zaehlt nicht
 *    mehr. Wer nicht in der Reihenfolge steht (Gast, Ehemalige, Hauspersonal),
 *    traegt die neutrale Scheibe. Die Reihenfolge haelt `setHouseholdOrder()`
 *    (api.js beim Start, nach jeder Aenderung an Mitgliedern) - eine Seite ohne
 *    eigene Haushaltsliste bekommt dieselbe Antwort wie eine mit.
 * 2. DIE SCHEIBE (`personDisc`) ist ein Markup fuer jede Stelle: das Bild,
 *    sonst die Initialen aus dem einen Helfer in der Tinte auf der Toenung.
 * 3. DIE PALETTE IM JS IST DIE IN tokens.css, und jedes Paar haelt AA.
 *
 * Ausfuehren: npm run test:person-color
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PERSON_PALETTE, personSlot, personToken, razemBackground, razemDisc, personDisc, personDiscEl, setHouseholdOrder,
} from '../public/utils/person-color.js';
import { setInitialsRoster, clearInitialsRoster } from '../public/utils/initials.js';
import { contrastRatio } from '../public/utils/contrast.js';

const TOKENS = readFileSync(new URL('../public/styles/tokens.css', import.meta.url), 'utf8');
const LAYOUT = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');

const NEUTRAL = { slot: null, ink: 'var(--color-text-secondary)', tint: 'var(--color-fill)' };

// Die Mitglieder, wie die API sie schickt: in der Haushaltsreihenfolge, mit
// `sort_order` (memberPositionSql). Mariola steht vorn, obwohl ihre id groesser ist.
const MARIOLA = { id: 7, display_name: 'Mariola', sort_order: 0, avatar_color: '#007AFF' };
const WOJTEK = { id: 3, display_name: 'Wojtek', sort_order: 1, avatar_color: '#FF2D55' };
const HOUSEHOLD = [MARIOLA, WOJTEK];

test('der Platz ist die Stelle in der Haushaltsreihenfolge, mit und ohne mitgegebene Liste', (t) => {
  t.after(() => setHouseholdOrder([]));
  setHouseholdOrder(HOUSEHOLD);
  assert.equal(personSlot(MARIOLA), 1, 'die Erste der Reihenfolge');
  assert.equal(personSlot(WOJTEK), 2, 'der Zweite');
  for (const person of HOUSEHOLD) {
    assert.deepEqual(personToken(person), personToken(person, HOUSEHOLD), `${person.display_name}: dieselbe Antwort ohne Liste`);
    assert.deepEqual(personToken({ id: person.id }), personToken(person), 'die id allein genuegt');
    assert.deepEqual(personToken({ id: String(person.id) }), personToken(person), 'auch als Text');
  }
  assert.deepEqual(personToken(MARIOLA), { slot: 1, ink: 'var(--person-1)', tint: 'var(--person-1-tint)' });
  // Die Reihenfolge der uebergebenen Liste zaehlt nicht, nur sort_order.
  assert.equal(personSlot(WOJTEK, [WOJTEK, MARIOLA]), 2);
});

test('sort_order entscheidet, nicht die id; Gleichstand und Unplatzierte nach id', (t) => {
  t.after(() => setHouseholdOrder([]));
  setHouseholdOrder([
    { id: 1, sort_order: 2 }, { id: 2, sort_order: 0 }, { id: 3, sort_order: 1 },
    { id: 9, sort_order: null }, { id: 5, sort_order: null }, { id: 4 },
  ]);
  assert.deepEqual([2, 3, 1, 4, 5, 9].map((id) => personSlot({ id })), [1, 2, 3, 4, 5, 6]);
  // Ab dem siebten Mitglied beginnt die Palette von vorn.
  setHouseholdOrder([1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, sort_order: id })));
  assert.equal(personSlot({ id: 7 }), 1);
  // Eine Liste ohne sort_order (nie umsortiert) ordnet nach id - ein neuer
  // Name aendert keine Farbe.
  setHouseholdOrder([{ id: 4, display_name: 'Zoe' }, { id: 2, display_name: 'Anna' }]);
  assert.deepEqual([personSlot({ id: 2 }), personSlot({ id: 4 })], [1, 2]);
});

test('die gespeicherte Avatarfarbe hat keine Wirkung', (t) => {
  t.after(() => setHouseholdOrder([]));
  setHouseholdOrder(HOUSEHOLD);
  for (const avatar_color of ['#007AFF', '#FF2D55', '#34C759', '#888888', '', null, 'var(--x)']) {
    assert.deepEqual(personToken({ id: 7, avatar_color }), personToken({ id: 7 }), `${avatar_color}`);
    assert.deepEqual(personToken({ id: 3, avatar_color, color: avatar_color }), personToken({ id: 3 }), `${avatar_color} als color`);
  }
  const source = readFileSync(new URL('../public/utils/person-color.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(source, /avatar_color|\.color\b/, 'person-color.js liest keine gespeicherte Farbe');
});

test('wer nicht in der Reihenfolge steht, traegt die neutrale Scheibe', (t) => {
  t.after(() => setHouseholdOrder([]));
  setHouseholdOrder(HOUSEHOLD);
  assert.deepEqual(personToken({ id: 99, display_name: 'Gast' }), NEUTRAL, 'Gast geteilter Ausgaben');
  assert.deepEqual(personToken({}), NEUTRAL, 'ohne id');
  assert.deepEqual(personToken(null), NEUTRAL);
  assert.equal(personSlot({ id: 99 }), null);
  // Hauspersonal und Ehemalige stehen in Listen wie /auth/users, aber nicht in der Reihenfolge.
  const directory = [...HOUSEHOLD, { id: 12, sort_order: null, is_household_member: false }];
  setHouseholdOrder(directory);
  assert.deepEqual(personToken({ id: 12 }), NEUTRAL, 'Hauspersonal');
  assert.deepEqual(personToken({ id: 12 }, directory), NEUTRAL, 'auch mit der Liste');
  assert.equal(personSlot(WOJTEK), 2, 'und schiebt niemanden weiter');
  // Ohne jede Reihenfolge (vor dem Start, Gast-Sitzung) ist jede Scheibe neutral.
  setHouseholdOrder([]);
  assert.deepEqual(personToken(MARIOLA), NEUTRAL);
  assert.equal(personSlot(MARIOLA, HOUSEHOLD), 1, 'eine mitgegebene Liste traegt dann allein');
});

test('personDisc: das Bild, sonst die Initialen in der Tinte auf der Toenung', (t) => {
  t.after(() => { setHouseholdOrder([]); clearInitialsRoster(); });
  setHouseholdOrder(HOUSEHOLD);

  const plain = personDisc(WOJTEK);
  assert.equal(plain, '<span class="person-disc person-disc--sm" aria-hidden="true" style="--person-disc-ink: var(--person-2); --person-disc-tint: var(--person-2-tint)">W</span>');

  const photo = personDisc({ ...WOJTEK, avatar_data: 'data:image/png;base64,QQ==' }, { label: true });
  assert.match(photo, /^<span class="person-disc person-disc--sm person-disc--photo" role="img" aria-label="Wojtek" title="Wojtek" style="[^"]*">/);
  assert.match(photo, /<img src="data:image\/png;base64,QQ==" alt="" loading="lazy"><\/span>$/, 'das Bild, ohne den Namen zu wiederholen');
  assert.doesNotMatch(photo, />W</, 'kein Initial neben dem Bild');

  // Label: true nimmt den Namen, ein Text gilt so, wie er kommt (escapet).
  assert.match(personDisc(WOJTEK, { label: 'Woj <b>"&' }), /role="img" aria-label="Woj &lt;b&gt;&quot;&amp;"/);
  assert.match(personDisc({ id: 3, display_name: '<i>' }, { label: true }), /aria-label="&lt;i&gt;"/);

  // Groessen: sm 20, md 36, lg 40 als Klassen; jede andere als Mass.
  assert.match(personDisc(WOJTEK, { size: 'md' }), /class="person-disc person-disc--md"/);
  assert.match(personDisc(WOJTEK, { size: 36 }), /class="person-disc person-disc--md"/);
  assert.match(personDisc(WOJTEK, { size: 40 }), /class="person-disc person-disc--lg"/);
  assert.match(personDisc(WOJTEK, { size: 'xl' }), /class="person-disc person-disc--sm"/, 'unbekannte Groesse faellt auf sm');
  const custom = personDisc(WOJTEK, { size: 26, className: 'user-ms__avatar' });
  assert.match(custom, /class="person-disc user-ms__avatar"/);
  assert.match(custom, /--person-disc-size: 26px; --person-disc-font: 12px/);
  assert.match(personDisc(WOJTEK, { size: 16 }), /><\/span>$/, 'unter 20 traegt die Scheibe keinen Text');
  assert.match(personDisc(WOJTEK, { size: 22, ring: true }), /class="person-disc person-disc--ring"/);

  // Die Zeichen kommen aus dem einen Helfer, mit den Doppelten des Haushalts.
  setInitialsRoster(['Linda Johnson', 'Leo Johnson']);
  assert.match(personDisc({ id: 7, display_name: 'Linda Johnson' }), />LI<\/span>$/);
  assert.match(personDisc({ id: 7, display_name: '' }), />\?<\/span>$/, 'ohne Namen ein ?');

  // Nicht im Haushalt: neutral.
  assert.match(personDisc({ id: 99, display_name: 'Gast' }), /--person-disc-ink: var\(--color-text-secondary\); --person-disc-tint: var\(--color-fill\)/);
  assert.equal(personDisc(null), '', 'ohne Person keine Scheibe');
});

test('personDiscEl: dieselbe Scheibe als Element fuer DOM-Bauer', (t) => {
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.attrs = {}; this.styles = {}; this.children = []; this.textContent = ''; this.className = ''; }
    get style() { return { setProperty: (k, v) => { this.styles[k] = v; } }; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    appendChild(c) { this.children.push(c); return c; }
  }
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = { createElement: (tag) => new El(tag) };
  t.after(() => {
    setHouseholdOrder([]);
    if (saved) Object.defineProperty(globalThis, 'document', saved); else delete globalThis.document;
  });
  setHouseholdOrder(HOUSEHOLD);

  const plain = personDiscEl(WOJTEK, { size: 56, className: 'settings-identity__avatar' });
  assert.equal(plain.className, 'person-disc settings-identity__avatar');
  assert.equal(plain.attrs['aria-hidden'], 'true');
  assert.deepEqual(plain.styles, {
    '--person-disc-ink': 'var(--person-2)', '--person-disc-tint': 'var(--person-2-tint)',
    '--person-disc-size': '56px', '--person-disc-font': '24px',
  });
  assert.equal(plain.textContent, 'W');

  const photo = personDiscEl({ ...MARIOLA, avatar_data: 'data:image/png;base64,QQ==' }, { label: true });
  assert.equal(photo.className, 'person-disc person-disc--sm person-disc--photo');
  assert.deepEqual(photo.attrs, { role: 'img', 'aria-label': 'Mariola', title: 'Mariola' });
  assert.equal(photo.children[0].tagName, 'IMG');
  assert.equal(photo.children[0].alt, '', 'das Bild wiederholt den Namen nicht');
  assert.equal(photo.textContent, '');
  assert.equal(personDiscEl(null), null);
});

test('die geteilte Scheibe: zwei Tinten, ab drei Personen das Violett', (t) => {
  t.after(() => setHouseholdOrder([]));
  setHouseholdOrder(HOUSEHOLD);
  assert.equal(razemBackground(MARIOLA, WOJTEK), 'linear-gradient(135deg, var(--person-1) 0 50%, var(--person-2) 50% 100%)');

  const two = razemDisc([MARIOLA, WOJTEK], { label: 'Razem <b>"&' });
  assert.match(two, /^<span class="person-disc person-disc--sm person-disc--razem" role="img" aria-label="Razem &lt;b&gt;&quot;&amp;"/);
  assert.match(two, /style="background: linear-gradient\(135deg, var\(--person-1\) 0 50%, var\(--person-2\) 50% 100%\)"><\/span>$/);
  assert.match(razemDisc([MARIOLA, WOJTEK]), /aria-hidden="true"/, 'ohne Label ist die Scheibe Dekor');
  assert.match(razemDisc([MARIOLA, WOJTEK], { size: 'lg', className: 'wall-disc' }), /class="person-disc person-disc--lg person-disc--razem wall-disc"/);

  const three = razemDisc([MARIOLA, WOJTEK, { id: 99 }]);
  assert.match(three, /style="background: var\(--color-accent\)"><\/span>$/, 'drei und mehr: der gemeinsame Ton');
  assert.equal(razemDisc([]), '');
});

test('die Scheibe hat ihre Regeln im geteilten Stylesheet', () => {
  for (const sel of ['.person-disc {', '.person-disc--md {', '.person-disc--lg {', '.person-disc--ring {', '.person-disc--photo img {']) {
    assert.ok(LAYOUT.includes(`\n${sel}`), sel);
  }
  const base = LAYOUT.slice(LAYOUT.indexOf('\n.person-disc {'), LAYOUT.indexOf('}', LAYOUT.indexOf('\n.person-disc {')));
  assert.match(base, /background: var\(--person-disc-tint, var\(--color-fill\)\)/);
  assert.match(base, /color: var\(--person-disc-ink, var\(--color-text-secondary\)\)/);
  assert.match(base, /font-size: var\(--person-disc-font, var\(--type-meta\)\)/);
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
