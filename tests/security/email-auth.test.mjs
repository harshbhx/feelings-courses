// Email identity (owner decision, 23 Oct 2026): exploit-style tests for docs/SECURITY-REVIEW.md,
// "Email identity". Every test plays an attack against the real handlers (D1 shim, fake Razorpay,
// the real mailer Worker behind a fake Email Service) and checks it fails; the ones named
// "regression" check that the honest path still works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleLiveOrder, handleLiveVerify, handleWebhook } from "../../functions/_lib/payments.ts";
import { handleContinue, handleSignin } from "../../functions/_lib/pages/auth.ts";
import { handleEmailLink } from "../../functions/_lib/student-api.ts";
import { requestSignInLink } from "../../functions/_lib/signin-links.ts";
import { emailProvider, outbox, sendEmail } from "../../functions/_lib/email.ts";
import { createAccessLink } from "../../functions/_lib/access-link.ts";
import { eraseStudent, updateStudentDetails } from "../../functions/_lib/admin/students.ts";
import { readSession } from "../../functions/_lib/session.ts";
import { sha256Hex } from "../../functions/_lib/crypto.ts";
import { SESSION_COOKIE } from "../../functions/_lib/config.ts";
import worker from "../../workers/mailer/index.js";
import { cookiesFrom, postForm, postJson, readJson, req } from "../helpers/http.mjs";
import { webhook } from "../helpers/razorpay.mjs";
import { EMAIL_FROM, MAILER_KEY, fakeMailer } from "../helpers/mailer.mjs";
import * as w2 from "../w2/fixtures.mjs";

const { NOW, DAY } = w2;
const VICTIM = "victim@example.com";
const HUB = "https://courses.feelingsbeautycare.in";

/** A W2 database (courses 10-13), a fake Razorpay with `n` payable orders, and a fake mailer. */
async function world(t, { orders = 6, amounts = {} } = {}) {
  const db = await w2.setupDb();
  const mail = fakeMailer();
  const payments = {};
  for (let i = 1; i <= orders; i++) {
    payments[`pay_Pay00000000${String(i).padStart(2, "0")}`] = { order_id: `order_Fake${String(i).padStart(4, "0")}`, amount: amounts[i] ?? 149999 };
  }
  const rzp = w2.razorpay(t, { payments });
  const env = { ...w2.envFor(db), ...mail.env };
  let n = 0;
  /** Buys `course` as `email` from `ip`; returns the verify answer and the order. */
  async function buy({ email, course = "online-basics", name = "Buyer", phone, ip = "203.0.113.50", at = NOW, cookie } = {}) {
    const order = await readJson(await handleLiveOrder(w2.orderRequest({ ...w2.orderBody({ course, name, email }), phone }, { ip }), env, at));
    assert.equal(order.mode, "razorpay", JSON.stringify(order));
    n += 1;
    const pay = `pay_Pay00000000${String(n).padStart(2, "0")}`;
    const res = await handleLiveVerify(postJson("/api/verify", w2.verifyBody(order.orderId, pay), { ip, cookie }), env, at + 30);
    return { order, res, data: await readJson(res), pay };
  }
  return { db, mail, rzp, env, buy };
}

const cookieOf = (res) => {
  const c = cookiesFrom(res)[SESSION_COOKIE];
  return c ? `${SESSION_COOKIE}=${c.value}` : null;
};

/** Follows a handoff redirect (GET) or an emailed link (Continue, POST) and returns the session cookie. */
async function open(env, url, at, { post = true } = {}) {
  const t = new URL(url).searchParams.get("t");
  const res = post ? await handleContinue(postForm("/auth/continue", { t }), env, at) : await handleContinue(req(`/auth/continue?t=${t}`), env, at);
  return { res, cookie: cookieOf(res) };
}

const sessionOf = async (env, cookie, at) => (cookie ? readSession(env, req("/", { cookie }), at) : null);

// ---------------------------------------------------------------- enumeration

