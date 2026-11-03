/**
 * Modul: Die Bausteine der Blaetter "Neue Aufgabe", "Neuer Termin", "Zakupy" (One Today, Task 9)
 * Zweck: Das Blatt "Neue Aufgabe" (pages/tasks.js) ist das Vorbild. Was an ihm
 *        nicht nur Aufgabe ist, steht hier und wird von den anderen Blaettern
 *        geteilt: Abschnittskopf, Abschnitt, kompakte Zeile eines Diktats,
 *        "+"-Chip, Titelfeld mit Mikrofon und die Zeile mit dem gehoerten Satz.
 *        Das Markup ist Byte fuer Byte das, was tasks.js davor selbst baute
 *        (test:sheet-parts); die Regeln dazu stehen in layout.css, nicht in
 *        tasks.css - das laedt nur auf /tasks.
 * Abhaengigkeiten: /i18n.js, /utils/html.js
 */
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

/** Lucide-Zeichen der drei kleinen Knoepfe des Aufgabenblatts (Vorgabe der Chips). */
export const SHEET_ICONS = Object.freeze({ due: 'calendar', reminder: 'bell', note: 'pencil' });

/** Abschnittskopf: Titel links, rechts "Entfernen" (`removable`). */
export function sheetSectionHead(name, titleHtml, { removable = true } = {}) {
  return `
          <div class="task-sheet__section-head">
            ${titleHtml}
            ${removable ? `<button type="button" class="task-sheet__remove" data-remove="${name}">${t('tasks.removeField')}</button>` : ''}
          </div>`;
}

/**
 * Ein Abschnitt des Blatts. Mit `row` (nur aus einem Diktat, Entwurf TaskSpoken)
 * steht er zuerst als kompakte Zeile da - Zeichen, Name, Wert und ein x, das
 * genau das tut, was "Entfernen" tut. Ein Tipp auf die Zeile klappt die
 * Felder auf (`[data-expand]`). Die Felder stehen in beiden Faellen im DOM:
 * das Speichern liest dieselben Eingaben. `rowOptions` sind Zeichen und Namen
 * der Zeile (siehe sheetRowHtml).
 */
export function sheetSectionHtml(name, {
  open, attrs = '', labelledBy = '', row = null, idPrefix = 'task', rowOptions = {},
}, innerHtml) {
  const group = labelledBy ? ` role="group" aria-labelledby="${labelledBy}"` : '';
  return `
      <div class="task-sheet__section" data-section="${name}"${group}${attrs}${open ? '' : ' hidden'}>${row === null ? '' : sheetRowHtml(name, row, { ...rowOptions, idPrefix })}
        <div class="task-sheet__body" id="${idPrefix}-${name}-body"${row === null ? '' : ' hidden'}>${innerHtml}
        </div>
      </div>`;
}

/** The widest of the row names in this language: every label is sized to it,
 *  so "Jutro" and "Jutro, 07:30" start in one line under each other. */
export function longestLabel(labels) {
  return Object.values(labels ?? {}).map((key) => t(key)).sort((a, b) => b.length - a.length)[0] ?? '';
}

/**
 * Die kompakte Zeile eines Abschnitts: Zeichen, Name, Wert, x.
 * `icons`, `labels`, `removeLabels` sind je Abschnittsname das Lucide-Zeichen
 * und die Schluessel fuer Name und x-Beschriftung. `removable: false` laesst
 * das x weg - fuer einen Wert, den es immer gibt (das "Kiedy" eines Termins).
 */
export function sheetRowHtml(name, value, {
  icons = SHEET_ICONS, labels = {}, removeLabels = {}, idPrefix = 'task', removable = true,
} = {}) {
  return `
        <div class="task-sheet__row" data-row="${name}">
          <button type="button" class="task-sheet__row-main" data-expand="${name}" aria-expanded="false" aria-controls="${idPrefix}-${name}-body">
            <i data-lucide="${icons[name]}" class="icon-md" aria-hidden="true"></i>
            <span data-fit="${esc(longestLabel(labels))}" class="task-sheet__row-label">${t(labels[name])}</span>
            <span class="task-sheet__row-value">${esc(value)}</span>
          </button>${removable ? `
          <button type="button" class="task-sheet__row-remove" data-remove="${name}" aria-label="${esc(t(removeLabels[name]))}">
            <i data-lucide="x" class="icon-md" aria-hidden="true"></i>
          </button>` : ''}
        </div>`;
}

/** Der "+"-Chip unter dem Titel, der einen Abschnitt aufklappt (`open`: schon offen, also verborgen). */
export function revealButtonHtml(name, labelKey, open, icons = SHEET_ICONS) {
  return `<button type="button" class="task-sheet__chip" data-reveal="${name}"${open ? ' hidden' : ''}>
          <i data-lucide="${icons[name]}" class="icon-md" aria-hidden="true"></i>${t(labelKey)}
        </button>`;
}

/**
 * Titelfeld; mit `mic` (`{ labelKey }`, der Name des Knopfes) sitzt das
 * Mikrofon IM Feld, am Ende. `labelKey` ist der Schluessel fuer das
 * unsichtbare Label, `placeholder` der fertige Text im Feld, `inputAttrs`
 * weitere Attribute des Feldes (fertiges Markup, z. B. `enterkeyhint="done"`).
 */
export function titleFieldHtml({ id, name, value = '', placeholder = '', labelKey, mic = null, inputAttrs = '' }) {
  return `<div class="form-field task-sheet__title${mic ? ' task-sheet__title--mic' : ''}">
          <label class="sr-only" for="${id}">${t(labelKey)}</label>
          <input class="input" type="text" id="${id}" name="${name}"
                 value="${esc(value)}" placeholder="${esc(placeholder)}"
                 required maxlength="200" autocomplete="off"${inputAttrs ? ` ${inputAttrs}` : ''}>
          ${mic ? `<!-- Diktieren nur beim Anlegen (R10): ein gesprochener Satz
               ueberschriebe die Werte einer bestehenden Aufgabe. -->
          <button type="button" class="task-sheet__mic" data-action="dictate" aria-label="${esc(t(mic.labelKey))}">
            <i data-lucide="mic" class="icon-lg" aria-hidden="true"></i>
          </button>` : ''}
          <div class="form-field__error">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/>
                 <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12" y2="16.01"/>
            </svg>
            ${t('common.required')}
          </div>
        </div>`;
}

/**
 * Der gehoerte Satz, ueber dem Titelfeld eines Blatts, das aus einem Satz kam:
 * die Person sieht, was angekommen ist, und kann es mit dem Blatt vergleichen.
 * Leerer Satz: keine Zeile.
 */
export function heardLineHtml(text) {
  const heard = String(text ?? '').trim();
  if (!heard) return '';
  return `<p class="sheet-heard"><i data-lucide="mic" aria-hidden="true"></i><span>${esc(t('sheet.heardQuote', { text: heard }))}</span></p>`;
}
