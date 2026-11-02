/**
 * Modul: Dashboard-Abruf und Widget-Restbestand
 * Zweck: Der Abruf der Uebersicht und der Erinnerungen fuer die Flaeche, die
 *        ihn zeichnet (`dashboardRequest`), der geteilte Erinnerungs-Abruf
 *        (`fetchPendingReminders`, `forgetPendingReminders`) und die Frage, ob
 *        eine Abfrage die Zahlen der Antwort veraendert
 *        (`dashboardQueryFiltersCounts`).
 * Abhängigkeiten: keine
 *
 * HEUTE IST FUER ALLE DASSELBE (One-Today-Runde, 2026-11-02): kein Layout je
 * Person, keine Haushaltsvorgabe, keine Widget-Optionen. Die Normalisierung
 * eines gespeicherten Layouts und die Uebersetzung von Optionen in
 * Abfrage-Parameter sind mit ihnen gegangen.
 *
 * NOCH DA, WEIL `utils/extension-widgets.js` SIE IMPORTIERT (Aufgabe 2 der
 * Runde entfernt beide Seiten): `WIDGET_IDS`, `WIDGET_SIZE_OPTIONS`,
 * `nearestPreset`, `defaultWidgetSize`, `defaultWidgetVisible`,
 * `DEFAULT_HIDDEN_WIDGETS` samt dem, was sie brauchen.
 */

// Reihenfolge = Standard-Layout. Die primären Inhalte (tasks, calendar) führen,
// damit sie beim Wieder-Einblenden oben stehen; das einzige passive Widget
// (weather) steht bewusst am Ende, statt die sichtbare Grid-Spitze zu belegen.
/* DIE REIHENFOLGE DIESER LISTE IST SEIT 2026-08-13 FREI - sie war es vorher
 * nicht. Bis dahin hängte `normalizeDashboardConfig` eine neu bekannte Id an
 * bestehende Layouts HINTEN an, und ein Vergleich gegen genau diese Liste
 * (`isUserOrderedConfig`) las jedes Bestandslayout als „umsortiert", sobald
 * eine neue Id vor einer bestehenden stand - das Raster schaltete dann
 * stillschweigend von der dichten Packung auf die Quellordnung um (Audit A1-03).
 * Der Merge sortiert eine fehlende Id seitdem an ihrer Default-Position ein.
 *
 * SEIT 2026-09-23 GIBT ES DEN VERGLEICH NICHT MEHR, und die Einsortierung
 * bleibt trotzdem richtig. Das Raster packt jetzt IMMER dicht (siehe `packGrid`
 * unten), eine Umsortierung schaltet nichts mehr um. Die Default-Position ist
 * aber weiter der Ort, an dem ein Neuzugang erscheint, und der Guard
 * „eine fehlende Id landet an ihrer Default-Position" haelt das fest. */
/* TAFLA (2026-10-19): Dziś is a day plan, not a widget board. Its sections are
 * entries of the SAME per-person layout, so the household default, "reset" and
 * every saved arrangement carry over: `today-weather` is the weather line in
 * the header, the other four are the sections below "Plan dnia". They lead the
 * list, so a saved layout that predates them gets them on top, in this order
 * (normalizeDashboardConfig inserts a missing id at its default position). */
export const TODAY_SECTION_IDS = Object.freeze(['today-weather', 'today-shopping', 'today-tomorrow', 'today-question', 'today-soon']);
export const WIDGET_IDS = [...TODAY_SECTION_IDS, 'tasks', 'calendar', 'meals', 'shopping', 'pantry', 'birthdays', 'countdown', 'budget', 'health', 'cycle', 'fasting', 'nutrition', 'housekeeping', 'schedule', 'waste', 'family', 'notes', 'weather', 'clock', 'metrics', 'quicklinks'];

// Vier kuratierte Formen statt sechs: über vier Auswahlmöglichkeiten pro Widget
// (× bis zu 12 Widgets) kippt der Anpassen-Modus in Mikro-Entscheidungs-Overhead
// für ein Familienpublikum (Critique P2, ≤4-Choices-Regel). Die früheren 3x2/4x2
// bleiben als Legacy-Werte gültig (WIDGET_SIZE_OPTIONS) — bestehende Layouts werden
// nicht zurückgesetzt, nur die Neu-Auswahl steuert auf diese vier zu.
export const WIDGET_SIZE_PRESETS = [
  { value: '1x1', labelKey: 'dashboard.widgetSizeTiny'     },
  // 2 Spalten x 1 Zeile ist BREIT. Der Schluessel hiess `widgetSizeNarrow`
  // („Schmal (2×1)"), und wer das woertlich nahm, bekam das Gegenteil
  // (Re-Critique 2026-09-27, W2).
  { value: '2x1', labelKey: 'dashboard.widgetSizeWide'     },
  { value: '1x2', labelKey: 'dashboard.widgetSizeTall'     },
  // 2x2 ist die GROESSTE der vier Formen, aber keine ist mehr der Vorschlag:
  // defaultWidgetSize() liefert 1x2, 2x1 oder 1x1. Der Schluessel hiess
  // `widgetSizeStandard` („Standard (2×2)") und behauptete damit einen
  // Ausgangswert, den es nicht gibt (#1723). Der Name sagt jetzt die Form.
  { value: '2x2', labelKey: 'dashboard.widgetSizeSquare'   },
];

