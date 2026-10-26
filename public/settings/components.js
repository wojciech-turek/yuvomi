import { t } from '/i18n.js';
import { moduleIconHTML } from '/nav-icons.js';
import { esc } from '/utils/html.js';
import { getReadableTextColor } from '/utils/color.js';
import { formRowHtml } from '/utils/form-row.js';

let settingRowIdCounter = 0;

function appendContent(container, content) {
  if (content == null) return;
  if (typeof content === 'object' && typeof content.nodeType === 'number') {
    container.appendChild(content);
    return;
  }
  container.appendChild(document.createTextNode(String(content)));
}

export function createDisclosure({
  id,
  summary,
  expanded = false,
  content,
}) {
  const section = document.createElement('section');
  section.className = 'settings-disclosure';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.id = `${id}-trigger`;
  trigger.className = 'settings-disclosure__trigger';
  trigger.setAttribute('aria-controls', `${id}-panel`);
  trigger.setAttribute('aria-expanded', String(expanded));
  appendContent(trigger, summary);

  const icon = document.createElement('i');
  icon.className = 'settings-disclosure__icon';
  icon.dataset.lucide = 'chevron-down';
  icon.setAttribute('aria-hidden', 'true');
  trigger.appendChild(icon);

  const panel = document.createElement('div');
  panel.id = `${id}-panel`;
  panel.className = 'settings-disclosure__panel';
  panel.setAttribute('aria-labelledby', trigger.id);
  panel.hidden = !expanded;
  appendContent(panel, content);

  trigger.addEventListener('click', () => {
    const nextExpanded = trigger.getAttribute('aria-expanded') !== 'true';
    trigger.setAttribute('aria-expanded', String(nextExpanded));
    panel.hidden = !nextExpanded;
  });

  section.append(trigger, panel);
  return section;
}

// Ein Schalter, eine Form. Vorher erfand jedes Blatt seine eigene: `toggle-row`,
// `settings-toggle`, der iOS-Switch aus `toggle`/`toggle__track` und nackte
// Checkboxen standen für dieselbe Boolean-Entscheidung nebeneinander (Critique
// 2026-07-27). `attrs` nimmt alles auf, was ein Aufrufer sonst hartkodieren
// müsste - id, name, value, data-*, aria-describedby -, sodass es genau einen
// Escape-Pfad gibt. `true` rendert ein Boolean-Attribut, `false`/`null` lässt es weg.
function attrsHtml(attrs) {
  return Object.entries(attrs)
    .filter(([, value]) => value !== false && value != null)
    .map(([name, value]) => (value === true ? ` ${name}` : ` ${name}="${esc(String(value))}"`))
    .join('');
}

