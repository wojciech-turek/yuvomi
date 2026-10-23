/**
 * Test: The per-display screensaver switch on the wall tablets page (#1766)
 * Purpose: An administrator decides per display whether it shows the photo
 *          screensaver (the server side, gate and route, is measured in
 *          test:display-account). Tested here: the card renders the switch in
 *          the state the server reports, the real page wires it, a change sends
 *          exactly `{ show_screensaver }` to that display and confirms it, and a
 *          failed request puts the switch back and says why.
 * Run: npm run test:display-screensaver-switch (needs
 *      test/test-browser-loader.mjs for /api.js, /i18n.js and the modal)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const toasts = [];
const patches = [];
let patchResult = () => Promise.resolve({ data: {} });

globalThis.window = {
  yuvomi: { showToast: (message, type) => toasts.push({ message, type }) },
};
globalThis.__apiStub = {
  get: async () => ({ data: [] }),
  patch: (path, body) => { patches.push({ path, body }); return patchResult(path, body); },
};

const page = await import('../public/settings/pages/admin-displays.js');

function makeToggle({ id = '7', name = 'Kitchen', checked = true } = {}) {
  return { checked, disabled: false, dataset: { displayScreensaver: id, name } };
}

function makeList() {
  const handlers = {};
  return {
    handlers,
    addEventListener(name, handler) { (handlers[name] ||= []).push(handler); },
    replaceChildren() {},
    insertAdjacentHTML() {},
    querySelector: () => null,
  };
}

const errorEl = () => ({ textContent: '', hidden: true });
const changeOn = (toggle) => ({ target: { closest: (selector) => (selector === '[data-display-screensaver]' ? toggle : null) } });

async function fire(list, event) {
  await Promise.all((list.handlers.change || []).map((handler) => handler(event)));
}

// TAFLA (2026-10-19): the switch moved from the display's card into the group
// "Na ścianie" of the "Tablet w kuchni" page ("Zdjęcia z albumu"); one row per
// display, named when there is more than one.
test('the switch shows the state the server reports', () => {
  const off = page.renderPhotoSwitch({ id: 7, display_name: 'Kitchen', show_screensaver: false, devices: [] });
  const input = off.match(/<input[^>]*id="display-screensaver-7"[^>]*>/)?.[0];
  assert.ok(input, 'one switch per display, with its own id');
  assert.match(input, /role="switch"/);
  assert.match(input, /data-display-screensaver="7"/);
  assert.doesNotMatch(input, /\schecked\b/, 'off as reported');
  assert.match(off, /settings\.tabletPhotos</, 'labelled as on the artboard');
  assert.match(off, /id="display-screensaver-hint-7"[^>]*>settings\.displayScreensaverHint</);

  const on = page.renderPhotoSwitch({ id: 8, display_name: 'Hall <b>', show_screensaver: true, devices: [] }, { named: true });
  const onInput = on.match(/<input[^>]*id="display-screensaver-8"[^>]*>/)?.[0];
  assert.match(onInput, /\schecked\b/, 'on as reported');
  assert.match(onInput, /data-name="Hall &lt;b&gt;"/, 'the name is escaped');
  assert.match(on, /settings\.tabletPhotosNamed\{&quot;name&quot;:&quot;Hall &lt;b&gt;&quot;\}/, 'with several tablets each row names its tablet');
});

test('the real page wires the switch to the list', async () => {
  const list = makeList();
  const nodes = {
    '#display-list': list,
    '#display-error': errorEl(),
  };
  const container = {
    replaceChildren() {},
    insertAdjacentHTML() {},
    querySelector: (selector) => nodes[selector] ?? null,
  };
  await page.render(container);
  // Two change handlers on the list: the photo switch per display (this one)
  // and the household's wall switches (sections and "Pozwól odhaczać").
  assert.equal(list.handlers.change?.length, 2, 'render() binds the photo switch and the wall switches once each');

  patches.length = 0;
  toasts.length = 0;
  await fire(list, changeOn(makeToggle({ id: '7', checked: true })));
  assert.deepEqual(patches, [{ path: '/displays/7', body: { show_screensaver: true } }]);
});

test('a change sends exactly that display\'s choice and confirms it', async () => {
  const list = makeList();
  page.bindDisplayScreensaverSwitches(list, errorEl());
  patches.length = 0;
  toasts.length = 0;

  const toggle = makeToggle({ id: '7', name: 'Kitchen', checked: false });
  await fire(list, changeOn(toggle));
  assert.deepEqual(patches, [{ path: '/displays/7', body: { show_screensaver: false } }]);
  assert.deepEqual(toasts, [{ message: 'settings.displayScreensaverOff{"name":"Kitchen"}', type: 'success' }]);
  assert.equal(toggle.checked, false);
  assert.equal(toggle.disabled, false, 'usable again afterwards');

  toggle.checked = true;
  await fire(list, changeOn(toggle));
  assert.deepEqual(patches.at(-1), { path: '/displays/7', body: { show_screensaver: true } });
  assert.equal(toasts.at(-1).message, 'settings.displayScreensaverOn{"name":"Kitchen"}');

  // Any other change in the list (there is none today) is not this switch.
  patches.length = 0;
  await fire(list, changeOn(null));
  assert.equal(patches.length, 0);
});

test('the switch is locked while its request runs, and a new change clears an old error', async () => {
  const list = makeList();
  const error = { textContent: 'Display not found.', hidden: false };
  page.bindDisplayScreensaverSwitches(list, error);
  let release;
  patchResult = () => new Promise((resolve) => { release = resolve; });
  try {
    const toggle = makeToggle({ checked: true });
    const pending = fire(list, changeOn(toggle));
    assert.equal(toggle.disabled, true, 'a second flip cannot race the first request');
    assert.equal(error.hidden, true, 'the error from before is gone');
    assert.equal(error.textContent, '');
    release({ data: {} });
    await pending;
    assert.equal(toggle.disabled, false);
  } finally {
    patchResult = () => Promise.resolve({ data: {} });
  }
});

test('a failed request puts the switch back and says why', async () => {
  const list = makeList();
  const error = errorEl();
  page.bindDisplayScreensaverSwitches(list, error);
  toasts.length = 0;
  patchResult = () => Promise.reject(new Error('Display not found.'));
  try {
    const toggle = makeToggle({ checked: true });
    await fire(list, changeOn(toggle));
    assert.equal(toggle.checked, false, 'back to the state the server still has');
    assert.equal(toggle.disabled, false);
    assert.equal(error.hidden, false);
    assert.equal(error.textContent, 'Display not found.');
    assert.equal(toasts.length, 0, 'no confirmation for a change that did not happen');
  } finally {
    patchResult = () => Promise.resolve({ data: {} });
  }
});

// --------------------------------------------------------
// Tafla: the household's wall switches on "Tablet w kuchni"
// --------------------------------------------------------

test('"Na ścianie" offers exactly the sections the wall draws, "Dotyk" the ticking switch (off by default)', () => {
  const { renderBody, WALL_SECTIONS } = page.__test;
  assert.deepEqual(WALL_SECTIONS.map((s) => s.id), ['dinner', 'plan', 'shopping', 'timers', 'weather'],
    'the same ids as utils/wall-plan.js and services/wall-settings.js');
  const html = renderBody({
    displays: [{ id: 7, display_name: 'Kuchnia', show_screensaver: false, devices: [{ id: 1, last_seen_at: null }] }],
    prefs: { wall_sections: { dinner: true, plan: true, shopping: false, timers: true, weather: true }, wall_allow_ticking: false },
  });
  const sectionInputs = [...html.matchAll(/<input[^>]*data-wall-section="([a-z]+)"[^>]*>/g)];
  assert.deepEqual(sectionInputs.map((m) => m[1]), ['dinner', 'plan', 'shopping', 'timers', 'weather']);
  assert.ok(!/\schecked\b/.test(sectionInputs[2][0]), 'shopping off as stored');
  assert.ok(/\schecked\b/.test(sectionInputs[0][0]), 'dinner on as stored');
  const ticking = html.match(/<input[^>]*data-wall-ticking[^>]*>/)?.[0] ?? '';
  assert.ok(ticking, 'the ticking switch is there');
  assert.ok(!/\schecked\b/.test(ticking), 'and off - the wall only shows');
  assert.match(html, /settings\.tabletTickingOff/);
  assert.match(html, /settings\.tabletTouchFooter/, 'Gotuj and the timers always work, said under the switch');
  assert.match(html, /data-display-revoke="7"/, 'the paired device can be unpaired');
  assert.match(html, /data-display-pair="7"/, 'and a new code issued');
});

test('a wall switch writes the household choice and nothing else', async () => {
  const puts = [];
  globalThis.__apiStub.put = async (path, body) => { puts.push({ path, body }); return { data: { wall_sections: { dinner: true, plan: true, shopping: false, timers: true, weather: true }, wall_allow_ticking: false } }; };
  const list = makeList();
  const container = {
    replaceChildren() {},
    insertAdjacentHTML() {},
    querySelector: (selector) => ({ '#display-list': list, '#display-error': errorEl() })[selector] ?? null,
  };
  await page.render(container);
  const section = { checked: false, disabled: false, dataset: { wallSection: 'shopping' } };
  const fire2 = (toggle, attr) => Promise.all((list.handlers.change || []).map((handler) => handler({
    target: { closest: (selector) => (selector === attr ? toggle : null) },
  })));
  await fire2(section, '[data-wall-section]');
  assert.deepEqual(puts, [{ path: '/preferences', body: { wall_sections: { shopping: false } } }]);
  const ticking = { checked: true, disabled: false, dataset: {} };
  await fire2(ticking, '[data-wall-ticking]');
  assert.deepEqual(puts.at(-1), { path: '/preferences', body: { wall_allow_ticking: true } });
  delete globalThis.__apiStub.put;
});
