/** /catalog: published courses from the demo store, main course first. */
import { getPublishedCourses, lessonTotal, minuteTotal, type Course } from "../../../lib/demo-store";
import { $, fill, h, icon, ready } from "./dom";
import { duration, inr, plural } from "./format";
import { coverImage } from "./covers";

/** The card image's rendered width per layout (catalog.astro's grid): 1, 2 or 3 columns. */
const CARD_SIZES = "(min-width: 64rem) 22rem, (min-width: 40rem) 45vw, calc(100vw - 2.5rem)";

function card(c: Course): HTMLElement {
  const img = coverImage(c.cover, c.title);
  const href = c.main ? "/" : `/course?id=${encodeURIComponent(c.id)}`;
  const isNew = !c.main && Date.now() - new Date(c.createdAt).getTime() < 7 * 86400000;
  return h(
    "li",
    null,
    h(
      "a",
      { class: "cat-card", href },
      h(
        "span",
        { class: "cat-media" },
        // Same sizes as the first card in catalog.astro, so the browser picks the same file.
        h("img", { ...(img.srcset ? { srcset: img.srcset, sizes: CARD_SIZES } : {}), src: img.src, alt: "", width: 480, height: 600, decoding: "async" }),
      ),
      h(
        "span",
        { class: "cat-body" },
        isNew ? h("span", { class: "cat-new", text: "New" }) : null,
        h("span", { class: "cat-meta", text: `${c.level} · ${plural(lessonTotal(c), "lesson")} · ${duration(minuteTotal(c))}` }),
        h("span", { class: "cat-title", text: c.title }),
        h("span", { class: "cat-sub", text: c.subtitle }),
        h("span", { class: "cat-foot" }, h("span", { class: "cat-price", text: inr(c.price) }), h("span", { class: "cat-go" }, "View course", icon("arrow-right"))),
      ),
    ),
  );
}

ready(() => {
  const grid = $("[data-catalog]");
  if (!grid) return;
  const courses = getPublishedCourses();
  if (!courses.length) {
    fill(
      grid,
      h(
        "li",
        { class: "cat-empty" },
        icon("book-open-text"),
        h("strong", { text: "No courses are published right now." }),
        h("span", { text: "Please check back soon." }),
      ),
    );
    return;
  }
  fill(grid, courses.map(card));
});
