/**
 * Modul: Das Menue "Hinzufuegen" auf Dziś (Quick-Add, 2026-10-29; One Today, Task 14)
 * Zweck: Das "+" unten rechts auf Dziś oeffnet dieses Blatt (Entwurf PlusMenu):
 *        oben hervorgehoben "Say it" ("Powiedz") mit einem Beispielsatz,
 *        darunter Task, Event und Shopping item. Ein Tipp schliesst das Menue
 *        und oeffnet das passende Blatt ueber Dziś. Meal ist seit One Today
 *        nicht mehr hier; Food legt Mahlzeiten selbst an.
 * Abhängigkeiten: /i18n.js, /components/modal.js, /components/task-dictation.js
 *
 * JEDE ZEILE NUR MIT SCHREIBRECHT AUF IHR MODUL. Task braucht Aufgaben, Event
 * den Kalender, Shopping item den Einkauf - was nur gelesen werden darf,
 * endete im Blatt mit einem 403. "Say it" legt an, was der Satz ist, und steht
 * deshalb, sobald eine der drei Zeilen steht; es oeffnet selbst nur, was
 * beschrieben werden darf, und bekommt dafuer die Rechte mit. Die Rechte reicht
 * die Seite herein (`access`, aus moduleAccess wie der Rest von Dziś).
 *
 * "SAY IT" STARTET IM TIPP. Safari startet die Spracherkennung nur innerhalb
 * der Nutzergeste, sonst meldet sie `not-allowed`, und es bliebe nur das
 * Textfeld. Deshalb kommt task-dictation.js STATISCH herein, und der Tipp ruft
 * `startQuickAdd` ohne ein `await` (und ohne ein Promise) davor. Die drei
 * anderen Blaetter laden per import(), wie "Dodaj zadanie" in der Karte - sie
 * brauchen keine Geste. Das Menue selbst laedt Dziś erst beim Tipp auf das +
 * (pages/dashboard.js) - steht es, steht auch das Hoerblatt.
 *
 * ERST ZU, DANN AUF - BEIDES IM TIPP. `closeModal({ force: true })` nimmt das
 * Menue synchron aus der Top-Layer; der Browser gibt den Fokus dabei an das +
 * zurueck, und das naechste Blatt merkt sich das + als Rueckweg statt einer
 * Zeile, die gleich verschwindet. So laeuft "Say it".
 *
 * DIE DREI ANDEREN LADEN NACH, UND DAS SIEHT MAN (F8). Beim ersten Tipp holt
 * der Browser das Modul samt seinem Graphen (Aufgaben, Kalender: tausende
 * Zeilen), danach laedt der Oeffner seine Daten. Bis dahin bleibt das Menue
 * offen und die getippte Zeile dreht (`aria-busy`); das Blatt ersetzt das
 * Menue selbst - `openModal` schliesst ein offenes Modal zuerst, der Fokus
 * geht dabei ans + zurueck wie oben. Wer das Menue inzwischen zumacht oder
 * woanders steht, bekommt das Blatt nicht mehr: nach dem Laden wird gefragt,
 * ob das Menue noch offen und die Route dieselbe ist, und ein Blatt, dessen
 * Daten erst nach einem Seitenwechsel kamen, geht wieder zu. Oeffnet der
 * Oeffner nichts (keine Liste, nur lesend) oder scheitert er, geht das Menue.
 */

import { t } from '/i18n.js';
import { openModal, closeModal, captureModalContext, isOwnModalOpen } from '/components/modal.js';
import { esc } from '/utils/html.js';
import { errorSentence } from '/utils/friendly-error.js';
// STATISCH, nicht per import(): siehe Kopf ("Say it" startet im Tipp).
import { startQuickAdd } from '/components/task-dictation.js';

/**
 * Die Zeilen in der Reihenfolge des Entwurfs, je mit den Modulen, von denen
 * eines beschreibbar sein muss. "Say it" fuellt jedes der drei.
 */
const ROWS = Object.freeze([
  { id: 'say', modules: ['tasks', 'calendar', 'shopping'] },
  { id: 'task', modules: ['tasks'] },
  { id: 'event', modules: ['calendar'] },
  { id: 'shopping', modules: ['shopping'] },
]);

