/**
 * Sign-in pages (W3; email identity since 23 Oct 2026), rendered by Functions on the hub:
 *
 *   /signin          the student types their email; a single-use link (15 minutes) is emailed to
 *                    it when it has an account. The same answer either way (no enumeration). A
 *                    plain HTML form (works without JavaScript); the same checks as
 *                    POST /api/auth/email-link. /signin?sent=1 is the "check your email" state.
 *   /auth/continue   a one-time link: "handoff" (right after payment, on the paying device, 10 min)
 *                    signs in at once; an emailed or admin link first shows a Continue button,
 *                    because mail scanners and WhatsApp's link preview open links and would use
 *                    the token up. Opening an emailed or admin link proves the email (claim.ts):
 *                    the first proof signs out every earlier session once.
 *   /learn/logout    POST signs this device out; GET only offers the button (no state change on GET).
 */
import { EMAIL_LINK_TTL, LEGACY_ENROLL_COOKIE } from "../config.ts";
import { markEmailVerified } from "../claim.ts";
import { writeAudit } from "../db/audit.ts";
import { unixNow } from "../db/d1.ts";
import { ValidationError } from "../db/errors.ts";
import { hasDb, type Env } from "../env.ts";
import { readForm } from "../http.ts";
import { requestSignInLink } from "../signin-links.ts";
import {
  clearSessionCookie,
  consumeLoginToken,
  createSession,
  peekLoginToken,
  readSession,
  revokeAllSessions,
  revokeSession,
  safeRedirectPath,
  sessionToken,
} from "../session.ts";
import type { WaitUntil } from "../stub.ts";
import { MAX_DEVICES_PER_STUDENT } from "../../../src/shared/constants.ts";
import {
  callout,
  formFromSameSite,
  html,
  icon,
  layout,
  loadBusiness,
  messagePage,
  page,
  pageRedirect,
  whatsappHref,
  type Business,
  type Raw,
} from "./html.ts";

/** Clears the demo's enrollment cookie, which D1 sessions replace. */
export const CLEAR_LEGACY_COOKIE = `${LEGACY_ENROLL_COOKIE}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; Secure; SameSite=Lax`;

const methodNotAllowedPage = (business: Business) =>
  page(messagePage({ title: "Not allowed", business }, "Not allowed", "This page can't be used that way.", undefined, { icon: "warning-circle", tone: "warn" }), 405);

function crossSite(business: Business): Response {
  return page(
    messagePage(
      { title: "Please try again", business },
      "Please try again",
      "That form came from another site, so nothing was changed.",
      { href: "/signin", label: "Go to sign in" },
      { icon: "warning-circle", tone: "warn" },
    ),
    403,
  );
}

