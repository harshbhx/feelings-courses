/**
 * Who may open a student's account by proving one purchase (security review F1,
 * docs/SECURITY-REVIEW.md).
 *
 * A student is found by phone number at checkout (payments.ts upsertStudent), and nothing checks
 * that the buyer owns that number (no OTP: the owner chose no SMS or email service). Without this
 * rule, anyone who knows a customer's phone number could buy any cheap course (or take a free one)
 * with it and receive a sign-in link, or restore with their own payment ID, straight into the
 * customer's existing account: every course in it, the profile, receipts and devices.
 *
 * The rule: a purchase proves the account only when nothing of value was in it before. A sign-in
 * by proof of an order (the handoff after checkout, restore with a payment ID) or of a free
 * enrollment is allowed when the student had no other enrollment that still gives access before
 * that purchase started. A returning customer who buys again on a new device signs in with the payment ID of
 * their first purchase, or gets a one-time link from the admin on WhatsApp; on a device that is
 * already signed in nothing changes.
 *
 * Not covered (an owner decision, see the review): someone who uses a phone number before its
 * owner ever buys holds that account first. Only verifying the phone number closes that.
 */
import type { Db } from "./db/d1.ts";

export interface PurchaseProof {
  /** The order proven (orders.id), or null for a free enrollment (no order row). */
  orderId: number | null;
  /** The course the proof is for (its own enrollment doesn't count as earlier access). */
  courseId: number;
  /** When the proven purchase started: the order's created_at, or the free enrollment's time. */
  since: number;
}

/**
 * True when proving this purchase may sign in to the student's account: before it started, the
 * student had no other enrollment that still gives access (not revoked, not expired). Expired or
 * revoked ones don't count: they open nothing, and counting them would lock out a customer whose
 * old access ran out. `now` decides "still gives access".
 */
export async function purchaseOpensAccount(db: Db, studentId: number, proof: PurchaseProof, now: number): Promise<boolean> {
  // Leave out the proof's own enrollment: the order's (a renewal keeps the old row's created_at),
  // or, for a free enrollment (no order), the course's.
  const notOwn = proof.orderId !== null ? "(order_id IS NULL OR order_id <> ?)" : "course_id <> ?";
  const earlier = await db
    .prepare(
      `SELECT 1 AS earlier FROM enrollments
       WHERE student_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         AND created_at < ? AND ${notOwn}
       LIMIT 1`,
    )
    .bind(studentId, now, proof.since, proof.orderId ?? proof.courseId)
    .first();
  return !earlier;
}
