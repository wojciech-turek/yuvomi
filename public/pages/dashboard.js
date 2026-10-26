/**
 * Modul: Dashboard
 * Zweck: Startseite mit Begrüßung, Terminen, Aufgaben, Essen, Notizen und FAB
 * Abhängigkeiten: /api.js
 */

import { api, auth } from '/api.js';
import { openCookForMeal } from '/components/cook-mode.js';
import { fetchOpenQuestion, answerQuestion, skipQuestion } from '/components/ai-question.js';
import { planContext, buildDay, dayClosed, buildTomorrow, buildSoon } from '/utils/today-plan.js';
import { renderTodayPage, renderTodaySkeleton, updateTimerText } from '/components/today-view.js';
import { openTodayCustomize } from '/components/today-customize.js';
import { createPageController } from '/utils/page-lifecycle.js';
import { canSeeWidget, moduleAccess, navModuleAccess, canUseFasting } from '/permissions.js';
import { t, formatDate, formatDayMonth, formatTime, getLocale, getNumberFormat } from '/i18n.js';
import { housekeepingSinceLabel } from '/utils/day-label.js';
import { esc } from '/utils/html.js';
// `todayKey` heisst hier schon ein Parameter (bzw. eine lokale Bindung), der den
// Bezugstag traegt - der Import kommt deshalb unter eigenem Namen herein.
import { addLocalDays, todayKey as householdToday } from '/utils/date.js';
import { zonedDateKey } from '/utils/timezone.js';
import { localizeBirthdayEvent } from '/utils/birthday-event.js';
import { findPageFab } from '/utils/fab.js';
import { openModal, closeModal, confirmModal } from '/components/modal.js';
import { isSoloHousehold } from '/utils/household.js';
import { toggleRegion } from '/utils/ux.js';
import { swapContent } from '/utils/content-swap.js';
import { brandMarkSvg } from '/utils/brand-mark.js';
import { dashboardQuery, dashboardQueryFiltersCounts, dashboardRequest, fetchPendingReminders, childDefaultWidgetConfig, TODAY_SECTION_IDS, TODAY_EXTRA_IDS } from '/utils/dashboard-widgets.js';
import { EVENT_LIMIT_STEPS, EVENT_LIMIT_DEFAULT, clampEventLimit } from '/utils/dashboard-event-limit.js';
import { buildDefaultWidgetConfig, normalizeDashboardConfigWithExtensions, isExtensionWidget, getExtensionWidgetMeta } from '/utils/extension-widgets.js';
import { widgetDisplayLabel } from '/utils/extension-i18n.js';
import { MODULE_ICON } from '/nav-icons.js';
import { enterWallMode, exitWallMode, isWallActive, syncWallMode } from '/utils/wall-mode.js';
import { mountZonePrompt } from '/utils/household-zone-hint.js';
import { wireWallTimer, readWallTimer, clearWallTimer } from '/components/wall-timer.js';
import { buildWall, wallClock, wallFingerprint, WALL_REFRESH_MS } from '/utils/wall-plan.js';
import { renderWall, renderWhoChooser, fitWallLists, wallDateLabel } from '/components/wall-view.js';
import { rememberLayoutHint, layoutHintQuery } from '/utils/dashboard-layout-hint.js';
import { attachOverlay, pushOverlay, dropOverlay, isOverlayOpen } from '/utils/overlay-history.js';
import { mealTypeLabel, primeMealTypeNames } from '/utils/meal-types.js';
import { wireRecipeThumbs } from '/utils/recipe-thumb.js';
import { installPopoverMenus } from '/utils/popover-menu.js';
import { nextRewardGoal } from '/utils/reward-goal.js';

// Hält den AbortController des aktuellen FAB-Listeners - wird bei jedem render() erneuert.
let _fabController = null;

/* DIE WAND HAELT DEN EINEN HISTORY-MARKER (#1559). Zurueck beendete sie nicht:
 * es gab keinen Eintrag und keinen `popstate`-Handler, in der installierten App
 * schloss die Geste die App, und beim naechsten Start stand die Wand wieder da.
 * Sie meldet sich deshalb im Overlay-Register an wie jeder Dialog - derselbe
 * EINE Marker (utils/overlay-history.js), keine zweite Buchhaltung.
 *
 * Angemeldet wird, solange die Flaeche STEHT, nicht beim Einschalten: der Modus
 * ist gemerkt und steht nach einem Neustart ohne jeden Klick wieder da. Auch
 * dann fuehrt Zurueck erst aus der Wand auf die Uebersicht und nicht aus der
 * App. Die Flaeche baut sich oft neu (Timer, Minutentakt, Laden) - der Token
 * ueberlebt das, und `_wallLeave` zeigt auf den Ausstieg des juengsten Aufbaus.
 *
 * `force` (Navigation, Sitzungsende) gibt nur den Marker frei, der Modus BLEIBT
 * gemerkt: wer per Kurzbefehl woandershin geht, hat die Wand nicht abbestellt.
 * Sie gilt ohnehin nur auf `/` (isWallRoute). */
let _wallOverlay = null;
let _wallLeave = null;

/* WOHIN DER FOKUS NACH DEM MODUSWECHSEL GEHT (R20, Re-Critique 2026-10-17 A1
 * P2-6). Start und Ausstieg bauen die ganze Seite neu (`rerender`), und danach
 * stand der Fokus auf <body>: wer per Tastatur „Wand-Modus starten" drueckte,
 * fand sich nirgends, und nach Esc wieder am Dokumentanfang. Die Absicht
 * ueberlebt den Neuaufbau hier, weil `render()` eine neue Closure baut:
 *   'enter' -> die Wandflaeche selbst (`#wall-surface`, tabindex=-1): ein
 *              ruhiger Einstieg, kein Knopf - ein Enter dort beendete sonst
 *              gleich wieder, was gerade begonnen hat;
 *   'leave' -> der Knopf, der die Wand wieder oeffnet (am Finger das Menue).
 * Einmal gelesen, dann vergessen. */
let _wallFocusIntent = null;
function takeWallFocusIntent(kind) {
  if (_wallFocusIntent !== kind) return false;
  _wallFocusIntent = null;
  return true;
}

function holdWallMarker(leave) {
  _wallLeave = leave;
  if (_wallOverlay !== null && isOverlayOpen(_wallOverlay)) return;
  _wallOverlay = pushOverlay(({ force }) => {
    _wallOverlay = null;
    if (!force) _wallLeave?.();
  });
}

function releaseWallMarker() {
  _wallLeave = null;
  if (_wallOverlay === null) return;
  const token = _wallOverlay;
  _wallOverlay = null;
  dropOverlay(token);
}

// ── Onboarding ──────────────────────────────────────────────────────────────

const ONBOARDING_KEY = 'yuvomi-onboarded';
// Der Dialog benennt sich ueber seinen Schritt-Titel; die id steht hier, weil
// beide Seiten der Verknuepfung sie brauchen (Overlay und `fillStep()`).
const ONBOARDING_TITLE_ID = 'onboarding-step-title';
const APP_NAME_STORAGE_KEY = 'yuvomi-app-name';

/** Geburtstags-Termine tragen serverseitig einen sprachneutralen Titel (#524) -
 * in beiden Terminlisten der Antwort, der der Kachel und der der Familienkarte. */
function localizeEventLists(payload) {
  for (const key of ['upcomingEvents', 'familyEvents']) {
    if (Array.isArray(payload?.[key])) payload[key] = payload[key].map(localizeBirthdayEvent);
  }
}

function getAppName() {
  return localStorage.getItem(APP_NAME_STORAGE_KEY) || 'Yuvomi';
}

function getOnboardingSteps() {
  const appName = getAppName();
  // Plattform-bewusste Copy (Critique P5/Paket 3): der allererste Eindruck darf
  // keine UI beschreiben, die der Nutzer nicht sieht - Desktop mit Sidebar
  // bekommt weder Bottom-Bar- noch Wischgesten-Text. Gleicher Breakpoint wie
  // der Sidebar-Umbruch (layout.css, min-width: 1024px).
  const desktop = window.matchMedia('(min-width: 1024px)').matches;
  // DIE MARKE UND DIE ECHTEN KNOEPFE (Re-Critique 2026-10-17, A1): der
  // Rundgang begann mit einem Lucide-Haus statt der Bildmarke und beschrieb
  // Leiste und Plus-Knopf nur in Worten. Schritt 1 traegt jetzt das Zeichen
  // (utils/brand-mark.js), Schritt 2 und 3 zeigen auf das Bedienelement, das
  // der Text nennt (`target`, siehe placeSpotlight in showOnboarding).
  return [
    { mark: true,           title: t('onboarding.step1Title', { name: appName }), body: t('onboarding.step1Body') },
    { icon: 'navigation',   title: t('onboarding.step2Title'), body: t(desktop ? 'onboarding.step2BodyDesktop' : 'onboarding.step2Body'),
      target: () => document.querySelector(desktop ? '.nav-sidebar' : '.nav-bottom__items') },
    { icon: 'plus-circle',  title: t('onboarding.step3Title'), body: t(desktop ? 'onboarding.step3BodyDesktop' : 'onboarding.step3Body'),
      // Tafla: das globale + der Shell (Telefon) bzw. die Pille „Dodaj" im Kopf.
      target: () => [...document.querySelectorAll('.capture-plus, .page-fab')].find(isShownOnScreen) ?? null },
  ];
}

/** Steht das Element sichtbar im Fenster? (Ziel eines Rundgang-Schritts) */
function isShownOnScreen(el) {
  if (!el || !el.getClientRects().length) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0
    && r.top < window.innerHeight && r.left < window.innerWidth;
}

/** Abstand des Lichtrings um das gezeigte Bedienelement, in px. */
const ONBOARDING_SPOT_PAD = 6;

