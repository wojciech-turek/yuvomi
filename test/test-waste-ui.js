/**
 * Modul: Waste collection page (#1063 Phase 2)
 * Zweck: pure UI-logic exported from public/pages/waste.js via __test - the
 *        deep-link contract (?type=<id>&date=<YYYY-MM-DD>), the schedule
 *        origin lookup that backs move/skip/restore, and the recurrence
 *        summary / provenance badge text that make overlapping origins
 *        (invariant #3/#4) visible in the UI. Uses the shared minimal DOM
 *        stub + browser-path loader (same pattern as test-shopping-ux.js);
 *        the loader's /i18n.js stub echoes t('key', params) as
 *        "key" + JSON.stringify(params), so assertions check against that
 *        predictable shape rather than real translated text. Full modal
 *        open/save/dirty-close flows are covered by manual browser testing
 *        instead of here, since modal.js's dirty-close machinery is generic,
 *        shared, and already covered by its own tests - this repo has no
 *        jsdom dependency, and open/save/dirty-close flows need a real DOM.
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-waste-ui.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eachRule } from './css-rules.js';

global.HTMLElement = class HTMLElement {};
global.customElements = { define() {}, get() { return undefined; } };
global.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, yuvomi: {} };
global.document = {
  getElementById: () => null,
  createElement: () => Object.assign(new global.HTMLElement(), {
    style: {}, setAttribute() {}, appendChild() {}, addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
  }),
  addEventListener() {},
  documentElement: { lang: 'de' },
};

const { __test } = await import('../public/pages/waste.js');
const {
  findScheduleOrigin, parseDeepLinkParams, deepLinkSelectors, recurrenceSummary, originBadges,
  defaultLabelDecision, unresolvedBlockingDiagnostics, buildMappingDecisions, sourceHealthBadgeInfo,
  splitUpcomingByType, deepLinkNeedsExpand, nearestOrdinalAnchorDateKey,
  typeCardHtml, scheduleRowHtml, sourceRowHtml, TYPE_PRESETS,
  isOnboarding, onboardingHtml, sectionVisibility, fabIntent,
} = __test;

// Quelltext-Schnappschuss fuer die Zusicherungen weiter unten. Er steht VOR dem
// ersten test(): unter Node 22 beginnen registrierte Tests schon beim naechsten
// Top-Level-await zu laufen, und ein spaeter definiertes const liegt dann noch in
// der temporal dead zone (ReferenceError, nur in der 22er-CI).
const WASTE_SRC = readFileSync(new URL('../public/pages/waste.js', import.meta.url), 'utf8');
// Fuer die "das gibt es nicht mehr"-Zusagen: die Begruendungen im Quelltext
// NENNEN die abgeschafften Dinge ausdruecklich (`toolbar-new-btn`,
// `<input type="color">`), damit der naechste Leser weiss, warum sie fehlen.
// Ohne diesen Schnitt wuerde ausgerechnet die Erklaerung den Test ausloesen.
const WASTE_CODE = WASTE_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// -------------------------------------------------------------------------
// findScheduleOrigin - backs move/skip/restore
// -------------------------------------------------------------------------

test('findScheduleOrigin: returns the schedule id and original date for a schedule-origin occurrence', () => {
  const occurrences = [{
    key: '1:2026-01-05', date_key: '2026-01-05',
    origins: [{ kind: 'schedule', schedule_id: 10, original_date: null, moved: false }],
  }];
  const found = findScheduleOrigin('1:2026-01-05', occurrences);
  assert.equal(found.scheduleId, 10);
  assert.equal(found.originalDate, '2026-01-05', 'falls back to the occurrence date when original_date is null (unmoved)');
});

test('findScheduleOrigin: uses the recorded original_date for a moved occurrence', () => {
  const occurrences = [{
    key: '1:2026-01-14', date_key: '2026-01-14',
    origins: [{ kind: 'schedule', schedule_id: 10, original_date: '2026-01-12', moved: true }],
  }];
  const found = findScheduleOrigin('1:2026-01-14', occurrences);
  assert.equal(found.originalDate, '2026-01-12');
});

test('findScheduleOrigin: returns null for a one-off-only occurrence (nothing to move/skip)', () => {
  const occurrences = [{
    key: '1:2026-01-12', date_key: '2026-01-12',
    origins: [{ kind: 'one_off', one_off_id: 5, original_date: null, moved: false }],
  }];
  assert.equal(findScheduleOrigin('1:2026-01-12', occurrences), null);
});

test('findScheduleOrigin: returns null for an unknown key', () => {
  assert.equal(findScheduleOrigin('missing', []), null);
});

// -------------------------------------------------------------------------
// Deep-link contract: ?type=<id>&date=<YYYY-MM-DD>
// -------------------------------------------------------------------------

test('parseDeepLinkParams: reads a well-formed type + date', () => {
  assert.deepEqual(parseDeepLinkParams('?type=7&date=2026-03-01'), { typeId: 7, date: '2026-03-01' });
});

test('parseDeepLinkParams: type alone (no date) is valid', () => {
  assert.deepEqual(parseDeepLinkParams('?type=7'), { typeId: 7, date: null });
});

test('parseDeepLinkParams: no type at all yields typeId: null regardless of date', () => {
  assert.deepEqual(parseDeepLinkParams('?date=2026-03-01'), { typeId: null, date: '2026-03-01' });
  assert.deepEqual(parseDeepLinkParams(''), { typeId: null, date: null });
});

test('parseDeepLinkParams: rejects a malformed date instead of passing it through unescaped', () => {
  assert.deepEqual(parseDeepLinkParams('?type=7&date=not-a-date'), { typeId: 7, date: null });
  assert.deepEqual(parseDeepLinkParams('?type=7&date=2026-3-1'), { typeId: 7, date: null });
});

test('parseDeepLinkParams: rejects a non-positive or non-numeric type', () => {
  assert.deepEqual(parseDeepLinkParams('?type=0'), { typeId: null, date: null });
  assert.deepEqual(parseDeepLinkParams('?type=-1'), { typeId: null, date: null });
  assert.deepEqual(parseDeepLinkParams('?type=abc'), { typeId: null, date: null });
});

test('deepLinkSelectors: null when there is no type to link to', () => {
  assert.equal(deepLinkSelectors({ typeId: null, date: null }), null);
});

test('deepLinkSelectors: a type + date targets the occurrence row, with a card fallback', () => {
  const selectors = deepLinkSelectors({ typeId: 7, date: '2026-03-01' });
  assert.equal(selectors.rowSelector, '.waste-occurrence-row[data-type-id="7"][data-date="2026-03-01"]');
  assert.equal(selectors.cardSelector, '.waste-type-card[data-type-id="7"]');
});

test('deepLinkSelectors: a type alone has no row selector, only the card fallback', () => {
  const selectors = deepLinkSelectors({ typeId: 7, date: null });
  assert.equal(selectors.rowSelector, null);
  assert.equal(selectors.cardSelector, '.waste-type-card[data-type-id="7"]');
});

// -------------------------------------------------------------------------
// splitUpcomingByType / deepLinkNeedsExpand - the collapsed "rest" section
// -------------------------------------------------------------------------

function occ(typeId, dateKey) {
  return { key: `${typeId}:${dateKey}`, date_key: dateKey, type_id: typeId };
}

test('splitUpcomingByType: one primary row per type (its earliest, since occurrences arrive date-sorted), everything else in rest', () => {
  const occurrences = [
    occ(1, '2026-01-05'), occ(2, '2026-01-06'), occ(1, '2026-01-12'), occ(1, '2026-01-19'), occ(2, '2026-01-13'),
  ];
  const { primary, rest } = splitUpcomingByType(occurrences);
  assert.deepEqual(primary.map((o) => o.key), ['1:2026-01-05', '2:2026-01-06'], 'the first occurrence encountered per type is primary');
  assert.deepEqual(rest.map((o) => o.key), ['1:2026-01-12', '1:2026-01-19', '2:2026-01-13']);
});

test('splitUpcomingByType: a single occurrence per type leaves rest empty', () => {
  const { primary, rest } = splitUpcomingByType([occ(1, '2026-01-05'), occ(2, '2026-01-06')]);
  assert.equal(primary.length, 2);
  assert.equal(rest.length, 0);
});

test('deepLinkNeedsExpand: false without a type/date, or when the target is a type\'s own primary row', () => {
  const occurrences = [occ(1, '2026-01-05'), occ(1, '2026-01-12')];
  assert.equal(deepLinkNeedsExpand(occurrences, { typeId: null, date: null }), false);
  assert.equal(deepLinkNeedsExpand(occurrences, { typeId: 1, date: null }), false);
  assert.equal(deepLinkNeedsExpand(occurrences, { typeId: 1, date: '2026-01-05' }), false, 'the primary row is already visible without expanding');
});

test('deepLinkNeedsExpand: true when the target date only exists in the collapsed rest section', () => {
  const occurrences = [occ(1, '2026-01-05'), occ(1, '2026-01-12')];
  assert.equal(deepLinkNeedsExpand(occurrences, { typeId: 1, date: '2026-01-12' }), true);
});

// -------------------------------------------------------------------------
// recurrenceSummary - the text a schedule row actually shows
// -------------------------------------------------------------------------

test('recurrenceSummary: weekly, single interval, joins weekday labels', () => {
  const schedule = { recurrence_kind: 'weekly', weekdays: 'MO,TH', interval: 1 };
  const days = 'waste.weekdayMon, waste.weekdayThu';
  assert.equal(recurrenceSummary(schedule), `waste.summaryWeekly{"days":"${days}"}`);
});

test('recurrenceSummary: weekly with interval > 1 uses the interval-aware key', () => {
  const schedule = { recurrence_kind: 'weekly', weekdays: 'MO', interval: 2 };
  assert.equal(recurrenceSummary(schedule), 'waste.summaryWeeklyInterval{"interval":2,"days":"waste.weekdayMon"}');
});

test('recurrenceSummary: monthly fixed day', () => {
  const schedule = { recurrence_kind: 'monthly_fixed_day', month_day: 15, interval: 1 };
  assert.equal(recurrenceSummary(schedule), 'waste.summaryMonthly{"day":"waste.summaryMonthDayN{\\"day\\":15}"}');
});

test('recurrenceSummary: monthly last-day-of-month uses the dedicated label, not summaryMonthDayN', () => {
  const schedule = { recurrence_kind: 'monthly_fixed_day', month_day: -1, interval: 1 };
  assert.equal(recurrenceSummary(schedule), 'waste.summaryMonthly{"day":"waste.monthDayLastDay"}');
});

test('recurrenceSummary: monthly with interval > 1 uses the interval-aware key', () => {
  const schedule = { recurrence_kind: 'monthly_fixed_day', month_day: 1, interval: 3 };
  assert.equal(recurrenceSummary(schedule), 'waste.summaryMonthlyInterval{"interval":3,"day":"waste.summaryMonthDayN{\\"day\\":1}"}');
});

// -------------------------------------------------------------------------
// originBadges - provenance visibility (invariant #3/#4)
// -------------------------------------------------------------------------

test('originBadges: an unmoved, non-coalesced occurrence shows no badges', () => {
  const occurrence = { moved: false, coalesced: false, origins: [{ kind: 'schedule', moved: false }] };
  assert.equal(originBadges(occurrence), '');
});

test('originBadges: a moved occurrence names its original date', () => {
  const occurrence = {
    moved: true, coalesced: false,
    origins: [{ kind: 'schedule', moved: true, original_date: '2026-01-12' }],
  };
  assert.match(originBadges(occurrence), /waste-badge--moved/);
  assert.match(originBadges(occurrence), /waste\.movedFromBadge/);
});

test('originBadges: a coalesced occurrence names the overlap, so editing one origin never looks like it erased the other', () => {
  const occurrence = {
    moved: false, coalesced: true,
    origins: [{ kind: 'schedule', moved: false }, { kind: 'one_off', moved: false }],
  };
  assert.match(originBadges(occurrence), /waste-badge--coalesced/);
});

test('originBadges: a moved AND coalesced occurrence shows both badges', () => {
  const occurrence = {
    moved: true, coalesced: true,
    origins: [{ kind: 'schedule', moved: true, original_date: '2026-01-12' }, { kind: 'one_off', moved: false }],
  };
  const html = originBadges(occurrence);
  assert.match(html, /waste-badge--moved/);
  assert.match(html, /waste-badge--coalesced/);
});

// -------------------------------------------------------------------------
// Import wizard pure helpers (#1063 Phase 3)
// -------------------------------------------------------------------------

test('defaultLabelDecision: remembered_ignored beats remembered_type_id beats suggested_type_id beats "create new"', () => {
  assert.equal(defaultLabelDecision({ remembered_ignored: true, remembered_type_id: 5, suggested_type_id: 9 }), '');
  assert.equal(defaultLabelDecision({ remembered_ignored: false, remembered_type_id: 5, suggested_type_id: 9 }), '5');
  assert.equal(defaultLabelDecision({ remembered_ignored: false, remembered_type_id: null, suggested_type_id: 9 }), '9');
  assert.equal(defaultLabelDecision({ remembered_ignored: false, remembered_type_id: null, suggested_type_id: null }), '__new__');
});

test('unresolvedBlockingDiagnostics: only blocking diagnostics count, and an explicit skip resolves one', () => {
  const diagnostics = [
    { severity: 'info', code: 'cancelled_excluded', event_key: null },
    { severity: 'blocking', code: 'unbounded_recurrence', event_key: 'uid:a' },
    { severity: 'blocking', code: 'unsupported_rdate', event_key: 'uid:b' },
  ];
  assert.equal(unresolvedBlockingDiagnostics(diagnostics, []).length, 2);
  assert.equal(unresolvedBlockingDiagnostics(diagnostics, ['uid:a']).length, 1);
  assert.equal(unresolvedBlockingDiagnostics(diagnostics, ['uid:a', 'uid:b']).length, 0);
});

test('buildMappingDecisions: builds type_id / new_type / ignored entries from each row\'s decision', () => {
  const rows = [
    { normalized_label: 'restmüll', decision: '5', newTypeName: '' },
    { normalized_label: 'papier', decision: '__new__', newTypeName: 'Papier' },
    { normalized_label: 'sperrmüll', decision: '', newTypeName: '' },
  ];
  const { mappings, error } = buildMappingDecisions(rows);
  assert.equal(error, undefined);
  assert.deepEqual(mappings, [
    { normalized_label: 'restmüll', type_id: 5 },
    { normalized_label: 'papier', new_type: { name: 'Papier' } },
    { normalized_label: 'sperrmüll', ignored: true },
  ]);
});

test('buildMappingDecisions: a "create new" decision without a name reports an error instead of committing a blank type', () => {
  const rows = [{ normalized_label: 'papier', decision: '__new__', newTypeName: '  ' }];
  const result = buildMappingDecisions(rows);
  assert.equal(result.error, 'missing_new_type_name');
  assert.equal(result.label, 'papier');
});

test('sourceHealthBadgeInfo: an error takes priority over needs_refresh, and a healthy source shows nothing', () => {
  assert.equal(sourceHealthBadgeInfo({ last_error: 'boom', needs_refresh: true }).code, 'error');
  assert.equal(sourceHealthBadgeInfo({ last_error: null, needs_refresh: true }).code, 'needs-refresh');
  assert.equal(sourceHealthBadgeInfo({ last_error: null, needs_refresh: false }), null);
});

// -------------------------------------------------------------------------
// nearestOrdinalAnchorDateKey - Anker-Vorbelegung fuer Ordinal-Schedules
// (#1063 Phase 9)
// -------------------------------------------------------------------------

// Rechnet komplett auf lokalen Date-Feldern; die Zone darf am Ergebnis nichts
// aendern. Genau diese Achse war der Round-3-Fund (toISOString().slice auf
// einem lokal gebauten Datum kippt westlich von UTC einen Tag) - deshalb
// laeuft jeder Fall einmal westlich, einmal oestlich von UTC und einmal unter
// der CI-Zone selbst, nach dem Muster von test-calendar-timezone-window.js.
function inTimezone(tz, fn) {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
  }
}

test('nearestOrdinalAnchorDateKey: this month\'s occurrence when it is today or later, else next month\'s - in any timezone', () => {
  for (const tz of ['America/Los_Angeles', 'Pacific/Auckland', 'UTC']) {
    inTimezone(tz, () => {
      // 2026-09-13 ist ein Sonntag; der zweite Montag (14.) liegt noch vor uns ...
      assert.equal(nearestOrdinalAnchorDateKey(2, 'MO', '2026-09-13'), '2026-09-14', `zweiter Montag unter ${tz}`);
      // ... der erste Montag (7.) nicht mehr - also der erste Montag des Oktobers.
      assert.equal(nearestOrdinalAnchorDateKey(1, 'MO', '2026-09-13'), '2026-10-05', `erster Montag unter ${tz}`);
      // "Letzter Freitag": Rueckwaertssuche vom Monatsletzten (Mi, 30.09.) aus.
      assert.equal(nearestOrdinalAnchorDateKey(-1, 'FR', '2026-09-13'), '2026-09-25', `letzter Freitag unter ${tz}`);
      // Heute selbst zaehlt ("am oder nach heute"): am 14. bleibt es der 14.
      assert.equal(nearestOrdinalAnchorDateKey(2, 'MO', '2026-09-14'), '2026-09-14', `heutiges Vorkommen unter ${tz}`);
    });
  }
});

// -------------------------------------------------------------------------
// Zeilengrammatik: EIN "..."-Menue statt nackter Icon-Knoepfe (Audit UX,
// 2026-09-12). Die drei Zeilentypen boten ihre Aktionen vorher auf drei
// verschiedene Arten an; die Abholzeile fuehrte als einzige ein Menue. Diese
// Tests halten die Vereinheitlichung fest - inklusive der Bedingung, die am
// Markup selbst nicht mehr sichtbar ist: an den Enden der Liste FEHLT der
// jeweilige Pfeil, statt ausgegraut dazustehen.
// -------------------------------------------------------------------------

const TYPE = { id: 7, name: 'Restmüll', icon: 'trash-2', color: '#64748B', archived: false };

test('typeCardHtml: die drei nackten Icon-Knoepfe sind einem einzigen "..."-Menue gewichen', () => {
  const html = typeCardHtml(TYPE, 1, 3);
  // Genau ein sichtbarer Zeilenknopf, und der oeffnet das Menue.
  assert.equal((html.match(/class="row-action"/g) ?? []).length, 1);
  assert.match(html, /popovertarget="waste-type-menu-7"/);
  assert.match(html, /<div class="popover-menu" id="waste-type-menu-7" popover role="menu">/);
  // Review PR #1146 ("nice to have"): der Knopf muss ein geschlossenes Menue
  // ankuendigen, nicht gar keins - dieselben zwei Attribute, die
  // popoverMenuHtml() fuer sein eigenes Menue setzt.
  assert.match(html, /class="row-action" popovertarget="waste-type-menu-7" aria-haspopup="menu" aria-expanded="false"/);
  // Die Aktionen liegen jetzt als beschriftete Eintraege im Menue, nicht mehr
  // als aria-label an einem Icon.
  for (const action of ['move-type-up', 'move-type-down', 'add-schedule']) {
    assert.match(html, new RegExp(`class="popover-menu__item" data-action="${action}"`), `${action} fehlt im Menue`);
  }
  // Loeschen gibt es auf Zeilenebene weiterhin nicht - das bleibt im Dialog.
  assert.doesNotMatch(html, /popover-menu__item--danger/);
});

test('typeCardHtml: der Datenschluessel jeder Aktion ueberlebt den Umzug ins Menue', () => {
  const html = typeCardHtml(TYPE, 1, 3);
  // Der delegierte Handler liest `dataset.id` bzw. `dataset.typeId` DIREKT am
  // Knoten mit data-action - ein Menueeintrag ohne diese Attribute waere still
  // wirkungslos geworden.
  assert.match(html, /data-action="move-type-up" data-id="7"/);
  assert.match(html, /data-action="add-schedule" data-type-id="7"/);
});

test('typeCardHtml: an den Enden der Liste fehlt der jeweilige Pfeil, statt tot dazustehen', () => {
  const first = typeCardHtml(TYPE, 0, 3);
  assert.doesNotMatch(first, /move-type-up/, 'die erste Abfallart kann nicht weiter nach oben');
  assert.match(first, /move-type-down/);

  const last = typeCardHtml(TYPE, 2, 3);
  assert.match(last, /move-type-up/);
  assert.doesNotMatch(last, /move-type-down/, 'die letzte Abfallart kann nicht weiter nach unten');

  // Und kein `disabled` mehr: der Eintrag ist weg, nicht ausgegraut.
  assert.doesNotMatch(first + last, /\bdisabled\b/);
});

test('typeCardHtml: bei genau einer Abfallart bleibt nur das Anlegen einer Serie uebrig', () => {
  const only = typeCardHtml(TYPE, 0, 1);
  assert.doesNotMatch(only, /move-type-up|move-type-down/, 'Sortieren gibt es bei einer einzigen Art nicht');
  assert.match(only, /data-action="add-schedule"/);
});

test('scheduleRowHtml: die Loeschung liegt hinter dem Menue und ist als gefaehrlich markiert', () => {
  const html = scheduleRowHtml({ id: 42, type_id: 7, active: true, freq: 'weekly', weekday: 1, interval: 1 });
  assert.equal((html.match(/class="row-action"/g) ?? []).length, 1);
  assert.match(html, /popovertarget="waste-schedule-menu-42"/);
  assert.match(html, /<div class="popover-menu" id="waste-schedule-menu-42" popover role="menu">/);
  assert.match(html, /class="row-action" popovertarget="waste-schedule-menu-42" aria-haspopup="menu" aria-expanded="false"/);
  assert.match(html, /class="popover-menu__item popover-menu__item--danger" data-action="delete-schedule" data-id="42"/);
  // Der nackte Muelltonnen-Knopf direkt in der Zeile ist weg - ein Fehlgriff
  // daneben loeschte vorher sofort eine ganze Serie.
  assert.doesNotMatch(html, /class="row-action" data-action="delete-schedule"/);
});

test('scheduleRowHtml: eine pausierte Serie traegt ihren eigenen Chip', () => {
  const paused = scheduleRowHtml({ id: 43, type_id: 7, active: false, freq: 'weekly', weekday: 1, interval: 1 });
  assert.match(paused, /class="waste-badge waste-badge--paused"/);
  const active = scheduleRowHtml({ id: 44, type_id: 7, active: true, freq: 'weekly', weekday: 1, interval: 1 });
  assert.doesNotMatch(active, /waste-badge--paused/);
});

test('sourceRowHtml: die wechselnde Zeilenaktion traegt im Menue endlich ihren Satz', () => {
  // Zwei der drei Faelle benutzten dasselbe `refresh-cw`; welcher gemeint war,
  // stand nur im aria-label und war fuer sehende Nutzer unsichtbar.
  const url = sourceRowHtml({ id: 3, kind: 'url', name: 'Stadt', needs_mapping: false });
  assert.match(url, /popovertarget="waste-source-menu-3"/);
  assert.match(url, /data-action="refresh-source" data-id="3"/);
  assert.match(url, /waste\.refreshNowAction/, 'der Eintrag traegt seine eigene Beschriftung');
  assert.match(url, /class="row-action" popovertarget="waste-source-menu-3" aria-haspopup="menu" aria-expanded="false"/);

  const needsMapping = sourceRowHtml({ id: 4, kind: 'url', name: 'Stadt', needs_mapping: true });
  assert.match(needsMapping, /data-action="review-source-mapping" data-id="4"/);

  const file = sourceRowHtml({ id: 5, kind: 'file', name: 'kalender.ics', needs_mapping: false });
  assert.match(file, /data-action="reimport-source" data-id="5"/);

  // Die Loeschung einer Quelle bleibt, wo sie war (Detail-Dialog).
  assert.doesNotMatch(url + file, /delete-source|popover-menu__item--danger/);
});

test('sourceRowHtml: jede Quelle bekommt ihr eigenes Menue', () => {
  const a = sourceRowHtml({ id: 3, kind: 'url', name: 'A', needs_mapping: false });
  const b = sourceRowHtml({ id: 9, kind: 'url', name: 'B', needs_mapping: false });
  assert.match(a, /id="waste-source-menu-3"/);
  assert.match(b, /id="waste-source-menu-9"/);
});

// -------------------------------------------------------------------------
// EINE Zeilengrammatik, auch im Bauplan (Browser-Pruefung, 2026-09-12)
//
// Die "..."-Knoepfe sassen nicht am Zeilenende, sondern klebten am Text: bei
// der Abfallart 372px zu frueh, bei der Serie 197px, bei der Quelle 354px -
// gemessen bei 1280px am gebauten Stand. Ursache war keine fehlende
// Ausrichtungsregel, sondern eine fehlende KLASSE: der Zeilenkoerper trug nur
// `list-row__main--interactive`, und dieser Modifikator traegt ausschliesslich
// die Knopf-Zuruecksetzung. `flex: 1 1 auto` und `min-width: 0` - das, was die
// Textspalte wachsen und die Bedienzone ans Ende ruecken laesst - stehen in
// der BASISKLASSE. Dieselbe Luecke stellte in allen vier Zeilentypen das
// Symbol ueber statt neben den Namen.
//
// Beide Zusagen sind reine Bauplan-Pruefungen: die Ausrichtung selbst
// entsteht im Browser. Aber genau die zwei Klassen, ohne die sie nicht
// entstehen KANN, lassen sich hier festnageln - und es ist die Art Fehler,
// die beim naechsten Umbau still zurueckkommt.
// -------------------------------------------------------------------------

test('alle vier "..."-Knoepfe kuendigen ein Menue an, auch der vorbestehende der Abholzeile (Review PR #1146)', () => {
  // popoverMenuHtml() setzt aria-haspopup="menu" aria-expanded="false" fuer
  // sein eigenes Menue; die vier `.row-action`-Knoepfe (Abholung, Serie,
  // Abfallart, Quelle) bauen ihr Markup separat und hatten diese zwei
  // Attribute keiner von ihnen - auch der Abholzeilen-Knopf nicht, der schon
  // vor diesem PR auf `main` stand.
  const rowActionButtons = WASTE_SRC.match(/<button type="button" class="row-action"[^>]*>/g) ?? [];
  assert.equal(rowActionButtons.length, 4, 'Abholung, Serie, Abfallart und Quelle');
  for (const btn of rowActionButtons) {
    assert.match(btn, /aria-haspopup="menu"/, `${btn} kuendigt kein Menue an`);
    assert.match(btn, /aria-expanded="false"/, `${btn} traegt keinen Anfangszustand`);
  }
});

test('jede Zeile des Moduls traegt die gemeinsame Marke waste-row', () => {
  // Ohne sie greift keine der beiden Grammatik-Regeln in waste.css, denn sie
  // haengen alle an `.waste-row > .list-row__main`.
  const rows = [
    typeCardHtml({ id: 1, name: 'A', color: '#16A34A' }, 0, 1),
    scheduleRowHtml({ id: 2, type_id: 1, recurrence_kind: 'weekly', interval: 1, weekdays: 'MO', active: true }),
    sourceRowHtml({ id: 3, kind: 'url', name: 'Q', needs_mapping: false }),
  ];
  for (const html of rows) {
    assert.match(html, /class="list-row waste-row /, 'die Marke steht direkt neben .list-row');
  }
  // Und die Abholzeile, die schon vorher richtig ausgerichtet war, ebenfalls -
  // sonst faellt ausgerechnet die Referenzzeile aus der gemeinsamen Regel.
  assert.match(WASTE_SRC, /class="list-row waste-row waste-occurrence-row"/);
});

test('der Zeilenkoerper traegt IMMER die Basisklasse, --interactive nur zusaetzlich', () => {
  // Vorrat und Inventar schreiben beide Klassen nebeneinander; hier stand der
  // Modifikator allein, und die Textspalte loeste damit auf ihre Inhaltsbreite
  // auf statt zu wachsen.
  const solo = WASTE_CODE.match(/class="[^"]*list-row__main--interactive[^"]*"/g) ?? [];
  assert.ok(solo.length >= 3, 'die drei schreibbaren Zeilenkoerper muessen auffindbar bleiben');
  for (const cls of solo) {
    assert.match(cls, /list-row__main(?!--)/, `${cls} braucht die Basisklasse list-row__main`);
  }
});

// -------------------------------------------------------------------------
// Keine Abfallartfarbe (One Today): Namen und Symbole, keine Palette.
// -------------------------------------------------------------------------

test('Vorlagen sind Name und Symbol, ohne Farbe', () => {
  for (const preset of TYPE_PRESETS) {
    assert.ok(!('color' in preset), `Preset ${preset.key} traegt keine Farbe`);
    assert.ok(preset.icon, `Preset ${preset.key} hat ein Symbol`);
  }
  assert.equal(__test.WASTE_TYPE_COLORS, undefined, 'die Palette ist weg');
  assert.equal(__test.activeSwatchColor, undefined);
  assert.equal(__test.resolveSwatchColors, undefined);
});

test('Zeilen und Chips zeichnen keine gespeicherte Farbe', () => {
  const html = typeCardHtml({ ...TYPE, color: '#64748B' }, 0, 2);
  assert.doesNotMatch(html, /#64748B|style="color:/i, 'die Abfallart-Karte ist ein Name mit Symbol');
  assert.doesNotMatch(WASTE_CODE, /type_color|type\.color|preset\.color/, 'der Quelltext liest keine Abfallartfarbe');
});

// -------------------------------------------------------------------------
// Quelltext-Zusicherungen (Audit UX, 2026-09-12).
//
// Die folgenden Zusagen haengen an `renderPage()`/`bindEvents()` und am
// Leerzustand - alles Stellen, die einen echten DOM und einen laufenden Router
// brauchen und deshalb oben bewusst nicht nachgebaut werden (siehe Kopf).
// Geprueft wird stattdessen der Vertrag im Quelltext, so wie es
// test-frontend-audit.js fuer die geteilten Blaetter tut. Das ist schwaecher
// als ein Klick, aber deutlich staerker als gar nichts - und es faengt genau
// den Rueckschritt ab, der hier teuer waere: einen Schreib-Weg, der einem
// Nur-lesen-Mitglied ins Markup rutscht.
// -------------------------------------------------------------------------

test('die Seite hat einen sichtbaren, beschrifteten Weg zur ersten Abfallart, und das Ueberlaufmenue bietet ihn nicht doppelt an', () => {
  // Vorher lagen ALLE vier Aktionen hinter dem unbeschrifteten "..." - eine
  // frische Installation zeigte keinen einzigen sichtbaren Weg zur ersten
  // Abfallart.
  //
  // SEKUNDAER FESTGENAGELT, nicht nur "irgendein Knopf": ab 1024px dockt der
  // FAB in dieselbe Werkzeugleiste (dockFabIntoToolbar in router.js) und
  // rendert dort als gefuellte Primaerpille. Als `btn--primary` standen hier
  // zwei gefuellte Violettknoepfe nebeneinander, und die Seite sagte nicht
  // mehr, welcher der Hauptweg ist (Eine-Stimme-Regel, DESIGN.md). Keine
  // statische Pruefung faengt das, weil beide Knoepfe je fuer sich
  // regelkonform sind - erst ihre Nachbarschaft ist der Fehler. Deshalb steht
  // die Variante hier ausdruecklich im Test und nicht nur im Kommentar.
  assert.match(WASTE_SRC, /class="btn btn--secondary" id="waste-add-type-btn" data-action="add-type"/);
  assert.doesNotMatch(WASTE_CODE, /class="btn btn--primary" id="waste-add-type-btn"/);
  // Und genau einmal als Knopf. Seit R16 (Kopfregel mobil 1a) gibt es den
  // Menueeintrag wieder, aber nie NEBEN dem Knopf: unter 768px traegt die
  // Titelzeile nur Icon-Knoepfe, der beschriftete Knopf ist dort ausgeblendet
  // und der Eintrag steht; ab 768px umgekehrt. Je Breite EIN Weg.
  assert.equal((WASTE_SRC.match(/data-action="add-type"/g) ?? []).length, 1);
  assert.equal((WASTE_CODE.match(/action: 'add-type'/g) ?? []).length, 1);
  const wasteCss = readFileSync(new URL('../public/styles/waste.css', import.meta.url), 'utf8');
  const hides = (sel, media) => [...eachRule(wasteCss)].some((r) => r.selector.trim() === sel
    && /display:\s*none/.test(r.body) && (media ? r.at.some((a) => media.test(a)) : r.at.length === 0));
  assert.ok(hides('#waste-add-type-btn', /max-width:\s*767px/), 'unter 768px weicht der Kopfknopf dem Menueeintrag');
  assert.ok(hides('#waste-page-menu [data-action="add-type"]', /min-width:\s*768px/), 'ab 768px weicht der Eintrag dem Knopf');
  assert.ok(hides('.waste-page--onboarding #waste-page-menu [data-action="add-type"]'), 'im Onboarding traegt der FAB den Weg');
  // Die drei uebrigen Kopf-Aktionen bleiben im Menue.
  for (const a of ['open-import', 'open-url-source', 'open-reminder-settings']) {
    assert.match(WASTE_SRC, new RegExp(`action: '${a}'`), `${a} gehoert weiter ins Ueberlaufmenue`);
  }
});

test('der neue Kopfknopf traegt bewusst KEIN toolbar-new-btn', () => {
  // Diese Klasse blendet ab 1024px den FAB aus
  // (`body:has(.toolbar-new-btn:not([hidden])) #fab-layer .page-fab`). Der FAB
  // der Abfallseite legt aber eine ABHOLUNG an, nicht eine Abfallart - mit der
  // Klasse waere die Abholung am Desktop ersatzlos verschwunden.
  assert.doesNotMatch(WASTE_CODE, /toolbar-new-btn/);
  assert.match(WASTE_SRC, /class="page-fab" id="waste-fab-new-pickup"/, 'der FAB bleibt, wo er war');
});

test('der FAB fuehrt ohne Abfallart nicht mehr ins Leere', () => {
  // Vorher: Toast, `return`, Ende - der prominenteste Knopf einer frischen
  // Installation war der einzige, der garantiert nirgendwohin fuehrte. Seit
  // der Re-Critique 2026-09-28 nennt er in diesem Zustand selbst "Abfallart"
  // (fabIntent, oben geprueft) und oeffnet genau diesen Dialog - der
  // erklaerende Toast entfiel, er legte sich ueber das Namensfeld.
  const handler = WASTE_SRC.match(/onClick: \(\) => \{[\s\S]{0,300}?\n {6}\}/);
  assert.ok(handler, 'der FAB-Handler in applyPageMode muss auffindbar bleiben');
  assert.match(handler[0], /if \(readOnly\(\)\) return;/);
  assert.match(handler[0], /creates === 'type'\) openTypeModal\(\)/);
  assert.match(handler[0], /else openScheduleModal\(null\)/, 'mit Abfallart legt der Primaerknopf den Termin an (R17/E2)');
  assert.doesNotMatch(WASTE_CODE, /addTypeFirstHint/, 'kein Umleitungs-Toast mehr');
  assert.match(WASTE_CODE, /setPageFabAction\(fab, \{[\s\S]{0,120}dockLabel: t\(intent\.dockLabelKey\)/,
    'der angedockte Knopf zieht sein Nomen mit');
});

test('beide Leerzustaende bieten ihren Weg an - und beide nur dem, der schreiben darf', () => {
  // Der Quellen-Leerzustand nannte den Weg in seiner Beschreibung, ohne ihn
  // anzubieten ("Importiere eine ICS-Datei deiner Kommune...").
  // Abfallarten: der EINE Onboarding-Block (Re-Critique 2026-09-28), dessen
  // Schreibwege am Nur-lesen-Schalter haengen (onboardingHtml, oben geprueft).
  assert.match(WASTE_SRC, /onboardingHtml\(\{ readOnly: readOnly\(\) \}\)/);
  assert.match(WASTE_SRC, /action: readOnly\(\) \? null : \{ label: t\('waste\.importFileAction'\)/);
  assert.match(WASTE_SRC, /#waste-empty-add-source'\)\?\.addEventListener\('click', \(\) => openImportWizard\(\)\)/);
});

test('jeder Schreib-Weg im Kopf bleibt hinter dem Nur-lesen-Riegel', () => {
  // Nicht "optisch versteckt", sondern gar nicht erst im Markup: das ist der
  // Unterschied, auf dem dieses Modul seit der ersten Fassung besteht.
  assert.match(WASTE_SRC, /actions: readOnly\(\) \? '' : renderPageActions\(\[/);
  // Und die Zeilenmenues ebenso - je einmal pro Zeilentyp.
  assert.equal((WASTE_SRC.match(/\$\{ro \? '' : `\n\s*<div class="row-actions">/g) ?? []).length, 2,
    'Serien- und Typzeile unterdruecken ihre Aktionen ueber dasselbe `ro`');
  assert.match(WASTE_SRC, /\$\{readOnly\(\) \? '' : `\n\s*<div class="row-actions">/, 'die Quellenzeile ebenso');
});

test('der Abfallart-Dialog hat keine Farbwahl mehr', () => {
  assert.doesNotMatch(WASTE_SRC, /type="color"|form-input--color|waste-color-|wtm-color|USER_COLORS/);
  assert.doesNotMatch(WASTE_CODE, /color:\s*(?:activeSwatchColor|selColor)/, 'Speichern schickt keine Farbe');
  const css = readFileSync(new URL('../public/styles/waste.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /waste-color-/, 'kein Swatch-CSS mehr');
});

// -------------------------------------------------------------------------
// EIN Leerzustand statt drei (Re-Critique 2026-09-28, P4). Ohne Abfallart
// standen drei "Noch nichts"-Bloecke untereinander, der erste Weg lag bei
// y683 unter dem Toast, und der FAB hiess "Abholung", fuehrte aber in den
// Abfallart-Dialog.
// -------------------------------------------------------------------------

test('isOnboarding: nur ohne jede Abfallart, nicht beim Laden, nicht bei nur archivierten', () => {
  assert.equal(isOnboarding({ types: [], loading: false, error: null }), true);
  assert.equal(isOnboarding({ types: [], loading: true, error: null }), false, 'Skelett statt Onboarding');
  assert.equal(isOnboarding({ types: [], loading: false, error: new Error('x') }), false, 'Ladefehler bleibt Ladefehler');
  assert.equal(isOnboarding({ types: [{ id: 1, archived: true }], loading: false, error: null }), false,
    'eine archivierte Art muss wiederherstellbar bleiben - sie steht nur in der vollen Ansicht');
});

test('sectionVisibility: im Onboarding nur EIN Block, Abholungen und Quellen erst mit Daten', () => {
  const on = sectionVisibility({ types: [], loading: false, error: null });
  assert.deepEqual(on, { upcoming: false, sources: false, addTypeButton: false });
  const full = sectionVisibility({ types: [{ id: 1, archived: false }], loading: false, error: null });
  assert.deepEqual(full, { upcoming: true, sources: true, addTypeButton: true });
});

test('onboardingHtml: Vorlagen als direkt anlegbare Chips plus ICS-Import, ein Leerzustand', () => {
  const html = onboardingHtml({ readOnly: false, emptyHtml: '<div class="empty-state">E</div>' });
  for (const preset of TYPE_PRESETS) {
    assert.match(html, new RegExp(`data-action="create-preset-type"[^>]*data-preset="${preset.key}"`), `Chip ${preset.key} fehlt`);
  }
  assert.equal((html.match(/class="empty-state/g) || []).length, 1, 'genau ein Leerzustand');
  assert.match(html, /data-action="open-import"/, 'ICS-Import als zweiter Weg');
  assert.match(html, /role="group"[^>]*aria-label="waste\.typePresetLabel"/);
});

test('onboardingHtml: Nur-lesen bekommt den Leerzustand ohne jeden Schreibweg', () => {
  const html = onboardingHtml({ readOnly: true, emptyHtml: '<div class="empty-state">E</div>' });
  assert.doesNotMatch(html, /create-preset-type|open-import/);
  assert.equal((html.match(/class="empty-state/g) || []).length, 1);
});

test('fabIntent: ohne Abfallart nennt der FAB "Abfallart" und legt sie an', () => {
  assert.deepEqual(fabIntent({ types: [] }), { creates: 'type', labelKey: 'waste.addType', dockLabelKey: 'newLabel.wasteType' });
  assert.deepEqual(fabIntent({ types: [{ id: 1, archived: true }] }),
    { creates: 'type', labelKey: 'waste.addType', dockLabelKey: 'newLabel.wasteType' }, 'nur archivierte: keine Abholung moeglich');
  // Entscheidung R17 (E2): mit Abfallart legt der Primaerknopf den
  // WIEDERKEHRENDEN TERMIN an - bis dahin die Einzelabholung, die seltenste
  // Handlung des Moduls.
  assert.deepEqual(fabIntent({ types: [{ id: 1, archived: false }] }),
    { creates: 'schedule', labelKey: 'waste.addSchedule', dockLabelKey: 'newLabel.wasteSchedule' });
});

/* #1775: mit NUR archivierten Abfallarten ist die Seite kein Onboarding (die
 * Karten bleiben wiederherstellbar), der Eintrag "Abholung hinzufuegen" stand
 * also im Menue - und oeffnete den Abfallart-Dialog. Gemessen wird die Klasse,
 * an der waste.css den Eintrag herausnimmt, an genau diesem Zustand. */
