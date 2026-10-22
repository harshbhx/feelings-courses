/**
 * Courses in the admin (W5): list, read, create, edit, delete (drafts only), the outline (modules
 * and lessons, with their order), publish / unpublish / archive, and the subdomain check.
 *
 * Owner decisions this code keeps (plan 10):
 * - The admin picks each course's slug, which is also its subdomain (<slug>.feelingsbeautycare.in).
 *   It can change until the domain is active, then it is locked (slug_locked).
 * - format: online (recorded lessons), in_person (batch booking) or hybrid (both), per course.
 * - Fees come from the admin only. A draft may have no fee; publishing needs one.
 * - access_days defaults to 365 (DEFAULT_ACCESS_DAYS).
 *
 * Every write is one D1 batch with its audit row. A change that touches what the public site shows
 * (anything on a published course) bumps settings.content_version in the same batch, so the
 * publish status knows the live pages are behind.
 */
import type { AdminOutlineRequest } from "../../../src/shared/api.ts";
import {
  DEFAULT_ACCESS_DAYS,
  LESSON_SLUG_RE,
  RESERVED_LABELS,
  RESERVED_LESSON_SLUGS,
  isValidCourseSlug,
} from "../../../src/shared/constants.ts";
import type {
  AdminBatch,
  AdminCourse,
  AdminLesson,
  AdminModule,
  CourseDetails,
  CourseFormat,
  CourseStatus,
  DomainStatus,
  VideoProvider,
} from "../../../src/shared/types.ts";
import { randomHex } from "../crypto.ts";
import { auditStatement } from "../db/audit.ts";
import type { Db, DbStatement, DbValue } from "../db/d1.ts";
import { ConflictError, ValidationError, isCheckViolation, isUniqueViolation } from "../db/errors.ts";
import { bumpContentVersionStatement } from "../db/settings.ts";
import { batch, lastId } from "../db/tx.ts";
import * as v from "../db/validate.ts";
import { ADMIN_ACTOR } from "./auth.ts";
import { NotFoundError } from "./request.ts";

export const COURSE_FORMATS: readonly CourseFormat[] = ["online", "in_person", "hybrid"];
/** The schema's default teacher, used when a new course doesn't name one. */
export const DEFAULT_TEACHER = "Urmi Mengar";
export const MAX_MODULES = 50;
export const MAX_LESSONS = 300;
export const MAX_PRICE_PAISE = 100_000_000;

// ---------------------------------------------------------------- rows and mapping

