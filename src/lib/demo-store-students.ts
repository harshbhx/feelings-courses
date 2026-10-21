/**
 * Students and test payments for the admin demo's Students and Payments screens.
 *
 * DEMO ONLY. Everything here is derived from getActivity() in demo-store.ts, so these two screens
 * show the same people, payment ids, amounts and dates as the dashboard. On top of that example
 * activity this file adds what the two screens need, the same way every time (same payment id,
 * same answer):
 * - Razorpay's words for a payment's state: "paid" is shown as "captured", "failed" stays
 *   "failed" (with a reason in plain words), and two older captured payments are shown as
 *   "refunded".
 * - Methods: some older card payments are shown as netbanking, with a bank name; cards get the
 *   network and the last digits of a Razorpay test card.
 * Only payments outside the dashboard's windows (older than 30 days and from before this month)
 * are changed, so the dashboard's revenue, sales chart and recent payments still agree.
 *
 * Nothing is saved: these screens keep no localStorage key of their own.
 */
import { course as mainCourse } from "../data/course";
import { getActivity, getCourses, type Course, type Payment, type Student } from "./demo-store";

// ── Types ─────────────────────────────────────────────────────────────

export type TxnStatus = "captured" | "failed" | "refunded";
export type TxnMethod = "UPI" | "Card" | "Netbanking";

/** A test transaction, as the Payments screen shows it. */
export interface Txn {
  /** Razorpay-style payment id: pay_ and 14 letters or digits. */
  id: string;
  studentId: string | null;
  studentName: string;
  courseId: string;
  courseTitle: string;
  /** Rupees, whole number. */
  amount: number;
  method: TxnMethod;
  /** "Visa ··1111", "HDFC Bank", or "" for UPI. */
  methodDetail: string;
  status: TxnStatus;
  /** ISO date and time. */
  at: string;
  coupon: string | null;
  /** Failed payments: why, in plain words. */
  reason: string | null;
  /** Refunded payments: when (ISO). */
  refundedAt: string | null;
}

/** Not started (0%), in progress, or finished (100%). */
export type ProgressBand = "none" | "some" | "done";

export const PROGRESS_LABELS: Record<ProgressBand, string> = {
  none: "Not started",
  some: "In progress",
  done: "Finished",
};

export const STATUS_LABELS: Record<TxnStatus, string> = {
  captured: "Captured",
  failed: "Failed",
  refunded: "Refunded",
};

export const METHOD_LABELS: Record<TxnMethod, string> = {
  UPI: "UPI",
  Card: "Card",
  Netbanking: "Netbanking",
};

export interface StudentRow extends Student {
  courseTitle: string;
  band: ProgressBand;
  /** True when the student's payment was refunded. */
  refunded: boolean;
  /** The student's payments, newest first. */
  payments: Txn[];
}

export interface LessonState {
  title: string;
  minutes: number;
  done: boolean;
}

export interface ModuleState {
  title: string;
  lessons: LessonState[];
  done: number;
}

export interface Totals {
  month: { amount: number; count: number; label: string };
  all: { amount: number; count: number; since: string | null };
  refunded: { amount: number; count: number };
  failed: number;
}

export interface StudentSummary {
  total: number;
  thisMonth: number;
  activeWeek: number;
  finished: number;
  notStarted: number;
}

// ── Helpers ───────────────────────────────────────────────────────────

const DAY = 86_400_000;

/** FNV-1a: a stable number per payment id. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);

export function progressBand(progress: number): ProgressBand {
  if (progress <= 0) return "none";
  if (progress >= 100) return "done";
  return "some";
}

function courseTitles(): Map<string, string> {
  const titles = new Map<string, string>();
  for (const c of getCourses()) titles.set(c.id, c.title);
  return titles;
}

// ── Transactions ──────────────────────────────────────────────────────

const BANKS = ["HDFC Bank", "State Bank of India", "ICICI Bank", "Bank of Baroda", "Axis Bank", "Kotak Mahindra Bank"];
// Razorpay's published test cards, so nothing here looks like a real card.
const CARDS = ["Visa ··1111", "Mastercard ··5449"];
const REASONS: Record<TxnMethod, string[]> = {
  UPI: ["The UPI request expired before it was approved", "Cancelled in the UPI app", "Wrong UPI PIN entered"],
  Card: ["Declined by the bank", "The OTP wasn't entered in time", "Cancelled at the payment screen"],
  Netbanking: ["Cancelled on the bank's page", "The bank's page timed out"],
};
const REFUNDS = 2;

/**
 * Payments before this moment may be re-dressed (netbanking, refunds): it is before both the
 * dashboard's 30-day chart and this month, so the dashboard's numbers stay the same.
 */
function settledBefore(now: Date): number {
  return Math.min(startOfMonth(now).getTime(), startOfDay(now).getTime() - 30 * DAY);
}

function toTxn(p: Payment, titles: Map<string, string>, settled: number): Txn {
  const r = hash(p.id);
  const old = new Date(p.at).getTime() < settled;
  let method = p.method as TxnMethod;
  if (old && method === "Card" && r % 5 < 2) method = "Netbanking";
  const methodDetail =
    method === "Card" ? CARDS[r % CARDS.length] : method === "Netbanking" ? BANKS[(r >>> 3) % BANKS.length] : "";
  const failed = p.status === "failed";
  return {
    id: p.id,
    studentId: p.studentId,
    studentName: p.studentName,
    courseId: p.courseId,
    courseTitle: titles.get(p.courseId) ?? mainCourse.title,
    amount: p.amount,
    method,
    methodDetail,
    status: failed ? "failed" : "captured",
    at: p.at,
    coupon: p.coupon,
    reason: failed ? REASONS[method][(r >>> 5) % REASONS[method].length] : null,
    refundedAt: null,
  };
}