function showOnboarding(appContainer) {
  const steps = getOnboardingSteps();
  let current = 0;

  // Fokus vor dem Dialog merken, um ihn beim Schließen zurückzugeben.
  const previouslyFocused = document.activeElement;

  const overlay = document.createElement('div');
  overlay.className = 'onboarding-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  // EIN DIALOG OHNE NAMEN ist fuer den Screenreader nur „Dialog". Der Name
  // kommt aus dem Schritt-Titel, den `fillStep()` ohnehin baut; die id ist
  // deshalb konstant und wandert mit dem Austausch des Karteninhalts mit
  // (WCAG 4.1.2). `aria-modal` versteckt alles dahinter - was bleibt, muss
  // sich also selbst benennen.
  overlay.setAttribute('aria-labelledby', ONBOARDING_TITLE_ID);

  const onKeydown = (event) => {
    if (event.key === 'Escape') { finish(); return; }
    if (event.key !== 'Tab') return;
    // Fokus-Trap (WCAG 2.4.3/2.1.2): der Erststart-Dialog darf den Fokus nicht
    // auf die verdeckte Seite dahinter entlassen. Fokussierbare Elemente je
    // Tab-Druck neu ermitteln, da fillStep() den Karteninhalt austauscht.
    const focusables = overlay.querySelectorAll(
      'button, [href], input, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKeydown);

  /* DIE KARTE STEHT, IHR INHALT WECHSELT (R17, Bewegung). Bisher baute jeder
   * Schritt die Karte neu: sie sprang mit der Textlaenge (gemessen 327 ->
   * 353px) und die Knoepfe wanderten unter dem Zeiger weg. Jetzt bleibt die
   * Karte derselbe Knoten, `.onboarding-step` darin traegt den Schritt und
   * tauscht ueber swapContent() in Leserichtung (utils/content-swap.js) - und
   * er ist so hoch wie der hoechste der Schritte (`fitSteps()`, gemessen
   * statt geraten: die Texte sind je Sprache verschieden lang). */
  const card = document.createElement('div');
  card.className = 'onboarding-card';
  const stepEl = document.createElement('div');
  stepEl.className = 'onboarding-step';
  card.appendChild(stepEl);

  /* DER LICHTRING (Re-Critique 2026-10-17, A1 "kein Bezug auf echte
   * Bedienelemente"). Nennt ein Schritt die Leiste oder den Plus-Knopf, liegt
   * ueber genau diesem Knopf ein Ausschnitt: der Ring traegt den Abdunkler als
   * Schatten nach aussen (`box-shadow` mit 100vmax Spreizung), das Overlay
   * selbst wird dafuer klar. So steht das echte Element scharf im Bild, der
   * Rest gedimmt - ohne Maske, ohne Kopie des Elements. Klicks faengt weiter
   * das Overlay; der Ring ist reine Anzeige (aria-hidden), der Text bleibt die
   * Aussage. Findet sich das Ziel nicht (Modul ohne Plus, ausgeblendete
   * Leiste), bleibt der Schritt so, wie er vorher war: Tafel auf Unschaerfe. */
  const spot = document.createElement('div');
  spot.className = 'onboarding-spotlight';
  spot.setAttribute('aria-hidden', 'true');
  overlay.appendChild(spot);
  overlay.appendChild(card);

  function placeSpotlight() {
    const target = steps[current].target?.();
    const shown = isShownOnScreen(target);
    overlay.classList.toggle('onboarding-overlay--spot', shown);
    if (!shown) return;
    const r = target.getBoundingClientRect();
    const radius = parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0;
    const pad = ONBOARDING_SPOT_PAD;
    spot.style.setProperty('--spot-x', `${Math.round(r.left - pad)}px`);
    spot.style.setProperty('--spot-y', `${Math.round(r.top - pad)}px`);
    spot.style.setProperty('--spot-w', `${Math.round(r.width + pad * 2)}px`);
    spot.style.setProperty('--spot-h', `${Math.round(r.height + pad * 2)}px`);
    spot.style.setProperty('--spot-r', `${Math.round(Math.min(radius + pad, (r.height + pad * 2) / 2))}px`);
  }
  const onResize = () => placeSpotlight();
  window.addEventListener('resize', onResize);

  function fitSteps() {
    stepEl.style.minBlockSize = '';
    const shown = current;
    let tallest = 0;
    for (current = 0; current < steps.length; current += 1) {
      fillStep();
      tallest = Math.max(tallest, stepEl.offsetHeight);
    }
    current = shown;
    fillStep();
    if (tallest > 0) stepEl.style.minBlockSize = `${tallest}px`;
  }

  /** Baut den Schritt `current` in die stehende Karte; gibt seinen Hauptknopf zurueck. */
  function fillStep() {
    const step = steps[current];
    const isLast = current === steps.length - 1;
    stepEl.replaceChildren();

    let icon;
    if (step.mark) {
      icon = document.createElement('span');
      icon.className = 'onboarding-mark';
      icon.setAttribute('aria-hidden', 'true');
      icon.insertAdjacentHTML('beforeend', brandMarkSvg());
    } else {
      icon = document.createElement('i');
      icon.dataset.lucide = step.icon;
      icon.className = 'onboarding-icon';
      icon.setAttribute('aria-hidden', 'true');
    }

    const title = document.createElement('h2');
    title.className = 'onboarding-title';
    title.id = ONBOARDING_TITLE_ID;
    title.textContent = step.title;

    const body = document.createElement('p');
    body.className = 'onboarding-body';
    body.textContent = step.body;

    // Die Punkte sind reine Dekoration und fuer Screenreader unsichtbar; die
    // Fortschrittsansage traegt ein sr-only-Text daneben - vorher hoerte ein
    // Screenreader gar nicht, an welchem der drei Schritte er steht
    // (Critique 2026-08-27, Persona Sam).
    const dots = document.createElement('div');
    dots.className = 'onboarding-dots';
    dots.setAttribute('aria-hidden', 'true');
    steps.forEach((_, i) => {
      const dot = document.createElement('span');
      dot.className = `onboarding-dot${i === current ? ' onboarding-dot--active' : ''}`;
      dots.appendChild(dot);
    });
    const progress = document.createElement('p');
    progress.className = 'sr-only';
    progress.textContent = t('onboarding.stepProgress', { current: current + 1, total: steps.length });

    const actions = document.createElement('div');
    actions.className = 'onboarding-actions';
    actions.dataset.dialogActions = '';

    const skipBtn = document.createElement('button');
    skipBtn.className = 'btn btn--ghost';
    skipBtn.textContent = t('onboarding.skip');
    skipBtn.addEventListener('click', finish);

    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn btn--primary';
    nextBtn.textContent = isLast ? t('onboarding.done') : t('onboarding.next');
    nextBtn.addEventListener('click', () => {
      if (isLast) { finish(); return; }
      current++;
      // Der Fokus geht an den NEUEN Hauptknopf (der alte ist mit dem Schritt
      // gegangen) - synchron nach dem Tausch, die Blende sperrt nichts.
      let next = null;
      swapContent(stepEl, () => { next = fillStep(); }, { direction: 1 });
      next?.focus();
    });

    if (!isLast) actions.appendChild(skipBtn);
    actions.appendChild(nextBtn);
    stepEl.appendChild(icon);
    stepEl.appendChild(title);
    stepEl.appendChild(body);
    stepEl.appendChild(dots);
    stepEl.appendChild(progress);
    stepEl.appendChild(actions);

    if (window.lucide) window.lucide.createIcons({ el: stepEl });
    placeSpotlight();
    return nextBtn;
  }

  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    document.removeEventListener('keydown', onKeydown);
    window.removeEventListener('resize', onResize);
    localStorage.setItem(ONBOARDING_KEY, '1');
    // Am Konto vermerken, nicht nur am Geraet: sonst zeigt ein neues Geraet
    // oder ein privates Fenster den Rundgang erneut, obwohl das Konto ihn
    // schon gesehen hat. Bewusst fire-and-forget - ein Netzwerkfehler hier
    // darf den Dialog nicht am Schliessen hindern; der lokale Merker faengt
    // den aktuellen Browser ohnehin ab.
    auth.markOnboardingSeen().catch(() => {});
    // Fokus dorthin zurückgeben, wo er vor dem Dialog lag (sonst neutral auf
    // den Body), damit Tastatur-/SR-Nutzer nicht im entfernten Overlay hängen.
    const restoreTarget = (previouslyFocused && document.contains(previouslyFocused))
      ? previouslyFocused
      : document.body;
    overlay.classList.add('onboarding-overlay--out');
    overlay.addEventListener('animationend', () => overlay.remove(), { once: true });
    // Fallback falls animationend nicht feuert (prefers-reduced-motion):
    setTimeout(() => overlay.remove(), 300);
    restoreTarget?.focus?.();
  }

  appContainer.appendChild(overlay);
  // Messen kann erst ein Knoten im Baum; danach steht Schritt 1.
  fitSteps();
  setTimeout(() => stepEl.querySelector('.btn--primary')?.focus(), 50);
  // Die Zurueck-Geste beendet die Einfuehrung, statt hinter ihr zu navigieren
  // (#871). `finish()` ist der EINE Weg hinaus und merkt sich das auch.
  attachOverlay(overlay, finish);
}

// --------------------------------------------------------
// Widget-Definitionen (Reihenfolge = Standard-Layout)
// --------------------------------------------------------

// Der Standard-Satz und die reine Logik darauf liegen in
// `/utils/dashboard-widgets.js` - sie tragen eine Zusicherung über die
// Reihenfolge und mussten dafür ohne Shell testbar sein. Was hier bleibt,
// hängt an Haushaltskontext und Modul-Schaltern.

// Widget → Modul-Slug für die „Modul deaktiviert?"-Prüfung. Widgets ohne Eintrag
// haengen an keinem Modul; eigene Verfuegbarkeitsregeln (family, countdown,
// weather) stehen in `isWidgetModuleEnabled`. Modulweit, damit Grid-Filter und
// Wieder-Einblenden-Leiste dieselbe Sichtbarkeitsregel teilen.
// `split-expenses` ist kein Widget, sondern eine Kachel der Kennzahlreihe -
// steht aber hier, weil `isWidgetModuleEnabled()` auch die Kacheln filtert, und
// die geteilten Ausgaben haengen am Budget-Modul (server/scopes.js).
const MODULE_FOR_WIDGET = { tasks: 'tasks', calendar: 'calendar', shopping: 'shopping', meals: 'meals', notes: 'notes', birthdays: 'birthdays', budget: 'budget', 'split-expenses': 'budget', rewards: 'rewards', health: 'health', cycle: 'health', fasting: 'health', nutrition: 'health', housekeeping: 'housekeeping', schedule: 'schedule', waste: 'waste', pantry: 'pantry' };

const _extensionWidgetModules = new Map();

async function mountExtensionWidgets(shell, cfg, user) {
  const mounts = shell.querySelectorAll('[data-extension-widget-mount]');
  await Promise.all([...mounts].map(async (mount) => {
    const wrapper = mount.closest('[data-widget-id]');
    const id = wrapper?.dataset?.widgetId;
    if (!id) return;
    const w = cfg.find((item) => item.id === id);
    const meta = getExtensionWidgetMeta(id);
    if (!meta?.entry) return;
    try {
      let mod = _extensionWidgetModules.get(meta.entry);
      if (!mod) {
        mod = await import(/* webpackIgnore: true */ meta.entry);
        _extensionWidgetModules.set(meta.entry, mod);
      }
      mount.replaceChildren();
      if (typeof mod.renderWidget !== 'function') {
        throw new Error('renderWidget export missing');
      }
      await mod.renderWidget(mount, {
        size: w?.size,
        options: w?.options ?? {},
        user,
      });
      if (window.lucide) window.lucide.createIcons({ el: mount });
    } catch (err) {
      console.error(`[dashboard] Extension widget "${id}" konnte nicht gerendert werden`, err);
      mount.replaceChildren();
      mount.insertAdjacentHTML('afterbegin', renderWidgetError(id));
      if (window.lucide) window.lucide.createIcons({ el: mount });
    }
  }));
}

/* DER COUNTDOWN IST EIN WIDGET, DAS ES ERST GIBT, WENN JEMAND ETWAS MARKIERT
 * HAT (#647). Er hat keine eigene Seite und keinen eigenen Bestand: seine
 * Kachel zeigt Termine und Aufgaben, die jemand ausdrücklich dafür markiert
 * hat, und in einem Haushalt, der das noch nie getan hat, gibt es nichts zu
 * zeigen und nichts einzurichten.
 *
 * ER RENDERT DESHALB NICHT LEER, SONDERN IST DANN NICHT VERFUEGBAR - das ist
 * genau der Unterschied, den das Familien-Widget unten schon einmal gekostet
 * hat: ein Renderer, der '' zurückgibt, verschwindet aus dem Raster, bleibt
 * aber `visible: true` und taucht damit auch in der Ablage der versteckten
 * Widgets nicht auf. Hier fällt er aus beiden Listen, so wie ein abgeschaltetes
 * Modul auch, und kommt mit dem ersten Countdown an seiner gespeicherten
 * Position zurück.
 *
 * Der Zähler ist modulweit und nicht Teil von `data`, weil ihn zwei Aufrufer
 * brauchen, von denen einer (die Ablage der versteckten Widgets) die Daten
 * nicht sieht. Er wird bei jedem render() zurückgesetzt und nach dem Laden
 * gesetzt - ein Stand von vorhin darf keine Kachel versprechen. */
let countdownAvailable = false;

function setCountdownAvailability(items) {
  countdownAvailable = Array.isArray(items) && visibleCountdowns(items).length > 0;
}

/* DAS WETTER IST VERFUEGBAR, SOBALD ES EINGERICHTET IST - NICHT ERST, WENN DER
 * ANBIETER ANTWORTET. Bis v2.70.0 hing die Kachel an der Antwort selbst: ein
 * Fehlschlag beim Anbieter lieferte `{ data: null }`, der Renderer gab '' zurueck,
 * und die Kachel verschwand genau so, wie es die Notiz am Countdown beschreibt -
 * aus dem Raster, aus der Anpassen-Ablage (sie blieb `visible: true`) und mit
 * ihr aus der Kopfzeile, die ihr Wetter der Kachel ueberlaesst.
 *
 * Jetzt zwei Faelle:
 *   - nicht eingerichtet: die Kachel ist NICHT VERFUEGBAR wie ein abgeschaltetes
 *     Modul (dieselbe Regel wie Countdown und Familie). Ein Einrichtungshinweis
 *     waere eine Kachel, die allen Mitgliedern eine Aufgabe zeigt, die nur der
 *     Admin erledigen kann, und ab Werk im Raster jedes Haushalts ohne Wetter
 *     stuende. Der Weg dorthin sind die Einstellungen;
 *   - eingerichtet, aber gescheitert: die Kachel bleibt stehen und sagt ruhig,
 *     dass es gerade kein Wetter gibt (`renderWeatherUnavailable`).
 *
 * Woher „eingerichtet": der Grund, den der Wetter-Proxy selbst nennt
 * (`reason`). Er kennt die ganze Regel, samt Standort je Mitglied und
 * unvollstaendiger Einrichtung - `weather_source` aus /preferences beschreibt
 * nur den Haushalt. Die Praeferenzen sind der Rueckfall fuer den Fall, dass die
 * Anfrage selbst scheiterte und der Server gar nichts sagen konnte. */
let weatherAvailable = false;

function weatherAvailableFrom(res, prefs) {
  if (res?.data) return true;
  if (res?.reason === 'not_configured') return false;
  // `upstream_error` und jeder kuenftige Grund: eingerichtet. Im Zweifel bleibt
  // die Kachel erreichbar - das Gegenteil war der Fehler.
  if (res?.reason) return true;
  const household = prefs?.weather_source?.source;
  const user = prefs?.weather_user;
  return Boolean((household && household !== 'none') || (user?.lat && user?.lon));
}

function setWeatherAvailability(res, prefs) {
  weatherAvailable = weatherAvailableFrom(res, prefs);
}

// Aus welchem Modul ein Countdown stammt, entscheidet über ihn: wer den
// Kalender abgeschaltet hat, soll dessen Einträge auch hier nicht sehen. Die
// Kachel als Ganzes gehört keinem Modul (siehe PERMISSION_WIDGETS), ihre
// einzelnen Zeilen schon - dieselbe Aufteilung wie bei der Kennzahlreihe.
//
// SEIT DEM REVIEW ZU PR #793 IST DAS DIE ZWEITE INSTANZ, NICHT DIE ERSTE:
// aussortiert wird schon in services/countdowns.js, vor Schnitt und Gesamtzahl.
// Hier zu filtern allein war der Fehler - der Server schickte fünf Termine
// eines abgeschalteten Kalenders, diese Zeile warf alle fünf weg, und die
// Kachel verschwand mitsamt der Aufgabe, die dahinter gestanden hätte.
// Stehen bleibt der Filter für den Fall, dass ein Modul umgeschaltet wird,
// ohne dass das Dashboard neu lädt.
function visibleCountdowns(items) {
  return (Array.isArray(items) ? items : []).filter((c) => {
    const mod = c.source === 'task' ? 'tasks' : 'calendar';
    return !window.yuvomi?.isModuleDisabled(mod);
  });
}

function isWidgetModuleEnabled(id) {
  if (isExtensionWidget(id)) {
    const meta = getExtensionWidgetMeta(id);
    if (!meta) return false;
    if (meta.permissionModuleKey && moduleAccess(meta.permissionModuleKey) === 'none') return false;
    if (!canSeeWidget(id)) return false;
    return true;
  }
  const mod = MODULE_FOR_WIDGET[id];
  if (mod && window.yuvomi?.isModuleDisabled(mod)) return false;
  // Rollen-/Mitglied-Rechte (#467): serverseitig gesperrtes Widget (bzw. Widget
  // eines Moduls ohne Zugriff — die Modulsperre wird bereits serverseitig auf die
  // Widget-Map durchgereicht) hier nicht anbieten.
  if (!canSeeWidget(id)) return false;
  // Im Solo-Haushalt ist das Familien-Widget kein VERFUEGBARES Widget, kein
  // leer gerendertes. Der Unterschied ist die „Anpassen"-Ablage: ein Renderer,
  // der '' zurueckgibt, verschwindet aus dem Raster, bleibt aber `visible: true`
  // und taucht damit auch in der Ablage der versteckten Widgets nicht auf - es
  // waere aus der Oberflaeche heraus nicht mehr erreichbar. Hier faellt es aus
  // beiden Listen, so wie ein abgeschaltetes Modul auch.
  if (id === 'family' && isSoloHousehold()) return false;
  if (id === 'fasting' && !canUseFasting()) return false;
  if (id === 'countdown' && !countdownAvailable) return false;
  if (id === 'weather' && !weatherAvailable) return false;
  return true;
}

function setHtml(element, html) {
  element.replaceChildren();
  element.insertAdjacentHTML('afterbegin', html);
}

function widgetLabel(id) {
  const ext = getExtensionWidgetMeta(id);
  if (ext) return widgetDisplayLabel(ext);
  const map = {
    tasks:    () => t('nav.tasks'),
    calendar: () => t('nav.calendar'),
    shopping: () => t('nav.shopping'),
    meals:    () => t('nav.meals'),
    notes:    () => t('nav.notes'),
    weather:  () => t('dashboard.weather'),
    birthdays: () => t('nav.birthdays'),
    budget:   () => t('nav.budget'),
    rewards:  () => t('nav.rewards'),
    health:   () => t('nav.health'),
    cycle:    () => t('health.cycle.title'),
    fasting:  () => t('health.fasting.title'),
    nutrition: () => t('health.nutrition.title'),
    housekeeping: () => t('nav.housekeeping'),
    schedule: () => t('nav.schedule'),
    waste:    () => t('nav.waste'),
    pantry:   () => t('dashboard.pantryExpiringTitle'),
    family:   () => t('dashboard.familyTitle'),
    clock:    () => t('dashboard.clock'),
    metrics:  () => t('dashboard.metrics'),
    countdown: () => t('dashboard.countdownTitle'),
    quicklinks: () => t('dashboard.quickLinksTitle'),
  };
  return (map[id] ?? (() => id))();
}

/* HIER STAND DIE ZWEITE TABELLE MODUL -> ZEICHEN, und sie war von der ersten
 * abgewichen: Notizen fuehrte hier `pin`, in der Navigation `sticky-note`. Wer
 * das Widget und die Leiste nebeneinander sah, sah zwei Zeichen fuer ein Modul.
 * Die Zuordnung steht jetzt einmal in MODULE_ICON (nav-icons.js) - inklusive
 * der vier Dashboard-eigenen Karten (Wetter, Uhr, Kennzahlen, Countdown), die
 * keine Module sind, aber dieselbe Absender-Rolle im Kopf tragen. */
function widgetIcon(id) {
  const ext = getExtensionWidgetMeta(id);
  if (ext?.icon) return ext.icon;
  return MODULE_ICON[id] ?? MODULE_ICON.dashboard;
}

const MEAL_ORDER = Object.freeze(['breakfast', 'lunch', 'dinner', 'snack']);

function normalizeVisibleMealTypes(visibleMealTypes) {
  if (!Array.isArray(visibleMealTypes)) return MEAL_ORDER;
  const filtered = MEAL_ORDER.filter((type) => visibleMealTypes.includes(type));
  return filtered.length ? filtered : MEAL_ORDER;
}

function formatCurrency(amount, currency = 'EUR') {
  return getNumberFormat({
    style: 'currency',
    currency,
    maximumFractionDigits: Math.abs(amount) >= 1000 ? 0 : 2,
  }).format(amount || 0);
}

function formatPoints(value) {
  return getNumberFormat().format(Number(value) || 0);
}

/* WER SCHAUT (R20, Kinder-Standards). Die Seite setzt das in `render()`; die
 * Programmzeilen fragen es, damit ein Kind seine Aufgaben zuerst sieht. */
let dashboardViewer = null;

/** Ein Kinderkonto, das der Vorgabe folgt, bekommt die Kinder-Vorgabe der Kacheln. */
function childDefaultFor(config, user, followsDefault) {
  return followsDefault && user?.family_role === 'child' ? childDefaultWidgetConfig(config) : config;
}

/* DIE BUDGET-KACHEL NENNT IHREN REITER (#1607). Das Budget merkt sich den
 * zuletzt offenen Reiter und zeigt ihn ohne `?tab=` wieder - richtig fuer die
 * Navigation, falsch fuer diese Kachel: wer zuletzt in der Statistik stand,
 * landete ueber „Eintrag hinzufuegen" auf einem Reiter ohne Anlegen. Kachel und
 * Kennzahl zeigen den Monat (Einnahmen, Ausgaben, Saldo), also fuehren ihre
 * Wege auf die Monatsuebersicht. */
const BUDGET_MONTH_ROUTE = '/budget?tab=budget';

/**
 * Wohin eine Zeile fuehrt, die ueber ALLE Einkaufslisten zaehlt (#1821).
 *
 * Die Zahl meint mehrere Listen, also ist die Modulseite das ehrliche Ziel -
 * bis nur noch EINE Liste etwas Offenes hat: dann meint "5 offen" genau diese
 * Liste, und `/shopping` oeffnete stattdessen die aelteste (shopping.js liest
 * `?list=`, sonst die erste geladene). `shoppingOpenLists` zaehlt der Server
 * ueber alle Listen; `shoppingLists` traegt hoechstens drei, bei einer einzigen
 * also genau sie.
 */
function shoppingSoleListRoute(data) {
  const lists = Array.isArray(data?.shoppingLists) ? data.shoppingLists : [];
  if (Number(data?.shoppingOpenLists) !== 1 || lists.length !== 1 || lists[0]?.id == null) return '/shopping';
  return `/shopping?list=${encodeURIComponent(String(lists[0].id))}`;
}

/**
 * The preview tile of an extra on Dziś ("Kafelek podglądu" in Dostosuj Dziś):
 * budget, notes, health, housekeeping, rewards. The plan already lists the
 * doses and the waiting approvals, so `sheetSpeaks` keeps the tile from saying
 * them a second time.
 */
function metricTileFor(id, data, currency, sheetSpeaks = new Set()) {
  const route = { budget: BUDGET_MONTH_ROUTE, notes: '/notes', rewards: '/rewards', health: '/health', housekeeping: '/housekeeping' }[id];
  switch (id) {
    case 'budget': {
      const budget = data.budget ?? {};
      if (!(budget.entryCount > 0)) return null;
      const balance = budget.balance || 0;
      // DIE VORZEICHENREGEL IST NICHT NEU - sie ist die des Budget-Widgets,
      // Zeichen fuer Zeichen. Ein Minus allein wird bei 20px auf dem Handy
      // ueberlesen, deshalb traegt die Farbe den zweiten Kanal; und der
      // Sonderfall aus #504 kommt mit: wer nur Ausgaben erfasst, hat einen
      // rechnerisch negativen Saldo, der nichts ueber seine Lage sagt, und
      // bekommt Label-Farbe statt Rot.
      const neutral = (budget.income || 0) === 0 && balance < 0;
      return {
        id, route, icon: widgetIcon('budget'), label: t('nav.budget'),
        value: formatCurrency(balance, currency),
        note: t('dashboard.monthlyBalance'),
        tone: neutral ? 'balance-neutral' : balance >= 0 ? 'balance-positive' : 'balance-negative',
      };
    }
    case 'notes': {
      const notes = data.pinnedNotes ?? [];
      if (!notes.length) return null;
      /* `pinnedNotes` ist die VORSCHAU (gepinnt zuerst, dann aktuellste, drei
       * Stueck), nicht die Menge der gepinnten - `notes.length` las deshalb bei
       * null Pins "3 angepinnt" und bei fuenf ebenfalls "3". Die Zahl kommt aus
       * `pinnedNotesCount`, die Vorschau bleibt die Vorschau. */
      const pinned = data.pinnedNotesCount ?? notes.filter((n) => n.pinned).length;
      if (!pinned) return null;
      return {
        id, route, icon: widgetIcon('notes'), label: t('nav.notes'),
        value: t('dashboard.metricPinned', { count: pinned }),
        note: notes[0]?.title || t('notes.titlePlaceholder'),
      };
    }
    case 'rewards': {
      // KEIN SPITZENREITER (Critique 2026-09-23). Die Kachel nannte den
      // hoechsten Stand samt Namen - dieselbe Rangliste wie das alte Widget,
      // nur kuerzer. Wer selbst sammelt, sieht den eigenen Stand und sein Ziel;
      // wer freigibt, sieht nur, ob etwas auf ihn wartet.
      const r = data.rewards ?? {};
      const standings = Array.isArray(r.standings) ? r.standings : [];
      const own = standings.find((m) => m.id === r.me);
      if (own && (r.view === 'self' || standings.length === 1)) {
        return {
          id, route, icon: widgetIcon('rewards'), label: t('nav.rewards'),
          value: t('dashboard.metricPoints', { count: Number(own.balance) || 0 }),
          note: rewardGoalLabel(own.balance, r.catalog),
        };
      }
      // Waiting approvals are rows of the plan (Dziś), never a tile.
      return null;
    }
    case 'health': {
      const h = data.health ?? {};
      // Ohne Medikamente hat die Kachel keine Kennzahl - und der Zyklus ist
      // bewusst NICHT ihr Ersatz: er haengt an expliziten Grants (#584), und
      // eine Kachel, die je nach Berechtigung etwas anderes zeigt, ist zwei
      // Kacheln mit einem Namen.
      if (!h.hasMeds || !(h.dosesTotal > 0)) return null;
      // Nennt das Heute-Blatt die offenen Dosen schon, waere „2 offen" hier
      // dieselbe Zahl ein zweites Mal - ausser eine Packung muss nachbestellt
      // werden, das sagt das Blatt nicht.
      if (sheetSpeaks.has('doses') && !(h.lowStockCount > 0)) return null;
      const offen = h.dosesTotal - (h.dosesTaken ?? 0) - (h.dosesSkipped ?? 0);
      return {
        id, route, icon: widgetIcon('health'), label: t('nav.health'),
        // „2 Dosen" liess offen, ob offen oder genommen (Critique 2026-09-23,
        // Persona Grosseltern) - der Wert nennt jetzt den Zustand („2 offen",
        // wie „12 offen" bei den Aufgaben; „2 Dosen offen" passte mobil nicht
        // in die nicht umbrechende Wertzeile), und die Zweitzeile nennt die
        // naechste Dosis mit Uhrzeit statt nur dem Namen.
        value: t('dashboard.metricDoses', { count: Math.max(0, offen) }),
        // Die Nachbestellung schlaegt die naechste Uhrzeit: eine leere Packung
        // ist der Zustand, der eine Handlung braucht, eine faellige Dosis der,
        // der von selbst kommt.
        note: h.lowStockCount > 0
          ? t('dashboard.healthRefill', { count: h.lowStockCount })
          : offen <= 0 || !h.nextDose?.name
            ? t('dashboard.healthAllTaken')
            : `${h.nextDose.time ? `${formatTime(h.nextDose.time)} ` : ''}${h.nextDose.name}`,
        noteTone: h.lowStockCount > 0 ? 'danger' : null,
      };
    }
    case 'housekeeping': {
      const hk = data.housekeeping ?? {};
      if (!hk.configured) return null;
      return {
        id, route, icon: widgetIcon('housekeeping'), label: t('nav.housekeeping'),
        // „9 Besuche" ohne Zeitraum - gezaehlt werden die abgeschlossenen
        // Besuche des laufenden Monats (routes/dashboard.js), und das sagt der
        // Wert jetzt. Kurz („9 im Monat"), weil der Wert nicht umbricht: die
        // Kachel ist mobil 152px breit, „9 Besuche diesen Monat" wurde dort
        // abgeschnitten (gemessen). Das Substantiv steht im Kachelnamen.
        value: t('dashboard.metricVisitsMonth', { count: hk.visitsThisMonth ?? 0 }),
        // Drei Zustaende, ein Rang: wer gerade da ist, ist die Nachricht; sonst
        // zaehlt offenes Geld; sonst der letzte Besuch. „Gerade im Haus" um
        // 21:18 las sich wie ein Fehler - mit „seit 08:00" ist es eine Auskunft
        // (und eine vergessene Abmeldung von gestern sieht man am Datum).
        note: hk.present
          ? (hk.presentSince
            ? t('dashboard.housekeepingPresentSince', { time: housekeepingSinceLabel(hk.presentSince) })
            : t('dashboard.housekeepingPresent'))
          : hk.unpaidAmount > 0
            ? t('dashboard.housekeepingUnpaid', { amount: formatCurrency(hk.unpaidAmount, currency) })
            : hk.lastVisit
              ? t('dashboard.housekeepingLastVisit', { date: earnedWhenLabel(hk.lastVisit) })
              : t('dashboard.housekeepingNoVisits'),
      };
    }
    default:
      return null;
  }
}

/** Der Satz zur naechsten Praemie - fuer Balken und Kennzahlkachel derselbe. */
function rewardGoalLabel(balance, catalog, goal = nextRewardGoal(balance, catalog)) {
  // Ein Minus steht nie ohne Satz da (#1607) - derselbe Satz und dieselbe
  // Reihenfolge wie nextRewardHint() auf der Belohnungsseite.
  if (Number(balance) < 0) return t('rewards.balanceBelowZero');
  if (!goal) return t('rewards.noRewardsYet');
  if (goal.reached) return t('rewards.canRedeemNow');
  return t('rewards.remainingToReward', { points: formatPoints(goal.missing), reward: goal.target.name });
}

/**
 * Wann eine Gutschrift kam - rueckwaerts gelesen. `relativeDateLabel` schaut
 * nach vorn (heute, morgen) und schrieb fuer vorgestern "21.09.2026": in einer
 * Zeile, die ohnehin nur die letzten Tage traegt, ist das Jahr Laerm. Es steht
 * nur, wenn es ein anderes ist.
 */
function earnedWhenLabel(value) {
  const day = zonedDateKey(value);
  if (!day) return '';
  const today = householdToday();
  if (day === today) return t('common.today');
  if (day === addLocalDays(today, -1)) return t('common.yesterday');
  return day.slice(0, 4) === today.slice(0, 4) ? formatDayMonth(value) : formatDate(value);
}

/** A selector that finds "the same" element again after a rebuild of Dziś. */
function focusKeyOf(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  // Dziś (Tafla): a control is its action plus, in a row, the row's key - the
  // circle of "Zamówić tort" is found again after any rebuild.
  const dayAction = el.getAttribute?.('data-day-action');
  if (dayAction) {
    const rowKey = el.getAttribute('data-row-key');
    return `[data-day-action="${CSS.escape(dayAction)}"]${rowKey ? `[data-row-key="${CSS.escape(rowKey)}"]` : ''}`;
  }
  return rowFocusKeyOf(el);
}

/**
 * Dasselbe fuer eine INHALTSZEILE (#1821): Termin, Notiz, Liste, Aufgabe.
 *
 * Die Flaeche baut nicht nur im Anpassen-Modus neu, sondern auch still - bei
 * der Rueckkehr in den Tab, im Viertelstundentakt, an einer Tagesgrenze, nach
 * dem Wetter. Wer mit der Tastatur auf einer Zeile stand, stand danach auf
 * <body>, und Enter tat nichts mehr. Eine Zeile hat keine Id; ihre Identitaet
 * ist, wohin sie fuehrt (`data-route`, bei Aufgaben `data-task-id`), in welcher
 * Kachel sie steht und - wo mehrere Zeilen dasselbe Ziel haben (Schichtplan,
 * Mahlzeiten) - die wievielte sie ist. Der Fokus kann auch auf einem Kind
 * liegen (der Notizkoerper traegt den Tabstopp, die Karte den Weg).
 *
 * `preventScroll`: der stille Neuaufbau darf niemanden zu einer Zeile
 * zurueckholen, von der er weggescrollt hat.
 */
function rowFocusKeyOf(el) {
  const row = el.closest?.('[data-route], [data-task-id]');
  if (!row) return null;
  const quoted = (name, value) => `[${name}="${CSS.escape(value)}"]`;
  let own = row.hasAttribute('data-task-id')
    ? quoted('data-task-id', row.getAttribute('data-task-id'))
    : quoted('data-route', row.getAttribute('data-route'));
  if (row.dataset.objectKind && row.dataset.objectId) {
    own += quoted('data-object-kind', row.dataset.objectKind) + quoted('data-object-id', row.dataset.objectId);
  }
  if (el !== row) {
    const cls = el.classList?.[0];
    if (!cls) return null;
    own += ` .${CSS.escape(cls)}`;
  }
  const selector = own;
  const root = row.closest('#dashboard-shell') ?? row.ownerDocument;
  const index = Math.max(0, [...root.querySelectorAll(selector)].indexOf(el));
  return { selector, index, preventScroll: true };
}

/**
 * VOR dem Neuaufbau: wer hat den Fokus, und unter welchem Schluessel findet
 * man ihn danach wieder? Nur ein Element IN der Flaeche zaehlt - ein Dialog
 * oder die Navigation behalten ihren Fokus ohnehin.
 *
 * @returns {{key: (string|object|null), had: boolean}}
 */
function captureRebuildFocus(shell, active, body) {
  const had = Boolean(active) && active !== body && Boolean(shell?.contains(active));
  return { key: had ? focusKeyOf(active) : null, had };
}

/**
 * NACH dem Neuaufbau: der erste Kandidat, den es gibt und der bedienbar ist,
 * bekommt den Fokus. Ein Kandidat ist ein Selektor (erster Treffer gilt: Ids,
 * Bearbeiten-Knoepfe, der Nachfolger, den eine Geste nennt) oder der Schluessel
 * einer Inhaltszeile mit Selektor UND Stelle (rowFocusKeyOf) - der kommt ohne
 * Scrollen zurueck, weil der stille Neuaufbau niemanden zu einer Zeile holen
 * darf, von der er weggescrollt hat.
 *
 * @returns {Element|null} das fokussierte Element
 */
function restoreFocusAfterRebuild(container, candidates) {
  for (const candidate of (candidates ?? []).filter(Boolean)) {
    const isRow = typeof candidate !== 'string';
    const el = isRow
      ? container.querySelectorAll(candidate.selector)[candidate.index]
      : container.querySelector(candidate);
    // Ein Knopf, der bei dieser Breite nicht gerendert ist (Anpassen mobil im
    // Menue, R19), nimmt keinen Fokus - weiter zum naechsten Kandidaten.
    if (el && !el.disabled && el.getClientRects?.().length !== 0) {
      if (isRow) el.focus({ preventScroll: candidate.preventScroll });
      else el.focus();
      return el;
    }
  }
  return null;
}

/* EINE ANSAGE-REGION, DIE DEN NEUAUFBAU UEBERLEBT.
 *
 * Eine Live-Region wird nur gehoert, wenn es sie schon gab, bevor ihr Text sich
 * aendert - eine, die mit dem Neuaufbau selbst entsteht, schweigt in der Regel.
 * Die Seite baut aber bei jeder Anpassen-Geste und bei jedem Timer-Wechsel neu.
 * Gesprochen wird deshalb ueber den Ansager der Shell (`#route-announcer`,
 * router.js): hoeflich, atomar, sr-only und fuer die ganze Sitzung da. Er meldet
 * sonst Seitenwechsel - eine Zustandsaenderung dieser Seite ist dieselbe Sorte
 * Nachricht. Leeren und verzoegert setzen ist sein eigenes Muster: derselbe Text
 * zweimal hintereinander waere sonst keine Aenderung. */
let announceTimer = null;
function announceDashboard(message) {
  const region = typeof document === 'undefined' ? null : document.getElementById('route-announcer');
  if (!region || !message) return;
  clearTimeout(announceTimer);
  region.textContent = '';
  announceTimer = setTimeout(() => { region.textContent = message; }, 50);
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* WIDGET-OPTIONEN (#814) - was ein Widget zeigt, nicht nur ob und wie gross.
 *
 * DIE OPTIONEN GEHOEREN DEM FRONTEND, wie die Widget-Ids seit jeher: der Server
 * speichert `options` als Form und weiss nicht, was drinsteht (preferences.js,
 * `normalizeWidgetOptions`). Eine serverseitige Registry „welches Widget kennt
 * welche Option" waere der billige Anfang und danach der Preis jedes weiteren
 * Widgets. Was der Browser daraus macht, sind Query-Parameter, die die Route
 * ohnehin versteht - kein zweiter Filterweg.
 *
 * WARUM EIN EIGENER DIALOG statt eines weiteren Steuerelements in der Leiste:
 * die Kachelleiste traegt Griff, Reihenfolge, vier Groessen und Ausblenden; eine
 * Kategorienauswahl daneben kippt sie auf 1x1-Kacheln ins Ueberlaufen (die
 * Lehre aus dem alten Groessen-Select, Critique P1). Der Knopf oeffnet, was
 * Platz braucht.
 */

/* Das Etikett einer Kategorie - dieselbe Regel wie im Aufgabenmodul
 * (`catLabel` in pages/tasks.js): die mitgelieferten Kategorien tragen einen
 * i18n-Schluessel, die selbst angelegten ihren Namen. Wer hier `key` anzeigt,
 * stellt „household" neben „Einkaufen" in dieselbe Liste. */
function taskCategoryLabel(category) {
  if (!category) return '';
  return category.label_key ? t(category.label_key) : (category.name || category.key);
}

/** Kategorien der Aufgaben - nur wenn der Dialog sie braucht, und nur einmal. */
let taskCategoriesCache = null;
async function loadTaskCategories() {
  if (taskCategoriesCache) return taskCategoriesCache;
  try {
    const res = await api.get('/tasks/categories');
    taskCategoriesCache = Array.isArray(res?.data) ? res.data : [];
  } catch {
    taskCategoriesCache = [];
  }
  return taskCategoriesCache;
}

/**
 * Der Optionen-Dialog eines Filters, den „Dostosuj Dziś" anbietet (#814): die
 * Kategorien der Aufgaben und der Kalender (nur meine, Geburtstage, Stufe).
 * Beide engen die ganze /dashboard-Antwort ein und damit den Plan. Aufloesen
 * mit den neuen Optionen oder null.
 */
async function openWidgetOptions(id, current = {}) {
  const options = { ...current };
  const categories = id === 'tasks' ? await loadTaskCategories() : [];

  const body = id === 'calendar'
    ? `
      <fieldset class="form-group widget-options__group">
        <legend class="form-label">${t('dashboard.optionCalendarScope')}</legend>
        <label class="widget-options__choice">
          <input type="radio" name="cal-scope" value="all" ${options.scope === 'mine' ? '' : 'checked'}>
          <span>${t('dashboard.optionCalendarAll')}</span>
        </label>
        <label class="widget-options__choice">
          <input type="radio" name="cal-scope" value="mine" ${options.scope === 'mine' ? 'checked' : ''}>
          <span>${t('calendar.assignedToMe')}</span>
        </label>
      </fieldset>
      <fieldset class="form-group widget-options__group">
        <legend class="form-label">${t('calendar.filtersLayers')}</legend>
        <p class="widget-options__hint">${t('dashboard.optionCalendarBirthdaysHint')}</p>
        <label class="widget-options__choice">
          <input type="checkbox" name="cal-birthdays" ${options.birthdays === 'hide' ? '' : 'checked'}>
          <span>${t('calendar.toggleBirthdays')}</span>
        </label>
      </fieldset>
      <fieldset class="form-group widget-options__group">
        <legend class="form-label">${t('dashboard.optionCalendarLimit')}</legend>
        ${EVENT_LIMIT_STEPS.map((step) => `
        <label class="widget-options__choice">
          <input type="radio" name="cal-limit" value="${step}" ${clampEventLimit(options.limit) === step ? 'checked' : ''}>
          <span>${esc(getNumberFormat().format(step))}</span>
        </label>`).join('')}
      </fieldset>`
    : `
      <fieldset class="form-group widget-options__group">
        <legend class="form-label">${t('dashboard.optionTaskCategories')}</legend>
        <p class="widget-options__hint">${t('dashboard.optionTaskCategoriesHint')}</p>
        ${categories.length ? categories.map((c) => `
        <label class="widget-options__choice">
          <input type="checkbox" name="task-category" value="${esc(c.key)}"
                 ${(options.categories ?? []).includes(c.key) ? 'checked' : ''}>
          <span>${esc(taskCategoryLabel(c))}</span>
        </label>`).join('') : `<p class="widget-options__hint">${t('dashboard.optionTaskCategoriesEmpty')}</p>`}
      </fieldset>`;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    openModal({
      title: t('dashboard.optionsFor', { widget: widgetLabel(id) }),
      size: 'sm',
      content: `
        <form id="widget-options-form" class="widget-options">
          ${body}
          <div class="modal-panel__footer modal-panel__footer--plain">
            <button type="button" class="btn btn--secondary" data-action="cancel">${t('common.cancel')}</button>
            <button type="submit" class="btn btn--primary">${t('common.save')}</button>
          </div>
        </form>`,
      onClose: () => finish(null),
      onSave(panel) {
        panel.querySelector('[data-action="cancel"]').addEventListener('click', () => closeModal({ force: true }));
        panel.querySelector('#widget-options-form').addEventListener('submit', (event) => {
          event.preventDefault();
          const next = {};
          if (id === 'calendar') {
            const scope = panel.querySelector('input[name="cal-scope"]:checked')?.value;
            // „Alles" ist die Abwesenheit einer Einschraenkung und wird deshalb
            // nicht gespeichert - sonst stuende in jedem Layout ein Feld, das
            // den Auslieferungszustand wiederholt.
            if (scope === 'mine') next.scope = 'mine';
            // Dasselbe eine Zeile tiefer, nur andersherum notiert: gespeichert
            // wird das ABWAEHLEN, nicht das Haekchen (#927).
            if (!panel.querySelector('input[name="cal-birthdays"]')?.checked) next.birthdays = 'hide';
            // Und die Stufe (#1680): gespeichert wird nur, was von der Vorgabe
            // abweicht, als Zahl und durch die Klemme - ein Wert, den es im
            // Dialog nicht gibt, kommt so auch nicht ins Layout.
            const limit = clampEventLimit(panel.querySelector('input[name="cal-limit"]:checked')?.value);
            if (limit !== EVENT_LIMIT_DEFAULT) next.limit = limit;
          } else {
            const picked = [...panel.querySelectorAll('input[name="task-category"]:checked')].map((el) => el.value);
            // Keine Auswahl heisst „alle" - eine leere Liste als Filter waere
            // ein leeres Dashboard fuer jemanden, der nur den Dialog geoeffnet hat.
            if (picked.length) next.categories = picked;
          }
          finish(next);
          closeModal({ force: true });
        });
      },
    });
  });
}

// Distinkter Fehlerzustand: verhindert, dass ein Ladefehler wie ein ruhiger,
// leerer Tag aussieht (falsch beruhigend). Bietet einen Retry, der neu lädt.
// Die Meldung unterscheidet Sitzungsablauf (401/403) und Serverfehler (5xx)
// von einem generischen Verbindungsproblem — Retry hilft nicht überall gleich.
function renderDashboardError(status = null) {
  const messageKey = status === 401 || status === 403
    ? 'dashboard.loadErrorSession'
    : (typeof status === 'number' && status >= 500)
      ? 'dashboard.loadErrorServer'
      : 'dashboard.loadError';
  return `
    <div class="dashboard-error" role="alert">
      <i data-lucide="cloud-off" class="dashboard-error__icon" aria-hidden="true"></i>
      <p class="dashboard-error__text">${t(messageKey)}</p>
      <button type="button" class="btn btn--secondary" id="dashboard-retry">
        <i data-lucide="refresh-cw" aria-hidden="true"></i>
        ${t('common.retry')}
      </button>
    </div>
  `;
}

// Inline-Fehlerkachel für ein einzelnes Widget (siehe Fehler-Isolation in
// renderDashboardLayout). Nutzt die vorhandene .widget/.widget__empty-Grammatik,
// damit sie sich ruhig einreiht statt wie ein Systemfehler zu schreien.
function renderWidgetError(id) {
  return `<div class="widget widget--error" role="alert">
    <div class="widget__header">
      <span class="widget__title">
        <i data-lucide="${widgetIcon(id)}" class="widget__title-icon" aria-hidden="true"></i>
        ${widgetLabel(id)}
      </span>
    </div>
    <div class="widget__empty">
      <i data-lucide="cloud-off" class="empty-state__icon" aria-hidden="true"></i>
      <div>${t('dashboard.widgetError')}</div>
      <button type="button" class="btn btn--secondary widget__retry" data-widget-retry="${esc(id)}">
        <i data-lucide="refresh-cw" aria-hidden="true"></i>
        ${t('common.retry')}
      </button>
    </div>
  </div>`;
}

// --------------------------------------------------------
// Wetter-Widget
// --------------------------------------------------------

const WEATHER_ICON_BASE = '/api/v1/weather/icon/';

function weatherIconHtml(weather, icon, cls, size, desc) {
  if (weather?.provider === 'open-meteo') {
    return `<i data-lucide="${esc(icon)}" class="${cls}" aria-hidden="true"></i>`;
  }
  return `<img class="${cls}" src="${WEATHER_ICON_BASE}${esc(icon)}"
           alt="${esc(desc)}" width="${size}" height="${size}" loading="lazy">`;
}

function startClockTicker(container, signal, onTick = null) {
  let timerId = null;

  const tick = () => {
    onTick?.();
    schedule();
  };

  const schedule = () => {
    const now = new Date();
    const msToNextMinute = 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds());
    timerId = setTimeout(tick, msToNextMinute);
  };

  schedule();
  signal.addEventListener('abort', () => clearTimeout(timerId));
}

