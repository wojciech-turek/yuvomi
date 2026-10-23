/**
 * Modul: Vorrat (Pantry)
 * Zweck: Bestand, Lagerort und Mindesthaltbarkeit der Vorräte verwalten (#596)
 * Abhängigkeiten: /api.js
 *
 * Die vierte Seite des Küchen-Kreislaufs: Mahlzeiten planen, Rezepte kochen,
 * Einkauf besorgen - und hier steht, was tatsächlich im Haus ist.
 */

import { api } from '/api.js';
import { t, getNumberFormat, formatDate, getLocale } from '/i18n.js';
import { esc, REQUIRED_MARK } from '/utils/html.js';
import { readRowHtml, readRowHintEl } from '/utils/read-row.js';
import {
  openModal as openSharedModal,
  closeModal as closeSharedModal,
  captureModalContext,
  advancedSection,
  wireBlurValidation,
  reportFieldError,
  refocusAfterRender,
} from '/components/modal.js';
import { renderKitchenTabsBar } from '/utils/kitchen-tabs.js';
import { resolveShoppingTarget, announceTransfer, mayTransferPantryToShopping } from '/utils/kitchen-transfer.js';
import { mayWritePath, pathAccess } from '/utils/module-access.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import { pageToolsMenuHtml, installPopoverMenus } from '/utils/popover-menu.js';
// Alias, weil dieses Modul selbst eine `emptyStateEl()`-Funktion hat, die den
// Renderer mit den Vorrats-Texten füllt.
import { emptyStateEl as emptyStateComponentEl, mountLoadError, searchEmptyEl } from '/utils/empty-state.js';
import { scheduleUndoableDelete, vibrate, wireScrollFade, collapseOut, expandIn } from '/utils/ux.js';
import { redrawList } from '/utils/list-motion.js';
import { wireSwipeRows, maybeShowSwipeHint } from '/utils/swipe-row.js';
import { todayKey } from '/utils/date.js';
import { DEFAULT_CATEGORY_NAME, categoryLabel } from '/utils/shopping-categories.js';
import { locationLabel } from '/utils/pantry-locations.js';
import { setBulkPill, clearBulkPill } from '/utils/bulk-pill.js';
import { PANTRY_UNITS, normalizePantryQuantity, pantryUnitStep, pantryQuantityLabel } from '/utils/pantry-units.js';
import { photoToJpegDataUrl } from '/utils/photo-resize.js';
import {
  daysUntil,
  matchesPantryFilter,
  pantryExpiryPhrase,
  pantryFilterCounts,
  pantryFilterFromSearch,
  pantryItemStatus,
} from '/utils/pantry-status.js';

let _container = null;
/** Handle des geteilten Suchfelds (setValue/clear), gesetzt in render(). */
let _search = null;
/** Die Kamera-Karte samt Dateiwaehler - ein Knoten, der jeden Neuaufbau ueberlebt. */
let _photoSlot = null;

const state = {
  items: [],
  locations: [],
  categories: [],
  /** Einkaufslisten - erst beim ersten „Auf die Einkaufsliste" nachgeladen. */
  lists: null,
  query: '',
  filter: 'all',
  /** Tafla: welcher Ort gezeigt wird - 'all', eine Lagerort-id oder 'none'. */
  place: 'all',
  /** Tafla: die eine aufgeklappte Zeile (Stepper, Na liste, Bearbeiten). */
  expanded: null,
  /** Namen (klein) der offenen Einkaufsartikel - fuer "schon auf der Liste".
   *  null, solange unbekannt oder ohne Leserecht auf den Einkauf. */
  onList: null,
  /** Einmal pro Render eingefroren: sonst könnte ein über Mitternacht offener
   *  Tab Zeilen unterschiedlich bewerten, je nachdem wann sie gezeichnet wurden. */
  todayKey: todayKey(),
};

/**
 * DIE ABSICHT, NICHT DER STAND - dieselbe Trennung wie im Einkauf.
 *
 * `state.items` traegt ausschliesslich, was der Server zuletzt gesagt hat. Was
 * der Nutzer WILL, steht hier: id -> { quantity, seq, timer, flush }. Die Zeile
 * zeigt die Ueberlagerung (`withIntent`).
 *
 * Der Vorlaeufer vermischte beides in `item.quantity`. Dann braucht ein
 * Fehlschlag eine Ruecksprung-Grundlage, und die wurde ueber vier
 * Review-Runden hinweg immer wieder falsch: mal vom alten Schnappschuss
 * ueberschrieben, mal am bestaetigten Wert vorbei, mal aus dem Offline-Cache.
 * Getrennt gehalten gibt es sie nicht mehr - ein Ruecksprung ist das ENTFERNEN
 * der Absicht.
 *
 * Drei Regeln:
 *   - Ein Schritt setzt die Absicht (entprellt, deshalb Timer und `flush`).
 *   - Scheitert der Schreibvorgang, faellt sie.
 *   - Bestaetigt der Server, wandert der Wert in den Serverstand und die
 *     Absicht faellt - geschuetzt von `settledAt`, damit eine Antwort, die
 *     vorher losgeschickt wurde, ihn nicht zurueckdreht.
 */
const intents = new Map();
let QUANTITY_DEBOUNCE_MS_OVERRIDE = null; // nur fuer Tests, siehe __test unten
const QUANTITY_DEBOUNCE_MS = 450;
/** Monotone Folgenummer, die überholte PATCH-Antworten erkennbar macht. */
let _quantitySeq = 0;
/** Monotone Nummer je Ladevorgang, und wann ein Artikel zuletzt bestaetigt wurde. */
let _pantryLoadSeq = 0;
let _pantryAppliedLoad = 0;
const settledAt = new Map();

/** Die Menge, die die Zeile ZEIGT: die Absicht, sonst der Serverstand. */
function quantityOf(item) {
  const intent = intents.get(item?.id);
  return intent ? intent.quantity : Number(item?.quantity ?? 0);
}

/**
 * Der Artikel, wie ihn die Zeile zeigt.
 *
 * Als Kopie statt als Einzelwert, weil die Menge in abgeleitete Angaben
 * einfliesst - Badges, Bestandsstatus, Fehlmenge. So bleiben `quantityText`,
 * `pantryItemStatus` und `shortfallText` unveraendert und bekommen einfach den
 * ueberlagerten Artikel.
 */
function withIntent(item) {
  const intent = intents.get(item?.id);
  return intent ? { ...item, quantity: intent.quantity } : item;
}

// --------------------------------------------------------
// Formatierung
// --------------------------------------------------------

/**
 * Menge ohne überflüssige Nachkommastellen: 2 bleibt "2", 2,5 wird lokalisiert.
 * getNumberFormat() formatiert in der Format-Locale der Region - die
 * Zahlenformat-Präferenz ist von der UI-Sprache entkoppelt (#521).
 */
function formatQuantity(value) {
  return getNumberFormat({ maximumFractionDigits: 2 }).format(Number(value) || 0);
}

/**
 * Einheit übersetzen, mit Rückfall auf den Rohwert. Alle Schreibpfade der App
 * normalisieren über normalizePantryUnit() auf die zehn kanonischen Einheiten,
 * ein unbekannter Wert ist also nicht über die Oberfläche erreichbar - wohl
 * aber über einen direkten Datenbankzugriff, einen Fremdimport oder eine
 * künftige Einheit, deren Locale-Key noch fehlt. Ohne diesen Rückfall stünde
 * dann der nackte Schlüssel in der Zeile („1 pantry.units.Stk"), und zwar an
 * der Stelle, an der die Menge steht. Der Rohwert ist immer noch lesbar.
 */
function unitLabel(unit) {
  const key = `pantry.units.${unit}`;
  const label = t(key);
  return label === key ? String(unit ?? '') : label;
}

/** „6 Dosen", nicht „6 Dose": die Einheit flektiert mit der Menge (W2). */
function quantityText(item) {
  return pantryQuantityLabel(item.quantity, item.unit, { t, formatNumber: formatQuantity });
}

/**
 * Ablauf-Badge als { text, tone } oder null. Bewusst nur für abgelaufen/bald:
 * ein Badge auf jeder Zeile wäre Ornament und würde genau die Zeilen entwerten,
 * die wirklich Aufmerksamkeit brauchen.
 */
function expiryBadge(item) {
  const { expiry } = pantryItemStatus(item, state.todayKey);
  if (!expiry) return null;

  // Der Satz kommt aus pantryExpiryPhrase(), den auch die Dashboard-Kachel
  // „Läuft bald ab" spricht - dieselbe Charge heisst an beiden Orten gleich.
  const phrase = pantryExpiryPhrase(daysUntil(item.expires_on, state.todayKey));
  return {
    tone: expiry === 'expired' ? 'danger' : 'warning',
    text: phrase.count === undefined ? t(phrase.key) : t(phrase.key, { count: phrase.count }),
  };
}

/**
 * Tafla: ab hier gilt ein Termin als "mija" - drei Tage, wie die Statusregel
 * im Spec ("expires within 3 days"). `soon` in pantry-status.js bleibt bei
 * sieben Tagen: das ist die Frage der Dashboard-Kachel und des Desktop-Panels.
 */
const ATTENTION_DAYS = 3;

/** "dziś" / "jutro" / "za 2 dni" - das Wort fuer einen Termin in `days` Tagen. */
function expiryWord(days) {
  if (days === 0) return t('pantry.pillToday');
  if (days === 1) return t('pantry.pillTomorrow');
  return t('pantry.pillInDays', { count: days });
}

/**
 * DAS EINE STATUSWORT DER ZEILE (Tafla, "Status pill"): als Wort in einer
 * getoenten Pille und nur, wenn es etwas zu tun gibt. Abgelaufen ist das
 * einzige Rot der Seite; leer, bald faellig und knapp sind Amber. Steht beides
 * an (knapp UND bald faellig), gewinnt die Frist - sie wartet nicht.
 * @returns {{ tone: 'danger'|'warning', text: string } | null}
 */
function statusPill(item) {
  const status = pantryItemStatus(item, state.todayKey);
  const days = item.expires_on ? daysUntil(item.expires_on, state.todayKey) : null;
  if (days != null && days < 0) return { tone: 'danger', text: t('pantry.pillExpired') };
  if (days != null && days <= ATTENTION_DAYS) return { tone: 'warning', text: expiryWord(days) };
  if (status.out) return { tone: 'warning', text: t('pantry.pillOut') };
  if (status.low) return { tone: 'warning', text: t('pantry.pillLow') };
  return null;
}

/** Faellt der Artikel in "Termin mija" (abgelaufen oder in hoechstens drei Tagen)? */
function expiresSoon(item) {
  if (!item.expires_on) return false;
  return daysUntil(item.expires_on, state.todayKey) <= ATTENTION_DAYS;
}

/** Das Zeichen der Zeile: das Icon der Einkaufskategorie (Nabial -> milk). */
function categoryIcon(item) {
  return state.categories.find((c) => c.name === item.category)?.icon || 'package';
}

/** "Mleko i jajka" - die Namen als Aufzaehlung der Oberflaechensprache. */
function joinNames(names) {
  try {
    return new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(names);
  } catch {
    return names.join(', ');
  }
}

// --------------------------------------------------------
// Laden
// --------------------------------------------------------


async function loadPantry() {
  const startedAt = ++_pantryLoadSeq;
  const res = await api.get('/pantry');
  // Wer aelter ist als das, was schon steht, fasst den Stand nicht mehr an.
  if (startedAt < _pantryAppliedLoad) return;
  _pantryAppliedLoad = startedAt;
  // Anders als der Einkauf liest der Vorrat mit `api.get`: `/pantry` steht
  // NICHT in `API_CACHE_WHITELIST` (sw.js), es gibt hier also keine Antwort aus
  // dem Cache. Haelt der Guard in `test-frontend-audit.js` fest.

  // EIN BESTAETIGTER ARTIKEL WIRD VON EINER AELTEREN ANTWORT NICHT
  // ZURUECKGEDREHT - alles andere an ihr wird gebraucht und landet.
  const vorherige = new Map(state.items.map((i) => [i.id, i]));
  const frisch = res.data ?? [];
  for (const item of frisch) {
    const bestaetigt = settledAt.get(item.id);
    if (bestaetigt != null && bestaetigt >= startedAt) {
      const alt = vorherige.get(item.id);
      if (alt) item.quantity = alt.quantity;
    }
  }
  state.items = frisch;
  state.locations = res.locations ?? [];
  state.categories = res.categories ?? [];
}

/** Einkaufslisten nachladen (erst wenn eine Übergabe ansteht). */
async function ensureLists() {
  if (state.lists) return state.lists;
  const res = await api.get('/shopping');
  state.lists = res.data ?? [];
  return state.lists;
}

// --------------------------------------------------------
// Auswahl / Gruppierung
// --------------------------------------------------------