let txnCache: { key: string; value: Txn[] } | null = null;

/** Every example test transaction, newest first. */
export function getTxns(now = new Date()): Txn[] {
  const activity = getActivity(now);
  const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${activity.payments.length}`;
  if (txnCache && txnCache.key === key) return txnCache.value;

  const titles = courseTitles();
  const settled = settledBefore(now);
  const txns = activity.payments.map((p) => toTxn(p, titles, settled));

  // Two older captured payments, without a coupon (so coupon counts stay the same), were refunded
  // a few days after they came in. Picked by id, so the same two every time.
  const candidates = txns
    .filter((t) => t.status === "captured" && !t.coupon && new Date(t.at).getTime() < settled)
    .sort((a, b) => hash(a.id) - hash(b.id))
    .slice(0, REFUNDS);
  for (const t of candidates) {
    const at = new Date(t.at);
    const refunded = new Date(at.getTime() + (2 + (hash(t.id) % 5)) * DAY);
    refunded.setHours(11, hash(t.id) % 60, 0, 0);
    t.status = "refunded";
    t.refundedAt = refunded.toISOString();
  }

  txnCache = { key, value: txns };
  return txns;
}

/** Totals for the Payments screen. Refunded and failed payments are not counted as collected. */
export function txnTotals(txns: Txn[], now = new Date()): Totals {
  const month = startOfMonth(now).getTime();
  const captured = txns.filter((t) => t.status === "captured");
  const thisMonth = captured.filter((t) => new Date(t.at).getTime() >= month);
  const refunded = txns.filter((t) => t.status === "refunded");
  const oldest = txns.length ? txns.reduce((a, b) => (a.at < b.at ? a : b)).at : null;
  return {
    month: {
      amount: thisMonth.reduce((s, t) => s + t.amount, 0),
      count: thisMonth.length,
      label: now.toLocaleDateString("en-IN", { month: "long" }),
    },
    all: { amount: captured.reduce((s, t) => s + t.amount, 0), count: captured.length, since: oldest },
    refunded: { amount: refunded.reduce((s, t) => s + t.amount, 0), count: refunded.length },
    failed: txns.filter((t) => t.status === "failed").length,
  };
}

// ── Students ──────────────────────────────────────────────────────────

let studentCache: { key: string; value: StudentRow[] } | null = null;

/** Every example student, newest enrolment first. */
export function getStudentRows(now = new Date()): StudentRow[] {
  const activity = getActivity(now);
  const txns = getTxns(now);
  const key = `${txnCache?.key ?? ""}-${activity.students.length}`;
  if (studentCache && studentCache.key === key) return studentCache.value;

  const titles = courseTitles();
  const byStudent = new Map<string, Txn[]>();
  for (const t of txns) {
    if (!t.studentId) continue;
    const list = byStudent.get(t.studentId) ?? [];
    list.push(t);
    byStudent.set(t.studentId, list);
  }

  const rows = activity.students.map((s): StudentRow => {
    const payments = byStudent.get(s.id) ?? [];
    return {
      ...s,
      courseTitle: titles.get(s.courseId) ?? mainCourse.title,
      band: progressBand(s.progress),
      refunded: payments.some((p) => p.id === s.paymentId && p.status === "refunded"),
      payments,
    };
  });

  studentCache = { key, value: rows };
  return rows;
}

export function studentSummary(rows: StudentRow[], now = new Date()): StudentSummary {
  const month = startOfMonth(now).getTime();
  const week = now.getTime() - 7 * DAY;
  return {
    total: rows.length,
    thisMonth: rows.filter((s) => new Date(s.enrolledOn).getTime() >= month).length,
    activeWeek: rows.filter((s) => s.lessonsDone > 0 && new Date(s.lastActive).getTime() >= week).length,
    finished: rows.filter((s) => s.band === "done").length,
    notStarted: rows.filter((s) => s.band === "none").length,
  };
}

/** Courses a student can be filtered by: every published course, and any course with students. */
export function courseOptions(rows: StudentRow[]): { id: string; title: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const s of rows) counts.set(s.courseId, (counts.get(s.courseId) ?? 0) + 1);
  const courses: Pick<Course, "id" | "title" | "status">[] = getCourses();
  const options = courses
    .filter((c) => c.status === "published" || counts.has(c.id))
    .map((c) => ({ id: c.id, title: c.title, count: counts.get(c.id) ?? 0 }));
  for (const [id, count] of counts) {
    if (!options.some((o) => o.id === id)) options.push({ id, title: rows.find((s) => s.courseId === id)?.courseTitle ?? id, count });
  }
  return options;
}

/**
 * The student's course, module by module, with the lessons they have done ticked. Students work
 * through the lessons in order, so the first `lessonsDone` lessons are the done ones.
 */
export function lessonStates(student: Pick<Student, "courseId" | "lessonsDone">): ModuleState[] {
  const saved = getCourses().find((c) => c.id === student.courseId);
  const modules = saved
    ? saved.modules.map((m) => ({ title: m.title, lessons: m.lessons.map((l) => ({ title: l.title, minutes: l.minutes })) }))
    : mainCourse.modules.map((m) => ({ title: m.title, lessons: m.lessons.map((l) => ({ title: l.title, minutes: l.minutes })) }));
  let left = student.lessonsDone;
  return modules.map((m) => {
    const lessons = m.lessons.map((l) => {
      const done = left > 0;
      if (done) left--;
      return { title: l.title || "Untitled lesson", minutes: l.minutes, done };
    });
    return { title: m.title || "Untitled module", lessons, done: lessons.filter((l) => l.done).length };
  });
}
