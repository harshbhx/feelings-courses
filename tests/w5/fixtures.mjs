// Shared set-up for the admin API tests (W5).
//
//   const t = await adminFixture();            // seeded DB, secrets, a signed-in admin
//   const res = await t.call(coursesRoute, "GET", "/api/admin/courses");
//   const res = await t.call(courseRoute, "PUT", "/api/admin/courses/2", { body: {...}, params: { id: "2" } });
//
// Every call goes through the real admin middleware first (session, Origin, JSON), then the route.
import { createHmac } from "node:crypto";
import { createTestDb } from "../helpers/d1.mjs";
import { context, cookiesFrom, readJson, req } from "../helpers/http.mjs";
import { adminMiddleware } from "../../functions/_lib/admin/middleware.ts";
import { loginRoute } from "../../functions/_lib/admin/routes.ts";

export const APP_SECRET = "a".repeat(64);
export const PASSWORD = "Test-Admin-Password-2026";
export const PASSWORD_HASH = createHmac("sha256", APP_SECRET).update(PASSWORD).digest("hex");
export const HUB = "courses.feelingsbeautycare.in";

export function adminEnv(db, extra = {}) {
  return { DB: db, APP_SECRET, ADMIN_PASSWORD_HASH: PASSWORD_HASH, APP_ENV: "production", HUB_HOST: HUB, ...extra };
}

/** Runs `route` behind the admin middleware, like Pages does. */
export async function callRoute(route, env, method, path, { body, params = {}, cookie, ip, headers, origin, now } = {}) {
  const request = req(path, { method, body, cookie, ip, headers, origin });
  const ctx = context({ request, env, params });
  ctx.next = async () => route(ctx);
  return adminMiddleware(ctx, now);
}

/** Signs in and returns the cookie header value ("__Host-fbc_admin=…"). */
export async function signIn(env, { ip = "198.51.100.1", password = PASSWORD } = {}) {
  const res = await callRoute(loginRoute, env, "POST", "/api/admin/login", { body: { password }, ip });
  if (res.status !== 200) throw new Error(`signIn: ${res.status} ${JSON.stringify(await readJson(res))}`);
  const { value } = cookiesFrom(res)["__Host-fbc_admin"];
  return `__Host-fbc_admin=${value}`;
}

export async function adminFixture(extraEnv = {}) {
  const db = await createTestDb();
  const env = adminEnv(db, extraEnv);
  const cookie = await signIn(env);
  return {
    db,
    env,
    cookie,
    /** Calls a route signed in. Returns { status, body, res }. */
    async call(route, method, path, opts = {}) {
      const res = await callRoute(route, env, method, path, { cookie, ...opts });
      const text = await res.text();
      let body = null;
      if (text && (res.headers.get("Content-Type") ?? "").includes("json")) body = JSON.parse(text);
      else if (text) body = text;
      return { status: res.status, body, res };
    },
  };
}

/** Inserts a student and returns its id. */
export function addStudentRow(db, { name = "Riya Shah", phone = "+919876543210", email = null, createdAt = 1_760_000_000 } = {}) {
  db.sqlite
    .prepare("INSERT INTO students (name, phone, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(name, phone, email, createdAt, createdAt);
  return db.get("SELECT id FROM students WHERE phone = ?", phone).id;
}

/** Inserts a paid order (and its enrollment) and returns the order id. */
export function addPaidOrder(db, { studentId, courseId = 1, amount = 299_900, paidAt = Math.floor(Date.now() / 1000) - 3600, mode = "live", payId, batchId = null } = {}) {
  const pay = payId ?? `pay_${Math.random().toString(36).slice(2, 12)}`;
  db.sqlite
    .prepare(
      "INSERT INTO orders (razorpay_order_id, mode, student_id, course_id, batch_id, list_price_paise, amount_paise, status, " +
        "razorpay_payment_id, method, payer_contact, payer_email, invoice_no, created_at, updated_at, paid_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', ?, 'upi', '+919876543210', 'buyer@example.com', ?, ?, ?, ?)",
    )
    .run(`order_${pay.slice(4)}`, mode, studentId, courseId, batchId, amount, amount, pay, `FBC/2026-27/${pay.slice(4, 8)}`, paidAt - 60, paidAt, paidAt);
  const orderId = db.get("SELECT id FROM orders WHERE razorpay_payment_id = ?", pay).id;
  db.sqlite
    .prepare(
      "INSERT INTO enrollments (student_id, course_id, batch_id, source, mode, order_id, starts_at, expires_at, created_at, updated_at) " +
        "VALUES (?, ?, ?, 'payment', ?, ?, ?, ?, ?, ?)",
    )
    .run(studentId, courseId, batchId, mode, orderId, paidAt, paidAt + 365 * 86_400, paidAt, paidAt);
  return orderId;
}
