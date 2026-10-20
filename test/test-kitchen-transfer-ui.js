/**
 * Modul: Kreuztransfer der Kueche in der Oberflaeche (#1290)
 * Zweck: Drei Wege schreiben aus einem Kuechen-Tab in ein FREMDES Modul, und
 *        der Server verlangt fuer jeden zwei Schreibrechte:
 *          - Mahlzeit -> Einkauf (`POST /meals/:id/to-shopping-list`) und
 *            Rezept -> Einkauf (`POST /recipes/:id/to-shopping-list`): der
 *            Pfad-Guard misst den Aufruf als `meals` (beide Praefixe gehoeren
 *            dem Scope-Modul `meals`), die Route verlangt dazu `shopping`.
 *          - Einkauf <- Essensplan (`POST /shopping/:listId/import-meal-plan`):
 *            der Pfad-Guard misst `shopping`, die Route verlangt dazu `meals`.
 *        Fehlt EINES der beiden, endet der Knopf im 403. Die Oberflaeche bietet
 *        ihn dann nicht an (Regel 2 in public/utils/module-access.js: die
 *        Handlung geht weg), und der Handler loest den Aufruf auch nicht aus,
 *        falls ihn doch jemand erreicht.
 *
 *        Gemessen wird am echten Markup und am echten Handler: die Zusage des
 *        Handlers ist das AUSBLEIBEN einer Anfrage, und das sieht kein
 *        Textguard. Jeder Fall prueft die Positivseite mit - erschiene der
 *        Knopf dort nicht, waere der Aufbau des Tests kaputt, nicht die Regel
 *        erfuellt.
 *
 * Ausführen: npm run test:kitchen-transfer-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.window = globalThis.window ?? {};
// Toasts ins Leere: der Einkauf ruft `window.yuvomi.showToast` ohne `?.`.
globalThis.window.yuvomi = { showToast() {}, ...globalThis.window.yuvomi };

const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();

const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const { __test: meals } = await import('../public/pages/meals.js');
const { __test: recipes } = await import('../public/pages/recipes.js');
const { __test: shopping } = await import('../public/pages/shopping.js');

/** Rechte setzen, `fn` fahren (auch async) und danach sicher aufraeumen. */
async function withAccess(modules, fn) {
  setPermissions({ admin: false, modules, widgets: {}, capabilities: {} });
  try {
    return await fn();
  } finally {
    clearPermissions();
  }
}

/** Jeden POST mitschreiben, statt ihn zu senden. */
async function recordPosts(fn) {
  const posts = [];
  const zuvor = globalThis.__apiStub;
  globalThis.__apiStub = {
    post: async (path, body) => {
      posts.push(path);
      return { data: { transferred: 0, skipped: 0, added_ids: [] } };
    },
  };
  try {
    await fn();
  } finally {
    globalThis.__apiStub = zuvor;
  }
  return posts;
}

// Die Rechtekombinationen, die der Server abweist, und die eine, die er annimmt.
const BEIDE = { meals: 'write', shopping: 'write' };
const KEIN_TRANSFER_AUS_DER_KUECHE = [
  ['shopping: read', { meals: 'write', shopping: 'read' }],
  ['shopping: none', { meals: 'write', shopping: 'none' }],
  // Der Pfad-Guard: `/meals` gehoert dem Modul `meals`, und die Route kippt
  // `on_shopping_list` im Essensplan - Mahlzeit -> Einkauf braucht `meals: write`.
  ['meals: read', { meals: 'read', shopping: 'write' }],
];
// Rezept -> Einkauf LIEST das Rezept (Entscheidung 22.09.2026, server/scopes.js
// `READ_LEVEL_WRITES`): dort reicht `meals: read`, `none` bleibt zu.
const REZEPT_ERLAUBT = [
  ['beiden Schreibrechten', BEIDE],
  ['meals: read + shopping: write', { meals: 'read', shopping: 'write' }],
];
const KEIN_REZEPT_TRANSFER = [
  ['shopping: read', { meals: 'write', shopping: 'read' }],
  ['shopping: none', { meals: 'write', shopping: 'none' }],
  ['meals: none', { meals: 'none', shopping: 'write' }],
  ['meals: read + shopping: read', { meals: 'read', shopping: 'read' }],
];
const KEIN_IMPORT_IN_DEN_EINKAUF = [
  ['meals: read', { shopping: 'write', meals: 'read' }],
  ['meals: none', { shopping: 'write', meals: 'none' }],
  // Der Pfad-Guard: `/shopping/...` gehoert dem Modul `shopping`.
  ['shopping: read', { shopping: 'read', meals: 'write' }],
];

const LISTE = { id: 5, name: 'Wocheneinkauf', item_total: 0, item_checked: 0 };

