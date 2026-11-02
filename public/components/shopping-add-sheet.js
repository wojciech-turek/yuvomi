/**
 * Modul: Einkaufsblatt (Quick-Add, 2026-10-29)
 * Zweck: Die Zakupy-Leiste als kleines Blatt ueber der Uebersicht. Es hat ein
 *        Feld, in dem die Menge mitsteht ("2 mleka"), die Chips von "Często"
 *        und einen Knopf. Angelegt wird auf der Liste, die zuletzt auf Zakupy
 *        offen war (je Geraet gemerkt). Der Listenname steht im Kopf; eine
 *        Auswahl gibt es nur, wenn mehr als eine Liste existiert. Sie steht
 *        unter dem Feld, damit das Feld den Erstfokus bekommt. Nach jedem
 *        Anlegen bleibt der Fokus im Feld, so gehen mehrere Artikel
 *        hintereinander.
 *
 *        Lesen der Zeile, Gangvermutung, Chips und Anfragekoerper kommen aus
 *        utils/shopping-entry.js, dieselben wie auf Zakupy. Die Stile liegen in
 *        layout.css, weil shopping.css ausserhalb von /shopping nicht gilt.
 *
 *        IM GEMEINSAMEN AUFBAU (One Today, Task 12): gehoerter Satz (nur aus
 *        einer Stimme), Titelfeld mit Mikrofon (`sheet-parts`), gesprochene
 *        Posten als entfernbare Chips, "Często", die Listenwahl unter "Więcej"
 *        und ein "Dodaj". Enter legt den getippten Artikel sofort an und laesst
 *        das Feld bereit (wie bisher), ein Tipp auf "Często" ebenso; "Dodaj"
 *        legt den getippten Text und jeden gesprochenen Chip an und schliesst.
 *        Mit gesprochenen Chips ist das Blatt ein geaendertes (R11,
 *        `data-dirty-base`, `dirtyGuard: true`); ohne sie bleibt es wie vorher.
 *
 *        DAS BLATT KENNT DEN BESTAND SEINER LISTE (F2). Es laedt ihre Zeilen
 *        beim Oeffnen und bei jedem Listenwechsel und tut dann, was Zakupy tut:
 *        "Często" zeigt nichts, was offen auf der Liste steht, und ein Name,
 *        der dort abgehakt steht, kommt zurueck (PATCH, #1816) statt ein
 *        zweites Mal angelegt zu werden. Der Server entdoppelt nicht. Ein Name,
 *        der OFFEN dasteht, wird wie auf Zakupy noch einmal angelegt.
 */
import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { openModal, closeModal, askOverModal, advancedSection, captureModalContext } from '/components/modal.js';
import { openDictationSheet } from '/components/task-dictation.js';
import { quickDraftFromSentence } from '/utils/quick-draft.js';
import { titleFieldHtml, heardLineHtml } from '/utils/sheet-parts.js';
import { mayWritePath } from '/utils/module-access.js';
import { errorSentence } from '/utils/friendly-error.js';
import { parseQuickEntry, guessAisle, pickShoppingList, frequentChipsHtml, quickItemBody, visibleFrequent, tickedItemNamed, splitSpokenItems } from '/utils/shopping-entry.js';

const FREQUENT_CHIPS = 8;
const GUESS_DELAY_MS = 450;
const GUESS_MIN_CHARS = 3;

/** Die gesprochenen Posten als entfernbare Chips; `id` ist stabil, solange das Blatt offen ist. */
function spokenChipsHtml(spoken) {
  return spoken.map((item) => `
    <span class="shopping-sheet__item" role="listitem" data-item="${item.id}">
      <span class="shopping-sheet__item-name">${esc(item.name)}</span>${item.quantity ? `
      <span class="shopping-sheet__item-qty">${esc(item.quantity)}</span>` : ''}
      <button type="button" class="shopping-sheet__item-remove" data-remove-item="${item.id}"
              aria-label="${esc(t('shopping.removeSpokenItem', { name: item.name }))}"><span aria-hidden="true">\u00d7</span></button>
    </span>`).join('');
}

