/**
 * Der Wand-Modus: der WACHE Zustand des Dashboards.
 *
 * PRODUCT.md nennt das Wandtablet als Kernszene, und gebaut waren dafuer bisher
 * drei Einzelteile, die sie nur einzeln bedienen: die Uhr-Kachel (#651), die
 * Wetterkarte als Opt-in und der Immich-Screensaver nach fuenf Minuten Ruhe
 * (#693). Zusammen ergaben sie keinen Zustand, sondern drei Haekchen im
 * Anpassen-Panel. Dieser Modus ist der Zustand: eine Anzeige fuer zwei bis drei
 * Sekunden aus zwei Metern Entfernung, ohne dass jemand das Geraet beruehrt.
 *
 * Er ist der WACHE Zustand - der Screensaver bleibt der ruhende und legt sich
 * nach seiner Leerlaufzeit unveraendert darueber.
 *
 * ── VIER ENTSCHEIDUNGEN, DIE HIER WOHNEN ──────────────────────────────────
 *
 * 1. EIN ZUSTAND, KEINE ROUTE. Der Modus lebt auf `/`. Ein zweiter Ort, an dem
 *    „Heute" gebaut wird, waere eine zweite Wahrheit, die auseinanderlaeuft -
 *    dieselbe Falle, die bei Modulnamen und Kachelgroessen schon zweimal
 *    zugeschlagen hat. Deshalb steht hier eine Routen-Bedingung und kein
 *    eigener Eintrag in der Routen-Tabelle.
 *
 * 2. GERAETELOKAL UND MANUELL. `localStorage`, wie Theme und Locale - und aus
 *    demselben Grund: das Wandtablet laeuft in der Praxis auf einem geteilten
 *    Konto, eine servergespeicherte Einstellung schaltete allen
 *    Familienmitgliedern das Handy-Dashboard um. Keine Automatik nach
 *    Geraeteform: eine Fehlerkennung auf dem Laptop erzeugte einen Zustand, den
 *    niemand angefordert hat und den man dann erst wieder loswerden muss.
 *
 * 3. KEINE NACHT. Bis v2 senkte der Modus zwischen 22 und 6 Uhr die
 *    Leuchtdichte ab (`data-wall-night`, die dunkle Szene "Noc" mit
 *    bernsteinfarbener Uhr). 2026-10-27, v2: light only - "kitchen tablet will
 *    be turned off for the night so dont worry about dark mode at all, keep
 *    everything light". Die Wand bleibt rund um die Uhr hell; wer sie nachts
 *    nicht sehen will, schaltet das Tablet aus (oder laesst den Bildschirm-
 *    schoner ueber ihr laufen).
 *
 * 4. REINE ANZEIGE. Der Modus ist ein Read-Zustand: die Programmzeilen sind
 *    Text, keine Links. Das steht nicht hier, sondern in den Renderern - hier
 *    steht nur, warum es keinen Kiosk-Lockdown gibt: der Modus ist eine
 *    Darstellung, keine Sicherheitsgrenze.
 *
 *    WAS "REINE ANZEIGE" NICHT HEISST: keine Knoepfe. Der Ausstieg steht seit
 *    dem ersten Tag auf der Flaeche, und seit #915 auch der Einstieg auf der
 *    Uebersicht daneben - bedienelementfrei war der Modus nie. Die Zusage ist
 *    enger und haelt dafuer: die Wand fuehrt nirgendwohin und aendert nichts am
 *    Haushalt.
 *
 *    Der Kuechentimer (#844) war der erste Fall, der das auf die Probe stellte,
 *    und er hat die Regel nicht gebrochen, sondern ihren Rand markiert. Damit
 *    der naechste Fall nicht wieder eine Einzelfallentscheidung wird, steht sie
 *    hier als AUFNAHMEREGEL statt als Ausnahme mit Verfallsdatum - ein Datum
 *    fuer etwas, das bleiben soll, waere eine Luege im Kommentar.
 *
 *    Ein Bedienelement darf auf die Wand, wenn es alle vier erfuellt:
 *      (a) es navigiert nicht - kein Link, keine Route, kein Modal, das die
 *          Flaeche verlaesst;
 *      (b) es aendert nichts am Haushalt - kein Schreibzugriff auf den Server,
 *          nichts, was auf einem zweiten Geraet ankommt;
 *      (c) es bleibt auf diesem Geraet - Zustand in localStorage, wie der Modus
 *          selbst, aus demselben Grund (geteiltes Konto, siehe 2.);
 *      (d) es ist aus zwei Metern bedienbar - wenige grosse Ziele, keine
 *          Eingabefelder, keine Auswahl-Ebene davor.
 *    Was eine davon reisst, gehoert nicht hierher, sondern in die App.
 *
 *    COOK MODE (fork, 2026-10-19) is the one deliberate exception to (a): the
 *    "Gotuj" button on today's meal opens the full-screen cook view
 *    (components/cook-mode.js). It still meets (b)-(d): it reads the recipe,
 *    writes nothing, keeps its timers on this device and is built for wet hands.
 *
 *    TAFLA (2026-10-19): DIE AUSNAHME VON (b) HAT EINEN SCHALTER. Die Wand ist
 *    weiter standardmaessig schreibgeschuetzt. Erst wenn ein Administrator
 *    „Pozwól odhaczać na ścianie" einschaltet (Einstellungen › Tablet w kuchni,
 *    `wall_allow_ticking`), bekommen die Aufgabenzeilen ihre Ringe, die
 *    Einkaufskarte ihre „+"-Chips und der Sonntagabend die Frage der Woche -
 *    und auch dann nur ueber die Routen, die ein Display ohnehin erreicht.
 *    Durchgesetzt am Server (services/wall-settings.js), nicht hier. Minutnik
 *    und Gotuj schreiben nichts und gehen immer; der Minutnik erfuellt (a)-(d)
 *    weiter ohne Ausnahme.
 *
 * ── WARUM DIE ATTRIBUTE AN DER WURZEL HAENGEN ─────────────────────────────
 *
 * Der Modus blendet Sidebar und Tab-Leiste aus, und beide sind Shell-Elemente
 * ausserhalb des Seiten-Containers. Ein Zustand, den nur das Dashboard-Markup
 * traegt, erreichte sie nicht. `data-wall-mode` an `<html>` ist derselbe
 * Mechanismus, mit dem `household-solo` reines Layout erreicht: eine Quelle,
 * zwei Wege.
 */

