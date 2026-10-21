/**
 * Course editor. Keeps a working copy of the course in memory, renders the outcome and lesson
 * lists from it, validates with friendly inline errors and saves to the demo store.
 *
 * Drafts need only a title; publishing needs everything a course page shows.
 */
import {
  blankCourse,
  deleteCourse,
  getCourse,
  lessonTotal,
  minuteTotal,
  newCourseId,
  saveCourse,
  uid,
  type Course,
  type Lesson,
  type Module,
} from "../../../lib/demo-store";
import { $, $$, fill, h, icon, ready } from "./dom";
import { ago, duration, inr, plural } from "./format";
import { coverImage } from "./covers";
import { confirmDialog, reportSave } from "./ui";

const LIMITS = { outcomes: 10, modules: 20, lessons: 30, price: 100000, minutes: 300, uploadBytes: 8 * 1024 * 1024, dataUrl: 450_000 };
const YOUTUBE = /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?(.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/|youtube-nocookie\.com\/embed\/)[\w-]{11}/i;

interface Problem {
  id: string;
  message: string;
}

let course: Course;
let isNew = true;
let savedStatus: Course["status"] = "draft";
let savedAt: string | null = null;
let dirty = false;
let showErrors = false;

// ── Elements ─────────────────────────────────────────────────────────

const el = {
  form: () => $<HTMLFormElement>("#course-form"),
  title: () => $<HTMLInputElement>("#f-title"),
  subtitle: () => $<HTMLTextAreaElement>("#f-subtitle"),
  price: () => $<HTMLInputElement>("#f-price"),
  level: () => $<HTMLSelectElement>("#f-level"),
  language: () => $<HTMLSelectElement>("#f-language"),
  publish: () => $<HTMLInputElement>("#f-publish"),
  file: () => $<HTMLInputElement>("#f-cover"),
};

function announce(message: string): void {
  const live = $("[data-announce]");
  if (live) live.textContent = message;
}

function markDirty(): void {
  dirty = true;
  updateState();
  if (showErrors) showProblems(validate(mode()), false);
}

const mode = (): "draft" | "publish" => (el.publish()?.checked ? "publish" : "draft");

// ── Header, publish card, card preview ───────────────────────────────

function updateState(): void {
  const heading = $("[data-ed-heading]");
  if (heading) heading.textContent = course.title.trim() || (isNew ? "New course" : "Untitled course");
  const state = $("[data-ed-state]");
  if (state) {
    if (isNew) fill(state, h("span", { class: "pill", text: "Draft" }), "Not saved yet");
    else {
      const status = savedStatus === "published" ? "Published" : "Draft";
      const when = savedAt ? ago(new Date(savedAt)) : "";
      const saved = /^(Just|Yesterday)/.test(when) ? when[0].toLowerCase() + when.slice(1) : when;
      fill(state, h("span", { class: savedStatus === "published" ? "pill pill-live" : "pill", text: status }), dirty ? "Unsaved changes" : `Saved ${saved}`);
    }
  }

  const on = mode() === "publish";
  const label = on ? (savedStatus === "published" && !isNew ? "Save changes" : "Publish") : savedStatus === "published" && !isNew ? "Save as draft" : "Save draft";
  for (const b of $$("[data-save-label]")) b.textContent = label;
  const help = $("[data-pub-help]");
  if (help) help.textContent = on ? "On: students see it in the catalog once you save." : "Off: a draft only you can see.";
  const live = $("[data-live]");
  if (live) live.hidden = !(savedStatus === "published" && !isNew && !dirty);

  for (const a of $$<HTMLAnchorElement>("[data-preview]")) a.href = previewUrl();
  cardPreview();
}

function previewUrl(): string {
  if (isNew) return "#";
  return `/course?id=${encodeURIComponent(course.id)}&preview=1`;
}