test('#1775: sind alle Abfallarten archiviert, traegt die Seite die Klasse, die "Abholung hinzufuegen" ausblendet', () => {
  const { pageModeClasses } = __test;
  const state = (types) => ({ loading: false, error: null, types });
  const archived = pageModeClasses(state([{ id: 1, archived: true }, { id: 2, archived: 1 }]));
  assert.equal(archived['waste-page--onboarding'], false, 'kein Onboarding: die Karten muessen bleiben');
  assert.equal(archived['waste-page--no-active-type'], true, 'aber auch keine aktive Abfallart');
  assert.equal(pageModeClasses(state([]))['waste-page--no-active-type'], true, 'im Onboarding ebenso');
  assert.deepEqual(pageModeClasses(state([{ id: 1, archived: true }, { id: 2, archived: false }])),
    { 'waste-page--loading': false, 'waste-page--onboarding': false, 'waste-page--no-active-type': false },
    'eine aktive genuegt: der Eintrag steht');
  // Dieselbe Regel wie der Primaerknopf - der Eintrag fehlt genau dann, wenn
  // sein Klick eine Abfallart anlegen wuerde.
  for (const types of [[], [{ archived: true }], [{ archived: false }]]) {
    assert.equal(pageModeClasses(state(types))['waste-page--no-active-type'], fabIntent({ types }).creates === 'type');
  }
  // Verdrahtung: applyPageMode() setzt JEDE dieser Klassen, und das Blatt
  // haengt die Regel an die neue, nicht mehr nur an das Onboarding.
  assert.match(WASTE_CODE, /for \(const \[name, on\] of Object\.entries\(pageModeClasses\(state\)\)\) page\?\.classList\.toggle\(name, on\);/);
  const css = readFileSync(new URL('../public/styles/waste.css', import.meta.url), 'utf8');
  const rule = [...eachRule(css)].find((r) => r.selector.split(',').some((x) => x.trim() === '.waste-page--no-active-type #waste-page-menu [data-action="add-pickup"]'));
  assert.ok(rule && /display:\s*none/.test(rule.body));
});

