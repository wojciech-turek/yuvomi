/**
 * Modul: Einstellungen - AI (fork, 2026-10-19; Tafla, 2026-10-20)
 * Zweck: The household's AI switch, this month's usage against the limit (the
 *        one hero number of the page), what the AI sees and never sees, one
 *        switch per feature, the household memory ("Czego się nauczyło"), the
 *        weekly question, the models and the API keys (never shown, only
 *        "zapisany") and the connection test. Artboard: AsystentAI.dc.html.
 *
 * ONLY WHAT IS TRUE. The "Co AI widzi" rows repeat the data rule the server
 * keeps (server/ai/*: product, meal and recipe names, photos someone sends,
 * the memory sentences; never health, money, documents or contacts, and no
 * people). The weekly question runs on Sundays from 10:00 (server/ai/
 * scheduler.js). Quick jobs always run on Haiku 5.5; bigger ones on the model
 * chosen here (Sonnet 5.5 or Haiku 5.5) - never Opus.
 */

import { api } from '/api.js';
import { t, getLocale, getNumberFormat } from '/i18n.js';
import { esc } from '/utils/html.js';
import { rowMenuHtml } from '/utils/row-action.js';
import { installPopoverMenus } from '/utils/popover-menu.js';
import { openModal, closeModal, captureModalContext } from '/components/modal.js';
import {
  createInlineError, createRetryState, bindInstantSwitch, taflaRowHtml, taflaGroupHtml, taflaSwitchHtml,
} from '/settings/components.js';

const FEATURES = ['shopping_smart', 'meal_ingredients', 'pantry_photo', 'meal_ideas', 'nudges', 'questions'];
const TOPICS = ['household', 'meals', 'shopping'];
const FEATURE_GLYPH = {
  shopping_smart: 'shopping-cart',
  meal_ingredients: 'utensils',
  pantry_photo: 'camera',
  meal_ideas: 'lightbulb',
  nudges: 'bell',
  questions: 'message-circle',
};

function toast(message, tone = 'default') {
  window.yuvomi?.showToast(message, tone);
}

/** "0,62 $", "5 $" - dollars in the reader's number format, no cents on a whole amount. */
function money(usd) {
  const value = Number(usd || 0);
  return getNumberFormat({
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    ...(Number.isInteger(value) ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}),
  }).format(value);
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

function splitFeatureLabel(label) {
  const at = label.indexOf(': ');
  if (at > 0) return { title: label.slice(0, at), meta: label.slice(at + 2) };
  return { title: label, wrap: true };
}

function topicLabel(topic) {
  return { household: t('ai.topicHousehold'), meals: t('ai.topicMeals'), shopping: t('ai.topicShopping') }[topic] ?? topic;
}

/** "1 listopada" - the day the limit starts over. */
function renewDate(now = new Date()) {
  const first = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'long' }).format(first);
}

function keyValue(set, env) {
  if (env) return t('ai.keyFromServer');
  return set ? t('ai.keySaved') : t('ai.keyMissing');
}

function memoryListHtml(memories) {
  if (!memories.length) return `<p class="tafla-group__footer">${esc(t('ai.memoryEmpty'))}</p>`;
  return `<ul class="tafla-card ai-memory-list">${memories.map((m) => `
    <li class="ai-memory-item" data-id="${esc(String(m.id))}">
      <span class="ai-memory-item__text">${esc(m.text)}</span>
      <span class="ai-memory-item__topic">${esc(topicLabel(m.topic))}</span>
      <div class="row-actions">
        ${rowMenuHtml({
          id: `ai-memory-menu-${m.id}`,
          label: t('common.moreActionsNamed', { name: m.text }),
          items: [{ action: 'delete-memory', icon: 'trash-2', label: t('common.delete'), danger: true, attrs: { 'data-delete-memory': m.id } }],
        })}
      </div>
    </li>`).join('')}</ul>`;
}

function usageCardHtml(cfg) {
  const usage = cfg.usage ?? {};
  const used = Number(usage.monthUsd) || 0;
  const cap = Number(usage.capUsd ?? cfg.capUsd ?? 0);
  const label = t('ai.usageAria', { used: money(used), cap: money(cap) });
  return `
    <button type="button" class="tafla-card ai-usage" id="ai-cap-edit" aria-haspopup="dialog" aria-label="${esc(label)}">
      <span class="ai-usage__line">
        <span class="ai-usage__hero">${esc(money(used))}</span>
        <span class="ai-usage__of">${esc(t('ai.usageOf', { cap: money(cap) }))}</span>
        <span class="tafla-row__chevron" aria-hidden="true"><i data-lucide="chevron-right"></i></span>
      </span>
      <span class="ai-usage__bar" aria-hidden="true"><span class="ai-usage__fill"></span></span>
      <span class="ai-usage__note">${esc(t('ai.usageRenews', { date: renewDate() }))}</span>
    </button>`;
}

