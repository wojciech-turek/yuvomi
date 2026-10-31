#!/usr/bin/env node
/**
 * Removes translation keys from every locale file at once.
 *
 *   node scripts/i18n-remove.mjs tasks.pointsLabel rewards.* settings.rewardsApproval
 *
 * Each argument is one of:
 *   a.b      the key a.b (or the section a.b) and its plural variants (_zero/_one/_two/_few/_many/_other)
 *   a.b.     the section a.b with everything under it, exact name only
 *   a.b.*    the same as "a.b."
 *   a.pre*   every sibling of a that starts with "pre" (a bare star, no dot before it)
 * Sections that became empty because of this run are pruned; other empty objects stay.
 * A locale file is only rewritten when something was removed from it.
 *
 * Files keep the repo format: JSON.stringify(obj, null, 4) plus a trailing newline.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'locales');
const PLURAL = /_(zero|one|two|few|many|other)$/;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Removes one argument from `root`; returns how many entries went. Empties it caused are pruned. */
function removeOne(root, arg) {
  const section = /\.\*?$/.test(arg);
  const prefix = !section && arg.endsWith('*');
  const path = arg.replace(/\.\*?$|\*$/, '').split('.');
  const leaf = path.pop();
  const trail = [root];
  for (const part of path) {
    const next = trail.at(-1)[part];
    if (!isObj(next)) return 0;
    trail.push(next);
  }
  const parent = trail.at(-1);
  let removed = 0;
  for (const name of Object.keys(parent)) {
    const hit = section ? name === leaf
      : prefix ? name.startsWith(leaf)
        : name === leaf || name.replace(PLURAL, '') === leaf;
    if (hit) { delete parent[name]; removed++; }
  }
  if (removed) {
    for (let i = trail.length - 1; i > 0; i--) {
      if (Object.keys(trail[i]).length) break;
      delete trail[i - 1][path[i - 1]];
    }
  }
  return removed;
}

/** Removes every argument from the locale object `data`; returns the number of entries removed. */
export function removeKeys(data, args) {
  return args.reduce((n, arg) => n + removeOne(data, arg), 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('Usage: node scripts/i18n-remove.mjs <key-or-prefix>...');
    process.exit(1);
  }
  let total = 0;
  for (const name of readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json')).sort()) {
    const path = join(LOCALES_DIR, name);
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const n = removeKeys(data, args);
    if (!n) continue;
    total += n;
    writeFileSync(path, `${JSON.stringify(data, null, 4)}\n`);
  }
  console.log(`Removed ${total} entries across all locales.`);
}