/** next=… from a query or form: a same-site path, never /signin or /auth (no loops). */
export function nextPath(value: unknown, fallback = "/account"): string {
  const path = safeRedirectPath(value);
  if (!path || /^\/(signin|auth)(?:[/?#.]|$)/.test(path)) return fallback;
  return path;
}

// ---------------------------------------------------------------- /signin

interface SigninState {
  email?: string;
  next: string;
  error?: string;
  /** This browser still had a session cookie, but the session has ended (signed out elsewhere, or by the 2-device limit). */
  ended?: boolean;
  /** Arrived from a link that had expired or was used. */
  expired?: boolean;
}

const LINK_MINUTES = Math.round(EMAIL_LINK_TTL / 60);

function signinForm(business: Business, state: SigninState): Raw {
  const help = whatsappHref(business, "Hi Urmi, I can't sign in to my course. Can you help?");
  const invalid = state.error ? html` aria-invalid="true" aria-describedby="email-hint form-error"` : html` aria-describedby="email-hint"`;
  return layout(
    { title: "Open your course", business },
    html`<section class="card narrow">
  <span class="state-icon">${icon("lock-simple")}</span>
  <h1>Open your course on this device</h1>
  <p class="lead">Enter the email you used for your course. We'll send you a link to sign in.</p>
  ${
    state.ended && !state.error
      ? callout(
          "info",
          html`This device was signed out. That happens when it is signed out from another device, or when you sign in on a new one: your course can be open on ${MAX_DEVICES_PER_STUDENT} devices at a time, and the one used least recently is signed out. Sign in again below.`,
        )
      : ""
  }
  ${state.expired && !state.error ? callout("info", "That sign-in link has expired or was already used. Enter your email for a new one.") : ""}
  ${state.error ? callout("alert", state.error, "form-error") : ""}
  <form method="post" action="/signin" class="form" novalidate>
    <input type="hidden" name="next" value="${state.next}">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" required maxlength="254"
      value="${state.email ?? ""}"${invalid}>
    <p class="hint" id="email-hint">The one you gave when you paid or enrolled. The link works once, for ${LINK_MINUTES} minutes.</p>
    <button type="submit" class="btn">Email me a sign-in link${icon("arrow-right")}</button>
  </form>
  <hr class="divider">
  <p class="help-line">${icon("device-mobile")}<span>You can be signed in on ${MAX_DEVICES_PER_STUDENT} devices. Signing in here signs out the device you used least recently if you're already on ${MAX_DEVICES_PER_STUDENT}.</span></p>
  ${help ? html`<p class="help-line">${icon("whatsapp")}<span>Changed your email, or no email arrives? <a href="${help}" target="_blank" rel="noopener noreferrer">Message us on WhatsApp</a> and we'll help.</span></p>` : ""}
</section>`,
  );
}

/** "Check your email": the same page whether or not the address has an account. */
function checkEmailPage(business: Business, email: string | null): Raw {
  const help = whatsappHref(business, "Hi Urmi, my sign-in email hasn't arrived. Can you help?");
  return layout(
    { title: "Check your email", business },
    html`<section class="card narrow state tone-ok">
  <span class="state-icon">${icon("check-circle")}</span>
  <h1>Check your email</h1>
  <p>${email ? html`If <strong>${email}</strong> has a course with us, a sign-in link is on its way.` : "If that email has a course with us, a sign-in link is on its way."} Open it on this device. It works once, for ${LINK_MINUTES} minutes.</p>
  <p class="muted small">Nothing after a few minutes? Look in Spam or Promotions, check the address, or <a href="/signin">try again</a>.${help ? html` Still nothing? <a href="${help}" target="_blank" rel="noopener noreferrer">Message us on WhatsApp</a>.` : ""}</p>
</section>`,
  );
}

/** Before the owner runs setup there is no D1, so no accounts: say so instead of failing. */
export function notSetUp(business: Business): Response {
  return page(
    messagePage({ title: "Not available yet", business }, "Not available yet", "Student accounts aren't set up on this site yet.", { href: "/", label: "See the courses" }, { icon: "clock", tone: "info" }),
    503,
  );
}

export async function handleSignin(request: Request, env: Env, now = unixNow(), ctx?: WaitUntil): Promise<Response> {
  const business = await loadBusiness(env.DB ?? null);
  if (!hasDb(env)) return notSetUp(business);
  const url = new URL(request.url);
  if (request.method === "GET" || request.method === "HEAD") {
    const next = nextPath(url.searchParams.get("next"));
    if (await readSession(env, request, now)) return pageRedirect(next, [], 302);
    // After checkout or a free enrollment the receipt and a link went to the buyer's email.
    if (url.searchParams.get("sent") === "1") return page(checkEmailPage(business, null), 200, [], request.method);
    // A session cookie that no longer opens a session: say why this device has to sign in again.
    return page(
      signinForm(business, { next, ended: sessionToken(request) !== null, expired: url.searchParams.get("expired") === "1" }),
      200,
      [],
      request.method,
    );
  }
  if (request.method !== "POST") return methodNotAllowedPage(business);
  if (!formFromSameSite(request)) return crossSite(business);

  const form = await readForm(request);
  if (!form) return page(signinForm(business, { next: "/account", error: "That was too much text. Please try again." }), 413);
  const state: SigninState = { email: (form.get("email") ?? "").slice(0, 254), next: nextPath(form.get("next")) };
  let result;
  try {
    result = await requestSignInLink(env, request, { email: state.email, next: state.next }, { now, ctx });
  } catch (err) {
    if (err instanceof ValidationError) return page(signinForm(business, { ...state, error: err.message }), 400);
    throw err;
  }
  if (!result.ok) {
    const minutes = Math.max(1, Math.ceil(result.retryAfter / 60));
    const response = page(
      signinForm(business, {
        ...state,
        error: `Too many tries. Please wait about ${minutes} minute${minutes === 1 ? "" : "s"}, then ask for a new link. Use the newest email we sent.`,
      }),
      429,
    );
    response.headers.set("Retry-After", String(result.retryAfter));
    return response;
  }
  return page(checkEmailPage(business, result.email), 200);
}

// ---------------------------------------------------------------- /auth/continue

/** An expired, used or unknown link: straight to the form for a new one. */
function expiredLink(business: Business): Response {
  const response = page(signinForm(business, { next: "/account", expired: true }), 410);
  return response;
}

function confirmPage(business: Business, token: string): Raw {
  return layout(
    { title: "Open your course", business },
    html`<section class="card narrow">
  <span class="state-icon">${icon("lock-simple")}</span>
  <h1>Open your course on this device</h1>
  <p class="lead">This link signs you in once. Continue on the phone or computer where you want to watch.</p>
  <form method="post" action="/auth/continue" class="form">
    <input type="hidden" name="t" value="${token}">
    <button type="submit" class="btn">Continue${icon("arrow-right")}</button>
  </form>
  <hr class="divider">
  <p class="help-line">${icon("device-mobile")}<span>You can be signed in on ${MAX_DEVICES_PER_STUDENT} devices. If you're already on ${MAX_DEVICES_PER_STUDENT}, the one you used least recently is signed out.</span></p>
</section>`,
  );
}

async function signInWithToken(request: Request, env: Env, token: unknown, now: number, business: Business): Promise<Response> {
  const used = await consumeLoginToken(env.DB, token, now);
  if (!used) return expiredLink(business);
  // An emailed or admin link proves the email. The first proof of this address signs out every
  // session from before it (a handoff session someone got by paying with an address that isn't
  // theirs), once; then this device signs in.
  let firstProof = false;
  if (used.purpose === "admin_link") {
    firstProof = await markEmailVerified(env.DB, used.studentId, now);
    if (firstProof) await revokeAllSessions(env.DB, used.studentId, now);
  }
  const { cookie } = await createSession(env.DB, used.studentId, request, now);
  await writeAudit(env.DB, {
    actor: `student:${used.studentId}`,
    action: used.purpose === "handoff" ? "student.handoff_signin" : "student.link_signin",
    entity: "student",
    entityId: used.studentId,
    ...(firstProof ? { data: { firstProof: true } } : {}),
    now,
  });
  return pageRedirect(used.redirectPath, [cookie, CLEAR_LEGACY_COOKIE]);
}

export async function handleContinue(request: Request, env: Env, now = unixNow()): Promise<Response> {
  const business = await loadBusiness(env.DB ?? null);
  if (!hasDb(env)) return notSetUp(business);
  if (request.method === "GET" || request.method === "HEAD") {
    const token = new URL(request.url).searchParams.get("t");
    const purpose = await peekLoginToken(env.DB, token, now);
    if (!purpose) return expiredLink(business);
    // The payment handoff comes straight from checkout's redirect: sign in at once. HEAD never uses a token.
    if (purpose === "handoff" && request.method === "GET") return signInWithToken(request, env, token, now, business);
    return page(confirmPage(business, token!), 200, [], request.method);
  }
  if (request.method !== "POST") return methodNotAllowedPage(business);
  if (!formFromSameSite(request)) return crossSite(business);
  const form = await readForm(request);
  return signInWithToken(request, env, form?.get("t") ?? null, now, business);
}

// ---------------------------------------------------------------- /learn/logout

export async function handleLogout(request: Request, env: Env, now = unixNow()): Promise<Response> {
  const business = await loadBusiness(env.DB ?? null);
  if (!hasDb(env)) return notSetUp(business);
  if (request.method === "POST") {
    if (!formFromSameSite(request)) return crossSite(business);
    const session = await readSession(env, request, now);
    if (session) await revokeSession(env.DB, session.studentId, session.sessionId, now);
    return pageRedirect("/", [clearSessionCookie(), CLEAR_LEGACY_COOKIE]);
  }
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowedPage(business);
  const signedIn = (await readSession(env, request, now)) !== null;
  return page(
    layout(
      { title: "Sign out", business, signedIn },
      html`<section class="card narrow state tone-info">
  <span class="state-icon">${icon("sign-out")}</span>
  <h1>Sign out of this device?</h1>
  <p>You can sign in again any time with a link we email you.</p>
  <form method="post" action="/learn/logout" class="btn-row"><button type="submit" class="btn">Sign out</button>${signedIn ? html`<a class="btn btn-quiet" href="/account">Stay signed in</a>` : ""}</form>
</section>`,
    ),
    200,
    [],
    request.method,
  );
}
