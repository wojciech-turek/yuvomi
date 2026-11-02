/**
 * Focus without a ring after a tap.
 *
 * Safari/WebKit draws the focus ring on the element `showModal()` focuses (the
 * close X) and keeps it for every scripted focus after that, even when the
 * sheet was opened by a tap. Chromium shows it only after keyboard use. These
 * helpers ask for no ring (`focusVisible: false`) unless a key was pressed
 * since the last tap; Tab still shows it, because the browser marks keyboard
 * focus itself.
 */

let keyboardLast = false;
globalThis.document?.addEventListener?.('pointerdown', () => { keyboardLast = false; }, { capture: true, passive: true });
globalThis.document?.addEventListener?.('keydown', () => { keyboardLast = true; }, { capture: true });

/** True when the last input was a key press, not a tap or click. */
export function keyboardWasLast() {
  return keyboardLast;
}

/** Focus `el`; a ring only when the keyboard was used last. */
export function focusQuietly(el) {
  if (!el?.focus) return;
  if (keyboardLast) { el.focus(); return; }
  // Re-focusing an already focused element changes nothing, so let go first.
  if (globalThis.document?.activeElement === el) el.blur?.();
  el.focus({ focusVisible: false });
}
