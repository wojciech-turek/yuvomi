/**
 * AI foundation (fork, 2026-10-19): Polish name keys, purchase statistics,
 * keyword aisles, the Claude and Jev clients (with fakes, no network), the AI
 * settings/memory routes, the monthly cap, and the shopping purchase log,
 * ranked autocomplete and remembered hand categories.
 * Run: npm run test:ai
 */
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.TYPESAFE_API_KEY;

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const { nameKey, matchesPrefix } = await import('../server/utils/name-key.js');
const { groupPurchases, cadence, dueItems, weight } = await import('../server/ai/shopping-stats.js');
const { keywordCategory } = await import('../server/services/shopping-category-guess.js');
const { createClaude, costUsd, MODELS } = await import('../server/ai/claude.js');
const { createJev } = await import('../server/ai/jev.js');
const { AiError } = await import('../server/ai/errors.js');
const { guard } = await import('../server/ai/usage.js');
const { memoryContext } = await import('../server/ai/memory.js');
const { default: aiRouter } = await import('../server/routes/ai.js');
const { default: shoppingRouter } = await import('../server/routes/shopping.js');
const { default: pantryRouter } = await import('../server/routes/pantry.js');
const { parsePhotoDataUrl } = await import('../server/services/pantry-photo.js');

db.prepare("INSERT INTO users(username, display_name, password_hash, role) VALUES ('admin', 'Wojtek', 'x', 'admin')").run();
db.prepare("INSERT INTO users(username, display_name, password_hash, role) VALUES ('ola', 'Ola', 'x', 'member')").run();

let role = 'admin';
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = role === 'admin' ? 1 : 2; req.authRole = role; next(); });
app.use('/ai', aiRouter);
app.use('/shopping', shoppingRouter);
app.use('/pantry', pantryRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, body: json };
}

const DAY = 86_400_000;

// ---------------------------------------------------------------- pure parts

test('name keys fold case, Polish diacritics and spaces', () => {
  assert.equal(nameKey('  Żółty   SER '), 'zolty ser');
  assert.equal(nameKey('Łosoś'), 'losos');
  assert.ok(matchesPrefix('zolty ser', 'ser'), 'start of a later word matches');
  assert.ok(!matchesPrefix('zolty ser', 'er'));
});

test('cadence needs three trips and collapses same-day repeats', () => {
  const now = Date.UTC(2026, 9, 19);
  assert.equal(cadence([now - 10 * DAY, now - 5 * DAY], now), null);
  const c = cadence([now - 15 * DAY, now - 10 * DAY, now - 10 * DAY + 3600_000, now - 5 * DAY], now);
  assert.equal(c.everyDays, 5);
  assert.equal(Math.round(c.sinceDays), 5);
  assert.equal(c.trips, 3);
});

test('due items: on time or a bit late, not open, not long abandoned', () => {
  const now = Date.UTC(2026, 9, 19);
  const ev = (name, daysAgo) => ({ name, name_key: nameKey(name), category: 'Milchprodukte', purchased_at: new Date(now - daysAgo * DAY).toISOString() });
  const groups = groupPurchases([
    ev('Mleko', 21), ev('Mleko', 14), ev('Mleko', 7), // every 7, last 7 days ago: due
    ev('Masło', 30), ev('Masło', 20), ev('Masło', 10), // every 10, last 10: due but open on a list
    ev('Mąka', 300), ev('Mąka', 290), ev('Mąka', 280), // every 10, last 280: habit stopped
    ev('Jajka', 6), ev('Jajka', 3), ev('Jajka', 1), // every ~2.5, last 1: not yet
  ]);
  const due = dueItems(groups, now, new Set(['maslo']));
  assert.deepEqual(due.map((d) => d.name), ['Mleko']);
  assert.ok(weight([now], now) > weight([now - 120 * DAY], now), 'recent purchases weigh more');
});

test('Polish keywords: head noun first, phrases before stems, no false friends', () => {
  assert.equal(keywordCategory('jogurt truskawkowy'), 'Milchprodukte');
  assert.equal(keywordCategory('pasta do zębów'), 'Drogerie');
  assert.equal(keywordCategory('Serwetki'), 'Haushalt');
  assert.equal(keywordCategory('ser żółty'), 'Milchprodukte');
  assert.equal(keywordCategory('Makrela wędzona'), 'Fleisch & Fisch');
  assert.equal(keywordCategory('mąka pszenna'), 'Backwaren');
  assert.equal(keywordCategory('mrożone warzywa'), 'Tiefkühl');
  assert.equal(keywordCategory('cukier'), null);
});

