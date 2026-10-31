/**
 * Modul: Seitenblaetter bleiben geladen (Schnell-Erfassen, Aufgabe 3)
 * Zweck: Ein Tab-Wechsel wartet nicht aufs Netz.
 *
 * Gemessen vor der Aenderung (Fast 4G, 165 ms Latenz; Chromium und WebKit):
 * jeder Wechsel zurueck auf einen besuchten Tab wartete rund 210 ms vom Tipp
 * bis zum Tausch - eine Rundreise fuer sein Seitenblatt. Der Router legte je
 * Wechsel einen NEUEN <link> an und warf den alten weg; Blaetter gehen mit
 * `no-cache` raus, und der Service Worker holt sie network-first.
 *
 * Jetzt (utils/page-style.js): ein <link> je Adresse fuer die Lebensdauer der
 * Seite, und ob ein Blatt GILT, steht an seinem Stylesheet (CSSOM), nicht am
 * Attribut. Das ist die zweite Messung: WebKit holt ein Blatt bei JEDER
 * Aenderung des `media`-Attributs neu vom Netz und wendet es erst danach an
 * (vier Wechsel, vier Abrufe) - ein Wechsel ueber das Attribut haette auf dem
 * iPhone die Seite eine Rundreise lang ungestylt gezeigt. `sheet.media` aendert
 * dagegen in beiden Engines sofort und ohne Abruf.
 *
 * Das Dokument hier ist ein kleiner Nachbau: Tests feuern `onload` selbst, und
 * erst dann traegt der Link ein `sheet` - wie im Browser.
 *
 * Ausfuehren: node --test test/test-page-style.js
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPageStyles, isStyleApplied } from '../public/utils/page-style.js';
import { eachRule } from './css-rules.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

let fakeDoc;

function createFakeDoc() {
  const links = [];
  return {
    links,
    get styleSheets() {
      return links.filter((l) => l.isConnected && l.sheet).map((l) => l.sheet);
    },
    createElement(tag) {
      const attrs = new Map();
      const link = {
        tagName: tag.toUpperCase(),
        onload: null,
        onerror: null,
        sheet: null,
        isConnected: false,
        // Jede Attributaenderung an einem GELADENEN Link - in WebKit ein neuer Abruf.
        writesAfterLoad: [],
        setAttribute(name, value) {
          if (link.sheet) link.writesAfterLoad.push(`${name}=${value}`);
          attrs.set(name, String(value));
        },
        getAttribute(name) {
          return attrs.has(name) ? attrs.get(name) : null;
        },
        removeAttribute(name) {
          if (link.sheet) link.writesAfterLoad.push(`-${name}`);
          attrs.delete(name);
        },
        remove() {
          const at = links.indexOf(link);
          if (at >= 0) links.splice(at, 1);
          link.isConnected = false;
        },
        get href() {
          return attrs.get('href') ?? '';
        },
      };
      return link;
    },
    head: {
      appendChild(el) {
        links.push(el);
        el.isConnected = true;
        return el;
      },
    },
  };
}

/** Der verbundene Link einer Adresse (nach einem Neuversuch der neue). */
const linkFor = (href) => fakeDoc.links.find((l) => l.href === href);

/** Laesst den Browser antworten: `load` legt das Blatt an, `error` keins. */
function fire(type, href) {
  const link = linkFor(href);
  assert.ok(link, `kein Link fuer ${href}`);
  if (type === 'load') {
    link.sheet = { href: `http://127.0.0.1${href}`, disabled: false, media: { mediaText: link.getAttribute('media') ?? '' } };
    link.onload?.({ type });
  } else {
    link.onerror?.({ type });
  }
}

/** Das Medium, mit dem das Blatt gilt - am Stylesheet, nicht am Attribut. */
const mediaOf = (link) => link.sheet?.media.mediaText;
const applies = (link) => Boolean(link?.sheet) && !link.sheet.disabled && mediaOf(link) !== 'not all';
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settledNow = (promise) => Promise.race([promise.then(() => 'ready'), tick().then(() => 'waiting')]);

