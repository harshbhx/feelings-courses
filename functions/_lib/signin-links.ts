/**
 * Email sign-in (owner decision, 23 Oct 2026): a student is their email address and signs in with
 * a single-use link sent to it. docs/platform/STUDENTS.md has the flow, docs/SECURITY-REVIEW.md
 * ("Email identity") the threat model.
 *
 * - requestSignInLink(): /signin and POST /api/auth/email-link. Rate limits are counted before
 *   anything is looked up (per IP, IPv6 per /64; per email, hashed). The answer is the same
 *   whether or not the address has an account, and the lookup, the token and the send run after
 *   the answer (waitUntil) so the response time doesn't tell either.
 * - The link: https://<hub>/auth/continue?t=<43 characters, 256 bits>. Only its SHA-256 is stored
 *   (login_tokens.token_hash, unique index), it works once (guarded UPDATE … RETURNING), for 15
 *   minutes, and a newer link replaces the student's unused older ones. Opening it shows a
 *   Continue button first, so mail scanners that fetch links can't use it up.
 * - sendReceiptEmail() / sendEnrolledEmail(): after a payment or a free enrollment, the receipt
 *   and a fresh 15-minute link go to the account's email (never to an address typed later).
 */
import { EMAIL_LINK_TTL, config } from "./config.ts";
import { contactSubject, ipSubject } from "./guard.ts";
import { writeAudit } from "./db/audit.ts";
import { unixNow, type Db } from "./db/d1.ts";
import { ValidationError } from "./db/errors.ts";
import * as v from "./db/validate.ts";
import { emailProvider, sendEmail } from "./email.ts";
import { enrolledEmail, receiptEmail, signInEmail, type EmailBrand } from "./email-templates.ts";
import type { Env } from "./env.ts";
import { loadBusiness, whatsappHref } from "./pages/html.ts";
import { hit } from "./ratelimit.ts";
import { buildReceipt, formatIst, receiptPath } from "./receipts.ts";
import { issueLoginToken, safeRedirectPath } from "./session.ts";
import type { WaitUntil } from "./stub.ts";

export type LinkRequestResult = { ok: true; email: string } | { ok: false; reason: "rate_limited"; retryAfter: number };

/** The typed email as stored (trimmed, lowercased). Throws ValidationError for anything else. */
export function normalizeSignInEmail(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError("email", "Enter the email you used for your course.");
  try {
    return v.email(value, "email");
  } catch {
    throw new ValidationError("email", "Enter an email like name@example.com.");
  }
}

/** The brand line and WhatsApp help link for emails. */
export async function emailBrand(db: Db | null): Promise<EmailBrand> {
  const business = await loadBusiness(db);
  return { name: business.name, whatsappUrl: whatsappHref(business, "Hi Urmi, I need help with my course sign-in.") };
}

/** A fresh 15-minute sign-in link for the student, landing on `path`, or null when they can't sign in. */
export async function emailLinkUrl(env: Env, studentId: number, path: string, now: number): Promise<string | null> {
  try {
    const token = await issueLoginToken(env.DB, studentId, "admin_link", safeRedirectPath(path) ?? "/account", now, { ttl: EMAIL_LINK_TTL });
    return `${config(env).hubOrigin}/auth/continue?t=${encodeURIComponent(token)}`;
  } catch (err) {
    if (err instanceof ValidationError) return null; // erased or missing student
    throw err;
  }
}

async function limited(db: Db, rules: [Parameters<typeof hit>[1], string][], now: number): Promise<number | null> {
  let retryAfter = 0;
  for (const [rule, subject] of rules) {
    const result = await hit(db, rule, subject, { now });
    if (!result.allowed) retryAfter = Math.max(retryAfter, result.retryAfter);
  }
  return retryAfter > 0 ? retryAfter : null;
}

/**
 * A sign-in link request. Throws ValidationError for something that isn't an email (that says
 * nothing about anyone's account). Otherwise the answer is { ok: true } for every address.
 */
export async function requestSignInLink(
  env: Env,
  request: Request,
  input: { email: unknown; next: string },
  options: { now?: number; ctx?: WaitUntil } = {},
): Promise<LinkRequestResult> {
  const now = options.now ?? unixNow();
  const db = env.DB;
  // Every attempt counts against the IP, malformed ones too.
  const ipWait = await limited(db, [["signin_ip", ipSubject(request)]], now);
  if (ipWait !== null) return { ok: false, reason: "rate_limited", retryAfter: ipWait };
  const email = normalizeSignInEmail(input.email);
  const subject = await contactSubject(email);
  const wait = await limited(
    db,
    [
      ["signin_email", subject],
      ["signin_email_day", subject],
    ],
    now,
  );
  if (wait !== null) return { ok: false, reason: "rate_limited", retryAfter: wait };

  const work = deliverSignInLink(env, email, input.next, now).catch((err) => {
    console.error(`signin: ${err instanceof Error ? err.message : "unknown error"}`);
  });
  if (options.ctx) options.ctx.waitUntil(work);
  else await work;
  return { ok: true, email };
}

