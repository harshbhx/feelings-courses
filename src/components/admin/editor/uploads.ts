/**
 * Uploads in the course editor, on W4's resumable uploader (src/lib/media-upload.ts):
 * - one job per destination (a lesson's video or captions, the cover, the sharing image);
 * - progress, time left, pause and resume, cancel;
 * - a job keeps running when its drawer closes: every element marked data-upload-slot="<job id>"
 *   shows it, so the lesson row keeps showing progress;
 * - after a dropped connection or a reload, picking the same file again sends only the missing parts.
 */
import type { MediaItem, MediaKind } from "../../../shared/types";
import { ApiError } from "../../../lib/api-client";
import { cancelUpload, uploadMedia } from "../../../lib/media-upload";
import { $$, fill, h, icon } from "../client/dom";
import { goToSignIn } from "../client/api";
import { describeError } from "../lib/errors";
import { contentTypeFor, fileProblem, formatBytes, progressText } from "../lib/upload";

export type JobState = "uploading" | "paused" | "done" | "failed";

export interface Job {
  id: string;
  file: File;
  kind: MediaKind;
  lessonId?: number;
  sent: number;
  total: number;
  state: JobState;
  error: string | null;
  startedAt: number;
  sessionStart: number;
  controller: AbortController;
  onDone: (item: MediaItem) => void | Promise<void>;
}

const jobs = new Map<string, Job>();

export const jobFor = (id: string) => jobs.get(id) ?? null;

/** True while any upload is sending (the editor warns before leaving). */
export const anyUploading = () => [...jobs.values()].some((j) => j.state === "uploading");

function paint(job: Job): void {
  for (const slot of $$(`[data-upload-slot="${CSS.escape(job.id)}"]`)) paintSlot(slot);
}

/** Fills one slot with its job's progress (or empties it). */
export function paintSlot(slot: HTMLElement): void {
  const job = jobs.get(slot.dataset.uploadSlot ?? "");
  if (!job || job.state === "done") {
    slot.replaceChildren();
    slot.hidden = true;
    return;
  }
  slot.hidden = false;
  const pct = job.total ? Math.floor((job.sent / job.total) * 100) : 0;
  const text =
    job.state === "failed"
      ? (job.error ?? "The upload stopped.")
      : job.state === "paused"
        ? `Paused at ${pct}% · ${formatBytes(job.sent)} of ${formatBytes(job.total)}`
        : progressText(job.sent, job.total, job.startedAt, Date.now(), job.sessionStart);
  const toggle =
    job.state === "uploading"
      ? h("button", { type: "button", class: "btn btn-ghost btn-sm", onClick: () => pause(job.id) }, "Pause")
      : h("button", { type: "button", class: "btn btn-secondary btn-sm", onClick: () => resume(job.id) }, job.state === "failed" ? "Try again" : "Resume");
  fill(
    slot,
    h(
      "div",
      { class: `upl upl-${job.state}` },
      h("div", { class: "upl-head" }, h("span", { class: "upl-name", text: job.file.name }), h("span", { class: "upl-text", text: `${pct}%` })),
      h("progress", { max: 100, value: pct, "aria-label": `Uploading ${job.file.name}` }),
      h("p", { class: `upl-text${job.state === "failed" ? " field-error" : ""}`, role: job.state === "failed" ? "alert" : null, text }),
      h(
        "div",
        { class: "btn-row" },
        toggle,
        h("button", { type: "button", class: "btn btn-ghost btn-sm", onClick: () => void cancel(job.id) }, icon("x-circle"), "Cancel"),
      ),
    ),
  );
}

