/**
 * Modul: Das Hoerblatt - eine Aufgabe sagen (Quick-Add, 2026-10-29, Entwurf TaskSpoken)
 * Zweck: Die Person spricht EINEN Satz; die Mitschrift steht live da
 *        ("Listening… say the task"), "Done" macht daraus einen Entwurf
 *        (utils/task-draft.js) und gibt ihn an den Aufrufer, der das Blatt
 *        "Neue Aufgabe" damit fuellt. Gespeichert wird hier NICHTS - erst der
 *        Tipp auf "Add task" im gefuellten Blatt speichert.
 *
 * Zwei Formen:
 *   - Zuhoeren (Safaris Erkennung, utils/speech.js): Status, Mitschrift
 *     (`aria-live="polite"`), Mikrofon-Ring, "Type instead" und "Done".
 *   - Textfeld, wenn der Browser nichts erkennen kann oder die Erkennung
 *     scheitert (verweigert, kein Dienst, kein Mikrofon, kein Netz - im
 *     installierten Web-App-Modus auf dem iPhone unzuverlaessig): ein Feld mit
 *     dem Hinweis "Tap the mic on your keyboard, then Done". Das Diktat der
 *     Tastatur fuellt das Feld, "Done" geht denselben Weg.
 *   "no-speech" und "aborted" bleiben beim Zuhoeren: der Status sagt es, ein
 *   Tipp auf den Ring hoert neu zu.
 *
 * Die Erkennung laeuft immer auf Polnisch (pl-PL), unabhaengig von der Sprache
 * der Oberflaeche. Sie startet beim Oeffnen und endet, sobald das Blatt zugeht,
 * "Done" oder "Type instead" getippt wird - kein Mikrofon bleibt offen.
 * Je "Done" EIN Aufruf an den Server; Zwischenstaende rufen nichts.
 *
 * `onDraft`/`onTypeInstead`/`onFail` kommen bei noch offenem Blatt: der
 * Aufrufer oeffnet, was folgt (ein neues Modal ersetzt dieses), oder schliesst
 * es selbst. `onCancel` kommt, wenn das Blatt ohne sie zugeht (x, Wischen, Esc).
 * Gibt `onDraft` ein Versprechen zurueck (das naechste Blatt laedt erst), dreht
 * "Done" weiter, bis es erfuellt ist.
 *
 * DIE WORTE DES BLATTS (`copy`): ohne Angabe sagt es eine Aufgabe ("Powiedz
 * zadanie") - das Mikrofon und "Powtórz" des Aufgabenblatts. Wo es mehr hoert
 * als eine Aufgabe ("Say it", die Mikrofone von Termin- und Einkaufsblatt),
 * gibt der Aufrufer `quickAddCopy()` mit: Titel, Status und Textfeld neutral
 * ("Powiedz", "Słucham… powiedz, co dodać").
 *
 * VON AUSSEN ("Say it" auf Heute, One Today Task 14) IST `startQuickAdd` DER
 * EINSTIEG: Safari startet die Erkennung nur innerhalb des Tipps. Das Blatt
 * und `start()` laufen deshalb im Aufruf selbst; was danach gebraucht wird,
 * laedt daneben (pages/tasks.js) oder nach dem Satz (Termin, Einkauf).
 */
import { t } from '/i18n.js';
import { openModal, closeModal, swapFieldsKeepingDirtyBase, btnLoading, captureModalContext, isOwnModalOpen } from '/components/modal.js';
import { esc } from '/utils/html.js';
import { errorSentence } from '/utils/friendly-error.js';
import { speechSupported, startListening } from '/utils/speech.js';
import { draftFromSentence } from '/utils/task-draft.js';
import { quickDraftFromSentence } from '/utils/quick-draft.js';

/** Fehler, nach denen ein neuer Versuch lohnt - alle anderen fuehren ins Textfeld. */
const RETRY_CODES = new Set(['no-speech', 'aborted']);

/** Die Worte fuer eine Aufgabe - ohne `copy` sagt das Blatt diese. */
function taskCopy() {
  return {
    title: t('tasks.dictation.title'),
    listening: t('tasks.dictation.listening'),
    textLabel: t('tasks.dictation.textLabel'),
  };
}

