/**
 * The student JSON API (W3, plan section 4). Route files in functions/api/** are one-liners that
 * call these, so tests can call them with a plain Request.
 *
 *   POST   /api/auth/email-link                      email → a one-time sign-in link by email (same answer for every address)
 *   POST   /api/auth/signout                         this device, or { all: true }
 *   GET    /api/me                PUT /api/me        profile and enrollments
 *   GET    /api/me/sessions       DELETE /api/me/sessions/:id
 *   GET    /api/me/orders
 *   GET    /api/me/orders/:id                         one of the student's own receipts (W2's buildReceipt)
 *   GET    /api/learn/:slug                          outline + progress + certificate
 *   GET    /api/learn/:slug/lessons/:lessonId/play   W4's signed playback, after the enrollment check
 *   PUT    /api/learn/progress
 *   POST   /api/learn/:slug/certificate
 *   GET    /api/certificates/:code                   public check (rate limited)
 *
 * Conventions (src/shared/api.ts): JSON in and out, no-store; writes need a JSON content type and
 * a same-origin Origin; errors are { error, message }. "Not enrolled" and "no such course" give the
 * same 404, so the API doesn't tell anyone which courses exist as drafts.
 */
import type { EmailLinkResponse, MeResponse, MyReceiptResponse } from "../../src/shared/api.ts";
import { checkCertificate, publicCheck } from "./certificates.ts";
import { unixNow } from "./db/d1.ts";
import { hasDb, type Env } from "./env.ts";
import { error, errorResponse, isJson, json, methodNotAllowed, readJson, sameOrigin } from "./http.ts";
import { claimCertificate, listEnrollments, loadLearnCourse, parseProgress, saveProgress } from "./learn.ts";
import { playLesson } from "./play.ts";
import { buildReceipt } from "./receipts.ts";
import { ipSubject } from "./guard.ts";
import { hit } from "./ratelimit.ts";
import {
  clearSessionCookie,
  readSession,
  requireEnrollment,
  revokeAllSessions,
  revokeSession,
  type SessionRef,
} from "./session.ts";
import { requestSignInLink } from "./signin-links.ts";
import type { WaitUntil } from "./stub.ts";
import { nextPath } from "./pages/auth.ts";
import { getStudent, listOrders, listSessions, updateStudent } from "./students.ts";

type Handler = (request: Request, env: Env, now: number, ctx?: WaitUntil) => Promise<Response>;

const notConfigured = () => error(503, "platform_not_configured", "This part of the site isn't set up yet.");
const notSignedIn = () => error(401, "not_signed_in", "Please sign in again.");
const notEnrolled = () => error(404, "not_enrolled", "This course isn't in your account.");

