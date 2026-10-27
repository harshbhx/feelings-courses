/**
 * The lesson outline: modules and lessons, reordering with buttons (keyboard and touch friendly, no
 * drag and drop to get wrong on a phone), a lesson drawer, and video and captions uploads (W4).
 *
 * Edits stay in a draft until "Save lessons" sends the whole outline (PUT …/outline). Uploads are
 * different: they attach to the saved lesson on the server when they finish, so the editor writes
 * the new video into both the saved outline and the draft.
 */
import type { AdminCourse, MediaItem, VideoProvider } from "../../../shared/types";
import { admin, asApiError } from "../client/api";
import { $, fill, h, icon } from "../client/dom";
import { field, input, select, setErrors, switchRow, textarea } from "../client/fields";
import { notifyChanged } from "../client/events";
import { announce, confirmDialog, formDialog, nextId, toast } from "../client/ui";
import { duration, plural } from "../client/format";
import { emptyBox } from "../client/states";
import { describeError } from "../lib/errors";
import {
  addLesson,
  addModule,
  draftFromModules,
  findLesson,
  isDirty,
  moveLesson,
  moveLessonTo,
  moveModule,
  outlineRequest,
  parseOutlinePath,
  removeLesson,
  removeModule,
  removedLessons,
  slugsIn,
  totals,
  updateLesson,
  updateModule,
  validateDraft,
  type Draft,
  type DraftLesson,
} from "../lib/outline";
import { lessonSlugFrom, lessonSlugProblem, youtubeId } from "../lib/slug";
import { UPLOAD_RULES, keyName } from "../lib/upload";
import { paintSlot, uploadControl, jobFor } from "./uploads";

interface Ctx {
  course: () => AdminCourse;
  onSaved: (course: AdminCourse) => void;
  onDirty: () => void;
}

let saved: Draft = [];
let draft: Draft = [];
let ctx: Ctx;
let errors: Record<string, string> = {};

export const outlineDirty = () => isDirty(saved, draft);

export function initOutline(course: AdminCourse, context: Ctx): void {
  ctx = context;
  saved = draftFromModules(course.modules);
  draft = saved;
  $("[data-add-module]")?.addEventListener("click", () => {
    draft = addModule(draft, `Module ${draft.length + 1}`);
    changed();
    const inputs = document.querySelectorAll<HTMLInputElement>(".mod-head .input");
    const last = inputs[inputs.length - 1];
    last?.focus();
    last?.select();
  });
  $("[data-outline-save]")?.addEventListener("click", (e) => void save(e.currentTarget as HTMLButtonElement));
  $("[data-outline-undo]")?.addEventListener("click", async () => {
    const ok = await confirmDialog({ title: "Undo lesson changes?", body: "The lessons go back to how they were last saved.", confirm: "Undo changes" });
    if (!ok) return;
    draft = saved;
    errors = {};
    changed();
  });
  render();
}

/** After a course reload elsewhere (publish): keep unsaved edits, refresh the saved copy. */
export function refreshSaved(course: AdminCourse): void {
  const wasDirty = outlineDirty();
  saved = draftFromModules(course.modules);
  if (!wasDirty) draft = saved;
  render();
}

function changed(): void {
  if (Object.keys(errors).length) errors = validateDraft(draft);
  render();
  ctx.onDirty();
}

function videoLabel(l: DraftLesson): { text: string; icon: string } {
  if (l.videoProvider === "r2" && l.videoRef) return { text: `Video: ${keyName(l.videoRef)}`, icon: "video-camera" };
  if (l.videoProvider === "youtube" && l.videoRef) return { text: "YouTube video", icon: "youtube" };
  if (l.videoProvider === "stream") return { text: "Old video link (re-upload it)", icon: "warning-circle" };
  return { text: "No video yet", icon: "circle" };
}

function lessonErrors(mi: number, li: number): string[] {
  const prefix = `modules[${mi}].lessons[${li}].`;
  return Object.entries(errors)
    .filter(([k]) => k.startsWith(prefix))
    .map(([, v]) => v);
}