function featureUsageHtml(cfg) {
  const rows = cfg.usage?.byFeature ?? [];
  return taflaGroupHtml({
    id: 'ai-usage-features',
    title: t('ai.usageTitle'),
    rows: rows.map((r) => taflaRowHtml({ title: featureLabel(r.feature), value: money(r.usd), glyph: FEATURE_GLYPH[r.feature] ?? 'sparkles' })),
  });
}

function renderPage(container, cfg, memories) {
  const env = cfg.envControlled || {};
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section ai-page">
      <div class="tafla-card ai-master">
        ${taflaRowHtml({
          title: t('ai.enabledLabel'),
          glyph: 'sparkles',
          titleId: 'ai-enabled-label',
          trail: taflaSwitchHtml({
            label: t('ai.enabledLabel'),
            checked: cfg.enabled === true,
            attrs: { id: 'ai-enabled', 'data-instant-save': '', 'aria-describedby': 'ai-enabled-hint' },
          }),
        })}
        <p class="ai-master__text" id="ai-enabled-hint">${esc(t('ai.masterText'))}</p>
      </div>

      <div id="ai-usage">${usageCardHtml(cfg)}</div>
      <div id="ai-usage-features-host">${featureUsageHtml(cfg)}</div>

      ${taflaGroupHtml({
        id: 'ai-sees',
        title: t('ai.seesTitle'),
        rows: [
          taflaRowHtml({ title: t('ai.seesNames'), glyph: 'check' }),
          taflaRowHtml({ title: t('ai.seesPhotos'), glyph: 'check' }),
          taflaRowHtml({ title: t('ai.seesMemory'), glyph: 'check' }),
          taflaRowHtml({ title: t('ai.seesNever'), meta: t('ai.seesNeverList'), glyph: 'eye-off' }),
        ],
        footer: t('ai.seesFooter'),
      })}

      ${taflaGroupHtml({
        id: 'ai-features',
        title: t('ai.featuresTitle'),
        rows: FEATURES.map((f) => taflaRowHtml({
          // "Zakupy: działy i podpowiedzi" -> the module as the title, the
          // job as the meta line; a label without a colon may wrap.
          ...splitFeatureLabel(featureLabel(f)),
          glyph: FEATURE_GLYPH[f],
          trail: taflaSwitchHtml({
            label: featureLabel(f),
            checked: cfg.features?.[f] !== false,
            attrs: { id: `ai-feature-${f}`, 'data-feature': f, 'data-instant-save': '' },
          }),
        })),
      })}

      <section class="tafla-group" id="ai-memory-group" aria-labelledby="ai-memory-title">
        <h3 class="tafla-group__title" id="ai-memory-title">${esc(t('ai.memoryGroup'))}</h3>
        <div class="tafla-card">
          ${taflaRowHtml({
            title: t('ai.memoryTitle'),
            glyph: 'notebook-text',
            value: t('ai.memoryCount', { count: memories.length }),
            chevron: true,
            button: true,
            attrs: { id: 'ai-memory-toggle', 'aria-expanded': 'false', 'aria-controls': 'ai-memory-panel', 'data-memory-count': '' },
          })}
          ${taflaRowHtml({
            title: t('ai.weeklyQuestion'),
            glyph: 'message-circle',
            value: cfg.features?.questions === false ? t('ai.weeklyQuestionOff') : t('ai.weeklyQuestionWhen'),
          })}
        </div>
        <div class="ai-memory-panel" id="ai-memory-panel" hidden>
          <p class="tafla-group__footer">${esc(t('ai.memoryHint'))}</p>
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
          <button class="tafla-plain" id="ai-ask-now" type="button">${esc(t('ai.askNow'))}</button>
        </div>
      </section>

      <section class="tafla-group" id="ai-models" aria-labelledby="ai-models-title">
        <h3 class="tafla-group__title" id="ai-models-title">${esc(t('ai.modelsTitle'))}</h3>
        <div class="tafla-card">
          ${taflaRowHtml({ title: t('ai.quickJobs'), glyph: 'zap', value: t('ai.modelHaikuName') })}
          ${taflaRowHtml({
            title: t('ai.smartModel'),
            glyph: 'layers',
            titleId: 'ai-smart-model-label',
            trail: `<span class="tafla-select">
              <select class="tafla-select__control" id="ai-smart-model" name="smartModel" aria-labelledby="ai-smart-model-label">
                <option value="claude-sonnet-5-5"${cfg.smartModel === 'claude-sonnet-5-5' ? ' selected' : ''}>${esc(t('ai.modelSonnetName'))}</option>
                <option value="claude-haiku-5-5"${cfg.smartModel === 'claude-haiku-5-5' ? ' selected' : ''}>${esc(t('ai.modelHaikuName'))}</option>
              </select>
              <i data-lucide="chevrons-up-down" aria-hidden="true"></i>
            </span>`,
          })}
          ${taflaRowHtml({
            title: t('ai.anthropicKey'),
            glyph: 'key-round',
            value: keyValue(cfg.anthropicKeySet, env.anthropicKey),
            chevron: !env.anthropicKey,
            button: !env.anthropicKey,
            attrs: env.anthropicKey ? {} : { 'data-key-edit': 'anthropicKey', 'aria-haspopup': 'dialog' },
          })}
          ${taflaRowHtml({
            title: t('ai.jevKey'),
            glyph: 'key-round',
            value: keyValue(cfg.jevKeySet, env.jevKey),
            chevron: !env.jevKey,
            button: !env.jevKey,
            attrs: env.jevKey ? {} : { 'data-key-edit': 'jevKey', 'aria-haspopup': 'dialog' },
          })}
        </div>
        <p class="tafla-group__footer">${esc(t('ai.smartModelHint'))}</p>
        <div id="ai-error"></div>
        <button class="tafla-plain" id="ai-test" type="button">${esc(t('ai.test'))}</button>
      </section>
    </section>
  `);
  paintUsageBar(container, cfg);
  window.lucide?.createIcons({ el: container });
  installPopoverMenus(container);

  const errorHost = container.querySelector('#ai-error');
  let current = cfg;

  const saveConfig = async (patch) => {
    const res = await api.put('/ai/config', patch);
    current = res.data ?? current;
    refreshUsage(container, current);
    return current;
  };

  bindInstantSwitch(container.querySelector('#ai-enabled'), {
    save: (checked) => saveConfig({ enabled: checked }),
    savedMessage: t('ai.saved'),
  });
  for (const input of container.querySelectorAll('[data-feature]')) {
    bindInstantSwitch(input, {
      save: (checked) => saveConfig({ features: { [input.dataset.feature]: checked } }),
      savedMessage: t('ai.saved'),
    });
  }

  const model = container.querySelector('#ai-smart-model');
  model.addEventListener('change', async () => {
    const before = current.smartModel;
    model.disabled = true;
    try {
      await saveConfig({ smartModel: model.value });
      toast(t('ai.saved'), 'success');
    } catch (error) {
      model.value = before;
      toast(error?.message || t('common.errorGeneric'), 'danger');
    } finally {
      model.disabled = false;
    }
  });

  container.querySelector('#ai-cap-edit').addEventListener('click', () => openCapSheet(current, async (capUsd) => {
    await saveConfig({ capUsd });
    toast(t('ai.saved'), 'success');
  }));

  container.addEventListener('click', (event) => {
    const keyRow = event.target.closest('[data-key-edit]');
    if (!keyRow) return;
    const field = keyRow.dataset.keyEdit;
    openKeySheet(field, current, async (patch) => {
      await saveConfig(patch);
      const set = field === 'anthropicKey' ? current.anthropicKeySet : current.jevKeySet;
      keyRow.querySelector('.tafla-row__value').textContent = keyValue(set, false);
      toast(t('ai.saved'), 'success');
    });
  });

  container.querySelector('#ai-test').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    errorHost.replaceChildren();
    try {
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

  const memoryToggle = container.querySelector('#ai-memory-toggle');
  const memoryPanel = container.querySelector('#ai-memory-panel');
  memoryToggle.addEventListener('click', () => {
    const open = memoryToggle.getAttribute('aria-expanded') !== 'true';
    memoryToggle.setAttribute('aria-expanded', String(open));
    memoryPanel.hidden = !open;
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
    const list = res.data ?? [];
    memoryHost.replaceChildren();
    memoryHost.insertAdjacentHTML('beforeend', memoryListHtml(list));
    const count = memoryToggle.querySelector('.tafla-row__value');
    if (count) count.textContent = t('ai.memoryCount', { count: list.length });
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

/** The bar's fill follows the share used; a CSS variable, no inline design value. */
function paintUsageBar(container, cfg) {
  const used = Number(cfg.usage?.monthUsd) || 0;
  const cap = Number(cfg.usage?.capUsd ?? cfg.capUsd) || 0;
  const share = cap > 0 ? Math.min(1, used / cap) : (used > 0 ? 1 : 0);
  container.querySelector('.ai-usage')?.style.setProperty('--ai-usage-share', String(share));
}

function refreshUsage(container, cfg) {
  const host = container.querySelector('#ai-usage');
  if (host) {
    const hadFocus = host.contains(document.activeElement);
    host.replaceChildren();
    host.insertAdjacentHTML('beforeend', usageCardHtml(cfg));
    paintUsageBar(container, cfg);
    window.lucide?.createIcons({ el: host });
    if (hadFocus) host.querySelector('button')?.focus();
  }
  const features = container.querySelector('#ai-usage-features-host');
  if (features) {
    features.replaceChildren();
    features.insertAdjacentHTML('beforeend', featureUsageHtml(cfg));
    window.lucide?.createIcons({ el: features });
  }
}

/** Sheet: the monthly limit in dollars. Foot [Anuluj][Zapisz] like every settings dialog. */
function openCapSheet(cfg, save) {
  openModal({
    title: t('ai.cap'),
    size: 'sm',
    content: `
      <form class="settings-form" id="ai-cap-form" novalidate>
        <label class="form-label" for="ai-cap">${esc(t('ai.cap'))}</label>
        <input class="form-input" id="ai-cap" name="capUsd" type="number" min="0" max="200" step="1"
          inputmode="decimal" aria-describedby="ai-cap-hint" value="${esc(String(cfg.capUsd ?? 5))}" />
        <p class="form-hint" id="ai-cap-hint">${esc(t('ai.capHint'))}</p>
        <div id="ai-cap-error"></div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button type="button" class="btn btn--secondary" id="ai-cap-cancel">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary">${esc(t('common.save'))}</button>
        </div>
      </form>`,
    onSave: (panel) => {
      const form = panel.querySelector('#ai-cap-form');
      panel.querySelector('#ai-cap-cancel')?.addEventListener('click', () => closeModal());
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const dialog = captureModalContext();
        const value = Number(form.capUsd.value);
        const errorHost = form.querySelector('#ai-cap-error');
        errorHost.replaceChildren();
        try {
          await save(Number.isFinite(value) ? value : 0);
          closeModal({ force: true, context: dialog });
        } catch (error) {
          errorHost.replaceChildren(createInlineError(error.message || t('common.errorGeneric')));
        }
      });
    },
  });
}

/** Sheet: replace or remove one API key. The saved key is never shown. */
function openKeySheet(field, cfg, save) {
  const label = field === 'anthropicKey' ? t('ai.anthropicKey') : t('ai.jevKey');
  const hint = field === 'anthropicKey' ? t('ai.anthropicKeyHint') : t('ai.jevKeyHint');
  const set = field === 'anthropicKey' ? cfg.anthropicKeySet : cfg.jevKeySet;
  const clearField = field === 'anthropicKey' ? 'clearAnthropicKey' : 'clearJevKey';
  openModal({
    title: label,
    size: 'sm',
    content: `
      <form class="settings-form" id="ai-key-form" novalidate autocomplete="off">
        <label class="form-label" for="ai-key-input">${esc(label)}</label>
        <input class="form-input" id="ai-key-input" name="key" type="password" autocomplete="new-password"
          aria-describedby="ai-key-hint" placeholder="${set ? '••••••••' : ''}" />
        <p class="form-hint" id="ai-key-hint">${esc(hint)}</p>
        ${set ? `<button class="tafla-plain ai-key-clear" type="button" data-key-clear>${esc(t('ai.keyRemove'))}</button>` : ''}
        <div id="ai-key-error"></div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button type="button" class="btn btn--secondary" id="ai-key-cancel">${esc(t('common.cancel'))}</button>
          <button type="submit" class="btn btn--primary">${esc(t('common.save'))}</button>
        </div>
      </form>`,
    onSave: (panel) => {
      const form = panel.querySelector('#ai-key-form');
      const errorHost = form.querySelector('#ai-key-error');
      panel.querySelector('#ai-key-cancel')?.addEventListener('click', () => closeModal());
      const run = async (patch) => {
        const dialog = captureModalContext();
        errorHost.replaceChildren();
        try {
          await save(patch);
          closeModal({ force: true, context: dialog });
        } catch (error) {
          errorHost.replaceChildren(createInlineError(error.message || t('common.errorGeneric')));
        }
      };
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const value = form.key.value.trim();
        if (!value) { form.key.focus(); return; }
        run({ [field]: value });
      });
      form.querySelector('[data-key-clear]')?.addEventListener('click', () => run({ [clearField]: true }));
    },
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
