/**
 * The admin demo's data: a small typed store in the browser's localStorage.
 *
 * DEMO ONLY. Nothing here talks to a server. Two kinds of data:
 * - Saved: courses and coupons. Seeded once (the main course from src/data/course.ts is always
 *   first), then changed by the admin screens and kept in localStorage on this device only.
 * - Activity: students, test payments and daily visitors. Example numbers, generated from the
 *   date with a fixed seed, so a day's numbers never change between page views and the last 30
 *   days always end today. They are never saved.
 *
 * Every read and write of browser storage is wrapped in try/catch: in a private window or with
 * storage blocked, the demo still works on the current page (in memory) and says so.
 */
import { course as mainCourse } from "../data/course";

export const STORE_KEY = "fbc-admin-demo-v1";
export const SESSION_KEY = "fbc-admin-demo-session";

// ── Types ─────────────────────────────────────────────────────────────

export type CourseStatus = "draft" | "published";

export interface Lesson {
  id: string;
  title: string;
  minutes: number;
  /** A YouTube link (often an unlisted video). May be empty while the course is a draft. */
  youtube: string;
}

export interface Module {
  id: string;
  title: string;
  lessons: Lesson[];
}

/** A glimpse from course.ts (by YouTube id) or a photo uploaded in the editor (a data: URL). */
export type Cover = { kind: "glimpse"; id: string } | { kind: "upload"; dataUrl: string };

