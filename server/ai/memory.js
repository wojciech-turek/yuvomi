/**
 * Modul: AI - household memory
 * Zweck: What Yuvomi knows about this household, as short sentences: "We don't
 *        eat pork", "Saturday is the big shopping day", "Wojtek likes it spicy".
 *        The household writes them, answers questions that create them, and
 *        Yuvomi adds what it learns from use. Every prompt that plans or
 *        suggests gets the relevant ones, so suggestions grow with the household.
 *
 * Kept in the household's own database (no memory service): at household scale
 * a few hundred sentences fit into a prompt as they are, and nothing leaves the
 * server except inside the prompts that use them. Health topics are not stored.
 */

import * as db from '../db.js';
import { nameKey } from '../utils/name-key.js';

export const TOPICS = Object.freeze(['household', 'meals', 'shopping']);
export const SOURCES = Object.freeze(['manual', 'answer', 'learned']);
export const MAX_TEXT = 300;
/** How many sentences one prompt carries at most. */
const CONTEXT_LIMIT = 60;

/** Same sentence regardless of case, diacritics, spacing and punctuation. */
export function sentenceKey(text) {
  return nameKey(text).replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
}

export function listMemories({ activeOnly = false } = {}) {
  return db.get().prepare(`
    SELECT id, topic, text, source, active, created_by, created_at, updated_at
    FROM ai_memories ${activeOnly ? 'WHERE active = 1' : ''}
    ORDER BY topic, updated_at DESC, id DESC
  `).all();
}

export function getMemory(id) {
  return db.get().prepare('SELECT * FROM ai_memories WHERE id = ?').get(id) ?? null;
}

/**
 * Adds a sentence, or refreshes the existing one with the same wording.
 * @returns {object} the stored row
 */
export function addMemory({ topic = 'household', text, source = 'manual', userId = null }) {
  const clean = String(text ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT);
  if (!clean) throw new Error('empty memory');
  const key = sentenceKey(clean);
  const existing = db.get().prepare('SELECT id, text FROM ai_memories').all().find((m) => sentenceKey(m.text) === key);
  if (existing) {
    db.get().prepare(`UPDATE ai_memories SET active = 1, topic = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`)
      .run(TOPICS.includes(topic) ? topic : 'household', existing.id);
    return getMemory(existing.id);
  }
  const info = db.get().prepare('INSERT INTO ai_memories (topic, text, source, created_by) VALUES (?, ?, ?, ?)')
    .run(TOPICS.includes(topic) ? topic : 'household', clean, SOURCES.includes(source) ? source : 'manual', userId);
  return getMemory(info.lastInsertRowid);
}

export function updateMemory(id, { topic, text, active }) {
  const row = getMemory(id);
  if (!row) return null;
  const nextText = text === undefined ? row.text : String(text).trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT);
  if (!nextText) throw new Error('empty memory');
  const nextTopic = topic !== undefined && TOPICS.includes(topic) ? topic : row.topic;
  const nextActive = typeof active === 'boolean' ? (active ? 1 : 0) : row.active;
  db.get().prepare(`UPDATE ai_memories SET topic = ?, text = ?, active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`)
    .run(nextTopic, nextText, nextActive, id);
  return getMemory(id);
}

export function deleteMemory(id) {
  return db.get().prepare('DELETE FROM ai_memories WHERE id = ?').run(id).changes > 0;
}

/**
 * The memory block for a prompt: household-wide sentences plus the ones for the
 * given topics, newest first, as "- sentence" lines. Empty string when none.
 * @param {string[]} topics
 */
export function memoryContext(topics = []) {
  const wanted = new Set(['household', ...topics]);
  const lines = listMemories({ activeOnly: true })
    .filter((m) => wanted.has(m.topic))
    .slice(0, CONTEXT_LIMIT)
    .map((m) => `- ${m.text}`);
  return lines.join('\n');
}