// -------------------------------------------------------------------------
// Essensplan: die Kachel und der Dialog
// -------------------------------------------------------------------------

const mahlzeit = () => ({
  id: 11, title: 'Linsensuppe', date: '2026-09-21', meal_type: 'lunch',
  ingredients: [{ id: 1, name: 'Linsen', quantity: '200 g', on_shopping_list: 0 }],
});
const kachel = () => meals.renderSlot('2026-09-21', { key: 'lunch', label: 'Mittag' }, [mahlzeit()], 1, 1);
const dialog = () => {
  const zuvor = meals.state.lists;
  meals.state.lists = [LISTE];
  try {
    return meals.buildModalContent({ mode: 'edit', date: '2026-09-21', mealType: 'lunch', meal: mahlzeit() });
  } finally {
    meals.state.lists = zuvor;
  }
};

test('Essensplan mit beiden Schreibrechten: Kachel und Dialog bieten den Transfer an', async () => {
  await withAccess(BEIDE, () => {
    assert.match(kachel(), /data-action="transfer-meal"/);
    assert.match(dialog(), /id="transfer-btn"/);
  });
});

for (const [name, modules] of KEIN_TRANSFER_AUS_DER_KUECHE) {
  test(`Essensplan mit ${name}: weder Kachel noch Dialog bieten den Transfer an`, async () => {
    await withAccess(modules, () => {
      assert.doesNotMatch(kachel(), /data-action="transfer-meal"/,
        'der Einkaufswagen an der Kachel fuehrte ins 403');
      const html = dialog();
      assert.doesNotMatch(html, /id="transfer-btn"/, 'der Transfer-Knopf im Dialog fuehrte ins 403');
      assert.doesNotMatch(html, /shopping-transfer/,
        'der ganze Abschnitt entfaellt - ein Auswahlfeld ohne Knopf verspraeche dasselbe');
    });
  });

  test(`Essensplan mit ${name}: der Handler schickt keinen Transfer`, async () => {
    const zuvor = meals.state.lists;
    meals.state.lists = [LISTE];
    try {
      const posts = await withAccess(modules, () => recordPosts(() => meals.transferMeal(11, null)));
      assert.deepEqual(posts, []);
    } finally {
      meals.state.lists = zuvor;
    }
  });
}

test('Essensplan mit beiden Schreibrechten: der Handler schickt den Transfer', async () => {
  const zuvor = meals.state.lists;
  meals.state.lists = [LISTE];
  try {
    const posts = await withAccess(BEIDE, () => recordPosts(() => meals.transferMeal(11, null)));
    assert.deepEqual(posts, ['/meals/11/to-shopping-list']);
  } finally {
    meals.state.lists = zuvor;
  }
});

// -------------------------------------------------------------------------
// Rezepte: der Knopf im Detail
// -------------------------------------------------------------------------

const rezept = { id: 21, title: 'Pfannkuchen' };
const zutaten = [{ name: 'Mehl', quantity: '250 g' }];

async function mitListe(fn) {
  const zuvor = recipes.state.lists;
  recipes.state.lists = [LISTE];
  try {
    return await fn();
  } finally {
    recipes.state.lists = zuvor;
  }
}

for (const [name, modules] of REZEPT_ERLAUBT) {
  test(`Rezept mit ${name}: Knopf da, Handler schickt den Transfer`, async () => {
    await mitListe(async () => {
      await withAccess(modules, async () => {
        const btn = recipes.shoppingTransferButton(rezept, zutaten);
        assert.equal(btn?.dataset.action, 'to-shopping');
        const posts = await recordPosts(() => recipes.transferRecipe(rezept, null));
        assert.deepEqual(posts, ['/recipes/21/to-shopping-list']);
      });
    });
  });
}

for (const [name, modules] of KEIN_REZEPT_TRANSFER) {
  test(`Rezept mit ${name}: kein Knopf, und der Handler schickt nichts`, async () => {
    await mitListe(async () => {
      await withAccess(modules, async () => {
        assert.equal(recipes.shoppingTransferButton(rezept, zutaten), null,
          '„Auf die Einkaufsliste" fuehrte ins 403');
        const posts = await recordPosts(() => recipes.transferRecipe(rezept, null));
        assert.deepEqual(posts, []);
      });
    });
  });
}

// -------------------------------------------------------------------------
// Einkauf: „Aus dem Essensplan uebernehmen" im Listenmenue
// -------------------------------------------------------------------------

