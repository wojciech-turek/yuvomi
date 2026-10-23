/**
 * Modul: Dashboard - Bedienung und Barrierefreiheit im gerenderten Dokument
 * Zweck: Was die Critique vom 2026-09-23 am lebenden Dashboard gemessen hat,
 *        hier als Programm gefahren statt als Textguard. Seit Tafla
 *        (2026-10-19) ist die Uebersicht „Dziś" - ein Plan statt eines
 *        Kachelrasters; die Fragen sind dieselben geblieben, gemessen wird an
 *        dem, was an die Stelle der Kacheln trat:
 *          (1) die Ziele von Dziś (Haken im Plan, Profil im Kopf, „Dostosuj
 *              Dziś") sind an ihrem Zentrum das oberste Element und tragen
 *              44/48px - Sonde 4 (test-document-guards.js) ueberspringt
 *              verdeckte Ziele stillschweigend,
 *          (2) jeder Abschnitt nennt sich nach einer eigenen h3 unter der h2
 *              des Kopfs, und keine Ueberschrift traegt eine Zahl im Namen
 *              (der Zaehler des Plans steht daneben, nicht darin),
 *          (3) „Dostosuj Dziś" per Tastatur: der Fokus bleibt nach jeder Geste
 *              auf dem Bedienelement, das Umordnen wird angesagt, „Gotowe"
 *              gibt den Fokus an den Knopf zurueck,
 *          (4) die Startknoepfe des Wand-Timers ruhen sichtbar, und der erste
 *              Tipp auf eine schlafende Wand weckt nur,
 *          (4b) das Wecken verschiebt die Startknoepfe nicht (der zweite Tipp
 *              traefe sonst einen anderen),
 *          (5) die Knoepfe von Dziś halten am Touch-Tablet (1180px) die
 *              Fingergroesse - das Kriterium ist die Zeigerfaehigkeit, nicht
 *              die Breite,
 *          (6) Griffe und Schalter in „Dostosuj Dziś" messen am Zeiger die
 *              Zielgroesse, nicht nur ihre Zeichnung.
 * Ausfuehren: npm run test:dashboard-a11y-browser (haengt an test:document-guards)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, openPage, gotoRoute, settle, DEVICES, enterDashboardWall } from './document-guards-harness.js';

let harness;
before(async () => { harness = await startHarness(); });
after(async () => { await harness?.close(); });

const WEATHER = {
  data: {
    provider: 'open-meteo', city: 'Dortmund', units: 'metric',
    current: { temp: 20, feels_like: 18, humidity: 47, icon: 'cloud', desc: 'wmo.3', wind_speed: 11 },
    today: { date: '2026-09-23', temp_min: 13, temp_max: 21, icon: 'cloud', desc: 'wmo.3' },
    forecast: [
      { date: '2026-09-24', temp_min: 14, temp_max: 19, icon: 'cloud', desc: 'wmo.3' },
      { date: '2026-09-25', temp_min: 12, temp_max: 22, icon: 'cloud', desc: 'wmo.3' },
      { date: '2026-09-26', temp_min: 13, temp_max: 25, icon: 'cloud', desc: 'wmo.3' },
    ],
  },
};

/* Die Abschnitte von Dziś in einer festen Reihenfolge, dazu zwei
 * Vorschaukacheln - damit das Blatt etwas umzuordnen hat. */
const LAYOUT = [
  { id: 'today-weather', visible: true, size: '1x1', order: 0 },
  { id: 'today-shopping', visible: true, size: '1x1', order: 1 },
  { id: 'today-tomorrow', visible: true, size: '1x1', order: 2 },
  { id: 'today-question', visible: true, size: '1x1', order: 3 },
  { id: 'today-soon', visible: true, size: '1x1', order: 4 },
  { id: 'notes', visible: true, size: '1x1', order: 5 },
  { id: 'budget', visible: true, size: '1x1', order: 6 },
];

const CUSTOMIZE = '[data-day-action="customize"]';

