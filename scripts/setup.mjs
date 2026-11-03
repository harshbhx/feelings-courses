// The owner's one-time setup (W7; hub page section 5, docs/owner/SETUP.md, docs/ops/CLOUDFLARE-API.md).
//
//   npm run setup -- --check                 only validate setup.local.json (no network)
//   npm run setup -- --dry-run               read Cloudflare, print the plan, change nothing
//   npm run setup -- --env preview           the preview environment only (do this first)
//   npm run setup                            both environments, test keys
//   npm run go-live -- --dry-run             the go-live checks and plan, change nothing
//   npm run go-live                          live Razorpay keys (rzp_live_…), PRODUCTION ONLY
//   npm run setup -- --add-domain <slug>     attach <slug>.<apex> to the Pages project + its DNS record
//
// Reads setup.local.json (gitignored; copy setup.example.json). Writes, all gitignored and mode 600:
//   setup.local.out.json / .out.txt   the generated admin passwords and webhook secrets;
//   setup.local.backup-<time>.json    before every change: the project's bindings and variable
//                                     names (secret values are never readable, so never saved),
//                                     each database's Time Travel bookmark, the buckets' lifecycle.
// It NEVER prints a secret: the console only shows names, ids and actions.
//
// What a run does, per environment it touches:
//   1. reads the Pages project (refuses if a wrangler config in the repo would own its bindings);
//   2. finds the D1 database (fbc-courses / fbc-courses-preview) and R2 bucket (fbc-media /
//      fbc-media-preview); missing ones are created AFTER you confirm, with an Asia-Pacific
//      location hint (only honoured at creation);
//   3. checks the bucket isn't public (r2.dev) and adds one lifecycle rule: database dumps under
//      backups/d1/ expire after 35 days, as the privacy policy says. Existing rules are kept
//      (the lifecycle API replaces the whole list, so it is read, merged and written back);
//   4. PATCHes the project's deployment config: the DB and MEDIA bindings, plain variables
//      (APP_ENV, HUB_HOST, APEX_DOMAIN, RAZORPAY_KEY_ID) and secrets (APP_SECRET,
//      ADMIN_PASSWORD_HASH, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, DEPLOY_HOOK_URL).
//      The Pages API merges env_vars per key (a key set to null is deleted; wrangler's own
//      `pages secret put` sends one key at a time), so variables set by hand are kept;
//   5. reads the project back and checks every variable and binding that existed before is still
//      there and every one it set is present.
// It refuses to point an existing DB or MEDIA binding at a different database or bucket (for
// example after a restore switched production to fbc-courses-restore) unless --allow-rebind.
// The database schema needs no step: the site migrates itself on the first request
// (functions/_lib/migrate.ts uses wrangler's own d1_migrations table).
//
// Re-running is safe: existing resources are reused, generated secrets are reused from
// setup.local.out.json (delete that file to rotate them), and a run that would change nothing
// still sets the same values again.

import { createHmac, randomBytes, randomInt } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

export const ROOT = path.resolve(import.meta.dirname, "..");
const API = "https://api.cloudflare.com/client/v4";

/** Files next to package.json (a test passes its own root). */
export function filesIn(root = ROOT) {
  return {
    config: path.join(root, "setup.local.json"),
    outJson: path.join(root, "setup.local.out.json"),
    outTxt: path.join(root, "setup.local.out.txt"),
    backup: (stamp) => path.join(root, `setup.local.backup-${stamp}.json`),
    wranglerConfigs: ["wrangler.toml", "wrangler.json", "wrangler.jsonc"].map((f) => path.join(root, f)),
  };
}
// Kept for callers of the first version.
export const CONFIG_FILE = filesIn().config;
export const OUT_JSON = filesIn().outJson;
export const OUT_TXT = filesIn().outTxt;

export const ENVIRONMENTS = {
  production: { d1: "fbc-courses", r2: "fbc-media", appEnv: "production" },
  preview: { d1: "fbc-courses-preview", r2: "fbc-media-preview", appEnv: "preview" },
};

/** D1 and R2 location hints (both APIs accept the same six). India is closest to apac. */
export const LOCATIONS = ["apac", "weur", "eeur", "wnam", "enam", "oc"];

const DEFAULTS = {
  project: "feelings-courses",
  hubHost: "courses.feelingsbeautycare.in",
  apexDomain: "feelingsbeautycare.in",
  location: "apac",
};

/** The R2 lifecycle rule for database dumps (functions/_lib/backup.ts BACKUP_PREFIX). */
export const BACKUP_RULE = {
  id: "fbc-backups-35d",
  enabled: true,
  conditions: { prefix: "backups/d1/" },
  deleteObjectsTransition: { condition: { type: "Age", maxAge: 35 * 86400 } },
};