// Alle bekannten Größen inkl. Legacy-Werte — für normalizeDashboardConfig-Validierung
export const WIDGET_SIZE_OPTIONS = [...new Set([
  ...WIDGET_SIZE_PRESETS.map((p) => p.value),
  '1x2', '1x3', '1x4', '2x3', '2x4', '3x1', '3x3', '3x4', '4x1', '4x3', '4x4',
])];

// Bildet einen beliebigen (auch Legacy-)Größenwert auf das nächstliegende der vier
// kuratierten Presets ab: Breite/Höhe ≥2 → 2, sonst 1. So kann normalizeDashboardConfig
// migrierte Layouts (z.B. 4x2 aus einer früheren Version) auf ein Preset zusammenziehen,
// statt dem betroffenen Nutzer als einziger eine 5. Dropdown-Option zu zeigen (Critique P2).
export function nearestPreset(size) {
  const values = WIDGET_SIZE_PRESETS.map((p) => p.value);
  if (values.includes(size)) return size;
  const [cols, rows] = String(size).split('x').map(Number);
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return '1x1';
  return `${cols >= 2 ? 2 : 1}x${rows >= 2 ? 2 : 1}`;
}

export function defaultWidgetSize(id) {
  // Listen-Widgets defaulten auf schmal-hoch (1×2) statt breit-hoch (2×2): eine
  // „Heute"-Liste braucht Höhe, nicht Breite — 1×2 halbiert die Grundfläche und
  // packt sich sauber neben andere Widgets, statt als 2-spaltige Kachel eine
  // ganze Rasterzeile zu belegen (löst die Masonry-Imbalance an der Wurzel).
  // Inhaltsschwere Karten (gestapelte Blöcke) starten hoch statt 1×1, damit die
  // Zeile nicht per grid-auto ragged nachwächst (Critique P4). Budget stapelt
  // Saldo + Sparen + Einnahme/Ausgabe + Top-Ausgabe → 1×2; family stapelt seit
  // dem „Heute dran"-Umbau Mitglieder-Zeilen und braucht dieselbe Höhe.
  //
  // NOTIZEN UND GEBURTSTAGE GEHOEREN IN DIESELBE LISTE, und dass sie es nicht
  // taten, hat man am Standard-Desktop gesehen: sichtbar sind ab Werk genau
  // vier Widgets - Geburtstage (1x1), Budget (1x2), Familie (1x2), Notizen
  // (2x1). Vier Spalten fassen die drei hohen nebeneinander, die breite
  // Notizkachel passt daneben nicht mehr und faellt eine Zeile tiefer; was
  // bleibt, ist das Loch rechts unten, das `dense` nicht schliessen kann,
  // weil kein Widget mehr uebrig ist. Beide sind Listen wie die anderen und
  // brauchen Hoehe, nicht Breite: mit 1x2 fuellen die vier Standard-Widgets
  // die Zeile lueckenlos. Bestandslayouts bleiben unberuehrt - gespeichert
  // wird die Groesse, nicht dieser Default.
  // `countdown` steht bei den Geburtstagen, weil es dieselbe Kachel ist: eine
  // nach Nähe sortierte Liste aus Name und „noch so lange". Es ist zugleich das
  // einzige Widget, das erst existiert, sobald jemand etwas markiert hat -
  // siehe die Verfügbarkeitsregel in pages/dashboard.js.
  // `schedule` joins `family` for the same reason: it too is a member list -
  // avatar, name, shift - and left at the 1x1 default it rendered 318px against
  // the 218px the size class promised, stretching whatever shared its grid row
  // (PR #930 review).
  // `pantry` („Laeuft bald ab") ist dieselbe Kachel wie die Geburtstage: eine
  // nach Naehe sortierte Liste aus Name und „noch so lange".
  if (['tasks', 'calendar', 'budget', 'family', 'notes', 'birthdays', 'countdown', 'schedule', 'waste', 'pantry'].includes(id)) return '1x2';
  // Die Uhr startet breit statt quadratisch: Uhrzeit und darunter der ausgeschriebene
  // Wochentag brauchen Zeile, nicht Höhe - auf 1x1 bräche das Datum um (#651).
  // `quicklinks` steht bei der Uhr und nicht bei den Listen: es ist eine ZEILE
  // aus Kacheln (#469), keine Liste aus Zeilen. Auf 1x1 passten zwei davon
  // nebeneinander, und eine Startrampe mit zwei Plaetzen ist keine.
  // `nutrition` steht hier und nicht bei den Listen: die Kachel zeigt eine
  // Fortschrittszeile je Naehrwert, also Balken nebeneinander - sie braucht
  // Zeile, nicht Hoehe, genau wie das Fasten daneben.
  if (['weather', 'shopping', 'health', 'cycle', 'fasting', 'nutrition', 'meals', 'clock', 'quicklinks'].includes(id)) return '2x1';
  // DIE KENNZAHLREIHE IST EINE ZEILE, KEIN BLOCK (Critique 2026-08-13, P1).
  //
  // Hier stand '2x2' mit der Begruendung, das Raster sei der Vergleich, fuer den
  // die Reihe gebaut ist. Gerendert war das Ergebnis ein anderes: 753x671px bei
  // 1440x900, vier Kacheln zu je 372x330px fuer einen Inhalt von rund 80px
  // Hoehe. Die eigene Zusage der Mitteilung lautete „in der Hoehe, die ein
  // Widget-Kopf kostet" - das sind 44px. Faktor 15.
  //
  // Vier Kacheln nebeneinander vergleichen sich genauso wie vier im Quadrat,
  // und sie tun es in einer Zeile statt in einem Drittel des Schirms. Das
  // 2x2-Raster bleibt waehlbar, es ist nur nicht mehr der Vorschlag.
  // Bestandslayouts bleiben unberuehrt - gespeichert wird die Groesse, nicht
  // dieser Default.
  if (id === 'metrics') return '2x1';
  return '1x1';
}

