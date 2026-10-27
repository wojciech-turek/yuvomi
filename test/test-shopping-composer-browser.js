/**
 * Modul: Der Composer der Einkaufsliste (v2, 2026-10-27) - Browser-Sonde
 * Zweck: Die Leiste "Dodaj produkt" und ihr Composer, so wie ein Telefon sie
 *        bedient: EIN Feld, aus dem die Menge gelesen wird ("jajka 10" ->
 *        jajka, 10 szt.), Enter und der Pfeil legen an und lassen den Fokus
 *        im Feld, die "Często"-Chips legen mit einem Tipp an, der Composer
 *        sitzt auf der Tastatur (visualViewport), der Kopf bleibt stehen,
 *        Escape und ein Tipp daneben schliessen - und dieser Tipp hakt nichts
 *        ab.
 * Ausfuehren: npm run test:shopping-composer-browser (haengt an test:document-guards)
 *
 * OHNE SERVER UND OHNE PORT, wie test-shopping-ticked-browser.js: das echte
 * `public/pages/shopping.js` mit den echten Stylesheets in Chromium, jede
 * Anfrage abgefangen. Die Tastatur ist eine gespielte: `visualViewport` meldet
 * eine kleinere Hoehe und ein `resize` - genau das, was iOS tut, wenn sie
 * aufgeht (das Layout-Viewport bleibt, das sichtbare schrumpft).
 *
 * WARUM DER KOPF IM GERUEST STEHT. Die Klage des Besitzers (iPhone, Brave):
 * die Leiste sprang beim Fokus ueber den Titel "Kuchnia". Der Grund war
 * `container-type` auf `.shopping-page` - ein Container ist der
 * Bezugsrahmen seiner fixen Nachfahren, "bottom: Tastaturhoehe" mass von der
 * Seite statt vom Bildschirm. Das Geruest traegt deshalb einen Kopf IN der
 * Seite, und die Sonde misst, dass er stehen bleibt und nichts ihn verdeckt.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'public');
const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.html': 'text/html', '.svg': 'image/svg+xml',
};

const sheets = [...readFileSync(join(PUB, 'index.html'), 'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
if (!sheets.includes('/styles/shopping.css')) sheets.push('/styles/shopping.css');

/* Das Geruest von render(): Kopf und Liste in der Seite, der Inhalt aus
 * renderListContent(). Die Seite fuellt den Bildschirm wie in der App. */
const HTML = `<!doctype html><html lang="pl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${sheets.map((href) => `<link rel="stylesheet" href="${href}">`).join('\n')}
<script src="/lucide.min.js"></script>
<style>html, body { height: 100%; margin: 0; } #c { height: 100%; }</style>
</head><body><main id="c" class="app-content"><div class="shopping-page page-measure--narrow">
<header id="probe-head" style="padding: 56px 16px 16px"><h1 style="margin: 0">Kuchnia</h1></header>
<div id="list-content" style="flex:1;display:flex;flex-direction:column;overflow:hidden"></div>
</div></main></body></html>`;

const KEYBOARD = 336;

let browser;
let page;
const api = { log: [], nextId: 100 };
const pageErrors = [];