/** Seite mit festem Layout und einer Wetterantwort, die nicht vom Netz abhaengt. */
async function dashboardPage({ device = 'desktop', viewport = null } = {}) {
  await harness.reset();
  const page = await openPage(harness, { device, theme: 'light', locale: 'de' });
  if (viewport) await page.setViewport(viewport);
  page.__yuvomiRequestInterceptor = (req) => {
    if (!/\/api\/v1\/weather\?/.test(req.url())) return false;
    req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(WEATHER) });
    return true;
  };
  await page.evaluate(async (layout) => {
    const { api } = await import('/api.js');
    await api.put('/preferences', { dashboard_widgets: layout });
    localStorage.setItem('yuvomi:fabSeen:dashboard', '5');
  }, LAYOUT);
  await gotoRoute(page, '/');
  await page.waitForSelector(`[data-today] ${CUSTOMIZE}`);
  return page;
}

/** Tastet wie Sonde 4: trifft das Zentrum das Element selbst, und wie weit reicht es? */
async function hitArea(page, selector) {
  return page.$eval(selector, async (el) => {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    document.getAnimations().forEach((a) => { try { a.finish(); } catch { /* egal */ } });
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const mine = (x, y) => { const h = document.elementFromPoint(x, y); return !!h && (h === el || el.contains(h)); };
    const reach = (dx, dy) => { let n = 0; while (n < 80 && mine(cx + dx * (n + 1), cy + dy * (n + 1))) n += 1; return n; };
    const top = document.elementFromPoint(cx, cy);
    return {
      covered: !mine(cx, cy),
      by: top ? `${top.tagName.toLowerCase()}.${[...top.classList].join('.')}` : null,
      box: { w: r.width, h: r.height },
      w: Math.max(r.width, reach(-1, 0) + reach(1, 0) + 1),
      h: Math.max(r.height, reach(0, -1) + reach(0, 1) + 1),
    };
  });
}

/** Der Text der Live-Region im Blatt - sie setzt sofort, kurz warten schadet nicht. */
async function sheetAnnounced(page) {
  await new Promise((r) => { setTimeout(r, 150); });
  return page.$eval('.day-sheet [data-sheet-live]', (el) => el.textContent.trim());
}

async function openSheet(page) {
  await page.focus(CUSTOMIZE);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.day-sheet [data-section-list]');
  await settle(page);
}

test('(1) die Ziele von Dziś liegen frei und tragen die Zielgroesse', async () => {
  for (const device of ['desktop', 'mobile']) {
    const page = await dashboardPage({ device });
    const min = device === 'mobile' ? 48 : 44;
    const targets = [CUSTOMIZE, '.day-head__me'];
    // Ein offener Haken, nicht einer aus dem zugeklappten „Wcześniej".
    const check = '[data-today] .day-plan .day-card > .day-row .day-check';
    if (await page.$(check)) targets.push(check);
    assert.ok(targets.length === 3, `${device}: Reichweite - der Plan im Seed hat keinen Haken`);
    for (const sel of targets) {
      const area = await hitArea(page, sel);
      assert.equal(area.covered, false, `${device} ${sel}: das Zentrum trifft ${area.by}, nicht das Ziel`);
      assert.ok(area.w >= min && area.h >= min,
        `${device} ${sel}: Trefferflaeche ${area.w}x${area.h}, verlangt ${min} (Box ${area.box.w}x${area.box.h})`);
    }
    await page.close();
  }
});

