/**
 * Modul: Essensplan (Meals)
 * Zweck: Wochenansicht mit Mahlzeit-CRUD, Zutaten-Verwaltung und Einkaufslisten-Integration
 * Abhängigkeiten: /api.js, /router.js (window.yuvomi)
 */

import { api } from '/api.js';
import { openModal as openSharedModal, closeModal as closeSharedModal, captureModalContext, selectModal, confirmModal, askOverModal, advancedSection, wireBlurValidation, reportFieldError, reportFieldErrors, refocusAfterRender, swapFieldsKeepingDirtyBase } from '/components/modal.js';
import { stagger, scheduleUndoableDelete, wireScrollFade } from '/utils/ux.js';
import { t, formatDate, formatDayMonth, formatDateInput, parseDateInput, isDateInputValid, getLocale } from '/i18n.js';
import { esc, REQUIRED_MARK } from '/utils/html.js';
import { periodStepperHtml, syncPeriodReset, swapPeriod } from '/utils/period-stepper.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { DEFAULT_CATEGORY_NAME, categoryLabel } from '/utils/shopping-categories.js';
import { renderKitchenTabsBar } from '/utils/kitchen-tabs.js';
import { resolveShoppingTarget, announceTransfer, mountMissingShoppingList, mayTransferMealToShopping } from '/utils/kitchen-transfer.js';
import { ingredientRowHTML } from '/utils/ingredient-row.js';
import { addLocalDays, startOfLocalWeekKey, todayKey } from '/utils/date.js';
import { normalizeRecipeMealTypes, recipeSupportsMealType, recipeAllowsMealType } from '/utils/recipe-meal-types.js';
import { mountEmptyState, mountLoadError, emptyStateEl } from '/utils/empty-state.js';
import { mealPayloadFromRecipe } from '/utils/recipe-to-meal.js';
import { findPageFab } from '/utils/fab.js';
import { pageToolsMenuHtml, popoverMenuHtml, installPopoverMenus, syncPopoverMenuItem } from '/utils/popover-menu.js';
import { zonedWeekday, nowFields } from '/utils/timezone.js';
import { mealTypeList, mealTypeLabel, primeMealTypeNames, MEAL_TYPE_KEYS } from '/utils/meal-types.js';
import { recipeThumbHtml, wireRecipeThumbs } from '/utils/recipe-thumb.js';
import { toDecimalString, breaksOffAtSeparator, toStoredNumber } from '/utils/money.js';
import { mayWritePath } from '/utils/module-access.js';
import { readRowHtml, readRowHintHtml } from '/utils/read-row.js';
import { renderUserMultiSelect, getSelectedUserIds, bindUserMultiSelect, renderAvatarStack } from '/components/user-multi-select.js';
import { withChosenPeople } from '/utils/people-picker.js';
import { isSoloHousehold } from '/utils/household.js';
import { errorSentence } from '/utils/friendly-error.js';
import { openCookForMeal } from '/components/cook-mode.js';
import { personDisc } from '/utils/person-color.js';
import { initials } from '/utils/initials.js';

// --------------------------------------------------------
// Konstanten
// --------------------------------------------------------

// Slots, Symbole und Namen kommen aus utils/meal-types.js - der Haushalt darf
// sie umbenennen (#1058), und ein zweiter Ort haette dabei den alten Namen
// behalten.
const MEAL_TYPES = () => mealTypeList();

const DAY_NAMES = () => [
  t('meals.dayMo'), t('meals.dayDi'), t('meals.dayMi'), t('meals.dayDo'),
  t('meals.dayFr'), t('meals.daySa'), t('meals.daySo'),
];

// Der VOLLE Wochentagsname fuer Screenreader-Namen (`meals.addMealOnDay`): die
// Spaltenkoepfe tragen nur das Kuerzel („Mo"), und sieben Knoepfe, die alle
// „Mahlzeit hinzufuegen" heissen, sind vorgelesen EIN Knopf (Persona Sam).
// Index = zonedWeekday() (0 = Sonntag), dieselben Keys wie calendar.js.
const DAY_LONG_KEYS = ['dayLongSunday', 'dayLongMonday', 'dayLongTuesday', 'dayLongWednesday', 'dayLongThursday', 'dayLongFriday', 'dayLongSaturday'];
const dayLongName = (dateKey) => t(`calendar.${DAY_LONG_KEYS[zonedWeekday(dateKey)]}`);

const EXCLUDED_MEAL_CATEGORY_NAMES = new Set(['Haushalt', 'Drogerie']);

// --------------------------------------------------------
// State
// --------------------------------------------------------

let state = {
  currentWeek:      null,   // YYYY-MM-DD (Montag)
  meals:            [],
  recipes:          [],
  lists:            [],     // Einkaufslisten für Transfer-Dropdown
  categories:       [],     // Einkaufskategorien für Zutaten
  members:          [],     // Haushaltsmitglieder für die Koch-Auswahl (#1679)
  modal:            null,
  visibleMealTypes: ['breakfast', 'lunch', 'dinner', 'snack'],
  /** Gefangener Fehler des letzten Wochen-Ladevorgangs, sonst null.
   *  Ohne dieses Feld ist eine fehlgeschlagene Woche von einer leeren Woche
   *  nicht zu unterscheiden - und der Renderer zeigte den Leerzustand. */
  loadError:        null,
  // Tafla, die Woche am Telefon: was der Vorrat hat (null = nicht lesbar oder
  // abgeschaltet - dann zeigt der Plan keinen Zaehler), welche Namen offen auf
  // einer Einkaufsliste stehen, wer schaut (der eigene Koch bekommt keinen
  // Namen) und ob es Pomysl-Vorschlaege gibt.
  pantry:           null,
  listedKeys:       new Set(),
  userId:           null,
  ideasReady:       false,
  pastOpen:         false,
};

// Container-Referenz für Hilfsfunktionen (wird in render() gesetzt)
let _container = null;
/**
 * Steht die Rezept-Spalte schon (ein- oder ausgeklappt)? Erst dann darf das
 * Board entscheiden, ob „heute" verdeckt ist - siehe revealToday().
 */
let _railSettled = false;
let _dragRecipeId = null;

/**
 * Darf dieses Konto in den Essensplan schreiben? Regel 1 in
 * utils/module-access.js. Als Funktion, damit jedes Neuzeichnen neu fragt.
 *
 * WAS BEI `read` BLEIBT: die Woche mit Stepper und „Heute", jede Mahlzeit als
 * Karte mit Typ, Namen, Zutatenzahl, Serien-Zeichen und dem Sprung zum Rezept -
 * und der Tipp auf die Karte, der dann die Leseansicht oeffnet (Regel 9).
 * WAS GEHT: Anlegen (FAB, Tagesknopf, leerer Platz, Leerzustand), Bearbeiten,
 * Loeschen, der Zufallsplan, das Ziehen einer Karte samt Griff (Regel 3) und
 * die Rezept-Spalte - sie ist ein Werkzeug zum Einplanen, und die Rezepte
 * selbst stehen im Rezept-Tab. DER TRANSFER IN DEN EINKAUF geht mit: seine
 * Route kippt `on_shopping_list` im Plan und verlangt deshalb `meals: write`
 * (Regel 8, `mayTransferMealToShopping()`).
 *
 * KEIN WANDTABLETT: ein Display fuehrt `meals` nicht in seiner Scope-Liste
 * (server/display-scopes.js) und erreicht diese Seite nicht; ein
 * `actingAsDisplay()` davor braucht es hier nicht.
 */
function readOnly() {
  return !mayWritePath('/meals');
}

/**
 * Die `data-action`s des Wochengitters, die NICHT schreiben - eine Positivliste
 * wie in pantry.js und shopping.js: eine morgen ergaenzte Schreib-Aktion ist
 * bei `read` zu, bis sie hier ausdruecklich steht. `transfer-meal` fehlt mit
 * Absicht (siehe oben).
 */
const READ_SAFE_ACTIONS = new Set(['meal-details', 'open-recipe', 'open-linked-recipe']);

// --------------------------------------------------------
// Datumshelfer
// --------------------------------------------------------

function getMondayOf(dateStr) {
  return startOfLocalWeekKey(dateStr, 1);
}

function addDays(dateStr, n) {
  return addLocalDays(dateStr, n);
}

// --------------------------------------------------------
// Rezept einplanen ohne Ziehen (Re-Kritik 2026-09-28, A4 P1-1)
// --------------------------------------------------------

/**
 * Die Mahlzeit, die zur Uhrzeit passt: morgens Fruehstueck, mittags
 * Mittagessen, danach Abendessen. Der Zwischensnack ist nie die Vermutung -
 * er ist die Ausnahme, die man bewusst waehlt.
 */
function mealTypeForHour(hour) {
  if (hour < 10) return 'breakfast';
  if (hour < 15) return 'lunch';
  return 'dinner';
}

/**
 * Wohin ein Rezept aus der Spalte geplant wird, wenn es nicht gezogen,
 * sondern angetippt wird.
 *
 * Mahlzeit: die zur Uhrzeit, sofern sie sichtbar ist und das Rezept sie
 * erlaubt; sonst die naechste passende danach, sonst die erste passende. Tag:
 * heute, wenn heute in der sichtbaren Woche liegt, sonst deren Montag - und
 * von dort der erste Tag, an dem diese Mahlzeit noch frei ist. Ist die Woche
 * voll, bleibt es beim ersten Tag; der Dialog laesst beides aendern.
 *
 * @returns {{date: string, mealType: string}}
 */
function railRecipeTarget({ recipe, weekStart, today, hour, visibleMealTypes, meals }) {
  const visible = MEAL_TYPE_KEYS.filter((key) => visibleMealTypes.includes(key));
  const allowed = visible.filter((key) => recipeAllowsMealType(recipe, key));
  const pool = allowed.length ? allowed : (visible.length ? visible : ['lunch']);
  const wanted = mealTypeForHour(hour);
  const rank = (key) => MEAL_TYPE_KEYS.indexOf(key);
  const mealType = pool.includes(wanted)
    ? wanted
    : (pool.find((key) => rank(key) > rank(wanted)) ?? pool[0]);

  const week = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const days = week.includes(today) ? week.slice(week.indexOf(today)) : week;
  const taken = (date) => meals.some((m) => m.date === date && m.meal_type === mealType);
  const date = days.find((d) => !taken(d)) ?? days[0];
  return { date, mealType };
}

/** Rezept aus der Spalte in den Dialog "Mahlzeit hinzufuegen" (Klick/Enter). */
function planRecipeFromRail(recipeId) {
  if (readOnly()) return;
  const recipe = state.recipes.find((r) => r.id === Number(recipeId));
  if (!recipe) return;
  const { date, mealType } = railRecipeTarget({
    recipe,
    weekStart: state.currentWeek,
    today: todayKey(),
    hour: nowFields()?.hour ?? 12,
    visibleMealTypes: state.visibleMealTypes,
    meals: state.meals,
  });
  openMealModal({ mode: 'create', date, mealType, recipeId: recipe.id });
}

/**
 * Vorschlaege fuer das Namensfeld: gespeicherte Rezepte zuerst (sie bringen
 * Zutaten und den Weg zum Einkauf mit), dahinter die Namen frueherer
 * Mahlzeiten, die kein gleichnamiges Rezept schon abdeckt. Ein Rezept wird ueber
 * einen Wortteil gefunden, nicht nur ueber den Anfang - "ridge" findet
 * "Porridge"; was mit der Eingabe beginnt, steht vorn.
 *
 * @returns {Array<{title: string, recipeId: number|null}>}
 */
function mealTitleSuggestions(query, recipes, history, limit = 8) {
  const norm = (v) => String(v ?? '').toLocaleLowerCase();
  const needle = norm(query).trim();
  if (!needle) return [];
  const recipeHits = recipes
    .filter((r) => norm(r.title).includes(needle))
    .sort((a, b) => (norm(a.title).startsWith(needle) ? 0 : 1) - (norm(b.title).startsWith(needle) ? 0 : 1)
      || String(a.title).localeCompare(String(b.title)))
    .map((r) => ({ title: r.title, recipeId: r.id }));
  const seen = new Set(recipeHits.map((h) => norm(h.title)));
  const historyHits = [];
  for (const h of history ?? []) {
    const title = h?.title;
    if (!title || seen.has(norm(title))) continue;
    seen.add(norm(title));
    historyHits.push({ title, recipeId: null });
  }
  return [...recipeHits, ...historyHits].slice(0, limit);
}

/**
 * Das Namensfeld als ARIA-1.2-Combobox mit Liste.
 *
 * Vorher waren die Vorschlaege `div`s ohne Rolle, das Feld hatte weder
 * `role=combobox` noch `aria-expanded`: fuer den Screenreader gab es die Liste
 * nicht, und die Pfeiltasten bewegten nur eine CSS-Klasse. Jetzt bleibt der
 * Fokus im Feld, die Pfeile bewegen die Markierung (`aria-activedescendant`,
 * `aria-selected`), Enter uebernimmt, Escape schliesst NUR die Liste. Ein
 * Rezepttreffer ruft `onRecipe` - der Dialog setzt dann Rezept, Zutaten und
 * `recipe_id` wie die Rezeptauswahl darunter.
 */
function wireMealTitleCombobox(panel, { onRecipe } = {}) {
  const input = panel.querySelector('#modal-title');
  const box = panel.querySelector('#modal-autocomplete');
  if (!input || !box) return;
  let items = [];
  let active = -1;
  let timer;
  let seq = 0;
  const optionId = (i) => `modal-autocomplete-opt-${i}`;

  const setActive = (index) => {
    active = index;
    [...box.children].forEach((el, i) => {
      el.classList.toggle('meal-modal__autocomplete-item--active', i === index);
      el.setAttribute('aria-selected', String(i === index));
    });
    if (index >= 0) input.setAttribute('aria-activedescendant', optionId(index));
    else input.removeAttribute('aria-activedescendant');
  };
  const close = () => {
    box.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    setActive(-1);
  };
  const show = (list) => {
    items = list;
    box.replaceChildren(...list.map((s, i) => {
      const option = document.createElement('div');
      option.id = optionId(i);
      option.className = 'meal-modal__autocomplete-item';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.dataset.index = String(i);
      const title = document.createElement('span');
      title.className = 'meal-modal__autocomplete-title';
      title.textContent = s.title;
      option.appendChild(title);
      if (s.recipeId) {
        const kind = document.createElement('span');
        kind.className = 'meal-modal__autocomplete-kind';
        kind.textContent = t('meals.suggestionRecipe');
        option.appendChild(kind);
      }
      return option;
    }));
    if (!list.length) { close(); return; }
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    setActive(-1);
  };
  const pick = (index) => {
    const s = items[index];
    if (!s) return;
    input.value = s.title;
    close();
    if (s.recipeId) onRecipe?.(s.recipeId);
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    const mine = ++seq;
    if (!q) { show([]); return; }
    timer = setTimeout(async () => {
      let history = [];
      try {
        const res = await api.get(`/meals/suggestions?q=${encodeURIComponent(q)}`);
        history = res?.data ?? [];
      } catch { history = []; }
      // Eine spaete Antwort auf eine alte Eingabe ueberschreibt nichts.
      if (mine !== seq) return;
      show(mealTitleSuggestions(q, state.recipes, history));
    }, 200);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (box.hidden) return;
      // Die Liste schliessen, nicht den Dialog darum.
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (box.hidden || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(active + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(active - 1, 0)); }
    else if (e.key === 'Enter' && active >= 0) {
      // Enter UEBERNIMMT den Vorschlag und endet hier: bis zum Dialog
      // durchgereicht, loeste es dessen Enter-zum-Speichern aus, und die
      // Mahlzeit war angelegt, bevor man sie gesehen hatte.
      e.preventDefault();
      e.stopPropagation();
      pick(active);
    }
  });

  // mousedown statt click: sonst nimmt der Blur des Feldes die Liste weg,
  // bevor der Klick ankommt. preventDefault haelt den Fokus im Feld.
  box.addEventListener('mousedown', (e) => {
    const option = e.target.closest?.('.meal-modal__autocomplete-item');
    if (!option) return;
    e.preventDefault();
    pick(Number(option.dataset.index));
  });
  input.addEventListener('blur', close);
}

/**
 * Schmale Telefone (PR #1200 Review, Blocking 2): das volle Datum an beiden
 * Enden - "14.09.2026 - 20.09.2026" - lief in de/fr/uk bei 320/375px 21-112px
 * ueber die Zeile. Seit #1164 lebt `#week-today` in derselben Zeile wie das
 * Label und macht sie um seine Breite enger; auf main war der schlechteste
 * Fall 9px bei 320px, hier gemessen bis 112px. Seit Runde 5 (unten,
 * `syncTodayButton()`) ist `#week-today` unter 640px nur noch ein Icon ohne
 * Text - der reservierte Platz bleibt dadurch in jeder Sprache gleich schmal
 * (~44-48px wie ein Pfeil), statt mit dem uebersetzten Wort zu wachsen.
 *
 * Unter 640px faellt das Jahr an BEIDEN Enden weg (`formatDayMonth` statt
 * `formatDate`) - verwandt mit dem Muster, das der Kalender fuer sein eigenes
 * schmales Wochen-Label nutzt (`updateLabel()`, calendar.js:
 * `calendar.dayRangeLabel`), dort behaelt nur der Endtag sein Jahr. Hier
 * fällt es an BEIDEN Tagen weg: eine Kalenderwoche liegt so gut wie nie über
 * einen Jahreswechsel, und die zusätzliche Breite (nicht nur ein Datum,
 * sondern zwei) war noetig, um die von Reviewern gemessenen 112px in fr
 * sicher aufzufangen.
 */
const NARROW_WEEK_LABEL_QUERY = '(max-width: 639px)';

function formatWeekLabel(monday) {
  const sunday = addDays(monday, 6);
  const narrow = window.matchMedia?.(NARROW_WEEK_LABEL_QUERY).matches;
  // Unter 640px faellt das Jahr an BEIDEN Enden weg (`formatDayMonth`): die
  // Kalenderwoche liegt so gut wie nie ueber einen Jahreswechsel, und die
  // gesparte Breite ist hier der knappere Preis - eine Woche wie
  // "28.12. - 03.01." bleibt trotzdem eindeutig genug fuer den Kopf einer
  // Seite, die ohnehin "diese Woche" zeigt.
  const from = narrow ? formatDayMonth(monday) : formatDate(monday);
  const to = narrow ? formatDayMonth(sunday) : formatDate(sunday);
  return `${from} - ${to}`;
}

/**
 * PR #1200 Review Runde 3, Nice-to-have 4: `formatWeekLabel()` liest
 * `matchMedia` nur beim Rendern - ein Fenster, das ueber die 640px-Schwelle
 * gezogen wird, behielt bis zum naechsten Wochenwechsel das alte Format.
 *
 * EINE gehaltene `MediaQueryList` statt eines
 * `window.matchMedia(...).addEventListener(...)` in einem Rutsch: ohne
 * gehaltene Referenz darf die Engine die Liste einsammeln, und der Listener
 * verstummt irgendwann still - dasselbe Muster wie router.js' `darkSchemeQuery`.
 * Modul-Top-Level statt in `render()`: `render()` laeuft bei jeder Navigation
 * zur Seite neu, ein dort gebundener Listener wuerde sich mit jedem Besuch
 * verdoppeln.
 *
 * `_container?.isConnected` (wie beim Fokus-Rueckstoss weiter unten) haelt den
 * Listener nach einer Navigation weg von /meals stumm - ohne die Prüfung
 * rendert er in einen Container, den niemand mehr sieht.
 *
 * PR #1200 Review Runde 4, Should-fix 2: hier stand `renderWeekGrid()` statt
 * `updateWeekLabel()` - eine Bildschirmdrehung ueber die 640px-Schwelle riss
 * damit das GANZE Wochengitter neu auf (jede Karte, den Stagger, den Scroll
 * zur heutigen Spalte), obwohl nur das Label ein anderes Format braucht.
 * Stand der Fokus auf einer Mahlzeit-Karte, landete er nach dem Neuaufbau auf
 * `<body>` - eine Kartenreferenz, die `renderWeekGrid()` wegwirft, ueberlebt
 * den Wechsel nicht. `updateWeekLabel()` ruehrt nur `#week-label` und den
 * Reset-Knopf an, beide unabhaengig vom Karten-DOM - der Fokus bleibt daher
 * unberuehrt, wo immer er gerade steht.
 */
function onNarrowWeekLabelQueryChange() {
  if (_container?.isConnected) updateWeekLabel();
}
const _narrowWeekLabelQuery = typeof window !== 'undefined' ? window.matchMedia?.(NARROW_WEEK_LABEL_QUERY) ?? null : null;
_narrowWeekLabelQuery?.addEventListener('change', onNarrowWeekLabelQueryChange);

function isToday(dateStr) {
  return dateStr === todayKey();
}

function formatDayDate(dateStr) {
  // Ohne Jahr (Audit F-04): das Wochen-Label in der Nav trägt das Jahr; in den
  // 7 Board-Spalten kollidierte das volle Datum mit dem Wochentagsnamen.
  return formatDayMonth(dateStr);
}

function mealCategories() {
  return state.categories.filter((c) => !EXCLUDED_MEAL_CATEGORY_NAMES.has(c.name));
}

function recipeMealTypeOptions() {
  return mealTypeList().map(({ key, label }) => ({ key, label }));
}

function buildRandomMealAssignments({ weekStart, visibleMealTypes, meals, recipes, replaceExisting = false, pick = Math.random }) {
  const assignments = [];
  const deleteMealIds = [];
  const previousDayByMealType = new Map();
  let hasOpenSlot = false;
  let hasCompatibleSlot = false;

  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const date = addDays(weekStart, dayOffset);
    let previousRecipeIdSameDay = null;
    for (const mealType of visibleMealTypes) {
      const slotMeals = meals.filter((meal) => meal.date === date && meal.meal_type === mealType);
      if (!replaceExisting && slotMeals.length) continue;
      hasOpenSlot = true;
      const compatible = recipes.filter((recipe) => recipeSupportsMealType(recipe, mealType));
      if (!compatible.length) continue;
      hasCompatibleSlot = true;
      const blockedIds = new Set([previousRecipeIdSameDay, previousDayByMealType.get(mealType)].filter(Boolean));
      const preferred = compatible.filter((recipe) => !blockedIds.has(recipe.id));
      const pool = preferred.length ? preferred : compatible;
      const index = Math.floor(Math.max(0, Math.min(0.999999, Number(pick()) || 0)) * pool.length);
      const recipe = pool[index] || pool[0];
      assignments.push({
        date,
        mealType,
        recipe,
        payload: mealPayloadFromRecipe(recipe, date, mealType),
      });
      previousRecipeIdSameDay = recipe.id;
      previousDayByMealType.set(mealType, recipe.id);
      if (replaceExisting) deleteMealIds.push(...slotMeals.map((meal) => meal.id));
    }
  }

  const reason = assignments.length
    ? null
    : !hasOpenSlot
      ? 'week_full'
      : !hasCompatibleSlot
        ? 'no_compatible_recipes'
        : 'no_assignments';

  return { assignments, deleteMealIds: [...new Set(deleteMealIds)], reason };
}

// --------------------------------------------------------
// API-Wrapper
// --------------------------------------------------------

async function loadWeek(week) {
  const currentWeek = getMondayOf(week);
  state.currentWeek = currentWeek;
  try {
    const res = await api.get(`/meals?week=${currentWeek}`);
    state.meals     = Array.isArray(res.data) ? res.data : [];
    state.loadError = null;
  } catch (err) {
    console.error('[Meals] loadWeek Fehler:', err);
    state.meals     = [];
    // Der Fehler wird bis zum Renderer getragen statt in einen Toast gelegt.
    // Ein Toast verschwindet nach Sekunden, der falsche Leerzustand darunter
    // blieb stehen - von den beiden Meldungen überlebte also genau die
    // irreführende (Critique P0, 2026-07-30).
    state.loadError = err;
  }
}

async function loadLists() {
  try {
    const res   = await api.get('/shopping');
    state.lists = res.data;
  } catch {
    state.lists = [];
  }
}

async function loadCategories() {
  try {
    const res       = await api.get('/shopping/categories');
    state.categories = res.data;
  } catch {
    state.categories = [];
  }
}

async function loadRecipes() {
  try {
    const res = await api.get('/recipes');
    state.recipes = res.data;
  } catch {
    state.recipes = [];
  }
}

/**
 * Wer als Koch waehlbar ist (#1679): die Haushaltsmitglieder, wie
 * `/family/members` sie durch das eine Mitglieder-Praedikat liefert - ohne
 * Hauspersonal, Gaeste und Wandtabletts (docs/DECISIONS.md, Eintrag 4). Die
 * Route lehnt genau die ab, die hier fehlen.
 *
 * AUCH BEI `read`. Eine Wahl gibt es dort nicht, die Liste traegt aber das
 * BILD des Kochs: die Mahlzeit nennt nur id, Name und Farbe (mealCook()), das
 * Profilbild steht einmal je Person hier statt an jeder Mahlzeit der Woche.
 * `/family/members` ist kein Modul der Rechteverwaltung und fuer jede Sitzung
 * lesbar; scheitert der Abruf, bleiben die Initialen.
 */
async function loadMembers() {
  try {
    const res = await api.get('/family/members');
    state.members = Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    // NICHT STILL: der Fehler geht in die Konsole wie der von loadWeek(), und
    // eine schon geladene Liste bleibt stehen - Mitglieder aendern sich
    // seltener, als ein Abruf scheitert. Scheitert schon der ERSTE Abruf, ist
    // die Liste weiter leer; dann holt der Dialog sie beim Oeffnen nach
    // (openMealModal() -> refreshCookPicker()).
    console.error('[Meals] loadMembers Fehler:', err);
  }
}

/**
 * Der Koch einer Mahlzeit als Person, wie `renderAvatarStack()` und
 * `withChosenPeople()` sie lesen - oder null. Die Leseabfragen liefern ihn
 * flach neben der Mahlzeit (`cook_user_id`, `cook_name`, `cook_color`), im
 * Planer wie in der Uebersicht.
 *
 * DAS BILD KOMMT AUS DER MITGLIEDERLISTE, nicht aus der Mahlzeit: der Server
 * haengt es nicht mehr an jede Zeile. Ein Koch, der kein Mitglied (mehr) ist,
 * steht dort nicht und zeigt seine Initialen auf seiner Farbe.
 */
function mealCook(meal) {
  if (!meal?.cook_user_id) return null;
  return {
    id: meal.cook_user_id,
    display_name: meal.cook_name ?? '',
    color: meal.cook_color ?? null,
    avatar_data: state.members.find((member) => member.id === meal.cook_user_id)?.avatar_data ?? null,
  };
}

/**
 * Das Zeichen "wer kocht" an einer Mahlzeit: der Avatar, dazu der Name fuer
 * Screenreader - die Scheibe traegt ihn sonst nur als `title`, und in einem
 * Knopf waeren zwei Initialen sein ganzer Beitrag zum Namen. Ohne Koch nichts:
 * eine Mahlzeit ohne Koch sieht aus wie bisher.
 */
function mealCookMarkHtml(meal, { size = 20 } = {}) {
  const cook = mealCook(meal);
  if (!cook) return '';
  return `<span class="meal-card__cook">${renderAvatarStack([cook], { size, maxVisible: 1 })}<span class="sr-only">${esc(t('meals.cookNamed', { name: cook.display_name }))}</span></span>`;
}

