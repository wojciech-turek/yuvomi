/**
 * Modul: Meals - ideas for an empty day (fork, 2026-10-19)
 * Zweck: Three ideas for one meal slot, on request: drawn from what the
 *        household likes (memory), what it has cooked lately (to avoid repeats),
 *        its own recipes, and what the pantry already has. Each idea comes with
 *        a one-line reason and its ingredients, so planning it is one tap and
 *        the shopping list one more. Sonnet 5.5 by default (or Haiku, by choice).
 */

import * as db from '../db.js';
import { nameKey } from '../utils/name-key.js';
import { claude } from '../ai/index.js';
import { memoryContext } from '../ai/memory.js';
import { recentMeals, pantryNames } from '../ai/household-insights.js';
import { localCategory } from './shopping-category-guess.js';

const MEAL_LABELS_PL = { breakfast: 'śniadanie', lunch: 'obiad', dinner: 'kolacja', snack: 'przekąska' };

const SCHEMA = {
  type: 'object',
  properties: {
    ideas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          why: { type: 'string' },
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
        required: ['title', 'why', 'ingredients'],
        additionalProperties: false,
      },
    },
  },
  required: ['ideas'],
  additionalProperties: false,
};

/**
 * @param {{date: string, mealType: string, userId?: number|null}} opts
 * @returns {Promise<{title: string, why: string, recipe_id: number|null, ingredients: object[]}[]>}
 */
export async function mealIdeas({ date, mealType, userId = null }) {
  const recent = recentMeals(21).map((m) => m.title);
  const recipes = db.get().prepare('SELECT id, title FROM recipes ORDER BY updated_at DESC LIMIT 80').all();
  const pantry = pantryNames(60);
  const memory = memoryContext(['meals']);
  const out = await claude.json({
    feature: 'meal_ideas',
    tier: 'smart',
    userId,
    system: [
      'You suggest home-cooked meals for a Polish household of two (unless their notes say otherwise).',
      'Give exactly three different ideas in Polish for the requested meal. Respect the household notes strictly (dislikes, diet).',
      'Prefer the household\'s own recipes and products already in the pantry; avoid repeating what they ate in the last three weeks.',
      'For each idea: a short dish name, one short reason why it fits today (mention a pantry product or a recipe when relevant), and its ingredients for the shopping list in Polish with metric quantities.',
      'Never make health or nutrition claims.',
    ].join(' '),
    text: [
      `Posiłek: ${MEAL_LABELS_PL[mealType] ?? mealType}, dzień ${date}.`,
      memory ? `Notatki domu:\n${memory}` : '',
      recent.length ? `Jedli ostatnio: ${recent.slice(0, 30).join(', ')}` : '',
      recipes.length ? `Ich przepisy: ${recipes.map((r) => r.title).join(', ')}` : '',
      pantry.length ? `W spiżarni: ${pantry.join(', ')}` : '',
    ].filter(Boolean).join('\n'),
    schema: SCHEMA,
    maxTokens: 2500,
  });
  const byTitle = new Map(recipes.map((r) => [nameKey(r.title), r.id]));
  return (out?.ideas ?? []).slice(0, 3).map((idea) => ({
    title: String(idea.title ?? '').trim().slice(0, 200),
    why: String(idea.why ?? '').trim().slice(0, 300),
    recipe_id: byTitle.get(nameKey(idea.title)) ?? null,
    ingredients: (idea.ingredients ?? []).slice(0, 20).map((ing) => ({
      name: String(ing.name ?? '').trim().slice(0, 200),
      quantity: String(ing.quantity ?? '').trim().slice(0, 50) || null,
      category: localCategory(ing.name)?.category ?? 'Sonstiges',
    })).filter((ing) => ing.name),
  })).filter((idea) => idea.title);
}
