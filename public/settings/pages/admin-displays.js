/**
 * Einstellungen: Tablet w kuchni (Tafla, 2026-10-19; vorher „Wandtabletts",
 * #1208, entschieden in #913)
 *
 * Das Blatt nach dem Artboard „TabletKuchnia": oben je Tablett eine
 * Statuskarte (gekoppelt, zuletzt gesehen, „Podgląd ściany"), darunter die
 * Wahl des Haushalts, was die Wand zeigt („Na ścianie"), ob man auf ihr
 * abhaken darf („Dotyk", Standard aus), die Nachtszene und das Geraet selbst:
 * koppeln, einen neuen Code ausstellen, entkoppeln, das Konto entfernen.
 *
 * Die Entscheidungen liegen im Server: welche Bereiche ein Tablett lesen darf
 * (DISPLAY_SCOPES), was es schreiben darf (services/wall-settings.js, nur mit
 * dem Schalter), wann ein Code gilt. Hier steht nur, was ein Mensch davon sieht.
 *
 * DER CODE STEHT GENAU EINMAL AUF DEM SCHIRM, wie der Klartext eines
 * API-Tokens. Er wandert nicht in die Liste und ueberlebt kein Neuladen: der
 * Server verwahrt nur seinen Hash, es gibt ihn danach schlicht nicht mehr.
 * Wer ihn verpasst, stellt einen neuen aus - und der entwertet den alten.
 */

import { api, auth } from '/api.js';
import { formatDate, formatTime, getLocale, t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { confirmModal, refocusAfterRender } from '/components/modal.js';
import { settingRowHtml, settingSwitchRowHtml } from '/settings/components.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';
import { enterWallMode } from '/utils/wall-mode.js';
import { zonedDateKey } from '/utils/timezone.js';

/** The wall sections the household switches, in the order of the artboard. */
const WALL_SECTIONS = Object.freeze([
  { id: 'dinner', icon: 'utensils', key: 'settings.tabletSectionDinner' },
  { id: 'plan', icon: 'list-checks', key: 'settings.tabletSectionPlan' },
  { id: 'shopping', icon: 'shopping-basket', key: 'settings.tabletSectionShopping' },
  { id: 'timers', icon: 'timer', key: 'settings.tabletSectionTimers' },
  { id: 'weather', icon: 'cloud-sun', key: 'settings.tabletSectionWeather' },
]);

function icon(name, cls = '') {
  return `<i data-lucide="${esc(name)}"${cls ? ` class="${esc(cls)}"` : ''} aria-hidden="true"></i>`;
}

function formatSeen(value, now = new Date()) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  // Heute genuegt die Uhrzeit („ostatnio widziany 18:10"), sonst mit Datum.
  // Der Tag in der Haushaltszone, nicht in der des Browsers.
  const sameDay = zonedDateKey(date) === zonedDateKey(now);
  return sameDay ? formatTime(date) : `${formatDate(date)} ${formatTime(date)}`.trim();
}

function showError(element, message) {
  if (!element) return;
  element.textContent = message || t('common.errorGeneric');
  element.hidden = false;
}

function clearError(element) {
  if (!element) return;
  element.textContent = '';
  element.hidden = true;
}

/**
 * Der Code in zwei Gruppen zu fuenf. Nur Darstellung - der Server normalisiert
 * Leerzeichen und Bindestriche weg, damit ein abgetippter Code mit oder ohne
 * Trennung passt.
 */
function groupCode(code) {
  return `${code.slice(0, 5)} ${code.slice(5)}`.trim();
}

function activeDevice(display) {
  return (display.devices || []).find((d) => !d.revoked_at) ?? null;
}

/** One action row of a group: a full-width button with its glyph in the 28 slot. */
function actionRow({ glyph, label, hint = '', tone = '', attrs = '' }) {
  return `
    <button type="button" class="tablet-action${tone ? ` tablet-action--${tone}` : ''}" ${attrs}>
      <span class="tablet-action__glyph">${icon(glyph)}</span>
      <span class="tablet-action__text">
        <span class="tablet-action__label">${esc(label)}</span>
        ${hint ? `<span class="tablet-action__hint">${esc(hint)}</span>` : ''}
      </span>
    </button>`;
}