// ---------------------------------------------------------------------------
// Critique R17 (E2): der Termin ist der Hauptweg, die Abholung sagt, wann sie ist
// ---------------------------------------------------------------------------

test('R17/E2: die Einzelabholung steht im Werkzeugmenue, der Termin-Dialog waehlt seine Abfallart', () => {
  const menu = WASTE_SRC.slice(WASTE_SRC.indexOf("id: 'waste-page-menu'"), WASTE_SRC.indexOf('id="waste-add-type-btn"'));
  assert.match(menu, /\{ action: 'add-pickup', label: t\('waste\.addPickup'\), icon: 'calendar-plus' \}/);
  assert.match(WASTE_CODE, /kind === 'add-pickup'\) \{[\s\S]{0,200}?else openPickupModal\(\);/, 'der Eintrag oeffnet den Dialog der Einzelabholung');
  const css = readFileSync(new URL('../public/styles/waste.css', import.meta.url), 'utf8');
  const hidden = [...eachRule(css)].filter((r) => /display:\s*none/.test(r.body))
    .flatMap((r) => r.selector.split(',').map((x) => x.trim()));
  assert.ok(hidden.includes('.waste-page--no-active-type #waste-page-menu [data-action="add-pickup"]'),
    'ohne aktive Abfallart gibt es nichts, wofuer man eine Einzelabholung eintraegt');

  // Vom Primaerknopf kommt der Dialog ohne Abfallart: vorgeschlagen wird die
  // erste aktive OHNE Termin, sonst die erste aktive.
  const types = [{ id: 1 }, { id: 2 }, { id: 3, archived: true }];
  assert.equal(__test.defaultScheduleType(types, [{ type_id: 1 }]).id, 2);
  assert.equal(__test.defaultScheduleType(types, [{ type_id: 1 }, { type_id: 2 }]).id, 1);
  assert.equal(__test.defaultScheduleType([{ id: 3, archived: true }], []), null);
  const modal = WASTE_SRC.slice(WASTE_SRC.indexOf('function openScheduleModal(type, schedule = null) {'), WASTE_SRC.indexOf('function openPickupModal('));
  assert.match(modal, /const pickType = !type;/);
  assert.match(modal, /<select class="form-input" id="wsm-type">/);
  assert.match(modal, /const typeId = typeSelect \? Number\(typeSelect\.value\) : type\.id;/);
});