test("enumeration: the same answer for an address with or without an account; mail only to a real one", async (t) => {
  const { db, mail, env, buy } = await world(t);
  await buy({ email: VICTIM });
  const sentBefore = mail.sent.length;
  const ask = (email, ip) => handleEmailLink(postJson("/api/auth/email-link", { email }, { ip }), env, NOW + DAY);
  const known = await ask(VICTIM, "198.51.100.1");
  const unknown = await ask("nobody@example.com", "198.51.100.2");
  assert.equal(known.status, 202);
  assert.equal(unknown.status, 202);
  assert.deepEqual(await readJson(known), await readJson(unknown));
  assert.deepEqual([...known.headers].filter(([k]) => k !== "date"), [...unknown.headers].filter(([k]) => k !== "date"));
  assert.equal(mail.sent.length, sentBefore + 1);
  assert.equal(mail.sent.at(-1).to, VICTIM);

  // The form page too: identical apart from the address it echoes.
  const page = async (email) => (await handleSignin(postForm("/signin", { email }, { ip: "198.51.100.3" }), env, NOW + DAY)).text();
  assert.equal((await page(VICTIM)).replaceAll(VICTIM, "X"), (await page("nobody@example.com")).replaceAll("nobody@example.com", "X"));
  // A legacy account with no email, or an erased one, can't be found by anything typed.
  assert.equal(db.get("SELECT count(*) AS n FROM students WHERE email IS NULL").n, 0);
});

test("enumeration: with waitUntil the lookup, the link and the send all happen after the answer", async (t) => {
  const { db, mail, env, buy } = await world(t);
  await buy({ email: VICTIM });
  const sentBefore = mail.sent.length;
  // A slow account lookup (as D1 over the network can be): the answer must not wait for it.
  let lookedUp = false;
  const slow = new Proxy(db, {
    get(target, prop) {
      if (prop !== "prepare") {
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql) => {
        const statement = target.prepare(sql);
        if (!/FROM students WHERE email/.test(sql)) return statement;
        return {
          bind: (...values) => {
            const bound = statement.bind(...values);
            return {
              first: async (column) => {
                await new Promise((resolve) => setTimeout(resolve, 30));
                lookedUp = true;
                return bound.first(column);
              },
            };
          },
        };
      };
    },
  });
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const res = await handleEmailLink(postJson("/api/auth/email-link", { email: VICTIM }, { ip: "198.51.100.9" }), { ...env, DB: slow }, NOW + DAY, ctx);
  assert.equal(res.status, 202);
  assert.equal(pending.length, 1);
  assert.equal(lookedUp, false, "answered before the account lookup finished");
  assert.equal(mail.sent.length, sentBefore, "nothing sent before the answer");
  await Promise.all(pending);
  assert.equal(lookedUp, true);
  assert.equal(mail.sent.length, sentBefore + 1);
});

// ---------------------------------------------------------------- the link itself

test("a link works once, for 15 minutes; GET never uses it; only the newest link works", async (t) => {
  const { db, mail, env, buy } = await world(t);
  await buy({ email: VICTIM });
  const at = NOW + DAY;
  const ask = (when, ip = "198.51.100.20") => requestSignInLink(env, req("/api/auth/email-link", { method: "POST", ip }), { email: VICTIM, next: "/account" }, { now: when });

  // GET (a mail scanner, a link preview) shows Continue and uses nothing.
  await ask(at);
  const first = mail.lastLink(VICTIM);
  const scan = await handleContinue(req(`/auth/continue?t=${mail.tokenOf(first)}`, { headers: { "User-Agent": "Microsoft Office/16.0 SafeLinks" } }), env, at + 5);
  assert.equal(scan.status, 200);
  assert.equal(cookieOf(scan), null);
  // Just inside 15 minutes: signs in. Then never again.
  const used = await open(env, first, at + 15 * 60 - 1);
  assert.equal(used.res.status, 303);
  assert.ok(used.cookie);
  assert.equal((await open(env, first, at + 15 * 60 - 1)).res.status, 410, "single use");

  // Exactly 15 minutes: expired.
  await ask(at + 3600);
  const late = mail.lastLink(VICTIM);
  assert.equal((await open(env, late, at + 3600 + 15 * 60)).res.status, 410);

  // A newer link replaces the older one.
  await ask(at + 7200);
  const older = mail.lastLink(VICTIM);
  await ask(at + 7210);
  const newer = mail.lastLink(VICTIM);
  assert.notEqual(older, newer);
  assert.equal((await open(env, older, at + 7220)).res.status, 410);
  assert.equal((await open(env, newer, at + 7220)).res.status, 303);

  // Two tabs racing with one link: exactly one session.
  await ask(at + 9000, "198.51.100.21");
  const race = mail.lastLink(VICTIM);
  const results = await Promise.all([open(env, race, at + 9001), open(env, race, at + 9001)]);
  assert.deepEqual(results.map((r) => r.res.status).sort(), [303, 410]);
  assert.ok(db.get("SELECT count(*) AS n FROM login_tokens WHERE used_at IS NULL AND expires_at > ?", at + 9001).n === 0);
});

