/**
 * /course?id=…: draws a course from the demo store. Drafts show only with ?preview=1, under a
 * "preview" bar. Enroll buttons open a labelled demo note (checkout is not mounted here).
 */
import { getCourse, lessonTotal, minuteTotal, type Course } from "../../../lib/demo-store";
import { whatsappLink } from "../../../lib/whatsapp";
import { $, $$, fill, h, icon, ready } from "./dom";
import { duration, inr, plural } from "./format";
import { coverImage } from "./covers";

function show(state: "loading" | "missing" | "course"): void {
  for (const el of $$("[data-state]")) el.hidden = el.dataset.state !== state;
}

function text(key: string, value: string): void {
  for (const el of $$(`[data-c="${key}"]`)) el.textContent = value;
}

function render(c: Course): void {
  const lessons = lessonTotal(c);
  const minutes = minuteTotal(c);
  document.title = `${c.title} | Feelings Beauty Care`;

  text("title", c.title);
  text("subtitle", c.subtitle);
  text("lessons", String(lessons));
  text("lessons-unit", lessons === 1 ? "lesson" : "lessons");
  text("minutes", String(minutes));
  text("level", c.level);
  text("language", c.language);
  text("enroll-label", `Enroll for ${inr(c.price)}`);
  text("see-lessons", lessons === 1 ? "See the lesson" : `See all ${plural(lessons, "lesson")}`);
  text("card-title", c.title);
  text("price", inr(c.price));
  text("lessons-sum", `${plural(c.modules.length, "module")}, ${plural(lessons, "lesson")}, ${duration(minutes)} of video in all.`);
  text("price-lead", `One payment of ${inr(c.price)}. ${plural(lessons, "video lesson")} to watch at your own pace.`);

  const cover = $<HTMLImageElement>('[data-c="cover"]');
  if (cover) {
    const img = coverImage(c.cover, c.title);
    cover.src = img.src;
    cover.alt = img.alt;
  }

  const outcomes = $('[data-c="outcomes"]');
  if (outcomes) fill(outcomes, c.outcomes.map((o) => h("li", null, icon("check-circle"), h("span", { text: o }))));

  const modules = $('[data-c="modules"]');
  if (modules) {
    fill(
      modules,
      c.modules.map((m, mi) => {
        const mins = m.lessons.reduce((s, l) => s + l.minutes, 0);
        return h(
          "section",
          { class: "cp-module", "aria-labelledby": `cp-mod-${mi}` },
          h(
            "div",
            { class: "cp-module-head" },
            h("h3", { id: `cp-mod-${mi}` }, h("span", { text: `Module ${mi + 1}` }), m.title),
            h("p", { text: `${plural(m.lessons.length, "lesson")} · ${duration(mins)}` }),
          ),
          h(
            "ol",
            { class: "cp-lessons" },
            m.lessons.map((l) =>
              h("li", null, icon("play-circle"), h("span", { class: "cp-lesson-title", text: l.title }), h("span", { class: "cp-lesson-min", text: `${l.minutes} min` })),
            ),
          ),
        );
      }),
    );
  }

  const included = $('[data-c="included"]');
  if (included) {
    const items = [
      `${plural(lessons, "video lesson")}, ${duration(minutes)} in all`,
      "Watch on phone or laptop, at your own pace",
      `Taught in ${c.language}`,
      `Level: ${c.level}`,
    ];
    fill(included, items.map((t) => h("li", null, icon("check-circle"), h("span", { text: t }))));
  }

  const wa = $<HTMLAnchorElement>('[data-c="whatsapp"]');
  if (wa) wa.href = whatsappLink(`Hi Urmi, I have a question about the course "${c.title}".`);

  // Enroll: a demo note, never the main course's checkout.
  const dialog = $<HTMLDialogElement>("[data-enroll-dialog]");
  if (c.main) {
    const title = $("[data-dlg-title]");
    if (title) title.textContent = "Enroll on the course page";
    const body = $("[data-dlg-text]");
    if (body) body.textContent = "This course has its own page with the full checkout.";
  }
  for (const link of $$<HTMLAnchorElement>("[data-enroll]")) {
    link.addEventListener("click", (event) => {
      if (!dialog || typeof dialog.showModal !== "function") return;
      event.preventDefault();
      dialog.showModal();
    });
  }
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });

  show("course");
}

ready(() => {
  const params = new URLSearchParams(location.search);
  const id = params.get("id");
  const preview = params.get("preview") === "1";
  const c = id ? getCourse(id) : null;

  if (!c || (c.status !== "published" && !preview)) {
    if (c) {
      const t = $("[data-missing-title]");
      if (t) t.textContent = "This course isn’t published yet";
      const p = $("[data-missing-text]");
      if (p) p.textContent = "It’s still a draft. Have a look at the courses that are open now.";
    }
    document.title = "Course not found | Feelings Beauty Care";
    show("missing");
    return;
  }

  if (preview) {
    const bar = $("[data-preview-bar]");
    const msg = $("[data-preview-text]");
    if (msg) msg.textContent = c.status === "published" ? "Preview: this course is live in the catalog." : "Preview of a draft: students can’t see this page yet.";
    const back = $<HTMLAnchorElement>("[data-back-editor]");
    if (back) back.href = `/admin/courses/edit?id=${encodeURIComponent(c.id)}`;
    if (bar) bar.hidden = false;
  }
  render(c);
});
