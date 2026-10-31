/**
 * Modul: Lade-Hilfen
 * Zweck: EINE geteilte Lade-Sprache fuer alle Seiten: ein stiller Ring, sonst
 *        nichts. Seit 2026-10-29 (Schnell-Erfassen, Aufgabe 2) gibt es keine
 *        Skelette mehr - die Platzhalter-Flaechen sprangen beim Eintreffen der
 *        Daten und flackerten bei schnellem Aufbau.
 * Abhaengigkeiten: keine (gibt reine HTML-Strings zurueck; Caller fuegen via
 *        insertAdjacentHTML/replaceChildren ein).
 *
 * Der Ring (.page-loading, layout.css) erscheint erst nach 300 ms: ein
 * schneller Aufbau zeigt gar nichts. Der Wrapper traegt aria-hidden="true";
 * die Lade-Semantik (aria-busy) gehoert an den umgebenden Live-Region-Container
 * des Callers.
 *
 * Die Namen renderSkeletonList/-Card/-Chart bleiben (rund 25 Aufrufer) und
 * nehmen ihre alten Optionen an; alle liefern denselben Ring.
 */

/** Der Ring fuer eine ladende Seite oder Flaeche. @returns {string} HTML */
export function loadingSpinnerHtml() {
  return '<div class="page-loading" aria-hidden="true"><span class="page-loading__spinner"></span></div>';
}

/** @returns {string} HTML (Optionen werden angenommen und ignoriert) */
export function renderSkeletonCard(_opts) {
  return loadingSpinnerHtml();
}

/** @returns {string} HTML (Optionen werden angenommen und ignoriert) */
export function renderSkeletonList(_opts) {
  return loadingSpinnerHtml();
}

/** @returns {string} HTML (Optionen werden angenommen und ignoriert) */
export function renderSkeletonChart(_opts) {
  return loadingSpinnerHtml();
}

/**
 * Legt ein Skelett in einen LEEREN Traeger, das von selbst geht, sobald der
 * Inhalt kommt (Critique R19, 2026-10-16).
 *
 * Das Muster, das es ablöst: die Einstellungs-Shell legte nach 120 ms ein
 * Skelett in jeden noch leeren Abschnitt. Ein Abschnitt, der sich zuerst
 * leert, dann wartet und danach per `insertAdjacentHTML('beforeend')` anhaengt
 * (modules-active.js), haengte seinen Inhalt HINTER das Skelett - es blieb ueber
 * dem fertigen Inhalt stehen, natuerlich in etwa 2 von 10 Laeufen, mit
 * verzoegerter Antwort fast immer. Den Fehler im Abschnitt zu beheben hiesse,
 * jeden Abschnitt einzeln zu kennen; hier raeumt das Skelett sich selbst.
 *
 * WIE: ein MutationObserver am Traeger. Sobald irgendein anderer Knoten darin
 * steht, nimmt er das Skelett heraus. Sein Rueckruf laeuft als Mikrotask, also
 * vor dem naechsten Bild: Skelett und Inhalt stehen nie gemeinsam auf dem
 * Schirm. Leert der Abschnitt den Traeger selbst (`replaceChildren`), ist das
 * Skelett ohnehin weg und der Beobachter hoert auf.
 *
 * @param {Element} host - der Traeger; nur wenn er im Dokument steht und leer ist
 * @param {string} html - Markup mit GENAU einem Wurzelelement (renderSkeletonList)
 * @param {object} [env]
 * @param {typeof MutationObserver} [env.Observer] - fuer Tests
 * @returns {Element|null} das gelegte Skelett, oder null
 */
export function placeSkeletonUntilContent(host, html, { Observer = globalThis.MutationObserver } = {}) {
  if (!host?.isConnected || host.firstChild) return null;
  host.insertAdjacentHTML('beforeend', html);
  const skeleton = host.lastElementChild;
  if (!skeleton || typeof Observer !== 'function') return skeleton ?? null;
  const observer = new Observer(() => {
    if (skeleton.parentNode !== host) {
      observer.disconnect();
      return;
    }
    for (const node of host.childNodes) {
      if (node !== skeleton) {
        skeleton.remove();
        observer.disconnect();
        return;
      }
    }
  });
  observer.observe(host, { childList: true });
  return skeleton;
}
