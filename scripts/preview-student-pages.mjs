// Writes every learner-facing page Functions render (sign-in, account, course home, lesson,
// certificate, receipt, and their empty, error and expired states) to static HTML, from the test
// world in tests/ux/world.mjs. No server, no build, no browser: open the files, or screenshot them
// (docs/design/LEARNER-UX.md has the commands).
//
//   node --experimental-strip-types --no-warnings --import ./tests/helpers/register.mjs scripts/preview-student-pages.mjs [outDir]
//
// Default outDir: preview/student (git-ignored). Absolute /app/… and /favicon.svg links are made
// relative and the files copied, so the pages open straight from disk with their real look.
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { handleAccount } from "../functions/_lib/pages/account.ts";
import { handleContinue, handleLogout, handleSignin } from "../functions/_lib/pages/auth.ts";
import { handleLearnPage } from "../functions/_lib/pages/learn.ts";
import { handleVerifyPage } from "../functions/_lib/pages/verify.ts";
import { handleReceipt } from "../functions/_lib/receipts-route.ts";
import { receiptPath } from "../functions/_lib/receipts.ts";
import { revokeSession, readSession } from "../functions/_lib/session.ts";
import { createWorld, NOW, signIn, SITE } from "../tests/ux/world.mjs";

const root = path.resolve(import.meta.dirname, "..");

/** Every page, by file name: [description, () => Response]. */
export async function studentPages() {
  const { db, env, certificate } = await createWorld();
  const asha = await signIn(db, 1);
  await signIn(db, 1, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0");
  const bina = await signIn(db, 2);
  const ended = await signIn(db, 2, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1");
  const endedSession = await readSession(env, new Request(SITE, { headers: { Cookie: ended } }), NOW);
  await revokeSession(db, 2, endedSession.sessionId, NOW);

  const get = (p, cookie) => new Request(`${SITE}${p}`, { headers: cookie ? { Cookie: cookie } : {} });
  const post = (p, fields) =>
    new Request(`${SITE}${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: SITE },
      body: new URLSearchParams(fields),
    });
  const learn = (p, cookie = asha) => handleLearnPage(get(p, cookie), env, p, NOW);
  const receipt = async (id) => {
    const link = await receiptPath(env, id);
    return handleReceipt(get(link), env, String(id), NOW);
  };

  return {
    "signin.html": ["Sign in on a new device", () => handleSignin(get("/signin?next=/account"), env, NOW)],
    "signin-device-ended.html": ["Sign in after this device was signed out (2-device limit)", () => handleSignin(get("/signin", ended), env, NOW)],
    "signin-error.html": ["Sign in with details that match no payment", () => handleSignin(post("/signin", { contact: "9876543210", paymentId: "pay_NoSuchPayment00", next: "/account" }), env, NOW)],
    "link-expired.html": ["A one-time sign-in link that has expired", () => handleContinue(get("/auth/continue?t=expired-token-value-000000000000"), env, NOW)],
    "account.html": ["Account: courses with progress, devices, payments", () => handleAccount(get("/account", asha), env, NOW)],
    "account-empty.html": ["Account with no course yet", () => handleAccount(get("/account", bina), env, NOW)],
    "course-home.html": ["Course home: resume card, modules, certificate", () => learn("/learn/everyday-glow")],
    "course-complete.html": ["Course home, finished, certificate issued, studio batch", () => learn("/learn/bridal-academy")],
    "lesson.html": ["Lesson player: resume note, done, next, outline", () => learn("/learn/everyday-glow/foundation")],
    "lesson-no-video.html": ["Lesson whose video is being prepared", () => learn("/learn/everyday-glow/kajal")],
    "access-ended.html": ["A course whose year of access has ended", () => learn("/learn/old-class")],
    "not-in-account.html": ["A course that isn't in this account", () => learn("/learn/hair-styling")],
    "certificate-almost.html": ["Certificate asked for before the last lesson", () => learn("/learn/everyday-glow/certificate")],
    "certificate-name.html": ["Correct the name on a certificate", () => learn("/learn/bridal-academy/certificate")],
    "certificate.html": ["The printable certificate, verified", () => handleVerifyPage(get(`/verify/${certificate.code}`), env, certificate.code, NOW)],
    "verify-lookup.html": ["Check a certificate code", () => handleVerifyPage(get("/verify"), env, null, NOW)],
    "verify-not-found.html": ["A certificate code that doesn't exist", () => handleVerifyPage(get("/verify/ZZZZZZZZZZ"), env, "ZZZZZZZZZZ", NOW)],
    "receipt.html": ["Receipt: recorded course, coupon, refund window open", () => receipt(1)],
    "receipt-studio.html": ["Receipt: studio workshop, booking amount", () => receipt(2)],
    "receipt-refunded.html": ["Receipt: refunded", () => receipt(3)],
    "receipt-missing.html": ["A receipt link that isn't valid", () => handleReceipt(get("/receipt/1?k=0"), env, "1", NOW)],
    "sign-out.html": ["Sign out of this device?", () => handleLogout(get("/learn/logout", asha), env, NOW)],
  };
}

/** Makes a page's same-origin links work from a folder on disk. */
export function relativise(html) {
  return html
    .replaceAll('href="/app/', 'href="app/')
    .replaceAll('src="/app/', 'src="app/')
    .replaceAll('"/favicon.svg"', '"favicon.svg"');
}

// Run as a script (not when the tests import studentPages()). Node 22 has no import.meta.main.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const out = path.resolve(root, process.argv[2] ?? "preview/student");
  mkdirSync(out, { recursive: true });
  cpSync(path.join(root, "public/app"), path.join(out, "app"), { recursive: true });
  cpSync(path.join(root, "public/favicon.svg"), path.join(out, "favicon.svg"));
  const pages = await studentPages();
  const index = [];
  for (const [file, [title, render]] of Object.entries(pages)) {
    const response = await render();
    writeFileSync(path.join(out, file), relativise(await response.text()));
    index.push(`<li><a href="${file}">${title}</a> <small>(${response.status})</small></li>`);
    console.log(`${String(response.status).padEnd(4)}${file}  ${title}`);
  }
  writeFileSync(
    path.join(out, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Student pages</title><link rel="stylesheet" href="app/app.css"><main class="wrap"><h1>Student pages</h1><ul>${index.join("")}</ul></main>`,
  );
  console.log(`\n${Object.keys(pages).length} pages in ${path.relative(root, out)}/ (open index.html)`);
}