async function loadPreferences() {
  try {
    const res = await api.get('/preferences');
    state.visibleMealTypes = res.data.visible_meal_types ?? state.visibleMealTypes;
    primeMealTypeNames(res.data);
  } catch {
    // Default beibehalten
  }
}

// --------------------------------------------------------
// Render
// --------------------------------------------------------

/**
 * Der Zeitraum-Kopf: zurueck, Wert, vor - und DAHINTER der Reset. „Heute" ist
 * ein Reset, kein Navigationsschritt: hinter dem Stepper statt zwischen den
 * Inhalts-Aktionen. Das ist die Regel, die budget.js an „Aktuell" festhaelt,
 * und seit #1164 gilt sie fuer alle drei Zeitraum-Koepfe (Kalender,
 * Wochenplan, Budget). Vorher stand „Heute" im Actions-Slot neben
 * „Zufallsplan" und „+ Gericht" - Inhalts-Aktionen einer ganz anderen
 * Gewichtung - und landete unter ~768px auf einer zweiten Zeile, getrennt vom
 * Stepper, den es zuruecksetzt. Als eigener Baustein, damit der
 * Verhaltenstest die GERENDERTE Reihenfolge prueft (test-meals.js), statt
 * Quelltext zu lesen.
 */
function weekNavHtml() {
  // Markup und Reihenfolge kommen aus dem EINEN Baustein (utils/period-stepper.js).
  return periodStepperHtml({
    prev: { id: 'week-prev', label: t('meals.prevWeek') },
    value: { id: 'week-label', className: 'week-nav__label' },
    next: { id: 'week-next', label: t('meals.nextWeek') },
    reset: { id: 'week-today', className: 'week-nav__today', label: t('meals.today') },
  });
}

/**
 * „Heute" erscheint nur, wenn die aktuelle Woche nicht zu sehen ist -
 * dieselbe Sichtbarkeitsregel wie syncTodayButton() im Kalender (#1164).
 *
 * `.is-current` statt `hidden` (PR #1200 Review): `hidden` entfernte die Box
 * aus dem Fluss, und `.week-nav__label` daneben (`flex: 1`) wuchs in den frei
 * gewordenen Platz - "›" ruckte dadurch um die Knopfbreite, sobald der Reset
 * erschien oder verschwand. `.is-current` (layout.css, `.btn.is-current`)
 * blendet nur per `visibility` aus; die Box bleibt im Fluss, der Slot bleibt
 * gleich breit. `inert` nimmt dem Knopf zusaetzlich Zeiger, Fokus und
 * A11y-Baum.
 *
 * War der Knopf fokussiert (Enter auf „Heute" fuehrt genau in den Zustand, der
 * ihn gleich verbirgt), holt sich der Fokus vorher einen Stepper daneben -
 * sonst faellt er auf `<body>`, denn ein `inert`es Element blurred wie
 * `display: none` es taete.
 *
 * PR #1200 Review Runde 5, Should-fix: unter 640px wird der Knopf hier
 * zusaetzlich auf ein reines Icon umgeschaltet (kein sichtbarer Text mehr) -
 * dieselbe `NARROW_WEEK_LABEL_QUERY`-Schwelle wie `formatWeekLabel()`, damit
 * beide zusammen kippen. Der uebersetzte Text von `meals.today` bleibt
 * erhalten, wandert aber auf `aria-label`/`title` statt auf den sichtbaren
 * Inhalt - Icons skalieren nicht mit der Wortlaenge der Uebersetzung, anders
 * als der vorherige Text-Knopf (Runde 3/4). `dataset.iconOnly` haelt fest,
 * welche Darstellung gerade steht, damit ein Aufruf ohne Wechsel (z. B. bei
 * jedem Wochenwechsel) das Icon nicht unnoetig neu erzeugt.
 */
function syncTodayButton(root = _container) {
  const btn = root?.querySelector('#week-today');
  if (!btn) return;
  const isCurrent = state.currentWeek === getMondayOf(todayKey());
  // Verbergen, Fokus-Uebergabe und `inert`: die eine Regel in period-stepper.js.
  syncPeriodReset(root, { reset: '#week-today', isCurrent, prev: '#week-prev', next: '#week-next' });

  const label = t('meals.today');
  btn.setAttribute('aria-label', label);
  btn.title = label;
  const narrow = typeof window !== 'undefined'
    ? Boolean(window.matchMedia?.(NARROW_WEEK_LABEL_QUERY).matches)
    : false;
  if (narrow) {
    if (btn.dataset.iconOnly !== 'true') {
      btn.textContent = '';
      btn.insertAdjacentHTML('beforeend', '<i data-lucide="calendar-check" aria-hidden="true"></i>');
      btn.dataset.iconOnly = 'true';
      if (window.lucide) lucide.createIcons({ el: btn });
    }
  } else if (btn.dataset.iconOnly === 'true') {
    btn.textContent = label;
    btn.dataset.iconOnly = 'false';
  }
}

/**
 * Das EINE Werkzeugmenue des Wochenplans (Kopfregel mobil, DESIGN.md).
 *
 * „Plan zufaellig fuellen" kann 28 Slots umschreiben und ist eine seltene
 * Handlung - im Menue steht sie mit Label, statt als Textknopf eine eigene
 * Kopfzeile zu kosten. Der Schalter der Rezept-Spalte ist ein
 * `menuitemcheckbox`: der Haken zeigt, ob die Spalte steht. Die Spalte gibt es
 * nur ab 1024px, darunter blendet meals.css den Eintrag aus (dieselbe
 * Schwelle wie `.meals-layout`); der Anfangszustand wird von
 * `wireRailToggle()` nachgezogen, sobald die Messung steht.
 */
function mealsToolsMenuHtml() {
  // Bei `read` bleibt kein Eintrag: der Zufallsplan schreibt, und die
  // Rezept-Spalte, die der zweite schaltet, gibt es dann nicht (readOnly()).
  // Ein Menue ohne Eintraege waere ein Knopf, der nichts oeffnet.
  if (readOnly()) return '';
  return pageToolsMenuHtml({
    id: 'meals-tools-menu',
    label: t('common.moreActions'),
    items: [
      { action: 'meal-ideas', label: t('meals.ideasMenu'), icon: 'sparkles' },
      { action: 'randomize-plan', label: t('meals.randomizePlan'), icon: 'shuffle' },
      { action: 'toggle-rail', label: t('meals.showRecipes'), icon: 'panel-right', checked: true },
    ],
  });
}

/**
 * Board, Rezept-Spalte und FAB. Bei `read` ohne Spalte und ohne FAB (siehe
 * readOnly()): die Spalte plant ein, der FAB legt an. `--rail-hidden` gibt dem
 * Board dann die Breite, die sonst die Spalte belegte - dieselbe Klasse, die
 * der Schalter im Werkzeugmenue setzt.
 */
function mealsLayoutHtml() {
  const ro = readOnly();
  return `<div class="meals-layout${ro ? ' meals-layout--rail-hidden' : ''}">
        <div class="week-grid page-scrollport" id="week-grid">
          <div style="grid-column:1/-1">${renderSkeletonList({ rows: 5, lines: 2 })}</div>
        </div>
        ${ro ? '' : '<aside class="recipe-sidebar" id="recipe-sidebar"></aside>'}
      </div>
      ${ro ? '' : `<button class="page-fab" id="fab-new-meal" aria-label="${t('meals.addMealTitle')}" data-dock-label="${t('newLabel.meals')}">
        <i data-lucide="plus" class="icon-xl" aria-hidden="true"></i>
      </button>`}`;
}

export async function render(container, { user }) {
  _container = container;
  _railSettled = false;
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="meals-page">
      <h1 class="sr-only">${t('nav.meals')}</h1>
      <!-- Kanonischer Kopf, Gruppen-Variante (.page-toolbar--in-group in
           layout.css): Akzentstreifen und oberste Sticky-Position bleiben bei
           der .kitchen-tabs-bar darüber. Vorher war das hier eine eigene
           .week-nav-Grammatik, eine von vier im Modul (Critique 2026-07-29).

           Die Datums-Navigation liegt geschlossen im __center-Slot. Vorher
           standen „<" und „>" an den beiden Enden der Zeile, mit dem gesamten
           Aktionsblock dazwischen - mobil gemessen 80px und 705px, einhändig
           also nie beide erreichbar. -->
      <div class="page-toolbar page-toolbar--in-group meals-toolbar">
        <div class="page-toolbar__center week-nav">${weekNavHtml()}</div>
        <div class="page-toolbar__actions">
          <!-- KUECHENKOPF (Kopfregel mobil, 2026-09-26): Zeile 1 ist die
               Kuechen-Leiste, Zeile 2 der Kontext des Tabs - hier der
               Wochenstepper - und am Ende EIN Werkzeugmenue. Zufallsplan und
               Rezept-Spalte standen hier als loser Textknopf und loses Icon;
               mobil brach der Textknopf auf eine eigene 48px-Zeile um (Kopf
               177px). Den Primaerknopf dockt der Router am Desktop dahinter an. -->
          ${mealsToolsMenuHtml()}
        </div>
      </div>
      ${phoneWeekShellHtml()}
      ${mealsLayoutHtml()}
    </div>
  `);

  if (window.lucide) lucide.createIcons({ el: container });
  renderKitchenTabsBar(container, '/meals');
  installPopoverMenus(container.querySelector('.meals-toolbar'));
  state.userId = user?.id ?? null;
  state.pastOpen = false;

  const today  = todayKey();
  const monday = getMondayOf(today);

  // Vor dem ersten Laden synchronisieren, nicht erst danach: `state.currentWeek`
  // steht schon (die Seite oeffnet immer auf der aktuellen Woche), also kann
  // „Heute" seinen Zielzustand VOR dem ersten Bildaufbau bekommen. Sonst
  // rendert weekNavHtml() ihn sichtbar, der Ladevorgang laeuft, und erst danach
  // versteckt syncTodayButton() ihn wieder - ein sichtbares Aufblitzen bei
  // jedem frischen Laden von /meals (PR #1200 Review, Befund 5).
  state.currentWeek = monday;
  syncTodayButton();

  await Promise.all([loadWeek(monday), loadLists(), loadPreferences(), loadCategories(), loadRecipes(), loadMembers(), loadPantry()]);
  // Was schon auf einer Liste steht, braucht die Listen - deshalb danach.
  await loadListedNames();
  renderWeekGrid();
  wirePhoneWeek();
  renderRecipeSidebar();
  wireNav();
  wireRecipeSidebar();
  wireRailToggle();

  // `?.`: bei `read` steht kein FAB im Markup. Der Riegel selbst sitzt in
  // openMealModal() - dort muenden alle Anlegewege.
  findPageFab('fab-new-meal')?.addEventListener('click', () => {
    const firstType = state.visibleMealTypes[0] ?? 'lunch';
    openMealModal({ mode: 'create', date: today, mealType: firstType });
  });

  wireMealIdeas(container, today);
}

// --------------------------------------------------------
// Meal ideas (fork, 2026-10-19)
// "Podpowiedz posiłek" in the tools menu, and the daily heads-up's link
// (/meals?ideas=YYYY-MM-DD): three ideas for one slot from the household
// memory, recent meals, recipes and pantry. Planning one is the ordinary
// POST /meals; the saved-toast then offers the shopping list.
// --------------------------------------------------------
async function wireMealIdeas(container, today) {
  const entry = container.querySelector('[data-action="meal-ideas"]');
  let ready = false;
  try {
    ready = Boolean((await api.get('/ai/status')).data?.features?.meal_ideas);
  } catch { ready = false; }
  if (!ready || readOnly()) {
    // No idea service here: the entry goes rather than leading nowhere.
    (entry?.closest('[role="menuitem"], li') ?? entry)?.remove();
    return;
  }
  entry?.addEventListener('click', () => openIdeasModal(today));
  // The phone week offers "Pomysł" on empty slots once the service answered.
  state.ideasReady = true;
  renderPhoneWeek();
  const asked = new URLSearchParams(location.search).get('ideas');
  if (asked && /^\d{4}-\d{2}-\d{2}$/.test(asked)) openIdeasModal(asked);
}

function openIdeasModal(date, { mealType = null, autoAsk = false } = {}) {
  const types = state.visibleMealTypes.length ? state.visibleMealTypes : ['lunch', 'dinner'];
  const defaultType = (mealType && types.includes(mealType) ? mealType : null)
    ?? ['lunch', 'dinner'].find((tp) => types.includes(tp)) ?? types[0];
  const days = Array.from({ length: 7 }, (_, i) => addLocalDays(todayKey(), i));
  if (!days.includes(date)) days.unshift(date);
  const content = `
    <div class="form-group">
      <label class="form-label" for="ideas-date">${esc(t('meals.ideasDay'))}</label>
      <select class="form-input" id="ideas-date">${days.map((d) => `<option value="${d}"${d === date ? ' selected' : ''}>${esc(formatDate(d))}</option>`).join('')}</select>
    </div>
    <div class="form-group">
      <label class="form-label" for="ideas-type">${esc(t('meals.ideasMeal'))}</label>
      <select class="form-input" id="ideas-type">${types.map((tp) => `<option value="${tp}"${tp === defaultType ? ' selected' : ''}>${esc(mealTypeLabel(tp))}</option>`).join('')}</select>
    </div>
    <div class="meal-ideas" id="meal-ideas" aria-live="polite"></div>
    <div class="modal-panel__footer modal-panel__footer--plain">
      <button class="btn btn--secondary" type="button" data-ideas="close">${esc(t('common.cancel'))}</button>
      <button class="btn btn--primary" type="button" data-ideas="ask">${esc(t('meals.ideasAsk'))}</button>
    </div>`;
  openSharedModal({
    title: t('meals.ideasTitle'),
    content,
    size: 'md',
    onSave(panel) {
      const out = panel.querySelector('#meal-ideas');
      let ideas = [];
      const show = (html) => { out.replaceChildren(); out.insertAdjacentHTML('beforeend', html); window.lucide?.createIcons({ el: out }); };
      panel.querySelector('[data-ideas="close"]').addEventListener('click', () => closeSharedModal({ force: true }));
      panel.querySelector('[data-ideas="ask"]').addEventListener('click', async (e) => {
        const button = e.currentTarget;
        button.disabled = true;
        show(`<p class="form-hint">${esc(t('meals.ideasLoading'))}</p>`);
        try {
          const res = await api.post('/meals/ideas', { date: panel.querySelector('#ideas-date').value, meal_type: panel.querySelector('#ideas-type').value });
          ideas = res.data?.ideas ?? [];
          if (!ideas.length) { show(`<p class="form-hint">${esc(t('meals.ideasNone'))}</p>`); return; }
          show(ideas.map((idea, i) => `
            <article class="meal-idea">
              <h3 class="meal-idea__title">${esc(idea.title)}</h3>
              <p class="meal-idea__why">${esc(idea.why)}</p>
              ${idea.ingredients.length ? `<p class="meal-idea__ingredients">${esc(idea.ingredients.map((ing) => ing.name).join(', '))}</p>` : ''}
              <button type="button" class="btn btn--secondary" data-plan="${i}">${esc(t('meals.ideasPlan'))}</button>
            </article>`).join(''));
        } catch (err) {
          const reason = err?.data?.reason;
          show(`<p class="form-hint">${esc(reason === 'ai_cap_reached' ? t('pantry.photoCap') : t('meals.ideasFailed'))}</p>`);
        } finally {
          button.disabled = false;
        }
      });
      out.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-plan]');
        if (!btn) return;
        const idea = ideas[Number(btn.dataset.plan)];
        if (!idea) return;
        btn.disabled = true;
        const context = captureModalContext();
        try {
          const res = await api.post('/meals', {
            date: panel.querySelector('#ideas-date').value,
            meal_type: panel.querySelector('#ideas-type').value,
            title: idea.title,
            recipe_id: idea.recipe_id ?? null,
            ingredients: idea.ingredients.map(({ name, quantity, category }) => ({ name, quantity, category })),
          });
          closeSharedModal({ force: true, context });
          await loadWeek(state.currentWeek);
          renderWeekGrid();
          refocusAfterRender();
          const created = res.data;
          if (created?.id && idea.ingredients.length && mayTransferMealToShopping(created.id)) {
            window.yuvomi?.showToast(t('meals.mealSaved'), 'success', 8000, { label: t('meals.toShoppingListAction'), onClick: () => transferMeal(created.id) });
          } else {
            window.yuvomi?.showToast(t('meals.mealSaved'), 'success');
          }
        } catch (err) {
          btn.disabled = false;
          window.yuvomi?.showToast(errorSentence(err), 'danger');
        }
      });
      // Opened from a slot's "Pomysł" chip: day and meal are known, so the
      // ideas come without a second tap.
      if (autoAsk) panel.querySelector('[data-ideas="ask"]')?.click();
    },
  });
}

// --------------------------------------------------------
// Rezept-Spalte ein-/ausklappen
// --------------------------------------------------------

const RAIL_STORAGE_KEY = 'yuvomi-meals-rail';

/**
 * Klappt die Rezept-Spalte weg. Sie belegt auf 1024-1439px 272px und ab 1440px
 * 320px - genau die Breite, die dem Board für den siebten Tag fehlt: mit ihr
 * sind Samstag und Sonntag nur über horizontales Scrollen erreichbar, ohne sie
 * passen alle sieben Spalten in voller Breite (Critique 2026-07-29). Die
 * Mindestbreite der Tagesspalten bleibt unangetastet, damit die Namen nicht
 * wieder silbenweise brechen (siehe Kommentar an .week-grid in meals.css).
 */
function wireRailToggle() {
  // Der Schalter ist ein Eintrag im Werkzeugmenue (Kopfregel mobil) - vorher
  // ein loses Icon im Kopf. Der Haken traegt den Zustand, den dort das
  // Icon-Paar panel-right-open/-close trug.
  const item = _container.querySelector('.popover-menu__item[data-action="toggle-rail"]');
  const layout = _container.querySelector('.meals-layout');
  if (!item || !layout) {
    // Ohne Schalter keine Entscheidung - die Breite steht trotzdem fest.
    _railSettled = true;
    revealToday(_container.querySelector('#week-grid'));
    return;
  }
  const toolbar = _container.querySelector('.meals-toolbar');

  const apply = (hidden) => {
    layout.classList.toggle('meals-layout--rail-hidden', hidden);
    syncPopoverMenuItem(toolbar, 'toggle-rail', !hidden);
  };

  // Default: gemessen, nicht per Breakpoint.
  //
  // Die Rezept-Spalte kostet 272-320px - genau die Breite, die dem Board für
  // die letzten Tage fehlt. Mit ihr zeigte das Board gemessen 4 von 7 Tagen
  // (Critique 2026-07-30). Eine px-Schwelle wäre hier die falsche Antwort: die
  // Zahl der Spalten hängt an den sichtbaren Mahlzeitstypen, und Zoom sowie
  // Schriftgröße verschieben sie zusätzlich. Stattdessen die Frage stellen, um
  // die es geht - passt die Woche mit offener Spalte? -, und nur dann
  // einklappen. Eine bewusste Entscheidung des Nutzers überschreibt den
  // Default dauerhaft (localStorage).
  let hidden = false;
  let gespeichert = null;
  try { gespeichert = localStorage.getItem(RAIL_STORAGE_KEY); } catch { /* ignore */ }
  if (gespeichert) {
    hidden = gespeichert === 'hidden';
  } else {
    const grid = _container.querySelector('#week-grid');
    const desktop = !window.matchMedia?.('(max-width: 639px)').matches;
    hidden = Boolean(desktop && grid && grid.scrollWidth > grid.clientWidth + 1);
  }
  apply(hidden);
  // Jetzt steht die Breite des Boards fest - erst jetzt die Frage, ob „heute"
  // verdeckt ist (revealToday).
  _railSettled = true;
  revealToday(_container.querySelector('#week-grid'));

  item.addEventListener('click', () => {
    hidden = !layout.classList.contains('meals-layout--rail-hidden');
    apply(hidden);
    try { localStorage.setItem(RAIL_STORAGE_KEY, hidden ? 'hidden' : 'shown'); } catch { /* ignore */ }
  });
}

// --------------------------------------------------------
// Wochengitter
// --------------------------------------------------------

/**
 * Aktualisiert NUR Label und Reset-Knopf der Wochen-Navigation - ohne das
 * Wochengitter anzufassen. Eigene Funktion statt zweier Zeilen inline in
 * `renderWeekGrid()` (PR #1200 Review Runde 4, Should-fix 2): der
 * Breakpoint-Handler unten braucht GENAU diese zwei Zeilen, keine der
 * Karten-Neuaufbauten, die im Rest von `renderWeekGrid()` folgen.
 */
function updateWeekLabel() {
  const label = _container?.querySelector('#week-label');
  if (label) label.textContent = formatWeekLabel(state.currentWeek);
  syncTodayButton();
}

/**
 * Der Leerzustand der Woche. Bei `read` nur der ZUSTAND (Regel 9): Knopf,
 * Beschreibung („Plane ...") und Hinweis laden alle zu einer Handlung ein, die
 * es dann nicht gibt.
 */
function emptyWeekOptions() {
  if (readOnly()) return { icon: 'utensils', title: t('meals.emptyTitle') };
  return {
    icon: 'utensils',
    title: t('meals.emptyTitle'),
    description: t('meals.emptyDescription'),
    hint: state.recipes.length ? t('meals.emptyHintRecipes') : t('emptyHint.meals'),
    action: {
      label: t('meals.emptyAction'),
      icon: 'plus',
      onClick: () => openMealModal({
        mode: 'create',
        date: state.currentWeek,
        mealType: state.visibleMealTypes[0] ?? 'lunch',
      }),
    },
  };
}

/**
 * Zeichnet die Woche neu - das Board (ab 1024px) und die Tafla-Woche des
 * Telefons darunter. Alle Schreibwege (Speichern, Loeschen, Verschieben,
 * Transfer) rufen diese eine Funktion, also bleiben beide Ansichten gleich.
 */
function renderWeekGrid() {
  renderBoardGrid();
  renderPhoneWeek();
}

function renderBoardGrid() {
  const grid = _container.querySelector('#week-grid');
  if (!grid) return;

  updateWeekLabel();

  // Fehlgeschlagene Woche: Fehlerzustand statt Leerzustand. Muss VOR der
  // Leer-Prüfung stehen - `state.meals` ist nach einem Fehler ebenfalls leer,
  // und die Reihenfolge ist das Einzige, was die beiden Fälle trennt.
  if (state.loadError) {
    grid.removeAttribute('aria-busy');
    mountLoadError(grid, {
      title: t('meals.loadError'),
      description: t('common.loadErrorDescription'),
      error: state.loadError,
      retryLabel: t('common.retry'),
      onRetry: async () => {
        grid.setAttribute('aria-busy', 'true');
        await loadWeek(state.currentWeek);
        renderWeekGrid();
      },
    });
    return;
  }

  // Leere Woche: Leerzustand statt Slot-Raster.
  //
  // Der Essensplan ist die Default-Landung des Küchen-Moduls und war bis hierher
  // der einzige der vier Tabs ohne Leerzustand - ein neuer Haushalt sah bis zu
  // 28 gestrichelte Kästen ohne ein Wort, während die drei Geschwister je einen
  // vollständigen Leerzustand mit CTA hatten (Critique P0, 2026-07-29).
  //
  // Der Hinweis richtet sich danach, was der Haushalt schon hat: ohne Rezepte
  // nennt er die nächste Station des Kreislaufs (der Plan füllt die
  // Einkaufsliste), mit Rezepten den schnelleren Weg (Rezept direkt einplanen).
  // Die Wochennavigation im Kopf bleibt erreichbar - der Leerzustand ersetzt nur
  // das Raster, nicht die Seite.
  if (!state.meals.length) {
    grid.removeAttribute('aria-busy');
    mountEmptyState(grid, emptyWeekOptions());
    return;
  }

  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(state.currentWeek, i));
  const dayNames = DAY_NAMES();
  // Default-Typ für den mobilen Per-Tag-Add-Button (Modal lässt den Typ ändern).
  const firstType = state.visibleMealTypes[0] ?? 'lunch';
  const visibleTypes = MEAL_TYPES().filter((type) => state.visibleMealTypes.includes(type.key));
  const ro = readOnly();

  // Desktop-Board: Typ-Label EINMAL pro Zeile in der linken Gutter-Spalte statt
  // in jedem der bis zu 28 Slots (Critique P1: 21 redundante, silbengetrennte
  // Labels pro Woche). Mobil unsichtbar (display:none); die Slot-eigenen Labels
  // bleiben dort sichtbar und am Desktop als Screenreader-Text erhalten —
  // darum ist die Gutter-Spalte fürs Accessibility-Tree ein reines Duplikat
  // und wird mit aria-hidden ausgeblendet.
  const gutterHTML = visibleTypes.map((type, ti) => `
    <div class="week-gutter-label" data-type="${type.key}" style="--type-row: ${ti + 2}" aria-hidden="true">
      <span class="week-gutter-label__text">${type.label}</span>
    </div>
  `).join('');

  grid.replaceChildren();
  grid.insertAdjacentHTML('beforeend', gutterHTML + weekDays.map((date, dayIndex) => {
    const mealsForDay = state.meals.filter((m) => m.date === date);
    const todayClass  = isToday(date) ? 'day-header--today' : '';
    // zonedWeekday statt `new Date(key + 'T00:00:00').getDay()`: derselbe Wert,
    // aber ohne den Umweg ueber ein Date der Browser-Zone (#829 Teil 3).
    const dayNameIndex = (zonedWeekday(date) + 6) % 7;
    // Spalte 1 ist die Gutter-Spalte, Zeile 1 die Kopfzeile — Inhalte ab 2.
    const dayCol = dayIndex + 2;

    return `
      <div class="day-column">
        <div class="day-header ${todayClass}" style="--day-col: ${dayCol}">
          <span class="day-header__name">${dayNames[dayNameIndex]}</span>
          <span class="day-header__date">${formatDayDate(date)}</span>
          ${ro ? '' : `<button class="day-add" data-action="add-meal" data-date="${date}" data-type="${firstType}" aria-label="${esc(t('meals.addMealOnDay', { day: dayLongName(date) }))}">
            <i data-lucide="plus" class="icon-md" aria-hidden="true"></i>
            <span class="day-add__label">${t('meals.addMealTitle')}</span>
          </button>`}
        </div>
        <div class="day-slots">
          ${visibleTypes.map((type, ti) => renderSlot(date, type, mealsForDay, dayCol, ti + 2)).join('')}
        </div>
      </div>
    `;
  }).join(''));

  grid.removeAttribute('aria-busy');
  if (window.lucide) lucide.createIcons({ el: grid });
  // Vorschaubilder brauchen ihren Platzhalter-Ruecksturz per Listener (#1059) -
  // ein `onerror` im Markup waere ein Inline-Handler und CSP-verboten.
  wireRecipeThumbs(grid);
  stagger(grid.querySelectorAll('.meal-card'), { host: grid });
  wireGrid(grid);

  // Scroll-Affordance des Desktop-Boards: End-Anriss signalisiert verborgene
  // Tage rechts (Critique-Folgebefund; Muster wie Tab-Leisten/Chip-Zeilen).
  // Einmal binden — der MutationObserver von wireScrollFade deckt spätere
  // replaceChildren-Rerenders ab.
  if (!grid.dataset.fadeWired) {
    grid.dataset.fadeWired = 'true';
    wireScrollFade(grid);
  }

  revealToday(grid);
}


/**
 * Holt den heutigen Tag in den Blick - schmal per Stapel-Scroll, am Board nur,
 * wenn er verdeckt ist.
 *
 * ERST NACH DER REZEPT-SPALTE (Critique 2026-09-26, A4 P1). Die Spalte kostet
 * 272-320px, und ob sie steht, entscheidet wireRailToggle() GEMESSEN am schon
 * gezeichneten Board. Lief die Frage „heute verdeckt?" vorher, sah sie das
 * Board bei offener Spalte (~820px), zentrierte den Samstag, und erst danach
 * klappte die Spalte zu - `scrollLeft` klemmte bei 1440px auf 52px, und der
 * Montag lag unter der Gutter-Spalte, ohne dass jemand gescrollt hatte. Vor
 * der Entscheidung tut diese Funktion deshalb nichts; wireRailToggle() ruft
 * sie danach selbst.
 */
function revealToday(grid) {
  if (!_railSettled || !grid) return;
  // Auf schmalen Viewports (gestapelte Tage) den heutigen Tag in den Blick scrollen.
  if (window.matchMedia?.('(max-width: 639px)').matches) {
    grid.querySelector('.day-header--today')?.closest('.day-column')
      ?.scrollIntoView({ block: 'start' });
  } else if (grid.scrollWidth > grid.clientWidth + 1) {
    // Desktop-Board mit horizontalem Scroll-Fenster: heutigen Tag in den Blick
    // holen - aber NUR, wenn er nicht ohnehin sichtbar ist.
    //
    // Vorher zentrierte diese Zeile unbedingt und erzeugte damit `scrollLeft`
    // von 156px, obwohl heute (Mittwoch) längst im Fenster lag. Der erste
    // Wochentag rutschte dadurch hinter die sticky Gutter-Spalte, deren
    // opaker Hintergrund ihn vollständig verdeckte: Montag war bei jedem Laden
    // reproduzierbar unsichtbar, ohne jeden Hinweis (Critique 2026-07-30).
    // Die Woche beginnt jetzt bei Montag, solange heute im Blick ist.
    const todayHeader = grid.querySelector('.day-header--today');
    if (todayHeader) {
      const gridBox = grid.getBoundingClientRect();
      const todayBox = todayHeader.getBoundingClientRect();
      const gutter = grid.querySelector('.week-gutter-label')?.getBoundingClientRect().width ?? 0;
      const verdeckt = todayBox.left < gridBox.left + gutter || todayBox.right > gridBox.right;
      if (verdeckt) todayHeader.scrollIntoView({ inline: 'center', block: 'nearest' });
    }
  }
}

function renderRecipeSidebar() {
  const sidebar = _container.querySelector('#recipe-sidebar');
  if (!sidebar) return;
  sidebar.replaceChildren();

  const title = document.createElement('h2');
  title.className = 'recipe-sidebar__title';
  title.textContent = t('nav.recipes');
  sidebar.appendChild(title);

  // Der Drag-Hinweis erscheint nur, wenn es etwas zu ziehen gibt. Vorher stand
  // „Ziehe Rezepte auf Essens-Slots" unbedingt da - bei leerem Haushalt direkt
  // über „Noch keine Rezepte", also eine Anleitung für etwas, das es nicht gibt.
  // Das war der einzige Text auf dem ersten Screen des Moduls und widersprach
  // sich selbst (Critique P0, 2026-07-29).
  if (!state.recipes.length) {
    // Geteilter Renderer statt nacktem Satz: das Panel war die fünfte Leerfläche
    // im Modul und die einzige, die den Renderer umging - ohne Icon, ohne CTA,
    // direkt neben dem gestalteten Leerzustand des Boards (Critique 2026-07-30).
    sidebar.appendChild(emptyStateEl({
      icon: 'book-text',
      title: t('recipes.emptyTitle'),
      description: t('recipes.emptyDescription'),
      action: {
        label: t('recipes.emptyAction'),
        icon: 'plus',
        onClick: () => window.yuvomi?.navigate('/recipes'),
      },
    }));
    if (window.lucide) window.lucide.createIcons({ el: sidebar });
    return;
  }

  const hint = document.createElement('p');
  hint.className = 'recipe-sidebar__hint';
  // Antippen ODER Ziehen (Re-Kritik 2026-09-28): der alte Satz nannte nur das
  // Ziehen, und genau das geht per Tastatur und fuer viele Haende nicht.
  hint.textContent = t('recipes.railHint');
  sidebar.appendChild(hint);

  const list = document.createElement('div');
  list.className = 'recipe-sidebar__list';

  state.recipes.forEach((recipe) => {
    const card = document.createElement('article');
    card.className = 'recipe-sidebar__card';
    card.draggable = true;
    card.dataset.recipeId = String(recipe.id);

    // DIE KARTE IST EIN KNOPF (Re-Kritik 2026-09-28, A4 P1-1). Sie war nur zu
    // ziehen: ohne Fokus, ohne Klick - per Tastatur kam kein Rezept in den
    // Plan, und ein Tipp auf die Karte tat nichts. Der Knopf fuellt die Karte
    // und oeffnet "Mahlzeit hinzufuegen" mit gesetztem Rezept
    // (planRecipeFromRail); das Ziehen bleibt am `article` als Beschleuniger.
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'recipe-sidebar__card-open';
    open.dataset.action = 'plan-recipe';
    open.dataset.recipeId = String(recipe.id);
    open.setAttribute('aria-label', t('meals.planRecipeNamed', { name: recipe.title }));
    card.appendChild(open);

    const titleEl = document.createElement('span');
    titleEl.className = 'recipe-sidebar__card-title';
    titleEl.textContent = recipe.title;
    open.appendChild(titleEl);

    if (recipe.source !== 'native') {
      const sourceBadgeEl = document.createElement('span');
      sourceBadgeEl.className = `source-badge source-badge--${recipe.source}`;
      sourceBadgeEl.textContent = t(`recipes.source${recipe.source[0].toUpperCase()}${recipe.source.slice(1)}`);
      if (recipe.provider_account_name) sourceBadgeEl.title = recipe.provider_account_name;
      open.appendChild(sourceBadgeEl);
    }

    // Mahlzeiten-Chips nur bei echter Teilmenge: ein Rezept, das zu allen Typen
    // passt, trägt mit "überall"-Chips null Information und ist dann das
    // lauteste Element der Karte (Audit P2, Muster wie recipes.js showBadges).
    // Der leere Fall ist seit #750 die Gegenprobe und keine Teilmenge mehr: Er
    // sagt „nur von Hand", denn der Zufallsvorschlag übergeht dieses Rezept.
    const recipeTypes = normalizeRecipeMealTypes(recipe.meal_types);
    const allTypeOptions = recipeMealTypeOptions();
    if (recipeTypes.length && recipeTypes.length < allTypeOptions.length) {
      const types = document.createElement('div');
      types.className = 'recipe-sidebar__card-types';
      allTypeOptions
        .filter((option) => recipeTypes.includes(option.key))
        .forEach((option) => {
          const badge = document.createElement('span');
          badge.className = `meal-type-badge meal-type-badge--${option.key}`;
          badge.textContent = option.label;
          types.appendChild(badge);
        });
      open.appendChild(types);
    } else if (!recipeTypes.length) {
      const types = document.createElement('div');
      types.className = 'recipe-sidebar__card-types';
      const badge = document.createElement('span');
      badge.className = 'meal-type-badge meal-type-badge--none';
      badge.textContent = t('recipes.mealTypeNone');
      types.appendChild(badge);
      open.appendChild(types);
    }

    list.appendChild(card);
  });

  sidebar.appendChild(list);
}

/**
 * Ist das Rezeptmodul fuer diesen Haushalt ueberhaupt erreichbar?
 *
 * Ein Admin kann Rezepte abschalten und Mahlzeiten anlassen; bestehende Essen
 * behalten ihre `recipe_id`, aber `/recipes` leitet dann auf die Startseite um.
 * Ein Knopf, der dorthin zeigt, waere ein Versprechen ins Leere - und weil er
 * dem externen Link vorgeht, naehme er auch den noch mit (#936).
 */
function recipesReachable() {
  return !window.yuvomi?.isModuleDisabled?.('recipes');
}

function renderSlot(date, type, mealsForDay, dayCol, typeRow) {
  const meals = mealsForDay.filter((m) => m.meal_type === type.key);
  // Explizite Grid-Platzierung fürs Desktop-Board (day-column/day-slots werden
  // dort zu display:contents); mobil ohne Wirkung, da die Slots im Fluss liegen.
  const gridPos = `--day-col: ${dayCol}; --type-row: ${typeRow}`;
  // Bei `read` bleibt vom Platz der ZUSTAND - leer oder belegt -, jede Handlung
  // daran geht (Regel 2): die Plus-Knoepfe, der Ziehgriff und das Loeschen.
  const ro = readOnly();

  if (!meals.length) {
    if (ro) {
      return `
      <div class="meal-slot meal-slot--empty meal-slot--static" data-date="${date}" data-type="${type.key}" style="${gridPos}">
        <div class="meal-slot__type-label"><span class="meal-slot__type-text">${type.label}</span></div>
      </div>
    `;
    }
    return `
      <div class="meal-slot meal-slot--empty" data-date="${date}" data-type="${type.key}" style="${gridPos}">
        <div class="meal-slot__type-label"><span class="meal-slot__type-text">${type.label}</span></div>
        <button
          class="meal-slot__add-btn"
          data-action="add-meal"
          data-date="${date}"
          data-type="${type.key}"
          aria-label="${esc(t('meals.addMealTypeOnDay', { type: type.label, day: dayLongName(date) }))}"
        >
          <i data-lucide="plus" class="icon-md" aria-hidden="true"></i>
        </button>
      </div>
    `;
  }

  // Die Aktions-Labels NENNEN ihre Mahlzeit („Fluffige Pancakes loeschen"):
  // vorher trugen alle Karten dieselben drei Saetze, und ein Screenreader, der
  // die Woche durchgeht, hoerte 25x „Mahlzeit loeschen" ohne Bezug (Critique
  // 2026-08-27, Persona Sam). Dasselbe Muster wie im Einkauf („Brokkoli
  // abhaken", shopping.markDoneLabel).
  const cardsHTML = meals.map((meal) => {
    const ownCount    = meal.ingredients?.length ?? 0;
    const ingDone     = meal.ingredients?.filter((i) => i.on_shopping_list).length ?? 0;
    // Aus einem Rezept geplante Mahlzeiten haben noch keine eigenen Zutaten;
    // der Server liefert dafür die Zahl aus dem Rezept mit. Sonst bliebe der
    // Einkaufslisten-Button genau dort aus, wo die Zutaten längst bekannt sind
    // (Critique 2026-07-29: sichtbar auf 1 von 22 Karten). Der erste Transfer
    // materialisiert sie, danach zählt wieder ownCount.
    const recipeCount = ownCount === 0 ? (meal.recipe_ingredient_count ?? 0) : 0;
    const ingCount    = ownCount || recipeCount;
    const ingLabel    = ingCount > 0 ? t('meals.ingredientCount', { count: ingCount }) : '';
    const ingDoneLabel = ownCount > 0 && ingDone === ownCount ? ' ✓' : '';
    // Und nur, wenn der Server den Transfer annaehme: Pfad-Guard (`meals`) UND
    // Einkaufs-Recht (#1290). Ohne eines davon endete der Knopf im 403.
    const canTransfer  = (recipeCount > 0 || (ownCount > 0 && ingDone < ownCount))
      && mayTransferMealToShopping(meal.id);
    // WER KOCHT, STEHT IN DER META-ZEILE, NICHT IM TITEL (#1679). Der Titel ist
    // an jeder Breite der knappste Platz der Karte - 148px am Board, eine
    // Zeile neben Griff und Aktionen am Telefon - und jedes Zeichen dort kostet
    // ihn Buchstaben. Die Zeile darunter traegt schon die Zutatenzahl und hat
    // Luft; der Avatar steht davor. Bei `read` bleibt er stehen: er ist
    // Zustand, keine Handlung (Regel 2).
    const cookMark = mealCookMarkHtml(meal);
    const recurrenceBadge = meal.recurrence_template_id
      ? `<span class="meal-card__recurrence" aria-label="${t('meals.recurrenceBadge')}"><i data-lucide="repeat-2" class="icon-sm" aria-hidden="true"></i></span>`
      : '';

    // Die Karte ist bewusst KEIN Button: sie trägt Buttons und einen Link, und
    // interaktiver Inhalt in einem Button ist invalides HTML - Screenreader
    // verlieren dann die inneren Aktionen (Critique 2026-08-17). Das Öffnen
    // gehört der Titelfläche; die Aktionen stehen daneben, nicht darin.
    //
    // Der Ziehgriff (#1317) gehoert der schmalen Zeile. Dort liegt der
    // Wochenplan im vertikalen Scroller (.app-content, pan-y), und der Browser
    // nahm jeden Zug an der Karte als Scroll und brach den Pointer mit
    // pointercancel ab. Der Griff traegt als einzige Stelle `touch-action:
    // none` (meals.css), der Rest der Zeile bleibt dem Scrollen. Kein Button:
    // wie im Kategorie-Manager (role="img") ist er eine Zeigergeste ohne eigene
    // Tastaturhandlung - der Weg ohne Zeiger ist das Datum im Bearbeiten-
    // Dialog. Er steht AUSSERHALB von .meal-card__actions, die wireDragDrop
    // ausnimmt. Ausserhalb der schmalen Fassung ist er ausgeblendet: dort
    // greift die Maus weiter die ganze Karte.
    //
    // DER TYP STEHT ALS VORSATZ IM TITEL (R9 M6). Mobil ist eine Mahlzeit eine
    // Zeile im Tagestraeger, und das Typ-Label kostete dort eine eigene
    // Overline-Zeile ueber jeder Karte. `.meal-card__type` steht deshalb vor
    // dem Namen und ist nur in der schmalen Fassung sichtbar (meals.css); am
    // Board und am Tablet traegt weiter das Slot-Label den Typ. Nebenbei nennt
    // der Oeffnen-Knopf damit mobil auch die Mahlzeit, nicht nur das Gericht.
    return `
      <div class="meal-card" data-meal-id="${meal.id}">
        <button type="button" class="meal-card__open${(meal.recipe_has_own_image || meal.recipe_has_image) ? ' meal-card__open--with-thumb' : ''}"
           data-action="${ro ? 'meal-details' : 'edit-meal'}"
           data-meal-id="${meal.id}">
          ${(meal.recipe_has_own_image || meal.recipe_has_image) ? recipeThumbHtml({
            recipeId: meal.recipe_id,
            hasImage: meal.recipe_has_image,
            hasOwnImage: meal.recipe_has_own_image,
            className: 'meal-card__thumb',
          }) : ''}
          <span class="meal-card__title"><span class="meal-card__type">${esc(type.label)}</span><span class="meal-card__title-text">${esc(meal.title)}</span>${recurrenceBadge}</span>
          ${ingLabel || cookMark ? `<span class="meal-card__meta">
            ${cookMark}${ingLabel ? `<span class="meal-card__ingredients-count">${ingLabel}${esc(ingDoneLabel)}</span>` : ''}
          </span>` : ''}${ro ? readRowHintHtml() : ''}
        </button>
        ${ro ? '' : `<span class="meal-card__drag" role="img"
              aria-label="${esc(t('meals.dragHandle', { title: meal.title }))}">
          <i data-lucide="grip-vertical" class="icon-md" aria-hidden="true"></i>
        </span>`}
        <div class="meal-card__actions">
          ${meal.recipe_id && recipesReachable() ? `<a class="meal-card__action-btn meal-card__action-btn--recipe"
            data-action="open-linked-recipe"
            href="/recipes?open=${encodeURIComponent(meal.recipe_id)}"
            aria-label="${esc(t('meals.viewRecipeNamed', { title: meal.title }))}"
          ><i data-lucide="chef-hat" class="icon-md" aria-hidden="true"></i></a>`
          : meal.recipe_url ? `<a class="meal-card__action-btn meal-card__action-btn--recipe"
            data-action="open-recipe"
            href="${esc(meal.recipe_url)}"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="${esc(t('meals.openRecipeNamed', { title: meal.title }))}"
          ><i data-lucide="link" class="icon-md" aria-hidden="true"></i></a>` : ''}
          ${canTransfer ? `<button class="meal-card__action-btn meal-card__action-btn--shopping"
            data-action="transfer-meal"
            data-meal-id="${meal.id}"
            aria-label="${esc(t('common.toShoppingListNamed', { title: meal.title }))}"
          ><i data-lucide="shopping-cart" class="icon-md" aria-hidden="true"></i></button>` : ''}
${/* KEIN PAPIERKORB AUF DER KARTE (Entscheidung 2026-10-07, benannte
               Ausnahme vom Mehr-Knopf): 27 Karten trugen als einziges
               wiederkehrendes Zeichen einen Papierkorb. Loeschen lebt im
               Dialog der Mahlzeit, links im Fuss - einen Tipp auf die Karte
               entfernt und mobil seit R8 der einzige Weg. Ein Mehr-Knopf mit
               einem Eintrag waere dieselbe Dichte fuer denselben Weg. */ ''}
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="meal-slot meal-slot--has-meal" data-date="${date}" data-type="${type.key}" style="${gridPos}">
      <div class="meal-slot__type-label"><span class="meal-slot__type-text">${type.label}</span></div>
      ${cardsHTML}
      ${/* DAS PLUS STEHT NUR IN LEEREN ZELLEN (Critique 2026-10-16, D5). Unter
            jeder belegten Zelle lag eine gestrichelte „+"-Leiste: am Desktop
            28 Plus in einer Woche, eins je Zelle, belegt oder nicht. Eine
            zweite Mahlzeit in denselben Platz legt der FAB - sein Dialog
            fragt Tag und Mahlzeit. */ ''}
    </div>
  `;
}

