/**
 * Modul: Flaeche und Raster der Uebersicht - Browser-Sonde
 * Zweck: misst im GERENDERTEN Dokument, was die Critique vom 23.09.2026 an der
 *        Flaeche fand: den Nachlauf am Seitenende, den mobilen Kopf, die
 *        kompakte Hoehenklasse und die Rasterloecher bei eigener Reihenfolge.
 * Ausfuehren: npm run test:dashboard-surface-browser (haengt an test:document-guards)
 *
 * WARUM IM BROWSER: alle vier Befunde sind im Stylesheet unsichtbar.
 *   - Der Nachlauf STAND im Stylesheet (`padding-block-end: 96px` an
 *     `.app-content`) und griff trotzdem nicht: `.page-transition` hat eine
 *     feste Hoehe, der Inhalt laeuft darueber hinaus, und das Polster eines
 *     Scrollports haengt am Ende seines Fluss-Kindes, nicht am Ende des
 *     Ueberlaufs. Gemessen blieben 24px statt 96px, der FAB lag am Seitenende
 *     auf der rechten Spalte. Ein Guard, der den CSS-Wert liest, war gruen.
 *   - Der Kopf brach bei 390px dreizeilig um, weil ein Element mit
 *     `flex: 0 0 100%` die Werkzeugspalte auf 187px aufblaehte - eine Regel,
 *     deren Wirkung nur die Layout-Engine kennt.
 *   - Ob das Raster Loecher hat, entscheidet der Auto-Placement-Algorithmus.
 */

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, openPage, gotoRoute, enterDashboardWall, clickLive } from './document-guards-harness.js';

let harness;

before(async () => {
  harness = await startHarness();
});

beforeEach(async () => {
  await harness.reset();
});

