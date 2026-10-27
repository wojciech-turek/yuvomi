/**
 * Modul: Dashboard - Bedienung und Barrierefreiheit im gerenderten Dokument
 * Zweck: Was die Critique vom 2026-09-23 am lebenden Dashboard gemessen hat,
 *        hier als Programm gefahren statt als Textguard. Seit Tafla
 *        (2026-10-19) ist die Uebersicht „Dziś"; seit v2 (2026-10-27) zeigt
 *        sie, was der Entwurf „Main" zeigt - Kopf, Wetter, Kalender, Aufgaben,
 *        Wkrótce - und hat nichts mehr anzupassen. Die Fragen sind dieselben
 *        geblieben, gemessen wird an dem, was jetzt dasteht:
 *          (1) die Ziele von Dziś (Profil im Kopf, die Wetterkarte, der Kreis
 *              einer Aufgabe, „Tydzień", „Dodaj zadanie") sind an ihrem Zentrum
 *              das oberste Element und tragen 44/48px - Sonde 4
 *              (test-document-guards.js) ueberspringt verdeckte Ziele still,
 *          (2) jeder Abschnitt nennt sich nach einer eigenen h3 unter der h2
 *              des Kopfs, und keine Ueberschrift traegt eine Zahl im Namen
 *              (die Zahl der Aufgaben steht daneben, nicht darin),
 *          (3) Abhaken per Tastatur: der Kreis meldet seinen Zustand, die Zeile
 *              geht, der Fokus steht danach auf dem naechsten Kreis, und die
 *              Meldung bietet „Cofnij" an; „wcześniej" klappt per Tastatur auf,
 *          (4) die Startknoepfe des Wand-Timers ruhen sichtbar, und der erste
 *              Tipp startet,
 *          (5) die Knoepfe von Dziś halten am Touch-Tablet (1180px) die
 *              Fingergroesse - das Kriterium ist die Zeigerfaehigkeit, nicht
 *              die Breite,
 *          (6) der Start der Wand aus „Więcej" legt den Fokus auf die Flaeche,
 *              der Ausstieg an den Anfang von Dziś.
 * Ausfuehren: npm run test:dashboard-a11y-browser (haengt an test:document-guards)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, openPage, gotoRoute, settle, enterDashboardWall } from './document-guards-harness.js';

let harness;
before(async () => { harness = await startHarness(); });
after(async () => { await harness?.close(); });

/* Ein nasser Nachmittag in jeder Stunde: die Regenzeile und das Diagramm
 * stehen, ganz gleich, wann die Sonde laeuft. */
const WEATHER = {
  data: {
    provider: 'open-meteo', city: 'Dortmund', units: 'metric',
    current: { temp: 11, feels_like: 9, humidity: 80, icon: 'cloud-rain', desc: 'wmo.61', wind_speed: 11 },
    today: { date: '2026-10-27', temp_min: 8, temp_max: 14, icon: 'cloud-rain', desc: 'wmo.61', pop_max: 85, rain_window: { from: 0, to: 23 } },
    today_hours: Array.from({ length: 24 }, (_, hour) => ({ hour, pop: 85, mm: 0.6 })),
    forecast: [],
  },
};

/** Dziś mit einer Wetterantwort, die nicht vom Netz abhaengt. */
async function dashboardPage({ device = 'desktop', viewport = null } = {}) {
  await harness.reset();
  const page = await openPage(harness, { device, theme: 'light', locale: 'de' });
  if (viewport) await page.setViewport(viewport);
  page.__yuvomiRequestInterceptor = (req) => {
    if (!/\/api\/v1\/weather\?/.test(req.url())) return false;
    req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(WEATHER) });
    return true;
  };
  await gotoRoute(page, '/');
  await page.waitForSelector('[data-today] .dz-head__me');
  await settle(page);
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

