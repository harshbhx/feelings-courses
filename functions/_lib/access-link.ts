/**
 * The one-time access link Urmi makes in the admin (plan 1.4; email identity since 23 Oct 2026),
 * for a student who can't sign in on their own (no email arrives, a typo in the address, a new
 * phone). W5's POST /api/admin/students/:id/access-link calls createAccessLink() after its admin
 * check.
 *
 * The link is https://<hub>/auth/continue?t=<token>: single use, 24 hours (LOGIN_TOKEN_TTL), and
 * a newer link (emailed or made here) replaces the student's unused older ones. It is emailed to
 * the student's address at once; the admin can also copy it or share it on WhatsApp (a prefilled
 * wa.me message). Opening it shows a "Continue" button first, so mail scanners and WhatsApp's link
 * preview can't use it up. Opening it counts as proof of the account (claim.ts): the admin vouches
 * for the person she sends it to.
 */
import type { AdminAccessLinkResponse } from "../../src/shared/api.ts";
import { config, LOGIN_TOKEN_TTL } from "./config.ts";
import { auditStatement } from "./db/audit.ts";
import { unixNow } from "./db/d1.ts";
import { ValidationError } from "./db/errors.ts";
import { sendEmail } from "./email.ts";
import { adminLinkEmail } from "./email-templates.ts";
import type { Env } from "./env.ts";
import { issueLoginToken } from "./session.ts";
import { emailBrand } from "./signin-links.ts";

/** Where the link lands after sign-in. */
export const ACCESS_LINK_LANDING = "/account";

/** https://wa.me/<digits>?text=… (no number: WhatsApp asks whom to send it to). */
export function whatsappUrl(phone: string | null, text: string): string {
  const digits = phone?.replace(/\D/g, "") ?? "";
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/** The message the admin sends. Plain, no promises the site can't keep. */
export function accessLinkMessage(name: string | null, url: string): string {
  const hello = name ? `Hi ${name.split(" ")[0]},` : "Hi,";
  return (
    `${hello} here is your link to open your Feelings Beauty Care course on this phone:\n${url}\n\n` +
    "It works once and expires in 24 hours. Please don't share it."
  );
}

export async function createAccessLink(
  env: Env,
  studentId: number,
  options: { actor?: string; now?: number } = {},
): Promise<AdminAccessLinkResponse> {
  const now = options.now ?? unixNow();
  const student = await env.DB.prepare("SELECT id, name, phone, email FROM students WHERE id = ? AND erased_at IS NULL")
    .bind(studentId)
    .first<{ id: number; name: string | null; phone: string | null; email: string | null }>();
  if (!student) throw new ValidationError("studentId", "No such student.");

  const token = await issueLoginToken(env.DB, student.id, "admin_link", ACCESS_LINK_LANDING, now);
  const url = `${config(env).hubOrigin}/auth/continue?t=${encodeURIComponent(token)}`;
  const emailed = student.email ? await sendEmail(env, adminLinkEmail(await emailBrand(env.DB), student.email, student.name, url)) : false;
  await auditStatement(env.DB, {
    actor: options.actor ?? "admin",
    action: "student.access_link",
    entity: "student",
    entityId: student.id,
    data: { emailed },
    now,
  }).run();
  return {
    url,
    whatsappUrl: whatsappUrl(student.phone, accessLinkMessage(student.name, url)),
    expiresAt: now + LOGIN_TOKEN_TTL.admin_link,
    emailed,
    email: student.email,
  };
}
