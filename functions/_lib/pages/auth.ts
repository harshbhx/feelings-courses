/**
 * Sign-in pages (W3), rendered by Functions on the hub:
 *
 *   /signin          restore access on a new device: phone or email + payment ID. A plain HTML
 *                    form (works without JavaScript); the same checks as POST /api/auth/restore.
 *   /auth/continue   a one-time link: "handoff" (right after payment, 10 min) signs in at once;
 *                    "admin_link" (sent by Urmi on WhatsApp, 24 h) first shows a Continue button,
 *                    because WhatsApp's link preview opens links and would use the token up.
 *   /learn/logout    POST signs this device out; GET only offers the button (no state change on GET).
 */
import { LEGACY_ENROLL_COOKIE } from "../config.ts";
import { writeAudit } from "../db/audit.ts";
import { unixNow } from "../db/d1.ts";
import { ValidationError } from "../db/errors.ts";
import { hasDb, type Env } from "../env.ts";
import { readForm } from "../http.ts";
import { restoreAccess } from "../restore.ts";
import {
  clearSessionCookie,
  consumeLoginToken,
  createSession,
  peekLoginToken,
  readSession,
  revokeSession,
  safeRedirectPath,
} from "../session.ts";
import {
  formFromSameSite,
  html,
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
  page(messagePage({ title: "Not allowed", business }, "Not allowed", "This page can't be used that way."), 405);

function crossSite(business: Business): Response {
  return page(
    messagePage({ title: "Please try again", business }, "Please try again", "That form came from another site, so nothing was changed.", {
      href: "/signin",
      label: "Go to sign in",
    }),
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
  contact?: string;
  paymentId?: string;
  next: string;
  error?: string;
  field?: "contact" | "paymentId";
}

function signinForm(business: Business, state: SigninState): Raw {
  const help = whatsappHref(business, "Hi Urmi, I bought a course and need a sign-in link for my new phone.");
  const invalid = (field: SigninState["field"]) => (state.field === field ? html` aria-invalid="true" aria-describedby="form-error"` : "");
  return layout(
    { title: "Open your course", business },
    html`<section class="card narrow">
  <h1>Open your course on this device</h1>
  <p class="lead">Enter the phone number or email you paid with, and the payment ID from your receipt.</p>
  ${state.error ? html`<p class="alert" id="form-error" role="alert">${state.error}</p>` : ""}
  <form method="post" action="/signin" class="form" novalidate>
    <input type="hidden" name="next" value="${state.next}">
    <label for="contact">Phone number or email</label>
    <input id="contact" name="contact" type="text" inputmode="email" autocomplete="username" required maxlength="254"
      value="${state.contact ?? ""}"${invalid("contact")}>
    <label for="paymentId">Payment ID</label>
    <input id="paymentId" name="paymentId" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" required
      maxlength="44" placeholder="pay_…" value="${state.paymentId ?? ""}"${invalid("paymentId")}>
    <p class="hint">It starts with <code>pay_</code>. You'll find it on your receipt page and in the SMS or email Razorpay sent after you paid.</p>
    <button type="submit" class="btn">Continue</button>
  </form>
  <p class="small">You can be signed in on 2 devices. Signing in here signs out the device you used least recently if you're already on 2.</p>
  ${help ? html`<p class="small">Lost your payment ID? <a href="${help}" target="_blank" rel="noopener noreferrer">Message us on WhatsApp</a> and we'll send you a one-time sign-in link.</p>` : ""}
</section>`,
  );
}

/** Before the owner runs setup there is no D1, so no accounts: say so instead of failing. */
export function notSetUp(business: Business): Response {
  return page(
    messagePage({ title: "Not available yet", business }, "Not available yet", "Student accounts aren't set up on this site yet."),
    503,
  );
}

export async function handleSignin(request: Request, env: Env, now = unixNow()): Promise<Response> {
  const business = await loadBusiness(env.DB ?? null);
  if (!hasDb(env)) return notSetUp(business);
  const url = new URL(request.url);
  if (request.method === "GET" || request.method === "HEAD") {
    const next = nextPath(url.searchParams.get("next"));
    if (await readSession(env, request, now)) return pageRedirect(next, [], 302);
    return page(signinForm(business, { next }), 200, [], request.method);
  }
  if (request.method !== "POST") return methodNotAllowedPage(business);
  if (!formFromSameSite(request)) return crossSite(business);

  const form = await readForm(request);
  if (!form) return page(signinForm(business, { next: "/account", error: "That was too much text. Please try again." }), 413);
  const state: SigninState = {
    contact: (form.get("contact") ?? "").slice(0, 254),
    paymentId: (form.get("paymentId") ?? "").slice(0, 44),
    next: nextPath(form.get("next")),
  };
  let result;
  try {
    result = await restoreAccess(env, request, { contact: state.contact, paymentId: state.paymentId }, now);
  } catch (err) {
    if (err instanceof ValidationError) {
      return page(signinForm(business, { ...state, error: err.message, field: err.field === "paymentId" ? "paymentId" : "contact" }), 400);
    }
    throw err;
  }
  if (!result.ok) {
    if (result.reason === "rate_limited") {
      const minutes = Math.max(1, Math.ceil(result.retryAfter / 60));
      const response = page(
        signinForm(business, {
          ...state,
          error: `Too many tries. Please wait about ${minutes} minute${minutes === 1 ? "" : "s"}, or message us on WhatsApp for a sign-in link.`,
        }),
        429,
      );
      response.headers.set("Retry-After", String(result.retryAfter));
      return response;
    }
    if (result.reason === "use_first_payment") {
      return page(
        signinForm(business, {
          ...state,
          paymentId: "",
          error:
            "This account has an earlier purchase. Enter the payment ID of your first purchase, or message us on WhatsApp for a sign-in link.",
          field: "paymentId",
        }),
        409,
      );
    }
    return page(
      signinForm(business, {
        ...state,
        error: "We couldn't find a payment with those details. Check the payment ID and the phone number or email you paid with.",
      }),
      400,
    );
  }
  const { cookie } = await createSession(env.DB, result.studentId, request, now);
  await writeAudit(env.DB, {
    actor: `student:${result.studentId}`,
    action: "student.restore",
    entity: "student",
    entityId: result.studentId,
    data: { orderId: result.orderId, via: result.via },
    now,
  });
  return pageRedirect(state.next, [cookie, CLEAR_LEGACY_COOKIE]);
}

// ---------------------------------------------------------------- /auth/continue

function expiredLink(business: Business): Response {
  return page(
    messagePage(
      { title: "Link expired", business },
      "This link has expired",
      "Sign-in links work once, for a short time. You can sign in with your phone number or email and payment ID, or ask us on WhatsApp for a new link.",
      { href: "/signin", label: "Sign in" },
    ),
    410,
  );
}

function confirmPage(business: Business, token: string): Raw {
  return layout(
    { title: "Open your course", business },
    html`<section class="card narrow">
  <h1>Open your course on this device</h1>
  <p class="lead">This link signs you in once. Continue on the phone or computer where you want to watch.</p>
  <form method="post" action="/auth/continue" class="form">
    <input type="hidden" name="t" value="${token}">
    <button type="submit" class="btn">Continue</button>
  </form>
  <p class="small">You can be signed in on 2 devices. If you're already on 2, the one you used least recently is signed out.</p>
</section>`,
  );
}

async function signInWithToken(request: Request, env: Env, token: unknown, now: number, business: Business): Promise<Response> {
  const used = await consumeLoginToken(env.DB, token, now);
  if (!used) return expiredLink(business);
  const { cookie } = await createSession(env.DB, used.studentId, request, now);
  await writeAudit(env.DB, {
    actor: `student:${used.studentId}`,
    action: used.purpose === "handoff" ? "student.handoff_signin" : "student.link_signin",
    entity: "student",
    entityId: used.studentId,
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
      html`<section class="card narrow">
  <h1>Sign out of this device?</h1>
  <p>You can sign in again any time with your phone number or email and payment ID.</p>
  <form method="post" action="/learn/logout" class="form"><button type="submit" class="btn">Sign out</button></form>
</section>`,
    ),
    200,
    [],
    request.method,
  );
}