function cardPreview(): void {
  const img = $<HTMLImageElement>("[data-prev-img]");
  const cover = coverImage(course.cover, course.title);
  if (img && img.getAttribute("src") !== cover.src) img.src = cover.src;
  const t = $("[data-prev-title]");
  if (t) t.textContent = course.title.trim() || "Untitled course";
  const meta = $("[data-prev-meta]");
  if (meta) meta.textContent = `${plural(lessonTotal(course), "lesson")} · ${duration(minuteTotal(course))} · ${course.level}`;
  const price = $("[data-prev-price]");
  if (price) price.textContent = course.price > 0 ? inr(course.price) : "Price not set";
  const sum = $("[data-curriculum-sum]");
  if (sum) sum.textContent = `${plural(course.modules.length, "module")} · ${plural(lessonTotal(course), "lesson")} · ${duration(minuteTotal(course))}`;
}

// ── Basics ───────────────────────────────────────────────────────────

function bindBasics(): void {
  const title = el.title();
  const subtitle = el.subtitle();
  const price = el.price();
  const level = el.level();
  const language = el.language();
  const counter = $("[data-count-subtitle]");
  if (!title || !subtitle || !price || !level || !language) return;

  title.value = course.title;
  subtitle.value = course.subtitle;
  price.value = course.price ? String(course.price) : "";
  if (![...level.options].some((o) => o.value === course.level)) level.append(h("option", { value: course.level, text: course.level }));
  level.value = course.level;
  if (![...language.options].some((o) => o.value === course.language)) language.append(h("option", { value: course.language, text: course.language }));
  language.value = course.language;
  if (counter) counter.textContent = String(course.subtitle.length);

  title.addEventListener("input", () => {
    course.title = title.value;
    markDirty();
  });
  subtitle.addEventListener("input", () => {
    course.subtitle = subtitle.value;
    if (counter) counter.textContent = String(subtitle.value.length);
    markDirty();
  });
  price.addEventListener("input", () => {
    // Accept "2,999" or "₹2999": keep the digits.
    const digits = price.value.replace(/[^\d]/g, "");
    course.price = digits ? Number(digits) : 0;
    markDirty();
  });
  price.addEventListener("blur", () => {
    if (course.price) price.value = String(course.price);
  });
  level.addEventListener("change", () => {
    course.level = level.value;
    markDirty();
  });
  language.addEventListener("change", () => {
    course.language = language.value;
    markDirty();
  });
  el.publish()?.addEventListener("change", () => markDirty());
}

// ── Cover ────────────────────────────────────────────────────────────

function syncCover(): void {
  const own = $("[data-own]");
  const ownImg = $<HTMLImageElement>("[data-own-img]");
  const remove = $("[data-remove-own]");
  const addLabel = $("[data-add-label]");
  const hasUpload = course.cover.kind === "upload" || Boolean(ownImg?.dataset.url);
  if (course.cover.kind === "upload" && ownImg) ownImg.dataset.url = course.cover.dataUrl;
  if (own && ownImg) {
    own.hidden = !ownImg.dataset.url;
    if (ownImg.dataset.url && ownImg.getAttribute("src") !== ownImg.dataset.url) ownImg.src = ownImg.dataset.url;
  }
  if (remove) remove.hidden = !hasUpload;
  if (addLabel) addLabel.textContent = hasUpload ? "Upload another" : "Upload a photo";
  const value = course.cover.kind === "upload" ? "upload" : `glimpse:${course.cover.id}`;
  for (const r of $$<HTMLInputElement>('input[name="cover"]')) r.checked = r.value === value;
  cardPreview();
}

function coverError(message: string): void {
  const err = $("#f-cover-err");
  if (err) fill(err, message ? icon("warning-circle") : "", message);
}

async function decode(file: File): Promise<CanvasImageSource & { width: number; height: number }> {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through to <img> */
    }
  }
  // CSP allows data: images (not blob:), so read the file as a data URL.
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

/** Crop to 4:5, shrink to 720×900 and encode as JPEG, so the photo fits in browser storage. */
async function processUpload(file: File): Promise<string> {
  const source = await decode(file);
  const targetRatio = 4 / 5;
  let sw = source.width;
  let sh = source.height;
  let sx = 0;
  let sy = 0;
  if (sw / sh > targetRatio) {
    sw = Math.round(sh * targetRatio);
    sx = Math.round((source.width - sw) / 2);
  } else {
    sh = Math.round(sw / targetRatio);
    sy = Math.round((source.height - sh) / 4); // keep faces: crop more from the bottom
  }
  const w = Math.min(720, sw);
  const hgt = Math.round(w / targetRatio);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = hgt;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, hgt);
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, hgt);
  for (const q of [0.82, 0.7, 0.58]) {
    const url = canvas.toDataURL("image/jpeg", q);
    if (url.length <= LIMITS.dataUrl) return url;
  }
  throw new Error("too-large");
}