export function toggleRowHtml({
  label,
  checked = false,
  disabled = false,
  className = '',
  // Icon vor dem Text. Der Name geht durch `moduleIconHTML`: ist es ein
  // Modulzeichen, kommt es aus Yuvomis Satz, sonst als Lucide-Platzhalter
  // (der wie überall ein `lucide.createIcons()` nach dem Einfügen braucht).
  icon = null,
  // Zeilen, deren Kontext den Schalter schon benennt (Modul-Listen), tragen ihr
  // Label nur für Screenreader.
  labelVisible = true,
  // FARBSCHEIBE STATT ICON - für Zeilen, deren Gegenstand eine eigene Farbe
  // HAT (eine Person, eine Kalenderebene). Sie nimmt eine FARBE entgegen und
  // baut die Scheibe selbst, statt fertiges Markup durchzureichen: ein
  // `swatchHtml`-Parameter wäre ein zweiter Escape-Pfad neben `attrs`, und
  // genau davon hat diese Funktion einen.
  //
  // Die Farbe steht als Scheibe NEBEN dem Text, nie als Fläche darunter - das
  // ist die Vollton-Regel für freie Nutzerfarben (DESIGN.md): auf einer frei
  // gewählten Helligkeit gibt es keine Tinte, die trägt. `swatchLabel` füllt
  // sie mit Initialen, wenn sie groß genug dafür ist.
  swatchColor = null,
  swatchLabel = '',
  // SCHALTER ODER HAKEN (Komponenten-Kanon, 2026-09-26). Eine Boolean-
  // EINSTELLUNG ist ein Schalter wie in Apples Einstellungen: der Zustand
  // steht rechts, das Label links, und das Umlegen wirkt sofort. Die native
  // 18px-Checkbox bleibt der Default, weil dieselbe Zeile auch Filterblaetter
  // traegt (Kalender, Aufgaben), deren Zeilen eine AUSWAHL sind - die Frage,
  // ob auch dort Schalter stehen, ist offen und nicht Teil dieser Runde.
  // `'switch'` rendert die geteilte `.toggle`-Bahn und `role="switch"`; der
  // Knoten bleibt eine `input[type=checkbox]`, Leser (`.checked`, `change`)
  // aendern sich nicht. Ratchet: test:control-dialect "settings-checkbox".
  control = 'checkbox',
  attrs = {},
}) {
  const isSwitch = control === 'switch';
  const rowClass = ['toggle-row', isSwitch ? 'toggle-row--switch' : '', className].filter(Boolean).join(' ');
  const iconHtml = icon ? moduleIconHTML(icon) : '';
  // DIE TINTE WIRD GERECHNET, NICHT GESETZT. `--color-ink-on-vivid` gilt fuer
  // KURATIERTE Toene, deren Helligkeit bekannt ist. Eine frei gewaehlte Farbe
  // hat keine garantierte Tinte - dieselbe Rechnung macht der Avatar-Stack
  // (components/user-multi-select.js), und zwei Antworten auf dieselbe Frage
  // waeren genau die Spaltung, die #891 an drei Stellen aufgeraeumt hat.
  const swatchHtml = swatchColor
    ? `<span class="toggle-row__swatch" aria-hidden="true"`
      + ` style="--swatch-color:${esc(String(swatchColor))};color:${getReadableTextColor(String(swatchColor))}">`
      + `${esc(String(swatchLabel ?? ''))}</span>`
    : '';
  const labelClass = labelVisible ? '' : ' class="sr-only"';
  if (isSwitch) {
    const textClass = labelVisible ? 'toggle-row__label' : 'toggle-row__label sr-only';
    return `<label class="${rowClass}">`
      + iconHtml
      + swatchHtml
      + `<span class="${textClass}">${esc(String(label ?? ''))}</span>`
      + '<span class="toggle">'
      + `<input type="checkbox" role="switch"${attrsHtml({ ...attrs, checked, disabled })}>`
      + '<span class="toggle__track" aria-hidden="true"></span>'
      + '</span>'
      + '</label>';
  }
  return `<label class="${rowClass}">`
    + `<input type="checkbox"${attrsHtml({ ...attrs, checked, disabled })}>`
    + iconHtml
    + swatchHtml
    + `<span${labelClass}>${esc(String(label ?? ''))}</span>`
    + '</label>';
}

/**
 * EIN SCHALTER WIRKT SOFORT (Komponenten-Kanon "Schalter in Einstellungen",
 * Re-Critique 2026-09-28 R15 A7 P1-1). Auch wenn er in einem Formular mit
 * "Speichern" steht: umlegen speichert, ein Fehler legt ihn zurueck. Das
 * Element traegt dazu `data-instant-save` im Markup - daran erkennt der
 * Verlassen-Schutz (settings/dirty-guard.js), dass er keinen offenen Stand
 * hinterlaesst. Dasselbe Muster wie die Sofort-Speicherer in
 * modules-options.js, nur einmal statt je Blatt.
 *
 * @param {HTMLInputElement|null} input
 * @param {object} options
 * @param {(checked: boolean) => Promise<unknown>} options.save
 * @param {string} options.savedMessage  Toast nach dem Speichern
 * @param {(checked: boolean) => void} [options.onRevert]  Folgezustand nach dem Zuruecklegen nachziehen
 */
export function bindInstantSwitch(input, { save, savedMessage, onRevert = () => {} }) {
  if (!input) return;
  input.addEventListener('change', async () => {
    const value = input.checked;
    input.disabled = true;
    try {
      await save(value);
      window.yuvomi?.showToast(savedMessage, 'success');
    } catch (error) {
      input.checked = !value;
      onRevert(!value);
      window.yuvomi?.showToast(error?.message || t('common.errorGeneric'), 'danger');
    } finally {
      if (input.isConnected) input.disabled = false;
    }
  });
}