function visibleItems() {
  const q = state.query.toLowerCase();
  // Gefiltert wird nach dem, was die Zeile ZEIGT - sonst faellt ein Artikel aus
  // „Fast leer", waehrend die Zeile ihn noch dort zeigt.
  return state.items.map(withIntent).filter((item) => {
    if (!matchesPantryFilter(item, state.filter, state.todayKey)) return false;
    if (!inPlace(item)) return false;
    if (!q) return true;
    return item.name?.toLowerCase().includes(q)
      || item.notes?.toLowerCase().includes(q)
      || (item.location_name && locationLabel(item.location_name).toLowerCase().includes(q));
  });
}

/** Liegt der Artikel am gewaehlten Ort der Ortsreihe? */
function inPlace(item) {
  if (state.place === 'all') return true;
  if (state.place === 'none') return item.location_id == null;
  return item.location_id === state.place;
}

/**
 * Ohne Filter nach Lagerort gruppiert („wo liegt was?"). Sobald ein Filter
 * aktiv ist, ist der Ort nicht mehr die Frage - dann ist eine flache, nach
 * Dringlichkeit sortierte Liste die ehrlichere Antwort. Der Ort wandert in
 * die Meta-Zeile und geht dabei nicht verloren.
 */
function groupedItems(items) {
  if (state.filter !== 'all') {
    const flat = [...items];
    if (state.filter === 'expired' || state.filter === 'soon') {
      flat.sort((a, b) => String(a.expires_on).localeCompare(String(b.expires_on)));
    } else {
      flat.sort((a, b) => Number(a.quantity) - Number(b.quantity));
    }
    return [{ key: 'flat', label: null, items: flat }];
  }

  const byLocation = new Map();
  for (const item of items) {
    const key = item.location_id ?? 'none';
    if (!byLocation.has(key)) byLocation.set(key, []);
    byLocation.get(key).push(item);
  }

  const groups = [];
  for (const loc of state.locations) {
    const rows = byLocation.get(loc.id);
    if (rows?.length) groups.push({ key: loc.id, label: locationLabel(loc.name), icon: loc.icon, items: rows });
  }
  const orphans = byLocation.get('none');
  if (orphans?.length) {
    groups.push({ key: 'none', label: t('pantry.unlocated'), icon: 'package', items: orphans });
  }
  return groups;
}

// --------------------------------------------------------
// Render
// --------------------------------------------------------

export async function render(container) {
  _container = container;
  state.todayKey = todayKey();
  // Frische Seite: die Chip-Leiste darf beim ersten Zeichnen wieder scrollen.
  _scrolledFilter = null;
  state.expanded = null;
  // Deep-Link der Dashboard-Kachel „Läuft bald ab" (`?filter=expired|soon`).
  // Trifft der Chip gerade nichts, setzt die Chip-Leiste ohnehin auf „Alle"
  // zurück - ein veralteter Link endet nie in einer leeren Liste.
  const linkedFilter = pantryFilterFromSearch(window.location.search);
  if (linkedFilter) state.filter = linkedFilter;

  const page = document.createElement('div');
  page.className = 'pantry-page app-page app-page--reading page-measure--narrow';
  page.dataset.composition = 'reading';

  // sr-only: die Küchen-Tab-Leiste benennt das Modul bereits sichtbar -
  // dieselbe Kopf-Grammatik wie Mahlzeiten/Rezepte/Einkauf.
  const title = document.createElement('h1');
  title.className = 'sr-only';
  title.textContent = t('nav.pantry');

  // Eine geteilte Live-Region für die ganze Seite statt einer je Zeile.
  const live = document.createElement('div');
  live.id = 'pantry-live';
  live.className = 'sr-only';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');

  // Kanonischer Kopf, Gruppen-Variante (siehe .page-toolbar--in-group in
  // layout.css): Suche im __center-Slot, Lagerort-Verwaltung im __actions-Slot.
  // TAFLA: am Telefon steht der Kopf nur, solange gesucht wird - der Einstieg
  // ist die Lupe vorn in der Ortsreihe (pantry.css, `.pantry-page--searching`).
  // Am Zeiger bleibt das Feld stehen wie bisher.
  const toolbar = document.createElement('div');
  // Kein --narrow (Re-Critique 2026-09-27, D3): der Kuechenkopf gehoert der
  // Kuechen-Leiste und endet an ihrer Kante wie in den drei Geschwister-Tabs.
  toolbar.className = 'page-toolbar page-toolbar--in-group pantry-toolbar';
  // Die Suche IST der Center-Slot (Re-Critique 2026-09-27, D4): Breite und
  // Stelle traegt page-search.css, wie in Dokumenten - kein Wrapper.
  toolbar.insertAdjacentHTML('beforeend', `
    ${renderPageSearch({
      id: 'pantry-search',
      label: t('pantry.searchPlaceholder'),
      placeholder: t('pantry.searchPlaceholder'),
      value: state.query,
      clearLabel: t('common.searchClear'),
      // Ein Feld, keine Lupe: am Telefon oeffnet die Lupe der Ortsreihe genau
      // diese Zeile, und dann soll getippt werden koennen.
      className: 'pantry-search page-toolbar__center page-search--field',
    })}
    ${readOnly() ? '' : `<div class="page-toolbar__actions">
      ${pageToolsMenuHtml({
        id: 'pantry-tools-menu',
        label: t('common.moreActions'),
        // KUECHENKOPF: die Verwaltung steht im EINEN Werkzeugmenue; mit einem
        // einzigen Eintrag wird daraus der direkte Knopf (pageToolsMenuHtml).
        // Regel 7 in utils/module-access.js: der AUFRUFER nimmt den Ausloeser
        // weg. Bei `pantry: read` endete jede Handlung im Verwalter im 403.
        items: [{ action: 'manage-locations', label: t('pantry.manageLocations'), icon: 'map-pin' }],
      })}
    </div>`}`);

  // DIE ORTSREIHE STEHT IM SCROLLPORT (Kopfregel mobil, Regel 3): als erstes
  // Kind von #pantry-list scrollt sie mit der Liste weg. renderList() ersetzt
  // nur, was HINTER ihr steht.
  const filters = document.createElement('div');
  filters.className = 'page-chip-row pantry-filters';
  filters.id = 'pantry-filters';
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', t('pantry.placesLabel'));
  filters.hidden = true;

  const list = document.createElement('div');
  list.className = 'list-scroller page-scrollport pantry-list';
  list.id = 'pantry-list';
  list.setAttribute('aria-busy', 'true');
  list.append(filters);
  list.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 6, lines: 2 }));

  // "Dodaj ze zdjęcia" (Tafla: Kamera-Karte statt Kopf-Knopf). Ein Knoten fuer
  // die ganze Seite: drawList() haengt ihn bei jedem Neuaufbau wieder ein, damit
  // der Dateiwaehler, den wirePhotoButton() daneben legt, verdrahtet bleibt.
  // Nur mit Schreibrecht - ein Foto legt Vorratsartikel an.
  _photoSlot = readOnly() ? null : photoCardEl();

  const fab = document.createElement('button');
  fab.className = 'page-fab';
  fab.type = 'button';
  fab.id = 'fab-new-pantry-item';
  fab.setAttribute('aria-label', t('pantry.addItem'));
  fab.dataset.dockLabel = t('newLabel.pantry');
  fab.insertAdjacentHTML('beforeend', '<i data-lucide="plus" aria-hidden="true"></i>');

  // DAS NEBENPANEL „IM BLICK" (Re-Critique 2026-09-27, A4 P1 / R10 L4): am
  // Desktop steht neben der Liste fest, was bald ablaeuft. Unter der Schwelle
  // blendet CSS es aus; dort traegt die Karte "Wymaga uwagi" die Frage.
  const body = document.createElement('div');
  body.className = 'pantry-body';
  const watch = document.createElement('aside');
  watch.className = 'pantry-watch';
  watch.id = 'pantry-watch';
  watch.setAttribute('aria-label', t('pantry.watchLabel'));
  watch.hidden = true;
  body.append(list, watch);

  page.append(title, live, toolbar, body, fab);
  container.replaceChildren(page);
  renderKitchenTabsBar(container, '/pantry');

  if (window.lucide) window.lucide.createIcons({ el: container });

  // Geteilter Baustein statt eigenem Input (utils/page-search.js).
  _search = wirePageSearch(toolbar, {
    id: 'pantry-search',
    onQuery: (value) => {
      state.query = value.trim();
      page.classList.toggle('pantry-page--searching', Boolean(state.query) || page.contains(document.activeElement));
      renderList();
    },
  });
  wireSearchToggle(page, toolbar);

  installPopoverMenus(toolbar);
  toolbar.querySelector('[data-action="manage-locations"]')?.addEventListener('click', openLocationManager);
  if (_photoSlot) wirePhotoButton(_photoSlot.querySelector('#pantry-photo-btn'));
  fab.addEventListener('click', () => openItemModal('create'));

  filters.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="search"]')) { openSearch(); return; }
    const chip = e.target.closest('[data-place], [data-filter]');
    if (!chip) return;
    // Ein Statusfilter (Deep-Link) steht als gewaehlte Chip vorn; ein Tipp
    // hebt ihn auf. Ein Ort waehlt den Ort.
    if (chip.dataset.filter) state.filter = 'all';
    else state.place = chip.dataset.place === 'all' || chip.dataset.place === 'none'
      ? chip.dataset.place
      : Number(chip.dataset.place);
    state.expanded = null;
    renderFilters();
    renderList();
  });

  list.addEventListener('click', onListClick);
  wireLongPress(list);
  watch.addEventListener('click', onWatchClick);

  try {
    await loadPantry();
  } catch (err) {
    renderLoadError(list, err);
    return;
  }

  renderFilters();
  renderList();
  refreshOnList();
}

/** Die Lupe der Ortsreihe: oeffnet den Suchkopf und setzt den Cursor hinein. */
function openSearch() {
  const page = _container?.querySelector('.pantry-page');
  if (!page) return;
  page.classList.add('pantry-page--searching');
  _search?.input.focus();
}

/**
 * Der Suchkopf geht am Telefon wieder zu, sobald er leer den Fokus verliert;
 * Esc leert ihn und gibt den Fokus an die Lupe zurueck.
 */
function wireSearchToggle(page, toolbar) {
  const input = _search?.input;
  if (!input) return;
  input.addEventListener('blur', () => {
    // Der Leeren-Knopf liegt im selben Kopf: ein Tipp darauf ist kein Verlassen.
    setTimeout(() => {
      if (!state.query && !toolbar.contains(document.activeElement)) page.classList.remove('pantry-page--searching');
    }, 0);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || (!input.value && !page.classList.contains('pantry-page--searching'))) return;
    _search.clear();
    state.query = '';
    page.classList.remove('pantry-page--searching');
    renderList();
    _container?.querySelector('.pantry-search-toggle')?.focus();
  });
}

/**
 * Der Vorrat war der einzige Tab mit einem echten Fehlerzustand - und zeigte
 * als Erklärung `[object Object]`, weil die Beschreibung den rohen Servertext
 * durchreichte (Critique P0, 2026-07-30). `mountLoadError()` nimmt jetzt das
 * Fehlerobjekt selbst entgegen und liest daraus nur den Statuscode.
 */
function renderLoadError(list, err) {
  list.removeAttribute('aria-busy');
  mountLoadError(list, {
    title: t('pantry.loadErrorTitle'),
    description: t('common.loadErrorDescription'),
    error: err,
    retryLabel: t('common.retry'),
    onRetry: () => render(_container),
  });
}

/**
 * Die Ortsreihe (Tafla). Ein Ort ohne Artikel bekommt keine Chip: eine Chip,
 * die garantiert auf eine leere Liste führt, ist eine Sackgasse.
 */
/**
 * Zuletzt ins Sichtfeld geholter Filter. Ohne dieses Gedächtnis rief jeder
 * Re-Render `scrollIntoView` auf - und weil `adjustQuantity` die Leiste bei
 * jedem ±-Tap neu zeichnet, riss ein einziger Tap die manuell zurückgescrollte
 * Leiste wieder weg und schob den „Alle"-Ausgang aus dem Bild (Critique P1).
 */
let _scrolledFilter = null;

/**
 * @returns {{ wasReset: boolean }} `wasReset` ist true, wenn der aktive Filter
 * seinen letzten Treffer verloren hat und automatisch auf „Alle" zurückfiel -
 * dann muss der Aufrufer auch die Liste neu zeichnen, sonst zeigen die Chips
 * „Alle" und die Liste weiter die alte gefilterte Teilmenge.
 */