test("tokens: 256 random bits, only their SHA-256 in D1, never in the audit log; next can't leave the site", async (t) => {
  const { db, mail, env, buy } = await world(t);
  await buy({ email: VICTIM });
  const nexts = ["//evil.example/x", "https://evil.example", "/\\evil.example", "/learn/online-basics"];
  for (const [i, next] of nexts.entries()) {
    // One per 15-minute window (3 links per address per window).
    await handleEmailLink(postJson("/api/auth/email-link", { email: VICTIM, next }, { ip: `198.51.100.${30 + i}` }), env, NOW + DAY + i * 900);
  }
  const links = mail.links(VICTIM).slice(-4);
  const tokens = links.map(mail.tokenOf);
  for (const token of tokens) assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const rows = db.rows("SELECT token_hash, redirect_path FROM login_tokens ORDER BY id DESC LIMIT 4").reverse();
  assert.deepEqual(rows.map((r) => r.redirect_path), ["/account", "/account", "/account", "/learn/online-basics"]);
  for (const [i, token] of tokens.entries()) assert.equal(rows[i].token_hash, await sha256Hex(token));
  const everything = JSON.stringify([db.rows("SELECT * FROM login_tokens"), db.rows("SELECT * FROM audit_log"), db.rows("SELECT * FROM rate_limits")]);
  for (const token of tokens) assert.equal(everything.includes(token), false, "no raw token stored anywhere");
  assert.equal(everything.includes(VICTIM), false, "no address in the audit log or the rate limits");
});

// ---------------------------------------------------------------- rate limits

test("rate limits: 3 links per address per 15 minutes from any IP, 10 a day; an unknown address is limited the same way", async (t) => {
  const { mail, env, buy } = await world(t);
  await buy({ email: VICTIM });
  const ask = (email, ip, at) => handleEmailLink(postJson("/api/auth/email-link", { email }, { ip }), env, at);
  const start = Math.floor(NOW / DAY) * DAY + DAY + 3600; // early in the next day, window-aligned
  for (const email of [VICTIM, "nobody@example.com"]) {
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await ask(email, `203.0.113.${100 + i}`, start)).status);
    assert.deepEqual(statuses, [202, 202, 202, 429], email);
  }
  // Across the day: 3 per 15-minute window, but no more than 10 in all.
  const day = [];
  for (let w = 1; w <= 4; w++) for (let i = 0; i < 3; i++) day.push((await ask(VICTIM, `198.51.100.${w * 10 + i}`, start + w * 900)).status);
  // Every try counts against the day, refused ones too: 4 earlier, then 3 + 3 allowed, the 11th refused.
  assert.equal(day.filter((s) => s === 202).length, 6);
  assert.equal(day.at(-1), 429);
  assert.ok(mail.sent.filter((m) => m.to === VICTIM && /sign-in link/i.test(m.subject)).length <= 10);
});

// ---------------------------------------------------------------- takeover attempts

test("takeover: an account whose email was proven is never opened by a purchase, even with nothing in it", async (t) => {
  const { db, mail, env, buy } = await world(t);
  db.sqlite.exec(`INSERT INTO students (id, name, email, created_at, updated_at) VALUES (90, 'Victim', '${VICTIM}', ${NOW - 9 * DAY}, ${NOW - 9 * DAY})`);
  // The victim proves the address once (an emailed link), then has no course at all.
  await handleEmailLink(postJson("/api/auth/email-link", { email: VICTIM }, { ip: "198.51.100.40" }), env, NOW - DAY);
  assert.equal((await open(env, mail.lastLink(VICTIM), NOW - DAY + 10)).res.status, 303);
  assert.equal(db.get("SELECT email FROM email_verifications WHERE student_id = 90").email, VICTIM);

  const mallory = await buy({ email: VICTIM, name: "Mallory", ip: "203.0.113.66" });
  assert.doesNotMatch(mallory.data.redirect, /auth\/continue/);
  assert.equal(mallory.data.redirect, mallory.data.receipt);
  assert.equal(db.get("SELECT count(*) AS n FROM login_tokens WHERE purpose = 'handoff'").n, 0);
  assert.equal(db.get("SELECT name FROM students WHERE id = 90").name, "Victim");
});