// --------------------------------------------------------
// Wand-Modus (Tafla, 2026-10-19)
// --------------------------------------------------------

/* DIE WAND IN DER KUECHE.
 *
 * Eine ANZEIGE fuer zwei Meter: wer am Tablett vorbeigeht, liest in zwei
 * Sekunden die Uhr, was als Naechstes ansteht, das Abendessen und den Einkauf.
 * Modell und Markup stehen ausserhalb dieser Seite (utils/wall-plan.js,
 * components/wall-view.js); hier stehen nur die Verdrahtung und die Daten.
 *
 * WAS SICH MIT TAFLA GEAENDERT HAT (DESIGN.md, „Der Wand-Modus"):
 *   - Der Deckel von vier Zeilen (WALL_ROW_CAP) ist einem Hoehenbudget
 *     gewichen: die Dziś-Karte zeigt, was in ihre Hoehe passt, der Rest wird
 *     „+N więcej" (fitWallLists).
 *   - „Wer heute dran ist" ist gegangen - die Scheiben an den Zeilen sagen es.
 *   - Das Abendessen steht ab 15:00 bis zwei Stunden nach dem Essen als
 *     Hauptkarte mit „Gotuj" da.
 *   - Abhaken ist moeglich, aber nur, wenn der Haushalt „Pozwól odhaczać na
 *     ścianie" eingeschaltet hat (Standard aus; der Server setzt es durch,
 *     services/wall-settings.js). Minutnik und Gotuj gehen immer. */

