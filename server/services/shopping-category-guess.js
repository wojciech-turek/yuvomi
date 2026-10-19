/**
 * Modul: Shopping - which aisle a name belongs to
 * Zweck: Fills the category for an item nobody sorted by hand, in this order of
 *        trust: the household's own choice for that name (a hand pick always
 *        wins), what the household used last time, Polish/English/German
 *        keywords, and only then a model (Jev if a key is set, otherwise Haiku).
 *        Model answers are remembered per name, so each new item costs at most
 *        one call, ever.
 * Abhängigkeiten: server/utils/name-key.js, server/ai, recipe-providers/categorize.js
 */

import * as db from '../db.js';
import { nameKey } from '../utils/name-key.js';
import { categorizeIngredient } from './recipe-providers/categorize.js';
import { claude, jev, featureOn } from '../ai/index.js';
import { aiSettings } from '../ai/settings.js';

const FALLBACK = 'Sonstiges';

// Polish stems on the diacritic-free key ("mieso" for mięso). Phrases come
// first: "pasta do zebow" is toothpaste, not pasta.
const PL_PHRASES = [
  ['pasta do zeb', 'Drogerie'], ['szczoteczk', 'Drogerie'], ['papier toalet', 'Haushalt'],
  ['recznik papier', 'Haushalt'], ['reczniki papier', 'Haushalt'], ['worki na smieci', 'Haushalt'],
  ['plyn do naczyn', 'Haushalt'], ['plyn do mycia', 'Haushalt'], ['plyn do prania', 'Haushalt'],
  ['proszek do prania', 'Haushalt'], ['kapsulki do prania', 'Haushalt'], ['tabletki do zmywark', 'Haushalt'],
  ['zel pod prysznic', 'Drogerie'], ['proszek do pieczenia', 'Backwaren'], ['mleko roslinne', 'Getränke'],
  ['fasolka szparag', 'Obst & Gemüse'], ['lody', 'Tiefkühl'], ['sol do zmywark', 'Haushalt'],
  ['nici dentyst', 'Drogerie'],
];
const PL_STEMS = {
  'Obst & Gemüse': ['jabl', 'banan', 'pomidor', 'cebul', 'czosn', 'ziemniak', 'kartof', 'marchew', 'marchw', 'cytryn',
    'limonk', 'papryk', 'salat', 'szpinak', 'ogor', 'warzyw', 'owoc', 'bazyli', 'pietrusz', 'pieczark', 'grzyb',
    'brokul', 'kalafior', 'kapust', 'truskaw', 'malin', 'borowk', 'gruszk', 'sliwk', 'winogron', 'awokad', 'cukini',
    'baklazan', 'dyni', 'rzodkiew', 'seler', 'koperk', 'szczypior', 'kolendr', 'imbir', 'mandaryn', 'pomarancz',
    'arbuz', 'melon', 'rukol', 'burak', 'buraczk', 'natk', 'szparag', 'kiwi', 'ananas', 'mang'],
  'Backwaren': ['chleb', 'bulk', 'bagiet', 'rogal', 'drozdz', 'tortill', 'makaron', 'spaghetti', 'penne',
    'pieczyw', 'grahamk', 'kajzer', 'chalk', 'platki', 'bulka'],
  'Milchprodukte': ['mlek', 'mleczk', 'serek', 'serki', 'twarog', 'masl', 'smietan', 'jogurt', 'kefir', 'maslank',
    'jaj', 'mozzarell', 'parmezan', 'feta', 'skyr', 'mascarpone', 'ricott', 'gouda', 'edam'],
  'Fleisch & Fisch': ['mies', 'kurczak', 'kurczec', 'filet', 'piers', 'udk', 'udzik', 'wolow', 'wieprz', 'schab',
    'karkowk', 'boczek', 'boczk', 'szynk', 'kielbas', 'parowk', 'salam', 'mielon', 'indyk', 'losos', 'dorsz',
    'tunczyk', 'krewetk', 'ryb', 'sledz', 'sledzi', 'makrel', 'pstrag', 'kabanos', 'golonk', 'watrobk', 'pasztet'],
  'Tiefkühl': ['mrozon', 'frytk'],
  'Getränke': ['wod', 'piw', 'napoj', 'kaw', 'herbat', 'cola', 'lemoniad', 'sok', 'soki', 'soku', 'wino', 'wina'],
  'Haushalt': ['foli', 'worki', 'serwetk', 'gabk', 'zmywak', 'domestos', 'ludwik', 'odplamiacz', 'rekawiczk'],
  'Drogerie': ['mydl', 'szampon', 'dezodorant', 'pieluch', 'chusteczk', 'podpask', 'tampon', 'golark', 'maszynk',
    'krem', 'balsam', 'odzywk', 'patyczk'],
};
// Words too short for a prefix match ("ser" would match "serwetki").
const PL_WORDS = { 'Milchprodukte': ['ser', 'sera', 'sery'], 'Getränke': ['sok'], 'Obst & Gemüse': ['por', 'pory'], 'Backwaren': ['maka', 'maki', 'make'] };