// --------------------------------------------------------
// Tafla: die Woche am Telefon (unter 1024px)
//
// Darunter steht das Board nicht mehr, sondern EINE ruhige Liste: Wochenkopf
// mit Streifen (sieben Tage, heute violett, vier Punkte je Tag), die heutige
// Kolacja als Herd-Karte mit Zutatenzaehler und "Gotuj", danach die Tage als
// gruppierte Karten mit 56er-Zeilen. Vergangene Tage der laufenden Woche
// liegen hinter EINER Zeile "Wcześniej w tym tygodniu". Die Daten sind
// dieselben wie am Board (state.meals), geschrieben wird ueber dieselben Wege
// (openMealModal, transferMeal, deleteMeal) - renderWeekGrid() zeichnet beide.
// --------------------------------------------------------

/** Mahlzeit-Zeichen der Zeilen: der Tagesverlauf, keine Farbe. */
const PHONE_SLOT_ICON = { breakfast: 'sunrise', lunch: 'sun', dinner: 'sunset', snack: 'apple' };
const STRIP_DAY_KEYS = ['meals.stripMo', 'meals.stripTu', 'meals.stripWe', 'meals.stripTh', 'meals.stripFr', 'meals.stripSa', 'meals.stripSu'];
/** Die Mahlzeit im Akkusativ fuer "Dodaj kolację" - nur fuer die eingebauten Namen. */
const MEAL_TYPE_ACC_KEYS = { breakfast: 'meals.typeAccBreakfast', lunch: 'meals.typeAccLunch', dinner: 'meals.typeAccDinner', snack: 'meals.typeAccSnack' };
const BUILT_IN_TYPE_KEYS = { breakfast: 'meals.typeBreakfast', lunch: 'meals.typeLunch', dinner: 'meals.typeDinner', snack: 'meals.typeSnack' };
const DAY_ACC_KEYS = ['meals.dayAccSunday', 'meals.dayAccMonday', 'meals.dayAccTuesday', 'meals.dayAccWednesday', 'meals.dayAccThursday', 'meals.dayAccFriday', 'meals.dayAccSaturday'];
/** Wie lange ein Finger liegen muss, bis die Zeile ihr Menue oeffnet. */
const LONG_PRESS_MS = 450;

function dateFromKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1, 12));
}

function dateParts(key, options) {
  try {
    return new Intl.DateTimeFormat(getLocale(), { ...options, timeZone: 'UTC' }).formatToParts(dateFromKey(key));
  } catch {
    return [];
  }
}

const partOf = (parts, type) => (parts.find((p) => p.type === type)?.value ?? '').replace(/\.$/, '');

/** "czw 22 paź" - Wochentag, Tag, Monat, ohne Satzzeichen. */
function shortDayLabel(key) {
  const parts = dateParts(key, { weekday: 'short', day: 'numeric', month: 'short' });
  const text = `${partOf(parts, 'weekday')} ${partOf(parts, 'day')} ${partOf(parts, 'month')}`.trim();
  return text || formatDayMonth(key);
}

/** "20 paź". */
function dayMonthLabel(key) {
  const parts = dateParts(key, { day: 'numeric', month: 'short' });
  const text = `${partOf(parts, 'day')} ${partOf(parts, 'month')}`.trim();
  return text || formatDayMonth(key);
}

/**
 * "19-25 paź" (Intl.formatRange in der Sprache der App). Der Halbgeviertstrich
 * der Formatierung wird zum Bindestrich - die Projektregel fuer UI-Texte, wie
 * im Wochenlabel des Boards (formatWeekLabel).
 */
function weekRangeLabel(monday) {
  const sunday = addDays(monday, 6);
  try {
    const fmt = new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC' });
    if (typeof fmt.formatRange === 'function') {
      // "19-25 pa\u017a" zwischen zwei Ziffern, sonst mit Luft: "26 pa\u017a - 1 lis".
      return fmt.formatRange(dateFromKey(monday), dateFromKey(sunday))
        .replace(/(\d?)\s*[\u2013\u2014]\s*(\d?)/g, (_, before, after) => (before && after ? `${before}-${after}` : `${before} - ${after}`));
    }
  } catch { /* Rueckfall unten */ }
  return `${dayMonthLabel(monday)} - ${dayMonthLabel(sunday)}`;
}

/** Der Name der Mahlzeit fuer Saetze ("Dodaj kolację"); eigene Namen des Haushalts klein. */
function mealTypeInSentence(key) {
  const label = mealTypeLabel(key);
  const builtIn = BUILT_IN_TYPE_KEYS[key];
  if (builtIn && label === t(builtIn) && MEAL_TYPE_ACC_KEYS[key]) return t(MEAL_TYPE_ACC_KEYS[key]);
  return label ? label.charAt(0).toLocaleLowerCase(getLocale()) + label.slice(1) : '';
}

function lowerFirst(text) {
  const value = String(text ?? '');
  return value ? value.charAt(0).toLocaleLowerCase(getLocale()) + value.slice(1) : value;
}

function upperFirst(text) {
  const value = String(text ?? '');
  return value ? value.charAt(0).toLocaleUpperCase(getLocale()) + value.slice(1) : value;
}

// ---- Vorrat und Einkaufsliste: "masz" und "na liście" ----

/**
 * Was der Vorrat hat - fuer "Masz 5 z 6" und die "masz"-Chips im Dialog. Ohne
 * Vorratsmodul oder ohne Leserecht bleibt `null`: dann gibt es keinen Zaehler,
 * statt eines, der alles als fehlend zeigt.
 */
async function loadPantry() {
  if (window.yuvomi?.isModuleDisabled?.('pantry')) { state.pantry = null; return; }
  try {
    const res = await api.get('/pantry');
    state.pantry = Array.isArray(res?.data) ? res.data : null;
  } catch {
    state.pantry = null;
  }
}

/** Namen, die offen (nicht abgehakt) auf einer Einkaufsliste stehen. */
async function loadListedNames() {
  const keys = new Set();
  if (!window.yuvomi?.isModuleDisabled?.('shopping')) {
    await Promise.all((state.lists ?? []).slice(0, 6).map(async (list) => {
      try {
        const res = await api.get(`/shopping/${list.id}/items`);
        for (const item of res?.data ?? []) if (!item.is_checked) keys.add(mealNameKey(item.name));
      } catch { /* eine Liste, die nicht laedt, zaehlt nicht */ }
    }));
  }
  state.listedKeys = keys;
}

const NAME_FOLD = { ł: 'l', Ł: 'l', đ: 'd', ø: 'o', ß: 'ss' };

