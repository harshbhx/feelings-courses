/** Courses list (GET /api/admin/courses) and the "New course" dialog (POST /api/admin/courses). */
import type { AdminCourse, AdminCourseInput, CourseFormat, CourseStatus } from "../../../shared/types";
import { admin, asApiError, hostsReady, siteHosts } from "./api";
import { $, $$, fill, h, icon, ready } from "./dom";
import { field, input, setErrors } from "./fields";
import { num, plural } from "./format";
import { emptyBox, loadInto } from "./states";
import { formDialog } from "./ui";
import { FORMAT_LABELS, STATUS_LABELS } from "../lib/course-form";
import { domainView } from "../lib/domain";
import { describeError } from "../lib/errors";
import { feeLabel } from "../lib/money";
import { courseAddresses, courseSlugFrom, courseSlugProblem, tidyCourseSlug } from "../lib/slug";
import { imageUrl } from "../lib/upload";

type Filter = "all" | CourseStatus;

const FORMAT_SHORT: Record<CourseFormat, string> = { online: "Recorded", in_person: "In-person", hybrid: "Batches + recorded" };

function statusPill(c: AdminCourse): HTMLElement {
  return h("span", { class: c.status === "published" ? "pill pill-live" : c.status === "archived" ? "pill pill-plain" : "pill", text: STATUS_LABELS[c.status] });
}

function cover(c: AdminCourse): HTMLElement {
  if (c.coverKey) return h("img", { class: "crs-cover", src: imageUrl(c.coverKey), alt: "", width: 72, height: 90, loading: "lazy", decoding: "async" });
  return h("span", { class: "crs-cover crs-cover-empty", "aria-hidden": "true" }, icon(c.format === "in_person" ? "calendar-blank" : "book-open-text"));
}

function row(c: AdminCourse): HTMLElement {
  const title = c.title.trim() || "Untitled course";
  const hosts = siteHosts();
  const addr = courseAddresses(c.slug, hosts);
  const live = c.domainStatus === "active";
  const viewHref = live ? addr.subdomainUrl : addr.hubUrl;
  const contents =
    c.format === "in_person"
      ? plural(c.batches.length, "batch", "batches")
      : c.format === "hybrid"
        ? `${plural(c.lessonCount, "lesson")} · ${plural(c.batches.length, "batch", "batches")}`
        : plural(c.lessonCount, "lesson");
  return h(
    "li",
    { class: "crs-item" },
    h(
      "div",
      { class: "crs-main" },
      cover(c),
      h(
        "div",
        { class: "crs-info" },
        h("p", { class: "crs-title" }, title, c.isDemo ? h("span", { class: "crs-tag", text: "Example" }) : null),
        h("p", { class: "crs-meta" }, h("span", { class: "crs-price", text: `${feeLabel(c.pricePaise)} · ` }), `${FORMAT_SHORT[c.format]} · ${contents}`),
        h(
          "p",
          { class: "crs-host", title: domainView(c.domainStatus, c.slug, hosts).help },
          icon("link-simple"),
          live ? addr.host : `${addr.host} · ${domainView(c.domainStatus, c.slug, hosts).label.toLowerCase()}`,
        ),
        h("div", { class: "crs-line" }, statusPill(c), h("span", { class: "crs-students" }, icon("users-three"), plural(c.enrollmentCount, "student"))),
      ),
    ),
    h("span", { class: "crs-cell-price" }, h("span", { class: "visually-hidden", text: "Fee: " }), feeLabel(c.pricePaise)),
    h("span", { class: "crs-cell-status" }, h("span", { class: "visually-hidden", text: "Status: " }), statusPill(c)),
    h("span", { class: "crs-cell-students" }, h("span", { class: "visually-hidden", text: "Students: " }), num(c.enrollmentCount)),
    h(
      "div",
      { class: "crs-actions" },
      c.status === "published"
        ? h("a", { class: "btn btn-ghost", href: viewHref, target: "_blank", rel: "noopener", "aria-label": `View ${title} on the site (opens a new tab)` }, icon("eye"), "View")
        : null,
      h("a", { class: "btn btn-secondary", href: `/admin/courses/edit?id=${c.id}`, "aria-label": `Edit ${title}` }, icon("pencil-simple"), "Edit"),
    ),
  );
}

