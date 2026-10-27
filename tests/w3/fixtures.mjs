// W3 fixtures: a seeded test database with students, paid and refunded orders, and enrollments in
// several states. Uses the seed's demo course 1 'selfmakeup' (9 lessons in 3 modules, certificate
// wording set) plus:
//   20 'evening-class'  online, 2 lessons, NO certificate wording
//   21 'old-class'      online, 1 lesson (student 1's enrollment expired)
//   22 'studio-days'    hybrid, 1 lesson, batch 221
//   23 'gone-class'     deleted
// Students: 1 Asha (phone + email, paid order 1 → course 1 active, course 20 active, course 21
// expired, course 22 with batch), 2 Bina (phone only, refunded order 2, course 1 revoked),
// 3 erased (paid order 3), 4 Chitra (test-mode enrollment in course 20).
import { createTestDb } from "../helpers/d1.mjs";
import { createSession } from "../../functions/_lib/session.ts";

/** 23 Oct 2026, 11:30 IST. */
export const NOW = Date.UTC(2026, 9, 23, 6, 0, 0) / 1000;
export const DAY = 86_400;

export const TEST_KEYS = Object.freeze({
  RAZORPAY_KEY_ID: "rzp_test_FakeKeyId00001",
  RAZORPAY_KEY_SECRET: "fake_key_secret_for_tests_only",
});
export const LIVE_KEYS = Object.freeze({ ...TEST_KEYS, RAZORPAY_KEY_ID: "rzp_live_FakeKeyId00001" });

export const ASHA = { id: 1, phone: "+919876543210", email: "asha@example.com", payment: "pay_AshaPayment0001" };
export const BINA = { id: 2, phone: "+919812345678", payment: "pay_BinaRefunded001" };
export const ERASED = { id: 3, payment: "pay_ErasedPayment01" };
export const CHITRA = { id: 4, phone: "+919800000004" };