function listenMenue() {
  // Zwei Traeger seit der Kopfregel mobil (2026-09-26): die Kapseln in
  // #list-tabs-bar, das Listenmenue im Werkzeug-Slot #shopping-tools des Kopfs.
  const sink = () => {
    const el = { html: '' };
    el.replaceChildren = () => { el.html = ''; };
    el.insertAdjacentHTML = (_pos, markup) => { el.html += markup; };
    return el;
  };
  const bar = sink();
  const tools = sink();
  const container = { querySelector: (sel) => ({ '#list-tabs-bar': bar, '#shopping-tools': tools }[sel] ?? null) };
  const zuvor = { lists: shopping.state.lists, activeList: shopping.state.activeList, activeListId: shopping.state.activeListId };
  Object.assign(shopping.state, { lists: [LISTE], activeList: LISTE, activeListId: LISTE.id });
  try {
    shopping.renderTabs(container);
  } finally {
    Object.assign(shopping.state, zuvor);
  }
  return bar.html + tools.html;
}

async function importOeffnetDialog() {
  let geoeffnet = false;
  const zuvorModal = globalThis.__openModal;
  const zuvorId = shopping.state.activeListId;
  globalThis.__openModal = () => { geoeffnet = true; };
  shopping.state.activeListId = LISTE.id;
  try {
    shopping.openMealPlanImport({});
  } finally {
    globalThis.__openModal = zuvorModal;
    shopping.state.activeListId = zuvorId;
  }
  return geoeffnet;
}

test('Einkauf mit beiden Schreibrechten: das Menue fuehrt die Uebernahme, der Dialog geht auf', async () => {
  await withAccess(BEIDE, async () => {
    const html = listenMenue();
    assert.match(html, /data-action="import-meals"/);
    assert.match(html, /data-action="rename-list"/, 'Gegenprobe: das Menue selbst wurde gezeichnet');
    assert.equal(await importOeffnetDialog(), true);
  });
});

for (const [name, modules] of KEIN_IMPORT_IN_DEN_EINKAUF) {
  test(`Einkauf mit ${name}: keine Uebernahme aus dem Essensplan`, async () => {
    await withAccess(modules, async () => {
      assert.doesNotMatch(listenMenue(), /data-action="import-meals"/,
        'die Uebernahme endete im 403 - schon ihre Vorschau');
      assert.equal(await importOeffnetDialog(), false,
        'der Einstieg oeffnet keinen Dialog, dessen Vorschau der Server abweist');
    });
  });
}

// -------------------------------------------------------------------------
// Die Dialoge als Programm: Rechte aendern sich, WAEHREND sie offen stehen
// -------------------------------------------------------------------------

/**
 * Ein Panel-Stub, der je Selektor EIN Element liefert und dessen Listener
 * mitschreibt - genug fuer die Verdrahtung eines Dialogs. Gemessen wird davon
 * nur der eine Handler, den der Test herausgreift.
 */
function stubPanel(werte = {}) {
  const elemente = new Map();
  const element = (sel) => {
    if (!elemente.has(sel)) {
      const listeners = {};
      elemente.set(sel, {
        listeners, value: werte[sel] ?? '', hidden: false, disabled: false, checked: false,
        addEventListener(typ, fn) { listeners[typ] = fn; },
        replaceChildren() {}, appendChild() {}, querySelectorAll: () => [],
      });
    }
    return elemente.get(sel);
  };
  return { querySelector: element, querySelectorAll: () => [], element };
}

/** Einen Dialog mit dem echten `onSave` oeffnen und das Panel zurueckgeben. */
function oeffne(openFn, werte) {
  const panel = stubPanel(werte);
  const zuvor = globalThis.__openModal;
  globalThis.__openModal = (opts) => opts.onSave(panel);
  try {
    openFn();
  } finally {
    globalThis.__openModal = zuvor;
  }
  return panel;
}

test('Mahlzeit-Dialog: gehen die Rechte verloren, waehrend er offen steht, schickt der Transfer-Knopf nichts', async () => {
  const zuvor = meals.state.lists;
  meals.state.lists = [LISTE];
  try {
    const panel = await withAccess(BEIDE, () => oeffne(
      () => meals.openMealModal({ mode: 'edit', date: '2026-09-21', mealType: 'lunch', meal: mahlzeit() }),
      { '#transfer-list-select': String(LISTE.id) },
    ));
    const klick = panel.element('#transfer-btn').listeners.click;
    assert.equal(typeof klick, 'function', 'Gegenprobe: der Dialog hat den Transfer-Knopf verdrahtet');
    for (const [name, modules] of KEIN_TRANSFER_AUS_DER_KUECHE) {
      const posts = await withAccess(modules, () => recordPosts(() => klick()));
      assert.deepEqual(posts, [], `mit ${name} endete der Klick im 403`);
    }
    const posts = await withAccess(BEIDE, () => recordPosts(() => klick()));
    assert.deepEqual(posts, ['/meals/11/to-shopping-list'], 'Gegenprobe: mit beiden Rechten geht der Transfer raus');
  } finally {
    meals.state.lists = zuvor;
    meals.state.modal = null;
  }
});

