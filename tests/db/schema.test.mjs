// The schema (migrations/0001_init.sql) applies, and its CHECKs and keys refuse bad rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../helpers/d1.mjs";
import { isCheckViolation, isForeignKeyViolation, isUniqueViolation } from "../../functions/_lib/db/errors.ts";

const T = 1_761_200_000;

async function schemaDb() {
  return createTestDb({ only: ["0001_init.sql"] });
}

async function insertCourse(db, fields = {}) {
  const row = { slug: "soft-glam", title: "Soft glam", price_paise: 99900, status: "draft", created_at: T, updated_at: T, ...fields };
  const cols = Object.keys(row);
  return db
    .prepare(`INSERT INTO courses (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...cols.map((c) => row[c]))
    .run();
}

async function rejects(promise, check = isCheckViolation) {
  await assert.rejects(promise, (err) => {
    assert.ok(check(err), `unexpected error: ${err.message}`);
    return true;
  });
}

test("every table of the plan exists", async () => {
  const db = await schemaDb();
  const tables = db.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
  for (const t of [
    "settings", "courses", "batches", "modules", "lessons", "media", "students", "coupons", "orders", "refunds",
    "invoice_counters", "enrollments", "coupon_redemptions", "lesson_progress", "certificates", "sessions",
    "login_tokens", "admin_sessions", "webhook_events", "rate_limits", "daily_stats", "audit_log", "d1_migrations",
  ]) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  assert.ok(!tables.includes("otp_codes"), "otp_codes was dropped by the plan");
});

test("courses: money must be whole paise and at least ₹1 (or 0)", async () => {
  const db = await schemaDb();
  await insertCourse(db, { slug: "ok-course" });
  await insertCourse(db, { slug: "free-course", price_paise: 0 });
  await rejects(insertCourse(db, { slug: "fraction", price_paise: 2999.5 }));
  await rejects(insertCourse(db, { slug: "too-cheap", price_paise: 50 }));
  await rejects(insertCourse(db, { slug: "negative", price_paise: -100 }));
  await rejects(insertCourse(db, { slug: "compare-low", price_paise: 1000, compare_at_paise: 900 }));
  await rejects(insertCourse(db, { slug: "deposit-high", price_paise: 1000, deposit_paise: 1000 }));
});

test("courses: slugs are DNS-safe labels of 2 to 40 characters", async () => {
  const db = await schemaDb();
  for (const slug of ["Upper", "a", "-lead", "trail-", "dou--ble", "under_score", "spa ce", "x".repeat(41)]) {
    await rejects(insertCourse(db, { slug }));
  }
  await insertCourse(db, { slug: "ab" });
  await insertCourse(db, { slug: "x".repeat(40) });
  await rejects(insertCourse(db, { slug: "ab" }), (e) => isUniqueViolation(e, "courses.slug"));
});

test("courses: a published course needs a price and published_at", async () => {
  const db = await schemaDb();
  await rejects(insertCourse(db, { slug: "no-price", price_paise: null, status: "published", published_at: T }));
  await rejects(insertCourse(db, { slug: "no-date", status: "published" }));
  await insertCourse(db, { slug: "draft-no-price", price_paise: null });
  await insertCourse(db, { slug: "published", status: "published", published_at: T });
  await rejects(insertCourse(db, { slug: "bad-format", format: "webinar" }));
});

test("lessons: slug rules, module/course pairing and the video pair", async () => {
  const db = await schemaDb();
  await insertCourse(db, { id: 1, slug: "one" });
  await insertCourse(db, { id: 2, slug: "two" });
  await db.prepare("INSERT INTO modules (id, course_id, position, title, created_at, updated_at) VALUES (1, 1, 1, 'M', ?, ?)").bind(T, T).run();
  const lesson = (fields) => {
    const row = { course_id: 1, module_id: 1, position: 1, slug: "intro", title: "Intro", created_at: T, updated_at: T, ...fields };
    const cols = Object.keys(row);
    return db.prepare(`INSERT INTO lessons (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...cols.map((c) => row[c])).run();
  };
  await lesson({});
  await rejects(lesson({ position: 2, slug: "certificate" }));
  await rejects(lesson({ position: 2, slug: "Bad Slug" }));
  await rejects(lesson({ position: 2, slug: "has-video", video_provider: "r2" })); // provider without ref
  await rejects(lesson({ position: 2, slug: "ref-only", video_ref: "lessons/1/x.mp4" })); // ref without provider
  await rejects(lesson({ position: 0, slug: "zero" }));
  // A module of course 1 can't hold a lesson of course 2.
  await rejects(lesson({ course_id: 2, position: 3, slug: "wrong-course" }), isForeignKeyViolation);
  await rejects(lesson({ position: 1, slug: "same-position" }), (e) => isUniqueViolation(e));
});