beforeEach(() => {
  fakeDoc = createFakeDoc();
});

test('revisit is instant and keeps one link per href', async () => {
  const s = createPageStyles(fakeDoc);
  const a = s.load('/styles/tasks.css'); fire('load', '/styles/tasks.css'); await a.ready;
  const b = s.load('/styles/meals.css'); fire('load', '/styles/meals.css'); await b.ready; b.cleanup();
  assert.equal(mediaOf(linkFor('/styles/tasks.css')), 'not all');
  const again = s.load('/styles/tasks.css');
  assert.equal(await Promise.race([again.ready.then(() => 'ready'), tick().then(() => 'waiting')]), 'ready');
  again.cleanup();
  assert.equal(mediaOf(linkFor('/styles/meals.css')), 'not all');
  assert.equal(fakeDoc.links.filter((l) => l.href === '/styles/tasks.css').length, 1);
  assert.ok(applies(linkFor('/styles/tasks.css')), 'das wieder besuchte Blatt gilt');
});

test('cleanup deactivates the previous sheet but never removes it', async () => {
  const s = createPageStyles(fakeDoc);
  const a = s.load('/styles/dashboard.css'); fire('load', '/styles/dashboard.css'); await a.ready;
  const b = s.load('/styles/tasks.css');
  // Bis zum Tausch gelten beide - die alte Seite steht noch.
  assert.ok(applies(linkFor('/styles/dashboard.css')));
  fire('load', '/styles/tasks.css'); await b.ready;
  b.cleanup();
  assert.equal(fakeDoc.links.length, 2, 'cleanup hat einen Link entfernt');
  assert.ok(!applies(linkFor('/styles/dashboard.css')));
  assert.ok(applies(linkFor('/styles/tasks.css')));
});

test('abandon() leaves the previous link active', async () => {
  const s = createPageStyles(fakeDoc);
  const a = s.load('/styles/tasks.css'); fire('load', '/styles/tasks.css'); await a.ready;
  // Ueberholt, bevor das Blatt kam: es darf beim Ankommen nicht gelten.
  const b = s.load('/styles/meals.css');
  b.abandon();
  fire('load', '/styles/meals.css'); await b.ready;
  assert.ok(applies(linkFor('/styles/tasks.css')), 'das Blatt der stehenden Seite gilt nicht mehr');
  assert.ok(!applies(linkFor('/styles/meals.css')), 'das ueberholte Blatt gilt');
  // Ueberholt, nachdem es kam: dasselbe.
  const c = s.load('/styles/meals.css');
  assert.equal(await settledNow(c.ready), 'ready');
  c.abandon();
  assert.ok(applies(linkFor('/styles/tasks.css')));
  assert.ok(!applies(linkFor('/styles/meals.css')));
  // Die stehende Seite ist weiter die aktive: ihr load() ist nichts.
  const same = s.load('/styles/tasks.css');
  same.cleanup();
  assert.ok(applies(linkFor('/styles/tasks.css')));
  assert.equal(fakeDoc.links.filter((l) => l.href === '/styles/meals.css').length, 1);
});

