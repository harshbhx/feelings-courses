/**
 * The course area's gate. Every request for /learn, /learn/* and their .html twins passes through
 * gate() before Pages serves the static page:
 *
 *   functions/_middleware.ts         every request; gates percent-encoded and other odd spellings
 *                                    of a course path (/%6cearn, /learn%2Fsoft-glam, //learn)
 *   functions/learn/_middleware.ts   /learn/* (and /learn itself)
 *   functions/learn.ts               /learn, so the bare path is a Functions route of its own
 *   functions/learn.html.ts          /learn.html
 *
 * Enrolled (verifyEnrollment() returns an enrollment): the page, marked private and no-store.
 * Anything else, including an error while checking: a 302 to the price card. It never fails open.
 *
 * This file exports no onRequest*, so Pages does not turn it into a route.
 */
import { ENROLL_COOKIE, verifyEnrollment, type EnrollEnv, type Enrollment } from "../_lib/enrollment";

/** Where a visitor without a valid enrollment goes: the landing page's price card. */
export const LOCKED_LOCATION = "/?locked=1#pricing";
export const GATED_CACHE_CONTROL = "private, no-store";
export const LOGOUT_PATH = "/learn/logout";

export type Verify = (env: EnrollEnv, request: Request) => Promise<Enrollment | null>;

/** The parts of a Pages Functions EventContext the gate uses (kept small so tests can fake it). */
export interface GateContext {
  request: Request;
  env: EnrollEnv;
  data: Record<string, unknown>;
  next: () => Promise<Response>;
}

/** Statuses that must not carry a body (same list as Pages' own response cloning). */
const NULL_BODY = new Set([101, 204, 205, 304]);

function locked(): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: LOCKED_LOCATION, "Cache-Control": GATED_CACHE_CONTROL },
  });
}

/** Copies a response with Cache-Control: private, no-store (the course pages are personal). */
export function privateResponse(response: Response): Response {
  const copy = new Response(NULL_BODY.has(response.status) ? null : response.body, response);
  copy.headers.set("Cache-Control", GATED_CACHE_CONTROL);
  return copy;
}

/**
 * Checks the enrollment cookie, then serves the page (next()) or redirects to the price card.
 * `verify` is only swapped in tests.
 */
export async function gate(context: GateContext, verify: Verify = verifyEnrollment): Promise<Response> {
  const { request, env, data, next } = context;

  // On /learn the middleware runs first, then functions/learn.ts: check once per request.
  if (!data.enrollment) {
    let enrollment: Enrollment | null = null;
    try {
      enrollment = await verify(env, request);
    } catch (error) {
      console.error("learn gate: verifyEnrollment failed", error);
      enrollment = null;
    }
    // verifyEnrollment() already rejects expired cookies; the second look costs nothing.
    if (!enrollment || !(enrollment.expires * 1000 > Date.now())) return locked();
    data.enrollment = enrollment;
  }

  return privateResponse(await next());
}

/**
 * True when a raw request path lands in the course area once the static file server has made
 * sense of it. Pages matches _routes.json and Functions routes against the raw path, but serves
 * files by the decoded one: without this, /%6cearn or /learn%2Fsoft-glam would reach the course
 * pages and skip every gate above. Errs on the side of gating: it decodes up to three times,
 * turns backslashes into slashes, collapses repeated slashes, resolves dot segments and ignores
 * case.
 */
export function isCoursePath(rawPath: string): boolean {
  let path = rawPath;
  for (let i = 0; i < 3 && path.includes("%"); i++) {
    // Byte by byte, so a malformed or multi-byte sequence never throws; the prefix is ASCII.
    path = path.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }
  const segments: string[] = [];
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return /^\/learn(?:[/.]|$)/i.test(`/${segments.join("/")}`);
}

/**
 * functions/_middleware.ts (every request): sends anything that resolves to the course area
 * through the gate, whatever its spelling. Everything else passes straight on.
 */
export function siteMiddleware(context: GateContext, verify: Verify = verifyEnrollment): Promise<Response> {
  const { pathname } = new URL(context.request.url);
  return isCoursePath(pathname) ? learnMiddleware(context, verify) : context.next();
}

/** functions/learn/_middleware.ts: gates everything under /learn except the logout link. */
export function learnMiddleware(context: GateContext, verify: Verify = verifyEnrollment): Promise<Response> {
  const { pathname } = new URL(context.request.url);
  // Logging out needs no enrollment and shows nothing, so an expired cookie can still be cleared.
  if (pathname === LOGOUT_PATH || pathname === `${LOGOUT_PATH}/`) return context.next();
  return gate(context, verify);
}

/** /learn/logout: clears the enrollment cookie (HttpOnly, so only the server can) and goes home. */
export function logout(request: Request): Response {
  return new Response(null, {
    // A form posts here; 303 turns the follow-up into a GET. A plain link gets the usual 302.
    status: request.method === "POST" ? 303 : 302,
    headers: {
      Location: "/",
      "Set-Cookie": `${ENROLL_COOKIE}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`,
      "Cache-Control": GATED_CACHE_CONTROL,
    },
  });
}