test('(2) jeder Abschnitt nennt sich nach seiner h3, keine Ueberschrift traegt eine Zahl', async () => {
  const page = await dashboardPage({ device: 'mobile' });
  const tree = await page.evaluate(() => {
    const root = document.querySelector('[data-today]');
    const name = (h) => {
      const clone = h.cloneNode(true);
      clone.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
      return clone.textContent.replace(/\s+/g, ' ').trim();
    };
    const sections = [...root.querySelectorAll('section.day-section')];
    const h2 = root.querySelector('h2');
    return {
      h2: h2 ? name(h2) : null,
      sections: sections.length,
      named: sections.map((s) => {
        const id = s.getAttribute('aria-labelledby');
        const h = id ? document.getElementById(id) : null;
        return { id, ok: !!h && h.tagName === 'H3' && s.contains(h), label: s.getAttribute('aria-label') };
      }),
      h3: [...root.querySelectorAll('h3')].map(name),
      h3BeforeH2: [...root.querySelectorAll('h3')].some((h) => h2 && (h.compareDocumentPosition(h2) & Node.DOCUMENT_POSITION_FOLLOWING)),
    };
  });
  assert.ok(tree.h2, 'der Kopf traegt eine h2 (die Begruessung)');
  assert.equal(tree.h3BeforeH2, false, 'keine h3 steht vor der h2 des Kopfs');
  assert.ok(tree.sections >= 2, `Reichweite: nur ${tree.sections} Abschnitt(e)`);
  const unnamed = tree.named.filter((s) => !s.ok && !s.label);
  assert.deepEqual(unnamed, [], 'Abschnitte ohne eigene h3 und ohne Namen');
  const withDigits = tree.h3.filter((n) => /\d/.test(n));
  assert.deepEqual(withDigits, [], 'Ueberschriften mit einer Zahl im zugaenglichen Namen');
  await page.close();
});

test('(3) „Dostosuj Dziś" per Tastatur: der Fokus bleibt, das Umordnen wird angesagt', async () => {
  const page = await dashboardPage({ device: 'desktop' });
  const active = () => page.evaluate(() => {
    const el = document.activeElement;
    return {
      body: el === document.body || !el,
      action: el?.getAttribute('data-day-action') ?? '',
      grip: el?.hasAttribute('data-grip') ?? false,
      sw: el?.getAttribute('data-switch') ?? '',
      checked: el?.getAttribute('aria-checked'),
      section: el?.closest('[data-section-id]')?.getAttribute('data-section-id') ?? '',
    };
  });
  const sheetOrder = () => page.$$eval('.day-sheet [data-section-list] [data-section-id]', (els) => els.map((el) => el.dataset.sectionId));

  await openSheet(page);
  const before = await sheetOrder();
  assert.ok(before.length >= 3, `Reichweite: das Blatt fuehrt ${before.length} Abschnitte`);

  // Der zweite Abschnitt rueckt per Pfeiltaste nach oben.
  const second = before[1];
  await page.focus(`.day-sheet [data-section-id="${second}"] [data-grip]`);
  await page.keyboard.press('ArrowUp');
  let a = await active();
  assert.equal(a.grip, true, `nach dem Umordnen liegt der Fokus auf ${JSON.stringify(a)}`);
  assert.equal(a.section, second, 'und zwar auf dem Griff des bewegten Abschnitts');
  assert.equal((await sheetOrder())[0], second, 'der Abschnitt steht jetzt oben');
  assert.match(await sheetAnnounced(page), /1/, 'die neue Stelle wird angesagt');

  // Ein Schalter per Leertaste: der Zustand wechselt, der Fokus bleibt.
  const target = (await sheetOrder())[1];
  await page.focus(`.day-sheet [data-switch="${target}"]`);
  const was = await page.$eval(`.day-sheet [data-switch="${target}"]`, (el) => el.getAttribute('aria-checked'));
  await page.keyboard.press('Space');
  a = await active();
  assert.equal(a.sw, target, `nach dem Schalten liegt der Fokus auf ${JSON.stringify(a)}`);
  assert.notEqual(a.checked, was, 'der Schalter traegt den neuen Zustand');

  // Die Seite hinter dem Blatt zeichnet neu - der Fokus bleibt trotzdem im Blatt.
  await settle(page);
  a = await active();
  assert.equal(a.body, false, 'das Neuzeichnen von Dziś hat den Fokus auf <body> geworfen');

  // „Gotowe" schliesst und gibt den Fokus an den Knopf zurueck.
  assert.ok(await page.$('.modal-panel #modal-header-action'), 'Reichweite: das Blatt hat seinen Fertig-Knopf im Kopf');
  await page.focus('#modal-header-action');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.day-sheet'));
  await settle(page);
  a = await active();
  assert.equal(a.action, 'customize', `nach „Gotowe" liegt der Fokus auf ${JSON.stringify(a)}`);
  await page.close();
});

