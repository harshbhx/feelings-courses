// A small "student" world for the learner-facing pages: three courses (recorded, studio batch plus
// recorded, studio only), a student part way through, one with nothing yet, paid orders with
// receipts, a certificate. Shared by tests/ux/learner-pages.test.mjs and
// scripts/preview-student-pages.mjs (which writes every state to static HTML for screenshots).
// Every secret here is made up.
import { createTestDb } from "../helpers/d1.mjs";
import { createFakeR2 } from "../helpers/r2.mjs";
import { createSession } from "../../functions/_lib/session.ts";
import { issueCertificate } from "../../functions/_lib/certificates.ts";

export const SITE = "https://courses.feelingsbeautycare.in";
/** 23 Oct 2026, 11:30 IST. */
export const NOW = Date.UTC(2026, 9, 23, 6, 0, 0) / 1000;
const DAY = 86_400;
export const SECRETS = Object.freeze({ APP_SECRET: "fake_ux_preview_app_secret_0123456789abcdef" });
export const KEY = "videos/2026/10/0123456789abcdef-skin-prep.mp4";

export async function createWorld() {
  const db = await createTestDb();
  const t = NOW - 40 * DAY;
  const paid = NOW - 3 * 3600;
  db.sqlite.exec(`
    UPDATE settings SET value = json_set(value, '$.whatsapp', '919876500000', '$.address', 'Jamnagar, Gujarat', '$.phone', '+91 98765 00000') WHERE key = 'business';
    INSERT INTO courses (id, slug, title, format, price_paise, deposit_paise, access_days, certificate_title, status, published_at, created_at, updated_at)
    VALUES
      (40, 'everyday-glow', 'Everyday Glow Makeup', 'online', 299900, NULL, 365, 'Certificate of completion: Everyday Glow Makeup', 'published', ${t}, ${t}, ${t}),
      (41, 'bridal-academy', 'Bridal Makeup Academy', 'hybrid', 2500000, 500000, 365, 'Bridal Makeup Academy certificate', 'published', ${t}, ${t}, ${t}),
      (42, 'saree-draping', 'Saree Draping Workshop', 'in_person', 300000, NULL, 365, NULL, 'published', ${t}, ${t}, ${t}),
      (43, 'old-class', 'Party Makeup (2025)', 'online', 100000, NULL, 365, NULL, 'published', ${t}, ${t}, ${t});
    INSERT INTO modules (id, course_id, position, title, created_at, updated_at) VALUES
      (400, 40, 1, 'Skin and base', ${t}, ${t}),
      (401, 40, 2, 'Eyes and brows', ${t}, ${t}),
      (402, 40, 3, 'Finishing touches', ${t}, ${t}),
      (410, 41, 1, 'Before the studio', ${t}, ${t}),
      (430, 43, 1, 'Party looks', ${t}, ${t});
    INSERT INTO lessons (id, course_id, module_id, position, slug, title, minutes, video_provider, video_ref, duration_seconds, notes, created_at, updated_at) VALUES
      (4001, 40, 400, 1, 'know-your-skin', 'Know your skin type', 8, 'r2', '${KEY}', 480, NULL, ${t}, ${t}),
      (4002, 40, 400, 2, 'skin-prep', 'Skin prep in five minutes', 6, 'r2', '${KEY}', 360, NULL, ${t}, ${t}),
      (4003, 40, 400, 3, 'foundation', 'Choosing and blending foundation', 12, 'r2', '${KEY}', 720, 'Start with a pea-sized amount and blend outwards from the centre of the face.

Check the match on your jawline in daylight, not on your hand.', ${t}, ${t}),
      (4004, 40, 401, 1, 'brows', 'Natural brows', 9, 'r2', '${KEY}', 540, NULL, ${t}, ${t}),
      (4005, 40, 401, 2, 'kajal', 'Kajal and liner', 10, 'none', NULL, NULL, NULL, ${t}, ${t}),
      (4006, 40, 402, 1, 'lips', 'Lip colour for your skin tone', 7, 'none', NULL, NULL, NULL, ${t}, ${t}),
      (4007, 40, 402, 2, 'setting', 'Setting it for the whole day', 6, 'none', NULL, NULL, NULL, ${t}, ${t}),
      (4101, 41, 410, 1, 'your-kit', 'Your bridal kit', 9, 'none', NULL, NULL, NULL, ${t}, ${t}),
      (4301, 43, 430, 1, 'party-eyes', 'Party eyes', 9, 'none', NULL, NULL, NULL, ${t}, ${t});
    INSERT INTO batches (id, course_id, title, starts_on, ends_on, schedule_text, status, created_at, updated_at) VALUES
      (411, 41, 'December weekday batch', '2026-12-01', '2026-12-19', 'Mon to Fri, 11 am to 2 pm', 'open', ${t}, ${t}),
      (421, 42, 'Sunday workshop', '2026-11-08', NULL, 'Sunday 8 Nov, 10 am to 1 pm', 'open', ${t}, ${t});

    INSERT INTO students (id, name, phone, email, created_at, updated_at) VALUES
      (1, 'Asha Patel', '+919876543210', 'asha@example.com', ${t}, ${t}),
      (2, 'Bina Shah', '+919812345678', NULL, ${t}, ${t});

    INSERT INTO coupons (id, code, percent_off, course_id, created_at, updated_at) VALUES (40, 'DIWALI10', 10, 40, ${t}, ${t});
    INSERT INTO orders (id, razorpay_order_id, mode, student_id, course_id, batch_id, coupon_id, payment_kind, list_price_paise, discount_paise, amount_paise, status,
                        razorpay_payment_id, method, invoice_no, refunded_paise, created_at, updated_at, paid_at)
    VALUES
      (1, 'order_UxGlow0000001', 'live', 1, 40, NULL, 40, 'full', 299900, 29990, 269910, 'paid', 'pay_UxGlowPayment001', 'upi', 'FBC/26-27/00012', 0, ${paid}, ${paid}, ${paid}),
      (2, 'order_UxSaree000001', 'live', 1, 42, 421, NULL, 'deposit', 300000, 0, 100000, 'paid', 'pay_UxSareePayment01', 'card', 'FBC/26-27/00013', 0, ${paid}, ${paid}, ${paid}),
      (3, 'order_UxBridal00001', 'live', 1, 41, 411, NULL, 'deposit', 2500000, 0, 500000, 'refunded', 'pay_UxBridalPaymnt1', 'upi', 'FBC/26-27/00009', 500000, ${NOW - 20 * DAY}, ${NOW - 20 * DAY}, ${NOW - 20 * DAY});

    INSERT INTO enrollments (id, student_id, course_id, batch_id, source, mode, order_id, starts_at, expires_at, revoked_at, created_at, updated_at) VALUES
      (1, 1, 40, NULL, 'payment', 'live', 1, ${paid}, ${paid + 365 * DAY}, NULL, ${paid}, ${paid}),
      (2, 1, 41, 411, 'manual', 'live', NULL, ${paid}, ${paid + 365 * DAY}, NULL, ${paid}, ${paid}),
      (3, 1, 42, 421, 'payment', 'live', 2, ${paid}, ${paid + 365 * DAY}, NULL, ${paid}, ${paid}),
      (4, 1, 43, NULL, 'manual', 'live', NULL, ${NOW - 400 * DAY}, ${NOW - 35 * DAY}, NULL, ${t}, ${t});

    -- Asha: two lessons done, the third left at 3:12.
    INSERT INTO lesson_progress (student_id, lesson_id, position_seconds, completed_at, updated_at) VALUES
      (1, 4001, 470, ${NOW - DAY}, ${NOW - DAY}),
      (1, 4002, 350, ${NOW - DAY}, ${NOW - DAY}),
      (1, 4003, 192, NULL, ${NOW - 3600}),
      (1, 4101, 540, ${NOW - DAY}, ${NOW - DAY});
  `);
  const media = createFakeR2();
  await media.put(KEY, new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { httpMetadata: { contentType: "video/mp4" } });
  const env = { ...SECRETS, DB: db, MEDIA: media };
  const certificate = await issueCertificate(env, { studentId: 1, courseId: 41, name: "Asha Patel", now: NOW });
  return { db, env, certificate };
}

/** A Cookie header for a new session of `studentId` (Chrome on Android unless told otherwise). */
export async function signIn(db, studentId, userAgent = "Mozilla/5.0 (Linux; Android 14) Chrome/130.0") {
  const request = new Request(`${SITE}/signin`, { headers: { "User-Agent": userAgent } });
  const { cookie } = await createSession(db, studentId, request, NOW);
  return cookie.split(";")[0];
}
