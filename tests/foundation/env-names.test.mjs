// The binding and variable names agree everywhere: functions/_lib/env.ts (what the code reads),
// scripts/setup.mjs (what the owner's setup sets on Pages), the dev script in package.json and
// every `env.NAME` the Functions read. A name spelled differently in one place would only show up
// as a 503 "not configured" after deploy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { deploymentConfigPatch } from "../../scripts/setup.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

/** Members of `interface Env` in functions/_lib/env.ts. */
function envMembers() {
  const src = read("functions/_lib/env.ts");
  const body = src.slice(src.indexOf("export interface Env {"), src.indexOf("\n}", src.indexOf("export interface Env {")));
  return new Set([...body.matchAll(/^\s+([A-Z][A-Z0-9_]*)\??:/gm)].map((m) => m[1]));
}

function walkTs(dir) {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name === "_generated" ? [] : walkTs(rel);
    return e.name.endsWith(".ts") ? [rel] : [];
  });
}

const fakeSecrets = { appSecret: "x", adminPasswordHash: "x", webhookSecret: "x" };
const patch = deploymentConfigPatch(
  { hubHost: "h.example", apexDomain: "example", keyId: "rzp_test_x", keySecret: "x", deployHookUrl: "https://hook" },
  { production: fakeSecrets, preview: fakeSecrets, mailer: { key: "x" } },
  { production: "db-prod", preview: "db-preview" },
);

test("setup.mjs sets only names the Functions' Env declares", () => {
  const members = envMembers();
  for (const [env, cfg] of Object.entries(patch.deployment_configs)) {
    for (const name of [...Object.keys(cfg.d1_databases), ...Object.keys(cfg.r2_buckets), ...Object.keys(cfg.services), ...Object.keys(cfg.env_vars)]) {
      assert.ok(members.has(name), `${env}: setup.mjs sets ${name}, which functions/_lib/env.ts doesn't declare`);
    }
  }
});

test("every Env member is set by setup.mjs, except the built-in ASSETS and the demo's ENROLL_SECRET", () => {
  const set = new Set(Object.entries(patch.deployment_configs.production).flatMap(([, v]) => Object.keys(v)));
  for (const name of envMembers()) {
    if (name === "ASSETS" || name === "ENROLL_SECRET") continue;
    assert.ok(set.has(name), `functions/_lib/env.ts declares ${name}, but scripts/setup.mjs never sets it`);
  }
});

test("every env.NAME the Functions read is declared in Env", () => {
  // Build-time names (CF_PAGES_BRANCH, SNAPSHOT_*, read by scripts/ and src/lib/build-env.ts
  // through process.env) never reach the Functions' env.
  const members = envMembers();
  for (const file of walkTs("functions")) {
    for (const m of read(file).matchAll(/\benv\??\.([A-Z][A-Z0-9_]+)\b/g)) {
      assert.ok(members.has(m[1]), `${file} reads env.${m[1]}, which Env doesn't declare`);
    }
  }
});

test("the local dev script binds the same D1 and R2 names", () => {
  const scripts = JSON.parse(read("package.json")).scripts;
  assert.match(scripts["dev:full"], /--d1 DB\b/);
  assert.match(scripts["dev:full"], /--r2 MEDIA\b/);
});
