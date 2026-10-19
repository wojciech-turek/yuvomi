/**
 * Modul: Name keys (Polish-aware comparison)
 * Zweck: One way to compare household names typed in Polish. "Żółty ser",
 *        "zolty ser" and "  ŻÓŁTY  ser " are the same item: lower case, no
 *        diacritics (ł has no decomposition, so it is mapped by hand), single
 *        spaces. Inflection ("jabłko"/"jabłka") is deliberately not folded here.
 */

const MANUAL = { ł: 'l', Ł: 'l', đ: 'd', ø: 'o', ß: 'ss' };

/** Comparison key for a name: lower case, ASCII letters, single spaces. */
export function nameKey(value) {
  return String(value ?? '')
    .replace(/[łŁđøß]/g, (ch) => MANUAL[ch])
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when `key` starts with `prefixKey` or any word of it does. */
export function matchesPrefix(key, prefixKey) {
  if (!prefixKey) return false;
  if (key.startsWith(prefixKey)) return true;
  return key.split(' ').some((word) => word.startsWith(prefixKey));
}
