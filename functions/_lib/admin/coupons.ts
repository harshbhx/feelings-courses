/**
 * Coupons (W5). W2's quote() prices them on the server at checkout; the admin only defines them.
 *
 * - Exactly one of percentOff (1 to 100) and amountOffPaise (₹1 or more).
 * - courseId null: any course. maxUses null: no limit (never below what was already used).
 * - allowFree: a 100% coupon may enroll without a payment (W2). Without it, the price never drops
 *   under Razorpay's ₹1 minimum.
 * - A coupon that was ever used can't be deleted (orders point at it): deactivate it instead.
 * - Codes are stored uppercase; the code is fixed once the coupon has been used.
 */
import type { AdminCoupon } from "../../../src/shared/types.ts";
import { auditStatement } from "../db/audit.ts";
import type { Db } from "../db/d1.ts";
import { ConflictError, ValidationError, isCheckViolation, isUniqueViolation } from "../db/errors.ts";
import { batch, lastId } from "../db/tx.ts";
import * as v from "../db/validate.ts";
import { ADMIN_ACTOR } from "./auth.ts";
import { MAX_PRICE_PAISE } from "./courses.ts";
import { NotFoundError } from "./request.ts";

interface CouponRow {
  id: number;
  code: string;
  percent_off: number | null;
  amount_off_paise: number | null;
  course_id: number | null;
  max_uses: number | null;
  used_count: number;
  starts_at: number | null;
  expires_at: number | null;
  active: number;
  allow_free: number;
  created_at: number;
  updated_at: number;
}

const COLUMNS =
  "id, code, percent_off, amount_off_paise, course_id, max_uses, used_count, starts_at, expires_at, active, allow_free, created_at, updated_at";

