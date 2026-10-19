#!/usr/bin/env node
/**
 * Adds or updates translation keys in every locale file at once.
 *
 *   node scripts/i18n-add.mjs keys.json
 *
 * keys.json maps dotted keys to their texts: { "ai.title": { "en": "AI", "pl": "AI" } }.
 * Polish and English get their own text; every other locale gets the English text.
 * German gets English too, so test:i18n-translated (which only counts values that
 * equal English where German differs) does not flag these copies.
 *
 * Files keep the repo format: JSON.stringify(obj, null, 4) plus a trailing newline,
 * new keys appended at the end of their section.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'locales');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/i18n-add.mjs keys.json');
  process.exit(1);
}
const entries = Object.entries(JSON.parse(readFileSync(file, 'utf8')));
for (const [key, texts] of entries) {
  if (!texts || typeof texts.en !== 'string' || typeof texts.pl !== 'string') {
    console.error(`${key}: needs both "en" and "pl" strings`);
    process.exit(1);
  }
}

function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let node = obj;
  for (const part of parts.slice(0, -1)) {
    if (node[part] === undefined) node[part] = {};
    if (typeof node[part] !== 'object') throw new Error(`${dotted}: "${part}" is a string, not a section`);
    node = node[part];
  }
  node[parts.at(-1)] = value;
}

for (const name of readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json')).sort()) {
  const locale = name.replace(/\.json$/, '');
  const path = join(LOCALES_DIR, name);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  for (const [key, texts] of entries) setPath(data, key, locale === 'pl' ? texts.pl : texts.en);
  writeFileSync(path, `${JSON.stringify(data, null, 4)}\n`);
}
console.log(`Wrote ${entries.length} keys to every locale.`);