function bindCover(): void {
  const grid = $("[data-cover-grid]");
  grid?.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    if (input.name !== "cover") return;
    if (input.value === "upload") {
      const url = $<HTMLImageElement>("[data-own-img]")?.dataset.url;
      if (url) course.cover = { kind: "upload", dataUrl: url };
    } else {
      course.cover = { kind: "glimpse", id: input.value.replace(/^glimpse:/, "") };
    }
    coverError("");
    markDirty();
    cardPreview();
  });

  const file = el.file();
  file?.addEventListener("change", async () => {
    const chosen = file.files?.[0];
    file.value = "";
    if (!chosen) return;
    coverError("");
    if (!/^image\/(jpeg|png|webp)$/.test(chosen.type)) {
      coverError("Please choose a JPG, PNG or WebP photo.");
      return;
    }
    if (chosen.size > LIMITS.uploadBytes) {
      coverError(`That photo is ${(chosen.size / 1024 / 1024).toFixed(1)} MB. Please choose one under 8 MB.`);
      return;
    }
    try {
      const dataUrl = await processUpload(chosen);
      const ownImg = $<HTMLImageElement>("[data-own-img]");
      if (ownImg) ownImg.dataset.url = dataUrl;
      course.cover = { kind: "upload", dataUrl };
      syncCover();
      markDirty();
      announce("Photo added and chosen as the cover.");
    } catch (e) {
      coverError(
        e instanceof Error && e.message === "too-large"
          ? "This photo is still too big after shrinking it. Please try a simpler or smaller photo."
          : "We couldn’t open that photo. Please try another one.",
      );
    }
  });

  $("[data-remove-own]")?.addEventListener("click", () => {
    const ownImg = $<HTMLImageElement>("[data-own-img]");
    if (ownImg) {
      delete ownImg.dataset.url;
      ownImg.removeAttribute("src");
    }
    if (course.cover.kind === "upload") {
      const first = $<HTMLInputElement>('input[name="cover"][value^="glimpse:"]');
      course.cover = { kind: "glimpse", id: (first?.value ?? "").replace(/^glimpse:/, "") };
    }
    syncCover();
    markDirty();
    $<HTMLInputElement>('input[name="cover"]:checked')?.focus();
    announce("Your photo was removed. The first glimpse is the cover now.");
  });
}

// ── Reorderable lists ────────────────────────────────────────────────

function move<T>(list: T[], from: number, to: number): void {
  if (to < 0 || to >= list.length) return;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
}

/** Up, down and remove buttons for one item. `key` lets focus come back after a re-render. */
function tools(key: string, what: string, index: number, count: number, minCount: number, onMove: (to: number) => void, onRemove: () => void): HTMLElement {
  const up = h("button", { type: "button", class: "icon-btn", "aria-label": `Move ${what} up`, "data-key": `${key}:up`, disabled: index === 0 }, icon("arrow-up"));
  const down = h("button", { type: "button", class: "icon-btn", "aria-label": `Move ${what} down`, "data-key": `${key}:down`, disabled: index === count - 1 }, icon("arrow-down"));
  const remove = h("button", { type: "button", class: "icon-btn danger", "aria-label": `Remove ${what}`, "data-key": `${key}:remove`, disabled: count <= minCount }, icon("trash"));
  up.addEventListener("click", () => onMove(index - 1));
  down.addEventListener("click", () => onMove(index + 1));
  remove.addEventListener("click", onRemove);
  return h("div", { class: "tools" }, up, down, remove);
}

/** After a re-render, put focus back on the same control, or the nearest sensible one. */
function refocus(key: string, fallback?: string): void {
  const target = $<HTMLButtonElement>(`[data-key="${key}"]`);
  if (target && !target.disabled) return target.focus();
  const [base, action] = key.split(":");
  const other = action === "up" ? "down" : "up";
  const alt = $<HTMLButtonElement>(`[data-key="${base}:${other}"]`);
  if (alt && !alt.disabled) return alt.focus();
  if (fallback) $<HTMLElement>(fallback)?.focus();
}