/** Derselbe Schluessel wie am Server (server/utils/name-key.js). */
function mealNameKey(value) {
  return String(value ?? '')
    .replace(/[łŁđøß]/g, (ch) => NAME_FOLD[ch])
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** "pomidory w puszce" passt zu "pomidory", "sól" zu "sól morska" - wie inPantry() am Server. */
function namesMatch(a, b) {
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `);
}

function inPantry(name) {
  if (!Array.isArray(state.pantry)) return false;
  const key = mealNameKey(name);
  return state.pantry.some((p) => (p.quantity == null || Number(p.quantity) > 0) && namesMatch(key, mealNameKey(p.name)));
}

function isListed(name) {
  const key = mealNameKey(name);
  for (const listed of state.listedKeys ?? []) if (namesMatch(key, listed)) return true;
  return false;
}

function recipeOf(meal) {
  return meal?.recipe_id ? state.recipes.find((r) => r.id === meal.recipe_id) ?? null : null;
}

/**
 * Die Zutaten einer Mahlzeit gegen Vorrat und Liste. Das Rezept fuehrt (es kennt
 * alle Zutaten, die Mahlzeit traegt oft nur, was zu kaufen war); ohne Rezept
 * die eigenen Zutaten. `null`, wenn es nichts zu zaehlen gibt.
 */
function ingredientMeter(meal) {
  if (!Array.isArray(state.pantry)) return null;
  const recipe = recipeOf(meal);
  const source = recipe?.ingredients?.length ? recipe.ingredients : (meal.ingredients ?? []);
  if (!source.length) return null;
  const own = new Map((meal.ingredients ?? []).map((ing) => [mealNameKey(ing.name), ing]));
  return source.map((ing) => {
    const have = inPantry(ing.name);
    const listed = !have && (Boolean(own.get(mealNameKey(ing.name))?.on_shopping_list) || isListed(ing.name));
    return { name: ing.name, have, listed };
  });
}

function meterCaption(rows) {
  const total = rows.length;
  const have = rows.filter((r) => r.have).length;
  const missing = rows.filter((r) => !r.have);
  const unlisted = missing.filter((r) => !r.listed);
  if (!missing.length) return { text: t('meals.meterAll'), done: true };
  if (!unlisted.length) {
    if (!have) return { text: t('meals.meterEverythingListed'), done: true };
    const tail = missing.length === 1 ? t('meals.meterOneListed', { name: lowerFirst(missing[0].name) }) : t('meals.meterRestListed');
    return { text: `${t('meals.meterHave', { have, total })} · ${tail}`, done: true };
  }
  const listed = missing.length - unlisted.length;
  const tail = unlisted.length === 1
    ? t('meals.meterOneMissing', { name: lowerFirst(unlisted[0].name) })
    : t('meals.meterMissing', { count: unlisted.length });
  const parts = [
    have ? t('meals.meterHave', { have, total }) : '',
    listed ? t('meals.meterListedCount', { count: listed }) : '',
    tail,
  ].filter(Boolean);
  return { text: upperFirst(parts.join(' · ')), done: false };
}

/** Der Zaehler: ein Segment je Zutat, Tinte = da, Bernstein = fehlt. */
function meterHtml(rows) {
  const caption = meterCaption(rows);
  const segments = [...rows].sort((a, b) => Number(b.have) - Number(a.have)).map((r) => `<span class="meals-meter__seg${r.have ? '' : ' meals-meter__seg--missing'}"></span>`).join('');
  return `
    <div class="meals-meter">
      <span class="meals-meter__bar" aria-hidden="true">${segments}</span>
      <span class="meals-meter__caption"><span class="meals-meter__text">${esc(caption.text)}</span>${caption.done ? '<i data-lucide="check" class="meals-meter__check" aria-hidden="true"></i>' : ''}</span>
    </div>`;
}

/** Ein Teller-Zeichen statt eines Fotos - nach dem Namen, sonst Besteck. */
function plateIcon(title) {
  const key = mealNameKey(title);
  if (/zup|krem|rosol|barszcz|spaghetti|makaron|pasta|risotto|soup|curry|tikka|gulasz/.test(key)) return 'soup';
  if (/salat|salad/.test(key)) return 'salad';
  if (/loso|ryb|dorsz|fish|salmon|tunczyk/.test(key)) return 'fish';
  if (/pizz/.test(key)) return 'pizza';
  if (/kanap|tost|sandw|bulk|chleb/.test(key)) return 'sandwich';
  if (/jajk|jajecz|omlet|egg/.test(key)) return 'egg';
  if (/kaw|coffee/.test(key)) return 'coffee';
  return 'utensils';
}

function plateHtml(meal, className) {
  if (meal.recipe_has_own_image || meal.recipe_has_image) {
    return recipeThumbHtml({
      recipeId: meal.recipe_id,
      hasImage: meal.recipe_has_image,
      hasOwnImage: meal.recipe_has_own_image,
      className,
    });
  }
  return `<span class="${className} meals-plate" aria-hidden="true"><i data-lucide="${plateIcon(meal.title)}" class="meals-plate__icon"></i></span>`;
}

// ---- Markup ----

function phoneWeekShellHtml() {
  return `
      <div class="meals-phone page-scrollport" id="meals-phone">
        <div class="meals-phone__head" id="meals-phone-head"></div>
        <div class="meals-phone__body" id="meals-phone-body">
          <div class="meals-phone__skeleton">${renderSkeletonList({ rows: 4, lines: 2 })}</div>
        </div>
      </div>`;
}

function weekOffset() {
  const thisMonday = getMondayOf(todayKey());
  const diff = Math.round((dateFromKey(state.currentWeek) - dateFromKey(thisMonday)) / 86_400_000);
  return Math.round(diff / 7);
}

function weekPickerHtml() {
  const offset = weekOffset();
  const label = offset === 0 ? t('meals.weekThis')
    : offset === 1 ? t('meals.nextWeek')
      : offset === -1 ? t('meals.prevWeek')
        : t('meals.weekOther');
  const ro = readOnly();
  const items = [
    { action: 'phone-week-prev', label: t('meals.prevWeek'), icon: 'chevron-left' },
    { action: 'phone-week-today', label: t('meals.weekThis'), icon: 'calendar-check' },
    { action: 'phone-week-next', label: t('meals.nextWeek'), icon: 'chevron-right' },
    ...(!ro && state.recipes.length ? [{ separator: true }, { action: 'randomize-plan', label: t('meals.randomizePlan'), icon: 'shuffle' }] : []),
    ...(!ro && state.ideasReady ? [{ action: 'phone-meal-ideas', label: t('meals.ideasMenu'), icon: 'sparkles' }] : []),
  ];
  // Der Ausloeser traegt sein Wort sichtbar ("Ten tydzień ▾") - die geteilte
  // Fassung kennt nur das Icon, also kommt der Text vor das Zeichen.
  return popoverMenuHtml({
    id: 'meals-week-menu',
    label: `${label}, ${t('meals.weekPickerLabel')}`,
    items,
    triggerClass: 'meals-week__pick',
    icon: 'chevron-down',
  }).replace('<i data-lucide="chevron-down"', `<span class="meals-week__pick-label">${esc(label)}</span><i data-lucide="chevron-down"`);
}

function stripHtml() {
  const today = todayKey();
  const types = state.visibleMealTypes.length ? state.visibleMealTypes : MEAL_TYPE_KEYS;
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(state.currentWeek, i);
    const dayMeals = state.meals.filter((m) => m.date === date);
    const planned = types.filter((type) => dayMeals.some((m) => m.meal_type === type)).length;
    const isTodayCell = date === today;
    const past = date < today;
    const dots = types.map((type) => `<span class="meals-strip__dot${dayMeals.some((m) => m.meal_type === type) ? ' meals-strip__dot--on' : ''}"></span>`).join('');
    const status = planned ? t('meals.stripPlanned', { planned, total: types.length }) : t('meals.stripNothing');
    const name = `${dayLongName(date)} ${dayMonthLabel(date)}${isTodayCell ? `, ${lowerFirst(t('meals.today'))}` : ''}, ${status}`;
    return `
      <button type="button" class="meals-strip__day${isTodayCell ? ' meals-strip__day--today' : ''}${past ? ' meals-strip__day--past' : ''}"
              data-action="phone-day" data-date="${date}" aria-label="${esc(name)}"${isTodayCell ? ' aria-current="date"' : ''}>
        <span class="meals-strip__weekday" aria-hidden="true">${esc(t(STRIP_DAY_KEYS[i]))}</span>
        <span class="meals-strip__num" aria-hidden="true">${esc(String(Number(date.slice(8))))}</span>
        <span class="meals-strip__dots" aria-hidden="true">${dots}</span>
      </button>`;
  }).join('');
}

function phoneHeadHtml() {
  const offset = weekOffset();
  return `
    <section class="meals-week" aria-label="${esc(t('meals.weekRangeAria', { range: weekRangeLabel(state.currentWeek) }))}">
      <div class="meals-week__head">
        <span class="meals-week__range">${esc(weekRangeLabel(state.currentWeek))}</span>
        <span class="meals-week__nav">
          ${offset !== 0 ? `<button type="button" class="meals-week__today" data-action="phone-week-today">${esc(t('meals.todayShort'))}</button>` : ''}
          ${weekPickerHtml()}
        </span>
      </div>
      <div class="meals-strip" role="group" aria-label="${esc(t('meals.stripLabel'))}">${stripHtml()}</div>
    </section>`;
}

/** Die Zeile "gotuje Ola" - nur, wenn nicht der Betrachter selbst kocht. */
function phoneMetaText(meal) {
  const bits = [];
  if (meal.notes) bits.push(String(meal.notes).split('\n')[0]);
  const cook = mealCook(meal);
  if (cook && cook.id !== state.userId && cook.display_name) bits.push(t('meals.metaCook', { name: cook.display_name }));
  return bits.join(' · ');
}

function phoneMealRowHtml(meal) {
  const ro = readOnly();
  const typeLabel = mealTypeLabel(meal.meal_type);
  const meta = phoneMetaText(meal);
  const ownCount = meal.ingredients?.length ?? 0;
  const ingDone = meal.ingredients?.filter((i) => i.on_shopping_list).length ?? 0;
  const recipeCount = ownCount === 0 ? (meal.recipe_ingredient_count ?? 0) : 0;
  const canTransfer = !ro && (recipeCount > 0 || (ownCount > 0 && ingDone < ownCount)) && mayTransferMealToShopping(meal.id);
  const recipeLink = meal.recipe_id && recipesReachable()
    ? `<a class="meals-row__action" data-action="open-linked-recipe" href="/recipes?open=${encodeURIComponent(meal.recipe_id)}"
          aria-label="${esc(t('meals.viewRecipeNamed', { title: meal.title }))}"><i data-lucide="chef-hat" aria-hidden="true"></i></a>`
    : '';
  const cart = canTransfer
    ? `<button type="button" class="meals-row__action" data-action="transfer-meal" data-meal-id="${meal.id}"
          aria-label="${esc(t('common.toShoppingListNamed', { title: meal.title }))}"><i data-lucide="shopping-cart" aria-hidden="true"></i></button>`
    : '';
  return `
    <div class="meals-row" data-meal-id="${meal.id}">
      <span class="meals-row__glyph" role="img" aria-label="${esc(typeLabel)}"><i data-lucide="${PHONE_SLOT_ICON[meal.meal_type] ?? 'utensils'}" aria-hidden="true"></i></span>
      <button type="button" class="meals-row__main" data-action="${ro ? 'meal-details' : 'edit-meal'}" data-meal-id="${meal.id}">
        <span class="meals-row__title">${esc(meal.title)}</span>
        ${meta ? `<span class="meals-row__meta">${esc(meta)}</span>` : ''}
      </button>
      ${recipeLink || cart ? `<span class="meals-row__actions">${recipeLink}${cart}</span>` : ''}
    </div>`;
}

/** Die Tage, an denen der "Pomysł"-Chip steht: heute und die naechste leere Kolacja. */
function ideaSlots(days) {
  const out = new Set();
  if (!state.ideasReady || readOnly()) return out;
  const today = todayKey();
  for (const type of state.visibleMealTypes) {
    if (!state.meals.some((m) => m.date === today && m.meal_type === type)) out.add(`${today}|${type}`);
  }
  const nextDinner = days.find((d) => d > today && !state.meals.some((m) => m.date === d && m.meal_type === 'dinner'));
  if (nextDinner && state.visibleMealTypes.includes('dinner')) out.add(`${nextDinner}|dinner`);
  return out;
}

function phoneEmptyRowHtml(date, type, withIdea) {
  const label = mealTypeLabel(type);
  return `
    <div class="meals-row meals-row--empty">
      <span class="meals-row__glyph" role="img" aria-label="${esc(label)}"><i data-lucide="${PHONE_SLOT_ICON[type] ?? 'utensils'}" aria-hidden="true"></i></span>
      <button type="button" class="meals-row__main meals-row__add" data-action="add-meal" data-date="${date}" data-type="${type}"
              aria-label="${esc(t('meals.addMealTypeOnDay', { type: label, day: dayLongName(date) }))}">
        <span class="meals-row__title">+ ${esc(label)}</span>
      </button>
      ${withIdea ? `<button type="button" class="meals-chip meals-chip--ai" data-action="phone-idea" data-date="${date}" data-type="${type}"
              aria-label="${esc(t('meals.ideaAria', { meal: mealTypeInSentence(type), day: dayLongName(date) }))}">
        <i data-lucide="sparkles" aria-hidden="true"></i><span>${esc(t('meals.idea'))}</span>
      </button>` : ''}
    </div>`;
}

/**
 * Die Zeilen eines Tages. `skip` nimmt die Mahlzeit heraus, die oben als Held
 * steht; `skipType` den leeren Platz, den die Herd-Karte schon anbietet.
 */
function phoneDayRowsHtml(date, { skip = null, skipType = null, ideas = new Set() } = {}) {
  const ro = readOnly();
  const rows = [];
  for (const type of state.visibleMealTypes) {
    const meals = state.meals.filter((m) => m.date === date && m.meal_type === type && m !== skip);
    if (meals.length) {
      for (const meal of meals) rows.push(phoneMealRowHtml(meal));
    } else if (!(skip && skip.meal_type === type) && type !== skipType && !ro) {
      rows.push(phoneEmptyRowHtml(date, type, ideas.has(`${date}|${type}`)));
    }
  }
  if (!rows.length) {
    rows.push(`<div class="meals-row meals-row--quiet"><span class="meals-row__title">${esc(t('meals.noMealPlanned'))}</span></div>`);
  }
  return rows.join('');
}

function phoneDaySectionHtml(date, { heading, headingClass = '', skip = null, skipType = null, ideas }) {
  return `
    <section class="meals-day" data-date="${date}" aria-label="${esc(`${dayLongName(date)} ${dayMonthLabel(date)}`)}">
      <h2 class="meals-day__title${headingClass}">${esc(heading)}</h2>
      <div class="meals-card">${phoneDayRowsHtml(date, { skip, skipType, ideas })}</div>
    </section>`;
}

function dayHeading(date) {
  return t('meals.dayHeading', { weekday: dayLongName(date), date: dayMonthLabel(date) });
}

/** Die Kolacja von heute als Herd-Karte - oder die Einladung, eine zu planen. */
function heroHtml(meal) {
  const ro = readOnly();
  if (!meal) {
    if (ro || !state.visibleMealTypes.includes('dinner')) return '';
    const today = todayKey();
    return `
    <section class="meals-hero meals-hero--empty" aria-label="${esc(t('meals.heroLabel'))}">
      <div class="meals-hero__top">
        <div class="meals-hero__text">
          <span class="meals-hero__eyebrow">${esc(mealTypeLabel('dinner'))}</span>
          <h2 class="meals-hero__title">${esc(t('meals.heroEmptyTitle'))}</h2>
        </div>
        <span class="meals-hero__plate meals-plate" aria-hidden="true"><i data-lucide="utensils" class="meals-plate__icon"></i></span>
      </div>
      <div class="meals-hero__actions">
        <button type="button" class="meals-primary" data-action="add-meal" data-date="${today}" data-type="dinner">${esc(t('meals.sheetAdd', { meal: mealTypeInSentence('dinner') }))}</button>
        ${state.ideasReady ? `<button type="button" class="meals-secondary" data-action="phone-idea" data-date="${today}" data-type="dinner">
          <i data-lucide="sparkles" aria-hidden="true"></i>${esc(t('meals.idea'))}</button>` : ''}
      </div>
    </section>`;
  }
  const cook = mealCook(meal);
  const cookText = cook ? (cook.id === state.userId ? t('meals.heroCookYou') : t('meals.heroCook', { name: cook.display_name })) : '';
  const meter = ingredientMeter(meal);
  const title = meal.recipe_id && recipesReachable()
    ? `<a class="meals-hero__title meals-hero__title--link" data-action="open-linked-recipe" href="/recipes?open=${encodeURIComponent(meal.recipe_id)}">${esc(meal.title)}</a>`
    : `<button type="button" class="meals-hero__title meals-hero__title--link" data-action="${ro ? 'meal-details' : 'edit-meal'}" data-meal-id="${meal.id}">${esc(meal.title)}</button>`;
  return `
    <section class="meals-hero" data-meal-id="${meal.id}" aria-label="${esc(t('meals.heroLabel'))}">
      <div class="meals-hero__top">
        <div class="meals-hero__text">
          <span class="meals-hero__eyebrow">${esc(mealTypeLabel(meal.meal_type))}</span>
          <h2 class="meals-hero__heading">${title}</h2>
          ${cookText ? `<span class="meals-hero__cook">${personDisc({ id: cook.id, avatar_color: cook.color }, { text: initials(cook.display_name), household: state.members })}<span>${esc(cookText)}</span></span>` : ''}
        </div>
        ${plateHtml(meal, 'meals-hero__plate')}
      </div>
      ${meter ? meterHtml(meter) : ''}
      <div class="meals-hero__actions">
        <button type="button" class="meals-primary" data-action="phone-cook" data-meal-id="${meal.id}"
                aria-label="${esc(t('meals.cookNamedAria', { title: meal.title }))}">
          <i data-lucide="chef-hat" aria-hidden="true"></i><span>${esc(t('meals.cook'))}</span>
        </button>
        ${/* Das Menue der Mahlzeit: ueber diesen Knopf auf jedem Geraet, am
            Finger zusaetzlich per langem Druck auf die Karte (meals.css). */ ''}
        <button type="button" class="row-action meals-hero__more" data-action="phone-meal-menu" data-meal-id="${meal.id}"
                aria-label="${esc(t('meals.mealMenu', { title: meal.title }))}"><i data-lucide="ellipsis" aria-hidden="true"></i></button>
      </div>
    </section>`;
}

/** Leere Woche: kein Kasten, eine ruhige Spalte mit drei Startern. */
function emptyWeekHtml() {
  const ro = readOnly();
  const today = todayKey();
  const inWeek = today >= state.currentWeek && today <= addDays(state.currentWeek, 6);
  const day = inWeek ? today : state.currentWeek;
  const chips = ro ? [] : [
    state.visibleMealTypes.includes('dinner')
      ? `<button type="button" class="meals-chip meals-chip--ai" data-action="add-meal" data-date="${day}" data-type="dinner"><i data-lucide="plus" aria-hidden="true"></i><span>${esc(inWeek ? t('meals.emptyChipDinnerToday') : t('meals.emptyChipDinnerDay', { day: t(DAY_ACC_KEYS[zonedWeekday(day)]) }))}</span></button>`
      : '',
    state.ideasReady
      ? `<button type="button" class="meals-chip meals-chip--ai" data-action="phone-idea" data-date="${day}" data-type="dinner"><i data-lucide="sparkles" aria-hidden="true"></i><span>${esc(t('meals.emptyChipIdea'))}</span></button>`
      : '',
    state.recipes.length
      ? `<button type="button" class="meals-chip meals-chip--ai" data-action="randomize-plan"><i data-lucide="shuffle" aria-hidden="true"></i><span>${esc(t('meals.emptyChipRandom'))}</span></button>`
      : '',
  ].filter(Boolean);
  return `
    <div class="meals-empty">
      <i data-lucide="utensils" class="meals-empty__glyph" aria-hidden="true"></i>
      <h2 class="meals-empty__title">${esc(t('meals.emptyWeekTitle'))}</h2>
      ${ro ? '' : `<p class="meals-empty__text">${esc(t('meals.emptyWeekText'))}</p>`}
      ${chips.length ? `<div class="meals-empty__chips">${chips.join('')}</div>` : ''}
    </div>`;
}

/**
 * Was in den kommenden Mahlzeiten fehlt: nicht im Vorrat, nicht schon auf
 * einer Liste. Je Name einmal. Die eigenen Zutaten tragen ihre id, damit ihr
 * Haken `on_shopping_list` nach dem Dopisz stimmt.
 */
function missingIngredients() {
  if (readOnly() || !Array.isArray(state.pantry)) return [];
  const today = todayKey();
  const seen = new Set();
  const out = [];
  for (const meal of state.meals) {
    if (meal.date < today) continue;
    const recipe = recipeOf(meal);
    const own = (meal.ingredients ?? []).filter((ing) => !ing.on_shopping_list);
    const source = (meal.ingredients?.length ? own : (recipe?.ingredients ?? []));
    for (const ing of source) {
      const key = mealNameKey(ing.name);
      if (!key || inPantry(ing.name) || isListed(ing.name)) continue;
      if (seen.has(key)) {
        if (ing.id && ing.meal_id) out.find((m) => m.key === key)?.ingIds.push(ing.id);
        continue;
      }
      seen.add(key);
      out.push({ key, name: ing.name, quantity: ing.quantity ?? null, category: ing.category || DEFAULT_CATEGORY_NAME, ingIds: ing.id && ing.meal_id ? [ing.id] : [] });
    }
  }
  return out;
}

function phoneBodyHtml() {
  const today = todayKey();
  const days = Array.from({ length: 7 }, (_, i) => addDays(state.currentWeek, i));
  const isCurrent = days.includes(today);
  const ideas = ideaSlots(days);
  const parts = [];

  if (isCurrent) {
    const past = days.filter((d) => d < today);
    if (past.length) {
      parts.push(`
        <div class="meals-card meals-past">
          <button type="button" class="meals-row meals-past__toggle" data-action="phone-past" aria-expanded="${state.pastOpen}" aria-controls="meals-past-days">
            <span class="meals-row__glyph" aria-hidden="true"><i data-lucide="history"></i></span>
            <span class="meals-row__title">${esc(t('meals.pastToggle'))}</span>
            <span class="meals-row__value">${esc(t('meals.pastCount', { count: past.length }))}</span>
            <i data-lucide="chevron-down" class="meals-past__chevron" aria-hidden="true"></i>
          </button>
        </div>
        <div class="meals-past__days" id="meals-past-days"${state.pastOpen ? '' : ' hidden'}>
          ${past.map((d) => phoneDaySectionHtml(d, { heading: dayHeading(d), ideas })).join('')}
        </div>`);
    }
    if (!state.meals.length) parts.push(emptyWeekHtml());
    const dinner = state.meals.find((m) => m.date === today && m.meal_type === 'dinner') ?? null;
    const hero = state.meals.length ? heroHtml(dinner) : '';
    if (hero) parts.push(hero);
    const restHeading = dinner ? t('meals.restOfDay') : t('meals.todayHeading');
    // Bietet die Herd-Karte die leere Kolacja schon an, steht sie nicht noch einmal darunter.
    parts.push(phoneDaySectionHtml(today, {
      heading: restHeading, headingClass: ' meals-day__title--small', skip: dinner, skipType: hero && !dinner ? 'dinner' : null, ideas,
    }));
    for (const d of days.filter((day) => day > today)) parts.push(phoneDaySectionHtml(d, { heading: dayHeading(d), ideas }));
  } else {
    if (!state.meals.length) parts.push(emptyWeekHtml());
    for (const d of days) parts.push(phoneDaySectionHtml(d, { heading: dayHeading(d), ideas }));
  }

  const missing = missingIngredients();
  if (missing.length && state.lists.length && mayWritePath('/shopping')) {
    parts.push(`
      <div class="meals-phone__end">
        <button type="button" class="meals-plain" data-action="phone-missing">${esc(t('meals.missingToList', { count: missing.length }))}</button>
      </div>`);
  }
  return parts.join('');
}

function renderPhoneWeek() {
  const root = _container?.querySelector?.('#meals-phone');
  if (!root || typeof root.querySelector !== 'function') return;
  const head = root.querySelector('#meals-phone-head');
  const body = root.querySelector('#meals-phone-body');
  if (!head || !body) return;
  head.replaceChildren();
  head.insertAdjacentHTML('beforeend', phoneHeadHtml());
  body.replaceChildren();
  if (state.loadError) {
    mountLoadError(body, {
      title: t('meals.loadError'),
      description: t('common.loadErrorDescription'),
      error: state.loadError,
      retryLabel: t('common.retry'),
      onRetry: async () => {
        await loadWeek(state.currentWeek);
        renderWeekGrid();
      },
    });
  } else {
    body.insertAdjacentHTML('beforeend', phoneBodyHtml());
  }
  if (window.lucide) lucide.createIcons({ el: root });
  wireRecipeThumbs(body);
}

// ---- Verhalten ----

async function phoneGoToWeek(monday) {
  if (monday === state.currentWeek) return;
  state.pastOpen = false;
  setWeekBusy();
  await loadWeek(monday);
  renderWeekGrid();
  _container?.querySelector('#meals-phone')?.scrollTo?.({ top: 0 });
}

function phoneScrollToDay(date) {
  const root = _container?.querySelector('#meals-phone');
  if (!root) return;
  const today = todayKey();
  if (date < today && !state.pastOpen && date >= state.currentWeek) {
    state.pastOpen = true;
    renderPhoneWeek();
  }
  root.querySelectorAll('.meals-strip__day--selected').forEach((el) => el.classList.remove('meals-strip__day--selected'));
  if (date !== today) root.querySelector(`.meals-strip__day[data-date="${date}"]`)?.classList.add('meals-strip__day--selected');
  if (date === today) { root.scrollTo?.({ top: 0, behavior: 'smooth' }); return; }
  const section = root.querySelector(`.meals-day[data-date="${date}"]`);
  const headH = root.querySelector('#meals-phone-head')?.getBoundingClientRect().height ?? 0;
  if (section && root.scrollTo) {
    const top = section.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - headH - 8;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    root.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
  }
}

async function phoneCook(meal) {
  try {
    await openCookForMeal({ mealId: meal.id, recipeId: meal.recipe_id, date: meal.date });
  } catch (err) {
    window.yuvomi?.showToast(errorSentence(err), 'danger');
  }
}

/**
 * Das Menue einer Mahlzeit fuer den Finger (langes Druecken) und fuer den
 * "..."-Knopf der Herd-Karte: alles, was am Board als Kartenaktion steht.
 */
function openMealMenu(meal) {
  const ro = readOnly();
  const ownCount = meal.ingredients?.length ?? 0;
  const ingDone = meal.ingredients?.filter((i) => i.on_shopping_list).length ?? 0;
  const recipeCount = ownCount === 0 ? (meal.recipe_ingredient_count ?? 0) : 0;
  const canTransfer = !ro && (recipeCount > 0 || (ownCount > 0 && ingDone < ownCount)) && mayTransferMealToShopping(meal.id);
  const entries = [
    ro ? { id: 'details', icon: 'info', label: t('meals.mealDetails') } : { id: 'edit', icon: 'pencil', label: t('common.edit') },
    { id: 'cook', icon: 'chef-hat', label: t('meals.cook') },
    meal.recipe_id && recipesReachable() ? { id: 'recipe', icon: 'book-open', label: t('meals.openRecipe') } : null,
    canTransfer ? { id: 'transfer', icon: 'shopping-cart', label: t('meals.toShoppingListAction') } : null,
    ro ? null : { id: 'delete', icon: 'trash-2', label: t('common.delete'), danger: true },
  ].filter(Boolean);
  openSharedModal({
    title: meal.title,
    size: 'sm',
    content: `<div class="meals-menu" role="group">${entries.map((e) => `
      <button type="button" class="meals-menu__item${e.danger ? ' meals-menu__item--danger' : ''}" data-menu="${e.id}">
        <i data-lucide="${e.icon}" aria-hidden="true"></i><span>${esc(e.label)}</span>
      </button>`).join('')}</div>`,
    onSave(panel) {
      if (window.lucide) lucide.createIcons({ el: panel });
      panel.querySelector('.meals-menu')?.addEventListener('click', (e) => {
        const choice = e.target.closest('[data-menu]')?.dataset.menu;
        if (!choice) return;
        closeSharedModal({ force: true });
        if (choice === 'details') openMealReadModal(meal);
        if (choice === 'edit') openMealModal({ mode: 'edit', meal, date: meal.date, mealType: meal.meal_type });
        if (choice === 'cook') phoneCook(meal);
        if (choice === 'recipe') window.yuvomi?.navigate(`/recipes?open=${encodeURIComponent(meal.recipe_id)}`);
        if (choice === 'transfer') transferMeal(meal.id);
        if (choice === 'delete') deleteMeal(meal.id);
      });
    },
  });
}

/** "Brakujące składniki na listę": was fehlt, auf EINE Liste, mit Rücknahme. */
async function phoneAddMissing(btn) {
  if (readOnly() || !mayWritePath('/shopping')) return;
  const missing = missingIngredients();
  if (!missing.length) return;
  const target = await resolveShoppingTarget(state.lists);
  if (!target) return;
  if (btn) btn.disabled = true;
  const addedIds = [];
  const flagged = [];
  try {
    for (const ing of missing) {
      const res = await api.post(`/shopping/${target.id}/items`, {
        name: ing.name, quantity: ing.quantity, category: ing.category, category_source: 'suggestion',
      });
      if (res?.data?.id) addedIds.push(res.data.id);
      for (const id of ing.ingIds) {
        await api.patch(`/meals/ingredients/${id}`, { on_shopping_list: true });
        flagged.push(id);
      }
    }
  } catch (err) {
    window.yuvomi?.showToast(errorSentence(err), 'danger');
  }
  await Promise.all([loadWeek(state.currentWeek), loadListedNames()]);
  renderWeekGrid();
  if (!addedIds.length) return;
  announceTransfer({
    message: t('meals.missingAdded', { count: addedIds.length, list: target.name }),
    addedIds,
    onUndone: async () => {
      // Die Ruecknahme loescht die Artikel; den Haken der eigenen Zutaten
      // setzt nur zurueck, wer ihn gesetzt hat.
      for (const id of flagged) {
        try { await api.patch(`/meals/ingredients/${id}`, { on_shopping_list: false }); } catch { /* bleibt gesetzt */ }
      }
      await Promise.all([loadWeek(state.currentWeek), loadListedNames()]);
      renderWeekGrid();
    },
  });
}

/** Langes Druecken (Finger/Stift) auf einer Zeile oeffnet ihr Menue; der Klick danach faellt aus. */
function wirePhoneLongPress(root) {
  let timer = null;
  let start = null;
  let fired = false;
  const cancel = () => { clearTimeout(timer); timer = null; start = null; };
  root.addEventListener('pointerdown', (e) => {
    fired = false;
    if (e.pointerType === 'mouse') return;
    const host = e.target.closest?.('.meals-row[data-meal-id], .meals-hero[data-meal-id]');
    if (!host || e.target.closest('.meals-row__actions, .meals-primary, .meals-hero__more')) return;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      timer = null;
      const meal = state.meals.find((m) => m.id === Number(host.dataset.mealId));
      if (!meal) return;
      fired = true;
      if (typeof navigator !== 'undefined') navigator.vibrate?.(10);
      openMealMenu(meal);
    }, LONG_PRESS_MS);
  });
  root.addEventListener('pointermove', (e) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
  });
  root.addEventListener('pointerup', cancel);
  root.addEventListener('pointercancel', cancel);
  root.addEventListener('contextmenu', (e) => {
    if (e.target.closest?.('.meals-row[data-meal-id], .meals-hero[data-meal-id]')) e.preventDefault();
  });
  root.addEventListener('click', (e) => {
    if (!fired && !_phoneSwiped) return;
    fired = false;
    _phoneSwiped = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, { capture: true });
}

/** Ein Wisch ueber den Streifen ist kein Tipp auf einen Tag. */
let _phoneSwiped = false;

/** Wischen ueber den Streifen blaettert die Woche. */
function wireStripSwipe(root) {
  let start = null;
  root.addEventListener('pointerdown', (e) => {
    start = e.target.closest?.('.meals-strip') ? { x: e.clientX, y: e.clientY } : null;
  });
  root.addEventListener('pointerup', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    start = null;
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) / 2) return;
    _phoneSwiped = true;
    phoneGoToWeek(addDays(state.currentWeek, dx < 0 ? 7 : -7));
  });
}

async function onPhoneClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'phone-day') { phoneScrollToDay(btn.dataset.date); return; }
  if (action === 'phone-week-prev') { await phoneGoToWeek(addDays(state.currentWeek, -7)); return; }
  if (action === 'phone-week-next') { await phoneGoToWeek(addDays(state.currentWeek, 7)); return; }
  if (action === 'phone-week-today') { await phoneGoToWeek(getMondayOf(todayKey())); return; }
  if (action === 'phone-past') {
    state.pastOpen = !state.pastOpen;
    btn.setAttribute('aria-expanded', String(state.pastOpen));
    const days = _container.querySelector('#meals-past-days');
    if (days) days.hidden = !state.pastOpen;
    return;
  }
  const meal = btn.dataset.mealId ? state.meals.find((m) => m.id === Number(btn.dataset.mealId)) : null;
  if (action === 'phone-cook') { if (meal) phoneCook(meal); return; }
  if (action === 'phone-meal-menu') { if (meal) openMealMenu(meal); return; }
  if (readOnly() && !READ_SAFE_ACTIONS.has(action)) return;
  if (action === 'phone-idea') { openIdeasModal(btn.dataset.date, { mealType: btn.dataset.type, autoAsk: true }); return; }
  if (action === 'phone-meal-ideas') { openIdeasModal(todayKey()); return; }
  if (action === 'phone-missing') { await phoneAddMissing(btn); return; }
  if (action === 'randomize-plan') { openRandomizeModal(); return; }
  // Alles Weitere sind die Aktionen des Boards - derselbe Handler.
  await onGridClick(e);
}

function wirePhoneWeek() {
  const root = _container?.querySelector?.('#meals-phone');
  if (!root || root.dataset.eventsWired) return;
  root.dataset.eventsWired = 'true';
  installPopoverMenus(root);
  root.addEventListener('click', onPhoneClick);
  wirePhoneLongPress(root);
  wireStripSwipe(root);
}

// --------------------------------------------------------
// Event-Delegation
// --------------------------------------------------------

function setWeekBusy() {
  // Sichtbares Lade-Feedback beim Wochenwechsel (dimmt das Raster via CSS,
  // meldet Screenreadern „busy"), bis renderWeekGrid das Attribut wieder entfernt.
  _container.querySelector('#week-grid')?.setAttribute('aria-busy', 'true');
}

/* Die neue Woche kommt von der Seite, zu der man blaettert (swapPeriod,
 * utils/period-stepper.js) - vorher ein harter Schnitt nach dem Laden. */
function swapWeek(step) {
  swapPeriod(_container?.querySelector('#week-grid') ?? null, step, renderWeekGrid);
}

function wireNav() {
  _container.querySelector('#week-prev')?.addEventListener('click', async () => {
    setWeekBusy();
    await loadWeek(addDays(state.currentWeek, -7));
    swapWeek(-1);
  });

  _container.querySelector('#week-next')?.addEventListener('click', async () => {
    setWeekBusy();
    await loadWeek(addDays(state.currentWeek, 7));
    swapWeek(1);
  });

  _container.querySelector('#week-today')?.addEventListener('click', async () => {
    const monday = getMondayOf(todayKey());
    if (monday === state.currentWeek) return;
    // "Heute" kommt von dort, wo die laufende Woche liegt (Schluessel als Text).
    const towards = monday < state.currentWeek ? -1 : 1;
    setWeekBusy();
    await loadWeek(monday);
    swapWeek(towards);
  });

  // Bei `read` steht der Eintrag nicht im Markup; openRandomizeModal() traegt
  // den Riegel fuer einen Knoten, den ein Rechtewechsel ueberholt hat.
  _container.querySelector('[data-action="randomize-plan"]')?.addEventListener('click', openRandomizeModal);
}

function wireGrid(grid) {
  // Delegation am stabilen #week-grid nur EINMAL binden. renderWeekGrid läuft bei
  // jedem Wochenwechsel erneut, ersetzt aber nur die Kinder (replaceChildren) —
  // ohne Guard akkumulierten click/keydown/pointerdown-Listener und feuerten
  // add-/delete-/transfer-meal mehrfach (Muster wie shopping.js#wireListContentEvents).
  if (!grid.dataset.eventsWired) {
    grid.dataset.eventsWired = 'true';
    grid.addEventListener('click', onGridClick);
  }

  // Regel 3 in utils/module-access.js: Ziehen hat kein Markup, das man
  // wegnehmen koennte - bei `read` bleibt die VERDRAHTUNG aus, fuer das Rezept
  // aus der Spalte (dragover/drop) wie fuer die Karte (wireDragDrop).
  //
  // EIN EIGENER MERKER, NACH DER RECHTEFRAGE GESETZT. Die Rechte koennen im
  // Lauf einer Sitzung wechseln (jedes `/auth/me` schreibt den Store neu,
  // api.js), und alles andere auf dieser Seite fragt je Zeichnen. Hing das
  // Ziehen am Merker des Klicks, blieb ein Gitter, das zuerst bei `read`
  // gezeichnet wurde, bis zum Seitenwechsel ohne Ziehen. So zieht das naechste
  // Zeichnen nach. Die Gegenrichtung - verdrahtet, dann faellt das Recht weg -
  // fangen die drei Handler selbst am ANFANG der Geste (onGridDragOver,
  // onGridDrop, `pointerdown` in wireDragDrop): ein Riegel erst im Ende-Handler
  // kaeme zu spaet, dann haette die Karte schon einen Geist und der Platz
  // seinen Zielrahmen.
  if (readOnly() || grid.dataset.dragWired) return;
  grid.dataset.dragWired = 'true';

  grid.addEventListener('dragover', onGridDragOver);
  grid.addEventListener('drop', onGridDrop);

  wireDragDrop(grid);
}

async function onGridClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;

  // Der eine Riegel fuer alle Aktionen darunter (siehe READ_SAFE_ACTIONS): das
  // Markup nimmt die Affordanz, die Positivliste den Effekt - auch fuer einen
  // Knoten, der einen Rechtewechsel ueberlebt hat.
  if (readOnly() && !READ_SAFE_ACTIONS.has(action)) return;

  if (action === 'meal-details') {
    const meal = state.meals.find((m) => m.id === parseInt(btn.dataset.mealId, 10));
    if (meal) openMealReadModal(meal);
    return;
  }

  if (action === 'add-meal') {
    openMealModal({ mode: 'create', date: btn.dataset.date, mealType: btn.dataset.type, fromSlot: true });
    return;
  }

  if (action === 'open-recipe') {
    // Link öffnet sich nativ - nur Bubbling stoppen damit kein Edit-Modal aufgeht
    e.stopPropagation();
    return;
  }

  // Sprung ins eigene Rezept (#936). Ein `<a href>` und kein Knopf, aus dem
  // Grund, den der Dashboard-Kopf schon nennt: ein Knopf, der navigiert,
  // nimmt dem Nutzer Cmd-Klick, Mittelklick und "Link kopieren". Deshalb
  // faengt der Handler den Klick nur ab, wenn der Browser ihn nicht selbst
  // besser bedient - sonst waere der href ein Versprechen, das der Handler
  // bricht.
  if (action === 'open-linked-recipe') {
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    window.yuvomi?.navigate(btn.getAttribute('href'));
    return;
  }

  if (action === 'edit-meal') {
    const mealId = parseInt(btn.dataset.mealId, 10);
    const meal   = state.meals.find((m) => m.id === mealId);
    if (meal) openMealModal({ mode: 'edit', meal, date: meal.date, mealType: meal.meal_type });
    return;
  }

  if (action === 'transfer-meal') {
    await transferMeal(parseInt(btn.dataset.mealId, 10), btn);
  }
}

function onGridDragOver(e) {
  if (!_dragRecipeId || readOnly()) return;
  const slot = e.target.closest('.meal-slot');
  if (!slot) return;
  const recipe = state.recipes.find((entry) => entry.id === _dragRecipeId);
  // Ziehen ist eine Entscheidung des Nutzers, nicht der Automatik: ein Rezept
  // ohne erklärte Mahlzeit bleibt hier ablegbar (#750, recipeAllowsMealType).
  if (!recipe || !recipeAllowsMealType(recipe, slot.dataset.type)) return;
  e.preventDefault();
  clearRecipeDropTargets();
  slot.classList.add('meal-slot--drop-target');
}

async function onGridDrop(e) {
  if (readOnly()) { _dragRecipeId = null; return; }
  if (!_dragRecipeId) return;
  const slot = e.target.closest('.meal-slot');
  const recipeId = _dragRecipeId;
  _dragRecipeId = null;
  clearRecipeDropTargets();
  if (!slot) return;
  const recipe = state.recipes.find((entry) => entry.id === recipeId);
  if (!recipe || !recipeAllowsMealType(recipe, slot.dataset.type)) return;
  e.preventDefault();
  const slotMeals = state.meals.filter((meal) => meal.date === slot.dataset.date && meal.meal_type === slot.dataset.type);
  if (slotMeals.length) {
    const confirmed = await confirmModal(t('meals.replaceExistingConfirm'), { confirmLabel: t('common.confirm') });
    if (!confirmed) return;
  }
  await addRecipeToSlot(recipe, slot.dataset.date, slot.dataset.type, { replaceMeals: slotMeals });
  // Nur nach der Rueckfrage: in einen leeren Platz gezogen schliesst kein
  // Dialog, und das Nachfassen griffe auf den Merker eines frueheren zurueck (#1083).
  if (slotMeals.length) refocusAfterRender();
}

function wireRecipeSidebar() {
  const sidebar = _container.querySelector('#recipe-sidebar');
  if (!sidebar || sidebar.dataset.eventsWired) return;
  sidebar.dataset.eventsWired = 'true';

  sidebar.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.recipe-sidebar__card');
    if (!card) return;
    _dragRecipeId = Number(card.dataset.recipeId);
    card.classList.add('recipe-sidebar__card--dragging');
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', card.dataset.recipeId);
  });

  sidebar.addEventListener('click', (e) => {
    const open = e.target.closest('[data-action="plan-recipe"]');
    if (open) planRecipeFromRail(open.dataset.recipeId);
  });

  sidebar.addEventListener('dragend', (e) => {
    e.target.closest('.recipe-sidebar__card')?.classList.remove('recipe-sidebar__card--dragging');
    _dragRecipeId = null;
    clearRecipeDropTargets();
  });
}

function clearRecipeDropTargets() {
  _container.querySelectorAll('.meal-slot--drop-target').forEach((slot) => slot.classList.remove('meal-slot--drop-target'));
}

async function addRecipeToSlot(recipe, date, mealType, { replaceMeals = [] } = {}) {
  if (readOnly()) return;
  try {
    const payload = mealPayloadFromRecipe(recipe, date, mealType);
    if (replaceMeals.length) {
      const res = await api.post('/meals/apply-plan', { assignments: [payload], replace_existing: true });
      state.meals = state.meals.filter((entry) => !(entry.date === date && entry.meal_type === mealType));
      state.meals.push(...(res.data || []));
    } else {
      const res = await api.post('/meals', payload);
      state.meals.push(res.data);
    }
    renderWeekGrid();
  } catch (err) {
    window.yuvomi?.showToast(window.yuvomi?.friendlyError?.(err) ?? t('common.errorGeneric'), 'danger');
  }
}

function openRandomizeModal() {
  if (readOnly()) return;
  openSharedModal({
    title: t('meals.randomizeTitle'),
    size: 'sm',
    content: `
      <div class="meal-randomize-modal">
        <label class="toggle meal-randomize-modal__toggle">
          <input type="checkbox" id="meal-randomize-replace">
          <span class="toggle__track"></span>
          <span>${t('meals.randomizeReplaceExisting')}</span>
        </label>
        <!-- Vorschau statt Blindflug: der Lauf füllt bis zu 28 Slots und kann
             eine ganze geplante Woche überschreiben. Vorher nannte der Dialog
             weder das eine noch das andere (Critique 2026-07-29). -->
        <p class="meal-randomize-modal__preview" id="meal-randomize-preview" aria-live="polite"></p>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button class="btn btn--secondary" id="meal-randomize-cancel">${t('common.cancel')}</button>
          <button class="btn btn--primary" id="meal-randomize-run">${t('meals.randomizePlan')}</button>
        </div>
      </div>`,
    onSave(panel) {
      const replaceBox = panel.querySelector('#meal-randomize-replace');
      const preview = panel.querySelector('#meal-randomize-preview');
      const runBtn = panel.querySelector('#meal-randomize-run');

      // Rein clientseitig: buildRandomMealAssignments rechnet auf dem bereits
      // geladenen Wochen- und Rezeptbestand, kostet also keinen Roundtrip.
      const updatePreview = () => {
        const plan = buildRandomMealAssignments({
          weekStart: state.currentWeek,
          visibleMealTypes: state.visibleMealTypes,
          meals: state.meals,
          recipes: state.recipes,
          replaceExisting: Boolean(replaceBox?.checked),
        });
        const fill = plan.assignments.length;
        const overwrite = plan.deleteMealIds?.length ?? 0;

        if (!fill) {
          preview.textContent = plan.reason === 'week_full'
            ? t('meals.randomizeWeekFull')
            : t('meals.randomizeNoRecipes');
          runBtn.disabled = true;
          return;
        }
        runBtn.disabled = false;
        preview.textContent = overwrite > 0
          ? `${t('meals.randomizePreview', { count: fill })} ${t('meals.randomizePreviewReplace', { count: overwrite })}`
          : t('meals.randomizePreview', { count: fill });
      };

      replaceBox?.addEventListener('change', updatePreview);
      updatePreview();

      panel.querySelector('#meal-randomize-cancel')?.addEventListener('click', closeModal);
      runBtn?.addEventListener('click', () => runRandomize(panel));
    },
  });
}

async function runRandomize(panel) {
  if (readOnly()) return;
  const replaceExisting = Boolean(panel.querySelector('#meal-randomize-replace')?.checked);
  const runBtn = panel.querySelector('#meal-randomize-run');
  const plan = buildRandomMealAssignments({
    weekStart: state.currentWeek,
    visibleMealTypes: state.visibleMealTypes,
    meals: state.meals,
    recipes: state.recipes,
    replaceExisting,
  });

  if (!plan.assignments.length) {
    window.yuvomi?.showToast(
      plan.reason === 'week_full' ? t('meals.randomizeWeekFull') : t('meals.randomizeNoRecipes'),
      'info'
    );
    return;
  }

  runBtn.disabled = true;
  try {
    await api.post('/meals/apply-plan', { assignments: plan.assignments.map((assignment) => assignment.payload), replace_existing: replaceExisting });
    await loadWeek(state.currentWeek);
    closeModal({ force: true });
    renderWeekGrid();
    window.yuvomi?.showToast(t('meals.randomizeSuccess', { count: plan.assignments.length }), 'success');
  } catch (err) {
    runBtn.disabled = false;
    window.yuvomi?.showToast(window.yuvomi?.friendlyError?.(err) ?? t('common.errorGeneric'), 'danger');
  }
}

// --------------------------------------------------------
// Drag & Drop
// --------------------------------------------------------

let _suppressNextClick = false;
// Ab so viel Weg wird aus einem Druecken ein Zug; darunter ist es ein Klick.
const DRAG_THRESHOLD_PX = 5;

function wireDragDrop(grid) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let dragging = null; // { mealId, sourceDate, sourceType, ghost, card, slot }

  grid.addEventListener('pointerdown', (e) => {
    // Am ANFANG der Geste (siehe wireGrid): verdrahtet wurde mit Schreibrecht,
    // inzwischen kann es fehlen.
    if (readOnly()) return;
    const card = e.target.closest('.meal-card');
    if (!card) return;
    // Die Aktionsleiste ist kein Drag-Griff. Hier standen drei Aktionen
    // namentlich, und die vierte (`open-linked-recipe`, #936) fehlte prompt:
    // ihr `pointerdown` startete ein Ziehen, das Loslassen verschob das Essen
    // in einen anderen Slot und verschluckte den Klick. Eine Liste vergisst den
    // naechsten Knopf genauso - der Container ist die Regel.
    if (e.target.closest('.meal-card__actions')) return;
    // Ein Finger (oder Stift) zieht nur am Griff, sobald die Zeile einen zeigt
    // (#1317). Ueberall sonst gehoert die Geste dem Scroller: er beansprucht sie
    // wegen `touch-action: pan-y` ohnehin und beendet den Pointer mit
    // pointercancel - ein hier begonnener Zug brach also nur ab, und das
    // preventDefault darunter liess nicht einmal den Scroll sauber anlaufen.
    // Die Maus greift weiter die ganze Karte. Wo der Griff ausgeblendet ist
    // (breites Board auf einem Tablet), bleibt es beim bisherigen Verhalten.
    if (e.pointerType !== 'mouse' && !e.target.closest('.meal-card__drag')) {
      const handle = card.querySelector('.meal-card__drag');
      if (handle && handle.getClientRects().length > 0) return;
    }

    const slot = card.closest('.meal-slot');
    if (!slot) return;

    const mealId     = parseInt(card.dataset.mealId, 10);
    const sourceDate = slot.dataset.date;
    const sourceType = slot.dataset.type;

    e.preventDefault();
    // Der Zeiger wird am GEDRUECKTEN Element gefangen, nicht an der Karte
    // (Critique 2026-10-16, P1): ein `click` geht an das gemeinsame Ziel von
    // Druecken und Loslassen, und mit der Karte als Faenger war das das
    // `.meal-card`-div - der Oeffnen-Knopf bekam den Klick nie, ein Mausklick
    // oeffnete keinen Dialog. Die Ereignisse steigen vom Faenger weiter zur
    // Karte auf, die Listener unten bleiben deshalb dort.
    e.target.setPointerCapture(e.pointerId);

    // Ein Zug beginnt erst mit Weg. Vorher legte jeder Klick einen Geist und
    // die Zieh-Markierung an; ein Druecken ohne Weg ist ein Klick.
    const startX = e.clientX;
    const startY = e.clientY;
    let ghost = null;
    let pending = { mealId, sourceDate, sourceType, card, slot };

    function beginDrag(ev) {
      if (!reducedMotion) {
        ghost = card.cloneNode(true);
        ghost.classList.add('meal-card--ghost');
        ghost.style.width  = card.offsetWidth + 'px';
        ghost.style.height = card.offsetHeight + 'px';
        ghost.style.left   = (ev.clientX - card.offsetWidth / 2) + 'px';
        ghost.style.top    = (ev.clientY - card.offsetHeight / 2) + 'px';
        document.body.appendChild(ghost);
      }
      slot.classList.add('meal-slot--dragging');
      dragging = { ...pending, ghost };
      pending = null;
    }

    let lastTarget = null;

    function onMove(ev) {
      if (pending) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
        beginDrag(ev);
      }
      if (!dragging) return;
      if (ghost) {
        ghost.style.left = (ev.clientX - ghost.offsetWidth / 2) + 'px';
        ghost.style.top  = (ev.clientY - ghost.offsetHeight / 2) + 'px';
      }
      if (ghost) ghost.style.display = 'none';
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      if (ghost) ghost.style.display = '';

      const targetSlot = el?.closest('.meal-slot');
      if (targetSlot !== lastTarget) {
        lastTarget?.classList.remove('meal-slot--drop-target');
        if (targetSlot && targetSlot !== dragging.slot) {
          targetSlot.classList.add('meal-slot--drop-target');
        }
        lastTarget = targetSlot;
      }
    }

    async function onUp(ev) {
      if (!dragging) { cleanup(); return; } // ohne Weg: ein Klick, er geht durch
      const { mealId, sourceDate, sourceType, slot: sourceSlot } = dragging;
      cleanup(); // setzt dragging = null - Werte daher vorher destrukturieren

      // Nach einem echten Zug ist der folgende Klick keine Bitte zum
      // Bearbeiten - auch dann nicht, wenn die Karte im eigenen Slot landet.
      // Seit der Faenger der Oeffnen-Knopf ist, erreichte ihn dieser Klick sonst.
      _suppressNextClick = true;
      setTimeout(() => { _suppressNextClick = false; }, 300);

      if (ghost) ghost.style.display = 'none';
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      if (ghost) ghost.style.display = '';

      const targetSlot = el?.closest('.meal-slot');
      if (targetSlot && targetSlot !== sourceSlot) {
        const targetDate = targetSlot.dataset.date;
        const targetType = targetSlot.dataset.type;
        await moveMeal(mealId, targetDate, targetType);
      }
    }

    function onCancel() { cleanup(); }

    function cleanup() {
      ghost?.remove();
      dragging?.slot?.classList.remove('meal-slot--dragging');
      lastTarget?.classList.remove('meal-slot--drop-target');
      dragging = null;
      pending = null;
      card.removeEventListener('pointermove',   onMove);
      card.removeEventListener('pointerup',     onUp);
      card.removeEventListener('pointercancel', onCancel);
    }

    card.addEventListener('pointermove',   onMove);
    card.addEventListener('pointerup',     onUp);
    card.addEventListener('pointercancel', onCancel);
  });

  // Suppress click after a completed drag
  grid.addEventListener('click', (e) => {
    if (_suppressNextClick) {
      e.stopImmediatePropagation();
      _suppressNextClick = false;
    }
  }, true);
}

/**
 * Eine Mahlzeit auf einen anderen Tag oder eine andere Mahlzeit ziehen.
 *
 * OPTIMISTISCH (Critique 2026-10-05, R16). Die Funktion wartete auf den Server
 * und baute erst danach neu: die Karte stand solange am alten Platz, das
 * Ablegen sah also aus, als haette es nicht geklappt. Und scheiterte der
 * Aufruf, baute die Woche still neu - die Karte war ohne ein Wort wieder da,
 * wo sie herkam. Jetzt zieht der Zustand sofort um; im Fehlerfall kehrt er
 * zurueck, und der Fehler wird gemeldet (dasselbe Muster wie beim Einplanen
 * weiter oben).
 *
 * ZWEI ZUEGE DERSELBEN KARTE vor der ersten Antwort (Review #1673): die
 * Aufrufe laufen je Karte NACHEINANDER, und zurueckgekehrt wird an den letzten
 * Platz, den der Server bestaetigt hat - nicht an den, an dem die Karte beim
 * Ziehen gerade stand (das war das unbestaetigte Ziel des ersten Zugs).
 * Zurueck setzt nur der JUENGSTE Zug: scheitert ein aelterer, gehoert der Platz
 * dem spaeteren.
 *
 * @param {number} mealId
 * @param {string} targetDate  YYYY-MM-DD
 * @param {string} targetType
 * @param {{ rerender?: () => void }} [opts]  nur fuer Tests
 */
const _mealMoves = new Map(); // mealId -> { confirmed, tail, latest, pending }

async function moveMeal(mealId, targetDate, targetType, { rerender = renderWeekGrid } = {}) {
  // Zweite Linie hinter der fehlenden Verdrahtung (wireGrid): der Zug ist
  // optimistisch - ohne diesen Riegel spraenge die Karte um und nach dem 403
  // zurueck.
  if (readOnly()) return;
  const meal = state.meals.find((m) => m.id === mealId);
  let moves = _mealMoves.get(mealId);
  if (!moves) {
    moves = {
      confirmed: meal ? { date: meal.date, meal_type: meal.meal_type } : null,
      tail: Promise.resolve(),
      latest: 0,
      pending: 0,
    };
    _mealMoves.set(mealId, moves);
  }
  const turn = ++moves.latest;
  moves.pending += 1;
  if (meal) {
    meal.date = targetDate;
    meal.meal_type = targetType;
    rerender();
  }
  const send = () => api.put(`/meals/${mealId}`, { date: targetDate, meal_type: targetType });
  // Der Normalfall (kein Zug dieser Karte unterwegs) geht sofort raus.
  const request = moves.pending > 1 ? moves.tail.then(send) : send();
  moves.tail = request.catch(() => {});
  try {
    await request;
    moves.confirmed = { date: targetDate, meal_type: targetType };
    if (!meal) rerender();
  } catch (err) {
    if (meal && moves.confirmed && moves.latest === turn) {
      meal.date = moves.confirmed.date;
      meal.meal_type = moves.confirmed.meal_type;
    }
    rerender();
    window.yuvomi?.showToast(window.yuvomi?.friendlyError?.(err) ?? t('common.errorGeneric'), 'danger');
  } finally {
    moves.pending -= 1;
    if (moves.pending === 0) _mealMoves.delete(mealId);
  }
}

// --------------------------------------------------------
// Modal
// --------------------------------------------------------

/**
 * Eine skalierte Zutatenmenge, in der Schreibweise der eingestellten Region.
 *
 * Die Menge ist Freitext („250 g", „1 1/2 Tassen", „eine Prise"), also wird nur
 * die fuehrende Zahl angefasst und der Rest der Zeile unveraendert angehaengt.
 * Erkannt werden gemischte Brueche, einfache Brueche und Dezimalzahlen; alles
 * andere bleibt, wie es dasteht.
 *
 * LESEN UND SCHREIBEN haengen beide an der Region, und das ist der Kern. Vorher
 * las die Funktion mit einem eigenen `replace(',', '.')` und schrieb mit einem
 * `useComma`, das sie sich aus der Eingabe abgeschaut hatte. Beides war still
 * falsch: unter en-US gruppiert das Komma Tausender, „1,000 g" wurde also zur
 * Basis 1 und danach mit dem Faktor multipliziert - eine Zutat, die um den
 * Faktor tausend zu klein im Rezept stand. Unter fa oder ar-EG traf die Regex
 * gar nicht erst (`\d` ist ASCII), die Zeile blieb ungeskaliert zwischen
 * skalierten Geschwistern stehen. Und das abgeschaute `useComma` konnte den
 * Trenner nur wiederholen, den die gespeicherte Zutat zufaellig trug - eine aus
 * Mealie gespiegelte „1.5" blieb in einer deutschen Oberflaeche „1.5".
 *
 * Die Umschrift ist dieselbe wie bei Preis und Einkaufsmenge
 * (`toDecimalString`), die Ausgabe geht durch `toStoredNumber`. Damit
 * liest die Funktion ihre eigene Ausgabe wieder ein, was sie muss: der
 * gerenderte Wert landet in einer Zutatenzeile, wird gespeichert und beim
 * naechsten Anwenden des Rezepts erneut skaliert. Deshalb auch ohne
 * Gruppierung - ein gruppierter Wert kaeme nicht wieder herein.
 *
 * Eine gruppierte Eingabe wird abgewiesen und die Zeile bleibt UNVERAENDERT
 * stehen. Das ist bewusst ein anderer Ausgang als beim Einkauf, wo ein nicht
 * verstandener Wert auf „1 Stueck" faellt: dort ist die Menge ein Vorschlag in
 * einem korrigierbaren Feld, hier ist sie der Text der Zutat selbst, und der
 * Originaltext ist die einzige Antwort, die nichts erfindet.
 */
function scaleQuantityText(quantity, factor) {
  if (!quantity || factor === 1) return quantity;

  // Erst umschreiben, dann lesen: sonst sieht die ASCII-Regex unter fa/ar-EG
  // ueberhaupt keine Ziffer, und zwar auch nicht in einem Bruch wie „1 1/2".
  // `freeText`, weil nur die fuehrende Zahl gerechnet wird: eine Gruppierung im
  // Rest („2 Dosen à 1.000 ml") darf die Zeile nicht ungeskaliert stehen lassen.
  const original = String(quantity).trim();
  const text = toDecimalString(original, { freeText: true });
  if (!text) return quantity;

  // Der Rest der Zeile kommt aus dem ORIGINAL, nicht aus der umgeschriebenen
  // Fassung: umgeschrieben wird nur, was auch gerechnet wird. Sonst verloere ein
  // zweiter Zahlenteil im Text seine Ziffern - unter fa wurde „۲ x ۵۰۰ g" zu
  // „۴ x 500 g", also zu einer Zeile in zwei Schriften. Der Offset stimmt, weil
  // toDecimalString positionstreu ist (ein Zeichen hinein, ein Zeichen hinaus);
  // die Zusicherung steht dort im Kopf und haengt an einem Guard.
  // In CODEPOINTS, nicht in UTF-16-Einheiten: die Ziffern von 40 der 77 Systeme
  // liegen ausserhalb der BMP und belegen zwei Einheiten, ihr ASCII-Ergebnis nur
  // eine. Mit `.length` verrutschte der Schnitt genau dort und schnitt mitten in
  // ein Zeichen - gemessen ergab „𞥒 x 500 g" ein „4\uDD52 x 500 g" mit einer
  // halben Ersatzzeichen-Paarung, und dieser kaputte Text wurde in die
  // Zutatenzeile geschrieben.
  const zeichen = [...original];
  const restOf = (match, tailGroup) => zeichen.slice([...match[0]].length - [...match[tailGroup]].length).join('');

  // Der Abbruch-im-Trenner gilt fuer ALLE drei Formen, nicht nur fuer die
  // Dezimalzahl unten. Bricht ein Nenner in einem Trenner ab, ist der Bruch nicht
  // gelesen, sondern abgeschnitten: aus „1/2,5 cup" wurde 1/2, mal Faktor, und der
  // Rest „,5 cup" dahinter - also „1,5 cup", eine plausible und falsche Menge.
  // Dann lieber gar nichts anfassen, wie bei „eine Prise".
  const mixed = text.match(/^(\d+)\s+(\d+)\/(\d+)(.*)$/);
  if (mixed) {
    if (breaksOffAtSeparator(mixed[4])) return quantity;
    const whole = Number(mixed[1]);
    const num = Number(mixed[2]);
    const den = Number(mixed[3]);
    if (den > 0) return `${formatScaledQuantity((whole + (num / den)) * factor)}${restOf(mixed, 4)}`;
  }

  const frac = text.match(/^(\d+)\/(\d+)(.*)$/);
  if (frac) {
    if (breaksOffAtSeparator(frac[3])) return quantity;
    const num = Number(frac[1]);
    const den = Number(frac[2]);
    if (den > 0) return `${formatScaledQuantity((num / den) * factor)}${restOf(frac, 3)}`;
  }

  const dec = text.match(/^(\d+(?:\.\d+)?)(.*)$/);
  if (dec) {
    // Bricht die Zahl mitten in einem Trennzeichen ab, ist sie nicht gelesen,
    // sondern abgeschnitten. Unter fa ist das ASCII-Komma kein Dezimaltrenner:
    // aus „1,5 kg" waere sonst die Basis 1 geworden und die Ausgabe „۲,5 kg",
    // also eine halbierte Zutat in einer Schreibweise, die es nicht gibt.
    // Ueber dieselbe geteilte Pruefung wie im Einkauf: sie kennt die Trennzeichen
    // der waehlbaren Regionen. „Irgendein Zeichen zwischen zwei Ziffern" war zu
    // breit und liess „2x500 g" ungeskaliert stehen - ein `x` trennt nichts.
    const abgeschnitten = breaksOffAtSeparator(dec[2]);
    const base = Number(dec[1]);
    if (!abgeschnitten && Number.isFinite(base)) {
      return `${formatScaledQuantity(base * factor)}${restOf(dec, 2)}`;
    }
  }

  // „eine Prise", „nach Geschmack": nichts zu rechnen, also nichts anfassen.
  return quantity;
}

/**
 * Die skalierte Zahl als Text: hoechstens zwei Nachkommastellen, Ziffern in
 * ASCII, Trenner aus der Region soweit serverlesbar, ohne Gruppierung.
 *
 * Warum die Ziffern NICHT der Region folgen, obwohl der Trenner es tut: dieser
 * Text wird in die Zutatenzeile geschrieben und gespeichert, und beim Uebertrag
 * in die Einkaufsliste liest ihn `parseQuantity` in
 * server/services/shopping-import.js mit einer ASCII-Regex wieder ein. Eine in
 * nativen Ziffern geschriebene Menge („۲۰۰۰ g") kaeme dort nicht an - die Zutat
 * liesse sich nicht mehr mit anderen zusammenzaehlen. Begruendung und der Weg zu
 * einem saubereren Endzustand stehen bei `toStoredNumber` in utils/money.js.
 */
function formatScaledQuantity(value) {
  return toStoredNumber(value);
}

/**
 * Die Mahlzeit bei `meals: read`: Leseansicht, sonst nichts (Regel 9, Bauart
 * `itemReadHtml()` in pantry.js und shopping.js). Alles, was der
 * Bearbeiten-Dialog zeigt - Datum, Mahlzeit, Zutaten samt Menge und Kategorie,
 * das gespeicherte Rezept, Notizen, Rezept-Link und die Wiederholung -, als
 * Wert statt als Eingabe; der Name steht im Titel. Notiz, Link, Kategorien und
 * das Serien-Ende stehen NUR im Editor, die Karte zeigt sie nie. Der Link
 * bleibt ein Link: ihn zu oeffnen ist Lesen. „Zutaten skalieren" fehlt, es ist
 * ein Werkzeug des Formulars und kein Wert der Mahlzeit.
 *
 * DIE WIEDERHOLUNG HAT EIN EIGENES ZUSTANDSWORT (`meals.recurrenceWeekly`,
 * „Woechentlich"). Die Beschriftung des Schalters im Formular
 * (`meals.recurrenceLabel`, „Woechentlich wiederholen") ist in jeder Sprache
 * ein Imperativ - als Wert einer Leseansicht waere das eine Aufforderung. Eine
 * Serie kennt nur diesen einen Rhythmus (`repeat_weekly` in
 * server/routes/meals.js); kommt ein zweiter dazu, braucht er sein eigenes Wort.
 */
function mealReadHtml(meal) {
  const typeLabel = MEAL_TYPES().find((mt) => mt.key === meal.meal_type)?.label ?? '';
  const ingredients = (meal.ingredients ?? []).map((ing) => {
    const line = ing.quantity ? `${ing.quantity} · ${ing.name}` : ing.name;
    return ing.category ? `${line} (${categoryLabel(ing.category)})` : line;
  }).join('\n');
  const recipe = meal.recipe_id ? state.recipes.find((r) => r.id === meal.recipe_id) : null;
  const url = String(meal.recipe_url ?? '').trim();
  const link = /^https?:\/\//i.test(url)
    ? `<a class="meal-read__link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`
    : esc(url);
  // Der Koch als Wert (#1679): Avatar und Name, keine Auswahl. Der Avatar ist
  // hier Schmuck neben dem ausgeschriebenen Namen und fuer Screenreader stumm.
  const cook = mealCook(meal);
  const cookHtml = cook
    ? `<span class="meal-read__cook"><span aria-hidden="true">${renderAvatarStack([cook], { size: 24, maxVisible: 1 })}</span><span>${esc(cook.display_name)}</span></span>`
    : null;
  return `
    <div class="meal-read detail-view" data-view="read" data-meal-id="${esc(String(meal.id))}">
      <div class="detail-view__rows">
        ${readRowHtml({ icon: 'calendar', label: t('meals.dateLabel'), value: meal.date ? formatDate(meal.date) : '' })}
        ${readRowHtml({ icon: 'utensils', label: t('meals.mealTypeLabel'), value: typeLabel })}
        ${cookHtml ? readRowHtml({ icon: 'cooking-pot', label: t('meals.cookLabel'), valueHtml: cookHtml }) : ''}
        ${readRowHtml({ icon: 'list', label: t('meals.ingredientsLabel'), value: ingredients, multiline: true })}
        ${readRowHtml({ icon: 'chef-hat', label: t('meals.savedRecipeLabel'), value: recipe?.title ?? '' })}
        ${readRowHtml({ icon: 'align-left', label: t('meals.notesLabel'), value: meal.notes || '', multiline: true })}
        ${readRowHtml({ icon: 'link', label: t('meals.recipeUrlLabel'), valueHtml: link })}
        ${readRowHtml({ icon: 'repeat-2', label: t('meals.recurrenceBadge'), value: meal.recurrence_template_id ? t('meals.recurrenceWeekly') : '' })}
        ${readRowHtml({ icon: 'calendar-range', label: t('meals.recurrenceUntilLabel'), value: meal.recurrence_template_id && meal.recurrence_end_date ? formatDate(meal.recurrence_end_date) : '' })}
      </div>
    </div>`;
}

function openMealReadModal(meal) {
  openSharedModal({
    title: meal.title,
    size: 'md',
    content: mealReadHtml(meal),
    onSave(panel) {
      if (window.lucide) window.lucide.createIcons({ el: panel });
    },
  });
}

function openMealModal(opts) {
  // Der Riegel steht VOR jeder Vorbereitung, und er steht HIER, weil FAB,
  // Tagesknopf, leerer Platz, Leerzustand, Rezept-Spalte und Karte alle diesen
  // Weg nehmen: bei `read` geht fuer eine Mahlzeit die Leseansicht auf, und
  // Anlegen gibt es nicht. Den FAB blendet CSS aus
  // (html[data-module-readonly]) - ausgeblendet ist nicht unerreichbar.
  if (readOnly()) {
    if (opts?.mode === 'edit' && opts.meal) openMealReadModal(opts.meal);
    return;
  }
  // `cookTouched`: hat jemand in DIESEM Dialog den Koch gewaehlt? Siehe
  // wireCookPicker() - mit jedem Oeffnen wieder false.
  state.modal = { ...opts, cookTouched: false };
  const { mode, date, mealType, meal } = opts;
  const isEdit = mode === 'edit';

  // Scheiterte der Abruf der Mitglieder beim Laden der Seite, ist die Liste
  // leer und die Auswahl boete nur "Niemand" an. Ein Haushalt ohne Mitglieder
  // gibt es nicht - eine leere Liste heisst hier immer "nicht geladen". Der
  // Dialog geht sofort auf und bekommt seine Auswahl nachgereicht
  // (refreshCookPicker()); `state.members` bleibt die eine Buchfuehrung.
  const membersMissing = state.members.length === 0;

  const content = buildModalContent(opts);
  // Der Kopf nennt Mahlzeit und Tag ("Kolacja · czw 22 paź"); syncSheet()
  // zieht ihn nach, wenn beides im Blatt geaendert wird.
  const sheetType = MEAL_TYPES().some((mt) => mt.key === mealType) ? mealType : MEAL_TYPES()[0]?.key;

  openSharedModal({
    title: date ? t('meals.sheetTitle', { meal: mealTypeLabel(sheetType), day: shortDayLabel(date) }) : (isEdit ? t('meals.editMeal') : t('meals.addMealTitle')),
    content,
    size: 'md',
    onSave(panel) {
      wireMealTypeChips(panel);
      // Zutaten
      const ingList   = panel.querySelector('#ingredient-list');
      const addIngBtn = panel.querySelector('#add-ingredient-btn');
      const recipeSelect = panel.querySelector('#modal-recipe-id');
      const recipeScaleInput = panel.querySelector('#modal-recipe-scale');
      const saveAsRecipeBtn = panel.querySelector('#modal-save-as-recipe');
      let currentAppliedRecipe = null;

      const applyRecipe = (recipeId) => {
        const id = Number(recipeId);
        const factor = Math.max(Number(recipeScaleInput?.value || 1), 0.1);
        if (!id) {
          currentAppliedRecipe = null;
          return;
        }
        const recipe = state.recipes.find((r) => r.id === id);
        if (!recipe) return;

        currentAppliedRecipe = recipe;

        panel.querySelector('#modal-title').value = recipe.title || '';
        panel.querySelector('#modal-notes').value = recipe.notes || '';
        panel.querySelector('#modal-recipe-url').value = recipe.recipe_url || '';

        // TAFLA: die Zutaten des Rezepts kommen als Chips - gedrueckt, was zu
        // kaufen ist, "· masz", was der Vorrat hat. Eigene Zeilen bleiben fuer
        // das, was jemand von Hand dazuschreibt.
        ingList.replaceChildren();
        ingList.insertAdjacentHTML('beforeend', buyFirst(recipe.ingredients || [])
          .map((ing) => ingredientChipHtml({
            name: ing.name,
            quantity: scaleQuantityText(ing.quantity ?? '', factor),
            category: ing.category ?? DEFAULT_CATEGORY_NAME,
          }))
          .join(''));

        if (window.lucide) lucide.createIcons({ el: ingList });
        setIngredientSource(panel, recipe.ingredients?.length ? 'recipe' : null);
        syncSheetRecipeRow(panel);
        syncSheet(panel);
      };

      recipeSelect?.addEventListener('change', () => {
        if (recipeScaleInput) recipeScaleInput.value = '1';
        applyRecipe(recipeSelect.value);
        syncSheetRecipeRow(panel);
      });

      // Namensfeld als Combobox (Re-Kritik 2026-09-28, A4 P1-1): ein
      // Rezepttreffer geht denselben Weg wie die Rezeptauswahl darunter.
      const chooseRecipe = (id) => {
        if (recipeSelect) recipeSelect.value = String(id);
        if (recipeScaleInput) recipeScaleInput.value = '1';
        applyRecipe(id);
      };
      wireMealTitleCombobox(panel, { onRecipe: chooseRecipe });
      // Aus der Rezept-Spalte geoeffnet: das Rezept ist schon gewaehlt, also
      // stehen Titel, Zutaten und Notizen gleich da.
      if (opts.recipeId) chooseRecipe(opts.recipeId);

      recipeScaleInput?.addEventListener('input', () => {
        const currentRecipeId = Number(recipeSelect?.value || 0);
        if (!currentRecipeId || !currentAppliedRecipe) return;

        const factor = Number(recipeScaleInput.value || 1);
        if (!Number.isFinite(factor) || factor <= 0) return;

        ingList.replaceChildren();
        ingList.insertAdjacentHTML('beforeend', buyFirst(currentAppliedRecipe.ingredients || [])
          .map((ing) => ingredientChipHtml({
            name: ing.name,
            quantity: scaleQuantityText(ing.quantity ?? '', Math.max(factor, 0.1)),
            category: ing.category ?? DEFAULT_CATEGORY_NAME,
          }))
          .join(''));

        if (window.lucide) lucide.createIcons({ el: ingList });
      });

      saveAsRecipeBtn?.addEventListener('click', async () => {
        // Die Rechte koennen sich aendern, waehrend der Dialog offen steht.
        if (!mayWritePath('/recipes')) return;
        const title = panel.querySelector('#modal-title').value.trim();
        if (!title) {
          reportFieldError(panel.querySelector('#modal-title'), t('common.nameRequired'));
          return;
        }

        const notes = panel.querySelector('#modal-notes').value.trim() || null;
        const recipe_url = panel.querySelector('#modal-recipe-url').value.trim() || null;
        const ingredients = collectModalIngredients(panel, { allChips: true }).map((ing) => ({
          name: ing.name,
          quantity: ing.quantity,
          category: ing.category,
        }));

        saveAsRecipeBtn.disabled = true;
        try {
          const created = await api.post('/recipes', { title, notes, recipe_url, ingredients });
          state.recipes.push(created.data);
          renderRecipeSidebar();

          if (recipeSelect) {
            const option = document.createElement('option');
            option.value = String(created.data.id);
            option.textContent = created.data.title;
            recipeSelect.appendChild(option);
            recipeSelect.value = String(created.data.id);
          }

          window.yuvomi?.showToast(t('recipes.created'), 'success');
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
        } finally {
          saveAsRecipeBtn.disabled = false;
        }
      });

      addIngBtn.addEventListener('click', () => {
        const tmp  = document.createElement('div');
        tmp.insertAdjacentHTML('beforeend', ingredientRowHTML({ categories: mealCategories() }));
        const row = tmp.firstElementChild;
        ingList.appendChild(row);
        if (window.lucide) lucide.createIcons({ el: ingList });
        row.querySelector('input').focus();
      });

      ingList.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="remove-ingredient"]');
        if (btn) btn.closest('.ingredient-row').remove();
      });

      wireIngredientSuggestions(panel, ingList);

      // Einkaufslisten-Transfer. Ohne Liste steht hier statt des toten
      // Auswahlfelds die geteilte Antwort samt Ausweg - `beforeLeave` schließt
      // das Modal, sonst bliebe es über dem Einkaufs-Tab stehen.
      mountMissingShoppingList(
        panel.querySelector('#transfer-missing'),
        { beforeLeave: () => closeModal({ force: true }) },
      );

      panel.querySelector('#transfer-btn')?.addEventListener('click', async () => {
        const selectEl = panel.querySelector('#transfer-list-select');
        const listId   = parseInt(selectEl?.value, 10);
        if (!listId || !state.modal?.meal) return;
        // Zweite Linie hinter dem Markup (Regel 2 in utils/module-access.js):
        // die Rechte koennen sich aendern, waehrend der Dialog offen steht.
        if (!mayTransferMealToShopping(state.modal.meal.id)) return;
        const btn = panel.querySelector('#transfer-btn');
        btn.disabled = true;
        try {
          const res = await api.post(`/meals/${state.modal.meal.id}/to-shopping-list`, { listId });
          if (res.data.transferred > 0) {
            await loadWeek(state.currentWeek);
            closeModal({ force: true });
            renderWeekGrid();
            // Dieselbe Meldung, Standzeit und Rücknahme wie am Slot-Knopf: es ist
            // derselbe Transfer, nur ein anderer Auslöser.
            announceTransfer({
              message: t('meals.transferSuccess', {
                count: res.data.transferred,
                list: state.lists.find((l) => l.id === listId)?.name ?? '',
              }),
              addedIds: res.data.added_ids ?? [],
              onUndone: async () => {
                await loadWeek(state.currentWeek);
                renderWeekGrid();
                refocusAfterRender();
              },
            });
          } else {
            window.yuvomi?.showToast(t('meals.transferAlreadyDone'), 'info');
            btn.disabled = false;
          }
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
          btn.disabled = false;
        }
      });

      // Das Wiederholungs-Ende gehört zur Wiederholung, nicht zur Mahlzeit: es
      // zeigt sich nur, wenn die Serie überhaupt im Spiel ist - beim Anlegen mit
      // gesetztem Schalter, beim Bearbeiten im Serien-Umfang.
      const repeatUntilGroup = panel.querySelector('#modal-repeat-until-group');
      const repeatToggle     = panel.querySelector('#modal-repeat-weekly');
      const editScopeSelect  = panel.querySelector('#modal-edit-scope');

      repeatToggle?.addEventListener('change', () => {
        repeatUntilGroup.hidden = !repeatToggle.checked;
      });
      editScopeSelect?.addEventListener('change', () => {
        repeatUntilGroup.hidden = editScopeSelect.value !== 'series';
        showCookForScope(panel, meal);
      });

      wireIngredientCount(panel);
      wireCookPicker(panel);
      if (membersMissing) {
        refreshCookPicker(panel, isEdit ? meal : null)
          .catch((err) => console.error('[Meals] refreshCookPicker Fehler:', err));
      }

      // "Anuluj" gibt es im Tafla-Blatt nicht mehr; das X im Kopf schliesst.
      panel.querySelector('#modal-cancel')?.addEventListener('click', closeModal);
      /* EIN ABGEBROCHENES SERIEN-LOESCHEN NAHM DEN EDITOR MIT (Codex an #1485):
       * der Knopf schloss den Dialog, bevor deleteMeal() nach dem Umfang
       * fragte - brach man dort ab, war nichts geloescht, aber Editor und
       * ungespeicherte Aenderungen waren weg. Die Frage steht jetzt ueber dem
       * geparkten Editor; zu geht er erst, wenn wirklich geloescht wird. */
      panel.querySelector('#modal-delete')?.addEventListener('click', async () => {
        let scope;
        if (meal.recurrence_template_id) {
          scope = await askOverModal(() => selectModal(...mealDeleteScopeQuestion()));
          if (scope === null || scope === undefined) return;
        }
        closeModal({ force: true });
        deleteMeal(meal.id, { scope });
      });
      panel.querySelector('#modal-save').addEventListener('click', () => saveModal(panel));
      // Pflichtfelder melden sich beim Verlassen inline (geteiltes Muster).
      wireBlurValidation(panel);
      wireSheet(panel);
    },
  });
}

