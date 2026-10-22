// The owner's one-time setup (W7; hub page section 5, docs/owner/SETUP.md).
//
//   npm run setup                 test keys: create D1 + R2, bind them, set variables and secrets
//   npm run setup -- --check      only validate setup.local.json (no network)
//   npm run setup -- --dry-run    read Cloudflare, print the plan, change nothing
//   npm run go-live               the same with live Razorpay keys (rzp_live_…), after the go-live checks
//
// Reads setup.local.json (gitignored; copy setup.example.json). Writes setup.local.out.json and
// setup.local.out.txt (gitignored, file mode 600): the generated admin password and webhook secret.
// It NEVER prints a secret: the console only ever shows names, ids and "set" / "unchanged".
//
// What it does, per environment (production, preview):
//   1. checks the Pages project exists and lists its current variable names;
//   2. creates the D1 database (fbc-courses / fbc-courses-preview) unless it exists;
//   3. creates the R2 bucket (fbc-media / fbc-media-preview) unless it exists (R2 must be enabled
//      in the dashboard first: it asks for a card, usage stays in the free tier);
//   4. PATCHes the project's deployment config: the DB and MEDIA bindings, plain variables
//      (APP_ENV, HUB_HOST, APEX_DOMAIN, RAZORPAY_KEY_ID) and secrets (APP_SECRET,
//      ADMIN_PASSWORD_HASH, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, DEPLOY_HOOK_URL);
//   5. reads the project back and checks every variable that existed before is still there (the
//      hub's open item: whether the Pages API merges or replaces variables on PATCH). If one went
//      missing it says which, so the owner can re-add it; nothing is retried blindly.
// The database schema needs no step: the site migrates itself on the first request.
//
// Re-running is safe: existing resources are reused, and generated secrets are reused from
// setup.local.out.json (delete that file to rotate them).
//
// STATUS: written against Cloudflare's v4 API docs; not yet run against the real account. Run it
// first with --dry-run, and check the preview environment before production.

import { createHmac, randomBytes, randomInt } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
export const CONFIG_FILE = path.join(root, "setup.local.json");
export const OUT_JSON = path.join(root, "setup.local.out.json");
export const OUT_TXT = path.join(root, "setup.local.out.txt");
const API = "https://api.cloudflare.com/client/v4";

export const ENVIRONMENTS = {
  production: { d1: "fbc-courses", r2: "fbc-media", appEnv: "production" },
  preview: { d1: "fbc-courses-preview", r2: "fbc-media-preview", appEnv: "preview" },
};

const DEFAULTS = { project: "feelings-courses", hubHost: "courses.feelingsbeautycare.in", apexDomain: "feelingsbeautycare.in" };

// ---------------------------------------------------------------- config

/**
 * Validates setup.local.json. Returns { config, errors }: errors name the field, never its value.
 * @param {unknown} raw
 * @param {{ live?: boolean }} options
 */
export function validateConfig(raw, { live = false } = {}) {
  const errors = [];
  const c = raw && typeof raw === "object" ? raw : {};
  const cf = c.cloudflare && typeof c.cloudflare === "object" ? c.cloudflare : {};
  const rp = c.razorpay && typeof c.razorpay === "object" ? c.razorpay : {};
  const str = (v) => (typeof v === "string" ? v.trim() : "");

  const config = {
    accountId: str(cf.accountId),
    apiToken: str(cf.apiToken),
    project: str(cf.project) || DEFAULTS.project,
    hubHost: str(c.hubHost) || DEFAULTS.hubHost,
    apexDomain: str(c.apexDomain) || DEFAULTS.apexDomain,
    keyId: str(rp.keyId),
    keySecret: str(rp.keySecret),
    deployHookUrl: str(c.deployHookUrl),
  };

  if (!/^[0-9a-f]{32}$/.test(config.accountId)) errors.push("cloudflare.accountId: 32 hex characters (dashboard → Workers & Pages → Account ID)");
  if (config.apiToken.length < 30) errors.push("cloudflare.apiToken: an API token with Pages Edit, D1 Edit and R2 Edit (not the global key)");
  if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(config.project)) errors.push("cloudflare.project: the Pages project name");
  const host = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
  if (!host.test(config.hubHost)) errors.push("hubHost: a host name like courses.feelingsbeautycare.in");
  if (!host.test(config.apexDomain)) errors.push("apexDomain: a domain like feelingsbeautycare.in");
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
 * The body of PATCH /accounts/:id/pages/projects/:name for both environments. Pure, so the test
 * checks exactly what would be sent (with secrets replaced by placeholders there).
 */
