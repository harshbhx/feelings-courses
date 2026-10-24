/**
 * Admin media uploads to R2 (W4): resumable multipart uploads, the media list, and deletion.
 *
 *   POST   /api/admin/uploads                 { kind, lessonId?, filename, size, contentType } → UploadInit
 *   PUT    /api/admin/uploads/:id/parts/:n    raw bytes (application/octet-stream)            → { etag }
 *   POST   /api/admin/uploads/:id/complete    { parts: [{ partNumber, etag }] }                → MediaItem
 *   DELETE /api/admin/uploads/:id[?force=1]   abort an unfinished upload or delete a file     → 204
 *   GET    /api/admin/media[?kind=&lessonId=&status=]                                         → MediaItem[]
 *
 * Resumable: the browser keeps { id, key, uploadId, etags } (src/lib/media-upload.ts) and after a
 * dropped connection, a reload or a closed laptop sends only the parts it has no etag for.
 * Re-sending a part replaces it. complete is idempotent: a retry after a lost answer gets the same
 * MediaItem. Each part bumps media.updated_at, so W7's daily job only aborts uploads untouched for
 * a day.
 *
 * Validation: kind, content type, extension and size up front (media-rules.ts); every part must
 * be exactly the planned size (R2 needs equal parts but the last); part 1's first bytes must match
 * the declared type; complete must list every part once; and the finished object's size must
 * equal the declared size.
 *
 * Every handler expects an authenticated admin: the route files refuse unless W5's admin
 * middleware (functions/api/admin/_middleware.ts) put `admin` in context.data (fail closed).
 */
import type { MediaItem, MediaKind, MediaStatus, UploadInit, UploadedPart } from "../../src/shared/types.ts";
import { UPLOAD_PART_SIZE } from "./config.ts";
import { randomHex } from "./crypto.ts";
import { auditStatement } from "./db/audit.ts";
import { unixNow, type Db } from "./db/d1.ts";
import { ConflictError, ValidationError } from "./db/errors.ts";
import { bumpContentVersionStatement } from "./db/settings.ts";
import { batch, changes } from "./db/tx.ts";
import type { Env } from "./env.ts";
import { expectedPartSize, MEDIA_KINDS, mediaKey, planUpload, sniffMismatch } from "./media-rules.ts";

/** Body cap for complete: up to 410 parts of a 4 GiB video, about 60 bytes each. */
export const COMPLETE_MAX_BYTES = 64 * 1024;

export class UploadError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "UploadError";
    this.status = status;
    this.code = code;
  }
}

interface MediaRow {
  id: number;
  key: string;
  kind: MediaKind;
  content_type: string;
  size_bytes: number;
  original_name: string | null;
  upload_id: string | null;
  status: MediaStatus;
  lesson_id: number | null;
  created_at: number;
  updated_at: number;
}

const MEDIA_COLUMNS = "id, key, kind, content_type, size_bytes, original_name, upload_id, status, lesson_id, created_at, updated_at";