function render(): void {
  const root = $("[data-modules]");
  if (!root) return;
  const t = totals(draft);
  const sum = $("[data-outline-sum]");
  if (sum)
    sum.textContent = t.lessons
      ? `${plural(t.modules, "module")} · ${plural(t.lessons, "lesson")} · ${duration(t.minutes)} · ${t.withVideo} with video${t.previews ? ` · ${t.previews} free preview${t.previews === 1 ? "" : "s"}` : ""}`
      : "Group lessons into modules. Each lesson can have a video.";
  const dirty = outlineDirty();
  const saveBtn = $<HTMLButtonElement>("[data-outline-save]");
  if (saveBtn && !saveBtn.hasAttribute("aria-busy")) saveBtn.disabled = !dirty;
  const undo = $("[data-outline-undo]");
  if (undo) undo.hidden = !dirty;
  const errBox = $("[data-outline-err]");
  if (errBox) {
    const list = Object.entries(errors);
    if (!list.length) errBox.replaceChildren();
  }

  if (!draft.length) {
    fill(root, emptyBox({ icon: "play-circle", title: "No lessons yet", text: "Add a module (for example “Basics”), then its lessons." }));
    return;
  }

  fill(
    root,
    draft.map((m, mi) => {
      const titleId = nextId("mod");
      const titleInput = input({
        id: titleId,
        value: m.title,
        maxlength: 120,
        "aria-label": `Module ${mi + 1} title`,
        "aria-invalid": errors[`modules[${mi}].title`] ? "true" : null,
        dataset: { field: `modules[${mi}].title` },
      });
      titleInput.addEventListener("input", () => {
        draft = updateModule(draft, mi, { title: titleInput.value });
        ctx.onDirty();
        const save = $<HTMLButtonElement>("[data-outline-save]");
        if (save) save.disabled = !outlineDirty();
        const undo = $("[data-outline-undo]");
        if (undo) undo.hidden = !outlineDirty();
      });
      return h(
        "section",
        { class: "mod", "aria-label": `Module ${mi + 1}: ${m.title || "untitled"}` },
        h(
          "div",
          { class: "mod-head" },
          h("span", { class: "mod-num", "aria-hidden": "true", text: String(mi + 1) }),
          h("div", { class: "mod-title" }, titleInput),
          h(
            "div",
            { class: "tools" },
            h("button", { type: "button", class: "icon-btn", "aria-label": `Move module ${mi + 1} up`, disabled: mi === 0, onClick: () => { draft = moveModule(draft, mi, -1); changed(); announce(`Module moved to position ${mi}.`); } }, icon("arrow-up")),
            h("button", { type: "button", class: "icon-btn", "aria-label": `Move module ${mi + 1} down`, disabled: mi === draft.length - 1, onClick: () => { draft = moveModule(draft, mi, 1); changed(); announce(`Module moved to position ${mi + 2}.`); } }, icon("arrow-down")),
            h("button", { type: "button", class: "icon-btn", "aria-label": `Remove module ${mi + 1}`, onClick: () => void removeModuleAsk(mi) }, icon("trash")),
          ),
        ),
        m.lessons.length
          ? h(
              "ol",
              { class: "les-list" },
              m.lessons.map((l, li) => lessonRow(l, mi, li)),
            )
          : h("p", { class: "mod-empty", text: "No lessons in this module yet." }),
        h(
          "div",
          { class: "mod-foot" },
          h(
            "button",
            {
              type: "button",
              class: "btn btn-ghost btn-sm",
              onClick: () => {
                draft = addLesson(draft, mi, `Lesson ${draft[mi]!.lessons.length + 1}`);
                changed();
                const added = draft[mi]!.lessons[draft[mi]!.lessons.length - 1]!;
                lessonDrawer(added.key, true);
              },
            },
            icon("plus"),
            "Add lesson",
          ),
        ),
      );
    }),
  );
  for (const slot of root.querySelectorAll<HTMLElement>("[data-upload-slot]")) paintSlot(slot);
}

