/**
 * /account (W3): the student's courses, devices, payments and name. GET shows it; POST (a form on
 * the page) signs a device out, signs out every other device, or changes the name.
 */
import { MAX_DEVICES_PER_STUDENT } from "../../../src/shared/constants.ts";
import type { EnrollmentSummary, OrderSummary, Student, StudentSession } from "../../../src/shared/types.ts";
import { unixNow } from "../db/d1.ts";
import { ValidationError } from "../db/errors.ts";
import { hasDb, type Env } from "../env.ts";
import { readForm } from "../http.ts";
import { notSetUp } from "./auth.ts";
import { listEnrollments } from "../learn.ts";
import { clearSessionCookie, readSession, revokeSession } from "../session.ts";
import { deviceLabel, getStudent, listOrders, listSessions, updateStudent } from "../students.ts";
import {
  formatDate,
  formatRupees,
  formFromSameSite,
  html,
  layout,
  loadBusiness,
  messagePage,
  page,
  pageRedirect,
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
  return e.expiresAt === null
    ? html`<span class="tag">Active</span>`
    : html`<span class="tag">Access until ${formatDate(e.expiresAt)}</span>`;
}

function courseCard(e: EnrollmentSummary, now: number): Raw {
  const canOpen = e.active && e.totalLessons > 0;
  return html`<li class="item">
  <div class="item-main">
    <h3 class="item-title">${e.courseTitle}</h3>
    <p class="muted">${FORMAT_LABEL[e.format]}</p>
    ${e.batch ? html`<p>Batch: ${e.batch.title}, from ${e.batch.startsOn}${e.batch.endsOn ? ` to ${e.batch.endsOn}` : ""}${e.batch.scheduleText ? html`<br><span class="muted">${e.batch.scheduleText}</span>` : ""}</p>` : ""}
    <p>${accessLine(e, now)}</p>
    ${
      e.totalLessons > 0
        ? html`<p class="progress-line"><progress max="${e.totalLessons}" value="${e.completedLessons}">${e.completedLessons} of ${e.totalLessons}</progress>
      <span>${e.completedLessons} of ${e.totalLessons} lessons done</span></p>`
        : ""
    }
  </div>
  ${canOpen ? html`<a class="btn" href="/learn/${e.courseSlug}">${e.completedLessons > 0 ? "Continue" : "Start"}</a>` : ""}
</li>`;
}

function deviceRow(s: StudentSession): Raw {
  return html`<li class="item">
  <div class="item-main">
    <h3 class="item-title">${deviceLabel(s.userAgent)}${s.current ? html` <span class="tag">This device</span>` : ""}</h3>
    <p class="muted">Signed in ${formatDate(s.createdAt)} · last used ${formatDate(s.lastSeenAt)}</p>
  </div>
  <form method="post" action="/account">
    <input type="hidden" name="action" value="signout">
    <input type="hidden" name="id" value="${s.id}">
    <button type="submit" class="btn btn-quiet">${s.current ? "Sign out" : "Sign out this device"}</button>
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

function orderRow(o: OrderSummary): Raw {
  return html`<li class="item">
  <div class="item-main">
    <h3 class="item-title">${o.courseTitle}</h3>
    <p>${formatRupees(o.amountPaise)} · ${STATUS_LABEL[o.status]}${o.paidAt ? ` · ${formatDate(o.paidAt)}` : ""}${o.mode === "test" ? " · test payment" : ""}</p>
    <p class="muted">Payment ID <code>${o.razorpayPaymentId ?? "none"}</code>${o.invoiceNo ? html` · Receipt no. ${o.invoiceNo}` : ""}</p>
    ${o.refundedPaise > 0 ? html`<p class="muted">Refunded ${formatRupees(o.refundedPaise)}</p>` : ""}
  </div>
</li>`;
}

const NOTICES: Record<string, string> = {
  signedout: "That device is signed out.",
  name: "Your name is saved.",
};

function accountPage(
  business: Business,
  student: Student,
  enrollments: EnrollmentSummary[],
  sessions: StudentSession[],
  orders: OrderSummary[],
  now: number,
  notice: string | null,
  formError: string | null,
): Raw {
  return layout(
    { title: "My courses", business, signedIn: true },
    html`<h1>${student.name ? `Hello, ${student.name.split(" ")[0]}` : "My courses"}</h1>
${notice ? html`<p class="notice" role="status">${notice}</p>` : ""}
${formError ? html`<p class="alert" role="alert">${formError}</p>` : ""}
<section class="card" aria-labelledby="courses-h">
  <h2 id="courses-h">My courses</h2>
  ${
    enrollments.length
      ? html`<ul class="list">${enrollments.map((e) => courseCard(e, now))}</ul>`
      : html`<p>No courses yet. If you've just paid, it can take a minute to show here.</p>`
  }
</section>
<section class="card" aria-labelledby="devices-h">
  <h2 id="devices-h">Devices</h2>
  <p class="muted">Signed in on ${sessions.length} of ${MAX_DEVICES_PER_STUDENT} devices. Signing in on another device signs out the one used least recently.</p>
  <ul class="list">${sessions.map(deviceRow)}</ul>
  ${
    sessions.length > 1
      ? html`<form method="post" action="/account"><input type="hidden" name="action" value="signout_others"><button type="submit" class="btn btn-quiet">Sign out every other device</button></form>`
      : ""
  }
</section>
<section class="card" aria-labelledby="payments-h">
  <h2 id="payments-h">Payments</h2>
  ${orders.length ? html`<ul class="list">${orders.map(orderRow)}</ul>` : html`<p class="muted">No payments yet.</p>`}
</section>
<section class="card" aria-labelledby="profile-h">
  <h2 id="profile-h">Your details</h2>
  <p class="muted">Phone ${student.phone ?? "not set"}${student.email ? ` · ${student.email}` : ""}. To change your phone number, message us on WhatsApp.</p>
  <form method="post" action="/account" class="form">
    <input type="hidden" name="action" value="name">
    <label for="name">Your name</label>
    <input id="name" name="name" type="text" autocomplete="name" maxlength="80" required value="${student.name ?? ""}">
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
      return page(messagePage({ title: "Please try again", business, signedIn: true }, "Please try again", "That form came from another site, so nothing was changed.", { href: "/account", label: "Back to my courses" }), 403);
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
  const notice = NOTICES[new URL(request.url).searchParams.get("done") ?? ""] ?? null;
  return page(
    accountPage(business, student, enrollments, sessions, orders, now, notice, formError),
    formError ? 400 : 200,
    [],
    request.method,
  );
}