test('warm() adds one inactive link; a later load() reuses it', async () => {
  const s = createPageStyles(fakeDoc);
  const a = s.load('/styles/dashboard.css'); fire('load', '/styles/dashboard.css'); await a.ready;
  s.warm(['/styles/calendar.css']);
  s.warm(['/styles/calendar.css', '/styles/dashboard.css']);
  assert.equal(fakeDoc.links.filter((l) => l.href === '/styles/calendar.css').length, 1);
  assert.equal(fakeDoc.links.length, 2);
  const warmed = linkFor('/styles/calendar.css');
  assert.equal(warmed.getAttribute('rel'), 'stylesheet', 'ein Stylesheet-Link - den holt jeder Browser, auch Safari (rel=prefetch nicht)');
  assert.equal(warmed.getAttribute('media'), 'not all', 'ruhend angelegt: geholt, aber ohne Wirkung und ohne zu blockieren');
  // Gewaermt, aber noch unterwegs: load() wartet auf genau diesen Link.
  const c = s.load('/styles/calendar.css');
  assert.equal(fakeDoc.links.filter((l) => l.href === '/styles/calendar.css').length, 1);
  assert.equal(await settledNow(c.ready), 'waiting');
  fire('load', '/styles/calendar.css');
  await c.ready;
  assert.ok(applies(warmed), 'das gewaermte Blatt gilt nach dem Laden');
  c.cleanup();
  assert.ok(!applies(linkFor('/styles/dashboard.css')));
  // Gewaermt und geladen: sofort.
  s.warm(['/styles/tasks.css']);
  fire('load', '/styles/tasks.css');
  assert.ok(!applies(linkFor('/styles/tasks.css')), 'ein gewaermtes Blatt gilt nicht von selbst');
  const t = s.load('/styles/tasks.css');
  assert.equal(await settledNow(t.ready), 'ready');
  assert.ok(applies(linkFor('/styles/tasks.css')));
});

test('load() of the active href is a no-op', async () => {
  const s = createPageStyles(fakeDoc);
  const a = s.load('/styles/settings.css'); fire('load', '/styles/settings.css'); await a.ready;
  const again = s.load('/styles/settings.css');
  assert.equal(await settledNow(again.ready), 'ready');
  again.cleanup();
  again.abandon();
  assert.equal(fakeDoc.links.length, 1);
  assert.ok(applies(linkFor('/styles/settings.css')));
});

test('a sheet that failed is fetched again on the next load, still one link per href', async () => {
  const s = createPageStyles(fakeDoc);
  const a = s.load('/styles/tasks.css');
  fire('error', '/styles/tasks.css');
  assert.equal(await settledNow(a.ready), 'ready', 'ein fehlendes Blatt haelt die Seite nicht auf');
  const failed = linkFor('/styles/tasks.css');
  const b = s.load('/styles/meals.css'); fire('load', '/styles/meals.css'); await b.ready; b.cleanup();
  const again = s.load('/styles/tasks.css');
  const retry = linkFor('/styles/tasks.css');
  assert.notEqual(retry, failed, 'der kaputte Link wird wiederverwendet - das Blatt kaeme bis zum Neuladen nie');
  assert.equal(failed.isConnected, false);
  assert.equal(fakeDoc.links.filter((l) => l.href === '/styles/tasks.css').length, 1);
  assert.equal(await settledNow(again.ready), 'waiting');
  fire('load', '/styles/tasks.css');
  await again.ready;
  again.cleanup();
  assert.ok(applies(retry));
  assert.ok(!applies(linkFor('/styles/meals.css')));
});

test('switching never touches the attributes of a loaded link (WebKit fetches it again)', async () => {
  const s = createPageStyles(fakeDoc);
  s.warm(['/styles/tasks.css', '/styles/calendar.css']);
  fire('load', '/styles/tasks.css');
  fire('load', '/styles/calendar.css');
  const steps = ['/styles/dashboard.css', '/styles/tasks.css', '/styles/calendar.css', '/styles/dashboard.css', '/styles/tasks.css'];
  for (const href of steps) {
    const style = s.load(href);
    if (!linkFor(href).sheet) fire('load', href);
    await style.ready;
    style.cleanup();
  }
  const back = s.load('/styles/calendar.css');
  back.abandon();
  assert.deepEqual(fakeDoc.links.flatMap((l) => l.writesAfterLoad.map((w) => `${l.href}: ${w}`)), []);
  assert.deepEqual(fakeDoc.links.filter(applies).map((l) => l.href), ['/styles/tasks.css']);
});