/** Looks the address up and, when it has an account, emails a link. Nothing is said either way. */
async function deliverSignInLink(env: Env, email: string, next: string, now: number): Promise<void> {
  if (!mailReady(env)) return;
  const student = await env.DB.prepare("SELECT id FROM students WHERE email = ? AND erased_at IS NULL")
    .bind(email)
    .first<{ id: number }>();
  if (!student) return;
  const url = await emailLinkUrl(env, student.id, next, now);
  if (!url) return;
  const sent = await sendEmail(env, signInEmail(await emailBrand(env.DB), email, url));
  await writeAudit(env.DB, {
    actor: `student:${student.id}`,
    action: "student.email_link",
    entity: "student",
    entityId: student.id,
    data: { sent },
    now,
  });
}

/** Mail can go out here. Without a mailer no link is made at all (a link nobody receives is only a risk). */
function mailReady(env: Env): boolean {
  if (emailProvider(env) !== "off") return true;
  console.error("email: no mailer is set up (run the owner setup), nothing sent");
  return false;
}

/** Where a course's sign-in link lands: the course area, or the account for a studio-only course. */
export function landingPath(course: { slug: string; format: string }): string {
  return course.format === "in_person" ? "/account" : `/learn/${course.slug}`;
}

/**
 * After a payment: the receipt link and a fresh sign-in link, to the account's email. Called once
 * per order, by whichever of verify and the webhook marked it paid. Never throws.
 */
export async function sendReceiptEmail(env: Env, orderId: number, now: number = unixNow()): Promise<boolean> {
  if (!mailReady(env)) return false;
  try {
    const receipt = await buildReceipt(env.DB, orderId);
    if (!receipt) return false;
    const row = await env.DB.prepare(
      "SELECT o.student_id, s.email, c.slug, c.format FROM orders o JOIN students s ON s.id = o.student_id " +
        "JOIN courses c ON c.id = o.course_id WHERE o.id = ? AND s.erased_at IS NULL",
    )
      .bind(orderId)
      .first<{ student_id: number; email: string | null; slug: string; format: string }>();
    if (!row?.email) return false;
    let receiptUrl: string | null = null;
    try {
      receiptUrl = `${config(env).hubOrigin}${await receiptPath(env, orderId)}`;
    } catch {
      receiptUrl = null; // no APP_SECRET yet: no receipt links at all
    }
    const signInUrl = await emailLinkUrl(env, row.student_id, landingPath(row), now);
    const o = receipt.order;
    const message = receiptEmail(await emailBrand(env.DB), row.email, {
      courseTitle: o.courseTitle,
      amount: `₹${(o.amountPaise / 100).toLocaleString("en-IN", { minimumFractionDigits: o.amountPaise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`,
      paidOn: o.paidAt ? formatIst(o.paidAt) : formatIst(now),
      paymentId: o.razorpayPaymentId ?? "",
      invoiceNo: o.invoiceNo,
      receiptUrl,
      signInUrl,
    });
    const sent = await sendEmail(env, message);
    await writeAudit(env.DB, {
      actor: "system",
      action: "order.receipt_email",
      entity: "order",
      entityId: orderId,
      data: { sent },
      now,
    });
    return sent;
  } catch (err) {
    console.error(`receipt email: ${err instanceof Error ? err.message : "unknown error"} (order ${orderId})`);
    return false;
  }
}

/** After a free enrollment: "you're enrolled" and a fresh sign-in link, to the account's email. Never throws. */
export async function sendEnrolledEmail(env: Env, studentId: number, courseId: number, now: number = unixNow()): Promise<boolean> {
  if (!mailReady(env)) return false;
  try {
    const row = await env.DB.prepare(
      "SELECT s.email, c.slug, c.title, c.format FROM students s, courses c WHERE s.id = ? AND c.id = ? AND s.erased_at IS NULL",
    )
      .bind(studentId, courseId)
      .first<{ email: string | null; slug: string; title: string; format: string }>();
    if (!row?.email) return false;
    const signInUrl = await emailLinkUrl(env, studentId, landingPath(row), now);
    return await sendEmail(env, enrolledEmail(await emailBrand(env.DB), row.email, row.title, signInUrl));
  } catch (err) {
    console.error(`enrolled email: ${err instanceof Error ? err.message : "unknown error"}`);
    return false;
  }
}
