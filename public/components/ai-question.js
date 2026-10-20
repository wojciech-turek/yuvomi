/**
 * Modul: AI question of the week (fork, 2026-10-19; Tafla card 2026-10-19)
 * Zweck: The question Yuvomi asks now and then to learn the household ("Czy
 *        jecie wieprzowinę?"). Dziś draws it as the "Pytanie tygodnia" card
 *        (components/today-view.js) in the place the viewer chose; this module
 *        only talks to the server. One tap answers and the answer becomes a
 *        memory sentence; "Pomiń" dismisses it. Never on the wall tablet: a
 *        display account cannot answer for anyone.
 */

import { t } from '/i18n.js';

/**
 * The open question, or null (none, AI off, or the request failed).
 * @param {{ get: Function }} api
 * @returns {Promise<{id: number, question: string, options: string[]}|null>}
 */
export async function fetchOpenQuestion(api) {
  try {
    const question = (await api.get('/ai/questions/open')).data;
    if (!question || !Array.isArray(question.options)) return null;
    return question;
  } catch {
    return null;
  }
}

/**
 * Answers with option `index`; resolves to the line the card shows afterwards
 * (what Yuvomi now remembers). Rejects when the request fails.
 */
export async function answerQuestion(api, question, index) {
  const res = await api.post(`/ai/questions/${question.id}/answer`, { option: Number(index) });
  const remembered = res.data?.memory?.text;
  return remembered ? t('ai.questionRemembered', { text: remembered }) : t('ai.questionThanks');
}

/** Dismisses the question ("Pomiń"). Rejects when the request fails. */
export async function skipQuestion(api, question) {
  await api.post(`/ai/questions/${question.id}/dismiss`, {});
}
