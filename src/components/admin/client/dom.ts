/**
 * Tiny DOM helpers for the admin demo. Text always goes in through textContent, never innerHTML,
 * because course titles, names and codes are typed by people.
 */

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> | null;

function append(el: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

function applyProps(el: Element, props: Props): void {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.setAttribute("class", String(value));
    else if (key === "text") el.textContent = String(value);
    else if (key === "dataset" && value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v !== null && v !== undefined) (el as HTMLElement).dataset[k] = String(v);
      }
    } else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "value" && "value" in el) {
      (el as HTMLInputElement).value = String(value);
    } else if (key === "checked" && "checked" in el) {
      (el as HTMLInputElement).checked = Boolean(value);
    } else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
}

/** Create an HTML element: h("p", { class: "x" }, "text", child). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Create an SVG element. */
export function s<K extends keyof SVGElementTagNameMap>(tag: K, props: Props = null, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

/** A Phosphor icon, cloned from the page's icon sprite (IconSprite.astro). */
export function icon(name: string, className = "icon"): SVGElement | Comment {
  const sprite = document.getElementById("icon-sprite");
  const source = sprite instanceof HTMLTemplateElement ? sprite.content.querySelector(`[data-i="${name}"] svg`) : null;
  if (!source) return document.createComment(`icon ${name}`);
  const svg = source.cloneNode(true) as SVGElement;
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  return svg;
}

export function $<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(selector);
}

export function $$<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

/** Replace an element's children. */
export function fill(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

/** Run once the DOM is parsed (module scripts usually already are). */
export function ready(fn: () => void): void {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once: true });
  else fn();
}

/** True when the visitor asked for less motion. */
export function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
