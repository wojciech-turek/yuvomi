/**
 * Modul: Seitenblaetter
 * Zweck: Jedes Seitenblatt (`/styles/<modul>.css`, auth.css, more.css) laedt
 *        EINMAL je Dokument und bleibt; ein Tab-Wechsel schaltet nur um,
 *        welches gilt.
 *
 * WARUM (Schnell-Erfassen 2026-10-29, Aufgabe 3 - "warum gibt es in der PWA
 * eine Verzoegerung beim Tab-Wechsel, das sollte sofort gehen"). Gemessen mit
 * Fast 4G (165 ms Latenz), in Chromium und in WebKit: jeder Wechsel zurueck
 * auf einen eben besuchten Tab wartete rund 210 ms vom Tipp bis zum Tausch.
 * Der Router legte je Wechsel einen NEUEN <link> an und warf den alten weg;
 * Blaetter gehen mit `no-cache` raus, und der Service Worker holt *.css
 * network-first. Jeder Wechsel wartete also eine Rundreise ab.
 *
 * JETZT: ein <link rel="stylesheet"> je Adresse fuer die Lebensdauer der Seite.
 * Was nicht gilt, ruht: geladen und geparst, aber ohne Wirkung. Zurueck auf
 * einen besuchten Tab ist eine Zuweisung, kein Abruf.
 *
 * OB EIN BLATT GILT, STEHT AM STYLESHEET, NICHT AM ATTRIBUT. Das ist die
 * zweite Messung: WebKit (Safari, die installierte App auf dem iPhone) holt
 * ein Blatt bei JEDER Aenderung des `media`-Attributs neu vom Netz und wendet
 * es erst danach an - vier Wechsel, vier Abrufe, und dazwischen gilt der alte
 * Stand. Ein Umschalten ueber das Attribut haette die neue Seite auf dem
 * iPhone sofort, aber eine Rundreise lang ungestylt gezeigt. `link.disabled`
 * holt dort ebenfalls neu. `sheet.media.mediaText` wirkt in WebKit und
 * Chromium sofort und ohne Abruf. Das Attribut traegt deshalb nur den
 * Anfangszustand: `media="not all"` fuer ein gewaermtes Blatt (geholt, aber
 * ohne Wirkung und ohne zu blockieren), keins fuer ein sofort gebrauchtes.
 * Geaendert wird es nur, solange das Blatt noch unterwegs ist - dann kostet es
 * nichts.
 *
 * `warm()` legt Blaetter ruhend an, damit auch der erste Besuch nicht wartet.
 * Vorher tat das `rel=prefetch`: Safari kennt es nicht, und wegen `no-cache`
 * holte der Link das Blatt danach ohnehin noch einmal.
 *
 * Ein Blatt, das nicht kam (offline, Serverfehler), wird beim naechsten
 * `load()` neu angelegt - ersetzt, nicht verdoppelt. Der Fehler haelt die Seite
 * nicht auf: ein fehlendes Blatt ist ein Schoenheitsfehler.
 */

/** Medium eines ruhenden Blatts. */
const RESTING = 'not all';
/** Medium eines geltenden Blatts. */
const SHOWN = 'all';

const NOTHING_TO_DO = () => ({ ready: Promise.resolve(), cleanup() {}, abandon() {} });

/**
 * @param {Document} [doc]
 * @returns {{
 *   load(href: string): { ready: Promise<void>, cleanup(): void, abandon(): void },
 *   warm(hrefs: string[]): void,
 * }}
 */
