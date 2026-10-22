/**
 * Settings, the dashboard's stats and the audit log, in the admin (W5).
 *
 * Owner decision (plan 10.5): the salon's GSTIN may be stored here for its records, but it is
 * never displayed: not on receipts, pages or the public snapshot. Only this admin endpoint returns
 * it, and the audit log records that it changed, never its value.
 */
import type { AdminAuditResponse } from "../../../src/shared/api.ts";
import type { AdminSettings, BusinessSettings, DailyStat, Stats } from "../../../src/shared/types.ts";
import { config } from "../config.ts";
import { auditStatement } from "../db/audit.ts";
import type { Db, DbValue } from "../db/d1.ts";
import { ValidationError } from "../db/errors.ts";
import { bumpContentVersionStatement, getSettings, setSettingStatement } from "../db/settings.ts";
import { batch } from "../db/tx.ts";
import * as v from "../db/validate.ts";
import type { Env } from "../env.ts";
import { ADMIN_ACTOR } from "./auth.ts";
import { istDay } from "./request.ts";

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Checks settings.business. Every field is required except gstin. */
export function validateBusiness(value: unknown): BusinessSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("business", "business must be an object.");
  const b = value as Record<string, unknown>;
  const phone = v.phone(b.phone, "business.phone");
  const whatsappRaw = v.isMissing(b.whatsapp) || b.whatsapp === "" ? phone : b.whatsapp;
  if (typeof whatsappRaw !== "string") throw new ValidationError("business.whatsapp", "Enter the WhatsApp number.");
  const whatsapp = v.phone(whatsappRaw, "business.whatsapp").replace(/\D/g, "");
  let gstin: string | null = null;
  if (!v.isMissing(b.gstin) && b.gstin !== "") {
    if (typeof b.gstin !== "string") throw new ValidationError("business.gstin", "Enter a 15-character GSTIN.");
    gstin = b.gstin.trim().toUpperCase();
    if (!GSTIN_RE.test(gstin)) throw new ValidationError("business.gstin", "Enter a 15-character GSTIN, like 24ABCDE1234F1Z5.");
  }
  const stateCode = typeof b.stateCode === "string" ? b.stateCode.trim() : b.stateCode;
  if (typeof stateCode !== "string" || !/^[0-9]{2}$/.test(stateCode)) {
    throw new ValidationError("business.stateCode", "The state code is two digits (24 is Gujarat).");
  }
  return {
    name: v.text(b.name, "business.name", { max: 80 }),
    legalName: v.text(b.legalName, "business.legalName", { max: 120 }),
    address: v.text(b.address, "business.address", { max: 300 }),
    stateCode,
    phone,
    whatsapp,
    gstin,
  };
}

export async function getAdminSettings(db: Db, env: Partial<Env>): Promise<AdminSettings> {
  const s = await getSettings(db, [
    "business",
    "legal_confirmed",
    "admin_password_hash",
    "content_version",
    "published_version",
    "last_backup_at",
    "last_rebuild_at",
  ]);
  const cfg = config(env);
  const business = s.business ?? { name: "", legalName: "", address: "", stateCode: "", phone: "", whatsapp: "", gstin: null };
  return {
    business: { ...business, gstin: business.gstin ?? null },
    legalConfirmed: s.legal_confirmed === true,
    paymentMode: cfg.paymentMode ?? "not_configured",
    appEnv: cfg.appEnv,
    lastBackupAt: typeof s.last_backup_at === "number" ? s.last_backup_at : null,
    lastRebuildAt: typeof s.last_rebuild_at === "number" ? s.last_rebuild_at : null,
    contentVersion: typeof s.content_version === "number" ? s.content_version : 1,
    publishedVersion: typeof s.published_version === "number" ? s.published_version : 0,
    passwordChanged: typeof s.admin_password_hash === "string" && s.admin_password_hash.length > 0,
  };
}

/**
 * Saves business facts and/or the legal confirmation. Business facts are on every page and
 * receipt, so a change bumps content_version (publish to update the pages).
 */
export async function updateAdminSettings(db: Db, env: Partial<Env>, input: Record<string, unknown>, now: number): Promise<AdminSettings> {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(input, key);
  if (!has("business") && !has("legalConfirmed")) throw new ValidationError("business", "Nothing to save.");
  const before = await getSettings(db, ["business", "legal_confirmed"]);
  const business = has("business") ? validateBusiness(input.business) : null;
  const legal = has("legalConfirmed") ? v.flag(input.legalConfirmed, "legalConfirmed") === 1 : null;

  const changes: Record<string, unknown> = {};
  if (business) {
    const old = before.business;
    const fields = (Object.keys(business) as (keyof BusinessSettings)[]).filter((k) => (old?.[k] ?? null) !== business[k]);
    // Field names only: never the GSTIN's value.
    if (fields.length) changes.business = fields;
  }
  if (legal !== null && legal !== (before.legal_confirmed === true)) changes.legalConfirmed = legal;
  if (Object.keys(changes).length === 0) return getAdminSettings(db, env);

  await batch(db, [
    business && changes.business ? setSettingStatement(db, "business", business, now) : null,
    business && changes.business ? bumpContentVersionStatement(db, now) : null,
    legal !== null && "legalConfirmed" in changes ? setSettingStatement(db, "legal_confirmed", legal, now) : null,
    auditStatement(db, { actor: ADMIN_ACTOR, action: "settings.update", entity: "settings", data: changes, now }),
  ]);
  return getAdminSettings(db, env);
}