function sheetHtml(lists, list, frequent, { spoken = [], heard = '', typed = '' } = {}) {
  const switcher = lists.length > 1 ? advancedSection(`
    <select class="form-input shopping-sheet__list" id="shopping-sheet-list" aria-label="${esc(t('shopping.chooseListLabel', { name: list.name }))}">
      ${lists.map((l) => `<option value="${esc(String(l.id))}" ${l.id === list.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
    </select>`, { label: t('tasks.more') }) : '';
  return `
    <div class="shopping-sheet">
      ${spoken.length ? `<!-- Ein Entwurf aus einer Stimme gilt als geaendert (R11): Wischen oder x
           fragt "Verwerfen?" (data-dirty-base, components/modal.js). -->
      <input type="hidden" id="shopping-sheet-from-draft" value="1" data-dirty-base="">` : ''}
      ${heardLineHtml(heard)}
      <form class="shopping-sheet__form" id="shopping-sheet-form" novalidate autocomplete="off">
        ${titleFieldHtml({
    id: 'shopping-sheet-input',
    name: 'item',
    value: typed,
    placeholder: t('shopping.itemNamePlaceholder'),
    labelKey: 'shopping.itemNameLabel',
    mic: { labelKey: 'tasks.sayIt' },
    inputAttrs: 'enterkeyhint="done"',
  })}
      </form>
      <div class="shopping-sheet__spoken" id="shopping-sheet-spoken" role="list" ${spoken.length ? '' : 'hidden'}>${spokenChipsHtml(spoken)}</div>
      <div class="shopping-sheet__frequent" id="shopping-sheet-frequent" role="group"
           aria-label="${esc(t('shopping.frequentLabel'))}" ${frequent.length ? '' : 'hidden'}>${frequentChipsHtml(frequent, 'shopping-sheet__chip')}</div>
      ${switcher}
    </div>
    <div class="modal-panel__footer modal-panel__footer--plain">
      <button type="button" class="btn btn--primary task-sheet__submit">${esc(t('common.add'))}</button>
    </div>`;
}

/**
 * Der Entwurf aus dem Satz fuer das Mikrofon dieses Blatts: Posten (`kind:
 * 'shopping'`, ein Haiku-Aufruf). Kam eine andere Art zurueck, zaehlt der Satz
 * als Liste von Posten, wie die lokale Regel ihn teilt.
 */
async function shoppingDraftFromSentence(sentence, { members = [], post } = {}) {
  const { kind, draft, source } = await quickDraftFromSentence(sentence, { members, post, kind: 'shopping' });
  return { source, draft: kind === 'shopping' ? draft : { items: splitSpokenItems(sentence) } };
}

/**
 * Das Blatt "Artikel hinzufuegen" von ausserhalb der Seite oeffnen.
 *
 * Die Uebersicht MUSS `user` mitgeben: die gemerkte Liste haengt an seiner id.
 *
 * @param {{user: object, onChanged?: () => (void|Promise<void>),
 *          draft?: {items: Array<{name: string, quantity?: string|null}>}|null, heard?: string,
 *          typed?: string, listId?: number|string|null}} [opts]
 *        `draft`/`heard`: gesprochene Posten und der gehoerte Satz (Say it, Mikrofon).
 *        `typed`/`listId` nimmt nur das Blatt selbst mit, wenn das Mikrofon es
 *        durch ein neues ersetzt: der getippte Text und die gewaehlte Liste bleiben.
 * @returns {Promise<boolean>} false bei nur lesendem Zugriff oder ohne Liste
 */
export async function openShoppingAddFrom({
  user, onChanged = () => {}, draft = null, heard = '', typed = '', listId = null,
} = {}) {
  if (!mayWritePath('/shopping')) return false;
  let lists = [];
  let frequent = [];
  try {
    const [listsRes, frequentRes] = await Promise.all([
      api.get('/shopping'),
      api.get('/shopping/frequent').catch(() => ({ data: [] })),
    ]);
    lists = listsRes?.data ?? [];
    frequent = frequentRes?.data ?? [];
  } catch (err) {
    window.yuvomi?.showToast(errorSentence(err), 'danger');
    return false;
  }
  if (user?.id == null) console.warn('openShoppingAddFrom: `user` fehlt, die gemerkte Liste geht verloren');
  const first = lists.find((l) => String(l.id) === String(listId)) ?? pickShoppingList(lists, user?.id);
  if (!first) {
    window.yuvomi?.showToast(t('shopping.noLists'), 'info');
    return false;
  }
  // Die Zeilen je Liste, einmal geladen und danach hier fortgeschrieben (was
  // das Blatt anlegt oder zurueckholt). Laesst sich eine Liste nicht lesen,
  // gilt sie als leer: dann wird angelegt, wie vor dem Bestand.
  const itemsByList = new Map();
  const itemsOf = (listId) => {
    if (!itemsByList.has(listId)) {
      itemsByList.set(listId, api.get(`/shopping/${listId}/items`)
        .then((res) => (Array.isArray(res?.data) ? res.data : []))
        .catch(() => []));
    }
    return itemsByList.get(listId);
  };
  // Vor dem Oeffnen: die ersten Chips sollen schon ohne das Offene dastehen.
  const firstItems = await itemsOf(first.id);
  let list = first;
  let added = 0;
  let chips = visibleFrequent(frequent, firstItems, { limit: FREQUENT_CHIPS });
  // Die gesprochenen Posten, die noch zu speichern sind.
  let nextSpokenId = 0;
  let spoken = (Array.isArray(draft?.items) ? draft.items : [])
    .map((item) => ({ name: String(item?.name ?? '').trim(), quantity: item?.quantity ? String(item.quantity) : null }))
    .filter((item) => item.name)
    .map((item) => ({ ...item, id: nextSpokenId++ }));
  const fromVoice = spoken.length > 0;
  let sayAgain = () => {};

  openModal({
    title: t('shopping.addToList', { list: list.name }),
    size: 'sm',
    // Ein Entwurf aus der Stimme gilt als geaendert (R11); von Hand: wie bisher.
    dirtyGuard: fromVoice,
    headerAction: fromVoice ? { id: 'shopping-say-again', label: t('tasks.sayAgain'), onClick: () => sayAgain() } : null,
    content: sheetHtml(lists, list, chips, { spoken, heard: fromVoice ? heard : '', typed }),
    onClose: () => { if (added) onChanged(); },
    onSave: (panel) => {
      const input = panel.querySelector('#shopping-sheet-input');
      const form = panel.querySelector('#shopping-sheet-form');
      const chipRow = panel.querySelector('#shopping-sheet-frequent');
      const spokenRow = panel.querySelector('#shopping-sheet-spoken');
      if (!input || !form) return;

      /** Die Chips der gesprochenen Posten neu; ohne Rest ist nichts mehr zu verlieren (kein geaendertes Blatt). */
      const renderSpoken = () => {
        if (spokenRow) {
          spokenRow.replaceChildren?.();
          spokenRow.insertAdjacentHTML?.('beforeend', spokenChipsHtml(spoken));
          spokenRow.hidden = !spoken.length;
        }
        if (!spoken.length) panel.querySelector('#shopping-sheet-from-draft')?.removeAttribute('data-dirty-base');
      };

      // Der Gang wird beim Tippen geraten (wie auf Zakupy); ohne Antwort sortiert der Server selbst.
      let guess = { name: '', category: null };
      let timer = null;
      input.addEventListener('input', () => {
        clearTimeout(timer);
        const name = parseQuickEntry(input.value).name;
        if (guess.name !== name) guess = { name: '', category: null };
        if (name.length < GUESS_MIN_CHARS) return;
        timer = setTimeout(async () => {
          const category = await guessAisle(name);
          if (parseQuickEntry(input.value).name === name) guess = { name, category };
        }, GUESS_DELAY_MS);
      });

      /** Die Chips neu, nach dem Bestand der offenen Liste. */
      const renderChips = (items) => {
        chips = visibleFrequent(frequent, items, { limit: FREQUENT_CHIPS });
        if (!chipRow) return;
        chipRow.replaceChildren?.();
        chipRow.insertAdjacentHTML?.('beforeend', frequentChipsHtml(chips, 'shopping-sheet__chip'));
        chipRow.hidden = !chips.length;
      };

      /**
       * Legt an oder holt zurueck - wie `addQuickItem` auf Zakupy. Eine
       * getippte Menge ersetzt die der abgehakten Zeile, ein Name ohne Menge
       * laesst sie stehen; die Kategorie bleibt die der Zeile (gewaehlt hat
       * hier niemand eine). Liefert den Satz fuer den Toast.
       */
      const add = async ({ name, quantity = null, category = null, source = 'default' }) => {
        const target = list;
        const items = await itemsOf(target.id);
        const ticked = tickedItemNamed(items, name);
        let toast;
        if (ticked) {
          const changes = quantity && quantity !== (ticked.quantity ?? null) ? { quantity } : {};
          await api.patch(`/shopping/items/${ticked.id}`, { ...changes, is_checked: 0 });
          Object.assign(ticked, changes, { is_checked: 0 });
          toast = [t('shopping.itemBackToast', { name: ticked.name }), 'info'];
        } else {
          const res = await api.post(`/shopping/${target.id}/items`, quickItemBody({ name, quantity, category, source }));
          items.push(res?.data && typeof res.data === 'object' ? res.data : { name, quantity, is_checked: 0 });
          toast = [`${name} · ${t('shopping.itemAdded')}`, 'success'];
        }
        added += 1;
        if (target === list) renderChips(items);
        return toast;
      };

      let busy = false;
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (busy) return;
        const { name, quantity } = parseQuickEntry(input.value);
        if (!name) { input.focus(); return; }
        busy = true;
        clearTimeout(timer);
        const category = guess.name === name ? guess.category : null;
        try {
          const toast = await add({ name, quantity, category, source: 'suggestion' });
          input.value = '';
          guess = { name: '', category: null };
          window.yuvomi?.showToast(...toast);
        } catch (err) {
          window.yuvomi?.showToast(errorSentence(err), 'danger');
        } finally {
          busy = false;
          input.focus();
        }
      });

      chipRow?.addEventListener('click', async (e) => {
        const chip = e.target?.closest?.('[data-action="add-frequent"]');
        const item = chip && chips.find((i) => i.name === chip.dataset.name);
        if (!item || chip.disabled) return;
        chip.disabled = true;
        try {
          const toast = await add({ name: item.name, quantity: item.quantity ?? null, category: item.category, source: 'suggestion' });
          // Angelegt nimmt das Neuzeichnen den Chip mit; zurueckgeholt sagt es
          // ein Satz (die Zeile steht irgendwo auf der Liste).
          if (toast[1] === 'info') window.yuvomi?.showToast(...toast);
        } catch (err) {
          chip.disabled = false;
          window.yuvomi?.showToast(errorSentence(err), 'danger');
        }
        input.focus();
      });

      spokenRow?.addEventListener('click', (e) => {
        const button = e.target?.closest?.('[data-remove-item]');
        if (!button) return;
        spoken = spoken.filter((item) => String(item.id) !== String(button.dataset.removeItem));
        renderSpoken();
        input.focus();
      });

      // "Dodaj": jeder gesprochene Chip, dann der getippte Text; bei einem Fehler
      // bleibt das Blatt offen und nur der Rest als Chip stehen.
      panel.querySelector('.task-sheet__submit')?.addEventListener('click', async (e) => {
        e.preventDefault?.();
        if (busy) return;
        busy = true;
        clearTimeout(timer);
        // Der Kontext VOR den Anfragen: ein spaetes Schliessen trifft nur dieses Blatt (#1997).
        const context = captureModalContext();
        let saved = 0;
        let failed = false;
        let last = null;
        try {
          for (const item of [...spoken]) {
            last = await add({ name: item.name, quantity: item.quantity, source: 'suggestion' });
            spoken = spoken.filter((i) => i.id !== item.id);
            saved += 1;
            renderSpoken();
          }
          const { name, quantity } = parseQuickEntry(input.value);
          if (name) {
            const category = guess.name === name ? guess.category : null;
            last = await add({ name, quantity, category, source: 'suggestion' });
            input.value = '';
            saved += 1;
          }
        } catch (err) {
          failed = true;
          window.yuvomi?.showToast(errorSentence(err), 'danger');
        } finally {
          busy = false;
        }
        if (failed || !saved) { input.focus(); return; }
        if (saved === 1 && last) window.yuvomi?.showToast(...last);
        closeModal({ force: true, context });
      });

      // Das Mikrofon im Titelfeld: das Hoerblatt geht synchron im Tipp auf (Safari
      // startet die Erkennung nur aus der Geste). Es BEHAELT, was schon da ist;
      // "Powtórz" ersetzt die gesprochenen Chips.
      const dictate = async (replace) => {
        const answer = await askOverModal(() => new Promise((resolve) => {
          openDictationSheet({
            initialText: input.value,
            members: [],
            toDraft: shoppingDraftFromSentence,
            onDraft: (spokenDraft, { text = '' } = {}) => { resolve({ draft: spokenDraft, heard: text }); closeModal({ force: true }); },
            onTypeInstead: (text) => { resolve({ type: true, text }); closeModal({ force: true }); },
            onCancel: () => resolve(null),
          });
        }));
        if (answer?.draft) {
          const heardItems = Array.isArray(answer.draft.items) ? answer.draft.items : [];
          const items = replace ? heardItems : [...spoken.map(({ name, quantity }) => ({ name, quantity })), ...heardItems];
          openShoppingAddFrom({
            user, onChanged, draft: { items }, heard: answer.heard,
            typed: input.value, listId: list.id,
          });
        } else if (answer?.type) {
          if (answer.text && answer.text !== input.value.trim()) input.value = answer.text;
          input.focus();
        }
      };
      sayAgain = () => dictate(true);
      panel.querySelector('.task-sheet__mic')?.addEventListener('click', (e) => {
        e.preventDefault?.();
        dictate(false);
      });

      panel.querySelector('#shopping-sheet-list')?.addEventListener('change', async (e) => {
        list = lists.find((l) => String(l.id) === e.target.value) ?? list;
        // Der Kopf gehoert zum Dialog dieses Blatts: von hier aus nach oben suchen.
        const title = panel.closest?.('.modal-overlay')?.querySelector('.modal-panel__title');
        if (title) title.textContent = t('shopping.addToList', { list: list.name });
        input.focus();
        // Die Chips folgen der neuen Liste, sobald ihr Bestand da ist.
        const target = list;
        const items = await itemsOf(target.id);
        if (target === list) renderChips(items);
      });
    },
  });
  return true;
}