test('R17/E2: eine Abholung nennt Wochentag, Datum und Abstand', () => {
  // t() ist im Loader der Schluessel plus seine Parameter, formatDate() gibt
  // den Key zurueck: geprueft wird die Zusammensetzung, nicht die Uebersetzung.
  const today = '2026-10-07'; // Mittwoch
  assert.equal(__test.pickupWhenLabel('2026-10-07', today), 'Mi, 2026-10-07 · common.today');
  assert.equal(__test.pickupWhenLabel('2026-10-08', today), 'Do, 2026-10-08 · common.tomorrow');
  assert.equal(__test.pickupWhenLabel('2026-10-09', today), 'Fr, 2026-10-09 · dashboard.daysLeft{"count":2}');
  assert.equal(__test.pickupWhenLabel('2026-12-21', today), 'Mo, 2026-12-21 · dashboard.countdownMonths{"count":2}');
  assert.equal(__test.pickupWhenLabel('2026-10-05', today), 'Mo, 2026-10-05', 'ein vergangener Tag traegt keinen Abstand');
  // Der Wochentag haengt am KEY, nicht an der Zone des Prozesses.
  const before = process.env.TZ;
  try {
    for (const zone of ['Pacific/Auckland', 'America/Los_Angeles']) {
      process.env.TZ = zone;
      assert.equal(__test.pickupWhenLabel('2026-10-09', today), 'Fr, 2026-10-09 · dashboard.daysLeft{"count":2}', zone);
    }
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
  const row = __test.occurrenceRowHtml({ key: 'k', type_id: 1, type_name: 'Papier', date_key: '2099-01-02', origins: [] });
  assert.match(row, /<span class="list-row__meta">Fr, 2099-01-02 · /, 'die Abholzeile traegt das Label');
});

test('R17/E2: eine Abfallart mit anstehender Abholung sagt nicht "Noch kein Termin"', () => {
  const occurrences = [
    { type_id: 2, date_key: '2099-01-02', origins: [{ kind: 'one_off' }] },
    { type_id: 2, date_key: '2099-02-02', origins: [{ kind: 'one_off' }] },
  ];
  assert.match(__test.typeWithoutScheduleLine(2, occurrences), /^waste\.nextPickupLabel: Fr, 2099-01-02/, 'die naechste Abholung dieser Art');
  assert.equal(__test.typeWithoutScheduleLine(1, occurrences), 'waste.noSchedulesYet', 'wirklich nichts: der bisherige Satz');
  assert.match(WASTE_SRC, /const line = typeWithoutScheduleLine\(type\.id\);/, 'die Karte liest die Zeile dort (typeWithoutScheduleHtml)');
});

// R20 (Re-Critique 2026-10-17 a2 P2-5): "Noch kein Termin" ohne Inline-Aktion,
// Schnellchips nach der ersten Art weg, Tageschips umbrechend bei 390.
test('R20: ohne Termin steht der Weg daneben, die uebrigen Vorlagen bleiben, sieben Tage in einer Zeile', () => {
  __test.setStateForTest({ occurrences: [], types: [{ id: 3, name: 'Restmüll' }] });
  const html = __test.typeWithoutScheduleHtml({ id: 3, name: 'Restmüll', archived: false }, false);
  assert.match(html, /waste\.noSchedulesYet[\s\S]*data-action="add-schedule" data-type-id="3"/, 'die Aktion steht an der Aussage');
  assert.doesNotMatch(__test.typeWithoutScheduleHtml({ id: 3, archived: true }, false), /add-schedule/, 'archiviert: kein Angebot');
  assert.doesNotMatch(__test.typeWithoutScheduleHtml({ id: 3, archived: false }, true), /add-schedule/, 'read: kein Angebot');
  const first = __test.TYPE_PRESETS[0];
  const label = `waste.preset${first.key.charAt(0).toUpperCase()}${first.key.slice(1)}`;
  const left = __test.remainingTypePresets([{ name: ` ${label.toUpperCase()} ` }]).map((p) => p.key);
  assert.ok(!left.includes(first.key), 'eine vorhandene Vorlage faellt aus der Zeile (Name, ohne Gross/klein)');
  assert.equal(left.length, __test.TYPE_PRESETS.length - 1);
  assert.equal(__test.remainingTypePresets([]).length, __test.TYPE_PRESETS.length);
  // Codex-Review PR #2053: die Vorlage legt den Namen in der Sprache dessen
  // an, der tippt. "Bioabfall" eines deutschen Mitglieds ist fuer ein
  // englisches dieselbe Vorlage - das Symbol traegt sie ueber Sprachen.
  const organic = __test.TYPE_PRESETS.find((p) => p.key === 'organic');
  const foreign = __test.remainingTypePresets([{ name: 'Bioabfall', icon: organic.icon }]).map((p) => p.key);
  assert.ok(!foreign.includes('organic'), 'eine in einer anderen Sprache angelegte Vorlage wird erneut angeboten');
  assert.equal(foreign.length, __test.TYPE_PRESETS.length - 1);
  // Eine eigene Art mit dem Standardsymbol verdeckt keine Vorlage.
  assert.equal(__test.remainingTypePresets([{ name: 'Gelber Sack', icon: 'trash-2' }]).length, __test.TYPE_PRESETS.length);
  const css = readFileSync(new URL('../public/styles/waste.css', import.meta.url), 'utf8');
  assert.match(css, /\.waste-weekday-picker \{\s*display: grid;\s*grid-template-columns: repeat\(7, minmax\(0, 1fr\)\);/, 'sieben gleiche Spalten');
  const stepper = __test.intervalStepperHtml(1);
  assert.match(stepper, /data-interval-step="-1"[^>]*disabled/, 'an der Untergrenze ist Weniger gesperrt');
  assert.match(stepper, /<input type="number"[^>]*id="wsm-interval"[^>]*min="1" max="52"/, 'das native Feld bleibt');
  assert.match(__test.intervalStepperHtml(52), /data-interval-step="1"[^>]*disabled/);
});

test('create-preset-type schreibt und steht deshalb NICHT in READ_SAFE_ACTIONS', () => {
  assert.match(WASTE_CODE, /const READ_SAFE_ACTIONS = new Set\(\['open-source', 'toggle-upcoming-rest'\]\)/);
  assert.match(WASTE_CODE, /kind === 'create-preset-type'/);
});

test('Onboarding-CSS: Abholungen, Quellen, Abschnittstitel und Kopfknopf treten zurueck', () => {
  const css = readFileSync(new URL('../public/styles/waste.css', import.meta.url), 'utf8');
  const hidden = [...eachRule(css)].filter((r) => /display:\s*none/.test(r.body))
    .flatMap((r) => r.selector.split(',').map((x) => x.trim()));
  for (const sel of [
    '.waste-page--onboarding .waste-upcoming-section',
    '.waste-page--onboarding .waste-sources-section',
    '.waste-page--onboarding .waste-types-section .waste-section-title',
    '.waste-page--onboarding #waste-add-type-btn',
  ]) assert.ok(hidden.includes(sel), `${sel} fehlt`);
  // #1771: ab der Schwelle des Spaltenrasters ueberspannt der Leerzustand beide
  // Spuren, sonst steht er links der Mitte neben einer leeren Spalte. Die
  // Schwelle ist wortgleich die des Rasters (PAGE-019, test-frontend-audit.js).
  assert.match(
    css,
    /@container module-surface \(min-width: 65rem\)\s*\{\s*\.waste-page--onboarding \.page-columns__rail\s*\{\s*grid-column:\s*1 \/ -1;\s*\}\s*\}/,
    'Onboarding: die Seitenspalte ueberspannt das Raster ab 65rem',
  );
  // Seit #1775 kommen die Zustandsklassen aus pageModeClasses() - gemessen
  // wird, was die Funktion fuer das Onboarding sagt, nicht ihre Schreibweise.
  assert.equal(__test.pageModeClasses({ loading: false, error: null, types: [] })['waste-page--onboarding'], true);
  assert.equal(__test.pageModeClasses({ loading: true, error: null, types: [] })['waste-page--onboarding'], false);
  assert.match(WASTE_CODE, /Object\.entries\(pageModeClasses\(state\)\)\) page\?\.classList\.toggle\(name, on\)/);
});

// R17 (E6), Critique 2026-10-07 (A3 P1): der Termin-Dialog trug sieben rohe
// 13x13-Checkboxen in 31px-Labels und "Aktiv" als Checkbox statt als Schalter.
test('R17 E6: Wochentage sind Chips mit Zustand, "Aktiv" ist ein Schalter', () => {
  const html = __test.weekdayPickerHtml('MO,TH');
  const chips = [...html.matchAll(/<button type="button" class="([^"]*)" data-weekday="(\w+)"\s+aria-pressed="(true|false)">/g)];
  assert.equal(chips.length, 7, 'sieben Chips, je Wochentag einer');
  assert.ok(chips.every((m) => m[1].split(' ').includes('filter-chip')), 'der Chip des Kanons');
  assert.deepEqual(chips.filter((m) => m[3] === 'true').map((m) => m[2]), ['MO', 'TH'], 'der Zustand steht in aria-pressed');
  assert.deepEqual(chips.filter((m) => m[1].includes('filter-chip--active')).map((m) => m[2]), ['MO', 'TH'], 'und im Bild');
  assert.doesNotMatch(html, /type="checkbox"/, 'keine rohe Checkbox mehr');
  assert.match(html, /role="group" aria-labelledby="wsm-weekdays-label"/, 'die Gruppe hat einen Namen');
  assert.match(html, /<input type="hidden" name="weekdays" value="MO,TH">/, 'der Stand steht fuer den Verwerfen-Schutz in einem Feld');

  // Lesen: genau die gedrueckten Chips, in Wochenreihenfolge.
  const pressed = [{ dataset: { weekday: 'MO' } }, { dataset: { weekday: 'TH' } }];
  const root = { querySelectorAll: (sel) => (/\[aria-pressed="true"\]/.test(sel) ? pressed : []) };
  assert.deepEqual(__test.weekdayPickerValue(root), ['MO', 'TH']);

  const modal = WASTE_SRC.slice(WASTE_SRC.indexOf('function openScheduleModal(type, schedule = null) {'), WASTE_SRC.indexOf('function openPickupModal('));
  assert.match(modal, /<label class="toggle">\s*<input type="checkbox" id="wsm-active"[^>]*>\s*<span class="toggle__track"><\/span>/,
    '"Aktiv" traegt die Schalter-Bahn');
  assert.match(modal, /body\.weekdays = weekdayPickerValue\(panel\)/, 'der Speicherweg liest die Chips');
  assert.match(modal, /wireWeekdayPicker\(panel\)/, 'und die Chips sind verdrahtet');
});

// #1795, #1909: a refusal the server names by reason is said in the household
// language; everything else gets the general sentence, never the server's.
test('importErrorText: a named refusal gets its own sentence, anything else the generic one - never the server sentence', () => {
  const { importErrorText } = __test;
  assert.equal(importErrorText({ status: 409, data: { error: 'English sentence', reason: 'preview_changed' } }), 'waste.importPreviewChangedError');
  assert.equal(importErrorText({ status: 409, data: { error: 'English sentence', reason: 'source_changed' } }), 'waste.importSourceChangedError');
  assert.equal(importErrorText({ status: 400, data: { error: 'No mapping decision was given.' } }), 'common.unknownError');
  assert.equal(importErrorText({ status: 409, data: { error: 'Other', reason: 'toString' } }), 'common.unknownError', 'an inherited property name is not a refusal');
  assert.equal(importErrorText({ status: 400, data: { error: 'English', reason: 'waste_import_file_too_large', params: { limit_mb: 5 } } }),
    'waste.errorImportTooLarge{"limit_mb":5}', 'a limit carries its number into the sentence');
  assert.equal(importErrorText(new Error('offline')), 'common.unknownError');

  const wizard = WASTE_SRC.slice(WASTE_SRC.indexOf('function openImportWizard('), WASTE_SRC.indexOf('function sourceMappingRowHtml('));
  assert.match(wizard, /api\.post\(endpoint, body\);[\s\S]*?catch \(err\) \{[\s\S]*?showError\(importErrorText\(err\)\);/, 'the commit step of the wizard uses it');
});

// D5 (Critique 2026-10-16): im Onboarding standen FAB, Leerzustand UND Menue
// mit demselben ersten Schritt (Abfallart / Import). Der Import steht dort nur
// im Leerzustand, als leiser Link - das Menue nimmt ihn erst danach auf.
test('D5: im Onboarding steht der Import nur im Leerzustand, nicht zusaetzlich im Menue', () => {
  const css = readFileSync(new URL('../public/styles/waste.css', import.meta.url), 'utf8');
  const hidden = [...eachRule(css)].filter((r) => /display:\s*none/.test(r.body) && !r.at.length)
    .flatMap((r) => r.selector.split(',').map((x) => x.trim()));
  for (const action of ['add-type', 'open-import']) {
    assert.ok(hidden.includes(`.waste-page--onboarding #waste-page-menu [data-action="${action}"]`),
      `${action}: im Onboarding nicht ein zweites Mal im Menue`);
  }
  assert.match(WASTE_SRC, /class="btn btn--ghost waste-onboarding__import" data-action="open-import"/,
    'der Leerzustand behaelt den Import als leisen Link');
});

// R20 (Re-Critique 2026-10-17 a2 P2-3): CLS 0,24 mobil (gemessen bis 0,42):
// das Skelett der Seitenspalte stand unter dem der Abholungen und sprang nach
// dem Laden. Waehrend des Ladens steht die Spalte nicht da.
test('R20: waehrend des Ladens steht die Seitenspalte nicht da (kein Sprung nach dem Laden)', () => {
  const { pageModeClasses } = __test;
  assert.equal(pageModeClasses({ loading: true, error: null, types: [] })['waste-page--loading'], true);
  assert.equal(pageModeClasses({ loading: false, error: null, types: [] })['waste-page--loading'], false);
  const css = readFileSync(new URL('../public/styles/waste.css', import.meta.url), 'utf8');
  assert.match(css, /\.waste-page--loading \.page-columns__rail \{\s*display: none;/);
  const src = readFileSync(new URL('../public/pages/waste.js', import.meta.url), 'utf8');
  assert.match(src, /renderPage\(\);\s*_container\.querySelector\('\.waste-page'\)\?\.classList\.add\('waste-page--loading'\);/, 'die Klasse steht ab dem ersten Bild');
  assert.match(src, /if \(state\.error\) \{\s*_container\.querySelector\('\.waste-page'\)\?\.classList\.remove\('waste-page--loading'\);/, 'ein Ladefehler gibt die Spalte frei');
});