/** Name des Koch-Wahlfelds im Mahlzeit-Dialog (`data-ms-name`). */
const COOK_INPUT = 'meal_cook';

/**
 * Die Koch-Auswahl des Dialogs (#1679): die Personenauswahl des
 * Aufgabendialogs, auf eine Person begrenzt (`bindUserMultiSelect(..., {
 * single })` in openMealModal).
 *
 * WER SCHON KOCHT, STEHT IN DER AUSWAHL, auch wenn er kein Mitglied (mehr) ist
 * - `withChosenPeople()`. Fehlte er, bekaeme er kein Haekchen, und das naechste
 * Speichern naehme ihn still heraus, obwohl der Server einen gespeicherten Koch
 * ausdruecklich weiter annimmt.
 *
 * IM SOLO-HAUSHALT VERBORGEN, NICHT ENTFERNT (utils/household.js): eine Reihe
 * aus der Nutzerin selbst und "Niemand" fragt nach etwas mit einer einzigen
 * Antwort. Das Feld bleibt im DOM und behaelt seinen Wert, der Absende-Pfad
 * liest es unveraendert - dieselbe Regel wie "Zugewiesen an" bei den Aufgaben.
 */
function cookPickerHtml(meal) {
  const cook = mealCook(meal);
  const people = withChosenPeople(state.members, cook ? [cook] : []);
  const hidden = isSoloHousehold() && people.length <= 1;
  return `
    <div class="form-group meal-modal__cook"${hidden ? ' hidden' : ''}>
      ${renderUserMultiSelect(people, cook ? [cook.id] : [], COOK_INPUT, 'meals.cookLabel')}
    </div>`;
}