function fieldError(id: string): HTMLElement {
  return h("p", { class: "field-error", id: `${id}-err` });
}

// ── Outcomes ─────────────────────────────────────────────────────────

function renderOutcomes(): void {
  const list = $("[data-outcomes]");
  if (!list) return;
  const count = course.outcomes.length;
  fill(
    list,
    course.outcomes.map((text, i) => {
      const id = `o-${i}`;
      const input = h("input", {
        class: "input",
        id,
        type: "text",
        maxlength: 120,
        value: text,
        placeholder: i === 0 ? "e.g. Match foundation to your skin tone" : "Another thing they’ll learn",
        "aria-label": `Point ${i + 1}`,
        "aria-describedby": `${id}-err`,
      });
      input.addEventListener("input", () => {
        course.outcomes[i] = input.value;
        markDirty();
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          if (i === course.outcomes.length - 1) addOutcome();
          else $<HTMLInputElement>(`#o-${i + 1}`)?.focus();
        }
      });
      return h(
        "li",
        { class: "oc" },
        h("span", { class: "oc-num", "aria-hidden": "true", text: i + 1 }),
        input,
        tools(
          `o${i}`,
          `point ${i + 1}`,
          i,
          count,
          1,
          (to) => {
            move(course.outcomes, i, to);
            renderOutcomes();
            markDirty();
            refocus(`o${to}:${to < i ? "up" : "down"}`);
            announce(`Point moved to position ${to + 1}.`);
          },
          () => {
            course.outcomes.splice(i, 1);
            renderOutcomes();
            markDirty();
            $<HTMLInputElement>(`#o-${Math.min(i, course.outcomes.length - 1)}`)?.focus();
            announce("Point removed.");
          },
        ),
        fieldError(id),
      );
    }),
  );
  const add = $<HTMLButtonElement>("[data-add-outcome]");
  if (add) add.disabled = count >= LIMITS.outcomes;
}

function addOutcome(): void {
  if (course.outcomes.length >= LIMITS.outcomes) return;
  course.outcomes.push("");
  renderOutcomes();
  markDirty();
  $<HTMLInputElement>(`#o-${course.outcomes.length - 1}`)?.focus();
}

// ── Modules and lessons ──────────────────────────────────────────────

function lessonRow(mod: Module, lesson: Lesson, li: number): HTMLElement {
  const base = `l-${lesson.id}`;
  const title = h("input", {
    class: "input",
    id: `${base}-title`,
    type: "text",
    maxlength: 90,
    value: lesson.title,
    placeholder: "e.g. Know your skin type",
    "aria-describedby": `${base}-title-err`,
  });
  const minutes = h("input", {
    class: "input num",
    id: `${base}-min`,
    type: "text",
    inputmode: "numeric",
    maxlength: 3,
    value: lesson.minutes ? String(lesson.minutes) : "",
    placeholder: "10",
    "aria-describedby": `${base}-min-err`,
  });
  const youtube = h("input", {
    class: "input",
    id: `${base}-yt`,
    type: "url",
    inputmode: "url",
    autocomplete: "off",
    value: lesson.youtube,
    placeholder: "https://youtu.be/…",
    "aria-describedby": `${base}-yt-err`,
  });
  title.addEventListener("input", () => {
    lesson.title = title.value;
    markDirty();
  });
  minutes.addEventListener("input", () => {
    const digits = minutes.value.replace(/[^\d]/g, "");
    lesson.minutes = digits ? Number(digits) : 0;
    markDirty();
  });
  youtube.addEventListener("input", () => {
    lesson.youtube = youtube.value.trim();
    markDirty();
  });

  const count = mod.lessons.length;
  return h(
    "li",
    { class: "les" },
    h(
      "div",
      { class: "les-top" },
      h("span", { class: "les-label" }, h("span", { class: "les-num", "aria-hidden": "true", text: li + 1 }), `Lesson ${li + 1}`),
      tools(
        base,
        `lesson ${li + 1}`,
        li,
        count,
        1,
        (to) => {
          move(mod.lessons, li, to);
          renderModules();
          markDirty();
          refocus(`${base}:${to < li ? "up" : "down"}`);
          announce(`Lesson moved to position ${to + 1}.`);
        },
        () => {
          mod.lessons.splice(li, 1);
          renderModules();
          markDirty();
          const next = mod.lessons[Math.min(li, mod.lessons.length - 1)];
          if (next) $<HTMLInputElement>(`#l-${next.id}-title`)?.focus();
          announce("Lesson removed.");
        },
      ),
    ),
    h(
      "div",
      { class: "les-fields" },
      h("div", { class: "field f-title" }, h("label", { class: "field-label", for: `${base}-title`, text: "Lesson title" }), title, fieldError(`${base}-title`)),
      h("div", { class: "field" }, h("label", { class: "field-label", for: `${base}-min`, text: "Minutes" }), minutes, fieldError(`${base}-min`)),
      h(
        "div",
        { class: "field" },
        h("label", { class: "field-label", for: `${base}-yt` }, "YouTube link ", h("span", { class: "opt", text: "(optional)" })),
        youtube,
        fieldError(`${base}-yt`),
      ),
    ),
  );
}