function renderFilters() {
  const bar = _container?.querySelector('#pantry-filters');
  if (!bar) return { wasReset: false };

  // Kanten-Anriss der Chip-Leiste: sie scrollt horizontal und blendet ihre
  // Scrollbar aus. wireScrollFade setzt die geteilten has-fade-*-Klassen aus
  // filter-chip.css. Einmal binden; der MutationObserver deckt die Rerenders.
  if (!bar.dataset.fadeWired) {
    bar.dataset.fadeWired = 'true';
    wireScrollFade(bar);
  }

  const items = state.items.map(withIntent);
  const counts = pantryFilterCounts(items, state.todayKey);

  // Der aktive Statusfilter (Deep-Link) hat seinen letzten Treffer verloren → zurück auf Alle.
  const previous = `${state.filter}:${state.place}`;
  if (state.filter !== 'all' && !(counts[state.filter] > 0)) state.filter = 'all';

  // TAFLA: die Reihe waehlt den ORT ("Wszystko · Lodówka 9 · Zamrażarka 2").
  // Die drei Statusfragen (abgelaufen, bald, knapp) beantwortet jetzt die Karte
  // "Wymaga uwagi" oben in der Liste, ohne dass man sie stellen muss. Ein Ort
  // ohne Artikel bekommt keine Chip - sie fuehrte garantiert ins Leere.
  const byPlace = new Map();
  for (const item of items) {
    const key = item.location_id ?? 'none';
    byPlace.set(key, (byPlace.get(key) ?? 0) + 1);
  }
  const places = state.locations
    .filter((loc) => byPlace.get(loc.id))
    .map((loc) => ({ id: String(loc.id), label: locationLabel(loc.name), count: byPlace.get(loc.id) }));
  if (byPlace.get('none')) places.push({ id: 'none', label: t('pantry.unlocated'), count: byPlace.get('none') });

  // Der gewaehlte Ort hat seinen letzten Artikel verloren → zurück auf Wszystko.
  if (state.place !== 'all' && !places.some((p) => p.id === String(state.place))) state.place = 'all';
  const wasReset = `${state.filter}:${state.place}` !== previous;

  // replaceChildren zerstört den fokussierten Chip; ohne Rettung landet der
  // Tastatur-Fokus auf <body> und der Tab-Weg beginnt wieder ganz oben.
  const hadFocus = bar.contains(document.activeElement);

  bar.replaceChildren();
  if (!state.items.length) {
    bar.hidden = true;
    return { wasReset };
  }
  bar.hidden = false;

  const chipHtml = ({ attr, value, label, count, active }) => `
    <button type="button" class="filter-chip filter-chip--sm${active ? ' filter-chip--active' : ''}"
            ${attr}="${esc(value)}" aria-pressed="${active}">
      ${active ? '<i data-lucide="check" class="icon-sm" aria-hidden="true"></i>' : ''}
      <span>${esc(label)}</span>
      ${count != null ? `<span class="filter-chip__count">${count}</span>` : ''}
    </button>`;

  const statusLabels = { expired: 'pantry.filterExpired', soon: 'pantry.filterSoon', low: 'pantry.filterLow' };
  const chips = [];
  // Ein Statusfilter steht nur, wenn ein Link ihn gesetzt hat: gewaehlt, vorn,
  // und ein Tipp hebt ihn auf.
  if (state.filter !== 'all') {
    chips.push(chipHtml({ attr: 'data-filter', value: state.filter, label: t(statusLabels[state.filter]), count: counts[state.filter], active: true }));
  }
  chips.push(chipHtml({ attr: 'data-place', value: 'all', label: t('pantry.placeAll'), count: null, active: state.place === 'all' && state.filter === 'all' }));
  for (const place of places) {
    chips.push(chipHtml({ attr: 'data-place', value: place.id, label: place.label, count: place.count, active: String(state.place) === place.id }));
  }

  // Die Lupe steht VORN: hinten laege sie bei vier Orten hinter dem Rand der
  // waagrecht scrollenden Reihe. Am Zeiger steht das Suchfeld im Kopf, dort
  // blendet pantry.css sie aus.
  bar.insertAdjacentHTML('beforeend', `
    <button type="button" class="pantry-search-toggle" data-action="search"
            aria-label="${esc(t('pantry.searchPlaceholder'))}">
      <i data-lucide="search" class="icon-md" aria-hidden="true"></i>
    </button>
    ${chips.join('')}`);

  if (window.lucide) window.lucide.createIcons({ el: bar });

  const activeChip = bar.querySelector('.filter-chip--active');
  if (hadFocus) activeChip?.focus({ preventScroll: true });

  // Ein gewaehlter Ort ausserhalb des Sichtfelds nimmt der Liste ihre
  // Erklaerung ("warum sehe ich nur drei Artikel?"). Aber NUR beim echten
  // Wechsel - sonst kaempft jeder Schritt gegen die Scrollposition.
  const selection = `${state.filter}:${state.place}`;
  if (_scrolledFilter !== selection) {
    if (state.place !== 'all' || state.filter !== 'all') activeChip?.scrollIntoView({ inline: 'center', block: 'nearest' });
    _scrolledFilter = selection;
  }

  return { wasReset };
}

/**
 * Sammelaktion des „Fast leer"-Filters, seit Etappe 5 als Pille in der unteren
 * Shell-Zone (utils/bulk-pill.js) statt als Block über der Liste. Sie lag davor
 * schon zweimal falsch: zuerst als letztes Element der Chip-Leiste (hinter dem
 * horizontalen Scroll, faktisch unsichtbar), dann als eigene Zeile darüber, die
 * dem Einkauf gemessene 103px Listenfläche kostete.
 *
 * DAS LABEL IST DIE ZAHL, NICHT DIE ERKLÄRUNG. Es stand hier „Diese Artikel
 * sind aufgebraucht oder unter dem Mindestbestand." - ein Satz, den der aktive
 * Filterchip („Fast leer") daneben schon sagt, und der auf einer einzeiligen
 * Fläche nichts als eine Ellipse hinterlässt. Was die Pille beitragen muss,
 * ist der Umfang von „Alles": worauf der Knopf wirkt. Dieselbe Antwort gibt der
 * Einkauf mit „3 Artikel abgehakt".
 *
 * UND BEI 320px IST GENAU DIESER UMFANG WEG (Etappe 7, 2026-08-13). Dort fällt
 * das Subjekt weg - gemessen verlangt „10 Artikel fast leer" 116,2px, frei
 * bleiben neben der Kapsel 86,9 von 264px Innenbreite. Übrig steht dann „Alles
 * auf die Einkaufsliste" allein auf einer dunklen Fläche: ein Quantor ohne
 * Bezugswort, lesbar als „der ganze Vorrat" statt als die zehn Artikel des
 * aktiven Filters.
 *
 * DIE GEFAHR IST EINE ANDERE ALS IM EINKAUF, DIE LÜCKE DIESELBE. Dort trägt die
 * Löschen-Kapsel die Marke, weil ein fehlendes Objekt vor einer nicht
 * rückfragenden Löschung teuer ist; hier ist die Aktion harmlos und trotzdem
 * mehrdeutig - „In den Vorrat" wäre es nicht, „Alles" ist es. Gemessen misst
 * die Kapsel mit Marke rund 194 von 264px, die Pille bleibt einzeilig.
 *
 * Die Zahl ist dieselbe, die das Subjekt nennt: `visibleItems()` ist der
 * gefilterte UND gesuchte Satz, und `sendToShopping` bekommt genau ihn.
 */
function renderBulkBar() {
  const items = visibleItems();
  // Die Pille traegt genau EINE Aktion, und die schreibt in den EINKAUF
  // (#1265): ohne Schreibrecht dort endete sie im 403 - also keine Pille.
  if (state.filter !== 'low' || !state.items.length || !items.length || !mayTransferPantryToShopping()) {
    clearBulkPill();
    return;
  }
  setBulkPill({
    label: t('pantry.bulkPillLabel', { count: items.length }),
    actions: [{
      label: t('pantry.toShoppingAll'),
      count: items.length,
      onClick: (btn) => sendToShopping(visibleItems(), btn),
    }],
  });
}

/**
 * Darf dieses Konto in den Vorrat schreiben? Regel 1 in utils/module-access.js.
 * Als Funktion, damit jedes Neuzeichnen neu fragt.
 *
 * WAS BEI `read` BLEIBT: Suche, Filterchips, das Nebenpanel, die Zeile mit
 * Menge, MHD und Badges als ZEICHEN - und der Tipp auf sie, der dann die
 * Leseansicht oeffnet (Regel 9). WAS GEHT: der Stepper, der Bearbeiten-Dialog
 * samt Loeschen, das Anlegen (FAB und Leerzustand), die Lagerort-Verwaltung und
 * der Loesch-Wisch (Regel 3). DER WARENKORB FOLGT NICHT DIESEM RECHT: er
 * schreibt in den Einkauf und fragt `mayTransferPantryToShopping()` (Regel 8) -
 * mit `pantry: read` und `shopping: write` bleibt er also stehen, und der
 * Server nimmt den Uebertrag an.
 *
 * KEIN WANDTABLETT: ein Display fuehrt `pantry` nicht in seiner Scope-Liste
 * (server/display-scopes.js) und erreicht diese Seite nicht; ein
 * `actingAsDisplay()` davor braucht es hier nicht.
 */
function readOnly() {
  return !mayWritePath('/pantry');
}

/**
 * Die `data-action`s der Liste, die NICHT in den Vorrat schreiben - eine
 * Positivliste wie in shopping.js: eine morgen ergaenzte Schreib-Aktion ist bei
 * `read` zu, bis sie hier ausdruecklich steht. `to-shopping` schreibt in den
 * Einkauf und traegt seinen eigenen Riegel (`sendToShopping`).
 */
const READ_SAFE_ACTIONS = new Set(['details', 'to-shopping']);

const PANTRY_ROW = '.pantry-swipe[data-swipe-id]';

/* `motion: true` setzt, wer die DATEN geaendert hat (Artikel angelegt,
 * gespeichert, geloescht): dann zieht die neue Zeile auf, und was dadurch die
 * Stelle wechselt, gleitet (utils/list-motion.js). Filter und Suche zeichnen
 * ohne Bewegung neu - dort wechselt die Frage, nicht die Liste, und jede
 * hinzukommende Zeile einzeln aufzuziehen waere Unruhe. */
function renderList({ motion = false } = {}) {
  const list = _container?.querySelector('#pantry-list');
  if (!list) return;
  if (motion) redrawList(list, () => drawList(list), { selector: PANTRY_ROW, keyAttr: 'data-swipe-id' });
  else drawList(list);
}

function drawList(list) {
  list.removeAttribute('aria-busy');
  // Die Chipreihe ist das erste Kind des Ports und ueberlebt den Neuaufbau.
  const chipRow = list.querySelector(':scope > #pantry-filters');
  list.replaceChildren(...(chipRow ? [chipRow] : []));
  renderBulkBar();
  renderWatch();

  if (!state.items.length) {
    list.appendChild(emptyStateEl());
    // Die eine Ausnahme der Tafla-Leerzustaende: der Vorrat behaelt seinen
    // Kamera-Einstieg - ein Foto vom Regal ist der schnellste erste Bestand.
    if (_photoSlot) list.appendChild(_photoSlot);
    if (window.lucide) window.lucide.createIcons({ el: list });
    return;
  }

  const items = visibleItems();
  // Filtern und Suchen ändern die Liste, ohne dass sich der Fokus bewegt -
  // ohne Ansage bleibt die neue Trefferzahl für Screenreader unsichtbar.
  if (state.filter !== 'all' || state.query || state.place !== 'all') {
    announce(t('pantry.resultCount', { count: items.length }));
  }

  if (!items.length) {
    list.appendChild(noResultsEl());
    if (window.lucide) window.lucide.createIcons({ el: list });
    return;
  }

  // TAFLA: oben, was Aufmerksamkeit braucht, dann der Kamera-Einstieg, dann die
  // Orte. Beides nur in der ungefilterten Ansicht - wer sucht oder einen Ort
  // gewaehlt hat, fragt etwas anderes.
  const overview = !state.query && state.filter === 'all' && state.place === 'all';
  if (overview) {
    const attention = attentionEl();
    if (attention) list.appendChild(attention);
    if (_photoSlot) list.appendChild(_photoSlot);
  }

  for (const group of groupedItems(items)) {
    const section = document.createElement('section');
    // Geteilte Gruppen-Grammatik (styles/list-row.css): die Gruppe trägt die
    // weiße Fläche, die Zeilen darin nur Trennlinien.
    section.className = 'list-group pantry-group';

    if (group.label) {
      // Tafla-Gruppenkopf: Name 17/600 und Zahl, Satzschreibung, kein Icon.
      const heading = document.createElement('h2');
      heading.className = 'list-group__title';
      const name = document.createElement('span');
      name.textContent = group.label;
      const count = document.createElement('span');
      count.className = 'list-group__count';
      count.textContent = String(group.items.length);
      heading.append(name, count);
      section.appendChild(heading);
    }

    const rows = document.createElement('ul');
    rows.className = 'row-carrier pantry-rows';
    for (const item of group.items) rows.appendChild(rowEl(withIntent(item)));
    section.appendChild(rows);
    list.appendChild(section);
  }

  // Die Lagerort-Verwaltung am Ende der Liste: am Telefon steht der Kopf mit
  // ihrem Knopf nur waehrend der Suche (pantry.css). Regel 7: nur mit
  // Schreibrecht.
  if (!readOnly()) {
    const footer = document.createElement('div');
    footer.className = 'pantry-footer';
    const manage = document.createElement('button');
    manage.type = 'button';
    manage.className = 'pantry-footer__manage';
    manage.dataset.action = 'manage-locations';
    manage.textContent = t('pantry.manageLocations');
    footer.appendChild(manage);
    list.appendChild(footer);
  }

  wirePantrySwipe(list);
  if (window.lucide) window.lucide.createIcons({ el: list });
}

