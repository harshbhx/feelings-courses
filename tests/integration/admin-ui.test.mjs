// W8 integration of W6 (the real admin UI): the requests its screens send, through the real
// Functions files (site.mjs), checked with the admin's own logic from src/components/admin/lib/.
//
// - the session check: GET /api/admin/me tells the admin the hub host and the course domain the
//   router uses, and admin pages and the admin API follow the router's host rules;
// - payments drawer: Refund, Re-check with Razorpay and Replay run W2's code (no 501 any more);
// - student drawer: the one-time sign-in link and certificates run W3's code;
// - settings: the backup panel on W7's backup.ts;
// - uploads: the admin's file checks are W4's rules (one table in src/shared/constants.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cookiesFrom, readJson, req } from "../helpers/http.mjs";
import { webhook } from "../helpers/razorpay.mjs";
import { adminCookie, buy, cookieHeader, COURSE_HOST, ENV, HOUR, HUB, PASSWORD, setup } from "./world.mjs";
import { courseAddresses } from "../../src/components/admin/lib/slug.ts";
import { domainView } from "../../src/components/admin/lib/domain.ts";
import { describeError } from "../../src/components/admin/lib/errors.ts";
import { readRefundForm, refundState } from "../../src/components/admin/lib/orders.ts";
import { fileProblem, UPLOAD_RULES } from "../../src/components/admin/lib/upload.ts";
import { normalizePhone as adminPhone } from "../../src/components/admin/lib/students.ts";
import { gstinProblem } from "../../src/components/admin/lib/settings.ts";
import { MEDIA_RULES, planUpload } from "../../functions/_lib/media-rules.ts";
import { normalisePhone as checkoutPhone } from "../../functions/_lib/checkout.ts";
import { phone as dataPhone } from "../../functions/_lib/db/validate.ts";
import { validateBusiness } from "../../functions/_lib/admin/settings.ts";

const asAdmin = (path, admin, opts = {}) => req(`${HUB}${path}`, { ...opts, cookie: admin });

test("the session check gives the admin the router's hosts; admin pages and API follow the host rules", async (t) => {
  const ctx = await setup(t);
  const { site, env } = ctx;
  const admin = await adminCookie(site);

  const me = await readJson(await site.fetch(asAdmin("/api/admin/me", admin)));
  assert.equal(me.ok, true);
  assert.equal(me.hubHost, "courses.feelingsbeautycare.in");
  assert.equal(me.apexDomain, "feelingsbeautycare.in");
  // The admin's course addresses, built from that answer, are the hosts the router serves.
  const addr = courseAddresses("glow", me);
  assert.equal(addr.subdomainUrl, `${COURSE_HOST}/`);
  assert.equal(addr.hubUrl, `${HUB}/c/glow`);
  assert.equal((await site.fetch(req(addr.subdomainUrl))).status, 200, "the course host serves the course");
  assert.match(domainView("none", "glow", me).help, /courses\.feelingsbeautycare\.in\/c\//);

  // Admin pages live on the hub only: a course host and unknown hosts send them there.
  for (const path of ["/admin", "/admin/settings", "/admin/courses/edit?id=30"]) {
    const res = await site.fetch(req(`${COURSE_HOST}${path}`));
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get("Location"), `${HUB}${path}`, path);
    const other = await site.fetch(req(`https://feelings-courses.example.net${path}`));
    assert.equal(other.status, 302, `other host ${path}`);
    assert.equal(other.headers.get("Location"), `${HUB}${path}`);
  }
  // The admin API never answers off the hub in production (404 JSON, never a redirect).
  for (const path of ["/api/admin/me", "/api/admin/settings"]) {
    const res = await site.fetch(req(`${COURSE_HOST}${path}`, { cookie: admin }));
    assert.equal(res.status, 404, path);
    assert.match(res.headers.get("Content-Type") ?? "", /application\/json/);
  }
  // Admin pages on the hub are private: never framed, never indexed.
  const page = await site.fetch(req(`${HUB}/admin/settings`));
  assert.equal(page.headers.get("X-Frame-Options"), "DENY");
  assert.equal(page.headers.get("X-Robots-Tag"), "noindex, nofollow");

  // A preview deployment (APP_ENV=preview on *.pages.dev) serves the admin on its own host, and
  // still names the production hub and domain for course addresses.
  env.APP_ENV = "preview";
  const preview = "https://integration.feelings-courses.pages.dev";
  const login = await site.fetch(req(`${preview}/api/admin/login`, { body: { password: PASSWORD }, ip: "198.51.100.10" }));
  assert.equal(login.status, 200);
  const previewCookie = `__Host-fbc_admin=${cookiesFrom(login)["__Host-fbc_admin"].value}`;
  const previewMe = await site.fetch(req(`${preview}/api/admin/me`, { cookie: previewCookie }));
  assert.equal(previewMe.status, 200);
  const pm = await readJson(previewMe);
  assert.equal(pm.appEnv, "preview");
  assert.equal(pm.hubHost, "courses.feelingsbeautycare.in");
  assert.equal(previewMe.headers.get("X-Robots-Tag"), "noindex, nofollow");
});

