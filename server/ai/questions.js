/**
 * Modul: AI - questions and weekly learning
 * Zweck: How the household memory grows without anyone having to write it.
 *        Once a week Yuvomi may ask ONE question with ready answers ("Czy
 *        jecie wieprzowinę?" - "Tak" / "Nie jemy"); every answer carries the
 *        memory sentence it becomes, so answering costs no model call. The same
 *        weekly run lets Haiku read recent meals and purchases and add up to
 *        three "learned" sentences the memory does not have yet.
 *        Never about health, money or people's private matters.
 */

import * as db from '../db.js';
import { nameKey } from '../utils/name-key.js';
import { claude } from './index.js';
import { addMemory, listMemories, memoryContext, TOPICS } from './memory.js';
import { historyBlock } from './household-insights.js';

const MAX_OPTIONS = 4;

function parse(row) {
  if (!row) return null;
  let options = [];
  try { options = JSON.parse(row.options_json); } catch { options = []; }
  return { id: row.id, topic: row.topic, question: row.question, options: options.map((o) => o.label), status: row.status, created_at: row.created_at };
}

/** The open question, if any, without the memory sentences behind the answers. */
export function openQuestion() {
  return parse(db.get().prepare("SELECT * FROM ai_questions WHERE status = 'open' ORDER BY created_at DESC, id DESC LIMIT 1").get());
}

/**
 * Stores the chosen answer and turns it into a memory sentence.
 * @returns {{question: object, memory: object|null}|null} null when the question is not open
 */
export function answerQuestion(id, optionIndex, userId = null) {
  const row = db.get().prepare("SELECT * FROM ai_questions WHERE id = ? AND status = 'open'").get(id);
  if (!row) return null;
  let options = [];
  try { options = JSON.parse(row.options_json); } catch { options = []; }
  const option = options[optionIndex];
  if (!option) return { invalid: true };
  const memory = option.memory ? addMemory({ topic: row.topic, text: option.memory, source: 'answer', userId }) : null;
  db.get().prepare(`UPDATE ai_questions SET status = 'answered', answer = ?, answered_by = ?, answered_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`)
    .run(option.label, userId, id);
  return { question: parse(db.get().prepare('SELECT * FROM ai_questions WHERE id = ?').get(id)), memory };
}

export function dismissQuestion(id) {
  return db.get().prepare("UPDATE ai_questions SET status = 'dismissed', answered_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND status = 'open'").run(id).changes > 0;
}

const QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    ask: { type: 'boolean' },
    topic: { type: 'string', enum: [...TOPICS] },
    question: { type: 'string' },
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, memory: { type: 'string' } },
        required: ['label', 'memory'],
        additionalProperties: false,
      },
    },
  },
  required: ['ask', 'topic', 'question', 'options'],
  additionalProperties: false,
};

/**
 * Creates one new question unless one is still open. Returns it, or null.
 */
export async function generateQuestion() {
  if (openQuestion()) return null;
  const earlier = db.get().prepare('SELECT question FROM ai_questions ORDER BY id DESC LIMIT 30').all().map((r) => `- ${r.question}`).join('\n');
  const memory = memoryContext(['meals', 'shopping']);
  const out = await claude.json({
    feature: 'questions',
    system: [
      'You help a Polish household app learn the household\'s food and shopping preferences, one short question at a time.',
      'Ask in Polish, informally, one question that would most improve meal ideas or shopping suggestions and that the notes do not answer yet.',
      'Give 2 to 4 short answer options. For each option write the sentence the app should remember if chosen, in Polish, in first person plural ("Nie jemy wieprzowiny.").',
      'Never ask about health, illness, medication, weight, money, income or anything private about a person. Never repeat an earlier question.',
      'If nothing useful is left to ask, set ask to false.',
    ].join(' '),
    text: [
      memory ? `Co już wiemy:\n${memory}` : 'Nic jeszcze nie wiemy.',
      historyBlock(),
      earlier ? `Wcześniejsze pytania:\n${earlier}` : '',
    ].filter(Boolean).join('\n\n'),
    schema: QUESTION_SCHEMA,
    maxTokens: 600,
  });
  if (!out?.ask || !out.question?.trim()) return null;
  const options = (out.options ?? [])
    .map((o) => ({ label: String(o.label ?? '').trim().slice(0, 80), memory: String(o.memory ?? '').trim().slice(0, 300) }))
    .filter((o) => o.label)
    .slice(0, MAX_OPTIONS);
  if (options.length < 2) return null;
  const topic = TOPICS.includes(out.topic) ? out.topic : 'household';
  const info = db.get().prepare('INSERT INTO ai_questions (topic, question, options_json) VALUES (?, ?, ?)')
    .run(topic, out.question.trim().slice(0, 300), JSON.stringify(options));
  return parse(db.get().prepare('SELECT * FROM ai_questions WHERE id = ?').get(info.lastInsertRowid));
}

const LEARN_SCHEMA = {
  type: 'object',
  properties: {
    sentences: {
      type: 'array',
      items: {
        type: 'object',
        properties: { topic: { type: 'string', enum: ['meals', 'shopping'] }, text: { type: 'string' } },
        required: ['topic', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['sentences'],
  additionalProperties: false,
};

/**
 * Reads recent meals and purchases and adds up to three habits the memory
 * does not know yet. Returns the stored rows.
 */
export async function learnFromHistory() {
  const history = historyBlock();
  if (!history) return [];
  const known = listMemories().map((m) => `- ${m.text}`).join('\n');
  const out = await claude.json({
    feature: 'questions',
    system: [
      'You notice stable habits in a Polish household\'s recent meals and shopping, to help the app suggest better.',
      'Write at most three short Polish sentences in first person plural about clear, repeated patterns (e.g. "W piątki zwykle jemy rybę.", "Mleko kupujemy co kilka dni.").',
      'Only what the data clearly shows. Nothing about health, diets for medical reasons, money or individual people. Skip anything already known.',
      'Return an empty list when nothing is clear.',
    ].join(' '),
    text: `${history}\n\nCo już wiemy:\n${known || '(nic)'}`,
    schema: LEARN_SCHEMA,
    maxTokens: 400,
  });
  const knownKeys = new Set(listMemories().map((m) => nameKey(m.text)));
  const stored = [];
  for (const s of (out?.sentences ?? []).slice(0, 3)) {
    const text = String(s.text ?? '').trim();
    if (!text || knownKeys.has(nameKey(text))) continue;
    stored.push(addMemory({ topic: s.topic, text, source: 'learned' }));
  }
  return stored;
}
