/**
 * Modul: Dashboard - was ein Screenreader und eine Tastatur auf der Uebersicht
 *        vorfinden.
 * Zweck: TAFLA (2026-10-19): das Raster der Widgets, sein Anpassen-Modus und
 *        „Heute wichtig" sind mit Dziś und der Wand gegangen - und mit ihnen
 *        die Faelle ueber Widget-Koepfe, Badges, Bearbeiten-Leisten, die
 *        Sammelzeile und den Kopf der alten Uebersicht. Hier bleibt, was fuer
 *        Dziś, „Dostosuj Dziś", die Wand und den Router weiter gilt.
 *        Rendering mit dem Loader-Stub: t('key', values) kommt als
 *        "key" + JSON.stringify(values) zurueck. Das Verhalten im gerenderten
 *        Dokument (Fokus, Ansagen, Trefferflaechen) prueft
 *        test-dashboard-a11y-browser.js.
 * Ausfuehren: npm run test:dashboard-a11y
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./test-browser-loader.mjs', import.meta.url);

const { __test } = await import('../public/pages/dashboard.js');
const { buildPlan, planContext } = await import('../public/utils/today-plan.js');
const { renderPlanRow } = await import('../public/components/today-view.js');

/** Der Text, den ein Screenreader aus einem Markup-Stueck liest: ohne aria-hidden und ohne Tags. */
function accessibleText(html) {
  // Tag fuer Tag statt per Ersetzung: ein Teilbaum unter aria-hidden="true" bleibt stumm,
  // auch verschachtelt, und aus den Resten kann kein neues Tag zusammenwachsen.
  const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr']);
  const hidden = [];
  const parts = [];
  for (const [token, closing, name] of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*>|[^<]+|</g)) {
    const muted = hidden.length > 0 && hidden[hidden.length - 1];
    if (name === undefined) {
      if (!muted) parts.push(token);
    } else if (closing) {
      hidden.pop();
    } else if (!VOID.has(name.toLowerCase()) && !token.endsWith('/>')) {
      hidden.push(muted || /\baria-hidden="true"/.test(token));
    }
    if (name !== undefined) parts.push(' ');
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

// ── Re-Critique 2026-09-27 (R8): Ziele, die luegen oder schweigen ─────────────

const { toLocalDateKey } = await import('../public/utils/date.js');
const { readFile } = await import('node:fs/promises');
const dashboardSource = await readFile(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');

test('Dziś bietet die Familienkarte erst ab drei Erwachsenen an (H1, Tafla)', () => {
  // Das Familie-Widget mit seinem „Verwalten"-Link ist mit dem Raster gegangen.
  // TAFLA (2026-10-19): Dziś zeichnet kein Raster mehr. Die Familienkarte
  // gibt es dort nur, wo mehr als zwei Erwachsene im Haushalt leben (Wunsch
  // des Haushalts: mit zweien sagen die Kreise im Plan schon, wer was tut);
  // die Verwaltung der Mitglieder erreicht man ueber die Einstellungen.
  assert.match(dashboardSource, /if \(id === 'family'\) return todayAdults\(\)\.length > 2/,
    'Dziś bietet die Familienkarte erst ab drei Erwachsenen an');
});

test('am Wandtablett bietet Dziś kein Anpassen an (#1808)', async () => {
  // Der Einstieg endet an einer Route, die ein Display nicht erreicht:
  // `PUT /preferences` antwortet ihm mit 403 (gemessen am echten Server in
  // test:display-account). Der Melder ordnete sein Brett um und bekam beim
  // Speichern den englischen Rohtext der Scope-Sperre. TAFLA: der Kopf der
  // alten Uebersicht ist gegangen; „Dostosuj Dziś" steht am Fuss von Dziś,
  // nur wenn `canCustomize` gilt - und die Seite setzt es fuer ein Display aus.
  const view = await readFile(new URL('../public/components/today-view.js', import.meta.url), 'utf8');
  const page = view.slice(view.indexOf('export function renderTodayPage('), view.indexOf('export function renderTodaySkeleton('));
  assert.match(page, /const customize = state\.canCustomize\s*\?[\s\S]*?data-day-action="customize"/,
    'der Einstieg haengt an canCustomize');
  assert.match(dashboardSource, /const onDisplay = user\?\.access_scope === 'display';/);
  assert.match(dashboardSource, /canCustomize: !onDisplay,/, 'ein Display bekommt keinen Einstieg in eine Anordnung, die sich nicht speichern laesst');
  // Ein Ausgaben-Gast oder ein anderes enges Konto ist nicht mitgemeint:
  // die Regel haengt am Display, nicht an jedem engen Konto.
  assert.doesNotMatch(dashboardSource, /canCustomize: [^\n]*split_guest/);
});

test('Abbrechen fragt nur, wenn es etwas zu verlieren gibt (H2)', async () => {
  // TAFLA (2026-10-19): „Dostosuj Dziś" ersetzt den Anpassen-Modus und hat
  // GAR NICHTS zu verlieren - jede Aenderung wird sofort gespeichert und Dziś
  // dahinter neu gezeichnet. Darum gibt es kein „Abbrechen", das verwerfen
  // koennte, und keine Rueckfrage; „Gotowe" schliesst nur.
  const sheet = await readFile(new URL('../public/components/today-customize.js', import.meta.url), 'utf8');
  assert.match(sheet, /headerAction: \{ label: t\('today\.customizeDone'\), onClick: \(\) => closeModal\(\) \}/, '„Gotowe" schliesst nur');
  assert.doesNotMatch(sheet, /common\.cancel/, 'kein zweiter Ausgang, der verwerfen koennte');
  assert.match(dashboardSource, /onChange: \(\{ order, visible \}\) => \{[\s\S]*?persistTodayLayout\(/, 'jede Aenderung geht sofort an den Speicher');
});

test('die Zeile in Dziś nennt den Titel vor der Person (H13, A7 Sam)', () => {
  // „Heute wichtig" ist gegangen; die Aufgabe steht als Zeile im Plan von
  // Dziś. Die Person ist dort eine Scheibe mit Namen (role="img",
  // aria-label) am Ende der Zeile - gesprochen wird sie nach dem Titel.
  const todayStr = toLocalDateKey(new Date());
  const linda = { id: 3, display_name: 'Linda Johnson', avatar_color: '#6a5acd' };
  const ctx = planContext({ now: new Date(), users: [linda] });
  const row = buildPlan({
    planTasks: [{ id: 1, title: 'Einverstaendnis abgeben', due_date: todayStr, due_time: '23:59', status: 'open', assigned_users: [linda] }],
  }, ctx).all.find((r) => r.kind === 'task');
  assert.ok(row, 'Reichweite: die Aufgabe steht im Plan');
  const html = renderPlanRow(row, { canCheck: () => false });
  const title = html.indexOf('Einverstaendnis abgeben');
  const person = html.search(/role="img" aria-label="Linda Johnson"/);
  assert.ok(title >= 0 && person >= 0, `Titel und Person stehen beide in der Zeile: ${accessibleText(html)}`);
  assert.ok(title < person, 'der Titel kommt vor dem Namen');
});

// ── R9 M7 (Re-Critique 2026-09-27, A7 P1-2): Anpassen ─────────────────────────

test('Tafla: Vorgabe und Zuruecksetzen stehen in „Dostosuj Dziś", nur fuer wen sie gelten', async () => {
  // Die Kopfzeile [Abbrechen] Titel [Fertig] des alten Anpassen-Modus und seine
  // Fussnote sind gegangen. TAFLA (2026-10-19): Vorgabe und Zuruecksetzen
  // stehen in „Dostosuj Dziś" (Abschnitt „Więcej"), nur fuer wen sie gelten -
  // Admin bzw. eigener Stand.
  const sheet = await readFile(new URL('../public/components/today-customize.js', import.meta.url), 'utf8');
  assert.match(sheet, /actions\.canPublish \? actionRow\(\{ action: 'publish'/);
  assert.match(sheet, /actions\.followsDefault === false \? actionRow\(\{ action: 'reset'/);
  assert.match(dashboardSource, /onPublish: async \(\) => \{ await closeModal\(\{ force: true \}\); await publishHouseholdDefault\(\); \}/);
});

// -------------------------------------------------------------------------
// Anpassen-Modus verliert nichts still (Re-Critique 2026-09-28, A7 P2-1)
// -------------------------------------------------------------------------

test('Verlassen-Schutz: ohne Waechter frei, ein Nein haelt, ein Fehler sperrt nicht, Abmelden trifft nur den eigenen', async () => {
  const { setLeaveGuard, mayLeave } = await import('../public/utils/leave-guard.js');
  assert.equal(await mayLeave('/calendar'), true, 'ohne Waechter geht jeder Wechsel');
  const gefragt = [];
  const abmelden = setLeaveGuard(async (to) => { gefragt.push(to); return false; });
  assert.equal(await mayLeave('/calendar'), false, 'ein Nein haelt die Seite');
  assert.deepEqual(gefragt, ['/calendar'], 'der Waechter erfaehrt das Ziel');
  const zweiter = setLeaveGuard(() => { throw new Error('kaputt'); });
  const fehler = console.error;
  console.error = () => {};
  try {
    assert.equal(await mayLeave('/tasks'), true, 'ein werfender Waechter sperrt die Navigation nicht');
  } finally {
    console.error = fehler;
  }
  abmelden();
  assert.equal(await mayLeave('/tasks'), true, 'ist aber noch der aktive - die alte Abmeldung nimmt ihn nicht weg');
  zweiter();
  assert.equal(await mayLeave('/tasks'), true);
});

test('Anpassen: das Blatt ist ein Dialog und braucht keinen Verlassen-Schutz', async () => {
  // Das Ausblenden des Speed-Dials im Anpassen-Modus (setCustomizeFabHidden)
  // ist mit dem Modus gegangen.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  // TAFLA (2026-10-19): „Dostosuj Dziś" ist ein modales Blatt - der Knopf
  // liegt unter dem Scrim, und weil jede Aenderung sofort gespeichert ist,
  // braucht der Weg hinaus keinen Verlassen-Schutz mehr.
  const sheet = readFileSync(new URL('../public/components/today-customize.js', import.meta.url), 'utf8');
  assert.match(sheet, /openModal\(\{/, 'das Blatt ist ein Dialog');
  assert.doesNotMatch(src, /setLeaveGuard\(\(\) => customizeLeaveAllowed\(/, 'kein Schutz fuer einen Modus, den es nicht mehr gibt');
});

// navigate() steht seit #1657 in utils/router-navigate.js; der Router reicht
// ihm den Verlassen-Schutz als Abhaengigkeit. Die Textguards unten lesen den
// Kopf der Funktion deshalb dort und pruefen am Router die Uebergabe.
const NAVIGATE_GETS_LEAVE_GUARD = /createNavigate\(routerState, \{[^}]*\bhasLeaveGuard, mayLeave\b[^}]*\}\)/;
function navigateHead(readFileSync) {
  const source = readFileSync(new URL('../public/utils/router-navigate.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function navigate(');
  const lock = source.indexOf('state.isNavigating = true;', start);
  assert.ok(start > 0 && lock > start, 'navigate() oder die Sperre nicht gefunden');
  return source.slice(start, lock);
}

test('Router: jeder Wechsel einer angemeldeten Sitzung fragt den Verlassen-Schutz, bevor er navigiert (A7 P2-1)', async () => {
  const { readFileSync } = await import('node:fs');
  const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  assert.match(router, /import \{[^}]*\bmayLeave\b[^}]*\} from '\/utils\/leave-guard\.js';/);
  assert.match(router, NAVIGATE_GETS_LEAVE_GUARD, 'der Router reicht den Schutz an navigate() weiter');
  const head = navigateHead(readFileSync);
  assert.match(head, /if \(state\.currentUser && typeof userOrPushState !== 'object' &&[^\n]*!\(await mayLeave\(path\)\)\)/,
    'der Schutz steht VOR isNavigating = true - sonst blockierte die offene Rueckfrage jede weitere Navigation');
  assert.match(head, /userOrPushState === false && state\.currentPath\)[\s\S]*history\.pushState\(\{ path: /,
    'ein abgelehntes Zurueck legt die Adresse zurueck');
});

test('Router: ohne angemeldeten Waechter bleibt der Wechsel ohne Yield - zwei Klicks starten keine zwei Navigationen', async () => {
  const { readFileSync } = await import('node:fs');
  const { setLeaveGuard, hasLeaveGuard } = await import('../public/utils/leave-guard.js');
  assert.equal(hasLeaveGuard(), false, 'ohne Anmeldung kein Waechter');
  const abmelden = setLeaveGuard(() => true);
  assert.equal(hasLeaveGuard(), true);
  abmelden();
  assert.equal(hasLeaveGuard(), false, 'die Abmeldung nimmt ihn weg');
  // `if (isNavigating) return; isNavigating = true;` war ein Paar ohne Luecke.
  // Ein `await` dazwischen oeffnet eine: ein zweiter synchroner Aufruf (Doppelklick,
  // popstate waehrend eines Klicks) saehe noch `isNavigating === false`. Gefragt
  // und gewartet wird daher nur, wenn eine Seite wirklich etwas zu verlieren hat.
  const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  assert.match(router, /import \{ hasLeaveGuard, mayLeave \} from '\/utils\/leave-guard\.js';/);
  assert.match(router, NAVIGATE_GETS_LEAVE_GUARD, 'der Router reicht den Schutz an navigate() weiter');
  const head = navigateHead(readFileSync);
  assert.match(head, /hasLeaveGuard\(\) && !\(await mayLeave\(path\)\)/,
    'erst der synchrone Blick auf den Waechter, dann das await');
});

test('Router: ein abgelehntes Zurueck legt die Adresse erst zurueck, wenn der Dialog seinen Marker zurueckgab', async () => {
  const { readFileSync } = await import('node:fs');
  const head = navigateHead(readFileSync);
  // Im Browser gemessen: ohne das Warten stand nach "Abbrechen" /calendar in der
  // Adresse, waehrend die Uebersicht zu sehen war (test:overlay-history haelt den Mechanismus).
  assert.match(head, /await whenHistorySettled\(\);\s*\n\s*history\.pushState\(\{ path: stay \}/,
    'erst das back() der Rueckfrage, dann der eigene Eintrag');
});

// -------------------------------------------------------------------------
// R14 P2 (Re-Critique 2026-09-28, A7 P2-2): Uebersicht mobil - Orientierung
// statt Buehne. Gemessen vorher bei 390x844: "Heute wichtig" y157-748 (591px),
// fuenfmal "Ueberfaellig", zwei Zeilen 87px durch Umbruch neben dem Label,
// erstes Widget y760, Seite 3192px.
// -------------------------------------------------------------------------

/** Ein Fenster, das auf die Telefon-Frage `matches` antwortet - eigener Stub je Test. */
async function withStage(phone, fn) {
  const hadWindow = 'window' in globalThis;
  const prevWindow = globalThis.window;
  globalThis.window = {
    yuvomi: null,
    matchMedia: (q) => ({ matches: phone && /max-width:\s*639px/.test(q), media: q, addEventListener() {}, removeEventListener() {} }),
  };
  try {
    return await fn();
  } finally {
    if (hadWindow) globalThis.window = prevWindow;
    else delete globalThis.window;
  }
}

test('R14 P2: die Wand sammelt nicht - dort klappt nichts auf', async () => {
  // Die Sammelzeile von „Heute wichtig" (wireTodayOverdue) ist mit dem
  // Cockpit gegangen.
  // TAFLA (2026-10-19): die Wand baut nicht mehr auf dem Cockpit-Modell auf,
  // sondern auf dem Tagesplan (utils/wall-plan.js) - und dort gibt es keine
  // Sammelzeile, die aufklappt: Zaelliges steht als eigene Zeile mit Pille.
  const wallPlan = await readFile(new URL('../public/utils/wall-plan.js', import.meta.url), 'utf8');
  const wallView = await readFile(new URL('../public/components/wall-view.js', import.meta.url), 'utf8');
  assert.doesNotMatch(wallPlan, /groupOverdue|buildTodayCockpitModel/, 'die Wand sammelt nicht');
  assert.doesNotMatch(wallView, /aria-expanded|data-today-overdue/, 'die Wand ist eine Anzeige - dort klappt nichts auf');
});

// R14 P12 (Re-Critique 2026-09-28, A8 P3-2): die Uebersicht war der einzige
// schwebende FAB am Desktop (48x48 @1360,820, nur "Schnellaktionen" als Name);
// jedes andere Modul dockt als Pille mit Nomen im Kopf an.
// Tafla (2026-10-19): der Speed-Dial ist entfallen. Am Desktop bleibt die
// angedockte Pille - sie heisst jetzt „Dodaj" und oeffnet das globale
// Erfassen-Blatt (dasselbe wie das + neben der Kapsel), statt eines Menues.
test('R14/Tafla: die Uebersicht ruft das globale Erfassen und baut keinen Speed-Dial', () => {
  // Der Kopf der alten Uebersicht (renderDashboardOverview) mit seiner
  // angedockten Pille ist gegangen; das Erfassen kommt aus der Shell.
  assert.equal(__test.renderFab(), '', 'kein schwebender Speed-Dial');
  assert.match(dashboardSource, /window\.yuvomi\?\.openCapture\?\.\(\)/, 'der Knopf ruft das globale Erfassen');
  assert.doesNotMatch(dashboardSource, /FAB_ACTIONS|FAB_NEW_BTN|function wireNewMenu/, 'der Speed-Dial ist entfallen');
});

test('Tafla: auf dem Telefon traegt die Uebersicht keinen eigenen Knopf - das + der Shell', () => withStage(true, () => {
  assert.equal(__test.renderFab(), '');
}));

// Critique 2026-10-16: jede Kachel fuehrt mit „Alle" zu ihrer Seite, nur die
// Familie sagte „Verwalten" fuer denselben Weg. Und die Onboarding-Karte trug
// Haarlinie plus 28px-Schatten (Detektor gpt-thin-border-wide-shadow): sie
// nimmt jetzt das Material der schwebenden Tafel (glass.css).
test('Dashboard: Onboarding-Karte als schwebende Tafel (Critique 2026-10-16)', async () => {
  // Das Familie-Widget mit seinem Kopf-Link ist mit dem Raster gegangen.
  const { eachRule } = await import('./css-rules.js');
  const { readFileSync } = await import('node:fs');
  assert.doesNotMatch(dashboardSource, /t\('dashboard\.manage'\)/);
  const css = readFileSync(new URL('../public/styles/dashboard.css', import.meta.url), 'utf8');
  const card = [...eachRule(css)].find((r) => !r.at.length && r.selector.trim() === '.onboarding-card');
  assert.match(card?.body ?? '', /border:\s*none/, 'keine Haarlinie');
  assert.match(card?.body ?? '', /box-shadow:\s*var\(--glass-shadow-lg\), var\(--glass-inset-elevated\)/, 'Tiefe und Lichtkante der schwebenden Tafel');
});

// R20 (Re-Critique 2026-10-17, A1 P3): Esc beendete das Anpassen nicht - am
// Telefon war "Abbrechen" der einzige Weg. Esc nimmt denselben Weg wie der
// Knopf (mit Rueckfrage bei Aenderungen) und laesst offene Dialoge und Menues
// ihr eigenes Esc behalten.
test('R20: Esc beendet das Anpassen wie "Abbrechen", nicht an einem offenen Dialog vorbei', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  // TAFLA (2026-10-19): das Anpassen ist ein Dialog (modal.js) - sein Esc ist
  // das Esc des Dialogs, und es verliert nichts, weil jede Aenderung schon
  // gespeichert ist. Die Seite selbst haengt kein eigenes Esc mehr an.
  assert.doesNotMatch(src, /event\.key !== 'Escape' \|\| event\.defaultPrevented \|\| !isCustomizing/);
  const sheet = readFileSync(new URL('../public/components/today-customize.js', import.meta.url), 'utf8');
  assert.match(sheet, /dirtyGuard: false/, 'nichts Ungespeichertes, also keine Rueckfrage beim Schliessen');
});