/**
 * Ein Geraet als Zeile der Gruppe „Urządzenie".
 *
 * „ZULETZT GESEHEN" STEHT IN DER STATUSKARTE und begruendet diesen Knopf: ein
 * Geraet, das seit Wochen nichts mehr gesagt hat, ist das, das man entkoppelt.
 * Ein entkoppeltes Geraet laesst sich danach von der Liste nehmen (D#1672).
 */
function renderDevice(display, device, { named = false } = {}) {
  const revoked = formatSeen(device.revoked_at);
  const label = device.label || t('settings.displayDeviceUnnamed');
  return `${revoked ? `
      ${actionRow({
        glyph: 'list-x',
        label: t('settings.tabletRemoveRevoked', { name: label }),
        hint: t('settings.displayDeviceRevokedAt', { when: revoked }),
        attrs: `data-display-remove-device="${display.id}" data-device="${device.id}"`,
      })}` : `
      ${actionRow({
        glyph: 'log-out',
        label: named ? t('settings.tabletUnpairNamed', { name: display.display_name }) : t('settings.tabletUnpair'),
        tone: 'danger',
        attrs: `data-display-revoke="${display.id}" data-device="${device.id}"`,
      })}`}`;
}

/**
 * Die Statuskarte eines Tabletts: Name, gekoppelt oder nicht, zuletzt
 * gesehen, „Podgląd ściany". Exportiert fuer test:display-screensaver-switch.
 */
export function renderDisplay(display) {
  const device = activeDevice(display);
  const seen = device ? formatSeen(device.last_seen_at) : null;
  const meta = device
    ? (seen ? t('settings.tabletSeen', { when: seen }) : t('settings.tabletNeverSeen'))
    : t('settings.tabletPairHint');
  return `
    <section class="tablet-card" data-display="${display.id}" aria-labelledby="display-title-${display.id}">
      <div class="tablet-card__head">
        <span class="tablet-card__glyph">${icon('tablet')}</span>
        <div class="tablet-card__text">
          <div class="tablet-card__title-row">
            <h2 class="tablet-card__title" id="display-title-${display.id}">${esc(display.display_name)}</h2>
            <span class="tablet-pill${device ? ' tablet-pill--ok' : ''}">${esc(device ? t('settings.tabletPaired') : t('settings.tabletNotPaired'))}</span>
          </div>
          <p class="tablet-card__meta">${esc(meta)}</p>
        </div>
      </div>
      <div class="tablet-card__actions">
        <button type="button" class="tablet-preview" data-wall-preview>${esc(t('settings.tabletPreview'))}</button>
      </div>
      <div class="settings-token-output tablet-code" data-display-code="${display.id}" hidden>
        <p class="form-label">${esc(t('settings.displayPairingCodeLabel'))}</p>
        <p class="settings-token-output__row"><code data-display-code-value="${display.id}"></code></p>
        <p class="form-hint">${esc(t('settings.displayPairingCodeHint'))}</p>
      </div>
    </section>`;
}

/**
 * Der Schalter „Zdjęcia z albumu" je Display (#1766): ob dieses Tablett den
 * Foto-Bildschirmschoner zeigt. Ein Display aendert keine Einstellungen, also
 * entscheidet es hier ein Administrator, je Display und standardmaessig aus;
 * der Server sperrt die Fotos bei „aus" am Gate.
 */
export function renderPhotoSwitch(display, { named = false } = {}) {
  return settingSwitchRowHtml({
    label: named ? t('settings.tabletPhotosNamed', { name: display.display_name }) : t('settings.tabletPhotos'),
    checked: display.show_screensaver === true,
    icon: 'image',
    description: t('settings.displayScreensaverHint'),
    descriptionId: `display-screensaver-hint-${display.id}`,
    attrs: {
      id: `display-screensaver-${display.id}`,
      'data-display-screensaver': display.id,
      'data-name': display.display_name,
    },
  });
}

function sectionTitle(id, key) {
  return `<h2 class="tablet-group-title" id="${esc(id)}">${esc(t(key))}</h2>`;
}

