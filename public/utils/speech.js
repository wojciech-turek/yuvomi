/**
 * Modul: Sprache zu Text auf dem Geraet (Quick-Add, 2026-10-29)
 * Zweck: Duenne Huelle um die Spracherkennung des Browsers - auf dem iPhone
 *        Safaris `webkitSpeechRecognition`. Claude nimmt kein Audio; aus dem
 *        Gesprochenen wird HIER Text, und erst der geht an den Server
 *        (utils/task-draft.js). Kostenlos, ohne eigenen Dienst.
 *
 * Entscheidungen (test:task-dictation-ui):
 *   - Die Sprache ist pl-PL, unabhaengig von der Sprache der Oberflaeche: der
 *     Haushalt spricht Polnisch, auch wenn das Telefon Englisch anzeigt (Spec,
 *     "Calls I made").
 *   - EIN Satz: `continuous: false` endet an der ersten Pause, `interimResults`
 *     liefert den Zwischenstand fuer die Live-Mitschrift.
 *   - `onEnd` bekommt das zuletzt Gehoerte, auch wenn nichts davon als final
 *     markiert war - Safari beendet eine Erkennung gelegentlich ohne finales
 *     Ergebnis, und die Mitschrift auf dem Schirm ist, was die Person gesagt hat.
 *   - Fehlercodes gehen unveraendert weiter ('not-allowed', 'no-speech', ...);
 *     was daraus folgt, entscheidet das Blatt. Ein Erkenner, der gar nicht erst
 *     startet, meldet 'start-failed', einer, den es nicht gibt, 'not-supported' -
 *     beide nach dem Aufruf, nie als Ausnahme.
 *   - `stop()` bricht ab (`abort`, das Mikrofon ist sofort frei) und macht den
 *     Erkenner stumm: danach meldet er nichts mehr, auch kein 'aborted'.
 */

/** Ob dieser Browser Sprache erkennen kann. */
export function speechSupported(win = globalThis.window) {
  return Boolean(win && (win.SpeechRecognition || win.webkitSpeechRecognition));
}

const tidy = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * Hoert EINEN Satz.
 *
 * @param {{lang?: string, onText?: (text: string, isFinal: boolean) => void,
 *          onEnd?: (finalText: string) => void, onError?: (code: string) => void}} handlers
 * @param {object} [win]
 * @returns {{stop(): void}}
 */
export function startListening({ lang = 'pl-PL', onText = () => {}, onEnd = () => {}, onError = () => {} } = {}, win = globalThis.window) {
  let live = true;
  const later = (code) => Promise.resolve().then(() => { if (live) { live = false; onError(code); } });
  const Recognition = win?.SpeechRecognition || win?.webkitSpeechRecognition;
  if (!Recognition) {
    later('not-supported');
    return { stop() { live = false; } };
  }

  let rec;
  let lastText = '';
  try {
    rec = new Recognition();
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    rec.onresult = (event) => {
      if (!live) return;
      let finalPart = '';
      let interimPart = '';
      for (const result of Array.from(event?.results ?? [])) {
        const piece = result?.[0]?.transcript ?? '';
        if (result?.isFinal) finalPart += ` ${piece}`;
        else interimPart += ` ${piece}`;
      }
      lastText = tidy(`${finalPart} ${interimPart}`);
      onText(lastText, tidy(interimPart) === '');
    };
    rec.onerror = (event) => {
      if (live) onError(String(event?.error || 'unknown'));
    };
    rec.onend = () => {
      if (!live) return;
      live = false;
      onEnd(lastText);
    };
    rec.start();
  } catch {
    later('start-failed');
    return { stop() { live = false; } };
  }

  return {
    stop() {
      if (!live) return;
      live = false;
      try { rec.abort(); } catch { /* schon beendet */ }
    },
  };
}
