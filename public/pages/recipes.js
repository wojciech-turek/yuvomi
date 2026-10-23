/**
 * Modul: Rezepte (Recipes)
 * Zweck: Gespeicherte Rezepte verwalten und in den Essensplan uebernehmen
 */

import { api } from '/api.js';
import { openCookMode } from '/components/cook-mode.js';
import { t, getLocale, formatDate, formatDateInput, parseDateInput, isDateInputValid } from '/i18n.js';
import { esc, REQUIRED_MARK } from '/utils/html.js';
import { openModal as openSharedModal, closeModal as closeSharedModal, advancedSection, wireBlurValidation, reportFieldError, refocusAfterRender, captureModalContext, isModalContextCurrent, isOwnModalOpen } from '/components/modal.js';
import { DEFAULT_CATEGORY_NAME, categoryLabel } from '/utils/shopping-categories.js';
import { renderKitchenTabsBar } from '/utils/kitchen-tabs.js';
import { resolveShoppingTarget, announceTransfer, mayTransferRecipeToShopping } from '/utils/kitchen-transfer.js';
import { popoverMenuHtml, installPopoverMenus } from '/utils/popover-menu.js';
import { ingredientRowHTML } from '/utils/ingredient-row.js';
import { scheduleUndoableDelete } from '/utils/ux.js';
import { normalizeRecipeMealTypes, RECIPE_MEAL_TYPE_KEYS } from '/utils/recipe-meal-types.js';
import { mealPayloadFromRecipe } from '/utils/recipe-to-meal.js';
import { todayKey, parseLocalDateKey } from '/utils/date.js';
import { splitSteps } from '/utils/cook-steps.js';
import '/components/datepicker.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { mountEmptyState, mountLoadError, mountSearchEmpty } from '/utils/empty-state.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import { mealTypeList, ensureMealTypeNames } from '/utils/meal-types.js';
import { recipeThumbEl, recipeHeroEl } from '/utils/recipe-thumb.js';
import { navModuleAccess } from '/permissions.js';
import { mountMasterDetail, splitViewDetailHtml, detailPaneHeaderEl } from '/utils/master-detail.js';
import { openDetailView, closeDetailView, detailFooterEl, withPrimaryEdit } from '/components/detail-view.js';
import { mayWritePath } from '/utils/module-access.js';
import { errorSentence, isGone, isAlreadyDeleted } from '/utils/friendly-error.js';
import { ingredientMatchKey } from '/utils/ingredient-match-key.js';

let _container = null;
/**
 * Rezepte, deren Loeschen gerade im Ruecknahme-Fenster steht: sie stehen noch
 * in `state.recipes` (Rueckgaengig stellt sie zurueck), aber nicht mehr in der
 * Liste. Ein Neuzeichnen in diesem Fenster - etwa nach "gibt es nicht mehr"
 * an einem ANDEREN Rezept - baut die Liste ohne sie (Codex an #2001).
 */
const _pendingDeleteIds = new Set();
/** Handle des geteilten Suchfelds (setValue/clear), gesetzt in render(). */
let _search = null;
/** Handle von Liste + Detail (utils/master-detail.js), gesetzt in render(). */
let _md = null;

const state = {
  recipes: [],
  categories: [],
  // Einkaufslisten für „Auf die Einkaufsliste": nur die Auswahl, keine Artikel.
  lists: [],
  query: '',
  /** Gefangener Fehler des letzten Rezept-Ladevorgangs, sonst null. */
  loadError: null,
  // 'all' | 'native' | 'mealie' | 'tandoor' | ... - Filter-Pille ist nur
  // sichtbar, sobald mindestens ein gespiegeltes Rezept existiert (siehe
  // renderSourceFilter).
  sourceFilter: 'all',
  // Rezept-IDs, die im Wochenplan der AKTUELLEN Woche stehen (loadPlannedRecipes).
  plannedRecipeIds: new Set(),
  // Tafla: recipe id -> the next day (today or later) it is planned this week.
  plannedOn: new Map(),
  // Tafla filter chips: 'all' or a meal type key.
  mealFilter: 'all',
  // What the pantry holds, for "masz 5 z 6": null = unknown (no access, not
  // loaded, failed) - then the detail claims nothing about the pantry.
  pantry: null,
  // Name keys open on any shopping list ("na liście"), null = unknown.
  onList: null,
};

/**
 * Darf dieses Konto Rezepte schreiben? Regel 1 in utils/module-access.js
 * (`/recipes` gehoert dem Scope-Modul `meals`). Als Funktion, damit jedes
 * Neuzeichnen neu fragt.
 *
 * WAS BEI `read` BLEIBT: Suche, Quellenfilter, die Zeile mit Bild, Herkunft,
 * Zutatenzahl und „Diese Woche geplant" - und der Tipp auf sie. Der fuehrt
 * hier schon immer in eine Leseansicht: den Aufklapper der Zeile bzw. die
 * Detailspalte. Was sonst nur im Formular stand (die Mahlzeiten, wenn alle
 * gelten, und die Einkaufskategorie je Zutat), steht bei `read` deshalb DORT -
 * einen eigenen Lese-Dialog gibt es nicht (Regel 9, zweiter Absatz).
 * WAS GEHT: Anlegen (FAB, Leerzustand), Bearbeiten, Duplizieren, Loeschen in
 * Zeile, Ueberlaufmenue und Detailkopf, „In den Essensplan" und die
 * Vorrats-Zuordnung. „AUF DIE EINKAUFSLISTE" FOLGT NICHT DIESEM RECHT: der
 * Server senkt den Pfad-Guard dafuer auf `meals: read` und verlangt
 * `shopping: write` (Regel 8, `mayTransferRecipeToShopping()`) - mit
 * `meals: read` und `shopping: write` bleibt der Knopf also stehen.
 *
 * KEIN WANDTABLETT: siehe readOnly() in meals.js.
 */
function readOnly() {
  return !mayWritePath('/recipes');
}

/**
 * „In den Essensplan" legt eine Mahlzeit an (`POST /meals`). Dasselbe
 * Scope-Modul wie die Rezepte, gefragt wird trotzdem mit dem Pfad, den der
 * Knopf schreibt (Regel 1).
 */
function mayPlanRecipe() {
  return mayWritePath('/meals');
}

/**
 * Die `data-action`s der Seite, die NICHT in die Kueche schreiben - eine
 * Positivliste wie in pantry.js: eine morgen ergaenzte Schreib-Aktion ist bei
 * `read` zu, bis sie hier ausdruecklich steht. `to-shopping` und
 * `to-shopping-missing` ("Dopisz N") schreiben in den Einkauf und tragen ihren
 * eigenen Riegel (`transferRecipe`).
 */
const READ_SAFE_ACTIONS = new Set(['open-detail', 'to-shopping', 'to-shopping-missing']);

/**
 * EIN WEG FUER DIE FEHLER-TOASTS DER SEITE (#1909). Der Toast sagt den Satz der
 * App (`errorSentence`): den Fall, den der Server mit `reason` nennt, sonst den
 * allgemeinen Satz der Stelle - nie den Text des Servers.
 *
 * Sagt der Grund, dass es das Ziel der Handlung nicht mehr gibt (`isGone`: ein
 * anderes Haushaltsmitglied hat das Rezept oder die Einkaufsliste geloescht,
 * der Abgleich mit einer Rezeptquelle hat das Rezept entfernt oder seine
 * Zutaten ersetzt), nimmt die Seite genau dieses Ding aus ihrem Stand
 * (`dropGone`) und zeichnet neu. KEIN NACHLADEN der ganzen Liste: eine
 * verspaetete Antwort ersetzte sonst, was der Nutzer inzwischen getan hat,
 * und die Objekte, die ein offener Dialog haelt (Zuschnitt nach Codex an
 * #2001). Die Aufrufstelle nennt, worum es ging (`recipeId`, `ingredientName`,
 * `listId`). `dialog` ist der Modal-Kontext der Handlung
 * (`captureModalContext()` vor der Anfrage): geschlossen wird nur, wenn genau
 * dieser Dialog noch offen ist - einen inzwischen geoeffneten anderen laesst
 * die Antwort stehen (Codex an #1994).
 *
 * `owner` ist der Container der Seite, VOR der Anfrage gemerkt (wie
 * `dialog`). Erst nach der Antwort gelesen, waere es nach "Seite verlassen
 * und zurueck" der NEUE Container - und eine spaete Antwort nahme etwas aus
 * dem frisch geladenen Stand, das der Nutzer dort inzwischen wieder angelegt
 * hat (Codex an #2001). Zeigt die Seite nicht mehr diesen Container, bleibt
 * es beim Satz: kein Entfernen, kein Zeichnen.
 *
 * @param {unknown} err
 * @param {{ owner?: object|null, fallbackKey?: string, dialog?: object|null, recipeId?: number|null,
 *   recipeRef?: object|null, ingredientName?: string|null, listId?: number|null }} [options]
 */
async function reportError(err, {
  owner = null, fallbackKey = 'common.errorGeneric', dialog = null, recipeId = null, recipeRef = null,
  ingredientName = null, listId = null,
} = {}) {
  window.yuvomi?.showToast(errorSentence(err, fallbackKey), 'danger');
  if (!isGone(err)) return;
  if (dialog && isModalContextCurrent(dialog)) await closeSharedModal({ force: true });
  // Wer die Seite inzwischen verlassen hat (oder neu betreten), bekommt weder
  // seinen Stand angefasst noch etwas gezeichnet.
  if (!stillShown(owner)) return;
  if (!dropGone(err.data.reason, { recipeId, recipeRef, ingredientName, listId })) return;
  // War das das letzte Rezept der gewaehlten Quelle, gibt es die Quelle im
  // Filter nicht mehr: sonst stuende eine leere Liste unter einem leeren Label.
  if (state.sourceFilter !== 'all' && !state.recipes.some((r) => r.source === state.sourceFilter)) {
    state.sourceFilter = 'all';
  }
  renderSourceFilter();
  renderRecipeList({ repaint: true });
  // Der Ausloeser ist mit der Liste neu gebaut: den Fokus auf seinen
  // Nachfolger tragen.
  refocusAfterRender();
}

/**
 * Nimmt aus dem Stand der Seite, was der Server als "gibt es nicht mehr"
 * gemeldet hat. Nur per ID bzw. Name, und `filter` statt Neuaufbau: die
 * uebrigen Rezept- und Zutatenobjekte bleiben dieselben, ein offener
 * Zuordnungsdialog schreibt also weiter in den aktuellen Stand.
 *
 * - Rezept weg (`recipes_recipe_not_found`, beim Einplanen
 *   `meals_selected_recipe_not_found`): das Rezept faellt aus der Liste.
 * - Zutat weg (`recipes_ingredient_not_found`): jede Zutat mit demselben
 *   Schluessel faellt aus dem Rezept - der Server sucht mit
 *   `ingredientMatchKey()` (getrimmt, Leerraum gefaltet, klein), "gibt es
 *   nicht mehr" gilt also fuer "Salz" und "salz" zugleich. Hat der Abgleich die Zutaten ERSETZT, kennt die Seite die neuen
 *   nicht - die zeigt erst das naechste Laden der Seite.
 * - Einkaufsliste weg (`shopping_list_not_found`): die Liste faellt aus der
 *   Auswahl.
 *
 * @returns {boolean} ob sich der Stand geaendert hat
 */
function dropGone(reason, { recipeId, recipeRef, ingredientName, listId }) {
  if (reason === 'recipes_recipe_not_found' || reason === 'meals_selected_recipe_not_found') {
    if (recipeId == null) return false;
    const before = state.recipes.length;
    state.recipes = state.recipes.filter((r) => r.id !== recipeId);
    return state.recipes.length !== before;
  }
  if (reason === 'recipes_ingredient_not_found') {
    // NUR an dem Rezept-Objekt, an dem die Anfrage hing (`recipeRef`, vor
    // der Anfrage gemerkt). Hat der Nutzer das Rezept inzwischen gespeichert,
    // steht dort ein neues Objekt mit dem Stand des Servers - eine spaete
    // Antwort nimmt ihm keine Zutat, die das Speichern wieder angelegt hat
    // (Codex an #2001). Rezepte und Listen brauchen das nicht: eine ID, die
    // es einmal nicht mehr gab, kommt nicht zurueck.
    const recipe = state.recipes.find((r) => r.id === recipeId);
    if (!recipe || recipe !== recipeRef || ingredientName == null) return false;
    const before = (recipe.ingredients ?? []).length;
    const key = ingredientMatchKey(ingredientName);
    recipe.ingredients = (recipe.ingredients ?? []).filter((i) => ingredientMatchKey(i.name) !== key);
    return recipe.ingredients.length !== before;
  }
  if (reason === 'shopping_list_not_found') {
    if (listId == null) return false;
    const before = state.lists.length;
    state.lists = state.lists.filter((l) => l.id !== listId);
    return state.lists.length !== before;
  }
  return false;
}

/**
 * Zeigt die Seite noch diesen Container? Die Navigation in ein anderes Modul
 * leert `_container` nicht, die Variable zeigt dann weiter auf den
 * abgehaengten Container. "Derselbe Container" allein haelt deshalb nicht: er muss
 * auch noch im DOM haengen (Codex an #2001). Sonst zeichnete ein spaetes
 * Nachladen in eine Seite, die niemand mehr sieht, und zoege den Fokus auf
 * der neuen Seite weg.
 */
function stillShown(owner) {
  return Boolean(owner) && _container === owner && owner.isConnected === true;
}

const isSelectedPantryItemGone = (err) => isGone(err) && err.data.reason === 'recipes_selected_pantry_item_not_found';

/** Die Rezepte der Liste: ohne die, deren Loeschen gerade laeuft. */
function listedRecipes() {
  return state.recipes.filter((r) => !_pendingDeleteIds.has(r.id));
}

// Client-seitige Suche über Titel, Notizen und Zutaten (Audit A1-21):
// die Rezeptliste ist vollständig geladen, ein Server-Roundtrip wäre Umweg.
function filteredRecipes() {
  const q = state.query.toLowerCase();
  return listedRecipes().filter((r) => {
    if (state.sourceFilter !== 'all' && r.source !== state.sourceFilter) return false;
    if (state.mealFilter !== 'all' && !normalizeRecipeMealTypes(r.meal_types).includes(state.mealFilter)) return false;
    if (!q) return true;
    return r.title?.toLowerCase().includes(q)
      || r.notes?.toLowerCase().includes(q)
      || (r.ingredients ?? []).some((i) => i.name?.toLowerCase().includes(q));
  });
}

function mealCategories() {
  return state.categories.filter((c) => c.name !== 'Haushalt' && c.name !== 'Drogerie');
}

// Kleines Badge für gespiegelte Rezepte (source: 'mealie'/'tandoor'/...). Der
// Account-Name als Tooltip hilft bei mehreren Accounts desselben Providers zu
// unterscheiden.
function sourceBadge(recipe) {
  const badge = document.createElement('span');
  badge.className = `source-badge source-badge--${recipe.source}`;
  badge.textContent = t(`recipes.source${recipe.source[0].toUpperCase()}${recipe.source.slice(1)}`);
  if (recipe.provider_account_name) badge.title = recipe.provider_account_name;
  return badge;
}

// Vorschaubild fuer ein gespiegeltes Rezept. Die beiden Faelle - kein Bild beim
// Provider, Bild seit dem letzten Sync verschwunden - stehen samt Begruendung in
// utils/recipe-thumb.js; seit #1059 zeigen auch Planer und Uebersichtskachel
// dasselbe Bild und teilen sich denselben Ruecksturz.
function recipeThumb(recipe) {
  return recipeThumbEl({
    recipeId: recipe.id,
    hasImage: recipe.provider_has_image,
    hasOwnImage: recipe.has_own_image,
    className: 'recipe-row__thumb',
  });
}

/**
 * Traegt die Zeile ein Vorschaubild?
 *
 * DIE FRAGE IST "HAT ES EIN BILD", NICHT "WOHER KOMMT ES" (Critique 2026-10-05,
 * R16). Die Bedingung war `isMirrored`: ein eigenes Rezept bekam im Editor ein
 * Bild, der Wochenplan zeigte es, die Rezeptliste nicht. Gespiegelte Rezepte
 * behalten ihre Regel aus #1059 (Bild oder Platzhalter - die Herkunft ist Teil
 * der Zeile); ein eigenes Rezept ohne Bild bleibt eine Textzeile.
 */
function rowShowsThumb(recipe) {
  return recipe.source !== 'native' || Boolean(recipe.has_own_image);
}

function mealTypeOptions() {
  return mealTypeList().map(({ key, label }) => ({ key, label }));
}

/**
 * Der Ladefehler bleibt im Modul, statt aus `render()` heraus zu propagieren.
 *
 * Vorher hatte diese Funktion als einzige der vier Küchen-Loader kein
 * try/catch: ein HTTP 500 auf `/recipes` riss die gesamte App in den globalen
 * Fehlerbildschirm - Navigation weg, die drei anderen Tabs unerreichbar, obwohl
 * nur eine Liste fehlte (Critique P0, 2026-07-30). Ein Modul, das seine Daten
 * nicht bekommt, darf höchstens sich selbst verlieren.
 */
async function loadRecipes() {
  try {
    const res = await api.get('/recipes');
    state.recipes = res.data ?? [];
    state.loadError = null;
  } catch (err) {
    console.error('[Recipes] loadRecipes Fehler:', err);
    state.recipes = [];
    state.loadError = err;
  }
}

async function loadCategories() {
  try {
    const res = await api.get('/shopping/categories');
    state.categories = res.data;
  } catch {
    state.categories = [];
  }
}