function renderBody(state) {
  const { displays, prefs } = state;
  const sections = prefs?.wall_sections ?? {};
  const ticking = prefs?.wall_allow_ticking === true;
  const named = displays.length > 1;

  const cards = displays.length
    ? displays.map(renderDisplay).join('')
    : `
    <section class="tablet-card tablet-card--empty" aria-labelledby="tablet-empty-title">
      <div class="tablet-card__head">
        <span class="tablet-card__glyph">${icon('tablet')}</span>
        <div class="tablet-card__text">
          <h2 class="tablet-card__title" id="tablet-empty-title">${esc(t('settings.tabletEmpty'))}</h2>
          <p class="tablet-card__meta tablet-card__meta--wrap">${esc(t('settings.tabletEmptyHint'))}</p>
        </div>
      </div>
    </section>`;

  const sectionRows = WALL_SECTIONS.map((section) => settingSwitchRowHtml({
    label: t(section.key),
    checked: sections[section.id] !== false,
    icon: section.icon,
    attrs: { 'data-wall-section': section.id },
  }));
  const photoRows = displays.map((display) => renderPhotoSwitch(display, { named }));

  const deviceRows = [];
  for (const display of displays) {
    for (const device of display.devices || []) deviceRows.push(renderDevice(display, device, { named }));
    deviceRows.push(actionRow({
      glyph: 'qr-code',
      label: named ? t('settings.tabletNewCodeNamed', { name: display.display_name }) : t('settings.tabletNewCode'),
      tone: 'accent',
      attrs: `data-display-pair="${display.id}"`,
    }));
  }
  deviceRows.push(actionRow({
    glyph: 'plus',
    label: displays.length ? t('settings.tabletPairAnother') : t('settings.tabletPairFirst'),
    tone: 'accent',
    attrs: 'data-display-add aria-expanded="false" aria-controls="display-form"',
  }));
  for (const display of displays) {
    deviceRows.push(actionRow({
      glyph: 'trash-2',
      label: named ? t('settings.tabletDeleteNamed', { name: display.display_name }) : t('settings.tabletDelete'),
      tone: 'danger',
      attrs: `data-display-delete="${display.id}" data-name="${esc(display.display_name)}"`,
    }));
  }

  return `
    ${cards}
    <section class="tablet-group" aria-labelledby="tablet-wall-title">
      ${sectionTitle('tablet-wall-title', 'settings.tabletOnWall')}
      <div class="row-carrier settings-group">
        ${[...sectionRows, ...photoRows].join('')}
      </div>
    </section>
    <section class="tablet-group" aria-labelledby="tablet-touch-title">
      ${sectionTitle('tablet-touch-title', 'settings.tabletTouch')}
      <div class="row-carrier settings-group">
        ${settingSwitchRowHtml({
          label: t('settings.tabletAllowTicking'),
          checked: ticking,
          icon: 'circle-check',
          description: ticking ? t('settings.tabletTickingOn') : t('settings.tabletTickingOff'),
          descriptionId: 'tablet-ticking-hint',
          attrs: { id: 'tablet-allow-ticking', 'data-wall-ticking': '' },
        })}
      </div>
      <p class="form-hint settings-group__footer">${esc(t('settings.tabletTouchFooter'))}</p>
    </section>
    ${/* 2026-10-27, v2: light only - der Abschnitt „Noc" (22:00-06:00,
          bursztynowy zegar) beschrieb nur die Nachtszene der Wand, und die ist
          gegangen. */ ''}
    <section class="tablet-group" aria-labelledby="tablet-device-title">
      ${sectionTitle('tablet-device-title', 'settings.tabletDevice')}
      <div class="row-carrier settings-group tablet-actions">
        ${deviceRows.join('')}
      </div>
      <form id="display-form" class="settings-form tablet-form" autocomplete="off" hidden>
        ${/* displayDeviceNameLabel, NICHT displayNameLabel: der zweite heisst
             "Anzeigename" - der Name eines MENSCHEN (admin-family.js). */ ''}
        <div class="row-carrier settings-group">
          ${settingRowHtml({
            label: t('settings.displayDeviceNameLabel'), labelFor: 'display-name',
            description: t('settings.displayDeviceNameHint'), descriptionId: 'display-name-hint',
            control: '<input class="form-input" type="text" id="display-name" maxlength="128" required aria-describedby="display-name-hint" />',
          })}
        </div>
        <div class="settings-form-actions">
          <button type="submit" class="btn btn--primary">${esc(t('settings.displayCreate'))}</button>
        </div>
      </form>
      ${/* Welche Bereiche ein Tablett lesen darf, weiss nur der Server
           (DISPLAY_SCOPES, #1808); der Satz kommt mit der Liste. */ ''}
      <p class="form-hint settings-group__footer" id="display-areas-hint" hidden></p>
    </section>`;
}