// Standardmäßig ausgeblendet: die vier vom Cockpit abgedeckten Domänen (kein Echo)
// plus die spezialisierten Module und Widgets (unter anderem Health, fasting,
// Haushaltshilfe und Abfall). Sie sind nicht in jedem Haushalt aktiv und erscheinen als Opt-in im
// „Anpassen"-Panel, statt frische Dashboards mit leeren Kacheln zu überladen
// (PRODUCT.md: „Power wird auf Abruf enthüllt, nicht in einem Raster ausgebreitet").
// `clock` kommt dazu: auf einem Gerät mit Statusleiste ist eine zweite Uhr
// Doppelung. Ihren Zweck erfüllt sie am Wandtablet ohne Systemleiste (#651) -
// das ist ein bewusster Aufbau, kein Standardfall.
// `weather` ebenso (Seele-Paket): das Wetter spricht als Masthead-Zeile unterm
// Gruß; die große Karte mit Vorhersage ist der Wandtablet-Opt-in im Tray.
// Bestandslayouts behalten ihre gespeicherte Sichtbarkeit - dort entfällt
// stattdessen die Masthead-Zeile (kein Echo).
// `quicklinks` reiht sich bei den Opt-ins ein, und zwar aus dem staerksten der
// hier genannten Gruende: die Reihe ist am ersten Tag LEER. Sichtbar ab Werk
// haette jeder Haushalt - auch jeder bestehende, denn eine neu bekannte Id erbt
// diesen Default - eine Kachel bekommen, die nichts zeigt und um Einrichtung
// bittet. Sie steht im Anpassen-Tray und kommt, wenn jemand sie holt.
// `nutrition` steht bei den Opt-ins aus demselben Grund wie `fasting`: ein
// Tagebuch fuehrt, wer es fuehren will. Und der Eintrag hier ist nicht
// Kosmetik - eine Id, die in dieser Menge FEHLT, ist nach dem Update in JEDEM
// bestehenden Haushalt eingeblendet, weil `normalizeDashboardConfig` eine neu
// bekannte Id mit `defaultWidgetVisible(id)` einsortiert.
// `pantry` („Laeuft bald ab", Critique 2026-09-23) aus demselben Grund: nicht
// jeder Haushalt fuehrt Mindesthaltbarkeiten, und ein frisches Dashboard mit
// einer Kachel „nichts laeuft ab" waere die Ueberladung, die diese Menge
// verhindern soll.
// Die Domaenen, die Dziś selbst als Plan zeigt - ihre alten Kacheln starten aus.
const COCKPIT_COVERED_WIDGETS = new Set(['tasks', 'calendar', 'shopping', 'meals']);

export const DEFAULT_HIDDEN_WIDGETS = new Set([...COCKPIT_COVERED_WIDGETS, 'health', 'cycle', 'fasting', 'nutrition', 'housekeeping', 'schedule', 'waste', 'pantry', 'clock', 'weather', 'quicklinks']);