// --------------------------------------------------------
// Karte „Wymaga uwagi" (Tafla)
// --------------------------------------------------------

/**
 * Was zuerst gebraucht wird, in EINER Karte oben in der Liste: "Termin mija"
 * (abgelaufen oder in hoechstens drei Tagen, nach Datum) und "Kończy się" (an
 * oder unter dem eigenen Mindestbestand, oder leer). Sie ersetzt die drei
 * Statusfilter als Einstieg: die Frage stellt sich, ohne dass man sie stellt.
 * Ohne Anlass gibt es die Karte nicht.
 */
function attentionGroups(items) {
  const expiring = items.filter(expiresSoon)
    .sort((a, b) => String(a.expires_on).localeCompare(String(b.expires_on)));
  const low = items.filter((item) => {
    const status = pantryItemStatus(item, state.todayKey);
    return status.low || status.out;
  });
  return { expiring, low };
}

function attentionEl() {
  const { expiring, low } = attentionGroups(state.items.map(withIntent));
  if (!expiring.length && !low.length) return null;

  const card = document.createElement('section');
  card.className = 'pantry-attention';
  card.id = 'pantry-attention';
  card.setAttribute('aria-labelledby', 'pantry-attention-title');

  const title = document.createElement('h2');
  title.className = 'pantry-attention__title';
  title.id = 'pantry-attention-title';
  title.textContent = t('pantry.watchLabel');
  card.appendChild(title);

  if (expiring.length) {
    const part = document.createElement('div');
    part.className = 'pantry-attention__part';
    const heading = document.createElement('h3');
    heading.className = 'pantry-attention__heading';
    heading.textContent = t('pantry.attentionExpiring');
    const rows = document.createElement('ul');
    rows.className = 'pantry-attention__rows';
    for (const item of expiring) {
      const li = document.createElement('li');
      // Ein Tipp holt die Zeile in der Liste ins Bild und klappt sie auf -
      // dort steht, was man mit dem Artikel tun kann.
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pantry-attention__row';
      btn.dataset.attentionId = String(item.id);
      const name = document.createElement('span');
      name.className = 'pantry-attention__name';
      name.textContent = item.name;
      btn.appendChild(name);
      const pill = statusPill(item);
      if (pill) btn.appendChild(pillEl(pill));
      li.appendChild(btn);
      rows.appendChild(li);
    }
    part.append(heading, rows);
    card.appendChild(part);
  }

  if (low.length) {
    if (expiring.length) {
      const rule = document.createElement('div');
      rule.className = 'pantry-attention__rule';
      rule.setAttribute('aria-hidden', 'true');
      card.appendChild(rule);
    }
    const part = document.createElement('div');
    part.className = 'pantry-attention__part';
    const heading = document.createElement('h3');
    heading.className = 'pantry-attention__heading';
    heading.textContent = t('pantry.attentionLow');

    // Was schon auf einer offenen Einkaufsliste steht, braucht keinen zweiten
    // Eintrag - die Karte sagt es, statt es anzubieten. Ohne Wissen ueber die
    // Liste (kein Leserecht, noch nicht geladen) gilt alles als offen; der
    // Server ueberspringt Doppelte ohnehin.
    const onList = state.onList;
    const isOnList = (item) => Boolean(onList?.has(String(item.name).trim().toLowerCase()));
    const missing = low.filter((item) => !isOnList(item));
    const already = low.filter(isOnList);

    const body = document.createElement('div');
    body.className = 'pantry-attention__low';
    const text = document.createElement('div');
    text.className = 'pantry-attention__text';
    const names = document.createElement('span');
    names.className = 'pantry-attention__names';
    names.textContent = joinNames((missing.length ? missing : low).map((i) => i.name));
    text.appendChild(names);
    if (already.length) {
      const note = document.createElement('span');
      note.className = 'pantry-attention__note';
      const noteText = document.createElement('span');
      noteText.className = 'pantry-attention__note-text';
      noteText.textContent = missing.length
        ? t('pantry.attentionOnList', { names: joinNames(already.map((i) => i.name)) })
        : t('pantry.attentionAllOnList');
      note.appendChild(noteText);
      note.insertAdjacentHTML('beforeend', '<i data-lucide="check" class="icon-sm" aria-hidden="true"></i>');
      text.appendChild(note);
    }
    body.appendChild(text);

    // Der Uebertrag schreibt in den EINKAUF: gefragt wird dessen Recht (#1265).
    if (missing.length && mayTransferPantryToShopping()) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'btn pantry-attention__add';
      add.dataset.action = 'attention-add';
      add.textContent = t('pantry.attentionAdd', { count: missing.length });
      body.appendChild(add);
    }
    part.append(heading, body);
    card.appendChild(part);
  }
  return card;
}

/** Zeichnet die Karte an Ort und Stelle neu (nach einem Schritt oder Uebertrag). */
function refreshAttention() {
  const list = _container?.querySelector('#pantry-list');
  const current = list?.querySelector(':scope > #pantry-attention');
  const overview = !state.query && state.filter === 'all' && state.place === 'all';
  if (!list || !overview || !state.items.length) return;
  const fresh = attentionEl();
  if (current && fresh) current.replaceWith(fresh);
  else if (current) current.remove();
  else if (fresh) {
    const chipRow = list.querySelector(':scope > #pantry-filters');
    if (chipRow) chipRow.after(fresh);
    else list.prepend(fresh);
  }
  if (fresh && window.lucide) window.lucide.createIcons({ el: fresh });
}

/**
 * Welche Namen stehen offen auf einer Einkaufsliste? Fuer den Satz "… już na
 * liście" der Karte. Nur mit Leserecht auf den Einkauf, und nur wenn es
 * ueberhaupt etwas Knappes gibt - sonst fragt die Seite nichts.
 */
async function refreshOnList() {
  const anyLow = state.items.some((item) => {
    const status = pantryItemStatus(withIntent(item), state.todayKey);
    return status.low || status.out;
  });
  if (!anyLow || pathAccess('/shopping') === 'none' || window.yuvomi?.isModuleDisabled?.('shopping')) {
    state.onList = null;
    return;
  }
  try {
    const lists = (await api.get('/shopping')).data ?? [];
    state.lists = lists;
    const names = new Set();
    const answers = await Promise.all(lists.map((list) => api.get(`/shopping/${list.id}/items`).catch(() => null)));
    for (const res of answers) {
      for (const item of res?.data ?? []) {
        if (!item.is_checked) names.add(String(item.name).trim().toLowerCase());
      }
    }
    state.onList = names;
  } catch {
    state.onList = null;
  }
  refreshAttention();
}

/** Ein Statuswort als getoente Pille. */
function pillEl(pill) {
  const el = document.createElement('span');
  el.className = `pantry-badge pantry-badge--${pill.tone}`;
  el.textContent = pill.text;
  return el;
}

/** Die Kamera-Karte: "Dodaj ze zdjęcia", wartet auf wirePhotoButton(). */
function photoCardEl() {
  const slot = document.createElement('div');
  slot.className = 'pantry-photo-slot';
  // Gebaut wie die Gruppen der Liste (DOM statt Markup-String): die Karte
  // steht in derselben Spalte und nimmt dasselbe Lesemass.
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'pantry-photo-card';
  card.id = 'pantry-photo-btn';
  card.hidden = true;
  const glyph = document.createElement('span');
  glyph.className = 'pantry-photo-card__glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.insertAdjacentHTML('beforeend', '<i data-lucide="camera" class="icon-lg"></i>');
  const text = document.createElement('span');
  text.className = 'pantry-photo-card__text';
  const title = document.createElement('span');
  title.className = 'pantry-photo-card__title';
  title.textContent = t('pantry.photoAdd');
  const hint = document.createElement('span');
  hint.className = 'pantry-photo-card__hint';
  hint.textContent = t('pantry.photoCardHint');
  text.append(title, hint);
  card.append(glyph, text);
  card.insertAdjacentHTML('beforeend', '<i data-lucide="chevron-right" class="icon-md pantry-photo-card__chevron" aria-hidden="true"></i>');
  slot.appendChild(card);
  return slot;
}

// --------------------------------------------------------
// Nebenpanel „Im Blick" (Desktop)
// --------------------------------------------------------

// NUR ZEITKRITISCHES (Re-Critique 2026-09-28, P7 / A4 P2-6). Hier stand auch
// "Fast leer": dieselbe Aussage stand damit dreimal da (Zeilen-Badge, Chip mit
// Zaehler, Panel), 14 von 21 Artikeln rechts ein zweites Mal, und "Fast leer
// 10" uebertoente die Fristen. Das Panel beantwortet jetzt nur, was nicht
// warten kann; "Fast leer" bleibt Chip plus Warenkorb an der Zeile.
const WATCH_SECTIONS = [
  { key: 'expired', label: 'pantry.filterExpired', icon: 'circle-alert', tone: 'danger' },
  { key: 'soon', label: 'pantry.filterSoon', icon: 'clock', tone: 'warning' },
];

/**
 * Die drei Abschnitte des Panels, mit genau der Zuordnung der Filterchips
 * (`matchesPantryFilter`) - ein Artikel steht im Panel, wenn und weil ihn der
 * gleichnamige Chip traefe. Unabhaengig von Suche und aktivem Filter: das
 * Panel beantwortet „was braucht Aufmerksamkeit", nicht „was zeigt die Liste".
 * Sortiert wie die flache Filterliste: Ablauf nach Datum, Bestand nach Menge.
 */
function pantryWatchGroups(items, today) {
  return WATCH_SECTIONS.map((section) => {
    const rows = items.filter((item) => matchesPantryFilter(item, section.key, today));
    rows.sort((a, b) => String(a.expires_on).localeCompare(String(b.expires_on)));
    return { ...section, items: rows };
  }).filter((section) => section.items.length);
}

function watchRowEl(item, section) {
  const li = document.createElement('li');
  li.className = 'list-row pantry-watch__row';
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'list-row__main list-row__main--interactive';
  main.dataset.watchId = String(item.id);
  const name = document.createElement('span');
  name.className = 'list-row__name';
  name.textContent = item.name;
  const meta = document.createElement('span');
  meta.className = 'list-row__meta';
  // Der Satz der Zeile („Laeuft morgen ab"), in der Tinte seiner Dringlichkeit.
  const expiry = expiryBadge(item);
  const lead = document.createElement('span');
  lead.className = `pantry-watch__due pantry-watch__due--${expiry ? expiry.tone : section.tone}`;
  lead.textContent = expiry ? expiry.text : quantityText(item);
  meta.appendChild(lead);
  if (item.location_name) meta.append(` · ${locationLabel(item.location_name)}`);
  main.append(name, meta);
  li.appendChild(main);
  return li;
}

/** Zeichnet das Panel neu; ohne Artikel bleibt es verborgen. */
function renderWatch() {
  const watch = _container?.querySelector('#pantry-watch');
  if (!watch) return;
  watch.replaceChildren();
  if (!state.items.length) {
    watch.hidden = true;
    return;
  }
  watch.hidden = false;
  const groups = pantryWatchGroups(state.items.map(withIntent), state.todayKey);
  if (!groups.length) {
    const calm = document.createElement('p');
    calm.className = 'pantry-watch__empty';
    calm.textContent = t('pantry.watchEmpty');
    watch.appendChild(calm);
    return;
  }
  for (const section of groups) {
    const el = document.createElement('section');
    el.className = 'list-group pantry-watch__group';
    const heading = document.createElement('h2');
    heading.className = 'list-group__title';
    heading.insertAdjacentHTML('beforeend', `<i data-lucide="${esc(section.icon)}" class="icon-sm" aria-hidden="true"></i>`);
    const label = document.createElement('span');
    label.textContent = t(section.label);
    const count = document.createElement('span');
    count.className = 'list-group__count';
    count.textContent = String(section.items.length);
    heading.append(label, count);
    const rows = document.createElement('ul');
    rows.className = 'row-carrier';
    for (const item of section.items) rows.appendChild(watchRowEl(item, section));
    el.append(heading, rows);
    watch.appendChild(el);
  }
  if (window.lucide) window.lucide.createIcons({ el: watch });
}

/** Eine Panelzeile oeffnet denselben Dialog wie ihre Zeile in der Liste. */
function onWatchClick(e) {
  const btn = e.target.closest('[data-watch-id]');
  if (!btn) return;
  const item = state.items.find((i) => i.id === Number(btn.dataset.watchId));
  if (item) openItemModal('edit', item);
}