// ---------------------------------------------------------------- clients

test('claude client: guard first, schema in output_config, usage recorded, JSON parsed', async () => {
  const sent = [];
  const records = [];
  const fakeClient = { messages: { create: async (params) => { sent.push(params); return {
    stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 },
    content: [{ type: 'text', text: '{"ok":true}' }],
  }; } } };
  const claude = createClaude({ getApiKey: () => 'k', guard: () => {}, record: (e) => records.push(e), clientFactory: () => fakeClient });
  const out = await claude.json({ feature: 'f', system: 's', text: 'x', schema: { type: 'object' } });
  assert.deepEqual(out, { ok: true });
  assert.equal(sent[0].model, MODELS.fast);
  assert.deepEqual(sent[0].thinking, { type: 'disabled' }, 'Haiku answers without thinking');
  assert.equal(sent[0].output_config.format.type, 'json_schema');
  assert.equal(records[0].usage.input_tokens, 1000);
  assert.ok(Math.abs(records[0].usd - costUsd(MODELS.fast, { input_tokens: 1000, output_tokens: 200 })) < 1e-12);

  await claude.json({ feature: 'f', tier: 'smart', system: 's', text: 'x', schema: { type: 'object' } });
  assert.equal(sent[1].model, MODELS.smart);
  assert.equal(sent[1].thinking, undefined, 'Sonnet keeps adaptive thinking');
});

test('claude client: refusal, missing key and a refusing guard become AiErrors', async () => {
  const refusing = { messages: { create: async () => ({ stop_reason: 'refusal', usage: {}, content: [] }) } };
  const claude = createClaude({ getApiKey: () => 'k', guard: () => {}, record: () => {}, clientFactory: () => refusing });
  await assert.rejects(claude.json({ feature: 'f', system: 's', text: 'x', schema: {} }), (e) => e instanceof AiError && e.code === 'refused');
  const noKey = createClaude({ getApiKey: () => '', guard: () => {}, record: () => {}, clientFactory: () => refusing });
  await assert.rejects(noKey.json({ feature: 'f', system: 's', text: 'x', schema: {} }), (e) => e.code === 'not_configured');
  const capped = createClaude({ getApiKey: () => 'k', guard: () => { throw new AiError('cap_reached'); }, record: () => {}, clientFactory: () => refusing });
  await assert.rejects(capped.json({ feature: 'f', system: 's', text: 'x', schema: {} }), (e) => e.code === 'cap_reached');
});

test('jev client: choice request shape and answer', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    return { ok: true, json: async () => ({ model: 'jev-1.14.0', answers: { pick: { type: 'choice', choice: 'dairy', confidence: 0.8, probabilities: { dairy: 0.9 } } }, usage: { input_tokens: 100 } }) };
  };
  const records = [];
  const jev = createJev({ getApiKey: () => 'jk', guard: () => {}, record: (e) => records.push(e), fetchImpl });
  const out = await jev.choose({ feature: 'f', state: 'mleko', instructions: 'aisle?', options: { dairy: 'milk', other: 'else' } });
  assert.equal(out.choice, 'dairy');
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(calls[0].auth, 'Bearer jk');
  assert.equal(calls[0].body.questions.pick.type, 'choice');
  assert.deepEqual(calls[0].body.questions.pick.criteria, { dairy: 'milk', other: 'else' });
  assert.equal(records[0].provider, 'jev');

  const failing = createJev({ getApiKey: () => 'jk', guard: () => {}, record: () => {}, fetchImpl: async () => ({ ok: false, status: 401 }) });
  await assert.rejects(failing.choose({ feature: 'f', state: 'x', instructions: 'i', options: { a: 'a' } }), (e) => e.code === 'not_configured');
});

// ---------------------------------------------------------------- routes

test('AI is off by default and the status says so', async () => {
  const r = await call('GET', '/ai/status');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.enabled, false);
  assert.equal(r.body.data.ready, false);
  assert.throws(() => guard('meal_ingredients'), (e) => e.code === 'disabled');
});

