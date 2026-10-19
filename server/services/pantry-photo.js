/**
 * Modul: Pantry - add from a photo (fork, 2026-10-19)
 * Zweck: A photo of a cupboard, shelf or fridge becomes a draft list of pantry
 *        items (name, amount, unit) that a person checks before anything is
 *        stored. Sonnet 5.5 reads the photo (or Haiku, if the household chose
 *        it for bigger jobs). The photo is sent once, inline, and not kept -
 *        neither here nor at Anthropic beyond their standard retention.
 * Abhängigkeiten: server/ai, shopping-category-guess.js, utils/name-key.js
 */

import * as db from '../db.js';
import { nameKey } from '../utils/name-key.js';
import { localCategory } from './shopping-category-guess.js';
import { claude } from '../ai/index.js';
import { PANTRY_UNITS } from '../../public/utils/pantry-units.js';
import { dataUrlContentMatches } from '../utils/file-signature.js';

export const MAX_PHOTO_BYTES = 4_500_000;
const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Parses a data URL from the browser into the API's image block parts.
 * @returns {{mediaType: string, data: string}|null}
 */
export function parsePhotoDataUrl(value) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(value ?? ''));
  if (!m || !MEDIA_TYPES.has(m[1])) return null;
  const bytes = Math.floor((m[2].length * 3) / 4);
  if (bytes < 1000 || bytes > MAX_PHOTO_BYTES) return null;
  // The bytes must really be the image type the data URL claims.
  if (!dataUrlContentMatches(String(value))) return null;
  return { mediaType: m[1], data: m[2] };
}

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          quantity: { type: 'number' },
          unit: { type: 'string', enum: [...PANTRY_UNITS] },
          sure: { type: 'boolean' },
        },
        required: ['name', 'quantity', 'unit', 'sure'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

/**
 * Reads a photo and returns draft pantry items. Each draft says which existing
 * pantry item has the same name (`existing_id`), so the review can merge.
 * @param {{image: {mediaType: string, data: string}, userId?: number|null}} opts
 */
export async function scanPantryPhoto({ image, userId = null }) {
  const out = await claude.json({
    feature: 'pantry_photo',
    tier: 'smart',
    effort: 'medium',
    userId,
    images: [image],
    system: [
      'You take stock of a Polish household\'s food and household supplies from one photo (a cupboard, shelf, fridge or freezer).',
      'List each distinct product you can actually identify, in Polish, the way it would be written on a shopping list ("mleko UHT 2%", "makaron penne", "pomidory w puszce").',
      'Count packages you can see; use the unit that fits: pcs (pieces), pkg (packages), can, bottle, jar, bag, or g/kg/ml/l only when the label shows it.',
      'Do not guess hidden items, do not list the shelf or the appliance itself. Set sure=false when you are not certain what a product is.',
    ].join(' '),
    text: 'Co jest na tym zdjęciu? Wypisz produkty do spiżarni.',
    schema: SCHEMA,
    // Sonnet keeps adaptive thinking; its tokens count toward this limit.
    maxTokens: 8000,
  });

  const existing = db.get().prepare('SELECT id, name, unit, location_id FROM pantry_items').all();
  const byKey = new Map(existing.map((e) => [nameKey(e.name), e]));
  const seen = new Set();
  const items = [];
  for (const raw of out?.items ?? []) {
    const name = String(raw.name ?? '').trim().slice(0, 200);
    const key = nameKey(name);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    const quantity = Number.isFinite(raw.quantity) && raw.quantity > 0 ? Math.min(raw.quantity, 999) : 1;
    const match = byKey.get(key) ?? null;
    items.push({
      name,
      quantity,
      unit: PANTRY_UNITS.includes(raw.unit) ? raw.unit : 'pcs',
      category: localCategory(name)?.category ?? null,
      sure: raw.sure !== false,
      existing_id: match?.id ?? null,
    });
  }
  return items;
}
