/**
 * The course outline editor's model: modules and lessons as an editable draft, reordering, and the
 * body for PUT /api/admin/courses/:id/outline (the whole outline in one request; rows left out are
 * deleted, so the editor warns before lessons with an id disappear).
 *
 * Every function returns a new draft; nothing is changed in place, so undo and "is it saved?" are
 * simple comparisons.
 */
import type { AdminOutlineRequest } from "../../../shared/api.ts";
import type { AdminLesson, AdminModule, VideoProvider } from "../../../shared/types.ts";
import { lessonSlugFrom, lessonSlugProblem, youtubeId } from "./slug.ts";

export const MAX_MODULES = 50;
export const MAX_LESSONS = 300;

export interface DraftLesson {
  /** Stable key for the UI (the id once saved, else a temporary one). */
  key: string;
  id?: number;
  slug: string;
  title: string;
  minutes: number;
  videoProvider: VideoProvider;
  videoRef: string | null;
  vertical: boolean;
  captionsKey: string | null;
  durationSeconds: number | null;
  notes: string | null;
  freePreview: boolean;
}

export interface DraftModule {
  key: string;
  id?: number;
  title: string;
  lessons: DraftLesson[];
}

export type Draft = DraftModule[];

let counter = 0;
/** A temporary key for a new module or lesson. */
export function newKey(prefix: "m" | "l"): string {
  counter += 1;
  return `${prefix}new${counter}`;
}

export function lessonFromAdmin(l: AdminLesson): DraftLesson {
  return {
    key: `l${l.id}`,
    id: l.id,
    slug: l.slug,
    title: l.title,
    minutes: l.minutes,
    videoProvider: l.videoProvider,
    videoRef: l.videoRef,
    vertical: l.vertical,
    captionsKey: l.captionsKey,
    durationSeconds: l.durationSeconds,
    notes: l.notes,
    freePreview: l.freePreview,
  };
}

/** The draft for a course's saved outline. */
export function draftFromModules(modules: AdminModule[]): Draft {
  return [...modules]
    .sort((a, b) => a.position - b.position)
    .map((m) => ({
      key: `m${m.id}`,
      id: m.id,
      title: m.title,
      lessons: [...m.lessons].sort((a, b) => a.position - b.position).map(lessonFromAdmin),
    }));
}

/** The request body for the outline endpoint. */
export function outlineRequest(draft: Draft): AdminOutlineRequest {
  return {
    modules: draft.map((m) => ({
      ...(m.id !== undefined ? { id: m.id } : {}),
      title: m.title.trim(),
      lessons: m.lessons.map((l) => ({
        ...(l.id !== undefined ? { id: l.id } : {}),
        slug: l.slug.trim().toLowerCase(),
        title: l.title.trim(),
        minutes: l.minutes,
        // "stream" is not available: such a lesson keeps its fields, but the API refuses it, so it
        // is saved without a video rather than blocking the whole outline.
        videoProvider: l.videoProvider === "stream" ? "none" : l.videoProvider,
        videoRef: l.videoProvider === "none" || l.videoProvider === "stream" ? null : l.videoRef,
        vertical: l.vertical,
        captionsKey: l.captionsKey,
        durationSeconds: l.durationSeconds,
        notes: l.notes && l.notes.trim() ? l.notes : null,
        freePreview: l.freePreview,
      })),
    })),
  };
}

/** True when the draft differs from what is saved. */
export function isDirty(saved: Draft, draft: Draft): boolean {
  return JSON.stringify(outlineRequest(saved)) !== JSON.stringify(outlineRequest(draft));
}

/** Moves item `from` to `to` in a list (both clamped). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const target = Math.max(0, Math.min(out.length - 1, to));
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item!);
  return out;
}

export function moveModule(draft: Draft, index: number, delta: number): Draft {
  return moveItem(draft, index, index + delta);
}

/**
 * Moves a lesson up or down. At the top or bottom of its module it crosses into the module before
 * or after (as the last or first lesson), so a lesson can travel the whole outline with two buttons.
 */
export function moveLesson(draft: Draft, mi: number, li: number, delta: -1 | 1): Draft {
  const mod = draft[mi];
  if (!mod || !mod.lessons[li]) return draft;
  const target = li + delta;
  if (target >= 0 && target < mod.lessons.length) {
    return draft.map((m, i) => (i === mi ? { ...m, lessons: moveItem(m.lessons, li, target) } : m));
  }
  const otherIndex = mi + delta;
  if (otherIndex < 0 || otherIndex >= draft.length) return draft;
  const lesson = mod.lessons[li]!;
  return draft.map((m, i) => {
    if (i === mi) return { ...m, lessons: m.lessons.filter((_, j) => j !== li) };
    if (i === otherIndex) return { ...m, lessons: delta < 0 ? [...m.lessons, lesson] : [lesson, ...m.lessons] };
    return m;
  });
}

/** Moves a lesson to the end of another module. */
export function moveLessonTo(draft: Draft, mi: number, li: number, targetModule: number): Draft {
  const lesson = draft[mi]?.lessons[li];
  if (!lesson || targetModule === mi || !draft[targetModule]) return draft;
  return draft.map((m, i) => {
    if (i === mi) return { ...m, lessons: m.lessons.filter((_, j) => j !== li) };
    if (i === targetModule) return { ...m, lessons: [...m.lessons, lesson] };
    return m;
  });
}

/** Every lesson slug in the draft. */
export function slugsIn(draft: Draft, exceptKey?: string): Set<string> {
  const out = new Set<string>();
  for (const m of draft) for (const l of m.lessons) if (l.key !== exceptKey) out.add(l.slug);
  return out;
}

