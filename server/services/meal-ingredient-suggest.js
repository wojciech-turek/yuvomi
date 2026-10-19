/**
 * Modul: Meals - ingredient suggestions (fork, 2026-10-19)
 * Zweck: When someone types a meal, offer its ingredients so they can go on the
 *        shopping list in one tap. Sources in order of trust: the linked recipe,
 *        the last time this household cooked a meal with that name, a recipe of
 *        that name, and only then Haiku (with the household memory, for two
 *        people unless the memory says otherwise). Every suggestion says whether
 *        the pantry already has it, so the dialog can leave those unticked.
 * Abhängigkeiten: server/ai, shopping-category-guess.js, utils/name-key.js
 */

import * as db from '../db.js';
import { nameKey } from '../utils/name-key.js';
import { localCategory } from './shopping-category-guess.js';
import { claude, featureOn } from '../ai/index.js';
import { aiSettings } from '../ai/settings.js';
import { memoryContext } from '../ai/memory.js';

const FALLBACK = 'Sonstiges';
const MAX_ITEMS = 20;

/** Pantry names with stock, as keys, for "you already have it". */
function pantryKeys() {
  return db.get().prepare('SELECT name FROM pantry_items WHERE quantity IS NULL OR quantity > 0').all().map((r) => nameKey(r.name)).filter(Boolean);
}

/** "pomidory w puszce" matches a pantry "pomidory"; "sól" matches "sól morska". */
function inPantry(name, keys) {
  const key = nameKey(name);
  if (!key) return false;
  return keys.some((k) => k === key || key.startsWith(`${k} `) || k.startsWith(`${key} `));
}

function finish(rows, source, keys) {
  const seen = new Set();
  const ingredients = [];
  for (const row of rows) {
    const name = String(row.name ?? '').trim();
    const key = nameKey(name);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    const category = row.category && row.category !== FALLBACK ? row.category : (localCategory(name)?.category ?? FALLBACK);
    ingredients.push({ name, quantity: row.quantity ? String(row.quantity).trim() : null, category, in_pantry: inPantry(name, keys) });
    if (ingredients.length >= MAX_ITEMS) break;
  }
  return { source: ingredients.length ? source : null, ingredients };
}

function fromRecipe(recipeId) {
  return db.get().prepare('SELECT name, quantity, category FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id').all(recipeId);
}

/** Ingredients of the newest earlier meal with the same title that had any. */
function fromHistory(titleKey) {
  const meals = db.get().prepare(`
    SELECT m.id, m.title FROM meals m
    WHERE EXISTS (SELECT 1 FROM meal_ingredients mi WHERE mi.meal_id = m.id)
    ORDER BY m.date DESC, m.id DESC LIMIT 500
  `).all();
  const match = meals.find((m) => nameKey(m.title) === titleKey);
  if (!match) return [];
  return db.get().prepare('SELECT name, quantity, category FROM meal_ingredients WHERE meal_id = ? ORDER BY id').all(match.id);
}

function recipeByTitle(titleKey) {
  const recipe = db.get().prepare('SELECT id, title FROM recipes').all().find((r) => nameKey(r.title) === titleKey);
  return recipe ? fromRecipe(recipe.id) : [];
}

const SCHEMA = {
  type: 'object',
  properties: {
    known_dish: { type: 'boolean' },
    ingredients: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, quantity: { type: 'string' } },
        required: ['name', 'quantity'],
        additionalProperties: false,
      },
    },
  },
  required: ['known_dish', 'ingredients'],
  additionalProperties: false,
};

/**
 * @param {{title: string, recipeId?: number|null, userId?: number|null, allowAi?: boolean}} opts
 * @returns {Promise<{source: 'recipe'|'history'|'ai'|null, ingredients: object[]}>}
 */
export async function suggestIngredients({ title, recipeId = null, userId = null, allowAi = true }) {
  const keys = pantryKeys();
  if (recipeId) {
    const rows = fromRecipe(recipeId);
    if (rows.length) return finish(rows, 'recipe', keys);
  }
  const titleKey = nameKey(title);
  if (!titleKey) return { source: null, ingredients: [] };
  const history = fromHistory(titleKey);
  if (history.length) return finish(history, 'history', keys);
  const byTitle = recipeByTitle(titleKey);
  if (byTitle.length) return finish(byTitle, 'recipe', keys);

  if (!allowAi || !featureOn('meal_ingredients') || !aiSettings().anthropicKey) return { source: null, ingredients: [] };
  const memory = memoryContext(['meals']);
  const out = await claude.json({
    feature: 'meal_ingredients',
    userId,
    system: [
      'You help a Polish household put a planned meal on the shopping list.',
      'List the ingredients of one ordinary home-cooked version of the dish, in Polish, as people write them on a shopping list (e.g. "makaron spaghetti", "mięso mielone wołowe").',
      'Quantities in metric units or pieces, for 2 people unless the household notes say otherwise. Leave out water. Include salt, pepper and oil only when the dish depends on them.',
      'If the text is not a dish (a placeholder like "resztki" or "na mieście"), set known_dish to false and return no ingredients.',
      'Respect the household notes (diet, dislikes). Never invent medical or diet claims.',
    ].join(' '),
    text: `Danie: ${String(title).slice(0, 200)}${memory ? `\nNotatki domu:\n${memory}` : ''}`,
    schema: SCHEMA,
    maxTokens: 900,
  });
  if (!out?.known_dish || !Array.isArray(out.ingredients)) return { source: null, ingredients: [] };
  return finish(out.ingredients, 'ai', keys);
}