/**
 * Kein Treffer für Suche und/oder Filter. Benennt beide Ursachen, statt nur die
 * Suche zu erwähnen: war zusätzlich ein Filter aktiv, blieb er vorher unsichtbar
 * und der Nutzer suchte den Fehler beim Suchbegriff.
 */
function noResultsEl() {
  // Der geteilte Leerzustand einer leeren Suche (R19): Begriff, Statusfilter
  // und Ort als Chips, EIN Knopf hebt alles auf.
  const filters = state.filter !== 'all'
    ? [t({ expired: 'pantry.filterExpired', soon: 'pantry.filterSoon', low: 'pantry.filterLow' }[state.filter])]
    : [];
  if (state.place !== 'all') {
    const loc = state.locations.find((l) => l.id === state.place);
    filters.push(loc ? locationLabel(loc.name) : t('pantry.unlocated'));
  }
  return searchEmptyEl({
    query: state.query,
    filters,
    onReset: () => {
      state.query = '';
      state.filter = 'all';
      state.place = 'all';
      // clear() versteckt zugleich den Leeren-Knopf des geteilten Suchfelds;
      // ein blankes `value = ''` ließe ihn über dem leeren Feld stehen.
      _search?.clear();
      renderFilters();
      renderList();
      _search?.input.focus();
    },
  });
}

function emptyStateEl() {
  // TAFLA "Pusty stan": kein Kasten, kein Knopf - das globale + legt an. Die
  // eine Ausnahme ist die Kamera-Karte, die drawList() darunter haengt.
  // Bei `read` nur der Zustand (Regel 9): die Beschreibung ("Zapisz, co masz
  // w domu …") laedt zu einer Handlung ein, die es dann nicht gibt.
  const ro = readOnly();
  return emptyStateComponentEl({
    icon: 'archive',
    title: t('pantry.emptyTitle'),
    description: ro ? undefined : t('pantry.emptyDescription'),
    className: 'pantry-empty',
  });
}

/**
 * Eine Vorratszeile (Tafla, 56pt).
 *
 * ZU: Zeichen der Kategorie · Name · hoechstens EIN Statuswort · Mengen-Pille.
 * Kein Stepper, kein Warenkorb, kein Griff in der ruhenden Zeile - die Liste
 * liest sich wie ein Regal, nicht wie ein Bedienfeld.
 *
 * AUF: ein Tipp klappt darunter auf, was man mit dem Artikel tut - Termin und
 * Ort als Fussnote, der Stepper (− Menge +), "Na listę" bei knappen Artikeln
 * und "Edytuj" (dort auch Loeschen). Loeschen bleibt zusaetzlich der Wisch zum
 * Zeilenende, Bearbeiten zusaetzlich der lange Druck (wireLongPress).
 *
 * BEI `read`: kein Aufklappen. Der Tipp oeffnet die Leseansicht (Regel 9); was
 * knapp ist, traegt die Karte "Wymaga uwagi" auf die Liste - ihr Knopf fragt
 * das Recht des EINKAUFS, nicht dieses.
 */
function rowEl(item) {
  const status = pantryItemStatus(item, state.todayKey);

  // DIE ZEILE LAESST SICH WEGWISCHEN (R16 Schritt 2b, Kuechenregel in
  // DESIGN.md): das `li` ist die Buehne (`.swipe-row`) mit dem Reveal-Panel am
  // Zeilenende, die Zeile selbst liegt als `div` darin. Nur EINE Seite: am
  // Zeilenanfang gibt es im Vorrat nichts Positives zu erledigen.
  const ro = readOnly();
  const expanded = !ro && state.expanded === item.id;
  const wrap = document.createElement('li');
  // `.swipe-row--static`: ohne Geste auch kein Wisch-Chevron (layout.css).
  wrap.className = ro ? 'swipe-row swipe-row--static pantry-swipe' : 'swipe-row pantry-swipe';
  wrap.dataset.swipeId = String(item.id);
  // Nur-lesen: die Buehne bleibt (Zeilenschluessel fuer Neuzeichnen und
  // Auffrischung), das Loeschen-Panel entfaellt (Regel 3).
  if (!ro) {
    wrap.insertAdjacentHTML('beforeend', `
    <div class="swipe-reveal swipe-reveal--delete swipe-reveal--trailing" aria-hidden="true">
      <i data-lucide="trash-2" class="icon-md"></i>
      <span>${esc(t('common.delete'))}</span>
    </div>`);
  }

  const li = document.createElement('div');
  li.className = expanded ? 'list-row pantry-row pantry-row--open' : 'list-row pantry-row';
  li.dataset.id = String(item.id);
  if (status.out) li.classList.add('pantry-row--out');

  // Die ganze Zeile ist EIN Knopf. BEWUSST kein aria-label: der Inhalt (Name,
  // Statuswort, Menge) ist der Name - ein Label hätte genau das verschluckt
  // (Critique P1, WCAG 1.3.1/4.1.2). Mit Schreibrecht klappt er auf
  // (`aria-expanded`), bei `read` oeffnet er die Leseansicht.
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'list-row__main list-row__main--interactive pantry-row__main';
  main.dataset.action = ro ? 'details' : 'expand';
  if (!ro) {
    main.setAttribute('aria-expanded', String(expanded));
    main.setAttribute('aria-controls', `pantry-row-more-${item.id}`);
  }

  const glyph = document.createElement('span');
  glyph.className = 'pantry-row__glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.insertAdjacentHTML('beforeend', `<i data-lucide="${esc(categoryIcon(item))}" class="icon-lg"></i>`);
  main.appendChild(glyph);

  // Name und Statuswort in EINER Zeile: das Wort qualifiziert den Artikel.
  const headline = document.createElement('span');
  headline.className = 'pantry-row__headline';
  const name = document.createElement('span');
  name.className = 'list-row__name';
  name.textContent = item.name;
  headline.appendChild(name);
  const pill = statusPill(item);
  if (pill) {
    const badges = document.createElement('span');
    badges.className = 'pantry-row__badges';
    badges.appendChild(pillEl(pill));
    headline.appendChild(badges);
  }
  main.appendChild(headline);

  // DIE MENGE ALS PILLE AM ZEILENENDE (Tafla "Ilość i stepper"). Ein eigener
  // Knoten: refreshRowQuantity() schreibt ihn bei jedem Schritt fort.
  const quantity = document.createElement('span');
  quantity.className = 'pantry-row__quantity';
  quantity.textContent = quantityText(item);
  main.appendChild(quantity);

  // Bei `read` sagt der geteilte Zusatz, dass die Zeile ihre Details zeigt (#1682).
  if (ro) main.appendChild(readRowHintEl());
  li.appendChild(main);
  if (ro) {
    wrap.appendChild(li);
    return wrap;
  }

  // ---- Der aufgeklappte Teil ------------------------------------------------
  // `.list-row__actions` ist die geteilte Bedienzone; hier steht sie als
  // eigene Zeile unter dem Namen statt daneben (pantry.css, flex-basis 100%).
  const more = document.createElement('div');
  more.className = 'list-row__actions pantry-row__expand';
  more.id = `pantry-row-more-${item.id}`;
  more.hidden = !expanded;

  // Termin und - in der flachen Filteransicht - der Ort als Fussnote. Die
  // Zeile selbst traegt nur das Statuswort; das Datum steht hier.
  const facts = [];
  if (item.expires_on) facts.push(t('pantry.bestBefore', { date: formatDate(item.expires_on) }));
  // In der Ortsgruppe nennt der Kopf den Ort schon; in der flachen Liste nicht.
  if (state.filter !== 'all') facts.push(item.location_name ? locationLabel(item.location_name) : t('pantry.unlocated'));
  if (facts.length) {
    const factsEl = document.createElement('p');
    factsEl.className = 'pantry-row__facts';
    const expiry = document.createElement('span');
    expiry.className = 'pantry-row__expiry';
    expiry.textContent = facts.join(' · ');
    factsEl.appendChild(expiry);
    more.appendChild(factsEl);
  }

  const controls = document.createElement('div');
  controls.className = 'pantry-row__controls';

  // Der Stepper: − Menge +, jede Seite ein volles Ziel (pantry.css).
  // BEWUSST keine eigene Live-Region je Zeile - die Ansage uebernimmt die eine
  // geteilte Region der Seite (#pantry-live).
  const stepper = document.createElement('div');
  stepper.className = 'pantry-stepper';
  stepper.dataset.step = String(pantryUnitStep(item.unit));

  const minus = document.createElement('button');
  minus.type = 'button';
  minus.className = 'pantry-stepper__btn';
  minus.dataset.action = 'decrease';
  minus.disabled = Number(item.quantity) <= 0;
  minus.setAttribute('aria-label', `${t('pantry.decrease')}: ${item.name}`);
  minus.insertAdjacentHTML('beforeend', '<i data-lucide="minus" class="icon-md" aria-hidden="true"></i>');

  const value = document.createElement('span');
  value.className = 'pantry-stepper__value';
  value.setAttribute('aria-hidden', 'true');
  value.textContent = quantityText(item);

  const plus = document.createElement('button');
  plus.type = 'button';
  plus.className = 'pantry-stepper__btn';
  plus.dataset.action = 'increase';
  plus.setAttribute('aria-label', `${t('pantry.increase')}: ${item.name}`);
  plus.insertAdjacentHTML('beforeend', '<i data-lucide="plus" class="icon-md" aria-hidden="true"></i>');

  stepper.append(minus, value, plus);
  controls.appendChild(stepper);

  // "Na listę" nur bei knappen oder leeren Artikeln, und nur mit Schreibrecht
  // auf den EINKAUF (#1265). Der Slot wird bei jedem Schritt als Ganzes
  // getauscht (refreshRowQuantity) - der Knopf kommt und geht mit der Menge.
  const cartSlot = document.createElement('span');
  cartSlot.className = 'pantry-row__cart-slot';
  // Steht der Name schon offen auf einer Einkaufsliste, gibt es nichts anzubieten.
  const onList = Boolean(state.onList?.has(String(item.name).trim().toLowerCase()));
  if ((status.out || status.low) && !onList && mayTransferPantryToShopping()) cartSlot.appendChild(cartEl(item));
  controls.appendChild(cartSlot);

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'pantry-row__edit';
  edit.dataset.action = 'edit';
  edit.textContent = t('common.edit');
  controls.appendChild(edit);

  more.appendChild(controls);
  li.appendChild(more);
  wrap.appendChild(li);
  return wrap;
}

/**
 * Wisch zum Zeilenende loescht - mit dem Rueckweg, den removeItem() schon hat
 * (Undo-Toast). Die Karte federt zurueck statt hinauszufliegen: removeItem()
 * blendet die Zeile selbst aus und holt sie bei "Rueckgaengig" wieder.
 */
function wirePantrySwipe(list) {
  // Regel 3 in utils/module-access.js: bei Nur-lesen bleibt die VERDRAHTUNG
  // aus, samt Wisch-Hinweis.
  if (readOnly()) return null;
  const optionen = {
    card: '.pantry-row',
    // Der aufgeklappte Teil ist Ausnahmezone: wer am Stepper tippt und dabei
    // rutscht, loescht nichts.
    ignore: '.pantry-row__expand, .pantry-stepper, .pantry-row__cart',
    trailing: {
      reveal: '.swipe-reveal--delete',
      run: (row) => {
        const item = state.items.find((i) => String(i.id) === row.dataset.swipeId);
        if (item) removeItem(item);
      },
    },
  };
  wireSwipeRows(list, optionen);
  maybeShowSwipeHint(list);
  return optionen;
}

/** "Na listę": die Einkaufs-Aktion der aufgeklappten Zeile, nur bei knappen Artikeln. */
function cartEl(item) {
  const cart = document.createElement('button');
  cart.type = 'button';
  cart.className = 'pantry-row__cart';
  cart.dataset.action = 'to-shopping';
  cart.setAttribute('aria-label', `${t('common.toShoppingList')}: ${item.name}`);
  cart.textContent = t('pantry.toListShort');
  return cart;
}

/**
 * LANGER DRUCK = BEARBEITEN (Tafla, Gesten statt Knoepfe): am Finger oeffnet
 * ein Druck von 450 ms ohne Bewegung den Editor. Derselbe Weg steht als
 * "Edytuj" in der aufgeklappten Zeile - die Geste ist eine Abkuerzung, nie der
 * einzige Zugang. Der Klick danach wird verschluckt, sonst klappte die Zeile
 * zusaetzlich auf.
 */
