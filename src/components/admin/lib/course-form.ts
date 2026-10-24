/**
 * The course form: values as typed (strings), the checks the API makes, the body for
 * POST/PUT /api/admin/courses (only the fields that changed), and the publish checklist.
 *
 * Error keys are the API's field names ("pricePaise", "details.faqs[2].a"), so a 400
 * invalid_details from the server lands on the same field as a local check.
 */
import type {
  AdminCourse,
  AdminCourseInput,
  CourseDetails,
  CourseFormat,
  CourseStatus,
  Paise,
} from "../../../shared/types.ts";
import { DEFAULT_ACCESS_DAYS } from "../../../shared/constants.ts";
import { feeLabel, paiseToInput, parseRupees } from "./money.ts";
import { courseSlugProblem, youtubeId } from "./slug.ts";

export const MAX_PRICE_PAISE = 100_000_000;

export interface CourseFormValues {
  slug: string;
  title: string;
  subtitle: string;
  description: string;
  teacher: string;
  format: CourseFormat;
  price: string;
  compareAt: string;
  deposit: string;
  /** "" = no expiry. */
  accessDays: string;
  level: string;
  language: string;
  durationText: string;
  certificateTitle: string;
  seoTitle: string;
  seoDescription: string;
  sortOrder: string;
  isDemo: boolean;
  coverKey: string | null;
  ogImageKey: string | null;
  outcomes: string[];
  forWho: string[];
  highlights: string[];
  faqs: { q: string; a: string }[];
  /** A YouTube link or id, as typed. */
  glimpses: { youtube: string; label: string }[];
}

export const FORMAT_LABELS: Record<CourseFormat, { title: string; hint: string }> = {
  online: { title: "Recorded course", hint: "Video lessons students watch online, any time." },
  in_person: { title: "In-person batches", hint: "Students book a seat in a batch at the academy." },
  hybrid: { title: "Both", hint: "Batches at the academy plus recorded lessons." },
};

export function blankForm(): CourseFormValues {
  return {
    slug: "",
    title: "",
    subtitle: "",
    description: "",
    teacher: "Urmi Mengar",
    format: "online",
    price: "",
    compareAt: "",
    deposit: "",
    accessDays: String(DEFAULT_ACCESS_DAYS),
    level: "",
    language: "",
    durationText: "",
    certificateTitle: "",
    seoTitle: "",
    seoDescription: "",
    sortOrder: "0",
    isDemo: false,
    coverKey: null,
    ogImageKey: null,
    outcomes: [],
    forWho: [],
    highlights: [],
    faqs: [],
    glimpses: [],
  };
}

export function formFromCourse(c: AdminCourse): CourseFormValues {
  return {
    slug: c.slug,
    title: c.title,
    subtitle: c.subtitle ?? "",
    description: c.description ?? "",
    teacher: c.teacher,
    format: c.format,
    price: paiseToInput(c.pricePaise),
    compareAt: paiseToInput(c.compareAtPaise),
    deposit: paiseToInput(c.depositPaise),
    accessDays: c.accessDays === null ? "" : String(c.accessDays),
    level: c.level ?? "",
    language: c.language ?? "",
    durationText: c.durationText ?? "",
    certificateTitle: c.certificateTitle ?? "",
    seoTitle: c.seoTitle ?? "",
    seoDescription: c.seoDescription ?? "",
    sortOrder: String(c.sortOrder),
    isDemo: c.isDemo,
    coverKey: c.coverKey,
    ogImageKey: c.ogImageKey,
    outcomes: [...c.details.outcomes],
    forWho: [...c.details.forWho],
    highlights: [...c.details.highlights],
    faqs: c.details.faqs.map((f) => ({ ...f })),
    glimpses: c.details.glimpses.map((g) => ({ youtube: g.youtubeId, label: g.label })),
  };
}

type Errors = Record<string, string>;

function text(errors: Errors, field: string, value: string, opts: { max: number; required?: string; label: string }): string | null {
  const v = value.trim();
  if (!v) {
    if (opts.required) errors[field] = opts.required;
    return null;
  }
  if (v.length > opts.max) errors[field] = `${opts.label} can be at most ${opts.max.toLocaleString("en-IN")} characters (now ${v.length.toLocaleString("en-IN")}).`;
  return v;
}

