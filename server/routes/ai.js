/**
 * Modul: AI - settings, status and household memory
 * Zweck: The admin's AI settings (switch, keys, model, monthly limit, features),
 *        a connection test, the status every page reads to decide whether to
 *        show AI help, and the household memory every member can read and edit.
 *        The features themselves live with their modules (shopping, meals,
 *        pantry), so their routes keep those modules' permission gates.
 */

import express from 'express';
import { createLogger } from '../logger.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { claude, jev, AiError } from '../ai/index.js';
import { sendAiError } from '../ai/http.js';
import { publicSettings, updateSettings, aiSettings } from '../ai/settings.js';
import { usageSummary } from '../ai/usage.js';
import { listMemories, addMemory, updateMemory, deleteMemory, getMemory, TOPICS, MAX_TEXT } from '../ai/memory.js';
import { openQuestion, answerQuestion, dismissQuestion, generateQuestion, learnFromHistory } from '../ai/questions.js';
import { refuseWallWrite } from '../services/wall-settings.js';

const router = express.Router();
const log = createLogger('AI');

// --------------------------------------------------------
// GET /api/v1/ai/status - what pages need to decide whether to offer AI help.
// No keys, no costs: every signed-in member may read it.
// --------------------------------------------------------
router.get('/status', (_req, res) => {
  const s = aiSettings();
  const ready = s.enabled && Boolean(s.anthropicKey);
  res.json({ data: {
    enabled: s.enabled,
    ready,
    jev: s.enabled && Boolean(s.jevKey),
    features: Object.fromEntries(Object.entries(s.features).map(([f, on]) => [f, ready && on])),
  } });
});

// --------------------------------------------------------
// GET /api/v1/ai/config - admin: settings and this month's usage
// --------------------------------------------------------
router.get('/config', requireAdmin, (_req, res) => {
  try {
    res.json({ data: { ...publicSettings(), usage: usageSummary() } });
  } catch (err) {
    sendAiError(res, err, 'GET /config');
  }
});

// --------------------------------------------------------
// PUT /api/v1/ai/config - admin: { enabled?, anthropicKey?, clearAnthropicKey?,
//   jevKey?, clearJevKey?, capUsd?, smartModel?, features?: { name: bool } }
// --------------------------------------------------------
router.put('/config', requireAdmin, (req, res) => {
  try {
    const problem = updateSettings(req.body ?? {});
    if (problem) return res.status(400).json({ error: problem, code: 400 });
    if (!process.env.DB_ENCRYPTION_KEY && (req.body?.anthropicKey || req.body?.jevKey)) {
      log.warn('DB_ENCRYPTION_KEY is not set - the AI API keys are stored in an unencrypted database.');
    }
    res.json({ data: { ...publicSettings(), usage: usageSummary() } });
  } catch (err) {
    sendAiError(res, err, 'PUT /config');
  }
});

// --------------------------------------------------------
// POST /api/v1/ai/test - admin: one tiny call per configured provider.
// Response: { data: { claude: { ok, error? }, jev: { ok, error? } | null } }
// --------------------------------------------------------
router.post('/test', requireAdmin, async (req, res) => {
  const result = { claude: null, jev: null };
  const s = aiSettings();
  if (s.anthropicKey) {
    try {
      const out = await claude.json({
        feature: 'admin-test',
        userId: req.authUserId,
        system: 'Answer with the JSON object requested.',
        text: 'Return {"ok": true}.',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
        maxTokens: 50,
      });
      result.claude = { ok: out?.ok === true };
    } catch (err) {
      result.claude = { ok: false, error: err instanceof AiError ? err.code : 'provider_error' };
    }
  }
  if (s.jevKey) {
    try {
      const out = await jev.choose({
        feature: 'admin-test',
        userId: req.authUserId,
        state: 'mleko 2%',
        instructions: 'Which shop aisle does this grocery item belong to?',
        options: { dairy: 'Milk, cheese, yoghurt', bakery: 'Bread and rolls', other: 'Anything else' },
      });
      result.jev = { ok: Boolean(out.choice), choice: out.choice };
    } catch (err) {
      result.jev = { ok: false, error: err instanceof AiError ? err.code : 'provider_error' };
    }
  }
  res.json({ data: result });
});