function renderPage(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="settings-section tablet-page">
      <!-- KEINE eigene Ueberschrift: die Shell setzt den Blatt-Titel
           („Tablet w kuchni") schon darueber. -->
      <div id="display-error" class="form-error" role="alert" hidden></div>
      <div class="tablet-page__body" id="display-list"></div>
    </div>
  `);
}

/**
 * Die Bereiche eines Displays als Satz (#1808).
 *
 * Die Namen sind die der Scope-Module, wie sie der API-Zugriff nebenan nennt
 * (`settings.apiTokenScopeModules.*`) - dieselben Schluessel, die der Server
 * liefert, also keine zweite Zuordnung. Ohne Liste (alte Antwort aus dem
 * Cache) bleibt der Absatz aus, statt einen halben Satz zu zeigen.
 */
function displayAreasText(modules) {
  const names = (Array.isArray(modules) ? modules : [])
    .map((key) => t(`settings.apiTokenScopeModules.${key}`));
  if (!names.length) return '';
  const areas = new Intl.ListFormat(getLocale(), { style: 'long', type: 'conjunction' }).format(names);
  return t('settings.displaysAreasHint', { areas });
}

function renderAreasHint(container, modules) {
  const hint = container.querySelector('#display-areas-hint');
  if (!hint) return;
  const text = displayAreasText(modules);
  hint.textContent = text;
  hint.hidden = !text;
}

const pageState = { displays: [], prefs: null, areaModules: [] };

function renderList(container) {
  const list = container.querySelector('#display-list');
  if (!list) return;
  list.replaceChildren();
  list.insertAdjacentHTML('beforeend', renderBody(pageState));
  renderAreasHint(container, pageState.areaModules);
  window.lucide?.createIcons({ el: list });
}

async function reload(container) {
  const [res, prefs] = await Promise.all([
    api.get('/displays'),
    getPreferences().catch(() => null),
  ]);
  pageState.displays = res.data ?? [];
  pageState.areaModules = res.area_modules ?? [];
  if (prefs) pageState.prefs = prefs;
  renderList(container);
  return pageState.displays;
}

/**
 * Welche Code-Anfrage je Display die juengste ist. Eine Antwort, deren Nummer
 * nicht mehr stimmt, wurde ueberholt und darf nichts mehr schreiben.
 */
const pairTickets = new Map();

/**
 * Der Schalter "Zdjęcia z albumu" je Display (#1766). Er wirkt sofort wie
 * jeder Schalter in den Einstellungen. Scheitert die Anfrage, springt er
 * zurueck - sonst zeigte die Liste einen Zustand, den der Server nicht hat.
 * Exported so test:display-screensaver-switch can drive the real handler.
 */
export function bindDisplayScreensaverSwitches(list, errorEl) {
  list.addEventListener('change', async (event) => {
    const toggle = event.target.closest?.('[data-display-screensaver]');
    if (!toggle) return;
    clearError(errorEl);
    const on = toggle.checked;
    toggle.disabled = true;
    try {
      await api.patch(`/displays/${toggle.dataset.displayScreensaver}`, { show_screensaver: on });
      window.yuvomi?.showToast(
        t(on ? 'settings.displayScreensaverOn' : 'settings.displayScreensaverOff', { name: toggle.dataset.name }),
        'success',
      );
    } catch (err) {
      toggle.checked = !on;
      showError(errorEl, err.message);
    } finally {
      toggle.disabled = false;
    }
  });
}

/**
 * Die Wahl des Haushalts fuer die Wand: welche Bereiche sie zeigt und ob man
 * auf ihr abhaken darf. Beides sofort gespeichert, beides springt bei einem
 * Fehler zurueck. Der Server setzt den Abhak-Schalter fuer das Tablett durch
 * (services/wall-settings.js) - hier ist es nur die Wahl.
 */
function bindWallSwitches(list, errorEl) {
  list.addEventListener('change', async (event) => {
    const section = event.target.closest?.('[data-wall-section]');
    const ticking = event.target.closest?.('[data-wall-ticking]');
    if (!section && !ticking) return;
    const toggle = section || ticking;
    clearError(errorEl);
    const on = toggle.checked;
    toggle.disabled = true;
    try {
      const patch = section
        ? { wall_sections: { [toggle.dataset.wallSection]: on } }
        : { wall_allow_ticking: on };
      const fresh = (await savePreferences(patch))?.data ?? {};
      // Der Server antwortet mit der ganzen Wahl (alle Bereiche) - sie gilt.
      pageState.prefs = {
        ...(pageState.prefs ?? {}),
        wall_sections: fresh.wall_sections ?? pageState.prefs?.wall_sections,
        wall_allow_ticking: typeof fresh.wall_allow_ticking === 'boolean' ? fresh.wall_allow_ticking : pageState.prefs?.wall_allow_ticking,
      };
      if (ticking) {
        const hint = list.querySelector('#tablet-ticking-hint');
        if (hint) hint.textContent = on ? t('settings.tabletTickingOn') : t('settings.tabletTickingOff');
      }
      window.yuvomi?.showToast(t('settings.tabletSaved'), 'success');
    } catch (err) {
      toggle.checked = !on;
      showError(errorEl, err.message);
    } finally {
      toggle.disabled = false;
    }
  });
}

function bindEvents(container) {
  const list = container.querySelector('#display-list');
  const errorEl = container.querySelector('#display-error');
  if (!list) return;

  bindDisplayScreensaverSwitches(list, errorEl);
  bindWallSwitches(list, errorEl);

  list.addEventListener('submit', async (event) => {
    const form = event.target.closest?.('#display-form');
    if (!form) return;
    event.preventDefault();
    clearError(errorEl);
    const input = form.querySelector('#display-name');
    const name = input.value.trim();
    if (!name) return;
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const created = await api.post('/displays', { display_name: name });
      // DAS ERSTE DISPLAY MACHT AUS EINEM EIN-PERSONEN-HAUSHALT EINEN MIT
      // MITLESER. `othersCanRead` entscheidet, ob Aufgaben und Kalender ihre
      // Sichtbarkeitsfelder ueberhaupt zeigen; der Wert kommt aus /auth/me und
      // liegt im Speicher. Ohne dieses Nachholen blieben die Felder bis zum
      // naechsten vollen Laden verborgen.
      await auth.me().catch(() => {});
      await reload(container);
      // Gleich den Code: wer ein Tablett anlegt, will es koppeln.
      const id = created?.data?.id;
      if (id != null) list.querySelector(`[data-display-pair="${id}"]`)?.click();
    } catch (err) {
      showError(errorEl, err.message);
    } finally {
      if (btn.isConnected) btn.disabled = false;
    }
  });

  list.addEventListener('click', async (event) => {
    if (event.target.closest('[data-wall-preview]')) {
      // „Podgląd ściany": dieses Geraet zeigt die Wand, bis man sie schliesst.
      enterWallMode();
      window.yuvomi?.navigate?.('/');
      return;
    }

    const add = event.target.closest('[data-display-add]');
    if (add) {
      const form = list.querySelector('#display-form');
      if (!form) return;
      form.hidden = !form.hidden;
      add.setAttribute('aria-expanded', String(!form.hidden));
      if (!form.hidden) form.querySelector('#display-name')?.focus();
      return;
    }

    const pair = event.target.closest('[data-display-pair]');
    if (pair) {
      // ZWEI KLICKS DUERFEN NICHT ZWEI CODES ANFRAGEN. Der Server entwertet
      // beim Ausstellen jeden aelteren Code - kommen die Antworten in der
      // anderen Reihenfolge zurueck, stuende am Ende der ALTE, laengst
      // ungueltige Code auf dem Schirm. Der Knopf sperrt sich deshalb fuer die
      // Dauer der Anfrage, und eine ueberholte Antwort schreibt nicht mehr.
      if (pair.disabled) return;
      clearError(errorEl);
      const id = pair.dataset.displayPair;
      const ticket = (pairTickets.get(id) ?? 0) + 1;
      pairTickets.set(id, ticket);
      pair.disabled = true;
      try {
        const res = await api.post(`/displays/${id}/pairing-code`, {});
        if (pairTickets.get(id) !== ticket) return;
        const box = list.querySelector(`[data-display-code="${id}"]`);
        const value = list.querySelector(`[data-display-code-value="${id}"]`);
        if (box && value) {
          value.textContent = groupCode(res.data.code);
          box.hidden = false;
          box.scrollIntoView?.({ block: 'nearest' });
        }
      } catch (err) {
        if (pairTickets.get(id) === ticket) showError(errorEl, err.message);
      } finally {
        if (pair.isConnected) pair.disabled = false;
      }
      return;
    }

    const revoke = event.target.closest('[data-display-revoke]');
    if (revoke) {
      // Die Frage nennt die HANDLUNG, das Detail die FOLGE: „entkoppeln" allein
      // verraet nicht, dass das Tablett an der Wand danach leer ist.
      const ok = await confirmModal(t('settings.displayRevokeConfirm'), {
        danger: true,
        detail: t('settings.displayRevokeDetail'),
      });
      if (!ok) return;
      clearError(errorEl);
      try {
        await api.post(`/displays/${revoke.dataset.displayRevoke}/devices/${revoke.dataset.device}/revoke`, {});
        await reload(container);
        refocusAfterRender();
      } catch (err) {
        showError(errorEl, err.message);
      }
      return;
    }

    // EIN ENTKOPPELTES GERAET LAESST SICH ENTFERNEN (D#1672). Jede neue
    // Kopplung widerruft das Geraet davor, und dessen Zeile blieb fuer immer
    // stehen. Rueckgaengig gibt es nicht - die Zeile ist danach weg -, also die
    // Rueckfrage vorab, mit der Folge im Detail.
    const remove = event.target.closest('[data-display-remove-device]');
    if (remove) {
      const ok = await confirmModal(t('settings.displayRemoveDeviceConfirm'), {
        danger: true,
        confirmLabel: t('settings.displayRemoveDevice'),
        detail: t('settings.displayRemoveDeviceDetail'),
      });
      if (!ok) return;
      clearError(errorEl);
      try {
        await api.post(`/displays/${remove.dataset.displayRemoveDevice}/devices/${remove.dataset.device}/remove`, {});
      } catch (err) {
        // 404 heisst: schon weg. Alles andere bekommt seinen Satz - der Grund
        // des Servers uebersetzt, nicht sein englischer Text.
        if (err?.status !== 404) {
          showError(errorEl, err?.status === 409 && err.data?.reason === 'display_device_active'
            ? t('settings.displayRemoveDeviceActive')
            : err.message);
        }
      }
      try {
        await reload(container);
        refocusAfterRender();
      } catch (err) {
        showError(errorEl, err.message);
      }
      return;
    }

    const del = event.target.closest('[data-display-delete]');
    if (del) {
      const ok = await confirmModal(t('settings.displayDeleteConfirm', { name: del.dataset.name }), {
        danger: true,
        detail: t('settings.displayDeleteDetail'),
      });
      if (!ok) return;
      clearError(errorEl);
      try {
        await api.delete(`/displays/${del.dataset.displayDelete}`);
        // Und der Rueckweg: war es das letzte Display, liest in einem
        // Ein-Personen-Haushalt wieder niemand mit, und die Felder gehoeren
        // wieder weg. Derselbe Wert, dieselbe Quelle wie beim Anlegen.
        await auth.me().catch(() => {});
        await reload(container);
        refocusAfterRender();
      } catch (err) {
        showError(errorEl, err.message);
      }
    }
  });
}

export async function render(container) {
  renderPage(container);
  bindEvents(container);
  try {
    await reload(container);
  } catch {
    pageState.displays = [];
    renderList(container);
  }
}

export const __test = { displayAreasText, renderBody, WALL_SECTIONS };