export interface Course {
  id: string;
  title: string;
  subtitle: string;
  /** Rupees, whole number. */
  price: number;
  level: string;
  language: string;
  cover: Cover;
  outcomes: string[];
  modules: Module[];
  status: CourseStatus;
  /** The course on the landing page (/), seeded from src/data/course.ts. */
  main: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Coupon {
  id: string;
  code: string;
  percent: number;
  /** Last day the code works, YYYY-MM-DD, or null for no expiry. */
  expires: string | null;
  /** Most times the code can be used, or null for no limit. */
  limit: number | null;
  active: boolean;
  createdAt: string;
}

export type PaymentMethod = "UPI" | "Card";
export type PaymentStatus = "paid" | "failed";

export interface Payment {
  id: string;
  studentId: string | null;
  studentName: string;
  courseId: string;
  amount: number;
  method: PaymentMethod;
  status: PaymentStatus;
  at: string;
  coupon: string | null;
}

export interface Student {
  id: string;
  name: string;
  phone: string;
  city: string;
  courseId: string;
  enrolledOn: string;
  lastActive: string;
  lessonsDone: number;
  lessonsTotal: number;
  progress: number;
  paymentId: string;
  amount: number;
  method: PaymentMethod;
  coupon: string | null;
}

export interface Day {
  /** YYYY-MM-DD, local time. */
  date: string;
  visitors: number;
  enrollments: number;
  revenue: number;
}

export interface Activity {
  days: Day[];
  payments: Payment[];
  students: Student[];
}

interface Saved {
  v: 1;
  courses: Course[];
  coupons: Coupon[];
}

export type SaveResult = { ok: true } | { ok: false; reason: "quota" | "blocked" };

// ── Small helpers ────────────────────────────────────────────────────

export const MAIN_COURSE_ID = mainCourse.slug;
export const MAIN_PRICE = Math.round(mainCourse.price.amount / 100);
export const LEVELS = ["Beginner", "Beginner to confident", "Intermediate", "Advanced", "Professional"] as const;
export const LANGUAGES = [
  "Hindi",
  "Gujarati",
  "English",
  "Hindi and Gujarati",
  "Hindi and Gujarati, with English terms",
] as const;

export function uid(prefix = ""): string {
  let rand = "";
  try {
    rand = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  } catch {
    rand = Math.random().toString(36).slice(2, 12);
  }
  return `${prefix}${rand}`;
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "course"
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar date as YYYY-MM-DD. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Midnight (local) of a YYYY-MM-DD date. */
export function fromYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

export const lessonTotal = (c: Pick<Course, "modules">) => c.modules.reduce((n, m) => n + m.lessons.length, 0);
export const minuteTotal = (c: Pick<Course, "modules">) =>
  c.modules.reduce((n, m) => n + m.lessons.reduce((s, l) => s + (Number.isFinite(l.minutes) ? l.minutes : 0), 0), 0);

// ── Seed ─────────────────────────────────────────────────────────────

function seedCourses(now: string): Course[] {
  const main: Course = {
    id: MAIN_COURSE_ID,
    title: mainCourse.title,
    subtitle: mainCourse.subtitle,
    price: MAIN_PRICE,
    level: mainCourse.level,
    language: mainCourse.language,
    cover: { kind: "glimpse", id: mainCourse.glimpses[3]?.id ?? mainCourse.glimpses[0].id },
    outcomes: [...mainCourse.outcomes],
    modules: mainCourse.modules.map((m, mi) => ({
      id: `m${mi + 1}`,
      title: m.title,
      lessons: m.lessons.map((l, li) => ({ id: `m${mi + 1}l${li + 1}`, title: l.title, minutes: l.minutes, youtube: "" })),
    })),
    status: "published",
    main: true,
    createdAt: now,
    updatedAt: now,
  };

  // An example draft, so the list shows both states. Never shown publicly while it is a draft.
  const draft: Course = {
    id: "party-hairstyles-demo",
    title: "Quick party hairstyles",
    subtitle: "Three easy hairstyles for functions, done on your own hair in front of a mirror.",
    price: 999,
    level: "Beginner",
    language: "Hindi and Gujarati",
    cover: { kind: "glimpse", id: mainCourse.glimpses[2]?.id ?? mainCourse.glimpses[0].id },
    outcomes: ["Prep hair so a style holds all evening", "Do a soft open-hair look, a bun and a braid"],
    modules: [
      {
        id: "d1",
        title: "Tools and prep",
        lessons: [
          { id: "d1l1", title: "Brushes, pins and sprays you need", minutes: 5, youtube: "" },
          { id: "d1l2", title: "Prep for volume and hold", minutes: 7, youtube: "" },
        ],
      },
      {
        id: "d2",
        title: "Three easy styles",
        lessons: [
          { id: "d2l1", title: "Soft open-hair curls", minutes: 9, youtube: "" },
          { id: "d2l2", title: "The quick low bun", minutes: 8, youtube: "" },
        ],
      },
    ],
    status: "draft",
    main: false,
    createdAt: now,
    updatedAt: now,
  };
  return [main, draft];
}

function seedCoupons(today: Date, now: string): Coupon[] {
  const endOfNextMonth = new Date(today.getFullYear(), today.getMonth() + 2, 0);
  return [
    { id: "cp_insta10", code: "INSTA10", percent: 10, expires: null, limit: null, active: true, createdAt: now },
    { id: "cp_reel15", code: "REEL15", percent: 15, expires: ymd(endOfNextMonth), limit: 100, active: true, createdAt: now },
    { id: "cp_bride20", code: "BRIDE20", percent: 20, expires: null, limit: 50, active: false, createdAt: now },
  ];
}

function seed(): Saved {
  const today = new Date();
  const now = today.toISOString();
  return { v: 1, courses: seedCourses(now), coupons: seedCoupons(today, now) };
}

// ── Load and save ────────────────────────────────────────────────────

let memory: Saved | null = null;
let storageBlocked = false;

function isSaved(x: unknown): x is Saved {
  if (!x || typeof x !== "object") return false;
  const s = x as Partial<Saved>;
  return s.v === 1 && Array.isArray(s.courses) && Array.isArray(s.coupons);
}

function load(): Saved {
  if (memory) return memory;
  let saved: Saved | null = null;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORE_KEY);
  } catch {
    storageBlocked = true;
  }
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isSaved(parsed)) saved = parsed;
    } catch {
      /* unreadable: start again from the seed */
    }
  }
  if (!saved) {
    saved = seed();
    // Keep the seed, so the dates in it stay the same from page to page.
    write(saved);
  }
  // The main course is always there and always first.
  if (!saved.courses.some((c) => c.main)) saved.courses.unshift(seedCourses(new Date().toISOString())[0]);
  memory = saved;
  return saved;
}

function write(next: Saved): SaveResult {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
    memory = next;
    return { ok: true };
  } catch (e) {
    const name = e instanceof DOMException ? e.name : "";
    // Full: nothing changes, so the screen never shows what wasn't kept.
    if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") return { ok: false, reason: "quota" };
    // Blocked: keep it in memory, so the demo still works on this page.
    memory = next;
    storageBlocked = true;
    return { ok: false, reason: "blocked" };
  }
}

