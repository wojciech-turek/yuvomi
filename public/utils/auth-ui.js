/**
 * Modul: Bausteine der Auth-Seiten (auth-ui)
 * Zweck: EIN Kopf, EIN Passwortfeld, EIN Fehlerfeld fuer Anmeldung,
 *        Ersteinrichtung, Einladung und Passwort-Reset.
 * Abhaengigkeiten: /utils/html.js
 *
 * WARUM (Critique 2026-10-05, R16 "Bausteine werden nicht vererbt"): die fuenf
 * Seiten vor der Anmeldung bauten dieselben drei Dinge je selbst.
 * - Die Marke stand nur auf der Anmeldung; Einrichtung, Einladung und Reset
 *   begannen ohne ein Zeichen, wessen Seite das ist - ausgerechnet dort, wo
 *   jemand ueber einen Link aus einer E-Mail ankommt.
 * - Das Auge am Passwortfeld gab es auf Anmeldung und Einrichtung (zweimal
 *   derselbe Code), auf Einladung und Reset nicht - dort tippt man ein NEUES
 *   Passwort zweimal blind.
 * - Das Fehlerfeld stand in drei Fassungen da: `role="alert"` mit
 *   `tabindex="-1"`, `role="alert"` mit `aria-live="polite"` (ein Widerspruch:
 *   alert ist assertiv) und beides gemischt.
 */
import { esc } from '/utils/html.js';

const DEFAULT_APP_NAME = 'Yuvomi';

/* TAFLA (2026-10-20, artboard "Logowanie"): the pages before the app carry the
 * house - Lucide `house`, inline because these pages draw before any icon
 * pass - in the accent on its tint, not the brand tile. The brand mark stays
 * the app's own picture (sidebar, loading screen, home-screen icon); here the
 * page says "your home", calm on paper. */
const HOUSE_GLYPH = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"></path><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>';

const LOCK_GLYPH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>';

/**
 * The quiet footnote under the sign-in form: "<host> · połączenie szyfrowane",
 * and only when it is true - served over https. Over plain http (a test copy,
 * a LAN address) the line stays empty instead of promising what is not so.
 *
 * @param {Location|{ protocol: string, host: string }} loc
 * @param {(host: string) => string} text  translated sentence for the host
 * @returns {string} HTML ('' without https)
 */
export function authSecureNoteHtml(loc, text) {
  if (loc?.protocol !== 'https:' || !loc.host) return '';
  return `${LOCK_GLYPH}<span>${esc(text(loc.host))}</span>`;
}
const APP_NAME_STORAGE_KEY = 'yuvomi-app-name';

/** Der Name, unter dem dieser Haushalt die App fuehrt (zuletzt vom Server gemeldet). */
export function getStoredAppName() {
  try {
    return localStorage.getItem(APP_NAME_STORAGE_KEY) || DEFAULT_APP_NAME;
  } catch {
    return DEFAULT_APP_NAME;
  }
}

/**
 * Der Kopf einer Auth-Seite: Marke, Name, optional ein Satz darunter.
 *
 * `heading: true` macht den Namen zur <h1> (Anmeldung, Einrichtung - die Karte
 * darunter traegt keinen eigenen Titel). `false` setzt ihn als Absatz ueber
 * eine Karte, die ihre eigene <h1> hat (Einladung, Reset): eine Seite, eine h1.
 *
 * @param {object} o
 * @param {string} [o.appName]
 * @param {string} [o.tagline]
 * @param {boolean} [o.heading=true]
 */
export function authHeroHtml({ appName = getStoredAppName(), tagline = '', heading = true } = {}) {
  const tag = heading ? 'h1' : 'p';
  return `
      <div class="auth-hero${heading ? '' : ' auth-hero--compact'}">
        <span class="auth-hero__mark" aria-hidden="true">${HOUSE_GLYPH}</span>
        <${tag} class="auth-hero__title">${esc(appName)}</${tag}>
        ${tagline ? `<p class="auth-hero__tagline">${esc(tagline)}</p>` : ''}
      </div>`;
}

/**
 * Das eine Fehlerfeld. `role="alert"` sagt den Fehler sofort an (und bringt
 * sein eigenes, assertives Live-Verhalten mit - kein `aria-live` daneben);
 * `tabindex="-1"` laesst die Seite den Fokus darauf setzen, damit auch
 * sehende Tastaturnutzer dort landen, wo die Meldung steht.
 */
export function authErrorHtml(id) {
  return `<div class="form-error" id="${esc(id)}" role="alert" tabindex="-1" hidden></div>`;
}

/**
 * Das Auge am Passwortfeld: umhuellt das Feld und haengt den Umschalter an.
 * Ein echter Knopf nach dem Feld in der Tab-Folge, sein Name nennt, was der
 * naechste Druck tut ("Passwort anzeigen" / "Passwort verbergen").
 *
 * @param {HTMLInputElement|null} input
 * @param {{ show: string, hide: string }} labels  schon uebersetzt
 * @returns {HTMLButtonElement|null}
 */
export function wirePasswordToggle(input, { show, hide }) {
  if (!input?.parentNode) return null;
  const wrapper = document.createElement('div');
  wrapper.className = 'input-password-wrapper';
  input.parentNode.insertBefore(wrapper, input);
  wrapper.appendChild(input);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'password-toggle';
  toggle.setAttribute('aria-label', show);
  const icon = document.createElement('i');
  icon.setAttribute('data-lucide', 'eye');
  icon.setAttribute('aria-hidden', 'true');
  toggle.appendChild(icon);
  wrapper.appendChild(toggle);
  if (window.lucide) window.lucide.createIcons({ el: toggle });

  toggle.addEventListener('click', () => {
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    // Lucide ersetzt das <i> durch ein <svg>: das Zeichen wird neu gesetzt,
    // nicht umgeschrieben.
    const next = document.createElement('i');
    next.setAttribute('data-lucide', reveal ? 'eye-off' : 'eye');
    next.setAttribute('aria-hidden', 'true');
    toggle.replaceChildren(next);
    toggle.setAttribute('aria-label', reveal ? hide : show);
    if (window.lucide) window.lucide.createIcons({ el: toggle });
  });
  return toggle;
}
