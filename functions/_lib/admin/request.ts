/**
 * Small helpers the admin API's route files share (W5): one place for method dispatch, path and
 * query parsing, JSON bodies and error mapping, so every route answers in the same shape.
 *
 *   export const onRequest = adminRoute({
 *     GET: async (ctx) => json(await getCourse(ctx.env.DB, pathId(ctx.params.id))),
 *   });
 *
 * Authentication, the Origin check and the JSON content-type rule run before any of this, in
 * functions/api/admin/_middleware.ts.
 */
import type { Db } from "../db/d1.ts";
import { ConflictError, ValidationError } from "../db/errors.ts";
import type { Env } from "../env.ts";
import { error, errorResponse, methodNotAllowed, readJson } from "../http.ts";

/** What the admin middleware stores in `context.data` for the routes behind it. */
export interface AdminLocals {
  admin?: { sessionId: number; expiresAt: number };
}

/** The parts of a Pages EventContext the admin routes use (tests pass plain objects). */
export interface AdminContext {
  request: Request;
  env: Env;
  params: Record<string, string | string[] | undefined>;
  data: AdminLocals & Record<string, unknown>;
  waitUntil(promise: Promise<unknown>): void;
}

export type AdminHandler = (ctx: AdminContext) => Promise<Response> | Response;

/** A record that doesn't exist (or was deleted). Answers 404 not_found. */
export class NotFoundError extends Error {
  constructor(message = "That doesn't exist.") {
    super(message);
    this.name = "NotFoundError";
  }
}

/** A finished response thrown from deep inside a handler (a bad body, a rate limit). */
export class ResponseError extends Error {
  readonly response: Response;
  constructor(response: Response) {
    super(`response ${response.status}`);
    this.name = "ResponseError";
    this.response = response;
  }
}

/** Maps thrown errors to API responses: the W0 mapping plus 404 for NotFoundError. */
export function adminErrorResponse(err: unknown): Response {
  if (err instanceof ResponseError) return err.response;
  if (err instanceof NotFoundError) return error(404, "not_found", err.message);
  // W2's refundOrder reports a missing order as ConflictError("not_found").
  if (err instanceof ConflictError && err.code === "not_found") return error(404, "not_found", err.message);
  return errorResponse(err);
}

/**
 * A route: one handler per method. Other methods answer 405 with an Allow header; thrown errors
 * become API errors (400, 404, 409, 501, 503, or a logged 500).
 */
export function adminRoute(
  handlers: Partial<Record<"GET" | "POST" | "PUT" | "DELETE", AdminHandler>>,
): (context: EventContext<Env, any, any>) => Promise<Response> {
  const allowed = Object.keys(handlers);
  return async (context) => {
    const ctx = context as unknown as AdminContext;
    const handler = handlers[ctx.request.method as keyof typeof handlers];
    if (!handler) return methodNotAllowed(allowed);
    try {
      return await handler(ctx);
    } catch (err) {
      return adminErrorResponse(err);
    }
  };
}

/** The database (the middleware has already checked the binding exists). */
export function dbOf(ctx: AdminContext): Db {
  return ctx.env.DB;
}

/** A path parameter that must be a positive id. Anything else is a 404 (no such record). */
export function pathId(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,14}$/.test(raw)) throw new NotFoundError();
  return Number(raw);
}

/**
 * Larger body caps than the API's 16 KB default, where the schema allows long text: a course
 * (description up to 20,000 characters, details JSON up to 50,000) and a whole outline (up to 300
 * lessons with notes).
 */
export const COURSE_BODY_BYTES = 128 * 1024;
export const OUTLINE_BODY_BYTES = 512 * 1024;

/** The JSON object body, or a thrown 400 / 413 response. */
export async function body(ctx: AdminContext, maxBytes?: number): Promise<Record<string, unknown>> {
  const result = await readJson(ctx.request, maxBytes);
  if (!result.ok) throw new ResponseError(result.response);
  return result.value;
}

/** Query string helpers. Every value is validated; a bad one is a 400 naming the parameter. */
export function query(request: Request) {
  const params = new URL(request.url).searchParams;
  const raw = (name: string): string | null => {
    const value = params.get(name);
    return value === null || value.trim() === "" ? null : value.trim();
  };
  return {
    string(name: string, max = 100): string | null {
      const value = raw(name);
      if (value === null) return null;
      if (value.length > max) throw new ValidationError(name, `${name} is too long.`);
      return value;
    },
    int(name: string, min: number, max: number): number | null {
      const value = raw(name);
      if (value === null) return null;
      if (!/^-?[0-9]{1,15}$/.test(value)) throw new ValidationError(name, `${name} must be a whole number.`);
      const n = Number(value);
      if (n < min || n > max) throw new ValidationError(name, `${name} must be from ${min} to ${max}.`);
      return n;
    },
    oneOf<T extends string>(name: string, allowed: readonly T[]): T | null {
      const value = raw(name);
      if (value === null) return null;
      if (!(allowed as readonly string[]).includes(value)) {
        throw new ValidationError(name, `${name} must be one of: ${allowed.join(", ")}.`);
      }
      return value as T;
    },
    date(name: string): string | null {
      const value = raw(name);
      if (value === null) return null;
      if (!isIsoDate(value)) throw new ValidationError(name, `${name} must be a date like 2026-10-23.`);
      return value;
    },
    flag(name: string): boolean {
      const value = raw(name);
      return value === "1" || value === "true";
    },
  };
}

/** True for a real calendar date written "YYYY-MM-DD". */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d && y >= 2000 && y <= 2100;
}

/** India is UTC+5:30 all year (no daylight saving). */
export const IST_OFFSET_SECONDS = 19_800;

/** Unix seconds at 00:00 India time on `day` ("YYYY-MM-DD"). */
export function istDayStart(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 1000 - IST_OFFSET_SECONDS;
}

/** The India-time calendar day of a unix time. */
export function istDay(unix: number): string {
  return new Date((unix + IST_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10);
}

/** "2026-10-23 14:05" in India time, for CSV exports. */
export function istDateTime(unix: number | null): string {
  if (unix === null) return "";
  return new Date((unix + IST_OFFSET_SECONDS) * 1000).toISOString().slice(0, 16).replace("T", " ");
}

/** A 204 for deletes and other writes with nothing to return. */
export function noContent(headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", ...headers } });
}

/** "+91 ••••• •1578". Shown in lists, so a screen share doesn't leak whole numbers. */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  const last4 = digits.slice(-4);
  if (phone.startsWith("+91") && digits.length === 12) return `+91 ••••• •${last4}`;
  const country = digits.slice(0, Math.max(1, digits.length - 10));
  return `+${country} •••• ${last4}`;
}
