/**
 * Turning API errors into what the owner reads, and the sign-in redirect. The API's `message` is
 * already written for the owner; this adds the cases where a different sentence helps (not set up
 * yet, a part of the platform that isn't switched on yet, offline, rate limits).
 */
import { roughDuration } from "./time.ts";

/** The parts of api-client's ApiError this needs (so tests can pass plain objects). */
export interface ErrorLike {
  status: number;
  code: string;
  message: string;
  retryAfter: number | null;
}

export type ErrorKind = "signin" | "offline" | "setup" | "coming" | "wait" | "missing" | "conflict" | "invalid" | "server";

export interface ErrorView {
  kind: ErrorKind;
  title: string;
  message: string;
  /** A retry button makes sense. */
  retry: boolean;
}

/** What to show for a failed request. `what` names the thing, for "couldn't load …" titles. */
export function describeError(err: ErrorLike, what = "this"): ErrorView {
  if (err.status === 0) return { kind: "offline", title: "You're offline", message: err.message, retry: true };
  if (err.status === 401 && err.code === "unauthorized")
    return { kind: "signin", title: "Signed out", message: "Your admin session ended. Sign in again to carry on.", retry: false };
  if (err.code === "platform_not_configured" || err.status === 503)
    return {
      kind: "setup",
      title: "Not set up yet",
      message: "The course platform isn't connected yet. Harsh runs the one-time setup (npm run setup), then this works.",
      retry: true,
    };
  // Every workstream is merged on the integration branch, so a 501 only comes from a deployment that
  // is behind this admin (an older Functions build). Nothing was changed on the server.
  if (err.code === "not_implemented" || err.status === 501)
    return {
      kind: "coming",
      title: "Not switched on yet",
      message: "This part isn't switched on in this copy of the site yet. Nothing was changed.",
      retry: false,
    };
  if (err.status === 429) {
    const wait = err.retryAfter ? ` Try again in ${roughDuration(err.retryAfter)}.` : " Try again in a little while.";
    return { kind: "wait", title: "Too many tries", message: err.message.replace(/\s*Please wait.*$/, "") + wait, retry: false };
  }
  if (err.status === 404) return { kind: "missing", title: "Not found", message: err.message || `We couldn't find ${what}.`, retry: false };
  if (err.status === 409) return { kind: "conflict", title: "Can't do that", message: err.message, retry: false };
  if (err.status === 400 || err.status === 413 || err.status === 415)
    return { kind: "invalid", title: "Check the details", message: err.message, retry: false };
  return {
    kind: "server",
    title: `Couldn't load ${what}`,
    message: err.message && err.status < 500 ? err.message : "Something went wrong on our side. Try again in a moment.",
    retry: true,
  };
}

/**
 * Where to go after signing in. Only admin pages on this site: never an outside address, never
 * the sign-in page itself.
 */
export function safeNext(next: string | null | undefined): string {
  const fallback = "/admin/dashboard";
  if (!next) return fallback;
  if (!/^\/admin\/[a-z0-9/_-]*(\?[\w=&%.+-]*)?(#[\w-]*)?$/i.test(next)) return fallback;
  if (next.startsWith("//") || next.includes("..") || next.includes("\\")) return fallback;
  return next;
}

/** The sign-in page's address that brings the owner back to `here` afterwards. */
export function signInHref(here: string): string {
  const next = safeNext(here);
  return next === "/admin/dashboard" ? "/admin" : `/admin?next=${encodeURIComponent(next)}`;
}