test("payments drawer: Refund, Re-check with Razorpay and Replay are live (W2)", async (t) => {
  const ctx = await setup(t);
  const { site, db, clock } = ctx;
  const { placed } = await buy(ctx);
  clock.advance(HOUR);
  const admin = await adminCookie(site);

  // The drawer loads the order and decides what to offer with W6's refundState.
  const order = await readJson(await site.fetch(asAdmin(`/api/admin/orders/${placed.ref}`, admin)));
  const state = refundState(order, clock.now());
  assert.equal(state.can, true);
  assert.equal(state.remaining, 149900);
  assert.equal(state.until, order.paidAt + 24 * HOUR);
  // An empty amount is a full refund: the form sends no amountPaise.
  const form = readRefundForm("", "Couldn't attend", state.remaining);
  assert.deepEqual(form, { ok: true, amountPaise: undefined, reason: "Couldn't attend" });
  const refund = await site.fetch(asAdmin(`/api/admin/orders/${placed.ref}/refund`, admin, { body: { reason: form.reason, revoke: true } }));
  assert.equal(refund.status, 201);
  assert.equal((await readJson(refund)).status, "pending");

  // Re-check with Razorpay: W2's syncOrder settles the refund; the answer has the same shape as the
  // drawer's GET, so the drawer can render it directly.
  const paymentId = order.razorpayPaymentId;
  ctx.routes[`GET /v1/payments/${paymentId}/refunds`] = { entity: "collection", count: 1, items: [{ ...ctx.refunds[0], status: "processed" }] };
  const sync = await site.fetch(asAdmin(`/api/admin/orders/${placed.ref}/sync`, admin, { method: "POST" }));
  assert.equal(sync.status, 200, `sync: ${sync.status}`);
  const synced = await readJson(sync);
  assert.equal(synced.status, "refunded");
  assert.deepEqual(synced, await readJson(await site.fetch(asAdmin(`/api/admin/orders/${placed.ref}`, admin))));
  assert.deepEqual(refundState(synced, clock.now()), { can: false, reason: "Already refunded in full." });

  // Razorpay's own webhook for the same refund arrives later; Replay processes it again safely.
  const hook = webhook("refund.processed", { refund: { ...ctx.refunds[0], status: "processed" } }, ENV.RAZORPAY_WEBHOOK_SECRET);
  assert.equal((await site.fetch(req(`${HUB}/api/razorpay/webhook`, { method: "POST", body: hook.body, headers: hook.headers, origin: null }))).status, 200);
  const events = await readJson(await site.fetch(asAdmin("/api/admin/webhooks", admin)));
  assert.equal(events.length, 1);
  const replay = await site.fetch(asAdmin(`/api/admin/webhooks/${encodeURIComponent(events[0].eventId)}/replay`, admin, { method: "POST" }));
  assert.equal(replay.status, 200, `replay: ${replay.status}`);
  assert.deepEqual(await readJson(replay), { ok: true });
  assert.deepEqual({ ...db.get("SELECT status, refunded_paise FROM orders WHERE id = ?", placed.ref) }, { status: "refunded", refunded_paise: 149900 }, "counted once");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'webhook.replay'").n, 1);
});

test("student drawer: the one-time sign-in link and certificates are live (W3)", async (t) => {
  const ctx = await setup(t);
  const { site, db } = ctx;
  await buy(ctx);
  const admin = await adminCookie(site);

  const list = await readJson(await site.fetch(asAdmin("/api/admin/students?q=98765%2043210", admin)));
  assert.equal(list.items.length, 1, "phone digits find the student however they are typed");
  const id = list.items[0].id;

  // "Send a sign-in link": W3's link on the hub, and a WhatsApp message to the student's number.
  const link = await site.fetch(asAdmin(`/api/admin/students/${id}/access-link`, admin, { method: "POST" }));
  assert.equal(link.status, 200);
  const sent = await readJson(link);
  assert.match(sent.url, /^https:\/\/courses\.feelingsbeautycare\.in\/auth\/continue\?t=[A-Za-z0-9_-]{43}$/);
  assert.match(sent.whatsappUrl, /^https:\/\/wa\.me\/919876543210\?text=/);
  // Opening it shows a confirm page (link previews can't use it up); the button signs in.
  const confirm = await site.fetch(req(sent.url));
  assert.equal(confirm.status, 200);
  assert.equal(cookiesFrom(confirm)["__Host-fbc_s"], undefined);
  const token = new URL(sent.url).searchParams.get("t");
  const signed = await site.fetch(
    req(`${HUB}/auth/continue`, { method: "POST", body: new URLSearchParams({ t: token }).toString(), headers: { "Content-Type": "application/x-www-form-urlencoded" } }),
  );
  assert.equal(signed.status, 303);
  const cookie = cookieHeader(signed);
  assert.ok(cookie, "the link signs the student in");
  assert.equal((await site.fetch(req(`${HUB}/learn/glow`, { cookie }))).status, 200);

  // "Issue a certificate": W3 issues it with the admin as the actor; the drawer lists it with its
  // public check page.
  const issued = await site.fetch(asAdmin(`/api/admin/students/${id}/certificate`, admin, { body: { courseId: 30, name: "Asha R. Patel" } }));
  assert.equal(issued.status, 201, `certificate: ${issued.status}`);
  const certificate = await readJson(issued);
  assert.equal(certificate.nameOnCertificate, "Asha R. Patel");
  assert.match(certificate.verifyUrl, new RegExp(`^${HUB}/verify/[0-9A-Z]{10}$`));
  const student = await readJson(await site.fetch(asAdmin(`/api/admin/students/${id}`, admin)));
  assert.deepEqual(student.certificates.map((c) => c.code), [certificate.code]);
  assert.equal((await site.fetch(req(certificate.verifyUrl))).status, 200);
  assert.deepEqual(
    db.rows("SELECT actor FROM audit_log WHERE action = 'certificate.issue'").map((r) => r.actor),
    ["admin"],
  );
});