before(async () => {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const url = new URL(req.url());
    if (url.pathname === '/probe.html') return req.respond({ status: 200, contentType: 'text/html', body: HTML });
    if (url.pathname.startsWith('/api/')) {
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      api.log.push({ method: req.method(), path: `${url.pathname}${url.search}`, body });
      const json = (data) => req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
      if (url.pathname === '/api/v1/shopping/frequent') {
        return json({ data: [
          { name: 'chleb', category: 'Obst & Gemüse', quantity: '1 szt.' },
          { name: 'Butter', category: 'Milchprodukte', quantity: null }, // open on the list: no chip
          { name: 'masło', category: 'Milchprodukte', quantity: '1 szt.' },
        ] });
      }
      if (url.pathname === '/api/v1/shopping/category-guess') return json({ data: { category: 'Milchprodukte', source: 'history' } });
      if (req.method() === 'POST' && /\/api\/v1\/shopping\/5\/items$/.test(url.pathname)) {
        const id = api.nextId++;
        return json({
          data: { id, list_id: 5, name: body.name, quantity: body.quantity ?? null, category: body.category, is_checked: 0, sort_order: -id, tags: [] },
          list_change: { list_id: 5, before: 1, after: 2 },
        });
      }
      return json({ data: null });
    }
    const file = join(PUB, url.pathname);
    if (!existsSync(file) || statSync(file).isDirectory()) return req.respond({ status: 404, body: '' });
    return req.respond({ status: 200, contentType: MIME[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('http://probe.local/probe.html', { waitUntil: 'load' });
  // DIE SPRACHE STEHT FEST (siehe test-shopping-ticked-browser.js): Polnisch,
  // die Sprache des Besitzers - "10 szt." ist hier der gemessene Text.
  await page.evaluate(async () => {
    localStorage.setItem('yuvomi-locale', 'pl');
    sessionStorage.clear();
    const { initI18n } = await import('/i18n.js');
    await initI18n();
  });
});

after(async () => {
  await browser?.close();
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const item = (id, name, category, over = {}) => ({
  id, list_id: 5, name, quantity: null, category, is_checked: 0,
  price_cents: null, store_id: null, url: null, notes: null, tags: [], sort_order: id, ...over,
});

/** Bestand setzen und den Inhalt der Liste samt Leiste bauen, wie render() es tut. */
async function setup(items = [item(1, 'Apfel', 'Obst & Gemüse'), item(2, 'Butter', 'Milchprodukte')]) {
  api.log.length = 0;
  await page.evaluate(async (list) => {
    document.activeElement?.blur?.();
    document.getElementById('fake-keyboard')?.remove();
    delete window.visualViewport.height;
    delete window.visualViewport.offsetTop;
    const { __test: s } = await import('/pages/shopping.js');
    window.s = s;
    window.yuvomi = { ...window.yuvomi, showToast: () => {} };
    s.resetLoadOrderForTest();
    s.resetPillMachine();
    s.resetPlacementHold();
    const LISTE = { id: 5, name: 'Woche', item_total: list.length, item_checked: 0 };
    Object.assign(s.state, {
      lists: [LISTE], activeList: LISTE, activeListId: 5, items: list,
      categories: [{ id: 1, name: 'Obst & Gemüse', icon: 'apple', sort_order: 0 }, { id: 2, name: 'Milchprodukte', icon: 'milk', sort_order: 1 }, { id: 3, name: 'Sonstiges', icon: 'tag', sort_order: 2 }],
      stores: [], currency: 'PLN', currentUserId: 7, listsError: null, itemsError: null,
      collapsedCategories: new Set(), tickedOpen: false, freshItemId: null,
    });
    s.setItemsListForTest(5);
    const c = document.getElementById('c');
    s.renderListContent(c);
    s.wireListContentEvents(c);
  }, items);
  // "Często" kommt aus einer Anfrage.
  await page.waitForFunction(() => document.querySelectorAll('.shopping-addbar__chip').length > 0, { timeout: 3000 });
}

/** Die Tastatur, wie iOS sie meldet: das sichtbare Viewport schrumpft, ein `resize` folgt. */
const openKeyboard = () => page.evaluate((kb) => {
  const vv = window.visualViewport;
  Object.defineProperty(vv, 'height', { configurable: true, get: () => window.innerHeight - kb });
  Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 });
  vv.dispatchEvent(new Event('resize'));
}, KEYBOARD);

const rect = (sel) => page.evaluate((s) => {
  const r = document.querySelector(s)?.getBoundingClientRect();
  return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) } : null;
}, sel);

const centre = (sel) => page.evaluate((s) => {
  const r = document.querySelector(s).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, sel);

const tap = async (sel) => {
  const p = await centre(sel);
  await page.touchscreen.tap(p.x, p.y);
};

const state = () => page.evaluate(() => ({
  focus: document.activeElement?.id || document.activeElement?.className || 'BODY',
  value: document.querySelector('#item-name-input')?.value,
  hint: document.querySelector('#quick-add-hint')?.textContent,
  typing: document.querySelector('.shopping-addbar')?.classList.contains('shopping-addbar--typing'),
  keyboard: document.querySelector('.shopping-addbar')?.classList.contains('shopping-addbar--keyboard'),
  milch: [...document.querySelectorAll('.list-group[data-category="Milchprodukte"] .shopping-item')].map((r) => ({
    name: r.querySelector('.list-row__name')?.textContent.trim(),
    meta: r.querySelector('.list-row__meta')?.textContent.trim().replace(/\s+/g, ' ') ?? '',
    fresh: r.classList.contains('shopping-item--fresh'),
  })),
}));

const posts = () => api.log.filter((a) => a.method === 'POST').map((a) => a.body);

// --------------------------------------------------------------------------
// Die Zeile liest ihre Menge
// --------------------------------------------------------------------------

test('Ein Feld, die Menge darin: "2 mleko", "mleko 2", "250 g sera", "jajka 10"', async () => {
  await setup();
  const parsed = await page.evaluate(() => Object.fromEntries(
    ['2 mleko', 'mleko 2', '250 g sera', 'jajka 10', 'Ser żółty', 'sól i pieprz', 'Mleko 2%', '1,5 kg ziemniaków', '2x chleb', '200 g sera żółtego', '10 jajek wiejskich', '']
      .map((line) => [line, window.s.parseQuickEntry(line)]),
  ));
  assert.deepEqual(parsed['2 mleko'], { name: 'mleko', quantity: '2 szt.' });
  assert.deepEqual(parsed['mleko 2'], { name: 'mleko', quantity: '2 szt.' }, 'eine Zahl HINTER dem Namen ist hier eine Menge');
  assert.deepEqual(parsed['250 g sera'], { name: 'ser', quantity: '250 g' }, 'nach einer Menge steht der Name im Nominativ');
  assert.deepEqual(parsed['jajka 10'], { name: 'jajka', quantity: '10 szt.' });
  assert.deepEqual(parsed['Ser żółty'], { name: 'Ser żółty', quantity: null }, 'ohne Menge bleibt die Zeile, wie sie getippt ist');
  assert.deepEqual(parsed['sól i pieprz'], { name: 'sól i pieprz', quantity: null }, 'ein Absenden ist EIN Artikel');
  assert.deepEqual(parsed['Mleko 2%'], { name: 'Mleko 2%', quantity: null }, '2% ist Teil des Namens, keine Menge');
  assert.deepEqual(parsed['1,5 kg ziemniaków'], { name: 'ziemniaki', quantity: '1,5 kg' });
  assert.deepEqual(parsed['2x chleb'], { name: 'chleb', quantity: '2 szt.' });
  assert.deepEqual(parsed['200 g sera żółtego'], { name: 'ser żółty', quantity: '200 g' }, 'das Adjektiv folgt seinem Nomen');
  assert.deepEqual(parsed['10 jajek wiejskich'], { name: 'jajka wiejskie', quantity: '10 szt.' });
  assert.deepEqual(parsed[''], { name: '', quantity: null });
});

test('Das Feld sagt, was es anlegen wird: "10 szt. · Nabiał" (Menge aus der Zeile, Gang aus der Vermutung)', async () => {
  await setup();
  await tap('#item-name-input');
  await page.keyboard.type('jajka 10');
  await page.waitForFunction(() => /·/.test(document.querySelector('#quick-add-hint').textContent), { timeout: 3000 });
  const s = await state();
  assert.equal(s.hint, '10 szt. · Nabiał', 'Milchprodukte heisst auf Polnisch Nabiał');
  const guess = api.log.find((a) => a.path.startsWith('/api/v1/shopping/category-guess'));
  assert.equal(guess?.path, '/api/v1/shopping/category-guess?name=jajka', 'gefragt wird nach dem NAMEN der Zeile, nicht nach "jajka 10"');
});

// --------------------------------------------------------------------------
// Anlegen und weiter
// --------------------------------------------------------------------------

test('Enter legt an, oben in seinem Gang, mit "dodano" - und der Fokus bleibt fuer den naechsten', async () => {
  await setup();
  await tap('#item-name-input');
  await page.keyboard.type('250 g sera');
  await wait(600); // die Vermutung des Gangs
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.shopping-item--fresh'), { timeout: 3000 });
  const s = await state();
  assert.deepEqual(posts(), [{ name: 'ser', quantity: '250 g', category: 'Milchprodukte', category_source: 'suggestion', position: 'top' }]);
  assert.equal(s.focus, 'item-name-input', 'das Feld behaelt den Fokus - die Tastatur bleibt offen');
  assert.equal(s.value, '', 'und ist leer fuer den naechsten Artikel');
  assert.equal(s.typing, true, 'der Composer bleibt offen');
  assert.deepEqual(s.milch[0], { name: 'ser', meta: 'dodano · 250 g', fresh: true }, 'die neue Zeile steht OBEN in ihrem Gang');

  // Der naechste gleich hinterher, ohne das Feld neu zu treffen.
  await page.keyboard.type('mleko 2');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.list-group[data-category] .shopping-item--fresh .list-row__name')?.textContent.trim() === 'mleko', { timeout: 3000 });
  assert.equal(posts()[1].name, 'mleko');
  assert.equal(posts()[1].quantity, '2 szt.');
  assert.equal((await state()).focus, 'item-name-input');
});

test('Der Pfeil legt an wie Enter, und ein Tipp darauf nimmt dem Feld den Fokus nicht', async () => {
  await setup();
  await tap('#item-name-input');
  await page.keyboard.type('jajka 10');
  await tap('.quick-add__btn');
  await page.waitForFunction(() => document.querySelector('.shopping-item--fresh'), { timeout: 3000 });
  assert.equal(posts()[0].name, 'jajka');
  assert.equal(posts()[0].quantity, '10 szt.');
  const s = await state();
  assert.equal(s.focus, 'item-name-input');
  assert.equal(s.value, '');
});

test('"Często": ein Tipp legt sofort an, der Fokus bleibt, und was offen auf der Liste steht, ist kein Chip', async () => {
  await setup();
  await tap('#item-name-input');
  const chips = await page.$$eval('.shopping-addbar__chip', (els) => els.map((e) => e.textContent.trim()));
  assert.deepEqual(chips, ['chleb', 'masło'], '"Butter" steht offen auf der Liste');
  const label = await page.$eval('#shopping-addbar-frequent-label', (el) => el.textContent.trim());
  assert.equal(label, 'Często');
  await tap('.shopping-addbar__chip[data-name="masło"]');
  await page.waitForFunction(() => document.querySelector('.shopping-item--fresh'), { timeout: 3000 });
  assert.deepEqual(posts(), [{ name: 'masło', quantity: '1 szt.', category: 'Milchprodukte', category_source: 'suggestion', position: 'top' }]);
  const s = await state();
  assert.equal(s.focus, 'item-name-input', 'ein Chip nimmt dem Feld den Fokus nicht');
  assert.deepEqual(await page.$$eval('.shopping-addbar__chip', (els) => els.map((e) => e.textContent.trim())), ['chleb'],
    'der angelegte Chip geht, er steht jetzt offen auf der Liste');
});

// --------------------------------------------------------------------------
// Auf der Tastatur, unter dem Kopf
// --------------------------------------------------------------------------

test('Ruhend: die Leiste steht unten, 48 hoch, und der Kopf liegt frei; die Seite ist am Telefon kein Container', async () => {
  await setup();
  const head = await rect('#probe-head');
  const bar = await rect('.shopping-addbar');
  assert.ok(bar.top > head.bottom, `die Leiste (${bar.top}) liegt unter dem Kopf (${head.bottom})`);
  assert.equal(bar.bottom - bar.top, 48, 'v2: 48 hoch');
  assert.ok(bar.bottom < 844 && bar.bottom > 844 - 200, `unten angeheftet, ueber der Leiste der Reiter (${bar.bottom})`);
  const containerType = await page.$eval('.shopping-page', (el) => getComputedStyle(el).containerType);
  assert.equal(containerType, 'normal', 'ein Container waere der Bezugsrahmen der fixen Leiste - sie sprang ueber den Titel');
});

test('Der Composer sitzt direkt auf der Tastatur, der Kopf bleibt, wo er war', async () => {
  await setup();
  const head = await rect('#probe-head');
  await tap('#item-name-input');
  await openKeyboard();
  await wait(100);
  const s = await state();
  assert.equal(s.keyboard, true);
  const bar = await rect('.shopping-addbar');
  assert.equal(bar.bottom, 844 - KEYBOARD, `die Unterkante (${bar.bottom}) ist die Oberkante der Tastatur (${844 - KEYBOARD})`);
  assert.deepEqual([bar.left, bar.right], [0, 390], 'volle Breite');
  assert.deepEqual(await rect('#probe-head'), head, 'der Kopf hat sich nicht bewegt');
  assert.ok(bar.top > head.bottom, 'und nichts liegt ueber ihm');
  const scrollY = await page.evaluate(() => window.scrollY);
  assert.equal(scrollY, 0, 'das Dokument scrollt nicht');
});

test('Nur EIN Textfeld am Telefon: kein Vor/Zurueck-Balken von iOS, enterkeyhint "send"', async () => {
  await setup();
  const fields = await page.$$eval('.shopping-addbar input, .shopping-addbar select, .shopping-addbar textarea',
    (els) => els.filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.id));
  assert.deepEqual(fields, ['item-name-input']);
  assert.equal(await page.$eval('#item-name-input', (el) => el.getAttribute('enterkeyhint')), 'send');
});

// --------------------------------------------------------------------------
// Schliessen
// --------------------------------------------------------------------------

test('Escape schliesst den Composer', async () => {
  await setup();
  await tap('#item-name-input');
  assert.equal((await state()).typing, true);
  await page.keyboard.press('Escape');
  await wait(50);
  const s = await state();
  assert.notEqual(s.focus, 'item-name-input');
  assert.equal(s.typing, false);
});

test('Ein Tipp daneben schliesst - und hakt die Zeile darunter NICHT ab', async () => {
  await setup();
  await tap('#item-name-input');
  await tap('.shopping-item[data-item-id="1"] .list-row__name');
  await wait(200);
  const s = await state();
  assert.equal(s.typing, false, 'der Composer ist zu');
  assert.notEqual(s.focus, 'item-name-input');
  assert.deepEqual(api.log.filter((a) => a.method === 'PATCH'), [], 'kein Haken: der Tipp war das Schliessen');
  // Der naechste Tipp ist wieder einer.
  await tap('.shopping-item[data-item-id="1"] .list-row__name');
  await wait(200);
  assert.equal(api.log.filter((a) => a.method === 'PATCH').length, 1, 'danach hakt ein Tipp wieder ab');
});

test('Keine Seitenfehler', () => {
  assert.deepEqual(pageErrors, []);
});
