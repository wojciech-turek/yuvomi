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
 *
 * VON AUSSEN ("Say a task" auf Heute) IST `startTaskDictation` DER EINSTIEG:
 * Safari startet die Erkennung nur innerhalb des Tipps. Das Blatt und
 * `start()` laufen deshalb im Aufruf selbst; was das Blatt "Neue Aufgabe"
 * braucht (pages/tasks.js, Stile, Mitglieder, Kategorien), laedt daneben und
 * wird erst bei "Done" abgewartet.
 */
import { t } from '/i18n.js';
import { openModal, closeModal, swapFieldsKeepingDirtyBase, btnLoading } from '/components/modal.js';
import { isNavModuleReadOnly } from '/permissions.js';
import { esc } from '/utils/html.js';
import { speechSupported, startListening } from '/utils/speech.js';
import { draftFromSentence } from '/utils/task-draft.js';

/** Fehler, nach denen ein neuer Versuch lohnt - alle anderen fuehren ins Textfeld. */
const RETRY_CODES = new Set(['no-speech', 'aborted']);

function bodyHtml(mode, text) {
  if (mode === 'type') {
    return `
      <p class="dictation__status" id="dictation-hint" data-dictation-status>${esc(t('tasks.dictation.keyboardHint'))}</p>
      <label class="sr-only" for="dictation-text">${esc(t('tasks.dictation.textLabel'))}</label>
      <textarea class="form-input dictation__text" id="dictation-text" rows="3" autocomplete="off"
                enterkeyhint="done" aria-describedby="dictation-hint">${esc(text)}</textarea>`;
  }
  return `
      <p class="dictation__status" role="status" data-dictation-status>${esc(t('tasks.dictation.listening'))}</p>
      <p class="dictation__transcript" data-dictation-transcript aria-live="polite">${esc(text)}</p>
      <button type="button" class="dictation__mic" data-dictation-mic data-listening
              aria-label="${esc(t('tasks.dictation.stop'))}">
        <span class="dictation__mic-core"><i data-lucide="mic" class="icon-lg" aria-hidden="true"></i></span>
      </button>`;
}

function sheetHtml(mode, text) {
  return `
    <div class="dictation">
      <div class="dictation__body dictation__body--${mode}" data-dictation-body>${bodyHtml(mode, text)}</div>
      <div class="modal-panel__footer modal-panel__footer--plain dictation__footer">
        <button type="button" class="btn btn--secondary" data-dictation-type>${esc(t('tasks.dictation.typeInstead'))}</button>
        <button type="button" class="btn btn--primary" data-dictation-done>${esc(t('tasks.dictation.done'))}</button>
      </div>
    </div>`;
}

function wireDictationSheet(panel, { mode: startMode, initialText, members, onDraft, onTypeInstead, onCancel, onFail, win, post }) {
  let mode = startMode;
  let heard = '';
  let listener = null;
  // Uebergeben oder geschlossen: ab hier geht nichts mehr an den Aufrufer.
  let over = false;
  let busy = false;

  const q = (sel) => panel.querySelector(sel);
  const setStatus = (key) => {
    const el = q('[data-dictation-status]');
    if (el) el.textContent = t(key);
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
    setStatus(heard ? 'tasks.dictation.heard' : 'tasks.dictation.noSpeech');
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
      host.insertAdjacentHTML('beforeend', bodyHtml('type', heard || initialText));
      host.classList?.replace?.('dictation__body--listen', 'dictation__body--type');
    });
    q('#dictation-text')?.focus?.();
  }

  function listen() {
    stopListening();
    heard = '';
    showHeard('');
    setMic(true);
    setStatus('tasks.dictation.listening');
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
      // Die Mitglieder duerfen nachkommen (startTaskDictation) - der lokale
      // Parser braucht sie, also erst sie, dann der Satz.
      const people = typeof members === 'function' ? await members() : members;
      result = await draftFromSentence(sentence, { members: people, post });
    } catch (err) {
      result = { error: err };
    } finally {
      busy = false;
      release?.();
    }
    if (over) return;
    over = true;
    if (result.error) onFail(result.error);
    else onDraft(result.draft, { source: result.source, text: sentence });
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
 *          onDraft?: (draft: object, meta: {source: 'ai'|'local', text: string}) => void,
 *          onTypeInstead?: (text: string) => void, onCancel?: () => void,
 *          onFail?: (err: Error) => void,
 *          win?: object, post?: (path: string, body: object) => Promise<any>}} opts
 *        `initialText` (der Titel des Blatts, aus dem diktiert wird) steht im
 *        Textfeld; beim Zuhoeren beginnt die Mitschrift leer und wird nur
 *        uebernommen, falls die Erkennung ins Textfeld wechselt.
 *        `members` darf eine Funktion sein, deren Promise "Done" abwartet;
 *        scheitert sie, kommt `onFail` statt `onDraft`.
 */
