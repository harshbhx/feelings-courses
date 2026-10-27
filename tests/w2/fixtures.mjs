// W2 fixtures: a seeded test database with a few sellable courses, batches and coupons, an env with
// FAKE Razorpay keys (never real ones), and a fake Razorpay that creates orders on demand.
//
// Courses (besides the seed's demo course 1 'selfmakeup' and drafts 2-4):
//   10 'online-basics'  online,    ₹1,499.99, 365 days
//   11 'studio-batch'   in_person, ₹5,000 with a ₹1,000 booking amount
//   12 'hybrid-pro'     hybrid,    ₹8,000 (batch 121 costs ₹9,000)
//   13 'free-intro'     online,    free
//   14 'old-course'     published but deleted
// Batches: 111 open (2 seats), 112 full, 113 cancelled, 114 already over, 121 hybrid.
import { createTestDb } from "../helpers/d1.mjs";
import { fakeRazorpay, orderEntity, paymentEntity, signPayment } from "../helpers/razorpay.mjs";
import { postJson } from "../helpers/http.mjs";

/** 23 Oct 2026, 11:30 IST. */
export const NOW = Date.UTC(2026, 9, 23, 6, 0, 0) / 1000;
export const DAY = 86_400;

export const TEST_ENV = Object.freeze({
  RAZORPAY_KEY_ID: "rzp_test_FakeKeyId00001",
  RAZORPAY_KEY_SECRET: "fake_key_secret_for_tests_only",
  RAZORPAY_WEBHOOK_SECRET: "fake_webhook_secret_for_tests",
  APP_SECRET: "fake_app_secret_for_tests_only_0123456789",
});
export const LIVE_ENV = Object.freeze({ ...TEST_ENV, RAZORPAY_KEY_ID: "rzp_live_FakeKeyId00001" });

export async function setupDb({ legal = true } = {}) {
  const db = await createTestDb();
  const t = NOW - 30 * DAY;
  db.sqlite.exec(`
    INSERT INTO courses (id, slug, title, format, price_paise, deposit_paise, access_days, status, published_at, created_at, updated_at)
    VALUES
      (10, 'online-basics', 'Online Basics', 'online', 149999, NULL, 365, 'published', ${t}, ${t}, ${t}),
      (11, 'studio-batch', 'Studio Batch', 'in_person', 500000, 100000, NULL, 'published', ${t}, ${t}, ${t}),
      (12, 'hybrid-pro', 'Hybrid Pro', 'hybrid', 800000, NULL, 365, 'published', ${t}, ${t}, ${t}),
      (13, 'free-intro', 'Free Intro', 'online', 0, NULL, 30, 'published', ${t}, ${t}, ${t});
    INSERT INTO courses (id, slug, title, format, price_paise, status, published_at, created_at, updated_at, deleted_at)
    VALUES (14, 'old-course', 'Old', 'online', 10000, 'published', ${t}, ${t}, ${t}, ${t});
    INSERT INTO batches (id, course_id, title, starts_on, ends_on, price_paise, seats, seats_taken, status, created_at, updated_at)
    VALUES
      (111, 11, 'November mornings', '2026-11-02', '2026-11-20', NULL, 2, 0, 'open', ${t}, ${t}),
      (112, 11, 'Full batch', '2026-11-05', NULL, NULL, 1, 1, 'open', ${t}, ${t}),
      (113, 11, 'Cancelled', '2026-11-09', NULL, NULL, NULL, 0, 'cancelled', ${t}, ${t}),
      (114, 11, 'Over', '2026-09-01', '2026-09-30', NULL, NULL, 0, 'open', ${t}, ${t}),
      (121, 12, 'Weekend batch', '2026-12-05', NULL, 900000, NULL, 0, 'open', ${t}, ${t});
    INSERT INTO coupons (id, code, percent_off, amount_off_paise, course_id, max_uses, used_count, starts_at, expires_at, active, allow_free, created_at, updated_at)
    VALUES
      (1, 'SAVE20', 20, NULL, NULL, NULL, 0, NULL, NULL, 1, 0, ${t}, ${t}),
      (2, 'FLAT500', NULL, 50000, 10, NULL, 0, NULL, NULL, 1, 0, ${t}, ${t}),
      (3, 'FREEPASS', 100, NULL, NULL, 1, 0, NULL, NULL, 1, 1, ${t}, ${t}),
      (4, 'ALMOSTFREE', 100, NULL, NULL, NULL, 0, NULL, NULL, 1, 0, ${t}, ${t}),
      (5, 'OLD10', 10, NULL, NULL, NULL, 0, ${t}, ${NOW - DAY}, 1, 0, ${t}, ${t}),
      (6, 'LATER10', 10, NULL, NULL, NULL, 0, ${NOW + DAY}, NULL, 1, 0, ${t}, ${t}),
      (7, 'OFF10', 10, NULL, NULL, NULL, 0, NULL, NULL, 0, 0, ${t}, ${t}),
      (8, 'GONE10', 10, NULL, NULL, 1, 1, NULL, NULL, 1, 0, ${t}, ${t}),
      (9, 'BIG', NULL, 99999900, NULL, NULL, 0, NULL, NULL, 1, 0, ${t}, ${t});
    UPDATE settings SET value = '${legal ? "true" : "false"}' WHERE key = 'legal_confirmed';
  `);
  return db;
}

export const envFor = (db, base = TEST_ENV) => ({ ...base, DB: db });

/** A buyer's OrderRequest body. */
export const orderBody = (overrides = {}) => ({
  course: "online-basics",
  name: "Asha Patel",
  phone: "9876543210",
  email: "asha@example.com",
  consent: true,
  ...overrides,
});

export const orderRequest = (body = orderBody(), opts = {}) => postJson("/api/order", body, { ip: "203.0.113.7", ...opts });

/**
 * A fake Razorpay API: orders get ids order_Fake<n>; payments are looked up in `payments` (id →
 * entity overrides); refunds are recorded. Extra routes override.
 */
export function razorpay(t, { payments = {}, routes = {} } = {}) {
  let n = 0;
  const orders = [];
  const fake = fakeRazorpay(t, {
    "POST /v1/orders": (call) => {
      n += 1;
      const order = orderEntity({ id: `order_Fake${String(n).padStart(4, "0")}`, amount: call.body.amount, amount_due: call.body.amount, receipt: call.body.receipt, notes: call.body.notes });
      orders.push(order);
      return { body: order };
    },
    ...Object.fromEntries(
      Object.entries(payments).map(([id, overrides]) => [`GET /v1/payments/${id}`, paymentEntity({ id, ...overrides })]),
    ),
    ...routes,
  });
  return { ...fake, orders };
}

/** The checkout handler's body for a paid Razorpay order. */
export const verifyBody = (orderId, paymentId, secret = TEST_ENV.RAZORPAY_KEY_SECRET) => ({
  razorpay_order_id: orderId,
  razorpay_payment_id: paymentId,
  razorpay_signature: signPayment(orderId, paymentId, secret),
});

export { paymentEntity, orderEntity, signPayment };