export interface CourseRow {
  id: number;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  teacher: string;
  format: CourseFormat;
  price_paise: number | null;
  compare_at_paise: number | null;
  deposit_paise: number | null;
  level: string | null;
  language: string | null;
  duration_text: string | null;
  access_days: number | null;
  certificate_title: string | null;
  details: string;
  cover_key: string | null;
  og_image_key: string | null;
  seo_title: string | null;
  seo_description: string | null;
  is_demo: number;
  status: CourseStatus;
  domain_status: DomainStatus;
  sort_order: number;
  published_at: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

const COURSE_COLUMNS =
  "id, slug, title, subtitle, description, teacher, format, price_paise, compare_at_paise, deposit_paise, level, " +
  "language, duration_text, access_days, certificate_title, details, cover_key, og_image_key, seo_title, " +
  "seo_description, is_demo, status, domain_status, sort_order, published_at, created_at, updated_at, deleted_at";

interface ModuleRow {
  id: number;
  course_id: number;
  position: number;
  title: string;
}

interface LessonRow {
  id: number;
  course_id: number;
  module_id: number;
  position: number;
  slug: string;
  title: string;
  minutes: number;
  video_provider: VideoProvider;
  video_ref: string | null;
  vertical: number;
  captions_key: string | null;
  duration_seconds: number | null;
  notes: string | null;
  free_preview: number;
}

export interface BatchRow {
  id: number;
  course_id: number;
  title: string;
  starts_on: string;
  ends_on: string | null;
  schedule_text: string | null;
  price_paise: number | null;
  seats: number | null;
  seats_taken: number;
  status: AdminBatch["status"];
  created_at: number;
  updated_at: number;
}

export const BATCH_COLUMNS =
  "id, course_id, title, starts_on, ends_on, schedule_text, price_paise, seats, seats_taken, status, created_at, updated_at";

export function mapBatch(row: BatchRow): AdminBatch {
  return {
    id: row.id,
    courseId: row.course_id,
    title: row.title,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    scheduleText: row.schedule_text,
    pricePaise: row.price_paise,
    seats: row.seats,
    seatsTaken: row.seats_taken,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLesson(row: LessonRow): AdminLesson {
  return {
    id: row.id,
    moduleId: row.module_id,
    position: row.position,
    slug: row.slug,
    title: row.title,
    minutes: row.minutes,
    videoProvider: row.video_provider,
    videoRef: row.video_ref,
    vertical: row.vertical === 1,
    captionsKey: row.captions_key,
    durationSeconds: row.duration_seconds,
    notes: row.notes,
    freePreview: row.free_preview === 1,
  };
}

const EMPTY_DETAILS: CourseDetails = { outcomes: [], forWho: [], faqs: [], glimpses: [], highlights: [] };

/** Reads the details JSON leniently (older rows may miss a list): never throws. */
export function parseDetails(text: string | null): CourseDetails {
  let raw: unknown;
  try {
    raw = JSON.parse(text ?? "{}");
  } catch {
    return { ...EMPTY_DETAILS };
  }
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const list = <T>(value: unknown, keep: (item: unknown) => item is T): T[] => (Array.isArray(value) ? value.filter(keep) : []);
  const isString = (item: unknown): item is string => typeof item === "string";
  return {
    outcomes: list(obj.outcomes, isString),
    forWho: list(obj.forWho, isString),
    highlights: list(obj.highlights, isString),
    faqs: list(obj.faqs, (item): item is { q: string; a: string } =>
      Boolean(item) && typeof (item as { q?: unknown }).q === "string" && typeof (item as { a?: unknown }).a === "string",
    ).map(({ q, a }) => ({ q, a })),
    glimpses: list(obj.glimpses, (item): item is { youtubeId: string; label: string } =>
      Boolean(item) &&
      typeof (item as { youtubeId?: unknown }).youtubeId === "string" &&
      typeof (item as { label?: unknown }).label === "string",
    ).map(({ youtubeId, label }) => ({ youtubeId, label })),
  };
}

function mapCourse(
  row: CourseRow,
  modules: AdminModule[],
  batches: AdminBatch[],
  enrollmentCount: number,
): AdminCourse {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    description: row.description,
    teacher: row.teacher,
    format: row.format,
    pricePaise: row.price_paise,
    compareAtPaise: row.compare_at_paise,
    depositPaise: row.deposit_paise,
    level: row.level,
    language: row.language,
    durationText: row.duration_text,
    accessDays: row.access_days,
    certificateTitle: row.certificate_title,
    details: parseDetails(row.details),
    coverKey: row.cover_key,
    ogImageKey: row.og_image_key,
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
    isDemo: row.is_demo === 1,
    status: row.status,
    domainStatus: row.domain_status,
    slugLocked: row.domain_status === "active",
    sortOrder: row.sort_order,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    modules,
    batches,
    lessonCount: modules.reduce((n, m) => n + m.lessons.length, 0),
    enrollmentCount,
  };
}

// ---------------------------------------------------------------- reading

async function loadCourses(db: Db, onlyId: number | null): Promise<AdminCourse[]> {
  const filter = onlyId === null ? "" : " AND id = ?";
  const childFilter = onlyId === null ? "" : " AND course_id = ?";
  const bindId = (sql: string) => (onlyId === null ? db.prepare(sql) : db.prepare(sql).bind(onlyId));
  const live = "course_id IN (SELECT id FROM courses WHERE deleted_at IS NULL)";

  const [courses, modules, lessons, batches, counts] = await Promise.all([
    bindId(`SELECT ${COURSE_COLUMNS} FROM courses WHERE deleted_at IS NULL${filter} ORDER BY sort_order, id`).all<CourseRow>(),
    bindId(`SELECT id, course_id, position, title FROM modules WHERE ${live}${childFilter} ORDER BY course_id, position`).all<ModuleRow>(),
    bindId(
      "SELECT id, course_id, module_id, position, slug, title, minutes, video_provider, video_ref, vertical, captions_key, " +
        `duration_seconds, notes, free_preview FROM lessons WHERE ${live}${childFilter} ORDER BY module_id, position`,
    ).all<LessonRow>(),
    bindId(`SELECT ${BATCH_COLUMNS} FROM batches WHERE ${live}${childFilter} ORDER BY starts_on, id`).all<BatchRow>(),
    bindId(
      `SELECT course_id, count(*) AS n FROM enrollments WHERE revoked_at IS NULL AND ${live}${childFilter} GROUP BY course_id`,
    ).all<{ course_id: number; n: number }>(),
  ]);

  const lessonsByModule = new Map<number, AdminLesson[]>();
  for (const row of lessons.results) {
    const list = lessonsByModule.get(row.module_id) ?? [];
    list.push(mapLesson(row));
    lessonsByModule.set(row.module_id, list);
  }
  const modulesByCourse = new Map<number, AdminModule[]>();
  for (const row of modules.results) {
    const list = modulesByCourse.get(row.course_id) ?? [];
    list.push({ id: row.id, position: row.position, title: row.title, lessons: lessonsByModule.get(row.id) ?? [] });
    modulesByCourse.set(row.course_id, list);
  }
  const batchesByCourse = new Map<number, AdminBatch[]>();
  for (const row of batches.results) {
    const list = batchesByCourse.get(row.course_id) ?? [];
    list.push(mapBatch(row));
    batchesByCourse.set(row.course_id, list);
  }
  const enrolled = new Map(counts.results.map((r) => [r.course_id, r.n]));
  return courses.results.map((row) =>
    mapCourse(row, modulesByCourse.get(row.id) ?? [], batchesByCourse.get(row.id) ?? [], enrolled.get(row.id) ?? 0),
  );
}

/** Every course that isn't deleted, in the catalog's order, with outline and batches. */
export function listCourses(db: Db): Promise<AdminCourse[]> {
  return loadCourses(db, null);
}

/** One course (not deleted), or NotFoundError. */
export async function getCourse(db: Db, id: number): Promise<AdminCourse> {
  const [course] = await loadCourses(db, id);
  if (!course) throw new NotFoundError("That course doesn't exist.");
  return course;
}

/** The raw row of a course that isn't deleted, or NotFoundError. */
export async function courseRow(db: Db, id: number): Promise<CourseRow> {
  const row = await db
    .prepare(`SELECT ${COURSE_COLUMNS} FROM courses WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<CourseRow>();
  if (!row) throw new NotFoundError("That course doesn't exist.");
  return row;
}

// ---------------------------------------------------------------- validation

/** A course slug (subdomain label): lowercased; format and reserved names checked. */
export function courseSlug(value: unknown, field = "slug"): string {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(field, "Choose the course's web address.", "required");
  const tidy = value.trim().toLowerCase();
  if (RESERVED_LABELS.includes(tidy)) throw new ValidationError(field, `"${tidy}" is reserved. Choose another web address.`);
  if (!isValidCourseSlug(tidy)) {
    throw new ValidationError(field, "Use 2 to 40 lowercase letters, digits or single hyphens, like \"bridal-basics\".");
  }
  return tidy;
}

/** A fee: null (not set yet), 0 (free) or ₹1 to ₹10,00,000. */
function feePaise(value: unknown, field: string): number | null {
  if (v.isMissing(value)) return null;
  const amount = v.paise(value, field, 0, MAX_PRICE_PAISE);
  if (amount !== 0 && amount < 100) throw new ValidationError(field, `${field} must be 0 (free) or at least ₹1 (100 paise).`);
  return amount;
}

function optionalAmount(value: unknown, field: string): number | null {
  return v.isMissing(value) ? null : v.paise(value, field, 100, MAX_PRICE_PAISE);
}

const MEDIA_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,299}$/;

/** An R2 key as W4 writes them. No "..", no "//". */
export function mediaKey(value: unknown, field: string): string | null {
  if (v.isMissing(value) || value === "") return null;
  if (typeof value !== "string" || !MEDIA_KEY_RE.test(value) || value.includes("..") || value.includes("//")) {
    throw new ValidationError(field, `${field} is not a valid file key.`);
  }
  return value;
}

function stringList(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (v.isMissing(value)) return [];
  if (!Array.isArray(value)) throw new ValidationError(field, `${field} must be a list.`);
  if (value.length > maxItems) throw new ValidationError(field, `${field} can have at most ${maxItems} items.`);
  return value.map((item, i) => v.text(item, `${field}[${i}]`, { max: maxLength }));
}

/** The details JSON, checked strictly (shared/types.ts CourseDetails). */
export function validateDetails(value: unknown, field = "details"): CourseDetails {
  if (v.isMissing(value)) return { ...EMPTY_DETAILS };
  if (typeof value !== "object" || Array.isArray(value)) throw new ValidationError(field, "details must be an object.");
  const obj = value as Record<string, unknown>;
  const faqsRaw = obj.faqs;
  if (!v.isMissing(faqsRaw) && !Array.isArray(faqsRaw)) throw new ValidationError(`${field}.faqs`, "faqs must be a list.");
  const faqs = (faqsRaw as unknown[] | undefined ?? []).map((item, i) => {
    if (!item || typeof item !== "object") throw new ValidationError(`${field}.faqs[${i}]`, "Each FAQ needs a question and an answer.");
    const { q, a } = item as Record<string, unknown>;
    return {
      q: v.text(q, `${field}.faqs[${i}].q`, { max: 300 }),
      a: v.text(a, `${field}.faqs[${i}].a`, { max: 3000, multiline: true }),
    };
  });
  if (faqs.length > 30) throw new ValidationError(`${field}.faqs`, "At most 30 FAQs.");
  const glimpsesRaw = obj.glimpses;
  if (!v.isMissing(glimpsesRaw) && !Array.isArray(glimpsesRaw)) throw new ValidationError(`${field}.glimpses`, "glimpses must be a list.");
  const glimpses = (glimpsesRaw as unknown[] | undefined ?? []).map((item, i) => {
    if (!item || typeof item !== "object") throw new ValidationError(`${field}.glimpses[${i}]`, "Each glimpse needs a YouTube id and a label.");
    const { youtubeId, label } = item as Record<string, unknown>;
    if (typeof youtubeId !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(youtubeId)) {
      throw new ValidationError(`${field}.glimpses[${i}].youtubeId`, "A YouTube video id is 11 letters, digits, - or _.");
    }
    return { youtubeId, label: v.text(label, `${field}.glimpses[${i}].label`, { max: 120 }) };
  });
  if (glimpses.length > 20) throw new ValidationError(`${field}.glimpses`, "At most 20 glimpses.");
  const details: CourseDetails = {
    outcomes: stringList(obj.outcomes, `${field}.outcomes`, 20, 200),
    forWho: stringList(obj.forWho, `${field}.forWho`, 20, 200),
    faqs,
    glimpses,
    highlights: stringList(obj.highlights, `${field}.highlights`, 20, 200),
  };
  if (JSON.stringify(details).length > 50_000) throw new ValidationError(field, "The course details are too long.");
  return details;
}

/** The columns a course input sets, as they are stored. */
export interface CourseValues {
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  teacher: string;
  format: CourseFormat;
  price_paise: number | null;
  compare_at_paise: number | null;
  deposit_paise: number | null;
  level: string | null;
  language: string | null;
  duration_text: string | null;
  access_days: number | null;
  certificate_title: string | null;
  details: string;
  cover_key: string | null;
  og_image_key: string | null;
  seo_title: string | null;
  seo_description: string | null;
  is_demo: number;
  sort_order: number;
}

type FieldSpec = [inputKey: string, column: keyof CourseValues, check: (value: unknown, field: string) => DbValue];

const FIELDS: FieldSpec[] = [
  ["slug", "slug", (x, f) => courseSlug(x, f)],
  ["title", "title", (x, f) => v.text(x, f, { max: 120 })],
  ["subtitle", "subtitle", (x, f) => v.optionalText(x, f, { max: 300 })],
  ["description", "description", (x, f) => v.optionalText(x, f, { max: 20_000, multiline: true })],
  ["teacher", "teacher", (x, f) => v.text(x, f, { max: 80 })],
  ["format", "format", (x, f) => v.oneOf(x, f, COURSE_FORMATS)],
  ["pricePaise", "price_paise", feePaise],
  ["compareAtPaise", "compare_at_paise", optionalAmount],
  ["depositPaise", "deposit_paise", optionalAmount],
  ["level", "level", (x, f) => v.optionalText(x, f, { max: 60 })],
  ["language", "language", (x, f) => v.optionalText(x, f, { max: 80 })],
  ["durationText", "duration_text", (x, f) => v.optionalText(x, f, { max: 60 })],
  ["accessDays", "access_days", (x, f) => v.optionalInt(x, f, 1, 3650)],
  ["certificateTitle", "certificate_title", (x, f) => v.optionalText(x, f, { max: 200 })],
  ["details", "details", (x, f) => JSON.stringify(validateDetails(x, f))],
  ["coverKey", "cover_key", mediaKey],
  ["ogImageKey", "og_image_key", mediaKey],
  ["seoTitle", "seo_title", (x, f) => v.optionalText(x, f, { max: 70 })],
  ["seoDescription", "seo_description", (x, f) => v.optionalText(x, f, { max: 170 })],
  ["isDemo", "is_demo", (x, f) => v.flag(x, f)],
  ["sortOrder", "sort_order", (x, f) => v.int(x, f, -100_000, 100_000)],
];

const CREATE_DEFAULTS: Partial<Record<string, unknown>> = {
  teacher: DEFAULT_TEACHER,
  format: "online",
  accessDays: DEFAULT_ACCESS_DAYS,
  details: undefined,
  isDemo: false,
  sortOrder: 0,
};

/**
 * Checks a course body. On create (`current` null) missing fields take their defaults; on edit,
 * fields left out keep their stored value and null clears an optional one. Unknown keys are
 * ignored, so the UI may send back a whole AdminCourse.
 */
export async function courseValues(db: Db, input: Record<string, unknown>, current: CourseRow | null): Promise<CourseValues> {
  const out = {} as Record<keyof CourseValues, DbValue>;
  for (const [key, column, check] of FIELDS) {
    const given = Object.prototype.hasOwnProperty.call(input, key);
    if (current && !given) {
      out[column] = current[column] as DbValue;
      continue;
    }
    const value = given ? input[key] : CREATE_DEFAULTS[key];
    out[column] = check(value, key);
  }
  const values = out as unknown as CourseValues;

  if (values.compare_at_paise !== null) {
    if (values.price_paise === null || values.compare_at_paise <= values.price_paise) {
      throw new ValidationError("compareAtPaise", "The \"was\" price must be higher than the fee.");
    }
  }
  if (values.deposit_paise !== null) {
    if (values.format === "online") throw new ValidationError("depositPaise", "A booking amount is only for in-person batches.");
    if (values.price_paise === null || values.deposit_paise >= values.price_paise) {
      throw new ValidationError("depositPaise", "The booking amount must be less than the fee.");
    }
  }
  if (current?.status === "published" && values.price_paise === null) {
    throw new ValidationError("pricePaise", "A published course needs a fee. Unpublish it first to clear the fee.");
  }
  for (const [key, column] of [["coverKey", "cover_key"], ["ogImageKey", "og_image_key"]] as const) {
    const key_ = values[column];
    if (key_ !== null && key_ !== current?.[column]) await requireMedia(db, key_, "image", key);
  }
  return values;
}

/** A file the admin points at must be an uploaded, finished file of the right kind (W4's media table). */
async function requireMedia(db: Db, key: string, kind: "image" | "video" | "captions", field: string): Promise<void> {
  const row = await db.prepare("SELECT 1 AS ok FROM media WHERE key = ? AND kind = ? AND status = 'ready'").bind(key, kind).first();
  if (!row) throw new ValidationError(field, `Upload the ${kind === "captions" ? "captions file" : kind} first.`);
}

function writeError(err: unknown): never {
  if (isUniqueViolation(err, "courses.slug")) throw new ConflictError("slug_taken", "Another course already uses this web address.");
  if (isCheckViolation(err)) throw new ValidationError("course", "Some of these values aren't allowed.");
  throw err;
}

// ---------------------------------------------------------------- create, edit, delete

const VALUE_COLUMNS = FIELDS.map(([, column]) => column);

export async function createCourse(db: Db, input: Record<string, unknown>, now: number): Promise<AdminCourse> {
  const values = await courseValues(db, input, null);
  let id: number;
  try {
    const result = await db
      .prepare(
        `INSERT INTO courses (${VALUE_COLUMNS.join(", ")}, status, domain_status, created_at, updated_at) ` +
          `VALUES (${VALUE_COLUMNS.map(() => "?").join(", ")}, 'draft', 'none', ?, ?)`,
      )
      .bind(...VALUE_COLUMNS.map((c) => values[c]), now, now)
      .run();
    id = lastId(result);
  } catch (err) {
    writeError(err);
  }
  await auditStatement(db, {
    actor: ADMIN_ACTOR,
    action: "course.create",
    entity: "course",
    entityId: id,
    data: { slug: values.slug, title: values.title, format: values.format, pricePaise: values.price_paise },
    now,
  }).run();
  return getCourse(db, id);
}

export async function updateCourse(db: Db, id: number, input: Record<string, unknown>, now: number): Promise<AdminCourse> {
  const current = await courseRow(db, id);
  const values = await courseValues(db, input, current);
  if (values.slug !== current.slug && current.domain_status === "active") {
    throw new ConflictError("slug_locked", "This course's subdomain is live, so its web address can't change.");
  }
  const changed = VALUE_COLUMNS.filter((c) => values[c] !== current[c]);
  if (changed.length === 0) return getCourse(db, id);

  // A new slug needs its own subdomain: a pending check of the old one no longer applies.
  const domainStatus: DomainStatus = values.slug !== current.slug ? "none" : current.domain_status;
  const data: Record<string, unknown> = { changed };
  if (changed.includes("slug")) data.slug = { from: current.slug, to: values.slug };
  if (changed.includes("price_paise")) data.pricePaise = { from: current.price_paise, to: values.price_paise };
  if (changed.includes("format")) data.format = { from: current.format, to: values.format };
  try {
    await batch(db, [
      db
        .prepare(
          `UPDATE courses SET ${changed.map((c) => `${c} = ?`).join(", ")}, domain_status = ?, updated_at = ? ` +
            "WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(...changed.map((c) => values[c]), domainStatus, now, id),
      current.status === "published" && bumpContentVersionStatement(db, now),
      auditStatement(db, { actor: ADMIN_ACTOR, action: "course.update", entity: "course", entityId: id, data, now }),
    ]);
  } catch (err) {
    writeError(err);
  }
  return getCourse(db, id);
}

/**
 * Deletes a draft that nobody bought or was enrolled in. Business rows are never hard deleted:
 * the row gets deleted_at, and its slug is renamed so the subdomain is free for another course.
 * Anything else should be archived instead (archived courses keep their students' access).
 */
export async function deleteCourse(db: Db, id: number, now: number): Promise<void> {
  const current = await courseRow(db, id);
  if (current.status === "published") throw new ConflictError("in_use", "Unpublish or archive the course first.");
  if (current.domain_status === "active") throw new ConflictError("in_use", "This course's subdomain is live. Archive it instead.");
  const used = await db
    .prepare(
      "SELECT (SELECT count(*) FROM orders WHERE course_id = ?1) + (SELECT count(*) FROM enrollments WHERE course_id = ?1) AS n",
    )
    .bind(id)
    .first<{ n: number }>();
  if ((used?.n ?? 0) > 0) throw new ConflictError("in_use", "This course has orders or students. Archive it instead.");
  const freed = `deleted-${id}-${randomHex(3)}`;
  await batch(db, [
    db
      .prepare("UPDATE courses SET deleted_at = ?, slug = ?, status = 'draft', updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .bind(now, freed, now, id),
    // Coupons only for this course can never be used again.
    db.prepare("UPDATE coupons SET active = 0, updated_at = ? WHERE course_id = ? AND active = 1").bind(now, id),
    auditStatement(db, { actor: ADMIN_ACTOR, action: "course.delete", entity: "course", entityId: id, data: { slug: current.slug }, now }),
  ]);
}

// ---------------------------------------------------------------- status changes

/** Why a course can't be published yet, or null when it can. */
export async function publishBlocker(db: Db, row: CourseRow): Promise<ValidationError | null> {
  if (row.price_paise === null) return new ValidationError("pricePaise", "Enter the fee before publishing.");
  if (!isValidCourseSlug(row.slug)) return new ValidationError("slug", "Choose a valid web address before publishing.");
  const counts = await db
    .prepare(
      "SELECT (SELECT count(*) FROM lessons WHERE course_id = ?1) AS lessons, " +
        "(SELECT count(*) FROM batches WHERE course_id = ?1 AND status = 'open') AS batches",
    )
    .bind(row.id)
    .first<{ lessons: number; batches: number }>();
  const lessons = counts?.lessons ?? 0;
  const batches = counts?.batches ?? 0;
  if (row.format === "online" && lessons === 0) return new ValidationError("modules", "Add at least one lesson before publishing.");
  if (row.format === "in_person" && batches === 0) return new ValidationError("batches", "Add an open batch before publishing.");
  if (row.format === "hybrid" && lessons === 0 && batches === 0) {
    return new ValidationError("modules", "Add a lesson or an open batch before publishing.");
  }
  return null;
}

export type StatusAction = "publish" | "unpublish" | "archive";

/**
 * Publish (draft or archived → published), unpublish (published → draft) or archive (→ archived:
 * off the catalog, but students keep their access). Bumps content_version when the public site
 * changes. The caller then asks for a rebuild.
 */
export async function setCourseStatus(db: Db, id: number, action: StatusAction, now: number): Promise<{ changed: boolean }> {
  const row = await courseRow(db, id);
  const target: CourseStatus = action === "publish" ? "published" : action === "unpublish" ? "draft" : "archived";
  if (row.status === target) return { changed: false };
  if (action === "unpublish" && row.status !== "published") {
    throw new ConflictError("conflict", "Only a published course can be unpublished.");
  }
  if (action === "publish") {
    const blocker = await publishBlocker(db, row);
    if (blocker) throw blocker;
  }
  const touchesSite = action === "publish" || row.status === "published";
  await batch(db, [
    db
      .prepare(
        "UPDATE courses SET status = ?, published_at = CASE WHEN ? = 'published' THEN ? ELSE published_at END, updated_at = ? " +
          "WHERE id = ? AND deleted_at IS NULL",
      )
      .bind(target, target, now, now, id),
    touchesSite && bumpContentVersionStatement(db, now),
    auditStatement(db, {
      actor: ADMIN_ACTOR,
      action: `course.${action}`,
      entity: "course",
      entityId: id,
      data: { from: row.status, to: target, slug: row.slug },
      now,
    }),
  ]);
  return { changed: true };
}

// ---------------------------------------------------------------- subdomain check

export type DomainProbe = number | "timeout" | "unreachable";
export const DOMAIN_PROBE_TIMEOUT_MS = 5_000;

/** Fetches https://<host>/ without following redirects. */
export async function probeHost(host: string, fetcher: typeof fetch = fetch): Promise<DomainProbe> {
  try {
    const response = await fetcher(`https://${host}/`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(DOMAIN_PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.status;
  } catch (err) {
    return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "timeout" : "unreachable";
  }
}

/**
 * Checks whether <slug>.<apex> answers. A 2xx or 3xx marks the domain active, which locks the slug. A
 * failed probe marks a not-yet-active domain pending; an active one stays active (a blip must not
 * unlock a live web address). The host is built from the stored slug only, never from the request.
 */
export async function checkDomain(
  db: Db,
  id: number,
  apexDomain: string,
  now: number,
  fetcher: typeof fetch = fetch,
): Promise<{ host: string; status: DomainStatus; probe: DomainProbe }> {
  const row = await courseRow(db, id);
  if (!isValidCourseSlug(row.slug)) throw new ValidationError("slug", "This course has no valid web address.");
  const host = `${row.slug}.${apexDomain}`;
  const probe = await probeHost(host, fetcher);
  const reachable = typeof probe === "number" && probe >= 200 && probe < 400;
  const status: DomainStatus = reachable ? "active" : row.domain_status === "active" ? "active" : "pending";
  if (status !== row.domain_status) {
    await batch(db, [
      db.prepare("UPDATE courses SET domain_status = ?, updated_at = ? WHERE id = ?").bind(status, now, id),
      // The hub's /c/<slug>/ redirect and canonical URLs depend on it (dist/domains.json).
      row.status === "published" && bumpContentVersionStatement(db, now),
      auditStatement(db, { actor: ADMIN_ACTOR, action: "course.domain", entity: "course", entityId: id, data: { host, from: row.domain_status, to: status, probe }, now }),
    ]);
  }
  return { host, status, probe };
}

// ---------------------------------------------------------------- outline (modules and lessons)

const VIDEO_PROVIDERS: readonly VideoProvider[] = ["r2", "youtube", "none"];
/** Lesson slugs the outline writer uses for a moment while it reorders; never accepted as input. */
const TEMP_SLUG_RE = /^tmp-reorder-[0-9]+$/;

interface LessonInput {
  id: number | null;
  slug: string;
  title: string;
  minutes: number;
  videoProvider: VideoProvider;
  videoRef: string | null;
  vertical: number;
  captionsKey: string | null;
  durationSeconds: number | null;
  notes: string | null;
  freePreview: number;
}

interface ModuleInput {
  id: number | null;
  title: string;
  lessons: LessonInput[];
}

function lessonSlug(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ValidationError(field, "Give the lesson a web address.", "required");
  const tidy = value.trim().toLowerCase();
  if (tidy.length < 1 || tidy.length > 80 || !LESSON_SLUG_RE.test(tidy)) {
    throw new ValidationError(field, "Use lowercase words joined by hyphens, like \"soft-glam\".");
  }
  if (RESERVED_LESSON_SLUGS.includes(tidy) || TEMP_SLUG_RE.test(tidy)) {
    throw new ValidationError(field, `"${tidy}" is reserved. Choose another.`);
  }
  return tidy;
}

function videoRef(provider: VideoProvider, value: unknown, field: string): string | null {
  if (provider === "none") {
    if (!v.isMissing(value) && value !== "") throw new ValidationError(field, "Choose a video source, or clear the video.");
    return null;
  }
  if (provider === "youtube") {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(value)) {
      throw new ValidationError(field, "A YouTube video id is 11 letters, digits, - or _.");
    }
    return value;
  }
  const key = mediaKey(value, field);
  if (key === null) throw new ValidationError(field, "Choose the uploaded video.", "required");
  return key;
}

/** Checks an outline body: shape, limits, unique slugs and ids. */
export function validateOutline(input: Record<string, unknown>): ModuleInput[] {
  const raw = input.modules;
  if (!Array.isArray(raw)) throw new ValidationError("modules", "modules must be a list.");
  if (raw.length > MAX_MODULES) throw new ValidationError("modules", `At most ${MAX_MODULES} modules.`);
  const slugs = new Set<string>();
  const lessonIds = new Set<number>();
  const moduleIds = new Set<number>();
  let lessonCount = 0;
  const modules = raw.map((m, i): ModuleInput => {
    const at = `modules[${i}]`;
    if (!m || typeof m !== "object" || Array.isArray(m)) throw new ValidationError(at, "Each module must be an object.");
    const mod = m as Record<string, unknown>;
    const id = v.isMissing(mod.id) ? null : v.id(mod.id, `${at}.id`);
    if (id !== null) {
      if (moduleIds.has(id)) throw new ValidationError(`${at}.id`, "A module appears twice.");
      moduleIds.add(id);
    }
    if (!Array.isArray(mod.lessons)) throw new ValidationError(`${at}.lessons`, "lessons must be a list.");
    lessonCount += mod.lessons.length;
    if (lessonCount > MAX_LESSONS) throw new ValidationError("modules", `At most ${MAX_LESSONS} lessons in a course.`);
    const lessons = (mod.lessons as unknown[]).map((l, j): LessonInput => {
      const lat = `${at}.lessons[${j}]`;
      if (!l || typeof l !== "object" || Array.isArray(l)) throw new ValidationError(lat, "Each lesson must be an object.");
      const les = l as Record<string, unknown>;
      const lessonId = v.isMissing(les.id) ? null : v.id(les.id, `${lat}.id`);
      if (lessonId !== null) {
        if (lessonIds.has(lessonId)) throw new ValidationError(`${lat}.id`, "A lesson appears twice.");
        lessonIds.add(lessonId);
      }
      const slug = lessonSlug(les.slug, `${lat}.slug`);
      if (slugs.has(slug)) throw new ValidationError(`${lat}.slug`, `Two lessons use "${slug}". Each needs its own.`);
      slugs.add(slug);
      const provider = v.isMissing(les.videoProvider) ? "none" : v.oneOf(les.videoProvider, `${lat}.videoProvider`, VIDEO_PROVIDERS);
      return {
        id: lessonId,
        slug,
        title: v.text(les.title, `${lat}.title`, { max: 160 }),
        minutes: v.isMissing(les.minutes) ? 0 : v.int(les.minutes, `${lat}.minutes`, 0, 600),
        videoProvider: provider,
        videoRef: videoRef(provider, les.videoRef, `${lat}.videoRef`),
        vertical: v.isMissing(les.vertical) ? 0 : v.flag(les.vertical, `${lat}.vertical`),
        captionsKey: mediaKey(les.captionsKey, `${lat}.captionsKey`),
        durationSeconds: v.optionalInt(les.durationSeconds, `${lat}.durationSeconds`, 0, 86_400),
        notes: v.optionalText(les.notes, `${lat}.notes`, { max: 20_000, multiline: true }),
        freePreview: v.isMissing(les.freePreview) ? 0 : v.flag(les.freePreview, `${lat}.freePreview`),
      };
    });
    return { id, title: v.text(mod.title, `${at}.title`, { max: 120 }), lessons };
  });
  return modules;
}

/**
 * Replaces a course's outline in one batch. Existing modules and lessons keep their ids (progress
 * and uploads stay attached); rows left out of the request are deleted (their progress goes with
 * them, by the schema's ON DELETE CASCADE); order is the order of the request.
 *
 * Positions and lesson slugs are UNIQUE, so the batch first moves every row out of the way
 * (negative positions, temporary slugs), then writes the final values, then deletes whatever is
 * still out of the way. New lessons find their module by its final position.
 */
export async function replaceOutline(db: Db, courseId: number, input: Record<string, unknown>, now: number): Promise<AdminCourse> {
  const course = await courseRow(db, courseId);
  const modules = validateOutline(input);

  const existing = await db
    .prepare("SELECT id, 'module' AS kind, NULL AS video_provider, NULL AS video_ref, NULL AS captions_key FROM modules WHERE course_id = ?1 " +
      "UNION ALL SELECT id, 'lesson', video_provider, video_ref, captions_key FROM lessons WHERE course_id = ?1")
    .bind(courseId)
    .all<{ id: number; kind: "module" | "lesson"; video_provider: string | null; video_ref: string | null; captions_key: string | null }>();
  const ownModules = new Set(existing.results.filter((r) => r.kind === "module").map((r) => r.id));
  const ownLessons = new Map(existing.results.filter((r) => r.kind === "lesson").map((r) => [r.id, r]));

  for (const [i, m] of modules.entries()) {
    if (m.id !== null && !ownModules.has(m.id)) throw new ValidationError(`modules[${i}].id`, "That module isn't part of this course.");
    for (const [j, l] of m.lessons.entries()) {
      const at = `modules[${i}].lessons[${j}]`;
      const before = l.id === null ? undefined : ownLessons.get(l.id);
      if (l.id !== null && !before) throw new ValidationError(`${at}.id`, "That lesson isn't part of this course.");
      // A newly chosen uploaded file must exist and be finished (W4's media table).
      if (l.videoProvider === "r2" && l.videoRef !== null && !(before?.video_provider === "r2" && before.video_ref === l.videoRef)) {
        await requireMedia(db, l.videoRef, "video", `${at}.videoRef`);
      }
      if (l.captionsKey !== null && l.captionsKey !== before?.captions_key) {
        await requireMedia(db, l.captionsKey, "captions", `${at}.captionsKey`);
      }
    }
  }

  const statements: DbStatement[] = [
    db.prepare("UPDATE lessons SET position = -id, slug = 'tmp-reorder-' || id WHERE course_id = ?").bind(courseId),
    db.prepare("UPDATE modules SET position = -id WHERE course_id = ?").bind(courseId),
  ];
  modules.forEach((m, i) => {
    const position = i + 1;
    statements.push(
      m.id === null
        ? db
            .prepare("INSERT INTO modules (course_id, position, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
            .bind(courseId, position, m.title, now, now)
        : db
            .prepare("UPDATE modules SET position = ?, title = ?, updated_at = ? WHERE id = ? AND course_id = ?")
            .bind(position, m.title, now, m.id, courseId),
    );
  });
  const moduleAt = "(SELECT id FROM modules WHERE course_id = ? AND position = ?)";
  modules.forEach((m, i) => {
    m.lessons.forEach((l, j) => {
      const values: DbValue[] = [
        l.slug,
        l.title,
        l.minutes,
        l.videoProvider,
        l.videoRef,
        l.vertical,
        l.captionsKey,
        l.durationSeconds,
        l.notes,
        l.freePreview,
      ];
      statements.push(
        l.id === null
          ? db
              .prepare(
                "INSERT INTO lessons (course_id, module_id, position, slug, title, minutes, video_provider, video_ref, vertical, " +
                  `captions_key, duration_seconds, notes, free_preview, created_at, updated_at) VALUES (?, ${moduleAt}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .bind(courseId, courseId, i + 1, j + 1, ...values, now, now)
          : db
              .prepare(
                `UPDATE lessons SET module_id = ${moduleAt}, position = ?, slug = ?, title = ?, minutes = ?, video_provider = ?, ` +
                  "video_ref = ?, vertical = ?, captions_key = ?, duration_seconds = ?, notes = ?, free_preview = ?, updated_at = ? " +
                  "WHERE id = ? AND course_id = ?",
              )
              .bind(courseId, i + 1, j + 1, ...values, now, l.id, courseId),
      );
    });
  });
  statements.push(
    db.prepare("DELETE FROM lessons WHERE course_id = ? AND position < 0").bind(courseId),
    db.prepare("DELETE FROM modules WHERE course_id = ? AND position < 0").bind(courseId),
  );
  const keptLessons = modules.reduce((n, m) => n + m.lessons.filter((l) => l.id !== null).length, 0);
  const totalLessons = modules.reduce((n, m) => n + m.lessons.length, 0);
  try {
    await batch(db, [
      ...statements,
      course.status === "published" && bumpContentVersionStatement(db, now),
      auditStatement(db, {
        actor: ADMIN_ACTOR,
        action: "course.outline",
        entity: "course",
        entityId: courseId,
        data: {
          modules: modules.length,
          lessons: totalLessons,
          added: totalLessons - keptLessons,
          removed: ownLessons.size - keptLessons,
        },
        now,
      }),
    ]);
  } catch (err) {
    if (isUniqueViolation(err) || isCheckViolation(err)) throw new ValidationError("modules", "The outline has values that aren't allowed.");
    throw err;
  }
  return getCourse(db, courseId);
}

/** Exposed for the batches module: a course that takes batch bookings. */
export function takesBatches(format: CourseFormat): boolean {
  return format === "in_person" || format === "hybrid";
}
