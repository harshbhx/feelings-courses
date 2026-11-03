/**
 * Every admin API route (W5), one exported handler per path. The files under functions/api/admin/
 * only re-export these, so the whole API is readable (and testable) in one place. docs/admin-api.md
 * documents each route for W6.
 *
 * All of them run behind functions/api/admin/_middleware.ts (session, Origin, JSON, headers).
 */
import type { AdminBackupRunResponse, AdminMeResponse } from "../../../src/shared/api.ts";
import { createAccessLink } from "../access-link.ts";
import { BACKUP_PREFIX, runBackup } from "../backup.ts";
import { issueCertificate } from "../certificates.ts";
import { ConfigError, config } from "../config.ts";
import { auditStatement } from "../db/audit.ts";
import { unixNow } from "../db/d1.ts";
import { ValidationError } from "../db/errors.ts";
import * as v from "../db/validate.ts";
import { error, json } from "../http.ts";
import { processWebhookEvent, refundOrder, syncOrder } from "../orders.ts";
import { publishStatus, requestRebuild } from "../rebuild.ts";
import { sendReceiptEmail } from "../signin-links.ts";
import { ADMIN_ACTOR, changePassword, clearAdminCookie, login, revokeAdminSession, type LoginResult } from "./auth.ts";
import { createBatch, deleteBatch, listBatches, updateBatch } from "./batches.ts";
import { createCoupon, deleteCoupon, getCoupon, listCoupons, updateCoupon } from "./coupons.ts";
import {
  checkDomain,
  createCourse,
  deleteCourse,
  getCourse,
  listCourses,
  replaceOutline,
  setCourseStatus,
  updateCourse,
  type StatusAction,
} from "./courses.ts";
import { csvResponse } from "./csv.ts";
import { ORDER_STATUSES, getOrder, listOrders, listWebhooks, ordersCsv, webhookExists, type OrderFilters } from "./orders.ts";
import { COURSE_BODY_BYTES, OUTLINE_BODY_BYTES, adminRoute, body, dbOf, noContent, pathId, query, type AdminContext } from "./request.ts";
import { getAdminSettings, getStats, listAudit, updateAdminSettings } from "./settings.ts";
import {
  addStudent,
  eraseStudent,
  getStudent,
  grantAccess,
  listStudents,
  requireStudent,
  revokeEnrollment,
  signOutEverywhere,
  studentsCsv,
  updateStudentDetails,
  type StudentFilters,
} from "./students.ts";

function live(ctx: AdminContext): boolean {
  return config(ctx.env).paymentMode === "live";
}

function studentOpts(ctx: AdminContext) {
  const cfg = config(ctx.env);
  return { now: unixNow(), live: cfg.paymentMode === "live", hubOrigin: cfg.hubOrigin };
}

function loginFailure(result: Exclude<LoginResult, { ok: true }>): Response {
  if (result.status === 401) return error(401, "wrong_password", "That password isn't right.");
  const retryAfter = Math.max(1, Math.ceil(result.retryAfter));
  const message =
    result.code === "admin_locked"
      ? "Too many wrong passwords. Sign-in is locked for a while to keep the admin safe."
      : "Too many tries. Please wait a little and try again.";
  return error(429, result.code, message, { retryAfter }, { "Retry-After": String(retryAfter) });
}

// ---------------------------------------------------------------- session

/** POST /api/admin/login { password } → 200 { ok } + Set-Cookie. */
export const loginRoute = adminRoute({
  POST: async (ctx) => {
    const input = await body(ctx);
    const result = await login(ctx.env, ctx.request, input.password, unixNow());
    if (!result.ok) return loginFailure(result);
    return json({ ok: true }, 200, { "Set-Cookie": result.cookie });
  },
});

/** POST /api/admin/logout → 204, cookie cleared. */
export const logoutRoute = adminRoute({
  POST: async (ctx) => {
    const now = unixNow();
    const session = ctx.data.admin;
    if (session) {
      await revokeAdminSession(dbOf(ctx), session.sessionId, now);
      await auditStatement(dbOf(ctx), { actor: ADMIN_ACTOR, action: "admin.logout", entity: "admin", entityId: session.sessionId, now }).run();
    }
    return noContent({ "Set-Cookie": clearAdminCookie() });
  },
});

