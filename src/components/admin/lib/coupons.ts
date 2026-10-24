/**
 * Coupons: how each one reads ("20% off", "Expired"), and the coupon form. Dates are entered in
 * India time and sent as unix seconds.
 */
import type { AdminCoupon, AdminCouponInput, Unix } from "../../../shared/types.ts";
import { formatPaise, paiseToInput, parseRupees } from "./money.ts";
import { istInputValue, unixFromIstInput } from "./time.ts";

export type CouponState = "active" | "scheduled" | "expired" | "used_up" | "off";

export const COUPON_STATE_LABELS: Record<CouponState, string> = {
  active: "Active",
  scheduled: "Starts later",
  expired: "Expired",
  used_up: "Used up",
  off: "Off",
};

export function couponState(c: Pick<AdminCoupon, "active" | "startsAt" | "expiresAt" | "maxUses" | "usedCount">, now: Unix): CouponState {
  if (!c.active) return "off";
  if (c.expiresAt !== null && now >= c.expiresAt) return "expired";
  if (c.maxUses !== null && c.usedCount >= c.maxUses) return "used_up";
  if (c.startsAt !== null && now < c.startsAt) return "scheduled";
  return "active";
}

/** "20% off", "₹500 off". */
export function discountLabel(c: Pick<AdminCoupon, "percentOff" | "amountOffPaise">): string {
  if (c.percentOff !== null) return `${c.percentOff}% off`;
  if (c.amountOffPaise !== null) return `${formatPaise(c.amountOffPaise)} off`;
  return "—";
}

/** "3 of 50 used", "12 used". */
export function usesLabel(c: Pick<AdminCoupon, "usedCount" | "maxUses">): string {
  return c.maxUses === null ? `${c.usedCount} used` : `${c.usedCount} of ${c.maxUses} used`;
}

export interface CouponFormValues {
  code: string;
  kind: "percent" | "amount";
  value: string;
  /** "" = any course. */
  courseId: string;
  maxUses: string;
  startsAt: string;
  expiresAt: string;
  active: boolean;
  allowFree: boolean;
}

export function blankCouponForm(): CouponFormValues {
  return { code: "", kind: "percent", value: "", courseId: "", maxUses: "", startsAt: "", expiresAt: "", active: true, allowFree: false };
}

export function couponForm(c: AdminCoupon): CouponFormValues {
  return {
    code: c.code,
    kind: c.percentOff !== null ? "percent" : "amount",
    value: c.percentOff !== null ? String(c.percentOff) : paiseToInput(c.amountOffPaise),
    courseId: c.courseId === null ? "" : String(c.courseId),
    maxUses: c.maxUses === null ? "" : String(c.maxUses),
    startsAt: istInputValue(c.startsAt),
    expiresAt: istInputValue(c.expiresAt),
    active: c.active,
    allowFree: c.allowFree,
  };
}

/** A code as it is stored: trimmed, uppercase. */
export const tidyCode = (code: string) => code.trim().toUpperCase().replace(/\s+/g, "");

export type CouponResult = { ok: true; input: AdminCouponInput } | { ok: false; errors: Record<string, string> };

export function couponInput(v: CouponFormValues, existing?: Pick<AdminCoupon, "usedCount">): CouponResult {
  const errors: Record<string, string> = {};
  const code = tidyCode(v.code);
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) errors.code = "Use 3 to 32 letters, digits, - or _, like REEL15.";

  let percentOff: number | null = null;
  let amountOffPaise: number | null = null;
  if (v.kind === "percent") {
    const n = v.value.trim().replace(/%$/, "");
    if (!/^\d+$/.test(n) || Number(n) < 1 || Number(n) > 100) errors.percentOff ="Enter a percentage from 1 to 100.";
    else percentOff = Number(n);
  } else {
    const r = parseRupees(v.value);
    if (!r.ok) errors.amountOffPaise = r.error;
    else if (r.paise === null || r.paise < 100) errors.amountOffPaise = "Enter at least ₹1 off.";
    else amountOffPaise = r.paise;
  }

  let courseId: number | null = null;
  if (v.courseId) {
    if (!/^\d+$/.test(v.courseId)) errors.courseId = "Choose a course.";
    else courseId = Number(v.courseId);
  }

  let maxUses: number | null = null;
  if (v.maxUses.trim()) {
    const n = v.maxUses.trim();
    if (!/^\d+$/.test(n) || Number(n) < 1) errors.maxUses = "Use a whole number from 1, or leave it empty for no limit.";
    else if (existing && Number(n) < existing.usedCount) errors.maxUses = `It has been used ${existing.usedCount} times already.`;
    else maxUses = Number(n);
  }

  const startsAt = unixFromIstInput(v.startsAt);
  if (startsAt === undefined) errors.startsAt = "Enter a date and time.";
  const expiresAt = unixFromIstInput(v.expiresAt);
  if (expiresAt === undefined) errors.expiresAt = "Enter a date and time.";
  if (typeof startsAt === "number" && typeof expiresAt === "number" && expiresAt <= startsAt) errors.expiresAt = "The end must be after the start.";

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    input: {
      code,
      percentOff,
      amountOffPaise,
      courseId,
      maxUses,
      startsAt: startsAt ?? null,
      expiresAt: expiresAt ?? null,
      active: v.active,
      allowFree: v.kind === "percent" && percentOff === 100 ? v.allowFree : false,
    },
  };
}

/** The changed fields of an edited coupon. Switching kind sends only the new one (the API clears the other). */
export function couponChanges(saved: AdminCoupon, input: AdminCouponInput): Partial<AdminCouponInput> {
  const out: Partial<AdminCouponInput> = {};
  const keys: (keyof AdminCouponInput)[] = ["code", "courseId", "maxUses", "startsAt", "expiresAt", "active", "allowFree"];
  for (const k of keys) if (saved[k] !== input[k]) (out as Record<string, unknown>)[k] = input[k];
  if (input.percentOff !== null && input.percentOff !== saved.percentOff) out.percentOff = input.percentOff;
  if (input.amountOffPaise !== null && input.amountOffPaise !== saved.amountOffPaise) out.amountOffPaise = input.amountOffPaise;
  return out;
}