function mapCoupon(row: CouponRow): AdminCoupon {
  return {
    id: row.id,
    code: row.code,
    percentOff: row.percent_off,
    amountOffPaise: row.amount_off_paise,
    courseId: row.course_id,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    active: row.active === 1,
    allowFree: row.allow_free === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function couponRow(db: Db, id: number): Promise<CouponRow> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM coupons WHERE id = ?`).bind(id).first<CouponRow>();
  if (!row) throw new NotFoundError("That coupon doesn't exist.");
  return row;
}

export async function listCoupons(db: Db): Promise<AdminCoupon[]> {
  const { results } = await db.prepare(`SELECT ${COLUMNS} FROM coupons ORDER BY active DESC, created_at DESC, id DESC`).all<CouponRow>();
  return results.map(mapCoupon);
}

export async function getCoupon(db: Db, id: number): Promise<AdminCoupon> {
  return mapCoupon(await couponRow(db, id));
}

interface CouponValues {
  code: string;
  percent_off: number | null;
  amount_off_paise: number | null;
  course_id: number | null;
  max_uses: number | null;
  starts_at: number | null;
  expires_at: number | null;
  active: number;
  allow_free: number;
}

/** Checks a coupon body. On edit, fields left out keep their value. */
export async function couponValues(db: Db, input: Record<string, unknown>, current: CouponRow | null): Promise<CouponValues> {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(input, key);
  const pick = <T>(key: string, column: keyof CouponRow, check: (value: unknown) => T, fallback?: unknown): T =>
    current && !has(key) ? (current[column] as T) : check(has(key) ? input[key] : fallback);

  const values: CouponValues = {
    code: pick("code", "code", (x) => v.couponCode(x, "code")),
    percent_off: pick("percentOff", "percent_off", (x) => v.optionalInt(x, "percentOff", 1, 100)),
    amount_off_paise: pick("amountOffPaise", "amount_off_paise", (x) =>
      v.isMissing(x) ? null : v.paise(x, "amountOffPaise", 100, MAX_PRICE_PAISE),
    ),
    course_id: pick("courseId", "course_id", (x) => (v.isMissing(x) ? null : v.id(x, "courseId"))),
    max_uses: pick("maxUses", "max_uses", (x) => v.optionalInt(x, "maxUses", 1, 1_000_000)),
    starts_at: pick("startsAt", "starts_at", (x) => v.optionalTimestamp(x, "startsAt")),
    expires_at: pick("expiresAt", "expires_at", (x) => v.optionalTimestamp(x, "expiresAt")),
    active: pick("active", "active", (x) => v.flag(x, "active"), true),
    allow_free: pick("allowFree", "allow_free", (x) => v.flag(x, "allowFree"), false),
  };
  // On an edit that switches kind, the other kind's stored value must not linger.
  if (current && has("percentOff") && !has("amountOffPaise") && values.percent_off !== null) values.amount_off_paise = null;
  if (current && has("amountOffPaise") && !has("percentOff") && values.amount_off_paise !== null) values.percent_off = null;

  if ((values.percent_off === null) === (values.amount_off_paise === null)) {
    throw new ValidationError("percentOff", "Give either a percentage or an amount off, not both.");
  }
  if (values.starts_at !== null && values.expires_at !== null && values.expires_at <= values.starts_at) {
    throw new ValidationError("expiresAt", "The coupon must end after it starts.");
  }
  if (current && values.max_uses !== null && values.max_uses < current.used_count) {
    throw new ValidationError("maxUses", `It has already been used ${current.used_count} times.`);
  }
  if (current && current.used_count > 0 && values.code !== current.code) {
    throw new ConflictError("coupon_used", "This coupon has been used, so its code can't change. Create a new one.");
  }
  if (values.course_id !== null && values.course_id !== current?.course_id) {
    const course = await db.prepare("SELECT 1 AS ok FROM courses WHERE id = ? AND deleted_at IS NULL").bind(values.course_id).first();
    if (!course) throw new ValidationError("courseId", "That course doesn't exist.");
  }
  return values;
}

const VALUE_COLUMNS: (keyof CouponValues)[] = [
  "code",
  "percent_off",
  "amount_off_paise",
  "course_id",
  "max_uses",
  "starts_at",
  "expires_at",
  "active",
  "allow_free",
];

function writeError(err: unknown): never {
  if (isUniqueViolation(err, "coupons.code")) throw new ConflictError("code_taken", "Another coupon already uses this code.");
  if (isCheckViolation(err)) throw new ValidationError("coupon", "Some of these values aren't allowed.");
  throw err;
}

export async function createCoupon(db: Db, input: Record<string, unknown>, now: number): Promise<AdminCoupon> {
  const values = await couponValues(db, input, null);
  let id: number;
  try {
    const result = await db
      .prepare(
        `INSERT INTO coupons (${VALUE_COLUMNS.join(", ")}, created_at, updated_at) VALUES (${VALUE_COLUMNS.map(() => "?").join(", ")}, ?, ?)`,
      )
      .bind(...VALUE_COLUMNS.map((c) => values[c]), now, now)
      .run();
    id = lastId(result);
  } catch (err) {
    writeError(err);
  }
  await auditStatement(db, { actor: ADMIN_ACTOR, action: "coupon.create", entity: "coupon", entityId: id, data: values, now }).run();
  return getCoupon(db, id);
}

export async function updateCoupon(db: Db, id: number, input: Record<string, unknown>, now: number): Promise<AdminCoupon> {
  const current = await couponRow(db, id);
  const values = await couponValues(db, input, current);
  const changed = VALUE_COLUMNS.filter((c) => values[c] !== current[c]);
  if (changed.length === 0) return mapCoupon(current);
  try {
    await batch(db, [
      db
        .prepare(`UPDATE coupons SET ${changed.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
        .bind(...changed.map((c) => values[c]), now, id),
      auditStatement(db, {
        actor: ADMIN_ACTOR,
        action: "coupon.update",
        entity: "coupon",
        entityId: id,
        data: Object.fromEntries(changed.map((c) => [c, { from: current[c], to: values[c] }])),
        now,
      }),
    ]);
  } catch (err) {
    writeError(err);
  }
  return getCoupon(db, id);
}

/** Deletes a coupon nobody used. A used one answers 409 coupon_used (deactivate it instead). */
export async function deleteCoupon(db: Db, id: number, now: number): Promise<void> {
  const current = await couponRow(db, id);
  const used = await db
    .prepare("SELECT (SELECT count(*) FROM orders WHERE coupon_id = ?1) + (SELECT count(*) FROM coupon_redemptions WHERE coupon_id = ?1) AS n")
    .bind(id)
    .first<{ n: number }>();
  if (current.used_count > 0 || (used?.n ?? 0) > 0) {
    throw new ConflictError("coupon_used", "This coupon has been used, so it can't be deleted. Turn it off instead.");
  }
  await batch(db, [
    db.prepare("DELETE FROM coupons WHERE id = ?").bind(id),
    auditStatement(db, { actor: ADMIN_ACTOR, action: "coupon.delete", entity: "coupon", entityId: id, data: { code: current.code }, now }),
  ]);
}