export function deploymentConfigPatch(config, secrets, databases) {
  const deployment_configs = {};
  for (const [env, spec] of Object.entries(ENVIRONMENTS)) {
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

/** Variable names in a project's config, per environment. */
export function variableNames(project) {
  const out = {};
  for (const env of Object.keys(ENVIRONMENTS)) out[env] = Object.keys(project?.deployment_configs?.[env]?.env_vars ?? {}).sort();
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

async function cf(config, method, pathname, body) {
  const res = await fetch(`${API}${pathname}`, {
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
    const detail = (data?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`;
    const err = new Error(`${method} ${pathname.replace(/[0-9a-f]{32}/g, "<account>")} failed: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return data?.result;
}

async function findOrCreateD1(config, name, dryRun) {
  const list = await cf(config, "GET", `/accounts/${config.accountId}/d1/database?name=${encodeURIComponent(name)}`);
  const found = (list ?? []).find((d) => d.name === name);
  if (found) return { id: found.uuid, created: false };
  if (dryRun) return { id: `<new ${name}>`, created: true };
  const made = await cf(config, "POST", `/accounts/${config.accountId}/d1/database`, { name });
  return { id: made.uuid, created: true };
}

async function findOrCreateR2(config, name, dryRun) {
  try {
    await cf(config, "GET", `/accounts/${config.accountId}/r2/buckets/${encodeURIComponent(name)}`);
    return { created: false };
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  if (!dryRun) await cf(config, "POST", `/accounts/${config.accountId}/r2/buckets`, { name });
  return { created: true };
}

// ---------------------------------------------------------------- main

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writePrivate(file, text) {
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} Type yes to continue: `);
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

export async function main(argv = process.argv.slice(2)) {
  const live = argv.includes("--live");
  const checkOnly = argv.includes("--check");
  const dryRun = argv.includes("--dry-run");
  const yes = argv.includes("--yes");

  if (!existsSync(CONFIG_FILE)) {
    console.error("setup: setup.local.json not found. Copy setup.example.json to setup.local.json and fill it in (docs/owner/SETUP.md).");
    return 1;
  }
  let raw;
  try {
    raw = readJson(CONFIG_FILE);
  } catch {
    console.error("setup: setup.local.json is not valid JSON.");
    return 1;
  }
  const { config, errors } = validateConfig(raw, { live });
  if (errors.length) {
    console.error("setup: please fix setup.local.json:");
    for (const e of errors) console.error(`  - ${e}`);
    return 1;
  }
  console.log(`setup: setup.local.json is complete (${live ? "LIVE" : "test"} Razorpay keys, project ${config.project}).`);
  if (checkOnly) return 0;

  const previous = existsSync(OUT_JSON) ? readJson(OUT_JSON) : {};
  const secrets = generatedSecrets(previous);

  const project = await cf(config, "GET", `/accounts/${config.accountId}/pages/projects/${config.project}`);
  const before = variableNames(project);
  console.log(`setup: Pages project ${config.project} found.`);

  const databases = {};
  for (const [env, spec] of Object.entries(ENVIRONMENTS)) {
    const d1 = await findOrCreateD1(config, spec.d1, dryRun);
    databases[env] = d1.id;
    console.log(`  ${env}: D1 ${spec.d1} ${d1.created ? (dryRun ? "would be created" : "created") : "exists"}`);
    const r2 = await findOrCreateR2(config, spec.r2, dryRun);
    console.log(`  ${env}: R2 ${spec.r2} ${r2.created ? (dryRun ? "would be created" : "created") : "exists"}`);
  }

  if (live) {
    const rows = await cf(config, "POST", `/accounts/${config.accountId}/d1/database/${databases.production}/query`, { sql: GO_LIVE_SQL });
    const blockers = goLiveBlockers(rows?.[0]?.results?.[0]);
    if (blockers.length) {
      console.error("go-live: not yet:");
      for (const b of blockers) console.error(`  - ${b}`);
      console.error("Also build with `node scripts/check-dist.mjs --live` passing before switching keys.");
      return 1;
    }
    console.log("go-live: legal pages confirmed, demo course unpublished, real courses published.");
  }

  const patch = deploymentConfigPatch(config, secrets, databases);
  const ours = new Set(Object.keys(patch.deployment_configs.production.env_vars));
  const others = Object.fromEntries(Object.entries(before).map(([env, names]) => [env, names.filter((n) => !ours.has(n))]));
  for (const [env, names] of Object.entries(patch.deployment_configs).map(([env, c]) => [env, Object.keys(c.env_vars)])) {
    console.log(`  ${env}: bindings DB, MEDIA; variables ${names.join(", ")}`);
  }
  for (const [env, names] of Object.entries(others)) {
    if (names.length) console.log(`  ${env}: also has ${names.join(", ")} (kept; checked again afterwards)`);
  }
  if (dryRun) {
    console.log("setup: dry run, nothing changed.");
    return 0;
  }
  if (!yes && !(await confirm(`This sets the bindings and ${live ? "LIVE" : "test"} keys on ${config.project}.`))) {
    console.log("setup: stopped, nothing changed.");
    return 1;
  }

  // Save the generated values before sending them, so a failure halfway never loses a password.
  writePrivate(OUT_JSON, JSON.stringify(secrets, null, 2));
  writePrivate(
    OUT_TXT,
    [
      "Feelings Courses: generated by npm run setup. Keep this file private; never commit or share it.",
      "",
      `Admin password (production): ${secrets.production.adminPassword}`,
      `Admin password (preview):    ${secrets.preview.adminPassword}`,
      "",
      "Razorpay webhook (Razorpay dashboard → Settings → Webhooks → Add):",
      `  URL:    https://${config.hubHost}/api/razorpay/webhook`,
      `  Secret: ${secrets.production.webhookSecret}`,
      "  Events: payment.captured, payment.failed, order.paid, refund.processed, refund.failed",
      "",
    ].join("\n"),
  );

  await cf(config, "PATCH", `/accounts/${config.accountId}/pages/projects/${config.project}`, patch);
  const after = variableNames(await cf(config, "GET", `/accounts/${config.accountId}/pages/projects/${config.project}`));
  const lost = lostVariables(before, after);
  const missing = Object.fromEntries(
    Object.entries(patch.deployment_configs).map(([env, c]) => [env, Object.keys(c.env_vars).filter((n) => !(after[env] ?? []).includes(n))]),
  );
  let ok = true;
  for (const [env, names] of Object.entries(lost)) {
    ok = false;
    console.error(`setup: ${env} lost ${names.join(", ")} (the API replaced the variables). Re-add them in the dashboard.`);
  }
  for (const [env, names] of Object.entries(missing)) {
    if (names.length) {
      ok = false;
      console.error(`setup: ${env} is missing ${names.join(", ")} after the update.`);
    }
  }
  console.log(ok ? "setup: done. Bindings, variables and secrets are set." : "setup: finished with problems (above).");
  console.log("Next: open setup.local.out.txt for the admin password and the Razorpay webhook, then redeploy (docs/owner/SETUP.md).");
  return ok ? 0 : 1;
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