/** The "New course" dialog. */
export function newCourseDialog(): void {
  const title = input({ maxlength: 120, placeholder: "e.g. Bridal makeup basics", dataset: { field: "title" } });
  const slug = input({ maxlength: 40, inputmode: "url", autocapitalize: "off", spellcheck: "false", placeholder: "bridal-basics", dataset: { field: "slug" } });
  const hostNote = h("p", { class: "field-hint", "aria-live": "polite" });
  let slugTouched = false;
  const showHost = () => {
    const s = slug.value.trim();
    hostNote.textContent = s && !courseSlugProblem(s) ? `Its address: ${courseAddresses(s, siteHosts()).host}` : "Lowercase letters, digits and hyphens. It becomes the course's own web address.";
  };
  title.addEventListener("input", () => {
    if (!slugTouched) slug.value = courseSlugFrom(title.value);
    showHost();
  });
  slug.addEventListener("input", () => {
    slugTouched = true;
    const at = slug.selectionStart ?? slug.value.length;
    const tidy = tidyCourseSlug(slug.value);
    if (tidy !== slug.value) {
      slug.value = tidy;
      slug.setSelectionRange(Math.min(at, tidy.length), Math.min(at, tidy.length));
    }
    showHost();
  });
  showHost();

  const choices = (Object.keys(FORMAT_LABELS) as CourseFormat[]).map((f) =>
    h(
      "label",
      { class: "choice" },
      h("input", { type: "radio", name: "format", value: f, checked: f === "online" }),
      h("strong", { text: FORMAT_LABELS[f].title }),
      h("span", { text: FORMAT_LABELS[f].hint }),
    ),
  );
  const formatGroup = h(
    "fieldset",
    { class: "field" },
    h("legend", { class: "field-label", text: "What kind of course?" }),
    h("div", { class: "choice-grid" }, choices),
    h("p", { class: "field-hint", text: "You can change this later." }),
  );

  const slugField = field({ label: "Web address", control: slug, name: "slug" });
  slugField.insertBefore(hostNote, slugField.querySelector(".field-error"));

  formDialog({
    title: "New course",
    intro: "Start with the basics. Everything else (fee, lessons, batches, photos) is in the editor next.",
    submit: "Create draft",
    body: [field({ label: "Course title", control: title, name: "title" }), slugField, formatGroup],
    onSubmit: async (d) => {
      const errors: Record<string, string> = {};
      if (!title.value.trim()) errors.title = "Give the course a title.";
      const problem = courseSlugProblem(slug.value);
      if (problem) errors.slug = problem;
      if (Object.keys(errors).length) {
        setErrors(d.form, errors);
        return false;
      }
      const format = (d.form.querySelector<HTMLInputElement>("input[name=format]:checked")?.value ?? "online") as CourseFormat;
      try {
        // The API fills in the rest (teacher, 365 days of access, no fee yet): see docs/admin-api.md.
        const draft = { title: title.value.trim(), slug: slug.value.trim(), format } as Partial<AdminCourseInput> as AdminCourseInput;
        const created = await admin("POST /api/admin/courses", {}, draft);
        location.assign(`/admin/courses/edit?id=${created.id}&new=1`);
        return false; // keep the dialog while the editor loads
      } catch (err) {
        const e = asApiError(err);
        const unplaced = setErrors(d.form, e.fields);
        if (e.code === "slug_taken") setErrors(d.form, { slug: e.message });
        else if (!Object.keys(e.fields).length || Object.keys(unplaced).length) d.setMessage(describeError(e).message);
        return false;
      }
    },
  });
}

ready(() => {
  const region = $("[data-region]");
  const list = $("[data-list]");
  const live = $("[data-list-live]");
  if (!region || !list) return;
  let courses: AdminCourse[] = [];
  let filter: Filter = "all";

  const render = () => {
    for (const key of ["all", "published", "draft", "archived"] as Filter[]) {
      const n = key === "all" ? courses.length : courses.filter((c) => c.status === key).length;
      const el = $(`[data-count="${key}"]`);
      if (el) el.textContent = `(${n})`;
    }
    const shown = filter === "all" ? courses : courses.filter((c) => c.status === filter);
    if (!courses.length) {
      fill(
        list,
        h(
          "li",
          { class: "crs-region-state" },
          emptyBox({
            icon: "book-open-text",
            title: "No courses yet",
            text: "Make your first course: a recorded course, in-person batches, or both.",
            action: h("button", { type: "button", class: "btn btn-primary", onClick: newCourseDialog }, icon("plus"), "New course"),
          }),
        ),
      );
    } else if (!shown.length) {
      fill(list, h("li", { class: "crs-region-state" }, emptyBox({ icon: "book-open-text", title: `No ${filter === "draft" ? "drafts" : filter} courses` })));
    } else fill(list, shown.map(row));
    if (live) live.textContent = `${plural(shown.length, "course")} shown.`;
  };

  for (const button of $$<HTMLButtonElement>("[data-filter]")) {
    button.addEventListener("click", () => {
      filter = button.dataset.filter as Filter;
      for (const b of $$("[data-filter]")) b.setAttribute("aria-pressed", String(b === button));
      render();
    });
  }
  $("[data-new-course]")?.addEventListener("click", newCourseDialog);
  if (new URLSearchParams(location.search).get("new")) newCourseDialog();

  const head = region.querySelector(".crs-head");
  void loadInto(
    list,
    async () => (await Promise.all([admin("GET /api/admin/courses"), hostsReady()]))[0],
    (data) => {
      courses = data;
      head?.removeAttribute("hidden");
      render();
    },
    { what: "your courses", rows: 3 },
  );
});