/** True when the browser blocks storage: changes then last only until the page is left. */
export function storageIsBlocked(): boolean {
  load();
  if (!storageBlocked) return false;
  // Check again with a real write before saying so.
  try {
    localStorage.setItem(`${STORE_KEY}-probe`, "1");
    localStorage.removeItem(`${STORE_KEY}-probe`);
    storageBlocked = false;
  } catch {
    /* really blocked */
  }
  return storageBlocked;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

// ── Courses ──────────────────────────────────────────────────────────

/** All courses: the main course first, then the newest. */
export function getCourses(): Course[] {
  const list = clone(load().courses);
  return list.sort((a, b) => Number(b.main) - Number(a.main) || b.createdAt.localeCompare(a.createdAt));
}

export function getCourse(id: string): Course | null {
  return getCourses().find((c) => c.id === id) ?? null;
}

/** Published courses for the catalog, main course first. */
export function getPublishedCourses(): Course[] {
  return getCourses().filter((c) => c.status === "published");
}

export function newCourseId(title: string): string {
  const taken = new Set(load().courses.map((c) => c.id));
  const base = slugify(title);
  let id = `${base}-${uid().slice(0, 4)}`;
  while (taken.has(id)) id = `${base}-${uid().slice(0, 4)}`;
  return id;
}

export function blankCourse(): Course {
  const now = new Date().toISOString();
  return {
    id: "",
    title: "",
    subtitle: "",
    price: 0,
    level: "Beginner",
    language: "Hindi and Gujarati",
    cover: { kind: "glimpse", id: mainCourse.glimpses[0].id },
    outcomes: [""],
    modules: [{ id: uid("m"), title: "", lessons: [{ id: uid("l"), title: "", minutes: 10, youtube: "" }] }],
    status: "draft",
    main: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function saveCourse(course: Course): SaveResult {
  const state = clone(load());
  const next: Course = { ...clone(course), updatedAt: new Date().toISOString() };
  const i = state.courses.findIndex((c) => c.id === next.id);
  if (i === -1) state.courses.push(next);
  else state.courses[i] = next;
  return write(state);
}

export function deleteCourse(id: string): SaveResult {
  const state = clone(load());
  state.courses = state.courses.filter((c) => c.id !== id || c.main);
  return write(state);
}

// ── Coupons ──────────────────────────────────────────────────────────

export function getCoupons(): Coupon[] {
  return clone(load().coupons).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function saveCoupon(coupon: Coupon): SaveResult {
  const state = clone(load());
  const i = state.coupons.findIndex((c) => c.id === coupon.id);
  if (i === -1) state.coupons.push(clone(coupon));
  else state.coupons[i] = clone(coupon);
  return write(state);
}

export function deleteCoupon(id: string): SaveResult {
  const state = clone(load());
  state.coupons = state.coupons.filter((c) => c.id !== id);
  return write(state);
}

// ── Reset ────────────────────────────────────────────────────────────

/** Back to the seed: removes every course and coupon made in the demo. */
export function resetDemo(): SaveResult {
  memory = null;
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* blocked: the fresh seed below lives in memory only */
  }
  return write(seed());
}

// ── Demo sign-in (sessionStorage) ────────────────────────────────────

export function isSignedIn(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) === "1";
  } catch {
    return true; // storage blocked: don't lock the demo
  }
}

export function signIn(): void {
  try {
    sessionStorage.setItem(SESSION_KEY, "1");
  } catch {
    /* blocked: the guard lets the demo through anyway */
  }
}

export function signOut(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* nothing to clear */
  }
}

// ── Activity: example students, payments and visitors ───────────────

const FIRST = [
  "Aarti", "Avni", "Bansari", "Bhavna", "Charmi", "Darshana", "Dhruvi", "Drashti", "Foram", "Grishma",
  "Heer", "Hetal", "Hiral", "Isha", "Janvi", "Jinal", "Kavya", "Khushi", "Kinjal", "Komal",
  "Krupa", "Mansi", "Megha", "Mitali", "Nidhi", "Nisha", "Payal", "Pooja", "Priya", "Riddhi",
  "Riya", "Sejal", "Shruti", "Sneha", "Tanvi", "Twinkle", "Urvashi", "Vaishali", "Yesha", "Zeel",
];
const LAST = [
  "Acharya", "Bhatt", "Chauhan", "Dave", "Desai", "Dholakia", "Gohil", "Jadeja", "Jani", "Joshi",
  "Kansara", "Kothari", "Mehta", "Mistry", "Modi", "Nanda", "Pandya", "Parmar", "Patel", "Raval",
  "Rathod", "Shah", "Sheth", "Solanki", "Thakkar", "Trivedi", "Vora", "Vyas",
];
const CITIES = [
  "Jamnagar", "Jamnagar", "Jamnagar", "Jamnagar", "Rajkot", "Rajkot", "Ahmedabad", "Surat",
  "Vadodara", "Bhavnagar", "Junagadh", "Dwarka", "Porbandar", "Mumbai",
];
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** FNV-1a, for a stable seed per date. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, deterministic. */
function prng(seedValue: number): () => number {
  let a = seedValue;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)];
const SEEDED_CODES = [
  { code: "INSTA10", percent: 10, weight: 0.5, since: 70 },
  { code: "REEL15", percent: 15, weight: 0.32, since: 70 },
  { code: "BRIDE20", percent: 20, weight: 0.18, since: 70, until: 24 },
];