test('Import-Dialog im Einkauf: gehen die Rechte verloren, waehrend er offen steht, schicken Vorschau und Uebernehmen nichts', async () => {
  const zuvorId = shopping.state.activeListId;
  shopping.state.activeListId = LISTE.id;
  try {
    const panel = await withAccess(BEIDE, () => oeffne(
      () => shopping.openMealPlanImport({}),
      { '#shopping-import-from': '2026-09-21', '#shopping-import-to': '2026-09-27' },
    ));
    const vorschau = panel.element('#shopping-import-from').listeners.change;
    const absenden = () => panel.element('#shopping-import-meals-form').listeners.submit({ preventDefault() {} });
    assert.equal(typeof vorschau, 'function', 'Gegenprobe: der Dialog hat die Vorschau verdrahtet');
    for (const [name, modules] of KEIN_IMPORT_IN_DEN_EINKAUF) {
      const posts = await withAccess(modules, () => recordPosts(async () => { await vorschau(); await absenden(); }));
      assert.deepEqual(posts, [], `mit ${name} endeten Vorschau und Uebernehmen im 403`);
    }
    const posts = await withAccess(BEIDE, () => recordPosts(async () => { await vorschau(); await absenden(); }));
    assert.deepEqual(posts, [`/shopping/${LISTE.id}/import-meal-plan`, `/shopping/${LISTE.id}/import-meal-plan`],
      'Gegenprobe: mit beiden Rechten rechnet die Vorschau, und Uebernehmen schickt den Import');
  } finally {
    shopping.state.activeListId = zuvorId;
  }
});

// -------------------------------------------------------------------------
// Dialogfuss nach dem Kanon (R8 H10): [Loeschen links] ... [Abbrechen] [Primaer]
// -------------------------------------------------------------------------

/** Den Fuss eines Dialog-Markups herausloesen. */
function fussVon(html) {
  const treffer = /<div class="modal-panel__footer[^"]*">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(treffer, 'der Dialog hat einen Fuss');
  return treffer[1];
}

function loeschenStehtLinks(fuss, id, abbrechenId) {
  const loeschen = fuss.indexOf(`id="${id}"`);
  assert.ok(loeschen >= 0, 'Loeschen steht im Dialogfuss');
  assert.ok(loeschen < fuss.indexOf(`id="${abbrechenId}"`), 'links vor Abbrechen und Primaer');
  // Weitere Attribute dazwischen sind erlaubt (R9: `data-delete-name` nennt
  // dem mobilen Icon-Knopf sein Objekt) - geprueft wird Klasse und Schub.
  assert.match(fuss, new RegExp(`class="btn btn--danger-outline" id="${id}"[^>]*\\sstyle="margin-inline-end:auto"`),
    'als danger-outline, das den Rest nach rechts schiebt');
}

// Tafla (2026-10-19): das Mahlzeit-Blatt hat kein "Abbrechen" mehr - das X im
// Kopf schliesst (mit Rueckfrage bei Eingaben), der Fuss traegt nur noch
// [Loeschen] [Primaer]. Die Regel bleibt: Loeschen steht links vom Primaerknopf.
test('Mahlzeit bearbeiten: Loeschen steht links im Dialogfuss, beim Anlegen nicht (R8 H10)', async () => {
  await withAccess(BEIDE, () => {
    loeschenStehtLinks(fussVon(dialog()), 'modal-delete', 'modal-save');
    assert.doesNotMatch(fussVon(dialog()), /id="modal-cancel"/, 'Tafla: kein Abbrechen im Blatt');
    const neu = meals.buildModalContent({ mode: 'create', date: '2026-09-21', mealType: 'lunch', meal: null });
    assert.doesNotMatch(fussVon(neu), /modal-delete/, 'ohne Bestand gibt es nichts zu loeschen');
  });
});

test('Rezept bearbeiten: Loeschen steht links im Dialogfuss - nicht beim Anlegen, nicht beim Spiegel (R8 H10)', () => {
  loeschenStehtLinks(fussVon(recipes.recipeModalFooterHtml(true, { id: 4, source: 'native' })), 'recipe-delete', 'recipe-cancel');
  assert.doesNotMatch(recipes.recipeModalFooterHtml(false, null), /recipe-delete/);
  assert.doesNotMatch(recipes.recipeModalFooterHtml(true, { id: 5, source: 'mealie' }), /recipe-delete/,
    'gespiegelte Rezepte gehoeren dem Provider - dieselbe Regel wie die Zeilenaktionen');
});

