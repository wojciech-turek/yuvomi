/**
 * Modul: Eingabezeile des Einkaufs
 * Zweck: Was die Zakupy-Leiste UND das kleine Blatt ueber der Uebersicht
 *        (components/shopping-add-sheet.js) teilen: die Zeile lesen
 *        (parseQuickEntry), den Gang raten (guessAisle) und die zuletzt
 *        geoeffnete Liste merken (je Geraet und Person).
 */
import { api } from '/api.js';
import { t } from '/i18n.js';
import { parseCapture } from '/utils/capture-parse.js';
import { esc } from '/utils/html.js';
import { DEFAULT_CATEGORY_NAME } from '/utils/shopping-categories.js';

const LAST_LIST_KEY = 'yuvomi.shopping.lastList.';

/** Merkt die Liste, die auf Zakupy zuletzt offen war (localStorage kann fehlen oder werfen). */
export function rememberShoppingList(userId, listId) {
  if (userId == null || listId == null) return; // ohne Person kein Schluessel (sonst "...lastList.null")
  try { localStorage.setItem(`${LAST_LIST_KEY}${userId}`, String(listId)); } catch { /* ohne Speicher: kein Merken */ }
}

/** Die gemerkte Liste, sonst die erste; ohne Listen null. */
export function pickShoppingList(lists, userId) {
  if (!Array.isArray(lists) || !lists.length) return null;
  if (userId == null) return lists[0];
  let stored = null;
  try { stored = localStorage.getItem(`${LAST_LIST_KEY}${userId}`); } catch { /* weiter mit der ersten */ }
  return lists.find((list) => String(list.id) === stored) ?? lists[0];
}

/** GET /shopping/category-guess: der Gang fuer einen Namen, oder null. */
export async function guessAisle(name, { get = (path) => api.get(path) } = {}) {
  try {
    const res = await get(`/shopping/category-guess?name=${encodeURIComponent(name)}`);
    return res?.data?.category ?? null;
  } catch {
    return null;
  }
}

/**
 * Die Chips von "Często" (ein Knopf je Artikel). Zakupy und das Blatt der
 * Uebersicht zeichnen sie hiermit; nur die CSS-Klasse unterscheidet sich.
 */
export function frequentChipsHtml(items, chipClass) {
  return items.map((i) => `
    <button type="button" class="${chipClass}" data-action="add-frequent" data-name="${esc(i.name)}"
            aria-label="${esc(t('shopping.predictionAddLabel', { name: i.name }))}">${esc(i.name)}</button>`).join('');
}

/**
 * Der Koerper von POST /shopping/:listId/items fuer die Eingabezeile. `known`:
 * die Kategorie ist der Liste der Gaenge bekannt; sonst gilt der Standard.
 */
export function quickItemBody({ name, quantity = null, category = null, source = 'default', known = !!category }) {
  return {
    name,
    quantity,
    category: known && category ? category : DEFAULT_CATEGORY_NAME,
    category_source: known && category ? source : 'default',
    position: 'top',
  };
}

/**
 * ONE FIELD, THE AMOUNT INCLUDED (2026-10-27, v2). The bar had a name field
 * and a quantity field; on an iPhone two fields meant iOS's previous/next bar
 * over the keyboard and a second target in a 52pt capsule. Now the amount is
 * read from the same line: "2 mleko", "mleko 2", "250 g sera", "jajka 10".
 *
 * The capture parser (utils/capture-parse.js) knows units, "2x" and the
 * genitive after an amount ("sera" -> "ser"). Two things are the bar's own:
 *   - a bare number AFTER the name is an amount here ("jajka 10"); in a free
 *     capture line it may be a time, so the parser leaves it in the name;
 *   - the name keeps the case it was typed in (the parser capitalises it),
 *     and a line the parser splits into several items ("sól i pieprz") stays
 *     one item, as typed - the bar adds one thing per send.
 * A number without a unit counts pieces: "10 szt.".
 *
 * @param {string} text
 * @returns {{ name: string, quantity: string|null }}
 */
export function parseQuickEntry(text) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return { name: '', quantity: null };
  const trail = /^(.*\S)\s+(\d+(?:[.,]\d+)?)$/u.exec(raw);
  const source = trail ? `${trail[2]} ${trail[1]}` : raw;
  const parsed = parseCapture(source, { type: 'shopping' });
  const item = parsed.items?.length === 1 ? parsed.items[0] : null;
  const amount = parsed.tokens?.find((tk) => tk.kind === 'amount')?.text ?? '';
  if (!item?.name || item.quantity == null || !amount) return { name: raw, quantity: null };

  const typedName = trail ? trail[1] : source.replace(amount, '').trim();
  const first = typedName.charAt(0);
  const cased = first && first !== first.toUpperCase() ? item.name.charAt(0).toLowerCase() + item.name.slice(1) : item.name;
  const name = nominativeAdjectives(typedName, cased);
  const number = /\d+(?:[.,]\d+)?/.exec(amount)?.[0] ?? String(item.quantity);
  const quantity = item.unit ? amount : `${number} ${t('pantry.units.pcs', { count: item.quantity })}`;
  return { name, quantity };
}

/** Lower case without diacritics (ł too) - for comparing a typed word with a parsed one. */
function foldWord(word) {
  return String(word ?? '').toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/\p{M}+/gu, '');
}

/**
 * THE ADJECTIVE FOLLOWS ITS NOUN (2026-10-27, v2). After an amount Polish puts
 * the whole phrase in the genitive: "200 g sera żółtego". The capture parser
 * turns the noun back ("sera" -> "ser") from its small table; this does the
 * same for the adjectives right after it, so the list says "ser żółty".
 *
 * LOW RISK BY CONSTRUCTION: it acts only when the parser DID change the noun -
 * the one sure sign that the phrase was in the genitive - and only on the words
 * directly after it that carry a genitive adjective ending; the first word
 * that does not ("w plastrach") ends it. A noun the table does not know
 * ("kiełbasy śląskiej") keeps the whole phrase as typed, rather than a noun in
 * one case and its adjective in another.
 *
 *   -ego -> -y / -i (masculine: "żółtego", "greckiego"), -e / -ie when the
 *           noun is neuter, i.e. ends in -o or -e ("mleka świeżego")
 *   -ej  -> -a ("pszennej"; "słodkiej" -> "słodka")
 *   -ych -> -e, -ich -> -ie (plural: "naturalnych", "wiejskich")
 */
function nominativeAdjectives(typedName, parsedName) {
  const typed = typedName.trim().split(/\s+/);
  const words = parsedName.trim().split(/\s+/);
  if (words.length < 2 || foldWord(typed[0]) === foldWord(words[0])) return parsedName;
  const neuter = /[oe]$/i.test(words[0]);
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    let next = null;
    if (/iego$/i.test(w)) next = w.replace(/iego$/i, neuter ? 'ie' : 'i');
    else if (/ego$/i.test(w)) next = w.replace(/ego$/i, neuter ? 'e' : 'y');
    else if (/[kg]iej$/i.test(w)) next = w.replace(/iej$/i, 'a');
    else if (/ej$/i.test(w)) next = w.replace(/ej$/i, 'a');
    else if (/ich$/i.test(w)) next = w.replace(/ich$/i, 'ie');
    else if (/ych$/i.test(w)) next = w.replace(/ych$/i, 'e');
    if (!next) break;
    words[i] = next;
  }
  return words.join(' ');
}