/** Die im Dialog gewaehlte Koch-id oder null ("Niemand"). */
function selectedCookId(overlay) {
  return getSelectedUserIds(overlay, COOK_INPUT)[0] ?? null;
}

/**
 * Verdrahtet die Koch-Auswahl des Dialogs.
 *
 * Eine Mahlzeit hat EINEN Koch: dieselbe Auswahl wie bei den Zustaendigen einer
 * Aufgabe, aber eine neue Wahl loest die vorige ab (#1679).
 *
 * DER BERUEHRT-MERKER (`state.modal.cookTouched`). Der Dialog zeigt beim Oeffnen
 * den Koch DIESER Mahlzeit; "ganze Serie" schreibt einen mitgeschickten Koch
 * aber auf die Vorlage und auf JEDE Mahlzeit der Serie. Aus den gespeicherten
 * Staenden laesst sich nicht lesen, ob der gezeigte Koch GEWAEHLT oder nur
 * GEZEIGT ist: "Ben bewusst fuer die ganze Serie" und "nur den Titel geaendert,
 * waehrend an dieser Woche Ben steht" ergeben dieselben Werte (Review zu
 * #1739: eine Titelaenderung machte aus Anna/Ben/Carla dreimal Ben, und von
 * einer Woche ohne Koch aus leerte sie die ganze Serie samt Vorlage). Also
 * zaehlt, was der Nutzer GETAN hat: ein `change` an der Auswahl. Das
 * programmatische Umstellen in showCookForScope() loest kein Ereignis aus und
 * setzt den Merker nicht.
 */
function wireCookPicker(panel) {
  bindUserMultiSelect(panel, COOK_INPUT, { single: true });
  panel.querySelector(`.user-ms[data-ms-name="${COOK_INPUT}"]`)?.addEventListener('change', () => {
    if (state.modal) state.modal.cookTouched = true;
  });
}