// Course slug rule, a copy of src/shared/constants.ts (this script runs on plain Node, which can't
// import TypeScript everywhere). tests/w7/scripts.test.mjs checks both agree.
export const COURSE_SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,39}$/;
export const RESERVED_LABELS = [
  "www", "courses", "admin", "api", "app", "mail", "review", "preview", "staging", "static", "cdn",
  "media", "blog", "shop", "book", "m", "salon", "academy", "bridal", "nails", "mehndi",
];

// ---------------------------------------------------------------- arguments

const FLAGS = new Set(["--live", "--check", "--dry-run", "--yes", "--allow-rebind"]);

/**
 * Parses the command line. Unknown flags are errors: a typo such as `--dryrun` must never fall
 * through to a real run.
 */
export function parseArgs(argv) {
  const out = { live: false, checkOnly: false, dryRun: false, yes: false, allowRebind: false, envs: Object.keys(ENVIRONMENTS), addDomain: null, errors: [] };
  let envArg = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, null];
    if (flag === "--env" || flag === "--add-domain") {
      const value = inline ?? argv[++i];
      if (!value || value.startsWith("--")) out.errors.push(`${flag} needs a value`);
      else if (flag === "--env") envArg = value;
      else out.addDomain = value.trim().toLowerCase();
      continue;
    }
    if (!FLAGS.has(arg)) {
      out.errors.push(`unknown option ${arg}`);
      continue;
    }
    if (arg === "--live") out.live = true;
    if (arg === "--check") out.checkOnly = true;
    if (arg === "--dry-run") out.dryRun = true;
    if (arg === "--yes") out.yes = true;
    if (arg === "--allow-rebind") out.allowRebind = true;
  }
  if (envArg !== null) {
    if (envArg === "all") out.envs = Object.keys(ENVIRONMENTS);
    else if (envArg in ENVIRONMENTS) out.envs = [envArg];
    else out.errors.push("--env is production, preview or all");
  }
  if (out.live) {
    // Live keys never go to previews: every branch push deploys one, and it must not take money.
    if (envArg !== null && envArg !== "production") out.errors.push("go-live sets the production environment only");
    out.envs = ["production"];
  }
  if (out.addDomain !== null) {
    if (out.live) out.errors.push("--add-domain is its own step; run it without --live");
    if (!isValidCourseSlug(out.addDomain)) out.errors.push("--add-domain: a course slug (2 to 40 of a-z, 0-9, inner hyphens; not a reserved name)");
  }
  return out;
}

export function isValidCourseSlug(slug) {
  return COURSE_SLUG_RE.test(slug) && !RESERVED_LABELS.includes(slug);
}

// ---------------------------------------------------------------- config

/**
 * Validates setup.local.json. Returns { config, errors }: errors name the field, never its value.
 * @param {unknown} raw
 * @param {{ live?: boolean, cloudflareOnly?: boolean }} options cloudflareOnly: --add-domain needs no Razorpay keys
 */
export function validateConfig(raw, { live = false, cloudflareOnly = false } = {}) {
  const errors = [];
  const c = raw && typeof raw === "object" ? raw : {};
  const cf = c.cloudflare && typeof c.cloudflare === "object" ? c.cloudflare : {};
  const rp = c.razorpay && typeof c.razorpay === "object" ? c.razorpay : {};
  const str = (v) => (typeof v === "string" ? v.trim() : "");

  const config = {
    accountId: str(cf.accountId),
    apiToken: str(cf.apiToken),
    project: str(cf.project) || DEFAULTS.project,
    location: str(cf.location) || DEFAULTS.location,
    hubHost: str(c.hubHost) || DEFAULTS.hubHost,
    apexDomain: str(c.apexDomain) || DEFAULTS.apexDomain,
    keyId: str(rp.keyId),
    keySecret: str(rp.keySecret),
    deployHookUrl: str(c.deployHookUrl),
  };

  if (!/^[0-9a-f]{32}$/.test(config.accountId)) errors.push("cloudflare.accountId: 32 hex characters (dashboard → Workers & Pages → Account ID)");
  if (config.apiToken.length < 30) errors.push("cloudflare.apiToken: an API token with Pages Edit, D1 Edit and R2 Edit (not the global key)");
  if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(config.project)) errors.push("cloudflare.project: the Pages project name");
  if (!LOCATIONS.includes(config.location)) errors.push(`cloudflare.location: one of ${LOCATIONS.join(", ")} (or leave it out for apac)`);
  const host = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
  if (!host.test(config.hubHost)) errors.push("hubHost: a host name like courses.feelingsbeautycare.in");
  if (!host.test(config.apexDomain)) errors.push("apexDomain: a domain like feelingsbeautycare.in");
  if (cloudflareOnly) return { config, errors };

  const mode = /^rzp_(test|live)_[A-Za-z0-9]{6,}$/.exec(config.keyId)?.[1];
  if (!mode) errors.push("razorpay.keyId: rzp_test_… or rzp_live_…");
  else if (live && mode !== "live") errors.push("razorpay.keyId: go-live needs the live key id (rzp_live_…)");
  else if (!live && mode !== "test") errors.push("razorpay.keyId: setup uses the test key id (rzp_test_…); live keys go through `npm run go-live`");
  if (config.keySecret.length < 16) errors.push("razorpay.keySecret: the key secret shown once when the key was generated");
  if (config.deployHookUrl && !/^https:\/\/api\.cloudflare\.com\/client\/v4\/pages\/webhooks\/deploy_hooks\/[A-Za-z0-9-]+$/.test(config.deployHookUrl)) {
    errors.push("deployHookUrl: the Pages deploy hook URL (Settings → Builds → Deploy hooks), or leave it out");
  }
  return { config, errors };
}