function list(errors: Errors, field: string, items: string[], label: string): string[] {
  const out = items.map((s) => s.trim()).filter(Boolean);
  if (out.length > 20) errors[field] = `At most 20 ${label}.`;
  out.forEach((s, i) => {
    if (s.length > 200) errors[`${field}[${i}]`] = `Keep each point under 200 characters (now ${s.length}).`;
  });
  return out;
}

export type FormResult = { ok: true; input: AdminCourseInput } | { ok: false; errors: Errors };

/** Checks the form and builds the full course body. */
export function courseInput(values: CourseFormValues): FormResult {
  const errors: Errors = {};
  const slug = values.slug.trim().toLowerCase();
  const slugProblem = courseSlugProblem(slug);
  if (slugProblem) errors.slug = slugProblem;

  const title = text(errors, "title", values.title, { max: 120, required: "Give the course a title.", label: "The title" }) ?? "";
  const teacher = text(errors, "teacher", values.teacher, { max: 80, required: "Who teaches it?", label: "The teacher's name" }) ?? "";

  const money = (field: string, raw: string, label: string): Paise | null => {
    const r = parseRupees(raw, { max: MAX_PRICE_PAISE });
    if (!r.ok) {
      errors[field] = `${label}: ${r.error}`;
      return null;
    }
    return r.paise;
  };
  const pricePaise = money("pricePaise", values.price, "Fee");
  if (pricePaise !== null && pricePaise !== 0 && pricePaise < 100) errors.pricePaise = "The fee must be 0 (free) or at least ₹1.";
  const compareAtPaise = money("compareAtPaise", values.compareAt, "Old price");
  if (compareAtPaise !== null && !errors.compareAtPaise) {
    if (pricePaise === null) errors.compareAtPaise = "Set the fee first, then the old (crossed-out) price.";
    else if (compareAtPaise <= pricePaise) errors.compareAtPaise = "The old price must be higher than the fee.";
  }
  const depositPaise = values.format === "online" ? null : money("depositPaise", values.deposit, "Booking amount");
  if (depositPaise !== null && !errors.depositPaise) {
    if (depositPaise < 100) errors.depositPaise = "The booking amount must be at least ₹1.";
    else if (pricePaise === null || depositPaise >= pricePaise) errors.depositPaise = "The booking amount must be less than the fee.";
  }

  let accessDays: number | null = null;
  const ad = values.accessDays.trim();
  if (ad) {
    if (!/^\d+$/.test(ad) || Number(ad) < 1 || Number(ad) > 3650) errors.accessDays = "Access is 1 to 3650 days, or empty for no end.";
    else accessDays = Number(ad);
  }

  let sortOrder = 0;
  if (values.sortOrder.trim()) {
    if (!/^-?\d+$/.test(values.sortOrder.trim())) errors.sortOrder = "Use a whole number.";
    else sortOrder = Number(values.sortOrder.trim());
  }

  const faqs: CourseDetails["faqs"] = [];
  values.faqs.forEach((f) => {
    const q = f.q.trim();
    const a = f.a.trim();
    if (!q && !a) return;
    const i = faqs.length;
    if (!q) errors[`details.faqs[${i}].q`] = "Write the question.";
    else if (q.length > 300) errors[`details.faqs[${i}].q`] = "Keep the question under 300 characters.";
    if (!a) errors[`details.faqs[${i}].a`] = "Write the answer.";
    else if (a.length > 3000) errors[`details.faqs[${i}].a`] = "Keep the answer under 3,000 characters.";
    faqs.push({ q, a });
  });
  if (faqs.length > 30) errors["details.faqs"] = "At most 30 questions.";

  const glimpses: CourseDetails["glimpses"] = [];
  values.glimpses.forEach((g) => {
    const raw = g.youtube.trim();
    const label = g.label.trim();
    if (!raw && !label) return;
    const i = glimpses.length;
    const id = youtubeId(raw);
    if (!id) errors[`details.glimpses[${i}].youtubeId`] = "Paste a YouTube link or its 11-character id.";
    if (label.length > 120) errors[`details.glimpses[${i}].label`] = "Keep the label under 120 characters.";
    glimpses.push({ youtubeId: id ?? raw, label });
  });
  if (glimpses.length > 20) errors["details.glimpses"] = "At most 20 glimpses.";

  const details: CourseDetails = {
    outcomes: list(errors, "details.outcomes", values.outcomes, "points"),
    forWho: list(errors, "details.forWho", values.forWho, "points"),
    highlights: list(errors, "details.highlights", values.highlights, "highlights"),
    faqs,
    glimpses,
  };

  const input: AdminCourseInput = {
    slug,
    title,
    subtitle: text(errors, "subtitle", values.subtitle, { max: 300, label: "The one-line description" }),
    description: text(errors, "description", values.description, { max: 20_000, label: "The description" }),
    teacher,
    format: values.format,
    pricePaise,
    compareAtPaise,
    depositPaise,
    level: text(errors, "level", values.level, { max: 60, label: "Level" }),
    language: text(errors, "language", values.language, { max: 80, label: "Language" }),
    durationText: text(errors, "durationText", values.durationText, { max: 60, label: "Duration" }),
    accessDays,
    certificateTitle: text(errors, "certificateTitle", values.certificateTitle, { max: 200, label: "The certificate title" }),
    details,
    coverKey: values.coverKey,
    ogImageKey: values.ogImageKey,
    seoTitle: text(errors, "seoTitle", values.seoTitle, { max: 70, label: "The search title" }),
    seoDescription: text(errors, "seoDescription", values.seoDescription, { max: 170, label: "The search description" }),
    isDemo: values.isDemo,
    sortOrder,
  };
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, input };
}