/** POST /api/admin/password { current, next } → 200 { ok } + a fresh Set-Cookie (all other sessions end). */
export const passwordRoute = adminRoute({
  POST: async (ctx) => {
    const input = await body(ctx);
    const result = await changePassword(ctx.env, ctx.request, { current: input.current, next: input.next }, unixNow());
    if (!result.ok) return loginFailure(result);
    return json({ ok: true }, 200, { "Set-Cookie": result.cookie });
  },
});

/** GET /api/admin/me → { ok, expiresAt, appEnv, paymentMode, hubHost, apexDomain }. */
export const meRoute = adminRoute({
  GET: (ctx) => {
    const cfg = config(ctx.env);
    return json({
      ok: true,
      expiresAt: ctx.data.admin?.expiresAt ?? 0,
      appEnv: cfg.appEnv,
      paymentMode: cfg.paymentMode ?? "not_configured",
      // The admin shows course addresses with the same hosts the router and the domain check use.
      hubHost: cfg.hubHost,
      apexDomain: cfg.apexDomain,
    } satisfies AdminMeResponse);
  },
});

// ---------------------------------------------------------------- courses

/** GET /api/admin/courses · POST /api/admin/courses */
export const coursesRoute = adminRoute({
  GET: async (ctx) => json(await listCourses(dbOf(ctx))),
  POST: async (ctx) => json(await createCourse(dbOf(ctx), await body(ctx, COURSE_BODY_BYTES), unixNow()), 201),
});

/** GET · PUT · DELETE /api/admin/courses/:id */
export const courseRoute = adminRoute({
  GET: async (ctx) => json(await getCourse(dbOf(ctx), pathId(ctx.params.id))),
  PUT: async (ctx) => json(await updateCourse(dbOf(ctx), pathId(ctx.params.id), await body(ctx, COURSE_BODY_BYTES), unixNow())),
  DELETE: async (ctx) => {
    await deleteCourse(dbOf(ctx), pathId(ctx.params.id), unixNow());
    return noContent();
  },
});

/** PUT /api/admin/courses/:id/outline */
export const outlineRoute = adminRoute({
  PUT: async (ctx) => json(await replaceOutline(dbOf(ctx), pathId(ctx.params.id), await body(ctx, OUTLINE_BODY_BYTES), unixNow())),
});

function statusRoute(action: StatusAction) {
  return adminRoute({
    POST: async (ctx) => {
      const id = pathId(ctx.params.id);
      const { changed } = await setCourseStatus(dbOf(ctx), id, action, unixNow());
      // Publishing an already published course is "publish my edits": it still asks for a build.
      const rebuild = changed || action === "publish" ? await requestRebuild(ctx.env, ctx) : { queued: false, nextAllowedAt: unixNow() };
      return json({ course: await getCourse(dbOf(ctx), id), rebuild });
    },
  });
}

/** POST /api/admin/courses/:id/publish · /unpublish · /archive → { course, rebuild } */
export const publishCourseRoute = statusRoute("publish");
export const unpublishCourseRoute = statusRoute("unpublish");
export const archiveCourseRoute = statusRoute("archive");

/** POST /api/admin/courses/:id/domain/check */
export const domainCheckRoute = adminRoute({
  POST: async (ctx) => json(await checkDomain(dbOf(ctx), pathId(ctx.params.id), config(ctx.env).apexDomain, unixNow())),
});

// ---------------------------------------------------------------- batches

/** GET · POST /api/admin/courses/:id/batches */
export const courseBatchesRoute = adminRoute({
  GET: async (ctx) => json(await listBatches(dbOf(ctx), pathId(ctx.params.id))),
  POST: async (ctx) => json(await createBatch(dbOf(ctx), pathId(ctx.params.id), await body(ctx), unixNow()), 201),
});