test("takeover: an unproven account with ANY earlier enrollment is not opened (expired, refunded, or a renewal of the same course)", async (t) => {
  const { db, buy } = await world(t);
  const old = NOW - 400 * DAY;
  db.sqlite.exec(`
    INSERT INTO students (id, name, email, created_at, updated_at) VALUES (91, 'Expired', 'expired@example.com', ${old}, ${old}), (92, 'Renewal', 'renew@example.com', ${old}, ${old});
    INSERT INTO enrollments (student_id, course_id, source, mode, starts_at, expires_at, created_at, updated_at) VALUES
      (91, 12, 'manual', 'live', ${old}, ${old + 365 * DAY}, ${old}, ${old}),
      (92, 10, 'manual', 'live', ${old}, ${old + 365 * DAY}, ${old}, ${old});
  `);
  const expired = await buy({ email: "expired@example.com", name: "Mallory" });
  assert.doesNotMatch(expired.data.redirect, /auth\/continue/, "an expired course elsewhere still holds history");
  const renewal = await buy({ email: "renew@example.com", name: "Mallory" });
  assert.doesNotMatch(renewal.data.redirect, /auth\/continue/, "renewing the same course keeps its old progress and certificate");
  assert.equal(db.get("SELECT count(*) AS n FROM login_tokens WHERE purpose = 'handoff'").n, 0);
});

test("email squatting: the first proof of the address signs the squatter out, and no purchase hands off after it", async (t) => {
  const { db, mail, env, buy } = await world(t, { amounts: { 2: 800000 } });
  // Mallory buys first with an address that isn't hers: a new, empty account, so the paying device is handed a session.
  const squat = await buy({ email: VICTIM, name: "Mallory", ip: "203.0.113.66" });
  assert.match(squat.data.redirect, /auth\/continue/);
  const mallory = await open(env, squat.data.redirect, NOW + 40, { post: false });
  assert.ok(mallory.cookie);
  const victimId = db.get("SELECT id FROM students WHERE email = ?", VICTIM).id;

  // The real owner buys later: the account already holds a course, so no handoff; the link comes by email.
  const real = await buy({ email: VICTIM, course: "hybrid-pro", name: "Asha", ip: "198.51.100.70", at: NOW + DAY });
  assert.doesNotMatch(real.data.redirect, /auth\/continue/);
  const link = mail.lastLink(VICTIM);
  assert.ok(link, "the receipt email carries a sign-in link");
  const owner = await open(env, link, NOW + DAY + 120);
  assert.equal(owner.res.status, 303);

  // The first proof signed every earlier session out: Mallory's device is gone, the owner's stays.
  assert.equal(await sessionOf(env, mallory.cookie, NOW + DAY + 130), null);
  assert.equal((await sessionOf(env, owner.cookie, NOW + DAY + 130)).studentId, victimId);
  assert.equal(db.get("SELECT action FROM audit_log WHERE action = 'student.link_signin'").action, "student.link_signin");
  assert.match(db.get("SELECT data FROM audit_log WHERE action = 'student.link_signin'").data, /firstProof/);

  // Mallory tries again (a free course): the address is proven now, so nothing hands off.
  const again = await readJson(await handleLiveOrder(w2.orderRequest(w2.orderBody({ course: "free-intro", name: "Mallory", email: VICTIM }), { ip: "203.0.113.66" }), env, NOW + 2 * DAY));
  assert.equal(again.redirect, `${HUB}/signin?sent=1`);
  // A second proof doesn't sign anyone out again.
  await handleEmailLink(postJson("/api/auth/email-link", { email: VICTIM }, { ip: "198.51.100.71" }), env, NOW + 3 * DAY);
  const second = await open(env, mail.lastLink(VICTIM), NOW + 3 * DAY + 10);
  assert.ok((await sessionOf(env, owner.cookie, NOW + 3 * DAY + 20)) !== null, "the owner's other device stays signed in");
  assert.ok(second.cookie);
});

