/**
 * The admin's API calls: `call()` from src/lib/api-client.ts, plus one rule every screen shares:
 * a 401 `unauthorized` (the admin session ended) goes to the sign-in page and comes back here after.
 * Wrong passwords (401 `wrong_password`) are left to the form that sent them.
 */
import type { EndpointKey, RequestOf, ResponseOf } from "../../../shared/api.ts";
import { ApiError, call, type ApiInit } from "../../../lib/api-client.ts";
import { signInHref } from "../lib/errors.ts";

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