export function defaultWidgetVisible(id) {
  return !DEFAULT_HIDDEN_WIDGETS.has(id);
}

/**
 * Der Abruf der Uebersicht fuer die Flaeche, die ihn zeichnet (#1817).
 *
 * DIE WAND FRAGT DIE HAUSHALTSFASSUNG AB (`audience=household`): sie ist eine
 * geteilte Flaeche, kein persoenlicher Bildschirm, und zeigt nur, was der ganze
 * Haushalt sehen darf - gleich, aus wessen Sitzung sie geoeffnet wurde. Der
 * Server liefert dafuer eine engere Antwort; hier wird nichts weggefiltert, was
 * schon im Browser liegt. Die normale Uebersicht fragt ohne den Parameter und
 * bleibt persoenlich.
 *
 * Dasselbe gilt fuer die faelligen Erinnerungen (`/reminders/pending`), die
 * zweite Antwort der Seite, die davon abhaengt, wer fragt: die Wand haengt den
 * Parameter auch dort an und bekommt keine.
 *
 * @param {string} query '/dashboard' oder '/reminders/pending'
 * @param {{ wall?: boolean }} [surface]
 * @returns {string}
 */
export function dashboardRequest(query, { wall = false } = {}) {
  const text = String(query ?? '/dashboard');
  if (!wall) return text;
  return `${text}${text.includes('?') ? '&' : '?'}audience=household`;
}

/* EIN ABRUF DER FAELLIGEN ERINNERUNGEN FUER GLOCKE UND UEBERSICHT (Critique
 * R19, Nachlese 1b). `/reminders/pending` ging beim Start zweimal hinaus: die
 * Glocke (reminders.js) fragte gleich nach der Anmeldung, das Heute-Blatt der
 * Uebersicht (pages/dashboard.js) 0,7 s spaeter dieselbe Adresse - am
 * gedrosselten Telefon eine Rundreise mehr auf einer der sechs Verbindungen,
 * genau waehrend die Uebersicht ihre Module laedt.
 *
 * Wer dieselbe Adresse innerhalb von PENDING_SHARE_MS nach dem letzten Abruf
 * fragt, bekommt dessen Versprechen - laufend oder schon erfuellt. Die Adresse
 * traegt die Reichweite (dashboardRequest oben), also teilen nur Fragen mit
 * derselben Antwort. Ein Fehler wird nicht geteilt. `fresh` (die Glocke nach
 * einer eigenen Aenderung) fragt immer neu, `forgetPendingReminders()`
 * verwirft das Gemerkte - beim Wegklicken und beim Abmelden, damit nie die
 * Antwort einer frueheren Sitzung weitergereicht wird.
 *
 * Es steht HIER, weil beide Aufrufer diese Datei schon laden: ein eigenes
 * Modul war eine Datei mehr in der Startkette und kostete gemessen mehr, als
 * der gesparte Abruf brachte. Den Abruf selbst (`get`, api.get) reicht der
 * Aufrufer herein - diese Datei importiert nichts aus dem Browser. */
export const PENDING_SHARE_MS = 2000;
let sharedPending = null;

/**
 * @param {string} path - '/reminders/pending' samt Reichweite
 * @param {{ get: (path: string) => Promise<any>, fresh?: boolean, now?: number }} options
 * @returns {Promise<any>}
 */
export function fetchPendingReminders(path, { get, fresh = false, now = Date.now() }) {
  if (!fresh && sharedPending && sharedPending.path === path && now - sharedPending.at < PENDING_SHARE_MS) {
    return sharedPending.promise;
  }
  const promise = Promise.resolve().then(() => get(path));
  const entry = { path, at: now, promise };
  sharedPending = entry;
  promise.catch(() => { if (sharedPending === entry) sharedPending = null; });
  return promise;
}

/** Das Gemerkte verwerfen (Erinnerung weggeklickt, Abmeldung). */
export function forgetPendingReminders() {
  sharedPending = null;
}

/**
 * Die Navigations-Badges und Modulkacheln nehmen die `/dashboard`-Antwort der
 * Seite nur an, wenn sie ungefiltert ist (router.js, `primeModuleCountsFrom`).
 * Seit es keine Optionen mehr gibt, ist der einzige Parameter `audience`
 * (die Haushaltsfassung der Wand): jeder Parameter gilt als Filter.
 *
 * @param {string} query Pfad der Uebersichts-Abfrage ('/dashboard' oder '/dashboard?…')
 * @returns {boolean} true, wenn die Antwort darauf andere Zahlen tragen kann als die ungefilterte
 */
export function dashboardQueryFiltersCounts(query) {
  const text = String(query ?? '');
  const at = text.indexOf('?');
  if (at === -1) return false;
  return [...new URLSearchParams(text.slice(at + 1)).keys()].length > 0;
}
