/**
 * Coupons for the admin demo: the fields the Coupons screen adds, two more example codes, each
 * code's uses and revenue, and the form's checks.
 *
 * DEMO ONLY. Coupons are saved by src/lib/demo-store.ts (getCoupons, saveCoupon, deleteCoupon;
 * localStorage key "fbc-admin-demo-v1"). This file adds:
 * - Three optional fields on a saved coupon: `kind` ("percent" or "flat"), `amount` (rupees off,
 *   flat codes only) and `courseId` (null means every course). A coupon saved without them is a
 *   percent code for every course, so the seed in demo-store.ts reads correctly. A flat code saves
 *   `percent: 0`.
 * - Two more example codes, LAUNCH500 and REEL3, added once to the saved coupons (flag key
 *   COUPON_SEED_KEY). LAUNCH500 ended before the 70 days of example payments, so its uses are a
 *   fixed example number; REEL3 is brand new and has no sales yet.
 * - Uses and revenue per code, from the example payments in getActivity(), so they agree with the
 *   Dashboard and Payments screens.
 */
import {
  MAIN_COURSE_ID,
  MAIN_PRICE,
  addDays,
  getActivity,
  getCoupons,
  saveCoupon,
  ymd,
  type Coupon,
  type Course,
  type Payment,
} from "./demo-store";

/** Set once the extra example codes have been added. Settings' "Reset demo data" clears it. */
export const COUPON_SEED_KEY = "fbc-admin-demo-coupons-v1";

export const CODE_MIN = 3;
export const CODE_MAX = 15;
export const PERCENT_MIN = 1;
export const PERCENT_MAX = 90;
export const LIMIT_MAX = 100000;

export type DiscountKind = "percent" | "flat";

export interface CouponPlus extends Coupon {
  kind: DiscountKind;
  /** Rupees off, for a flat code. 0 for a percent code. */
  amount: number;
  /** The one course the code works on, or null for every course. */
  courseId: string | null;
}

export interface CouponStats {
  uses: number;
  /** What buyers paid with the code, in rupees. */
  revenue: number;
  /** ISO time of the last sale with the code, if known. */
  lastUsed: string | null;
}

export type CouponState = "on" | "off" | "expired" | "used-up";

// ── Reading ──────────────────────────────────────────────────────────

/** A saved coupon with the Coupons screen's fields filled in. */
export function withDefaults(c: Coupon & Partial<Pick<CouponPlus, "kind" | "amount" | "courseId">>): CouponPlus {
  const kind: DiscountKind = c.kind === "flat" ? "flat" : "percent";
  const amount = kind === "flat" && typeof c.amount === "number" && Number.isFinite(c.amount) ? Math.max(0, Math.round(c.amount)) : 0;
  return {
    ...c,
    kind,
    amount,
    percent: kind === "percent" ? c.percent : 0,
    courseId: typeof c.courseId === "string" && c.courseId ? c.courseId : null,
  };
}

/** Every coupon, newest first, with the extra example codes added on first use. */
export function getCouponList(): CouponPlus[] {
  ensureExtraSeeds();
  return getCoupons().map(withDefaults);
}

// ── The two extra example codes ──────────────────────────────────────

interface ExtraSeed {
  coupon: CouponPlus;
  /** Example uses, shown only while the example payments have none for this code. */
  uses: number;
  lastUsed: string | null;
}