/**
 * Der Koch, den die Auswahl im gewaehlten Umfang ZEIGT, solange niemand
 * gewaehlt hat: bei "nur diese Mahlzeit" der Koch der Mahlzeit, bei "ganze
 * Serie" der Koch der Vorlage (`recurrence_cook_user_id`). Sonst stuende im
 * Serien-Umfang ein Name da, den die Serie gar nicht hat.
 *
 * NUR, WENN ES DIE PERSON IN DER AUSWAHL GIBT. Ein Koch der Vorlage, der kein
 * Mitglied (mehr) ist, hat keine Zeile - die Auswahl nennt neben den
 * Mitgliedern nur den gespeicherten Koch DIESER Mahlzeit. Dann bleibt stehen,
 * was da stand; gesendet wird ohne Beruehrung ohnehin nichts.
 *
 * Eine beruehrte Auswahl bleibt beim Wechsel des Umfangs, wie sie ist. Setzt
 * `checked` direkt und loest kein `change` aus - siehe wireCookPicker().
 */
function showCookForScope(panel, meal) {
  if (!meal?.recurrence_template_id || state.modal?.cookTouched) return;
  const scope = panel.querySelector('#modal-edit-scope')?.value || 'single';
  const shown = (scope === 'series' ? meal.recurrence_cook_user_id : meal.cook_user_id) ?? null;
  const boxes = [...panel.querySelectorAll(`[data-ms-input="${COOK_INPUT}"]`)];
  const isNone = (box) => box.classList.contains('user-ms__none');
  if (shown !== null && !boxes.some((box) => !isNone(box) && Number(box.value) === shown)) return;
  for (const box of boxes) box.checked = isNone(box) ? shown === null : Number(box.value) === shown;
}

/**
 * Reicht dem offenen Dialog die Auswahl nach, wenn die Mitgliederliste beim
 * Oeffnen leer war (gescheiterter Abruf, siehe loadMembers()). Ersetzt wird nur,
 * wenn derselbe Dialog noch offen ist und niemand gewaehlt hat - eine Wahl aus
 * der unvollstaendigen Liste ("Niemand") ueberschriebe das neue Markup sonst.
 *
 * DER TAUSCH IST KEINE EINGABE (#1784). Die neuen Checkboxen kennt die Basis
 * des Verwerfen-Waechters nicht: das Schliessen des unberuehrten Dialogs
 * fragte "Aenderungen verwerfen?". Die Basis einfach neu aufzunehmen waere die
 * andere Luege - sie froere mit ein, was bis dahin getippt wurde. Der Tausch
 * laeuft deshalb ueber swapFieldsKeepingDirtyBase(), samt der Vorauswahl aus
 * showCookForScope(): sie gehoert zum Ausgangsstand der neuen Felder.
 */
async function refreshCookPicker(panel, meal) {
  const opened = state.modal;
  await loadMembers();
  if (!state.members.length || state.modal !== opened || opened.cookTouched) return;
  const old = panel.querySelector('.meal-modal__cook');
  if (!old) return;
  swapFieldsKeepingDirtyBase(panel, () => {
    old.insertAdjacentHTML('afterend', cookPickerHtml(meal));
    old.remove();
    wireCookPicker(panel);
    showCookForScope(panel, meal);
  });
}

/** Beschriftung des Zutaten-Aufklappers: "Zutaten · 6" (wie "Geplant · n" im Budget). */
function ingredientsFoldLabel(count) {
  return `${t('meals.ingredientsLabel')} · ${count}`;
}

/**
 * Haelt den Zaehler am Zutaten-Aufklapper nach, wenn Zeilen dazukommen oder
 * gehen (Hinzufuegen, Entfernen, ein Rezept ersetzt die Liste). Ohne
 * Aufklapper (Anlegen, keine Zutaten) passiert nichts.
 */
function wireIngredientCount(panel) {
  const label = panel.querySelector?.('#modal-ingredients-fold .form-advanced__summary > span');
  const list = panel.querySelector?.('#ingredient-list');
  if (!label || !list || typeof MutationObserver !== 'function') return;
  new MutationObserver(() => {
    label.textContent = ingredientsFoldLabel(list.querySelectorAll('.ingredient-row').length);
  }).observe(list, { childList: true });
}

/* Die Mahlzeitart als Radiogruppe aus Chips (buildModalContent): Klick und
 * Pfeiltasten waehlen, das versteckte `#modal-type` haelt den Wert. Roving
 * tabindex wie beim Segment: EIN Tab-Halt, die Pfeile wandern. */
function wireMealTypeChips(panel) {
  const group = panel.querySelector?.('#modal-type-chips');
  const field = panel.querySelector?.('#modal-type');
  if (!group || !field) return;
  const chips = () => [...group.querySelectorAll('[data-meal-type]')];
  const select = (chip, { focus = false } = {}) => {
    for (const other of chips()) {
      const on = other === chip;
      other.setAttribute('aria-checked', String(on));
      other.tabIndex = on ? 0 : -1;
      other.classList.toggle('filter-chip--active', on);
    }
    if (field.value !== chip.dataset.mealType) {
      field.value = chip.dataset.mealType;
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (focus) chip.focus();
  };
  group.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-meal-type]');
    if (chip) select(chip);
  });
  group.addEventListener('keydown', (e) => {
    const list = chips();
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const dir = getComputedStyle(group).direction === 'rtl' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') ? -step : step;
    select(list[(i + dir + list.length) % list.length], { focus: true });
  });
}

// --------------------------------------------------------
// Tafla-Blatt "Dodaj posiłek": Tage, Zutaten-Chips, Schalter, Primaerknopf
// --------------------------------------------------------

/** Sieben Tag-Chips der Woche, in der `date` liegt; der gewaehlte getoent. */
function sheetDayChipsHtml(date) {
  const monday = getMondayOf(date || todayKey());
  const today = todayKey();
  const chips = Array.from({ length: 7 }, (_, i) => {
    const day = addDays(monday, i);
    const on = day === date;
    const name = `${dayLongName(day)} ${dayMonthLabel(day)}${day === today ? `, ${lowerFirst(t('meals.today'))}` : ''}`;
    return `<button type="button" class="meal-sheet__day${on ? ' meal-sheet__day--on' : ''}" role="radio" data-date="${day}"
              aria-checked="${on}" tabindex="${on ? '0' : '-1'}" aria-label="${esc(name)}">
        <span class="meal-sheet__day-name" aria-hidden="true">${esc(day === today ? t('meals.todayShort') : t(STRIP_DAY_KEYS[i]))}</span>
        <span class="meal-sheet__day-num" aria-hidden="true">${esc(String(Number(day.slice(8))))}</span>
      </button>`;
  }).join('');
  return `${chips}
      <button type="button" class="meal-sheet__other-day" id="meal-sheet-other-day" aria-expanded="false" aria-controls="meal-sheet-date-group"
              aria-label="${esc(t('meals.sheetOtherDay'))}" title="${esc(t('meals.sheetOtherDay'))}"><i data-lucide="calendar-days" aria-hidden="true"></i></button>`;
}

/** Darf das Blatt beim Anlegen gleich auf die Liste schreiben? */
function sheetCanAddToList() {
  return !globalThis.window?.yuvomi?.isModuleDisabled?.('shopping') && mayWritePath('/shopping') && state.lists.length > 0;
}

/** Der Primaerknopf nennt das Ergebnis: "Dodaj kolację i 4 produkty". */
function sheetPrimaryLabel({ isEdit, mealType, count }) {
  const meal = mealTypeInSentence(mealType || 'dinner');
  if (isEdit) return t('meals.sheetSave', { meal });
  return count > 0 ? t('meals.sheetAddWithItems', { meal, count }) : t('meals.sheetAdd', { meal });
}

/**
 * Eine Zutat als Chip (Tafla-Blatt). Gedrueckt = sie wird Zutat der Mahlzeit
 * und geht mit dem Schalter auf die Liste; was der Vorrat hat, startet
 * ungedrueckt als "· masz" - dieselbe Regel wie die Vorschlaege bisher.
 */
function ingredientChipHtml({ name, quantity = '', category = DEFAULT_CATEGORY_NAME, source = 'recipe', have = inPantry(name), buy = !have }) {
  return `<button type="button" class="ingredient-chip" aria-pressed="${buy}" data-have="${have ? '1' : '0'}"
            data-name="${esc(name)}" data-qty="${esc(quantity ?? '')}" data-category="${esc(category || DEFAULT_CATEGORY_NAME)}"
            data-source="${esc(source)}">${ingredientChipInner({ name, quantity, have, buy })}</button>`;
}

/** Was zu kaufen ist zuerst, dann was der Vorrat hat - in sich in der Reihenfolge der Quelle. */
function buyFirst(ingredients, have = (ing) => inPantry(ing.name)) {
  return [...ingredients].sort((a, b) => Number(have(a)) - Number(have(b)));
}

function ingredientChipInner({ name, quantity, have, buy }) {
  const text = have && !buy ? t('meals.chipHave', { name }) : [name, quantity].filter(Boolean).join(' ');
  const icon = buy ? 'check' : (have ? 'archive' : 'plus');
  return `<i data-lucide="${icon}" class="ingredient-chip__icon" aria-hidden="true"></i><span class="ingredient-chip__text">${esc(text)}</span>`;
}

function toggleIngredientChip(chip) {
  const buy = chip.getAttribute('aria-pressed') !== 'true';
  chip.setAttribute('aria-pressed', String(buy));
  chip.replaceChildren();
  chip.insertAdjacentHTML('beforeend', ingredientChipInner({
    name: chip.dataset.name, quantity: chip.dataset.qty, have: chip.dataset.have === '1', buy,
  }));
  if (window.lucide) lucide.createIcons({ el: chip });
}

/** Wie viele Produkte das Speichern auf die Liste schreibt: gedrueckte Chips und eigene Zeilen. */
function sheetBuyCount(panel) {
  const chips = panel.querySelectorAll?.('.ingredient-chip[aria-pressed="true"]')?.length ?? 0;
  const rows = [...(panel.querySelectorAll?.('.ingredient-row') ?? [])]
    .filter((row) => !row.dataset.ingId && row.querySelector('.ingredient-row__name')?.value.trim()).length;
  return chips + rows;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Haelt Titel, Schalter-Zeile und Primaerknopf beim Tippen auf dem Stand:
 * "Kolacja · czw 22 paź", "Cotygodniowe · 4 produkty", "Dodaj kolację i 4 produkty".
 */
function syncSheet(panel) {
  if (!panel?.querySelector) return;
  const isEdit = state.modal?.mode === 'edit';
  const type = panel.querySelector('#modal-type')?.value || 'dinner';
  const dateRaw = panel.querySelector('#modal-date')?.value || '';
  const date = ISO_DATE.test(dateRaw) ? dateRaw : parseDateInput(dateRaw);
  const title = panel.closest?.('.modal-overlay')?.querySelector('.modal-panel__title') ?? null;
  if (title && date) title.textContent = t('meals.sheetTitle', { meal: mealTypeLabel(type), day: shortDayLabel(date) });
  const count = sheetBuyCount(panel);
  const toggle = panel.querySelector('#meal-sheet-to-list');
  const on = toggle?.getAttribute?.('aria-checked') === 'true';
  const meta = panel.querySelector('#meal-sheet-to-list-meta');
  if (meta && state.lists[0]) meta.textContent = t('meals.sheetToListMeta', { list: state.lists[0].name, count });
  const save = panel.querySelector('#modal-save');
  if (save && !save.disabled) save.textContent = sheetPrimaryLabel({ isEdit, mealType: type, count: on ? count : 0 });
}

/** Die Rezept-Zeile unter dem Namen: Teller, Titel, "wasz przepis · 6 składników", Haken. */
function syncSheetRecipeRow(panel) {
  const box = panel.querySelector?.('#meal-sheet-recipe');
  if (!box) return;
  const id = Number(panel.querySelector('#modal-recipe-id')?.value || 0);
  const recipe = id ? state.recipes.find((r) => r.id === id) : null;
  box.replaceChildren?.();
  box.hidden = !recipe;
  if (!recipe) return;
  const source = recipe.source && recipe.source !== 'native'
    ? t(`recipes.source${recipe.source[0].toUpperCase()}${recipe.source.slice(1)}`)
    : t('meals.sheetRecipeOwn');
  const count = recipe.ingredients?.length ?? 0;
  const meta = [source, count ? t('meals.ingredientCount', { count }) : ''].filter(Boolean).join(' · ');
  const plate = recipe.image_data || recipe.provider_has_image
    ? recipeThumbHtml({ recipeId: recipe.id, hasImage: recipe.provider_has_image, hasOwnImage: Boolean(recipe.image_data), className: 'meal-sheet__recipe-plate' })
    : `<span class="meal-sheet__recipe-plate meals-plate" aria-hidden="true"><i data-lucide="${plateIcon(recipe.title)}" class="meals-plate__icon"></i></span>`;
  box.insertAdjacentHTML?.('beforeend', `
    <button type="button" class="meal-sheet__recipe-btn" id="meal-sheet-recipe-unlink" aria-pressed="true"
            aria-label="${esc(t('meals.sheetRecipeLinked', { title: recipe.title }))}">
      ${plate}
      <span class="meal-sheet__recipe-text">
        <span class="meal-sheet__recipe-title">${esc(recipe.title)}</span>
        <span class="meal-sheet__recipe-meta">${esc(meta)}</span>
      </span>
      <i data-lucide="check" class="meal-sheet__recipe-check" aria-hidden="true"></i>
    </button>`);
  if (window.lucide) lucide.createIcons({ el: box });
  wireRecipeThumbs(box);
}

/** Tag-Chips, "Inny dzień", Schalter und Chips des Blatts verdrahten. */
function wireSheet(panel) {
  if (!panel?.querySelector) return;
  panel.classList?.add('meal-sheet');
  panel.closest?.('.modal-overlay')?.classList.add('meal-sheet-overlay');
  const dateEl = panel.querySelector('#modal-date');
  const days = panel.querySelector('#meal-sheet-days');
  const dateGroup = panel.querySelector('#meal-sheet-date-group');
  const selectDay = (day, { focus = false } = {}) => {
    if (!days) return;
    // Liegt der Tag ausserhalb der gezeigten Woche, zeigt die Reihe seine Woche.
    if (!days.querySelector(`[data-date="${day}"]`)) {
      days.replaceChildren();
      days.insertAdjacentHTML('beforeend', sheetDayChipsHtml(day));
      if (window.lucide) lucide.createIcons({ el: days });
    }
    for (const chip of days.querySelectorAll('[data-date]')) {
      const on = chip.dataset.date === day;
      chip.classList.toggle('meal-sheet__day--on', on);
      chip.setAttribute('aria-checked', String(on));
      chip.tabIndex = on ? 0 : -1;
      if (on && focus) chip.focus();
    }
  };
  days?.addEventListener?.('click', (e) => {
    const other = e.target.closest('#meal-sheet-other-day');
    if (other && dateGroup) {
      dateGroup.hidden = !dateGroup.hidden;
      other.setAttribute('aria-expanded', String(!dateGroup.hidden));
      if (!dateGroup.hidden) dateEl?.focus?.();
      return;
    }
    const chip = e.target.closest('[data-date]');
    if (!chip || !dateEl) return;
    dateEl.value = chip.dataset.date;
    selectDay(chip.dataset.date);
    syncSheet(panel);
  });
  days?.addEventListener?.('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const current = e.target.closest?.('[data-date]');
    if (!step || !current || !dateEl) return;
    e.preventDefault();
    const next = addDays(current.dataset.date, step);
    dateEl.value = next;
    selectDay(next, { focus: true });
    syncSheet(panel);
  });
  dateEl?.addEventListener?.('change', () => {
    const iso = ISO_DATE.test(dateEl.value) ? dateEl.value : parseDateInput(dateEl.value);
    if (iso) selectDay(iso);
    syncSheet(panel);
  });
  panel.querySelector('#modal-type')?.addEventListener?.('change', () => syncSheet(panel));

  const toggle = panel.querySelector('#meal-sheet-to-list');
  toggle?.addEventListener?.('click', () => {
    toggle.setAttribute('aria-checked', String(toggle.getAttribute('aria-checked') !== 'true'));
    syncSheet(panel);
  });

  const list = panel.querySelector('#ingredient-list');
  list?.addEventListener?.('click', (e) => {
    const chip = e.target.closest('.ingredient-chip');
    if (!chip) return;
    toggleIngredientChip(chip);
    syncSheet(panel);
  });
  list?.addEventListener?.('input', () => syncSheet(panel));
  if (list?.nodeType === 1 && typeof MutationObserver === 'function') {
    new MutationObserver(() => syncSheet(panel)).observe(list, { childList: true });
  }

  panel.querySelector('#meal-sheet-recipe')?.addEventListener?.('click', (e) => {
    if (!e.target.closest('#meal-sheet-recipe-unlink')) return;
    const select = panel.querySelector('#modal-recipe-id');
    if (select) select.value = '';
    syncSheetRecipeRow(panel);
  });
  syncSheetRecipeRow(panel);
  syncSheet(panel);
}

function buildModalContent({ mode, date, mealType, meal, recipeId = null }) {
  const isEdit   = mode === 'edit';
  const isRecurring = isEdit && meal.recurrence_template_id;
  // MAHLZEITART ALS CHIPS WIE IM REZEPT-DIALOG (Critique 2026-10-16, D4).
  // Rezept und Mahlzeit fragten dieselbe Sache einmal als Chips, einmal als
  // Auswahlliste. Hier ist es eine Einfachauswahl: dieselben Chips, als
  // Radiogruppe (genau einer gewaehlt). Das versteckte Feld `#modal-type`
  // traegt den Wert - Speichern, Dirty-Check und Tests lesen es wie vorher.
  const types = MEAL_TYPES();
  const chosenType = types.some((mt) => mt.key === mealType) ? mealType : types[0]?.key;
  const typeChips = types.map((mt) => {
    const on = mt.key === chosenType;
    return `<button type="button" class="filter-chip meal-type-chip${on ? ' filter-chip--active' : ''}" role="radio"
              data-meal-type="${mt.key}" aria-checked="${on}" tabindex="${on ? '0' : '-1'}">${esc(mt.label)}</button>`;
  }).join('');

  const listOpts = state.lists.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');

  const ingRows = isEdit && meal.ingredients?.length
    ? meal.ingredients.map((ing) => ingredientRowHTML({
        name: ing.name,
        quantity: ing.quantity ?? '',
        id: ing.id,
        category: ing.category ?? DEFAULT_CATEGORY_NAME,
        categories: mealCategories(),
      })).join('')
    : '';

  const hasIngOpen = isEdit && meal.ingredients?.some((i) => !i.on_shopping_list);
  // Der Abschnitt „Auf die Einkaufsliste" entfaellt GANZ, wenn der Server den
  // Transfer abwiese (#1290) - ein Auswahlfeld ohne Knopf verspraeche dasselbe.
  const canTransfer = hasIngOpen && mayTransferMealToShopping(meal.id);

  const chosenRecipeId = isEdit ? meal.recipe_id : recipeId;
  const recipeOptionHtml = (r) => `<option value="${r.id}" ${chosenRecipeId === r.id ? 'selected' : ''}>${esc(r.title)}</option>`;
  // Optgroups nur, sobald gespiegelte Rezepte wirklich vorkommen: ohne Mirror-
  // Account bleibt die flache Liste von vorher unverändert (kein UI-Rauschen).
  const hasMirroredRecipes = state.recipes.some((r) => r.source !== 'native');
  const mirroredSources = [...new Set(state.recipes.map((r) => r.source).filter((s) => s !== 'native'))].sort();
  const recipeOptions = hasMirroredRecipes
    ? [
      `<option value="">${t('meals.savedRecipePlaceholder')}</option>`,
      `<optgroup label="${esc(t('recipes.sourceNative'))}">${state.recipes.filter((r) => r.source === 'native').map(recipeOptionHtml).join('')}</optgroup>`,
      ...mirroredSources.map((s) => `<optgroup label="${esc(t(`recipes.source${s[0].toUpperCase()}${s.slice(1)}`))}">${state.recipes.filter((r) => r.source === s).map(recipeOptionHtml).join('')}</optgroup>`),
    ].join('')
    : [
      `<option value="">${t('meals.savedRecipePlaceholder')}</option>`,
      ...state.recipes.map(recipeOptionHtml),
    ].join('');

  // Wie beim Bearbeiten einer Mahlzeit mit Rezept: aus der Rezept-Spalte
  // geoeffnet, steht die Rezeptauswahl offen da, damit sichtbar ist, WOHER Titel
  // und Zutaten kommen.
  // (Bis R17 Schritt 5 oeffnete auch `isRecurring` den Abschnitt - der
  // Serien-Umfang stand darin. Er steht jetzt oben, siehe `scopeHtml`.)
  const advancedOpen = (isEdit && (!!meal.recipe_id || !!meal.notes || !!meal.recipe_url)) || Boolean(recipeId);

  // DER SERIEN-UMFANG STEHT OBEN (R17 Schritt 5, Critique 2026-10-07 A4 P2).
  // "Aenderung anwenden auf" entscheidet, was Speichern tut - und stand als
  // letztes Feld hinter "Weitere Einstellungen", mobil bei y 1813 von 1899px.
  // Nur die POSITION wechselt: dieselben Knoten mit denselben ids, die
  // Verdrahtung (Wiederholungs-Ende zeigen, Koch der Vorlage zeigen) greift
  // unveraendert.
  const scopeHtml = isRecurring ? `
    <div class="meal-recurrence-note">
      <i data-lucide="repeat-2" class="icon-sm" aria-hidden="true"></i>
      <span>${t('meals.recurrenceEditHint')}</span>
    </div>
    <div class="form-group">
      <label class="form-label" for="modal-edit-scope">${t('meals.editScopeLabel')}</label>
      <select class="form-input" id="modal-edit-scope">
        <option value="single">${t('meals.editScopeSingle')}</option>
        <option value="series">${t('meals.editScopeSeries')}</option>
      </select>
    </div>
    <div class="form-group" id="modal-repeat-until-group" hidden>
      <label class="form-label" for="modal-repeat-until">${t('meals.recurrenceUntilLabel')}</label>
      <yuvomi-datepicker type="date" id="modal-repeat-until"
                         value="${meal.recurrence_end_date ? formatDateInput(meal.recurrence_end_date) : ''}"></yuvomi-datepicker>
      <p class="form-hint">${t('meals.recurrenceUntilHint')}</p>
    </div>` : '';

  const advancedFieldsHtml = `
    <div class="form-group">
      <label class="form-label" for="modal-recipe-id">${t('meals.savedRecipeLabel')}</label>
      <select class="form-input" id="modal-recipe-id">${recipeOptions}</select>
    </div>

    <div class="modal-grid modal-grid--2">
      <div class="form-group">
        <label class="form-label" for="modal-recipe-scale">${t('meals.recipeScaleLabel')}</label>
        <input type="number" class="form-input" id="modal-recipe-scale" min="0.1" step="0.1" value="1">
      </div>
      <div class="form-group" style="display:flex;align-items:flex-end;">
        <button class="btn btn--secondary" id="modal-save-as-recipe" type="button">${t('meals.saveAsRecipe')}</button>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label" for="modal-notes">${t('meals.notesLabel')}</label>
      <textarea class="form-input" id="modal-notes" rows="2"
                placeholder="${t('meals.notesPlaceholder')}">${esc(isEdit && meal.notes ? meal.notes : '')}</textarea>
    </div>

    <div class="form-group">
      <label class="form-label" for="modal-recipe-url">${t('meals.recipeUrlLabel')}</label>
      <input type="url" class="form-input" id="modal-recipe-url"
             placeholder="${t('meals.recipeUrlPlaceholder')}"
             value="${esc(isEdit && meal.recipe_url ? meal.recipe_url : '')}">
    </div>

    ${isEdit ? '' : `
    <div class="meal-recurrence-option">
      <label class="toggle">
        <input type="checkbox" id="modal-repeat-weekly">
        <span class="toggle__track"></span>
        <span>${t('meals.recurrenceLabel')}</span>
      </label>
      <p class="form-hint">${t('meals.recurrenceHint')}</p>
      <div class="form-group" id="modal-repeat-until-group" hidden>
        <label class="form-label" for="modal-repeat-until">${t('meals.recurrenceUntilLabel')}</label>
        <yuvomi-datepicker type="date" id="modal-repeat-until" value=""></yuvomi-datepicker>
        <p class="form-hint">${t('meals.recurrenceUntilHint')}</p>
      </div>
    </div>`}`;

  // TAFLA (Dodaj posiłek): die Mahlzeitart ist ein Segment, der Tag eine
  // Reihe aus sieben Chips der Woche - das Datumsfeld bleibt die Quelle fuer
  // Speichern und Dirty-Check und steht hinter "Inny dzień" fuer alles
  // ausserhalb dieser Woche. Die Ueberschriften bleiben fuer Screenreader.
  const whenHtml = `
    <div class="form-group meal-sheet__when">
      <span class="form-label sr-only" id="modal-type-label">${t('meals.mealTypeLabel')}</span>
      <div class="meal-type-chips" id="modal-type-chips" role="radiogroup" aria-labelledby="modal-type-label">${typeChips}</div>
      <input type="hidden" id="modal-type" value="${esc(chosenType ?? '')}">
      <div class="meal-sheet__days" id="meal-sheet-days" role="radiogroup" aria-label="${esc(t('meals.sheetDays'))}">${sheetDayChipsHtml(date)}</div>
    </div>
    <div class="form-group meal-sheet__date" id="meal-sheet-date-group" hidden>
      <label class="form-label" for="modal-date">${t('meals.dateLabel')}</label>
      <yuvomi-datepicker type="date" id="modal-date" value="${formatDateInput(date)}"></yuvomi-datepicker>
    </div>
`;
  // Kein sichtbares Label und kein Stern (Tafla-Blatt): das Feld traegt den
  // Platzhalter, das Label bleibt fuer Screenreader samt Pflicht-Zeichen.
  const nameHtml = `
    <div class="form-group meal-sheet__name" style="position:relative;">
      <label class="form-label sr-only" for="modal-title">${t('common.nameLabel')}${REQUIRED_MARK}</label>
      <input type="text" class="form-input" id="modal-title" required
             placeholder="${t('meals.titlePlaceholder')}"
             value="${esc(isEdit ? meal.title : '')}"
             autocomplete="off" role="combobox" aria-autocomplete="list"
             aria-expanded="false" aria-controls="modal-autocomplete">
      <div id="modal-autocomplete" class="meal-modal__autocomplete" role="listbox"
           aria-label="${esc(t('meals.suggestionsLabel'))}" hidden></div>
      <div class="meal-sheet__recipe" id="meal-sheet-recipe" hidden></div>
    </div>
`;
  // NAME ZUERST, IMMER (Re-Critique 2026-09-28 A4 P2-9 fuer den Slot;
  // Critique 2026-10-16 D4 fuer jeden Weg). Der Name ist das Pflichtfeld und
  // traegt die Rezeptvorschlaege des Autocompletes; er steht oben und bekommt
  // den Fokus. Vorher fuehrte ohne Slot (FAB, Kurzbefehl) das Datum - der
  // Dialog fokussierte "Datum", das Pflichtfeld stand an dritter Stelle.
  // Darunter Mahlzeitart (Chips) und Tag.
  // ZUTATEN BEIM BEARBEITEN EINGEKLAPPT, MIT ZAEHLER (R17 Schritt 5). Eine
  // Zutatenzeile misst mobil 104px; mit sechs Zutaten lag alles Weitere zwei
  // Bildschirme tiefer. Wer eine bestehende Mahlzeit oeffnet, aendert meist
  // Tag, Koch oder Umfang - die Zutaten stehen hinter dem geteilten Aufklapper,
  // der ihre Zahl nennt (wireIngredientCount haelt sie nach). Beim Anlegen und
  // ohne Zutaten bleibt der Abschnitt offen wie bisher: dort IST er die Arbeit.
  const ingCount = isEdit ? (meal.ingredients?.length ?? 0) : 0;
  const ingFieldsHtml = `
      <div class="ingredient-list" id="ingredient-list">${ingRows}</div>
      <div class="ingredient-suggest" id="ingredient-suggest" aria-live="polite" hidden></div>
      <button class="btn btn--secondary add-ingredient-btn" id="add-ingredient-btn" type="button">
        <i data-lucide="plus" class="icon-md" aria-hidden="true"></i>
        ${t('meals.addIngredient')}
      </button>`;
  const ingredientsHtml = ingCount > 0
    ? `<div class="meal-ingredients-fold" id="modal-ingredients-fold">
      ${advancedSection(ingFieldsHtml, { label: ingredientsFoldLabel(ingCount) })}
    </div>`
    : `
    <div class="form-group meal-ingredients">
      <label class="form-label">${t('meals.ingredientsLabel')}</label>${ingFieldsHtml}
    </div>`;

  // "Dopisz brakujące do listy" (Tafla): beim Anlegen ein Schalter statt des
  // Transfer-Abschnitts - was gewaehlt ist, geht mit dem Speichern auf die
  // erste Liste. Nur, wo der Einkauf beschreibbar ist und eine Liste hat.
  const toListHtml = !isEdit && sheetCanAddToList() ? `
    <div class="meal-sheet__switch">
      <span class="meal-sheet__switch-text">
        <span class="meal-sheet__switch-title" id="meal-sheet-to-list-label">${esc(t('meals.sheetToList'))}</span>
        <span class="meal-sheet__switch-meta" id="meal-sheet-to-list-meta">${esc(t('meals.sheetToListMeta', { list: state.lists[0].name, count: 0 }))}</span>
      </span>
      <button type="button" class="meal-sheet__toggle" id="meal-sheet-to-list" role="switch" aria-checked="true"
              aria-labelledby="meal-sheet-to-list-label" aria-describedby="meal-sheet-to-list-meta"><span class="meal-sheet__toggle-knob"></span></button>
    </div>` : '';

  return `
    ${scopeHtml}
    ${nameHtml + whenHtml}
    ${cookPickerHtml(isEdit ? meal : null)}

    ${ingredientsHtml}
    ${toListHtml}

    ${advancedSection(advancedFieldsHtml, { open: advancedOpen, label: t('meals.sheetMore'), hint: t('meals.sheetMoreHint') })}

    ${canTransfer ? `
    <div class="shopping-transfer">
      <div class="shopping-transfer__label">
        <i data-lucide="shopping-cart" class="icon-sm" aria-hidden="true"></i>
        ${t('meals.transferLabel')}
      </div>
      ${state.lists.length ? `
      <select class="shopping-transfer__select" id="transfer-list-select">${listOpts}</select>
      <button class="btn btn--secondary shopping-transfer__btn" id="transfer-btn" type="button">
        ${t('meals.transferNow')}
      </button>`
      // Ohne Liste stand hier ein Auswahlfeld mit einem deaktivierten
      // `<option>` als Begründung und daneben ein Knopf, der nichts tat - ein
      // Bedienelement, das den Grund seiner Nutzlosigkeit in sich trägt, ist die
      // schlechteste der vier Formen dieses Zustands, weil es bedienbar aussieht
      // (Audit 2026-07-30, P1-A). Der Platzhalter wird beim Verdrahten aus dem
      // geteilten Baustein gefüllt.
      : '<div id="transfer-missing" class="shopping-transfer__missing"></div>'}
    </div>` : ''}

    ${/* Loeschen links im Dialogfuss (Kanon, R8 H10): am Desktop war eine
        * Mahlzeit sonst nur ueber den Papierkorb der Karte loeschbar. Es geht
        * denselben Weg wie dort (`deleteMeal`: Serienabfrage, Rueckgaengig). */ ''}
    ${/* KEIN "Anuluj" (Tafla-Blatt): das X im Kopf schliesst, mit Rueckfrage,
        * wenn etwas getippt ist. Der Primaerknopf nennt das Ergebnis
        * ("Dodaj kolację i 4 produkty", sheetPrimaryLabel). */ ''}
    <div class="modal-panel__footer modal-panel__footer--plain meal-sheet__footer">
      ${isEdit ? `<button type="button" class="btn btn--danger-outline" id="modal-delete" data-delete-name="${esc(meal.title)}" style="margin-inline-end:auto"><i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>${esc(t('common.delete'))}</button>` : ''}
      <button class="btn btn--primary meal-sheet__primary" id="modal-save">${esc(sheetPrimaryLabel({ isEdit, mealType: chosenType, count: 0 }))}</button>
    </div>`;
}