// ---------------------------------------------------------------- generated secrets

const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A random password: 20 characters from an unambiguous alphabet (about 115 bits). */
export function generatePassword(length = 20) {
  let out = "";
  for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  return out;
}

/** hex(HMAC-SHA256(APP_SECRET, password)), as functions/_lib/env.ts ADMIN_PASSWORD_HASH defines it. */
export function adminPasswordHash(appSecret, password) {
  return createHmac("sha256", appSecret).update(password).digest("hex");
}

/** Generated values per environment, reused from setup.local.out.json when present. */
export function generatedSecrets(previous = {}) {
  const out = {};
  for (const env of Object.keys(ENVIRONMENTS)) {
    const prev = previous[env] ?? {};
    const appSecret = prev.appSecret ?? randomBytes(32).toString("hex");
    const adminPassword = prev.adminPassword ?? generatePassword();
    out[env] = {
      appSecret,
      adminPassword,
      adminPasswordHash: adminPasswordHash(appSecret, adminPassword),
      webhookSecret: prev.webhookSecret ?? randomBytes(24).toString("base64url"),
    };
  }
  return out;
}

// ---------------------------------------------------------------- the deployment config patch

/**
 * The body of PATCH /accounts/:id/pages/projects/:name for the given environments (default both).
 * Pure, so the test checks exactly what would be sent (with secrets replaced by placeholders there).
 */
export function deploymentConfigPatch(config, secrets, databases, envs = Object.keys(ENVIRONMENTS)) {
  const deployment_configs = {};
  for (const env of envs) {
    const spec = ENVIRONMENTS[env];
    const s = secrets[env];
    const plain = (value) => ({ type: "plain_text", value });
    const secret = (value) => ({ type: "secret_text", value });
    const env_vars = {
      APP_ENV: plain(spec.appEnv),
      HUB_HOST: plain(config.hubHost),
      APEX_DOMAIN: plain(config.apexDomain),
      RAZORPAY_KEY_ID: plain(config.keyId),
      APP_SECRET: secret(s.appSecret),
      ADMIN_PASSWORD_HASH: secret(s.adminPasswordHash),
      RAZORPAY_KEY_SECRET: secret(config.keySecret),
      RAZORPAY_WEBHOOK_SECRET: secret(s.webhookSecret),
    };
    // Only production rebuilds on publish; a preview never calls the hook.
    if (env === "production" && config.deployHookUrl) env_vars.DEPLOY_HOOK_URL = secret(config.deployHookUrl);
    deployment_configs[env] = {
      d1_databases: { DB: { id: databases[env] } },
      r2_buckets: { MEDIA: { name: spec.r2 } },
      env_vars,
    };
  }
  return { deployment_configs };
}

/**
 * The PATCH body as sent: `wrangler_config_hash` is echoed back per environment when the project
 * has one, exactly as wrangler's own `pages secret put` does.
 */
export function withConfigHash(patch, project) {
  const body = structuredClone(patch);
  for (const [env, cfg] of Object.entries(body.deployment_configs)) {
    const hash = project?.deployment_configs?.[env]?.wrangler_config_hash;
    if (hash) cfg.wrangler_config_hash = hash;
  }
  return body;
}

/** Variable names in a project's config, per environment. */
export function variableNames(project) {
  const out = {};
  for (const env of Object.keys(ENVIRONMENTS)) out[env] = Object.keys(project?.deployment_configs?.[env]?.env_vars ?? {}).sort();
  return out;
}