/**
 * Die neutralen Worte, wo das Blatt mehr hoert als eine Aufgabe: "Say it" und
 * die Mikrofone von Termin- und Einkaufsblatt.
 * @returns {{title: string, listening: string, textLabel: string}}
 */
export function quickAddCopy() {
  return {
    title: t('quickAdd.title'),
    listening: t('quickAdd.listening'),
    textLabel: t('quickAdd.textLabel'),
  };
}

function bodyHtml(mode, text, words) {
  if (mode === 'type') {
    return `
      <p class="dictation__status" id="dictation-hint" data-dictation-status>${esc(t('tasks.dictation.keyboardHint'))}</p>
      <label class="sr-only" for="dictation-text">${esc(words.textLabel)}</label>
      <textarea class="form-input dictation__text" id="dictation-text" rows="3" autocomplete="off"
                enterkeyhint="done" aria-describedby="dictation-hint">${esc(text)}</textarea>`;
  }
  return `
      <p class="dictation__status" role="status" data-dictation-status>${esc(words.listening)}</p>
      <p class="dictation__transcript" data-dictation-transcript aria-live="polite">${esc(text)}</p>
      <button type="button" class="dictation__mic" data-dictation-mic data-listening
              aria-label="${esc(t('tasks.dictation.stop'))}">
        <span class="dictation__mic-core"><i data-lucide="mic" class="icon-lg" aria-hidden="true"></i></span>
      </button>`;
}

function sheetHtml(mode, text, words) {
  return `
    <div class="dictation">
      <div class="dictation__body dictation__body--${mode}" data-dictation-body>${bodyHtml(mode, text, words)}</div>
      <div class="modal-panel__footer modal-panel__footer--plain dictation__footer">
        <button type="button" class="btn btn--secondary" data-dictation-type>${esc(t('tasks.dictation.typeInstead'))}</button>
        <button type="button" class="btn btn--primary" data-dictation-done>${esc(t('tasks.dictation.done'))}</button>
      </div>
    </div>`;
}

