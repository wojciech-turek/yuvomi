/**
 * Modul: User Multi-Select
 * Zweck: Wiederverwendbare Mehrfachauswahl-Komponente für Benutzer (Tasks & Kalender)
 * Abhängigkeiten: public/utils/html.js, public/i18n.js
 */

import { esc } from '/utils/html.js';
import { t } from '/i18n.js';
import { personDisc } from '/utils/person-color.js';

/**
 * Rendert einen Avatar-Stack für mehrere zugewiesene Benutzer: je Person die
 * eine Personenscheibe (utils/person-color.js) mit Rand, damit Nachbarn
 * getrennt stehen.
 *
 * WAS AUF DER SCHEIBE STEHT, ENTSCHEIDET personDisc(): unter 20px nur die
 * Farbe (Etappe 3, 2026-08-17: eine 9px-Schrift sagt weniger als ein sauberer
 * Punkt), darueber die Initialen aus dem einen Helfer - zwei Geviert-Zeichen
 * nur, wo sie innerhalb des Rands Platz haben (#1607), sonst das kompakte
 * eine. Der Name steht als Label an der Scheibe.
 * @param {Array<{id, display_name, avatar_data?}>} users
 * @param {object} opts
 * @param {number} [opts.size=28]      Avatar-Größe in px
 * @param {number} [opts.maxVisible=3] Maximale Avatare vor "+N"-Anzeige
 * @returns {string} HTML-String
 */
export function renderAvatarStack(users, { size = 28, maxVisible = 3 } = {}) {
  if (!users?.length) return '';
  const visible = users.slice(0, maxVisible);
  const overflow = users.length - visible.length;
  const avatars = visible.map((u) => personDisc(u, {
    size, ring: true, label: String(u?.display_name ?? ''), className: 'avatar-stack__item',
  }));
  if (overflow > 0) {
    // "+N" ist keine Person: dieselbe Scheibe in ruhigen Toenen
    // (user-multi-select.css), in der Groesse der Nachbarn.
    const px = Math.round(Number(size)) || 28;
    avatars.push(`<span class="person-disc person-disc--ring avatar-stack__item avatar-stack__overflow"
      style="--person-disc-size: ${px}px"
      title="${overflow} ${t('userMultiSelect.moreUsers')}">${px >= 20 ? `+${overflow}` : ''}</span>`);
  }
  return `<span class="avatar-stack">${avatars.join('')}</span>`;
}

/**
 * DER GETEILTE NACHNAME STEHT NICHT IN JEDEM CHIP (R19, Critique 2026-10-16:
 * Termin-Dialog mobil 1,6 Bildschirme). "Alex Johnson, Emma Johnson, Leo
 * Johnson, Linda Johnson" brauchten bei 390px drei Chip-Zeilen, und das
 * vierfache "Johnson" unterscheidet niemanden. Tragen ALLE Personen der Wahl
 * denselben Nachnamen, zeigt der Chip den Vornamen; der volle Name bleibt sein
 * zugaenglicher Name (`.sr-only`). Ein Konto mit anderem Nachnamen (Hilfe,
 * Grosseltern) laesst alle Namen voll stehen - dann unterscheidet er.
 * @param {Array<{display_name?: string}>} users
 * @returns {string} der geteilte Nachname, sonst ''
 */
export function sharedSurname(users) {
  if (!Array.isArray(users) || users.length < 2) return '';
  const lasts = users.map((u) => String(u?.display_name ?? '').trim().split(/\s+/))
    .map((parts) => (parts.length >= 2 ? parts[parts.length - 1] : ''));
  const [first] = lasts;
  return first && lasts.every((l) => l === first) ? first : '';
}

function userChipName(displayName, surname) {
  const full = String(displayName ?? '').trim();
  if (!surname || !full.endsWith(` ${surname}`)) return esc(full);
  const given = full.slice(0, -(surname.length + 1));
  return `${esc(given)}<span class="sr-only"> ${esc(surname)}</span>`;
}

/**
 * Rendert das Multi-Select-Widget als Dropdown-Checkbox-Liste.
 * @param {Array<{id, display_name, avatar_data?}>} allUsers  Alle verfügbaren Benutzer
 * @param {number[]} selectedIds                               Bereits ausgewählte IDs
 * @param {string}   inputName                                 Name-Attribut des Widgets
 * @param {string}   labelKey                                  i18n-Schlüssel für das Label
 * @param {string}   [noneLabelKey]                            i18n-Schlüssel für die "Niemand"-Zeile;
 *   Vorgabe passt für "wem zugewiesen" (Tasks/Kalender/Budget). Ein Aufrufer, dessen Auswahl kein
 *   Zuweisen ist - z. B. der Schedule-Vergleich, wo "Niemand" nur die Auswahl leert - übergibt
 *   seinen eigenen Schlüssel (S-19).
 * @returns {string} HTML-String
 */