/** Binding and variable names per environment, as "kind:NAME" (d1_databases:DB, env_vars:APP_ENV, …). */
export function bindingNames(project) {
  const out = {};
  for (const env of Object.keys(ENVIRONMENTS)) {
    const cfg = project?.deployment_configs?.[env] ?? {};
    const names = [];
    for (const [kind, value] of Object.entries(cfg)) {
      if (value && typeof value === "object" && !Array.isArray(value)) for (const name of Object.keys(value)) names.push(`${kind}:${name}`);
    }
    out[env] = names.sort();
  }
  return out;
}

/** Names that existed before and are gone after, per environment. */
export function lostVariables(before, after) {
  const lost = {};
  for (const env of Object.keys(ENVIRONMENTS)) {
    const gone = (before[env] ?? []).filter((n) => !(after[env] ?? []).includes(n));
    if (gone.length) lost[env] = gone;
  }
  return lost;
}

/**
 * Existing DB / MEDIA bindings the patch would point somewhere else. A rebind silently switches
 * production to another database, so it needs --allow-rebind.
 */
export function rebindConflicts(project, patch) {
  const out = [];
  for (const [env, cfg] of Object.entries(patch.deployment_configs)) {
    const cur = project?.deployment_configs?.[env] ?? {};
    const db = cur.d1_databases?.DB?.id;
    if (db && db !== cfg.d1_databases.DB.id) out.push(`${env}: DB is bound to database ${db}, setup would bind ${cfg.d1_databases.DB.id}`);
    const bucket = cur.r2_buckets?.MEDIA?.name;
    if (bucket && bucket !== cfg.r2_buckets.MEDIA.name) out.push(`${env}: MEDIA is bound to bucket ${bucket}, setup would bind ${cfg.r2_buckets.MEDIA.name}`);
  }
  return out;
}

/**
 * What the patch changes, per environment, as lines without any value: "add", "keep" (same plain
 * value or same binding) or "set again" (a secret: its value can't be read back to compare).
 */
export function planLines(project, patch) {
  const lines = [];
  for (const [env, cfg] of Object.entries(patch.deployment_configs)) {
    const cur = project?.deployment_configs?.[env] ?? {};
    const db = cur.d1_databases?.DB?.id;
    lines.push(`${env}: binding DB → ${cfg.d1_databases.DB.id}: ${!db ? "add" : db === cfg.d1_databases.DB.id ? "keep" : "CHANGE"}`);
    const bucket = cur.r2_buckets?.MEDIA?.name;
    lines.push(`${env}: binding MEDIA → ${cfg.r2_buckets.MEDIA.name}: ${!bucket ? "add" : bucket === cfg.r2_buckets.MEDIA.name ? "keep" : "CHANGE"}`);
    for (const [name, v] of Object.entries(cfg.env_vars)) {
      const old = cur.env_vars?.[name];
      let action = "add";
      if (old && v.type === "plain_text" && old.type === "plain_text") action = old.value === v.value ? "keep" : "change";
      else if (old) action = "set again";
      lines.push(`${env}: ${v.type === "secret_text" ? "secret" : "variable"} ${name}: ${action}`);
    }
  }
  return lines;
}

/**
 * The project with every secret value removed, for the backup file. The API doesn't return
 * secret values anyway; this makes sure nothing secret-typed is ever written, whatever it returns.
 */
export function sanitizeProject(project) {
  const configs = {};
  for (const [env, cfg] of Object.entries(project?.deployment_configs ?? {})) {
    const copy = structuredClone(cfg ?? {});
    const vars = {};
    for (const [name, v] of Object.entries(copy.env_vars ?? {})) {
      vars[name] = v?.type === "plain_text" ? { type: "plain_text", value: v.value } : { type: v?.type ?? "unknown" };
    }
    copy.env_vars = vars;
    configs[env] = copy;
  }
  return { name: project?.name, subdomain: project?.subdomain, domains: project?.domains, production_branch: project?.production_branch, deployment_configs: configs };
}

// ---------------------------------------------------------------- R2 lifecycle

function sameRule(a, b) {
  return (
    a?.enabled === b.enabled &&
    (a?.conditions?.prefix ?? "") === b.conditions.prefix &&
    a?.deleteObjectsTransition?.condition?.type === "Age" &&
    a?.deleteObjectsTransition?.condition?.maxAge === b.deleteObjectsTransition.condition.maxAge
  );
}

/**
 * The bucket's lifecycle rules with BACKUP_RULE in place. The API's PUT replaces the whole list,
 * so every other rule (Cloudflare's default "abort unfinished uploads after 7 days" among them) is
 * carried over unchanged. Returns { rules, changed }.
 */