const LONG_PRESS_MS = 450;
function wireLongPress(list) {
  if (!list?.addEventListener || list.dataset.longPressWired) return;
  list.dataset.longPressWired = '1';
  let timer = null;
  let start = null;
  let fired = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  list.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || readOnly()) return;
    const main = e.target.closest?.('.pantry-row__main');
    if (!main) return;
    fired = false;
    start = { x: e.clientX, y: e.clientY };
    cancel();
    timer = setTimeout(() => {
      timer = null;
      const row = main.closest('.pantry-row[data-id]');
      const item = state.items.find((i) => i.id === Number(row?.dataset.id));
      if (!item) return;
      fired = true;
      vibrate(12);
      openItemModal('edit', item);
    }, LONG_PRESS_MS);
  });
  list.addEventListener('pointermove', (e) => {
    if (timer && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) cancel();
  });
  list.addEventListener('pointerup', cancel);
  list.addEventListener('pointercancel', cancel);
  list.addEventListener('contextmenu', (e) => {
    if (e.target.closest?.('.pantry-row__main') && (timer || fired)) e.preventDefault();
  });
  list.addEventListener('click', (e) => {
    if (!fired) return;
    fired = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
}

// --------------------------------------------------------
// Interaktion
// --------------------------------------------------------

function onListClick(e) {
  // Die Karte "Wymaga uwagi": ein Artikel darin holt seine Zeile ins Bild.
  const attention = e.target.closest('[data-attention-id]');
  if (attention) { revealItem(Number(attention.dataset.attentionId)); return; }

  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  // Zwei Knoepfe ausserhalb einer Zeile: der Uebertrag der Karte (fragt das
  // Recht des Einkaufs selbst, sendToShopping) und die Lagerort-Verwaltung am
  // Listenende (openLocationManager fragt das Schreibrecht).
  if (btn.dataset.action === 'attention-add') {
    const { low } = attentionGroups(state.items.map(withIntent));
    const missing = low.filter((item) => !state.onList?.has(String(item.name).trim().toLowerCase()));
    sendToShopping(missing, btn);
    return;
  }
  if (btn.dataset.action === 'manage-locations') { openLocationManager(); return; }

  const row = btn.closest('.pantry-row[data-id]');
  if (!row) return;
  const item = state.items.find((i) => i.id === Number(row.dataset.id));
  if (!item) return;

  // Der eine Riegel fuer alle Aktionen darunter (siehe READ_SAFE_ACTIONS): das
  // Markup nimmt die Affordanz, diese Zeile den Effekt eines Knotens, den ein
  // Rechtewechsel ueberholt hat.
  if (readOnly() && !READ_SAFE_ACTIONS.has(btn.dataset.action)) return;

  if (btn.dataset.action === 'details') { openItemReadModal(item); return; }
  if (btn.dataset.action === 'expand') { toggleExpanded(item.id); return; }
  if (btn.dataset.action === 'edit') { openItemModal('edit', item); return; }
  if (btn.dataset.action === 'to-shopping') { sendToShopping([item], btn); return; }
  if (btn.dataset.action === 'increase') { adjustQuantity(item, +1, row); return; }
  if (btn.dataset.action === 'decrease') { adjustQuantity(item, -1, row); }
}

/**
 * Klappt eine Zeile auf oder zu - an Ort und Stelle, ohne Neuaufbau: die Liste
 * behaelt ihren Scrollstand, der Fokus bleibt auf dem Zeilenknopf. Es ist
 * immer hoechstens EINE Zeile offen.
 */
function toggleExpanded(id) {
  const next = state.expanded === id ? null : id;
  const setOpen = (rowId, open) => {
    const row = _container?.querySelector(`.pantry-row[data-id="${rowId}"]`);
    if (!row) return;
    row.classList.toggle('pantry-row--open', open);
    row.querySelector('.pantry-row__main')?.setAttribute('aria-expanded', String(open));
    const more = row.querySelector('.pantry-row__expand');
    if (!more) return;
    if (open) {
      more.hidden = false;
      expandIn(more);
    } else {
      more.hidden = true;
    }
  };
  if (state.expanded != null) setOpen(state.expanded, false);
  state.expanded = next;
  if (next != null) setOpen(next, true);
}

/** Holt die Zeile eines Artikels ins Bild und klappt sie auf (Karte "Wymaga uwagi"). */
function revealItem(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  if (readOnly()) { openItemReadModal(withIntent(item)); return; }
  if (state.expanded !== id) toggleExpanded(id);
  const row = _container?.querySelector(`.pantry-row[data-id="${id}"]`);
  row?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  row?.querySelector('.pantry-row__main')?.focus({ preventScroll: true });
}

/**
 * Optimistischer ±-Schritt. Der PATCH wird entprellt, damit mehrfaches Tippen
 * einen Request auslöst statt fünf; beim Fehlschlag kehrt die Zeile auf den
 * Serverstand zurück.
 *
 * Die Zeile wird bewusst NICHT neu gefiltert: verschwände ein Artikel unter
 * dem Finger, sobald er den aktiven Filter verlässt, wäre der nächste Tap ein
 * Fehltap. Die Auswahl aktualisiert sich beim nächsten vollen Render.
 */
function adjustQuantity(item, direction, row) {
  // Zweite Linie hinter dem fehlenden Stepper: ohne Schreibrecht keine
  // optimistische Menge und kein PATCH.
  if (readOnly()) return;
  const step = Number(row.querySelector('.pantry-stepper')?.dataset.step) || 1;
  // Der Ausgangspunkt ist, was die Zeile ZEIGT - eine schon laufende Absicht
  // eingeschlossen, sonst zaehlte jeder Schritt vom Serverstand aus neu.
  const previous = quantityOf(item);
  const next = normalizePantryQuantity(previous + direction * step, { fallback: previous });
  if (next === previous) return;

  const vorher = intents.get(item.id);
  if (vorher) clearTimeout(vorher.timer);
  const seq = ++_quantitySeq;

  const timer = setTimeout(async () => {
    try {
      const res = await api.patch(`/pantry/${item.id}`, { quantity: next });
      // Ueberholt: ein spaeterer Schritt hat die Absicht ersetzt, sein Ausgang
      // entscheidet. Der Server steht trotzdem auf `next` - das gehoert in den
      // SERVERSTAND, damit ein Fehlschlag des spaeteren nicht daran vorbei
      // zurueckfaellt.
      const aktuell = intents.get(item.id);
      // NUR die Menge aus der Antwort. Sie ist ein Schnappschuss vom Zeitpunkt
      // DIESES Schreibvorgangs und fuer nichts anderes autoritativ - hat jemand
      // Name, Ort oder Notiz geaendert, holt die naechste Auffrischung das.
      const bestaetigt = normalizePantryQuantity(res.data?.quantity, { fallback: next });
      const current = state.items.find((i) => i.id === item.id);
      if (current) current.quantity = bestaetigt;
      settledAt.set(item.id, _pantryLoadSeq);
      if (aktuell?.seq !== seq) return;
      // Die eigene Absicht ist erfuellt und faellt - was die Zeile danach
      // zeigt, ist der bestaetigte Serverstand.
      intents.delete(item.id);
      const rowNow = liveRow(item.id, row);
      if (rowNow && current) refreshRowQuantity(rowNow, withIntent(current));
    } catch (err) {
      const aktuell = intents.get(item.id);
      if (aktuell?.seq !== seq) return;
      // DIE ABSICHT FAELLT, mehr passiert nicht. Was die Zeile danach zeigt,
      // ist der Serverstand - der aktuellste, den wir haben. Es gibt keinen
      // gemerkten Ruecksprungwert mehr, der dabei veralten koennte.
      intents.delete(item.id);
      const current = state.items.find((i) => i.id === item.id);
      // Die Seite wurde inzwischen verlassen: kein Zurückzeichnen einer
      // abgehängten Zeile und kein Vorrats-Toast auf einer fremden Seite.
      const rowNow = liveRow(item.id, row);
      if (!rowNow) return;
      if (current) refreshRowQuantity(rowNow, withIntent(current));
      if (renderFilters().wasReset) renderList();
      window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
    }
  }, QUANTITY_DEBOUNCE_MS_OVERRIDE ?? QUANTITY_DEBOUNCE_MS);

  intents.set(item.id, {
    quantity: next,
    seq,
    timer,
    // `flush` schickt den gedebouncten Wert sofort ab, wenn die Seite
    // verschwindet. Die Absicht faellt dabei nicht - der Rundlauf laeuft ja
    // noch, nur ohne Timer.
    flush: () => {
      clearTimeout(timer);
      // keepalive: der Request muss den Seitenwechsel überleben. Ohne ihn
      // bricht der Browser ihn mit dem Dokument ab.
      api.patch(`/pantry/${item.id}`, { quantity: next }, { keepalive: true })
        .catch(() => { /* Die Seite ist weg; ein Toast hätte kein Ziel mehr. */ });
    },
  });

  vibrate(8);
  refreshRowQuantity(row, withIntent(item));
  if (renderFilters().wasReset) renderList();
  bindQuantityFlush();
}

let _quantityFlushBound = false;

/**
 * Offene Mengenänderungen beim Verschwinden der Seite noch abschicken.
 *
 * Der Stepper schreibt 450ms gedebounced. Genau in diesem Fenster ist der
 * typische Ablauf: am Vorratsschrank stehen, „+" tippen, Telefon sperren. Der
 * Timer feuerte dann nie, die UI hatte den neuen Wert aber schon optimistisch
 * gezeigt - beim nächsten Öffnen stand der alte Bestand da, ohne jede Meldung.
 *
 * Dasselbe Muster wie `bindDeleteFlush` in utils/ux.js (Audit F-13): einmal
 * global gebunden, `pagehide` deckt Tab-Schließen, Reload und den
 * App-Wechsel auf iOS ab.
 */
function bindQuantityFlush() {
  if (_quantityFlushBound) return;
  _quantityFlushBound = true;
  window.addEventListener('pagehide', () => {
    for (const intent of [...intents.values()]) intent.flush?.();
  });
}

/** Sagt eine Bestandsänderung über die eine geteilte Live-Region der Seite an. */
function announce(message) {
  const region = _container?.querySelector('#pantry-live');
  if (region) region.textContent = message;
}

/** Aktualisiert Menge, Badges und Leer-Zustand einer Zeile ohne Listen-Rebuild. */
/**
 * Die Zeile eines Artikels, wie sie JETZT im Dokument steht.
 *
 * Nach einer Auffrischung hat `renderList()` die Liste neu gebaut; die beim
 * Schritt festgehaltene Zeile haengt dann an nichts mehr, und ein
 * Zurueckzeichnen darauf waere unsichtbar. Findet sich keine angehaengte
 * Zeile, ist die Seite verlassen - dann bleibt es beim State.
 */
function liveRow(id, fallback) {
  const el = _container?.querySelector(`.pantry-row[data-id="${id}"]`);
  if (el?.isConnected) return el;
  return fallback?.isConnected ? fallback : null;
}

function refreshRowQuantity(row, item) {
  // Zwei Stellen zeigen die Menge: die Pille der Zeile und der Wert im Stepper.
  const value = row.querySelector('.pantry-row__quantity');
  if (value) value.textContent = quantityText(item);
  const stepValue = row.querySelector('.pantry-stepper__value');
  if (stepValue) stepValue.textContent = quantityText(item);
  announce(`${item.name}: ${quantityText(item)}`);

  const minus = row.querySelector('[data-action="decrease"]');
  if (minus) {
    const willDisable = Number(item.quantity) <= 0;
    // Einen fokussierten Button zu deaktivieren wirft den Fokus auf <body>.
    // Vorher auf „+" ausweichen - das ist ohnehin die einzige Aktion, die auf
    // einem leeren Artikel noch sinnvoll ist.
    if (willDisable && !minus.disabled && document.activeElement === minus) {
      row.querySelector('[data-action="increase"]')?.focus();
    }
    minus.disabled = willDisable;
  }

  const status = pantryItemStatus(item, state.todayKey);
  row.classList.toggle('pantry-row--out', status.out);

  // Statuswort und "Na listę" hängen an der Menge und müssen mitgehen. Getauscht
  // werden nur der Zeilenknopf und der Slot von "Na listę" - nie der Stepper,
  // auf dem gerade der Finger (oder der Fokus) liegt.
  const fresh = rowEl(item);
  row.querySelector('.pantry-row__main')?.replaceWith(fresh.querySelector('.pantry-row__main'));
  row.querySelector('.pantry-row__cart-slot')?.replaceWith(fresh.querySelector('.pantry-row__cart-slot'));

  if (window.lucide) window.lucide.createIcons({ el: row });
  // Panel und Karte sprechen von denselben Mengen: ein Schritt, der einen
  // Artikel unter den Mindestbestand bringt, gehoert sofort unter "Kończy się".
  renderWatch();
  refreshAttention();
}

// --------------------------------------------------------
// Einkaufsliste
// --------------------------------------------------------

/**
 * Fehlmenge als Anzeigetext: bis zum Mindestbestand auffüllen. Ohne
 * Mindestbestand bleibt die Menge offen - im Laden entscheidet man selbst.
 */
function shortfallText(item) {
  if (item.min_quantity == null) return null;
  const missing = normalizePantryQuantity(Number(item.min_quantity) - Number(item.quantity), { fallback: 0 });
  if (missing <= 0) return null;
  // Derselbe Helfer wie die Zeile: auch auf dem Einkaufszettel „2 Dosen".
  return pantryQuantityLabel(missing, item.unit, { t, formatNumber: formatQuantity });
}

async function sendToShopping(items, btn) {
  if (!items.length) return;
  // Zweite Linie hinter Warenkorb und Pille - auch fuer einen Knoten, den ein
  // Rechtewechsel ueberholt hat.
  if (!mayTransferPantryToShopping()) return;

  let lists;
  try {
    lists = await ensureLists();
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
    return;
  }

  // Vorprüfung, Listenwahl und die Antwort auf „es gibt keine Liste" liegen im
  // geteilten Baustein (utils/kitchen-transfer.js) - dieselbe Abfolge stand
  // vorher in allen drei erzeugenden Tabs, mit drei Ergebnissen.
  const target = await resolveShoppingTarget(lists);
  if (!target) return;

  // Während des Transfers gesperrt, wie im Rezepte-Tab. Ohne das lässt sich der
  // Warenkorb mehrfach antippen, und jeder Klick erzeugt einen eigenen Toast mit
  // eigenem Undo - von denen nur der letzte etwas zurücknimmt.
  if (btn) btn.disabled = true;
  try {
    const res = await api.post(`/shopping/${target.id}/import-pantry`, {
      items: items.map((item) => ({ pantry_item_id: item.id, quantity: shortfallText(item) })),
    });
    const { added = 0, skipped = 0, added_ids: addedIds = [] } = res.data ?? {};
    if (!added) {
      window.yuvomi?.showToast(t('pantry.toShoppingNone'), 'info');
      return;
    }
    // Zwei vollständige Sätze, mit Leerzeichen verbunden. Vorher stand ein
    // Interpunkt dazwischen: das ergab einen zusammengesetzten Satz, der in
    // Sprachen mit anderer Satzstellung bricht, und ein Screenreader liest das
    // Zeichen mit (Critique 2026-07-29). Ein einziger Key mit beiden Zahlen
    // wäre die Alternative - der müsste dann aber zwei Plurale in einem String
    // beugen, was Intl.PluralRules nicht kann.
    // `list` nennt das ZIEL. „… auf die Einkaufsliste übernommen." benannte den
    // Typ, nicht die Liste - bei mehreren Listen bleibt damit offen, auf welche
    // (Critique 2026-07-30, P1). Der Name steht hier ohnehin fest: entweder gibt es
    // nur eine Liste, oder der Nutzer hat sie gerade ausgewählt.
    const message = skipped
      ? `${t('pantry.toShoppingDone', { count: added, list: target.name })} ${t('pantry.toShoppingSkipped', { count: skipped })}`
      : t('pantry.toShoppingDone', { count: added, list: target.name });

    // Meldung, Standzeit, Tab-Zahl und Rücknahme kommen aus dem geteilten
    // Baustein. Der Warenkorb ist der Pfad, den man am leichtesten versehentlich
    // nimmt - er sitzt in der Zeile direkt neben „Menge erhöhen", und die beiden
    // bedeuten das Gegenteil voneinander (Critique 2026-07-30).
    announceTransfer({ message, addedIds });
    // Die Karte "Wymaga uwagi" sagt danach "już na liście" statt erneut anzubieten.
    refreshOnList();
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// --------------------------------------------------------
// Artikel-Formular
// --------------------------------------------------------

/**
 * Der Artikel bei `pantry: read`: Leseansicht, sonst nichts (Regel 9, Bauart
 * `openItemReadModal()` in shopping.js und `openNoteReadModal()` in notes.js).
 * Alles, was der Bearbeiten-Dialog zeigt - Menge mit Einheit, Lagerort,
 * Kategorie, MHD, Mindestbestand, Notiz -, als Wert statt als Eingabe; der Name
 * steht im Titel. Kategorie, Mindestbestand und Notiz stehen NUR im Editor, die
 * Zeile zeigt sie nie. Kein Fusszeilen-Knopf, das X schliesst.
 */
function itemReadHtml(item) {
  const amount = (value) => pantryQuantityLabel(Number(value) || 0, item.unit, { t, formatNumber: formatQuantity });
  return `
    <div class="pantry-item-read detail-view" data-view="read" data-item-id="${esc(String(item.id))}">
      <div class="detail-view__rows">
        ${readRowHtml({ icon: 'hash', label: t('pantry.quantityLabel'), value: amount(item.quantity) })}
        ${readRowHtml({ icon: 'map-pin', label: t('pantry.locationLabel'), value: item.location_name ? locationLabel(item.location_name) : t('pantry.unlocated') })}
        ${readRowHtml({ icon: 'tag', label: t('pantry.categoryLabel'), value: item.category ? categoryLabel(item.category) : '' })}
        ${readRowHtml({ icon: 'calendar', label: t('pantry.expiresLabel'), value: item.expires_on ? formatDate(item.expires_on) : '' })}
        ${readRowHtml({ icon: 'triangle-alert', label: t('pantry.minQuantityLabel'), value: item.min_quantity != null ? amount(item.min_quantity) : '' })}
        ${readRowHtml({ icon: 'align-left', label: t('pantry.notesLabel'), value: item.notes || '', multiline: true })}
      </div>
    </div>`;
}

function openItemReadModal(item) {
  openSharedModal({
    title: item.name,
    size: 'md',
    content: itemReadHtml(item),
    onSave(panel) {
      if (window.lucide) window.lucide.createIcons({ el: panel });
    },
  });
}

function openItemModal(mode, item = null) {
  const isEdit = mode === 'edit';
  // Der Riegel steht VOR jeder Vorbereitung, und er steht HIER, weil Liste,
  // Nebenpanel, FAB und Leerzustand alle diesen Weg nehmen: bei `read` geht
  // fuer einen Artikel die Leseansicht auf, und Anlegen gibt es nicht. Den FAB
  // blendet CSS aus (html[data-module-readonly]) - ausgeblendet ist nicht
  // unerreichbar.
  if (readOnly()) {
    if (isEdit && item) openItemReadModal(withIntent(item));
    return;
  }
  // Der Dialog zeigt den Artikel, wie ihn die Zeile zeigt: mit der Absicht
  // eines Stepper-Schritts, dessen PATCH noch im Entprell-Fenster steht. Aus
  // dem nackten Serverstand gefuellt stuende dort die alte Menge, und wer dann
  // ein anderes Feld speichert, schriebe sie per PUT zurueck - der Schritt
  // waere still verloren. Hier statt beim Aufrufer, weil Liste und Nebenpanel
  // denselben Weg nehmen.
  if (isEdit) item = withIntent(item);
  const locations = state.locations;
  const categories = state.categories;

  const unitOptions = PANTRY_UNITS
    .map((unit) => `<option value="${esc(unit)}">${esc(unitLabel(unit))}</option>`)
    .join('');
  const locationOptions = [
    `<option value="">${esc(t('pantry.unlocated'))}</option>`,
    ...locations.map((loc) => `<option value="${loc.id}">${esc(locationLabel(loc.name))}</option>`),
  ].join('');
  const categoryOptions = categories
    .map((cat) => `<option value="${esc(cat.name)}">${esc(categoryLabel(cat.name))}</option>`)
    .join('');

  openSharedModal({
    title: isEdit ? t('common.editItem') : t('pantry.addItem'),
    size: 'md',
    content: `
      <div class="form-group">
        <label class="form-label" for="pantry-name">${esc(t('common.nameLabel'))}${REQUIRED_MARK}</label>
        <input id="pantry-name" class="form-input" type="text" required
               placeholder="${esc(t('pantry.namePlaceholder'))}">
      </div>
      <div class="form-pair">
        <div class="form-group">
          <label class="form-label" for="pantry-quantity">${esc(t('pantry.quantityLabel'))}</label>
          <input id="pantry-quantity" class="form-input" type="number" min="0" step="any" inputmode="decimal">
        </div>
        <div class="form-group">
          <label class="form-label" for="pantry-unit">${esc(t('pantry.unitLabel'))}</label>
          <select id="pantry-unit" class="form-input">${unitOptions}</select>
        </div>
      </div>
      <div class="form-pair">
        <div class="form-group">
          <label class="form-label" for="pantry-location">${esc(t('pantry.locationLabel'))}</label>
          <select id="pantry-location" class="form-input">${locationOptions}</select>
        </div>
        <div class="form-group">
          <label class="form-label" for="pantry-category">${esc(t('pantry.categoryLabel'))}</label>
          <select id="pantry-category" class="form-input">${categoryOptions}</select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="pantry-expires">${esc(t('pantry.expiresLabel'))}</label>
        <yuvomi-datepicker id="pantry-expires" type="date"
                           value="${esc(isEdit && item.expires_on ? item.expires_on : '')}"></yuvomi-datepicker>
        <p class="form-hint">${esc(t('pantry.expiresHint'))}</p>
      </div>
      ${advancedSection(`
        <div class="form-group">
          <label class="form-label" for="pantry-min">${esc(t('pantry.minQuantityLabel'))}</label>
          <input id="pantry-min" class="form-input" type="number" min="0" step="any" inputmode="decimal">
          <p class="form-hint">${esc(t('pantry.minQuantityHint'))}</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="pantry-notes">${esc(t('pantry.notesLabel'))}</label>
          <textarea id="pantry-notes" class="form-input" rows="3"
                    placeholder="${esc(t('pantry.notesPlaceholder'))}"></textarea>
        </div>`,
      { open: isEdit && (item.min_quantity != null || !!item.notes) })}
      <div class="modal-panel__footer modal-panel__footer--plain">
        ${isEdit ? `<button type="button" class="btn btn--danger-outline pantry-form__delete" id="pantry-delete"><i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>${esc(t('common.delete'))}</button>` : ''}
        <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
        <button type="button" class="btn btn--primary" id="pantry-save">${esc(isEdit ? t('common.save') : t('common.add'))}</button>
      </div>`,
    onSave(panel) {
      panel.querySelector('#pantry-name').value = isEdit ? item.name : '';
      panel.querySelector('#pantry-quantity').value = isEdit ? String(item.quantity) : '1';
      panel.querySelector('#pantry-unit').value = isEdit ? item.unit : 'pcs';
      panel.querySelector('#pantry-location').value = isEdit && item.location_id ? String(item.location_id) : '';
      panel.querySelector('#pantry-category').value = isEdit
        ? item.category
        : (categories.find((c) => c.name === DEFAULT_CATEGORY_NAME)?.name ?? categories[0]?.name ?? DEFAULT_CATEGORY_NAME);
      panel.querySelector('#pantry-min').value = isEdit && item.min_quantity != null ? String(item.min_quantity) : '';
      panel.querySelector('#pantry-notes').value = isEdit && item.notes ? item.notes : '';

      panel.querySelector('#pantry-save').addEventListener('click', () => saveItem(panel, mode, item));
      panel.querySelector('#pantry-delete')?.addEventListener('click', async () => {
        closeSharedModal({ force: true });
        await removeItem(item);
        refocusAfterRender();
      });

      wireBlurValidation(panel);
      if (window.lucide) window.lucide.createIcons({ el: panel });
    },
  });
}

async function saveItem(panel, mode, item) {
  // Ein Dialog, den ein Rechtewechsel ueberholt hat: POST und PUT endeten im 403.
  if (readOnly()) return;
  const saveBtn = panel.querySelector('#pantry-save');
  const nameInput = panel.querySelector('#pantry-name');
  const name = nameInput.value.trim();

  if (!name) {
    reportFieldError(nameInput, t('common.nameRequired'));
    return;
  }

  const minRaw = panel.querySelector('#pantry-min').value.trim();
  const payload = {
    name,
    quantity: normalizePantryQuantity(panel.querySelector('#pantry-quantity').value, { fallback: 1 }),
    unit: panel.querySelector('#pantry-unit').value,
    location_id: panel.querySelector('#pantry-location').value || null,
    category: panel.querySelector('#pantry-category').value,
    expires_on: panel.querySelector('#pantry-expires').value || null,
    min_quantity: minRaw === '' ? null : normalizePantryQuantity(minRaw, { fallback: 0 }),
    notes: panel.querySelector('#pantry-notes').value.trim() || null,
  };

  saveBtn.disabled = true;
  try {
    if (mode === 'create') {
      const res = await api.post('/pantry', payload);
      state.items.push(res.data);
    } else {
      const res = await api.put(`/pantry/${item.id}`, payload);
      const idx = state.items.findIndex((i) => i.id === item.id);
      if (idx >= 0) state.items[idx] = res.data;
    }
    // location_name/location_icon kommen aus dem JOIN der Liste, nicht aus der
    // Einzel-Antwort - deshalb nach dem Speichern einmal frisch laden, damit
    // Gruppierung und Meta-Zeile stimmen.
    await loadPantry();
    closeSharedModal({ force: true });
    renderFilters();
    renderList({ motion: true });
    window.yuvomi?.showToast(mode === 'create' ? t('pantry.created') : t('pantry.updated'), 'success');
  } catch (err) {
    saveBtn.disabled = false;
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  }
}

async function removeItem(item) {
  // VOR dem Ausklappen: sonst verschwaende die Zeile, das DELETE endete im
  // 403, und sie kaeme mit Fehlermeldung zurueck.
  if (readOnly()) return;
  // Die Buehne (`li.swipe-row`), nicht nur die Zeile darin: sonst bliebe ein
  // leeres Listenelement samt Trennlinie stehen.
  const inner = _container?.querySelector(`.pantry-row[data-id="${item.id}"]`);
  const rowEl_ = inner?.closest('.swipe-row') ?? inner;
  // Die Zeile klappt aus, die Nachbarn ruecken nach (vorher `display: none`:
  // sie war weg, der Rest sprang). `display: none` folgt erst DANACH und bleibt
  // das Netz fuer alles, was nicht animiert (reduzierte Bewegung, kein
  // `animate`): der Zustand "weg" haengt an keiner Animation.
  let restored = false;
  if (rowEl_) collapseOut(rowEl_).then(() => { if (!restored) rowEl_.style.display = 'none'; });

  scheduleUndoableDelete({
    message: t('pantry.deleted'),
    commit: async ({ keepalive }) => {
      await api.delete(`/pantry/${item.id}`, { keepalive });
      if (keepalive) return;
      state.items = state.items.filter((i) => i.id !== item.id);
      renderFilters();
      renderList();
    },
    restore: (err) => {
      restored = true;
      if (rowEl_) {
        rowEl_.style.display = '';
        // collapseOut haelt die Hoehe 0 (fill: forwards) - verwerfen, dann aufziehen.
        rowEl_.getAnimations?.().forEach((anim) => anim.cancel());
        rowEl_.style.overflow = '';
        expandIn(rowEl_);
      }
      if (err) window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
    },
  });
}

// --------------------------------------------------------
// Lagerort-Verwaltung
// --------------------------------------------------------

async function openLocationManager() {
  // Zweite Linie hinter dem fehlenden Knopf im Kopf (Regel 7).
  if (readOnly()) return;
  await import('/components/category-manager.js');

  // Die Auffrischung haengt am Ereignis, nicht am Schliessen: beim Loeschen
  // raeumt `confirmOverModal` das Modal darunter ab, bevor `api.delete` laeuft
  // (siehe `_notifyChanged` in components/category-manager.js). Ein in onClose
  // ausgewerteter Merker stuende hier auf false, und die Filterleiste boete
  // weiter einen Lagerort an, den es nicht mehr gibt.
  const onChanged = async () => {
    try {
      await loadPantry();
      renderFilters();
      renderList();
      refocusAfterRender();
    } catch (err) {
      // NICHT „meldet der Manager selbst": der quittiert nur seine eigene
      // Mutation, und `_notifyChanged()` kommt erst nach deren Erfolg. Was hier
      // ankommt, ist immer ein Fehler DIESER Auffrischung - und der erklaert als
      // einziger, warum die Seite den alten Stand behaelt.
      console.error('[Pantry] Auffrischen nach Ort-Aenderung fehlgeschlagen:', err);
      window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
    }
  };

  openSharedModal({
    title: t('pantry.manageLocations'),
    content: '<yuvomi-category-manager></yuvomi-category-manager>',
    onSave: (panel) => {
      const manager = panel.querySelector('yuvomi-category-manager');
      if (!manager) return;
      manager.addEventListener('category-manager-changed', onChanged);
      // Dieselbe geteilte Komponente wie Einkaufskategorien: die Lagerort-API
      // bietet exakt deren CRUD-Vertrag (GET/POST basePath, PUT/DELETE :id,
      // PATCH /reorder).
      manager.configure({
        basePath: '/pantry/locations',
        labelResolver: (loc) => locationLabel(loc.name),
        titleKey: 'pantry.manageLocations',
        hintKey: 'pantry.manageLocationsHint',
        addPlaceholderKey: 'pantry.addLocation',
        // Lagerorte, keine Kategorien: der Server loescht auch belegte und
        // laesst die Artikel unzugeordnet zurueck (`orphaned` in der Antwort).
        deleteDetailKey: 'pantry.locationDeleteConfirmDetail',
        groups: [{ key: '', labelKey: '', addLabelKey: 'common.add' }],
      });
    },
    // Bewusst KEIN onClose, das den Listener abmeldet - es liefe vor dem
    // Loeschen. Das Element entsteht je Oeffnen neu und geht mit dem Overlay.
  });
}

// --------------------------------------------------------
// Add from a photo (fork, 2026-10-19)
// The camera button appears when AI is on for the pantry. A photo of a
// cupboard or fridge comes back as a draft list; nothing is stored until the
// person checks the list and taps "Add to the pantry".
// --------------------------------------------------------
async function wirePhotoButton(btn) {
  if (!btn) return;
  try {
    const status = await api.get('/ai/status');
    // Die Karte haengt erst nach dem Laden der Liste im Dokument (drawList) -
    // gefragt wird deshalb, ob sie noch die Karte DIESER Seite ist.
    if (!status.data?.features?.pantry_photo || !_photoSlot?.contains(btn)) return;
  } catch {
    return;
  }
  btn.hidden = false;
  window.lucide?.createIcons({ el: btn });
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.setAttribute('capture', 'environment');
  picker.hidden = true;
  btn.after(picker);
  btn.addEventListener('click', () => picker.click());
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file) return;
    btn.disabled = true;
    try {
      await scanPantryPhoto(file);
    } finally {
      btn.disabled = false;
    }
  });
}

