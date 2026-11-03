/**
 * Modul: Dashboard-Abruf
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
 * Der Widget-Katalog (Ids, Groessen, Standard-Sichtbarkeit) ist ebenfalls
 * gegangen, mit der Haelfte von `utils/extension-widgets.js`, die ihn nutzte.
 */

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
