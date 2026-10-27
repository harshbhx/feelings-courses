// Shared set-up for W4 (media) tests: a migrated D1, a fake R2, a student with a live session
// enrolled in the seeded demo course, and lesson 1 pointing at an R2 video.

import { createHash } from "node:crypto";
import { createTestDb } from "../helpers/d1.mjs";
import { createFakeR2 } from "../helpers/r2.mjs";
import { resetLiveChecks } from "../../functions/_lib/media-serve.ts";

export const NOW = 1_790_000_000;
export const APP_SECRET = "test-app-secret-0123456789abcdef0123456789";
export const TOKEN = "A".repeat(43);
export const OTHER_TOKEN = "B".repeat(43);
export const VIDEO_KEY = "videos/2026/10/0123456789abcdef-intro.mp4";
export const CAPTIONS_KEY = "captions/2026/10/0123456789abcdef-intro.vtt";
export const COURSE_ID = 1;
export const LESSON_ID = 1;

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export const tagOf = (token) => sha256(token).slice(0, 16);
export const sessionCookie = (token = TOKEN) => `__Host-fbc_s=${token}`;

/** A fake MP4: "....ftypisom" then filler, `size` bytes. */
export function mp4Bytes(size) {
  if (size < 12) return new Uint8Array(size).fill(7);
  const bytes = new Uint8Array(size);
  bytes.set([0, 0, 0, 0x18], 0);
  bytes.set(new TextEncoder().encode("ftypisom"), 4);
  for (let i = 12; i < size; i++) bytes[i] = i % 251;
  return bytes;
}

/**
 * @param {{ enrolled?: boolean, video?: boolean, captions?: boolean, minPartSize?: number }} [opts]
 */
export async function setup({ enrolled = true, video = true, captions = false, minPartSize } = {}) {
  resetLiveChecks();
  const db = await createTestDb();
  const r2 = createFakeR2(minPartSize ? { minPartSize } : undefined);
  db.sqlite.prepare("INSERT INTO students (id, name, phone, email, created_at, updated_at) VALUES (1, 'Priya Shah', '+919876541578', NULL, ?, ?)").run(NOW, NOW);
  db.sqlite.prepare("INSERT INTO students (id, name, phone, email, created_at, updated_at) VALUES (2, NULL, NULL, 'meera@example.com', ?, ?)").run(NOW, NOW);
  db.sqlite
    .prepare("INSERT INTO sessions (token_hash, student_id, created_at, last_seen_at, expires_at) VALUES (?, 1, ?, ?, ?)")
    .run(sha256(TOKEN), NOW - 100, NOW - 100, NOW + 3650 * 86_400);
  db.sqlite
    .prepare("INSERT INTO sessions (token_hash, student_id, created_at, last_seen_at, expires_at) VALUES (?, 2, ?, ?, ?)")
    .run(sha256(OTHER_TOKEN), NOW - 100, NOW - 100, NOW + 3650 * 86_400);
  if (enrolled) {
    db.sqlite
      .prepare("INSERT INTO enrollments (student_id, course_id, source, mode, starts_at, expires_at, created_at, updated_at) VALUES (1, ?, 'manual', 'live', ?, ?, ?, ?)")
      .run(COURSE_ID, NOW - 1000, NOW + 365 * 86_400, NOW, NOW);
  }
  if (video) {
    db.sqlite.prepare("UPDATE lessons SET video_provider = 'r2', video_ref = ?, duration_seconds = 300 WHERE id = ?").run(VIDEO_KEY, LESSON_ID);
    await r2.put(VIDEO_KEY, mp4Bytes(1000), { httpMetadata: { contentType: "video/mp4" } });
  }
  if (captions) {
    db.sqlite.prepare("UPDATE lessons SET captions_key = ? WHERE id = ?").run(CAPTIONS_KEY, LESSON_ID);
    await r2.put(CAPTIONS_KEY, "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n", { httpMetadata: { contentType: "text/vtt; charset=utf-8" } });
  }
  const env = { DB: db, MEDIA: r2, APP_SECRET, HUB_HOST: "courses.feelingsbeautycare.in", APEX_DOMAIN: "feelingsbeautycare.in" };
  return { db, r2, env };
}

/** The EnrollmentRef W3's requireEnrollment would give student 1. */
export function enrollmentRef(db, token = TOKEN) {
  const row = db.get("SELECT id FROM enrollments WHERE student_id = 1 AND course_id = ?", COURSE_ID);
  return { studentId: 1, enrollmentId: row?.id ?? 0, courseId: COURSE_ID, sessionTag: tagOf(token) };
}
