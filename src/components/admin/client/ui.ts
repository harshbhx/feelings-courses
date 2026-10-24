/** Shared admin UI: toasts, confirm and form dialogs, busy buttons. */
import { h, icon } from "./dom";

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
  while (region.children.length > 3) region.firstElementChild?.remove();
  // It waits while the pointer or focus is on it, so there's time to read it.
  let timer = window.setTimeout(remove, tone === "error" ? Math.max(ms, 7000) : ms);
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

let uid = 0;
/** A unique id for labels and descriptions. */
export const nextId = (prefix = "x") => `${prefix}-${++uid}`;

interface ConfirmOptions {
  title: string;
  body: string | Node;
  confirm: string;
  cancel?: string;
  danger?: boolean;
}

/** A small modal question. Resolves true when confirmed. Escape or Cancel resolve false. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const titleId = nextId("dlg");
    const textId = `${titleId}-text`;
    const ok = h("button", { type: "submit", value: "ok", class: `btn ${opts.danger ? "btn-danger" : "btn-primary"}` }, opts.confirm);
    const dialog = h(
      "dialog",
      { class: "dlg dlg-confirm", "aria-labelledby": titleId, "aria-describedby": textId },
      h(
        "form",
        { method: "dialog", class: "dlg-body" },
        h("h2", { id: titleId, class: "dlg-title", text: opts.title }),
        typeof opts.body === "string" ? h("p", { class: "dlg-text", id: textId, text: opts.body }) : h("div", { class: "dlg-text", id: textId }, opts.body),
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
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close("cancel");
    });
    document.body.appendChild(dialog);
    dialog.showModal();
    (opts.danger ? (dialog.querySelector('button[value="cancel"]') as HTMLButtonElement) : ok).focus();
  });
}

export interface FormDialog {
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  submit: HTMLButtonElement;
  /** Shows a message above the buttons (form-level error); "" clears it. */
  setMessage(text: string): void;
  close(): void;
}

interface FormDialogOptions {
  title: string;
  intro?: string;
  body: Node[];
  submit: string;
  danger?: boolean;
  /** A drawer (side panel / bottom sheet) instead of a centred dialog. */
  drawer?: boolean;
  /** Called on submit; return false (or throw) to keep the dialog open. */
  onSubmit(d: FormDialog): Promise<boolean | void> | boolean | void;
  onClose?(): void;
}

/** A modal with a form. The submit button shows a busy state while `onSubmit` runs. */
export function formDialog(opts: FormDialogOptions): FormDialog {
  const titleId = nextId("dlg");
  const message = h("p", { class: "field-error dlg-message", role: "alert" });
  const submit = h("button", { type: "submit", class: `btn ${opts.danger ? "btn-danger" : "btn-primary"}` }, opts.submit);
  const cancel = h("button", { type: "button", class: "btn btn-secondary" }, "Cancel");
  const form = h(
    "form",
    { class: opts.drawer ? "drawer-body" : "dlg-body", novalidate: true },
    opts.drawer ? null : h("h2", { id: titleId, class: "dlg-title", text: opts.title }),
    opts.intro ? h("p", { class: "dlg-text", text: opts.intro }) : null,
    ...opts.body,
    message,
    h("div", { class: "dlg-actions" }, cancel, submit),
  );
  const dialog = h(
    "dialog",
    { class: opts.drawer ? "drawer" : "dlg dlg-form", "aria-labelledby": titleId },
    opts.drawer
      ? h(
          "div",
          { class: "drawer-head" },
          h("h2", { id: titleId, class: "dlg-title drawer-title", text: opts.title }),
          h("button", { type: "button", class: "icon-btn", "aria-label": "Close", dataset: { close: "" } }, icon("close")),
        )
      : null,
    form,
  );
  const api: FormDialog = {
    dialog,
    form,
    submit,
    setMessage: (text) => {
      message.textContent = text;
    },
    close: () => dialog.close(),
  };
  cancel.addEventListener("click", () => dialog.close());
  dialog.querySelector("[data-close]")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog && !submit.hasAttribute("aria-busy")) dialog.close();
  });
  dialog.addEventListener("cancel", (event) => {
    if (submit.hasAttribute("aria-busy")) event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    opts.onClose?.();
    dialog.remove();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.hasAttribute("aria-busy")) return;
    api.setMessage("");
    let keepOpen = false;
    await busy(submit, async () => {
      try {
        keepOpen = (await opts.onSubmit(api)) === false;
      } catch {
        keepOpen = true;
      }
    });
    if (!keepOpen) dialog.close();
  });
  document.body.appendChild(dialog);
  dialog.showModal();
  const first = form.querySelector<HTMLElement>("input:not([type=hidden]):not([disabled]), select, textarea");
  (first ?? submit).focus();
  return api;
}

/**
 * Runs `fn` with `button` disabled and marked busy (aria-busy, a spinner), so a double tap can't
 * send twice. Returns what `fn` returns.
 */
export async function busy<T>(button: HTMLButtonElement | null, fn: () => Promise<T>): Promise<T> {
  if (!button) return fn();
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.classList.add("is-busy");
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.classList.remove("is-busy");
  }
}

/** Copies text, with a toast either way. */
export async function copyText(text: string, what = "Copied"): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what}.`, "success", 2200);
  } catch {
    toast("Couldn't copy here. Select the text and copy it yourself.", "info");
  }
}

/** Says something to screen readers through the page's polite live region. */
export function announce(text: string): void {
  const live = document.querySelector<HTMLElement>("[data-announce]");
  if (!live) return;
  live.textContent = "";
  window.setTimeout(() => (live.textContent = text), 50);
}