export function lifecycleWithBackupRule(current) {
  const rules = Array.isArray(current) ? current.map((r) => structuredClone(r)) : [];
  const i = rules.findIndex((r) => r?.id === BACKUP_RULE.id);
  if (i >= 0 && sameRule(rules[i], BACKUP_RULE)) return { rules, changed: false };
  if (i >= 0) rules[i] = structuredClone(BACKUP_RULE);
  else rules.push(structuredClone(BACKUP_RULE));
  return { rules, changed: true };
}

// ---------------------------------------------------------------- custom domains

/**
 * What --add-domain has to do for <slug>.<apex>. Pages needs both: the domain attached to the
 * project (POST …/pages/projects/:name/domains) and a proxied CNAME to <project>.pages.dev in the
 * zone. The dashboard makes the CNAME by itself; the API doesn't. A CNAME made before the domain
 * is attached answers 522, so the attach comes first.
 * @returns {{ host: string, target: string, attach: "add" | "ok", attachStatus?: string, dns: "add" | "ok" | "conflict", conflict?: string }}
 */
export function domainPlan({ slug, apexDomain, projectSubdomain, pagesDomains = [], dnsRecords = [] }) {
  const host = `${slug}.${apexDomain}`;
  const target = projectSubdomain;
  const attached = pagesDomains.find((d) => d?.name === host);
  const plan = { host, target, attach: attached ? "ok" : "add", dns: "add" };
  if (attached) plan.attachStatus = attached.status;
  const records = dnsRecords.filter((r) => r?.name === host);
  const cname = records.find((r) => r.type === "CNAME");
  if (cname && cname.content === target && cname.proxied === true) plan.dns = "ok";
  else if (records.length) {
    plan.dns = "conflict";
    plan.conflict = records.map((r) => `${r.type} → ${r.content}${r.proxied ? " (proxied)" : " (DNS only)"}`).join(", ");
  }
  return plan;
}

// ---------------------------------------------------------------- go-live gate

/** The read-only query go-live runs against the production database. */
export const GO_LIVE_SQL =
  "SELECT (SELECT value FROM settings WHERE key = 'legal_confirmed') AS legal, " +
  "(SELECT count(*) FROM courses WHERE is_demo = 1 AND status = 'published' AND deleted_at IS NULL) AS demo_published, " +
  "(SELECT count(*) FROM courses WHERE is_demo = 0 AND status = 'published' AND deleted_at IS NULL) AS real_published";

/** Why the site can't take live payments yet, from GO_LIVE_SQL's row. Empty = ready. */
export function goLiveBlockers(row) {
  const blockers = [];
  if (!row) return ["the production database has no data yet (open the site once so it migrates)"];
  if (row.legal !== "true") blockers.push("the legal pages aren't confirmed yet (admin → Settings → confirm the policies)");
  if (Number(row.demo_published) > 0) blockers.push("the demo course is still published (admin → Courses → unpublish it)");
  if (Number(row.real_published) === 0) blockers.push("no real course is published yet");
  return blockers;
}

// ---------------------------------------------------------------- Cloudflare API

/** A small v4 API client. Errors carry the HTTP status and Cloudflare's codes, never a request body. */
export function cfClient(config, fetchImpl = globalThis.fetch) {
  return async function cf(method, pathname, body) {
    const res = await fetchImpl(`${API}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok || data?.success === false) {
      // Cloudflare's error messages never echo secrets; still, only codes and messages are shown.
      const errors = data?.errors ?? [];
      const detail = errors.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`;
      const err = new Error(`${method} ${pathname.replace(/[0-9a-f]{32}/g, "<account>")} failed: ${detail}`);
      err.status = res.status;
      err.codes = errors.map((e) => e.code);
      throw err;
    }
    return data?.result;
  };
}

/** True for "R2 isn't enabled on this account" (code 10042, or the message when the code changes). */
export function isR2NotEnabled(err) {
  return Boolean(err?.codes?.includes(10042) || /enable r2/i.test(err?.message ?? ""));
}

async function findD1(cf, config, name) {
  const list = await cf("GET", `/accounts/${config.accountId}/d1/database?name=${encodeURIComponent(name)}&per_page=100`);
  return (list ?? []).find((d) => d.name === name)?.uuid ?? null;
}

async function bucketExists(cf, config, name) {
  try {
    await cf("GET", `/accounts/${config.accountId}/r2/buckets/${encodeURIComponent(name)}`);
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    if (isR2NotEnabled(err)) {
      const e = new Error("R2 isn't enabled on this Cloudflare account yet: dashboard → R2 object storage → enable it (docs/owner/OWNER-GUIDE.md, step 3), then run this again.");
      e.status = err.status;
      throw e;
    }
    throw err;
  }
}