test('Serien-Mahlzeit: Loeschen im Fuss fragt den Umfang UEBER dem Editor - ein Abbruch laesst ihn offen (Codex an #1485)', async () => {
  const serie = { ...mahlzeit(), recurrence_template_id: 7 };
  const zuvor = { meals: meals.state.meals, lists: meals.state.lists, close: globalThis.__closeModal,
    ask: globalThis.__askOverModal, api: globalThis.__apiStub };
  const ablauf = [];
  meals.state.meals = [serie];
  meals.state.lists = [LISTE];
  globalThis.__closeModal = () => { ablauf.push('schliessen'); };
  globalThis.__apiStub = {
    get: async () => ({ data: [] }),
    delete: async (path) => { ablauf.push(`DELETE ${path}`); return { data: {} }; },
  };
  let antwort = null;
  globalThis.__askOverModal = async () => { ablauf.push('frage'); return antwort; };
  try {
    const panel = await withAccess(BEIDE, () => oeffne(
      () => meals.openMealModal({ mode: 'edit', date: serie.date, mealType: serie.meal_type, meal: serie }),
    ));
    const klick = panel.element('#modal-delete').listeners.click;
    assert.equal(typeof klick, 'function', 'Gegenprobe: der Dialog hat Loeschen verdrahtet');

    await klick();
    assert.deepEqual(ablauf, ['frage'],
      'abgebrochen: nichts geloescht, und der Editor mit seinen Aenderungen bleibt offen');

    ablauf.length = 0;
    antwort = 'series';
    await klick();
    assert.deepEqual(ablauf.slice(0, 3), ['frage', 'schliessen', 'DELETE /meals/11?scope=series'],
      'erst mit gewaehltem Umfang geht der Editor zu - und der Umfang wird nicht ein zweites Mal erfragt');
  } finally {
    meals.state.meals = zuvor.meals;
    meals.state.lists = zuvor.lists;
    meals.state.modal = null;
    globalThis.__closeModal = zuvor.close;
    globalThis.__askOverModal = zuvor.ask;
    globalThis.__apiStub = zuvor.api;
  }
});

// ---------------------------------------------------------------------------
// Eigene Rezepte zeigen ihr Bild (Critique 2026-10-05, R16)
// ---------------------------------------------------------------------------
// Das Vorschaubild hing an `isMirrored`: ein eigenes Rezept bekam im Editor ein
// Bild, der Wochenplan zeigte es - die Rezeptliste nicht, und das Detail hatte
// gar keins. Die Frage ist "hat es ein Bild", nicht "woher kommt das Rezept".

const NATIVE_MIT_BILD = { id: 11, title: 'Lachs', source: 'native', has_own_image: true, provider_has_image: false, ingredients: [], meal_types: ['dinner'] };
const NATIVE_OHNE_BILD = { ...NATIVE_MIT_BILD, id: 12, has_own_image: false };

test('R16: ein eigenes Rezept mit Bild traegt das Vorschaubild in der Liste, eines ohne Bild keinen Platzhalter', () => {
  assert.equal(recipes.rowShowsThumb(NATIVE_MIT_BILD), true);
  assert.equal(recipes.rowShowsThumb(NATIVE_OHNE_BILD), false, 'ein eigenes Rezept ohne Bild bleibt eine Textzeile');
  // Gespiegelte Rezepte behalten ihre Regel (#1059): Bild oder Platzhalter.
  assert.equal(recipes.rowShowsThumb({ id: 13, source: 'mealie', provider_has_image: false }), true);
});

test('R16: das Detail traegt ein Kopfbild, wenn es ein eigenes Bild gibt - und nur dann', () => {
  // Das Mini-DOM kennt keine Selektoren: gelesen werden die Kinder selbst.
  const isHero = (node) => node?.className === 'recipe-detail__hero';
  const mit = document.createElement('div');
  recipes.fillRecipeDetail(mit, NATIVE_MIT_BILD);
  const [hero] = mit.childNodes;
  assert.ok(isHero(hero), 'das Kopfbild steht im Detail, und zwar zuerst');
  const [img] = hero.childNodes;
  assert.equal(img.tagName, 'img');
  assert.equal(img.src, '/api/v1/recipes/11/image');
  assert.equal(img.alt, '', 'dekorativ: der Name steht in der Zeile');
  assert.equal(img.loading, 'lazy');
  assert.equal(img.listener, 'error', 'ein Bild, das nicht laedt, nimmt seinen Rahmen mit');

  const ohne = document.createElement('div');
  recipes.fillRecipeDetail(ohne, NATIVE_OHNE_BILD);
  assert.equal(ohne.childNodes.some(isHero), false, 'ohne Bild kein Platzhalterblock');
  assert.ok(ohne.childNodes.length > 0, 'das Detail selbst ist da');
});