test('config is admin-only and never returns a key', async () => {
  role = 'member';
  assert.equal((await call('GET', '/ai/config')).status, 403);
  assert.equal((await call('PUT', '/ai/config', { enabled: true })).status, 403);
  role = 'admin';
  const put = await call('PUT', '/ai/config', { enabled: true, anthropicKey: 'sk-ant-test-123', capUsd: 3, smartModel: 'claude-haiku-5-5' });
  assert.equal(put.status, 200);
  assert.equal(put.body.data.anthropicKeySet, true);
  assert.equal(put.body.data.capUsd, 3);
  assert.equal(put.body.data.smartModel, 'claude-haiku-5-5');
  assert.ok(!JSON.stringify(put.body).includes('sk-ant-test-123'), 'the key never leaves the server');
  assert.equal((await call('PUT', '/ai/config', { smartModel: 'claude-opus-5-5' })).status, 400, 'Opus is not offered');
  assert.equal((await call('PUT', '/ai/config', { capUsd: -1 })).status, 400);
  const status = await call('GET', '/ai/status');
  assert.equal(status.body.data.ready, true);
  assert.equal(status.body.data.features.meal_ingredients, true);
});

test('a feature switch and the monthly cap stop calls', async () => {
  await call('PUT', '/ai/config', { features: { pantry_photo: false } });
  assert.throws(() => guard('pantry_photo'), (e) => e.code === 'disabled');
  assert.doesNotThrow(() => guard('meal_ingredients'));
  db.prepare("INSERT INTO ai_usage (feature, provider, model, usd) VALUES ('meal_ingredients', 'anthropic', 'claude-haiku-5-5', 3.5)").run();
  assert.throws(() => guard('meal_ingredients'), (e) => e.code === 'cap_reached');
  const cfg = await call('GET', '/ai/config');
  assert.ok(cfg.body.data.usage.monthUsd >= 3.5);
  db.prepare('DELETE FROM ai_usage').run();
});

test('memory: add, dedupe by wording, pause, delete, prompt context', async () => {
  const a = await call('POST', '/ai/memories', { text: 'Nie jemy wieprzowiny', topic: 'meals' });
  assert.equal(a.status, 201);
  const again = await call('POST', '/ai/memories', { text: '  nie jemy WIEPRZOWINY ', topic: 'meals' });
  assert.equal(again.body.data.id, a.body.data.id, 'same sentence, same row');
  await call('POST', '/ai/memories', { text: 'Zakupy robimy w soboty', topic: 'shopping' });
  assert.equal((await call('POST', '/ai/memories', { text: '' })).status, 400);
  assert.equal((await call('POST', '/ai/memories', { text: 'x', topic: 'health' })).status, 400, 'no health topic');
  assert.match(memoryContext(['meals']), /Nie jemy wieprzowiny/);
  assert.doesNotMatch(memoryContext(['meals']), /soboty/, 'other topics stay out');
  await call('PATCH', `/ai/memories/${a.body.data.id}`, { active: false });
  assert.doesNotMatch(memoryContext(['meals']), /wieprzowiny/, 'paused sentences stay out');
  assert.equal((await call('DELETE', `/ai/memories/${a.body.data.id}`)).status, 204);
  assert.equal((await call('DELETE', `/ai/memories/${a.body.data.id}`)).status, 404);
});