// Ist das Einkaufsmodul deaktiviert oder gibt es keine Liste, bleibt state.lists
// leer und die Karte zeigt die Übernahme-Aktion gar nicht erst an.
async function loadShoppingLists() {
  if (window.yuvomi?.isModuleDisabled?.('shopping')) {
    state.lists = [];
    return;
  }
  try {
    const res = await api.get('/shopping');
    state.lists = res.data ?? [];
  } catch {
    state.lists = [];
  }
}

// „Diese Woche geplant": die Rezepteliste kannte ihren eigenen Wochenplan
// nicht - die Verbindung der beiden Kuechen-Raeume war nur im Meals-Tab
// sichtbar, und die Liste las sich als kontextlose CRUD-Ablage (Critique
// 2026-08-27, P2). Die Zuordnung steht laengst in meals.recipe_id; der Server
// liefert ohne week-Parameter die aktuelle Woche. Ein Fehler laesst die
// Angabe schlicht weg - die Liste haengt nicht an ihr.
async function loadPlannedRecipes() {
  if (window.yuvomi?.isModuleDisabled?.('meals')) {
    state.plannedRecipeIds = new Set();
    return;
  }
  try {
    const res = await api.get('/meals');
    const meals = res.data ?? [];
    state.plannedRecipeIds = new Set(meals.map((m) => m.recipe_id).filter(Boolean));
    // Tafla: WHEN it is planned ("dziś", "w czwartek") - only today and later;
    // an earlier day of this week counts as cooked (`last_cooked_on`).
    const today = todayKey();
    state.plannedOn = new Map();
    for (const m of meals) {
      if (!m.recipe_id || !m.date || m.date < today) continue;
      const known = state.plannedOn.get(m.recipe_id);
      if (!known || m.date < known) state.plannedOn.set(m.recipe_id, m.date);
    }
  } catch {
    state.plannedRecipeIds = new Set();
    state.plannedOn = new Map();
  }
}

/**
 * Tafla "masz 5 z 6": what the pantry holds, as comparison keys. Read-only and
 * never stored. Without pantry access the state stays `null` (unknown) and the
 * detail shows no have/missing marks at all.
 */
async function loadPantry() {
  if (pantryAccess() === 'none') {
    state.pantry = null;
    return;
  }
  try {
    const res = await api.get('/pantry');
    state.pantry = (res.data ?? []).map((item) => ({
      id: item.id,
      key: foldKey(item.name),
      stocked: item.quantity == null || Number(item.quantity) > 0,
    }));
  } catch {
    state.pantry = null;
  }
}

/** Tafla "na liście": names open (not ticked) on any shopping list. */
async function loadOnList() {
  if (!state.lists.length || navModuleAccess('shopping') === 'none') {
    state.onList = null;
    return;
  }
  try {
    const answers = await Promise.all(state.lists.map((list) => api.get(`/shopping/${list.id}/items`)));
    state.onList = new Set(answers.flatMap((res) => res.data ?? [])
      .filter((item) => !item.is_checked)
      .map((item) => foldKey(item.name))
      .filter(Boolean));
  } catch {
    state.onList = null;
  }
}

/* EIN VERGLEICHSSCHLUESSEL FUER NAMEN - dieselbe Regel wie `nameKey` in
 * server/utils/name-key.js (klein, ohne diakritische Zeichen, ł -> l, einfache
 * Leerzeichen), damit "masz" hier genauso urteilt wie die Zutatenvorschlaege im
 * Essensplan (server/services/meal-ingredient-suggest.js). */
