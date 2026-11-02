/**
 * Modul: Ein Satz wird zum Entwurf (One Today, Task 9)
 * Zweck: quickDraftFromSentence() postet den Satz EINMAL an /quick-add/parse;
 *        die KI-Antwort bestimmt Art und Felder, sonst entscheidet die lokale
 *        Regel (Einkauf oder Aufgabe, nie ein Termin). splitSpokenItems()
 *        zerlegt "mleko, chleb i 2 l soku".
 * Ausfuehren: npm run test:quick-draft
 */
process.env.TZ = 'Asia/Yekaterinburg';
import test from 'node:test';
import assert from 'node:assert/strict';

const { quickDraftFromSentence } = await import('../public/utils/quick-draft.js');
const { splitSpokenItems } = await import('../public/utils/shopping-entry.js');
const { setDisplayTimeZone } = await import('../public/utils/timezone.js');
setDisplayTimeZone('Europe/Warsaw');

const NOW = new Date('2026-11-02T10:00:00Z');
const UNAVAILABLE = async () => ({ data: { source: null, unavailable: 'ai_disabled' } });
const recorder = (answer) => {
  const calls = [];
  const post = async (path, body, opts) => { calls.push({ path, body, opts }); return answer(); };
  return { calls, post };
};

test('AI shopping answer: kind shopping with its items', async () => {
  const { calls, post } = recorder(async () => ({
    data: { source: 'ai', kind: 'shopping', fields: { items: [{ name: 'mleko', quantity: null }] } },
  }));
  const out = await quickDraftFromSentence('kup mleko', { post, now: NOW });
  assert.equal(out.source, 'ai');
  assert.equal(out.kind, 'shopping');
  assert.deepEqual(out.draft, { items: [{ name: 'mleko', quantity: null }] });
  assert.equal(calls.length, 1);
});

test('posts exactly once with { text } and no kind unless one is given', async () => {
  const { calls, post } = recorder(UNAVAILABLE);
  await quickDraftFromSentence('  trening w czwartek o 17  ', { post, now: NOW });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/quick-add/parse');
  assert.deepEqual(calls[0].body, { text: 'trening w czwartek o 17' });
});

test('a forced kind is passed through', async () => {
  const { calls, post } = recorder(async () => ({
    data: { source: 'ai', kind: 'event', fields: { title: 'Trening', date: null } },
  }));
  const out = await quickDraftFromSentence('trening', { post, now: NOW, kind: 'event' });
  assert.deepEqual(calls[0].body, { text: 'trening', kind: 'event' });
  assert.equal(out.kind, 'event');
  assert.equal(out.draft.title, 'Trening');
});

test('unavailable + "kup mleko, chleb": local shopping with two items', async () => {
  const { post } = recorder(UNAVAILABLE);
  const out = await quickDraftFromSentence('kup mleko, chleb', { post, now: NOW });
  assert.equal(out.source, 'local');
  assert.equal(out.kind, 'shopping');
  assert.deepEqual(out.draft.items.map((i) => i.name), ['mleko', 'chleb']);
});

test('unavailable + a plain comma list of short items is shopping, with a verb or a day it is a task', async () => {
  const { post } = recorder(UNAVAILABLE);
  const list = await quickDraftFromSentence('mleko, chleb i jajka', { post, now: NOW });
  assert.equal(list.kind, 'shopping');
  assert.equal(list.draft.items.length, 3);
  const verb = await quickDraftFromSentence('zadzwonić do babci, kupić mleko', { post, now: NOW });
  assert.equal(verb.kind, 'task');
  const day = await quickDraftFromSentence('mleko, chleb jutro', { post, now: NOW });
  assert.equal(day.kind, 'task');
});

test('unavailable + "trening w czwartek o 17": local task, never an event', async () => {
  const { post } = recorder(UNAVAILABLE);
  const out = await quickDraftFromSentence('trening w czwartek o 17', { post, now: NOW });
  assert.equal(out.source, 'local');
  assert.equal(out.kind, 'task');
  assert.equal(out.draft.title, 'Trening');
  assert.match(out.draft.due_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(out.draft.due_time, '17:00');
});

test('a forced event without AI is a task with the sentence as the title', async () => {
  const { post } = recorder(UNAVAILABLE);
  const out = await quickDraftFromSentence('wizyta u dentysty w piątek', { post, now: NOW, kind: 'event' });
  assert.equal(out.kind, 'task');
  assert.equal(out.source, 'local');
  assert.equal(out.draft.title, 'wizyta u dentysty w piątek');
  assert.equal(out.draft.due_date, null);
});

test('a throwing post falls back to the local rule', async () => {
  const out = await quickDraftFromSentence('kup masło', {
    post: async () => { throw new Error('offline'); }, now: NOW,
  });
  assert.equal(out.source, 'local');
  assert.equal(out.kind, 'shopping');
});

test('a post that never answers: the local rule after the timeout, the request aborted', async () => {
  let signal = null;
  const out = await quickDraftFromSentence('kup masło', {
    post: (path, body, opts) => { signal = opts.signal; return new Promise(() => {}); },
    now: NOW,
    timeoutMs: 20,
  });
  assert.equal(out.source, 'local');
  assert.equal(out.kind, 'shopping');
  assert.equal(signal?.aborted, true);
});

test('an AI answer with an unknown kind or no fields is not trusted', async () => {
  const bad = await quickDraftFromSentence('kup masło', {
    post: async () => ({ data: { source: 'ai', kind: 'meal', fields: {} } }), now: NOW,
  });
  assert.equal(bad.source, 'local');
  const none = await quickDraftFromSentence('kup masło', {
    post: async () => ({ data: { source: 'ai', kind: 'task' } }), now: NOW,
  });
  assert.equal(none.source, 'local');
});

test('splitSpokenItems: commas, "i" and "oraz"', () => {
  assert.deepEqual(splitSpokenItems('mleko, chleb i 2 l soku'), [
    { name: 'mleko', quantity: null },
    { name: 'chleb', quantity: null },
    { name: 'sok', quantity: '2 l' },
  ]);
  assert.deepEqual(splitSpokenItems('sól oraz pieprz').map((i) => i.name), ['sól', 'pieprz']);
  assert.deepEqual(splitSpokenItems(' , '), []);
});
