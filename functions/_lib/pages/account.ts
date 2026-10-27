/**
 * /account (W3): the student's courses, devices, payments and name. GET shows it; POST (a form on
 * the page) signs a device out, signs out every other device, or changes the name.
 */
import { MAX_DEVICES_PER_STUDENT } from "../../../src/shared/constants.ts";
import type { EnrollmentSummary, OrderSummary, Student, StudentSession } from "../../../src/shared/types.ts";
import { ConfigError } from "../config.ts";
import { unixNow } from "../db/d1.ts";
import { ValidationError } from "../db/errors.ts";
import { hasDb, type Env } from "../env.ts";
import { readForm } from "../http.ts";
import { notSetUp } from "./auth.ts";
import { listEnrollments } from "../learn.ts";
import { receiptPath } from "../receipts.ts";
import { clearSessionCookie, readSession, revokeSession } from "../session.ts";
import { deviceLabel, getStudent, listOrders, listSessions, updateStudent } from "../students.ts";
import {
  batchLine,
  callout,
  formatDate,
  formatRupees,
  formFromSameSite,
  html,
  icon,
  layout,
  loadBusiness,
  messagePage,
  page,
  pageRedirect,
  plural,
  progressLine,
  raw,
  whatsappHref,
  type Business,
  type Raw,
} from "./html.ts";

const FORMAT_LABEL: Record<EnrollmentSummary["format"], string> = {
  online: "Recorded course",
  in_person: "In-person batch",
  hybrid: "In-person batch and recorded lessons",
};

function accessLine(e: EnrollmentSummary, now: number): Raw {
  if (e.revokedAt !== null) return html`<span class="tag tag-off">Access removed</span>`;
  if (e.expiresAt !== null && e.expiresAt <= now) return html`<span class="tag tag-off">Access ended ${formatDate(e.expiresAt)}</span>`;
  if (!e.active) return html`<span class="tag tag-off">Test purchase</span>`;
  if (e.completedAt !== null || (e.totalLessons > 0 && e.completedLessons >= e.totalLessons)) {
    return html`<span class="tag tag-ok">${icon("check")}Completed</span>`;
  }
  return e.expiresAt === null
    ? html`<span class="tag">Active</span>`
    : html`<span class="tag">Access until ${formatDate(e.expiresAt)}</span>`;
}

function courseCard(e: EnrollmentSummary, now: number): Raw {
  const canOpen = e.active && e.totalLessons > 0;
  const finished = e.totalLessons > 0 && e.completedLessons >= e.totalLessons;
  const label = finished ? "Open course" : e.completedLessons > 0 ? "Continue" : "Start";
  return html`<li class="course${e.active ? "" : " is-off"}">
  <div class="course-top">
    <p class="course-format">${FORMAT_LABEL[e.format]}</p>
    ${accessLine(e, now)}
  </div>
  <h3 class="item-title">${e.courseTitle}</h3>
  ${
    e.batch
      ? html`<p class="course-batch">${icon("calendar-blank")}<span>Batch: ${batchLine(e.batch)}${e.batch.scheduleText ? html`<br><span class="muted">${e.batch.scheduleText}</span>` : ""}</span></p>`
      : ""
  }
  ${
    e.totalLessons > 0 || canOpen
      ? html`<div class="course-foot">
    ${e.totalLessons > 0 ? progressLine(e.completedLessons, e.totalLessons) : ""}
    ${canOpen ? html`<a class="btn${finished ? " btn-quiet" : ""}" href="/learn/${e.courseSlug}">${e.completedLessons > 0 && !finished ? icon("play-fill") : ""}${label}${icon("arrow-right")}</a>` : ""}
  </div>`
      : ""
  }
</li>`;
}

function deviceRow(s: StudentSession): Raw {
  return html`<li class="item">
  <div class="item-with-icon">
    <span class="item-icon">${icon("device-mobile")}</span>
    <div class="item-main">
      <h3 class="item-title">${deviceLabel(s.userAgent)}${s.current ? html` <span class="tag">This device</span>` : ""}</h3>
      <p class="muted small">Signed in ${formatDate(s.createdAt)} · last used ${formatDate(s.lastSeenAt)}</p>
    </div>
  </div>
  <form method="post" action="/account">
    <input type="hidden" name="action" value="signout">
    <input type="hidden" name="id" value="${s.id}">
    <button type="submit" class="btn btn-quiet btn-sm">${s.current ? "Sign out" : "Sign out this device"}</button>
  </form>
</li>`;
}