/**
 * TAFLA-ZEILEN DER EINSTELLUNGEN (2026-10-20, Artboards Domownicy, Moduly,
 * AsystentAI, Powiadomienia). Eine gruppierte Liste: Kopf 17/600 auf dem Grund,
 * eine weisse Karte (Radius 20), Zeilen 48 bzw. 64 mit dem 28er Leitplatz (das
 * nackte 20er Zeichen in Tinte-2, Titel bei x=56), Wert 17 Tinte-2, Chevron 16,
 * Haarlinien auf 56 eingerueckt, darunter hoechstens zwei Zeilen Fussnote.
 * Texte laufen durch esc(); `trail` und `lead` sind Markup des Aufrufers.
 *
 * @param {object} row
 * @param {string} row.title
 * @param {string} [row.meta]      zweite Zeile (13 Tinte-2) - macht die Zeile 64 hoch
 * @param {string} [row.glyph]     Lucide-Name des Zeichens
 * @param {string} [row.lead]      eigenes Markup im Leitplatz (Personenscheibe)
 * @param {string} [row.value]     Wert am Ende (17 Tinte-2)
 * @param {string} [row.trail]     eigenes Markup am Ende (Schalter, Verb)
 * @param {boolean} [row.chevron]  Chevron am Ende (die Zeile fuehrt weiter)
 * @param {string} [row.href]      die Zeile ist ein Link
 * @param {object} [row.attrs]     Attribute: an einem Knopf/Link der Zeile selbst
 * @param {boolean} [row.button]   die Zeile ist ein Knopf
 * @param {boolean} [row.accent]   der Titel ist selbst die Handlung (Violett)
 */
export function taflaRowHtml({
  title, meta = '', glyph = '', lead = '', value = '', trail = '', chevron = false,
  href = '', button = false, attrs = {}, accent = false, titleId = '', wrap = false,
}) {
  const classes = ['tafla-row', meta ? 'tafla-row--two' : '', accent ? 'tafla-row--accent' : '', wrap ? 'tafla-row--wrap' : ''].filter(Boolean).join(' ');
  const leadHtml = lead
    ? `<span class="tafla-row__lead">${lead}</span>`
    : `<span class="tafla-row__lead" aria-hidden="true">${glyph ? `<i data-lucide="${esc(glyph)}"></i>` : ''}</span>`;
  const body = `<span class="tafla-row__body">`
    + `<span class="tafla-row__title"${titleId ? ` id="${esc(titleId)}"` : ''}>${esc(title)}</span>`
    + (meta ? `<span class="tafla-row__meta">${esc(meta)}</span>` : '')
    + '</span>';
  const end = (value ? `<span class="tafla-row__value">${esc(value)}</span>` : '')
    + trail
    + (chevron ? '<span class="tafla-row__chevron" aria-hidden="true"><i data-lucide="chevron-right"></i></span>' : '');
  if (href) return `<a class="${classes}" href="${esc(href)}"${attrsHtml(attrs)}>${leadHtml}${body}${end}</a>`;
  if (button) return `<button type="button" class="${classes}"${attrsHtml(attrs)}>${leadHtml}${body}${end}</button>`;
  return `<div class="${classes}"${attrsHtml(attrs)}>${leadHtml}${body}${end}</div>`;
}

/**
 * Der Schalter am Ende einer Tafla-Zeile: dieselbe `.toggle`-Bahn wie ueberall
 * (`input[type=checkbox][role=switch]`, `change` wie bisher), mit eigenem
 * Namen, weil die Zeile ihn nicht als <label> umschliesst.
 */
export function taflaSwitchHtml({ label, checked = false, disabled = false, attrs = {} }) {
  return '<label class="toggle tafla-switch">'
    + `<input type="checkbox" role="switch"${attrsHtml({ 'aria-label': label, ...attrs, checked, disabled })}>`
    + '<span class="toggle__track" aria-hidden="true"></span>'
    + '</label>';
}

/**
 * Eine Gruppe: Kopf (optional), Karte mit den Zeilen, Fussnote (optional).
 * @param {{ id?: string, title?: string, count?: string|number, rows: string[], footer?: string, className?: string, level?: 2|3 }} group
 */
export function taflaGroupHtml({ id = '', title = '', count = '', rows = [], footer = '', className = '', level = 2 }) {
  const items = rows.filter(Boolean);
  if (!items.length) return '';
  const headId = id ? `${id}-title` : '';
  // Unter dem h1 des Blatts ist eine Gruppe h2 (Sonde 10: keine Stufe ueberspringen).
  const tag = level === 3 ? 3 : 2;
  return `<section class="tafla-group ${esc(className)}"${id ? ` id="${esc(id)}"` : ''}${headId && title ? ` aria-labelledby="${esc(headId)}"` : ''}>`
    + (title ? `<h${tag} class="tafla-group__title"${headId ? ` id="${esc(headId)}"` : ''}>${esc(title)}${count !== '' ? ` <span class="tafla-group__count">${esc(String(count))}</span>` : ''}</h${tag}>` : '')
    + `<div class="tafla-card">${items.join('')}</div>`
    + (footer ? `<p class="tafla-group__footer">${esc(footer)}</p>` : '')
    + '</section>';
}