/* REZEPT OHNE BILD (R20, Entscheidung Ulas 2026-10-17): das flache Band im
 * Kuechenton aus R18 ist weg. Ohne Bild beginnt das Detail mit seinem Inhalt
 * (Mahlzeit-Chips, Zutaten), den Titel traegt der Kopf des Rahmens. Am Desktop
 * stand das Band als 480px breiter Stummel ueber den Zutaten. */
/* TAFLA (2026-10-19): der Inhalt beginnt mit seinem Kopf (wie oft gekocht,
 * Mahlzeiten, Zahlenreihe) statt direkt mit den Mahlzeiten - die Regel R20
 * fuer die Spalte bleibt: kein Band, kein Platzhalter. Das Blatt am Telefon
 * (`variant: 'sheet'`) traegt dagegen bewusst das Kopfbild bzw. die warme
 * Flaeche (Tafla "Przepis"), eigener Fall unten. */
test('R20: ohne Bild beginnt das Detail mit seinem Inhalt - kein Band, kein Platzhalter', async () => {
  const ohne = document.createElement('div');
  recipes.fillRecipeDetail(ohne, NATIVE_OHNE_BILD);
  const [first] = ohne.childNodes;
  assert.equal(first.className, 'recipe-detail__head', 'das Detail beginnt mit seinem Kopf, nicht mit einem Band');
  assert.equal(ohne.childNodes.some((node) => /recipe-detail__(?:band|hero)/.test(node?.className ?? '')), false);

  // Mit Bild bleibt der Hero vorn.
  const mit = document.createElement('div');
  recipes.fillRecipeDetail(mit, NATIVE_MIT_BILD);
  assert.equal(mit.childNodes[0].className, 'recipe-detail__hero');

  const { readFileSync } = await import('node:fs');
  const thumb = readFileSync(new URL('../public/utils/recipe-thumb.js', import.meta.url), 'utf8');
  assert.doesNotMatch(thumb, /recipeBandEl|recipe-detail__band/, 'der Baustein des Bands ist weg');
  // Scheitert das Bild beim Laden, geht der Rahmen mit - ohne Ersatz.
  const fn = thumb.slice(thumb.indexOf('export function recipeHeroEl('), thumb.indexOf('/**', thumb.indexOf('export function recipeHeroEl(')));
  assert.match(fn, /addEventListener\('error', \(\) => frame\.remove\(\)/);
  const page = readFileSync(new URL('../public/pages/recipes.js', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /recipeBandEl/);
  const css = readFileSync(new URL('../public/styles/recipes.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /\.recipe-detail__band/, 'keine Regeln fuer ein Band, das niemand baut');
});


test('R16: das Kopfbild beschneidet (3:2, cover) und verzerrt nicht', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const css = readFileSync(new URL('../public/styles/recipes.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)];
  const frame = rules.find((r) => r.selector.trim() === '.recipe-detail__hero');
  const image = rules.find((r) => r.selector.trim() === '.recipe-detail__hero-img');
  assert.match(frame?.body ?? '', /aspect-ratio:\s*3\s*\/\s*2/);
  assert.match(frame?.body ?? '', /overflow:\s*hidden/);
  assert.match(image?.body ?? '', /object-fit:\s*cover/, 'das Bild wird beschnitten, nicht gestaucht');
});

// ---------------------------------------------------------------------------
// TAFLA (2026-10-19): das Rezept weiss, was der Vorrat hat und was schon auf
// einer Liste steht ("masz 5 z 6", Haken/Ring, "na liście", "Dopisz 1").
// Eine bestaetigte Zuordnung (#1314) geht vor; sonst vergleicht der Name wie
// die Zutatenvorschlaege im Essensplan - nur fuer die Anzeige, nichts wird
// gespeichert. Ohne Vorratswissen (`pantry: null`) behauptet das Detail nichts.

// Die Seiten setzen Klassen ueber `classList`; der Mini-DOM kennt nur das
// Attribut. Derselbe duenne Aufsatz wie in test-kitchen-readonly-ui.js.
const { MiniElement: TaflaMini } = await import('./mini-dom.js');
if (!Object.getOwnPropertyDescriptor(TaflaMini.prototype, 'classList')) {
  Object.defineProperty(TaflaMini.prototype, 'classList', {
    get() {
      const el = this;
      const liste = () => el.className.split(/\s+/).filter(Boolean);
      const setze = (l) => { el.className = l.join(' '); };
      return {
        add: (...c) => setze([...new Set([...liste(), ...c])]),
        remove: (...c) => setze(liste().filter((k) => !c.includes(k))),
        contains: (c) => liste().includes(c),
        toggle: (c, an = !liste().includes(c)) => { if (an) setze([...new Set([...liste(), c])]); else setze(liste().filter((k) => k !== c)); return an; },
      };
    },
  });
}

// Eine Zutat ohne Zuordnung gibt ein leeres Fragment zurueck (pantryMatchEl).
globalThis.document.createDocumentFragment ??= () => ({ childNodes: [], dataset: {}, outerHTML: '' });

const TAFLA_REZEPT = {
  id: 41, title: 'Spaghetti', source: 'native', has_own_image: false, meal_types: ['dinner'],
  notes: '1. Kochen.\n2. Abgiessen.', cooked_count: 3, last_cooked_on: '2026-10-05',
  ingredients: [
    { name: 'Cebula', quantity: '1 szt.' },
    { name: 'Makaron  spaghetti', quantity: '250 g' },
    { name: 'Śmietanka 30%', quantity: '100 ml' },
    { name: 'Kapusta biała', quantity: '1 główka' },
  ],
};

async function mitKueche({ pantry = null, onList = null, lists = [] } = {}, fn) {
  const zuvor = { ...recipes.state };
  Object.assign(recipes.state, { pantry, onList, lists, plannedOn: new Map(), plannedRecipeIds: new Set() });
  try {
    return await fn();
  } finally {
    Object.assign(recipes.state, zuvor);
  }
}

const VORRAT = [
  { id: 1, key: 'cebula', stocked: true },
  { id: 2, key: 'makaron spaghetti', stocked: true },
  { id: 3, key: 'smietanka 30%', stocked: false },
];

test('Tafla: Vorrat und Liste je Zutat - Name gefaltet, bestaetigte Zuordnung zuerst', async () => {
  assert.equal(recipes.foldKey('  Śmietanka   30%'), 'smietanka 30%');
  assert.equal(recipes.foldKey('Żółty ser'), 'zolty ser');
  await mitKueche({ pantry: VORRAT, onList: new Set(['smietanka 30%']) }, () => {
    const s = TAFLA_REZEPT.ingredients.map((ing) => recipes.ingredientState(ing));
    assert.deepEqual(s.map((x) => x.have), [true, true, false, false], 'leerer Bestand zaehlt nicht als vorhanden');
    assert.deepEqual(s.map((x) => x.onList), [false, false, true, false]);
    assert.deepEqual(recipes.pantryTally(TAFLA_REZEPT), { have: 2, total: 4 });
    assert.deepEqual(recipes.missingIngredients(TAFLA_REZEPT).map((i) => i.name), ['Kapusta biała'],
      'was schon auf der Liste steht, ist nicht mehr "zu dopisz"');
    // "pomidory w puszce" findet "pomidory" (wie inPantry() am Server).
    assert.equal(recipes.ingredientState({ name: 'Cebula czerwona' }).have, true);
    // Die bestaetigte Zuordnung schlaegt den Namen: zeigt sie auf eine leere Zeile, fehlt die Zutat.
    assert.equal(recipes.ingredientState({ name: 'Cebula', pantry_item_id: 3 }).have, false);
  });
  await mitKueche({}, () => {
    assert.equal(recipes.ingredientState(TAFLA_REZEPT.ingredients[0]).have, null, 'unbekannt ist nicht fehlend');
    assert.equal(recipes.pantryTally(TAFLA_REZEPT), null);
    assert.deepEqual(recipes.missingIngredients(TAFLA_REZEPT), []);
  });
});

test('Tafla: "Dopisz N" schickt nur die fehlenden Namen, "Na listę zakupów" das ganze Rezept', async () => {
  const bodies = [];
  const zuvor = globalThis.__apiStub;
  globalThis.__apiStub = {
    post: async (path, body) => { bodies.push([path, body]); return { data: { transferred: 1, skipped: 0, added_ids: [9] } }; },
  };
  try {
    await withAccess(BEIDE, () => mitKueche({ pantry: VORRAT, onList: new Set(), lists: [{ id: 5, name: 'Cotygodniowe' }] }, async () => {
      await recipes.transferRecipe(TAFLA_REZEPT, null, { onlyMissing: true });
      await recipes.transferRecipe(TAFLA_REZEPT, null);
    }));
  } finally {
    globalThis.__apiStub = zuvor;
  }
  assert.deepEqual(bodies, [
    ['/recipes/41/to-shopping-list', { listId: 5, names: ['Śmietanka 30%', 'Kapusta biała'] }],
    ['/recipes/41/to-shopping-list', { listId: 5 }],
  ]);
});

test('Tafla: das Detail traegt Kopf, Zahlenreihe, Zeichen je Zutat und Kroki', async () => {
  const find = (node, cls, out = []) => {
    if (String(node?.className ?? '').split(' ').includes(cls)) out.push(node);
    for (const child of node?.childNodes ?? []) find(child, cls, out);
    return out;
  };
  await withAccess(BEIDE, () => mitKueche({ pantry: VORRAT, onList: new Set(['smietanka 30%']), lists: [{ id: 5, name: 'L' }] }, () => {
    const blatt = document.createElement('div');
    recipes.fillRecipeDetail(blatt, TAFLA_REZEPT, { variant: 'sheet' });
    const [hero, title, head] = blatt.childNodes;
    assert.match(hero.className, /recipe-view__hero/, 'das Blatt beginnt mit dem Kopfbild bzw. der warmen Flaeche');
    assert.equal(title.className, 'recipe-view__title');
    assert.equal(head.className, 'recipe-detail__head');
    assert.match(head.outerHTML, /recipes\.cookedTimes\{&quot;count&quot;:3\}|recipes\.cookedTimes\{"count":3\}/, '"Ugotowane 3×" aus dem Essensplan');
    assert.equal(find(blatt, 'recipe-detail__fact').length, 3, 'Zutaten, Schritte, masz');
    assert.equal(find(blatt, 'recipe-meter__seg').length, 4);
    assert.equal(find(blatt, 'recipe-meter__seg--missing').length, 2);
    const zeichen = find(blatt, 'recipe-detail__ingredient-status').map((el) => el.getAttribute('aria-label'));
    assert.deepEqual(zeichen, ['recipes.inPantry', 'recipes.inPantry', 'recipes.notInPantry', 'recipes.notInPantry']);
    assert.equal(find(blatt, 'recipe-detail__pill').length, 1, '"na liście" nur an der fehlenden Zutat auf der Liste');
    assert.equal(find(blatt, 'recipe-detail__add-missing').length, 1, '"Dopisz 1" im Kopf der Zutaten');
    assert.equal(find(blatt, 'recipe-detail__step').length, 2, 'Kroki aus der Notiz, wie im Kochmodus');
    assert.equal(find(blatt, 'recipe-detail__notes').length, 0, 'die Notiz steht nicht ein zweites Mal da');
    assert.equal(find(blatt, 'btn--secondary').some((b) => b.textContent.includes('cook.open')), false,
      'im Blatt ist Gotuj der eine Primaerknopf unten, kein zweiter Knopf im Inhalt');
  }));

  // Ohne Vorratswissen: keine Zeichen, kein Zaehler, kein "Dopisz".
  await withAccess(BEIDE, () => mitKueche({ lists: [{ id: 5, name: 'L' }] }, () => {
    const spalte = document.createElement('div');
    recipes.fillRecipeDetail(spalte, TAFLA_REZEPT);
    assert.equal(find(spalte, 'recipe-meter').length, 0);
    assert.equal(find(spalte, 'recipe-detail__add-missing').length, 0);
    assert.ok(find(spalte, 'recipe-detail__ingredient-status').every((el) => el.getAttribute('aria-hidden') === 'true'));
  }));
});

test('Tafla: "Gotowane ostatnio" - geplant ab heute und zuletzt gekocht, das Naechste zuerst', async () => {
  const { todayKey, addLocalDays } = await import('../public/utils/date.js');
  const heute = todayKey();
  const r = (id, extra = {}) => ({ id, title: `R${id}`, source: 'native', ingredients: [], meal_types: ['dinner'], ...extra });
  const liste = [
    r(1, { last_cooked_on: addLocalDays(heute, -20) }),
    r(2),
    r(3, { last_cooked_on: addLocalDays(heute, -1) }),
    r(4),
    r(5, { last_cooked_on: addLocalDays(heute, -3) }),
  ];
  await mitKueche({}, () => {
    recipes.state.plannedOn = new Map([[4, heute], [2, addLocalDays(heute, 2)]]);
    const order = recipes.recentRecipes(liste).map((e) => e.recipe.id);
    assert.deepEqual(order, [4, 3, 2, 5], 'heute geplant, gestern gekocht, uebermorgen, vor drei Tagen - hoechstens vier');
  });
});

test('Tafla: Mahlzeit-Chips nur fuer Mahlzeiten, die einen TEIL der Rezepte betreffen', async () => {
  await mitKueche({}, () => {
    const zuvor = recipes.state.recipes;
    try {
      recipes.state.recipes = [
        { id: 1, title: 'A', meal_types: ['dinner'] },
        { id: 2, title: 'B', meal_types: ['lunch', 'dinner'] },
      ];
      assert.deepEqual(recipes.mealFilterChoices().map((c) => c.key), ['lunch'],
        'Kolacja gilt fuer alle - ein Chip, der nichts filtert, entfaellt');
    } finally {
      recipes.state.recipes = zuvor;
    }
  });
});