test("takeover: the phone number never finds an account; a known phone with another email opens only a new, empty one", async (t) => {
  const { db, env, buy } = await world(t, { amounts: { 2: 800000 } });
  await buy({ email: VICTIM, name: "Asha", phone: "9876543210" });
  const victimId = db.get("SELECT id FROM students WHERE email = ?", VICTIM).id;
  const mallory = await buy({ email: "mallory@example.net", name: "Mallory", phone: "9876543210", ip: "203.0.113.66", course: "hybrid-pro" });
  assert.match(mallory.data.redirect, /auth\/continue/, "her own new account");
  const session = await open(env, mallory.data.redirect, NOW + 60, { post: false });
  const mine = await sessionOf(env, session.cookie, NOW + 70);
  assert.notEqual(mine.studentId, victimId);
  assert.equal(db.get("SELECT count(*) AS n FROM enrollments WHERE student_id = ?", mine.studentId).n, 1);
  assert.equal(db.get("SELECT phone FROM students WHERE id = ?", mine.studentId).phone, null, "the victim's phone isn't copied onto her account");
  assert.equal(db.get("SELECT phone FROM students WHERE id = ?", victimId).phone, "+919876543210");
});

test("admin changes the email: the old address's links stop working and it gets nothing more; erase ends everything", async (t) => {
  const { db, mail, env, buy } = await world(t);
  await buy({ email: VICTIM });
  const id = db.get("SELECT id FROM students WHERE email = ?", VICTIM).id;
  await handleEmailLink(postJson("/api/auth/email-link", { email: VICTIM }, { ip: "198.51.100.80" }), env, NOW + DAY);
  const before = mail.lastLink(VICTIM);
  const opts = { now: NOW + DAY + 10, live: false, hubOrigin: HUB };
  await updateStudentDetails(db, id, { email: "asha.new@example.com" }, opts);
  assert.equal((await open(env, before, NOW + DAY + 20)).res.status, 410, "a link sent to the old address is dead");
  const sent = mail.sent.length;
  await handleEmailLink(postJson("/api/auth/email-link", { email: VICTIM }, { ip: "198.51.100.81" }), env, NOW + DAY + 30);
  assert.equal(mail.sent.length, sent, "the old address gets nothing");
  await handleEmailLink(postJson("/api/auth/email-link", { email: "asha.new@example.com" }, { ip: "198.51.100.82" }), env, NOW + DAY + 40);
  assert.equal(mail.sent.at(-1).to, "asha.new@example.com");
  const opened = await open(env, mail.lastLink("asha.new@example.com"), NOW + DAY + 50);
  assert.equal(opened.res.status, 303);
  assert.equal(db.get("SELECT email FROM email_verifications WHERE student_id = ?", id).email, "asha.new@example.com");
  // Two students can't share an address.
  db.sqlite.exec(`INSERT INTO students (id, name, email, created_at, updated_at) VALUES (95, 'Other', 'other@example.com', ${NOW}, ${NOW})`);
  await assert.rejects(updateStudentDetails(db, 95, { email: "asha.new@example.com" }, opts), /already has this email/);

  // Erase: sessions, links and the proof go; the address finds nothing.
  await handleEmailLink(postJson("/api/auth/email-link", { email: "asha.new@example.com" }, { ip: "198.51.100.83" }), env, NOW + DAY + 60);
  const pendingLink = mail.lastLink("asha.new@example.com");
  await eraseStudent(db, id, opts);
  assert.equal(await sessionOf(env, opened.cookie, NOW + DAY + 70), null);
  assert.equal((await open(env, pendingLink, NOW + DAY + 70)).res.status, 410);
  assert.equal(db.get("SELECT count(*) AS n FROM email_verifications WHERE student_id = ?", id).n, 0);
  const afterErase = mail.sent.length;
  await handleEmailLink(postJson("/api/auth/email-link", { email: "asha.new@example.com" }, { ip: "198.51.100.84" }), env, NOW + DAY + 80);
  assert.equal(mail.sent.length, afterErase);
});

// ---------------------------------------------------------------- receipts and the admin link