const ME = '[data-today] .dz-head__me';
const WEATHER_CARD = '[data-today] .dz-weather';
const CHECK = '[data-today] .dz-task .day-check';
const WEEK = '[data-today] .dz-sec--calendar .dz-sec__link';
const ADD = '[data-today] .dz-tasks__add';

test('(1) die Ziele von Dziś liegen frei und tragen die Zielgroesse', async () => {
  for (const device of ['desktop', 'mobile']) {
    const page = await dashboardPage({ device });
    const min = device === 'mobile' ? 48 : 44;
    const targets = [ME, WEATHER_CARD, CHECK, WEEK, ADD];
    const present = [];
    for (const sel of targets) if (await page.$(sel)) present.push(sel);
    assert.deepEqual(present, targets, `${device}: Reichweite - es fehlt ${targets.filter((s) => !present.includes(s)).join(', ')}`);
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
    const sections = [...root.querySelectorAll('section')];
    const h2 = root.querySelector('h2');
    return {
      h2: h2 ? name(h2) : null,
      h2Count: root.querySelectorAll('h2').length,
      sections: sections.length,
      named: sections.map((s) => {
        const id = s.getAttribute('aria-labelledby');
        const h = id ? document.getElementById(id) : null;
        return { id, ok: !!h && h.tagName === 'H3' && s.contains(h), label: s.getAttribute('aria-label') };
      }),
      h3: [...root.querySelectorAll('h3')].map(name),
      h3BeforeH2: [...root.querySelectorAll('h3')].some((h) => h2 && (h.compareDocumentPosition(h2) & Node.DOCUMENT_POSITION_FOLLOWING)),
      chartHidden: root.querySelector('.dz-chart')?.getAttribute('aria-hidden'),
      weatherName: root.querySelector('.dz-weather')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
    };
  });
  assert.ok(tree.h2, 'der Kopf traegt eine h2 (die Begruessung)');
  assert.equal(tree.h2Count, 1, 'genau eine h2');
  assert.equal(tree.h3BeforeH2, false, 'keine h3 steht vor der h2 des Kopfs');
  assert.ok(tree.sections >= 2, `Reichweite: nur ${tree.sections} Abschnitt(e)`);
  const unnamed = tree.named.filter((s) => !s.ok && !s.label);
  assert.deepEqual(unnamed, [], 'Abschnitte ohne eigene h3 und ohne Namen');
  const withDigits = tree.h3.filter((n) => /\d/.test(n));
  assert.deepEqual(withDigits, [], 'Ueberschriften mit einer Zahl im zugaenglichen Namen');
  // Das Diagramm wiederholt fuer das Auge, was die Regenzeile in Worten sagt.
  assert.equal(tree.chartHidden, 'true');
  assert.match(tree.weatherName, /Regen|Deszcz|today\.rain/, `die Wetterkarte sagt den Regen in Worten: ${tree.weatherName}`);
  await page.close();
});