// ---------------------------------------------------------------- stats (daily_stats, W7 counts them)

export const MAX_STATS_DAYS = 400;

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Daily counters between two India-time days (inclusive). Default: the last 30 days. */
export async function getStats(
  db: Db,
  query: { from: string | null; to: string | null; course: number | null },
  now: number,
): Promise<Stats> {
  const to = query.to ?? istDay(now);
  const from = query.from ?? addDays(to, -29);
  if (from > to) throw new ValidationError("from", "from must be on or before to.");
  if (addDays(from, MAX_STATS_DAYS) < to) throw new ValidationError("from", `At most ${MAX_STATS_DAYS} days at a time.`);
  const params: DbValue[] = [from, to];
  let sql =
    "SELECT day, SUM(views) AS views, SUM(checkouts_started) AS checkouts_started, SUM(paid_orders) AS paid_orders, " +
    "SUM(revenue_paise) AS revenue_paise, SUM(refunds_paise) AS refunds_paise FROM daily_stats WHERE day >= ? AND day <= ?";
  if (query.course !== null) {
    sql += " AND course_id = ?";
    params.push(query.course);
  }
  sql += " GROUP BY day ORDER BY day";
  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<{ day: string; views: number; checkouts_started: number; paid_orders: number; revenue_paise: number; refunds_paise: number }>();
  const series: DailyStat[] = results.map((r) => ({
    day: r.day,
    courseId: query.course ?? 0,
    views: r.views,
    checkoutsStarted: r.checkouts_started,
    paidOrders: r.paid_orders,
    revenuePaise: r.revenue_paise,
    refundsPaise: r.refunds_paise,
  }));
  const totals = { views: 0, checkoutsStarted: 0, paidOrders: 0, revenuePaise: 0, refundsPaise: 0 };
  for (const s of series) {
    totals.views += s.views;
    totals.checkoutsStarted += s.checkoutsStarted;
    totals.paidOrders += s.paidOrders;
    totals.revenuePaise += s.revenuePaise;
    totals.refundsPaise += s.refundsPaise;
  }
  return { from, to, courseId: query.course, series, totals };
}

// ---------------------------------------------------------------- audit log

export const AUDIT_PAGE_SIZE = 50;

/**
 * Newest first, 50 a page. Filter by entity ("course", "order", …) and optionally its id.
 * `before` (an audit id) pages by cursor, which stays stable while new entries arrive; `page`
 * (offset) is also accepted.
 */
export async function listAudit(
  db: Db,
  query: { entity: string | null; entityId: string | null; before: number | null; page: number },
): Promise<AdminAuditResponse> {
  if (query.entity !== null && !/^[a-z][a-z0-9_]{0,39}$/.test(query.entity)) throw new ValidationError("entity", "Unknown entity.");
  if (query.entityId !== null && query.entity === null) throw new ValidationError("entity", "entity is required with entityId.");
  const where: string[] = [];
  const params: DbValue[] = [];
  if (query.entity !== null) {
    where.push("entity = ?");
    params.push(query.entity);
  }
  if (query.entityId !== null) {
    where.push("entity_id = ?");
    params.push(query.entityId);
  }
  if (query.before !== null) {
    where.push("id < ?");
    params.push(query.before);
  }
  const offset = query.before === null ? (query.page - 1) * AUDIT_PAGE_SIZE : 0;
  const { results } = await db
    .prepare(
      `SELECT id, actor, action, entity, entity_id, data, created_at FROM audit_log${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ` +
        "ORDER BY id DESC LIMIT ? OFFSET ?",
    )
    .bind(...params, AUDIT_PAGE_SIZE, offset)
    .all<{ id: number; actor: string; action: string; entity: string; entity_id: string | null; data: string | null; created_at: number }>();
  return results.map((r) => {
    let data: unknown = null;
    try {
      data = r.data === null ? null : JSON.parse(r.data);
    } catch {
      data = null;
    }
    return { id: r.id, actor: r.actor, action: r.action, entity: r.entity, entityId: r.entity_id, data, createdAt: r.created_at };
  });
}