// --------------------------------------------------------
// Household memory: GET/POST /api/v1/ai/memories, PATCH/DELETE /api/v1/ai/memories/:id
// --------------------------------------------------------
function readMemoryBody(body, { partial }) {
  const out = {};
  if (body.text !== undefined || !partial) {
    const text = String(body.text ?? '').trim();
    if (!text) return { error: 'The sentence is empty.' };
    if (text.length > MAX_TEXT) return { error: `Keep it under ${MAX_TEXT} characters.` };
    out.text = text;
  }
  if (body.topic !== undefined) {
    if (!TOPICS.includes(body.topic)) return { error: 'Unknown topic.' };
    out.topic = body.topic;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') return { error: 'active must be true or false.' };
    out.active = body.active;
  }
  return { value: out };
}

router.get('/memories', (_req, res) => {
  try {
    res.json({ data: listMemories() });
  } catch (err) {
    sendAiError(res, err, 'GET /memories');
  }
});

router.post('/memories', (req, res) => {
  try {
    const parsed = readMemoryBody(req.body ?? {}, { partial: false });
    if (parsed.error) return res.status(400).json({ error: parsed.error, code: 400 });
    const row = addMemory({ ...parsed.value, source: 'manual', userId: req.authUserId });
    res.status(201).json({ data: row });
  } catch (err) {
    sendAiError(res, err, 'POST /memories');
  }
});

router.patch('/memories/:id', (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!getMemory(id)) return res.status(404).json({ error: 'Not found.', code: 404 });
    const parsed = readMemoryBody(req.body ?? {}, { partial: true });
    if (parsed.error) return res.status(400).json({ error: parsed.error, code: 400 });
    res.json({ data: updateMemory(id, parsed.value) });
  } catch (err) {
    sendAiError(res, err, 'PATCH /memories/:id');
  }
});

router.delete('/memories/:id', (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!deleteMemory(id)) return res.status(404).json({ error: 'Not found.', code: 404 });
    res.status(204).end();
  } catch (err) {
    sendAiError(res, err, 'DELETE /memories/:id');
  }
});

// --------------------------------------------------------
// Questions that teach the memory (fork, 2026-10-19)
// GET  /api/v1/ai/questions/open          -> { data: question | null }
// POST /api/v1/ai/questions/:id/answer    { option: number } -> { data: { question, memory } }
// POST /api/v1/ai/questions/:id/dismiss
// POST /api/v1/ai/questions/ask-now       admin: ask a new question now (and learn), instead of waiting for Sunday
// --------------------------------------------------------
router.get('/questions/open', (_req, res) => {
  try {
    res.json({ data: aiSettings().enabled ? openQuestion() : null });
  } catch (err) {
    sendAiError(res, err, 'GET /questions/open');
  }
});

router.post('/questions/:id/answer', (req, res) => {
  try {
    // The kitchen wall answers only when the household lets it write (Tafla).
    if (refuseWallWrite(req, res)) return;
    const id = Number.parseInt(req.params.id, 10);
    const option = Number(req.body?.option);
    if (!Number.isInteger(option) || option < 0) return res.status(400).json({ error: 'Choose an answer.', code: 400 });
    const result = answerQuestion(id, option, req.authUserId);
    if (!result) return res.status(404).json({ error: 'This question is no longer open.', code: 404 });
    if (result.invalid) return res.status(400).json({ error: 'Unknown answer.', code: 400 });
    res.json({ data: result });
  } catch (err) {
    sendAiError(res, err, 'POST /questions/:id/answer');
  }
});

router.post('/questions/:id/dismiss', (req, res) => {
  try {
    if (refuseWallWrite(req, res)) return;
    if (!dismissQuestion(Number.parseInt(req.params.id, 10))) return res.status(404).json({ error: 'This question is no longer open.', code: 404 });
    res.status(204).end();
  } catch (err) {
    sendAiError(res, err, 'POST /questions/:id/dismiss');
  }
});

router.post('/questions/ask-now', requireAdmin, async (_req, res) => {
  try {
    const learned = await learnFromHistory();
    const question = await generateQuestion();
    res.json({ data: { question: question ?? openQuestion(), learned: learned.length } });
  } catch (err) {
    sendAiError(res, err, 'POST /questions/ask-now');
  }
});

export default router;