// ---------------------------------------------------------------- main

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writePrivate(file, text) {
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

async function confirmTTY(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} Type yes to continue: `);
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

/**
 * @param {string[]} argv
 * @param {{ fetchImpl?: typeof fetch, root?: string, log?: (s: string) => void, error?: (s: string) => void, confirm?: (q: string) => Promise<boolean>, now?: Date }} io
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const log = io.log ?? ((s) => console.log(s));
  const error = io.error ?? ((s) => console.error(s));
  const confirm = io.confirm ?? confirmTTY;
  const files = filesIn(io.root);
  const args = parseArgs(argv);
  if (args.errors.length) {
    error("setup: " + args.errors.join("; "));
    error("Usage: npm run setup -- [--check | --dry-run] [--env production|preview|all] [--yes] [--allow-rebind] | --add-domain <slug> [--dry-run]");
    return 1;
  }

  if (!existsSync(files.config)) {
    error("setup: setup.local.json not found. Copy setup.example.json to setup.local.json and fill it in (docs/owner/SETUP.md).");
    return 1;
  }
  let raw;
  try {
    raw = readJson(files.config);
  } catch {
    error("setup: setup.local.json is not valid JSON.");
    return 1;
  }
  const { config, errors } = validateConfig(raw, { live: args.live, cloudflareOnly: args.addDomain !== null });
  if (errors.length) {
    error("setup: please fix setup.local.json:");
    for (const e of errors) error(`  - ${e}`);
    return 1;
  }
  if (args.addDomain === null) {
    log(`setup: setup.local.json is complete (${args.live ? "LIVE" : "test"} Razorpay keys, project ${config.project}, ${args.envs.join(" + ")}).`);
  }
  if (args.checkOnly) return 0;

  const wranglerConfig = files.wranglerConfigs.find((f) => existsSync(f));
  if (wranglerConfig) {
    // With a wrangler config in the repo, Pages takes bindings from it on every deploy and the
    // dashboard/API ones stop counting. This project deliberately has none (functions/_lib/env.ts).
    error(`setup: ${path.basename(wranglerConfig)} exists. Pages would take its bindings from that file and ignore what setup sets. Remove it first.`);
    return 1;
  }

  const cf = cfClient(config, io.fetchImpl);
  const project = await cf("GET", `/accounts/${config.accountId}/pages/projects/${config.project}`);
  log(`setup: Pages project ${config.project} found (${project?.subdomain ?? "no pages.dev name"}).`);

  if (args.addDomain !== null) return addDomain({ cf, config, project, slug: args.addDomain, dryRun: args.dryRun, yes: args.yes, confirm, log, error });

  // ---- 1. find what exists (read only)
  const found = {};
  for (const env of args.envs) {
    const spec = ENVIRONMENTS[env];
    const d1 = await findD1(cf, config, spec.d1);
    const r2 = await bucketExists(cf, config, spec.r2);
    found[env] = { d1, r2 };
    log(`  ${env}: D1 ${spec.d1} ${d1 ? "exists" : "will be created"}; R2 ${spec.r2} ${r2 ? "exists" : "will be created"}`);
    if (r2) {
      try {
        const managed = await cf("GET", `/accounts/${config.accountId}/r2/buckets/${spec.r2}/domains/managed`);
        if (managed?.enabled) error(`  ${env}: WARNING ${spec.r2} is public on r2.dev. Turn it off: R2 → ${spec.r2} → Settings → Public access. Videos and backups must only be served by the site.`);
      } catch {
        /* the check is advisory */
      }
    }
  }

  // ---- 2. go-live gate
  if (args.live) {
    const id = found.production.d1;
    let row;
    if (id) {
      try {
        const rows = await cf("POST", `/accounts/${config.accountId}/d1/database/${id}/query`, { sql: GO_LIVE_SQL });
        row = rows?.[0]?.results?.[0];
      } catch (err) {
        if (!/no such table/i.test(err.message)) throw err;
      }
    }
    const blockers = goLiveBlockers(row);
    if (blockers.length) {
      error("go-live: not yet:");
      for (const b of blockers) error(`  - ${b}`);
      error("Also build with `node scripts/check-dist.mjs --live` passing before switching keys.");
      return 1;
    }
    log("go-live: legal pages confirmed, demo course unpublished, real courses published.");
  }

  // ---- 3. the plan
  const previous = existsSync(files.outJson) ? readJson(files.outJson) : {};
  const secrets = generatedSecrets(previous);
  const planned = Object.fromEntries(args.envs.map((env) => [env, found[env].d1 ?? `<new ${ENVIRONMENTS[env].d1}>`]));
  const plannedPatch = deploymentConfigPatch(config, secrets, planned, args.envs);
  const conflicts = rebindConflicts(project, plannedPatch);
  for (const line of planLines(project, plannedPatch)) log(`  ${line}`);
  const existing = variableNames(project);
  for (const env of args.envs) {
    const ours = new Set(Object.keys(plannedPatch.deployment_configs[env].env_vars));
    const others = existing[env].filter((n) => !ours.has(n));
    if (others.length) log(`  ${env}: also has ${others.join(", ")} (kept; checked again afterwards)`);
  }
  for (const env of args.envs) log(`  ${env}: R2 lifecycle rule ${BACKUP_RULE.id} (backups/d1/ deleted after 35 days): ${found[env].r2 ? "checked" : "added"}`);
  if (conflicts.length) {
    for (const c of conflicts) error(`  STOP ${c}`);
    if (!args.allowRebind) {
      error("setup: an existing binding points elsewhere (a restore, or a database made by hand). Nothing changed. If the switch is intended, run again with --allow-rebind.");
      return 1;
    }
  }
  if (args.dryRun) {
    log("setup: dry run, nothing changed.");
    return 0;
  }
  if (!args.yes && !(await confirm(`This sets the bindings and ${args.live ? "LIVE" : "test"} keys on ${config.project} (${args.envs.join(" + ")}).`))) {
    log("setup: stopped, nothing changed.");
    return 1;
  }

  // ---- 4. backup of what is there now (no secret values: the API never returns them)
  const stamp = (io.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const backup = { takenAt: (io.now ?? new Date()).toISOString(), project: sanitizeProject(project), d1: {}, r2: {} };
  for (const env of args.envs) {
    const id = found[env].d1;
    if (id) {
      try {
        backup.d1[ENVIRONMENTS[env].d1] = { id, bookmark: (await cf("GET", `/accounts/${config.accountId}/d1/database/${id}/time_travel/bookmark`))?.bookmark ?? null };
      } catch (err) {
        backup.d1[ENVIRONMENTS[env].d1] = { id, bookmark: null, note: err.message };
      }
    }
    if (found[env].r2) {
      try {
        backup.r2[ENVIRONMENTS[env].r2] = { lifecycle: (await cf("GET", `/accounts/${config.accountId}/r2/buckets/${ENVIRONMENTS[env].r2}/lifecycle`))?.rules ?? [] };
      } catch (err) {
        backup.r2[ENVIRONMENTS[env].r2] = { lifecycle: null, note: err.message };
      }
    }
  }
  writePrivate(files.backup(stamp), JSON.stringify(backup, null, 2));
  log(`setup: saved the current settings to ${path.basename(files.backup(stamp))} (rollback: docs/owner/ROLLBACK.md).`);

  // ---- 5. create what is missing
  const databases = {};
  for (const env of args.envs) {
    const spec = ENVIRONMENTS[env];
    if (found[env].d1) databases[env] = found[env].d1;
    else {
      const made = await cf("POST", `/accounts/${config.accountId}/d1/database`, { name: spec.d1, primary_location_hint: config.location });
      databases[env] = made.uuid;
      log(`  ${env}: D1 ${spec.d1} created`);
    }
    if (!found[env].r2) {
      await cf("POST", `/accounts/${config.accountId}/r2/buckets`, { name: spec.r2, locationHint: config.location });
      log(`  ${env}: R2 ${spec.r2} created`);
    }
    const current = backup.r2[spec.r2]?.lifecycle ?? (await cf("GET", `/accounts/${config.accountId}/r2/buckets/${spec.r2}/lifecycle`))?.rules ?? [];
    const { rules, changed } = lifecycleWithBackupRule(current);
    if (changed) {
      await cf("PUT", `/accounts/${config.accountId}/r2/buckets/${spec.r2}/lifecycle`, { rules });
      log(`  ${env}: R2 lifecycle rule ${BACKUP_RULE.id} set (${rules.length} rule${rules.length === 1 ? "" : "s"} in all)`);
    }
  }

  // ---- 6. the generated values, saved before they are sent so a failure never loses a password
  const all = { ...previous, ...secrets };
  writePrivate(files.outJson, JSON.stringify(all, null, 2));
  writePrivate(
    files.outTxt,
    [
      "Feelings Courses: generated by npm run setup. Keep this file private; never commit or share it.",
      "",
      `Admin password (production): ${secrets.production.adminPassword}`,
      `Admin password (preview):    ${secrets.preview.adminPassword}`,
      "",
      "Razorpay webhook (Razorpay dashboard → Account & Settings → Webhooks → Add new webhook):",
      `  URL:    https://${config.hubHost}/api/razorpay/webhook`,
      `  Secret: ${secrets.production.webhookSecret}`,
      "  Events: payment.captured, payment.failed, order.paid, refund.processed, refund.failed",
      "",
      "Testing on a preview address instead (test mode only): the same events, with",
      `  URL:    https://<branch>.${project?.subdomain ?? `${config.project}.pages.dev`}/api/razorpay/webhook`,
      `  Secret: ${secrets.preview.webhookSecret}`,
      "",
    ].join("\n"),
  );

  // ---- 7. bindings, variables and secrets
  const before = bindingNames(project);
  const patch = deploymentConfigPatch(config, secrets, databases, args.envs);
  await cf("PATCH", `/accounts/${config.accountId}/pages/projects/${config.project}`, withConfigHash(patch, project));
  const after = bindingNames(await cf("GET", `/accounts/${config.accountId}/pages/projects/${config.project}`));

  // ---- 8. check
  let ok = true;
  for (const [env, names] of Object.entries(lostVariables(before, after))) {
    ok = false;
    error(`setup: ${env} lost ${names.join(", ")}. Re-add them in Pages → Settings → Variables and Secrets / Bindings (the backup file lists them).`);
  }
  for (const [env, cfg] of Object.entries(patch.deployment_configs)) {
    const want = [...Object.keys(cfg.env_vars).map((n) => `env_vars:${n}`), "d1_databases:DB", "r2_buckets:MEDIA"];
    const missing = want.filter((n) => !(after[env] ?? []).includes(n));
    if (missing.length) {
      ok = false;
      error(`setup: ${env} is missing ${missing.join(", ")} after the update.`);
    }
  }
  log(ok ? "setup: done. Bindings, variables and secrets are set." : "setup: finished with problems (above).");
  log("Next: open setup.local.out.txt for the admin password and the Razorpay webhook, then redeploy (Pages → Deployments → Retry deployment), docs/owner/OWNER-GUIDE.md.");
  return ok ? 0 : 1;
}