/** Nach diesem Takt versucht die Wand einen Ladefehler von selbst zu heilen. */
const WALL_HEAL_MS = 60_000;

/** Module, die an der Wand fehlen: abgeschaltet oder ohne Leserecht. */
function wallModuleOff(module) {
  return Boolean(globalThis.window?.yuvomi?.isModuleDisabled?.(module)) || moduleAccess(module) === 'none';
}

/**
 * Die ganze Flaeche als Markup. Ohne Daten (Laden, Fehler) stehen trotzdem die
 * Uhr und der Minutnik: beide haengen an nichts, was geladen werden koennte.
 */
function renderWallSurface(data, weather, {
  failed = false, loading = false, updatedAt = null, now = new Date(), screensaverEnabled = false,
  sections = null, mayWrite = false, isDisplay = false, predictions = [], question = null, tickers = null,
  questionSettled = null,
} = {}) {
  const model = buildWall(failed || loading ? null : data, {
    now, sections, mayWrite, isDisplay, timer: readWallTimer(), lastLoadedAt: updatedAt,
    predictions, question, tickers, moduleOff: wallModuleOff, mealLabel: mealTypeLabel,
  });
  return renderWall(model, {
    clock: wallClock(now),
    weather,
    weatherIcon: weatherIconHtml,
    screensaverEnabled,
    state: failed ? 'failed' : loading ? 'loading' : null,
    ui: { questionSettled },
  });
}

/**
 * Das Einpassen der Dziś-Liste an EINER Stelle verdrahtet: nach jedem Aufbau
 * und bei jeder Groessenaenderung (Drehen des Tabletts, Vollbild), hoechstens
 * einmal pro Bild. Haengt am Signal der Seite und faellt mit ihr.
 */
function createWallFit(win, signal) {
  let shown = null;
  let frame = 0;
  win.addEventListener('resize', () => {
    if (!shown || frame) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      if (shown?.isConnected) fitWallLists(shown);
    });
  }, { signal, passive: true });
  signal.addEventListener('abort', () => {
    win.cancelAnimationFrame(frame);
    shown = null;
  }, { once: true });
  return {
    show(shell) {
      shown = shell;
      return fitWallLists(shell);
    },
  };
}

/**
 * Baut die Wand in die Schale: Flaeche, Zeichen, Bedienung, Einpassen. EINE
 * Funktion, damit kein Schritt davon am Aufrufer vergessen werden kann.
 */
function rebuildWall(container, shell, { surface, rerender, signal, fit, actions }) {
  // Der stille Neuaufbau (Minutentakt, Timer) nimmt den Fokus mit, statt ihn
  // auf <body> fallen zu lassen - dasselbe Paar wie in rebuildDashboard.
  const doc = globalThis.document;
  const { key: keepFocus } = captureRebuildFocus(shell, doc?.activeElement, doc?.body);
  setHtml(shell, surface);
  if (globalThis.window?.lucide) globalThis.window.lucide.createIcons({ el: shell });
  wireRecipeThumbs(shell);
  wireWallSurface(container, rerender, signal, actions);
  restoreFocusAfterRebuild(container, [keepFocus, takeWallFocusIntent('enter') ? '#wall-surface' : null]);
  return fit.show(shell);
}

/** Haelt Uhr und Datum der Wand im Minutentakt aktuell, ohne Neuaufbau. */
function updateWallClock(container, now = new Date()) {
  const clockEl = container.querySelector('#wall-clock');
  if (!clockEl) return;
  const clock = wallClock(now);
  clockEl.textContent = clock.time;
  clockEl.setAttribute('datetime', clock.machine);
  const dateEl = container.querySelector('#wall-date');
  if (dateEl && clock.dayKey) dateEl.textContent = wallDateLabel(clock.dayKey);
}

/**
 * Verdrahtet die Bedienung der Flaeche: Minutnik, Bildschirmschoner und - nur
 * wenn der Haushalt das Abhaken erlaubt - Ringe, „+"-Chips und die Frage der
 * Woche. Was ein Tipp TUT, kommt als `actions` aus render().
 */
function wireWallSurface(container, rerender, signal, actions = {}) {
  const wall = container.querySelector('.wall');
  if (!wall) return;

  wireWallTimer(wall, rerender, signal, { announce: announceDashboard });

  wall.querySelector('#wall-screensaver-start')?.addEventListener('click', async () => {
    const { preview } = await import('/components/photo-screensaver.js');
    if (!await preview()) window.yuvomi?.showToast(t('dashboard.wallScreensaverNone'), 'info');
  }, { signal });

  wall.addEventListener('click', (event) => {
    const tick = event.target.closest?.('[data-wall-tick]');
    if (tick) { void actions.tick?.(tick.dataset.wallTick, tick); return; }
    const add = event.target.closest?.('[data-wall-add]');
    if (add) { void actions.add?.(add.dataset.wallAdd, add); return; }
    const answer = event.target.closest?.('[data-wall-answer]');
    if (answer) { void actions.answer?.(Number(answer.dataset.wallAnswer), answer); return; }
    if (event.target.closest?.('[data-wall-skip]')) void actions.skip?.();
  }, { signal });
}

/**
 * Der Ausstieg - datenunabhaengig, und deshalb getrennt vom Rest.
 *
 * Er stand bis zum Review in `wireWallSurface` und wurde damit erst verdrahtet,
 * wenn die Dashboard-Daten da waren. Auf der Ladeflaeche ist der Knopf sichtbar,
 * aber tot; haengt die Anfrage, kommt niemand mehr aus dem Wandmodus heraus -
 * in der installierten PWA ohne Browserleiste heisst das: gar nicht mehr.
 *
 * Er haengt am CONTAINER, nicht am Knopf: `setHtml` tauscht dessen Inhalt aus,
 * der Container selbst bleibt. So ueberlebt die eine Verdrahtung beide Renders,
 * und es braucht keinen zweiten Aufruf, der Escape ein zweites Mal registrierte.
 */