function closeModal({ force = false } = {}) {
  closeSharedModal({ force });
  state.modal = null;
}

async function saveModal(overlay) {
  // Zweite Linie hinter openMealModal(): die Rechte koennen sich aendern,
  // waehrend der Dialog offen steht.
  if (readOnly()) return;
  const saveBtn   = overlay.querySelector('#modal-save');
  const dateRaw   = overlay.querySelector('#modal-date').value;
  const date      = parseDateInput(dateRaw);
  const meal_type = overlay.querySelector('#modal-type').value;
  const title     = overlay.querySelector('#modal-title').value.trim();
  const notes     = overlay.querySelector('#modal-notes').value.trim() || null;
  const recipe_url = overlay.querySelector('#modal-recipe-url').value.trim() || null;
  const recipe_id = overlay.querySelector('#modal-recipe-id')?.value || null;
  const cook_user_id = selectedCookId(overlay);
  const repeat_weekly = state.modal?.mode === 'create'
    ? Boolean(overlay.querySelector('#modal-repeat-weekly')?.checked)
    : false;
  const scope = overlay.querySelector('#modal-edit-scope')?.value || 'single';
  // Das Wiederholungs-Ende zählt nur, solange die Serie im Spiel ist: beim
  // Anlegen mit gesetztem Schalter, beim Bearbeiten im Serien-Umfang. Sonst
  // steht im Feld zwar ein Wert, er gehört aber zu keiner der beiden Absichten.
  const seriesScoped   = state.modal?.mode === 'create' ? repeat_weekly : scope === 'series';
  const repeatUntilEl  = overlay.querySelector('#modal-repeat-until');
  const repeatUntilRaw = seriesScoped ? (repeatUntilEl?.value ?? '') : '';
  // Leeres Feld heißt „ohne Ende" und geht als leerer String raus: der Server
  // unterscheidet das ausdrücklich vom fehlenden Feld (Ende bleibt unverändert).
  const repeat_until = repeatUntilRaw ? parseDateInput(repeatUntilRaw) : '';

  // Alle Feldfehler auf einmal, Fokus aufs erste im Bild (Critique R19):
  // der Titel steht oben, wurde aber zuletzt geprueft.
  const dateValid = Boolean(date) && isDateInputValid(dateRaw);
  const untilInvalid = Boolean(repeatUntilRaw) && (!repeat_until || !isDateInputValid(repeatUntilRaw));
  if (reportFieldErrors([
    !title && [overlay.querySelector('#modal-title'), t('common.nameRequired')],
    !dateValid && [overlay.querySelector('#modal-date'), t('calendar.invalidDate')],
    untilInvalid && [repeatUntilEl, t('calendar.invalidDate')],
    dateValid && !untilInvalid && repeat_until && repeat_until < date && [repeatUntilEl, t('meals.recurrenceUntilBeforeStart')],
  ])) return;

  const ingredients = collectModalIngredients(overlay);
  let createdWithIngredients = null;
  // "Dopisz brakujące do listy" (Tafla-Blatt, nur beim Anlegen): an, wenn der
  // Schalter steht und an ist.
  const toListSwitch = overlay.querySelector('#meal-sheet-to-list');
  const addToList = Boolean(toListSwitch) && toListSwitch.getAttribute?.('aria-checked') === 'true' && sheetCanAddToList();

  saveBtn.disabled    = true;
  saveBtn.textContent = '…';

  try {
    const { mode, meal } = state.modal;

    if (mode === 'create') {
      const res     = await api.post('/meals', { date, meal_type, title, notes, recipe_url, recipe_id, cook_user_id, ingredients, repeat_weekly, repeat_until });
      state.meals.push(res.data);
      createdWithIngredients = ingredients.length > 0 ? res.data : null;
    } else {
      if (scope === 'series') {
        // Ganze Serie: Template + alle Instanzen inkl. Zutaten serverseitig aktualisieren.
        //
        // DER KOCH GEHT NUR MIT, WENN IHN JEMAND IN DIESEM DIALOG GEWAEHLT HAT
        // (#1679, `cookTouched` - siehe wireCookPicker()). Der Server schreibt
        // einen mitgeschickten Koch auf die Vorlage und auf JEDE Mahlzeit der
        // Serie; ein fehlendes Feld laesst alle, wie sie sind.
        const seriesBody = { meal_type, title, notes, recipe_url, recipe_id, ingredients, repeat_until };
        if (state.modal.cookTouched) seriesBody.cook_user_id = cook_user_id;
        await api.put(`/meals/${meal.id}?scope=series`, seriesBody);
      } else {
        // Nur diese Instanz
        await api.put(`/meals/${meal.id}`, { date, meal_type, title, notes, recipe_url, recipe_id, cook_user_id });

        // Zutaten synchronisieren
        const existingIds = new Set((meal.ingredients ?? []).map((i) => i.id));
        const keptIds     = new Set(
          ingredients.filter((i) => i.id).map((i) => parseInt(i.id, 10))
        );

        for (const id of existingIds) {
          if (!keptIds.has(id)) await api.delete(`/meals/ingredients/${id}`);
        }
        for (const ing of ingredients) {
          if (!ing.id) await api.post(`/meals/${meal.id}/ingredients`, { name: ing.name, quantity: ing.quantity, category: ing.category });
        }
      }

      // Aktualisierte Woche laden
      await loadWeek(state.currentWeek);
    }

    closeModal({ force: true });
    // TAFLA: mit dem Schalter gehen die gewaehlten Zutaten gleich auf die
    // erste Liste - derselbe Transfer wie an der Karte, mit Ruecknahme.
    if (mode === 'create' && addToList && createdWithIngredients && mayTransferMealToShopping(createdWithIngredients.id)) {
      const created = createdWithIngredients;
      const list = state.lists[0];
      try {
        const res = await api.post(`/meals/${created.id}/to-shopping-list`, { listId: list.id });
        await Promise.all([loadWeek(state.currentWeek), loadListedNames()]);
        renderWeekGrid();
        refocusAfterRender();
        announceTransfer({
          message: t('meals.sheetSavedItems', {
            meal: mealTypeInSentence(meal_type), day: t(DAY_ACC_KEYS[zonedWeekday(date)]), count: res.data?.transferred ?? 0, list: list.name,
          }),
          addedIds: res.data?.added_ids ?? [],
          onUndone: async () => {
            await Promise.all([loadWeek(state.currentWeek), loadListedNames()]);
            renderWeekGrid();
          },
        });
        return;
      } catch (err) {
        // Die Mahlzeit steht - nur der Transfer scheiterte. Die Karte bietet ihn weiter an.
        window.yuvomi?.showToast(errorSentence(err), 'danger');
      }
    }
    renderWeekGrid();
    // Das Ergebnis, nicht der Dialogtitel: „Mahlzeit hinzufügen" als
    // Erfolgsmeldung liest sich wie eine Aufforderung (R16).
    // ONE TAP TO THE SHOPPING LIST (fork, 2026-10-19): a new meal with
    // ingredients offers to put them on the list right from this toast,
    // through the same transfer (list choice, undo) as the meal card.
    if (createdWithIngredients && mayTransferMealToShopping(createdWithIngredients.id)) {
      const created = createdWithIngredients;
      window.yuvomi?.showToast(t('meals.mealSaved'), 'success', 8000, {
        label: t('meals.toShoppingListAction'),
        onClick: () => transferMeal(created.id),
      });
    } else {
      window.yuvomi?.showToast(mode === 'create' ? t('meals.mealSaved') : t('meals.mealUpdated'), 'success');
    }
  } catch (err) {
    // Der Satz der App, nie der Text des Servers (#1909): ein inzwischen
    // geloeschtes Rezept nennt der Server `meals_selected_recipe_not_found`.
    window.yuvomi?.showToast(errorSentence(err), 'danger');
    saveBtn.disabled    = false;
    saveBtn.textContent = sheetPrimaryLabel({ isEdit: state.modal?.mode === 'edit', mealType: meal_type, count: addToList ? ingredients.length : 0 });
  }
}

// --------------------------------------------------------
// Ingredient suggestions in the meal dialog (fork, 2026-10-19)
// A pause after typing the meal (or leaving the field) asks
// POST /meals/ingredient-suggestions - the recipe, the last time this meal was
// cooked, or Haiku when AI is on.
//
// TAFLA: the answer lands as chips IN the ingredient list (no "Add ticked"
// step any more): ticked = goes with the meal and, with the switch on, onto
// the shopping list; what the pantry has starts unticked as "· masz". A new
// answer replaces the previous suggestion chips; a recipe's chips and rows
// typed by hand stay, and while any of them exist nothing is asked.
// --------------------------------------------------------

/** "z przepisu" / "z ostatniego razu" / "propozycja AI" next to the "Składniki" label. */
function setIngredientSource(panel, source) {
  const box = panel.querySelector?.('#ingredient-suggest');
  if (!box) return;
  const text = { recipe: t('meals.suggestFromRecipe'), history: t('meals.suggestFromHistory'), ai: t('meals.suggestFromAi'), loading: t('meals.suggestLoading') }[source] ?? '';
  box.replaceChildren();
  box.hidden = !text;
  if (!text) return;
  const icon = { recipe: 'book-open', history: 'history', ai: 'sparkles', loading: 'sparkles' }[source];
  box.insertAdjacentHTML('beforeend', `<i data-lucide="${icon}" class="ingredient-suggest__icon" aria-hidden="true"></i><span class="ingredient-suggest__label">${esc(text)}</span>`);
  window.lucide?.createIcons({ el: box });
}

function wireIngredientSuggestions(panel, ingList) {
  const box = panel.querySelector('#ingredient-suggest');
  const titleInput = panel.querySelector('#modal-title');
  if (!box || !titleInput || !ingList) return;
  let timer = null;
  let seq = 0;
  let lastTitle = '';
  const hasRows = () => [...ingList.querySelectorAll('.ingredient-row__name')].some((i) => i.value.trim());
  const hasRecipeChips = () => ingList.querySelectorAll('.ingredient-chip[data-source="recipe"]').length > 0;
  const dropSuggestions = () => ingList.querySelectorAll('.ingredient-chip[data-source="suggest"]').forEach((chip) => chip.remove());

  const ask = async () => {
    const title = titleInput.value.trim();
    if (title.length < 3 || title === lastTitle || hasRows() || hasRecipeChips()) return;
    lastTitle = title;
    const mine = ++seq;
    const recipeId = Number(panel.querySelector('#modal-recipe-id')?.value) || undefined;
    setIngredientSource(panel, 'loading');
    try {
      const res = await api.post('/meals/ingredient-suggestions', { title, recipe_id: recipeId });
      if (mine !== seq || !box.isConnected) return;
      const { source, ingredients = [] } = res.data ?? {};
      if (!ingredients.length || hasRows() || hasRecipeChips()) { setIngredientSource(panel, null); return; }
      dropSuggestions();
      ingList.insertAdjacentHTML('afterbegin', buyFirst(ingredients, (ing) => Boolean(ing.in_pantry) || inPantry(ing.name)).map((ing) => {
        const have = Boolean(ing.in_pantry) || inPantry(ing.name);
        return ingredientChipHtml({ name: ing.name, quantity: ing.quantity ?? '', category: ing.category, source: 'suggest', have });
      }).join(''));
      if (window.lucide) lucide.createIcons({ el: ingList });
      setIngredientSource(panel, source);
    } catch {
      if (mine === seq) setIngredientSource(panel, null);
    }
  };

  titleInput.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(ask, 900); });
  titleInput.addEventListener('change', () => { clearTimeout(timer); ask(); });
}

/**
 * Die Zutaten des Dialogs: eigene Zeilen und die GEDRUECKTEN Chips (Tafla).
 * Ein ungedrueckter Chip - "· masz" oder abgewaehlt - ist keine Zutat dieser
 * Mahlzeit, er geht nicht auf die Liste. `allChips` nimmt fuer "Als Rezept
 * speichern" jeden Chip: das Rezept braucht auch, was im Vorrat steht.
 */
function collectModalIngredients(overlay, { allChips = false } = {}) {
  const ingredients = [];
  overlay.querySelectorAll('.ingredient-chip').forEach((chip) => {
    if (!allChips && chip.getAttribute('aria-pressed') !== 'true') return;
    const name = String(chip.dataset.name ?? '').trim();
    if (name) ingredients.push({ name, quantity: chip.dataset.qty || null, category: chip.dataset.category || DEFAULT_CATEGORY_NAME, id: null });
  });
  overlay.querySelectorAll('.ingredient-row').forEach((row) => {
    const name = row.querySelector('.ingredient-row__name').value.trim();
    const qty = row.querySelector('.ingredient-row__qty').value.trim() || null;
    const category = row.querySelector('.ingredient-row__cat')?.value || DEFAULT_CATEGORY_NAME;
    if (name) ingredients.push({ name, quantity: qty, category, id: row.dataset.ingId || null });
  });
  return ingredients;
}

// --------------------------------------------------------
// Mahlzeit löschen
// --------------------------------------------------------

/**
 * Die Umfangs-Frage einer Serien-Mahlzeit als Argumente fuer selectModal():
 * Einzeltermin, alles ab hier oder ganze Serie. Der Editor stellt sie ueber
 * sich selbst (askOverModal), die Karte direkt.
 */
function mealDeleteScopeQuestion() {
  return [t('meals.deleteRecurringTitle'), [
    { value: 'single', label: t('meals.deleteScopeSingle') },
    { value: 'future', label: t('meals.deleteScopeFuture') },
    { value: 'series', label: t('meals.deleteScopeSeries') },
  ]];
}

/**
 * Loescht eine Mahlzeit. `scope` ist der schon erfragte Umfang einer Serie
 * (der Editor fragt ihn ueber sich selbst, bevor er schliesst); ohne ihn
 * fragt die Funktion selbst.
 */
async function deleteMeal(mealId, { scope } = {}) {
  // Vor der Serienfrage und vor dem Ausblenden der Karte: sonst verschwaende
  // sie, und das Rueckgaengig-Fenster endete im 403.
  if (readOnly()) return;
  const meal = state.meals.find((m) => m.id === mealId);

  // Wiederkehrende Mahlzeit: Einzeltermin, alles ab hier oder ganze Serie löschen.
  // „Ab hier" ist der Ausweg, wenn die Serie in der Vergangenheit sinnvoll war und
  // nur nach vorn enden soll - ohne ihn blieb nur, jedes künftige Vorkommen
  // einzeln zu löschen, während die nächste Woche schon wieder eines erzeugte (#619).
  if (meal?.recurrence_template_id) {
    const choice = scope ?? await selectModal(...mealDeleteScopeQuestion());
    if (choice === null) return;

    if (choice === 'series' || choice === 'future') {
      try {
        await api.delete(`/meals/${mealId}?scope=${choice}`);
        await loadWeek(state.currentWeek);
        renderWeekGrid();
        refocusAfterRender();
        window.yuvomi?.showToast(
          choice === 'future' ? t('meals.seriesEndedToast') : t('meals.seriesDeletedToast'),
          'success',
        );
      } catch (err) {
        window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
      }
      return;
    }
    // choice === 'single' → weiter mit der Undo-Löschung unten
  }

  const itemEl = _container.querySelector(`.meal-card[data-meal-id="${mealId}"]`);
  if (itemEl) itemEl.style.display = 'none';
  // Dieselbe Mahlzeit steht in der Telefon-Woche als Zeile oder Herd-Karte.
  const phoneEls = [...(_container.querySelectorAll?.(`.meals-row[data-meal-id="${mealId}"], .meals-hero[data-meal-id="${mealId}"]`) ?? [])];
  for (const el of phoneEls) el.hidden = true;

  scheduleUndoableDelete({
    message: t('meals.deletedToast'),
    commit: async ({ keepalive }) => {
      await api.delete(`/meals/${mealId}`, { keepalive });
      if (keepalive) return; // Seite verschwindet — kein UI-Refresh mehr
      state.meals = state.meals.filter((m) => m.id !== mealId);
      renderWeekGrid();
    },
    restore: (err) => {
      if (itemEl) itemEl.style.display = '';
      for (const el of phoneEls) el.hidden = false;
      if (err) window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    },
  });
}

// --------------------------------------------------------
// Zutaten → Einkaufsliste (Quick-Transfer vom Slot aus)
// --------------------------------------------------------

async function transferMeal(mealId, btn) {
  // Zweite Linie hinter dem Markup (Regel 2 in utils/module-access.js): der
  // Knopf fehlt ohne beide Rechte, und der Handler loest den Aufruf dann auch
  // nicht aus.
  if (!mayTransferMealToShopping(mealId)) return;
  // Vorprüfung, Listenwahl und die Antwort auf „es gibt keine Liste" liegen im
  // geteilten Baustein (utils/kitchen-transfer.js).
  const target = await resolveShoppingTarget(state.lists);
  if (!target) return;

  if (btn) btn.disabled = true;
  try {
    const res = await api.post(`/meals/${mealId}/to-shopping-list`, { listId: target.id });
    if (res.data.transferred > 0) {
      await loadWeek(state.currentWeek);
      renderWeekGrid();
      // Der Toast nennt die ZIEL-Liste. „5 Zutaten übernommen." sagte nicht, wohin -
      // und bei mehreren Listen ist genau das die Frage, die offen bleibt (Critique
      // 2026-07-30, P1). Der Kreislauf endet nicht mit „übernommen", sondern in
      // einer bestimmten Liste.
      //
      // `onUndone` zeichnet die Woche neu: die Rücknahme setzt serverseitig auch
      // `on_shopping_list` zurück, die Zutaten sind danach wieder offen - und die
      // Kachel zeigt den Übernahme-Knopf wieder an.
      announceTransfer({
        message: t('meals.transferSuccess', { count: res.data.transferred, list: target.name }),
        addedIds: res.data.added_ids ?? [],
        onUndone: async () => {
          await loadWeek(state.currentWeek);
          renderWeekGrid();
        },
      });
    } else {
      window.yuvomi?.showToast(t('meals.transferAlreadyDone'), 'info');
    }
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  } finally {
    // Die Kachel wird nach einem Erfolg neu gezeichnet; der Knopf hier ist dann
    // schon ersetzt. Das Zurücksetzen gilt dem Fehlerfall und dem Nichts-zu-tun-Fall.
    if (btn?.isConnected) btn.disabled = false;
  }
}

export const __test = {
  buildRandomMealAssignments,
  // Verschieben per Ziehen (R16): optimistisch, mit Ruecksprung und Meldung.
  moveMeal,
  // Kuechenkopf (Kopfregel mobil): das EINE Werkzeugmenue (test-meals.js).
  mealsToolsMenuHtml,
  mealPayloadFromRecipe,
  // Skalierte Zutatenmenge: haengt an der Format-Locale und ist deshalb nur
  // verhaltensgetrieben pruefbar (siehe test-meals.js).
  scaleQuantityText,
  // Zeitraum-Kopf (#1164): Reihenfolge und Sichtbarkeitsregel des
  // „Heute"-Resets sind verhaltensgetrieben gepinnt (test-meals.js).
  weekNavHtml,
  syncTodayButton,
  getMondayOf,
  formatWeekLabel,
  state,
  // PR #1200 Review Runde 3, Nice-to-have 1: der bisherige Verdrahtungstest
  // las `renderWeekGrid()` als QUELLTEXT (Regex auf den Funktionskoerper) -
  // ein auskommentiertes `// syncTodayButton();` im echten Render-Pfad blieb
  // gruen, solange der String noch irgendwo im Funktionskoerper stand. Dieser
  // Wrapper laesst den TATSAECHLICHEN Render-Pfad laufen (mit einem
  // uebergebenen Test-Container statt des Modul-internen `_container`), damit
  // der Test die echte Verdrahtung prueft, nicht ihre Textform.
  renderWeekGridForTest(container) {
    _container = container;
    renderWeekGrid();
  },
  // PR #1200 Review Runde 3, Nice-to-have 4: pinnt, dass ein Wechsel ueber die
  // 640px-Schwelle das Wochen-Label wirklich neu zeichnet (test-meals.js).
  onNarrowWeekLabelQueryChange,
  // #1317: Griff-Markup und der ECHTE pointerdown-Handler, verhaltensgetrieben
  // gepinnt (test-meals.js, „Ziehgriff").
  renderSlot,
  wireDragDrop,
  // A4 P1 (Critique 2026-09-26): die Reihenfolge Rezept-Spalte -> „heute in den
  // Blick" wird als Programm gefahren (test-meals.js, „Montag").
  revealToday,
  wireRailToggle,
  setContainerForTest(container) { _container = container; _railSettled = false; },
  // #1290: der Transfer in den Einkauf braucht BEIDE Schreibrechte - Markup
  // (Kachel und Dialog) und der Handler werden als Programm gefahren
  // (test-kitchen-transfer-ui.js).
  buildModalContent,
  openMealModal,
  transferMeal,
  // Re-Kritik 2026-09-28 (A4 P1-1): Rezept einplanen ohne Ziehen - Ziel der
  // Spalte, Spalte samt Klick, Vorschlaege des Namensfelds
  // (test-meals-recipe-entry.js).
  railRecipeTarget,
  // #1265: Nur-lesen im Essensplan - Leseansicht, Positivliste, Verdrahtung
  // und jeder Schreibweg als Programm (test-kitchen-readonly-ui.js).
  READ_SAFE_ACTIONS,
  mealsLayoutHtml,
  emptyWeekOptions,
  mealReadHtml,
  wireGrid,
  onGridClick,
  planRecipeFromRail,
  addRecipeToSlot,
  openRandomizeModal,
  runRandomize,
  saveModal,
  deleteMeal,
  renderRecipeSidebar,
  wireRecipeSidebar,
  mealTitleSuggestions,
  // #1679: der Koch einer Mahlzeit - Zeichen an der Karte, Auswahl im Dialog,
  // Wert in der Leseansicht und der Absende-Pfad (test-meals-cook.js).
  mealCook,
  mealCookMarkHtml,
  cookPickerHtml,
  loadMembers,
  showCookForScope,
  // Tafla (2026-10-19): die Telefon-Woche und das Blatt "Dodaj posiłek" -
  // Zaehler, Wochenbereich, Markup der Woche, Chips und Primaerknopf
  // (test-meals.js, Abschnitt "Tafla").
  ingredientMeter,
  meterCaption,
  weekRangeLabel,
  phoneBodyHtml,
  phoneHeadHtml,
  missingIngredients,
  mealNameKey,
  sheetPrimaryLabel,
  ingredientChipHtml,
  collectModalIngredients,
};

// --------------------------------------------------------
// Hilfsfunktion
// --------------------------------------------------------