test("receipt email: once per order, whichever of verify and the webhook paid it; the link signs in on any device", async (t) => {
  const { db, mail, env, buy } = await world(t);
  const bought = await buy({ email: VICTIM, name: "Asha" });
  const receipts = () => mail.sent.filter((m) => m.subject.startsWith("Payment received"));
  assert.equal(receipts().length, 1);
  const message = receipts()[0];
  assert.equal(message.to, VICTIM);
  assert.ok(message.text.includes(bought.pay));
  assert.ok(message.text.includes("/receipt/"));
  assert.equal(/gstin|GST/i.test(message.text + message.html), false);
  // The webhook for the same payment arrives late: no second email.
  const payment = w2.paymentEntity({ id: bought.pay, order_id: bought.order.orderId, amount: bought.order.amount });
  const { body, headers } = webhook("payment.captured", { payment }, w2.TEST_ENV.RAZORPAY_WEBHOOK_SECRET, { eventId: "evt_Late000000001" });
  assert.equal((await handleWebhook(req("/api/razorpay/webhook", { method: "POST", body, headers, origin: null }), env, undefined, NOW + 120)).status, 200);
  assert.equal(receipts().length, 1);
  // The receipt's sign-in link works on a second device too (it went to the proven inbox).
  const other = await open(env, mail.lastLink(VICTIM), NOW + 200);
  assert.equal(other.res.status, 303);
  assert.equal(db.get("SELECT count(*) AS n FROM sessions WHERE revoked_at IS NULL").n, 1, "the first proof signed the handoff device out once");
});

test("receipt email for a payment only the webhook saw (the browser closed)", async (t) => {
  const { mail, env } = await world(t);
  const order = await readJson(await handleLiveOrder(w2.orderRequest(w2.orderBody({ email: VICTIM })), env, NOW));
  const payment = w2.paymentEntity({ id: "pay_Pay0000000001", order_id: order.orderId, amount: order.amount });
  const { body, headers } = webhook("payment.captured", { payment }, w2.TEST_ENV.RAZORPAY_WEBHOOK_SECRET, { eventId: "evt_Only000000001" });
  const pending = [];
  const res = await handleWebhook(req("/api/razorpay/webhook", { method: "POST", body, headers, origin: null }), env, { waitUntil: (p) => pending.push(p) }, NOW + 60);
  assert.equal(res.status, 200);
  await Promise.all(pending);
  assert.equal(mail.sent.filter((m) => m.to === VICTIM && m.subject.startsWith("Payment received")).length, 1);
});

test("admin link: emailed to the student, 24 hours, copyable for WhatsApp; opening it proves the email", async (t) => {
  const { db, mail, env, buy } = await world(t);
  await buy({ email: VICTIM, name: "Asha", phone: "9876543210" });
  const id = db.get("SELECT id FROM students WHERE email = ?", VICTIM).id;
  const link = await createAccessLink(env, id, { now: NOW + DAY });
  assert.equal(link.emailed, true);
  assert.equal(link.email, VICTIM);
  assert.equal(link.expiresAt, NOW + 2 * DAY);
  assert.match(link.whatsappUrl, /^https:\/\/wa\.me\/919876543210\?text=/);
  assert.equal(mail.lastLink(VICTIM), link.url);
  assert.equal((await open(env, link.url, NOW + 2 * DAY - 1)).res.status, 303);
  assert.equal(db.get("SELECT count(*) AS n FROM email_verifications WHERE student_id = ?", id).n, 1);
});

// ---------------------------------------------------------------- the mailer

