/** Page-wide events between a screen and the shell (no imports, so importing it runs nothing). */

/** Fired on document after a save that may change the public site; the shell re-checks the publish chip. */
export const CHANGED_EVENT = "admin:changed";

export function notifyChanged(): void {
  document.dispatchEvent(new CustomEvent(CHANGED_EVENT));
}