function lessonRow(l: DraftLesson, mi: number, li: number): HTMLElement {
  const v = videoLabel(l);
  const errs = lessonErrors(mi, li);
  const first = mi === 0 && li === 0;
  const last = mi === draft.length - 1 && li === draft[mi]!.lessons.length - 1;
  return h(
    "li",
    { class: `les${errs.length ? " is-invalid" : ""}` },
    h(
      "button",
      { type: "button", class: "les-main", onClick: () => lessonDrawer(l.key) },
      h("span", { class: "les-title", text: `${li + 1}. ${l.title || "Untitled lesson"}` }),
      h(
        "span",
        { class: "les-meta" },
        h("span", null, icon(v.icon), " ", v.text),
        l.minutes ? h("span", null, icon("clock"), " ", duration(l.minutes)) : null,
        l.freePreview ? h("span", { class: "pill pill-plain", text: "Free preview" }) : null,
        l.id === undefined ? h("span", { class: "pill pill-plain", text: "Not saved" }) : null,
      ),
      errs.length ? h("span", { class: "les-err", text: errs[0]! }) : null,
      h("span", { class: "visually-hidden", text: ". Edit lesson" }),
    ),
    h(
      "div",
      { class: "tools" },
      h("button", { type: "button", class: "icon-btn", "aria-label": `Move “${l.title}” up`, disabled: first, onClick: () => { draft = moveLesson(draft, mi, li, -1); changed(); focusLesson(l.key, "up"); } }, icon("arrow-up")),
      h("button", { type: "button", class: "icon-btn", "aria-label": `Move “${l.title}” down`, disabled: last, onClick: () => { draft = moveLesson(draft, mi, li, 1); changed(); focusLesson(l.key, "down"); } }, icon("arrow-down")),
    ),
    l.id !== undefined ? h("div", { dataset: { uploadSlot: `video-${l.id}` }, hidden: true }) : null,
  );
}

/** Keeps focus on the moved lesson's button, so repeated presses keep moving it. */
function focusLesson(key: string, dir: "up" | "down"): void {
  const at = findLesson(draft, key);
  if (!at) return;
  const mods = document.querySelectorAll(".mod");
  const row = mods[at[0]]?.querySelectorAll(".les")[at[1]];
  row?.querySelector<HTMLButtonElement>(`.tools .icon-btn:nth-child(${dir === "up" ? 1 : 2})`)?.focus();
  announce(`Moved to module ${at[0] + 1}, lesson ${at[1] + 1}.`);
}

async function removeModuleAsk(mi: number): Promise<void> {
  const m = draft[mi];
  if (!m) return;
  if (m.lessons.length) {
    const ok = await confirmDialog({
      title: `Remove “${m.title || `Module ${mi + 1}`}”?`,
      body: `Its ${plural(m.lessons.length, "lesson")} go too when you save. Move any lesson you want to keep to another module first.`,
      confirm: "Remove module",
      danger: true,
    });
    if (!ok) return;
  }
  draft = removeModule(draft, mi);
  changed();
}

