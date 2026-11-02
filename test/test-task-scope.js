/**
 * Modul: Aufgaben-Auswahl, geteilt zwischen Modul und Übersicht (#825)
 * Zweck: Die Frage, die keine der beiden Seiten allein beantworten kann -
 *        zeigen `GET /api/v1/tasks` und `GET /api/v1/dashboard` dieselben
 *        Aufgaben?
 *
 *        Sie taten es nicht. Das Modul schloss Unteraufgaben (`parent_task_id
 *        IS NULL`) und noch nicht begonnene Aufgaben (`start_date`) aus, die
 *        Übersicht kannte beide Regeln nicht: eine Unteraufgabe stand dort als
 *        kontextlose eigene Zeile, eine Aufgabe mit Startdatum nächste Woche
 *        stand heute schon da, und die Kennzahl-Kacheln zählten beides mit.
 *        Beide Seiten waren für sich grün - der Fehler lag im Unterschied.
 *
 *        Der Test misst deshalb BEIDE echten Router gegen DENSELBEN Bestand
 *        und vergleicht ihre Antworten miteinander, statt jede für sich gegen
 *        eine erwartete Liste zu prüfen. Eine Zusicherung über nur eine Seite
 *        hätte die Divergenz nie sehen können.
 *
 * Ausführen: npm run test:task-scope
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'task-scope-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { taskScopeWhere, taskScopeNeedsToday } = await import('../server/services/task-scope.js');

const moduleDatabase = get();
const db = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(db);
moduleDatabase.close();

function buildMigratedDatabase(migrations) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) {
    if (typeof migration.up === 'function') migration.up(database);
    else database.exec(migration.up);
    if (typeof migration.afterUp === 'function') migration.afterUp(database);
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  }
  return database;
}

// Lokaler Kalendertag, nicht der UTC-Tag: `start_date` ist ein lokal
// eingegebener Tag, und westlich von UTC sind das am Abend zwei verschiedene.
// Genau diese Sorte Fehler ist in der UTC-CI unsichtbar.
const now = new Date();
const localKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (n) => localKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n));
const TODAY = localKey(now);
const TOMORROW = addDays(1);
const NEXT_WEEK = addDays(7);
const YESTERDAY = addDays(-1);

const ALICE = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, avatar_color, role)
  VALUES (?, 'Alice', 'hash', '#007AFF', 'admin')
`).run(`alice-${randomUUID()}`).lastInsertRowid;

// --------------------------------------------------------------------------
// Bestand. Vier Aufgaben, die genau die strittigen Achsen abdecken - jede mit
// einer Fälligkeit HEUTE, damit sie es an allen Zeitfiltern der Übersicht
// vorbeischafft und wirklich nur die Auswahlregel über sie entscheidet.
// --------------------------------------------------------------------------
const insertTask = db.prepare(`
  INSERT INTO tasks (title, priority, status, due_date, start_date, parent_task_id, visibility, created_by)
  VALUES (?, 'high', 'open', ?, ?, ?, 'all', ?)
`);

const PARENT_ID = insertTask.run('Umzug vorbereiten', TODAY, null, null, ALICE).lastInsertRowid;
const SUBTASK_ID = insertTask.run('Kartons kaufen', TODAY, null, PARENT_ID, ALICE).lastInsertRowid;
const FUTURE_ID = insertTask.run('Erst nächste Woche', TODAY, NEXT_WEEK, null, ALICE).lastInsertRowid;
const STARTED_ID = insertTask.run('Läuft seit gestern', TODAY, YESTERDAY, null, ALICE).lastInsertRowid;

// Eine erledigte Unteraufgabe: `tasksDoneToday` ist die Kennzahl „heute
// geschafft", und eine abgehakte Unteraufgabe darf dort nicht als eigene
// Tagesleistung zählen, wenn sie in keiner Liste steht.
const parentDone = insertTask.run('Küche streichen', TODAY, null, null, ALICE).lastInsertRowid;
const doneSubtask = insertTask.run('Farbe besorgen', TODAY, null, parentDone, ALICE).lastInsertRowid;
db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(doneSubtask);

// --------------------------------------------------------------------------
// Beide echten Router am selben Bestand.
// --------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = ALICE;
  req.authRole = 'admin';
  req.session = { userId: ALICE, role: 'admin' };
  req.sessionModuleAccess = null;
  next();
});
app.use('/api/v1/tasks', tasksRouter);
app.use('/api/v1/dashboard', dashboardRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;

test.after(() => { server.close(); db.close(); });

const moduleTasks = async (query = '') => (await (await fetch(`${base}/tasks${query}`)).json()).data;
const dashboard = async (query = '') => (await fetch(`${base}/dashboard${query}`)).json();

// --------------------------------------------------------------------------
// Vorbedingung. OHNE SIE IST JEDE ZUSICHERUNG UNTEN WERTLOS: wenn die
// Übersicht ohnehin nichts oder etwas anderes ausliefert, sagt die
// Abwesenheit einer Unteraufgabe nichts über die Auswahlregel aus.
// --------------------------------------------------------------------------
test('Vorbedingung: beide Wege liefern überhaupt Aufgaben, und die normale ist in beiden', async () => {
  const listed = await moduleTasks();
  const body = await dashboard();

  assert.ok(listed.some((t) => t.id === PARENT_ID), 'das Modul listet die gewöhnliche Aufgabe');
  assert.ok(body.urgentTasks.some((t) => t.id === PARENT_ID), 'die Übersicht zeigt die gewöhnliche Aufgabe');
  assert.ok(body.urgentTasks.length > 0, 'die Übersicht ist nicht generell leer');
});

// --------------------------------------------------------------------------
// Die eigentliche Zusicherung: die Auswahl ist DIESELBE. Sie ist bewusst als
// Vergleich formuliert und nicht als zwei Listen von Ids - so deckt sie auch
// jede künftige Auswahlregel ab, die nur eine der beiden Seiten bekommt.
// --------------------------------------------------------------------------
test('Übersicht und Modul treffen dieselbe Auswahl', async () => {
  const listedIds = new Set((await moduleTasks()).map((t) => t.id));
  const body = await dashboard();

  for (const task of body.urgentTasks) {
    assert.ok(
      listedIds.has(task.id),
      `Die Übersicht zeigt "${task.title}" (id ${task.id}), das Aufgabenmodul listet sie nicht - `
      + 'die beiden Auswahlregeln sind auseinandergelaufen (#825).',
    );
  }
});

test('Eine Unteraufgabe ist kein eigener Eintrag der Übersicht', async () => {
  const body = await dashboard();
  assert.ok(
    !body.urgentTasks.some((t) => t.id === SUBTASK_ID),
    'die Unteraufgabe stand ohne die Aufgabe, zu der sie gehört, als eigene Zeile in der Übersicht',
  );
});

test('Was erst später beginnt, steht heute in keiner der beiden Listen', async () => {
  const listed = await moduleTasks();
  const body = await dashboard();

  assert.ok(!listed.some((t) => t.id === FUTURE_ID), 'Vorbedingung: das Modul blendet sie aus');
  assert.ok(
    !body.urgentTasks.some((t) => t.id === FUTURE_ID),
    'die erst nächste Woche beginnende Aufgabe stand schon heute in der Übersicht',
  );
  assert.ok(
    body.urgentTasks.some((t) => t.id === STARTED_ID),
    'eine bereits begonnene Aufgabe muss bleiben - sonst filtert die Regel zu scharf',
  );
});

// --------------------------------------------------------------------------
// Die Kacheln sind der Teil, den ein reiner Listen-Test durchgehen ließe:
// `urgentTasks` deckelt bei 5, die Zahlen zählen unbegrenzt. Liefe der Filter
// nur auf der Liste, stünden zwei Zeilen unter einer Kachel, die vier sagt.
// --------------------------------------------------------------------------
test('Die Kennzahlen zählen dieselbe Grundgesamtheit wie die Liste', async () => {
  const body = await dashboard();
  const listed = await moduleTasks();
  const openInModule = listed.filter((t) => t.status !== 'done').length;

  assert.equal(
    body.openTaskCount, openInModule,
    'die Kachel „offen" zählt andere Aufgaben, als das Modul listet - Unteraufgaben oder '
    + 'noch nicht begonnene laufen in der Zahl mit',
  );
  assert.equal(body.tasksDoneToday, 0, 'eine abgehakte Unteraufgabe ist keine eigene Tagesleistung');
});

// --------------------------------------------------------------------------
// Der Fragmentbauer selbst. Die Zusicherung ist nicht die genaue SQL-Form,
// sondern dass das Fragment an JEDER Aufrufstelle verkettbar bleibt - ein
// leerer String ergäbe beim Aufrufer ein blankes `AND` und damit einen
// Syntaxfehler statt einer falschen Antwort.
// --------------------------------------------------------------------------
test('Das Scope-Fragment bleibt in jeder Kombination verkettbar', () => {
  const combos = [
    {}, { includeFuture: true }, { includeSubtasks: true },
    { includeFuture: true, includeSubtasks: true },
  ];
  for (const opts of combos) {
    const sql = taskScopeWhere('t', opts);
    assert.ok(sql.trim().length > 0, `leeres Fragment für ${JSON.stringify(opts)}`);
    db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${sql}`).get(
      ...(taskScopeNeedsToday(opts) ? [TODAY] : []),
    );
  }
});

test('Der Tagesschlüssel wird gebunden, nicht aus SQLite genommen', () => {
  // `date('now')` wäre der UTC-Tag gegen ein lokal eingegebenes `start_date`.
  // Der Beweis, dass gebunden wird: ein anderer Tag ändert die Antwort.
  const sql = taskScopeWhere('t', { bind: '@today' });
  const count = (today) => db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${sql}`).get({ today }).n;

  assert.ok(count(NEXT_WEEK) > count(TOMORROW), 'ein späterer Stichtag muss mehr Aufgaben einschließen');
  assert.ok(!taskScopeNeedsToday({ includeFuture: true }), 'ohne Startdatum-Filter ist kein Bind fällig');
});
