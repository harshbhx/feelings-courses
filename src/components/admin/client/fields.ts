/**
 * Form building blocks for screens that build forms in the browser (dialogs, drawers, the editor's
 * repeating lists), with the admin's field classes and accessible errors: each control is labelled,
 * its hint and error are linked with aria-describedby, and an error sets aria-invalid.
 */
import { h, icon, reducedMotion } from "./dom";
import { nextId } from "./ui";

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

interface FieldOptions {
  label: string;
  /** The control, already built. Its id is set here when it has none. */
  control: Control | HTMLElement;
  hint?: string;
  optional?: boolean;
  /** API field name, for setErrors(). */
  name?: string;
  class?: string;
  /** Wrap the control (for ₹ affixes). */
  affix?: string;
  affixEnd?: string;
}

/** A labelled field with hint and error slots. */
export function field(opts: FieldOptions): HTMLElement {
  const control = opts.control;
  const target = (control.matches("input, select, textarea") ? control : control.querySelector("input, select, textarea")) as Control | null;
  const id = target?.id || nextId("f");
  if (target && !target.id) target.id = id;
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  if (target) {
    const described = [opts.hint ? hintId : null, errId].filter(Boolean).join(" ");
    target.setAttribute("aria-describedby", described);
    if (opts.name) target.dataset.field = opts.name;
  }
  const wrapped =
    opts.affix || opts.affixEnd
      ? h(
          "div",
          { class: "input-affix" },
          opts.affix ? h("span", { class: "affix", "aria-hidden": "true", text: opts.affix }) : null,
          control,
          opts.affixEnd ? h("span", { class: "affix affix-end", "aria-hidden": "true", text: opts.affixEnd }) : null,
        )
      : control;
  return h(
    "div",
    { class: `field${opts.class ? ` ${opts.class}` : ""}`, dataset: { fieldWrap: opts.name ?? null } },
    h("label", { class: "field-label", for: id }, opts.label, opts.optional ? h("span", { class: "opt", text: " (optional)" }) : null),
    wrapped,
    opts.hint ? h("p", { class: "field-hint", id: hintId, text: opts.hint }) : null,
    h("p", { class: "field-error", id: errId }),
  );
}

export function input(props: Record<string, unknown> = {}): HTMLInputElement {
  return h("input", { class: "input", type: "text", autocomplete: "off", ...props });
}

export function textarea(props: Record<string, unknown> = {}): HTMLTextAreaElement {
  return h("textarea", { class: "textarea", rows: 3, ...props });
}

export function select(options: { value: string; label: string }[], value: string, props: Record<string, unknown> = {}): HTMLSelectElement {
  const el = h("select", { class: "select", ...props }, options.map((o) => h("option", { value: o.value, text: o.label })));
  el.value = value;
  return el;
}

/** A switch row: label and hint on the left, the switch on the right. */
export function switchRow(opts: { label: string; hint?: string; checked: boolean; name?: string }): { row: HTMLElement; input: HTMLInputElement } {
  const id = nextId("sw");
  const box = h("input", { type: "checkbox", role: "switch", id, checked: opts.checked, dataset: { field: opts.name ?? null } });
  if (opts.hint) box.setAttribute("aria-describedby", `${id}-hint`);
  const row = h(
    "div",
    { class: "switch-row" },
    h("div", null, h("label", { class: "field-label", for: id, text: opts.label }), opts.hint ? h("p", { class: "field-hint", id: `${id}-hint`, text: opts.hint }) : null),
    h("label", { class: "switch" }, box, h("span", { class: "switch-track" })),
  );
  return { row, input: box };
}

/** Clears every field error under `root`. */
export function clearErrors(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>("[aria-invalid=true]")) el.removeAttribute("aria-invalid");
  for (const el of root.querySelectorAll<HTMLElement>(".field-error")) {
    if (!el.classList.contains("dlg-message")) el.replaceChildren();
  }
}

/**
 * Shows `errors` (API field name → message) on the controls marked data-field="<name>". Errors with
 * no control on the form are returned, so the caller can show them elsewhere. Focuses the first.
 */
export function setErrors(root: ParentNode, errors: Record<string, string>, focus = true): Record<string, string> {
  clearErrors(root);
  const unplaced: Record<string, string> = {};
  let first: HTMLElement | null = null;
  for (const [name, message] of Object.entries(errors)) {
    const control = root.querySelector<HTMLElement>(`[data-field="${CSS.escape(name)}"]`);
    if (!control) {
      unplaced[name] = message;
      continue;
    }
    control.setAttribute("aria-invalid", "true");
    const errId = control.getAttribute("aria-describedby")?.split(" ").find((id) => id.endsWith("-err"));
    const slot = errId ? document.getElementById(errId) : null;
    if (slot) slot.replaceChildren(icon("warning-circle"), message);
    first ??= control;
  }
  if (focus && first) {
    first.focus();
    first.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
  }
  return unplaced;
}
