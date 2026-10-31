#!/usr/bin/env node
/**
 * Removes translation keys from every locale file at once.
 *
 *   node scripts/i18n-remove.mjs tasks.pointsLabel rewards.* settings.rewardsApproval
 *
 * Each argument is a dotted key (a section name removes the whole section), "section." for a
 * section, or "some.keyPrefix*" for every sibling starting with that prefix. A plain key also
 * removes its plural variants (_zero/_one/_two/_few/_many/_other). Emptied sections are pruned.
 *
 * Files keep the repo format: JSON.stringify(obj, null, 4) plus a trailing newline.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'locales');
const PLURAL = /_(zero|one|two|few|many|other)$/;

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Usage: node scripts/i18n-remove.mjs <key-or-prefix>...');
  process.exit(1);
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function removeFrom(root, dotted) {
  const star = dotted.endsWith('*');
  const path = dotted.replace(/[.*]+$/, '').split('.');
  const leaf = path.pop();
  let parent = root;
  for (const part of path) {
    if (!isObj(parent[part])) return 0;
    parent = parent[part];
  }
  let removed = 0;
  for (const name of Object.keys(parent)) {
    const base = name.replace(PLURAL, '');
    const hit = star ? name.startsWith(leaf) : name === leaf || base === leaf;
    if (hit) { delete parent[name]; removed++; }
  }
  return removed;
}

function prune(node) {
  for (const [k, v] of Object.entries(node)) {
    if (!isObj(v)) continue;
    prune(v);
    if (!Object.keys(v).length) delete node[k];
  }
}

let total = 0;
for (const name of readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json')).sort()) {
  const path = join(LOCALES_DIR, name);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  let n = 0;
  for (const key of args) n += removeFrom(data, key);
  prune(data);
  total += n;
  writeFileSync(path, `${JSON.stringify(data, null, 4)}\n`);
}
console.log(`Removed ${total} entries across all locales.`);
