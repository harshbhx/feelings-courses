/**
 * Loading, error and empty states, the same on every screen:
 * - loading: grey placeholder rows (aria-busy on the region, "Loading…" for screen readers);
 * - error: what went wrong in the owner's words, with "Try again" when that can help;
 * - empty: what this list is for, and the action that fills it.
 */
import { asApiError } from "./api";
import { fill, h, icon } from "./dom";
import { describeError } from "../lib/errors";

/** Placeholder rows while something loads. */
export function skeleton(rows = 3, kind: "rows" | "cards" | "block" = "rows"): HTMLElement {
  return h(
    "div",
    { class: `skel skel-${kind}`, "aria-hidden": "true" },
    Array.from({ length: rows }, (_, i) => h("div", { class: "skel-item", style: `--i:${i}` }, h("span", { class: "skel-line w-60" }), h("span", { class: "skel-line w-35" }))),
  );
}

/** An error box with an optional retry. */
export function errorBox(err: unknown, opts: { what?: string; retry?: () => void } = {}): HTMLElement {
  const view = describeError(asApiError(err), opts.what);
  const retry =
    view.retry && opts.retry
      ? h("button", { type: "button", class: "btn btn-secondary", onClick: opts.retry }, icon("arrow-counter-clockwise"), "Try again")
      : null;
  return h(
    "div",
    { class: `state state-error state-${view.kind}`, role: "alert" },
    icon(view.kind === "offline" ? "warning-circle" : view.kind === "setup" || view.kind === "coming" ? "info" : "warning-circle", "icon state-icon"),
    h("strong", { class: "state-title", text: view.title }),
    h("p", { class: "state-text", text: view.message }),
    retry,
  );
}

interface EmptyOptions {
  icon: string;
  title: string;
  text?: string;
  action?: HTMLElement | null;
}

export function emptyBox(opts: EmptyOptions): HTMLElement {
  return h(
    "div",
    { class: "state state-empty" },
    icon(opts.icon, "icon state-icon"),
    h("strong", { class: "state-title", text: opts.title }),
    opts.text ? h("p", { class: "state-text", text: opts.text }) : null,
    opts.action ?? null,
  );
}

/**
 * Loads into `region`: placeholder first, then `render(data)`, or the error with a retry that
 * runs the whole thing again. Resolves with the data, or null after an error.
 */
export async function loadInto<T>(
  region: HTMLElement,
  load: () => Promise<T>,
  render: (data: T) => void,
  opts: { what?: string; rows?: number; kind?: "rows" | "cards" | "block"; quiet?: boolean } = {},
): Promise<T | null> {
  region.setAttribute("aria-busy", "true");
  // Lists get their placeholder and messages inside an <li>.
  const wrap = (node: HTMLElement) => (region.tagName === "UL" || region.tagName === "OL" ? h("li", { class: "state-li" }, node) : node);
  if (!opts.quiet) fill(region, wrap(h("div", null, skeleton(opts.rows ?? 3, opts.kind ?? "rows"), h("p", { class: "visually-hidden", text: "Loading…" }))));
  try {
    const data = await load();
    region.removeAttribute("aria-busy");
    render(data);
    return data;
  } catch (err) {
    region.removeAttribute("aria-busy");
    fill(region, wrap(errorBox(err, { what: opts.what, retry: () => void loadInto(region, load, render, { ...opts, quiet: false }) })));
    return null;
  }
}