test('ticking logs a purchase, unticking takes it back', async () => {
  const list = db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Biedronka', 1)").run().lastInsertRowid;
  const add = await call('POST', `/shopping/${list}/items`, { name: 'Mleko 2%', category: 'Milchprodukte' });
  const id = add.body.data.id;
  await call('PATCH', `/shopping/items/${id}`, { is_checked: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM shopping_purchases WHERE item_id = ?').get(id).c, 1);
  assert.equal(db.prepare('SELECT name_key FROM shopping_purchases WHERE item_id = ?').get(id).name_key, 'mleko 2%');
  await call('PATCH', `/shopping/items/${id}`, { is_checked: false });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM shopping_purchases WHERE item_id = ?').get(id).c, 0);
  await call('PATCH', `/shopping/items/${id}`, { is_checked: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM shopping_purchases').get().c, 1);
});

test('autocomplete ranks by what is bought, ignores diacritics, matches word starts', async () => {
  const list = db.prepare("SELECT id FROM shopping_lists LIMIT 1").get().id;
  await call('POST', `/shopping/${list}/items`, { name: 'Żółty ser', category: 'Milchprodukte' });
  await call('POST', `/shopping/${list}/items`, { name: 'Mascarpone', category: 'Milchprodukte' });
  const now = Date.now();
  const insert = db.prepare('INSERT INTO shopping_purchases (name, name_key, category, purchased_at) VALUES (?, ?, ?, ?)');
  for (const d of [3, 10, 17]) insert.run('Masło', 'maslo', 'Milchprodukte', new Date(now - d * DAY).toISOString());
  insert.run('Mascarpone', 'mascarpone', 'Milchprodukte', new Date(now - 200 * DAY).toISOString());
  const ma = await call('GET', '/shopping/suggestions?q=ma');
  assert.deepEqual(ma.body.data.slice(0, 2).map((s) => s.name), ['Masło', 'Mascarpone'], 'bought often and recently first');
  const zolty = await call('GET', '/shopping/suggestions?q=zolty');
  assert.equal(zolty.body.data[0]?.name, 'Żółty ser');
  const ser = await call('GET', '/shopping/suggestions?q=ser');
  assert.ok(ser.body.data.some((s) => s.name === 'Żółty ser'), 'start of a later word');
});

test('a hand-picked aisle is remembered and wins over keywords', async () => {
  const list = db.prepare("SELECT id FROM shopping_lists LIMIT 1").get().id;
  const add = await call('POST', `/shopping/${list}/items`, { name: 'Hummus', category: 'Sonstiges', category_source: 'default' });
  assert.equal(add.body.data.category, 'Sonstiges', 'nothing knows hummus yet');
  await call('PATCH', `/shopping/items/${add.body.data.id}`, { category: 'Milchprodukte' });
  const guess = await call('GET', '/shopping/category-guess?name=hummus');
  assert.deepEqual(guess.body.data, { category: 'Milchprodukte', source: 'hand' });
  const keyword = await call('GET', '/shopping/category-guess?name=jogurt naturalny');
  assert.equal(keyword.body.data.category, 'Milchprodukte');
  const auto = await call('POST', `/shopping/${list}/items`, { name: 'Banany', category: 'Sonstiges', category_source: 'default' });
  assert.equal(auto.body.data.category, 'Obst & Gemüse', 'left at default, sorted by keywords');
  const kept = await call('POST', `/shopping/${list}/items`, { name: 'Banany', category: 'Sonstiges', category_source: 'hand' });
  assert.equal(kept.body.data.category, 'Sonstiges', 'a hand choice is never overridden');
});

test('predictions stay empty until the household switches shopping help on', async () => {
  await call('PUT', '/ai/config', { features: { shopping_smart: false } });
  assert.deepEqual((await call('GET', '/shopping/predictions')).body.data, []);
  await call('PUT', '/ai/config', { features: { shopping_smart: true } });
  const now = Date.now();
  const insert = db.prepare('INSERT INTO shopping_purchases (name, name_key, category, purchased_at) VALUES (?, ?, ?, ?)');
  for (const d of [4, 8, 12]) insert.run('Chleb', 'chleb', 'Backwaren', new Date(now - d * DAY).toISOString());
  const r = await call('GET', '/shopping/predictions');
  assert.equal(r.status, 200);
  const names = r.body.data.map((p) => p.name);
  assert.ok(names.includes('Chleb'), 'every 4 days, last 4 days ago: due');
  assert.ok(!names.includes('Masło'), 'every 7 days, last 3 days ago: not yet');
  assert.equal(r.body.data.find((p) => p.name === 'Chleb').everyDays, 4);
});

// ---------------------------------------------------------------- meals

test('meal ingredient suggestions: recipe, then last time, pantry marked, nothing invented without AI', async () => {
  const { suggestIngredients } = await import('../server/services/meal-ingredient-suggest.js');
  const recipe = db.prepare("INSERT INTO recipes (title, created_by) VALUES ('Leczo', 1)").run().lastInsertRowid;
  db.prepare("INSERT INTO recipe_ingredients (recipe_id, name, quantity, category) VALUES (?, 'Papryka', '3 szt.', 'Obst & Gemüse'), (?, 'Kiełbasa', '300 g', 'Sonstiges')").run(recipe, recipe);
  const fromRecipe = await suggestIngredients({ title: 'leczo', allowAi: false });
  assert.equal(fromRecipe.source, 'recipe');
  assert.deepEqual(fromRecipe.ingredients.map((i) => i.name), ['Papryka', 'Kiełbasa']);
  assert.equal(fromRecipe.ingredients[1].category, 'Fleisch & Fisch', 'a catch-all category is replaced by the keyword guess');

  const meal = db.prepare("INSERT INTO meals (date, meal_type, title, created_by) VALUES ('2026-10-01', 'dinner', 'Leczo', 1)").run().lastInsertRowid;
  db.prepare("INSERT INTO meal_ingredients (meal_id, name, quantity, category) VALUES (?, 'Cukinia', '1', 'Obst & Gemüse'), (?, 'Cebula', '2', 'Obst & Gemüse')").run(meal, meal);
  db.prepare("INSERT INTO pantry_items (name, quantity, unit) VALUES ('Cebula', 3, 'pcs')").run();
  const fromHistory = await suggestIngredients({ title: '  LECZO ', allowAi: false });
  assert.equal(fromHistory.source, 'history', 'what we cooked last time beats the recipe of the same name');
  assert.deepEqual(fromHistory.ingredients.map((i) => [i.name, i.in_pantry]), [['Cukinia', false], ['Cebula', true]]);

  const linked = await suggestIngredients({ title: 'Leczo', recipeId: recipe, allowAi: false });
  assert.equal(linked.source, 'recipe', 'a linked recipe beats history');

  const unknown = await suggestIngredients({ title: 'Coś nowego', allowAi: false });
  assert.deepEqual(unknown, { source: null, ingredients: [] });
});

// ---------------------------------------------------------------- pantry photo

// A buffer that starts like a JPEG (FF D8 FF), long enough to pass the size floor.
const JPEG_BODY = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 1)]).toString('base64');

test('pantry photo: only real images of sane size are accepted', () => {
  assert.deepEqual(parsePhotoDataUrl(`data:image/jpeg;base64,${JPEG_BODY}`), { mediaType: 'image/jpeg', data: JPEG_BODY });
  assert.equal(parsePhotoDataUrl(`data:image/png;base64,${JPEG_BODY}`), null, 'the bytes must match the claimed type');
  assert.equal(parsePhotoDataUrl(`data:image/jpeg;base64,${'A'.repeat(4000)}`), null, 'not image bytes');
  assert.equal(parsePhotoDataUrl(`data:image/gif;base64,${JPEG_BODY}`), null);
  assert.equal(parsePhotoDataUrl('data:image/png;base64,AAAA'), null, 'too small to be a photo');
  assert.equal(parsePhotoDataUrl('https://example.com/a.jpg'), null);
});

test('pantry photo: switched off answers with a reason, never a model call', async () => {
  await call('PUT', '/ai/config', { features: { pantry_photo: false } });
  const r = await call('POST', '/pantry/photo-scan', { image: `data:image/jpeg;base64,${JPEG_BODY}` });
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'ai_disabled');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM ai_usage WHERE feature = 'pantry_photo'").get().c, 0);
  const bad = await call('POST', '/pantry/photo-scan', { image: 'not a photo' });
  assert.equal(bad.status, 400);
});

