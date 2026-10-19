/**
 * Modul: Einstellungen - AI (fork, 2026-10-19)
 * Zweck: The household's AI switch, API keys (never shown, only "set"), the
 *        model for bigger jobs, the monthly limit, one switch per feature, this
 *        month's usage, and the household memory ("what Yuvomi knows about you").
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { rowMenuHtml } from '/utils/row-action.js';
import { installPopoverMenus } from '/utils/popover-menu.js';
import { createInlineError, createRetryState, settingRowHtml, settingSwitchRowHtml, bindInstantSwitch } from '/settings/components.js';

const FEATURES = ['shopping_smart', 'meal_ingredients', 'pantry_photo', 'meal_ideas', 'nudges', 'questions'];
const TOPICS = ['household', 'meals', 'shopping'];

function toast(message, tone = 'default') {
  window.yuvomi?.showToast(message, tone);
}

function money(usd) {
  return `$${Number(usd || 0).toFixed(2)}`;
}

function featureLabel(f) {
  return {
    shopping_smart: t('ai.featureShopping'),
    meal_ingredients: t('ai.featureMealIngredients'),
    pantry_photo: t('ai.featurePantryPhoto'),
    meal_ideas: t('ai.featureMealIdeas'),
    nudges: t('ai.featureNudges'),
    questions: t('ai.featureQuestions'),
    'admin-test': t('ai.test'),
  }[f] ?? f;
}

function topicLabel(topic) {
  return { household: t('ai.topicHousehold'), meals: t('ai.topicMeals'), shopping: t('ai.topicShopping') }[topic] ?? topic;
}

function usageHtml(usage) {
  if (!usage?.byFeature?.length) return `<p class="form-hint">${esc(t('ai.usageNone'))}</p>`;
  return `
    <p>${esc(t('ai.usageLine', { used: money(usage.monthUsd), cap: money(usage.capUsd) }))}</p>
    <ul class="ai-usage-list">${usage.byFeature.map((r) => `<li><span>${esc(featureLabel(r.feature))}</span><span>${esc(money(r.usd))}</span></li>`).join('')}</ul>`;
}

function memoryListHtml(memories) {
  if (!memories.length) return `<p class="form-hint">${esc(t('ai.memoryEmpty'))}</p>`;
  return `<ul class="ai-memory-list">${memories.map((m) => `
    <li class="ai-memory-item" data-id="${m.id}">
      <span class="ai-memory-item__topic">${esc(topicLabel(m.topic))}</span>
      <span class="ai-memory-item__text">${esc(m.text)}</span>
      <div class="row-actions">
        ${rowMenuHtml({
          id: `ai-memory-menu-${m.id}`,
          label: t('common.moreActionsNamed', { name: m.text }),
          items: [{ action: 'delete-memory', icon: 'trash-2', label: t('common.delete'), danger: true, attrs: { 'data-delete-memory': m.id } }],
        })}
      </div>
    </li>`).join('')}</ul>`;
}

function renderPage(container, cfg, memories) {
  const env = cfg.envControlled || {};
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <div class="row-divided settings-group">
        ${settingSwitchRowHtml({
          label: t('ai.enabledLabel'),
          checked: cfg.enabled === true,
          icon: 'sparkles',
          description: t('ai.enabledHint'),
          descriptionId: 'ai-enabled-hint',
          attrs: { id: 'ai-enabled', 'data-instant-save': '' },
        })}
      </div>
    </section>

    <section class="settings-section">
      <form class="settings-form" id="ai-form" novalidate autocomplete="off">
        <div class="row-carrier settings-group">
          ${settingRowHtml({
            label: t('ai.anthropicKey'), labelFor: 'ai-anthropic-key',
            description: t('ai.anthropicKeyHint'), descriptionId: 'ai-anthropic-key-hint',
            control: `<input class="form-input" id="ai-anthropic-key" name="anthropicKey" type="password"
              autocomplete="new-password" aria-describedby="ai-anthropic-key-hint" placeholder="${cfg.anthropicKeySet ? '••••••••' : ''}" />`,
            extra: `<p class="form-hint" data-env="anthropicKey" hidden>${esc(t('settings.documentStorageEnvHint'))}</p>`,
          })}
          ${settingRowHtml({
            label: t('ai.jevKey'), labelFor: 'ai-jev-key',
            description: t('ai.jevKeyHint'), descriptionId: 'ai-jev-key-hint',
            control: `<input class="form-input" id="ai-jev-key" name="jevKey" type="password"
              autocomplete="new-password" aria-describedby="ai-jev-key-hint" placeholder="${cfg.jevKeySet ? '••••••••' : ''}" />`,
            extra: `<p class="form-hint" data-env="jevKey" hidden>${esc(t('settings.documentStorageEnvHint'))}</p>`,
          })}
          ${settingRowHtml({
            label: t('ai.smartModel'), labelFor: 'ai-smart-model',
            description: t('ai.smartModelHint'), descriptionId: 'ai-smart-model-hint',
            control: `<select class="form-input" id="ai-smart-model" name="smartModel" aria-describedby="ai-smart-model-hint">
              <option value="claude-sonnet-5-5"${cfg.smartModel === 'claude-sonnet-5-5' ? ' selected' : ''}>${esc(t('ai.modelSonnet'))}</option>
              <option value="claude-haiku-5-5"${cfg.smartModel === 'claude-haiku-5-5' ? ' selected' : ''}>${esc(t('ai.modelHaiku'))}</option>
            </select>`,
          })}
          ${settingRowHtml({
            label: t('ai.cap'), labelFor: 'ai-cap',
            description: t('ai.capHint'), descriptionId: 'ai-cap-hint',
            control: `<input class="form-input" id="ai-cap" name="capUsd" type="number" min="0" max="200" step="1"
              inputmode="decimal" aria-describedby="ai-cap-hint" value="${esc(String(cfg.capUsd ?? 5))}" />`,
          })}
        </div>
        <div id="ai-error"></div>
        <div class="settings-form-actions">
          <button class="btn btn--secondary" id="ai-test" type="button">${esc(t('ai.test'))}</button>
          <button class="btn btn--primary" type="submit">${esc(t('common.save'))}</button>
        </div>
      </form>
    </section>

    <section class="settings-section">
      <h3 class="settings-section__title">${esc(t('ai.featuresTitle'))}</h3>
      <div class="row-divided settings-group">
        ${FEATURES.map((f) => settingSwitchRowHtml({
          label: featureLabel(f),
          checked: cfg.features?.[f] !== false,
          attrs: { id: `ai-feature-${f}`, 'data-feature': f, 'data-instant-save': '' },
        })).join('')}
      </div>
    </section>

    <section class="settings-section">
      <h3 class="settings-section__title">${esc(t('ai.usageTitle'))}</h3>
      <div class="settings-group ai-usage" id="ai-usage">${usageHtml(cfg.usage)}</div>
    </section>

    <section class="settings-section">
      <h3 class="settings-section__title">${esc(t('ai.memoryTitle'))}</h3>
      <p class="form-hint">${esc(t('ai.memoryHint'))}</p>
      <div id="ai-memory">${memoryListHtml(memories)}</div>
      <form class="ai-memory-add" id="ai-memory-form" novalidate autocomplete="off">
        <label class="sr-only" for="ai-memory-text">${esc(t('ai.memoryAddPlaceholder'))}</label>
        <input class="form-input" id="ai-memory-text" name="text" type="text" maxlength="300" placeholder="${esc(t('ai.memoryAddPlaceholder'))}" />
        <label class="sr-only" for="ai-memory-topic">${esc(t('ai.memoryTopic'))}</label>
        <select class="form-input" id="ai-memory-topic" name="topic">
          ${TOPICS.map((tp) => `<option value="${tp}">${esc(topicLabel(tp))}</option>`).join('')}
        </select>
        <button class="btn btn--secondary" type="submit">${esc(t('ai.memoryAdd'))}</button>
      </form>
      <div class="settings-form-actions">
        <button class="btn btn--ghost" id="ai-ask-now" type="button">${esc(t('ai.askNow'))}</button>
      </div>
    </section>
  `);
  window.lucide?.createIcons({ el: container });
  installPopoverMenus(container);

  const form = container.querySelector('#ai-form');
  const errorHost = container.querySelector('#ai-error');
  for (const field of ['anthropicKey', 'jevKey']) {
    form.elements[field].disabled = env[field] === true;
    container.querySelector(`[data-env="${field}"]`).hidden = env[field] !== true;
  }

  bindInstantSwitch(container.querySelector('#ai-enabled'), {
    save: (checked) => api.put('/ai/config', { enabled: checked }),
    savedMessage: t('ai.saved'),
  });
  for (const input of container.querySelectorAll('[data-feature]')) {
    bindInstantSwitch(input, {
      save: (checked) => api.put('/ai/config', { features: { [input.dataset.feature]: checked } }),
      savedMessage: t('ai.saved'),
    });
  }

  const collect = () => ({
    smartModel: form.smartModel.value,
    capUsd: Number(form.capUsd.value || 0),
    ...(env.anthropicKey || !form.anthropicKey.value.trim() ? {} : { anthropicKey: form.anthropicKey.value.trim() }),
    ...(env.jevKey || !form.jevKey.value.trim() ? {} : { jevKey: form.jevKey.value.trim() }),
  });
  const save = async () => {
    errorHost.replaceChildren();
    const res = await api.put('/ai/config', collect());
    form.anthropicKey.value = '';
    form.jevKey.value = '';
    form.anthropicKey.placeholder = res.data?.anthropicKeySet ? '••••••••' : '';
    form.jevKey.placeholder = res.data?.jevKeySet ? '••••••••' : '';
    container.querySelector('#ai-usage').replaceChildren();
    container.querySelector('#ai-usage').insertAdjacentHTML('beforeend', usageHtml(res.data?.usage));
    return res.data;
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await save();
      toast(t('ai.saved'), 'success');
    } catch (error) {
      errorHost.replaceChildren(createInlineError(error.message || t('common.errorGeneric')));
    } finally {
      button.disabled = false;
    }
  });

  container.querySelector('#ai-test').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    errorHost.replaceChildren();
    try {
      await save();
      const res = await api.post('/ai/test', {});
      const { claude, jev } = res.data ?? {};
      if (!claude && !jev) throw new Error(t('ai.testNothing'));
      const problems = [];
      if (claude && !claude.ok) problems.push(t('ai.testClaudeFail', { reason: claude.error ?? '?' }));
      if (jev && !jev.ok) problems.push(t('ai.testJevFail', { reason: jev.error ?? '?' }));
      if (problems.length) throw new Error(problems.join(' '));
      toast(t('ai.testOk'), 'success');
    } catch (error) {
      errorHost.replaceChildren(createInlineError(error.message || t('common.errorGeneric')));
    } finally {
      button.disabled = false;
    }
  });

  container.querySelector('#ai-ask-now').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const res = await api.post('/ai/questions/ask-now', {});
      await redrawMemory();
      toast(res.data?.question ? t('ai.askNowDone') : t('ai.askNowNone'), res.data?.question ? 'success' : 'default');
    } catch (error) {
      toast(error.message || t('common.errorGeneric'), 'danger');
    } finally {
      button.disabled = false;
    }
  });

  const memoryHost = container.querySelector('#ai-memory');
  const redrawMemory = async () => {
    const res = await api.get('/ai/memories');
    memoryHost.replaceChildren();
    memoryHost.insertAdjacentHTML('beforeend', memoryListHtml(res.data ?? []));
    window.lucide?.createIcons({ el: memoryHost });
    installPopoverMenus(memoryHost);
  };
  container.querySelector('#ai-memory-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const memoryForm = event.currentTarget;
    const text = memoryForm.text.value.trim();
    if (!text) { memoryForm.text.focus(); return; }
    try {
      await api.post('/ai/memories', { text, topic: memoryForm.topic.value });
      memoryForm.text.value = '';
      await redrawMemory();
    } catch (error) {
      toast(error.message || t('common.errorGeneric'), 'danger');
    }
  });
  memoryHost.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-delete-memory]');
    if (!btn) return;
    btn.disabled = true;
    try {
      await api.delete(`/ai/memories/${btn.dataset.deleteMemory}`);
      await redrawMemory();
      toast(t('ai.memoryDeleted'), 'success');
    } catch (error) {
      btn.disabled = false;
      toast(error.message || t('common.errorGeneric'), 'danger');
    }
  });
}

export async function render(container) {
  try {
    const [cfg, memories] = await Promise.all([api.get('/ai/config'), api.get('/ai/memories')]);
    renderPage(container, cfg.data || {}, memories.data || []);
  } catch (error) {
    container.replaceChildren(createRetryState({
      message: error.message || t('common.errorGeneric'),
      onRetry: () => render(container),
    }));
  }
}
