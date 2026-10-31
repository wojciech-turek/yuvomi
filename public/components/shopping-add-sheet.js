/**
 * Modul: Einkaufsblatt (Quick-Add, 2026-10-29)
 * Zweck: Die Zakupy-Leiste als kleines Blatt ueber der Uebersicht: EIN Feld
 *        ("2 mleka" - die Menge steht in der Zeile), "Często" darueber, ein
 *        Knopf (die Auswahl der Liste steht darunter, damit das Feld den Erstfokus bekommt). Es legt auf der Liste an, die zuletzt auf Zakupy offen war
 *        (je Geraet); der Listenname steht im Kopf, eine Auswahl gibt es nur
 *        bei mehr als einer Liste. Nach jedem Anlegen bleibt der Fokus im Feld,
 *        damit mehrere Artikel hintereinander gehen.
 *
 *        Die Stile liegen in layout.css (immer geladen): shopping.css gilt
 *        ausserhalb von /shopping nicht.
 */
import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { openModal } from '/components/modal.js';
import { mayWritePath } from '/utils/module-access.js';
import { DEFAULT_CATEGORY_NAME } from '/utils/shopping-categories.js';
import { errorSentence } from '/utils/friendly-error.js';
import { parseQuickEntry, guessAisle, pickShoppingList } from '/utils/shopping-entry.js';

const FREQUENT_CHIPS = 8;
const GUESS_DELAY_MS = 450;
const GUESS_MIN_CHARS = 3;

function chipsHtml(items) {
  return items.map((i) => `
    <button type="button" class="shopping-sheet__chip" data-action="add-frequent" data-name="${esc(i.name)}"
            aria-label="${esc(t('shopping.predictionAddLabel', { name: i.name }))}">${esc(i.name)}</button>`).join('');
}

function sheetHtml(lists, list, frequent) {
  const switcher = lists.length > 1 ? `
    <select class="form-input shopping-sheet__list" id="shopping-sheet-list" aria-label="${esc(t('shopping.chooseListLabel', { name: list.name }))}">
      ${lists.map((l) => `<option value="${esc(String(l.id))}" ${l.id === list.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
    </select>` : '';
  return `
    <div class="shopping-sheet">
      <div class="shopping-sheet__frequent" id="shopping-sheet-frequent" role="group"
           aria-label="${esc(t('shopping.frequentLabel'))}" ${frequent.length ? '' : 'hidden'}>${chipsHtml(frequent)}</div>
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
 * @param {{user?: object|null, onChanged?: () => (void|Promise<void>)}} [opts]
 * @returns {Promise<boolean>} false bei nur lesendem Zugriff oder ohne Liste
 */
export async function openShoppingAddFrom({ user = null, onChanged = () => {} } = {}) {
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
  const first = pickShoppingList(lists, user?.id);
  if (!first) {
    window.yuvomi?.showToast(t('shopping.noLists'), 'info');
    return false;
  }
  let list = first;
  let added = 0;
  let chips = frequent.slice(0, FREQUENT_CHIPS);

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

      const post = async ({ name, quantity = null, category = null, source = 'default' }) => {
        await api.post(`/shopping/${list.id}/items`, {
          name,
          quantity,
          category: category ?? DEFAULT_CATEGORY_NAME,
          category_source: category ? source : 'default',
          position: 'top',
        });
        added += 1;
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
          await post({ name, quantity, category, source: 'suggestion' });
          input.value = '';
          guess = { name: '', category: null };
          window.yuvomi?.showToast(`${name} · ${t('shopping.itemAdded')}`, 'success');
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
          await post({ name: item.name, quantity: item.quantity ?? null, category: item.category, source: 'suggestion' });
          chips = chips.filter((i) => i !== item);
          chip.remove();
          if (!chips.length) chipRow.hidden = true;
        } catch (err) {
          chip.disabled = false;
          window.yuvomi?.showToast(errorSentence(err), 'danger');
        }
        input.focus();
      });

      panel.querySelector('#shopping-sheet-list')?.addEventListener('change', (e) => {
        list = lists.find((l) => String(l.id) === e.target.value) ?? list;
        const title = document.getElementById('shared-modal-title');
        if (title) title.textContent = list.name;
        input.focus();
      });
    },
  });
  return true;
}
