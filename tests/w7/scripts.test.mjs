// scripts/setup.mjs (pure parts) and scripts/check-dist.mjs (against a small fixture build).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  adminPasswordHash,
  deploymentConfigPatch,
  generatePassword,
  generatedSecrets,
  goLiveBlockers,
  lostVariables,
  validateConfig,
  variableNames,
} from "../../scripts/setup.mjs";
import { hmacSha256Hex } from "../../functions/_lib/crypto.ts";

const GOOD = {
  cloudflare: { accountId: "0123456789abcdef0123456789abcdef", apiToken: "t".repeat(40), project: "feelings-courses" },
  razorpay: { keyId: "rzp_test_ABCDEF123", keySecret: "s".repeat(24) },
  deployHookUrl: "https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/abc-123",
};

// ---------------------------------------------------------------- setup.mjs

test("validateConfig: names the bad fields, never their values", () => {
  assert.deepEqual(validateConfig(GOOD).errors, []);
  const { errors } = validateConfig({ cloudflare: { accountId: "nope", apiToken: "short-secret-value" }, razorpay: { keyId: "rzp_live_X1234567", keySecret: "x" } });
  assert.ok(errors.some((e) => e.startsWith("cloudflare.accountId")));
  assert.ok(errors.some((e) => e.startsWith("cloudflare.apiToken")));
  assert.ok(errors.some((e) => e.includes("test key id")), "setup refuses live keys");
  assert.ok(errors.some((e) => e.startsWith("razorpay.keySecret")));
  assert.ok(!errors.join().includes("short-secret-value"), "no value is echoed");
  assert.ok(validateConfig(GOOD, { live: true }).errors.some((e) => e.includes("rzp_live_")), "go-live refuses test keys");
  assert.deepEqual(validateConfig({ ...GOOD, deployHookUrl: "https://evil.example/hook" }).errors.length, 1);
});

test("generated secrets: strong, stable across reruns, hash matches the Functions' check", async () => {
  const pw = generatePassword();
  assert.equal(pw.length, 20);
  assert.doesNotMatch(pw, /[01lIoO]/);
  const first = generatedSecrets();
  const again = generatedSecrets(JSON.parse(JSON.stringify(first)));
  assert.deepEqual(again, first, "reruns reuse setup.local.out.json");
  assert.notEqual(first.production.appSecret, first.preview.appSecret);
  assert.equal(first.production.appSecret.length, 64);
  assert.equal(first.production.adminPasswordHash, await hmacSha256Hex(first.production.appSecret, first.production.adminPassword));
  assert.equal(adminPasswordHash("k", "p"), await hmacSha256Hex("k", "p"));
});

