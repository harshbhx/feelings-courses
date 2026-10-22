// W5 batches, students (list, detail, add, grant, revoke, erase, export), payments (list, detail,
// export, refund validation), coupons, settings (GSTIN never logged), stats and the audit log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { csvCell, rupees, toCsv } from "../../functions/_lib/admin/csv.ts";
import { maskPhone } from "../../functions/_lib/admin/request.ts";
import {
  accessLinkRoute,
  auditRoute,
  batchRoute,
  couponRoute,
  couponsRoute,
  courseBatchesRoute,
  enrollmentRoute,
  eraseRoute,
  grantRoute,
  orderRoute,
  ordersCsvRoute,
  ordersRoute,
  refundRoute,
  settingsRoute,
  signoutAllRoute,
  statsRoute,
  studentRoute,
  studentsCsvRoute,
  studentsRoute,
  webhooksRoute,
} from "../../functions/_lib/admin/routes.ts";
import { addPaidOrder, addStudentRow, adminFixture } from "./fixtures.mjs";

const BATCH = { title: "November weekend batch", startsOn: "2026-11-07", endsOn: "2026-11-29", scheduleText: "Sat-Sun 11-4", seats: 2 };

test("batches: only for in-person courses, dates and seats checked, booked ones can't be deleted", async () => {
  const t = await adminFixture();
  const online = await t.call(courseBatchesRoute, "POST", "/", { params: { id: "1" }, body: BATCH });
  assert.equal(online.status, 400, "the demo course is recorded only");

  const made = await t.call(courseBatchesRoute, "POST", "/", { params: { id: "2" }, body: BATCH });
  assert.equal(made.status, 201);
  assert.equal(made.body.status, "open");
  assert.equal(made.body.seatsTaken, 0);
  const id = String(made.body.id);

  const bad = async (body, field) => {
    const r = await t.call(batchRoute, "PUT", "/", { params: { id }, body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(r.body.fields[field], JSON.stringify(r.body));
  };
  await bad({ startsOn: "2026-02-30" }, "startsOn");
  await bad({ endsOn: "2026-11-01" }, "endsOn");
  await bad({ status: "full" }, "status");
  await bad({ pricePaise: 99 }, "pricePaise");

  const listed = await t.call(courseBatchesRoute, "GET", "/", { params: { id: "2" } });
  assert.equal(listed.body.length, 1);

  // Somebody booked it: seats can't drop below that, and it can't be deleted.
  const s = addStudentRow(t.db);
  const grant = await t.call(grantRoute, "POST", "/", { params: { id: String(s) }, body: { courseId: 2, batchId: Number(id) } });
  assert.equal(grant.status, 201, JSON.stringify(grant.body));
  assert.equal(t.db.get("SELECT seats_taken FROM batches WHERE id = ?", Number(id)).seats_taken, 1);
  t.db.sqlite.exec(`UPDATE batches SET seats_taken = 2 WHERE id = ${id}`);
  await bad({ seats: 1 }, "seats");
  const del = await t.call(batchRoute, "DELETE", "/", { params: { id } });
  assert.equal(del.status, 409);
  const closed = await t.call(batchRoute, "PUT", "/", { params: { id }, body: { status: "closed" } });
  assert.equal(closed.body.status, "closed");

  const empty = await t.call(courseBatchesRoute, "POST", "/", { params: { id: "2" }, body: { ...BATCH, title: "Spare" } });
  assert.equal((await t.call(batchRoute, "DELETE", "/", { params: { id: String(empty.body.id) } })).status, 204);
});

test("students: masked list, search by name or digits, course filter, full detail", async () => {
  const t = await adminFixture();
  const riya = addStudentRow(t.db, { name: "Riya Shah", phone: "+919876543210", email: "riya@example.com", createdAt: 1_760_000_000 });
  const mehul = addStudentRow(t.db, { name: "Mehul Joshi", phone: "+919800011122", createdAt: 1_760_000_500 });
  addPaidOrder(t.db, { studentId: riya, courseId: 1, amount: 299_900 });
  addPaidOrder(t.db, { studentId: mehul, courseId: 1, amount: 299_900, mode: "test" });

  const list = await t.call(studentsRoute, "GET", "/api/admin/students");
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 2);
  assert.deepEqual(list.body.items.map((s) => s.id), [mehul, riya], "newest first");
  const row = list.body.items.find((s) => s.id === riya);
  assert.equal(row.phoneMasked, "+91 ••••• •3210");
  assert.equal(JSON.stringify(list.body).includes("9876543210"), false, "no full phone in the list");
  assert.equal(row.paidPaise, 299_900);
  assert.equal(row.enrollments, 1);

  const byName = await t.call(studentsRoute, "GET", "/api/admin/students?q=riya");
  assert.deepEqual(byName.body.items.map((s) => s.id), [riya]);
  const byDigits = await t.call(studentsRoute, "GET", "/api/admin/students?q=98000%2011");
  assert.deepEqual(byDigits.body.items.map((s) => s.id), [mehul]);
  const wildcard = await t.call(studentsRoute, "GET", "/api/admin/students?q=%25");
  assert.equal(wildcard.body.total, 0, "% is searched literally");
  const byCourse = await t.call(studentsRoute, "GET", "/api/admin/students?course=2");
  assert.equal(byCourse.body.total, 0);
  assert.equal((await t.call(studentsRoute, "GET", "/api/admin/students?page=0")).status, 400);

  const detail = await t.call(studentRoute, "GET", "/", { params: { id: String(riya) } });
  assert.equal(detail.body.phone, "+919876543210");
  assert.equal(detail.body.enrollments.length, 1);
  assert.equal(detail.body.enrollments[0].active, true);
  assert.equal(detail.body.orders[0].refundableUntil, detail.body.orders[0].paidAt + 86_400, "24-hour refund window");

  // Live mode: test payments neither count as paid nor give access.
  const live = await adminFixture({ RAZORPAY_KEY_ID: "rzp_live_abc123" });
  const m = addStudentRow(live.db, { phone: "+919800011122" });
  addPaidOrder(live.db, { studentId: m, mode: "test" });
  const liveRow = (await live.call(studentsRoute, "GET", "/api/admin/students")).body.items[0];
  assert.equal(liveRow.paidPaise, 0);
  const liveDetail = await live.call(studentRoute, "GET", "/", { params: { id: String(m) } });
  assert.equal(liveDetail.body.enrollments[0].active, false);
});

test("students: add, grant with the course's 1-year default, revoke and reopen", async () => {
  const t = await adminFixture();
  const added = await t.call(studentsRoute, "POST", "/api/admin/students", {
    body: { name: "Kavya", phone: "98250 12345", email: "Kavya@Example.com", courseId: 1 },
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.phone, "+919825012345");
  assert.equal(added.body.email, "kavya@example.com");
  const e = added.body.enrollments[0];
  assert.equal(e.source, "manual");
  assert.equal(e.mode, "live", "manual access is real access");
  assert.equal(e.expiresAt - e.startsAt, 365 * 86_400);

  const dup = await t.call(studentsRoute, "POST", "/api/admin/students", { body: { name: "Again", phone: "+919825012345" } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, "student_exists");
  const badPhone = await t.call(studentsRoute, "POST", "/api/admin/students", { body: { name: "X", phone: "12345" } });
  assert.equal(badPhone.status, 400);

  const id = String(added.body.id);
  const again = await t.call(grantRoute, "POST", "/", { params: { id }, body: { courseId: 1 } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "already_enrolled");
  const past = await t.call(grantRoute, "POST", "/", { params: { id }, body: { courseId: 2, expiresAt: 1000 } });
  assert.equal(past.status, 400);
  const forever = await t.call(grantRoute, "POST", "/", { params: { id }, body: { courseId: 2, expiresAt: null } });
  assert.equal(forever.status, 201);
  assert.equal(forever.body.expiresAt, null);
  const wrongBatch = await t.call(grantRoute, "POST", "/", { params: { id }, body: { courseId: 3, batchId: 999 } });
  assert.equal(wrongBatch.status, 400);

  const revoke = await t.call(enrollmentRoute, "DELETE", "/", { params: { id: String(e.id) } });
  assert.equal(revoke.status, 204);
  const after = await t.call(studentRoute, "GET", "/", { params: { id } });
  assert.equal(after.body.enrollments.find((x) => x.id === e.id).active, false);
  assert.equal((await t.call(enrollmentRoute, "DELETE", "/", { params: { id: String(e.id) } })).status, 204, "idempotent");
  const reopened = await t.call(grantRoute, "POST", "/", { params: { id }, body: { courseId: 1 } });
  assert.equal(reopened.status, 201);
  assert.equal(reopened.body.id, e.id, "same enrollment row, reopened");
  assert.equal(reopened.body.active, true);
  const actions = t.db.rows("SELECT action FROM audit_log WHERE entity = 'enrollment' ORDER BY id").map((r) => r.action);
  assert.deepEqual(actions, ["enrollment.grant", "enrollment.revoke", "enrollment.grant"]);
});

test("students: sign-out everywhere, access link (W3 stub), and erase", async () => {
  const t = await adminFixture();
  const s = addStudentRow(t.db, { email: "riya@example.com" });
  const orderId = addPaidOrder(t.db, { studentId: s });
  t.db.sqlite.exec(
    `INSERT INTO sessions (token_hash, student_id, created_at, last_seen_at, expires_at) VALUES ('${"a".repeat(64)}', ${s}, 1, 1, 9999999999);` +
      `INSERT INTO certificates (code, student_id, course_id, name_on_cert, title, issued_at) VALUES ('ABCDEFGHJK', ${s}, 1, 'Riya Shah', 'Certificate', 1);`,
  );
  const id = String(s);
  assert.equal((await t.call(signoutAllRoute, "POST", "/", { params: { id } })).status, 204);
  assert.ok(t.db.get("SELECT revoked_at FROM sessions WHERE student_id = ?", s).revoked_at > 0);

  // Integration: W3's access-link.ts makes the link; one audit row with the admin as actor.
  const link = await t.call(accessLinkRoute, "POST", "/", { params: { id } });
  assert.equal(link.status, 200);
  assert.match(link.body.url, /^https:\/\/courses\.feelingsbeautycare\.in\/auth\/continue\?t=[A-Za-z0-9_-]{43}$/);
  assert.match(link.body.whatsappUrl, /^https:\/\/wa\.me\/919876543210\?text=/);
  assert.deepEqual(
    t.db.rows("SELECT actor FROM audit_log WHERE action = 'student.access_link'").map((r) => r.actor),
    ["admin"],
  );
  assert.equal((await t.call(accessLinkRoute, "POST", "/", { params: { id: "999" } })).status, 404);

  const noConfirm = await t.call(eraseRoute, "POST", "/", { params: { id }, body: {} });
  assert.equal(noConfirm.status, 400);
  const erased = await t.call(eraseRoute, "POST", "/", { params: { id }, body: { confirm: true } });
  assert.equal(erased.status, 200);
  assert.equal(erased.body.name, null);
  assert.equal(erased.body.phone, null);
  assert.equal(erased.body.email, null);
  assert.ok(erased.body.erasedAt > 0);
  const order = t.db.get("SELECT amount_paise, payer_contact, payer_email, invoice_no FROM orders WHERE id = ?", orderId);
  assert.equal(order.amount_paise, 299_900, "amounts stay");
  assert.ok(order.invoice_no);
  assert.equal(order.payer_contact, null);
  assert.equal(order.payer_email, null);
  assert.equal(erased.body.enrollments[0].active, false);
  assert.equal(erased.body.certificates[0].nameOnCertificate, "Erased");
  assert.ok(erased.body.certificates[0].revokedAt > 0);
  const dump = JSON.stringify(t.db.rows("SELECT * FROM students")) + JSON.stringify(t.db.rows("SELECT * FROM certificates"));
  assert.equal(dump.includes("Riya") || dump.includes("9876543210") || dump.includes("riya@"), false);
  const grantAfter = await t.call(grantRoute, "POST", "/", { params: { id }, body: { courseId: 2 } });
  assert.equal(grantAfter.status, 409);
});

test("exports: CSV with a BOM, full phones, rupees, and formula injection defused", async () => {
  assert.equal(csvCell("=HYPERLINK(\"http://x\")"), "\"'=HYPERLINK(\"\"http://x\"\")\"");
  assert.equal(csvCell("+91 98"), "'+91 98");
  assert.equal(csvCell("-12"), "-12", "plain negative numbers stay numbers");
  assert.equal(csvCell("@sum"), "'@sum");
  assert.equal(csvCell("a,b"), "\"a,b\"");
  assert.equal(csvCell(null), "");
  assert.equal(rupees(299_900), "2999.00");
  assert.equal(rupees(5), "0.05");
  assert.equal(toCsv(["a"], [[1]]), "﻿a\r\n1\r\n");
  assert.equal(maskPhone("+14155550123"), "+1 •••• 0123");

  const t = await adminFixture();
  const s = addStudentRow(t.db, { name: "=cmd|'/c calc'!A1" });
  addPaidOrder(t.db, { studentId: s });
  const students = await t.call(studentsCsvRoute, "GET", "/api/admin/students.csv");
  assert.equal(students.status, 200);
  assert.match(students.res.headers.get("Content-Type"), /^text\/csv/);
  assert.match(students.res.headers.get("Content-Disposition"), /attachment; filename="students.csv"/);
  assert.equal(students.res.headers.get("Cache-Control"), "no-store");
  assert.ok(students.body.includes("+919876543210"));
  assert.ok(students.body.includes("'=cmd"));
  const payments = await t.call(ordersCsvRoute, "GET", "/api/admin/orders.csv?status=paid");
  assert.equal(payments.status, 200);
  const [header, first] = payments.body.replace("﻿", "").split("\r\n");
  assert.ok(header.startsWith("Order,Invoice no,"));
  assert.equal(/gst|tax/i.test(header), false, "no tax columns (owner decision)");
  assert.ok(first.includes("2999.00"));
  assert.equal(t.db.get("SELECT count(*) AS n FROM audit_log WHERE action IN ('student.export', 'order.export')").n, 2);
});

test("payments: filters, paging, detail with refunds, and refund input checks", async () => {
  const t = await adminFixture();
  const s = addStudentRow(t.db);
  const o1 = addPaidOrder(t.db, { studentId: s, courseId: 1, paidAt: 1_761_000_000 });
  const s2 = addStudentRow(t.db, { phone: "+919811111111" });
  addPaidOrder(t.db, { studentId: s2, courseId: 1, paidAt: 1_762_000_000 });
  t.db.sqlite.exec(
    `UPDATE orders SET status = 'partially_refunded', refunded_paise = 10000 WHERE id = ${o1};` +
      `INSERT INTO refunds (order_id, razorpay_refund_id, amount_paise, status, reason, revoke_access, created_at, updated_at) VALUES (${o1}, 'rfnd_1', 10000, 'processed', 'goodwill', 0, 1, 1);`,
  );
  const all = await t.call(ordersRoute, "GET", "/api/admin/orders");
  assert.equal(all.body.total, 2);
  assert.equal(all.body.items[0].paidAt, 1_762_000_000, "newest first");
  assert.equal(all.body.items[0].studentPhoneMasked, "+91 ••••• •1111");
  const part = await t.call(ordersRoute, "GET", "/api/admin/orders?status=partially_refunded");
  assert.equal(part.body.total, 1);
  assert.equal(part.body.items[0].refunds[0].razorpayRefundId, "rfnd_1");
  // 2025-10-21 India time contains paidAt 1_761_000_000 - 60 (created_at).
  const day = await t.call(ordersRoute, "GET", "/api/admin/orders?from=2025-10-21&to=2025-10-21");
  assert.equal(day.body.total, 1);
  assert.equal((await t.call(ordersRoute, "GET", "/api/admin/orders?from=2025-10-22&to=2025-10-21")).status, 400);
  assert.equal((await t.call(ordersRoute, "GET", "/api/admin/orders?status=bogus")).status, 400);

  const one = await t.call(orderRoute, "GET", "/", { params: { id: String(o1) } });
  assert.equal(one.body.refunds.length, 1);
  assert.equal(one.body.invoiceNo.startsWith("FBC/"), true);
  assert.equal((await t.call(orderRoute, "GET", "/", { params: { id: "999" } })).status, 404);

  const noReason = await t.call(refundRoute, "POST", "/", { params: { id: String(o1) }, body: { revoke: true } });
  assert.equal(noReason.status, 400);
  const noRevoke = await t.call(refundRoute, "POST", "/", { params: { id: String(o1) }, body: { reason: "asked" } });
  assert.equal(noRevoke.status, 400);
  // Integration: W2's refundOrder. Without Razorpay keys it can't refund (tests/integration covers a real one).
  const noKeys = await t.call(refundRoute, "POST", "/", { params: { id: String(o1) }, body: { reason: "asked", revoke: true } });
  assert.equal(noKeys.status, 503);
  assert.equal((await t.call(refundRoute, "POST", "/", { params: { id: "999" }, body: { reason: "x", revoke: true } })).status, 404);

  t.db.sqlite.exec(
    "INSERT INTO webhook_events (event_id, type, mode, payload, received_at) VALUES ('evt_1', 'payment.captured', 'test', '{}', 5);" +
      "INSERT INTO webhook_events (event_id, type, mode, payload, received_at, processed_at) VALUES ('evt_2', 'order.paid', 'test', '{}', 6, 7);",
  );
  const pending = await t.call(webhooksRoute, "GET", "/api/admin/webhooks?pending=1");
  assert.deepEqual(pending.body.map((w) => w.eventId), ["evt_1"]);
  assert.equal(JSON.stringify(pending.body).includes("payload"), false, "payloads stay in D1");
});

test("coupons: one kind of discount, unique codes, used ones are kept", async () => {
  const t = await adminFixture();
  const made = await t.call(couponsRoute, "POST", "/api/admin/coupons", { body: { code: " diwali20 ", percentOff: 20, courseId: 1, maxUses: 50 } });
  assert.equal(made.status, 201);
  assert.equal(made.body.code, "DIWALI20");
  assert.equal(made.body.active, true);
  assert.equal(made.body.allowFree, false);
  const id = String(made.body.id);

  const bad = async (body, field) => {
    const r = await t.call(couponsRoute, "POST", "/api/admin/coupons", { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(r.body.fields[field], JSON.stringify(r.body));
  };
  await bad({ code: "BOTH", percentOff: 10, amountOffPaise: 10_000 }, "percentOff");
  await bad({ code: "NONE" }, "percentOff");
  await bad({ code: "X", percentOff: 10 }, "code");
  await bad({ code: "HUGE", percentOff: 101 }, "percentOff");
  await bad({ code: "TINY", amountOffPaise: 50 }, "amountOffPaise");
  await bad({ code: "DATES", percentOff: 10, startsAt: 2000, expiresAt: 1000 }, "expiresAt");
  await bad({ code: "NOCOURSE", percentOff: 10, courseId: 99 }, "courseId");
  const dup = await t.call(couponsRoute, "POST", "/api/admin/coupons", { body: { code: "Diwali20", amountOffPaise: 10_000 } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, "code_taken");

  const switched = await t.call(couponRoute, "PUT", "/", { params: { id }, body: { amountOffPaise: 50_000 } });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.percentOff, null, "switching kind clears the other");
  assert.equal(switched.body.amountOffPaise, 50_000);

  t.db.sqlite.exec(`UPDATE coupons SET used_count = 3 WHERE id = ${id}`);
  const below = await t.call(couponRoute, "PUT", "/", { params: { id }, body: { maxUses: 2 } });
  assert.equal(below.status, 400);
  const rename = await t.call(couponRoute, "PUT", "/", { params: { id }, body: { code: "NEWCODE" } });
  assert.equal(rename.status, 409);
  const del = await t.call(couponRoute, "DELETE", "/", { params: { id } });
  assert.equal(del.status, 409);
  assert.equal(del.body.error, "coupon_used");
  const off = await t.call(couponRoute, "PUT", "/", { params: { id }, body: { active: false } });
  assert.equal(off.body.active, false);

  const unused = await t.call(couponsRoute, "POST", "/api/admin/coupons", { body: { code: "SPARE", percentOff: 5 } });
  assert.equal((await t.call(couponRoute, "DELETE", "/", { params: { id: String(unused.body.id) } })).status, 204);
  const list = await t.call(couponsRoute, "GET", "/api/admin/coupons");
  assert.deepEqual(list.body.map((c) => c.code), ["DIWALI20"]);
});

test("settings: business facts validated, GSTIN stored but never logged, legal confirmation", async () => {
  const t = await adminFixture({ RAZORPAY_KEY_ID: "rzp_test_abc123" });
  const got = await t.call(settingsRoute, "GET", "/api/admin/settings");
  assert.equal(got.status, 200);
  assert.equal(got.body.business.name, "Feelings Beauty Care");
  assert.equal(got.body.business.gstin, null);
  assert.equal(got.body.legalConfirmed, false);
  assert.equal(got.body.paymentMode, "test");
  assert.equal(got.body.passwordChanged, false);

  const business = { ...got.body.business, gstin: "24abcde1234f1z5", whatsapp: "" };
  const bad = await t.call(settingsRoute, "PUT", "/api/admin/settings", { body: { business: { ...business, gstin: "NOT-A-GSTIN" } } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.fields["business.gstin"]);
  const badState = await t.call(settingsRoute, "PUT", "/api/admin/settings", { body: { business: { ...business, stateCode: "Gujarat" } } });
  assert.equal(badState.status, 400);

  const v0 = Number(t.db.get("SELECT value FROM settings WHERE key = 'content_version'").value);
  const saved = await t.call(settingsRoute, "PUT", "/api/admin/settings", { body: { business, legalConfirmed: true } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.business.gstin, "24ABCDE1234F1Z5");
  assert.equal(saved.body.business.whatsapp, "918000661578", "WhatsApp defaults to the phone");
  assert.equal(saved.body.legalConfirmed, true);
  assert.equal(Number(t.db.get("SELECT value FROM settings WHERE key = 'content_version'").value), v0 + 1);
  const log = t.db.get("SELECT data FROM audit_log WHERE action = 'settings.update'").data;
  assert.deepEqual(JSON.parse(log), { business: ["gstin"], legalConfirmed: true });
  assert.equal(log.includes("24ABCDE"), false, "the GSTIN's value is never logged");

  assert.equal((await t.call(settingsRoute, "PUT", "/api/admin/settings", { body: {} })).status, 400);
});

test("stats and the audit log", async () => {
  const t = await adminFixture();
  t.db.sqlite.exec(
    "INSERT INTO daily_stats (day, course_id, views, paid_orders, revenue_paise) VALUES ('2026-10-01', 1, 10, 1, 299900), ('2026-10-01', 0, 5, 0, 0), ('2026-10-02', 1, 3, 0, 0);",
  );
  const all = await t.call(statsRoute, "GET", "/api/admin/stats?from=2026-10-01&to=2026-10-31");
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.series.map((d) => [d.day, d.views]), [["2026-10-01", 15], ["2026-10-02", 3]]);
  assert.equal(all.body.totals.revenuePaise, 299_900);
  const course = await t.call(statsRoute, "GET", "/api/admin/stats?from=2026-10-01&to=2026-10-31&course=1");
  assert.equal(course.body.totals.views, 13);
  assert.equal((await t.call(statsRoute, "GET", "/api/admin/stats?from=2020-01-01&to=2026-01-01")).status, 400);

  await t.call(couponsRoute, "POST", "/api/admin/coupons", { body: { code: "AUDITME", percentOff: 5 } });
  const coupons = await t.call(auditRoute, "GET", "/api/admin/audit?entity=coupon");
  assert.equal(coupons.body.length, 1);
  assert.equal(coupons.body[0].action, "coupon.create");
  assert.equal(coupons.body[0].actor, "admin");
  const everything = await t.call(auditRoute, "GET", "/api/admin/audit");
  assert.ok(everything.body.length >= 6, "seed rows, the sign-in and the coupon");
  const older = await t.call(auditRoute, "GET", `/api/admin/audit?before=${everything.body[0].id}`);
  assert.equal(older.body[0].id, everything.body[1].id);
  assert.equal((await t.call(auditRoute, "GET", "/api/admin/audit?entity=Bad!")).status, 400);
  assert.equal((await t.call(auditRoute, "GET", "/api/admin/audit?entityId=3")).status, 400);
});