/** PUT · DELETE /api/admin/batches/:id */
export const batchRoute = adminRoute({
  PUT: async (ctx) => json(await updateBatch(dbOf(ctx), pathId(ctx.params.id), await body(ctx), unixNow())),
  DELETE: async (ctx) => {
    await deleteBatch(dbOf(ctx), pathId(ctx.params.id), unixNow());
    return noContent();
  },
});

// ---------------------------------------------------------------- students

function studentFilters(request: Request): StudentFilters {
  const q = query(request);
  return { q: q.string("q", 100), course: q.int("course", 1, Number.MAX_SAFE_INTEGER) };
}

/** GET /api/admin/students?q=&course=&page= · POST /api/admin/students */
export const studentsRoute = adminRoute({
  GET: async (ctx) => {
    const page = query(ctx.request).int("page", 1, 100_000) ?? 1;
    return json(await listStudents(dbOf(ctx), studentFilters(ctx.request), page, live(ctx)));
  },
  POST: async (ctx) => json(await addStudent(dbOf(ctx), await body(ctx), studentOpts(ctx)), 201),
});

/** GET /api/admin/students.csv?q=&course= */
export const studentsCsvRoute = adminRoute({
  GET: async (ctx) => {
    const csv = await studentsCsv(dbOf(ctx), studentFilters(ctx.request), live(ctx));
    await auditStatement(dbOf(ctx), { actor: ADMIN_ACTOR, action: "student.export", entity: "student", now: unixNow() }).run();
    return csvResponse("students.csv", csv);
  },
});

/** GET /api/admin/students/:id · PUT { name?, email?, phone? } (contact details; the email is how they sign in) */
export const studentRoute = adminRoute({
  GET: async (ctx) => json(await getStudent(dbOf(ctx), pathId(ctx.params.id), studentOpts(ctx))),
  PUT: async (ctx) => json(await updateStudentDetails(dbOf(ctx), pathId(ctx.params.id), await body(ctx), studentOpts(ctx))),
});

/** POST /api/admin/students/:id/enrollments { courseId, batchId?, expiresAt? } */
export const grantRoute = adminRoute({
  POST: async (ctx) => {
    const opts = studentOpts(ctx);
    return json(await grantAccess(dbOf(ctx), pathId(ctx.params.id), await body(ctx), opts), 201);
  },
});

/** DELETE /api/admin/enrollments/:id */
export const enrollmentRoute = adminRoute({
  DELETE: async (ctx) => {
    await revokeEnrollment(dbOf(ctx), pathId(ctx.params.id), unixNow());
    return noContent();
  },
});

/** POST /api/admin/students/:id/access-link */
export const accessLinkRoute = adminRoute({
  POST: async (ctx) => {
    // W3's access-link.ts makes the link (one place for the token, the message and the audit row).
    // requireStudent first, so a missing student is a 404 and an erased one a 409.
    const id = pathId(ctx.params.id);
    await requireStudent(dbOf(ctx), id);
    return json(await createAccessLink(ctx.env, id, { actor: ADMIN_ACTOR, now: unixNow() }));
  },
});

/** POST /api/admin/students/:id/signout-all → 204 */
export const signoutAllRoute = adminRoute({
  POST: async (ctx) => {
    await signOutEverywhere(dbOf(ctx), pathId(ctx.params.id), unixNow());
    return noContent();
  },
});

/** POST /api/admin/students/:id/erase { confirm: true } */
export const eraseRoute = adminRoute({
  POST: async (ctx) => {
    const input = await body(ctx);
    if (input.confirm !== true) throw new ValidationError("confirm", "Erasing can't be undone. Send { \"confirm\": true }.");
    return json(await eraseStudent(dbOf(ctx), pathId(ctx.params.id), studentOpts(ctx)));
  },
});

/** POST /api/admin/students/:id/certificate { courseId, name } (W3's issueCertificate) */
export const certificateRoute = adminRoute({
  POST: async (ctx) => {
    const studentId = pathId(ctx.params.id);
    const input = await body(ctx);
    const courseId = v.id(input.courseId, "courseId");
    const name = v.text(input.name, "name", { min: 2, max: 80 });
    await requireStudent(dbOf(ctx), studentId);
    const certificate = await issueCertificate(ctx.env, { studentId, courseId, name, actor: ADMIN_ACTOR });
    return json(certificate, 201);
  },
});