async function withOrder(db, fields = {}) {
  await insertCourse(db, { id: 1, slug: "one" });
  await db.prepare("INSERT INTO students (id, name, phone, created_at, updated_at) VALUES (1, 'Asha', '+919876543210', ?, ?)").bind(T, T).run();
  const row = { id: 1, mode: "test", student_id: 1, course_id: 1, list_price_paise: 99900, amount_paise: 99900, created_at: T, updated_at: T, ...fields };
  const cols = Object.keys(row);
  return db.prepare(`INSERT INTO orders (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...cols.map((c) => row[c])).run();
}

test("orders: amount, status and refund rules", async () => {
  const db = await schemaDb();
  await withOrder(db);
  const update = (sql, ...p) => db.prepare(sql).bind(...p).run();
  await rejects(update("UPDATE orders SET status = 'paid' WHERE id = 1")); // paid needs payment id and paid_at
  await update("UPDATE orders SET status = 'paid', razorpay_payment_id = 'pay_A1', paid_at = ? WHERE id = 1", T);
  await rejects(update("UPDATE orders SET refunded_paise = 100000 WHERE id = 1")); // above the amount
  await update("UPDATE orders SET refunded_paise = 99900, status = 'refunded' WHERE id = 1");
  await rejects(update("UPDATE orders SET discount_paise = 100 WHERE id = 1")); // discount needs a coupon
  await rejects(update("UPDATE orders SET amount_paise = 50 WHERE id = 1"));
  await rejects(update("UPDATE orders SET amount_paise = 999.5 WHERE id = 1"));
});

test("orders: one Razorpay payment can never pay two orders", async () => {
  const db = await schemaDb();
  await withOrder(db, { status: "paid", razorpay_payment_id: "pay_Same", paid_at: T });
  await assert.rejects(
    db.prepare("INSERT INTO orders (mode, student_id, course_id, list_price_paise, amount_paise, status, razorpay_payment_id, paid_at, created_at, updated_at) VALUES ('test', 1, 1, 100, 100, 'paid', 'pay_Same', ?, ?, ?)").bind(T, T, T).run(),
    (e) => isUniqueViolation(e, "orders.razorpay_payment_id"),
  );
});

test("students, coupons, tokens, certificates, settings: CHECKs", async () => {
  const db = await schemaDb();
  const run = (sql, ...p) => db.prepare(sql).bind(...p).run();
  await rejects(run("INSERT INTO students (phone, created_at, updated_at) VALUES ('9876543210', ?, ?)", T, T)); // not E.164
  await rejects(run("INSERT INTO students (email, created_at, updated_at) VALUES ('Asha@X.com', ?, ?)", T, T)); // not lowercased
  await rejects(run("INSERT INTO students (name, created_at, updated_at) VALUES ('No contact', ?, ?)", T, T));
  await run("INSERT INTO students (id, phone, created_at, updated_at) VALUES (1, '+919876543210', ?, ?)", T, T);

  await rejects(run("INSERT INTO coupons (code, percent_off, amount_off_paise, created_at, updated_at) VALUES ('BOTH', 10, 1000, ?, ?)", T, T));
  await rejects(run("INSERT INTO coupons (code, created_at, updated_at) VALUES ('NONE', ?, ?)", T, T));
  await rejects(run("INSERT INTO coupons (code, percent_off, created_at, updated_at) VALUES ('lower', 10, ?, ?)", T, T));
  await rejects(run("INSERT INTO coupons (code, percent_off, created_at, updated_at) VALUES ('OVER', 101, ?, ?)", T, T));
  await run("INSERT INTO coupons (code, percent_off, created_at, updated_at) VALUES ('DIWALI20', 20, ?, ?)", T, T);

  const hash = "a".repeat(64);
  await rejects(run("INSERT INTO login_tokens (token_hash, purpose, student_id, redirect_path, created_at, expires_at) VALUES (?, 'handoff', 1, '//evil.example', ?, ?)", hash, T, T + 600));
  await rejects(run("INSERT INTO login_tokens (token_hash, purpose, student_id, redirect_path, created_at, expires_at) VALUES (?, 'handoff', 1, 'https://evil.example', ?, ?)", hash, T, T + 600));
  await rejects(run("INSERT INTO login_tokens (token_hash, purpose, student_id, redirect_path, created_at, expires_at) VALUES (?, 'otp', 1, '/learn', ?, ?)", hash, T, T + 600));
  await run("INSERT INTO login_tokens (token_hash, purpose, student_id, redirect_path, created_at, expires_at) VALUES (?, 'handoff', 1, '/welcome?o=1', ?, ?)", hash, T, T + 600);

  await rejects(run("INSERT INTO sessions (token_hash, student_id, created_at, last_seen_at, expires_at) VALUES ('ABC', 1, ?, ?, ?)", T, T, T + 1));

  await run("INSERT INTO courses (id, slug, title, created_at, updated_at) VALUES (1, 'one', 'One', ?, ?)", T, T);
  await rejects(run("INSERT INTO certificates (code, student_id, course_id, name_on_cert, title, issued_at) VALUES ('ILOU000000', 1, 1, 'Asha', 'Cert', ?)", T));
  await run("INSERT INTO certificates (code, student_id, course_id, name_on_cert, title, issued_at) VALUES ('7K3M9QX2ZA', 1, 1, 'Asha', 'Cert', ?)", T);

  await rejects(run("INSERT INTO settings (key, value, updated_at) VALUES ('x', 'not json', ?)", T));
  await rejects(run("INSERT INTO enrollments (student_id, course_id, source, mode, starts_at, created_at, updated_at) VALUES (1, 1, 'payment', 'test', ?, ?, ?)", T, T, T)); // payment needs order_id
});

test("foreign keys are enforced, as on D1", async () => {
  const db = await schemaDb();
  await assert.rejects(
    db.prepare("INSERT INTO enrollments (student_id, course_id, source, mode, starts_at, created_at, updated_at) VALUES (99, 99, 'manual', 'test', ?, ?, ?)").bind(T, T, T).run(),
    (e) => isForeignKeyViolation(e),
  );
});
