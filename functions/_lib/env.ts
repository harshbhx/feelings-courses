/**
 * The Pages Functions environment: bindings, variables and secrets.
 *
 * Set by the owner's setup script (scripts/setup.mjs, W7) through the Pages API, per environment
 * (production / preview). Nothing here is committed in a wrangler.toml (plan 1.16).
 *
 * Until the owner has run setup, the live project has none of these except ASSETS. So:
 * - code that runs on every request (functions/_middleware.ts) checks `hasDb(env)` first;
 * - secrets are typed optional: read them through config.ts `requireSecret()`, which refuses a
 *   missing or short value instead of signing with "undefined".
 */
import type { AppEnv } from "../../src/shared/types.ts";

export interface Env {
  /** D1: fbc-courses (production) / fbc-courses-preview (preview). */
  DB: D1Database;
  /** R2: fbc-media / fbc-media-preview. Lesson videos, captions, images, backups. */
  MEDIA: R2Bucket;
  /** Pages' static assets (built in). */
  ASSETS: Fetcher;

  /** "production" | "preview". Read through config(env).appEnv (defaults to "production"). */
  APP_ENV?: AppEnv;
  /** courses.feelingsbeautycare.in. Read through config(env).hubHost. */
  HUB_HOST?: string;
  /** feelingsbeautycare.in. Read through config(env).apexDomain. */
  APEX_DOMAIN?: string;

  /** 32 random bytes: signs media URLs, peppers the admin password hash. */
  APP_SECRET?: string;
  /** hex(HMAC-SHA256(APP_SECRET, password)). settings.admin_password_hash overrides it. */
  ADMIN_PASSWORD_HASH?: string;
  /** Pages deploy hook (production only). */
  DEPLOY_HOOK_URL?: string;

  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;

  /**
   * @deprecated The demo's enrollment cookie key (functions/_lib/enrollment.ts). Removed by W3 when
   * D1 sessions replace the cookie.
   */
  ENROLL_SECRET?: string;
}

/** True when the D1 binding exists (the owner has run setup). */
export function hasDb(env: Partial<Env>): env is Partial<Env> & { DB: D1Database } {
  return typeof (env as { DB?: unknown }).DB === "object" && env.DB !== null;
}

/** The Pages Functions context, typed with this Env. */
export type Context<Params extends string = string> = EventContext<Env, Params, Record<string, unknown>>;

// Compile-time check: Cloudflare's D1Database fits the data layer's Db interface, so env.DB can be
// passed to every db/ helper as it is. A wrong fit fails `tsc -p functions`.
type Fits<A, B> = A extends B ? true : false;
export type D1FitsDb = Fits<D1Database, import("./db/d1.ts").Db>;
const d1FitsDb: D1FitsDb = true;
void d1FitsDb;