export async function setupDb() {
  const db = await createTestDb();
  const t = NOW - 30 * DAY;
  const paid = NOW - 2 * DAY;
  db.sqlite.exec(`
    INSERT INTO courses (id, slug, title, format, price_paise, access_days, certificate_title, status, published_at, created_at, updated_at, deleted_at)
    VALUES
      (20, 'evening-class', 'Evening Class', 'online', 100000, 365, NULL, 'published', ${t}, ${t}, ${t}, NULL),
      (21, 'old-class', 'Old Class', 'online', 100000, 365, 'Old certificate', 'published', ${t}, ${t}, ${t}, NULL),
      (22, 'studio-days', 'Studio Days', 'hybrid', 500000, 365, 'Studio certificate', 'published', ${t}, ${t}, ${t}, NULL),
      (23, 'gone-class', 'Gone Class', 'online', 100000, 365, NULL, 'published', ${t}, ${t}, ${t}, ${t});
    INSERT INTO modules (id, course_id, position, title, created_at, updated_at) VALUES
      (200, 20, 1, 'Evening basics', ${t}, ${t}),
      (210, 21, 1, 'Old module', ${t}, ${t}),
      (220, 22, 1, 'Studio prep', ${t}, ${t});
    INSERT INTO lessons (id, course_id, module_id, position, slug, title, minutes, video_provider, video_ref, duration_seconds, notes, created_at, updated_at) VALUES
      (2001, 20, 200, 1, 'lights', 'Lights', 5, 'r2', 'v/2001.mp4', 300, 'First paragraph.

Second <b>paragraph</b>.', ${t}, ${t}),
      (2002, 20, 200, 2, 'colour', 'Colour', 5, 'none', NULL, NULL, NULL, ${t}, ${t}),
      (2101, 21, 210, 1, 'old-lesson', 'Old lesson', 5, 'none', NULL, NULL, NULL, ${t}, ${t}),
      (2201, 22, 220, 1, 'kit', 'Your kit', 5, 'none', NULL, NULL, NULL, ${t}, ${t});
    INSERT INTO batches (id, course_id, title, starts_on, ends_on, schedule_text, status, created_at, updated_at)
    VALUES (221, 22, 'November mornings', '2026-11-02', '2026-11-20', 'Mon to Fri, 10 am', 'open', ${t}, ${t});

    INSERT INTO students (id, name, phone, email, created_at, updated_at, erased_at) VALUES
      (1, 'Asha Patel', '${ASHA.phone}', '${ASHA.email}', ${t}, ${t}, NULL),
      (2, 'Bina Shah', '${BINA.phone}', NULL, ${t}, ${t}, NULL),
      (3, NULL, NULL, NULL, ${t}, ${t}, ${t}),
      (4, 'Chitra', '${CHITRA.phone}', NULL, ${t}, ${t}, NULL);

    INSERT INTO orders (id, razorpay_order_id, mode, student_id, course_id, list_price_paise, amount_paise, status,
                        razorpay_payment_id, payer_contact, payer_email, invoice_no, refunded_paise, created_at, updated_at, paid_at)
    VALUES
      (1, 'order_AshaOrder00001', 'test', 1, 1, 299900, 299900, 'paid', '${ASHA.payment}', '9876543210', 'asha.pay@example.com', 'TEST-1', 0, ${paid}, ${paid}, ${paid}),
      (2, 'order_BinaOrder00001', 'test', 2, 1, 299900, 299900, 'refunded', '${BINA.payment}', '${BINA.phone}', NULL, 'TEST-2', 299900, ${paid}, ${paid}, ${paid}),
      (3, 'order_ErasedOrder001', 'test', 3, 1, 299900, 299900, 'paid', '${ERASED.payment}', '+919811111111', NULL, 'TEST-3', 0, ${paid}, ${paid}, ${paid}),
      (4, 'order_UnpaidOrder001', 'test', 2, 20, 100000, 100000, 'created', NULL, NULL, NULL, NULL, 0, ${paid}, ${paid}, NULL);

    INSERT INTO enrollments (id, student_id, course_id, batch_id, source, mode, order_id, starts_at, expires_at, revoked_at, created_at, updated_at) VALUES
      (1, 1, 1, NULL, 'payment', 'test', 1, ${paid}, ${paid + 365 * DAY}, NULL, ${paid}, ${paid}),
      (2, 1, 20, NULL, 'manual', 'live', NULL, ${paid}, ${paid + 365 * DAY}, NULL, ${paid}, ${paid}),
      (3, 1, 21, NULL, 'manual', 'live', NULL, ${NOW - 400 * DAY}, ${NOW - 35 * DAY}, NULL, ${t}, ${t}),
      (4, 1, 22, 221, 'manual', 'live', NULL, ${paid}, ${paid + 365 * DAY}, NULL, ${paid}, ${paid}),
      (5, 2, 1, NULL, 'payment', 'test', 2, ${paid}, ${paid + 365 * DAY}, ${paid + 3600}, ${paid}, ${paid}),
      (6, 4, 20, NULL, 'manual', 'test', NULL, ${paid}, NULL, NULL, ${paid}, ${paid}),
      (7, 1, 23, NULL, 'manual', 'live', NULL, ${paid}, NULL, NULL, ${paid}, ${paid});
  `);
  return db;
}

export const env = (db, extra = {}) => ({ DB: db, ...extra });

/** A Cookie header value for a fresh session of `studentId`. */
export async function sessionCookie(db, studentId, { now = NOW, userAgent = "Mozilla/5.0 (Linux; Android 14) Chrome/130.0" } = {}) {
  const request = new Request("https://courses.feelingsbeautycare.in/signin", { headers: { "User-Agent": userAgent } });
  const { cookie } = await createSession(db, studentId, request, now);
  return cookie.split(";")[0];
}

/** Marks every lesson of a course done for a student. */
export function completeCourse(db, studentId, courseId, now = NOW) {
  db.sqlite.exec(`
    INSERT INTO lesson_progress (student_id, lesson_id, position_seconds, completed_at, updated_at)
    SELECT ${studentId}, id, 0, ${now}, ${now} FROM lessons WHERE course_id = ${courseId}
    ON CONFLICT (student_id, lesson_id) DO UPDATE SET completed_at = ${now};
  `);
}