/** Polish-first keyword guess on the name. Returns a category name or null. */
export function keywordCategory(name) {
  const key = nameKey(name);
  if (!key) return null;
  for (const [phrase, cat] of PL_PHRASES) if (key.includes(phrase)) return cat;
  // Polish puts the head noun first ("jogurt truskawkowy" is a yoghurt), so the
  // words are tried in order and the first one that names an aisle decides.
  for (const word of key.split(' ')) {
    for (const [cat, list] of Object.entries(PL_WORDS)) if (list.includes(word)) return cat;
    for (const [cat, stems] of Object.entries(PL_STEMS)) if (stems.some((stem) => word.startsWith(stem))) return cat;
  }
  const other = categorizeIngredient({ foodName: name });
  return other && other !== FALLBACK ? other : null;
}

function validCategories() {
  return db.get().prepare('SELECT name FROM shopping_categories ORDER BY sort_order, id').all().map((r) => r.name);
}

/** The category the household attached to this name before (hand pick or earlier guess). */
export function rememberedCategory(key) {
  return db.get().prepare('SELECT category, source FROM shopping_category_memory WHERE name_key = ?').get(key) ?? null;
}

/** Remembers a category for a name; a guess never overwrites a hand pick. */
export function rememberCategory(name, category, source, confidence = null) {
  const key = nameKey(name);
  if (!key || !category) return;
  const prev = rememberedCategory(key);
  if (prev?.source === 'hand' && source !== 'hand') return;
  db.get().prepare(`
    INSERT INTO shopping_category_memory (name_key, category, source, confidence) VALUES (?, ?, ?, ?)
    ON CONFLICT(name_key) DO UPDATE SET category = excluded.category, source = excluded.source,
      confidence = excluded.confidence, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).run(key, category, source, confidence);
}

/** The category of the newest list row with the same name (any list), ignoring the catch-all. */
function historyCategory(key) {
  const rows = db.get().prepare(`
    SELECT name, category FROM shopping_items WHERE category IS NOT NULL AND category != ?
    ORDER BY created_at DESC, id DESC LIMIT 2000
  `).all(FALLBACK);
  return rows.find((r) => nameKey(r.name) === key)?.category ?? null;
}

// Polish labels for the default categories, so a model sees what they mean.
const LABELS = {
  'Obst & Gemüse': 'owoce i warzywa (fruit and vegetables)',
  'Backwaren': 'pieczywo, mąka, makaron (bread, flour, pasta)',
  'Milchprodukte': 'nabiał, jajka (dairy, eggs)',
  'Fleisch & Fisch': 'mięso, wędliny, ryby (meat, cold cuts, fish)',
  'Tiefkühl': 'mrożonki (frozen food)',
  'Getränke': 'napoje (drinks)',
  'Haushalt': 'chemia domowa (household cleaning and paper)',
  'Drogerie': 'kosmetyki, higiena (toiletries)',
  'Sonstiges': 'inne: przyprawy, konserwy, słodycze, sypkie (other: spices, cans, sweets, dry goods)',
};

/**
 * The category for a new item, without any model call. `source` says why.
 * @returns {{category: string, source: string}|null}
 */
export function localCategory(name) {
  const key = nameKey(name);
  if (!key) return null;
  const valid = validCategories();
  const remembered = rememberedCategory(key);
  if (remembered && valid.includes(remembered.category)) return { category: remembered.category, source: remembered.source };
  const history = historyCategory(key);
  if (history && valid.includes(history)) return { category: history, source: 'history' };
  const keyword = keywordCategory(name);
  if (keyword && valid.includes(keyword)) return { category: keyword, source: 'keywords' };
  return null;
}

/**
 * Like localCategory, then asks a model when nothing local knows the name and
 * the household switched the feature on. Remembers what the model said.
 * @returns {Promise<{category: string, source: string, confidence?: number}|null>}
 */
export async function guessCategory(name, { userId = null } = {}) {
  const local = localCategory(name);
  if (local) return local;
  if (!featureOn('shopping_smart')) return null;
  const valid = validCategories();
  const options = Object.fromEntries(valid.map((c) => [c, LABELS[c] ?? c]));
  const s = aiSettings();

  if (s.jevKey) {
    try {
      const out = await jev.choose({
        feature: 'shopping_smart',
        userId,
        state: `Produkt z listy zakupów w polskim domu: "${name}"`,
        instructions: 'In which shop aisle does a Polish household find this product?',
        options,
      });
      if (valid.includes(out.choice)) {
        if (out.confidence >= 0.4) rememberCategory(name, out.choice, 'jev', out.confidence);
        return { category: out.choice, source: 'jev', confidence: out.confidence };
      }
    } catch {
      // Jev unavailable: fall through to Haiku.
    }
  }
  if (!s.anthropicKey) return null;
  const out = await claude.json({
    feature: 'shopping_smart',
    userId,
    system: 'You sort grocery list items into shop aisles for a Polish household. Answer only with the JSON requested.',
    text: `Item: "${name}"\nAisles:\n${valid.map((c) => `- ${c}: ${LABELS[c] ?? c}`).join('\n')}\nPick the aisle name exactly as written before the colon.`,
    schema: {
      type: 'object',
      properties: { category: { type: 'string', enum: valid }, sure: { type: 'boolean' } },
      required: ['category', 'sure'],
      additionalProperties: false,
    },
    maxTokens: 60,
  });
  if (!valid.includes(out?.category)) return null;
  if (out.sure) rememberCategory(name, out.category, 'llm', null);
  return { category: out.category, source: 'llm' };
}