test('pantry photo apply: new items are added, matching ones topped up', async () => {
  db.prepare("INSERT INTO pantry_items (name, quantity, unit) VALUES ('Ryż', 1, 'pkg')").run();
  const r = await call('POST', '/pantry/photo-scan/apply', { items: [
    { name: 'ryż', quantity: 2, unit: 'pkg' },
    { name: 'Passata pomidorowa', quantity: 3, unit: 'jar' },
  ] });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.data, { added: 1, merged: 1 });
  assert.equal(db.prepare("SELECT quantity FROM pantry_items WHERE name = 'Ryż'").get().quantity, 3);
  assert.equal(db.prepare("SELECT unit FROM pantry_items WHERE name = 'Passata pomidorowa'").get().unit, 'jar');
  assert.equal((await call('POST', '/pantry/photo-scan/apply', { items: [] })).status, 400);
});

// ---------------------------------------------------------------- questions, heads-up, schedule

test('answering a question stores its memory sentence; dismissing closes it', async () => {
  const insert = db.prepare('INSERT INTO ai_questions (topic, question, options_json) VALUES (?, ?, ?)');
  const id = insert.run('meals', 'Czy jecie ryby?', JSON.stringify([
    { label: 'Tak, chętnie', memory: 'Lubimy ryby.' },
    { label: 'Nie', memory: 'Nie jemy ryb.' },
  ])).lastInsertRowid;
  const open = await call('GET', '/ai/questions/open');
  assert.deepEqual(open.body.data.options, ['Tak, chętnie', 'Nie'], 'labels only, not the sentences behind them');
  assert.equal((await call('POST', `/ai/questions/${id}/answer`, { option: 5 })).status, 400);
  const answer = await call('POST', `/ai/questions/${id}/answer`, { option: 1 });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.data.memory.text, 'Nie jemy ryb.');
  assert.equal(answer.body.data.memory.source, 'answer');
  assert.equal((await call('POST', `/ai/questions/${id}/answer`, { option: 0 })).status, 404, 'answered once');
  const id2 = insert.run('shopping', 'Gdzie robicie zakupy?', JSON.stringify([{ label: 'Biedronka', memory: 'Zakupy robimy w Biedronce.' }, { label: 'Różnie', memory: '' }])).lastInsertRowid;
  assert.equal((await call('POST', `/ai/questions/${id2}/dismiss`)).status, 204);
  assert.equal((await call('GET', '/ai/questions/open')).body.data, null);
});