// TAFLA (2026-10-19): die Startknoepfe sind 80pt-Scheiben, die voll sichtbar
// ruhen - der erste Tipp startet (vorher weckte er nur, weil die Knoepfe fast
// unsichtbar im Fuss lagen; test:wall-timer). (4b) mass, dass das Wecken die
// Knoepfe nicht verschiebt; ohne Wecken gibt es nichts mehr zu verschieben.
test('(4) Wand-Minutnik: sichtbar in Ruhe, der erste Tipp startet, die Anzeige ist ein timer', async () => {
  const page = await dashboardPage({ device: 'mobile' });
  await enterDashboardWall(page);
  await page.waitForSelector('.wall [data-wall-timer-start]');
  await settle(page);
  const rest = await page.evaluate(() => {
    document.getAnimations().forEach((a) => { try { a.finish(); } catch { /* egal */ } });
    const btn = document.querySelector('[data-wall-timer-start="5"]');
    const cs = getComputedStyle(btn);
    const r = btn.getBoundingClientRect();
    return { color: cs.color, background: cs.backgroundColor, opacity: cs.opacity, w: r.width, h: r.height };
  });
  const alpha = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); const p = m ? m[1].split(',').map(Number) : []; return p.length === 4 ? p[3] : 1; };
  assert.ok(alpha(rest.color) > 0 && alpha(rest.background) > 0 && Number(rest.opacity) > 0,
    `die Scheibe ruht unsichtbar (color ${rest.color}, background ${rest.background}, opacity ${rest.opacity})`);
  assert.ok(rest.w >= 56 && rest.h >= 56, `Treffflaeche ${rest.w}x${rest.h}`);

  await page.tap('[data-wall-timer-start="5"]');
  await page.waitForSelector('.wall__timer');
  assert.ok(await page.evaluate(() => localStorage.getItem('yuvomi-wall-timer')), 'der erste Tipp startet');
  assert.equal(await page.$eval('.wall__timer', (el) => el.getAttribute('role')), 'timer',
    'die tickende Anzeige ist keine Live-Region');
  await new Promise((r) => { setTimeout(r, 150); });
  assert.match(await page.$eval('#route-announcer', (el) => el.textContent.trim()), /Küchentimer läuft/, 'der Start wird angesagt');

  await page.evaluate(() => {
    localStorage.removeItem('yuvomi-wall-timer');
  });
  await page.close();
});

test('(5) die Knoepfe von Dziś halten am Touch-Tablet die Fingergroesse', async () => {
  const page = await dashboardPage({
    device: 'mobile',
    viewport: { width: 1180, height: 820, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  });
  await gotoRoute(page, '/');
  await page.waitForSelector(CUSTOMIZE);
  const touch = await page.evaluate(() => matchMedia('(hover: none)').matches && innerWidth >= 1024);
  assert.ok(touch, 'Reichweite: ein Touch-Geraet ueber 1024px Breite');
  for (const sel of [CUSTOMIZE, '.day-head__me']) {
    const area = await hitArea(page, sel);
    assert.ok(area.w >= 48 && area.h >= 48, `${sel}: ${area.w}x${area.h} am Finger, verlangt 48`);
  }
  await page.close();
});

test('(6) Griffe und Schalter in „Dostosuj Dziś" messen am Zeiger die Zielgroesse', async () => {
  const page = await dashboardPage({ device: 'desktop' });
  assert.equal(DEVICES.desktop.hasTouch, false, 'Reichweite: Zeigergeraet');
  await openSheet(page);
  const boxes = await page.$$eval('.day-sheet [data-grip], .day-sheet [data-switch], .day-sheet [data-sheet-action]',
    (els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      return { what: el.dataset.switch ? `switch ${el.dataset.switch}` : el.dataset.sheetAction ?? 'grip', w: r.width, h: r.height };
    }));
  assert.ok(boxes.length >= 6, `Reichweite: ${boxes.length} Bedienelemente im Blatt`);
  const low = boxes.filter((b) => b.h < 44 || b.w < 44).map((b) => `${b.what} ${Math.round(b.w)}x${Math.round(b.h)}`);
  assert.deepEqual(low, [], 'Bedienelemente unter der Zielgroesse des Zeigers (--target-base)');
  await page.close();
});