function wireDictationSheet(panel, {
  mode: startMode, initialText, members, onDraft, onTypeInstead, onCancel, onFail, win, post, toDraft, words,
}) {
  let mode = startMode;
  let heard = '';
  let listener = null;
  // Uebergeben oder geschlossen: ab hier geht nichts mehr an den Aufrufer.
  let over = false;
  let busy = false;

  const q = (sel) => panel.querySelector(sel);
  const setStatus = (text) => {
    const el = q('[data-dictation-status]');
    if (el) el.textContent = text;
  };
  const showHeard = (text) => {
    const el = q('[data-dictation-transcript]');
    if (el) el.textContent = text;
  };
  const setMic = (listening) => {
    const mic = q('[data-dictation-mic]');
    if (!mic) return;
    mic.toggleAttribute('data-listening', listening);
    mic.setAttribute('aria-label', t(listening ? 'tasks.dictation.stop' : 'tasks.sayAgain'));
  };
  const stopListening = () => {
    listener?.stop();
    listener = null;
  };

  /** Zuhoeren ist vorbei (Pause, "no-speech", Ring): was nun? */
  function settle() {
    stopListening();
    setMic(false);
    setStatus(heard ? t('tasks.dictation.heard') : t('tasks.dictation.noSpeech'));
  }

  function toTextBox() {
    stopListening();
    if (mode === 'type' || over) return;
    mode = 'type';
    const host = q('[data-dictation-body]');
    if (!host) return;
    // Das neue Feld kommt in die Dirty-Basis: erst eine Eingabe darin ist eine Aenderung.
    swapFieldsKeepingDirtyBase(panel, () => {
      host.replaceChildren();
      host.insertAdjacentHTML('beforeend', bodyHtml('type', heard || initialText, words));
      host.classList?.replace?.('dictation__body--listen', 'dictation__body--type');
    });
    q('#dictation-text')?.focus?.();
  }

  function listen() {
    stopListening();
    heard = '';
    showHeard('');
    setMic(true);
    setStatus(words.listening);
    listener = startListening({
      lang: 'pl-PL',
      onText(text) {
        heard = text;
        showHeard(text);
      },
      onEnd(text) {
        listener = null;
        if (text) heard = text;
        settle();
      },
      onError(code) {
        if (RETRY_CODES.has(code)) settle();
        else toTextBox();
      },
    }, win);
  }

  const currentText = () => String((mode === 'type' ? q('#dictation-text')?.value : heard) ?? '').trim();

  async function done() {
    if (over || busy) return;
    const sentence = currentText();
    if (!sentence) {
      if (mode === 'type') q('#dictation-text')?.focus?.();
      else settle();
      return;
    }
    stopListening();
    setMic(false);
    busy = true;
    const button = q('[data-dictation-done]');
    const release = button ? btnLoading(button) : null;
    let result;
    try {
      // Die Mitglieder duerfen nachkommen (startQuickAdd) - der lokale
      // Parser braucht sie, also erst sie, dann der Satz.
      const people = typeof members === 'function' ? await members() : members;
      result = await toDraft(sentence, { members: people, post });
    } catch (err) {
      result = { error: err };
    } finally {
      busy = false;
    }
    if (over) {
      release?.();
      return;
    }
    over = true;
    // "Done" dreht weiter, bis das naechste Blatt steht: wer es erst laden
    // muss ("Say it" -> Termin, Einkauf), gibt das Versprechen zurueck.
    const handed = result.error
      ? onFail(result.error)
      : onDraft(result.draft, { source: result.source, text: sentence, kind: result.kind });
    Promise.resolve(handed).then(() => release?.(), () => release?.());
  }

  function typeInstead() {
    if (over) return;
    stopListening();
    over = true;
    onTypeInstead(currentText());
  }

  panel.addEventListener('click', (e) => {
    const target = e.target;
    if (target?.closest?.('[data-dictation-done]')) { e.preventDefault?.(); done(); return; }
    if (target?.closest?.('[data-dictation-type]')) { e.preventDefault?.(); typeInstead(); return; }
    if (target?.closest?.('[data-dictation-mic]')) {
      e.preventDefault?.();
      // Waehrend "Done" laeuft, bleibt die Mitschrift, was gesendet wurde.
      if (busy || over) return;
      if (listener) settle();
      else listen();
    }
  });
  // Im Textfeld ist "Fertig" der Tastatur (Enter) dasselbe wie "Done".
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.target?.id !== 'dictation-text') return;
    e.preventDefault();
    done();
  });

  if (mode === 'listen') listen();

  return {
    close() {
      stopListening();
      if (over) return;
      over = true;
      onCancel();
    },
  };
}

/**
 * Oeffnet das Hoerblatt. Nur ueber openModal - das Modal ist ein einziger
 * Platz: was danach oeffnet, ersetzt es.
 *
 * @param {{initialText?: string,
 *          members?: Array<{id: number, display_name: string}>|(() => Promise<Array<object>>),
 *          onDraft?: (draft: object, meta: {source: 'ai'|'local', text: string, kind?: string}) => (void|Promise<unknown>),
 *          onTypeInstead?: (text: string) => void, onCancel?: () => void,
 *          onFail?: (err: Error) => void,
 *          win?: object, post?: (path: string, body: object) => Promise<any>,
 *          toDraft?: (sentence: string, opts: {members: Array<object>, post?: Function}) =>
 *            Promise<{draft: object, source: 'ai'|'local', kind?: string}>,
 *          copy?: {title?: string, listening?: string, textLabel?: string}|null}} opts
 *        `initialText` (der Titel des Blatts, aus dem diktiert wird) steht im
 *        Textfeld; beim Zuhoeren beginnt die Mitschrift leer und wird nur
 *        uebernommen, falls die Erkennung ins Textfeld wechselt.
 *        `members` darf eine Funktion sein, deren Promise "Done" abwartet;
 *        scheitert sie, kommt `onFail` statt `onDraft`.
 *        `toDraft` macht aus dem Satz den Entwurf (EIN Aufruf je "Done");
 *        ohne Angabe eine Aufgabe (draftFromSentence). Das Termin-Blatt gibt
 *        seinen eigenen mit (pages/calendar.js, `kind: 'event'`); liefert er
 *        eine `kind`, steht sie in `meta` von onDraft.
 *        `copy` sind die Worte des Blatts (Titel, Status beim Zuhoeren, Name
 *        des Textfelds), schon uebersetzt; ohne Angabe die einer Aufgabe,
 *        `quickAddCopy()` die neutralen.
 */
