/** Courses list: cover, title, price, status and students, filtered by status. */
import { getCourses, lessonTotal, minuteTotal, studentCounts, type Course } from "../../../lib/demo-store";
import { $, $$, fill, h, icon, ready } from "./dom";
import { duration, inr, num, plural } from "./format";
import { coverImage } from "./covers";

type Filter = "all" | "published" | "draft";

/** Where a course is seen by students: the landing page for the main course. */
export function publicUrl(c: Course): string {
  if (c.main) return "/";
  return `/course?id=${encodeURIComponent(c.id)}${c.status === "published" ? "" : "&preview=1"}`;
}

function statusPill(c: Course): HTMLElement {
  return h("span", { class: c.status === "published" ? "pill pill-live" : "pill", text: c.status === "published" ? "Published" : "Draft" });
}

function row(c: Course, students: number): HTMLElement {
  const img = coverImage(c.cover, c.title);
  const title = c.title.trim() || "Untitled course";
  const editHref = `/admin/courses/edit?id=${encodeURIComponent(c.id)}`;
  return h(
    "li",
    { class: "crs-item" },
    h(
      "div",
      { class: "crs-main" },
      h("img", { class: "crs-cover", src: img.src, alt: "", width: 72, height: 90, loading: "lazy", decoding: "async" }),
      h(
        "div",
        { class: "crs-info" },
        h("p", { class: "crs-title" }, title, c.main ? h("span", { class: "crs-tag", text: "Main course" }) : null),
        h(
          "p",
          { class: "crs-meta" },
          h("span", { class: "crs-price", text: `${inr(c.price)} · ` }),
          `${plural(lessonTotal(c), "lesson")} · ${duration(minuteTotal(c))}`,
        ),
        h("div", { class: "crs-line" }, statusPill(c), h("span", { class: "crs-students" }, icon("users-three"), plural(students, "student"))),
      ),
    ),
    h("span", { class: "crs-cell-price", text: inr(c.price) }),
    h("span", { class: "crs-cell-status" }, statusPill(c)),
    h("span", { class: "crs-cell-students", text: num(students) }),
    h(
      "div",
      { class: "crs-actions" },
      h(
        "a",
        { class: "btn btn-ghost", href: publicUrl(c), "aria-label": `${c.status === "published" ? "View" : "Preview"} ${title}` },
        icon("eye"),
        c.status === "published" ? "View" : "Preview",
      ),
      h("a", { class: "btn btn-secondary", href: editHref, "aria-label": `Edit ${title}` }, icon("pencil-simple"), "Edit"),
    ),
  );
}

ready(() => {
  const list = $("[data-list]");
  if (!list) return;
  const courses = getCourses();
  const counts = studentCounts();
  const buttons = $$<HTMLButtonElement>("[data-filter]");
  const countOf = (f: Filter) => (f === "all" ? courses.length : courses.filter((c) => c.status === f).length);
  for (const f of ["all", "published", "draft"] as Filter[]) {
    const el = $(`[data-count="${f}"]`);
    if (el) el.textContent = String(countOf(f));
  }

  const render = (filter: Filter) => {
    const shown = courses.filter((c) => filter === "all" || c.status === filter);
    if (!shown.length) {
      fill(
        list,
        h(
          "li",
          { class: "empty card" },
          icon("book-open-text"),
          h("strong", { text: filter === "draft" ? "No drafts" : "Nothing published yet" }),
          h("span", { text: filter === "draft" ? "New courses start as drafts until you publish them." : "Open a course and switch on Publish." }),
        ),
      );
      return;
    }
    fill(list, shown.map((c) => row(c, counts.get(c.id) ?? 0)));
  };

  for (const button of buttons) {
    button.addEventListener("click", () => {
      for (const b of buttons) b.setAttribute("aria-pressed", String(b === button));
      render(button.dataset.filter as Filter);
    });
  }
  render("all");
});