/**
 * Reads one photo into the draft list and opens the review. Exported for the
 * global capture (components/capture-sheet.js): its long-press menu picks the
 * photo itself (the file dialog needs the tap's user gesture), opens this page
 * and hands the file over - the review needs the page's locations.
 * @param {File} file
 */
export async function scanPantryPhoto(file) {
  if (!file) return;
  window.yuvomi?.showToast(t('pantry.photoReading'), 'default', 6000);
  try {
    const image = await photoToJpegDataUrl(file);
    const res = await api.post('/pantry/photo-scan', { image });
    const items = res.data?.items ?? [];
    if (!items.length) {
      window.yuvomi?.showToast(t('pantry.photoNothing'), 'warning');
      return;
    }
    openPhotoReview(items);
  } catch (err) {
    const reason = err?.data?.reason;
    const key = reason === 'ai_cap_reached' ? 'pantry.photoCap'
      : (reason === 'ai_disabled' || reason === 'ai_not_configured') ? 'pantry.photoOff'
      : 'pantry.photoFailed';
    window.yuvomi?.showToast(t(key), 'danger');
  }
}

function openPhotoReview(items) {
  const unitOptions = (selected) => PANTRY_UNITS
    .map((u) => `<option value="${esc(u)}"${u === selected ? ' selected' : ''}>${esc(unitLabel(u))}</option>`).join('');
  const locationOptions = ['<option value="">' + esc(t('pantry.photoNoLocation')) + '</option>']
    .concat(state.locations.map((loc) => `<option value="${loc.id}">${esc(locationLabel(loc.name))}</option>`)).join('');
  const rows = items.map((item, i) => `
    <div class="pantry-photo-row${item.sure ? '' : ' pantry-photo-row--unsure'}" data-idx="${i}">
      <input type="checkbox" class="pantry-photo-row__pick" id="pp-pick-${i}" ${item.sure ? 'checked' : ''}
             aria-label="${esc(t('pantry.photoKeep', { name: item.name }))}">
      <input type="text" class="form-input pantry-photo-row__name" value="${esc(item.name)}" aria-label="${esc(t('common.nameLabel'))}">
      <input type="number" class="form-input pantry-photo-row__qty" value="${esc(String(item.quantity))}" min="0" step="any" inputmode="decimal" aria-label="${esc(t('pantry.quantityLabel'))}">
      <select class="form-input pantry-photo-row__unit" aria-label="${esc(t('pantry.unitLabel'))}">${unitOptions(item.unit)}</select>
      ${item.existing_id ? `<span class="pantry-photo-row__note">${esc(t('pantry.photoMerges'))}</span>` : ''}
    </div>`).join('');
  const content = `
    <p class="form-hint">${esc(t('pantry.photoReviewHint'))}</p>
    <div class="form-group">
      <label class="form-label" for="pantry-photo-location">${esc(t('pantry.photoLocation'))}</label>
      <select class="form-input" id="pantry-photo-location">${locationOptions}</select>
    </div>
    <div class="pantry-photo-rows">${rows}</div>
    <div class="modal-panel__footer modal-panel__footer--plain">
      <button class="btn btn--secondary" type="button" data-photo="cancel">${esc(t('common.cancel'))}</button>
      <button class="btn btn--primary" type="button" data-photo="apply">${esc(t('pantry.photoApply'))}</button>
    </div>`;
  openSharedModal({
    title: t('pantry.photoReviewTitle'),
    content,
    size: 'md',
    onSave: (panel) => {
      panel.querySelector('[data-photo="cancel"]').addEventListener('click', () => closeSharedModal({ force: true }));
      panel.querySelector('[data-photo="apply"]').addEventListener('click', async (e) => {
        const button = e.currentTarget;
        const locationId = Number(panel.querySelector('#pantry-photo-location').value) || null;
        const chosen = [...panel.querySelectorAll('.pantry-photo-row')]
          .filter((row) => row.querySelector('.pantry-photo-row__pick').checked)
          .map((row) => ({
            name: row.querySelector('.pantry-photo-row__name').value.trim(),
            quantity: Number(row.querySelector('.pantry-photo-row__qty').value) || 1,
            unit: row.querySelector('.pantry-photo-row__unit').value,
            location_id: locationId,
            category: items[Number(row.dataset.idx)]?.category ?? null,
          }))
          .filter((item) => item.name);
        if (!chosen.length) { closeSharedModal({ force: true }); return; }
        button.disabled = true;
        const context = captureModalContext();
        try {
          const res = await api.post('/pantry/photo-scan/apply', { items: chosen });
          closeSharedModal({ force: true, context });
          await loadPantry();
          renderFilters();
          renderList({ motion: true });
          refocusAfterRender();
          window.yuvomi?.showToast(t('pantry.photoAdded', { added: res.data?.added ?? 0, merged: res.data?.merged ?? 0 }), 'success');
        } catch (err) {
          button.disabled = false;
          window.yuvomi?.showToast(err?.message || t('common.errorGeneric'), 'danger');
        }
      });
    },
  });
}