export function openDictationSheet({
  initialText = '', members = [], onDraft = () => {}, onTypeInstead = () => {}, onCancel = () => {},
  onFail = () => {}, win = globalThis.window, post, toDraft = draftFromSentence, copy = null,
} = {}) {
  const mode = speechSupported(win) ? 'listen' : 'type';
  const text = String(initialText ?? '').trim();
  const words = { ...taskCopy(), ...copy };
  let sheet = null;
  openModal({
    title: words.title,
    content: sheetHtml(mode, mode === 'type' ? text : '', words),
    onSave(panel) {
      sheet = wireDictationSheet(panel, {
        mode, initialText: text, members, onDraft, onTypeInstead, onCancel, onFail, win, post, toDraft, words,
      });
    },
    onClose() { sheet?.close(); },
  });
}

/** Welche Art in welches Modul schreibt: "Say it" oeffnet nur, was beschrieben werden darf. */
const KIND_MODULE = Object.freeze({ task: 'tasks', event: 'calendar', shopping: 'shopping' });
/** Laenger nimmt der Server keinen Titel (validate.js MAX_TITLE) - wie utils/quick-draft.js. */
const TITLE_MAX = 200;

/**
 * "Say it" ("Powiedz") von aussen - der Einstieg fuer das "+" auf Heute
 * (One Today, Task 14). EIN Satz wird, was er ist: eine Aufgabe, ein Termin
 * oder Einkauf (utils/quick-draft.js, ein Aufruf an /quick-add/parse, ohne KI
 * die lokale Regel). Das passende Blatt geht gefuellt auf, gesprochen (R11,
 * "Powtórz") und mit dem gehoerten Satz ueber den Feldern. Gespeichert wird
 * nichts - erst der Tipp im Blatt speichert.
 *
 * STATISCH IMPORTIEREN UND IM TIPP-HANDLER OHNE VORHERIGES `await` RUFEN:
 * das Hoerblatt geht in diesem Aufruf auf, und `start()` der Erkennung laeuft
 * darin - Safari startet sie nur innerhalb der Nutzergeste, sonst meldet sie
 * `not-allowed`, und es bliebe nur das Textfeld. Daneben laedt pages/tasks.js
 * (Mitglieder fuer die lokale Regel, das Blatt "Neue Aufgabe"), nur mit
 * Schreibrecht auf Aufgaben.
 * Termin- und Einkaufsblatt laden erst nach dem Satz; "Done" dreht so lange.
 *
 * NUR WAS BESCHRIEBEN WERDEN DARF (`access`, wie das Menue es kennt): ist die
 * Art des Satzes hier nur lesbar, oeffnet die Aufgabe mit dem Satz als Titel,
 * wenn Aufgaben beschreibbar sind - sonst sagt eine kurze Meldung es, und das
 * Hoerblatt geht. "Type instead" oeffnet das Blatt zum Tippen mit dem schon
 * Gesagten: die Aufgabe, sonst das erste beschreibbare (Termin, Einkauf).
 *
 * @param {{user?: object|null, onChanged?: () => (void|Promise<void>),
 *          access?: Record<string, 'write'|'read'|'none'>}} [opts]
 *        `user` ist der angemeldete Mensch (das Einkaufsblatt merkt sich seine
 *        Liste je Person), `onChanged` frischt die aufrufende Flaeche auf,
 *        `access` das Recht je Modul (tasks, calendar, shopping).
 * @param {{win?: object, post?: Function, loadTasks?: () => Promise<object>,
 *          loadCalendar?: () => Promise<object>, loadShopping?: () => Promise<object>}} [testing]
 * @returns {boolean} false, wenn nichts aufging (keine der drei Arten beschreibbar)
 */