// ---------------------------------------------------------------- payments

function orderFilters(request: Request): OrderFilters {
  const q = query(request);
  return {
    status: q.oneOf("status", ORDER_STATUSES),
    course: q.int("course", 1, Number.MAX_SAFE_INTEGER),
    from: q.date("from"),
    to: q.date("to"),
  };
}

/** GET /api/admin/orders?status=&course=&from=&to=&page= */
export const ordersRoute = adminRoute({
  GET: async (ctx) => {
    const page = query(ctx.request).int("page", 1, 100_000) ?? 1;
    return json(await listOrders(dbOf(ctx), orderFilters(ctx.request), page));
  },
});

/** GET /api/admin/orders.csv?status=&course=&from=&to= */
export const ordersCsvRoute = adminRoute({
  GET: async (ctx) => {
    const csv = await ordersCsv(dbOf(ctx), orderFilters(ctx.request));
    await auditStatement(dbOf(ctx), { actor: ADMIN_ACTOR, action: "order.export", entity: "order", now: unixNow() }).run();
    return csvResponse("payments.csv", csv);
  },
});

/** GET /api/admin/orders/:id */
export const orderRoute = adminRoute({
  GET: async (ctx) => json(await getOrder(dbOf(ctx), pathId(ctx.params.id))),
});

/** POST /api/admin/orders/:id/refund { amountPaise?, reason, revoke } (W2's refundOrder; 24-hour window) */
export const refundRoute = adminRoute({
  POST: async (ctx) => {
    const id = pathId(ctx.params.id);
    await getOrder(dbOf(ctx), id);
    const input = await body(ctx);
    const amountPaise = v.isMissing(input.amountPaise) ? undefined : v.paise(input.amountPaise, "amountPaise", 100);
    const reason = v.text(input.reason, "reason", { max: 300 });
    if (typeof input.revoke !== "boolean") throw new ValidationError("revoke", "Say whether access ends with the refund.");
    return json(await refundOrder(ctx.env, id, { amountPaise, reason, revoke: input.revoke }), 201);
  },
});

/**
 * POST /api/admin/orders/:id/sync (W2's syncOrder: re-reads Razorpay). Answers with the same
 * AdminOrder mapping as GET /api/admin/orders/:id, so the admin's order drawer shows one shape.
 */
export const syncRoute = adminRoute({
  POST: async (ctx) => {
    const id = pathId(ctx.params.id);
    const before = await getOrder(dbOf(ctx), id);
    await syncOrder(ctx.env, id);
    const after = await getOrder(dbOf(ctx), id);
    // A payment only the sync found (the browser closed, no webhook): its receipt email goes now.
    if (before.status !== "paid" && after.status === "paid") await sendReceiptEmail(ctx.env, id);
    return json(after);
  },
});

/** GET /api/admin/webhooks?pending=1 */
export const webhooksRoute = adminRoute({
  GET: async (ctx) => json(await listWebhooks(dbOf(ctx), query(ctx.request).flag("pending"))),
});

/** POST /api/admin/webhooks/:id/replay (W2's processWebhookEvent) */
export const replayRoute = adminRoute({
  POST: async (ctx) => {
    const id = await webhookExists(dbOf(ctx), ctx.params.id);
    const outcome = await processWebhookEvent(ctx.env, id);
    // A replay that marks an order paid sends its receipt email, as the webhook would have.
    if (outcome.paidOrderId !== null) await sendReceiptEmail(ctx.env, outcome.paidOrderId);
    await auditStatement(dbOf(ctx), { actor: ADMIN_ACTOR, action: "webhook.replay", entity: "webhook", entityId: id, now: unixNow() }).run();
    return json({ ok: true });
  },
});

// ---------------------------------------------------------------- coupons

/** GET · POST /api/admin/coupons */
export const couponsRoute = adminRoute({
  GET: async (ctx) => json(await listCoupons(dbOf(ctx))),
  POST: async (ctx) => json(await createCoupon(dbOf(ctx), await body(ctx), unixNow()), 201),
});

