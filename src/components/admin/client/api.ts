/**
 * The admin's API calls: `call()` from src/lib/api-client.ts, plus one rule every screen shares:
 * a 401 `unauthorized` (the admin session ended) goes to the sign-in page and comes back here after.
 * Wrong passwords (401 `wrong_password`) are left to the form that sent them.
 */
import type { AdminMeResponse, EndpointKey, RequestOf, ResponseOf } from "../../../shared/api.ts";
import { ApiError, call, type ApiInit } from "../../../lib/api-client.ts";
import { signInHref } from "../lib/errors.ts";
import { DEFAULT_SITE_HOSTS, type SiteHosts } from "../lib/slug.ts";

export { ApiError };

let leaving = false;

/** Sends the owner to sign in, then back to this page. */
export function goToSignIn(): void {
  if (leaving) return;
  leaving = true;
  location.assign(signInHref(location.pathname + location.search));
}

export async function admin<K extends EndpointKey>(
  key: K,
  params: Record<string, string | number> = {},
  body?: RequestOf<K>,
  init: ApiInit = {},
): Promise<ResponseOf<K>> {
  try {
    return await call(key, params, body, init);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && err.code === "unauthorized") goToSignIn();
    throw err;
  }
}

/** Any thrown value as an ApiError (so screens can describe it). */
export function asApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError"))
    return new ApiError(0, { message: "That took too long. Check your connection and try again." });
  return new ApiError(500, { error: "server_error", message: "Something went wrong. Try again in a moment." });
}

// ---------------------------------------------------------------- the session and the site's hosts

let me: Promise<AdminMeResponse> | null = null;
let hosts: SiteHosts = DEFAULT_SITE_HOSTS;

/**
 * GET /api/admin/me, once per page (the shell and the screens share it). It also records the hub
 * host and the course domain the server uses, for siteHosts().
 */
export function adminMe(): Promise<AdminMeResponse> {
  if (!me) {
    me = admin("GET /api/admin/me").then((r) => {
      if (r.hubHost && r.apexDomain) hosts = { hubHost: r.hubHost, apexDomain: r.apexDomain };
      return r;
    });
    me.catch(() => {
      me = null; // a later call may try again
    });
  }
  return me;
}

/** Waits for the session check, so siteHosts() has the server's answer. Never throws. */
export async function hostsReady(): Promise<SiteHosts> {
  try {
    await adminMe();
  } catch {
    /* the defaults (production's hosts) */
  }
  return hosts;
}

/** The hosts course addresses are shown with (production's until GET /api/admin/me answers). */
export const siteHosts = (): SiteHosts => hosts;

// ---------------------------------------------------------------- file downloads

/**
 * Downloads a file the admin API serves as an attachment (the newest backup). Errors come back as
 * ApiError with the server's message (404 "no backup yet"); a 401 goes to the sign-in page.
 */
export async function download(path: `/api/admin/${string}`, fallbackName: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(120_000) });
  } catch (err) {
    throw err instanceof DOMException ? asApiError(err) : new ApiError(0, { message: "You seem to be offline. Check your connection and try again." });
  }
  if (!res.ok) {
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    const err = new ApiError(res.status, body);
    if (err.status === 401 && err.code === "unauthorized") goToSignIn();
    throw err;
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