after(async () => {
  await harness?.close();
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function freeze(page) {
  await page.evaluate(() => {
    document.getAnimations().forEach((a) => { try { a.finish(); } catch { /* endlos */ } });
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Der Nachlauf reitet am Inhaltsende
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Faehrt `.app-content` ans Ende und misst den Abstand zwischen der Unterkante
 * des letzten GEMALTEN Inhalts und der Unterkante des Scrollports.
 *
 * „Gemalt" heisst: ein Blatt ohne Element-Kinder oder eine Box mit Flaeche,
 * Rahmen oder Schatten. Eine transparente Huelle zaehlt nicht - `.dashboard`
 * etwa reicht mit ihrem eigenen Polster bis an die Kante und wuerde jeden
 * Nachlauf als 0 melden.
 */
async function tailAtEnd(page) {
  await freeze(page);
  const toEnd = () => page.evaluate(() => {
    const ac = document.querySelector('.app-content');
    ac.scrollTop = ac.scrollHeight;
  });
  await toEnd();
  await wait(400);
  await toEnd();
  await wait(300);
  return page.evaluate(() => {
    const ac = document.querySelector('.app-content');
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;inline-size:0;block-size:var(--shell-tail)';
    ac.append(probe);
    const shellTail = probe.getBoundingClientRect().height;
    probe.remove();

    const bottom = ac.getBoundingClientRect().bottom;
    let last = 0;
    let who = '';
    for (const el of ac.querySelectorAll('.page-transition *')) {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.visibility === 'hidden') continue;
      const painted = !el.children.length
        || cs.backgroundColor !== 'rgba(0, 0, 0, 0)'
        || cs.boxShadow !== 'none'
        || parseFloat(cs.borderBottomWidth) > 0;
      if (!painted) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      // Sichtbar ist nur, was kein innerer Scroller wegschneidet: die klebende
      // Einstellungs-Liste (R10) scrollt fuer sich, ihre letzten Zeilen liegen
      // rechnerisch 300px unter dem Fenster, zu sehen ist ihre Kante. Deren
      // Unterkante misst die Sonde weiter - sie ist selbst Inhalt.
      let seenBottom = r.bottom;
      for (let a = el.parentElement; a && a !== ac; a = a.parentElement) {
        if (getComputedStyle(a).overflowY !== 'visible') seenBottom = Math.min(seenBottom, a.getBoundingClientRect().bottom);
      }
      if (seenBottom <= r.top) continue;
      if (seenBottom > last) { last = seenBottom; who = String(el.className || el.tagName).slice(0, 60); }
    }
    return {
      path: location.pathname,
      shellTail: Math.round(shellTail),
      tail: Math.round(bottom - last),
      scrolls: ac.scrollHeight > ac.clientHeight + 1,
      ownScrollport: !!document.querySelector('.page-scrollport'),
      who,
    };
  });
}

/* Die Routen, auf denen `.app-content` selbst scrollt. Der Nachlauf ist dort
 * nur zu sehen, wenn eine fixierte Flaeche ihn verlangt - ausser der Uebersicht
 * (FAB am Zeiger) keine davon im Seed. Das Install-Banner ist der dritte
 * Summand und gilt auf JEDER Route; die Sonde setzt seinen Summanden so, wie es
 * `:root:has(yuvomi-install-prompt[data-shown])` tut, statt das Bauteil
 * vorzutaeuschen. Die Rechnung darueber (`--shell-tail` an `.app-content`)
 * laeuft unveraendert. */
const PAGE_SCROLL_ROUTES = ['/', '/tasks', '/settings', '/documents', '/health', '/housekeeping', '/rewards', '/birthdays'];

for (const device of ['desktop', 'mobile']) {
  test(`Nachlauf: am Seitenende liegt der volle Nachlauf unter dem letzten Inhalt (${device})`, async () => {
    const page = await openPage(harness, { device });
    const findings = [];
    const seen = [];
    for (const path of PAGE_SCROLL_ROUTES) {
      await gotoRoute(page, path);
      // Die Uebersicht bringt mobil ihren FAB am Zeiger selbst mit; dort wird
      // der echte Summand gemessen, nicht der gesetzte. Am Desktop dockt er
      // seit R14 (Re-Critique 2026-09-28, A8 P3-2) als Pille "+ Neu" im Kopf
      // - dann schwebt nichts, und die Uebersicht misst wie jede Route den
      // Summanden des Install-Banners.
      const floatingFab = await page.evaluate(() => [...document.querySelectorAll('.page-fab:not([hidden])')]
        .some((el) => getComputedStyle(el).position === 'fixed'));
      if (path !== '/' || device === 'mobile' || !floatingFab) {
        await page.evaluate(() => document.documentElement.style.setProperty('--install-prompt-tail', '96px'));
      }
      const m = await tailAtEnd(page);
      if (m.ownScrollport) continue;
      seen.push(path);
      if (m.shellTail < 1) {
        findings.push(`${path}: Reichweite - --shell-tail ist 0, es gibt nichts zu messen`);
        continue;
      }
      if (m.tail < m.shellTail - 1) {
        findings.push(`${path}: ${m.tail}px unter dem letzten Inhalt (${m.who}), verlangt ${m.shellTail}px `
          + `(scrollt: ${m.scrolls})`);
      }
    }
    await page.close();
    assert.ok(seen.length >= 6, `Reichweite: nur ${seen.length} Routen ohne eigenen Scrollport gesehen (${seen.join(', ')})`);
    assert.deepEqual(findings, [], `Der Nachlauf greift nicht:\n${findings.join('\n')}`);
  });
}

// TAFLA (2026-10-19): Dziś ist eine Spalte, kein Raster. Die Regel dahinter
// bleibt: am Seitenende liegt keine schwebende Flaeche auf Inhalt. Steht am
// Desktop kein schwebender Knopf (der Anlegen-Weg gehoert der Kapsel und ihrem
// +), gibt es nichts, das verdecken koennte.
test('Nachlauf: am Seitenende der Uebersicht liegt der FAB auf keinem Inhalt (desktop)', async () => {
  const page = await openPage(harness, { device: 'desktop' });
  await gotoRoute(page, '/');
  await page.waitForSelector('[data-today]');
  await tailAtEnd(page);
  const hits = await page.evaluate(() => {
    const fab = [...document.querySelectorAll('.page-fab:not([hidden])')].find((el) => getComputedStyle(el).position === 'fixed');
    if (!fab) return { reach: true, ids: [] };
    const f = fab.getBoundingClientRect();
    // 2026-10-27, v2: die Karten von Dziś und die Zeilen von Wkrótce.
    const blocks = [...document.querySelectorAll('[data-today] .dz-card, [data-today] .dz-soon__row')];
    return {
      reach: blocks.length > 0,
      ids: blocks.filter((b) => {
        const r = b.getBoundingClientRect();
        return r.left < f.right && r.right > f.left && r.top < f.bottom && r.bottom > f.top;
      }).map((b) => b.className),
    };
  });
  await page.close();
  assert.ok(hits.reach, 'Reichweite: Dziś hat keinen Inhalt');
  assert.deepEqual(hits.ids, [], `Am Seitenende liegt der FAB auf: ${hits.ids.join(', ')}`);
});

test('Nachlauf: eine Seite mit eigenem Scrollport behaelt ihre Hoehe (desktop)', async () => {
  // Gegenrichtung: der Nachlauf der Seitenscroller darf die Seiten, deren Root
  // `height: 100%` traegt, nicht aus dem Fenster schieben - dort scrollt
  // `.app-content` gar nicht.
  const page = await openPage(harness, { device: 'desktop' });
  const findings = [];
  for (const path of ['/notes', '/budget', '/calendar', '/contacts']) {
    await gotoRoute(page, path);
    await page.evaluate(() => document.documentElement.style.setProperty('--install-prompt-tail', '96px'));
    const m = await page.evaluate(() => {
      const ac = document.querySelector('.app-content');
      return { own: !!document.querySelector('.page-scrollport'), over: ac.scrollHeight - ac.clientHeight };
    });
    if (!m.own) findings.push(`${path}: Reichweite - kein .page-scrollport`);
    else if (m.over > 1) findings.push(`${path}: .app-content scrollt ${m.over}px, obwohl die Seite ihren Scrollport mitbringt`);
  }
  await page.close();
  assert.deepEqual(findings, [], findings.join('\n'));
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Der Kopf der Uebersicht
 * ──────────────────────────────────────────────────────────────────────────── */

// 2026-10-27, v2: der Kopf heisst `.dz-head` (Datum 15, Gruss 26/32, Avatar).
async function measureHead(page) {
  await page.waitForSelector('[data-today] .dz-head__greeting');
  await freeze(page);
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const title = q('.dz-head__greeting');
    const lines = (text) => {
      title.textContent = text;
      const cs = getComputedStyle(title);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
      return Math.round(title.getBoundingClientRect().height / lh);
    };
    const original = title.textContent;
    // Alle drei Tageszeiten: die Sonde darf nicht an der Uhrzeit des Laufs haengen.
    const variants = ['Guten Morgen, Linda', 'Guten Tag, Linda', 'Guten Abend, Linda'];
    const titleLines = Object.fromEntries(variants.map((v) => [v, lines(v)]));
    title.textContent = original;
    const box = (s) => {
      const el = q(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height),
        left: Math.round(r.left), right: Math.round(r.right),
        shown: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 1 && r.height > 1,
      };
    };
    // Wie breit der Gruss wirklich geschrieben ist, nicht seine Box.
    const range = document.createRange();
    range.selectNodeContents(title);
    const text = range.getBoundingClientRect();
    const first = q('[data-today] .dz-weather, [data-today] .dz-sec, [data-today] .dz-soon');
    return {
      titleLines,
      titleText: title.textContent.trim(),
      titleRight: Math.round(text.right),
      date: box('.dz-head__date'),
      title: box('.dz-head__greeting'),
      tools: box('.dz-head__me'),
      disc: box('.dz-head__me .day-disc'),
      overview: box('.dz-head'),
      updated: box('.wall__updated'),
      firstContent: first ? Math.round(first.getBoundingClientRect().top) : null,
    };
  });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 375, height: 812 }]) {
  test(`Kopf mobil ${viewport.width}x${viewport.height}: Large Title einzeilig, Knoepfe in der Datumszeile`, async () => {
    const page = await openPage(harness, { device: 'mobile' });
    await page.setViewport({ ...viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await gotoRoute(page, '/');
    const m = await measureHead(page);
    await page.close();

    const umbrochen = Object.entries(m.titleLines).filter(([, n]) => n !== 1);
    assert.deepEqual(umbrochen, [], `Der Gruss bricht um: ${umbrochen.map(([t, n]) => `"${t}" ${n} Zeilen`).join(', ')}`);
    // TAFLA (2026-10-19): rechts steht nur der eigene Avatar (36, Treffer 44).
    // v2 (2026-10-27): er steht oben buendig mit dem Datum und reicht neben
    // den Gruss - die Schrift des Grusses endet vor ihm.
    assert.ok(Math.abs(m.disc.top - m.date.top) <= 2, `Der Avatar steht oben buendig mit dem Datum (${m.disc.top} / ${m.date.top})`);
    assert.ok(m.titleRight <= m.disc.left, `Gruss und Avatar beruehren sich nicht (Gruss bis ${m.titleRight}, Avatar ab ${m.disc.left})`);
    assert.ok(m.date.top < m.title.top && m.date.bottom <= m.title.top + 1, 'Das Datum steht ueber dem Titel');
    assert.ok(!m.updated?.shown, 'Der Stand-Anker gehoert der Wand, nicht dem Telefon');
    // Vorher 227px (ohne Wetterzeile) bzw. 274px (mit). v2: Kopf 56 und 24
    // Abstand - die erste Karte steht unter 190.
    assert.ok(m.firstContent !== null && m.firstContent <= 190,
      `Der erste Inhalt beginnt erst bei ${m.firstContent}px`);
  });
}

test('Kopf desktop: nicht hoeher als vorher, Werkzeuge rechts auf Hoehe des Datums', async () => {
  const page = await openPage(harness, { device: 'desktop' });
  await gotoRoute(page, '/');
  const m = await measureHead(page);
  await page.close();
  // TAFLA (2026-10-19): Datum 18, Gruss 41, die Wetterzeile 22 - hoechstens
  // 89px. v2 (2026-10-27): Datum 20, 4 Abstand, Gruss 32 - 56px; das Wetter
  // ist eine eigene Karte darunter.
  assert.ok(m.overview.height <= 60, `Der Kopf ist am Desktop ${m.overview.height}px hoch`);
  assert.equal(m.titleLines['Guten Morgen, Linda'], 1);
  assert.ok(Math.abs(m.disc.top - m.date.top) <= 2, 'Der Avatar steht oben buendig mit dem Datum');
  assert.ok(!m.updated?.shown, 'Kein Stand-Anker ausserhalb des Wand-Modus');
});

test('Kopf in der kompakten Hoehenklasse (640x400): nur die Datumszeile bleibt sichtbar', async () => {
  const page = await openPage(harness, { device: 'short' });
  await gotoRoute(page, '/');
  const m = await measureHead(page);
  const a11y = await page.evaluate(() => {
    const t = document.querySelector('.dz-head__greeting');
    return { tag: t?.tagName, text: t?.textContent.trim() };
  });
  await page.close();
  assert.ok(!m.title.shown, 'Der Large Title steht in 400px Hoehe noch sichtbar da');
  assert.equal(a11y.tag, 'H2', 'Die Ueberschrift bleibt fuer Screenreader im Dokument');
  assert.ok(a11y.text.length > 0);
  assert.ok(m.date.shown && m.tools.shown, 'Datum und Avatar bleiben');
  // Datumszeile (Knopf 44px) plus Polster - vorher 150px und mehr.
  assert.ok(m.overview.height <= 72, `Der Kopf ist in 400px Hoehe ${m.overview.height}px hoch`);
});

// TAFLA (2026-10-19): hier stand „der Stand-Anker steht weiter auf der Wand"
// („Zaktualizowano 18:11" im Fuss). Das Artboard „Ściana" hat kein
// „Updated" mehr - die Wand sagt ihren Datenstand nur, wenn er alt ist
// („dane sprzed 12 min", test:wall-tafla).
test('Wand-Modus: ein frischer Datenstand steht nicht auf der Wand', async () => {
  const page = await openPage(harness, { device: 'desktop' });
  await page.evaluate(() => localStorage.setItem('yuvomi-wall-mode', '1'));
  await gotoRoute(page, '/');
  await page.waitForSelector('.wall-plan, .wall-hero, .wall__stage', { timeout: 10000 }).catch(() => {});
  const m = await page.evaluate(() => ({
    wall: !!document.querySelector('.wall'),
    updated: !!document.querySelector('.wall__updated'),
    stale: !!document.querySelector('.wall__stale'),
  }));
  await page.evaluate(() => localStorage.removeItem('yuvomi-wall-mode'));
  await page.close();
  assert.ok(m.wall, 'Reichweite: die Wand steht');
  assert.ok(!m.updated && !m.stale, 'frisch geladen: kein Stand, keine Warnung');
});

test('Wand-Modus 1280x800: nichts unter 24px, und das Dock liegt im Bild', async () => {
  const page = await openPage(harness, { device: 'desktop' });
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
  await page.evaluate(() => localStorage.setItem('yuvomi-wall-mode', '1'));
  await gotoRoute(page, '/');
  await page.waitForSelector('.wall-plan__list .wall-row, .wall-plan__state', { timeout: 10000 }).catch(() => {});
  await freeze(page);
  const m = await page.evaluate(() => {
    const wall = document.querySelector('.wall');
    const sizes = [...(wall?.querySelectorAll('*') ?? [])]
      .filter((el) => el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
      .filter((el) => el.getClientRects().length && !el.closest('.sr-only'))
      .map((el) => ({ text: el.textContent.trim().slice(0, 30), px: parseFloat(getComputedStyle(el).fontSize) }));
    const dock = document.querySelector('.wall__dock')?.getBoundingClientRect();
    return { sizes, fits: !!dock && dock.bottom <= innerHeight + 1, scrolls: (wall?.scrollHeight ?? 0) > innerHeight + 1 };
  });
  await page.evaluate(() => localStorage.removeItem('yuvomi-wall-mode'));
  await page.close();
  assert.ok(m.sizes.length > 5, `Reichweite: ${m.sizes.length} Texte gelesen`);
  const small = m.sizes.filter((x) => x.px < 24);
  assert.deepEqual(small, [], 'auf der Wand steht nichts unter 24px');
  assert.ok(m.fits, 'Das Dock mit Ausstieg und Minutnik liegt nicht im Bild');
  assert.ok(!m.scrolls, 'Die Wand passt in das Bild - sie scrollt nicht');
});

/* DER AUSSTIEG LIEGT IN JEDER GROESSE IM BILD (#1559). Die Sonde darueber mass
 * nur 1280x800, wo der Fuss passt. Auf 390x844 lag `#wall-exit` bei y=832-880,
 * auf 375x667 ganz unter der Kante - erreichbar nur per Scrollen, und im
 * Ruhezustand ein graues Zeichen ohne Wort. Gemessen wird die RUHENDE Wand
 * (kein Zeiger hat sie geweckt), am Anfang des Scrollwegs, also genau das Bild,
 * das jemand nach dem Einschalten sieht. Keine Regel nach Geraeteklasse
 * (d697fa1e4): dieselbe Erwartung fuer Telefon und Wand. */
const WALL_VIEWPORTS = [
  { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];

for (const viewport of WALL_VIEWPORTS) {
  test(`Wand-Modus ${viewport.width}x${viewport.height}: der Ausstieg liegt ganz im Bild und traegt sein Wort (#1559)`, async () => {
    const page = await openPage(harness, { device: viewport.isMobile ? 'mobile' : 'desktop' });
    await page.setViewport(viewport);
    await page.evaluate(() => localStorage.setItem('yuvomi-wall-mode', '1'));
    await gotoRoute(page, '/');
    await page.waitForSelector('.wall-plan__list .wall-row, .wall-plan__state', { timeout: 10000 }).catch(() => {});
    await freeze(page);
    const m = await page.evaluate(() => {
      const btn = document.getElementById('wall-exit');
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      const label = btn.querySelector('span');
      const lr = label?.getBoundingClientRect();
      const lcs = label ? getComputedStyle(label) : null;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        awake: document.querySelector('.wall')?.hasAttribute('data-wall-awake'),
        rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) },
        width: r.width,
        height: r.height,
        vw: document.documentElement.clientWidth,
        vh: innerHeight,
        labelText: label?.textContent.trim() ?? '',
        labelShown: !!lr && lr.width > 1 && lr.height > 1 && lcs.display !== 'none' && lcs.visibility !== 'hidden'
          && parseFloat(lcs.opacity) > 0.5,
        onTop: !!hit && btn.contains(hit),
      };
    });
    await page.evaluate(() => localStorage.removeItem('yuvomi-wall-mode'));
    await page.close();
    assert.ok(m, 'Reichweite: kein #wall-exit auf der Wand');
    assert.ok(!m.awake, 'Reichweite: die Wand ist geweckt, gemessen werden soll der Ruhezustand');
    const r = m.rect;
    assert.ok(r.top >= 0 && r.left >= 0 && r.bottom <= m.vh && r.right <= m.vw,
      `Der Ausstieg liegt nicht ganz im Bild: ${r.left}-${r.right} x ${r.top}-${r.bottom} bei ${m.vw}x${m.vh}`);
    assert.ok(m.onTop, 'Der Ausstieg ist verdeckt - ein Tipp auf seine Mitte trifft etwas anderes');
    assert.ok(m.width >= 44 && m.height >= 44, `Treffflaeche ${Math.round(m.width)}x${Math.round(m.height)}px`);
    assert.ok(m.labelShown && m.labelText.length > 0,
      `Der ruhende Ausstieg zeigt kein Wort (Beschriftung "${m.labelText}", sichtbar: ${m.labelShown})`);
  });
}

/* ZURUECK BEENDET DIE WAND (#1559). Es gab weder einen History-Eintrag noch
 * einen `popstate`-Handler: in der installierten App schloss Zurueck die App,
 * und beim naechsten Start stand die Wand wieder da. Gemessen wird, dass die
 * Geste im SELBEN Dokument bleibt (kein Ladevorgang), auf der Uebersicht
 * landet und den gemerkten Modus loescht. */
async function markDocument(page) {
  await page.evaluate(() => { window.__wallProbeDoc = true; });
}

async function afterBack(page) {
  // Verlaesst die Geste das Dokument, reisst sie den Ausfuehrungskontext mit -
  // das ist der gemessene Fehler, kein Messfehler: dann fehlt die Marke.
  await page.evaluate(() => history.back()).catch(() => {});
  await wait(900);
  await page.waitForFunction(() => document.getElementById('main-content')?.children.length > 0, { timeout: 10000 })
    .catch(() => {});
  return page.evaluate(() => ({
    sameDoc: window.__wallProbeDoc === true,
    path: location.pathname,
    wallAttr: document.documentElement.hasAttribute('data-wall-mode'),
    // Auf `about:blank` (die App ist „geschlossen") ist der Speicher gesperrt.
    stored: (() => { try { return localStorage.getItem('yuvomi-wall-mode'); } catch { return 'unlesbar'; } })(),
    wallSurface: !!document.querySelector('.dashboard--wall'),
    overview: !!document.querySelector('[data-today]'),
  }));
}

test('Wand-Modus: Einschalten sagt, was das ist und wie man herauskommt; Zurueck beendet ihn (#1559)', async () => {
  const page = await openPage(harness, { device: 'mobile' });
  await page.setViewport(WALL_VIEWPORTS[0]);
  await page.evaluate(() => localStorage.removeItem('yuvomi-wall-mode'));
  // 2026-10-27, v2: der Einstieg steht in „Więcej" und fuehrt per Navigation
  // auf `/` - im selben Dokument. Die Marke steht deshalb auf /more, und die
  // Tiefe zaehlt diese eine Navigation mit.
  await gotoRoute(page, '/more');
  await markDocument(page);
  const depthBefore = await page.evaluate(() => history.length);
  await clickLive(page, '[data-more-action="wall"]', { timeout: 15000 });
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-wall-mode'), { timeout: 5000 });
  await wait(300);
  const hint = await page.evaluate(async () => {
    const { t } = await import('/i18n.js');
    const toasts = [...document.querySelectorAll('.toast')].map((el) => el.textContent.trim());
    return { toasts, exitWord: t('dashboard.wallExit') };
  });
  const depthIn = await page.evaluate(() => history.length);
  const out = await afterBack(page);
  await page.evaluate(() => localStorage.removeItem('yuvomi-wall-mode')).catch(() => {});
  await page.close();

  assert.ok(hint.toasts.some((text) => text.includes(hint.exitWord)),
    `Kein Hinweis beim Einschalten, der den Ausstieg nennt ("${hint.exitWord}"): ${JSON.stringify(hint.toasts)}`);
  assert.equal(depthIn, depthBefore + 2, 'Die Navigation auf / und genau EIN History-Eintrag der Wand');
  assert.ok(out.sameDoc, 'Zurueck hat das Dokument verlassen statt die Wand zu beenden');
  assert.equal(out.path, '/');
  assert.ok(!out.wallAttr && !out.wallSurface, 'Nach Zurueck steht noch die Wand');
  assert.equal(out.stored, null, 'Nach Zurueck ist der Modus noch gemerkt - beim naechsten Start stuende die Wand wieder da');
  assert.ok(out.overview, 'Nach Zurueck steht nicht die Uebersicht');
});

test('Wand-Modus nach einem Neustart: Zurueck beendet ihn, statt die App zu verlassen (#1559)', async () => {
  const page = await openPage(harness, { device: 'mobile' });
  await page.setViewport(WALL_VIEWPORTS[1]);
  // Der Neustart: der Modus ist gemerkt, die Seite laedt hart auf `/`.
  await page.evaluate(() => localStorage.setItem('yuvomi-wall-mode', '1'));
  await gotoRoute(page, '/');
  await markDocument(page);
  const before = await page.evaluate(() => document.documentElement.hasAttribute('data-wall-mode'));
  const out = await afterBack(page);
  await page.evaluate(() => localStorage.removeItem('yuvomi-wall-mode')).catch(() => {});
  await page.close();

  assert.ok(before, 'Reichweite: nach dem Neustart steht keine Wand');
  assert.ok(out.sameDoc, 'Zurueck hat das Dokument verlassen statt die Wand zu beenden');
  assert.equal(out.path, '/');
  assert.ok(!out.wallAttr && !out.wallSurface, 'Nach Zurueck steht noch die Wand');
  assert.equal(out.stored, null, 'Nach Zurueck ist der Modus noch gemerkt');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. Dziś v2 (2026-10-27): die Seite des Entwurfs „Main"
 * ──────────────────────────────────────────────────────────────────────────── */

/* TAFLA (2026-10-19) mass hier die Reihenfolge der Person, die Zeilen des
 * Plans bei 56, die Vorschaukacheln und „Dostosuj Dziś". Mit v2 ist die
 * Reihenfolge die des Entwurfs, und es gibt nichts anzupassen; gemessen wird,
 * was der Entwurf zusagt: Kopf, Wetter, Kalender, Aufgaben, Wkrótce von oben
 * nach unten, 16 Rand am Telefon, Zeilen 48 hoch, Ziele 44, nichts scrollt
 * waagerecht. */

/** Ein nasser Tag in jeder Stunde: Regenzeile und Diagramm stehen immer. */
const RAINY = {
  data: {
    provider: 'open-meteo', city: 'Dortmund', units: 'metric',
    current: { temp: 11, feels_like: 9, humidity: 80, icon: 'cloud-rain', desc: 'wmo.61', wind_speed: 11 },
    today: { date: '2026-10-27', temp_min: 8, temp_max: 14, icon: 'cloud-rain', desc: 'wmo.61', pop_max: 85, rain_window: { from: 0, to: 23 } },
    today_hours: Array.from({ length: 24 }, (_, hour) => ({ hour, pop: hour % 2 ? 85 : 20, mm: 0.4 })),
    forecast: [],
  },
};

test('Dziś: von oben nach unten Kopf, Wetter, Kalender, Aufgaben, Wkrótce - 16 Rand, Zeilen 48, Ziele 44', async () => {
  const page = await openPage(harness, { device: 'mobile' });
  answerWeather(page, RAINY);
  await gotoRoute(page, '/');
  await page.waitForSelector('[data-today] .dz-weather');
  await freeze(page);
  const m = await page.evaluate(() => {
    const top = (sel) => document.querySelector(sel)?.getBoundingClientRect().top ?? null;
    const order = ['.dz-head', '.dz-weather', '.dz-sec--calendar', '.dz-sec--tasks', '.dz-soon']
      .map((sel) => [sel, top(`[data-today] ${sel}`)]).filter(([, y]) => y !== null);
    const rows = [...document.querySelectorAll('[data-today] .dz-cal__link, [data-today] .dz-task')]
      .map((el) => Math.round(el.getBoundingClientRect().height));
    return {
      order,
      left: Math.round(document.querySelector('[data-today]').getBoundingClientRect().left),
      rows,
      small: [...document.querySelectorAll('[data-today] button, [data-today] a')]
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && (r.height < 43.5 || r.width < 43.5))
        .map(({ el, r }) => `${el.className || el.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  await page.close();
  assert.ok(m.order.length >= 4, `Reichweite: ${m.order.map(([s]) => s).join(', ')}`);
  const ys = m.order.map(([, y]) => y);
  assert.deepEqual([...ys].sort((a, b) => a - b), ys, `Reihenfolge: ${m.order.map(([sel, y]) => `${sel}@${Math.round(y)}`).join(', ')}`);
  assert.equal(m.left, 16, 'der Rand am Telefon ist 16');
  assert.ok(m.rows.length > 0, 'Reichweite: keine Zeilen');
  assert.deepEqual(m.rows.filter((h) => h < 48), [], `Zeilen unter 48: ${m.rows.join(', ')}`);
  assert.deepEqual(m.small, [], `Ziele unter 44: ${m.small.join('; ')}`);
  assert.ok(!m.overflow, 'Dziś scrollt waagerecht');
});

test('Dziś: das Regendiagramm - Balken am Boden, hoechstens 14, eine Stunde „teraz", Regen ab 40 % in seinem Blau', async () => {
  const page = await openPage(harness, { device: 'mobile' });
  answerWeather(page, RAINY);
  await gotoRoute(page, '/');
  await page.waitForSelector('[data-today] .dz-chart');
  await freeze(page);
  const c = await page.evaluate(() => {
    const bars = [...document.querySelectorAll('[data-today] .dz-chart__bar')];
    const box = document.querySelector('[data-today] .dz-chart__bars').getBoundingClientRect();
    const color = (el) => getComputedStyle(el).backgroundColor;
    return {
      count: bars.length,
      now: bars.filter((b) => b.classList.contains('dz-chart__bar--now')).length,
      bottoms: [...new Set(bars.map((b) => Math.round(b.getBoundingClientRect().bottom)))],
      chartBottom: Math.round(box.bottom),
      height: Math.round(box.height),
      wet: [...new Set(bars.filter((b) => b.classList.contains('dz-chart__bar--wet')).map(color))],
      dry: [...new Set(bars.filter((b) => !b.className.includes('--')).map(color))],
      umbrella: !!document.querySelector('[data-today] .dz-weather__rain:not(.dz-weather__rain--dry)'),
      labels: document.querySelector('[data-today] .dz-chart__labels').children.length,
    };
  });
  await page.close();
  assert.ok(c.count >= 1 && c.count <= 14, `${c.count} Balken`);
  assert.equal(c.labels, c.count, 'unter jedem Balken seine Stelle fuer die Stunde');
  assert.equal(c.now, 1, 'genau eine Stunde ist „teraz"');
  assert.deepEqual(c.bottoms, [c.chartBottom], 'alle Balken stehen am Boden');
  assert.equal(c.height, 24);
  assert.ok(c.umbrella, 'der Regen steht in Worten mit dem Schirm');
  if (c.wet.length && c.dry.length) assert.notDeepEqual(c.wet, c.dry, 'Regen und Trockenes haben zwei Blau');
});

/* ────────────────────────────────────────────────────────────────────────────
 * Wetter: eingerichtet, aber gescheitert, verschwindet nicht (v2.70.0)
 * ──────────────────────────────────────────────────────────────────────────── */

/* Gemeldet produktiv mit Open-Meteo: die Wetterkachel fehlte im Raster, in der
 * Anpassen-Ablage UND in der Kopfzeile. Der Client machte aus jedem Fehlschlag
 * `{ data: null }`, der Renderer gab dafuer '' zurueck, und eine Kachel, die
 * `visible: true` bleibt und nichts zeichnet, ist aus der Oberflaeche heraus
 * nicht mehr erreichbar. Die Sonde antwortet an Stelle des Anbieters, damit sie
 * nicht vom Netz abhaengt. */
function answerWeather(page, reply) {
  page.__yuvomiRequestInterceptor = (req) => {
    if (!/\/api\/v1\/weather\?/.test(req.url())) return false;
    if (reply === 'abort') req.abort('failed');
    else req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(reply) });
    return true;
  };
}

/* TAFLA (2026-10-19): das Wetter war eine Zeile im Kopf, abschaltbar in
 * „Dostosuj Dziś". v2 (2026-10-27): es ist die erste Karte unter dem Kopf,
 * und es gibt nichts abzuschalten. Die Regel bleibt: ohne Wetter steht keine
 * leere Karte da - weder bei einem Fehlschlag noch ohne Einrichtung - und der
 * Rest der Seite steht trotzdem. */
async function weatherState(page) {
  await page.waitForSelector('[data-today] .dz-head');
  await wait(300);
  return page.evaluate(() => ({
    card: !!document.querySelector('[data-today] .dz-weather'),
    page: !!document.querySelector('[data-today] .dz-sec'),
  }));
}

for (const [label, reply] of [
  ['der Anbieter scheitert (upstream_error)', { data: null, reason: 'upstream_error' }],
  ['die Anfrage selbst scheitert (Seed hat Wetter eingerichtet)', 'abort'],
  ['nicht eingerichtet', { data: null, reason: 'not_configured' }],
]) {
  test(`Wetter: ${label} - keine leere Karte, der Rest von Dziś steht`, async () => {
    const page = await openPage(harness, { device: 'mobile' });
    answerWeather(page, reply);
    await gotoRoute(page, '/');
    const s = await weatherState(page);
    await page.close();
    assert.ok(s.page, 'Reichweite: Dziś steht mit seinen Abschnitten');
    assert.ok(!s.card, 'ohne Wetter keine Wetterkarte');
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Der FAB nach einem Neuaufbau aus der Seite heraus (#1588)
 * ──────────────────────────────────────────────────────────────────────────── */

/* DIE UEBERSICHT BAUT SICH AUCH OHNE ROUTER NEU AUF - beim Verlassen des
 * Wand-Modus, nach „erneut versuchen", nach einer Aenderung aus einer Kachel.
 * Der Router hebt den FAB nur in renderPage() in die Shell-Ebene (#634) und
 * zeichnet sein Glyph erst in updateNav(); ein Neuaufbau an ihm vorbei liess
 * den Knopf im Scrollport stehen. Gemeldet am Telefon: das Plus fehlte, und die
 * Tab-Kapsel hielt ihr hinteres Ende nicht mehr frei - ihre Reserve haengt an
 * `.fab-layer .page-fab`, die fuenf Slots wurden breiter und „Mehr" lag unter
 * dem Knopf. Gemessen wird deshalb, was man sieht: wo der Knopf haengt, ob er
 * ein Glyph hat und ob ein Tab-Slot unter ihm liegt. */
/* TAFLA (2026-10-19): der Speed-Dial der Uebersicht ist entfallen. Am Telefon
 * stand dort, wo er stand, das globale + der Shell (`#capture-plus`).
 * 2026-10-27, v2: auch das + ist weg - jede Seite legt in ihrem eigenen Kopf
 * an, und Dziś hat keinen Anlege-Knopf. Die Zusage des Neuaufbaus bleibt: er
 * laesst die Shell heil - die Leiste steht mit allen Tabs, und nirgends
 * (Shell-Ebene oder Scrollport) bleibt ein Knopf zurueck, der hier nichts
 * anlegt. */
async function todayChrome(page) {
  await page.waitForFunction(() => {
    const bar = document.querySelector('.nav-bottom__items');
    return bar && bar.getClientRects().length && !document.documentElement.hasAttribute('data-wall-mode');
  }, { timeout: 10000 });
  await freeze(page);
  await wait(300);
  return page.evaluate(() => {
    const shown = (el) => el.getClientRects().length > 0;
    return {
      plus: document.querySelectorAll('#capture-plus, #fab-main').length,
      fabs: [...document.querySelectorAll('#fab-layer .page-fab, #main-content .page-fab')].filter(shown).length,
      slots: [...document.querySelectorAll('.nav-bottom__items > .nav-item')].filter(shown).length,
    };
  });
}

function assertChromeIntact(state, when) {
  assert.ok(state.slots >= 3, `Reichweite (${when}): nur ${state.slots} Tab-Slots gesehen`);
  // Gesammelt statt einzeln: rot soll jeder Befund auf einmal stehen, nicht
  // nur der erste.
  const findings = [];
  if (state.plus !== 0) findings.push(`${state.plus} globale Plus-Knoepfe (#capture-plus/#fab-main) im Dokument`);
  if (state.fabs !== 0) findings.push(`${state.fabs} sichtbare Seiten-Knoepfe auf Dziś - die Seite legt nichts an`);
  assert.deepEqual(findings, [], `${when}:\n${findings.join('\n')}`);
}

/* DER UMGEKEHRTE WEG: beim Betreten bringt der Neuaufbau KEINEN FAB mit, und
 * der alte haengt schon in der Shell-Ebene neben dem Container. Geraeumt wurde
 * er bis dahin erst nach der Antwort von `/dashboard` - solange sie laeuft,
 * stand das Plus bedienbar auf einer Flaeche, die nichts anlegt. Die Anfrage
 * wird deshalb angehalten: gemessen wird der Moment, bevor die Daten da sind. */
test('FAB: beim Betreten des Wand-Modus steht keiner auf der Wand, auch solange die Daten laden (mobile, #1588)', async () => {
  const page = await openPage(harness, { device: 'mobile' });
  // 2026-10-27, v2: der Einstieg steht in „Więcej"; angehalten wird erst dort,
  // denn auch „Więcej" fragt /dashboard (seine Zahlen). Gewartet wird auf die
  // Leiste - das + gibt es nicht mehr.
  await gotoRoute(page, '/more');
  await page.waitForSelector('.nav-bottom__items .nav-item');
  await page.waitForSelector('[data-more-action="wall"]');
  const held = [];
  page.__yuvomiRequestInterceptor = (req) => {
    if (!/\/api\/v1\/dashboard(\?|$)/.test(req.url())) return false;
    held.push(req);
    return true;
  };
  await clickLive(page, '[data-more-action="wall"]');
  await page.waitForSelector('.wall #wall-exit');
  await wait(300);
  const state = await page.evaluate(() => ({
    wall: document.documentElement.hasAttribute('data-wall-mode'),
    fabs: [...document.querySelectorAll('#fab-main, #fab-layer .page-fab, #capture-plus')]
      .filter((el) => el.getClientRects().length).length,
  }));
  const pending = held.length;
  page.__yuvomiRequestInterceptor = null;
  for (const req of held) req.continue();
  await page.close();
  assert.ok(state.wall, 'Reichweite: die Wand steht');
  assert.ok(pending >= 1, 'Reichweite: die Anfrage an /dashboard wurde gar nicht angehalten');
  assert.equal(state.fabs, 0, `auf der Wand stehen ${state.fabs} FAB, solange die Daten laden`);
});

// 2026-10-27, v2: „steht er in der Shell-Ebene, mit Plus, neben der Kapsel" -
// das + ist weg; geprueft wird, dass der Neuaufbau die Shell heil laesst.
test('Dziś: nach dem Verlassen des Wand-Modus steht die Leiste, und kein Knopf bleibt zurueck (mobile, #1588, v2)', async () => {
  const page = await openPage(harness, { device: 'mobile' });
  assertChromeIntact(await todayChrome(page), 'vor dem Wand-Modus');
  await enterDashboardWall(page);
  await page.waitForSelector('.wall #wall-exit');
  await page.click('#wall-exit');
  const after = await todayChrome(page);
  await page.close();
  assertChromeIntact(after, 'nach dem Verlassen');
});

test('Dziś: nach "erneut versuchen" steht die Leiste, und kein Knopf bleibt zurueck (mobile, #1588, v2)', async () => {
  const page = await openPage(harness, { device: 'mobile' });
  let failNext = true;
  page.__yuvomiRequestInterceptor = (req) => {
    if (!failNext || !/\/api\/v1\/dashboard(\?|$)/.test(req.url())) return false;
    failNext = false;
    req.respond({ status: 500, contentType: 'application/json', body: '{"error":"probe"}' });
    return true;
  };
  await gotoRoute(page, '/');
  await page.waitForSelector('#dashboard-retry');
  assert.equal(failNext, false, 'Reichweite: die Uebersicht hat die gescheiterte Anfrage gar nicht gestellt');
  await page.click('#dashboard-retry');
  await page.waitForSelector('[data-today]');
  const after = await todayChrome(page);
  await page.close();
  assertChromeIntact(after, 'nach erneut versuchen');
});