function lessonDrawer(key: string, isNew = false): void {
  const at = findLesson(draft, key);
  if (!at) return;
  const [mi, li] = at;
  const l = draft[mi]!.lessons[li]!;
  const course = ctx.course();

  const title = input({ value: l.title, maxlength: 160, dataset: { field: "title" } });
  const slug = input({ value: l.slug, maxlength: 80, inputmode: "url", autocapitalize: "off", spellcheck: "false", dataset: { field: "slug" } });
  let slugTouched = !isNew;
  title.addEventListener("input", () => {
    if (!slugTouched) slug.value = lessonSlugFrom(title.value, slugsIn(draft, key));
  });
  slug.addEventListener("input", () => (slugTouched = true));
  const minutes = input({ value: String(l.minutes), inputmode: "numeric", dataset: { field: "minutes" } });
  const preview = switchRow({ label: "Free preview", hint: "Anyone can watch this one on the course page, without buying.", checked: l.freePreview });
  const vertical = switchRow({ label: "Vertical video (9:16)", hint: "Recorded on a phone, upright.", checked: l.vertical });

  const providerName = nextId("vp");
  const provider: VideoProvider = l.videoProvider === "stream" ? "none" : l.videoProvider;
  const radio = (value: VideoProvider, label: string, hint: string) =>
    h("label", { class: "choice" }, h("input", { type: "radio", name: providerName, value, checked: provider === value }), h("strong", { text: label }), h("span", { text: hint }));
  const yt = input({ value: l.videoProvider === "youtube" ? (l.videoRef ?? "") : "", inputmode: "url", placeholder: "https://youtu.be/…", dataset: { field: "videoRef" } });
  const ytField = field({ label: "YouTube link", control: yt, hint: "Unlisted YouTube videos work. Students can share a YouTube link, so use uploads for paid lessons." });

  const uploadNote = h("p", { class: "field-hint" });
  const current = h("p", { class: "field-hint" });
  const showCurrent = () => {
    const now = findLesson(draft, key);
    const cur = now ? draft[now[0]]!.lessons[now[1]]! : l;
    current.textContent = cur.videoProvider === "r2" && cur.videoRef ? `Current video: ${keyName(cur.videoRef)}` : "No video uploaded yet.";
  };
  showCurrent();
  const videoUpload =
    l.id !== undefined
      ? uploadControl({
          id: `video-${l.id}`,
          kind: "video",
          label: "Upload video",
          accept: UPLOAD_RULES.video.accept,
          lessonId: l.id,
          onDone: (item) => {
            attachVideo(l.id!, item);
            showCurrent();
          },
          onError: (msg) => (uploadNote.textContent = msg),
        })
      : h("p", { class: "field-hint", text: "Save lessons first, then upload this lesson's video." });
  const uploadBox = h("div", { class: "stack-sm" }, current, videoUpload, uploadNote, h("p", { class: "field-hint", text: `${UPLOAD_RULES.video.hint} If it stops, choose the same file again: it carries on where it stopped.` }));

  const captionsNote = h("p", { class: "field-hint" });
  const captionsKey = { value: l.captionsKey };
  const captionsLine = h("p", { class: "field-hint", text: l.captionsKey ? `Captions: ${keyName(l.captionsKey)}` : "No captions." });
  const captions =
    l.id !== undefined
      ? uploadControl({
          id: `captions-${l.id}`,
          kind: "captions",
          label: "Upload captions",
          accept: UPLOAD_RULES.captions.accept,
          lessonId: l.id,
          onDone: (item) => {
            captionsKey.value = item.key;
            attachCaptions(l.id!, item);
            captionsLine.textContent = `Captions: ${keyName(item.key)}`;
            removeCaptions.hidden = false;
          },
          onError: (msg) => (captionsNote.textContent = msg),
        })
      : null;

  // Removing captions takes effect with "Done" and "Save lessons" (the file stays in the media library).
  const removeCaptions = h("button", { type: "button", class: "link-btn", hidden: !l.captionsKey }, icon("trash"), "Remove captions");
  removeCaptions.addEventListener("click", () => {
    captionsKey.value = null;
    captionsLine.textContent = "No captions (removed when you save).";
    removeCaptions.hidden = true;
  });

  const videoGroup = h(
    "fieldset",
    { class: "field" },
    h("legend", { class: "field-label", text: "Video" }),
    h("div", { class: "choice-grid" }, radio("r2", "Upload a video", "Private: only students who paid can watch."), radio("youtube", "YouTube link", "For free or public lessons."), radio("none", "No video", "Text and notes only, or add it later.")),
  );
  const ytWrap = h("div", null, ytField);
  const upWrap = h("div", null, uploadBox);
  const syncProvider = () => {
    const value = (videoGroup.querySelector<HTMLInputElement>("input:checked")?.value ?? "none") as VideoProvider;
    ytWrap.hidden = value !== "youtube";
    upWrap.hidden = value !== "r2";
  };
  videoGroup.addEventListener("change", syncProvider);
  syncProvider();

  const notes = textarea({ rows: 4, maxlength: 20000, dataset: { field: "notes" } });
  notes.value = l.notes ?? "";
  const moveTo = draft.length > 1 ? select(draft.map((m, i) => ({ value: String(i), label: `${i + 1}. ${m.title || "Untitled module"}` })), String(mi)) : null;

  const removeBtn = h(
    "button",
    { type: "button", class: "btn btn-danger btn-sm" },
    icon("trash"),
    "Remove lesson",
  );

  const dialog = formDialog({
    title: isNew ? "New lesson" : "Edit lesson",
    drawer: true,
    submit: "Done",
    body: [
      field({ label: "Lesson title", control: title }),
      field({ label: "Web address", control: slug, hint: `…/learn/${course.slug}/<this>` }),
      field({ label: "Minutes", control: minutes, hint: "Shown in the lesson list. 0 to 600." }),
      videoGroup,
      ytWrap,
      upWrap,
      h("div", { class: "field" }, h("span", { class: "field-label", text: "Captions" }, h("span", { class: "opt", text: " (optional)" })), captionsLine, captions, removeCaptions, captionsNote),
      preview.row,
      vertical.row,
      field({ label: "Notes under the video", control: notes, optional: true, hint: "Plain text: products used, steps, links." }),
      moveTo ? field({ label: "Module", control: moveTo }) : null,
      h("div", null, removeBtn),
    ].filter(Boolean) as Node[],
    onSubmit: (d) => {
      const fieldErrors: Record<string, string> = {};
      if (!title.value.trim()) fieldErrors.title = "Give the lesson a title.";
      const s = slug.value.trim().toLowerCase();
      const problem = lessonSlugProblem(s);
      if (problem) fieldErrors.slug = problem;
      else if (slugsIn(draft, key).has(s)) fieldErrors.slug = `Another lesson uses “${s}”.`;
      const mins = minutes.value.trim() === "" ? 0 : Number(minutes.value.trim());
      if (!Number.isInteger(mins) || mins < 0 || mins > 600) fieldErrors.minutes = "Minutes must be a whole number from 0 to 600.";
      const chosen = (videoGroup.querySelector<HTMLInputElement>("input:checked")?.value ?? "none") as VideoProvider;
      let videoRef: string | null = null;
      const latest = (() => {
        const p = findLesson(draft, key);
        return p ? draft[p[0]]!.lessons[p[1]]! : l;
      })();
      if (chosen === "youtube") {
        videoRef = youtubeId(yt.value);
        if (!videoRef) fieldErrors.videoRef = "Paste a YouTube link or its 11-character id.";
      } else if (chosen === "r2") {
        videoRef = latest.videoProvider === "r2" ? latest.videoRef : null;
        if (!videoRef && !jobFor(`video-${l.id}`)) fieldErrors.videoRef = "Upload the video first, or choose “No video”.";
      }
      if (Object.keys(fieldErrors).length) {
        setErrors(d.form, fieldErrors);
        if (fieldErrors.videoRef && !fieldErrors.title && !fieldErrors.slug && !fieldErrors.minutes) d.setMessage(fieldErrors.videoRef);
        return false;
      }
      draft = updateLesson(draft, key, {
        title: title.value.trim(),
        slug: s,
        minutes: mins,
        // An upload still running: keep the provider as it is; the upload sets it when it finishes.
        videoProvider: chosen === "r2" && !videoRef ? latest.videoProvider : chosen,
        videoRef: chosen === "r2" && !videoRef ? latest.videoRef : videoRef,
        captionsKey: captionsKey.value,
        freePreview: preview.input.checked,
        vertical: vertical.input.checked,
        notes: notes.value.trim() ? notes.value : null,
      });
      if (moveTo && Number(moveTo.value) !== mi) {
        const pos = findLesson(draft, key)!;
        draft = moveLessonTo(draft, pos[0], pos[1], Number(moveTo.value));
      }
      changed();
      return true;
    },
  });
  removeBtn.addEventListener("click", async () => {
    dialog.close();
    const pos = findLesson(draft, key);
    if (!pos) return;
    if (l.id !== undefined && course.enrollmentCount > 0) {
      const ok = await confirmDialog({
        title: `Remove “${l.title}”?`,
        body: "When you save, students lose their progress on this lesson. This can't be undone after saving.",
        confirm: "Remove lesson",
        danger: true,
      });
      if (!ok) return;
    }
    draft = removeLesson(draft, pos[0], pos[1]);
    changed();
    toast("Lesson removed. Save lessons to keep the change.", "info");
  });
}

