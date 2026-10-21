/**
 * /admin/students (DEMO): the example students from src/lib/demo-store-students.ts, with search,
 * course and progress filters, a sort, "Show more", a detail drawer and a CSV export.
 *
 * The filters live in the URL (?q=, ?course=, ?progress=, ?sort=), and ?id=<student id> opens that
 * student's drawer, so other screens can link straight to a student. ?preview=empty shows the
 * screen as it looks before the first sale.
 */
import { $, fill, h, icon, ready } from "../client/dom";
import { toast } from "../client/ui";
import { fullDate, initials, maskPhone, num, plural } from "../client/format";
import {
  courseOptions,
  getStudentRows,
  studentSummary,
  type ProgressBand,
  type StudentRow,
} from "../../../lib/demo-store-students";
import { openStudent } from "./drawer";
import { downloadStudentsCsv } from "./csv";

const PAGE = 20;
const SORTS = ["new", "old", "most", "least", "name"] as const;
type Sort = (typeof SORTS)[number];
const BANDS: ProgressBand[] = ["none", "some", "done"];

interface State {
  q: string;
  course: string;
  progress: ProgressBand | "";
  sort: Sort;
  shown: number;
}

const params = new URLSearchParams(location.search);
const preview = params.get("preview") === "empty";
let rows: StudentRow[] = [];
let matches: StudentRow[] = [];
const state: State = {
  q: (params.get("q") ?? "").slice(0, 80),
  course: params.get("course") ?? "",
  progress: BANDS.includes(params.get("progress") as ProgressBand) ? (params.get("progress") as ProgressBand) : "",
  sort: SORTS.includes(params.get("sort") as Sort) ? (params.get("sort") as Sort) : "new",
  shown: PAGE,
};

// ── Filtering ─────────────────────────────────────────────────────────

const norm = (text: string) => text.toLowerCase().normalize("NFKD").replace(/\s+/g, " ").trim();

function filterRows(): StudentRow[] {
  const q = norm(state.q);
  const digits = q.replace(/\D/g, "");
  const list = rows.filter((s) => {
    if (state.course && s.courseId !== state.course) return false;
    if (state.progress && s.band !== state.progress) return false;
    if (!q) return true;
    if (norm(s.name).includes(q) || norm(s.city).includes(q)) return true;
    return digits.length >= 3 && digits.length === q.replace(/\s/g, "").length && s.phone.includes(digits);
  });
  const byName = (a: StudentRow, b: StudentRow) => a.name.localeCompare(b.name, "en-IN");
  const sorters: Record<Sort, (a: StudentRow, b: StudentRow) => number> = {
    new: (a, b) => b.enrolledOn.localeCompare(a.enrolledOn),
    old: (a, b) => a.enrolledOn.localeCompare(b.enrolledOn),
    most: (a, b) => b.progress - a.progress || byName(a, b),
    least: (a, b) => a.progress - b.progress || byName(a, b),
    name: byName,
  };
  return list.sort(sorters[state.sort]);
}

const filtersOn = () => Boolean(state.q || state.course || state.progress);

