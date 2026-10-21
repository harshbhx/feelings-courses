/** Shared admin UI: toasts, a confirm dialog and the "available in the real version" note. */
import { h, icon } from "./dom";
import type { SaveResult } from "../../../lib/demo-store";

type Tone = "info" | "success" | "error";

/** A short message at the bottom of the screen, read out by screen readers. */
export function toast(message: string, tone: Tone = "success", ms = 4200): void {
  const region = document.getElementById("toasts");
  if (!region) return;
  const name = tone === "error" ? "warning-circle" : tone === "info" ? "info" : "check-circle";
  const close = h("button", { type: "button", class: "toast-close", "aria-label": "Dismiss" }, icon("close"));
  // The region is aria-live="polite"; only errors interrupt (role="alert").
  const el = h("div", { class: `toast toast-${tone}`, role: tone === "error" ? "alert" : null }, icon(name, "icon toast-icon"), h("p", { text: message }), close);
  const remove = () => {
    el.classList.add("is-leaving");
    window.setTimeout(() => el.remove(), 200);
  };
  close.addEventListener("click", remove);
  region.appendChild(el);
  // Keep at most three on screen.
  while (region.children.length > 3) region.firstElementChild?.remove();
  // It waits while the pointer or focus is on it, so there's time to read it.
  let timer = window.setTimeout(remove, ms);
  const pause = () => window.clearTimeout(timer);
  const resume = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(remove, 2500);
  };
  el.addEventListener("pointerenter", pause);
  el.addEventListener("pointerleave", resume);
  el.addEventListener("focusin", pause);
  el.addEventListener("focusout", resume);
}

/** The note for anything the demo doesn't do yet (refunds, messages, uploads to a server). */
export function demoNote(what: string): void {
  toast(`${what} is available in the real version. This demo doesn't change anything.`, "info", 5200);
}

/** Tell the person when a save didn't stick. Returns true when it did. */
export function reportSave(result: SaveResult, success?: string): boolean {
  if (result.ok) {
    if (success) toast(success, "success");
    return true;
  }
  if (result.reason === "quota") {
    toast("This browser's storage is full. Remove an uploaded cover photo, or reset the demo data in Settings.", "error", 7000);
  } else {
    toast("This browser is blocking storage (private window?), so this change lasts only until you leave the page.", "error", 7000);
  }
  return false;
}

interface ConfirmOptions {
  title: string;
  body: string;
  confirm: string;
  cancel?: string;
  danger?: boolean;
}

/** A small modal question. Resolves true when confirmed. Escape or Cancel resolve false. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
    const textId = `${titleId}-text`;
    const ok = h("button", { type: "submit", value: "ok", class: `btn ${opts.danger ? "btn-danger" : "btn-primary"}` }, opts.confirm);
    const dialog = h(
      "dialog",
      { class: "dlg dlg-confirm", "aria-labelledby": titleId, "aria-describedby": textId },
      h(
        "form",
        { method: "dialog", class: "dlg-body" },
        h("h2", { id: titleId, class: "dlg-title", text: opts.title }),
        h("p", { class: "dlg-text", id: textId, text: opts.body }),
        h(
          "div",
          { class: "dlg-actions" },
          h("button", { type: "submit", value: "cancel", class: "btn btn-secondary" }, opts.cancel ?? "Cancel"),
          ok,
        ),
      ),
    );
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "ok");
      dialog.remove();
    });
    // A click on the backdrop (outside the box) cancels.
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close("cancel");
    });
    document.body.appendChild(dialog);
    dialog.showModal();
    (opts.danger ? (dialog.querySelector('button[value="cancel"]') as HTMLButtonElement) : ok).focus();
  });
}
