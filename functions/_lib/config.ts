/**
 * Runtime configuration: env values read safely, plus the platform's fixed numbers (cookie names,
 * lifetimes, rate limits). Every workstream reads these from here instead of retyping them.
 */
import { DEFAULT_APEX_DOMAIN, DEFAULT_HUB_HOST, MAX_DEVICES_PER_STUDENT } from "../../src/shared/constants.ts";
import type { AppEnv, PaymentMode } from "../../src/shared/types.ts";
import type { Env } from "./env.ts";

export interface AppConfig {
  appEnv: AppEnv;
  hubHost: string;
  apexDomain: string;
  /** https://<hubHost> */
  hubOrigin: string;
  /** Razorpay mode from the key prefix, or null when no valid key id is set. */
  paymentMode: PaymentMode | null;
}

const APP_ENVS: readonly AppEnv[] = ["production", "preview", "development"];
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The env's plain values with safe defaults. A missing or unknown APP_ENV counts as "production",
 * the most restrictive: preview-only features (dev seed) stay off.
 */
export function config(env: Partial<Env>): AppConfig {
  const appEnv = APP_ENVS.includes(env.APP_ENV as AppEnv) ? (env.APP_ENV as AppEnv) : "production";
  const host = (value: string | undefined, fallback: string) => {
    const tidy = value?.trim().toLowerCase() ?? "";
    return HOST_RE.test(tidy) ? tidy : fallback;
  };
  const hubHost = host(env.HUB_HOST, DEFAULT_HUB_HOST);
  return {
    appEnv,
    hubHost,
    apexDomain: host(env.APEX_DOMAIN, DEFAULT_APEX_DOMAIN),
    hubOrigin: `https://${hubHost}`,
    paymentMode: razorpayMode(env.RAZORPAY_KEY_ID),
  };
}

/** "test" for rzp_test_…, "live" for rzp_live_…, else null. */
export function razorpayMode(keyId: string | undefined): PaymentMode | null {
  const m = /^rzp_(test|live)_[A-Za-z0-9]+$/.exec(keyId?.trim() ?? "");
  return m ? (m[1] as PaymentMode) : null;
}

/** Thrown when a secret the request needs isn't set. Endpoints answer 503 platform_not_configured. */
export class ConfigError extends Error {
  readonly secret: string;
  constructor(secret: string) {
    super(`${secret} is not set (run the owner setup script)`);
    this.name = "ConfigError";
    this.secret = secret;
  }
}

type SecretName = "APP_SECRET" | "ADMIN_PASSWORD_HASH" | "DEPLOY_HOOK_URL" | "RAZORPAY_KEY_ID" | "RAZORPAY_KEY_SECRET" | "RAZORPAY_WEBHOOK_SECRET";

/** A secret's value, trimmed. Throws ConfigError when missing or shorter than `minLength`. */
export function requireSecret(env: Partial<Env>, name: SecretName, minLength = 16): string {
  const value = env[name]?.trim() ?? "";
  if (value.length < minLength) throw new ConfigError(name);
  return value;
}

// ---------------------------------------------------------------- fixed numbers (plan 1.4, 1.5, 1.6, 1.13)

export const MINUTE = 60;
export const HOUR = 3600;
export const DAY = 86_400;

/** Student session cookie (hub only). */
export const SESSION_COOKIE = "__Host-fbc_s";
export const SESSION_TTL = 180 * DAY;
/** last_seen_at is refreshed at most this often (saves writes). */
export const SESSION_TOUCH_INTERVAL = DAY;
/** 2 devices (owner decision, plan 10.7): the 3rd sign-in revokes the oldest session. */
export const MAX_SESSIONS_PER_STUDENT = MAX_DEVICES_PER_STUDENT;

/** Admin session cookie (hub only). */
export const ADMIN_COOKIE = "__Host-fbc_admin";
export const ADMIN_IDLE_TTL = 12 * HOUR;
export const ADMIN_ABSOLUTE_TTL = 7 * DAY;
export const ADMIN_PASSWORD_MIN_LENGTH = 14;

/** The demo's HMAC enrollment cookie, ignored and cleared once D1 sessions exist. */
export const LEGACY_ENROLL_COOKIE = "fbc_enroll";

export const LOGIN_TOKEN_TTL: Record<"handoff" | "admin_link", number> = {
  handoff: 10 * MINUTE,
  admin_link: DAY,
};

/** Signed media URLs. */
export const MEDIA_URL_TTL = 2 * HOUR;
/** sidTag for free-preview URLs (no cookie check). */
export const PUBLIC_SESSION_TAG = "public";
export const UPLOAD_PART_SIZE = 10 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;

/** Default JSON body cap (http.ts readJson). */
export const MAX_JSON_BYTES = 16 * 1024;

/** Deploy hook debounce. */
export const REBUILD_DEBOUNCE = 120;

export interface RateLimitRule {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in seconds (fixed windows aligned to the epoch). */
  window: number;
}

/**
 * Plan 1.13. Bucket keys are built by ratelimit.ts as `<name>:<subject>:<windowStart>`, for example
 * "restore_ip:203.0.113.9:1761200000".
 */
export const RATE_LIMITS = {
  admin_login_ip: { limit: 5, window: 15 * MINUTE },
  admin_login_global: { limit: 20, window: DAY },
  restore_ip: { limit: 5, window: 15 * MINUTE },
  restore_contact: { limit: 5, window: DAY },
  order_ip: { limit: 10, window: 10 * MINUTE },
  order_phone: { limit: 20, window: DAY },
  coupon_quote_ip: { limit: 20, window: 10 * MINUTE },
  track_ip: { limit: 60, window: MINUTE },
  certificate_ip: { limit: 30, window: MINUTE },
} as const satisfies Record<string, RateLimitRule>;
export type RateLimitName = keyof typeof RATE_LIMITS;

/** After admin_login_global is exceeded, the login form stays locked this long. */
export const ADMIN_LOCKOUT = HOUR;
