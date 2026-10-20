/**
 * Test: Navigations-Konfiguration in der Preferences-API
 * Zweck: Mobile-Favoriten werden normalisiert und benutzerspezifisch gespeichert.
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';

const { get } = await import('../server/db.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');

let currentUserId = 1;

function clearNavigationPreferences() {
  get().prepare(`
    DELETE FROM sync_config
    WHERE key = 'mobile_nav_order'
       OR key LIKE 'mobile_nav_order:user:%'
  `).run();
}

function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = currentUserId;
    req.authRole = 'admin';
    next();
  });
  app.use('/', preferencesRouter);

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

test.beforeEach(() => {
  clearNavigationPreferences();
  currentUserId = 1;
});

test('GET /preferences returns an empty mobile order by default', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const response = await fetch(`${baseUrl}/`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.data.mobile_nav_order, []);
  } finally {
    await close();
  }
});

test('PUT /preferences stores three normalized mobile favorites per user', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const response = await fetch(`${baseUrl}/`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mobile_nav_order: ['recipes', 'tasks', 'meals', 'calendar', 'budget'],
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.data.mobile_nav_order, ['kitchen', 'tasks', 'calendar']);

    currentUserId = 2;
    const secondUserResponse = await fetch(`${baseUrl}/`);
    const secondUserBody = await secondUserResponse.json();
    assert.deepEqual(secondUserBody.data.mobile_nav_order, []);

    currentUserId = 1;
    const firstUserResponse = await fetch(`${baseUrl}/`);
    const firstUserBody = await firstUserResponse.json();
    assert.deepEqual(firstUserBody.data.mobile_nav_order, ['kitchen', 'tasks', 'calendar']);
  } finally {
    await close();
  }
});

test('PUT /preferences rejects a non-array mobile order', async () => {
  const { baseUrl, close } = await startApp();
  try {
    const response = await fetch(`${baseUrl}/`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile_nav_order: 'calendar,tasks,kitchen' }),
    });

    assert.equal(response.status, 400);
  } finally {
    await close();
  }
});

/*
 * Więcej (Tafla): the "Przypięte" tiles are chosen per person. `null` means
 * "never chosen" (the page takes its default), an array is a choice - known
 * tiles only, no doubles, at most four.
 */
test('more_pins is per person, normalized, and null until chosen', async () => {
  get().prepare("DELETE FROM sync_config WHERE key LIKE 'more_pins:user:%' OR key = 'more_pins'").run();
  const { baseUrl, close } = await startApp();
  const put = (body) => fetch(`${baseUrl}/`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await (await fetch(`${baseUrl}/`)).json()).data.more_pins, null);

    const saved = await put({ more_pins: ['budget', 'nope', 'budget', 'notes', 'waste', 'health', 'documents'] });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).data.more_pins, ['budget', 'notes', 'waste', 'health']);

    currentUserId = 2;
    assert.equal((await (await fetch(`${baseUrl}/`)).json()).data.more_pins, null);
    assert.deepEqual((await (await put({ more_pins: [] })).json()).data.more_pins, []);

    currentUserId = 1;
    assert.equal((await put({ more_pins: 'notes' })).status, 400);
    assert.equal((await (await put({ more_pins: null })).json()).data.more_pins, null);
  } finally {
    await close();
  }
});
