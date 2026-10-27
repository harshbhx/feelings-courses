// W2: server-side pricing (functions/_lib/pricing.ts quote()). Every number comes from D1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { quote, couponDiscount, couponLabel, formatRupees, normaliseCouponCode } from "../../functions/_lib/pricing.ts";
import { NOW, setupDb } from "./fixtures.mjs";

const q = (db, input) => quote(db, { now: NOW, ...input });

test("pricing: the course price from D1, no coupon", async () => {
  const db = await setupDb();
  assert.deepEqual(await q(db, { courseSlug: "online-basics" }), {
    ok: true,
    courseId: 10,
    batchId: null,
    couponId: null,
    paymentKind: "full",
    listPaise: 149999,
    discountPaise: 0,
    amountPaise: 149999,
    free: false,
    label: null,
  });
  // Slugs are case-insensitive on the way in, but nothing else is accepted.
  assert.equal((await q(db, { courseSlug: " Online-Basics " })).ok, true);
  assert.deepEqual(await q(db, { courseSlug: "nope" }), { ok: false, reason: "course_not_found" });
  assert.deepEqual(await q(db, { courseSlug: "x'; DROP TABLE courses; --" }), { ok: false, reason: "course_not_found" });
  assert.deepEqual(await q(db, { courseSlug: "old-course" }), { ok: false, reason: "course_not_found" });
  // Drafts without a fee (the academy seeds) are not for sale.
  assert.deepEqual(await q(db, { courseSlug: "diploma" }), { ok: false, reason: "course_not_for_sale" });
});

test("pricing: percent coupons round the discount down; amount coupons are capped; labels", async () => {
  const db = await setupDb();
  const save = await q(db, { courseSlug: "online-basics", couponCode: "save20" });
  assert.equal(save.discountPaise, 29999); // 20% of 149999 = 29999.8, rounded down
  assert.equal(save.amountPaise, 120000);
  assert.equal(save.couponId, 1);
  assert.equal(save.label, "20% off");
  const flat = await q(db, { courseSlug: "online-basics", couponCode: " FLAT500 " });
  assert.equal(flat.discountPaise, 50000);
  assert.equal(flat.amountPaise, 99999);
  assert.equal(flat.label, "₹500 off");
  assert.equal(couponDiscount({ percent_off: null, amount_off_paise: 900 }, 500), 500);
  assert.equal(couponLabel({ percent_off: null, amount_off_paise: 12345 }), "₹123.45 off");
  assert.equal(formatRupees(29990000), "₹2,99,900");
  assert.equal(normaliseCouponCode(" ab-1 "), "AB-1");
  assert.equal(normaliseCouponCode("a b"), null);
});

test("pricing: coupon rules", async () => {
  const db = await setupDb();
  const reason = async (code, courseSlug = "online-basics") => (await q(db, { courseSlug, couponCode: code })).reason;
  assert.equal(await reason("NOPE"), "coupon_not_found");
  assert.equal(await reason("<script>"), "coupon_not_found");
  assert.equal(await reason("OLD10"), "coupon_expired");
  assert.equal(await reason("LATER10"), "coupon_not_started");
  assert.equal(await reason("OFF10"), "coupon_inactive");
  assert.equal(await reason("GONE10"), "coupon_used_up");
  assert.equal(await reason("FLAT500", "hybrid-pro"), "coupon_wrong_course");
  // An empty code means no coupon.
  assert.equal((await q(db, { courseSlug: "online-basics", couponCode: "  " })).couponId, null);
});

test("pricing: a coupon once per student", async () => {
  const db = await setupDb();
  db.sqlite.exec(`INSERT INTO students (id, name, phone, created_at, updated_at) VALUES (50, 'A', '+919876543210', ${NOW}, ${NOW});
    INSERT INTO coupon_redemptions (coupon_id, student_id, course_id, order_id, discount_paise, created_at) VALUES (1, 50, 12, NULL, 0, ${NOW});`);
  assert.equal((await q(db, { courseSlug: "online-basics", couponCode: "SAVE20", studentId: 50 })).reason, "coupon_already_used");
  assert.equal((await q(db, { courseSlug: "online-basics", couponCode: "SAVE20", studentId: 51 })).ok, true);
});

test("pricing: at least ₹1 unless an allow_free coupon makes it exactly free", async () => {
  const db = await setupDb();
  const almost = await q(db, { courseSlug: "online-basics", couponCode: "ALMOSTFREE" });
  assert.equal(almost.free, false);
  assert.equal(almost.amountPaise, 100);
  assert.equal(almost.discountPaise, 149899);
  const big = await q(db, { courseSlug: "online-basics", couponCode: "BIG" });
  assert.equal(big.amountPaise, 100);
  const free = await q(db, { courseSlug: "online-basics", couponCode: "FREEPASS" });
  assert.equal(free.free, true);
  assert.equal(free.amountPaise, 0);
  assert.equal(free.couponId, 3);
  // A course priced 0 is free; a coupon has nothing to do there.
  const intro = await q(db, { courseSlug: "free-intro", couponCode: "SAVE20" });
  assert.deepEqual([intro.free, intro.amountPaise, intro.couponId, intro.discountPaise], [true, 0, null, 0]);
});

test("pricing: batches for in-person and hybrid courses", async () => {
  const db = await setupDb();
  const reason = async (courseSlug, batchId) => (await q(db, { courseSlug, batchId })).reason;
  assert.equal(await reason("studio-batch", undefined), "batch_not_found"); // in-person needs a batch
  assert.equal(await reason("studio-batch", 112), "batch_full");
  assert.equal(await reason("studio-batch", 113), "batch_not_found"); // cancelled
  assert.equal(await reason("studio-batch", 114), "batch_not_found"); // over
  assert.equal(await reason("studio-batch", 121), "batch_not_found"); // another course's batch
  assert.equal(await reason("studio-batch", -1), "batch_not_found");
  assert.equal(await reason("online-basics", 111), "batch_not_found"); // online takes no batch

  // Booking amount: the deposit is charged, the rest is paid at the studio.
  const studio = await q(db, { courseSlug: "studio-batch", batchId: 111 });
  assert.deepEqual([studio.paymentKind, studio.listPaise, studio.amountPaise, studio.batchId], ["deposit", 500000, 100000, 111]);
  // A coupon that takes the price under the deposit: the lower amount, charged in full.
  db.sqlite.exec("UPDATE coupons SET percent_off = 90 WHERE id = 1");
  const cheap = await q(db, { courseSlug: "studio-batch", batchId: 111, couponCode: "SAVE20" });
  assert.deepEqual([cheap.paymentKind, cheap.amountPaise], ["full", 50000]);

  // Hybrid: a batch's own price, or the course price for recorded only.
  const hybridBatch = await q(db, { courseSlug: "hybrid-pro", batchId: 121 });
  assert.deepEqual([hybridBatch.listPaise, hybridBatch.paymentKind], [900000, "full"]);
  assert.equal((await q(db, { courseSlug: "hybrid-pro" })).listPaise, 800000);
});