const STATUS_LABEL: Record<OrderSummary["status"], string> = {
  created: "Not paid",
  failed: "Failed",
  paid: "Paid",
  partially_refunded: "Partly refunded",
  refunded: "Refunded",
};

/** Each order's on-screen receipt link (W2's receiptPath), or none without APP_SECRET. */
async function receiptLinks(env: Env, orders: OrderSummary[]): Promise<Map<number, string>> {
  const links = new Map<number, string>();
  for (const o of orders) {
    try {
      links.set(o.id, await receiptPath(env, o.id));
    } catch (err) {
      if (err instanceof ConfigError) break; // no APP_SECRET yet: no receipt links at all
      throw err;
    }
  }
  return links;
}

function orderRow(o: OrderSummary, receipt: string | undefined): Raw {
  return html`<li class="item">
  <div class="item-with-icon">
    <span class="item-icon">${icon("receipt")}</span>
    <div class="item-main">
      <h3 class="item-title">${o.courseTitle}</h3>
      <p>${formatRupees(o.amountPaise)} · ${STATUS_LABEL[o.status]}${o.paidAt ? ` · ${formatDate(o.paidAt)}` : ""}${o.mode === "test" ? " · test payment" : ""}</p>
      <p class="muted small">Payment ID <code>${o.razorpayPaymentId ?? "none"}</code>${o.invoiceNo ? html` · Receipt no. ${o.invoiceNo}` : ""}</p>
      ${o.refundedPaise > 0 ? html`<p class="muted small">Refunded ${formatRupees(o.refundedPaise)}</p>` : ""}
    </div>
  </div>
  ${receipt ? html`<a class="btn btn-quiet btn-sm" href="${receipt}">${icon("receipt")}Receipt</a>` : ""}
</li>`;
}

const NOTICES: Record<string, string> = {
  signedout: "That device is signed out.",
  name: "Your name is saved.",
};

function emptyCourses(business: Business): Raw {
  const help = whatsappHref(business, "Hi Urmi, I paid for a course but it isn't in my account.");
  return html`<div class="card state tone-info">
  <span class="state-icon">${icon("graduation-cap")}</span>
  <h3>No courses yet</h3>
  <p>No courses yet. If you've just paid, it can take a minute to show here. Refresh this page in a moment.</p>
  <div class="btn-row">
    <a class="btn" href="/">See the courses</a>
    ${help ? html`<a class="btn btn-quiet" href="${help}" target="_blank" rel="noopener noreferrer">${icon("whatsapp")}Paid already? Message us</a>` : ""}
  </div>
</div>`;
}