function wireWallExit(container, rerender, signal) {
  const leave = () => {
    releaseWallMarker();
    exitWallMode();
    _wallFocusIntent = 'leave';
    // Der Toast sagt, WO der Weg zurueck liegt - wer versehentlich aussteigt,
    // soll nicht suchen muessen. Der Name kommt aus dem Schluessel des Knopfes
    // statt aus dem Satz: sonst driftet die Wegbeschreibung, sobald der Knopf
    // umbenannt wird.
    //
    // Er zeigte bis #915 in die Einstellungen, weil der Modus dort als einziges
    // eingeschaltet werden konnte. Das war nie falsch, aber seit der Einstieg in
    // der Werkzeugzeile steht, waere es der Umweg - und ein Hinweis, der den
    // Umweg nennt, waehrend der kurze Weg sichtbar danebenliegt, ist eine
    // schlechtere Auskunft als gar keiner.
    window.yuvomi?.showToast(t('dashboard.wallExited', {
      action: t('dashboard.wallEnter'),
    }), 'success', 6000);
    rerender();
  };

  container.addEventListener('click', (event) => {
    if (event.target.closest('#wall-exit')) leave();
    // GOTUJ geht immer (Tafla): Kochmodus ist die eine Vollbildansicht, die
    // die Wand oeffnen darf. Auf der Wand kehrt er nach dem Ende von selbst
    // zurueck (components/cook-mode.js, `wall`).
    const cookBtn = event.target.closest('[data-wall-cook]');
    if (cookBtn) {
      openCookForMeal(
        { mealId: cookBtn.dataset.meal, recipeId: cookBtn.dataset.recipe, date: cookBtn.dataset.date },
        { wall: true },
      ).catch(() => window.yuvomi?.showToast(t('cook.loadError'), 'danger'));
    }
  }, { signal });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') leave();
  }, { signal });
  // Der dritte Weg hinaus: Zurueck (#1559). Er schliesst die Wand wie ein
  // Dialog - `handleBackNavigation` ruft `leave`, der Router navigiert nicht.
  holdWallMarker(leave);
}

/** Am Telefon traegt die Uebersicht keinen eigenen FAB mehr - das + der Shell. */
function renderFab() {
  return '';
}

function initFab(signal) {
  findPageFab('fab-main')?.addEventListener('click', (e) => {
    // Der Kurzbefehl `n` klickt den Knopf auch, wenn er ausgeblendet ist
    // (triggerPageFab) - im Anpassen-Modus oeffnet er nichts.
    if (e.currentTarget.hidden) return;
    window.yuvomi?.openCapture?.();
  }, { signal });
}

// --------------------------------------------------------
// Eine Aufgabe aus der Übersicht öffnen (#918)
// --------------------------------------------------------

/**
 * Dieselbe Leseansicht, die das Aufgabenmodul öffnet.
 *
 * Hier stand ein eigenes Kärtchen mit zwei Knöpfen: „Bearbeiten" schickte den
 * Nutzer ins Aufgabenmodul, „Erledigt" hakte ab. Alles andere, was an einer
 * Aufgabe hängt - Teilaufgaben, Kommentare, Dokumente, die abhakbaren Zeilen
 * in der Beschreibung, die Fälligkeit, die Zuweisung - war von hier aus nicht
 * zu sehen und nicht zu erreichen.
 *
 * Das wog schwerer, als die zwei fehlenden Knöpfe klingen: Die Übersicht ist
 * die Ansicht, in der die App im Alltag steht. Das Aufgabenmodul ist die, in
 * der Aufgaben angelegt und aufgeräumt werden. Die eine bot weniger an als die
 * andere, obwohl sie öfter offen ist.
 *
 * Das Modul wird nachgeladen statt mitgeladen: Es zieht das Aufgabenformular
 * mit sich, und dessen Gewicht gehört nicht in den Start der Startseite.
 *
 * `rerender` frischt die Kachel auf, aus der geöffnet wurde - der Nutzer
 * bleibt, wo er war, statt im Aufgabenmodul zu landen. `user` reist mit,
 * weil an ihm haengt, wem seine eigenen Kommentare gehoeren und wer eine
 * gesperrte Aufgabe umschreiben darf.
 */
async function openTaskFromOverview(taskId, container, rerender, user) {
  try {
    const { openTaskById } = await import('/pages/tasks.js');
    await openTaskById(taskId, { user, container, onChanged: rerender });
  } catch (err) {
    console.error('[Dashboard] Aufgabe konnte nicht geöffnet werden:', err);
    window.yuvomi?.showToast(err.message ?? t('tasks.loadError'), 'danger');
  }
}

function updateWidgetConfig(config, id, patch) {
  return config.map((w) => w.id === id ? { ...w, ...patch } : w)
    .map((w, i) => ({ ...w, order: i }));
}

// --------------------------------------------------------
// Haupt-Render
// --------------------------------------------------------

// Dependencies injiziert, damit die Funktion ohne DOM/`navigator`-Globals testbar ist.
export async function maybeUpdateAutoLocation({ autoLocateEnabled, geolocation, putPreferences }) {
  if (!autoLocateEnabled || !geolocation) return false;
  try {
    const position = await new Promise((resolve, reject) => {
      geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 8000 });
    });
    await putPreferences({
      weather_user: {
        lat: position.coords.latitude.toFixed(4),
        lon: position.coords.longitude.toFixed(4),
        // Stadt-Label gehört zu den alten Koordinaten — Override löschen, damit das Widget
        // auf die "lat, lon"-Anzeige zurückfällt statt einen veralteten Namen zu zeigen.
        city: null,
      },
    });
    return true;
  } catch {
    return false;
  }
}

