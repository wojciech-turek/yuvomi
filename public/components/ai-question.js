/**
 * Modul: AI question card (fork, 2026-10-19)
 * Zweck: The question Yuvomi asks now and then to learn the household ("Czy
 *        jecie wieprzowinę?"), as one quiet card above the dashboard. One tap
 *        answers and the answer becomes a memory sentence; "Skip" dismisses it.
 *        Never on the wall tablet: a display account cannot answer for anyone.
 */

import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

/**
 * @param {HTMLElement|null} host - the dashboard page element
 * @param {{api: object, before: Element|null, wall: boolean}} opts
 */
export async function mountAiQuestion(host, { api, before, wall }) {
  if (!host || wall) return;
  let question = null;
  try {
    question = (await api.get('/ai/questions/open')).data;
  } catch {
    return;
  }
  if (!question || !host.isConnected) return;

  const card = document.createElement('section');
  card.className = 'ai-question';
  card.setAttribute('aria-label', t('ai.questionLabel'));
  card.insertAdjacentHTML('beforeend', `
    <p class="ai-question__eyebrow"><i data-lucide="sparkles" class="icon-sm" aria-hidden="true"></i>${esc(t('ai.questionLabel'))}</p>
    <p class="ai-question__text">${esc(question.question)}</p>
    <div class="ai-question__options">
      ${question.options.map((label, i) => `<button type="button" class="btn btn--secondary" data-option="${i}">${esc(label)}</button>`).join('')}
      <button type="button" class="btn btn--ghost" data-skip>${esc(t('ai.questionSkip'))}</button>
    </div>`);
  host.insertBefore(card, before && before.parentNode === host ? before : host.firstChild);
  window.lucide?.createIcons({ el: card });

  const settle = (sentence) => {
    card.replaceChildren();
    card.insertAdjacentHTML('beforeend', `<p class="ai-question__done">${esc(sentence)}</p>`);
    setTimeout(() => card.remove(), 4000);
  };

  card.addEventListener('click', async (e) => {
    const option = e.target.closest('[data-option]');
    const skip = e.target.closest('[data-skip]');
    if (!option && !skip) return;
    card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      if (skip) {
        await api.post(`/ai/questions/${question.id}/dismiss`, {});
        card.remove();
        return;
      }
      const res = await api.post(`/ai/questions/${question.id}/answer`, { option: Number(option.dataset.option) });
      const remembered = res.data?.memory?.text;
      settle(remembered ? t('ai.questionRemembered', { text: remembered }) : t('ai.questionThanks'));
    } catch {
      card.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      window.yuvomi?.showToast(t('common.errorGeneric'), 'danger');
    }
  });
}