test("deploymentConfigPatch: bindings, plain variables and secrets per environment", () => {
  const { config } = validateConfig(GOOD);
  const secrets = generatedSecrets();
  const patch = deploymentConfigPatch(config, secrets, { production: "db-prod", preview: "db-prev" });
  const prod = patch.deployment_configs.production;
  const prev = patch.deployment_configs.preview;
  assert.deepEqual(prod.d1_databases, { DB: { id: "db-prod" } });
  assert.deepEqual(prev.r2_buckets, { MEDIA: { name: "fbc-media-preview" } });
  assert.deepEqual(prod.env_vars.APP_ENV, { type: "plain_text", value: "production" });
  assert.equal(prev.env_vars.APP_ENV.value, "preview");
  for (const name of ["APP_SECRET", "ADMIN_PASSWORD_HASH", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"]) {
    assert.equal(prod.env_vars[name].type, "secret_text", name);
  }
  assert.equal(prod.env_vars.RAZORPAY_KEY_ID.type, "plain_text", "the key id is public");
  assert.equal(prod.env_vars.DEPLOY_HOOK_URL.type, "secret_text");
  assert.equal(prev.env_vars.DEPLOY_HOOK_URL, undefined, "previews never rebuild production");
  assert.equal(prod.env_vars.ADMIN_PASSWORD_HASH.value, secrets.production.adminPasswordHash);
  assert.ok(!JSON.stringify(patch).includes(secrets.production.adminPassword), "the password itself is never sent");
});

test("variable bookkeeping finds anything the API dropped", () => {
  const before = variableNames({ deployment_configs: { production: { env_vars: { ENROLL_SECRET: {}, A: {} } }, preview: { env_vars: {} } } });
  const after = variableNames({ deployment_configs: { production: { env_vars: { A: {}, APP_SECRET: {} } } } });
  assert.deepEqual(before, { production: ["A", "ENROLL_SECRET"], preview: [] });
  assert.deepEqual(lostVariables(before, after), { production: ["ENROLL_SECRET"] });
});

test("goLiveBlockers: legal confirmed, demo unpublished, a real course published", () => {
  assert.deepEqual(goLiveBlockers({ legal: "true", demo_published: 0, real_published: 2 }), []);
  assert.equal(goLiveBlockers({ legal: "false", demo_published: 1, real_published: 0 }).length, 3);
  assert.equal(goLiveBlockers(undefined).length, 1);
});

// ---------------------------------------------------------------- check-dist.mjs

const CSP =
  "Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-x'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'";
const page = (canonical, extra = "") =>
  `<!doctype html><html><head><link rel="canonical" href="${canonical}" />${extra}</head><body><p>ok</p></body></html>`;

function fixture(overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "check-dist-"));
  const files = {
    "_headers": `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Strict-Transport-Security: max-age=31536000\n  ${CSP}\n`,
    "_routes.json": JSON.stringify({ version: 1, include: ["/*"], exclude: ["/_astro/*"] }),
    "index.html": page("https://courses.feelingsbeautycare.in/"),
    "404.html": "<p>nf</p>",
    "sitemap.xml": "<urlset/>",
    "build.json": JSON.stringify({ contentVersion: 1, builtAt: 1, commit: null, snapshotSource: "seed" }),
    "domains.json": JSON.stringify({ active: [] }),
    "legal.html": page("https://courses.feelingsbeautycare.in/legal"),
    "legal/terms.html": page("https://courses.feelingsbeautycare.in/legal/terms"),
    "legal/refunds.html": page("https://courses.feelingsbeautycare.in/legal/refunds"),
    "legal/privacy.html": page("https://courses.feelingsbeautycare.in/legal/privacy"),
    "legal/delivery.html": page("https://courses.feelingsbeautycare.in/legal/delivery"),
    "c/selfmakeup.html": page("https://courses.feelingsbeautycare.in/c/selfmakeup", '<script type="application/ld+json">{"@type":"Course"}</script>'),
    "sitemaps/selfmakeup.xml": "<urlset/>",
    "admin/settings.html": "<p>GSTIN field</p>",
    ...overrides,
  };
  for (const [name, body] of Object.entries(files)) {
    if (body === null) continue;
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  return dir;
}

function runCheck(dir, ...flags) {
  const res = spawnSync(process.execPath, ["scripts/check-dist.mjs", dir, ...flags], { encoding: "utf8" });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

test("check-dist passes a good build (the admin may label a GSTIN field)", () => {
  const dir = fixture();
  try {
    const { code, out } = runCheck(dir);
    assert.equal(code, 0, out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-dist catches a missing CSP, a shown GSTIN, bad canonicals, missing pages and bad JSON-LD", () => {
  const dir = fixture({
    "_headers": "/*\n  X-Content-Type-Options: nosniff\n  X-Robots-Tag: noindex\n",
    "c/selfmakeup.html": page("/c/selfmakeup", '<script type="application/ld+json">{not json</script>'),
    "legal/terms.html": page("https://courses.feelingsbeautycare.in/legal/terms") + "<p>GSTIN: 24ABCDE1234F1Z5</p>",
    "legal/delivery.html": null,
    "sitemaps/selfmakeup.xml": null,
    "domains.json": JSON.stringify({ active: ["diploma"] }),
  });
  try {
    const { code, out } = runCheck(dir);
    assert.equal(code, 1);
    for (const needle of [
      "no Content-Security-Policy",
      "site-wide X-Robots-Tag",
      "legal/terms.html: shows a GSTIN",
      "legal/delivery.html is missing",
      "sitemaps/selfmakeup.xml is missing",
      "not an absolute https URL",
      "JSON-LD doesn't parse",
      "lists diploma",
    ]) {
      assert.ok(out.includes(needle), `expected "${needle}" in:\n${out}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-dist --live refuses test keys and the demo ribbon", () => {
  const dir = fixture({
    "index.html": page("https://courses.feelingsbeautycare.in/", '<p class="demo-ribbon">Demo</p>'),
    "_astro/checkout.js": 'const k = "rzp_test_ABC";',
  });
  try {
    assert.equal(runCheck(dir).code, 0, "fine for a test-mode build");
    const { code, out } = runCheck(dir, "--live");
    assert.equal(code, 1);
    assert.ok(out.includes("rzp_test_"), out);
    assert.ok(out.includes("demo ribbon"), out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