test("settings: the backup panel runs a backup, shows its time and downloads the newest", async (t) => {
  const ctx = await setup(t);
  const { site, env, clock } = ctx;
  const admin = await adminCookie(site);
  await Promise.all(site.waitUntil); // the daily job's own backup
  // With no copy in storage, the download says so in words the panel shows as is.
  for (const o of (await env.MEDIA.list({ prefix: "backups/" })).objects) await env.MEDIA.delete(o.key);
  const none = await site.fetch(asAdmin("/api/admin/backup", admin));
  assert.equal(none.status, 404);
  const view = describeError({ status: 404, code: "not_found", message: (await readJson(none)).message, retryAfter: null }, "the backup");
  assert.equal(view.message, "There is no backup yet. Run one first.");

  clock.advance(120);
  // "Back up now" sends no body (the admin's call() for an E<None, …> endpoint).
  const run = await site.fetch(asAdmin("/api/admin/backup/run", admin, { method: "POST" }));
  assert.equal(run.status, 200, `run: ${run.status}`);
  const result = await readJson(run);
  const settings = await readJson(await site.fetch(asAdmin("/api/admin/settings", admin)));
  assert.equal(settings.lastBackupAt, result.at, "the panel's 'last copy' is the run's time");
  const file = await site.fetch(asAdmin("/api/admin/backup", admin));
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("Content-Disposition"), `attachment; filename="${result.key.slice("backups/d1/".length)}"`);
});

test("one rule each: uploads, phones and the GSTIN are checked the same way in the admin and on the server", () => {
  // W6's file picker uses W4's table itself.
  for (const kind of Object.keys(MEDIA_RULES)) {
    assert.equal(UPLOAD_RULES[kind].types, MEDIA_RULES[kind].types, kind);
    assert.equal(UPLOAD_RULES[kind].maxBytes, MEDIA_RULES[kind].maxBytes, kind);
  }
  const files = [
    ["video", { name: "lesson.mp4", type: "video/mp4", size: 5e6 }],
    ["video", { name: "lesson.m4v", type: "", size: 5e6 }],
    ["video", { name: "iphone.mov", type: "video/quicktime", size: 5e6 }],
    ["video", { name: "huge.mp4", type: "video/mp4", size: MEDIA_RULES.video.maxBytes + 1 }],
    ["image", { name: "cover.jpeg", type: "image/jpeg", size: 2e6 }],
    ["image", { name: "logo.svg", type: "image/svg+xml", size: 2e3 }],
    ["captions", { name: "hi.vtt", type: "text/vtt", size: 2e3 }],
    ["file", { name: "notes.pdf", type: "application/pdf", size: 51 * 1024 * 1024 }],
  ];
  for (const [kind, f] of files) {
    const admin = fileProblem(f, kind) === null;
    let server = true;
    try {
      planUpload({ kind, filename: f.name, size: f.size, contentType: f.type || Object.keys(MEDIA_RULES[kind].types)[0] });
    } catch {
      server = false;
    }
    assert.equal(admin, server, `${kind} ${f.name}`);
  }

  for (const input of ["98250 12345", "+91 98250-12345", "09825012345", "+447700900123", "12345", "+911234567890", ""]) {
    const expected = adminPhone(input);
    assert.equal(checkoutPhone(input), expected, input);
    let data = null;
    try {
      data = dataPhone(input);
    } catch {
      data = null;
    }
    assert.equal(data, expected, input);
  }

  const business = { name: "Feelings", legalName: "Feelings Beauty Care", address: "Jamnagar", stateCode: "24", phone: "9825012345" };
  for (const gstin of ["24ABCDE1234F1Z5", "24abcde1234f1z5", "24ABCDE1234F1Z", "GSTIN"]) {
    let server = true;
    try {
      validateBusiness({ ...business, gstin });
    } catch {
      server = false;
    }
    assert.equal(gstinProblem(gstin) === null, server, gstin);
  }
});