const FOLD_MANUAL = { ł: 'l', Ł: 'l', đ: 'd', ø: 'o', ß: 'ss' };
function foldKey(value) {
  return String(value ?? '')
    .replace(/[łŁđøß]/g, (ch) => FOLD_MANUAL[ch])
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** "pomidory w puszce" findet "pomidory", "sól" findet "sól morska" - wie inPantry() am Server. */
function keyMatches(key, other) {
  return Boolean(key && other) && (other === key || key.startsWith(`${other} `) || other.startsWith(`${key} `));
}

/**
 * Was die Kueche ueber eine Zutat weiss: `have` true/false, oder `null`, wenn
 * der Vorrat unbekannt ist. Eine bestaetigte Zuordnung (#1314) geht vor; sonst
 * vergleicht der Name - nur fuer die Anzeige, gespeichert wird nichts
 * (docs/DECISIONS.md Abschnitt 7). `onList`: steht offen auf einer
 * Einkaufsliste.
 */
function ingredientState(ing) {
  const key = foldKey(ing?.name);
  let have = null;
  if (state.pantry) {
    const confirmed = ing?.pantry_item_id ? state.pantry.find((p) => p.id === ing.pantry_item_id) : null;
    have = confirmed
      ? confirmed.stocked
      : state.pantry.some((p) => p.stocked && keyMatches(key, p.key));
  }
  const onList = Boolean(state.onList && [...state.onList].some((k) => keyMatches(key, k)));
  return { have, onList };
}

/** `{ have, total }` fuer den Zutaten-Zaehler, oder `null` ohne Vorratswissen. */
function pantryTally(recipe) {
  const ingredients = recipe?.ingredients ?? [];
  if (!state.pantry || !ingredients.length) return null;
  const have = ingredients.filter((ing) => ingredientState(ing).have).length;
  return { have, total: ingredients.length };
}

/** Zutaten, die der Vorrat nicht zu haben scheint und die auch auf keiner Liste stehen. */
function missingIngredients(recipe) {
  if (!state.pantry) return [];
  return (recipe?.ingredients ?? []).filter((ing) => {
    const s = ingredientState(ing);
    return s.have === false && !s.onList;
  });
}

// --------------------------------------------------------
// Tafla: relative Tage ("dziś", "w czwartek", "3 tyg. temu")
// --------------------------------------------------------

const DAY_MS = 86_400_000;
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function dayDiff(fromKey, toKey) {
  return Math.round((parseLocalDateKey(toKey) - parseLocalDateKey(fromKey)) / DAY_MS);
}

/** Ein geplanter Tag: "dziś", "jutro", "w czwartek" (innerhalb einer Woche), sonst das Datum. */
function upcomingLabel(dateKey) {
  const ahead = dayDiff(todayKey(), dateKey);
  if (ahead <= 0) return t('recipes.whenToday');
  if (ahead === 1) return t('recipes.whenTomorrow');
  if (ahead < 7) return t(`recipes.whenOn.${WEEKDAY_KEYS[parseLocalDateKey(dateKey).getDay()]}`);
  return formatDate(dateKey);
}

/** Ein vergangener Tag: "wczoraj", "3 dni temu", "2 tyg. temu" - aus Intl, in jeder Sprache. */
function agoLabel(dateKey) {
  const days = Math.max(1, dayDiff(dateKey, todayKey()));
  let fmt;
  try {
    fmt = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto', style: 'short' });
  } catch {
    return formatDate(dateKey);
  }
  if (days < 7) return fmt.format(-days, 'day');
  if (days < 35) return fmt.format(-Math.round(days / 7), 'week');
  if (days < 365) return fmt.format(-Math.max(1, Math.round(days / 30)), 'month');
  return fmt.format(-Math.round(days / 365), 'year');
}

/**
 * Oeffnet das per ?open=<id> benannte Rezept, wenn es in der geladenen Liste steht.
 *
 * Lesen statt Bearbeiten: wer aus dem Essensplan kommt, will kochen, nicht
 * aendern - dieselbe Entscheidung wie beim Antippen einer Zeile. Unter der
 * Schwelle oeffnet das Rezept seit R19 als Leseblatt (wie Kontakte, Inventar,
 * Aufgaben), nicht mehr als Aufklapper in der Liste.
 *
 * Ein Rezept ohne Detailinhalt (keine Zutaten, keine Notiz, keine Quelle) hat
 * kein Leseblatt. Dann bleibt das Scrollen als das, was zu holen ist: die
 * Zeile zeigen, statt still nichts zu tun.
 */
function openRecipeFromQuery() {
  const raw = new URLSearchParams(window.location.search).get('open');
  const id = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(id)) return;

  const row = _container?.querySelector(`.recipe-row-item[data-id="${id}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'nearest' });

  // In der Detailspalte hat der Baustein das Rezept beim Einhaengen schon
  // ausgewaehlt - er liest denselben Parameter (`param: 'open'` in
  // mountRecipeDetail).
  if (_md?.isSplit()) return;

  const recipe = state.recipes.find((r) => r.id === id);
  if (recipe && row.querySelector('[data-action="open-detail"]')) openRecipeSheet(recipe);
}

/**
 * Der Anlegeknopf - oder `null` bei `read`: der Knopf steht dann nicht im
 * Markup, statt per CSS (html[data-module-readonly]) nur ausgeblendet zu sein.
 */
function fabEl() {
  if (readOnly()) return null;
  const fab = document.createElement('button');
  fab.className = 'page-fab';
  fab.type = 'button';
  fab.id = 'fab-new-recipe';
  fab.setAttribute('aria-label', t('recipes.addRecipe'));
  fab.dataset.dockLabel = t('newLabel.recipes');
  const fabIcon = document.createElement('i');
  fabIcon.dataset.lucide = 'plus';
  fabIcon.setAttribute('aria-hidden', 'true');
  fab.appendChild(fabIcon);
  return fab;
}

export async function render(container, { signal } = {}) {
  _container = container;
  _md = null;

  // `state` ueberlebt den Seitenwechsel. Wer zuletzt nach "Suppe" gesucht oder
  // auf Mealie gefiltert hat, kaeme sonst per Deep-Link auf eine Liste zurueck,
  // in der das verlangte Rezept gar nicht steht - und der Sprung endete
  // wortlos im Nichts. Ein benanntes Ziel schlaegt einen alten Filter, also
  // faellt der weg, und zwar VOR dem Bau des Suchfelds, damit die Zeile darueber
  // nicht einen Begriff zeigt, nach dem die Liste nicht mehr filtert (#936).
  if (new URLSearchParams(window.location.search).has('open')) {
    state.query = '';
    state.sourceFilter = 'all';
  }

  const page = document.createElement('div');
  // `app-page--list-detail`: Regime „Liste + Detail" der Breitenregel
  // (DESIGN.md). Unter der Schwelle bleibt es Lesemass, ab 65rem Modulflaeche
  // steht rechts das ausgewaehlte Rezept (utils/master-detail.js).
  page.className = 'recipes-page app-page app-page--reading app-page--list-detail page-measure--narrow';
  page.dataset.composition = 'reading';

  // sr-only Titel: die geteilte Kitchen-Tabs-Leiste labelt das Modul bereits
  // sichtbar — konsistent mit Mahlzeiten/Einkauf. Der FAB ist die einzige
  // Create-Affordanz (kein redundanter sichtbarer Kopf-Titel mehr).
  const title = document.createElement('h1');
  title.className = 'sr-only';
  title.textContent = t('nav.recipes');

  // Suchfeld über der Liste: Rezepte waren als einziges Kitchen-Modul nicht
  // durchsuchbar (Audit A1-21).
  // Kanonischer Kopf in der Gruppen-Variante: --in-group gibt Akzentstreifen und
  // oberste Sticky-Position an die .kitchen-tabs-bar darüber ab, die beides schon
  // trägt. Genau der Doppelstreifen aus Issue #577 war der Grund, warum diese
  // Zeile vorher als eigene .recipes-toolbar gebaut war - mit dem Ergebnis, dass
  // alle vier Küchen-Tabs eine andere Kopf-Grammatik hatten (Critique
  // 2026-07-29). Die Variante löst den Konflikt, ohne den Kopf zu meiden.
  const toolbar = document.createElement('div');
  // Kein --narrow (Re-Critique 2026-09-27, D3): der Kuechenkopf gehoert der
  // Kuechen-Leiste und endet an ihrer Kante wie in den drei Geschwister-Tabs -
  // sonst sprang die angedockte Primaeraktion beim Tabwechsel zwischen
  // Lesemass (x 865) und Leistenkante (x 1288). Test: test-meals.js (D3).
  toolbar.className = 'page-toolbar page-toolbar--in-group';
  // Geteilter Baustein (utils/page-search.js) statt eines eigenen Inputs. Er
  // bringt Lupe, Leeren-Knopf, `<label for>` und die mobilen Eingabe-Attribute
  // mit; der Nachbau hatte keines davon und ließ den Placeholder die
  // Beschriftung tragen, die beim ersten Zeichen verschwindet.
  // Die Suche IST der Center-Slot (Re-Critique 2026-09-27, D4): Breite und
  // Stelle traegt page-search.css, wie in Dokumenten - kein Wrapper, keine
  // Modulbreite.
  toolbar.insertAdjacentHTML('beforeend', renderPageSearch({
    id: 'recipes-search',
    // Label und Placeholder aus demselben Key, wie im Vorrat und in den drei
    // Referenzmodulen: „Rezepte durchsuchen" benennt das Feld vollständig.
    label: t('recipes.searchPlaceholder'),
    placeholder: t('recipes.searchPlaceholder'),
    value: state.query,
    clearLabel: t('common.searchClear'),
    // Feld statt Lupe auch mobil (R19): die Zeile traegt nur die Suche.
    className: 'recipes-search page-toolbar__center page-search--field',
  }));

  // Trigger im __actions-Slot statt einer eigenen Pillen-Zeile darunter -
  // dieselbe Behandlung wie „Lagerorte verwalten" im Vorrat (btn--icon im
  // Kopf, kein zusätzliches Kopf-Element). Die frühere Chip-Reihe brauchte auf
  // schmalen Bildschirmen eine ganze eigene Zeile, nur für drei Optionen, von
  // denen fast immer "Alle" aktiv ist. Nur sichtbar, sobald mindestens ein
  // gespiegeltes Rezept existiert (renderSourceFilter füllt/versteckt sie nach
  // dem Laden).
  //
  // SLOT UND FILTER SIND ZWEI KNOTEN. In `.page-toolbar__actions` dockt der
  // Router auf dem Desktop den FAB an (dockFabIntoToolbar in router.js). Solange
  // der Slot selbst der Filter war, stand der „Neues Rezept"-Knopf ohne
  // gespiegelte Rezepte in einem `hidden`-Container, und mit ihnen warf
  // renderSourceFilter() ihn per replaceChildren() aus dem DOM. Der Slot wird
  // deshalb nie ausgeblendet und nie geleert; der Filter hat seinen eigenen
  // Container darin (test:hidden-cascade haelt beides).
  const actions = document.createElement('div');
  actions.className = 'page-toolbar__actions';
  const sourceFilter = document.createElement('div');
  sourceFilter.className = 'recipes-source-filter';
  sourceFilter.id = 'recipes-source-filter';
  sourceFilter.hidden = true;
  actions.appendChild(sourceFilter);
  toolbar.appendChild(actions);

  const list = document.createElement('div');
  list.className = 'list-scroller page-scrollport recipes-list split-view__list';
  list.id = 'recipes-list';
  // Lade-Skeleton bis loadRecipes() aufgelöst ist (Router blendet den Wrapper
  // bereits vor dem Daten-await ein).
  list.setAttribute('aria-busy', 'true');
  list.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 5, lines: 2 }));
  // Kein wireScrollFade mehr: die Liste kachelt nicht länger mit 320px-Mindest-
  // breite, sondern ist eine Zeilenliste in der 720er-Lesespalte. Der frühere
  // 32px-Überlauf bei 320px war eine Eigenschaft des Rasters und ist mit ihm weg.

  const fab = fabEl();

  // Liste + Detail: der Scrollport wird `.split-view__list` und steht mit der
  // Detailspalte in einer Huelle an seinem bisherigen Platz. Unter der
  // Schwelle ist die Spalte `display: none` und die Huelle eine Flex-Spalte -
  // die Liste steht wie vorher. Der Kuechenkopf (kitchen-tabs) sitzt ausserhalb
  // der Seitenwurzel und laeuft damit ueber beide Spalten.
  const split = document.createElement('div');
  split.className = 'split-view';
  split.appendChild(list);
  split.insertAdjacentHTML('beforeend', splitViewDetailHtml({
    id: 'recipes',
    label: t('recipes.detailPaneLabel'),
    empty: { icon: 'book-text', title: t('recipes.pickOne'), hint: t('recipes.pickOneHint') },
  }));

  page.append(...[title, toolbar, split, fab].filter(Boolean));
  container.replaceChildren(page);
  renderKitchenTabsBar(container, '/recipes');
  // Positionierung und Schliessen der Zeilen-Ueberlaufmenues. Idempotent, haengt an
  // der stabilen Seitenwurzel - die Liste darin wird bei jedem Filter neu gebaut.
  installPopoverMenus(page);

  if (window.lucide) window.lucide.createIcons({ el: container });

  await Promise.all([loadRecipes(), loadCategories(), loadShoppingLists(), loadPlannedRecipes(), loadPantry(), ensureMealTypeNames()]);
  // Tafla "na liście": braucht die Listen von eben.
  await loadOnList();
  // Ein Seitenwechsel waehrend des Ladens: die Seite ist schon abgebaut, ein
  // Einhaengen jetzt schriebe in eine fremde Adresse.
  if (signal?.aborted || !page.isConnected) return;
  renderSourceFilter();
  // VOR dem ersten Listenbau: der Baustein loest `?open=` beim Einhaengen ein
  // und braucht dafuer die geladenen Rezepte, nicht die Zeilen -
  // renderRecipeList() setzt danach die Markierung (refresh).
  _md = mountRecipeDetail(split, signal);
  renderRecipeList();

  // Deep-Link: ?open=<id> klappt das Rezept auf und scrollt es ins Bild.
  // Dieselbe Schreibweise wie in Kontakten und auf der Startseite, damit nicht
  // jedes Modul seinen eigenen Parameter erfindet.
  //
  // Gebraucht wird er von den Essenskarten (#936): ein Essen liess sich mit
  // einem Rezept verknuepfen, aber die Verknuepfung hatte keinen Ausgang - der
  // Aktionsknopf gab es nur fuer eine externe `recipe_url`, nicht fuer ein
  // Rezept aus dem eigenen Haus.
  openRecipeFromQuery();

  // Bei `read` gibt es keinen FAB (fabEl). Der Riegel selbst sitzt in
  // openRecipeModal() - dort muenden alle Anlege- und Bearbeitungswege.
  fab?.addEventListener('click', () => openRecipeModal('create'));

  // Handle im Modul halten: der Zurücksetzen-Pfad des Suchtreffer-Leerzustands
  // braucht `clear()`, nicht nur `input.value = ''` - sonst bliebe der
  // Leeren-Knopf über einem leeren Feld stehen.
  _search = wirePageSearch(toolbar, {
    id: 'recipes-search',
    onQuery: (value) => {
      state.query = value.trim();
      renderRecipeList();
    },
  });

  // An der Huelle, nicht an der Liste: die Kreislauf-Ausgaenge und die
  // Vorrats-Zuordnung stehen in der Spalten-Darstellung in der Detailspalte,
  // mit denselben `data-action`-Knoepfen wie im Aufklapper.
  split.addEventListener('click', (e) => onSplitClick(e, list));
  // Am Finger: langer Druck auf eine Zeile oeffnet ihr Menue (Tafla).
  wireLongPress(list, signal);

  // Kein eigener keydown-Handler mehr: das Aufklappen sitzt auf einem echten
  // <button>, der Enter und Space von sich aus verarbeitet. Der frühere Handler
  // gehörte zur Karte, die role="button" trug und damit ein Bedienelement mit
  // Bedienelementen darin war.
}

async function onSplitClick(e, list) {
  // Der Hauptknopf der Zeile: in der Spalte waehlt er aus, darunter oeffnet
  // er das Leseblatt oder das Formular - der Baustein entscheidet ueber open().
  // Auswaehlen und Oeffnen sind Lesen; den Weg ins Formular schliesst
  // openRecipeModal() selbst.
  // Die Mahlzeit-Chips (Tafla) filtern nur die Ansicht - Lesen, kein Riegel.
  const chip = e.target.closest('[data-meal-filter]');
  if (chip && list.contains(chip)) {
    const value = chip.dataset.mealFilter;
    if (state.mealFilter !== value) {
      state.mealFilter = value;
      renderRecipeList();
      list.querySelector(`[data-meal-filter="${CSS.escape(value)}"]`)?.focus();
    }
    return;
  }

  // Eine Karte in "Gotowane ostatnio" tut, was der Tipp auf ihre Zeile tut.
  const card = e.target.closest('.recipe-card');
  const main = card && list.contains(card)
    ? list.querySelector(`.recipe-row__toggle[data-id="${CSS.escape(card.dataset.id)}"]`)
    : e.target.closest('.recipe-row__toggle');
  if (main && list.contains(main)) {
    if (_md) _md.open(main.dataset.id, card ?? main);
    else openRecipeNarrow(main.dataset.id, main);
    return;
  }

  const actionBtn = e.target.closest('[data-action]');
  if (!actionBtn) return;

  // Der eine Riegel fuer alle Aktionen darunter (siehe READ_SAFE_ACTIONS): das
  // Markup nimmt die Affordanz, die Positivliste den Effekt - auch fuer einen
  // Knoten, der einen Rechtewechsel ueberlebt hat.
  if (readOnly() && !READ_SAFE_ACTIONS.has(actionBtn.dataset.action)) return;

  const run = SPLIT_ACTIONS[actionBtn.dataset.action];
  if (!run) return;

  const recipeId = Number(actionBtn.dataset.id);
  const recipe = state.recipes.find((r) => r.id === recipeId);
  if (!recipe) return;

  await run(recipe, actionBtn);
}

/**
 * Was eine `data-action` der Seite TUT - eine Tabelle statt einer Kette aus
 * `if`, damit der Riegel davor (`READ_SAFE_ACTIONS` in onSplitClick) an EINER
 * Stelle ueber alle Eintraege urteilt, auch ueber einen, der morgen dazukommt
 * und noch keinen eigenen Riegel traegt. `open-detail` fehlt hier: der
 * Hauptknopf der Zeile ist vorher abgezweigt.
 */
const SPLIT_ACTIONS = {
  edit: (recipe) => openRecipeModal('edit', recipe),
  'match-ingredient': (recipe, btn) => openPantryMatchModal(recipe, btn.dataset.ingredient),
  'match-ingredients': (recipe) => openPantryBulkMatchModal(recipe),
  delete: (recipe) => removeRecipe(recipe),
  duplicate: (recipe) => duplicateRecipe(recipe),
  'to-shopping': (recipe, btn) => transferRecipe(recipe, btn),
  'to-shopping-missing': (recipe, btn) => transferRecipe(recipe, btn, { onlyMissing: true }),
  'add-to-meals': (recipe, btn) => planRecipe(recipe, btn),
};

// Mehrwege-Filter (Alle/Nativ/pro Provider) als Trigger + Popover-Menü im
// __actions-Slot, dieselbe Behandlung wie „Lagerorte verwalten" im Vorrat -
// ein btn--icon im Kopf statt einer eigenen Zeile, die auf schmalen
// Bildschirmen für wenige Optionen (fast immer "Alle" aktiv) eine ganze
// Kopf-Zeile kostete. Bleibt versteckt, solange kein Provider-Account
// gespiegelte Rezepte liefert - der Filter wäre sonst leere Ornamentik.
function renderSourceFilter() {
  const el = _container.querySelector('#recipes-source-filter');
  if (!el) return;

  const hasMirrored = state.recipes.some((r) => r.source !== 'native');
  if (!hasMirrored) {
    el.hidden = true;
    state.sourceFilter = 'all';
    return;
  }

  el.hidden = false;
  const options = [
    { value: 'all', label: t('recipes.sourceAll') },
    { value: 'native', label: t('recipes.sourceNative') },
    ...[...new Set(state.recipes.map((r) => r.source).filter((s) => s !== 'native'))].sort().map((s) => ({
      value: s, label: t(`recipes.source${s[0].toUpperCase()}${s.slice(1)}`),
    })),
  ];
  const activeLabel = options.find((o) => o.value === state.sourceFilter)?.label ?? '';

  el.replaceChildren();
  el.insertAdjacentHTML('beforeend', `
    <button type="button" class="btn btn--ghost btn--icon popover-menu__trigger"
            popovertarget="recipes-source-filter-menu" aria-haspopup="menu" aria-expanded="false"
            aria-label="${esc(t('recipes.sourceFilterLabel'))}: ${esc(activeLabel)}"
            title="${esc(t('recipes.sourceFilterLabel'))}: ${esc(activeLabel)}">
      <i data-lucide="filter" class="icon-md" aria-hidden="true"></i>
    </button>
    <div class="popover-menu recipes-source-filter-menu" id="recipes-source-filter-menu" popover role="menu"
         aria-label="${esc(t('recipes.sourceFilterLabel'))}">
      ${options.map((opt) => {
        const active = state.sourceFilter === opt.value;
        return `
          <button type="button" role="menuitemradio" aria-checked="${active}"
                  class="popover-menu__item" data-source-value="${esc(opt.value)}">
            <i data-lucide="check" class="icon-md popover-menu__item-check${active ? '' : ' popover-menu__item-check--hidden'}" aria-hidden="true"></i>
            <span>${esc(opt.label)}</span>
          </button>`;
      }).join('')}
    </div>`);

  for (const btn of el.querySelectorAll('[data-source-value]')) {
    btn.addEventListener('click', () => {
      const value = btn.dataset.sourceValue;
      if (state.sourceFilter === value) return;
      state.sourceFilter = value;
      renderSourceFilter();
      renderRecipeList();
    });
  }
  if (window.lucide) window.lucide.createIcons({ el });
}

/**
 * Baut die Liste neu und gleicht danach Liste + Detail ab - auf JEDEM Weg,
 * auch dem Leer-, Fehler- und Kein-Treffer-Zustand: sonst stuende rechts ein
 * Rezept, das die Liste links gerade nicht mehr zeigt.
 *
 * `repaint` nach dem Speichern: das Detail rechts zeigte sonst den Stand vor
 * dem Formular.
 */
function renderRecipeList({ repaint = false } = {}) {
  buildRecipeList();
  syncRowMode();
  _md?.refresh({ repaint });
}

/* LISTE + DETAIL (Breitenregel, Regime 2 - DESIGN.md)
 *
 * Ab 65rem Modulflaeche steht links die Liste, rechts das ausgewaehlte Rezept
 * mit eigenem Kopf (Titel, Bearbeiten, Duplizieren, Loeschen) und dem
 * Aufklapper-Inhalt darunter - wie Notizen und Erinnerungen auf dem Mac.
 * Darunter bleibt alles, wie es war: die Zeile klappt auf, und ein Rezept
 * ohne Detail oeffnet das Formular.
 *
 * DER PARAMETER IST `open` (Standard des Bausteins, hier ausdruecklich).
 * `/recipes?open=<id>` ist der Deep-Link, den die Essenskarten schon setzen
 * (#936). Die Auswahl schreibt
 * dieselbe Schreibweise, damit ein Rezept genau EINE Adresse hat - ein
 * zweiter Parameter hiesse zwei Adressen fuer dieselbe Sache und einen Link
 * aus dem Essensplan, der rechts nichts auswaehlt.
 */
function mountRecipeDetail(root, signal) {
  const md = mountMasterDetail({
    root,
    param: 'open',
    signal,
    renderDetail: (id, body) => renderRecipePane(id, body),
    openNarrow: (id, trigger) => openRecipeNarrow(id, trigger),
    // Unter der Schwelle loest openRecipeFromQuery() den Link ein, NACH dem
    // Listenbau - beim Einhaengen sind die Rezepte noch nicht geladen.
    deepLinkNarrow: false,
    // Darunter oeffnet die Zeile ein LESEBLATT (R19, "Zeilentipp oeffnet"):
    // vorher klappte sie in der Liste auf, als einziges Modul neben Aufgaben,
    // Kontakten und Inventar, die ihr Element oeffnen.
    narrow: 'sheet',
    // Und bei Zurueck/Vor auf `?open=` (Eintraege aus der Spalte, Fenster
    // inzwischen schmal) dieselbe Einloesung (Codex an #1477).
    onNarrowSync: () => openRecipeFromQuery(),
  });
  // Der Moduswechsel (Fenster, Seitenleiste) aendert, was der Hauptknopf der
  // Zeile IST: Aufklapper darunter, Auswahl in der Spalte. Seine ARIA-Angaben
  // ziehen hier nach; die Geometrie entscheidet das CSS.
  if (typeof ResizeObserver === 'function') {
    let last = md.isSplit();
    const ro = new ResizeObserver(() => {
      const now = md.isSplit();
      if (now === last) return;
      last = now;
      syncRowMode();
    });
    ro.observe(root);
    signal?.addEventListener('abort', () => ro.disconnect(), { once: true });
  }
  return md;
}

/**
 * Das ausgewaehlte Rezept in der Detailspalte. `false` heisst: diese ID gibt es
 * (nicht mehr) - der Baustein faellt dann auf den Leerzustand zurueck.
 */
function renderRecipePane(id, body) {
  const recipe = state.recipes.find((r) => String(r.id) === String(id));
  if (!recipe) return false;
  // Dieselbe Regel wie die Zeilenaktionen: gespiegelte Rezepte sind
  // schreibgeschuetzt, Duplizieren legt eine eigene Kopie an.
  const isMirrored = recipe.source !== 'native';
  // Bei `read` gibt es keinen Fuss: alle drei Knoepfe schreiben.
  // BEARBEITEN IST DER PRIMAERKNOPF AM ENDE DES FUSSES (R19, withPrimaryEdit) -
  // wie in jeder anderen Detailspalte; vorher stand es umrandet im Kopf.
  const footer = readOnly() ? null : detailFooterEl(recipeActions(recipe, {
    // In der Spalte bearbeiten, nicht in einem Fenster darueber (R19).
    edit: { id: 'recipes-detail-edit', dock: true, onClick: () => openRecipeModal('edit', recipe) },
    duplicate: () => duplicateRecipe(recipe),
    remove: () => removeRecipe(recipe),
  }));
  if (footer) footer.className = 'detail-view__footer split-view__detail-footer';

  const detail = document.createElement('div');
  detail.className = 'recipe-detail recipe-detail--pane';
  fillRecipeDetail(detail, recipe);
  body.replaceChildren(...[detailPaneHeaderEl({ title: recipe.title }), detail, footer].filter(Boolean));
  return undefined;
}

/**
 * Die Aktionen eines Rezepts im Fuss von Leseblatt und Detailspalte: Loeschen
 * zurueckgenommen am Anfang, Duplizieren leise, Bearbeiten als Primaerknopf
 * am Ende (withPrimaryEdit). Ein gespiegeltes Rezept ist schreibgeschuetzt:
 * nur Duplizieren (legt eine eigene Kopie an).
 */
function recipeActions(recipe, { edit, duplicate, remove }) {
  const isMirrored = recipe.source !== 'native';
  return withPrimaryEdit([
    !isMirrored && {
      id: 'recipe-detail-delete', label: t('common.delete'), icon: 'trash-2',
      variant: 'danger-ghost', align: 'start', onClick: remove,
    },
    { id: 'recipe-detail-duplicate', label: t('recipes.duplicate'), icon: 'copy', variant: 'ghost', onClick: duplicate },
  ], isMirrored ? null : { label: t('common.edit'), ...edit });
}

/**
 * Das Rezept als LESEBLATT unter der Schwelle (R19, Critique 2026-10-16:
 * "Zeilentipp hat vier Bedeutungen"). Derselbe Inhalt wie die Detailspalte
 * (fillRecipeDetail), dasselbe Blatt wie Kontakte und Inventar
 * (openDetailView). Die Knoepfe IM Detail (Einplanen, Einkauf, Vorrat
 * zuordnen) laufen ueber dieselbe Tabelle wie in der Liste (SPLIT_ACTIONS)
 * samt Nur-lesen-Riegel.
 *
 * TAFLA (2026-10-19): auf dem Telefon ist das Blatt eine geschobene Seite
 * (`size: 'recipe'`, recipes.css): Bild oben, eine Glas-Zurueck-Taste und ⋯
 * darueber, und unten EIN Primaerknopf, "Zacznij gotować" - er oeffnet den
 * Kochmodus. Bearbeiten, Duplizieren und Loeschen wandern ins ⋯ (Tafla: ein
 * Primaerknopf je Ansicht). Zurueck (Taste, Wischgeste, Browser) schliesst
 * das Blatt wie jedes Modal.
 */
function openRecipeSheet(recipe) {
  const detail = document.createElement('div');
  detail.className = 'recipe-detail recipe-detail--sheet';
  fillRecipeDetail(detail, recipe, { variant: 'sheet' });
  detail.addEventListener('click', (e) => onSplitClick(e, detail));
  openDetailView({
    title: recipe.title,
    key: `recipe:${recipe.id}`,
    size: 'recipe',
    sections: [{ node: detail }],
    actions: canCook(recipe) ? [{
      id: 'recipe-sheet-cook',
      label: t('recipes.startCooking'),
      icon: 'chef-hat',
      variant: 'primary',
      onClick: () => startCooking(recipe),
    }] : [],
  });
  decorateRecipeSheet(recipe);
}

/**
 * Der Kopf des Blatts (Tafla): das Schliessen-X des geteilten Dialogs wird zur
 * Zurueck-Taste (Chevron, "Wstecz"), rechts daneben das ⋯ mit den
 * Objektaktionen. Nur am Blatt dieser Seite (`.modal-panel--recipe`).
 */
function decorateRecipeSheet(recipe) {
  const panel = document.querySelector?.('#shared-modal-overlay .modal-panel--recipe');
  if (!panel) return;
  const close = panel.querySelector('.modal-panel__close');
  if (close) {
    close.setAttribute('aria-label', t('common.back'));
    close.replaceChildren();
    close.insertAdjacentHTML('beforeend', '<i data-lucide="chevron-left" class="icon-md" aria-hidden="true"></i>');
  }
  const isMirrored = recipe.source !== 'native';
  const items = readOnly() ? [] : [
    !isMirrored && { action: 'edit', icon: 'pencil', label: t('common.edit') },
    { action: 'duplicate', icon: 'copy', label: t('recipes.duplicate') },
    !isMirrored && { action: 'delete', icon: 'trash-2', label: t('common.delete'), danger: true },
  ].filter(Boolean);
  if (items.length) {
    const head = panel.querySelector('.modal-panel__header');
    const menu = document.createElement('div');
    menu.className = 'recipe-view__menu';
    menu.insertAdjacentHTML('beforeend', popoverMenuHtml({
      id: `recipe-view-menu-${recipe.id}`,
      label: t('common.moreActions'),
      triggerClass: 'recipe-view__more',
      items: items.map((item) => ({ ...item, id: recipe.id })),
    }));
    head?.appendChild(menu);
    installPopoverMenus(panel);
    // Erst das Blatt schliessen, dann das naechste Fenster: das geteilte
    // Modal kennt kein Stapeln (closeDetailView).
    menu.addEventListener('click', async (e) => {
      const item = e.target.closest('.popover-menu__item[data-action]');
      if (!item || readOnly()) return;
      await closeDetailView({ force: true });
      if (item.dataset.action === 'edit') openRecipeModal('edit', recipe);
      else if (item.dataset.action === 'duplicate') duplicateRecipe(recipe);
      else if (item.dataset.action === 'delete') removeRecipe(recipe);
    });
  }
  if (window.lucide) window.lucide.createIcons({ el: panel });
}

/**
 * Unter der Schwelle: das Leseblatt, wenn es ein Detail gibt, sonst das
 * Formular - ein gespiegeltes Rezept ohne Detail tut nichts (siehe
 * buildRecipeList).
 */
function openRecipeNarrow(id, trigger) {
  const btn = trigger
    ?? _container?.querySelector(`.recipe-row__toggle[data-id="${CSS.escape(String(id))}"]`);
  if (!btn) return;
  const recipe = state.recipes.find((r) => String(r.id) === String(id));
  if (!recipe) return;
  if (btn.dataset.action === 'open-detail') {
    openRecipeSheet(recipe);
    return;
  }
  if (btn.dataset.action === 'edit') openRecipeModal('edit', recipe);
}

/**
 * ARIA des Hauptknopfs je Darstellung. Unter der Schwelle oeffnet er ein
 * Leseblatt (`aria-haspopup="dialog"`, seit R19 statt eines Aufklappers); in
 * der Spalte waehlt er aus - dort zeigt `aria-controls` auf die Detailspalte,
 * und die Auswahl traegt der Baustein als `aria-current`.
 */
function syncRowMode() {
  const list = _container?.querySelector('#recipes-list');
  if (!list) return;
  const split = _md?.isSplit() ?? false;
  // Die Klasse traegt die Darstellung ins Stylesheet (Aufklapper und Chevron
  // weg, recipes.css). Sie folgt der gerechneten Darstellung der Spalte statt
  // einer eigenen Abfrage: eine zweite `@container`-Schwelle hier liefe der in
  // layout.css davon, und PAGE-019 bewacht nur die eine.
  list.classList.toggle('recipes-list--split', split);
  for (const btn of list.querySelectorAll('.recipe-row__toggle')) {
    // In der Spalte steuert der Knopf die Detailspalte; darunter oeffnet er
    // ein Blatt (aria-haspopup) oder das Formular.
    if (split) {
      btn.setAttribute('aria-controls', 'recipes-detail');
      btn.removeAttribute('aria-haspopup');
    } else {
      btn.removeAttribute('aria-controls');
      if (btn.dataset.action === 'open-detail') btn.setAttribute('aria-haspopup', 'dialog');
    }
    if ('narrowInert' in btn.dataset) {
      btn.tabIndex = split ? 0 : -1;
      btn.classList.toggle('list-row__main--interactive', split);
    }
  }
}

/**
 * Der Leerzustand der Rezeptliste. Bei `read` nur der ZUSTAND (Regel 9): Knopf,
 * Beschreibung („Speichere ...") und Hinweis laden alle zu einer Handlung ein,
 * die es dann nicht gibt.
 */
function emptyListOptions() {
  if (readOnly()) return { icon: 'book-text', title: t('recipes.emptyTitle') };
  return {
    icon: 'book-text',
    title: t('recipes.emptyTitle'),
    description: t('recipes.emptyDescription'),
    hint: t('emptyHint.recipes'),
    action: {
      label: t('recipes.emptyAction'),
      icon: 'plus',
      onClick: () => document.querySelector('.page-fab')?.click(),
    },
  };
}

function buildRecipeList() {
  const list = _container.querySelector('#recipes-list');
  if (!list) return;
  list.removeAttribute('aria-busy');

  list.replaceChildren();

  // Fehlerzustand vor Leerzustand: nach einem Fehler ist `state.recipes`
  // ebenfalls leer, und nur die Reihenfolge trennt „nichts angelegt" von
  // „nicht geladen".
  if (state.loadError) {
    mountLoadError(list, {
      title: t('recipes.loadError'),
      description: t('common.loadErrorDescription'),
      error: state.loadError,
      retryLabel: t('common.retry'),
      onRetry: async () => {
        list.setAttribute('aria-busy', 'true');
        await loadRecipes();
        renderRecipeList();
      },
    });
    return;
  }

  if (!listedRecipes().length) {
    // Geteilter Renderer (utils/empty-state.js): erzwingt Reihenfolge und
    // ARIA-Rolle. Vorher fehlte hier als einzigem Küchen-Leerzustand das Icon.
    mountEmptyState(list, emptyListOptions());
    return;
  }

  // TAFLA (2026-10-19): oben die Filter-Chips, dann "Gotowane ostatnio" als
  // Karten und darunter "Wszystkie przepisy N" als gruppierte Zeilen.
  const chips = mealFilterEl();
  if (chips) list.appendChild(chips);

  const visible = filteredRecipes();
  if (!visible.length) {
    // Geteilter Renderer, Variante 'no-results' (role="status", sekundärer CTA).
    // Seit R19 der EINE Leerzustand einer leeren Suche (mountSearchEmpty) - in
    // einem eigenen Traeger unter den Chips, damit ein gewaehlter Chip sichtbar
    // bleibt und sich zuruecknehmen laesst.
    const holder = document.createElement('div');
    holder.className = 'recipes-list__empty';
    list.appendChild(holder);
    mountSearchEmpty(holder, {
      query: state.query,
      onReset: () => {
        state.query = '';
        state.mealFilter = 'all';
        // clear() versteckt zugleich den Leeren-Knopf; ein blankes
        // `value = ''` ließe ihn über dem leeren Feld stehen.
        _search?.clear();
        renderRecipeList();
        _search?.input.focus();
      },
    });
    if (window.lucide) window.lucide.createIcons({ el: list });
    return;
  }

  const unfiltered = !state.query && state.mealFilter === 'all' && state.sourceFilter === 'all';
  const recent = unfiltered ? recentRecipes(visible) : [];
  if (recent.length >= 2) list.appendChild(recentSectionEl(recent));

  const section = document.createElement('section');
  section.className = 'recipes-all';
  if (unfiltered) {
    // Gruppenkopf ausserhalb der Karte: Titel 17/600 plus Zahl 17/400.
    const heading = document.createElement('h2');
    heading.className = 'recipes-group-title';
    heading.id = 'recipes-all-title';
    const label = document.createElement('span');
    label.textContent = t('recipes.allTitle');
    const count = document.createElement('span');
    count.className = 'recipes-group-title__count';
    count.textContent = String(visible.length);
    heading.append(label, count);
    section.setAttribute('aria-labelledby', 'recipes-all-title');
    section.appendChild(heading);
  }

  // Eine Zeilenliste, keine Kacheln: das Kartenraster war der letzte Tab mit
  // eigener Zeilen-Grammatik (20px Radius, 408px Höhe, drei CTA-Grundlinien,
  // 48px Bodenversatz in derselben Rasterzeile). Als Zeile teilt es Fläche,
  // Trennlinie, Textspalte und Bedienzone mit Einkauf und Vorrat. Die Karten
  // oben (Tafla) sind die Abkuerzung zu dem, was gerade gekocht wird.
  const rows = document.createElement('ul');
  rows.className = 'row-carrier';
  for (const recipe of visible) rows.appendChild(recipeRowEl(recipe));
  section.appendChild(rows);
  list.appendChild(section);

  if (window.lucide) window.lucide.createIcons({ el: list });
}

/**
 * Die Mahlzeit-Chips (Tafla): "Wszystkie" plus jede Mahlzeit, die nur EINEN
 * Teil der Rezepte betrifft - ein Chip, der alle Rezepte zeigt, filtert nichts.
 * Zeit ("Szybkie") und Favoriten ("Ulubione") aus dem Entwurf gibt es nicht:
 * Rezepte tragen weder eine Kochzeit noch ein Favoritenfeld.
 */
function mealFilterChoices() {
  const recipes = listedRecipes();
  return mealTypeOptions().filter(({ key }) => {
    const n = recipes.filter((r) => normalizeRecipeMealTypes(r.meal_types).includes(key)).length;
    return n > 0 && n < recipes.length;
  });
}

function mealFilterEl() {
  const choices = mealFilterChoices();
  if (state.mealFilter !== 'all' && !choices.some((c) => c.key === state.mealFilter)) state.mealFilter = 'all';
  if (!choices.length) return null;
  const group = document.createElement('div');
  group.className = 'recipes-filter';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', t('recipes.filterLabel'));
  for (const { key, label } of [{ key: 'all', label: t('recipes.filterAll') }, ...choices]) {
    const active = state.mealFilter === key;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `recipes-filter__chip${active ? ' recipes-filter__chip--active' : ''}`;
    chip.dataset.mealFilter = key;
    chip.setAttribute('aria-pressed', String(active));
    if (active) chip.insertAdjacentHTML('beforeend', '<i data-lucide="check" class="recipes-filter__check" aria-hidden="true"></i>');
    const text = document.createElement('span');
    text.textContent = label;
    chip.appendChild(text);
    group.appendChild(chip);
  }
  return group;
}

/**
 * "Gotowane ostatnio" (Tafla): was heute oder spaeter in dieser Woche geplant
 * ist und was zuletzt gekocht wurde - das Naechste zuerst, hoechstens vier.
 * Gekocht heisst: eine Mahlzeit mit diesem Rezept vor heute (`last_cooked_on`
 * vom Server). Bei Gleichstand geht das Geplante vor.
 */
function recentRecipes(recipes) {
  const today = todayKey();
  return recipes.map((recipe) => {
    const planned = state.plannedOn.get(recipe.id);
    if (planned) return { recipe, planned, distance: dayDiff(today, planned) };
    if (recipe.last_cooked_on) return { recipe, cooked: recipe.last_cooked_on, distance: dayDiff(recipe.last_cooked_on, today) + 0.5 };
    return null;
  }).filter(Boolean).sort((a, b) => a.distance - b.distance).slice(0, 4);
}

function recentSectionEl(entries) {
  const section = document.createElement('section');
  section.className = 'recipes-recent';
  section.setAttribute('aria-labelledby', 'recipes-recent-title');
  const heading = document.createElement('h2');
  heading.className = 'recipes-section-title';
  heading.id = 'recipes-recent-title';
  heading.textContent = t('recipes.recentTitle');
  section.appendChild(heading);
  const grid = document.createElement('div');
  grid.className = 'recipes-recent__grid';
  for (const entry of entries) grid.appendChild(recipeCardEl(entry));
  section.appendChild(grid);
  return section;
}

/**
 * Eine Karte in "Gotowane ostatnio": Bild (oder die warme Flaeche mit dem
 * Teller-Zeichen), Titel in zwei Zeilen, darunter der Tag. Ein Tipp tut, was
 * der Tipp auf die Zeile darunter tut (onSplitClick reicht ihn weiter).
 */
function recipeCardEl({ recipe, planned, cooked }) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'recipe-card';
  card.dataset.id = String(recipe.id);
  card.appendChild(recipeThumbEl({
    recipeId: recipe.id,
    hasImage: recipe.provider_has_image,
    hasOwnImage: recipe.has_own_image,
    className: 'recipe-card__media',
    iconClass: 'recipe-card__plate',
  }));
  const body = document.createElement('span');
  body.className = 'recipe-card__body';
  const title = document.createElement('span');
  title.className = 'recipe-card__title';
  title.textContent = recipe.title;
  const meta = document.createElement('span');
  meta.className = 'recipe-card__meta';
  meta.textContent = planned ? upcomingLabel(planned) : agoLabel(cooked);
  body.append(title, meta);
  card.appendChild(body);
  return card;
}

/** Eine Zeile in "Wszystkie przepisy": 64 hoch, Bild oder Teller-Zeichen, Titel, Meta. */
function recipeRowEl(recipe) {
  // Mirror-Rezepte sind read-only (der Provider bleibt Quelle der Wahrheit); steuert
  // weiter unten sowohl die Zeilenaktionen als auch das Detail.
  const isMirrored = recipe.source !== 'native';
  const ro = readOnly();
  const ingredients = recipe.ingredients ?? [];
  // Bei `read` hat JEDE Zeile ein Detail: dort stehen dann immer die
  // Mahlzeiten (fillRecipeDetail), und der Weg „ohne Detail direkt ins
  // Formular" ist zu - die Zeile waere sonst ein Knopf, der nichts tut.
  const hasDetail = ro || Boolean(ingredients.length || recipe.notes || recipe.recipe_url);

  const li = document.createElement('li');
  li.className = 'recipe-row-item';
  li.dataset.id = String(recipe.id);
  // Liste + Detail: die Zeile ist auswaehlbar, ihr Hauptknopf traegt den Fokus
  // der Pfeiltasten (utils/master-detail.js).
  li.dataset.mdId = String(recipe.id);

  const row = document.createElement('div');
  row.className = 'list-row recipe-row';

  // Überschrift umschließt den Button (Dokumentstruktur + Zustand). Eine
  // Stufe unter den Abschnittskoepfen der Liste (h2).
  const heading = document.createElement('h3');
  heading.className = 'list-row__main recipe-row__heading';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'list-row__main--interactive recipe-row__toggle';
  toggle.dataset.action = 'open-detail';
  toggle.dataset.id = String(recipe.id);
  toggle.dataset.mdFocus = "";

  // Der fuehrende Platz (28 breit, Titel bei x=56): das Bild des Rezepts, sonst
  // das Teller-Zeichen. Die Herkunft bleibt Teil der Zeile (Badge darunter).
  if (rowShowsThumb(recipe)) toggle.appendChild(recipeThumb(recipe));
  else toggle.insertAdjacentHTML('beforeend', '<span class="recipe-row__glyph" aria-hidden="true"><i data-lucide="utensils" class="icon-md" aria-hidden="true"></i></span>');

  const name = document.createElement('span');
  name.className = 'list-row__name';
  name.textContent = recipe.title;
  toggle.appendChild(name);

  if (isMirrored) {
    // Eigener Slot statt das Badge selbst als Flex-Item zu verwenden: die
    // Pille bleibt ihrer Inhaltsbreite treu.
    const badgeSlot = document.createElement('span');
    badgeSlot.className = 'recipe-row__badge-slot';
    badgeSlot.appendChild(sourceBadge(recipe));
    toggle.appendChild(badgeSlot);
  }

  // Die Zutatenzahl ist die Beschriftung dessen, was das Detail zeigt - IMMER
  // gerendert, auch bei 0, damit die Zeile ihre zweite Zeile behaelt.
  const meta = document.createElement('span');
  meta.className = 'list-row__meta';
  meta.textContent = t('meals.ingredientCount', { count: ingredients.length });
  // Zutatenzahl und der Tag (geplant / zuletzt gekocht) teilen sich die zweite
  // Zeile unter dem Namen (recipes.css).
  const sub = document.createElement('span');
  sub.className = 'recipe-row__sub';
  sub.appendChild(meta);

  // Zweite Meta-Angabe, getrennt ueber den Mittelpunkt (Hausform, Vorrat):
  // neutraler Sekundaertext, keine Flaeche. Geplant geht vor gekocht.
  const plannedDate = state.plannedOn.get(recipe.id);
  if (plannedDate || (state.plannedRecipeIds.has(recipe.id) && !recipe.last_cooked_on)) {
    const planned = document.createElement('span');
    planned.className = 'recipe-row__planned';
    planned.textContent = plannedDate
      ? t('recipes.plannedRow', { when: upcomingLabel(plannedDate) })
      : t('recipes.plannedThisWeek');
    sub.appendChild(planned);
  } else if (recipe.last_cooked_on) {
    const cooked = document.createElement('span');
    cooked.className = 'recipe-row__planned recipe-row__cooked';
    cooked.textContent = t('recipes.cookedAgo', { when: agoLabel(recipe.last_cooked_on) });
    sub.appendChild(cooked);
  }
  toggle.appendChild(sub);

  if (hasDetail) {
    // Ein Wegweiser, kein Aufklapp-Winkel: die Zeile oeffnet das Rezept.
    toggle.setAttribute('aria-haspopup', 'dialog');
    toggle.insertAdjacentHTML('beforeend',
      '<i data-lucide="chevron-right" class="icon-sm recipe-row__chevron" aria-hidden="true"></i>');
  } else if (!isMirrored) {
    // Ohne Detail kein Versprechen: kein Chevron, kein aria-expanded. Der
    // Button öffnet dann direkt das Bearbeiten-Formular.
    toggle.dataset.action = 'edit';
  } else {
    // Gespiegelt UND ohne Detail: weder zu oeffnen noch zu bearbeiten (der
    // Server weist das Speichern mit 403 ab). Nur unter der Schwelle stumm: in
    // der Spalte zeigt auch dieses Rezept sein Detail rechts (syncRowMode).
    delete toggle.dataset.action;
    toggle.classList.remove('list-row__main--interactive');
    toggle.tabIndex = -1;
    toggle.dataset.narrowInert = "";
    toggle.insertAdjacentHTML('beforeend',
      '<i data-lucide="chevron-right" class="icon-sm recipe-row__chevron recipe-row__chevron--placeholder" aria-hidden="true"></i>');
  }

  heading.appendChild(toggle);
  row.appendChild(heading);

  // Bearbeiten, Duplizieren, Loeschen: am Zeiger in der Zeile (breit inline,
  // schmal im Ueberlaufmenue), am Finger NICHT (Tafla: kein ⋯ je Zeile) - dort
  // liegen sie im Detail und hinter einem langen Druck (wireLongPress). Ein
  // gespiegeltes Rezept kennt nur Duplizieren; bei `read` gibt es keine.
  const ROW_ACTIONS = ro ? [] : [
    !isMirrored && { action: 'edit',      icon: 'pencil',  label: t('common.edit') },
    { action: 'duplicate', icon: 'copy',    label: t('recipes.duplicate') },
    !isMirrored && { action: 'delete',    icon: 'trash-2', label: t('common.delete'), danger: true },
  ].filter(Boolean);

  const actions = document.createElement('div');
  actions.className = 'list-row__actions';

  const inline = document.createElement('div');
  inline.className = 'recipe-row__inline-actions';
  for (const a of ROW_ACTIONS) {
    const btn = document.createElement('button');
    btn.className = `row-action${a.danger ? ' row-action--danger' : ''}`;
    btn.type = 'button';
    btn.dataset.action = a.action;
    btn.dataset.id = String(recipe.id);
    btn.setAttribute('aria-label', `${a.label}: ${recipe.title}`);
    btn.title = a.label;
    btn.insertAdjacentHTML('beforeend',
      `<i data-lucide="${a.icon}" class="icon-md" aria-hidden="true"></i>`);
    inline.appendChild(btn);
  }
  actions.appendChild(inline);

  const more = document.createElement('div');
  more.className = 'recipe-row__more';
  more.insertAdjacentHTML('beforeend', popoverMenuHtml({
    id: `recipe-menu-${recipe.id}`,
    label: t('common.moreActions'),
    triggerClass: 'row-action',
    items: ROW_ACTIONS.map((a) => ({ ...a, id: recipe.id })),
  }));
  actions.appendChild(more);

  if (ROW_ACTIONS.length) row.appendChild(actions);
  li.appendChild(row);
  return li;
}

/**
 * LANGER DRUCK = MENUE (Tafla, Gesten): am Finger hat die Zeile kein ⋯, also
 * oeffnet ein Druck von ~450 ms ohne Bewegung dasselbe Ueberlaufmenue der
 * Zeile, an ihr ausgerichtet. Der Klick danach oeffnet das Rezept NICHT.
 * Tastatur und Zeiger behalten die sichtbaren Knoepfe (recipes.css).
 *
 * GEOEFFNET WIRD BEIM LOSLASSEN, nicht waehrend des Drucks: das Loslassen
 * ausserhalb eines offenen Popovers ist sein "light dismiss" - ein Menue, das
 * unter dem Finger aufgeht, schloesse sich beim Heben sofort wieder. Die
 * Zeile zeigt nach der Haltezeit, dass sie gegriffen ist (`--held`).
 */
function wireLongPress(list, signal) {
  const HOLD_MS = 450;
  const SLOP = 8;
  let timer = null;
  let start = null;
  let armed = null;
  let swallowClick = false;
  let touching = false;
  const release = () => {
    armed?.item.classList.remove('recipe-row-item--held');
    armed = null;
  };
  const cancel = () => { clearTimeout(timer); timer = null; start = null; release(); };
  const openMenu = ({ item, menu }) => {
    try { menu.showPopover(); } catch { return; }
    // Die Lage gibt die Zeile vor - der Ausloeser selbst ist am Finger
    // ausgeblendet. Nach dem toggle-Handler (popover-menu.js) gesetzt.
    requestAnimationFrame(() => {
      const rect = item.getBoundingClientRect();
      const width = menu.offsetWidth || 200;
      const height = menu.offsetHeight || 120;
      const left = Math.min(Math.max(8, rect.right - width - 16), window.innerWidth - width - 8);
      const below = rect.bottom + 4;
      const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : below;
      menu.style.left = `${Math.round(left)}px`;
      menu.style.top = `${Math.round(top)}px`;
    });
  };
  list.addEventListener('pointerdown', (e) => {
    swallowClick = false;
    cancel();
    touching = e.pointerType === 'touch';
    if (!touching) return;
    const item = e.target.closest?.('.recipe-row-item');
    const menu = item && document.getElementById?.(`recipe-menu-${item.dataset.id}`);
    if (!menu) return;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      timer = null;
      armed = { item, menu };
      item.classList.add('recipe-row-item--held');
    }, HOLD_MS);
  }, { signal });
  list.addEventListener('pointermove', (e) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP) cancel();
  }, { signal });
  const lift = () => {
    const held = armed;
    clearTimeout(timer);
    timer = null;
    start = null;
    release();
    if (!held) return;
    swallowClick = true;
    // Nach dem Loslassen, nicht in ihm (siehe oben).
    setTimeout(() => openMenu(held), 0);
  };
  list.addEventListener('pointerup', lift, { signal, passive: true });
  list.addEventListener('pointercancel', lift, { signal, passive: true });
  list.addEventListener('scroll', cancel, { signal, passive: true });
  // Das Kontextmenue des Systems (iOS-Vorschau, Android) faellt auf der Zeile weg.
  list.addEventListener('contextmenu', (e) => {
    if (touching && e.target.closest?.('.recipe-row-item')) e.preventDefault();
  }, { signal });
  list.addEventListener('click', (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, { signal, capture: true });
}

/**
 * Der Inhalt eines Rezeptdetails: Kopf (wie oft gekocht, Mahlzeiten, Zahlen),
 * Zutaten mit Vorrat und Einkaufsliste, Kroki und die Kreislauf-Ausgaenge.
 * EINE Quelle fuer zwei Orte - das Blatt unter der Schwelle (`variant:
 * 'sheet'`, Tafla: Bild oben, grosser Titel) und die Detailspalte (Liste +
 * Detail, Titel im Kopf der Spalte), damit beide nie auseinanderlaufen.
 */
function fillRecipeDetail(detail, recipe, { variant = 'pane' } = {}) {
  const ingredients = recipe.ingredients ?? [];
  const mealTypes = normalizeRecipeMealTypes(recipe.meal_types);
  const sheet = variant === 'sheet';

  if (sheet) {
    // Tafla: das Blatt beginnt mit dem Bild - oder der warmen Flaeche mit dem
    // Teller-Zeichen -, darunter der Titel 34/600. Den Namen des Dialogs
    // traegt sein (unsichtbarer) Kopf, der sichtbare Titel ist Bild.
    detail.appendChild(recipeViewHeroEl(recipe));
    const title = document.createElement('p');
    title.className = 'recipe-view__title';
    title.setAttribute('aria-hidden', 'true');
    title.textContent = recipe.title;
    detail.appendChild(title);
  } else {
    // Das eigene Bild als Kopf der Spalte (R16) - ohne Bild kein Platzhalter
    // (R20, Entscheidung Ulas 2026-10-17: am Desktop stand das Band als 480px
    // breiter Stummel ueber den Zutaten).
    const hero = recipeHeroEl({ recipeId: recipe.id, hasOwnImage: recipe.has_own_image });
    if (hero) detail.appendChild(hero);
  }

  const head = recipeHeadEl(recipe, mealTypes);
  if (head) detail.appendChild(head);

  // VOLLSTÄNDIGE Zutatenliste: ein Detail, das sich öffnet, hat keinen Grund,
  // etwas zu verschweigen.
  if (ingredients.length) detail.appendChild(ingredientsSectionEl(recipe));

  // Kroki (Tafla): dieselbe Zerlegung wie im Kochmodus (utils/cook-steps.js),
  // damit die Nummern hier und am Herd dieselben sind. Eine Notiz, die keine
  // zwei Schritte hergibt, steht als Text da.
  const steps = splitSteps(recipe.notes);
  if (steps.length >= 2) {
    detail.appendChild(stepsSectionEl(steps));
  } else if (recipe.notes) {
    const section = detailSectionEl(t('recipes.notesLabel'));
    const notes = document.createElement('p');
    notes.className = 'recipe-detail__notes';
    notes.textContent = recipe.notes;
    section.appendChild(notes);
    detail.appendChild(section);
  }

  // Die Kreislauf-Ausgänge stehen im Detail, nicht in der Zeile, und sind dort
  // BESCHRIFTET (Critique 2026-07-30): man entscheidet sich fürs Einplanen,
  // nachdem man gesehen hat, was drin ist.
  const detailActions = document.createElement('div');
  detailActions.className = 'recipe-detail__actions';

  // GOTUJ (cook mode) schreibt nichts und steht deshalb fuer jeden Leser. Im
  // Blatt ist es der EINE Primaerknopf in der Leiste unten ("Zacznij
  // gotować", openRecipeSheet); in der Spalte traegt Bearbeiten den Fuss, und
  // Gotuj steht hier als sekundaerer Knopf.
  if (!sheet && canCook(recipe)) {
    const cook = document.createElement('button');
    cook.className = 'btn btn--secondary';
    cook.type = 'button';
    cook.insertAdjacentHTML('beforeend', '<i data-lucide="chef-hat" class="icon-sm" aria-hidden="true"></i>');
    const cookLabel = document.createElement('span');
    cookLabel.textContent = t('cook.open');
    cook.appendChild(cookLabel);
    cook.addEventListener('click', () => startCooking(recipe));
    detailActions.appendChild(cook);
  }

  // „Do planu" legt eine Mahlzeit an - ohne Schreibrecht entfaellt der Knopf
  // (Regel 2), der Riegel dazu steht in planRecipe(). SEKUNDAER (R19).
  if (mayPlanRecipe()) {
    const addToMeals = document.createElement('button');
    addToMeals.className = 'btn btn--secondary';
    addToMeals.type = 'button';
    addToMeals.dataset.action = 'add-to-meals';
    addToMeals.dataset.id = String(recipe.id);
    addToMeals.textContent = t('recipes.toPlan');
    detailActions.appendChild(addToMeals);
  }

  const addToShopping = shoppingTransferButton(recipe, ingredients);
  if (addToShopping) detailActions.appendChild(addToShopping);

  if (recipe.recipe_url) {
    const link = document.createElement('a');
    link.className = 'btn btn--ghost';
    link.href = recipe.recipe_url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.insertAdjacentHTML('beforeend',
      '<i data-lucide="external-link" class="icon-sm" aria-hidden="true"></i>');
    const linkLabel = document.createElement('span');
    linkLabel.textContent = t('recipes.openLink');
    link.appendChild(linkLabel);
    detailActions.appendChild(link);
  }

  // Bei `read` ohne Einkaufsrecht und ohne Link bliebe eine leere Leiste.
  if (detailActions.childNodes.length) detail.appendChild(detailActions);

  // Die Zeichen (Haken, Teller, Gotuj) materialisiert der Renderer selbst -
  // er hat zwei Aufrufer (Spalte und Blatt).
  if (window.lucide) window.lucide.createIcons({ el: detail });
}

/** Hat das Rezept etwas, wonach man kochen kann? (Zutaten oder Notiz) */
function canCook(recipe) {
  return Boolean((recipe.ingredients ?? []).length || recipe.notes?.trim());
}

function startCooking(recipe) {
  openCookMode({ title: recipe.title, ingredients: recipe.ingredients ?? [], notes: recipe.notes });
}

/**
 * Das Kopfbild im Blatt (Tafla): das Bild des Rezepts in 4:3 - das eigene oder
 * das der Rezeptquelle -, sonst die warme Flaeche mit dem Teller-Zeichen.
 * Scheitert das Bild, faellt es auf die Flaeche zurueck (recipeThumbEl).
 */
function recipeViewHeroEl(recipe) {
  return recipeThumbEl({
    recipeId: recipe.id,
    hasImage: recipe.provider_has_image,
    hasOwnImage: recipe.has_own_image,
    className: 'recipe-view__hero',
    iconClass: 'recipe-view__plate',
  });
}

/**
 * Der Kopf des Details: wie oft und wann gekocht bzw. geplant (aus dem
 * Essensplan), die Mahlzeiten - nur wenn sie unterscheiden oder bei `read` -
 * und eine Reihe Zahlen (Zutaten, Schritte, "masz 5 z 6").
 */
function recipeHeadEl(recipe, mealTypes) {
  const head = document.createElement('div');
  head.className = 'recipe-detail__head';

  // Erste Zeile (17 ink-2): wie oft und wann zuletzt gekocht - oder, wenn
  // noch nie, wann es geplant ist. Die zweite Zeile (13 ink-2) traegt den
  // Plan (falls die erste schon belegt ist) und die Mahlzeiten.
  const planned = state.plannedOn.get(recipe.id);
  const plannedText = planned ? t('recipes.plannedWhen', { when: upcomingLabel(planned) }) : '';
  let metaText = '';
  if (recipe.cooked_count > 0) {
    metaText = t('recipes.cookedTimes', { count: recipe.cooked_count });
    if (recipe.last_cooked_on) metaText += ` · ${t('recipes.cookedLast', { when: agoLabel(recipe.last_cooked_on) })}`;
  } else if (plannedText) {
    metaText = plannedText;
  }
  if (metaText) {
    const meta = document.createElement('p');
    meta.className = 'recipe-detail__meta';
    meta.textContent = metaText;
    head.appendChild(meta);
  }
  const sub = document.createElement('div');
  sub.className = 'recipe-detail__sub';
  if (plannedText && recipe.cooked_count > 0) {
    const plan = document.createElement('span');
    plan.className = 'recipe-detail__planned';
    plan.textContent = plannedText;
    sub.appendChild(plan);
  }

  // Mahlzeiten nur, wenn sie unterscheiden: gilt ein Rezept für alle, ist die
  // Reihe reine Ornamentik (Audit A1-21). BEI `read` IMMER (Regel 9 in
  // utils/module-access.js): im Formular stehen sie als Chips, und wer es nicht
  // oeffnen darf, saehe „gilt fuer alle" sonst nur daran, dass hier nichts steht.
  // Tafla: als Text in ink-2, nicht als farbige Marken (recipes.css).
  const showMealTypeBadges = mealTypes.length && (readOnly() || mealTypes.length < mealTypeOptions().length);
  if (showMealTypeBadges) {
    const badges = document.createElement('div');
    badges.className = 'recipe-card__meal-types';
    badges.append(...mealTypeOptions()
      .filter((option) => mealTypes.includes(option.key))
      .map((option) => {
        const badge = document.createElement('span');
        badge.className = `meal-type-badge meal-type-badge--${option.key}`;
        badge.textContent = option.label;
        return badge;
      }));
    sub.appendChild(badges);
  } else if (!mealTypes.length) {
    // Keine Mahlzeit ist eine Aussage und braucht ein Wort: das Rezept fällt
    // aus Menüplan und Zufallsauswahl heraus (#750).
    const none = document.createElement('div');
    none.className = 'recipe-card__meal-types';
    const badge = document.createElement('span');
    badge.className = 'meal-type-badge meal-type-badge--none';
    badge.textContent = t('recipes.mealTypeNone');
    none.appendChild(badge);
    sub.appendChild(none);
  }
  if (sub.childNodes.length) head.appendChild(sub);

  const facts = recipeFactsEl(recipe);
  if (facts) head.appendChild(facts);

  return head.childNodes.length ? head : null;
}

/**
 * Drei Spalten, Wert ueber Bezeichnung (Tafla). Nur echte Zahlen: Zutaten,
 * Schritte und - wenn der Vorrat bekannt ist - "5 z 6 / masz" mit Zaehler.
 * Zeit und Portionen aus dem Entwurf gibt es nicht, Rezepte tragen keine.
 * Eine einzelne Zahl allein wiederholte nur die Liste darunter.
 */
function recipeFactsEl(recipe) {
  const ingredients = recipe.ingredients ?? [];
  const steps = splitSteps(recipe.notes);
  const items = [];
  if (ingredients.length) items.push({ value: String(ingredients.length), label: t('recipes.factIngredients') });
  if (steps.length >= 2) items.push({ value: String(steps.length), label: t('recipes.factSteps') });
  const tally = pantryTally(recipe);
  if (tally) items.push({ value: t('recipes.haveOf', tally), label: t('recipes.factHave'), tally });
  if (items.length < 2) return null;

  const dl = document.createElement('dl');
  dl.className = 'recipe-detail__facts';
  for (const item of items) {
    const cell = document.createElement('div');
    cell.className = 'recipe-detail__fact';
    const dt = document.createElement('dt');
    dt.textContent = item.label;
    const dd = document.createElement('dd');
    const value = document.createElement('span');
    value.textContent = item.value;
    dd.appendChild(value);
    if (item.tally) dd.appendChild(meterEl(item.tally));
    cell.append(dt, dd);
    dl.appendChild(cell);
  }
  return dl;
}

/**
 * Der Zutaten-Zaehler (Tafla "Licznik składników"): ein Segment je Zutat,
 * vorhanden in Tinte, fehlend im Warnton. Ab zwoelf Zutaten anteilig, damit
 * die Segmente lesbar bleiben. Dekorativ - die Zahl daneben sagt dasselbe.
 */
function meterEl({ have, total }) {
  const meter = document.createElement('span');
  meter.className = 'recipe-meter';
  meter.setAttribute('aria-hidden', 'true');
  const segments = Math.min(total, 12);
  const owned = Math.round((have / total) * segments);
  for (let i = 0; i < segments; i += 1) {
    const seg = document.createElement('span');
    seg.className = `recipe-meter__seg${i < owned ? '' : ' recipe-meter__seg--missing'}`;
    meter.appendChild(seg);
  }
  return meter;
}

/* ABSCHNITTSKOEPFE, DIE MAN ANSPRINGEN KANN (Re-Critique 2026-09-27, W2).
 *
 * Jeder Abschnitt traegt eine echte Ueberschrift (h3, unter dem Titel des
 * Rezepts). Tafla: Titel 22/600, rechts daneben hoechstens eine Handlung
 * ("Dopisz 1"). Die Worte sind die Feldnamen des Formulars - dieselbe Sache
 * heisst an beiden Stellen gleich. */
function detailSectionEl(title, action = null) {
  const section = document.createElement('section');
  section.className = 'recipe-detail__section';
  const head = document.createElement('div');
  head.className = 'recipe-detail__section-head';
  const heading = document.createElement('h3');
  heading.className = 'recipe-detail__section-title';
  heading.textContent = title;
  head.appendChild(heading);
  if (action) head.appendChild(action);
  section.appendChild(head);
  return section;
}

/**
 * Der Zutaten-Abschnitt als EIN Element mit Rezept-ID, damit eine geaenderte
 * Zuordnung oder ein Uebertrag auf die Liste ihn an beiden Orten (Blatt und
 * Detailspalte) als Ganzes neu bauen kann - samt "Dopisz N".
 *
 * Tafla: eine Karte aus 48er-Zeilen. Vorn das Zeichen des Vorrats (Haken:
 * vorhanden, Ring: nicht zu sehen; nichts, wenn der Vorrat unbekannt ist),
 * dann der Name - mit "na liście", wenn die Zutat offen auf einer
 * Einkaufsliste steht -, rechts die Menge in tabellarischen Ziffern.
 */
function ingredientsSectionEl(recipe) {
  const ingredients = recipe.ingredients ?? [];
  const missing = missingIngredients(recipe);
  const section = detailSectionEl(t('recipes.ingredientsLabel'), missingTransferButton(recipe, missing));
  section.classList.add('recipe-detail__ingredients-section');
  section.dataset.recipeId = String(recipe.id);
  const ul = document.createElement('ul');
  ul.className = 'recipe-detail__ingredients';
  for (const ing of ingredients) {
    const { have, onList } = ingredientState(ing);
    const item = document.createElement('li');
    item.className = 'recipe-detail__ingredient';
    item.appendChild(ingredientStatusEl(have));
    const label = document.createElement('span');
    label.className = 'recipe-detail__ingredient-name';
    label.textContent = ing.name;
    // Die Einkaufskategorie steht sonst NUR im Formular. Bei `read` deshalb
    // hier, wo der Tipp landet (Regel 9) - als Text, nicht als Auswahl.
    if (readOnly() && ing.category) {
      const category = document.createElement('span');
      category.className = 'recipe-detail__ingredient-category';
      category.textContent = categoryLabel(ing.category);
      label.append(' ', category);
    }
    if (onList && have !== true) {
      const pill = document.createElement('span');
      pill.className = 'recipe-detail__pill';
      pill.textContent = t('recipes.onList');
      label.append(' ', pill);
    }
    item.appendChild(label);
    // Die Menge hat ihre eigene Spalte (Critique R18): rechtsbuendig in gleich
    // breiten Ziffern, sodass "200 g", "1 EL" und "2" an EINER Kante enden.
    // Die Zelle steht auch ohne Menge da (leer), damit die Spalte haelt.
    const quantity = document.createElement('span');
    quantity.className = 'recipe-detail__ingredient-quantity';
    quantity.textContent = ing.quantity ?? '';
    item.appendChild(quantity);
    item.appendChild(pantryMatchEl(recipe, ing));
    ul.appendChild(item);
  }
  section.appendChild(ul);
  const bulk = pantryMatchBulkEl(recipe);
  if (bulk) section.appendChild(bulk);
  return section;
}

/**
 * Das Vorrats-Zeichen einer Zutat: Haken (16, ink-2) wenn vorhanden, ein Ring
 * wenn im Vorrat nichts Passendes zu sehen ist. Ohne Vorratswissen ein leerer
 * Platz - unbekannt ist nicht fehlend (docs/DECISIONS.md Abschnitt 7).
 */
function ingredientStatusEl(have) {
  const slot = document.createElement('span');
  slot.className = 'recipe-detail__ingredient-status';
  if (have === null) {
    slot.setAttribute('aria-hidden', 'true');
    return slot;
  }
  slot.setAttribute('role', 'img');
  slot.setAttribute('aria-label', have ? t('recipes.inPantry') : t('recipes.notInPantry'));
  slot.insertAdjacentHTML('beforeend', have
    ? '<i data-lucide="check" class="recipe-detail__have" aria-hidden="true"></i>'
    : '<span class="recipe-detail__ring" aria-hidden="true"></span>');
  return slot;
}

/**
 * "Dopisz N" (Tafla): nur die Zutaten, die der Vorrat nicht zu haben scheint
 * und die noch auf keiner Liste stehen. Dieselben zwei Riegel wie "Na listę"
 * (shoppingTransferButton); ohne Vorratswissen gibt es den Knopf nicht - dann
 * bleibt "Na listę" mit allen Zutaten.
 */
function missingTransferButton(recipe, missing) {
  if (!missing.length || !state.lists.length) return null;
  if (!mayTransferRecipeToShopping(recipe.id)) return null;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'recipe-detail__add-missing';
  btn.dataset.action = 'to-shopping-missing';
  btn.dataset.id = String(recipe.id);
  btn.textContent = t('recipes.addMissing', { count: missing.length });
  btn.setAttribute('aria-label', t('recipes.addMissingLabel', { count: missing.length }));
  return btn;
}

/** Kroki (Tafla): eine Karte, Nummern in der Stimme, der Text in Body. */
function stepsSectionEl(steps) {
  const section = detailSectionEl(t('recipes.stepsLabel'));
  section.classList.add('recipe-detail__steps-section');
  const ol = document.createElement('ol');
  ol.className = 'recipe-detail__steps';
  steps.forEach((text, i) => {
    const li = document.createElement('li');
    li.className = 'recipe-detail__step';
    const num = document.createElement('span');
    num.className = 'recipe-detail__step-num';
    num.setAttribute('aria-hidden', 'true');
    num.textContent = String(i + 1);
    const body = document.createElement('span');
    body.className = 'recipe-detail__step-text';
    body.textContent = text;
    li.append(num, body);
    ol.appendChild(li);
  });
  section.appendChild(ol);
  return section;
}

/**
 * Baut jeden Zutaten-Abschnitt dieses Rezepts neu - in der Detailspalte (in
 * der Seite) und im Blatt (ein Dialog am Ende von <body>, nicht in der Seite).
 */
function renderIngredientSections(recipe) {
  const selector = `.recipe-detail__ingredients-section[data-recipe-id="${CSS.escape(String(recipe.id))}"]`;
  const inPage = [...(_container?.querySelectorAll(selector) ?? [])];
  const inSheet = [...(document.querySelectorAll?.(`.modal-panel--recipe ${selector}`) ?? [])];
  for (const el of new Set([...inPage, ...inSheet])) {
    const next = ingredientsSectionEl(recipe);
    el.replaceWith(next);
    if (window.lucide) window.lucide.createIcons({ el: next });
  }
}

/* DIE BESTAETIGTE ZUORDNUNG ZU EINER VORRATSZEILE (#1314, Stufe 1).
 *
 * Sie steht im Rezeptdetail, neben der Zutat, und nirgends sonst: eine eigene
 * Zuordnungsseite oeffnet niemand ein zweites Mal (#1314, Punkt 2). Yuvomi
 * schlaegt dabei NICHTS vor - auch dann nicht, wenn eine Vorratszeile genauso
 * heisst. Ein geratener Treffer waere der gepflegte Katalog, eine Ableitung
 * nach der anderen (docs/DECISIONS.md Abschnitt 7).
 *
 * UND DAS WORT ZAEHLT. Eine Zutat ohne Zuordnung heisst „nicht zugeordnet",
 * niemals „fehlt": Stufe 1 weiss nur, worauf der Haushalt gezeigt hat, und
 * nichts ueber den Bestand. Ein „fehlt" waere eine vollstaendige Auskunft auf
 * halber Datenlage - genau das, was der Abschnitt unter „What counts as undoing
 * it" nennt.
 */

/** 'none' | 'read' | 'write' - was dieses Konto mit dem Vorrat darf. */
function pantryAccess() {
  if (window.yuvomi?.isModuleDisabled?.('pantry')) return 'none';
  return navModuleAccess('pantry');
}

/**
 * Darf dieses Konto eine Zutat zuordnen? ZWEI RIEGEL, wie beim Transfer in den
 * Einkauf (Regel 8): `PUT /recipes/:id/ingredient-match` misst der Pfad-Guard
 * als `meals`, und die Route verlangt dazu `pantry: write`
 * (server/routes/recipes.js). Bis #1265 fragte die Oberflaeche nur den Vorrat -
 * mit `meals: read` und `pantry: write` standen Knopf und Dialog da, und das
 * Speichern endete im 403.
 *
 * @param {number|string} recipeId
 */
function mayMatchIngredient(recipeId) {
  return pantryAccess() === 'write' && mayWritePath(`/recipes/${recipeId}/ingredient-match`);
}

/**
 * Der Zuordnungs-Zustand einer Zutat als Element.
 *
 * Bei `read` bleibt der ZUSTAND stehen und nur die HANDLUNG geht (die Regel aus
 * #467): ein Mitglied, das den Vorrat nur ansehen darf, sieht die Zuordnung,
 * kann sie aber nicht aendern. Bei `none` steht hier gar nichts - wer den
 * Vorrat nicht sehen darf, erfaehrt auch nicht, dass es dort eine Zeile gibt.
 *
 * NUR DIE BESTEHENDE ZUORDNUNG STEHT AN DER ZEILE (Re-Critique 2026-09-27, W2).
 * Hier stand an jeder offenen Zutat „Nicht zugeordnet" - sechsmal je Rezept,
 * unterstrichen, lauter als die Menge. Die Zuordnung ist ein Werkzeug fuer den
 * Vorrat, kein Zustand des Rezepts; ihr Fehlen ist der Normalfall und braucht
 * kein Wort je Zeile. Der Weg dorthin steht EINMAL unter der Liste
 * (`pantryMatchBulkEl`). Das Wort „fehlt" bleibt weiter ausgeschlossen (Kopf
 * dieses Abschnitts): wo nichts steht, behauptet die Zeile auch nichts.
 */
function pantryMatchEl(recipe, ing) {
  const access = pantryAccess();
  if (access === 'none') return document.createDocumentFragment();

  const matched = Boolean(ing.pantry_item_id);
  if (!matched) return document.createDocumentFragment();
  const text = ing.pantry_item_name;

  if (!mayMatchIngredient(recipe.id)) {
    const span = document.createElement('span');
    span.className = 'recipe-detail__ingredient-match';
    span.textContent = text;
    return span;
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'recipe-detail__ingredient-match';
  btn.dataset.action = 'match-ingredient';
  btn.dataset.id = String(recipe.id);
  btn.dataset.ingredient = ing.name;
  btn.textContent = text;
  // Der sichtbare Text ist der Zustand, nicht die Handlung - deshalb sagt das
  // Zugaengliche-Name-Feld, was der Knopf TUT, und nennt die Zutat dazu: in
  // einer Liste aus acht Zutaten waere „Zuordnen" achtmal derselbe Name.
  btn.setAttribute('aria-label', t('recipes.ingredientMatchAction', { name: ing.name }));
  return btn;
}

/**
 * DER EINE WEG ZU DEN OFFENEN ZUORDNUNGEN: ein stiller Knopf unter der Liste,
 * der sagt, wie viele Zutaten noch keine Vorratszeile haben, und sie in EINEM
 * Dialog zuordnen laesst. Nur fuer Konten, die den Vorrat schreiben duerfen -
 * Nur-Lesende sehen die bestehenden Zuordnungen und keine Handlung (#467).
 * `null`, wenn es nichts zu tun gibt.
 */
function pantryMatchBulkEl(recipe) {
  if (!mayMatchIngredient(recipe.id)) return null;
  const open = (recipe.ingredients ?? []).filter((ing) => !ing.pantry_item_id);
  if (!open.length) return null;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn--ghost recipe-detail__match-open';
  btn.dataset.action = 'match-ingredients';
  btn.dataset.id = String(recipe.id);
  btn.insertAdjacentHTML('beforeend', '<i data-lucide="link" class="icon-sm" aria-hidden="true"></i>');
  const label = document.createElement('span');
  label.textContent = t('recipes.ingredientMatchOpen', { count: open.length });
  btn.appendChild(label);
  return btn;
}

/** Eine Vorratszeile im Auswahlfeld: Name, Ort und MHD unterscheiden Chargen. */
function pantryOptionLabel(item) {
  const teile = [item.name];
  if (item.location_name) teile.push(item.location_name);
  if (item.expires_on) teile.push(formatDate(item.expires_on));
  return teile.join(' · ');
}

/**
 * Die Optionen EINER Vorrats-Auswahl: "nicht zugeordnet" und je Zeile ihr
 * Name samt Ort und MHD. Ein Helfer fuer jede Auswahl - Einzel- und
 * Sammeldialog und den Neuaufbau nach "die gewaehlte Zeile gibt es nicht
 * mehr", damit sie nicht auseinanderlaufen.
 */
function pantrySelectOptionsHtml(items, selectedId = null) {
  return `<option value="">${esc(t('recipes.ingredientMatchNone'))}</option>${items.map((item) => `<option value="${esc(String(item.id))}"${
    item.id === selectedId ? ' selected' : ''
  }>${esc(pantryOptionLabel(item))}</option>`).join('')}`;
}

/**
 * Die im Dialog GEWAEHLTE Vorratszeile ist weg (#1909): der Dialog bleibt mit
 * seiner Auswahl offen, jede Auswahl bekommt den aktuellen Vorrat. Eine Wahl,
 * die es noch gibt, bleibt stehen; eine weggefallene steht danach auf "nicht
 * zugeordnet", und die erste davon traegt den Fokus. Scheitert das Nachladen,
 * bleibt die Auswahl, wie sie war - der Satz steht schon da.
 *
 * @param {HTMLSelectElement[]} selects
 */
async function offerCurrentPantryItems(selects) {
  let items;
  try {
    const res = await api.get('/pantry');
    items = res.data ?? [];
  } catch (err) {
    console.warn('[Recipes] pantry reload failed:', err);
    return;
  }
  const present = new Set(items.map((item) => String(item.id)));
  let focusTarget = null;
  for (const select of selects) {
    const chosen = String(select.value ?? '');
    select.replaceChildren();
    select.insertAdjacentHTML('beforeend', pantrySelectOptionsHtml(items));
    const keep = chosen !== '' && present.has(chosen);
    select.value = keep ? chosen : '';
    if (!keep && chosen !== '' && !focusTarget) focusTarget = select;
  }
  focusTarget?.focus();
}

async function openPantryMatchModal(recipe, ingredientName) {
  // Zweite Linie hinter dem Markup, VOR dem Laden des Vorrats.
  if (!mayMatchIngredient(recipe.id)) return;
  const ing = (recipe.ingredients ?? []).find((i) => i.name === ingredientName);
  if (!ing) return;

  let items = [];
  const owner = _container;
  try {
    const res = await api.get('/pantry');
    items = res.data ?? [];
  } catch (err) {
    reportError(err, { owner, fallbackKey: 'recipes.ingredientMatchLoadError' });
    return;
  }

  openSharedModal({
    title: t('recipes.ingredientMatchTitle', { name: ingredientName }),
    size: 'sm',
    content: `
      <p class="form-hint">${t('recipes.ingredientMatchHint')}</p>
      ${items.length ? `
        <div class="form-group">
          <label class="form-label" for="pantry-match-select">${t('recipes.ingredientMatchLabel')}</label>
          <select id="pantry-match-select" class="form-input">
            ${pantrySelectOptionsHtml(items, ing.pantry_item_id)}
          </select>
        </div>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button class="btn btn--secondary" id="pantry-match-cancel" type="button">${t('common.cancel')}</button>
          <button class="btn btn--primary" id="pantry-match-save" type="button">${t('common.save')}</button>
        </div>
      ` : `
        <p class="form-hint">${t('recipes.ingredientMatchEmpty')}</p>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button class="btn btn--secondary" id="pantry-match-cancel" type="button">${t('common.close')}</button>
        </div>
      `}
    `,
    onSave(panel) {
      panel.querySelector('#pantry-match-cancel')?.addEventListener('click', () => closeSharedModal());
      panel.querySelector('#pantry-match-save')?.addEventListener('click', async () => {
        const raw = panel.querySelector('#pantry-match-select')?.value ?? '';
        const pantryItemId = raw === '' ? null : Number(raw);
        // Die Rechte koennen sich aendern, waehrend der Dialog offen steht.
        if (!mayMatchIngredient(recipe.id)) return;
        const dialog = captureModalContext();
        const owner = _container;
        try {
          const res = await api.put(`/recipes/${recipe.id}/ingredient-match`, {
            name: ingredientName,
            pantryItemId,
          });
          // Den geladenen Stand nachziehen statt neu zu holen: die Antwort
          // traegt genau die beiden Felder, die sich geaendert haben.
          ing.pantry_item_id = res.data.pantry_item_id;
          ing.pantry_item_name = res.data.pantry_item_name;
          // force: der Schreibvorgang ist durch, eine Verwerfen-Frage waere
          // eine Frage nach etwas, das schon gespeichert ist. `context`: nur
          // DIESEN Dialog - einen inzwischen geoeffneten anderen laesst die
          // spaete Antwort stehen, samt allem, was darin getippt ist (#1997).
          const ownDialog = isOwnModalOpen(dialog);
          closeSharedModal({ force: true, context: dialog });
          window.yuvomi?.showToast(
            pantryItemId === null ? t('recipes.ingredientMatchCleared') : t('recipes.ingredientMatchSaved'),
            'success',
          );
          // Seite verlassen (oder neu betreten): nichts zeichnen, keinen Fokus
          // ziehen - wie reportError.
          if (!stillShown(owner)) return;
          // NUR DEN ZUTATEN-ABSCHNITT NEU BAUEN, kein renderRecipeList(): das
          // Zutaten-Detail ist gerade aufgeklappt, und ein Neuaufbau der Liste
          // klappte es zu - der Nutzer stuende nach dem Speichern vor der
          // geschlossenen Zeile, aus der er kam.
          //
          // Die Zutat steht an ZWEI Stellen - im Aufklapper der Zeile und in
          // der Detailspalte. Beide ziehen nach, sonst zeigte der Aufklapper
          // nach dem naechsten Schmalerziehen den alten Stand. Als ganzer
          // Abschnitt, weil der Sammelknopf darunter seine Zahl mitaendert.
          renderIngredientSections(recipe);
          // Der Ausloeser ist mit dem Abschnitt ersetzt: den Fokus auf seinen
          // Nachfolger tragen (gleiches data-action/data-id) - nur, wenn es
          // dieser Dialog war, der eben zuging. Sonst gehoert der Fokus dem,
          // was der Nutzer inzwischen tut.
          if (ownDialog) refocusAfterRender();
        } catch (err) {
          if (isSelectedPantryItemGone(err)) {
            window.yuvomi?.showToast(errorSentence(err), 'danger');
            // Wie reportError: nur, solange Seite und Dialog noch dieselben sind.
            if (!stillShown(owner) || !isModalContextCurrent(dialog)) return;
            await offerCurrentPantryItems([panel.querySelector('#pantry-match-select')].filter(Boolean));
            return;
          }
          reportError(err, { owner, dialog, recipeId: recipe.id, recipeRef: recipe, ingredientName });
        }
      });
    },
  });
}

/**
 * Alle offenen Zuordnungen eines Rezepts in EINEM Dialog: je Zutat ein
 * Auswahlfeld, beschriftet mit der Zutat. Gespeichert wird nur, was sich
 * geaendert hat, Zutat fuer Zutat ueber denselben Endpunkt wie der
 * Einzeldialog - er kennt keine Sammelform, und eine eigene waere eine zweite
 * Fassung derselben Regel (Yuvomi raet nichts, es gilt nur Bestaetigtes).
 */
async function openPantryBulkMatchModal(recipe) {
  if (!mayMatchIngredient(recipe.id)) return;
  const open = (recipe.ingredients ?? []).filter((ing) => !ing.pantry_item_id);
  if (!open.length) return;

  let items = [];
  const owner = _container;
  try {
    const res = await api.get('/pantry');
    items = res.data ?? [];
  } catch (err) {
    reportError(err, { owner, fallbackKey: 'recipes.ingredientMatchLoadError' });
    return;
  }
  const fields = open.map((ing, i) => `
        <div class="form-group">
          <label class="form-label" for="pantry-bulk-match-${i}">${esc(ing.quantity ? `${ing.quantity} · ${ing.name}` : ing.name)}</label>
          <select id="pantry-bulk-match-${i}" class="form-input" data-ingredient-index="${i}">
            ${pantrySelectOptionsHtml(items)}
          </select>
        </div>`).join('');

  openSharedModal({
    title: t('recipes.ingredientMatchBulkTitle'),
    size: 'sm',
    content: `
      <p class="form-hint">${t('recipes.ingredientMatchBulkHint')}</p>
      ${items.length ? `${fields}
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button class="btn btn--secondary" id="pantry-bulk-match-cancel" type="button">${t('common.cancel')}</button>
          <button class="btn btn--primary" id="pantry-bulk-match-save" type="button">${t('common.save')}</button>
        </div>
      ` : `
        <p class="form-hint">${t('recipes.ingredientMatchEmpty')}</p>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button class="btn btn--secondary" id="pantry-bulk-match-cancel" type="button">${t('common.close')}</button>
        </div>
      `}
    `,
    onSave(panel) {
      panel.querySelector('#pantry-bulk-match-cancel')?.addEventListener('click', () => closeSharedModal());
      const save = panel.querySelector('#pantry-bulk-match-save');
      save?.addEventListener('click', async () => {
        const chosen = [...panel.querySelectorAll('select[data-ingredient-index]')]
          .filter((sel) => sel.value !== '')
          .map((sel) => ({ ing: open[Number(sel.dataset.ingredientIndex)], pantryItemId: Number(sel.value) }));
        if (!chosen.length) { closeSharedModal({ force: true }); return; }
        if (!mayMatchIngredient(recipe.id)) return;
        save.disabled = true;
        let saved = 0;
        // Die Zutat, an der ein Fehler haengt: "gibt es nicht mehr" nimmt sie
        // aus dem Stand (reportError).
        let current = null;
        const dialog = captureModalContext();
        const owner = _container;
        try {
          for (const { ing, pantryItemId } of chosen) {
            current = ing;
            const res = await api.put(`/recipes/${recipe.id}/ingredient-match`, { name: ing.name, pantryItemId });
            ing.pantry_item_id = res.data.pantry_item_id;
            ing.pantry_item_name = res.data.pantry_item_name;
            saved += 1;
          }
          // Wie im Einzeldialog: nur diesen Dialog schliessen, nur auf dieser
          // Seite zeichnen und den Fokus nur zurueckgeben, wenn er es war (#1997).
          const ownDialog = isOwnModalOpen(dialog);
          closeSharedModal({ force: true, context: dialog });
          window.yuvomi?.showToast(t('recipes.ingredientMatchSaved'), 'success');
          if (!stillShown(owner)) return;
          renderIngredientSections(recipe);
          if (ownDialog) refocusAfterRender();
        } catch (err) {
          // Was bis zum Fehler gespeichert ist, bleibt gespeichert und steht
          // gleich in der Liste; der Dialog bleibt fuer den Rest offen.
          if (saved && stillShown(owner)) renderIngredientSections(recipe);
          save.disabled = false;
          if (isSelectedPantryItemGone(err)) {
            window.yuvomi?.showToast(errorSentence(err), 'danger');
            // Wie reportError: nur, solange Seite und Dialog noch dieselben sind.
            if (!stillShown(owner) || !isModalContextCurrent(dialog)) return;
            await offerCurrentPantryItems([...panel.querySelectorAll('select[data-ingredient-index]')]);
            return;
          }
          reportError(err, { owner, dialog, recipeId: recipe.id, recipeRef: recipe, ingredientName: current?.name ?? null });
        }
      });
    },
  });
}

/* ENTFERNT: openRecipeReadModal (Nur-Lese-Modal fürs Kochen, Audit A1-21).
 *
 * Es zeigte volle Zutatenliste, Notizen und Link - genau das, was jetzt das
 * Aufklapp-Detail der Zeile zeigt, nur ohne Kontextverlust, ohne Overlay und
 * ohne einen zweiten Weg zur selben Information (Kriterium aus distill:
 * „wenn es woanders steht, wiederhole es nicht"). Sein Auslöser war zusätzlich
 * eine Karte mit role="button", die Buttons enthielt.
 *
 * Der Zweck bleibt erfüllt: Lesen erzwingt weiter kein Bearbeiten-Formular. Das
 * Herkunfts-Badge, das hier stand, sitzt jetzt in der Zeilenüberschrift selbst -
 * sichtbar, bevor man überhaupt aufklappt (siehe sourceBadge() weiter oben).
 */

/**
 * Fuss des Rezept-Dialogs nach dem Kanon `[Loeschen links] ... [Abbrechen]
 * [Primaer]` (R8 H10). Loeschen gab es bis dahin nur im Detailkopf und im
 * Zeilenmenue. Gespiegelte Rezepte bleiben ohne: sie gehoeren dem Provider,
 * dieselbe Regel wie in `ROW_ACTIONS`.
 */
function recipeModalFooterHtml(isEdit, recipe) {
  const canDelete = isEdit && recipe?.source === 'native';
  return `
      <div class="modal-panel__footer modal-panel__footer--plain">
        ${canDelete ? `<button type="button" class="btn btn--danger-outline" id="recipe-delete" style="margin-inline-end:auto"><i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>${esc(t('common.delete'))}</button>` : ''}
        <button class="btn btn--secondary" id="recipe-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="recipe-save">${isEdit ? t('common.save') : t('common.add')}</button>
      </div>`;
}

function openRecipeModal(mode, recipe = null) {
  // Der Riegel steht VOR jeder Vorbereitung, und er steht HIER, weil FAB,
  // Leerzustand, Zeile, Ueberlaufmenue und Detailkopf alle diesen Weg nehmen.
  // Eine eigene Leseansicht geht nicht auf: die ist der Aufklapper der Zeile
  // bzw. die Detailspalte (siehe readOnly()).
  if (readOnly()) return;
  const isEdit = mode === 'edit';

  openSharedModal({
    title: isEdit ? t('recipes.editRecipe') : t('recipes.addRecipe'),
    size: 'md',
    content: `
      <div class="form-group">
        <label class="form-label" for="recipe-title">${t('common.nameLabel')}${REQUIRED_MARK}</label>
        <input id="recipe-title" class="form-input" type="text" required placeholder="${t('recipes.titlePlaceholder')}">
      </div>
      <div class="form-group">
        <span class="form-label" id="recipe-meal-types-label">${t('meals.mealTypeLabel')}</span>
        <!-- UMSCHALT-CHIPS STATT CHECKBOX PLUS BADGE (Re-Critique 2026-09-28,
             A4 P2-7): jede Option trug eine native Checkbox UND ein Farbbadge -
             zwei Zeichen fuer eine Wahl; der Kanon fuehrt die native Checkbox
             fuer Mehrfachauswahl unter "Nicht mehr". -->
        <div class="recipe-meal-types" id="recipe-meal-types" role="group" aria-labelledby="recipe-meal-types-label">
          ${mealTypeOptions().map((option) => `
            <button type="button" class="filter-chip recipe-meal-types__chip" data-meal-type="${option.key}" aria-pressed="false">${esc(option.label)}</button>
          `).join('')}
          <input type="hidden" id="recipe-meal-types-value" value="">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">${t('recipes.ingredientsLabel')}</label>
        <div class="recipe-ingredient-list" id="recipe-ingredient-list"></div>
        <button class="btn btn--secondary recipe-add-ingredient" type="button" id="recipe-add-ingredient"><i data-lucide="plus" class="icon-md" aria-hidden="true"></i>${t('meals.addIngredient')}</button>
      </div>
      ${advancedSection(`
        <div class="form-group">
          <label class="form-label" for="recipe-notes">${t('recipes.notesLabel')}</label>
          <textarea id="recipe-notes" class="form-input" rows="3" placeholder="${t('recipes.notesPlaceholder')}"></textarea>
        </div>
        ${/* Ein eigenes Bild (#1059, Schritt 2) - fuer gespiegelte Rezepte
            * ausgeblendet: die sind hier ohnehin schreibgeschuetzt, ihr Inhalt
            * gehoert dem Provider. */ ''}
        <div class="form-group" id="recipe-image-group"${isEdit && recipe?.source !== 'native' ? ' hidden' : ''}>
          <label class="form-label">${t('recipes.imageLabel')}</label>
          <div class="recipe-image-editor">
            <button type="button" class="recipe-image-preview" id="recipe-image-preview"
                    aria-label="${esc(t('recipes.imageLabel'))}"></button>
            <input class="sr-only" id="recipe-image" type="file" accept="image/png,image/jpeg,image/webp"
                   aria-label="${esc(t('recipes.imageLabel'))}" tabindex="-1">
            <button type="button" class="btn btn--secondary btn--sm" id="recipe-image-pick">${t('recipes.imageChoose')}</button>
            <button type="button" class="btn btn--ghost btn--sm" id="recipe-image-remove">${t('recipes.imageRemove')}</button>
          </div>
          <p class="form-hint">${t('recipes.imageHint')}</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="recipe-url">${t('recipes.urlLabel')}</label>
          <input id="recipe-url" class="form-input" type="url" placeholder="${t('recipes.urlPlaceholder')}">
        </div>`,
        { open: isEdit && (!!recipe.notes || !!recipe.recipe_url) })}
      ${recipeModalFooterHtml(isEdit, recipe)}
    `,
    onSave(panel) {
      panel.querySelector('#recipe-title').value = isEdit ? recipe.title : '';
      panel.querySelector('#recipe-notes').value = isEdit && recipe.notes ? recipe.notes : '';
      panel.querySelector('#recipe-url').value = isEdit && recipe.recipe_url ? recipe.recipe_url : '';

      /* BILD (#1059, Schritt 2) - dasselbe Vorgehen wie beim Gegenstandsfoto:
       * Auswahl, Zuschnitt und Groessenpruefung macht `pickCroppedImage`.
       *
       * `bildStand` traegt DREI Zustaende, und die dritte ist der Grund fuer die
       * Fallunterscheidung beim Speichern: `undefined` heisst "nicht angefasst"
       * (der Server laesst das gespeicherte Bild stehen), `null` heisst "entfernt",
       * eine Data-URL heisst "das hier". Ohne den Unterschied schickte jedes
       * Speichern eines bebilderten Rezepts entweder null (Bild weg) oder muesste
       * die ganze Data-URL erneut hochladen. */
      let bildStand;
      const bildVorschau = panel.querySelector('#recipe-image-preview');
      const bildInput = panel.querySelector('#recipe-image');
      const zeigeBild = () => {
        if (!bildVorschau) return;
        bildVorschau.replaceChildren();
        // Beim Bearbeiten kommt das gespeicherte Bild ueber die Route, nicht aus
        // den Listendaten - dort steht nur das Flag (die Data-URL waere zu gross).
        const quelle = bildStand !== undefined
          ? bildStand
          : (isEdit && recipe?.has_own_image ? `/api/v1/recipes/${recipe.id}/image` : null);
        if (quelle) {
          const img = document.createElement('img');
          img.className = 'recipe-image-preview__img';
          img.src = quelle;
          img.alt = '';
          bildVorschau.appendChild(img);
        } else {
          bildVorschau.insertAdjacentHTML('beforeend', '<i data-lucide="image-plus" class="icon-md" aria-hidden="true"></i>');
          if (window.lucide) window.lucide.createIcons({ el: bildVorschau });
        }
      };
      zeigeBild();
      bildVorschau?.addEventListener('click', () => bildInput?.click());
      panel.querySelector('#recipe-image-pick')?.addEventListener('click', () => bildInput?.click());
      bildInput?.addEventListener('change', async (e) => {
        const datei = e.target.files?.[0];
        // Sofort zuruecksetzen: sonst feuert dieselbe Datei nach einem
        // abgebrochenen Zuschnitt kein zweites `change`.
        e.target.value = '';
        let ImageProblemType = null;
        try {
          const { pickCroppedImage, ImageProblem } = await import('/utils/avatar-crop.js');
          ImageProblemType = ImageProblem;
          const zugeschnitten = await pickCroppedImage(datei, {
            messageKeys: { dataTooLarge: 'recipes.imageTooLarge' },
          });
          if (zugeschnitten === undefined) return; // abgebrochen
          bildStand = zugeschnitten;
          zeigeBild();
        } catch (err) {
          // Die Pruefung des Bildes sagt ihren Satz; jeder andere Wurf (ein
          // Ladefehler, ein Programmfehler) den allgemeinen, nie seinen
          // eigenen, unuebersetzten Text (#1909).
          window.yuvomi?.showToast(
            ImageProblemType && err instanceof ImageProblemType ? err.sentence : t('common.errorGeneric'),
            'danger',
          );
        }
      });
      panel.querySelector('#recipe-image-remove')?.addEventListener('click', () => {
        bildStand = null;
        zeigeBild();
      });
      panel.dataset.bildGesetzt = '';
      panel._bildStand = () => bildStand;
      const selectedMealTypes = normalizeRecipeMealTypes(isEdit ? recipe.meal_types : RECIPE_MEAL_TYPE_KEYS);
      // Der Dialog vergleicht fuer "Aenderungen verwerfen?" die Werte seiner
      // Felder (modal.js); ein Knopf hat keinen. Das versteckte Feld traegt die
      // Auswahl als Wert - ohne es verwarf Schliessen eine geaenderte Auswahl still.
      const typesValue = panel.querySelector('#recipe-meal-types-value');
      const syncTypesValue = () => {
        typesValue.value = [...panel.querySelectorAll('#recipe-meal-types [aria-pressed="true"]')]
          .map((chip) => chip.dataset.mealType).join(',');
      };
      panel.querySelectorAll('#recipe-meal-types [data-meal-type]').forEach((chip) => {
        const setPressed = (on) => {
          chip.setAttribute('aria-pressed', String(on));
          chip.classList.toggle('filter-chip--active', on);
        };
        setPressed(selectedMealTypes.includes(chip.dataset.mealType));
        chip.addEventListener('click', () => {
          setPressed(chip.getAttribute('aria-pressed') !== 'true');
          syncTypesValue();
        });
      });
      syncTypesValue();

      const ingList = panel.querySelector('#recipe-ingredient-list');
      if (isEdit && recipe.ingredients?.length) {
        ingList.insertAdjacentHTML('beforeend', recipe.ingredients.map((i) => ingredientRowHTML({
          name: i.name,
          quantity: i.quantity ?? '',
          category: i.category ?? DEFAULT_CATEGORY_NAME,
          categories: mealCategories(),
        })).join(''));
      }

      panel.querySelector('#recipe-add-ingredient')?.addEventListener('click', () => {
        ingList.insertAdjacentHTML('beforeend', ingredientRowHTML({ categories: mealCategories() }));
        if (window.lucide) window.lucide.createIcons({ el: ingList });
      });

      ingList.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="remove-ingredient"]');
        if (!btn) return;
        btn.closest('.ingredient-row')?.remove();
      });

      panel.querySelector('#recipe-cancel')?.addEventListener('click', closeModal);
      panel.querySelector('#recipe-delete')?.addEventListener('click', () => {
        closeModal({ force: true });
        removeRecipe(recipe);
      });
      panel.querySelector('#recipe-save')?.addEventListener('click', () => saveRecipe(panel, mode, recipe));
      // Pflichtfelder melden sich beim Verlassen inline (geteiltes Muster).
      wireBlurValidation(panel);

      if (window.lucide) window.lucide.createIcons({ el: panel });
    },
  });
}

// Reicht `context` durch (#1997): ein Wrapper, der nur `force` weitergibt,
// schloesse nach einer spaeten Antwort wieder den Dialog, der gerade offen ist.
function closeModal({ force = false, context = null } = {}) {
  return closeSharedModal({ force, context });
}

async function saveRecipe(panel, mode, recipe) {
  // Die Rechte koennen sich aendern, waehrend der Dialog offen steht.
  if (readOnly()) return;
  const saveBtn = panel.querySelector('#recipe-save');
  const title = panel.querySelector('#recipe-title')?.value.trim() || '';
  const notes = panel.querySelector('#recipe-notes')?.value.trim() || null;
  const recipe_url = panel.querySelector('#recipe-url')?.value.trim() || null;
  const meal_types = [...panel.querySelectorAll('#recipe-meal-types [aria-pressed="true"]')].map((chip) => chip.dataset.mealType);

  if (!title) {
    // Fehler am Feld statt als ortloser Toast (geteiltes Muster, Critique P1).
    reportFieldError(panel.querySelector('#recipe-title'), t('common.nameRequired'));
    return;
  }

  const ingredients = [];
  panel.querySelectorAll('.ingredient-row').forEach((row) => {
    const name = row.querySelector('.ingredient-row__name')?.value.trim() || '';
    const quantity = row.querySelector('.ingredient-row__qty')?.value.trim() || null;
    const category = row.querySelector('.ingredient-row__cat')?.value || DEFAULT_CATEGORY_NAME;
    if (name) ingredients.push({ name, quantity, category });
  });

  // Nur mitschicken, wenn der Nutzer das Bild angefasst hat: ein fehlendes Feld
  // laesst das gespeicherte stehen (#1059).
  const bildStand = panel._bildStand?.();
  const bildFeld = bildStand === undefined ? {} : { image_data: bildStand };

  saveBtn.disabled = true;
  const dialog = captureModalContext();
  const owner = _container;

  try {
    let createdId = null;
    if (mode === 'create') {
      const res = await api.post('/recipes', { title, notes, recipe_url, meal_types, ingredients, ...bildFeld });
      state.recipes.push(res.data);
      createdId = res.data?.id ?? null;
    } else {
      const res = await api.put(`/recipes/${recipe.id}`, { title, notes, recipe_url, meal_types, ingredients, ...bildFeld });
      const idx = state.recipes.findIndex((r) => r.id === recipe.id);
      if (idx >= 0) state.recipes[idx] = res.data;
    }

    // Nur diesen Dialog: einen inzwischen geoeffneten anderen laesst die
    // spaete Antwort stehen (#1997).
    closeModal({ force: true, context: dialog });
    renderRecipeList({ repaint: true });
    // In der Spalte steht das neue Rezept gleich rechts - wie eine neue Notiz
    // in Notizen. Darunter bleibt die Liste, wie sie war.
    if (createdId != null) selectOwnRecipe(createdId);
    window.yuvomi?.showToast(mode === 'create' ? t('recipes.created') : t('recipes.updated'), 'success');
  } catch (err) {
    saveBtn.disabled = false;
    reportError(err, { owner, dialog, recipeId: mode === 'create' ? null : recipe.id });
  }
}

// --------------------------------------------------------
// Zutaten → Einkaufsliste
// --------------------------------------------------------

/**
 * Übernimmt die Zutaten eines Rezepts auf eine Einkaufsliste. Bei genau einer
 * Liste ohne Rückfrage, sonst über die geteilte Auswahl - dasselbe Muster wie
 * transferMeal() im Essensplan, damit sich der Weg in beiden Modulen gleich
 * anfühlt. Der Server überspringt Zutaten, die schon unabgehakt auf der Liste
 * liegen; die Rückmeldung nennt beide Zahlen.
 */
/**
 * Rezept in den Essensplan übernehmen: fragt „Für wann?" hier und legt die
 * Mahlzeit direkt an.
 *
 * Vorher navigierte dieser Weg auf `/meals?recipe=<id>`, wo ein Formular mit 27
 * Feldern aufging - Titel „Mahlzeit hinzufügen" ohne das Rezept zu nennen, das
 * Datumsfeld leer, 42 % des Dialogs unter der Sichtkante. Nach Escape blieb
 * `?recipe=` in der URL und ein Reload öffnete das Formular erneut, beliebig oft
 * (Critique 2026-07-29). Als einziger der fünf Transfers folgte er nicht dem
 * Muster der anderen.
 *
 * Jetzt zwei Entscheidungen statt neun Feldern, kein Seitenwechsel, und der
 * Query-Parameter existiert nicht mehr - der Zombie ist damit strukturell weg,
 * nicht per `replaceState` kaschiert. Details lassen sich danach im Essensplan
 * bearbeiten, wie bei jeder anderen Mahlzeit.
 */
async function planRecipe(recipe, btn) {
  if (!mayPlanRecipe()) return;
  const declared = normalizeRecipeMealTypes(recipe.meal_types);
  // Erklärt das Rezept keine Mahlzeit, stehen hier trotzdem alle zur Wahl: Der
  // leere Zustand hält es aus der Zufallsauswahl heraus (#750), nicht aus dem
  // Menüplan. Ohne diesen Rückgriff bliebe das Auswahlfeld leer und der Dialog
  // hätte nichts anzubieten, was der Nutzer bestätigen könnte.
  const types = declared.length ? declared : RECIPE_MEAL_TYPE_KEYS.slice();
  // Vorauswahl: erklärt das Rezept genau einen Typ, ist die Sache klar. Erklärt
  // es mehrere - was der Default ist, wenn niemand etwas gesetzt hat -, dann
  // stand bisher „Frühstück" da, weil es in der Liste zuerst kommt: der Dialog
  // schlug für ein Curry das Frühstück vor (Critique 2026-07-30). Ohne Signal
  // vom Rezept ist das Abendessen die ehrlichere Annahme, es ist die Mahlzeit,
  // die Haushalte am häufigsten planen.
  const vorauswahl = types.length === 1 ? types[0] : (types.includes('dinner') ? 'dinner' : types[0]);
  const typeOpts = mealTypeOptions()
    .filter(({ key }) => types.includes(key))
    .map(({ key, label }) =>
      `<option value="${key}"${key === vorauswahl ? ' selected' : ''}>${esc(label)}</option>`)
    .join('');

  const today = todayKey();

  openSharedModal({
    title: t('recipes.planTitle', { name: recipe.title }),
    size: 'sm',
    content: `
      <div class="form-group">
        <label class="form-label" for="plan-date">${t('meals.dateLabel')}</label>
        <yuvomi-datepicker type="date" id="plan-date" value="${esc(formatDateInput(today))}"></yuvomi-datepicker>
      </div>
      <div class="form-group">
        <label class="form-label" for="plan-type">${t('meals.mealTypeLabel')}</label>
        <select class="form-input" id="plan-type">${typeOpts}</select>
      </div>
      <div class="modal-panel__footer modal-panel__footer--plain">
        <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
        <!-- „Übernehmen", nicht die Wiederholung des Auslöser-Labels: die drei
             anderen Transfer-Dialoge bestätigen genauso, und der Dialogtitel
             nennt Rezept und Ziel bereits (Critique 2026-07-30). -->
        <button type="button" class="btn btn--primary" id="plan-confirm">${esc(t('common.apply'))}</button>
      </div>`,
    onSave(panel) {
      panel.querySelector('#plan-confirm').addEventListener('click', async (e) => {
        const confirmBtn = e.currentTarget;
        const dateField = panel.querySelector('#plan-date');
        if (!isDateInputValid(dateField.value)) {
          reportFieldError(dateField, t('calendar.invalidDate'));
          return;
        }
        const date = parseDateInput(dateField.value);
        const mealType = panel.querySelector('#plan-type').value;

        if (!mayPlanRecipe()) return;
        confirmBtn.disabled = true;
        const dialog = captureModalContext();
        const owner = _container;
        try {
          await api.post('/meals', mealPayloadFromRecipe(recipe, date, mealType));
          closeSharedModal({ force: true, context: dialog });
          window.yuvomi?.showToast(
            t('recipes.planSuccess', { name: recipe.title, date: formatDate(date) }),
            'success',
          );
        } catch (err) {
          confirmBtn.disabled = false;
          reportError(err, { owner, dialog, recipeId: recipe.id });
        }
      });
    },
  });

  if (btn) btn.blur();
}

/**
 * Der Knopf „Auf die Einkaufsliste" im Rezeptdetail - oder `null`, wenn er
 * nichts ausloesen koennte: ohne Liste, ohne Zutaten, oder weil der Server ihn
 * abwiese. Das sind ZWEI Riegel (#1290): `/recipes` misst der Pfad-Guard als
 * `meals`, die Route verlangt dazu `shopping`. Mit `shopping: read` laedt
 * `state.lists` trotzdem - die Liste allein ist also keine Erlaubnis.
 */
function shoppingTransferButton(recipe, ingredients) {
  if (!state.lists.length || !ingredients.length) return null;
  if (!mayTransferRecipeToShopping(recipe.id)) return null;
  const btn = document.createElement('button');
  btn.className = 'btn btn--secondary';
  btn.type = 'button';
  btn.dataset.action = 'to-shopping';
  btn.dataset.id = String(recipe.id);
  btn.textContent = t('common.toShoppingList');
  return btn;
}

async function transferRecipe(recipe, btn, { onlyMissing = false } = {}) {
  // Zweite Linie hinter dem Markup (Regel 2 in utils/module-access.js).
  if (!mayTransferRecipeToShopping(recipe.id)) return;
  // "Dopisz N" (Tafla): nur, was der Vorrat nicht zu haben scheint und noch
  // auf keiner Liste steht - der Server nimmt dann nur diese Namen.
  const names = onlyMissing ? missingIngredients(recipe).map((ing) => ing.name) : null;
  if (names && !names.length) return;
  // Vorprüfung, Listenwahl und die Antwort auf „es gibt keine Liste" liegen im
  // geteilten Baustein. Vorher lieh sich diese Stelle `meals.noShoppingLists` -
  // der Text der Rezepte hing damit an einem fremden Modul, und ein Refactor im
  // Essensplan hätte ihn stillschweigend mitgenommen (Audit 2026-07-30, P1-A).
  const target = await resolveShoppingTarget(state.lists);
  if (!target) return;

  if (btn) btn.disabled = true;
  const owner = _container;
  try {
    const res = await api.post(`/recipes/${recipe.id}/to-shopping-list`,
      names ? { listId: target.id, names } : { listId: target.id });
    const added = res.data?.transferred ?? 0;
    const skipped = res.data?.skipped ?? 0;

    // Was jetzt offen auf der Liste steht, zeigt das Detail als "na liście".
    if (added > 0 || skipped > 0) {
      state.onList ??= new Set();
      for (const ing of names ? recipe.ingredients.filter((i) => names.includes(i.name)) : (recipe.ingredients ?? [])) {
        state.onList.add(foldKey(ing.name));
      }
      if (stillShown(owner)) renderIngredientSections(recipe);
    }

    if (added > 0) {
      // t() wählt die _one-Form selbst, sobald count numerisch ist (i18n.js).
      // `list` nennt das Ziel: „5 Zutaten übernommen." sagte nicht, in welche der
      // Listen (Critique 2026-07-30, P1).
      //
      // Rücknahme über den geteilten Baustein: dieser Pfad überträgt am meisten
      // auf einmal - eine ganze Zutatenliste - in eine Liste, die der Nutzer
      // gerade nicht ansieht (Audit 2026-07-30, P1-B).
      announceTransfer({
        message: t('recipes.toShoppingSuccess', { count: added, list: target.name }),
        addedIds: res.data?.added_ids ?? [],
      });
    } else if (skipped > 0) {
      window.yuvomi?.showToast(t('recipes.toShoppingAllPresent'), 'info');
    } else {
      window.yuvomi?.showToast(t('recipes.toShoppingNoIngredients'), 'info');
    }
  } catch (err) {
    reportError(err, { owner, recipeId: recipe.id, listId: target.id });
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function removeRecipe(recipe) {
  // Vor dem Ausblenden der Zeile: sonst verschwaende sie, und das
  // Rueckgaengig-Fenster endete im 403.
  if (readOnly()) return;
  const itemEl = _container.querySelector(`.recipe-row-item[data-id="${recipe.id}"]`);
  if (itemEl) itemEl.style.display = 'none';
  // Auch jedes Neuzeichnen im Ruecknahme-Fenster laesst das Rezept weg.
  _pendingDeleteIds.add(recipe.id);
  // Steht das Rezept rechts in der Detailspalte, geht es dort mit: sonst
  // zeigte die Spalte ein Rezept, das die Liste schon nicht mehr fuehrt.
  // Rueckgaengig waehlt es wieder aus.
  const wasSelected = _md?.selectedId() === String(recipe.id);
  if (wasSelected) {
    _md.clear({ history: 'replace' });
    _container?.querySelector('#recipes-detail')?.focus();
  }

  scheduleUndoableDelete({
    message: t('recipes.deleted'),
    commit: async ({ keepalive }) => {
      try {
        await api.delete(`/recipes/${recipe.id}`, { keepalive });
      } catch (err) {
        _pendingDeleteIds.delete(recipe.id);
        // SCHON GELOESCHT IST EIN ERFOLG (#1909): ein anderes Haushaltsmitglied
        // war schneller. Rezepte haben keine Sichtbarkeit, und ein
        // gespiegeltes Rezept weist DELETE vorher mit 403 ab - die 404 heisst
        // hier also nur "gibt es nicht mehr". Kein Toast, die Zeile kommt
        // nicht zurueck. Alles andere bleibt ein Fehler.
        if (!isAlreadyDeleted(err, 'recipes_recipe_not_found')) throw err;
      }
      _pendingDeleteIds.delete(recipe.id);
      if (keepalive) return; // Seite verschwindet — kein UI-Refresh mehr
      state.recipes = state.recipes.filter((r) => r.id !== recipe.id);
      renderRecipeList();
    },
    restore: (err) => {
      _pendingDeleteIds.delete(recipe.id);
      if (itemEl) itemEl.style.display = '';
      // Wurde die Liste im Fenster neu gebaut, haengt die alte Zeile nicht
      // mehr: dann steht das Rezept erst mit dem naechsten Bau wieder da.
      if (itemEl?.isConnected === false && stillShown(_container)) renderRecipeList();
      if (wasSelected && _md?.isSplit()) _md.select(recipe.id, { history: 'replace' });
      if (err) window.yuvomi?.showToast(errorSentence(err, 'common.unknownError'), 'danger');
    },
  });
}

/**
 * Waehlt in der Spalte ein Rezept aus, das die Seite gerade selbst angelegt
 * hat (Neu, Duplizieren).
 *
 * Ein benanntes Ziel schlaegt einen alten Filter (#936, dort fuer den
 * Deep-Link). Die Kopie eines Mealie-Rezepts ist nativ und faellt aus dem
 * Quellenfilter "Mealie"; ein neues Rezept passt nicht zwingend zur Suche.
 * Unbedingt ausgewaehlt stand rechts ein Rezept ohne Zeile links (Codex an
 * #1477). Also fallen Suche und Filter weg, BEVOR ausgewaehlt wird - und nur
 * dann, wenn das Rezept sonst fehlte: wer unter "Suppe" eine Suppe anlegt,
 * behaelt seine Suche.
 */
function selectOwnRecipe(id) {
  if (!_md?.isSplit()) return;
  if (!filteredRecipes().some((r) => String(r.id) === String(id))) {
    state.query = '';
    state.sourceFilter = 'all';
    _search?.clear();
    renderSourceFilter();
    renderRecipeList();
  }
  _md.select(id);
}

async function duplicateRecipe(recipe) {
  if (readOnly()) return;
  const copySuffix = t('recipes.copySuffix');
  const title = `${recipe.title} (${copySuffix})`;
  const notes = recipe.notes || null;
  const recipe_url = recipe.recipe_url || null;
  const ingredients = (recipe.ingredients || []).map((ing) => ({
    name: ing.name,
    quantity: ing.quantity || null,
    category: ing.category || DEFAULT_CATEGORY_NAME,
  }));

  const owner = _container;
  try {
    const res = await api.post('/recipes', { title, notes, recipe_url, ingredients });
    state.recipes.push(res.data);
    renderRecipeList();
    // Die Kopie ist das, was man als Naechstes bearbeitet: in der Spalte steht
    // sie deshalb gleich rechts.
    if (res.data?.id != null) selectOwnRecipe(res.data.id);
    window.yuvomi?.showToast(t('recipes.duplicated'), 'success');
  } catch (err) {
    reportError(err, { owner });
  }
}

export const __test = {
  // #1290: der Transfer in den Einkauf braucht BEIDE Schreibrechte - Knopf und
  // Handler werden als Programm gefahren (test-kitchen-transfer-ui.js).
  state,
  shoppingTransferButton,
  transferRecipe,
  // R8 H10: Loeschen links im Dialogfuss.
  recipeModalFooterHtml,
  // R16: eigene Rezepte zeigen ihr Bild in Liste und Detail.
  rowShowsThumb, fillRecipeDetail,
  // #1265: Nur-lesen in den Rezepten - Zeile, Detail, Positivliste und jeder
  // Schreibweg als Programm (test-kitchen-readonly-ui.js).
  READ_SAFE_ACTIONS,
  SPLIT_ACTIONS,
  fabEl,
  emptyListOptions,
  buildRecipeList,
  setContainerForTest(container) { _container = container; },
  renderRecipePane,
  onSplitClick,
  openRecipeModal,
  saveRecipe,
  planRecipe,
  removeRecipe,
  duplicateRecipe,
  openPantryMatchModal,
  openPantryBulkMatchModal,
  pantryMatchEl,
  pantryMatchBulkEl,
  // Tafla: Vorrat/Liste je Zutat, die Karten "Gotowane ostatnio", die Chips
  // und die relativen Tage - als Programm gefahren (test-recipes-tafla.js).
  ingredientState,
  pantryTally,
  missingIngredients,
  recentRecipes,
  mealFilterChoices,
  upcomingLabel,
  agoLabel,
  foldKey,
  openRecipeSheet,
};