export function startQuickAdd({ user = null, onChanged = () => {}, access = {} } = {}, {
  win = globalThis.window, post,
  loadTasks = () => import('/pages/tasks.js'),
  loadCalendar = () => import('/pages/calendar.js'),
  loadShopping = () => import('/components/shopping-add-sheet.js'),
} = {}) {
  const may = (kind) => access?.[KIND_MODULE[kind]] === 'write';
  if (!Object.keys(KIND_MODULE).some(may)) return false;
  // DANEBEN, NICHT DAVOR - kein await vor openDictationSheet.
  const tasksReady = may('task')
    ? Promise.resolve()
      .then(loadTasks)
      .then(async (tasks) => ({ tasks, members: await tasks.prepareNewTask({ user }) }))
    : null;
  tasksReady?.catch(() => {}); // gemeldet wird, wo es gebraucht wird
  // DAS HOERBLATT, DAS HIER AUFGEHT (#1997): wer es zumacht, bekommt kein
  // Blatt hinterher, und ein spaetes Schliessen trifft nur dieses.
  let context = null;
  const toast = (...args) => globalThis.window?.yuvomi?.showToast?.(...args);
  const fail = (fallbackKey) => (err) => {
    console.error('[Say it] Das Blatt konnte nicht geoeffnet werden:', err);
    closeModal({ force: true, context });
    toast(errorSentence(err, fallbackKey), 'danger');
  };
  const openTask = (opts) => tasksReady.then(({ tasks }) => {
    if (!isOwnModalOpen(context)) return;
    tasks.openPreparedNewTask({ onChanged, ...opts });
  }).catch(fail('tasks.loadError'));
  /**
   * Ob das Hoerblatt noch steht. Die Oeffner fragen es NACH ihrem eigenen
   * Laden (`stillWanted`): auf langsamem Netz kann es waehrenddessen zugehen.
   */
  const stillWanted = () => isOwnModalOpen(context);
  /** Termin- oder Einkaufsblatt: laden, dann oeffnen - wenn das Hoerblatt noch steht. */
  const openFrom = (load, open) => Promise.resolve()
    .then(load)
    .then(async (mod) => {
      if (!isOwnModalOpen(context)) return;
      // Oeffnet es nichts (keine Liste, nur lesend), sagte es selbst warum: das Hoerblatt geht.
      if (await open(mod) === false) closeModal({ force: true, context });
    })
    .catch(fail('common.errorGeneric'));
  /** Der Entwurf in sein Blatt; ist seine Art hier nur lesbar, die Aufgabe mit dem Satz als Titel. */
  const route = (kind, draft, heard) => {
    if (kind === 'event' && may('event')) {
      return openFrom(loadCalendar, (calendar) => calendar.openNewEventFrom({ user, onChanged, draft, spoken: true, heard, stillWanted }));
    }
    if (kind === 'shopping' && may('shopping')) {
      return openFrom(loadShopping, (sheet) => sheet.openShoppingAddFrom({ user, onChanged, draft, heard, stillWanted }));
    }
    if (may('task')) return openTask({ draft: kind === 'task' ? draft : { title: heard.slice(0, TITLE_MAX) }, spoken: true, heard });
    // Nichts hier darf diesen Satz aufnehmen: das sagt eine kurze Meldung.
    closeModal({ force: true, context });
    toast(t('quickAdd.noAccess'), 'info');
    return null;
  };
  /** "Type instead": das Blatt zum Tippen, mit dem schon Gesagten. */
  const typeInstead = (text) => {
    const draft = text ? { title: text } : null;
    if (may('task')) return openTask({ draft });
    if (may('event')) return openFrom(loadCalendar, (calendar) => calendar.openNewEventFrom({ user, onChanged, draft, stillWanted }));
    return openFrom(loadShopping, (sheet) => sheet.openShoppingAddFrom({ user, onChanged, typed: text, stillWanted }));
  };
  openDictationSheet({
    win,
    post,
    copy: quickAddCopy(),
    // Die Mitglieder braucht nur die lokale Regel; ohne Aufgabenseite geht es
    // ohne sie weiter, und erst ein Aufgabenblatt meldet den Fehler.
    members: () => (tasksReady ? tasksReady.then((r) => r.members, () => []) : []),
    toDraft: quickDraftFromSentence,
    onDraft: (draft, { kind, text }) => route(kind, draft, text),
    onTypeInstead: typeInstead,
    onFail: fail('common.errorGeneric'),
  });
  // Gleich nach dem Oeffnen: das Hoerblatt ist jetzt der offene Dialog.
  context = captureModalContext();
  return true;
}