export async function render(container, { user, signal: routeSignal = null } = {}) {
  _fabController?.abort();
  // Zwei Achsen, ein Controller (#976/#977): das Router-Signal faellt beim
  // Verlassen der Seite, der eigene Controller beim naechsten eigenen Aufbau.
  // Alles, was dieser Aufbau verdrahtet, haengt an `signal` - nicht am
  // Modul-Feld, sonst registrierte ein ueberholter Aufbau seine Timer am
  // Controller des neueren. Ein verspaeteter Neuaufbau nach dem Verlassen
  // zeichnet gar nichts mehr.
  if (routeSignal?.aborted) return;
  const controller = createPageController(routeSignal);
  _fabController = controller;
  const { signal } = controller;
  dashboardViewer = user ?? null;

  // Der Wand-Modus ist ein Zustand DIESER Seite, kein zweiter Ort: die Route,
  // die Daten, der stille Refresh und die Echo-Regel bleiben dieselben - nur
  // Massstab, Dichte und Bedienbarkeit aendern sich. Ob er laeuft, hat der
  // Router bereits an der Wurzel vermerkt (utils/wall-mode.js).
  const wallMode = isWallActive();

  setHtml(container, `
    <div class="dashboard app-page app-page--dashboard${wallMode ? ' dashboard--wall' : ' dashboard--today'}" data-composition="dashboard">
      <h1 class="sr-only">${t('dashboard.title')}</h1>
      <div class="dashboard-shell" id="dashboard-shell">
        ${wallMode ? renderWallSurface(null, null, { loading: true }) : renderTodaySkeleton()}
      </div>
    </div>
    ${wallMode ? '' : renderFab()}
  `);

  // Der Zonen-Hinweis fuer Bestandshaushalte (#1607): ein Admin, dessen Browser
  // in einer anderen Zone steht, als der Haushalt ohne eigene Einstellung
  // rechnet, wird hier einmal gefragt. HIER und nicht nach den Daten: der Stand
  // dazu liegt seit dem Anmelden vor (router.js), die Zeile steht also schon
  // neben dem Skelett. Sie haengt neben `.dashboard-shell`, nicht darin - die
  // Shell wird mit den Daten neu gefuellt.
  mountZonePrompt(container.querySelector('.dashboard'), {
    user, t, api, wall: wallMode,
    before: container.querySelector('#dashboard-shell'),
    toast: (message, type) => window.yuvomi?.showToast(message, type),
  });
  // Die Frage der Woche (fork, 2026-10-19) steht seit Tafla als Abschnitt
  // „Pytanie tygodnia" in Dziś, an der Stelle, die die Person waehlt
  // (loadTodayExtras, components/today-view.js).

  // Ein Neuaufbau AUS DER SEITE HERAUS laeuft nicht durch renderPage() im
  // Router, und damit an dessen FAB-Wechsel vorbei (#634): den alten Knopf aus
  // der Shell-Ebene raeumen, den neuen aus dem Container dorthin heben. Der
  // synchrone Teil von render() hat den Speed-Dial schon gelegt - oder, auf der
  // Wand, keinen. Ohne diesen Schritt stand beim Betreten der alte Knopf auf der
  // Wand und nach dem Verlassen der neue ohne Plus im Scrollport (#1588).
  const rerender = () => {
    const done = render(container, { user, signal: routeSignal });
    window.yuvomi?.replacePageFab?.();
    return done;
  };
  // Steht keine Wand mehr (Ausstieg, Einstellungen), gehoert der Marker nicht
  // mehr ihr - sonst kostete die naechste Zurueck-Geste einen Tipp ins Leere.
  if (!wallMode) releaseWallMarker();

  // DER TIMER HAENGT NICHT AN DEN DATEN (Review zu #844). Die Wandflaeche wird
  // erst verdrahtet, wenn das Dashboard geladen hat - der Timer aber ist von
  // diesen Daten unabhaengig, und ein Neuzeichnen bricht den vorigen Controller
  // sofort ab. Startete jemand einen Timer, waehrend die Anfrage haengt, waeren
  // Takt und `data-wall-timer` weg, bis die Antwort kommt: die Anzeige stuende
  // still, es laeutete nicht, und der Screensaver duerfte sich darueberlegen.
  //
  // Er wird deshalb verdrahtet, sobald die Flaeche im DOM steht. Der Aufruf
  // nach dem Laden bleibt und ersetzt diesen hier - `wireWallTimer` raeumt
  // seinen vorigen Takt selbst ab.
  if (wallMode) {
    wireWallTimer(container.querySelector('.wall'), rerender, signal, { announce: announceDashboard });
    // Der Ausstieg gehoert zur selben Sorte: er haengt an nichts, was geladen
    // wird. Einmal verdrahtet, ueber den Container - er ueberlebt das zweite
    // Rendern und braucht keinen zweiten Aufruf.
    wireWallExit(container, rerender, signal);
  }

  let data         = { upcomingEvents: [], urgentTasks: [], todayMeals: [], pinnedNotes: [], shoppingLists: [], birthdays: [], countdowns: [], users: [], budget: {}, rewards: {}, health: {}, housekeeping: {} };
  // Ein Stand von vorhin darf keine Kachel versprechen: erst nach dem Laden
  // wieder wahr (siehe die Notiz an `countdownAvailable`).
  setCountdownAvailability([]);
  setWeatherAvailability(null, null);
  let weather      = null;
  let weatherPrefs = null;
  let weatherAutoLocate = false;
  let widgetConfig = buildDefaultWidgetConfig();
  let savedWidgetConfig = buildDefaultWidgetConfig();
  // Das Kopfband „Heute auf einen Blick" ist kein Rasterkachel, folgt aber
  // derselben Anpassen-Grammatik wie die Widgets: ausblenden am Block, zurueck
  // ueber die Chip-Leiste, und es faehrt in denselben Speicher-, Abbruch- und
  // Ruecknahme-Zyklus mit (#740). Persoenlich wie `dashboard_widgets` (#585):
  // beide liegen im selben PUT, und ein haushaltweites Kopfband neben einer
  // persoenlichen Anordnung hiesse, dass ein Ausblenden je nach Element mal
  // mich und mal alle traefe.
  let glanceVisible = true;
  let savedGlanceVisible = true;
  // Folge ich der Vorgabe des Haushalts, habe ich nichts Eigenes gespeichert -
  // dann gibt es auch nichts zurueckzusetzen (#827).
  let followsDefault = true;
  const canPublish = user?.role === 'admin';
  // Die Wand fragt die Haushaltsfassung der Uebersicht ab (#1817,
  // `dashboardRequest`). JEDER Abruf dieser Seite geht hier durch - auch der
  // stille Refresh, sonst stuende nach einer Viertelstunde wieder die
  // persoenliche Fassung an der Wand. Die faelligen Erinnerungen ebenso
  // (`loadPendingReminders`): sie sind die zweite Antwort, die davon abhaengt,
  // wer fragt.
  const overviewRequest = (query) => dashboardRequest(query, { wall: wallMode });
  // Hat ein Admin eine Vorgabe fuer den Haushalt veroeffentlicht? Dann gilt sie
  // samt ihrer Kacheln auch fuer die, die ihr folgen (Dziś, todayVisible).
  let householdDefaultPublished = false;
  let screensaverEnabled = false;
  /* WHAT THE WALL KEEPS ACROSS REBUILDS (Tafla): the household's choices, the
   * extras that arrive after the first paint ("Kończy się", the question of
   * the week, who the display may tick for) and the answer line that stands
   * for three seconds. */
  const wallUi = {
    sections: null,
    mayWrite: false,
    isDisplay: user?.access_scope === 'display',
    predictions: [],
    question: null,
    questionSettled: null,
    tickers: null,
    busy: new Set(),
  };
  let currency     = 'EUR';
  let visibleMealTypes = MEAL_ORDER;
  let loadFailed   = false;
  let loadErrorStatus = null;
  // Zeitpunkt des letzten geglueckten Datenstands - der Anker im Masthead (A8).
  // Bleibt `null`, solange nichts geladen wurde: eine Uhrzeit ohne Daten
  // dahinter waere die falscheste aller Angaben.
  let lastLoadedAt = null;
  try {
    const [dashRes, weatherRes, prefsRes, remindersRes] = await Promise.all([
      api.get(overviewRequest(layoutHintQuery('/dashboard'))),
      api.get(`/weather?lang=${encodeURIComponent(getLocale())}`).catch(() => ({ data: null })),
      // Beim Start hat der Router dieselbe Antwort schon unterwegs und reicht
      // sie herein (utils/start-handoff.js) - sonst zwei `/preferences` je
      // Kaltstart. Danach gibt es nichts mehr abzuholen, und die Seite fragt selbst.
      (window.yuvomi?.takeStartPreferences?.() ?? api.get('/preferences')).catch(() => ({ data: {} })),
      loadPendingReminders(overviewRequest),
    ]);
    // Ueberholt oder verlassen, waehrend die Antworten unterwegs waren (#977):
    // dieser Aufbau gehoert niemandem mehr und faesst die Flaeche nicht an.
    if (signal.aborted) return;
    primeMealTypeNames(prefsRes?.data);
    data         = dashRes;
    /* Die Zahlen an den Nav-Zielen und Modulkacheln kommen aus derselben
     * Antwort (#868). Sie hier hereinzureichen spart die zweite Aggregation,
     * die der Shell-Aufbau sonst beim Anmelden anstiess - `layoutHintQuery`
     * schraenkt sie allerdings ein, und eine eingeschraenkte Zahl ist eine
     * andere Zahl, also nimmt der Speicher sie nur ungefiltert an. Die Stufe
     * der Kalender-Kachel (`events_limit`, #1680) ist kein Filter: sie aendert
     * keine Zahl, und mit ihr als „gefiltert" holte der Router die Antwort bei
     * jedem Kaltstart ein zweites Mal (`dashboardQueryFiltersCounts`). */
    window.yuvomi?.primeModuleCountsFrom?.(dashRes, {
      filtered: dashboardQueryFiltersCounts(overviewRequest(layoutHintQuery('/dashboard'))),
    });
    // Geburtstags-Termine tragen serverseitig einen sprachneutralen Titel
    // („Birthday: <Name>"); anhand von birthday_name in die aktive Sprache
    // übersetzen (Issue #524).
    localizeEventLists(data);
    setCountdownAvailability(data?.countdowns);
    weather      = weatherRes.data ?? null;
    weatherPrefs = prefsRes.data ?? null;
    setWeatherAvailability(weatherRes, weatherPrefs);
    weatherAutoLocate = Boolean(prefsRes.data?.weather_user?.auto_locate ?? prefsRes.data?.weather_auto_locate);
    widgetConfig = childDefaultFor(
      normalizeDashboardConfigWithExtensions(prefsRes.data?.dashboard_widgets ?? buildDefaultWidgetConfig()),
      user,
      prefsRes.data?.dashboard_follows_default !== false,
    );
    savedWidgetConfig = widgetConfig.map((w) => ({ ...w }));
    /* WIDGET-OPTIONEN KOMMEN EINEN SCHRITT ZU SPAET (#814): die Uebersicht und
     * die Praeferenzen laufen absichtlich parallel los, aber welche Filter
     * gelten, steht erst in der Antwort der zweiten. Die erste Abfrage nimmt
     * deshalb den Pfad, den dieses Geraet zuletzt gebraucht hat
     * (`layoutHintQuery`, dieselbe Vorhersage wie beim Skelett) - im
     * Regelfall stimmt er, und es bleibt bei einer Abfrage.
     *
     * Stimmt er nicht, wird nachgeholt, und zwar VOR dem ersten Zeichnen: sonst
     * saehe man kurz Termine, die man ausgeblendet hat. Die Alternative - erst
     * Praeferenzen, dann Uebersicht - kostete JEDEN Aufruf eine Rundreise, auch
     * die ohne Optionen. */
    if (dashboardQuery(widgetConfig) !== layoutHintQuery('/dashboard')) {
      try {
        const filtered = await api.get(overviewRequest(dashboardQuery(widgetConfig)));
        if (signal.aborted) return;
        localizeEventLists(filtered);
        data = filtered;
        setCountdownAvailability(data?.countdowns);
      } catch { /* die ungefilterte Antwort steht bereits - lieber mehr als nichts */ }
    }
    data.pendingReminders = remindersRes;
    glanceVisible = prefsRes.data?.dashboard_today_glance !== false;
    savedGlanceVisible = glanceVisible;
    followsDefault = prefsRes.data?.dashboard_follows_default !== false;
    householdDefaultPublished = prefsRes.data?.dashboard_widgets_default != null;
    // Das Skelett des NAECHSTEN Aufrufs lernt hier seine Kachelform.
    rememberLayoutHint(widgetConfig, dashboardQuery(widgetConfig));
    screensaverEnabled = Boolean(prefsRes.data?.screensaver_enabled);
    // The household's choices for the wall (Tafla): its sections and whether
    // it may tick things off. Read on every build - an admin's switch reaches
    // the tablet with its next refresh.
    wallUi.sections = prefsRes.data?.wall_sections ?? null;
    wallUi.mayWrite = prefsRes.data?.wall_allow_ticking === true;
    currency     = prefsRes.data?.currency ?? 'EUR';
    visibleMealTypes = normalizeVisibleMealTypes(prefsRes.data?.visible_meal_types);
    lastLoadedAt = new Date();
  } catch (err) {
    console.error('[Dashboard] Ladefehler:', err.message, 'Status:', err.status ?? 'network');
    loadFailed = true;
    loadErrorStatus = Number.isFinite(err?.status) ? err.status : null;
  }

  // Auch die Nachlade-Runden koennen von einem Verlassen oder Neuaufbau
  // ueberholt worden sein (#977).
  if (signal.aborted) return;


  /** Die Uebersicht neu holen, wenn sich die Filter geaendert haben (#814). */
  async function reloadIfQueryChanged(previousQuery) {
    if (dashboardQuery(widgetConfig) === previousQuery) return;
    try {
      const fresh = await api.get(overviewRequest(dashboardQuery(widgetConfig)));
      localizeEventLists(fresh);
      fresh.cycle = data.cycle;
      fresh.schedule = data.schedule;
      fresh.waste = data.waste;
      fresh.pendingReminders = data.pendingReminders;
      data = fresh;
      setCountdownAvailability(data?.countdowns);
      lastLoadedAt = new Date();
    } catch { /* der alte Stand bleibt stehen, statt die Seite zu leeren */ }
  }

  /* DOSTOSUJ DZIŚ SAVES AS IT GOES (Tafla, 2026-10-19). Every switch and every
   * move in the sheet redraws Dziś behind it at once and is written in order
   * behind the previous write - the sheet has no "Anuluj", so there is no
   * unsaved state to lose. The first change gives the person their own layout,
   * exactly as saving the old customise mode did (#827). */
  let layoutWrites = Promise.resolve();
  function persistTodayLayout(nextConfig) {
    widgetConfig = nextConfig.map((w) => ({ ...w }));
    rebuildDashboard(widgetConfig);
    layoutWrites = layoutWrites.then(async () => {
      const previousQuery = dashboardQuery(savedWidgetConfig);
      try {
        await api.put('/preferences', { dashboard_widgets: widgetConfig, dashboard_today_glance: glanceVisible });
        savedWidgetConfig = widgetConfig.map((w) => ({ ...w }));
        followsDefault = false;
        rememberLayoutHint(widgetConfig, dashboardQuery(widgetConfig));
        await reloadIfQueryChanged(previousQuery);
        rebuildDashboard(widgetConfig);
        // A section switched on fetches what it shows (question, predictions,
        // expiring documents) - otherwise it would stay empty until reload.
        void loadTodayExtras();
      } catch {
        window.yuvomi?.showToast(t('common.errorGeneric'), 'danger');
      }
    });
    return layoutWrites;
  }

  /* „ZURÜCKSETZEN" IST DER RÜCKWEG ZUR VORGABE (#827), durch LÖSCHEN des
   * eigenen Standes, nicht durch Hineinladen der Vorgabe - sonst friert die
   * heutige Vorgabe auf dem Konto ein. Seit Tafla aus „Dostosuj Dziś" heraus. */
  async function resetDashboardConfig() {
    const confirmed = await confirmModal(t('dashboard.customizeResetConfirm'), {
      confirmLabel: t('dashboard.customizeReset'),
      detail: t('dashboard.customizeResetDetail'),
    });
    if (!confirmed) return;
    const previousConfig = savedWidgetConfig.map((w) => ({ ...w }));
    const previousGlance = savedGlanceVisible;
    const previousQuery = dashboardQuery(savedWidgetConfig);
    try {
      const res = await api.put('/preferences', { dashboard_widgets: null, dashboard_today_glance: null });
      widgetConfig = childDefaultFor(
        normalizeDashboardConfigWithExtensions(res.data?.dashboard_widgets ?? buildDefaultWidgetConfig()),
        user,
        true,
      );
      glanceVisible = res.data?.dashboard_today_glance !== false;
    } catch {
      window.yuvomi?.showToast(t('common.errorGeneric'), 'danger');
      return;
    }
    savedWidgetConfig = widgetConfig.map((w) => ({ ...w }));
    savedGlanceVisible = glanceVisible;
    followsDefault = true;
    rememberLayoutHint(widgetConfig, dashboardQuery(widgetConfig));
    // Die Vorgabe kann andere Filter tragen als mein geloeschter Stand (#814).
    await reloadIfQueryChanged(previousQuery);
    rebuildDashboard(widgetConfig);
    // Ein Zurücksetzen ist so umkehrbar wie jedes andere Speichern (#821):
    // der vorherige eigene Stand wird zurückgeschrieben, nicht nachgebaut.
    window.yuvomi?.showToast(t('dashboard.customizeResetDone'), 'success', 6000, async () => {
      const queryBeforeUndo = dashboardQuery(widgetConfig);
      try {
        widgetConfig = previousConfig.map((w) => ({ ...w }));
        glanceVisible = previousGlance;
        await api.put('/preferences', { dashboard_widgets: widgetConfig, dashboard_today_glance: glanceVisible });
        savedWidgetConfig = widgetConfig.map((w) => ({ ...w }));
        savedGlanceVisible = glanceVisible;
        followsDefault = false;
        rememberLayoutHint(widgetConfig, dashboardQuery(widgetConfig));
        await reloadIfQueryChanged(queryBeforeUndo);
      } catch {
        window.yuvomi?.showToast(t('common.errorGeneric'), 'danger');
      }
      rebuildDashboard(widgetConfig);
    });
  }

  /* DIE VORGABE DES HAUSHALTS (#827) entsteht dort, wo man Dziś ohnehin
   * einrichtet. WER DER VORGABE FOLGT, HÄNGT SICH MIT DEM VERÖFFENTLICHEN NICHT
   * AB: für ihn wird nichts Persönliches geschrieben. */
  async function publishHouseholdDefault() {
    const confirmed = await confirmModal(t('dashboard.customizeSetDefaultConfirm'), {
      confirmLabel: t('dashboard.customizeSetDefault'),
      detail: t('dashboard.customizeSetDefaultDetail'),
    });
    if (!confirmed) return;
    const previousQuery = dashboardQuery(savedWidgetConfig);
    const payload = {
      dashboard_widgets_default: widgetConfig,
      dashboard_today_glance_default: glanceVisible,
    };
    if (!followsDefault) {
      payload.dashboard_widgets = widgetConfig;
      payload.dashboard_today_glance = glanceVisible;
    }
    try {
      await api.put('/preferences', payload);
    } catch {
      window.yuvomi?.showToast(t('common.errorGeneric'), 'danger');
      return;
    }
    savedWidgetConfig = widgetConfig.map((w) => ({ ...w }));
    savedGlanceVisible = glanceVisible;
    householdDefaultPublished = true;
    rememberLayoutHint(widgetConfig, dashboardQuery(widgetConfig));
    await reloadIfQueryChanged(previousQuery);
    rebuildDashboard(widgetConfig);
    window.yuvomi?.showToast(t('dashboard.customizeSetDefaultDone'), 'success');
  }

  // --------------------------------------------------------
  // Dziś (Tafla, 2026-10-19)
  // --------------------------------------------------------

  /* WHAT A REBUILD KEEPS: the open "Wcześniej" row, the extras that arrive
   * after the first paint (question of the week, "Pewnie się kończy",
   * expiring documents) and the rows that are being ticked right now. */
  const todayUi = {
    earlierOpen: false,
    question: null,
    questionSettled: null,
    predictions: [],
    documents: [],
    busy: new Set(),
  };
  let todayState = null;
  let todayFocus = null;
  const onDisplay = user?.access_scope === 'display';
  const moduleOff = (module) => Boolean(window.yuvomi?.isModuleDisabled(module)) || moduleAccess(module) === 'none';
  // The adults of the household: members without the child role. Display
  // accounts, staff and guests are no members at all (householdMemberSql).
  const todayAdults = () => (Array.isArray(data?.users) ? data.users : []).filter((u) => u.family_role !== 'child');

  /** Can this viewer have this section or extra at all? */
  function todayAvailable(id) {
    if (id === 'today-weather') return weatherAvailable;
    if (id === 'today-shopping') return !moduleOff('shopping');
    if (id === 'today-question') return !onDisplay;
    if (id === 'today-tomorrow' || id === 'today-soon') return true;
    // THE FAMILY CARD ONLY WHERE IT SAYS SOMETHING (owner, 2026-10-19): with
    // two adults the discs in the plan already say who does what.
    if (id === 'family') return todayAdults().length > 2 && isWidgetModuleEnabled('family');
    if (TODAY_EXTRA_IDS.includes(id) || isExtensionWidget(id)) return isWidgetModuleEnabled(id);
    return false;
  }

  /* EXTRAS FOLLOW WHAT SOMEBODY ARRANGED. A layout this person saved, or one an
   * admin published for the household, keeps its widgets as preview tiles - so
   * nobody loses what they set up. Following the built-in default, Dziś starts
   * as Tafla does: the plan and its sections, no tiles. */
  const extrasFromLayout = () => !followsDefault || householdDefaultPublished;

  function todayEntries(cfg) {
    return cfg.filter((w) => (TODAY_SECTION_IDS.includes(w.id) || TODAY_EXTRA_IDS.includes(w.id) || isExtensionWidget(w.id))
      && todayAvailable(w.id));
  }

  function todayVisible(w) {
    if (TODAY_SECTION_IDS.includes(w.id)) return w.visible !== false;
    return extrasFromLayout() && w.visible !== false;
  }

  function todaySectionLabel(id) {
    const labels = {
      'today-shopping': 'today.shoppingTitle',
      'today-tomorrow': 'today.tomorrow',
      'today-question': 'today.questionTitle',
      'today-soon': 'today.soonTitle',
      pantry: 'nav.pantry',
    };
    return labels[id] ? t(labels[id]) : widgetLabel(id);
  }

  /** The preview tile of an extra, or null when it has nothing to say. */
  function todayTile(id) {
    if (id === 'pantry') {
      const slice = data?.pantryExpiring;
      const total = Number(slice?.total) || 0;
      if (!total) return null;
      return {
        id, route: '/pantry?filter=soon', icon: MODULE_ICON.pantry, label: t('nav.pantry'),
        value: t('today.pantryExpiring', { count: total }),
        note: (slice.items ?? []).slice(0, 2).map((item) => item.name).join(', '),
      };
    }
    // The plan already lists the doses and the waiting approvals - their tiles
    // speak only for what the plan does not say (a refill, a points goal).
    return metricTileFor(id, data, currency, new Set(['doses', 'approvals']));
  }

  function todayFamily() {
    const counts = new Map((data?.memberTodayTasks ?? []).map((m) => [m.user_id, Number(m.open_count) || 0]));
    return todayAdults().filter((u) => u.id !== user?.id).map((u) => ({ ...u, open: counts.get(u.id) ?? 0 }));
  }

  const canCheckToday = (row) => {
    if (onDisplay) return false;
    if (row.kind === 'task') return moduleAccess('tasks') === 'write';
    if (row.kind === 'dose') return moduleAccess('health') === 'write';
    return false;
  };

  function buildTodayState() {
    const ctx = planContext({ now: new Date(), viewer: user, users: data?.users ?? [], moduleOff, mealLabel: mealTypeLabel });
    const { plan, now } = buildDay(data, ctx, { timer: readWallTimer() });
    const closed = now.mode !== 'timer' && dayClosed(plan);
    const tomorrow = buildTomorrow(data, ctx);
    const soon = buildSoon(data, ctx, { documents: todayUi.documents });
    const entries = todayEntries(widgetConfig);
    const sections = entries.filter((w) => w.id !== 'today-weather' && todayVisible(w)).map((w) => w.id);
    const tiles = new Map();
    for (const id of sections) {
      if (!TODAY_EXTRA_IDS.includes(id) || id === 'family') continue;
      const tile = todayTile(id);
      if (tile) tiles.set(id, tile);
    }
    const shopping = moduleOff('shopping') ? null : {
      count: Number(data?.shoppingOpenCount) || 0,
      lists: Number(data?.shoppingOpenLists) || 0,
      predictions: todayUi.predictions.slice(0, 3),
      route: shoppingSoleListRoute(data),
    };
    const firstRun = !plan.hasAnything && !tomorrow.total && !soon.length
      && !(Number(data?.openTaskCount) > 0) && !(Number(data?.shoppingOpenCount) > 0)
      && !(data?.upcomingEvents?.length) && !(data?.todayMeals?.length);
    return {
      user, ctx, weather,
      showWeather: entries.some((w) => w.id === 'today-weather' && todayVisible(w)),
      plan, now, closed, tomorrow, soon, shopping,
      question: todayUi.questionSettled ? { settled: todayUi.questionSettled } : todayUi.question,
      sections,
      tiles,
      extensions: new Map(entries.filter((w) => isExtensionWidget(w.id)).map((w) => [w.id, widgetLabel(w.id)])),
      family: sections.includes('family') ? todayFamily() : [],
      earlierOpen: todayUi.earlierOpen,
      firstRun,
      canCustomize: !onDisplay,
      canCheck: canCheckToday,
      canWriteShopping: navModuleAccess('shopping') === 'write',
    };
  }

  /** What changes by the clock alone: rows over, the Teraz card and its minutes. */
  function todayClockStamp() {
    const state = buildTodayState();
    return JSON.stringify([
      state.plan.open.map((row) => row.key), state.plan.earlier.length, state.closed,
      state.now?.mode, state.now?.minutes ?? null, state.ctx.todayKey,
    ]);
  }

  let timerTick = null;
  signal.addEventListener('abort', () => clearInterval(timerTick), { once: true });
  function syncTimerTick() {
    const running = todayState?.now?.mode === 'timer' && todayState.now.timer.state === 'running';
    if (running && !timerTick) {
      timerTick = setInterval(() => {
        const timer = readWallTimer();
        if (timer.state !== 'running') {
          clearInterval(timerTick);
          timerTick = null;
          rebuildDashboard(widgetConfig);
          return;
        }
        updateTimerText(container.querySelector('[data-today]'), timer);
      }, 1000);
    } else if (!running && timerTick) {
      clearInterval(timerTick);
      timerTick = null;
    }
  }

  function renderToday(shell) {
    todayState = buildTodayState();
    const fromSkeleton = Boolean(shell.querySelector('.day-skeleton'))
      && !document.documentElement.classList.contains('page-swapping');
    const { key: keepFocus } = captureRebuildFocus(shell, document.activeElement, document.body);
    swapContent(shell, () => setHtml(shell, renderTodayPage(todayState)), { animate: fromSkeleton });
    if (window.lucide) window.lucide.createIcons({ el: shell });
    wireRecipeThumbs(shell);
    wireToday(shell.querySelector('[data-today]'));
    void mountExtensionWidgets(shell, widgetConfig, user);
    restoreFocusAfterRebuild(container, [keepFocus, ...(todayFocus ?? [])]);
    todayFocus = null;
    // Nach dem Ausstieg aus der Wand (R20): der Fokus geht an den Weg, der sie
    // wieder oeffnet - „Dostosuj Dziś". Eigener Aufruf, weil ein gemerkter
    // Fokus von davor dieses Ziel nicht verdraengen darf.
    if (takeWallFocusIntent('leave')) restoreFocusAfterRebuild(container, ['[data-day-action="customize"]']);
    syncTimerTick();
  }

  function todayRowByKey(key) {
    if (!todayState || !key) return null;
    return todayState.plan.all.find((row) => row.key === key)
      ?? todayState.tomorrow.rows.find((row) => row.key === key)
      ?? null;
  }

  /* TICKING A ROW (spec "Kółko odhaczania"): the circle fills and the title
   * dims at once, the server is asked, and after a short hold the row folds
   * into "Wcześniej" - with a toast and "Cofnij". A failure puts the row back
   * the way it was. */
  async function commitTodayRow(row, doing) {
    if (row.kind === 'task') {
      const task = row.task;
      const before = { status: task.status, completed_at: task.completed_at };
      await api.patch(`/tasks/${task.id}/status`, { status: doing ? 'done' : 'open' });
      task.status = doing ? 'done' : 'open';
      task.completed_at = doing ? new Date().toISOString() : null;
      return async () => {
        await api.patch(`/tasks/${task.id}/status`, { status: before.status === 'done' ? 'done' : 'open' });
        Object.assign(task, before);
      };
    }
    if (row.kind === 'dose') {
      const dose = row.dose;
      const before = { status: dose.status, taken_at: dose.taken_at };
      if (doing) {
        const res = dose.log_id
          ? await api.post(`/health/logs/${dose.log_id}/take`, {})
          : await api.post(`/health/medications/${dose.medication_id}/logs`, {
            schedule_id: dose.schedule_id,
            scheduled_at: `${todayState.ctx.todayKey}T${dose.time}`,
            status: 'taken',
          });
        dose.log_id = res?.data?.id ?? dose.log_id;
        dose.status = 'taken';
        dose.taken_at = res?.data?.taken_at ?? null;
      } else {
        await api.patch(`/health/logs/${dose.log_id}`, { status: 'pending' });
        dose.status = 'pending';
        dose.taken_at = null;
      }
      return async () => {
        await api.patch(`/health/logs/${dose.log_id}`, { status: before.status });
        Object.assign(dose, before);
      };
    }
    throw new Error('not checkable');
  }

  function markRowChecked(button, checked) {
    const li = button.closest('.day-row');
    button.classList.toggle('day-check--done', checked);
    button.classList.toggle('check-ring--done', checked);
    button.setAttribute('aria-pressed', checked ? 'true' : 'false');
    li?.classList.toggle('day-row--done', checked);
    li?.classList.toggle('day-row--ticking', checked);
  }

  async function toggleTodayRow(row, button) {
    if (!row?.checkable || todayUi.busy.has(row.key) || !canCheckToday(row)) return;
    todayUi.busy.add(row.key);
    const doing = !row.done;
    // Keyboard users go on to the next row's circle once this one has folded.
    if (document.activeElement === button) {
      const rows = [...container.querySelectorAll('[data-today] .day-check:not([disabled])')];
      const next = rows[rows.indexOf(button) + 1];
      todayFocus = next ? [`[data-day-action="check"][data-row-key="${CSS.escape(next.dataset.rowKey)}"]`] : null;
    }
    markRowChecked(button, doing);
    const hold = doing && !prefersReducedMotion() ? new Promise((resolve) => setTimeout(resolve, 820)) : null;
    let undo;
    try {
      undo = await commitTodayRow(row, doing);
      await hold;
    } catch (err) {
      markRowChecked(button, !doing);
      todayUi.busy.delete(row.key);
      todayFocus = null;
      window.yuvomi?.showToast(err?.status === 403 ? t('today.notAllowed') : t('common.errorGeneric'), 'danger');
      return;
    }
    todayUi.busy.delete(row.key);
    if (signal.aborted) return;
    rebuildDashboard(widgetConfig);
    const message = !doing
      ? t('today.toastReopened', { title: row.title })
      : t(row.kind === 'dose' ? 'today.toastTaken' : 'today.toastDone', { title: row.title });
    window.yuvomi?.showToast(message, 'default', 5000, async () => {
      try {
        await undo();
        if (!signal.aborted) rebuildDashboard(widgetConfig);
        void refreshDashboardData();
      } catch {
        window.yuvomi?.showToast(t('common.errorGeneric'), 'danger');
      }
    });
    void refreshDashboardData();
  }

  /** "Dopisz": the missing ingredients of tonight's dinner onto the first list. */
  async function addMissingToShopping(button) {
    const dinnerPlan = data?.dinnerPlan;
    const missing = [...(dinnerPlan?.missing ?? [])];
    if (!missing.length) return;
    button.disabled = true;
    try {
      const lists = (await api.get('/shopping'))?.data ?? [];
      const list = lists[0];
      if (!list) {
        button.disabled = false;
        window.yuvomi?.showToast(t('today.noShoppingList'), 'danger');
        return;
      }
      const added = [];
      for (const name of missing) {
        const res = await api.post(`/shopping/${list.id}/items`, { name, category_source: 'default' });
        if (res?.data?.id != null) added.push(res.data.id);
      }
      dinnerPlan.on_list = [...(dinnerPlan.on_list ?? []), ...missing];
      dinnerPlan.missing = [];
      data.shoppingOpenCount = (Number(data.shoppingOpenCount) || 0) + added.length;
      rebuildDashboard(widgetConfig);
      window.yuvomi?.showToast(t('today.addedToast', { n: added.length }), 'default', 5000, async () => {
        try {
          await Promise.all(added.map((id) => api.delete(`/shopping/items/${id}`)));
          dinnerPlan.missing = missing;
          dinnerPlan.on_list = (dinnerPlan.on_list ?? []).filter((name) => !missing.includes(name));
          data.shoppingOpenCount = Math.max(0, (Number(data.shoppingOpenCount) || 0) - added.length);
          if (!signal.aborted) rebuildDashboard(widgetConfig);
        } catch {
          window.yuvomi?.showToast(t('common.errorGeneric'), 'danger');
        }
      });
    } catch {
      button.disabled = false;
      window.yuvomi?.showToast(t('common.errorGeneric'), 'danger');
    }
  }

  async function answerTodayQuestion(button) {
    const question = todayUi.question;
    if (!question) return;
    const skip = button.dataset.dayAction === 'skip-question';
    const card = button.closest('.day-question');
    card?.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      if (skip) await skipQuestion(api, question);
      else todayUi.questionSettled = await answerQuestion(api, question, Number(button.dataset.option));
      todayUi.question = null;
      rebuildDashboard(widgetConfig);
      if (todayUi.questionSettled) {
        // The line naming what changed stays three seconds, fades, then goes.
        setTimeout(() => container.querySelector('.day-question--settled')?.classList.add('day-question--leaving'), 2750);
        setTimeout(() => {
          todayUi.questionSettled = null;
          if (!signal.aborted) rebuildDashboard(widgetConfig);
        }, 3000);
      }
    } catch {
      card?.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      window.yuvomi?.showToast(t('common.errorGeneric'), 'danger');
    }
  }

  function enterWallFromToday() {
    enterWallMode();
    _wallFocusIntent = 'enter';
    // EIN KNOPF OHNE WORT SCHALTET DIE GANZE SHELL AB (#1559): eine Zeile sagt,
    // was das ist und wie man herauskommt.
    window.yuvomi?.showToast(t('dashboard.wallEntered', {
      action: t('dashboard.wallExit'),
    }), 'default', 8000);
    rerender();
  }

  /** Applies the sheet's order and switches to the layout (positions of the rest stay). */
  function applyTodayLayout(cfg, order, visible) {
    const next = cfg.map((w) => (Object.hasOwn(visible, w.id) ? { ...w, visible: Boolean(visible[w.id]) } : { ...w }));
    const slots = next.map((w, i) => (order.includes(w.id) ? i : -1)).filter((i) => i >= 0);
    const moved = order.map((id) => next.find((w) => w.id === id)).filter(Boolean);
    slots.forEach((slot, i) => { if (moved[i]) next[slot] = moved[i]; });
    return next.map((w, i) => ({ ...w, order: i }));
  }

  /* THE FILTERS STAY REACHABLE (#814). A category choice of the task widget or
   * "only mine" of the calendar widget narrows the whole /dashboard answer -
   * and so the plan. The old widget menus are gone with the board; the sheet
   * opens the same option dialogs, so a saved filter never hides rows without
   * a way to see and change it. */
  async function editTodayFilter(id) {
    await closeModal({ force: true });
    const current = widgetConfig.find((w) => w.id === id)?.options ?? {};
    const next = await openWidgetOptions(id, current);
    if (next === null) return;
    // Ein leeres Optionsobjekt wird zu „keine Optionen" (#814).
    await persistTodayLayout(updateWidgetConfig(widgetConfig, id,
      Object.keys(next).length ? { options: next } : { options: undefined }));
  }

  function openTodayCustomizeSheet() {
    const entries = todayEntries(widgetConfig);
    const weatherEntry = entries.find((w) => w.id === 'today-weather');
    openTodayCustomize({
      sections: entries.filter((w) => w.id !== 'today-weather').map((w) => ({
        id: w.id,
        label: todaySectionLabel(w.id),
        visible: todayVisible(w),
        note: w.id === 'today-question' ? t('today.questionNote') : '',
      })),
      weather: weatherEntry ? { visible: todayVisible(weatherEntry) } : null,
      onChange: ({ order, visible }) => {
        // Following the built-in default, every extra the sheet showed as off
        // is written off - the first own layout must not wake old widgets.
        const shown = Object.fromEntries(entries.map((w) => [w.id, Object.hasOwn(visible, w.id) ? visible[w.id] : todayVisible(w)]));
        void persistTodayLayout(applyTodayLayout(widgetConfig, order, shown));
      },
      actions: {
        canPublish,
        followsDefault,
        onPublish: async () => { await closeModal({ force: true }); await publishHouseholdDefault(); },
        onReset: async () => { await closeModal({ force: true }); await resetDashboardConfig(); },
        onWall: onDisplay ? null : enterWallFromToday,
        filters: ['tasks', 'calendar'].filter((id) => !moduleOff(MODULE_FOR_WIDGET[id])),
        onFilter: editTodayFilter,
      },
    });
  }

  async function handleTodayAction(el) {
    const action = el.dataset.dayAction;
    if (action === 'earlier') {
      const open = el.getAttribute('aria-expanded') !== 'true';
      const region = container.querySelector(`#${el.getAttribute('aria-controls')}`);
      toggleRegion(region, open);
      el.setAttribute('aria-expanded', open ? 'true' : 'false');
      todayUi.earlierOpen = open;
      return;
    }
    if (action === 'check') {
      await toggleTodayRow(todayRowByKey(el.dataset.rowKey), el);
      return;
    }
    if (action === 'open') {
      const row = todayRowByKey(el.dataset.rowKey);
      if (row?.kind === 'task') openTaskFromOverview(row.id, container, () => refreshDashboardData(), user);
      return;
    }
    if (action === 'open-task') {
      openTaskFromOverview(el.dataset.taskId, container, () => refreshDashboardData(), user);
      return;
    }
    if (action === 'cook') {
      const meal = todayState?.now?.meal;
      if (!meal) return;
      openCookForMeal({ mealId: meal.id, recipeId: meal.recipe_id, date: meal.date })
        .catch(() => window.yuvomi?.showToast(t('common.errorGeneric'), 'danger'));
      return;
    }
    if (action === 'add-missing') { await addMissingToShopping(el); return; }
    if (action === 'timer-stop') { clearWallTimer(); rebuildDashboard(widgetConfig); return; }
    if (action === 'answer' || action === 'skip-question') { await answerTodayQuestion(el); return; }
    if (action === 'customize') openTodayCustomizeSheet();
  }

  function wireToday(root) {
    if (!root) return;
    root.addEventListener('click', (event) => {
      // The error tile of an extension widget (renderWidgetError): try again.
      const retry = event.target.closest?.('[data-widget-retry]');
      if (retry && root.contains(retry)) {
        void mountExtensionWidgets(container.querySelector('#dashboard-shell') ?? root, widgetConfig, user);
        return;
      }
      const actionEl = event.target.closest?.('[data-day-action]');
      if (actionEl && root.contains(actionEl)) {
        if (actionEl.tagName === 'A') event.preventDefault();
        void handleTodayAction(actionEl);
        return;
      }
      const link = event.target.closest?.('a[data-route]');
      if (!link || !root.contains(link)) return;
      // Der Browser behaelt seinen Klick: Cmd-, Mittel- und Shift-Klick oeffnen
      // den Link, wie an jedem <a href> der App.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      window.yuvomi?.navigate(link.dataset.route);
    }, { signal });
  }

  /** The extras that may come later than the page: they never hold up the plan. */
  async function loadTodayExtras() {
    if (wallMode || loadFailed) return;
    const visible = new Set(todayEntries(widgetConfig).filter(todayVisible).map((w) => w.id));
    const jobs = [];
    if (visible.has('today-question')) {
      jobs.push(fetchOpenQuestion(api).then((question) => { todayUi.question = question; }));
    }
    if (visible.has('today-shopping')) {
      jobs.push(api.get('/shopping/predictions')
        .then((res) => { todayUi.predictions = (Array.isArray(res?.data) ? res.data : []).map((p) => p.name).filter(Boolean); })
        .catch(() => {}));
    }
    if (visible.has('today-soon') && !moduleOff('documents')) {
      jobs.push(api.get('/documents?expiring=30')
        .then((res) => { todayUi.documents = Array.isArray(res?.data) ? res.data : []; })
        .catch(() => {}));
    }
    if (!jobs.length) return;
    await Promise.all(jobs);
    if (!signal.aborted) rebuildDashboard(widgetConfig);
  }

  // --------------------------------------------------------
  // Die Wand (Tafla, 2026-10-19)
  // --------------------------------------------------------

  function wallOptions() {
    return {
      sections: wallUi.sections,
      mayWrite: wallUi.mayWrite,
      isDisplay: wallUi.isDisplay,
      predictions: wallUi.predictions,
      question: wallUi.question,
      tickers: wallUi.tickers,
      questionSettled: wallUi.questionSettled,
    };
  }

  /** The model the wall shows right now - for the minute stamp and the taps. */
  function wallModel() {
    return buildWall(loadFailed ? null : data, {
      ...wallOptions(), timer: readWallTimer(), lastLoadedAt, moduleOff: wallModuleOff, mealLabel: mealTypeLabel,
    });
  }

  /* THE EXTRAS COME AFTER THE FIRST PAINT and never hold the wall up: what is
   * running out (only with the shopping card), the weekly question (only on
   * a Sunday evening, only where the wall may answer) and, on the display,
   * the people it may tick for - an empty list means no rings. */
  async function loadWallExtras() {
    if (!wallMode || loadFailed) return;
    const sections = wallUi.sections ?? {};
    const jobs = [];
    if (sections.shopping !== false && !wallModuleOff('shopping')) {
      jobs.push(api.get('/shopping/predictions')
        .then((res) => { wallUi.predictions = (Array.isArray(res?.data) ? res.data : []).map((p) => p.name).filter(Boolean); })
        .catch(() => {}));
    }
    const day = zonedDateKey(new Date());
    const sunday = day && new Date(`${day}T12:00:00Z`).getUTCDay() === 0;
    if (sunday && (!wallUi.isDisplay || wallUi.mayWrite)) {
      jobs.push(fetchOpenQuestion(api).then((question) => { wallUi.question = question; }));
    }
    if (wallUi.isDisplay && wallUi.mayWrite) {
      jobs.push(api.get('/displays/people')
        .then((res) => { wallUi.tickers = (Array.isArray(res?.data) ? res.data : []).filter((p) => p.can_tick_off); })
        .catch(() => { wallUi.tickers = []; }));
    } else {
      wallUi.tickers = null;
    }
    if (!jobs.length) return;
    await Promise.all(jobs);
    if (!signal.aborted) rebuildDashboard(widgetConfig);
  }

  /** "Kto to zrobił?" on the display: a dialog with one big button per person. */
  function chooseWallDoer(title, people) {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'wall-pick';
      dialog.setAttribute('aria-labelledby', 'wall-pick-title');
      dialog.insertAdjacentHTML('beforeend', renderWhoChooser(title, people, data?.users ?? []));
      let chosen = null;
      dialog.addEventListener('click', (event) => {
        const person = event.target.closest?.('[data-wall-pick]');
        if (person) chosen = Number(person.dataset.wallWho);
        if (person || event.target.closest?.('[data-wall-pick-cancel]') || event.target === dialog) dialog.close();
      });
      dialog.addEventListener('close', () => { dialog.remove(); resolve(chosen); }, { once: true });
      signal.addEventListener('abort', () => { if (dialog.open) dialog.close(); }, { once: true });
      document.body.append(dialog);
      dialog.showModal();
      if (window.lucide) window.lucide.createIcons({ el: dialog });
      dialog.querySelector('[data-wall-pick]')?.focus();
    });
  }

  function wallWriteError(err) {
    const readOnly = err?.status === 403 && err?.data?.reason === 'wall_read_only';
    window.yuvomi?.showToast(readOnly ? t('wall.readOnly') : t('common.errorGeneric'), 'danger');
    if (readOnly) wallUi.mayWrite = false;
  }

  const wallActions = {
    /* A RING ON THE WALL (switch on): the display names who did it - the one
     * assignee it may tick for, else a chooser; a person's own wall ticks as
     * that person, like Dziś. The row folds away with the next refresh. */
    async tick(key, button) {
      if (wallUi.busy.has(key)) return;
      const row = wallModel().plan?.rows.find((r) => r.key === key);
      if (!row?.checkable) return;
      let doneBy = null;
      if (wallUi.isDisplay) {
        const tickers = wallUi.tickers ?? [];
        const own = tickers.filter((p) => row.people.some((person) => person.id === p.id));
        doneBy = own.length === 1 ? own[0].id : await chooseWallDoer(row.title, own.length ? own : tickers);
        if (doneBy == null) return;
      }
      wallUi.busy.add(key);
      button.classList.add('wall-ring--done');
      button.setAttribute('aria-pressed', 'true');
      try {
        await api.patch(`/tasks/${row.id}/status`, doneBy == null ? { status: 'done' } : { status: 'done', done_by_user_id: doneBy });
        const person = doneBy == null ? null : (wallUi.tickers ?? []).find((p) => p.id === doneBy);
        window.yuvomi?.showToast(person
          ? t('tasks.doneByToast', { name: person.display_name })
          : t('today.toastDone', { title: row.title }), 'default', 4000);
        if (!prefersReducedMotion()) await new Promise((resolve) => { setTimeout(resolve, 820); });
      } catch (err) {
        button.classList.remove('wall-ring--done');
        button.removeAttribute('aria-pressed');
        wallWriteError(err);
      } finally {
        wallUi.busy.delete(key);
      }
      await refreshDashboardData();
    },

    /** "+ masło": a running-out item onto the first list. */
    async add(name, button) {
      if (!name || button.disabled) return;
      button.disabled = true;
      try {
        let listId = wallModel().shopping?.listId ?? null;
        if (listId == null) listId = ((await api.get('/shopping'))?.data ?? [])[0]?.id ?? null;
        if (listId == null) {
          window.yuvomi?.showToast(t('today.noShoppingList'), 'danger');
          button.disabled = false;
          return;
        }
        await api.post(`/shopping/${listId}/items`, { name, category_source: 'default' });
        wallUi.predictions = wallUi.predictions.filter((item) => item !== name);
        data.shoppingOpenCount = (Number(data.shoppingOpenCount) || 0) + 1;
        rebuildDashboard(widgetConfig);
        window.yuvomi?.showToast(t('today.addedToast', { n: 1 }), 'default', 4000);
        void refreshDashboardData();
      } catch (err) {
        button.disabled = false;
        wallWriteError(err);
      }
    },

    async answer(index) {
      const question = wallUi.question;
      if (!question) return;
      try {
        wallUi.questionSettled = await answerQuestion(api, question, index);
        wallUi.question = null;
        rebuildDashboard(widgetConfig);
        setTimeout(() => {
          wallUi.questionSettled = null;
          if (!signal.aborted) rebuildDashboard(widgetConfig);
        }, 3000);
      } catch (err) {
        wallWriteError(err);
      }
    },

    async skip() {
      const question = wallUi.question;
      if (!question) return;
      try {
        await skipQuestion(api, question);
        wallUi.question = null;
        rebuildDashboard(widgetConfig);
      } catch (err) {
        wallWriteError(err);
      }
    },
  };

  // Das Einpassen der Wand auf Aufbau und Fenstergroesse (Hoehenbudget).
  const wallFit = createWallFit(window, signal);
  function rebuildDashboard(cfg) {
    // Der eine Engpass fuer jeden verspaeteten Neuaufbau (#977): eine Antwort,
    // die nach dem Verlassen der Seite oder nach dem naechsten render()
    // eintrifft, darf die Flaeche nicht mehr anfassen - sonst ueberschreibt der
    // aeltere Stand den neueren.
    if (signal.aborted) return;
    const shell = container.querySelector('#dashboard-shell');
    if (!shell) return;
    if (wallMode) {
      rebuildWall(container, shell, {
        surface: renderWallSurface(data, weather, { failed: loadFailed, updatedAt: lastLoadedAt, screensaverEnabled, ...wallOptions() }),
        rerender: () => rebuildDashboard(widgetConfig),
        signal,
        fit: wallFit,
        actions: wallActions,
      });
      return;
    }
    if (loadFailed) {
      setHtml(shell, renderDashboardError(loadErrorStatus));
      if (window.lucide) window.lucide.createIcons({ el: shell });
      container.querySelector('#dashboard-retry')?.addEventListener('click', rerender, { signal: signal });
      return;
    }
    // Dziś liest die Anordnung aus `widgetConfig`; `cfg` bleibt das Argument
    // aller Aufrufer.
    void cfg;
    renderToday(shell);
  }

  rebuildDashboard(widgetConfig);

  if (wallMode || loadFailed) {
    // Kein FAB im Fehler-Zustand: seine Schnellaktionen würden in Module
    // navigieren, deren Daten gerade nicht geladen werden konnten — das würde
    // dem Fehler-Banner widersprechen. Retry stellt bei Erfolg alles her.
    // Dokumentweit, nicht im Container: die Gruppe kann zu diesem Zeitpunkt
    // schon in der Shell-Layer hängen (adoptPageFab, #634). Das Backdrop reist
    // als ihr Kind mit und braucht keine zweite Zeile.
    //
    // Und keiner im Wand-Modus: eine Anlege-Affordance in einer reinen Anzeige
    // waere ein Versprechen, das die Flaeche nicht einloest. Er wird dort gar
    // nicht erst gerendert; diese Zeile raeumt nur einen mit, den die Vorseite
    // in der Shell-Layer zurueckgelassen haben koennte. Bewusst hier und nicht
    // per CSS: eine Regel, die `.page-fab` auf `opacity: 0` oder
    // `pointer-events: none` setzt, ist seit #634 verboten (Guard in
    // test-frontend-audit.js).
    findPageFab('fab-main')?.remove();
  } else {
    initFab(signal);
    // Die Popover-Menues der Seite (Werkzeuge, Kachelgroesse) - bis Tafla
    // verdrahtete sie wireNewMenu() mit, das mit dem Speed-Dial entfallen ist.
    installPopoverMenus(container);
  }

  // SELBSTHEILUNG STATT RETRY-KNOPF. Am Wandtablet drueckt niemand auf
  // „erneut versuchen" - die Flaeche muss sich selbst wieder einfangen. Der
  // Takt ist kuerzer als der stille Refresh: 15 Minuten Fehlerbild waeren an
  // der Wand eine Viertelstunde Falschauskunft.
  if (wallMode && loadFailed) {
    const healTimerId = setTimeout(rerender, WALL_HEAL_MS);
    signal.addEventListener('abort', () => clearTimeout(healTimerId));
  }

  // Stiller Daten-Refresh (Paket 2, Critique P4): Inhaltsdaten veralteten sonst
  // in offenen Tabs - PRODUCT.md nennt Wandtablet und PWA-Dauernutzung als
  // Kernszene, dort zeigte „Heute wichtig" abends noch den Morgenstand. EIN
  // Pfad für beide Auslöser (Tab-Reaktivierung + 15-Min-Takt im sichtbaren
  // Tab), bewusst ohne Skeleton (das gehört dem Erstaufbau) und still bei
  // Fehlern, wie der Wetter-Timer. Dziś ruft ihn auch nach jedem Haken auf.
  let refreshInFlight = false;
  async function refreshDashboardData() {
    if (loadFailed || refreshInFlight) return;
    refreshInFlight = true;
    try {
      const fresh = await api.get(overviewRequest(dashboardQuery(widgetConfig)));
      if (signal.aborted) return;
      localizeEventLists(fresh);
      fresh.pendingReminders = await loadPendingReminders(overviewRequest);
      if (signal.aborted) return;
      // Was gerade abgehakt wird, haelt seinen Stand: die Antwort kann vor
      // dem Haken abgeschickt worden sein.
      if (todayUi.busy.size || wallUi.busy.size) return;
      data = fresh;
      setCountdownAvailability(data?.countdowns);
      lastLoadedAt = new Date();
      rebuildDashboard(widgetConfig);
    } catch { /* Hintergrund-Refresh: bewusst still */ }
    finally { refreshInFlight = false; }
  }
  // Die Wand wird angesehen, nicht bedient: sie holt alle fuenf Minuten nach
  // (und sagt „dane sprzed N min", wenn das scheitert), Dziś alle fuenfzehn.
  const refreshTimerId = setInterval(() => {
    if (document.hidden) return;
    refreshDashboardData();
    if (wallMode) void loadWallExtras();
  }, wallMode ? WALL_REFRESH_MS : 15 * 60 * 1000);
  signal.addEventListener('abort', () => clearInterval(refreshTimerId));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // Hintergrund-Tabs bekommen gedrosselte Timer: die Uhr könnte beim
    // Zurückkehren Minuten nachhängen und muss sofort nachziehen (#651).
    // Datum und Teraz zeichnet der Neuaufbau nach dem Refresh neu.
    updateWallClock(container);
    refreshDashboardData();
  }, { signal: signal });

  // Der Minutentakt der Uhr traegt die Nachtabsenkung mit: um 22:00 und um
  // 06:00 muss die Flaeche umschalten, wenn es so weit ist - nicht erst beim
  // naechsten Laden. Ein zweiter Timer nur dafuer waere ein zweiter Takt fuer
  // dieselbe Minute.
  //
  // Derselbe Takt traegt die Grenzen des Tages (#1449): endet ein Termin, wird
  // eine Dosis faellig oder ist die Tonne mittags abgeholt, aendert sich das
  // Blatt - ohne Neuladen. Gebaut wird nur, wenn sich der Stand WIRKLICH
  // geaendert hat. Auf Dziś zaehlt dazu die Minute der Teraz-Karte („Kolacja
  // za 19 min"), an der Wand der Fingerabdruck des Blatts.
  const dayStamp = () => (wallMode ? wallFingerprint(wallModel()) : todayClockStamp());
  let dayFingerprint = loadFailed ? '' : dayStamp();
  const followDayBoundaries = () => {
    if (loadFailed || todayUi.busy.size || wallUi.busy.size) return;
    const next = dayStamp();
    if (next === dayFingerprint) return;
    dayFingerprint = next;
    rebuildDashboard(widgetConfig);
  };
  startClockTicker(container, signal, () => {
    if (wallMode) {
      syncWallMode(location.pathname);
      updateWallClock(container);
    }
    followDayBoundaries();
  });

  void loadTodayExtras();
  void loadWallExtras();

  // 30-Minuten Auto-Refresh für Wetter (inkl. optionaler Standort-Aktualisierung).
  // Anker ist der Datensatz, nicht der Karten-Button: seit dem Masthead-Umzug
  // kann Wetter sichtbar sein (Zeile), ohne dass die Karte samt Refresh-Button
  // im Raster steht - auch die Zeile darf nicht den ganzen Tag alt werden.
  // Eingerichtet reicht: eine Kachel, die gerade kein Wetter hat, soll es
  // nachholen, sobald der Anbieter wieder antwortet.
  if (weatherAvailable) {
    const doAutoRefresh = async () => {
      try {
        await maybeUpdateAutoLocation({
          autoLocateEnabled: weatherAutoLocate,
          geolocation: navigator.geolocation,
          putPreferences: (body) => api.put('/preferences', body),
        });
        const res = await api.get(`/weather?lang=${encodeURIComponent(getLocale())}`).catch(() => ({ data: null }));
        if (signal.aborted) return;
        weather = res.data ?? null;
        setWeatherAvailability(res, weatherPrefs);
        rebuildDashboard(widgetConfig);
      } catch { /* Hintergrund-Timer: bewusst still — der Nutzer hat nichts
                   angestoßen, ein Toast alle 30 Min wäre reiner Lärm. */ }
    };
    const timerId = setInterval(doAutoRefresh, 30 * 60 * 1000);
    signal.addEventListener('abort', () => clearInterval(timerId));
    if (weatherAutoLocate) doAutoRefresh();
  }

  // Weder Onboarding noch Anpassen-Hinweis im Wand-Modus: beide sprechen auf
  // Arm-Laenge ueber Bedienung, die es dort nicht gibt. Der Onboarding-Merker
  // bleibt bewusst ungesetzt - wer die Wand wieder verlaesst, bekommt seine
  // Einfuehrung dann, wenn sie ihm etwas nuetzt.
  if (wallMode) return;

  // Das Konto entscheidet (onboarding_pending aus /auth/me), nicht mehr allein
  // das Geraet - sonst zeigt ein neues Geraet oder ein privates Fenster den
  // Rundgang erneut, obwohl das Konto ihn schon gesehen hat. Der lokale
  // Schluessel bleibt eine ZUSAETZLICHE Bedingung statt zu entfallen: er ist
  // der Weg, mit dem Test-Faelle (document-guards-harness.js) den Dialog
  // gezielt unterdruecken, ohne einen Testnutzer am Server zu markieren.
  if (user?.onboarding_pending && !localStorage.getItem(ONBOARDING_KEY)) {
    setTimeout(() => showOnboarding(container), 400);
  }
}