export function createToggleRow(options) {
  const host = document.createElement('div');
  host.insertAdjacentHTML('afterbegin', toggleRowHtml(options));
  return host.firstElementChild;
}

/**
 * DIE GRUPPIERTE ZEILE ALS MARKUP (Critique 2026-10-07, R17 E9).
 *
 * Bis dahin trug in den Einstellungen jede Option ihre eigene Karte: das Blatt
 * Darstellung zeigte zehn Einstellungen in acht Karten (1650px, drei davon im
 * ersten Bild), waehrend "Aktive Module" daneben laengst die Form hatte, die
 * Apples Einstellungen fuehren - EIN Traeger je Abschnitt, darin Zeilen mit
 * dem Label links und dem Bedienelement rechts. Diese zwei Helfer sind die
 * Zeile dazu; der Traeger ist `<div class="row-carrier settings-group">`, ein
 * Hinweis fuer die ganze Gruppe steht als `.settings-group__footer` darunter
 * auf dem Grund.
 *
 * `createSettingRow()` darunter baut dieselbe Zeile als Knoten; die Blaetter
 * schreiben ihr Markup als Zeichenkette, also gibt es sie auch so. Texte
 * (`label`, `description`) laufen durch `esc()`; `control` und `extra` sind
 * Markup des Aufrufers.
 *
 * @param {object} options
 * @param {string} options.label
 * @param {string|null} [options.labelFor]  id des Bedienelements - dann ist das Label ein `<label for>`
 * @param {string|null} [options.labelId]   id am Label, fuer `aria-labelledby` einer Gruppe
 * @param {string} [options.description]    Sekundaerzeile: ein Hinweis, der nur DIESE Zeile betrifft
 * @param {string|null} [options.descriptionId]
 * @param {string} [options.control]        Markup des Bedienelements
 * @param {string} [options.extra]          Markup unter dem Text (Fehlerzeile, verborgener Zusatzhinweis)
 * @param {boolean} [options.stacked]       Bedienelement UNTER dem Text: Segmente und Chip-Gruppen, die neben einem Label nicht stehen koennen
 */
export function settingRowHtml({
  label,
  labelFor = null,
  labelId = null,
  description = '',
  descriptionId = null,
  control = '',
  extra = '',
  stacked = false,
  field = false,
  className = '',
  attrs = {},
}) {
  // `field`: die Zeile ist der Traeger eines Feldfehlers (reportFieldError,
  // components/modal.js) - die Meldung steht dann unter der Zeile, ueber beide
  // Spalten, statt das Feld zu quetschen (layout.css, `.form-row`).
  // DIE EINSTELLUNGSZEILE IST EINE FORMULARZEILE (R18, 2026-10-07): derselbe
  // Baustein wie in den Erfassungsdialogen (utils/form-row.js). Die Klassen
  // `settings-setting-row*` bleiben vorn - unter ihnen fuehrt settings.css die
  // Masse des Blatts -, `form-row*` kommt dazu und bringt, was in der Zeile
  // steht: die randlose Auswahl, das Datum als Wert, das zusammengesetzte Feld.
  return formRowHtml({
    label, labelFor, labelId, description, descriptionId, control, extra, stacked, field, className, attrs,
    variant: 'settings-setting-row',
  });
}

/**
 * Die Schalterzeile einer Gruppe: `toggleRowHtml({ control: 'switch' })` bleibt
 * das Label und damit die Trefferflaeche der ganzen Zeile; die Sekundaerzeile
 * steht DARUNTER und ausserhalb des Labels, sonst laese ein Screenreader den
 * Hinweis als Teil des Namens. Verknuepft wird sie ueber `aria-describedby`.
 *
 * Nimmt dieselben Optionen wie `toggleRowHtml()`, dazu `description`,
 * `descriptionId` und `extra`.
 */