// Testfläche: die Mengen-Entprellung ist nur verhaltensgetrieben pruefbar - der
// Fehler steckt in der REIHENFOLGE von Schritt und Auffrischung, nicht im
// Vorhandensein einer Wache. `state` bleibt ERREICHBAR, nicht ERSETZBAR
// (dasselbe Muster wie in shopping.js).
export const __test = {
  state,
  adjustQuantity,
  // Kopfregel mobil: die Chipreihe ist das erste Kind des Ports und muss den
  // Neuaufbau der Liste ueberleben (test-pantry-ux.js).
  renderList,
  loadPantry,
  intents,
  quantityOf,
  withIntent,
  setContainerForTest: (el) => { _container = el; },
  // Eine echte, aber knapp bemessene Frist statt eines Uhr-Objekts - wie beim
  // Sammelaktions-Automaten des Einkaufs.
  setQuantityDebounceMsForTest: (ms) => { QUANTITY_DEBOUNCE_MS_OVERRIDE = ms; },
  // Aufraeumen am ANFANG: `_pantryLoadSeq` waechst global weiter, und eine
  // Bestaetigung aus einem frueheren Fall schuetzt sonst den Artikel des
  // naechsten vor seiner eigenen Auffrischung.
  resetLoadOrderForTest: () => { _pantryAppliedLoad = 0; settledAt.clear(); },
  // #1265 P4: der Warenkorb der Zeile und sein Handler schreiben in den
  // Einkauf - gemessen am echten Knoten und als Programm
  // (test-shopping-readonly-ui.js).
  rowEl,
  sendToShopping,
  // R10 L4: das Nebenpanel ordnet wie die Filterchips (test-pantry-ux.js).
  pantryWatchGroups,
  renderWatch,
  // Beide Wege in den Bearbeiten-Dialog (test-pantry-ux.js).
  onListClick,
  onWatchClick,
  // R16 2b: der Lösch-Wisch der Vorratszeile (test-pantry-ux.js).
  wirePantrySwipe,
  removeItem,
  // Nur-lesen im Vorrat: Leseansicht, Anlegen, Leerzustand und
  // Lagerort-Verwaltung (test-shopping-readonly-ui.js).
  READ_SAFE_ACTIONS,
  openItemModal,
  itemReadHtml,
  emptyStateEl,
  openLocationManager,
  // Tafla: Statuswort, Karte "Wymaga uwagi", Ortsreihe und Aufklappen
  // (test-pantry-ux.js).
  statusPill,
  attentionGroups,
  attentionEl,
  renderFilters,
  toggleExpanded,
  refreshOnList,
};