function patchLessonEverywhere(id: number, patch: Partial<DraftLesson>): string | null {
  let name: string | null = null;
  const apply = (d: Draft): Draft =>
    d.map((m) => ({
      ...m,
      lessons: m.lessons.map((l) => {
        if (l.id !== id) return l;
        name = l.title;
        return { ...l, ...patch };
      }),
    }));
  saved = apply(saved);
  draft = apply(draft);
  render();
  ctx.onDirty();
  return name;
}

function attachVideo(lessonId: number, item: MediaItem): void {
  const name = patchLessonEverywhere(lessonId, { videoProvider: "r2", videoRef: item.key });
  toast(`Video uploaded${name ? ` and added to “${name}”` : ""}.`);
  if (ctx.course().status === "published") notifyChanged();
}

function attachCaptions(lessonId: number, item: MediaItem): void {
  patchLessonEverywhere(lessonId, { captionsKey: item.key });
  toast("Captions uploaded.");
}

function describePath(path: string): string {
  const p = parseOutlinePath(path);
  if (!p) return "";
  const m = draft[p.module];
  if (p.lesson === null) return `Module ${p.module + 1}${m?.title ? ` (“${m.title}”)` : ""}: `;
  const l = m?.lessons[p.lesson];
  return `Module ${p.module + 1}, lesson ${p.lesson + 1}${l?.title ? ` (“${l.title}”)` : ""}: `;
}