/** The root-relative URL W1 and the admin use for an image (each key segment encoded). */
export function mediaImagePath(key: string): string {
  return `/media/i/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export function toMediaItem(row: MediaRow): MediaItem {
  return {
    id: row.id,
    key: row.key,
    kind: row.kind,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    originalName: row.original_name,
    status: row.status,
    lessonId: row.lesson_id,
    publicUrl: row.kind === "image" && row.status === "ready" ? mediaImagePath(row.key) : null,
    createdAt: row.created_at,
  };
}

async function loadMedia(db: Db, id: number): Promise<MediaRow | null> {
  return db.prepare(`SELECT ${MEDIA_COLUMNS} FROM media WHERE id = ?`).bind(id).first<MediaRow>();
}

function parseId(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : typeof value === "string" && /^[1-9]\d{0,11}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new ValidationError(field, `${field} must be a positive whole number.`, "upload_invalid");
  return n;
}

// ---------------------------------------------------------------- start

/** POST /api/admin/uploads. */
export async function startUpload(env: Env, body: Record<string, unknown>, now: number = unixNow()): Promise<UploadInit> {
  const plan = planUpload({ kind: body.kind, filename: body.filename, size: body.size, contentType: body.contentType }, UPLOAD_PART_SIZE);
  let lessonId: number | null = null;
  if (body.lessonId !== undefined && body.lessonId !== null) {
    lessonId = parseId(body.lessonId, "lessonId");
    if (plan.kind !== "video" && plan.kind !== "captions") {
      throw new ValidationError("lessonId", "Only videos and captions are attached to a lesson.", "upload_invalid");
    }
    const lesson = await env.DB.prepare("SELECT id FROM lessons WHERE id = ?").bind(lessonId).first();
    if (!lesson) throw new ValidationError("lessonId", "That lesson doesn't exist.", "upload_invalid");
  }

  const key = mediaKey(plan, now, randomHex(8));
  const upload = await env.MEDIA.createMultipartUpload(key, {
    httpMetadata: { contentType: plan.kind === "captions" ? "text/vtt; charset=utf-8" : plan.contentType },
    customMetadata: { originalName: plan.originalName.slice(0, 200), kind: plan.kind },
  });
  try {
    const [inserted] = await batch(env.DB, [
      env.DB.prepare(
        "INSERT INTO media (key, kind, content_type, size_bytes, original_name, upload_id, status, lesson_id, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?)",
      ).bind(key, plan.kind, plan.contentType, plan.size, plan.originalName, upload.uploadId, lessonId, now, now),
      auditStatement(env.DB, {
        actor: "admin",
        action: "media.upload_start",
        entity: "media",
        entityId: null,
        data: { key, kind: plan.kind, size: plan.size, contentType: plan.contentType, lessonId },
        now,
      }),
    ]);
    return { id: inserted!.meta.last_row_id, uploadId: upload.uploadId, key, partSize: plan.partSize };
  } catch (err) {
    await upload.abort().catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------- parts

/**
 * PUT /api/admin/uploads/:id/parts/:n. `body` is the part's bytes; `declaredLength` the
 * Content-Length header (checked before reading, so a wrong-sized part costs nothing).
 */
export async function uploadPart(
  env: Env,
  idParam: string,
  partParam: string,
  read: () => Promise<ArrayBuffer>,
  declaredLength: number | null,
  now: number = unixNow(),
): Promise<{ etag: string }> {
  const id = parseId(idParam, "id");
  const partNumber = /^[1-9]\d{0,4}$/.test(partParam) ? Number(partParam) : NaN;
  const row = await loadMedia(env.DB, id);
  if (!row) throw new UploadError(404, "not_found", "That upload doesn't exist.");
  if (row.status !== "uploading" || !row.upload_id) {
    throw new UploadError(409, "conflict", row.status === "ready" ? "This upload is already finished." : "This upload was cancelled. Start it again.");
  }
  if (declaredLength === null) throw new UploadError(411, "bad_request", "Send the part with a Content-Length header.");
  const expected = expectedPartSize(row.size_bytes, UPLOAD_PART_SIZE, partNumber);
  if (expected === null) throw new UploadError(400, "upload_invalid", "That part number is outside this file.");
  if (declaredLength !== expected) {
    throw new UploadError(400, "upload_invalid", `Part ${partNumber} must be exactly ${expected} bytes.`);
  }
  const bytes = new Uint8Array(await read());
  if (bytes.byteLength !== expected) throw new UploadError(400, "upload_invalid", `Part ${partNumber} must be exactly ${expected} bytes.`);
  if (partNumber === 1) {
    const mismatch = sniffMismatch(row.content_type, bytes);
    if (mismatch) throw new UploadError(415, "upload_invalid", mismatch);
  }
  const part = await env.MEDIA.resumeMultipartUpload(row.key, row.upload_id).uploadPart(partNumber, bytes);
  await env.DB.prepare("UPDATE media SET updated_at = ? WHERE id = ? AND status = 'uploading'").bind(now, id).run();
  return { etag: part.etag };
}

// ---------------------------------------------------------------- complete

function parseParts(value: unknown, partCount: number): UploadedPart[] {
  if (!Array.isArray(value) || value.length !== partCount) {
    throw new UploadError(400, "upload_invalid", `Send all ${partCount} part(s) to finish this upload.`);
  }
  const seen = new Set<number>();
  const parts: UploadedPart[] = [];
  for (const item of value) {
    const p = item as { partNumber?: unknown; etag?: unknown };
    if (
      !p ||
      typeof p !== "object" ||
      typeof p.partNumber !== "number" ||
      !Number.isInteger(p.partNumber) ||
      p.partNumber < 1 ||
      p.partNumber > partCount ||
      seen.has(p.partNumber) ||
      typeof p.etag !== "string" ||
      p.etag.length < 1 ||
      p.etag.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(p.etag)
    ) {
      throw new UploadError(400, "upload_invalid", "The list of uploaded parts is not valid.");
    }
    seen.add(p.partNumber);
    parts.push({ partNumber: p.partNumber, etag: p.etag });
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber);
}

/** POST /api/admin/uploads/:id/complete. */
export async function completeUpload(env: Env, idParam: string, body: Record<string, unknown>, now: number = unixNow()): Promise<MediaItem> {
  const id = parseId(idParam, "id");
  const row = await loadMedia(env.DB, id);
  if (!row) throw new UploadError(404, "not_found", "That upload doesn't exist.");
  if (row.status === "ready") return toMediaItem(row); // a retry after a lost answer
  if (row.status !== "uploading" || !row.upload_id) throw new UploadError(409, "conflict", "This upload was cancelled. Start it again.");
  const partCount = Math.ceil(row.size_bytes / UPLOAD_PART_SIZE);
  const parts = parseParts(body.parts, partCount);

  let object: R2Object;
  try {
    object = await env.MEDIA.resumeMultipartUpload(row.key, row.upload_id).complete(parts);
  } catch (err) {
    // A concurrent complete may have won: answer with its result.
    const again = await loadMedia(env.DB, id);
    if (again?.status === "ready") return toMediaItem(again);
    console.error(`upload complete ${id}: ${err instanceof Error ? err.message : "failed"}`);
    throw new UploadError(409, "upload_invalid", "Some parts are missing or changed. Resume the upload to send them again.");
  }
  if (object.size !== row.size_bytes) {
    await env.MEDIA.delete(row.key);
    await env.DB.prepare("UPDATE media SET status = 'aborted', upload_id = NULL, updated_at = ? WHERE id = ?").bind(now, id).run();
    throw new UploadError(400, "upload_invalid", "The uploaded file's size doesn't match. Start the upload again.");
  }

  const attach =
    row.lesson_id === null
      ? []
      : row.kind === "video"
        ? [
            env.DB.prepare("UPDATE lessons SET video_provider = 'r2', video_ref = ?, updated_at = ? WHERE id = ?").bind(row.key, now, row.lesson_id),
            env.DB.prepare("UPDATE media SET lesson_id = NULL, updated_at = ? WHERE lesson_id = ? AND kind = 'video' AND id <> ?").bind(now, row.lesson_id, id),
          ]
        : row.kind === "captions"
          ? [
              env.DB.prepare("UPDATE lessons SET captions_key = ?, updated_at = ? WHERE id = ?").bind(row.key, now, row.lesson_id),
              env.DB.prepare("UPDATE media SET lesson_id = NULL, updated_at = ? WHERE lesson_id = ? AND kind = 'captions' AND id <> ?").bind(now, row.lesson_id, id),
            ]
          : [];
  const [updated] = await batch(env.DB, [
    env.DB.prepare("UPDATE media SET status = 'ready', upload_id = NULL, updated_at = ? WHERE id = ? AND status = 'uploading'").bind(now, id),
    ...attach,
    auditStatement(env.DB, {
      actor: "admin",
      action: "media.upload_complete",
      entity: "media",
      entityId: id,
      data: { key: row.key, size: object.size, lessonId: row.lesson_id },
      now,
    }),
  ]);
  if (changes(updated) !== 1) {
    const again = await loadMedia(env.DB, id);
    if (again?.status === "ready") return toMediaItem(again);
    throw new UploadError(409, "conflict", "This upload changed while finishing. Reload the media list.");
  }
  return toMediaItem({ ...row, status: "ready", upload_id: null, updated_at: now });
}

// ---------------------------------------------------------------- delete

/** Lessons and courses that point at `key`. */
async function usesOf(db: Db, key: string): Promise<{ lessons: number[]; courses: number[] }> {
  const lessons = await db
    .prepare("SELECT id FROM lessons WHERE (video_provider = 'r2' AND video_ref = ?) OR captions_key = ? ORDER BY id")
    .bind(key, key)
    .all<{ id: number }>();
  const courses = await db
    .prepare("SELECT id FROM courses WHERE cover_key = ? OR og_image_key = ? ORDER BY id")
    .bind(key, key)
    .all<{ id: number }>();
  return { lessons: lessons.results.map((r) => r.id), courses: courses.results.map((r) => r.id) };
}

/**
 * DELETE /api/admin/uploads/:id. An unfinished upload is aborted. A finished file is deleted from
 * R2 and marked deleted; if a lesson or course still uses it, 409 unless `force` (then the lesson
 * loses its video or captions, the course its image). Deleting twice is fine.
 */
export async function deleteMedia(env: Env, idParam: string, force: boolean, now: number = unixNow()): Promise<void> {
  const id = parseId(idParam, "id");
  const row = await loadMedia(env.DB, id);
  if (!row) throw new UploadError(404, "not_found", "That file doesn't exist.");
  if (row.status === "deleted" || row.status === "aborted") return;

  if (row.status === "uploading") {
    if (row.upload_id) {
      try {
        await env.MEDIA.resumeMultipartUpload(row.key, row.upload_id).abort();
      } catch {
        /* already gone in R2: the row is still marked aborted */
      }
    }
    await batch(env.DB, [
      env.DB.prepare("UPDATE media SET status = 'aborted', upload_id = NULL, updated_at = ? WHERE id = ? AND status = 'uploading'").bind(now, id),
      auditStatement(env.DB, { actor: "admin", action: "media.upload_abort", entity: "media", entityId: id, data: { key: row.key }, now }),
    ]);
    return;
  }

  const uses = await usesOf(env.DB, row.key);
  if ((uses.lessons.length || uses.courses.length) && !force) {
    const where = [uses.lessons.length ? `${uses.lessons.length} lesson(s)` : "", uses.courses.length ? `${uses.courses.length} course(s)` : ""]
      .filter(Boolean)
      .join(" and ");
    throw new ConflictError("conflict", `This file is used by ${where}. Replace it there first, or delete it anyway.`);
  }
  // D1 first: if R2's delete then fails, the worst case is an unused object, never a lesson
  // pointing at a missing video.
  await batch(env.DB, [
    env.DB.prepare("UPDATE media SET status = 'deleted', lesson_id = NULL, updated_at = ? WHERE id = ?").bind(now, id),
    env.DB.prepare("UPDATE lessons SET video_provider = 'none', video_ref = NULL, updated_at = ? WHERE video_provider = 'r2' AND video_ref = ?").bind(now, row.key),
    env.DB.prepare("UPDATE lessons SET captions_key = NULL, updated_at = ? WHERE captions_key = ?").bind(now, row.key),
    env.DB.prepare("UPDATE courses SET cover_key = NULL, updated_at = ? WHERE cover_key = ?").bind(now, row.key),
    env.DB.prepare("UPDATE courses SET og_image_key = NULL, updated_at = ? WHERE og_image_key = ?").bind(now, row.key),
    uses.courses.length ? bumpContentVersionStatement(env.DB, now) : null,
    auditStatement(env.DB, {
      actor: "admin",
      action: "media.delete",
      entity: "media",
      entityId: id,
      data: { key: row.key, kind: row.kind, size: row.size_bytes, detached: uses },
      now,
    }),
  ]);
  try {
    await env.MEDIA.delete(row.key);
  } catch (err) {
    console.error(`media delete ${id}: R2 delete failed (${err instanceof Error ? err.message : "unknown"}); the object is orphaned`);
  }
}

// ---------------------------------------------------------------- list

const STATUSES: readonly MediaStatus[] = ["uploading", "ready", "aborted", "deleted"];

/** GET /api/admin/media. Newest first; deleted and aborted rows only when asked for by status. */
export async function listMedia(env: Env, query: URLSearchParams): Promise<MediaItem[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const kind = query.get("kind");
  if (kind !== null) {
    if (!(MEDIA_KINDS as string[]).includes(kind)) throw new ValidationError("kind", "Unknown kind.", "upload_invalid");
    where.push("kind = ?");
    params.push(kind);
  }
  const status = query.get("status");
  if (status !== null) {
    if (!(STATUSES as string[]).includes(status)) throw new ValidationError("status", "Unknown status.", "upload_invalid");
    where.push("status = ?");
    params.push(status);
  } else {
    where.push("status IN ('uploading', 'ready')");
  }
  const lessonId = query.get("lessonId");
  if (lessonId !== null) {
    where.push("lesson_id = ?");
    params.push(parseId(lessonId, "lessonId"));
  }
  const { results } = await env.DB.prepare(`SELECT ${MEDIA_COLUMNS} FROM media WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT 500`)
    .bind(...params)
    .all<MediaRow>();
  return results.map(toMediaItem);
}