function accountPage(
  business: Business,
  student: Student,
  enrollments: EnrollmentSummary[],
  sessions: StudentSession[],
  orders: OrderSummary[],
  receipts: Map<number, string>,
  now: number,
  notice: string | null,
  formError: string | null,
): Raw {
  // Courses that can be opened first, then the rest (ended, removed, test).
  const sorted = [...enrollments].sort((a, b) => Number(b.active) - Number(a.active));
  const used = Math.min(sessions.length, MAX_DEVICES_PER_STUDENT);
  return layout(
    { title: "My courses", business, signedIn: true, current: "account" },
    html`<div class="page-head">
  <h1>${student.name ? `Hello, ${student.name.split(" ")[0]}` : "My courses"}</h1>
  <p class="muted">Your courses, devices and payments in one place.</p>
</div>
${notice ? callout("notice", notice) : ""}
${formError ? callout("alert", formError) : ""}
<section aria-labelledby="courses-h">
  <div class="section-title"><h2 id="courses-h">My courses</h2>${enrollments.length ? html`<span class="small muted">${plural(enrollments.length, "course")}</span>` : ""}</div>
  ${sorted.length ? html`<ul class="courses">${sorted.map((e) => courseCard(e, now))}</ul>` : emptyCourses(business)}
</section>
<section class="card" aria-labelledby="devices-h">
  <div class="card-head">
    <h2 id="devices-h">Devices</h2>
    <span class="small muted"><span class="slots" aria-hidden="true">${Array.from({ length: MAX_DEVICES_PER_STUDENT }, (_, i) => html`<span class="slot${i < used ? " used" : ""}"></span>`)}</span> ${used} of ${MAX_DEVICES_PER_STUDENT} in use</span>
  </div>
  <p class="muted small">Signed in on ${sessions.length} of ${MAX_DEVICES_PER_STUDENT} devices. Signing in on another device signs out the one used least recently.</p>
  <ul class="list">${sessions.map(deviceRow)}</ul>
  ${
    sessions.length > 1
      ? html`<form method="post" action="/account" class="actions"><input type="hidden" name="action" value="signout_others"><button type="submit" class="btn btn-quiet btn-sm">Sign out every other device</button></form>`
      : ""
  }
</section>
<section class="card" aria-labelledby="payments-h">
  <div class="card-head"><h2 id="payments-h">Payments</h2></div>
  ${orders.length ? html`<ul class="list">${orders.map((o) => orderRow(o, receipts.get(o.id)))}</ul>` : html`<p class="muted">No payments yet.</p>`}
</section>
<section class="card" aria-labelledby="profile-h">
  <div class="card-head"><h2 id="profile-h">Your details</h2></div>
  <p class="muted small">Phone ${student.phone ?? "not set"}${student.email ? ` · ${student.email}` : ""}. To change your phone number, message us on WhatsApp.</p>
  <form method="post" action="/account" class="form">
    <input type="hidden" name="action" value="name">
    <label for="name">Your name</label>
    <input id="name" name="name" type="text" autocomplete="name" maxlength="80" required value="${student.name ?? ""}"${formError ? raw(` aria-invalid="true"`) : ""}>
    <p class="hint">Shown on this page. Your certificate asks for the name to print separately.</p>
    <button type="submit" class="btn btn-quiet">Save name</button>
  </form>
</section>`,
  );
}

export async function handleAccount(request: Request, env: Env, now = unixNow()): Promise<Response> {
  const business = await loadBusiness(env.DB ?? null);
  if (!hasDb(env)) return notSetUp(business);
  const session = await readSession(env, request, now);
  if (!session) {
    if (request.method === "POST") return pageRedirect("/signin?next=/account");
    return pageRedirect("/signin?next=/account", [], 302);
  }

  let formError: string | null = null;
  if (request.method === "POST") {
    if (!formFromSameSite(request)) {
      return page(messagePage({ title: "Please try again", business, signedIn: true }, "Please try again", "That form came from another site, so nothing was changed.", { href: "/account", label: "Back to my courses" }, { icon: "warning-circle", tone: "warn" }), 403);
    }
    const form = (await readForm(request)) ?? new URLSearchParams();
    const action = form.get("action");
    if (action === "signout") {
      const id = /^\d{1,12}$/.test(form.get("id") ?? "") ? Number(form.get("id")) : 0;
      if (id) await revokeSession(env.DB, session.studentId, id, now);
      if (id === session.sessionId) return pageRedirect("/", [clearSessionCookie()]);
      return pageRedirect("/account?done=signedout");
    }
    if (action === "signout_others") {
      await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE student_id = ? AND id <> ? AND revoked_at IS NULL")
        .bind(now, session.studentId, session.sessionId)
        .run();
      return pageRedirect("/account?done=signedout");
    }
    if (action === "name") {
      try {
        await updateStudent(env.DB, session.studentId, { name: form.get("name") ?? "" }, now);
        return pageRedirect("/account?done=name");
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        formError = err.message;
      }
    } else {
      return pageRedirect("/account");
    }
  } else if (request.method !== "GET" && request.method !== "HEAD") {
    return page(messagePage({ title: "Not allowed", business }, "Not allowed", "This page can't be used that way."), 405);
  }

  const student = await getStudent(env.DB, session.studentId);
  if (!student) return pageRedirect("/signin", [], 302);
  const [enrollments, sessions, orders] = await Promise.all([
    listEnrollments(env, session.studentId, now),
    listSessions(env.DB, session.studentId, session.sessionId, now),
    listOrders(env.DB, session.studentId),
  ]);
  const receipts = await receiptLinks(env, orders);
  const notice = NOTICES[new URL(request.url).searchParams.get("done") ?? ""] ?? null;
  return page(
    accountPage(business, student, enrollments, sessions, orders, receipts, now, notice, formError),
    formError ? 400 : 200,
    [],
    request.method,
  );
}