async function run(job: Job): Promise<void> {
  job.state = "uploading";
  job.error = null;
  job.controller = new AbortController();
  job.startedAt = Date.now();
  job.sessionStart = -1;
  paint(job);
  try {
    const item = await uploadMedia(job.file, {
      kind: job.kind,
      lessonId: job.lessonId,
      signal: job.controller.signal,
      onProgress: (sent, total) => {
        // The first report is what the server already had (a resumed upload).
        if (job.sessionStart < 0) job.sessionStart = sent;
        job.sent = sent;
        job.total = total;
        paint(job);
      },
    });
    job.state = "done";
    job.sent = job.total;
    paint(job);
    jobs.delete(job.id);
    await job.onDone(item);
  } catch (err) {
    if (job.controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      if (jobs.get(job.id) === job) {
        job.state = "paused";
        paint(job);
      }
      return;
    }
    if (err instanceof ApiError && err.status === 401 && err.code === "unauthorized") {
      job.state = "paused";
      paint(job);
      goToSignIn();
      return;
    }
    job.state = "failed";
    job.error =
      err instanceof ApiError
        ? err.code === "upload_invalid" || err.code === "upload_too_large" || err.status === 400
          ? err.message
          : `${describeError(err).message} Pick the same file again later to continue where it stopped.`
        : "The upload stopped. Try again.";
    paint(job);
  }
}

/**
 * Starts (or resumes) uploading `file` to destination `id`. Returns an error message instead when
 * the file can't be used, or when that destination is already busy.
 */
export function startUpload(
  id: string,
  picked: File,
  kind: MediaKind,
  opts: { lessonId?: number; onDone: Job["onDone"] },
): string | null {
  const existing = jobs.get(id);
  if (existing && existing.state === "uploading") return "An upload is already running here. Pause or cancel it first.";
  const problem = fileProblem(picked, kind);
  if (problem) return problem;
  const type = contentTypeFor(picked, kind)!;
  // Declare the type the server expects (some browsers leave it empty); same bytes, same name and date,
  // so the resume fingerprint is unchanged.
  const file = picked.type === type ? picked : new File([picked], picked.name, { type, lastModified: picked.lastModified });
  const job: Job = {
    id,
    file,
    kind,
    lessonId: opts.lessonId,
    sent: 0,
    total: file.size,
    state: "uploading",
    error: null,
    startedAt: Date.now(),
    sessionStart: -1,
    controller: new AbortController(),
    onDone: opts.onDone,
  };
  jobs.set(id, job);
  void run(job);
  return null;
}

export function pause(id: string): void {
  const job = jobs.get(id);
  if (!job || job.state !== "uploading") return;
  job.controller.abort();
  job.state = "paused";
  paint(job);
}

export function resume(id: string): void {
  const job = jobs.get(id);
  if (!job || job.state === "uploading") return;
  void run(job);
}

/** Stops the upload and removes what reached the server. */
export async function cancel(id: string): Promise<void> {
  const job = jobs.get(id);
  if (!job) return;
  job.controller.abort();
  jobs.delete(id);
  paint(job);
  try {
    await cancelUpload(job.file, { kind: job.kind, lessonId: job.lessonId });
  } catch {
    /* the daily clean-up removes an abandoned upload anyway */
  }
}

/**
 * A "Choose file" button for destination `id`: a real file input dressed as a button, with the
 * slot that shows progress below it.
 */
export function uploadControl(opts: {
  id: string;
  kind: MediaKind;
  label: string;
  accept: string;
  lessonId?: number;
  disabled?: string | null;
  onDone: Job["onDone"];
  onError: (message: string) => void;
}): HTMLElement {
  const inputId = `file-${opts.id.replace(/[^a-z0-9]/gi, "-")}`;
  const inputEl = h("input", { type: "file", id: inputId, accept: opts.accept, "aria-label": opts.label, disabled: Boolean(opts.disabled) });
  inputEl.addEventListener("change", () => {
    const file = inputEl.files?.[0];
    inputEl.value = "";
    if (!file) return;
    const error = startUpload(opts.id, file, opts.kind, { lessonId: opts.lessonId, onDone: opts.onDone });
    if (error) opts.onError(error);
  });
  const slot = h("div", { dataset: { uploadSlot: opts.id }, hidden: true });
  paintSlot(slot);
  return h(
    "div",
    { class: "upload-control stack-sm" },
    opts.disabled
      ? h("p", { class: "field-hint", text: opts.disabled })
      : h("span", { class: "file-btn btn btn-secondary btn-sm" }, icon("upload-simple"), h("span", { "aria-hidden": "true", text: opts.label }), inputEl),
    slot,
  );
}