function syncUrl(openId?: string | null): void {
  const next = new URLSearchParams();
  if (preview) next.set("preview", "empty");
  if (state.q) next.set("q", state.q);
  if (state.course) next.set("course", state.course);
  if (state.progress) next.set("progress", state.progress);
  if (state.sort !== "new") next.set("sort", state.sort);
  if (openId) next.set("id", openId);
  const query = next.toString();
  try {
    history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}`);
  } catch {
    /* some embedded browsers refuse; the filters still work */
  }
}

// ── Rendering ─────────────────────────────────────────────────────────

function rowEl(s: StudentRow): HTMLLIElement {
  const meter = h("span", { class: `meter stu-meter${s.progress >= 100 ? " is-done" : ""}`, "aria-hidden": "true" }, h("span"));
  meter.style.setProperty("--p", `${s.progress}%`);
  const enrolled = new Date(s.enrolledOn);
  return h(
    "li",
    { class: "stu-row", dataset: { id: s.id } },
    h("span", { class: "avatar avatar-soft stu-av", "aria-hidden": "true", text: initials(s.name) }),
    h(
      "span",
      { class: "stu-name" },
      h("button", { type: "button", class: "stu-open", "aria-haspopup": "dialog", dataset: { open: s.id } }, s.name),
      s.refunded ? h("span", { class: "stu-tag", text: "Refunded" }) : null,
    ),
    h("span", { class: "stu-city", text: s.city }),
    h("span", { class: "stu-phone num" }, h("span", { class: "visually-hidden", text: "Phone " }), maskPhone(s.phone)),
    h("span", { class: "stu-course" }, h("span", { class: "visually-hidden", text: "Course: " }), s.courseTitle),
    meter,
    h(
      "span",
      { class: "stu-pct num" },
      h("span", { class: "visually-hidden", text: "Progress: " }),
      `${s.progress}%`,
      h("span", { class: "stu-count", text: ` · ${s.lessonsDone}/${s.lessonsTotal}` }),
    ),
    h(
      "span",
      { class: "stu-date" },
      h("span", { class: "visually-hidden", text: "Enrolled " }),
      h("time", { datetime: enrolled.toISOString(), text: fullDate(enrolled) }),
    ),
    icon("caret-right", "icon stu-chev"),
  );
}

function renderSummary(): void {
  const sum = studentSummary(rows);
  const set = (key: string, value: string) => {
    const el = $(`[data-s="${key}"]`);
    if (el) el.textContent = value;
  };
  set("total", num(sum.total));
  set("total-meta", sum.thisMonth ? `${num(sum.thisMonth)} joined this month` : "None joined this month yet");
  set("active", num(sum.activeWeek));
  set("finished", num(sum.finished));
  set("finished-meta", sum.total ? `${Math.round((sum.finished / sum.total) * 100)}% of students` : "No students yet");
  set("none", num(sum.notStarted));
}

function renderCourseOptions(): void {
  const select = $<HTMLSelectElement>("#stu-course");
  if (!select) return;
  const options = courseOptions(rows);
  if (state.course && !options.some((o) => o.id === state.course)) state.course = "";
  fill(
    select,
    h("option", { value: "" }, "All courses"),
    options.map((o) => h("option", { value: o.id }, `${o.title} (${num(o.count)})`)),
  );
  select.value = state.course;
}

function emptyState(): HTMLElement {
  return h(
    "div",
    { class: "empty stu-empty" },
    icon("users-three"),
    h("strong", { text: "No students yet" }),
    h("p", { text: "When someone buys a course, they appear here with their progress and payment." }),
    h("a", { class: "btn btn-secondary", href: "/admin/courses" }, "See your courses", icon("arrow-right")),
  );
}

function noResults(): HTMLElement {
  const what = state.q ? `“${state.q}”` : "these filters";
  return h(
    "div",
    { class: "empty stu-empty" },
    icon("magnifying-glass"),
    h("strong", { text: `No students match ${what}` }),
    h("p", { text: "Try a first name, a city or the last digits of a phone number, or clear the filters." }),
    h("button", { type: "button", class: "btn btn-secondary", dataset: { clear: "" } }, "Clear search and filters"),
  );
}

let announceTimer = 0;
function announce(text: string): void {
  window.clearTimeout(announceTimer);
  announceTimer = window.setTimeout(() => {
    const live = $("[data-live]");
    if (live) live.textContent = text;
  }, 450);
}

function render(focusFrom = -1): void {
  const list = $<HTMLUListElement>("[data-list]");
  const states = $("[data-states]");
  const more = $<HTMLButtonElement>("[data-more]");
  const count = $("[data-count]");
  const clear = $("[data-clear-top]");
  const exportBtn = $<HTMLButtonElement>("[data-export]");
  if (!list || !states || !more || !count) return;

  matches = filterRows();
  const shown = Math.min(state.shown, matches.length);

  document.body.classList.toggle("stu-is-empty", rows.length === 0);
  clear?.toggleAttribute("hidden", !filtersOn());
  if (exportBtn) {
    exportBtn.disabled = rows.length === 0;
    exportBtn.title = rows.length ? "" : "No students to export yet";
  }

  if (rows.length === 0) {
    fill(list);
    fill(states, emptyState());
    count.textContent = "No students yet";
  } else if (matches.length === 0) {
    fill(list);
    fill(states, noResults());
    count.textContent = "No matches";
  } else {
    fill(states);
    fill(list, matches.slice(0, shown).map(rowEl));
    count.textContent =
      shown < matches.length ? `Showing ${num(shown)} of ${plural(matches.length, "student")}` : plural(matches.length, "student");
  }
  list.removeAttribute("aria-busy");

  const left = matches.length - shown;
  more.hidden = left <= 0;
  more.textContent = `Show ${num(Math.min(PAGE, left))} more`;

  if (focusFrom >= 0) $<HTMLButtonElement>(`.stu-row:nth-child(${focusFrom + 1}) .stu-open`, list)?.focus();
}

function update(): void {
  state.shown = PAGE;
  render();
  syncUrl();
  announce(
    matches.length
      ? `${plural(matches.length, "student")} ${filtersOn() ? "match" : "in total"}.`
      : "No students match. Clear the search or filters to see everyone.",
  );
}

function clearFilters(): void {
  state.q = "";
  state.course = "";
  state.progress = "";
  const q = $<HTMLInputElement>("#stu-q");
  if (q) q.value = "";
  const course = $<HTMLSelectElement>("#stu-course");
  if (course) course.value = "";
  const progress = $<HTMLSelectElement>("#stu-progress");
  if (progress) progress.value = "";
  update();
  q?.focus();
}

function open(id: string, from: HTMLElement | null): void {
  const s = rows.find((r) => r.id === id);
  if (!s) return;
  syncUrl(id);
  openStudent(s, from, () => syncUrl());
}

// ── Start ─────────────────────────────────────────────────────────────

ready(() => {
  rows = preview ? [] : getStudentRows();
  renderSummary();
  renderCourseOptions();

  const q = $<HTMLInputElement>("#stu-q");
  const course = $<HTMLSelectElement>("#stu-course");
  const progress = $<HTMLSelectElement>("#stu-progress");
  const sort = $<HTMLSelectElement>("#stu-sort");
  if (q) q.value = state.q;
  if (progress) progress.value = state.progress;
  if (sort) sort.value = state.sort;

  q?.addEventListener("input", () => {
    state.q = q.value.slice(0, 80);
    update();
  });
  // Escape in a non-empty search clears it (the browser does this for type=search too).
  q?.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && q.value) {
      q.value = "";
      state.q = "";
      update();
    }
  });
  course?.addEventListener("change", () => {
    state.course = course.value;
    update();
  });
  progress?.addEventListener("change", () => {
    state.progress = progress.value as ProgressBand | "";
    update();
  });
  sort?.addEventListener("change", () => {
    state.sort = sort.value as Sort;
    update();
  });

  $("[data-more]")?.addEventListener("click", () => {
    const from = state.shown;
    state.shown += PAGE;
    render(from);
  });

  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (!target) return;
    const opener = target.closest<HTMLButtonElement>("[data-open]");
    if (opener) {
      open(opener.dataset.open ?? "", opener);
      return;
    }
    if (target.closest("[data-clear], [data-clear-top]")) clearFilters();
  });

  $("[data-export]")?.addEventListener("click", () => {
    if (!matches.length) {
      toast("Nothing to export: no students match the search and filters.", "info");
      return;
    }
    const name = downloadStudentsCsv(matches);
    toast(`Downloaded ${plural(matches.length, "example student")} as ${name}.`, "success");
  });

  render();
  syncUrl();

  const id = params.get("id");
  if (id && rows.some((r) => r.id === id)) {
    const button = $<HTMLButtonElement>(`[data-open="${CSS.escape(id)}"]`);
    open(id, button);
  }
});