/**
 * Die faelligen Erinnerungen fuer das Heute-Blatt (utils/today-sheet.js).
 *
 * Derselbe Endpunkt, den die Glocke pollt - er filtert Herkuenfte schon nach
 * Modulrecht und Token-Scope (`mayTouchOrigin`), das Blatt waehlt daraus nur
 * noch, welche Herkunft eine Zeile ist. Ein Fehler kostet die Zeilen, nicht
 * die Uebersicht: die Erinnerung spricht weiter ueber Toast und Glocke.
 *
 * `request` IST DIE EINE REGEL DER SEITE (`overviewRequest`): die Wand fragt
 * auch hier die Haushaltsfassung ab, und die ist leer - eine Erinnerung gilt
 * der Person, die um sie gebeten hat, nicht der Kueche (#1817).
 */
async function loadPendingReminders(request = (path) => path, get = (path) => fetchPendingReminders(path, { get: (p) => api.get(p) })) {
  try {
    const res = await get(request('/reminders/pending'));
    return Array.isArray(res?.data) ? res.data : [];
  } catch {
    return [];
  }
}

export const __test = { metricTileFor, loadPendingReminders, childDefaultFor, normalizeVisibleMealTypes, renderWallSurface, createWallFit, rebuildWall, updateWallClock, wireWallSurface, weatherAvailableFrom, openWidgetOptions, renderFab, focusKeyOf, captureRebuildFocus, restoreFocusAfterRebuild, shoppingSoleListRoute };