test('(3) Abhaken per Tastatur: Zustand, Fokus auf den naechsten Kreis, „Cofnij"; „wcześniej" klappt auf', async () => {
  const page = await dashboardPage({ device: 'desktop' });
  const circles = await page.$$eval(CHECK, (els) => els.map((el) => el.dataset.rowKey));
  assert.ok(circles.length >= 1, `Reichweite: ${circles.length} Kreise im Seed`);
  const [first, second] = circles;
  await page.focus(`${CHECK}[data-row-key="${first}"]`);
  await page.keyboard.press('Space');
  // Sofort: der Kreis meldet seinen Zustand.
  assert.equal(await page.$eval(`${CHECK}[data-row-key="${first}"]`, (el) => el.getAttribute('aria-pressed')), 'true');
  // Nach dem Halten (820 ms) geht die Zeile, der Fokus wandert weiter.
  await page.waitForFunction((key) => !document.querySelector(`[data-today] .dz-task[data-row-key="${key}"]`), { timeout: 8000 }, first);
  await settle(page);
  const after = await page.evaluate(() => ({
    key: document.activeElement?.dataset?.rowKey ?? '',
    action: document.activeElement?.dataset?.dayAction ?? '',
    body: document.activeElement === document.body,
  }));
  assert.equal(after.body, false, 'der Fokus ist auf <body> gefallen');
  if (second) assert.equal(after.key, second, `der Fokus steht auf dem naechsten Kreis, nicht auf ${JSON.stringify(after)}`);
  else assert.equal(after.action, 'add-task', 'ohne weiteren Kreis auf „Dodaj zadanie"');
  // Die Meldung bietet den Rueckweg an.
  // (Eine faellige Erinnerung traegt auch einen `.toast__undo` - gemeint ist
  // der mit dem Wort fuer Rueckgaengig.)
  const undo = await page.waitForFunction(() => [...document.querySelectorAll('.toast__undo')]
    .some((b) => /Rückgängig/.test(b.textContent)), { timeout: 5000 }).catch(() => null);
  assert.ok(undo, 'die Meldung traegt „Cofnij" (de: Rückgängig)');

  // „wcześniej" (nur wenn der Seed heute schon Vergangenes hat).
  const toggle = '[data-today] .dz-cal__earlier';
  if (await page.$(toggle)) {
    await page.focus(toggle);
    await page.keyboard.press('Enter');
    await settle(page);
    const open = await page.$eval(toggle, (el) => ({
      expanded: el.getAttribute('aria-expanded'),
      hidden: document.getElementById(el.getAttribute('aria-controls'))?.hidden,
      focused: document.activeElement === el,
    }));
    assert.deepEqual(open, { expanded: 'true', hidden: false, focused: true });
  }
  await page.close();
});

// TAFLA (2026-10-19): die Startknoepfe sind 80pt-Scheiben, die voll sichtbar
// ruhen - der erste Tipp startet (test:wall-timer).
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
    return { color: cs.color, background: cs.backgroundColor, shadow: cs.boxShadow, opacity: cs.opacity, w: r.width, h: r.height };
  });
  const alpha = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); const p = m ? m[1].split(',').map(Number) : []; return p.length === 4 ? p[3] : 1; };
  // Tags eine gefuellte Scheibe, in der Szene Noc (22-6) ein bernsteinfarbener
  // Ring - sichtbar ist sie in beiden.
  const shape = alpha(rest.background) > 0 || (rest.shadow && rest.shadow !== 'none');
  assert.ok(alpha(rest.color) > 0 && shape && Number(rest.opacity) > 0,
    `die Scheibe ruht unsichtbar (color ${rest.color}, background ${rest.background}, shadow ${rest.shadow}, opacity ${rest.opacity})`);
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
  const touch = await page.evaluate(() => matchMedia('(hover: none)').matches && innerWidth >= 1024);
  assert.ok(touch, 'Reichweite: ein Touch-Geraet ueber 1024px Breite');
  for (const sel of [ME, CHECK, WEEK, ADD]) {
    const area = await hitArea(page, sel);
    assert.ok(area.w >= 48 && area.h >= 48, `${sel}: ${area.w}x${area.h} am Finger, verlangt 48`);
  }
  await page.close();
});

test('(6) die Wand aus „Więcej": der Fokus steht auf der Flaeche, nach dem Ausstieg am Anfang von Dziś', async () => {
  const page = await dashboardPage({ device: 'desktop' });
  await enterDashboardWall(page);
  await page.waitForFunction(() => document.activeElement?.id === 'wall-surface', { timeout: 5000 })
    .catch(() => {});
  const onWall = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
  assert.equal(onWall, 'wall-surface', `nach dem Start steht der Fokus auf ${onWall}`);
  await page.focus('#wall-exit');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-today] .dz-head__me');
  await settle(page);
  const back = await page.evaluate(() => document.activeElement?.className ?? '');
  assert.match(back, /dz-head__me/, `nach dem Ausstieg steht der Fokus auf „${back}"`);
  await page.close();
});