const WALL_KEY = 'yuvomi-wall-mode';

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    // Privatmodus/Quota: der Modus gilt dann fuer diese Sitzung nicht.
    return null;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Siehe safeGet - ein nicht schreibbarer Storage darf nichts abbrechen.
  }
}

function safeRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Siehe safeGet.
  }
}

/** Ist der Modus auf DIESEM Geraet eingeschaltet? */
export function isWallModeEnabled() {
  return safeGet(WALL_KEY) === '1';
}

/** Schaltet den Modus auf diesem Geraet ein oder aus. */
export function setWallModeEnabled(enabled) {
  if (enabled) safeSet(WALL_KEY, '1');
  else safeRemove(WALL_KEY);
}

/**
 * Die eine Stelle, an der steht, wo der Modus gilt.
 *
 * Er ist ein Zustand des Dashboards, also genau dessen Route. Ein Vergleich
 * ohne diesen Namen waere die Sorte Bedingung, die beim naechsten Routen-Umbau
 * still stehen bleibt.
 */
export function isWallRoute(path) {
  return path === '/';
}

/**
 * Laeuft auf diesem Pfad die Wand? Schalter des Geraets UND Route.
 *
 * Aus Ablage und Pfad gerechnet, nicht aus dem Attribut der Wurzel gelesen
 * (`isWallActive`): die Glocke der Shell fragt beim Kaltstart, bevor
 * `syncWallMode` das Attribut gesetzt hat (reminders.js).
 */
export function wallShowsOn(path = location.pathname) {
  return isWallModeEnabled() && isWallRoute(path);
}

/** Laeuft die Flaeche gerade als Wand? Liest den Zustand, den `syncWallMode` setzt. */
export function isWallActive() {
  return document.documentElement.hasAttribute('data-wall-mode');
}

/**
 * Bringt das Wurzel-Attribut auf den Stand von Route und Schalter.
 *
 * Idempotent und billig: der Minutentakt der Uhr ruft sie mit. Sie ist die
 * EINZIGE Stelle, die das Attribut setzt (seit v2 nur noch `data-wall-mode` -
 * die Nacht ist gegangen).
 *
 * @param {string} path Der aktive Pfad.
 * @returns {boolean} Ob die Wand danach laeuft.
 */
export function syncWallMode(path = location.pathname) {
  const root = document.documentElement;
  const active = wallShowsOn(path);
  root.toggleAttribute('data-wall-mode', active);
  return active;
}

/** Schaltet den Modus aus und raeumt die Wurzel sofort auf. */
export function exitWallMode() {
  setWallModeEnabled(false);
  syncWallMode(location.pathname);
}

/**
 * Gegenstueck zu `exitWallMode`, und erst seit #915 ueberhaupt vorhanden.
 *
 * Der Modus liess sich nur unter Einstellungen -> Persoenlich -> Darstellung
 * einschalten, verlassen aber auf der Uebersicht: man ging dort hinaus, wo man
 * nicht hineinkam. Der Weg ueber die Einstellungen bleibt - er ist der
 * ausfuehrliche, mit Erklaerung daneben; dies ist der kurze am Ort der Wirkung.
 */
export function enterWallMode() {
  setWallModeEnabled(true);
  _entryFocus = true;
  syncWallMode(location.pathname);
}

/* DER START GIBT DEN FOKUS AN DIE FLAECHE (R20 D4). Seit v2 (2026-10-27)
 * startet die Wand aus „Więcej" und kommt per Navigation auf `/` - in einer
 * neuen Seite, die von diesem Start nichts weiss. Die Absicht steht deshalb
 * hier, beim Start selbst; die Uebersicht nimmt sie beim ersten Zeichnen der
 * Wand einmal (`takeWallEntryFocus`) und setzt den Fokus auf `#wall-surface`. */
let _entryFocus = false;

/** True once after `enterWallMode()`: the wall's first drawing takes the focus. */
export function takeWallEntryFocus() {
  const wanted = _entryFocus;
  _entryFocus = false;
  return wanted;
}
