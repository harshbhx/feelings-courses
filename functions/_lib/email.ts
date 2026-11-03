/**
 * Sending email (owner decision, 23 Oct 2026: Cloudflare's own email sending, no paid provider).
 *
 * Pages Functions can't hold a `send_email` binding, so a tiny Worker does (workers/mailer/,
 * deployed by scripts/setup.mjs with `allowed_sender_addresses` set to the one sender address on
 * feelingsbeautycare.in). The Functions reach it through the `MAILER` service binding, which no
 * browser can call; every call also carries the shared `MAILER_KEY`.
 *
 * Providers (`EMAIL_PROVIDER`):
 * - "cloudflare": POST the message to the mailer Worker, which calls Cloudflare Email Service.
 * - "outbox": nothing leaves the site. The message is kept in `outbox` (tests, local dev) and one
 *   line is logged; in APP_ENV=development the line includes the text (it holds the sign-in link).
 *   Refused in production, where it would silently drop every sign-in link.
 * - missing: "cloudflare" when MAILER is bound, else "outbox" outside production, else off.
 *
 * Never logged: addresses, links, tokens. sendEmail() never throws: a failure is logged by kind and
 * reported as `false`, so a payment or a sign-in request never fails because of email.
 */
import { config } from "./config.ts";
import type { Env } from "./env.ts";

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain text first: it is what many phone mail apps preview. */
  text: string;
  html: string;
}

export type EmailProvider = "cloudflare" | "outbox" | "off";

/** Messages the "outbox" provider kept (newest last, at most OUTBOX_MAX). Tests read and clear it. */
export const outbox: EmailMessage[] = [];
const OUTBOX_MAX = 50;

/** Where mail goes in this environment. */
export function emailProvider(env: Partial<Env>): EmailProvider {
  const production = config(env).appEnv === "production";
  const chosen = env.EMAIL_PROVIDER?.trim().toLowerCase();
  if (chosen === "outbox") return production ? "off" : "outbox";
  if (chosen === "cloudflare") return env.MAILER ? "cloudflare" : "off";
  if (env.MAILER) return "cloudflare";
  return production ? "off" : "outbox";
}

/** One address: what the database stores (lowercase, no spaces, one @). */
const ADDRESS_RE = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}$/;

/** True when the message reached the provider (or the outbox). Never throws. */
export async function sendEmail(env: Partial<Env>, message: EmailMessage): Promise<boolean> {
  if (!ADDRESS_RE.test(message.to) || message.to.length > 254 || /[\r\n]/.test(message.subject)) {
    console.error("email: refused a malformed message");
    return false;
  }
  const provider = emailProvider(env);
  if (provider === "off") {
    console.error("email: no mailer is set up (run the owner setup), message not sent");
    return false;
  }
  if (provider === "outbox") {
    outbox.push(message);
    if (outbox.length > OUTBOX_MAX) outbox.splice(0, outbox.length - OUTBOX_MAX);
    const dev = config(env).appEnv === "development";
    console.log(`email (outbox, not sent): ${message.subject}${dev ? `\n${message.text}` : ""}`);
    return true;
  }
  const key = env.MAILER_KEY?.trim() ?? "";
  if (key.length < 32) {
    console.error("email: MAILER_KEY is not set (run the owner setup), message not sent");
    return false;
  }
  try {
    const res = await env.MAILER!.fetch("https://mailer.internal/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(message),
    });
    if (res.status === 202) return true;
    let code = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string" && /^[A-Za-z0-9_]{1,60}$/.test(body.error)) code = body.error;
    } catch {
      /* not JSON */
    }
    console.error(`email: the mailer refused the message (${code})`);
    return false;
  } catch (err) {
    console.error(`email: the mailer can't be reached (${err instanceof Error ? err.name : "error"})`);
    return false;
  }
}