export function createPageStyles(doc = document) {
  /** @type {Map<string, { link: HTMLLinkElement, state: 'loading'|'loaded'|'failed', shown: boolean, settled: Promise<void> }>} */
  const sheets = new Map();
  /** Das Blatt der Seite, die steht oder gerade kommt. */
  let active = null;

  /** Schaltet ein Blatt um - am Stylesheet, sobald es eines gibt. */
  function show(entry, shown) {
    entry.shown = shown;
    const sheet = entry.state === 'loaded' ? entry.link.sheet : null;
    if (sheet) {
      // Nur schreiben, was sich aendert: jede Zuweisung stoesst die
      // Stilberechnung der ganzen Seite an.
      if ((sheet.media.mediaText !== RESTING) !== shown) sheet.media.mediaText = shown ? SHOWN : RESTING;
      return;
    }
    // Noch unterwegs: was nicht gelten soll, kommt ruhend an. Das Attribut
    // darf sich hier aendern - es ist noch nichts geladen, was neu kaeme.
    if (!shown && entry.state === 'loading' && entry.link.getAttribute('media') !== RESTING) {
      entry.link.setAttribute('media', RESTING);
    }
  }

  function add(href, shown) {
    const link = doc.createElement('link');
    link.setAttribute('rel', 'stylesheet');
    link.setAttribute('href', href);
    if (!shown) link.setAttribute('media', RESTING);
    const entry = { link, state: 'loading', shown, settled: null };
    entry.settled = new Promise((resolve) => {
      link.onload = () => {
        entry.state = 'loaded';
        // Gilt, was inzwischen gewuenscht ist - ein gewaermtes Blatt kann
        // aktiviert, ein angefordertes ueberholt worden sein.
        show(entry, entry.shown);
        resolve();
      };
      link.onerror = () => {
        entry.state = 'failed';
        resolve();
      };
    });
    sheets.set(href, entry);
    doc.head.appendChild(link);
    return entry;
  }

  return {
    /**
     * Das Blatt einer Seite anfordern. `ready` loest auf, sobald es gilt (oder
     * scheiterte); `cleanup()` legt danach das vorige still, `abandon()` nimmt
     * die Anforderung zurueck und laesst das vorige gelten.
     */
    load(href) {
      let entry = sheets.get(href);
      if (entry && entry === active) return NOTHING_TO_DO();
      if (entry?.state === 'failed') {
        entry.link.remove();
        entry = null;
      }
      if (entry) show(entry, true);
      else entry = add(href, true);

      const previous = active;
      const mine = entry;
      active = mine;
      return {
        ready: mine.state === 'loaded' ? Promise.resolve() : mine.settled,
        cleanup() {
          if (previous && previous !== active) show(previous, false);
        },
        abandon() {
          if (active !== mine) return;
          show(mine, false);
          active = previous;
          if (previous) show(previous, true);
        },
      };
    },

    /** Legt unbekannte Blaetter ruhend an - der Browser holt sie im Hintergrund. */
    warm(hrefs) {
      for (const href of hrefs ?? []) {
        if (href && !sheets.has(href)) add(href, false);
      }
    },
  };
}

/**
 * Gilt ein Blatt mit dieser Adresse im Dokument? Ein ruhendes Seitenblatt
 * steht auch in `document.styleSheets` - es zaehlt nicht.
 * @param {string} href - z. B. '/styles/tasks.css'
 * @param {Document} [doc]
 */
export function isStyleApplied(href, doc = document) {
  return [...doc.styleSheets].some((sheet) => (sheet.href ?? '').endsWith(href)
    && !sheet.disabled && sheet.media?.mediaText !== RESTING);
}

/**
 * Das Blatt einer Seite sicherstellen, wenn ihr Formular von AUSSEN aufgeht
 * (Kalender, Mahlzeiten, Aufgaben von der Uebersicht aus). Gilt es schon (das
 * Blatt der Seite, auf der man steht), passiert nichts; ein ruhendes Blatt
 * zaehlt nicht (isStyleApplied) - dann kommt ein eigener <link>, auf den
 * gewartet wird, sonst zeigt das Blatt seinen Inhalt einmal roh. Ein Fehler
 * loest ebenfalls auf: ein fehlendes Blatt ist ein Schoenheitsfehler, kein
 * Grund, das Formular nicht zu zeigen.
 *
 * DIE ANTWORT IST DER RUECKWEG. Seitenblaetter tragen allgemeine Selektoren
 * (`.color-swatch`, `.ingredient-list` gibt es auch auf anderen Seiten); ein
 * von aussen angeschaltetes Blatt darf deshalb nicht fuer den Rest der Sitzung
 * auf jeder Seite gelten. `release()` legt NUR den eigenen <link> wieder still
 * - das Blatt des Routers (utils/page-style.js `load`) ist ein anderer <link>
 * und bleibt unberuehrt, es gibt also nichts, worum man mit ihm streitet.
 *
 * @param {string} href - z. B. '/styles/calendar.css'
 * @param {Document} [doc]
 * @returns {Promise<() => void>} release: nach dem Schliessen des Blatts rufen
 */
export async function ensureStyleApplied(href, doc = document) {
  if (isStyleApplied(href, doc)) return () => {};
  let link = doc.querySelector(`link[data-outside-styles][href="${href}"]`);
  let ready = Promise.resolve();
  if (link) {
    if (link.dataset.ready !== '1') {
      ready = new Promise((resolve) => {
        link.addEventListener('load', resolve, { once: true });
        link.addEventListener('error', resolve, { once: true });
      });
    } else if (link.sheet && link.sheet.media?.mediaText === RESTING) {
      link.sheet.media.mediaText = SHOWN;
    }
  } else {
    link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.outsideStyles = '';
    ready = new Promise((resolve) => {
      link.onload = () => { link.dataset.ready = '1'; resolve(); };
      link.onerror = () => { link.dataset.ready = '1'; resolve(); };
    });
    doc.head.appendChild(link);
  }
  link.dataset.users = String(Number(link.dataset.users ?? 0) + 1);
  await ready;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = Number(link.dataset.users ?? 1) - 1;
    link.dataset.users = String(left);
    if (left <= 0 && link.sheet?.media) link.sheet.media.mediaText = RESTING;
  };
}