function renderModules(): void {
  const wrap = $("[data-modules]");
  if (!wrap) return;
  const count = course.modules.length;
  fill(
    wrap,
    course.modules.map((mod, mi) => {
      const base = `m-${mod.id}`;
      const title = h("input", {
        class: "input",
        id: `${base}-title`,
        type: "text",
        maxlength: 80,
        value: mod.title,
        placeholder: "e.g. Skin prep and base",
        "aria-describedby": `${base}-title-err`,
      });
      title.addEventListener("input", () => {
        mod.title = title.value;
        markDirty();
      });
      const addLesson = h("button", { type: "button", class: "btn btn-ghost add-lesson", disabled: mod.lessons.length >= LIMITS.lessons }, icon("plus"), "Add a lesson");
      addLesson.addEventListener("click", () => {
        const lesson: Lesson = { id: uid("l"), title: "", minutes: 10, youtube: "" };
        mod.lessons.push(lesson);
        renderModules();
        markDirty();
        $<HTMLInputElement>(`#l-${lesson.id}-title`)?.focus();
      });
      return h(
        "section",
        { class: "mod", "aria-labelledby": `${base}-label` },
        h(
          "div",
          { class: "mod-head" },
          h(
            "div",
            { class: "mod-top" },
            h("h3", { class: "mod-label", id: `${base}-label`, text: `Module ${mi + 1}` }),
            tools(
              base,
              `module ${mi + 1}`,
              mi,
              count,
              1,
              (to) => {
                move(course.modules, mi, to);
                renderModules();
                markDirty();
                refocus(`${base}:${to < mi ? "up" : "down"}`);
                announce(`Module moved to position ${to + 1}.`);
              },
              async () => {
                const lessons = mod.lessons.filter((l) => l.title.trim()).length;
                if (lessons) {
                  const ok = await confirmDialog({
                    title: `Remove module ${mi + 1}?`,
                    body: `${mod.title.trim() || "This module"} and its ${plural(mod.lessons.length, "lesson")} will be removed from the course.`,
                    confirm: "Remove module",
                    danger: true,
                  });
                  if (!ok) return;
                }
                course.modules.splice(mi, 1);
                renderModules();
                markDirty();
                const next = course.modules[Math.min(mi, course.modules.length - 1)];
                if (next) $<HTMLInputElement>(`#m-${next.id}-title`)?.focus();
                announce("Module removed.");
              },
            ),
          ),
          h("div", { class: "field" }, h("label", { class: "field-label", for: `${base}-title`, text: "Module title" }), title, fieldError(`${base}-title`)),
        ),
        h("ol", { class: "lessons", "aria-label": `Lessons in module ${mi + 1}` }, mod.lessons.map((lesson, li) => lessonRow(mod, lesson, li))),
        h("div", { class: "lessons-foot" }, addLesson),
      );
    }),
  );
  const add = $<HTMLButtonElement>("[data-add-module]");
  if (add) add.disabled = count >= LIMITS.modules;
  cardPreview();
}

// ── Validation ───────────────────────────────────────────────────────