export function settingSwitchRowHtml({ description = '', descriptionId = null, extra = '', rowAttrs = {}, ...toggle }) {
  const attrs = { ...(toggle.attrs ?? {}) };
  if (description && descriptionId && !attrs['aria-describedby']) attrs['aria-describedby'] = descriptionId;
  const descriptionHtml = description
    ? `<p class="settings-setting-row__description"${attrsHtml({ id: descriptionId })}>${esc(String(description))}</p>`
    : '';
  return `<div class="settings-setting-row settings-setting-row--switch"${attrsHtml(rowAttrs)}>`
    + toggleRowHtml({ ...toggle, control: 'switch', attrs })
    + descriptionHtml
    + extra
    + '</div>';
}

/**
 * Die Schalterzeile eines DIALOGS (R19, Einstellungen B7): `toggleRowHtml` als
 * Zeile des Dialog-Traegers `.form-rows` (utils/form-row.js), der Hinweis
 * darunter und per `aria-describedby` verknuepft. Das Gegenstueck zu
 * `settingSwitchRowHtml` fuer die Blaetter - dort traegt die Gruppe
 * (`.settings-group`) ihre eigenen Masse, im Dialog der Formular-Traeger.
 */
export function formSwitchRowHtml({ hint = '', hintId = null, ...toggle }) {
  const attrs = { ...(toggle.attrs ?? {}) };
  if (hint && hintId && !attrs['aria-describedby']) attrs['aria-describedby'] = hintId;
  return '<div class="form-switch">'
    + toggleRowHtml({ ...toggle, control: 'switch', attrs })
    + (hint ? `<p class="form-hint form-switch__hint"${attrsHtml({ id: hintId })}>${esc(String(hint))}</p>` : '')
    + '</div>';
}

export function createSettingRow({ label, description, control }) {
  const rowId = `settings-setting-row-${++settingRowIdCounter}`;
  const formControl = control?.matches?.('input, select, textarea, button')
    ? control
    : control?.querySelector?.('input, select, textarea, button') ?? null;

  if (formControl && !formControl.id) {
    formControl.id = `${rowId}-control`;
  }

  // Dieselben Klassenpaare wie `settingRowHtml()` (utils/form-row.js).
  const row = document.createElement('div');
  row.className = 'settings-setting-row form-row';

  const copy = document.createElement('div');
  copy.className = 'settings-setting-row__copy form-row__copy';

  const title = document.createElement(formControl ? 'label' : 'div');
  title.className = 'settings-setting-row__label form-row__label';
  title.textContent = String(label ?? '');
  if (formControl) title.htmlFor = formControl.id;
  copy.appendChild(title);

  if (description) {
    const detail = document.createElement('p');
    detail.id = `${rowId}-description`;
    detail.className = 'settings-setting-row__description form-row__description';
    detail.textContent = String(description);
    copy.appendChild(detail);

    if (formControl) {
      const describedBy = (formControl.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .filter(Boolean);
      if (!describedBy.includes(detail.id)) describedBy.push(detail.id);
      formControl.setAttribute('aria-describedby', describedBy.join(' '));
    }
  }

  const controlContainer = document.createElement('div');
  controlContainer.className = 'settings-setting-row__control form-row__control';
  appendContent(controlContainer, control);

  row.append(copy, controlContainer);
  return row;
}

export function createStatusSummary({
  title,
  status,
  details = [],
  action = null,
  tone = 'neutral',
  // Überschriftenebene, nicht Größe: die trägt `settings-status-summary__title`.
  // Blätter, in denen die Zusammenfassung direkt unter dem Leaf-Titel sitzt,
  // brauchen 2, sonst springt das Outline von h1 auf h3.
  level = 3,
}) {
  const allowedTones = new Set(['neutral', 'success', 'warning', 'danger']);
  const resolvedTone = allowedTones.has(tone) ? tone : 'neutral';
  const summary = document.createElement('section');
  summary.className = `settings-status-summary settings-status-summary--${resolvedTone}`;

  const heading = document.createElement(level === 2 ? 'h2' : 'h3');
  heading.className = 'settings-status-summary__title';
  heading.textContent = String(title ?? '');

  const statusText = document.createElement('p');
  statusText.className = 'settings-status-summary__status';
  statusText.textContent = String(status ?? '');

  summary.append(heading, statusText);

  if (details.length) {
    const list = document.createElement('ul');
    list.className = 'settings-status-summary__details';
    for (const detail of details) {
      const item = document.createElement('li');
      // Details sind entweder ein String oder { text, key }. Der Key macht eine
      // Zeile adressierbar, damit Aufrufer sie später gezielt aktualisieren
      // können, ohne die Karte neu zu bauen.
      if (detail && typeof detail === 'object') {
        item.textContent = String(detail.text ?? '');
        if (detail.key) item.dataset.key = detail.key;
      } else {
        item.textContent = String(detail);
      }
      list.appendChild(item);
    }
    summary.appendChild(list);
  }

  if (action && typeof action.nodeType === 'number') {
    const actionContainer = document.createElement('div');
    actionContainer.className = 'settings-status-summary__action';
    actionContainer.appendChild(action);
    summary.appendChild(actionContainer);
  }

  return summary;
}

export function createInfoRow({ label, value, tone = null, code = false }) {
  const row = document.createElement('div');
  row.className = 'settings-info-row';

  const labelEl = document.createElement('span');
  labelEl.className = 'settings-info-label';
  labelEl.textContent = String(label ?? '');

  const valueEl = document.createElement('span');
  valueEl.className = 'settings-info-value';
  const allowedTones = new Set(['success', 'danger', 'warning']);
  if (allowedTones.has(tone)) valueEl.classList.add(`settings-info-value--${tone}`);

  if (value != null && typeof value === 'object' && typeof value.nodeType === 'number') {
    valueEl.appendChild(value);
  } else if (code) {
    const codeEl = document.createElement('code');
    codeEl.textContent = String(value ?? '');
    valueEl.appendChild(codeEl);
  } else {
    valueEl.textContent = String(value ?? '');
  }

  row.append(labelEl, valueEl);
  return row;
}

export function createInfoList(rows = []) {
  const grid = document.createElement('div');
  grid.className = 'settings-info-grid';
  for (const row of rows) {
    if (row == null) continue;
    grid.appendChild(typeof row.nodeType === 'number' ? row : createInfoRow(row));
  }
  return grid;
}

export function createInlineError(message) {
  const error = document.createElement('p');
  error.className = 'settings-inline-error';
  error.setAttribute('role', 'alert');
  error.textContent = String(message ?? '');
  return error;
}

export function createRetryState({ message, onRetry }) {
  const state = document.createElement('div');
  state.className = 'settings-retry-state';
  state.appendChild(createInlineError(message));

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn--secondary settings-retry-state__button';
  button.textContent = t('settings.retry');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await onRetry?.();
    } catch (error) {
      console.error('[Settings] Retry failed:', error);
    } finally {
      button.disabled = false;
    }
  });

  state.appendChild(button);
  return state;
}

