/**
 * Tests: Keine Skelette mehr (Schnell-Erfassen, Aufgabe 2, 2026-10-29)
 * Pinnt: kein Skelett-Markup und keine Skelett-Regel ausser dem Kompatibilitaets-
 * Helfer utils/skeleton.js; EIN `.page-loading` in layout.css, das erst nach
 * mindestens 300 ms erscheint (ein schneller Aufbau zeigt gar nichts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { eachRule } from './css-rules.js';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const TEXT_EXT = /\.(js|css|html|mjs)$/;
const files = walk(PUBLIC).filter((f) => TEXT_EXT.test(f));
const rel = (f) => relative(PUBLIC, f).replaceAll('\\', '/');

test('kein Skelett-Markup ausser im Helfer utils/skeleton.js', () => {
  const banned = ['skeleton-line', 'dz-skeleton', 'more-skeleton', 'widget-skeleton', 'tasks-pane-skeleton'];
  const hits = [];
  for (const f of files) {
    if (rel(f) === 'utils/skeleton.js') continue;
    const src = readFileSync(f, 'utf8');
    for (const word of banned) if (src.includes(word)) hits.push(`${rel(f)}: ${word}`);
  }
  assert.deepEqual(hits, []);
});

test('kein Stylesheet definiert .skeleton, .skeleton-card, .skeleton-line, .dz-skeleton', () => {
  const hits = [];
  for (const f of files.filter((x) => x.endsWith('.css'))) {
    for (const rule of eachRule(readFileSync(f, 'utf8'))) {
      if (/\.(skeleton|skeleton-card|skeleton-line|skeleton-chart|skeleton-list|dz-skeleton)(?![\w-])/.test(rule.selector)) {
        hits.push(`${rel(f)}: ${rule.selector.trim()}`);
      }
    }
  }
  assert.deepEqual(hits, []);
});

test('.page-loading steht einmal in layout.css und erscheint erst nach >= 300 ms', () => {
  const defs = [];
  for (const f of files.filter((x) => x.endsWith('.css'))) {
    for (const rule of eachRule(readFileSync(f, 'utf8'))) {
      if (/(^|[\s,])\.page-loading(?![\w-])/.test(rule.selector)) defs.push({ file: rel(f), ...rule });
    }
  }
  const base = defs.filter((d) => d.selector.trim() === '.page-loading' && d.at.length === 0);
  assert.equal(base.length, 1, '.page-loading hat genau eine Basisregel');
  assert.equal(base[0].file, 'styles/layout.css');
  assert.match(base[0].body, /min-block-size:\s*40vh/);
  assert.match(base[0].body, /place-items:\s*center/);
  assert.match(base[0].body, /opacity:\s*0\b/, 'steht erst unsichtbar');
  const delay = base[0].body.match(/animation-delay:\s*([^;]+);/)?.[1].trim();
  assert.ok(delay, 'der Ring blendet verzoegert ein (animation-delay)');
  // Die Verzoegerung darf ein Dauer-Token sein (test-motion verbietet Literale): aus tokens.css aufloesen.
  const token = delay.match(/^var\((--duration-[\w-]+)\)$/)?.[1];
  const resolved = token
    ? readFileSync(join(PUBLIC, 'styles/tokens.css'), 'utf8').match(new RegExp(`${token}:\\s*(\\d+)ms`))?.[1] + 'ms'
    : delay;
  const m = resolved.match(/^(\d+(?:\.\d+)?)(ms|s)$/);
  assert.ok(m, `Verzug "${delay}" ist nicht lesbar`);
  const ms = Number(m[1]) * (m[2] === 's' ? 1000 : 1);
  assert.ok(ms >= 300, `Erscheinungsverzug ${ms} ms muss >= 300 ms sein`);
  assert.match(base[0].body, /animation-fill-mode:\s*forwards/);
});

test('.page-loading__spinner ist derselbe Ring wie der Startring und nutzt app-spin', () => {
  const css = readFileSync(join(PUBLIC, 'styles/layout.css'), 'utf8');
  const rules = [...eachRule(css)].filter((r) => /\.page-loading__spinner(?![\w-])/.test(r.selector) && r.at.length === 0);
  assert.ok(rules.length >= 1);
  const body = rules.map((r) => r.body).join('\n');
  assert.match(body, /animation:\s*app-spin 800ms linear infinite/);
  assert.equal((css.match(/@keyframes app-spin/g) || []).length, 1, 'app-spin wird nicht zweimal definiert');
});

test('die leere Einkaufs-Tableiste und die Gesundheits-Ladung halten ihr Mass', () => {
  const shopping = readFileSync(join(PUBLIC, 'pages/shopping.js'), 'utf8');
  assert.match(shopping, /<div class="list-tabs-bar" id="list-tabs-bar"><\/div>/, 'leer, ohne Leerraum - sonst greift :empty nicht');
  const sCss = readFileSync(join(PUBLIC, 'styles/shopping.css'), 'utf8');
  const bar = [...eachRule(sCss)].find((r) => r.selector.trim() === '.list-tabs-bar:empty');
  assert.ok(bar && /min-block-size:\s*36px/.test(bar.body), 'die leere Leiste haelt die Hoehe der Pillen');
  const hCss = readFileSync(join(PUBLIC, 'styles/health.css'), 'utf8');
  const small = [...eachRule(hCss)].find((r) => /\.health-loading \.page-loading/.test(r.selector));
  assert.ok(small && /min-block-size:\s*8rem/.test(small.body), 'der Ring im Bereich ist klein, nicht 40vh');
  const health = readFileSync(join(PUBLIC, 'pages/health.js'), 'utf8');
  assert.match(health, /__loading health-loading" role="status"/);
  assert.match(health, /health-cycle__loading health-loading"/);
});