/**
 * Welche Zeilen das Menue zeigt.
 *
 * @param {Record<string, 'write'|'read'|'none'>} [access]  Recht je Modul (tasks, calendar, shopping)
 * @returns {Array<{ id: 'say'|'task'|'event'|'shopping' }>}
 */
export function addMenuItems(access = {}) {
  return ROWS
    .filter((row) => row.modules.some((module) => access?.[module] === 'write'))
    .map(({ id }) => ({ id }));
}

/**
 * Wer welches Blatt oeffnet. `say` IST startQuickAdd - ohne Promise davor
 * (siehe Kopf). Die anderen laden erst (`load`, die drehende Zeile) und
 * oeffnen dann (`open`) - siehe openWhenLoaded.
 */
const OPENERS = Object.freeze({
  say: startQuickAdd,
  task: { load: () => import('/pages/tasks.js'), open: (mod, opts) => mod.openNewTaskFrom(opts) },
  event: { load: () => import('/pages/calendar.js'), open: (mod, opts) => mod.openNewEventFrom(opts) },
  // `user` MUSS mit: das Blatt merkt sich die zuletzt benutzte Liste je Person.
  shopping: { load: () => import('/components/shopping-add-sheet.js'), open: (mod, opts) => mod.openShoppingAddFrom(opts) },
});

/** Wo die Seite gerade steht - wie captureModalContext() es vergleicht. */
function currentRoute() {
  const loc = globalThis.location;
  return loc ? `${loc.pathname}${loc.search}${loc.hash}` : '';
}

function setBusy(row, busy) {
  row?.setAttribute?.('aria-busy', String(busy));
}

/**
 * Laedt das Blatt einer Zeile und oeffnet es - wenn es dann noch gewollt ist
 * (siehe Kopf, F8). Das Menue steht dabei offen, die Zeile dreht.
 */
async function openWhenLoaded(row, { load, open }, opts) {
  const context = captureModalContext();
  const route = currentRoute();
  setBusy(row, true);
  try {
    const mod = await load();
    // Zugemacht oder weitergegangen: das Blatt will niemand mehr.
    if (!isOwnModalOpen(context) || currentRoute() !== route) return;
    const opened = await open(mod, opts);
    // Die Daten des Blatts kamen erst nach einem Seitenwechsel: es gehoert
    // nicht ueber die neue Seite. Geschlossen wird genau das Blatt, das der
    // Oeffner eben aufgemacht hat (er loest im selben Zug auf, #1997).
    if (opened !== false && currentRoute() !== route) {
      const sheet = captureModalContext();
      await closeModal({ force: true, context: sheet });
    }
  } catch (err) {
    reportOpenFailure(err);
  } finally {
    setBusy(row, false);
    // Nichts hat das Menue ersetzt (keine Liste, nur lesend, ein Fehler): es geht.
    if (isOwnModalOpen(context)) closeModal({ force: true, context });
  }
}

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
  ].join('');
  // Der Beispielsatz ist Beschreibung, nicht Name: vorgelesen wird "Say it",
  // danach das Beispiel (einer fuer Einkauf, einer fuer einen Termin).
  const say = has('say') ? `
    <button type="button" class="add-menu__say" data-add="say" aria-labelledby="add-menu-say-title" aria-describedby="add-menu-say-hint">
      <span class="add-menu__say-icon" aria-hidden="true"><i data-lucide="mic"></i></span>
      <span class="add-menu__say-text">
        <span class="add-menu__say-title" id="add-menu-say-title">${esc(t('quickAdd.title'))}</span>
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
 *        Liste je Person), `onChanged` frischt Dziś nach dem Speichern auf,
 *        `access` das Recht je Modul - "Say it" bekommt es mit.
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
      // Die Zeile, deren Blatt gerade laedt - solange oeffnet kein Tipp ein zweites.
      let loading = null;
      panel.querySelector('[data-add-menu]')?.addEventListener('click', (event) => {
        const row = event.target?.closest?.('[data-add]');
        const open = row ? openers[row.dataset.add] : null;
        if (loading) return;
        if (open && typeof open === 'object' && typeof open.load === 'function') {
          loading = row;
          void openWhenLoaded(row, open, { user, onChanged }).finally(() => { loading = null; });
          return;
        }
        if (typeof open !== 'function') return;
        // Synchron, kein await bis zum Oeffner (siehe Kopf).
        closeModal({ force: true });
        let result;
        try {
          result = open({ user, onChanged, access });
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

export const __test = { OPENERS };