async function addDomain({ cf, config, project, slug, dryRun, yes, confirm, log, error }) {
  const host = `${slug}.${config.apexDomain}`;
  if (!project?.subdomain) {
    error("setup: the project has no pages.dev name to point the domain at.");
    return 1;
  }
  const pagesDomains = (await cf("GET", `/accounts/${config.accountId}/pages/projects/${config.project}/domains`)) ?? [];
  let zone;
  try {
    zone = ((await cf("GET", `/zones?name=${encodeURIComponent(config.apexDomain)}&account.id=${config.accountId}`)) ?? [])[0];
  } catch (err) {
    error(`setup: can't read the ${config.apexDomain} zone (${err.message}). The token needs Zone → Zone Read and Zone → DNS Edit for it, or add the domain in the dashboard instead (docs/owner/OWNER-GUIDE.md).`);
    return 1;
  }
  if (!zone) {
    error(`setup: ${config.apexDomain} isn't a zone on this Cloudflare account.`);
    return 1;
  }
  const dnsRecords = (await cf("GET", `/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}`)) ?? [];
  const plan = domainPlan({ slug, apexDomain: config.apexDomain, projectSubdomain: project.subdomain, pagesDomains, dnsRecords });
  log(`  ${host}: attach to ${config.project}: ${plan.attach === "ok" ? `already attached (${plan.attachStatus ?? "status unknown"})` : "add"}`);
  log(`  ${host}: DNS CNAME → ${plan.target} (proxied): ${plan.dns === "ok" ? "exists" : plan.dns === "add" ? "add" : "CONFLICT"}`);
  if (plan.dns === "conflict") {
    error(`setup: ${host} already has ${plan.conflict}. Nothing changed. Remove or fix that record in DNS first.`);
    return 1;
  }
  if (plan.attach === "ok" && plan.dns === "ok") {
    log("setup: nothing to do. In the admin, open the course and press Check now.");
    return 0;
  }
  if (dryRun) {
    log("setup: dry run, nothing changed.");
    return 0;
  }
  if (!yes && !(await confirm(`This adds ${host} to ${config.project}.`))) {
    log("setup: stopped, nothing changed.");
    return 1;
  }
  if (plan.attach === "add") {
    await cf("POST", `/accounts/${config.accountId}/pages/projects/${config.project}/domains`, { name: host });
    log(`  ${host}: attached`);
  }
  if (plan.dns === "add") {
    await cf("POST", `/zones/${zone.id}/dns_records`, { type: "CNAME", name: host, content: plan.target, proxied: true, ttl: 1, comment: `Pages project ${config.project}` });
    log(`  ${host}: CNAME added`);
  }
  log("setup: done. The certificate takes a few minutes. Then, in the admin, open the course and press Check now; then `node scripts/smoke-hosts.mjs " + slug + "`.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`setup: ${err.message}`);
      process.exit(1);
    },
  );
}