test('heads-up: nothing planned for tomorrow, but only for households that plan', async () => {
  const { pickNudge } = await import('../server/ai/nudges.js');
  const features = { nudges: true, shopping_smart: true };
  db.prepare('DELETE FROM meals').run();
  assert.equal(pickNudge({ today: '2026-10-19', features }), null, 'a household that does not plan is not nagged');
  const add = db.prepare("INSERT INTO meals (date, meal_type, title, created_by) VALUES (?, 'lunch', 'Obiad', 1)");
  for (const d of ['2026-10-15', '2026-10-17', '2026-10-19']) add.run(d);
  const nudge = pickNudge({ today: '2026-10-19', features });
  assert.equal(nudge.kind, 'no-plan');
  assert.equal(nudge.url, '/meals?ideas=2026-10-20');
  assert.ok(nudge.title && nudge.body, 'fixed, translated sentences');
  add.run('2026-10-20');
  assert.notEqual(pickNudge({ today: '2026-10-19', features })?.kind, 'no-plan');
  assert.equal(pickNudge({ today: '2026-10-19', features: { nudges: false, shopping_smart: true } }), null, 'switched off');
});

test('schedule: the daily heads-up runs once per day, after 17:30 household time', async () => {
  const { runAiTick, wallClock } = await import('../server/ai/scheduler.js');
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Warsaw') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  assert.deepEqual(wallClock(new Date('2026-10-19T15:45:00Z'), 'Europe/Warsaw'), { hour: 17, minute: 45, weekday: 'Mon' });
  db.prepare("DELETE FROM sync_config WHERE key IN ('ai_nudge_last_day', 'ai_weekly_last')").run();
  assert.deepEqual(await runAiTick(new Date('2026-10-19T14:00:00Z')), {}, '16:00 in Warsaw: too early');
  const first = await runAiTick(new Date('2026-10-19T15:45:00Z'));
  assert.ok(first.daily, 'ran at 17:45');
  assert.deepEqual(await runAiTick(new Date('2026-10-19T16:30:00Z')), {}, 'not twice the same day');
  await call('PUT', '/ai/config', { enabled: false });
  assert.deepEqual(await runAiTick(new Date('2026-10-20T16:00:00Z')), { skipped: 'disabled' });
  await call('PUT', '/ai/config', { enabled: true });
});

test('autocomplete knows common Polish groceries before the household has history', async () => {
  const r = await call('GET', '/shopping/suggestions?q=papier toal');
  assert.equal(r.body.data[0]?.name, 'Papier toaletowy');
  assert.equal(r.body.data[0]?.category, 'Haushalt');
  const pom = await call('GET', '/shopping/suggestions?q=pomar');
  assert.ok(pom.body.data.some((s) => s.name === 'Pomarańcze'), 'diacritic-free typing finds Polish names');
});

test('memory sentences match regardless of punctuation and case', async () => {
  const { addMemory } = await import('../server/ai/memory.js');
  const a = addMemory({ text: 'Lubimy ostre jedzenie', topic: 'meals' });
  const b = addMemory({ text: 'lubimy OSTRE jedzenie.', topic: 'meals', source: 'answer' });
  assert.equal(a.id, b.id);
});