export function openDictationSheet({
  initialText = '', members = [], onDraft = () => {}, onTypeInstead = () => {}, onCancel = () => {},
  onFail = () => {}, win = globalThis.window, post,
} = {}) {
  const mode = speechSupported(win) ? 'listen' : 'type';
  const text = String(initialText ?? '').trim();
  let sheet = null;
  openModal({
    title: t('tasks.dictation.title'),
    content: sheetHtml(mode, mode === 'type' ? text : ''),
    onSave(panel) {
      sheet = wireDictationSheet(panel, {
        mode, initialText: text, members, onDraft, onTypeInstead, onCancel, onFail, win, post,
      });
    },
    onClose() { sheet?.close(); },
  });
}

/**
 * "Say a task" von aussen - der Einstieg fuer das "+" auf Heute.
 *
 * STATISCH IMPORTIEREN UND IM TIPP-HANDLER OHNE VORHERIGES `await` RUFEN:
 * das Hoerblatt geht in diesem Aufruf auf, und `start()` der Erkennung laeuft
 * darin - Safari startet sie nur innerhalb der Nutzergeste, sonst meldet sie
 * `not-allowed`, und es bliebe nur das Textfeld. pages/tasks.js samt Stilen,
 * Mitgliedern und Kategorien laedt daneben (`prepareNewTask`); "Done" wartet
 * darauf und oeffnet dann das gefuellte Blatt "Neue Aufgabe" (`spoken`),
 * "Type instead" das Blatt zum Tippen mit dem schon Gesagten als Titel. Kann
 * die Seite nicht laden (offline ohne Cache, keine Kategorien), geht das
 * Hoerblatt zu, und eine Meldung sagt es - gespeichert wird nie etwas.
 *
 * @param {{user?: object|null, onChanged?: () => (void|Promise<void>)}} [opts]
 *        `user` ist der angemeldete Mensch der aufrufenden Seite, `onChanged`
 *        frischt deren Flaeche nach dem Speichern auf.
 * @param {{win?: object, post?: Function, loadTasks?: () => Promise<object>}} [testing]
 * @returns {boolean} false, wenn nichts aufging (Aufgaben nur lesbar)
 */
export function startTaskDictation({ user = null, onChanged = () => {} } = {}, {
  win = globalThis.window, post, loadTasks = () => import('/pages/tasks.js'),
} = {}) {
  if (isNavModuleReadOnly('tasks')) return false;
  // DANEBEN, NICHT DAVOR - kein await vor openDictationSheet.
  const ready = Promise.resolve()
    .then(loadTasks)
    .then(async (tasks) => ({ tasks, members: await tasks.prepareNewTask({ user }) }));
  ready.catch(() => {}); // gemeldet wird, wo es gebraucht wird
  const fail = (err) => {
    console.error('[Dictation] Neue Aufgabe konnte nicht geoeffnet werden:', err);
    closeModal({ force: true });
    globalThis.window?.yuvomi?.showToast?.(err?.message || t('tasks.loadError'), 'danger');
  };
  const openSheet = (opts) => ready.then(({ tasks }) => tasks.openPreparedNewTask({ onChanged, ...opts })).catch(fail);
  openDictationSheet({
    win,
    post,
    members: () => ready.then((r) => r.members),
    onDraft: (draft) => { openSheet({ draft, spoken: true }); },
    onTypeInstead: (text) => { openSheet({ draft: text ? { title: text } : null }); },
    onFail: fail,
  });
  return true;
}