/** Method check, CSRF checks for writes, and error mapping around a handler. */
function endpoint(methods: readonly string[], handler: Handler) {
  return async (request: Request, env: Env, now = unixNow(), ctx?: WaitUntil): Promise<Response> => {
    const method = request.method === "HEAD" ? "GET" : request.method;
    if (!methods.includes(method)) return methodNotAllowed(methods);
    if (method !== "GET") {
      if (!sameOrigin(request)) return error(403, "cross_origin", "This request must come from this site.");
      if (!isJson(request) && method !== "DELETE") return error(415, "unsupported_media_type", "Send JSON.");
    }
    if (!hasDb(env)) return notConfigured();
    try {
      return await handler(request, env, now, ctx);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

async function signedIn(request: Request, env: Env, now: number): Promise<SessionRef | null> {
  return readSession(env, request, now);
}

// ---------------------------------------------------------------- auth

/**
 * POST /api/auth/email-link { email, next? }: emails a one-time sign-in link when the address has
 * an account. 202 for every well-formed address (no enumeration); 400 for a malformed one; 429
 * when the IP or the address asked too often.
 */
export const handleEmailLink = endpoint(["POST"], async (request, env, now, ctx) => {
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const result = await requestSignInLink(env, request, { email: body.value.email, next: nextPath(body.value.next) }, { now, ctx });
  if (!result.ok) {
    return error(
      429,
      "rate_limited",
      "Too many tries. Please wait a while, then ask for a new link.",
      { retryAfter: result.retryAfter },
      { "Retry-After": String(result.retryAfter) },
    );
  }
  return json({ ok: true } satisfies EmailLinkResponse, 202);
});

export const handleSignout = endpoint(["POST"], async (request, env, now) => {
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const session = await signedIn(request, env, now);
  if (session) {
    if (body.value.all === true) await revokeAllSessions(env.DB, session.studentId, now);
    else await revokeSession(env.DB, session.studentId, session.sessionId, now);
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "Set-Cookie": clearSessionCookie() } });
});

// ---------------------------------------------------------------- me

export const handleMe = endpoint(["GET", "PUT"], async (request, env, now) => {
  const session = await signedIn(request, env, now);
  if (!session) return notSignedIn();
  if (request.method === "PUT") {
    const body = await readJson(request);
    if (!body.ok) return body.response;
    return json(await updateStudent(env.DB, session.studentId, body.value, now));
  }
  const student = await getStudent(env.DB, session.studentId);
  if (!student) return notSignedIn();
  return json({ student, enrollments: await listEnrollments(env, session.studentId, now) } satisfies MeResponse);
});

export const handleMySessions = endpoint(["GET"], async (request, env, now) => {
  const session = await signedIn(request, env, now);
  if (!session) return notSignedIn();
  return json(await listSessions(env.DB, session.studentId, session.sessionId, now));
});

export function handleMySession(id: string) {
  return endpoint(["DELETE"], async (request, env, now) => {
    const session = await signedIn(request, env, now);
    if (!session) return notSignedIn();
    const sessionId = /^\d{1,12}$/.test(id) ? Number(id) : 0;
    // Someone else's session id looks exactly like a missing one.
    if (!sessionId || !(await revokeSession(env.DB, session.studentId, sessionId, now))) {
      return error(404, "not_found", "That device isn't signed in.");
    }
    const headers: Record<string, string> = { "Cache-Control": "no-store" };
    if (sessionId === session.sessionId) headers["Set-Cookie"] = clearSessionCookie();
    return new Response(null, { status: 204, headers });
  });
}

export const handleMyOrders = endpoint(["GET"], async (request, env, now) => {
  const session = await signedIn(request, env, now);
  if (!session) return notSignedIn();
  return json(await listOrders(env.DB, session.studentId));
});

/**
 * GET /api/me/orders/:id: one receipt (W2's buildReceipt), only the student's own. Someone else's
 * order, an unpaid one and a missing one all give the same 404.
 */
export function handleMyReceipt(orderId: string) {
  return endpoint(["GET"], async (request, env, now) => {
    const session = await signedIn(request, env, now);
    if (!session) return notSignedIn();
    const id = /^\d{1,12}$/.test(orderId) ? Number(orderId) : 0;
    const owner = id ? await env.DB.prepare("SELECT student_id FROM orders WHERE id = ?").bind(id).first<{ student_id: number }>() : null;
    const receipt = owner?.student_id === session.studentId ? await buildReceipt(env.DB, id) : null;
    if (!receipt) return error(404, "not_found", "No such payment in your account.");
    const { extras: _extras, ...plain } = receipt;
    return json(plain satisfies MyReceiptResponse);
  });
}

// ---------------------------------------------------------------- learn

export function handleLearnCourse(slug: string) {
  return endpoint(["GET"], async (request, env, now) => {
    const session = await signedIn(request, env, now);
    if (!session) return notSignedIn();
    const course = /^[a-z0-9-]{1,40}$/.test(slug) ? await loadLearnCourse(env, session.studentId, slug, now) : null;
    return course ? json(course) : notEnrolled();
  });
}

export function handlePlay(slug: string, lessonId: string) {
  return endpoint(["GET"], async (request, env, now) => {
    const enrollment = await requireEnrollment(env, request, slug, now);
    if (!enrollment) return (await signedIn(request, env, now)) ? notEnrolled() : notSignedIn();
    const id = /^\d{1,12}$/.test(lessonId) ? Number(lessonId) : 0;
    const info = id ? await playLesson(env, enrollment, id, now) : null;
    return info ? json(info) : error(404, "not_found", "This lesson has no video.");
  });
}

export const handleProgress = endpoint(["PUT"], async (request, env, now) => {
  const session = await signedIn(request, env, now);
  if (!session) return notSignedIn();
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const saved = await saveProgress(env, session.studentId, parseProgress(body.value), now);
  return saved ? json(saved) : notEnrolled();
});

export function handleCertificateClaim(slug: string) {
  return endpoint(["POST"], async (request, env, now) => {
    const session = await signedIn(request, env, now);
    if (!session) return notSignedIn();
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const result = await claimCertificate(env, session.studentId, slug, body.value.nameOnCertificate, now);
    if (result.ok) return json(result.certificate);
    switch (result.reason) {
      case "course_incomplete":
        return error(409, "course_incomplete", "Finish every lesson to get your certificate.");
      case "no_certificate":
        return error(409, "no_certificate", "This course has no certificate.");
      case "revoked":
        return error(409, "conflict", "This certificate can't be changed. Message us on WhatsApp.");
      default:
        return notEnrolled();
    }
  });
}

// ---------------------------------------------------------------- public certificate check

export function handleCertificateCheck(code: string) {
  return endpoint(["GET"], async (request, env, now) => {
    const limit = await hit(env.DB, "certificate_ip", ipSubject(request), { now });
    if (!limit.allowed) {
      return error(429, "rate_limited", "Too many checks. Please wait a minute.", { retryAfter: limit.retryAfter }, {
        "Retry-After": String(limit.retryAfter),
      });
    }
    return json(publicCheck(await checkCertificate(env.DB, code)));
  });
}

