/**
 * Server-side pricing (plan 1.9): course or batch price, then coupon, then the amount in paise
 * (at least ₹1 unless an allow_free coupon makes it free). STUB: signature frozen by W0, body by W2.
 */
import type { Quote, Unix } from "../../src/shared/types.ts";
import type { Db } from "./db/d1.ts";
import { notImplemented } from "./stub.ts";

export interface QuoteInput {
  courseSlug: string;
  batchId?: number;
  couponCode?: string;
  /** For per-student coupon rules (a free coupon once per student). */
  studentId?: number;
  now: Unix;
}

export async function quote(db: Db, input: QuoteInput): Promise<Quote> {
  return notImplemented("quote", "W2");
}
