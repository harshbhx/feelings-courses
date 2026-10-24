/**
 * The course page's repeating lists: short points (outcomes, who it's for, highlights), questions
 * and answers, and YouTube glimpses. Each list keeps its rows in memory, renders labelled inputs
 * (with data-field paths like "details.faqs[2].a" so API errors land on them), and calls
 * `onChange` on every edit so the editor can track unsaved changes.
 */
import { fill, h, icon } from "../client/dom";
import { nextId } from "../client/ui";

const MAX_POINTS = 20;

function tools(index: number, count: number, label: string, onMove: (from: number, to: number) => void, onRemove: (i: number) => void): HTMLElement {
  return h(
    "div",
    { class: "rep-tools" },
    h("button", { type: "button", class: "icon-btn", "aria-label": `Move ${label} ${index + 1} up`, disabled: index === 0, onClick: () => onMove(index, index - 1) }, icon("arrow-up")),
    h("button", { type: "button", class: "icon-btn", "aria-label": `Move ${label} ${index + 1} down`, disabled: index === count - 1, onClick: () => onMove(index, index + 1) }, icon("arrow-down")),
    h("button", { type: "button", class: "icon-btn", "aria-label": `Remove ${label} ${index + 1}`, onClick: () => onRemove(index) }, icon("trash")),
  );
}

function errSlot(id: string): HTMLElement {
  return h("p", { class: "field-error", id: `${id}-err` });
}

function move<T>(list: T[], from: number, to: number): void {
  if (to < 0 || to >= list.length) return;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item!);
}

export interface ListHandle<T> {
  get(): T[];
  set(items: T[]): void;
}

/** A list of short points in `root` (data-list, data-label, data-add on the element). */
export function pointsList(root: HTMLElement, onChange: () => void): ListHandle<string> {
  const name = root.dataset.list!;
  const label = root.dataset.label ?? "Points";
  const headingId = nextId("lst");
  let items: string[] = [];
  const ul = h("ol", { class: "rep-list", "aria-labelledby": headingId });
  const add = h("button", { type: "button", class: "btn btn-secondary btn-sm" }, icon("plus"), root.dataset.add ?? "Add");
  const render = (focus?: number) => {
    fill(
      ul,
      items.map((text, i) => {
        const id = nextId("pt");
        const inputEl = h("input", {
          class: "input",
          id,
          type: "text",
          maxlength: 200,
          value: text,
          "aria-label": `${label}, point ${i + 1}`,
          "aria-describedby": `${id}-err`,
          dataset: { field: `details.${name}[${i}]` },
        });
        inputEl.addEventListener("input", () => {
          items[i] = inputEl.value;
          onChange();
        });
        inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (items.length < MAX_POINTS) {
              items.splice(i + 1, 0, "");
              render(i + 1);
              onChange();
            }
          }
        });
        return h(
          "li",
          { class: "rep-item" },
          inputEl,
          tools(i, items.length, "point", (from, to) => {
            move(items, from, to);
            render(to);
            onChange();
          }, (at) => {
            items.splice(at, 1);
            render(Math.min(at, items.length - 1));
            onChange();
          }),
          errSlot(id),
        );
      }),
    );
    add.hidden = items.length >= MAX_POINTS;
    if (focus !== undefined && focus >= 0) ul.querySelectorAll<HTMLInputElement>("input")[focus]?.focus();
  };
  add.addEventListener("click", () => {
    items.push("");
    render(items.length - 1);
    onChange();
  });
  fill(
    root,
    h("h3", { class: "section-title", id: headingId, text: label }),
    ul,
    h("div", null, add),
  );
  return {
    get: () => [...items],
    set: (next) => {
      items = [...next];
      render();
    },
  };
}