export function renderUserMultiSelect(allUsers, selectedIds, inputName, labelKey, noneLabelKey = 'userMultiSelect.nobody') {
  const selectedSet = new Set(selectedIds ?? []);
  const surname = sharedSurname(allUsers);
  const items = allUsers.map((u) => {
    const checked = selectedSet.has(u.id) ? 'checked' : '';
    // Die Personenscheibe (Bild, sonst Initialen in der Personenfarbe) ist
    // Schmuck: den Namen sagt der Chip daneben.
    return `
      <label class="user-ms__option">
        <input type="checkbox" class="user-ms__checkbox" value="${u.id}" ${checked}
               data-ms-input="${esc(inputName)}">
        ${personDisc(u, { size: 26, className: 'user-ms__avatar' })}
        <span class="user-ms__name">${userChipName(u.display_name, surname)}</span>
      </label>`;
  });

  // „Niemand" ist ein ruhiger Eintrag, keine Person: kein Avatar und keine
  // Striche um das Wort. Hier stand ein grauer Kreis mit einem Gedankenstrich
  // und „- Niemand -" daneben - ein Platzhalter-Gesicht, das neben echten
  // Initialen wie ein weiteres Mitglied aussah (Critique 2026-09-24).
  const noneLabel = t(noneLabelKey);
  return `
    <div class="user-ms" data-ms-name="${esc(inputName)}">
      <label class="label">${t(labelKey)}</label>
      <div class="user-ms__options">
        <label class="user-ms__option user-ms__option--none">
          <input type="checkbox" class="user-ms__checkbox user-ms__none" value=""
                 data-ms-input="${esc(inputName)}" ${selectedSet.size === 0 ? 'checked' : ''}>
          <span class="user-ms__name">${noneLabel}</span>
        </label>
        ${items.join('')}
      </div>
    </div>`;
}

/**
 * Liest die ausgewählten User-IDs aus einem gerenderten Multi-Select-Widget.
 * @param {Element} container  DOM-Element, das das Widget enthält
 * @param {string}  inputName  Name-Attribut des Widgets
 * @returns {number[]}
 */
export function getSelectedUserIds(container, inputName) {
  const checkboxes = container.querySelectorAll(
    `[data-ms-input="${CSS.escape(inputName)}"]:not(.user-ms__none):checked`
  );
  return Array.from(checkboxes).map((cb) => Number(cb.value)).filter(Boolean);
}

/**
 * Bindet die Checkbox-Logik:
 * - "Niemand" deselektiert alle anderen
 * - Andere Auswahl deselektiert "Niemand"
 * - `single`: hoechstens EINE Person. Eine neue Wahl loest die vorige ab, und
 *   wer die gewaehlte Person abwaehlt, landet wieder bei "Niemand" - sonst
 *   stuende die Reihe ohne jede Markierung da. Fuer Felder, die genau eine
 *   Person tragen (der Koch einer Mahlzeit, #1679): dieselbe Auswahl wie bei
 *   den Zustaendigen einer Aufgabe, nur dass der Server eine einzige id
 *   erwartet. Das Markup bleibt dasselbe; `getSelectedUserIds()` liefert dann
 *   null oder eine id.
 * @param {Element} container
 * @param {string}  inputName
 * @param {{ single?: boolean }} [options]
 */
export function bindUserMultiSelect(container, inputName, { single = false } = {}) {
  const widget = container.querySelector(`.user-ms[data-ms-name="${CSS.escape(inputName)}"]`);
  if (!widget) return;

  widget.addEventListener('change', (e) => {
    const cb = e.target;
    if (!cb.matches('.user-ms__checkbox')) return;
    const none = widget.querySelector('.user-ms__none');

    if (cb.classList.contains('user-ms__none') && cb.checked) {
      widget.querySelectorAll('.user-ms__checkbox:not(.user-ms__none)').forEach((c) => { c.checked = false; });
    } else if (!cb.classList.contains('user-ms__none') && cb.checked) {
      if (none) none.checked = false;
      if (single) {
        widget.querySelectorAll('.user-ms__checkbox:not(.user-ms__none)').forEach((c) => {
          if (c !== cb) c.checked = false;
        });
      }
    } else if (single && none && !widget.querySelector('.user-ms__checkbox:checked')) {
      none.checked = true;
    }
  });
}
