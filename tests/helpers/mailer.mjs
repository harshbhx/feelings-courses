// A fake of the email path, end to end: the Pages env gets a MAILER service binding that runs the
// REAL mailer Worker (workers/mailer/index.js) with a fake `send_email` binding (EMAIL) that
// records what Cloudflare Email Service would have sent. No network, no real mail.
//
//   const mail = fakeMailer();
//   const env = { ...envFor(db), ...mail.env };
//   … mail.sent  → [{ from, to, subject, text, html }]
//   mail.lastLink("asha@example.com") → "https://…/auth/continue?t=…" (the newest link to that address)
//
// `fail` makes the fake Email Service throw (an Email Service error code), `down` makes the
// service binding itself throw (the Worker unreachable).

import worker from "../../workers/mailer/index.js";

export const MAILER_KEY = "test-mailer-key-0123456789abcdef0123456789";
export const EMAIL_FROM = "courses@feelingsbeautycare.in";

export function fakeMailer({ fail = null, down = false } = {}) {
  const sent = [];
  const calls = [];
  const EMAIL = {
    async send(message) {
      if (fail) {
        const err = new Error("send failed");
        err.code = fail;
        throw err;
      }
      sent.push({ ...message });
      return { messageId: `msg-${sent.length}` };
    },
  };
  const workerEnv = { EMAIL, EMAIL_FROM, EMAIL_FROM_NAME: "Feelings Beauty Care", MAILER_KEY };
  const MAILER = {
    async fetch(url, init) {
      calls.push(url);
      if (down) throw new TypeError("Network connection lost");
      return worker.fetch(new Request(url, init), workerEnv);
    },
  };
  const links = (to) =>
    sent
      .filter((m) => to === undefined || m.to === to)
      .flatMap((m) => [...m.text.matchAll(/https:\/\/[^\s]+\/auth\/continue\?t=[A-Za-z0-9_%-]+/g)].map((x) => x[0]));
  return {
    sent,
    calls,
    env: { MAILER, MAILER_KEY, EMAIL_PROVIDER: "cloudflare" },
    links,
    lastLink: (to) => links(to).at(-1) ?? null,
    /** The raw token of a link. */
    tokenOf: (url) => decodeURIComponent(new URL(url).searchParams.get("t")),
  };
}