/** Questions and answers. */
export function faqList(root: HTMLElement, onChange: () => void): ListHandle<{ q: string; a: string }> {
  let items: { q: string; a: string }[] = [];
  const headingId = nextId("faq");
  const ol = h("ol", { class: "rep-list", "aria-labelledby": headingId });
  const add = h("button", { type: "button", class: "btn btn-secondary btn-sm" }, icon("plus"), "Add a question");
  const render = (focus?: number) => {
    fill(
      ol,
      items.map((f, i) => {
        const qid = nextId("q");
        const aid = nextId("a");
        const q = h("input", { class: "input", id: qid, type: "text", maxlength: 300, value: f.q, "aria-describedby": `${qid}-err`, dataset: { field: `details.faqs[${i}].q` } });
        const a = h("textarea", { class: "textarea", id: aid, rows: 3, maxlength: 3000, "aria-describedby": `${aid}-err`, dataset: { field: `details.faqs[${i}].a` } });
        a.value = f.a;
        q.addEventListener("input", () => {
          items[i] = { ...items[i]!, q: q.value };
          onChange();
        });
        a.addEventListener("input", () => {
          items[i] = { ...items[i]!, a: a.value };
          onChange();
        });
        return h(
          "li",
          { class: "rep-item rep-card" },
          h(
            "div",
            { class: "rep-fields" },
            h("label", { class: "field-label", for: qid, text: `Question ${i + 1}` }),
            q,
            errSlot(qid),
            h("label", { class: "field-label", for: aid, text: "Answer" }),
            a,
            errSlot(aid),
          ),
          tools(i, items.length, "question", (from, to) => {
            move(items, from, to);
            render();
            onChange();
          }, (at) => {
            items.splice(at, 1);
            render();
            onChange();
          }),
        );
      }),
    );
    add.hidden = items.length >= 30;
    if (focus !== undefined) ol.querySelectorAll<HTMLInputElement>("input")[focus]?.focus();
  };
  add.addEventListener("click", () => {
    items.push({ q: "", a: "" });
    render(items.length - 1);
    onChange();
  });
  fill(
    root,
    h("h3", { class: "section-title", id: headingId, text: "Questions people ask" }),
    h("p", { class: "field-hint", text: "Answer the questions people send on WhatsApp: timings, kit, certificate, language." }),
    ol,
    h("div", null, add),
  );
  return {
    get: () => items.map((f) => ({ ...f })),
    set: (next) => {
      items = next.map((f) => ({ ...f }));
      render();
    },
  };
}

/** YouTube glimpses: short clips shown on the landing page. */
export function glimpseList(root: HTMLElement, onChange: () => void): ListHandle<{ youtube: string; label: string }> {
  let items: { youtube: string; label: string }[] = [];
  const headingId = nextId("gl");
  const ol = h("ol", { class: "rep-list", "aria-labelledby": headingId });
  const add = h("button", { type: "button", class: "btn btn-secondary btn-sm" }, icon("plus"), "Add a glimpse");
  const render = (focus?: number) => {
    fill(
      ol,
      items.map((g, i) => {
        const yid = nextId("yt");
        const lid = nextId("gl");
        const y = h("input", {
          class: "input",
          id: yid,
          type: "url",
          inputmode: "url",
          value: g.youtube,
          placeholder: "https://youtube.com/shorts/…",
          "aria-describedby": `${yid}-err`,
          dataset: { field: `details.glimpses[${i}].youtubeId` },
        });
        const l = h("input", { class: "input", id: lid, type: "text", maxlength: 120, value: g.label, placeholder: "Soft glam base", "aria-describedby": `${lid}-err`, dataset: { field: `details.glimpses[${i}].label` } });
        y.addEventListener("input", () => {
          items[i] = { ...items[i]!, youtube: y.value };
          onChange();
        });
        l.addEventListener("input", () => {
          items[i] = { ...items[i]!, label: l.value };
          onChange();
        });
        return h(
          "li",
          { class: "rep-item rep-card" },
          h(
            "div",
            { class: "rep-fields" },
            h("label", { class: "field-label", for: yid, text: `YouTube link ${i + 1}` }),
            y,
            errSlot(yid),
            h("label", { class: "field-label", for: lid, text: "Label" }),
            l,
            errSlot(lid),
          ),
          tools(i, items.length, "glimpse", (from, to) => {
            move(items, from, to);
            render();
            onChange();
          }, (at) => {
            items.splice(at, 1);
            render();
            onChange();
          }),
        );
      }),
    );
    add.hidden = items.length >= 20;
    if (focus !== undefined) ol.querySelectorAll<HTMLInputElement>("input[type=url]")[focus]?.focus();
  };
  add.addEventListener("click", () => {
    items.push({ youtube: "", label: "" });
    render(items.length - 1);
    onChange();
  });
  fill(
    root,
    h("h3", { class: "section-title", id: headingId, text: "Glimpses (YouTube)" }),
    h("p", { class: "field-hint", text: "Short clips from your reels, shown on the course page. Paste the YouTube link." }),
    ol,
    h("div", null, add),
  );
  return {
    get: () => items.map((g) => ({ ...g })),
    set: (next) => {
      items = next.map((g) => ({ ...g }));
      render();
    },
  };
}
