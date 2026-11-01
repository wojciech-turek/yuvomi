/**
 * Modul: Das Menue "Hinzufuegen" auf Dziś (Quick-Add, 2026-10-29)
 * Zweck: Das "+" unten rechts auf Dziś oeffnet dieses Blatt (Entwurf PlusMenu):
 *        oben hervorgehoben "Say a task" mit einem Beispielsatz, darunter Task,
 *        Event, Shopping item und Meal. Ein Tipp schliesst das Menue und oeffnet
 *        das passende Blatt ueber Dziś.
 * Abhängigkeiten: /i18n.js, /components/modal.js, /components/task-dictation.js
 *
 * JEDE ZEILE NUR MIT SCHREIBRECHT AUF IHR MODUL. "Say a task" und Task brauchen
 * Aufgaben, Event den Kalender, Shopping item den Einkauf, Meal die Mahlzeiten -
 * was nur gelesen werden darf, endete im Blatt mit einem 403. Die Rechte reicht
 * die Seite herein (`access`, aus moduleAccess wie der Rest von Dziś).
 *
 * "SAY A TASK" STARTET IM TIPP. Safari startet die Spracherkennung nur innerhalb
 * der Nutzergeste, sonst meldet sie `not-allowed`, und es bliebe nur das
 * Textfeld. Deshalb kommt task-dictation.js STATISCH herein, und der Tipp ruft
 * `startTaskDictation` ohne ein `await` (und ohne ein Promise) davor. Die vier
 * anderen Blaetter laden per import(), wie "Dodaj zadanie" in der Karte - sie
 * brauchen keine Geste.
 *
 * ERST ZU, DANN AUF - BEIDES IM TIPP. `closeModal({ force: true })` nimmt das
 * Menue synchron aus der Top-Layer; der Browser gibt den Fokus dabei an das +
 * zurueck, und das naechste Blatt merkt sich das + als Rueckweg statt einer
 * Zeile, die gleich verschwindet.
 */

import { t } from '/i18n.js';
import { openModal, closeModal } from '/components/modal.js';
import { esc } from '/utils/html.js';
import { errorSentence } from '/utils/friendly-error.js';
// STATISCH, nicht per import(): siehe Kopf ("Say a task" startet im Tipp).
import { startTaskDictation } from '/components/task-dictation.js';

/** Die Zeilen in der Reihenfolge des Entwurfs, je mit dem Modul, dessen Schreibrecht sie brauchen. */
const ROWS = Object.freeze([
  { id: 'say', module: 'tasks' },
  { id: 'task', module: 'tasks' },
  { id: 'event', module: 'calendar' },
  { id: 'shopping', module: 'shopping' },
  { id: 'meal', module: 'meals' },
]);

/**
 * Welche Zeilen das Menue zeigt.
 *
 * @param {Record<string, 'write'|'read'|'none'>} [access]  Recht je Modul (tasks, calendar, shopping, meals)
 * @returns {Array<{ id: 'say'|'task'|'event'|'shopping'|'meal' }>}
 */
export function addMenuItems(access = {}) {
  return ROWS.filter((row) => access?.[row.module] === 'write').map(({ id }) => ({ id }));
}

/** Wer welches Blatt oeffnet. `say` ohne Promise davor (siehe Kopf). */
const OPENERS = Object.freeze({
  say: (opts) => startTaskDictation(opts),
  task: async (opts) => (await import('/pages/tasks.js')).openNewTaskFrom(opts),
  event: async (opts) => (await import('/pages/calendar.js')).openNewEventFrom(opts),
  // `user` MUSS mit: das Blatt merkt sich die zuletzt benutzte Liste je Person.
  shopping: async (opts) => (await import('/components/shopping-add-sheet.js')).openShoppingAddFrom(opts),
  meal: async (opts) => (await import('/pages/meals.js')).openNewMealFrom(opts),
});

/** Eine einfache Zeile: Zeichen und Nomen (Entwurf PlusMenu). */
function rowHtml(id, icon, label) {
  return `<li class="add-menu__item"><button type="button" class="add-menu__row" data-add="${id}"><i data-lucide="${icon}" aria-hidden="true"></i><span>${esc(label)}</span></button></li>`;
}

function menuHtml(ids) {
  const has = (id) => ids.includes(id);
  // Literale t()-Aufrufe je Zeile, keine Schluessel-Tabelle: so findet jeder
  // Schluessel-Guard sie im Quelltext.
  const rows = [
    has('task') ? rowHtml('task', 'square-check-big', t('dashboard.fabTask')) : '',
    has('event') ? rowHtml('event', 'calendar', t('dashboard.fabCalendar')) : '',
    has('shopping') ? rowHtml('shopping', 'shopping-cart', t('dashboard.addMenuShopping')) : '',
    has('meal') ? rowHtml('meal', 'utensils', t('newLabel.meals')) : '',
  ].join('');
  // Der Beispielsatz ist Beschreibung, nicht Name: vorgelesen wird "Say a task",
  // danach das Beispiel.
  const say = has('say') ? `
    <button type="button" class="add-menu__say" data-add="say" aria-labelledby="add-menu-say-title" aria-describedby="add-menu-say-hint">
      <span class="add-menu__say-icon" aria-hidden="true"><i data-lucide="mic"></i></span>
      <span class="add-menu__say-text">
        <span class="add-menu__say-title" id="add-menu-say-title">${esc(t('tasks.dictation.title'))}</span>
        <span class="add-menu__say-hint" id="add-menu-say-hint">${esc(t('dashboard.addMenuSayHint'))}</span>
      </span>
    </button>` : '';
  return `
    <div class="add-menu" data-add-menu>
      ${say}
      ${rows ? `<ul class="add-menu__list" role="list">${rows}</ul>` : ''}
    </div>`;
}

function reportOpenFailure(err) {
  console.error('[AddMenu] Das Blatt konnte nicht geoeffnet werden:', err);
  globalThis.window?.yuvomi?.showToast?.(errorSentence(err), 'danger');
}

/**
 * Das Menue oeffnen.
 *
 * @param {{ user?: object|null, onChanged?: () => (void|Promise<void>), access?: Record<string, string> }} [opts]
 *        `user` ist der angemeldete Mensch (das Einkaufsblatt merkt sich seine
 *        Liste je Person), `onChanged` frischt Dziś nach dem Speichern auf.
 * @param {{ openers?: Record<string, (opts: object) => unknown> }} [testing]
 * @returns {boolean} false, wenn es nichts hinzuzufuegen gibt (kein Blatt)
 */
export function openAddMenu({ user = null, onChanged = () => {}, access = {} } = {}, { openers = OPENERS } = {}) {
  const ids = addMenuItems(access).map((item) => item.id);
  if (!ids.length) return false;
  openModal({
    title: t('dashboard.addMenuTitle'),
    size: 'sm',
    dirtyGuard: false,
    content: menuHtml(ids),
    onSave(panel) {
      panel.querySelector('[data-add-menu]')?.addEventListener('click', (event) => {
        const row = event.target?.closest?.('[data-add]');
        const open = row ? openers[row.dataset.add] : null;
        if (typeof open !== 'function') return;
        // Synchron, kein await bis zum Oeffner (siehe Kopf).
        closeModal({ force: true });
        let result;
        try {
          result = open({ user, onChanged });
        } catch (err) {
          reportOpenFailure(err);
          return;
        }
        if (typeof result?.then === 'function') result.then(null, reportOpenFailure);
      });
    },
  });
  return true;
}