function validate(kind: "draft" | "publish"): Problem[] {
  const problems: Problem[] = [];
  const publish = kind === "publish";
  const t = course.title.trim();
  if (t.length < 3) problems.push({ id: "f-title", message: t ? "The title needs at least 3 letters." : "Give the course a title." });

  const sub = course.subtitle.trim();
  if (publish && !sub) problems.push({ id: "f-subtitle", message: "Add a one-line description, so students know what they’ll learn." });

  const priceRaw = el.price()?.value.trim() ?? "";
  if (priceRaw && !/^[₹\s]*[\d,]+$/.test(priceRaw)) problems.push({ id: "f-price", message: "Use numbers only, like 2999." });
  else if (course.price > LIMITS.price) problems.push({ id: "f-price", message: "The demo takes prices up to ₹1,00,000." });
  else if (publish && course.price < 1) problems.push({ id: "f-price", message: "Set a price before you publish, like 2999." });

  const outcomes = course.outcomes.map((o) => o.trim());
  if (publish && !outcomes.some(Boolean)) problems.push({ id: "o-0", message: "Add at least one thing students will learn." });

  if (publish && !course.modules.length) problems.push({ id: "f-modules-err", message: "Add at least one module with a lesson." });
  for (const [mi, mod] of course.modules.entries()) {
    if (publish && !mod.title.trim()) problems.push({ id: `m-${mod.id}-title`, message: `Give module ${mi + 1} a title.` });
    for (const [li, lesson] of mod.lessons.entries()) {
      const where = `module ${mi + 1}, lesson ${li + 1}`;
      if (publish && !lesson.title.trim()) problems.push({ id: `l-${lesson.id}-title`, message: `Give ${where} a title.` });
      const minRaw = $<HTMLInputElement>(`#l-${lesson.id}-min`)?.value.trim() ?? String(lesson.minutes || "");
      if (minRaw && !/^\d+$/.test(minRaw)) problems.push({ id: `l-${lesson.id}-min`, message: "Minutes: numbers only." });
      else if (lesson.minutes > LIMITS.minutes) problems.push({ id: `l-${lesson.id}-min`, message: "Keep a lesson under 300 minutes." });
      else if (publish && lesson.minutes < 1) problems.push({ id: `l-${lesson.id}-min`, message: `How many minutes is ${where}?` });
      if (lesson.youtube && !YOUTUBE.test(lesson.youtube)) {
        problems.push({ id: `l-${lesson.id}-yt`, message: "That isn’t a YouTube link. Copy it from Share on YouTube." });
      }
    }
  }
  return problems;
}

function showProblems(problems: Problem[], focusSummary: boolean): void {
  // Clear old errors.
  for (const err of $$(".ed .field-error")) {
    if (err.id === "f-cover-err") continue;
    err.replaceChildren();
  }
  for (const input of $$("[aria-invalid]")) input.removeAttribute("aria-invalid");

  for (const p of problems) {
    const field = document.getElementById(p.id);
    const err = document.getElementById(`${p.id}-err`) ?? (field?.classList.contains("field-error") ? field : null);
    if (field && field.tagName !== "P") field.setAttribute("aria-invalid", "true");
    if (err && !err.textContent) fill(err, icon("warning-circle"), p.message);
  }

  const summary = $("[data-summary]");
  const list = $("[data-summary-list]");
  const title = $("[data-summary-title]");
  if (!summary || !list || !title) return;
  if (!problems.length) {
    summary.hidden = true;
    return;
  }
  title.textContent =
    mode() === "publish"
      ? `${plural(problems.length, "thing")} to fix before you publish`
      : `${plural(problems.length, "thing")} to fix before you save`;
  fill(
    list,
    problems.slice(0, 8).map((p) => {
      const a = h("a", { href: `#${p.id}`, text: p.message });
      a.addEventListener("click", (event) => {
        event.preventDefault();
        const target = document.getElementById(p.id);
        target?.scrollIntoView({ block: "center" });
        target?.focus();
      });
      return h("li", null, a);
    }),
    problems.length > 8 ? h("li", { text: `and ${problems.length - 8} more` }) : null,
  );
  summary.hidden = false;
  if (focusSummary) {
    summary.scrollIntoView({ block: "start" });
    summary.focus();
  }
}

// ── Save, preview, delete ────────────────────────────────────────────