test('isStyleApplied() does not count a resting page sheet', () => {
  const doc = {
    styleSheets: [
      { href: 'http://127.0.0.1/styles/tasks.css', disabled: false, media: { mediaText: 'not all' } },
      { href: 'http://127.0.0.1/styles/meals.css', disabled: false, media: { mediaText: '' } },
      { href: 'http://127.0.0.1/styles/calendar.css', disabled: true, media: { mediaText: 'all' } },
      { href: null, disabled: false, media: { mediaText: '' } },
    ],
  };
  assert.equal(isStyleApplied('/styles/tasks.css', doc), false);
  assert.equal(isStyleApplied('/styles/meals.css', doc), true);
  assert.equal(isStyleApplied('/styles/calendar.css', doc), false);
  assert.equal(isStyleApplied('/styles/notes.css', doc), false);
});

// ── Verdrahtung (router.js ist nicht importierbar: Quelltext) ──

const router = read('../public/router.js');
const body = (src, signature) => {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} nicht gefunden`);
  return src.slice(start, src.indexOf('\n}\n', start) + 2);
};

test('the router keeps page sheets through ONE createPageStyles()', () => {
  assert.match(router, /import \{ createPageStyles \} from '\/utils\/page-style\.js';/);
  assert.equal((router.match(/createPageStyles\(/g) ?? []).length, 1, 'genau ein Satz Seitenblaetter je Dokument');
  const load = body(router, 'function loadPageStyle(moduleName, routeStyle = null) {');
  assert.match(load, /return pageStyles\.load\(routeStyle \|\| `\/styles\/\$\{moduleName\}\.css`\);/);
  assert.doesNotMatch(load, /createElement|\.remove\(\)/, 'loadPageStyle legt wieder selbst Links an');
});

test('the bottom bar sheets are warmed as resting stylesheets, read from the bar itself', () => {
  assert.doesNotMatch(router, /'prefetch'/, 'rel=prefetch kennt Safari nicht, und mit no-cache holte der Link das Blatt danach ohnehin neu');
  const warm = body(router, 'function warmPrimaryRoutes() {');
  assert.match(warm, /pageStyles\.warm\(bottomBarStyles\(\)\)/);
  const bar = body(router, 'function bottomBarStyles() {');
  assert.match(bar, /\.nav-bottom \[data-route\]/, 'die Ziele kommen aus der Leiste, nicht aus einer Liste');
  // Die zwei Knoepfe ohne `data-route` (im Browser gemessen: ohne die Zeile
  // blieb meals.css ungewaermt, obwohl „Kuchnia" in der Leiste steht).
  assert.match(bar, /#kitchen-btn'\)\) paths\.push\(currentKitchenDestination\(\)\?\.path\)/);
  assert.match(bar, /#more-btn'\)\) paths\.push\(MORE_PATH\)/);
  assert.doesNotMatch(bar, /\/styles\//, 'eine Handliste von Blaettern');
  const prefetch = body(router, 'function prefetchRoute(path, { now = false } = {}) {');
  assert.match(prefetch, /pageStyles\.warm\(\[cssHref\]\)/, 'auch die Absicht (Druck, Hover) waermt ueber dieselbe Stelle');
});

test('the tab bar answers a tap without the double-tap wait', () => {
  const [nav] = [...eachRule(read('../public/styles/layout.css'))]
    .filter((r) => r.at.length === 0 && r.selector.trim() === '.nav-bottom');
  assert.ok(nav, 'keine Basisregel .nav-bottom');
  assert.match(nav.body, /touch-action:\s*manipulation/);
});

test('opening a task from elsewhere does not mistake a resting tasks.css for a loaded one', () => {
  const tasks = read('../public/pages/tasks.js');
  const fn = body(tasks, 'function ensureTaskStyles() {');
  // Seit Schnell-Erfassen (Aufgabe 10) fragt der geteilte Baustein, ob das Blatt GILT.
  assert.match(fn, /ensureStyleApplied\(/);
  const helper = read('../public/utils/page-style.js');
  const shared = helper.slice(helper.indexOf('export async function ensureStyleApplied'));
  assert.match(shared, /isStyleApplied\(href, doc\)/);
  assert.doesNotMatch(shared, /\.styleSheets/, 'ein ruhendes Seitenblatt steht auch in document.styleSheets');
});
