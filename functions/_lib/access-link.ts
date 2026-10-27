/**
 * The one-time access link Urmi sends a student on WhatsApp (plan 1.4), for a student who lost
 * their payment ID or changed phones. W5's POST /api/admin/students/:id/access-link calls
 * createAccessLink() after its admin check; there is no email service, so the link goes out
 * through a prefilled wa.me message the admin sends herself.
 *
 * The link is https://<hub>/auth/continue?t=<token>: single use, 24 hours (LOGIN_TOKEN_TTL), and
 * a newer link replaces the student's unused older ones. Opening it shows a "Continue" button
 * first, so WhatsApp's link preview can't use it up.
 */
import type { AdminAccessLinkResponse } from "../../src/shared/api.ts";
import { config, LOGIN_TOKEN_TTL } from "./config.ts";
import { auditStatement } from "./db/audit.ts";
import { unixNow } from "./db/d1.ts";
import { ValidationError } from "./db/errors.ts";
import type { Env } from "./env.ts";
import { issueLoginToken } from "./session.ts";

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
  const student = await env.DB.prepare("SELECT id, name, phone FROM students WHERE id = ? AND erased_at IS NULL")
    .bind(studentId)
    .first<{ id: number; name: string | null; phone: string | null }>();
  if (!student) throw new ValidationError("studentId", "No such student.");

  const token = await issueLoginToken(env.DB, student.id, "admin_link", ACCESS_LINK_LANDING, now);
  await auditStatement(env.DB, {
    actor: options.actor ?? "admin",
    action: "student.access_link",
    entity: "student",
    entityId: student.id,
    now,
  }).run();
  const url = `${config(env).hubOrigin}/auth/continue?t=${encodeURIComponent(token)}`;
  return {
    url,
    whatsappUrl: whatsappUrl(student.phone, accessLinkMessage(student.name, url)),
    expiresAt: now + LOGIN_TOKEN_TTL.admin_link,
  };
}