test("the mailer Worker: only the Pages project's key gets through; one recipient, a one-line subject, the fixed sender", async () => {
  const sent = [];
  const env = { EMAIL: { send: async (m) => sent.push(m) }, EMAIL_FROM, EMAIL_FROM_NAME: "Feelings Beauty Care", MAILER_KEY };
  const call = (body, { key = MAILER_KEY, method = "POST", path = "/send", workerEnv = env } = {}) =>
    worker.fetch(
      new Request(`https://mailer.internal${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: method === "GET" ? undefined : JSON.stringify(body),
      }),
      workerEnv,
    );
  const good = { to: "a@example.com", subject: "Hello", text: "Hi", html: "<p>Hi</p>" };
  assert.equal((await call(good, { key: null })).status, 401);
  assert.equal((await call(good, { key: "wrong-key-wrong-key-wrong-key-wrong" })).status, 401);
  assert.equal((await call(good, { workerEnv: { ...env, MAILER_KEY: "short" }, key: "short" })).status, 401, "a short key is never accepted");
  assert.equal((await call(good, { method: "GET" })).status, 404);
  assert.equal((await call(good, { path: "/other" })).status, 404);
  assert.equal((await call({ ...good, to: "a@example.com, b@example.com" })).status, 400);
  assert.equal((await call({ ...good, to: "a@example.com\r\nBcc: b@example.com" })).status, 400);
  assert.equal((await call({ ...good, subject: "Hi\r\nBcc: b@example.com" })).status, 400);
  assert.equal(sent.length, 0);
  const ok = await call({ ...good, from: "ceo@bank.example", replyTo: "x@evil.example" });
  assert.equal(ok.status, 202);
  assert.deepEqual(sent[0], { from: { email: EMAIL_FROM, name: "Feelings Beauty Care" }, to: "a@example.com", subject: "Hello", text: "Hi", html: "<p>Hi</p>" });
  // Email Service refusing: the code comes back, nothing else.
  const failing = { ...env, EMAIL: { send: async () => Promise.reject(Object.assign(new Error("x"), { code: "E_SENDER_NOT_VERIFIED" })) } };
  const refused = await call(good, { workerEnv: failing });
  assert.equal(refused.status, 502);
  assert.deepEqual(await refused.json(), { error: "E_SENDER_NOT_VERIFIED" });
});

test("providers: production without a mailer sends nothing and makes no link; the outbox is never used in production", async (t) => {
  assert.equal(emailProvider({}), "off");
  assert.equal(emailProvider({ APP_ENV: "production", EMAIL_PROVIDER: "outbox" }), "off");
  assert.equal(emailProvider({ APP_ENV: "preview" }), "outbox");
  assert.equal(emailProvider({ APP_ENV: "preview", MAILER: {} }), "cloudflare");
  assert.equal(emailProvider({ EMAIL_PROVIDER: "cloudflare" }), "off", "cloudflare without the binding");

  const { db, buy } = await world(t);
  await buy({ email: VICTIM });
  const bare = { ...w2.envFor(db) }; // production, no MAILER
  const tokens = db.get("SELECT count(*) AS n FROM login_tokens").n;
  const res = await handleEmailLink(postJson("/api/auth/email-link", { email: VICTIM }, { ip: "198.51.100.90" }), bare, NOW + DAY);
  assert.equal(res.status, 202, "the same answer");
  assert.equal(db.get("SELECT count(*) AS n FROM login_tokens").n, tokens, "no link nobody can receive");

  // The outbox (previews, local dev) keeps the message instead of sending it.
  outbox.length = 0;
  assert.equal(await sendEmail({ APP_ENV: "preview" }, { to: "a@example.com", subject: "S", text: "T", html: "" }), true);
  assert.equal(outbox.length, 1);
  assert.equal(await sendEmail({ APP_ENV: "preview" }, { to: "a@example.com", subject: "S\nBcc: x", text: "T", html: "" }), false);
});

test("a broken mailer never breaks a payment or a sign-in request (regression)", async (t) => {
  const db = await w2.setupDb();
  w2.razorpay(t, { payments: { pay_Pay0000000001: { order_id: "order_Fake0001", amount: 149999 } } });
  for (const mail of [fakeMailer({ down: true }), fakeMailer({ fail: "E_DAILY_LIMIT_EXCEEDED" })]) {
    const env = { ...w2.envFor(db), ...mail.env };
    const res = await handleEmailLink(postJson("/api/auth/email-link", { email: "anyone@example.com" }, { ip: "198.51.100.95" }), env, NOW);
    assert.equal(res.status, 202);
    assert.equal(await sendEmail(env, { to: "a@example.com", subject: "S", text: "T", html: "" }), false);
  }
  const env = { ...w2.envFor(db), ...fakeMailer({ down: true }).env };
  const order = await readJson(await handleLiveOrder(w2.orderRequest(w2.orderBody({ email: VICTIM })), env, NOW));
  const verify = await handleLiveVerify(postJson("/api/verify", w2.verifyBody(order.orderId, "pay_Pay0000000001")), env, NOW + 30);
  assert.equal(verify.status, 200);
  assert.match((await readJson(verify)).redirect, /auth\/continue/);
  assert.match(db.get("SELECT data FROM audit_log WHERE action = 'order.receipt_email'").data, /"sent":false/);
});