/** GET · PUT · DELETE /api/admin/coupons/:id */
export const couponRoute = adminRoute({
  GET: async (ctx) => json(await getCoupon(dbOf(ctx), pathId(ctx.params.id))),
  PUT: async (ctx) => json(await updateCoupon(dbOf(ctx), pathId(ctx.params.id), await body(ctx), unixNow())),
  DELETE: async (ctx) => {
    await deleteCoupon(dbOf(ctx), pathId(ctx.params.id), unixNow());
    return noContent();
  },
});

// ---------------------------------------------------------------- settings, stats, publish, audit

/** GET · PUT /api/admin/settings */
export const settingsRoute = adminRoute({
  GET: async (ctx) => json(await getAdminSettings(dbOf(ctx), ctx.env)),
  PUT: async (ctx) => json(await updateAdminSettings(dbOf(ctx), ctx.env, await body(ctx), unixNow())),
});

/** GET /api/admin/stats?from=&to=&course= */
export const statsRoute = adminRoute({
  GET: async (ctx) => {
    const q = query(ctx.request);
    return json(await getStats(dbOf(ctx), { from: q.date("from"), to: q.date("to"), course: q.int("course", 0, Number.MAX_SAFE_INTEGER) }, unixNow()));
  },
});

/** POST /api/admin/publish: rebuild the site with the latest content → PublishStatus (+ rebuild). */
export const publishSiteRoute = adminRoute({
  POST: async (ctx) => {
    const rebuild = await requestRebuild(ctx.env, ctx);
    return json({ ...(await publishStatus(ctx.env, ctx.request.url)), rebuild });
  },
});

/** GET /api/admin/publish/status */
export const publishStatusRoute = adminRoute({
  GET: async (ctx) => json(await publishStatus(ctx.env, ctx.request.url)),
});

/** GET /api/admin/audit?entity=&entityId=&before=&page= */
export const auditRoute = adminRoute({
  GET: async (ctx) => {
    const q = query(ctx.request);
    return json(
      await listAudit(dbOf(ctx), {
        entity: q.string("entity", 40),
        entityId: q.string("entityId", 80),
        before: q.int("before", 1, Number.MAX_SAFE_INTEGER),
        page: q.int("page", 1, 100_000) ?? 1,
      }),
    );
  },
});

// ---------------------------------------------------------------- backups (W7's backup.ts, wired at integration)

/** POST /api/admin/backup/run: a fresh gzipped SQL dump into R2 now → AdminBackupRunResponse. */
export const backupRunRoute = adminRoute({
  POST: async (ctx) => {
    if (!ctx.env.MEDIA) throw new ConfigError("MEDIA (the R2 binding)");
    const now = unixNow();
    const result = await runBackup(ctx.env, now);
    await auditStatement(dbOf(ctx), { actor: ADMIN_ACTOR, action: "backup.run", entity: "settings", entityId: "last_backup_at", data: { key: result.key, bytes: result.bytes }, now }).run();
    return json({ ok: true, key: result.key, at: result.at } satisfies AdminBackupRunResponse);
  },
});

/** GET /api/admin/backup: the newest dump as a .sql.gz download, or 404 when there is none yet. */
export const backupDownloadRoute = adminRoute({
  GET: async (ctx) => {
    const bucket = ctx.env.MEDIA;
    if (!bucket) throw new ConfigError("MEDIA (the R2 binding)");
    let newest: string | null = null;
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix: BACKUP_PREFIX, cursor, limit: 1000 });
      for (const o of page.objects) if (newest === null || o.key > newest) newest = o.key;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const object = newest ? await bucket.get(newest) : null;
    if (!object || !newest) return error(404, "not_found", "There is no backup yet. Run one first.");
    await auditStatement(dbOf(ctx), { actor: ADMIN_ACTOR, action: "backup.download", entity: "settings", entityId: "last_backup_at", data: { key: newest }, now: unixNow() }).run();
    return new Response(object.body, {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${newest.slice(BACKUP_PREFIX.length)}"`,
        "Cache-Control": "no-store",
      },
    });
  },
});