function extraSeeds(now = new Date()): ExtraSeed[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const at = (days: number, hour = 11) => {
    const d = addDays(today, days);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  return [
    {
      // An old launch offer: ended before the example payments start, so it can't be in them.
      coupon: {
        id: "cp_launch500",
        code: "LAUNCH500",
        kind: "flat",
        amount: 500,
        percent: 0,
        courseId: null,
        expires: ymd(addDays(today, -75)),
        limit: 30,
        active: true,
        createdAt: at(-100),
      },
      uses: 26,
      lastUsed: at(-76, 19),
    },
    {
      // Made two days ago for the next reel: no sales yet.
      coupon: {
        id: "cp_reel3",
        code: "REEL3",
        kind: "flat",
        amount: 300,
        percent: 0,
        courseId: MAIN_COURSE_ID,
        expires: ymd(addDays(today, 30)),
        limit: 50,
        active: true,
        createdAt: at(-2, 18),
      },
      uses: 0,
      lastUsed: null,
    },
  ];
}

let seededInMemory = false;

/** Adds LAUNCH500 and REEL3 once. Deleting them later is respected. */
export function ensureExtraSeeds(): void {
  let done = seededInMemory;
  try {
    done = done || localStorage.getItem(COUPON_SEED_KEY) === "1";
  } catch {
    /* storage blocked: remember in memory for this page */
  }
  if (done) return;
  const saved = getCoupons();
  const codes = new Set(saved.map((c) => c.code));
  const ids = new Set(saved.map((c) => c.id));
  for (const seed of extraSeeds()) {
    if (!codes.has(seed.coupon.code) && !ids.has(seed.coupon.id)) saveCoupon(seed.coupon);
  }
  seededInMemory = true;
  try {
    localStorage.setItem(COUPON_SEED_KEY, "1");
  } catch {
    /* blocked: the in-memory flag above covers this page */
  }
}

// ── Money ────────────────────────────────────────────────────────────

const inrFormat = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const inr = (rupees: number) => inrFormat.format(rupees);

/** "10% off", "₹300 off" */
export function discountLabel(c: Pick<CouponPlus, "kind" | "percent" | "amount">): string {
  return c.kind === "flat" ? `${inr(c.amount)} off` : `${c.percent}% off`;
}

/** What a buyer pays for a course of `price` rupees with the code. Never below zero. */
export function priceWith(c: Pick<CouponPlus, "kind" | "percent" | "amount">, price: number): number {
  const after = c.kind === "flat" ? price - c.amount : Math.round(price * (1 - c.percent / 100));
  return Math.max(0, after);
}

// ── Uses and revenue ─────────────────────────────────────────────────

/** Uses, revenue and last sale for each coupon id. */
export function couponStatsById(
  coupons: CouponPlus[],
  courses: Pick<Course, "id" | "price">[],
  payments: Payment[] = getActivity().payments,
): Map<string, CouponStats> {
  const byCode = new Map<string, CouponStats>();
  for (const p of payments) {
    if (p.status !== "paid" || !p.coupon) continue;
    const s = byCode.get(p.coupon) ?? { uses: 0, revenue: 0, lastUsed: null };
    s.uses++;
    s.revenue += p.amount;
    if (!s.lastUsed || p.at > s.lastUsed) s.lastUsed = p.at;
    byCode.set(p.coupon, s);
  }

  const seeds = new Map(extraSeeds().map((s) => [s.coupon.id, s]));
  const priceOf = (id: string | null) => courses.find((c) => c.id === (id ?? MAIN_COURSE_ID))?.price ?? MAIN_PRICE;
  const out = new Map<string, CouponStats>();
  for (const c of coupons) {
    let stats = byCode.get(c.code) ?? { uses: 0, revenue: 0, lastUsed: null };
    const seed = seeds.get(c.id);
    if (stats.uses === 0 && seed && seed.coupon.code === c.code && seed.uses > 0) {
      // Example numbers for a code the example payments can't contain (it ended before them).
      stats = { uses: seed.uses, revenue: seed.uses * priceWith(c, priceOf(c.courseId)), lastUsed: seed.lastUsed };
    }
    out.set(c.id, stats);
  }
  return out;
}

/** On, off, expired or used up. `today` is YYYY-MM-DD; a code works through its last day. */
export function couponState(c: Pick<Coupon, "active" | "expires" | "limit">, uses: number, today = ymd(new Date())): CouponState {
  if (!c.active) return "off";
  if (c.expires && c.expires < today) return "expired";
  if (c.limit !== null && uses >= c.limit) return "used-up";
  return "on";
}

/** The next free reel code: REEL4 when REEL3 exists. */
export function nextReelCode(coupons: Pick<Coupon, "code">[]): string {
  const taken = new Set(coupons.map((c) => c.code));
  // Reel numbers are small; REEL15 and the like are percent codes, not reel numbers.
  const numbers = coupons.map((c) => /^REEL(\d)$/.exec(c.code)?.[1]).filter(Boolean).map(Number);
  let n = numbers.length ? Math.max(...numbers) + 1 : 1;
  while (taken.has(`REEL${n}`)) n++;
  return `REEL${n}`;
}

// ── The form's checks ────────────────────────────────────────────────

export type CouponField = "code" | "value" | "courseId" | "expires" | "limit";
export type CouponErrors = Partial<Record<CouponField, string>>;

/** What the form holds, as typed. */
export interface CouponInput {
  code: string;
  kind: DiscountKind;
  value: string;
  /** "" for every course. */
  courseId: string;
  /** "" for no expiry, else YYYY-MM-DD. */
  expires: string;
  /** "" for no limit. */
  limit: string;
  active: boolean;
}

export interface CheckContext {
  /** The coupon being edited, or null for a new one. */
  editing: CouponPlus | null;
  coupons: CouponPlus[];
  courses: Pick<Course, "id" | "title" | "price">[];
  /** Times the edited coupon has been used. */
  uses: number;
  /** YYYY-MM-DD */
  today: string;
}

/** Codes are stored in capitals: "insta10 " becomes "INSTA10". */
export const normaliseCode = (raw: string) => raw.trim().toUpperCase();

/** A whole number from what was typed ("1,000", "10%", "₹300"), or NaN. */
function wholeNumber(raw: string): number {
  const clean = raw.replace(/[\s,₹%]/g, "");
  if (!/^\d+$/.test(clean)) return clean && /^\d*[.]\d+$/.test(clean) ? -1 : Number.NaN;
  return Number(clean);
}

/**
 * Checks a coupon form. Returns an error per field (empty when all is well) and, when there are
 * none, the coupon to save.
 */
export function checkCoupon(input: CouponInput, ctx: CheckContext): { errors: CouponErrors; coupon: CouponPlus | null } {
  const errors: CouponErrors = {};
  const { editing } = ctx;

  // Code: capitals and digits, unique, and fixed once it has been used.
  const code = normaliseCode(input.code);
  if (!code) errors.code = "Enter a code, like INSTA10.";
  else if (/\s/.test(code)) errors.code = "Remove the spaces. Use only capital letters and numbers, like REEL4.";
  else if (!/^[A-Z0-9]+$/.test(code)) errors.code = "Use only capital letters A to Z and numbers 0 to 9, like REEL4.";
  else if (code.length < CODE_MIN || code.length > CODE_MAX) errors.code = `Use ${CODE_MIN} to ${CODE_MAX} characters. This one has ${code.length}.`;
  else if (editing && ctx.uses > 0 && code !== editing.code)
    errors.code = `${editing.code} has been used, so its code can't change. Make a new coupon instead.`;
  else if (ctx.coupons.some((c) => c.code === code && c.id !== editing?.id)) errors.code = `${code} already exists. Each code must be different.`;

  // Course: every course, or one that still exists.
  const courseId = input.courseId || null;
  const course = courseId ? ctx.courses.find((c) => c.id === courseId) : null;
  if (courseId && !course) errors.courseId = "That course was deleted. Pick a course, or All courses.";

  // Discount: 1-90% off, or a whole rupee amount below the price.
  const value = wholeNumber(input.value);
  let percent = 0;
  let amount = 0;
  if (input.kind === "percent") {
    if (!input.value.trim()) errors.value = `Enter how much off, from ${PERCENT_MIN}% to ${PERCENT_MAX}%.`;
    else if (value === -1) errors.value = "Use a whole number, like 10.";
    else if (!Number.isFinite(value) || value < PERCENT_MIN || value > PERCENT_MAX)
      errors.value = `Enter a discount from ${PERCENT_MIN}% to ${PERCENT_MAX}%.`;
    else percent = value;
  } else {
    const priced = (course ? [course] : ctx.courses).filter((c) => c.price > 0);
    const cheapest = priced.reduce<(typeof priced)[number] | null>((low, c) => (!low || c.price < low.price ? c : low), null);
    if (!input.value.trim()) errors.value = "Enter how many rupees off, like 300.";
    else if (value === -1) errors.value = "Use whole rupees, like 300.";
    else if (!Number.isFinite(value) || value < 1) errors.value = "Enter an amount of ₹1 or more.";
    else if (cheapest && value >= cheapest.price)
      errors.value = `Keep it under ${inr(cheapest.price)}, the price of ${cheapest.title}${course ? "" : " (your lowest-priced course)"}.`;
    else amount = value;
  }

  // Expiry: optional; today or later (an existing past date may stay as it is).
  const expires = input.expires.trim() || null;
  if (expires) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || Number.isNaN(new Date(`${expires}T00:00:00`).getTime()))
      errors.expires = "Enter a date, or leave it empty.";
    else if (expires < ctx.today && expires !== editing?.expires) errors.expires = "Pick today or a later date, or leave it empty.";
  }

  // Usage limit: optional; at least the uses so far.
  let limit: number | null = null;
  if (input.limit.trim()) {
    const n = wholeNumber(input.limit);
    if (!Number.isFinite(n) || n < 1 || n > LIMIT_MAX) errors.limit = `Enter a whole number from 1 to ${LIMIT_MAX.toLocaleString("en-IN")}, or leave it empty.`;
    else if (editing && n < ctx.uses)
      errors.limit = `${editing.code} has been used ${ctx.uses} times already. Set ${ctx.uses} or more, or leave it empty.`;
    else limit = n;
  }

  if (Object.keys(errors).length) return { errors, coupon: null };
  return {
    errors,
    coupon: {
      id: editing?.id ?? `cp_${code.toLowerCase()}_${Date.now().toString(36)}`,
      code,
      kind: input.kind,
      percent,
      amount,
      courseId,
      expires,
      limit,
      active: input.active,
      createdAt: editing?.createdAt ?? new Date().toISOString(),
    },
  };
}
