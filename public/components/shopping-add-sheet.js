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
import { openModal } from '/components/modal.js';
import { mayWritePath } from '/utils/module-access.js';
import { errorSentence } from '/utils/friendly-error.js';
import { parseQuickEntry, guessAisle, pickShoppingList, frequentChipsHtml, quickItemBody, visibleFrequent, tickedItemNamed } from '/utils/shopping-entry.js';

const FREQUENT_CHIPS = 8;
const GUESS_DELAY_MS = 450;
const GUESS_MIN_CHARS = 3;

function sheetHtml(lists, list, frequent) {
  const switcher = lists.length > 1 ? `
    <select class="form-input shopping-sheet__list" id="shopping-sheet-list" aria-label="${esc(t('shopping.chooseListLabel', { name: list.name }))}">
      ${lists.map((l) => `<option value="${esc(String(l.id))}" ${l.id === list.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
    </select>` : '';
  return `
    <div class="shopping-sheet">
      <div class="shopping-sheet__frequent" id="shopping-sheet-frequent" role="group"
           aria-label="${esc(t('shopping.frequentLabel'))}" ${frequent.length ? '' : 'hidden'}>${frequentChipsHtml(frequent, 'shopping-sheet__chip')}</div>
      <form class="shopping-sheet__form" id="shopping-sheet-form" novalidate autocomplete="off">
        <input class="form-input shopping-sheet__input" type="text" id="shopping-sheet-input" enterkeyhint="done"
               placeholder="${esc(t('shopping.itemNamePlaceholder'))}" aria-label="${esc(t('shopping.itemNameLabel'))}"
               autocomplete="off">
        <button type="submit" class="btn btn--primary shopping-sheet__add">${esc(t('shopping.addItemLabel'))}</button>
      </form>
      ${switcher}
    </div>`;
}

/**
 * Das Blatt "Artikel hinzufuegen" von ausserhalb der Seite oeffnen.
 *
 * Die Uebersicht MUSS `user` mitgeben: die gemerkte Liste haengt an seiner id.
 *
 * @param {{user: object, onChanged?: () => (void|Promise<void>)}} [opts]
 * @returns {Promise<boolean>} false bei nur lesendem Zugriff oder ohne Liste
 */
export async function openShoppingAddFrom({ user, onChanged = () => {} } = {}) {
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
  const first = pickShoppingList(lists, user?.id);
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

  openModal({
    title: list.name,
    size: 'sm',
    dirtyGuard: false,
    content: sheetHtml(lists, list, chips),
    onClose: () => { if (added) onChanged(); },
    onSave: (panel) => {
      const input = panel.querySelector('#shopping-sheet-input');
      const form = panel.querySelector('#shopping-sheet-form');
      const chipRow = panel.querySelector('#shopping-sheet-frequent');
      if (!input || !form) return;

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

      panel.querySelector('#shopping-sheet-list')?.addEventListener('change', async (e) => {
        list = lists.find((l) => String(l.id) === e.target.value) ?? list;
        // Der Kopf gehoert zum Dialog dieses Blatts: von hier aus nach oben suchen.
        const title = panel.closest?.('.modal-overlay')?.querySelector('.modal-panel__title');
        if (title) title.textContent = list.name;
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