function showErrors(list: Record<string, string>): void {
  errors = list;
  render();
  const box = $("[data-outline-err]");
  if (!box) return;
  const entries = Object.entries(list);
  box.replaceChildren(icon("warning-circle"), entries.length === 1 ? `${describePath(entries[0]![0])}${entries[0]![1]}` : `${entries.length} things to fix in the lessons (marked in red). ${describePath(entries[0]![0])}${entries[0]![1]}`);
  box.focus();
}

async function save(button: HTMLButtonElement): Promise<void> {
  const local = validateDraft(draft);
  if (Object.keys(local).length) {
    showErrors(local);
    return;
  }
  const gone = removedLessons(saved, draft);
  const course = ctx.course();
  if (gone.length && course.enrollmentCount > 0) {
    const ok = await confirmDialog({
      title: `Delete ${plural(gone.length, "lesson")}?`,
      body: `${gone.map((l) => `“${l.title}”`).join(", ")} will be deleted, with every student's progress on ${gone.length === 1 ? "it" : "them"}. This can't be undone.`,
      confirm: "Save and delete",
      danger: true,
    });
    if (!ok) return;
  }
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.classList.add("is-busy");
  try {
    const updated = await admin("PUT /api/admin/courses/:id/outline", { id: course.id }, outlineRequest(draft));
    saved = draftFromModules(updated.modules);
    draft = saved;
    errors = {};
    toast(course.status === "published" ? "Lessons saved. Publish changes to update the site." : "Lessons saved.");
    if (course.status === "published") notifyChanged();
    ctx.onSaved(updated);
  } catch (err) {
    const e = asApiError(err);
    if (Object.keys(e.fields).length) showErrors(e.fields);
    else toast(describeError(e).message, "error");
  } finally {
    button.removeAttribute("aria-busy");
    button.classList.remove("is-busy");
    render();
    ctx.onDirty();
  }
}