export function addModule(draft: Draft, title: string): Draft {
  return [...draft, { key: newKey("m"), title, lessons: [] }];
}

/** A new lesson at the end of module `mi`, with a unique slug made from its title. */
export function addLesson(draft: Draft, mi: number, title: string): Draft {
  if (!draft[mi]) return draft;
  const lesson: DraftLesson = {
    key: newKey("l"),
    slug: lessonSlugFrom(title, slugsIn(draft)),
    title,
    minutes: 0,
    videoProvider: "none",
    videoRef: null,
    vertical: false,
    captionsKey: null,
    durationSeconds: null,
    notes: null,
    freePreview: false,
  };
  return draft.map((m, i) => (i === mi ? { ...m, lessons: [...m.lessons, lesson] } : m));
}

export function removeModule(draft: Draft, mi: number): Draft {
  return draft.filter((_, i) => i !== mi);
}

export function removeLesson(draft: Draft, mi: number, li: number): Draft {
  return draft.map((m, i) => (i === mi ? { ...m, lessons: m.lessons.filter((_, j) => j !== li) } : m));
}

export function updateModule(draft: Draft, mi: number, patch: Partial<Pick<DraftModule, "title">>): Draft {
  return draft.map((m, i) => (i === mi ? { ...m, ...patch } : m));
}

export function updateLesson(draft: Draft, key: string, patch: Partial<Omit<DraftLesson, "key" | "id">>): Draft {
  return draft.map((m) => ({ ...m, lessons: m.lessons.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
}

/** Where a lesson is: [module index, lesson index], or null. */
export function findLesson(draft: Draft, key: string): [number, number] | null {
  for (let i = 0; i < draft.length; i++) {
    const j = draft[i]!.lessons.findIndex((l) => l.key === key);
    if (j >= 0) return [i, j];
  }
  return null;
}

/** Saved lessons that the draft no longer has: saving deletes them (and students' progress on them). */
export function removedLessons(saved: Draft, draft: Draft): DraftLesson[] {
  const kept = new Set<number>();
  for (const m of draft) for (const l of m.lessons) if (l.id !== undefined) kept.add(l.id);
  const out: DraftLesson[] = [];
  for (const m of saved) for (const l of m.lessons) if (l.id !== undefined && !kept.has(l.id)) out.push(l);
  return out;
}

export interface OutlineTotals {
  modules: number;
  lessons: number;
  minutes: number;
  withVideo: number;
  previews: number;
}

export function totals(draft: Draft): OutlineTotals {
  let lessons = 0;
  let minutes = 0;
  let withVideo = 0;
  let previews = 0;
  for (const m of draft)
    for (const l of m.lessons) {
      lessons += 1;
      minutes += l.minutes;
      if (l.videoProvider !== "none" && l.videoRef) withVideo += 1;
      if (l.freePreview) previews += 1;
    }
  return { modules: draft.length, lessons, minutes, withVideo, previews };
}

/**
 * Checks the draft the way the API will. Keys are the API's field paths
 * ("modules[0].lessons[2].slug"), so server errors land in the same places.
 */
export function validateDraft(draft: Draft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (draft.length > MAX_MODULES) errors.modules = `At most ${MAX_MODULES} modules.`;
  const count = draft.reduce((n, m) => n + m.lessons.length, 0);
  if (count > MAX_LESSONS) errors.modules = `At most ${MAX_LESSONS} lessons in a course.`;
  const seen = new Map<string, string>();
  draft.forEach((m, i) => {
    const at = `modules[${i}]`;
    const title = m.title.trim();
    if (!title) errors[`${at}.title`] = "Give the module a title.";
    else if (title.length > 120) errors[`${at}.title`] = "Keep the module title under 120 characters.";
    m.lessons.forEach((l, j) => {
      const lat = `${at}.lessons[${j}]`;
      const t = l.title.trim();
      if (!t) errors[`${lat}.title`] = "Give the lesson a title.";
      else if (t.length > 160) errors[`${lat}.title`] = "Keep the lesson title under 160 characters.";
      const slug = l.slug.trim().toLowerCase();
      const problem = lessonSlugProblem(slug);
      if (problem) errors[`${lat}.slug`] = problem;
      else if (seen.has(slug)) errors[`${lat}.slug`] = `Two lessons use "${slug}". Each needs its own.`;
      else seen.set(slug, lat);
      if (!Number.isInteger(l.minutes) || l.minutes < 0 || l.minutes > 600) errors[`${lat}.minutes`] = "Minutes must be 0 to 600.";
      if (l.videoProvider === "youtube" && !(l.videoRef && youtubeId(l.videoRef) === l.videoRef))
        errors[`${lat}.videoRef`] = "Paste a YouTube link or its 11-character id.";
      if (l.videoProvider === "r2" && !l.videoRef) errors[`${lat}.videoRef`] = "Upload the video, or choose “No video”.";
      if (l.notes && l.notes.length > 20_000) errors[`${lat}.notes`] = "Notes can be at most 20,000 characters.";
    });
  });
  return errors;
}

/** "modules[1].lessons[3].slug" → { module: 1, lesson: 3, field: "slug" }. */
export function parseOutlinePath(path: string): { module: number; lesson: number | null; field: string } | null {
  const m = /^modules\[(\d+)\](?:\.lessons\[(\d+)\])?(?:\.(\w+))?$/.exec(path);
  if (!m) return null;
  return { module: Number(m[1]), lesson: m[2] === undefined ? null : Number(m[2]), field: m[3] ?? "" };
}