/**
 * Aufklappbares Feld einer Modulzeile verdrahten (Kueche).
 *
 * Stand kurz in beiden Modul-Blaettern wortgleich (Audit 2026-08-16). Es ist
 * kein Blatt-Detail, sondern das Verhalten einer geteilten Komponente: derselbe
 * Ausloeser, dasselbe Panel, dieselbe `aria-expanded`-Kopplung.
 *
 * `aria-controls` gehoert dazu und fehlte in beiden Fassungen: der Ausloeser
 * sagte "ich bin aufgeklappt", nannte aber nicht, WAS. Die Id wird hier
 * vergeben, damit kein Blatt sie selbst erfinden muss.
 */
export function bindDisclosure(container, { triggerSelector, panelSelector, id }) {
  const trigger = container.querySelector(triggerSelector);
  const panel = container.querySelector(panelSelector);
  if (!trigger || !panel) return;

  if (id && !panel.id) {
    panel.id = id;
    trigger.setAttribute('aria-controls', id);
  }

  trigger.addEventListener('click', () => {
    const expanded = trigger.getAttribute('aria-expanded') === 'true';
    trigger.setAttribute('aria-expanded', String(!expanded));
    panel.hidden = expanded;
  });
}

/**
 * Statuswort einer Drittanbieter-Modulzeile.
 *
 * Liegt hier und nicht in einem der zwei Modul-Blaetter: beide zeigen dieselbe
 * Zeile, nur mit verschiedenen Bedienelementen. Ein Blatt, das vom anderen
 * importiert, zoege beim Oeffnen das falsche Modul mit.
 */
export function thirdPartyStatusLabel(module) {
  if (module.status === 'error') return t('settings.thirdPartyModulesStatusError');
  return module.enabled
    ? t('settings.thirdPartyModulesStatusEnabled')
    : t('settings.thirdPartyModulesStatusDisabled');
}
