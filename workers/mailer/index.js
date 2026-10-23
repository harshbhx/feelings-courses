// The mailer Worker: sends the course site's emails (sign-in links, receipts) through Cloudflare
// Email Service. Pages Functions can't hold a `send_email` binding, so this Worker holds it and
// the Pages project calls it through a service binding (MAILER). scripts/setup.mjs uploads this
// file as the Worker `fbc-courses-mailer` with:
//
//   EMAIL          send_email binding, allowed_sender_addresses = [EMAIL_FROM] (it can't send as
//                  anyone else)
//   EMAIL_FROM     the sender, an address on feelingsbeautycare.in (an Email Sending domain)
//   EMAIL_FROM_NAME  "Feelings Beauty Care"
//   MAILER_KEY     shared secret; the Pages project sends it as "Authorization: Bearer <key>"
//
// and with workers.dev and preview URLs turned off and no routes, so nothing on the internet can
// reach it; the key is a second lock in case a route is ever added by mistake.
//
// Plain JavaScript with no imports, so it uploads as it is (no build step).
// POST /send { to, subject, text, html } → 202 { ok: true } | 4xx/5xx { error }.
// It never logs an address, a subject or a body: only error codes.

const MAX_BODY = 64 * 1024;
const ADDRESS_RE = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}$/;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

/** Constant-time string compare (time depends on the length only). */
function sameText(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** The message, checked: one recipient, a one-line subject, text and HTML of sane size. */
export function parseMessage(value) {
  if (!value || typeof value !== "object") return null;
  const { to, subject, text, html } = value;
  if (typeof to !== "string" || to.length > 254 || !ADDRESS_RE.test(to)) return null;
  if (typeof subject !== "string" || subject.length < 1 || subject.length > 200 || /[\r\n]/.test(subject)) return null;
  if (typeof text !== "string" || text.length < 1 || text.length > 20_000) return null;
  if (typeof html !== "string" || html.length > 40_000) return null;
  return { to, subject, text, html };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/send") return json(404, { error: "not_found" });
    const key = typeof env.MAILER_KEY === "string" ? env.MAILER_KEY : "";
    if (key.length < 32 || !sameText(request.headers.get("Authorization") ?? "", `Bearer ${key}`)) return json(401, { error: "unauthorized" });
    if (!env.EMAIL || typeof env.EMAIL_FROM !== "string" || !ADDRESS_RE.test(env.EMAIL_FROM)) return json(503, { error: "not_configured" });

    const raw = await request.text();
    if (raw.length > MAX_BODY) return json(413, { error: "too_large" });
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: "invalid_json" });
    }
    const message = parseMessage(body);
    if (!message) return json(400, { error: "invalid_message" });

    try {
      await env.EMAIL.send({
        from: env.EMAIL_FROM_NAME ? { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME } : env.EMAIL_FROM,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      });
      return json(202, { ok: true });
    } catch (err) {
      // Email Service errors carry a code such as E_SENDER_NOT_VERIFIED or E_DAILY_LIMIT_EXCEEDED.
      const code = typeof err?.code === "string" && /^[A-Z0-9_]{1,60}$/.test(err.code) ? err.code : "send_failed";
      console.error(`mailer: ${code}`);
      return json(502, { error: code });
    }
  },
};