function cleaned(): Course {
  const c: Course = JSON.parse(JSON.stringify(course)) as Course;
  c.title = c.title.trim();
  c.subtitle = c.subtitle.trim();
  c.outcomes = c.outcomes.map((o) => o.trim()).filter(Boolean);
  c.modules = c.modules.map((m) => ({
    ...m,
    title: m.title.trim(),
    lessons: m.lessons.map((l) => ({ ...l, title: l.title.trim(), youtube: l.youtube.trim() })),
  }));
  c.status = mode() === "publish" ? "published" : "draft";
  return c;
}

function save(): boolean {
  const problems = validate(mode());
  if (problems.length) {
    showErrors = true;
    showProblems(problems, true);
    return false;
  }
  showErrors = false;
  showProblems([], false);
  const next = cleaned();
  if (isNew) {
    next.id = newCourseId(next.title);
    next.createdAt = new Date().toISOString();
  }
  const wasPublished = savedStatus === "published" && !isNew;
  const result = saveCourse(next);
  const message =
    next.status === "published"
      ? wasPublished
        ? "Changes saved. They show in the catalog now."
        : "Published. It’s in your catalog now."
      : wasPublished
        ? "Saved as a draft. It’s no longer in the catalog."
        : "Draft saved. Only you can see it.";
  if (!reportSave(result, message)) {
    if (result.ok === false && result.reason === "quota") return false;
  }
  course = { ...course, id: next.id, createdAt: next.createdAt, status: next.status };
  savedStatus = next.status;
  savedAt = new Date().toISOString();
  if (isNew) {
    isNew = false;
    history.replaceState(null, "", `/admin/courses/edit?id=${encodeURIComponent(next.id)}`);
    const del = $("[data-delete]");
    if (del) del.hidden = false;
  }
  dirty = false;
  updateState();
  return true;
}

function bindActions(): void {
  el.form()?.addEventListener("submit", (event) => {
    event.preventDefault();
    save();
  });

  for (const a of $$<HTMLAnchorElement>("[data-preview]")) {
    a.addEventListener("click", (event) => {
      if (!dirty && !isNew) return;
      event.preventDefault();
      if (save()) location.href = previewUrl();
    });
  }

  $("[data-add-outcome]")?.addEventListener("click", addOutcome);
  $("[data-add-module]")?.addEventListener("click", () => {
    if (course.modules.length >= LIMITS.modules) return;
    const mod: Module = { id: uid("m"), title: "", lessons: [{ id: uid("l"), title: "", minutes: 10, youtube: "" }] };
    course.modules.push(mod);
    renderModules();
    markDirty();
    $<HTMLInputElement>(`#m-${mod.id}-title`)?.focus();
  });

  $("[data-delete]")?.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Delete this course?",
      body: `${course.title.trim() || "This course"} will be removed from the demo, and from the catalog if it was published.`,
      confirm: "Delete course",
      danger: true,
    });
    if (!ok) return;
    if (reportSave(deleteCourse(course.id))) {
      dirty = false;
      location.href = "/admin/courses";
    }
  });

  window.addEventListener("beforeunload", (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

// ── Start ────────────────────────────────────────────────────────────

ready(() => {
  const id = new URLSearchParams(location.search).get("id");
  const found = id ? getCourse(id) : null;
  if (id && !found) {
    $("[data-editor]")?.setAttribute("hidden", "");
    $("[data-missing]")?.removeAttribute("hidden");
    return;
  }
  course = found ?? blankCourse();
  isNew = !found;
  savedStatus = found?.status ?? "draft";
  savedAt = found?.updatedAt ?? null;
  if (found) document.title = document.title.replace(/^Edit course/, `Edit: ${found.title}`);
  if (!found) document.title = document.title.replace(/^Edit course/, "New course");

  const publish = el.publish();
  if (publish) publish.checked = course.status === "published";
  if (course.main) $("[data-main-note]")?.removeAttribute("hidden");
  const del = $("[data-delete]");
  if (del) del.hidden = isNew || course.main;

  bindBasics();
  bindCover();
  syncCover();
  renderOutcomes();
  renderModules();
  bindActions();
  updateState();
  if (isNew) el.title()?.focus({ preventScroll: true });
});