const INPUT_KEYS: (keyof AdminCourseInput)[] = [
  "slug",
  "title",
  "subtitle",
  "description",
  "teacher",
  "format",
  "pricePaise",
  "compareAtPaise",
  "depositPaise",
  "level",
  "language",
  "durationText",
  "accessDays",
  "certificateTitle",
  "details",
  "coverKey",
  "ogImageKey",
  "seoTitle",
  "seoDescription",
  "isDemo",
  "sortOrder",
];

/** JSON with object keys sorted, so two equal values always compare equal. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** Only the fields of `input` that differ from the saved course (the API leaves the rest alone). */
export function changedFields(saved: AdminCourse, input: AdminCourseInput): Partial<AdminCourseInput> {
  const out: Partial<AdminCourseInput> = {};
  for (const key of INPUT_KEYS) {
    if (stableJson(saved[key]) !== stableJson(input[key])) (out as Record<string, unknown>)[key] = input[key];
  }
  return out;
}

export interface ChecklistItem {
  key: "fee" | "slug" | "content" | "cover" | "domain";
  label: string;
  done: boolean;
  /** Required to publish (the others are recommended). */
  required: boolean;
  /** Where to fix it in the editor. */
  anchor: string;
}

/** What publishing needs (the API's rules), plus two recommended steps. */
export function publishChecklist(c: Pick<AdminCourse, "pricePaise" | "slug" | "format" | "modules" | "batches" | "coverKey" | "domainStatus">): ChecklistItem[] {
  const lessons = c.modules.reduce((n, m) => n + m.lessons.length, 0);
  const openBatches = c.batches.filter((b) => b.status === "open").length;
  const contentLabel =
    c.format === "online" ? "At least one lesson" : c.format === "in_person" ? "At least one open batch" : "A lesson or an open batch";
  const content = c.format === "online" ? lessons > 0 : c.format === "in_person" ? openBatches > 0 : lessons > 0 || openBatches > 0;
  return [
    { key: "fee", label: c.pricePaise === null ? "Set the fee" : `Fee: ${feeLabel(c.pricePaise)}`, done: c.pricePaise !== null, required: true, anchor: "sec-fee" },
    { key: "slug", label: "A valid web address", done: courseSlugProblem(c.slug) === null, required: true, anchor: "sec-address" },
    { key: "content", label: contentLabel, done: content, required: true, anchor: c.format === "in_person" ? "sec-batches" : "sec-outline" },
    { key: "cover", label: "A cover photo", done: c.coverKey !== null, required: false, anchor: "sec-images" },
    { key: "domain", label: "Its own subdomain is live", done: c.domainStatus === "active", required: false, anchor: "sec-address" },
  ];
}

/** True when every required checklist item is done. */
export function canPublish(items: ChecklistItem[]): boolean {
  return items.every((i) => !i.required || i.done);
}

export const STATUS_LABELS: Record<CourseStatus, string> = { draft: "Draft", published: "Published", archived: "Archived" };

/** Field → element id in the editor (for errors and the summary links). */
export function fieldId(field: string): string {
  return `f-${field.replace(/[^A-Za-z0-9]+/g, "-").replace(/-+$/, "")}`;
}