const WINDOW = 70; // days of history: this month and all of last month
let cache: { key: string; value: Activity } | null = null;

/** The example activity for the last 70 days, ending now. Same day, same numbers. */
export function getActivity(now = new Date()): Activity {
  const key = `${ymd(now)}-${now.getHours()}`;
  if (cache && cache.key === key) return cache.value;

  const lessonsTotal = mainCourse.modules.reduce((n, m) => n + m.lessons.length, 0);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days: Day[] = [];
  const payments: Payment[] = [];
  const students: Student[] = [];

  for (let back = WINDOW - 1; back >= 0; back--) {
    const date = addDays(today, -back);
    const dateKey = ymd(date);
    const r = prng(hash(`fbc-demo-${dateKey}`));
    const weekday = date.getDay();
    const weekFactor = weekday === 0 ? 1.25 : weekday === 6 ? 1.15 : weekday === 5 ? 1.05 : 0.95;
    const reelDay = r() < 0.13 ? 1.9 : 1;
    const visitors = Math.round((46 + r() * 40) * weekFactor * reelDay);
    const rate = 0.011 + r() * 0.016;
    const sales = Math.floor(visitors * rate + r());
    const failedToday = r() < 0.2 ? 1 : 0;

    let revenue = 0;
    let enrollments = 0;
    for (let k = 0; k < sales + failedToday; k++) {
      const failed = k >= sales;
      const at = new Date(date);
      at.setHours(8 + Math.floor(r() * 15), Math.floor(r() * 60), Math.floor(r() * 60));
      const name = `${pick(r, FIRST)} ${pick(r, LAST)}`;
      const method: PaymentMethod = r() < 0.72 ? "UPI" : "Card";
      let id = "pay_";
      for (let c = 0; c < 14; c++) id += ALNUM[Math.floor(r() * ALNUM.length)];
      let couponCode: string | null = null;
      let percent = 0;
      if (r() < 0.38) {
        const eligible = SEEDED_CODES.filter((c) => back < c.since && (c.until === undefined || back >= c.until));
        let roll = r() * eligible.reduce((s, c) => s + c.weight, 0);
        for (const c of eligible) {
          roll -= c.weight;
          if (roll <= 0) {
            couponCode = c.code;
            percent = c.percent;
            break;
          }
        }
      }
      const amount = Math.round(MAIN_PRICE * (1 - percent / 100));
      const phone = `${pick(r, ["9", "8", "7", "6"])}${Array.from({ length: 9 }, () => Math.floor(r() * 10)).join("")}`;
      const city = pick(r, CITIES);
      const engagement = r();
      // Payments later today haven't happened yet.
      if (at.getTime() > now.getTime()) continue;

      const studentId = failed ? null : `stu_${id.slice(4)}`;
      payments.push({
        id,
        studentId,
        studentName: name,
        courseId: MAIN_COURSE_ID,
        amount,
        method,
        status: failed ? "failed" : "paid",
        at: at.toISOString(),
        coupon: failed ? null : couponCode,
      });
      if (failed) continue;

      revenue += amount;
      enrollments++;
      const daysSince = back;
      const lessonsDone = engagement < 0.12 ? 0 : Math.min(lessonsTotal, Math.floor(daysSince * engagement * 0.55 + (engagement > 0.5 ? 1 : 0)));
      const lastActive = lessonsDone === 0 ? at : addDays(date, Math.min(daysSince, Math.max(0, Math.round(lessonsDone / Math.max(engagement, 0.2)))));
      students.push({
        id: studentId as string,
        name,
        phone,
        city,
        courseId: MAIN_COURSE_ID,
        enrolledOn: at.toISOString(),
        lastActive: (lastActive.getTime() > now.getTime() ? now : lastActive).toISOString(),
        lessonsDone,
        lessonsTotal,
        progress: Math.round((lessonsDone / lessonsTotal) * 100),
        paymentId: id,
        amount,
        method,
        coupon: couponCode,
      });
    }
    days.push({ date: dateKey, visitors, enrollments, revenue });
  }

  payments.sort((a, b) => b.at.localeCompare(a.at));
  students.sort((a, b) => b.enrolledOn.localeCompare(a.enrolledOn));
  const value = { days, payments, students };
  cache = { key, value };
  return value;
}

/** Times each code was used in the example payments (all of the demo history). */
export function couponUses(code: string, payments = getActivity().payments): number {
  return payments.filter((p) => p.status === "paid" && p.coupon === code).length;
}

/** Students per course id, from the example activity. */
export function studentCounts(students = getActivity().students): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of students) counts.set(s.courseId, (counts.get(s.courseId) ?? 0) + 1);
  return counts;
}
