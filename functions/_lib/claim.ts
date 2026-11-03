/**
 * Who may open a student's account (security review F1, with email identity since 23 Oct 2026;
 * docs/SECURITY-REVIEW.md, "Email identity").
 *
 * A student IS their email address. The only proof that someone owns an account is a sign-in link
 * sent to that address and opened (or one the admin made for them): email_verifications records
 * that proof. Checkout finds the account by the email the buyer types, and typing an address
 * proves nothing, so a purchase alone opens an account only in the one case where nothing can be
 * taken from it:
 *
 *   the account's email has never been proven, AND it holds no enrollment besides this purchase.
 *
 * Then the paying device is handed a session at once (the common case: a first purchase). In every
 * other case the buyer gets the receipt on screen and the receipt and a sign-in link by email; the
 * owner of the address opens the course from their inbox.
 *
 * Email squatting (someone buys first with an address that isn't theirs, gets the handoff session,
 * and waits for the real owner to buy into "their" account) is closed by markEmailVerified(): the
 * first proof of an address signs out every session that existed before it, once.
 */
import type { Db } from "./db/d1.ts";
import { changes } from "./db/tx.ts";

export interface PurchaseProof {
  /** The order proven (orders.id), or null for a free enrollment (no order row). */
  orderId: number | null;
  /** The course the proof is for (its own enrollment doesn't count as something else in the account). */
  courseId: number;
  /** When the proven purchase started: the order's created_at, or the free enrollment's time. */
  since: number;
}

/** True when the student's CURRENT email has been proven by an opened sign-in link. */
export async function emailVerified(db: Db, studentId: number): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 AS proven FROM email_verifications v JOIN students s ON s.id = v.student_id " +
        "WHERE v.student_id = ? AND s.email IS NOT NULL AND v.email = s.email",
    )
    .bind(studentId)
    .first();
  return Boolean(row);
}

/**
 * Records that the student just proved their current email. Returns true the first time this
 * address is proven for the account (then the caller signs out every earlier session), false when
 * it already was (or the student has no email).
 */
export async function markEmailVerified(db: Db, studentId: number, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      "INSERT INTO email_verifications (student_id, email, verified_at) " +
        "SELECT id, email, ? FROM students WHERE id = ? AND email IS NOT NULL AND erased_at IS NULL " +
        "ON CONFLICT (student_id) DO UPDATE SET email = excluded.email, verified_at = excluded.verified_at " +
        "WHERE email_verifications.email <> excluded.email",
    )
    .bind(now, studentId)
    .run();
  return changes(result) === 1;
}

/**
 * True when proving this purchase may sign the paying device in: the account's email was never
 * proven, and the account holds nothing from before this purchase: no other enrollment in any
 * state (an expired or refunded course still shows its history, receipts, certificate and the
 * name), and its own enrollment row wasn't there before the purchase started (a renewal keeps the
 * old row, with its progress and certificate). The proof's own enrollment is the order's, or for a
 * free enrollment (no order) the course's.
 */
export async function purchaseOpensAccount(db: Db, studentId: number, proof: PurchaseProof): Promise<boolean> {
  if (await emailVerified(db, studentId)) return false;
  const notOwn = proof.orderId !== null ? "(order_id IS NULL OR order_id <> ?)" : "course_id <> ?";
  const other = await db
    .prepare(`SELECT 1 AS other FROM enrollments WHERE student_id = ? AND (created_at < ? OR ${notOwn}) LIMIT 1`)
    .bind(studentId, proof.since, proof.orderId ?? proof.courseId)
    .first();
  return !other;
}
