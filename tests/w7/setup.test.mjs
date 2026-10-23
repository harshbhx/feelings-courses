// scripts/setup.mjs end to end against a fake Cloudflare API that behaves as documented:
// - PATCH /pages/projects/:name merges deployment_configs per key (null deletes a key) and never
//   returns secret values;
// - PUT /r2/buckets/:name/lifecycle replaces the whole rule list;
// - new buckets start with the default "abort unfinished multipart uploads after 7 days" rule.
// Nothing here touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BACKUP_RULE,
  COURSE_SLUG_RE,
  RESERVED_LABELS,
  domainPlan,
  isValidCourseSlug,
  lifecycleWithBackupRule,
  main,
  parseArgs,
  planLines,
  rebindConflicts,
  sanitizeProject,
  withConfigHash,
} from "../../scripts/setup.mjs";
import * as constants from "../../src/shared/constants.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const KEY_SECRET = "S".repeat(24);
const HOOK = "https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/abc-123";
const DEFAULT_RULE = { id: "Default Multipart Abort Rule", enabled: true, conditions: { prefix: "" }, abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604800 } } };

function fakeCloudflare({ r2Enabled = true, projectConfigs } = {}) {
  const state = {
    project: {
      name: "feelings-courses",
      subdomain: "feelings-courses.pages.dev",
      deployment_configs: projectConfigs ?? {
        production: { env_vars: { ENROLL_SECRET: { type: "secret_text", value: "hand-set" } }, compatibility_date: "2026-10-01" },
        preview: { env_vars: {} },
      },
    },
    d1: [],
    buckets: {},
    domains: [],
    zone: { id: "z".repeat(32), name: "feelingsbeautycare.in" },
    dns: [],
    tables: null,
    calls: [],
  };
  const ok = (result) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
  const fail = (status, code, message) => new Response(JSON.stringify({ success: false, errors: [{ code, message }] }), { status });
  const visible = (project) => {
    const copy = structuredClone(project);
    for (const cfg of Object.values(copy.deployment_configs)) {
      for (const v of Object.values(cfg.env_vars ?? {})) if (v.type === "secret_text") v.value = "";
    }
    return copy;
  };
  async function fetchImpl(url, init) {
    const u = new URL(url);
    const p = u.pathname.replace("/client/v4", "");
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.calls.push(`${method} ${p}`);
    assert.equal(init.headers.Authorization, `Bearer ${"t".repeat(40)}`);
    const acct = `/accounts/${ACCOUNT}`;
    if (p === `${acct}/pages/projects/feelings-courses` && method === "GET") return ok(visible(state.project));
    if (p === `${acct}/pages/projects/feelings-courses` && method === "PATCH") {
      for (const [env, cfg] of Object.entries(body.deployment_configs)) {
        const cur = (state.project.deployment_configs[env] ??= {});
        for (const [key, value] of Object.entries(cfg)) {
          if (value && typeof value === "object") {
            cur[key] ??= {};
            for (const [name, v] of Object.entries(value)) {
              if (v === null) delete cur[key][name];
              else cur[key][name] = v;
            }
          } else cur[key] = value;
        }
      }
      return ok(visible(state.project));
    }
    if (p === `${acct}/d1/database` && method === "GET") return ok(state.d1.filter((d) => d.name.includes(u.searchParams.get("name"))));
    if (p === `${acct}/d1/database` && method === "POST") {
      const db = { name: body.name, uuid: `uuid-${body.name}`, hint: body.primary_location_hint };
      state.d1.push(db);
      return ok(db);
    }
    const tt = /\/d1\/database\/([^/]+)\/time_travel\/bookmark$/.exec(p);
    if (tt) return ok({ bookmark: `bm-${tt[1]}` });
    if (/\/d1\/database\/[^/]+\/query$/.test(p)) {
      if (!state.tables) return fail(400, 7500, "no such table: settings: SQLITE_ERROR");
      return ok([{ results: [state.tables], success: true }]);
    }
    const bucket = /\/r2\/buckets\/([^/]+)(\/.*)?$/.exec(p);
    if (p === `${acct}/r2/buckets` && method === "POST") {
      if (!r2Enabled) return fail(403, 10042, "Please enable R2 through the Cloudflare Dashboard.");
      state.buckets[body.name] = { lifecycle: [structuredClone(DEFAULT_RULE)], managed: false, hint: body.locationHint };
      return ok({ name: body.name });
    }
    if (bucket) {
      if (!r2Enabled) return fail(403, 10042, "Please enable R2 through the Cloudflare Dashboard.");
      const b = state.buckets[bucket[1]];
      if (!b) return fail(404, 10006, "The specified bucket does not exist.");
      if (!bucket[2] && method === "GET") return ok({ name: bucket[1] });
      if (bucket[2] === "/lifecycle" && method === "GET") return ok({ rules: b.lifecycle });
      if (bucket[2] === "/lifecycle" && method === "PUT") {
        b.lifecycle = body.rules;
        return ok({});
      }
      if (bucket[2] === "/domains/managed") return ok({ enabled: b.managed, domain: `pub-x.r2.dev` });
    }
    if (p === `${acct}/pages/projects/feelings-courses/domains` && method === "GET") return ok(state.domains);
    if (p === `${acct}/pages/projects/feelings-courses/domains` && method === "POST") {
      state.domains.push({ name: body.name, status: "initializing" });
      return ok(state.domains.at(-1));
    }
    if (p === "/zones" && method === "GET") return ok(u.searchParams.get("name") === state.zone.name ? [state.zone] : []);
    if (p === `/zones/${state.zone.id}/dns_records` && method === "GET") return ok(state.dns.filter((r) => r.name === u.searchParams.get("name")));
    if (p === `/zones/${state.zone.id}/dns_records` && method === "POST") {
      state.dns.push(body);
      return ok(body);
    }
    return fail(404, 9999, `fake: no route for ${method} ${p}`);
  }
  return { state, fetchImpl };
}

function workspace(config = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "setup-"));
  const full = {
    cloudflare: { accountId: ACCOUNT, apiToken: "t".repeat(40), project: "feelings-courses" },
    razorpay: { keyId: "rzp_test_ABCDEF123", keySecret: KEY_SECRET },
    deployHookUrl: HOOK,
    ...config,
  };
  writeFileSync(path.join(root, "setup.local.json"), JSON.stringify(full));
  return root;
}

async function run(argv, { root, cf, now = new Date("2026-10-23T10:00:00Z") }) {
  const out = [];
  const code = await main(argv, { root, fetchImpl: cf.fetchImpl, log: (s) => out.push(s), error: (s) => out.push(s), confirm: async () => false, now });
  return { code, out: out.join("\n") };
}

const writes = (calls) => calls.filter((c) => !c.startsWith("GET ") && !c.endsWith("/query"));

// ---------------------------------------------------------------- pure parts

test("parseArgs: unknown flags stop the run; go-live is production only", () => {
  assert.deepEqual(parseArgs([]).envs, ["production", "preview"]);
  assert.deepEqual(parseArgs(["--env", "preview"]).envs, ["preview"]);
  assert.deepEqual(parseArgs(["--env=production"]).envs, ["production"]);
  assert.ok(parseArgs(["--dryrun"]).errors.some((e) => e.includes("--dryrun")), "a typo never becomes a real run");
  assert.deepEqual(parseArgs(["--live"]).envs, ["production"]);
  assert.ok(parseArgs(["--live", "--env", "preview"]).errors.length > 0);
  assert.equal(parseArgs(["--add-domain", "Glow"]).addDomain, "glow");
  assert.ok(parseArgs(["--add-domain", "www"]).errors.length > 0, "reserved labels");
  assert.ok(parseArgs(["--add-domain"]).errors.length > 0);
});

test("the slug rule is the same as src/shared/constants.ts", () => {
  assert.equal(COURSE_SLUG_RE.source, constants.COURSE_SLUG_RE.source);
  assert.deepEqual(RESERVED_LABELS, [...constants.RESERVED_LABELS]);
  for (const s of ["glow", "bridal-pro", "a1", "x", "-a", "a--b", "www", "a".repeat(41)]) {
    assert.equal(isValidCourseSlug(s), constants.isValidCourseSlug(s), s);
  }
});

test("lifecycle: the backup rule is added once and every other rule is kept", () => {
  const first = lifecycleWithBackupRule([DEFAULT_RULE]);
  assert.equal(first.changed, true);
  assert.deepEqual(first.rules[0], DEFAULT_RULE);
  assert.deepEqual(first.rules[1], BACKUP_RULE);
  assert.equal(lifecycleWithBackupRule(first.rules).changed, false);
  const edited = lifecycleWithBackupRule([{ ...BACKUP_RULE, deleteObjectsTransition: { condition: { type: "Age", maxAge: 86400 } } }]);
  assert.equal(edited.changed, true);
  assert.equal(edited.rules.length, 1);
  assert.equal(edited.rules[0].deleteObjectsTransition.condition.maxAge, 35 * 86400);
});

test("rebind, plan and backup helpers name things, never secret values", () => {
  const project = {
    deployment_configs: {
      production: {
        d1_databases: { DB: { id: "restore-db" } },
        r2_buckets: { MEDIA: { name: "fbc-media" } },
        env_vars: { APP_ENV: { type: "plain_text", value: "production" }, APP_SECRET: { type: "secret_text", value: "leak" } },
        wrangler_config_hash: "h1",
      },
    },
  };
  const patch = {
    deployment_configs: {
      production: {
        d1_databases: { DB: { id: "main-db" } },
        r2_buckets: { MEDIA: { name: "fbc-media" } },
        env_vars: { APP_ENV: { type: "plain_text", value: "production" }, APP_SECRET: { type: "secret_text", value: "new" }, HUB_HOST: { type: "plain_text", value: "x" } },
      },
    },
  };
  assert.deepEqual(rebindConflicts(project, patch), ["production: DB is bound to database restore-db, setup would bind main-db"]);
  const lines = planLines(project, patch).join("\n");
  assert.match(lines, /binding DB → main-db: CHANGE/);
  assert.match(lines, /binding MEDIA → fbc-media: keep/);
  assert.match(lines, /variable APP_ENV: keep/);
  assert.match(lines, /secret APP_SECRET: set again/);
  assert.match(lines, /variable HUB_HOST: add/);
  assert.ok(!lines.includes("new") && !lines.includes("leak"));
  const saved = JSON.stringify(sanitizeProject(project));
  assert.ok(!saved.includes("leak"), "secret values never reach the backup file");
  assert.ok(saved.includes("restore-db"));
  assert.equal(withConfigHash(patch, project).deployment_configs.production.wrangler_config_hash, "h1");
  assert.equal(patch.deployment_configs.production.wrangler_config_hash, undefined, "the input is not changed");
});

test("domainPlan: attach first, CNAME to the pages.dev name, stop on a conflicting record", () => {
  const base = { slug: "glow", apexDomain: "feelingsbeautycare.in", projectSubdomain: "feelings-courses.pages.dev" };
  assert.deepEqual(domainPlan(base), { host: "glow.feelingsbeautycare.in", target: "feelings-courses.pages.dev", attach: "add", dns: "add" });
  const done = domainPlan({
    ...base,
    pagesDomains: [{ name: "glow.feelingsbeautycare.in", status: "active" }],
    dnsRecords: [{ name: "glow.feelingsbeautycare.in", type: "CNAME", content: "feelings-courses.pages.dev", proxied: true }],
  });
  assert.equal(done.attach, "ok");
  assert.equal(done.dns, "ok");
  const clash = domainPlan({ ...base, dnsRecords: [{ name: "glow.feelingsbeautycare.in", type: "A", content: "192.0.2.1", proxied: false }] });
  assert.equal(clash.dns, "conflict");
  assert.match(clash.conflict, /A → 192\.0\.2\.1 \(DNS only\)/);
  const unproxied = domainPlan({ ...base, dnsRecords: [{ name: "glow.feelingsbeautycare.in", type: "CNAME", content: "feelings-courses.pages.dev", proxied: false }] });
  assert.equal(unproxied.dns, "conflict", "a DNS-only CNAME isn't served by Pages");
});

// ---------------------------------------------------------------- main() against the fake API

test("--dry-run only reads", async () => {
  const root = workspace();
  const cf = fakeCloudflare();
  try {
    const { code, out } = await run(["--dry-run"], { root, cf });
    assert.equal(code, 0, out);
    assert.deepEqual(writes(cf.state.calls), []);
    assert.match(out, /D1 fbc-courses will be created/);
    assert.match(out, /production: also has ENROLL_SECRET \(kept/);
    assert.match(out, /dry run, nothing changed/);
    assert.deepEqual(readdirSync(root), ["setup.local.json"], "no files written");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no confirmation, no change", async () => {
  const root = workspace();
  const cf = fakeCloudflare();
  try {
    const { code } = await run([], { root, cf });
    assert.equal(code, 1);
    assert.deepEqual(writes(cf.state.calls), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a full run creates, binds, keeps hand-set variables, backs up, and a rerun changes nothing new", async () => {
  const root = workspace();
  const cf = fakeCloudflare();
  try {
    const first = await run(["--yes"], { root, cf });
    assert.equal(first.code, 0, first.out);
    const { state } = cf;
    assert.deepEqual(state.d1.map((d) => [d.name, d.hint]), [["fbc-courses", "apac"], ["fbc-courses-preview", "apac"]]);
    assert.equal(state.buckets["fbc-media"].hint, "apac");
    for (const name of ["fbc-media", "fbc-media-preview"]) {
      assert.deepEqual(state.buckets[name].lifecycle, [DEFAULT_RULE, BACKUP_RULE], "the default rule survives the PUT");
    }
    const prod = state.project.deployment_configs.production;
    assert.equal(prod.env_vars.ENROLL_SECRET.value, "hand-set", "a variable set by hand is kept (merge)");
    assert.equal(prod.compatibility_date, "2026-10-01");
    assert.deepEqual(prod.d1_databases, { DB: { id: "uuid-fbc-courses" } });
    assert.equal(prod.env_vars.RAZORPAY_KEY_SECRET.value, KEY_SECRET);
    assert.equal(state.project.deployment_configs.preview.env_vars.DEPLOY_HOOK_URL, undefined);
    assert.ok(!first.out.includes(KEY_SECRET) && !first.out.includes("deploy_hooks/abc"), "no secret on the console");

    const files = readdirSync(root).sort();
    const backupName = files.find((f) => f.startsWith("setup.local.backup-"));
    assert.ok(backupName, files.join());
    for (const f of [backupName, "setup.local.out.json", "setup.local.out.txt"]) {
      assert.equal(statSync(path.join(root, f)).mode & 0o777, 0o600, f);
    }
    const backup = readFileSync(path.join(root, backupName), "utf8");
    assert.ok(!backup.includes("hand-set") && !backup.includes(KEY_SECRET));
    const out = JSON.parse(readFileSync(path.join(root, "setup.local.out.json"), "utf8"));
    assert.ok(!backup.includes(out.production.appSecret));

    // Rerun: same ids, same secrets, no create, no lifecycle write; a backup with bookmarks.
    state.calls.length = 0;
    const second = await run(["--yes"], { root, cf, now: new Date("2026-10-24T10:00:00Z") });
    assert.equal(second.code, 0, second.out);
    assert.deepEqual(writes(state.calls), [`PATCH /accounts/${ACCOUNT}/pages/projects/feelings-courses`]);
    assert.match(second.out, /secret APP_SECRET: set again/);
    assert.match(second.out, /binding DB → uuid-fbc-courses: keep/);
    const again = JSON.parse(readFileSync(path.join(root, "setup.local.out.json"), "utf8"));
    assert.deepEqual(again, out, "generated secrets are reused");
    const latest = readdirSync(root).filter((f) => f.startsWith("setup.local.backup-")).sort().at(-1);
    assert.match(readFileSync(path.join(root, latest), "utf8"), /bm-uuid-fbc-courses/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--env preview touches only the preview environment", async () => {
  const root = workspace();
  const cf = fakeCloudflare();
  try {
    const { code, out } = await run(["--env", "preview", "--yes"], { root, cf });
    assert.equal(code, 0, out);
    assert.deepEqual(cf.state.d1.map((d) => d.name), ["fbc-courses-preview"]);
    assert.equal(cf.state.project.deployment_configs.production.d1_databases, undefined);
    assert.equal(cf.state.project.deployment_configs.preview.env_vars.APP_ENV.value, "preview");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an existing binding to another database stops the run unless --allow-rebind", async () => {
  const root = workspace();
  const cf = fakeCloudflare({
    projectConfigs: { production: { d1_databases: { DB: { id: "uuid-fbc-courses-restore" } }, env_vars: {} }, preview: { env_vars: {} } },
  });
  cf.state.d1.push({ name: "fbc-courses", uuid: "uuid-fbc-courses" }, { name: "fbc-courses-preview", uuid: "uuid-fbc-courses-preview" });
  cf.state.buckets["fbc-media"] = { lifecycle: [DEFAULT_RULE, BACKUP_RULE], managed: true };
  cf.state.buckets["fbc-media-preview"] = { lifecycle: [DEFAULT_RULE, BACKUP_RULE], managed: false };
  try {
    const stopped = await run(["--yes"], { root, cf });
    assert.equal(stopped.code, 1);
    assert.match(stopped.out, /DB is bound to database uuid-fbc-courses-restore/);
    assert.match(stopped.out, /fbc-media is public on r2\.dev/);
    assert.deepEqual(writes(cf.state.calls), []);
    const allowed = await run(["--yes", "--allow-rebind"], { root, cf });
    assert.equal(allowed.code, 0, allowed.out);
    assert.equal(cf.state.project.deployment_configs.production.d1_databases.DB.id, "uuid-fbc-courses");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R2 not enabled: a plain instruction, nothing changed", async () => {
  const root = workspace();
  const cf = fakeCloudflare({ r2Enabled: false });
  try {
    await assert.rejects(run(["--yes"], { root, cf }), /R2 isn't enabled/);
    assert.deepEqual(writes(cf.state.calls), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("go-live: blocked before the schema exists and until the checks pass; then production only", async () => {
  const root = workspace({ razorpay: { keyId: "rzp_live_ABCDEF123", keySecret: KEY_SECRET } });
  const cf = fakeCloudflare();
  try {
    const noDb = await run(["--live", "--yes"], { root, cf });
    assert.equal(noDb.code, 1);
    assert.match(noDb.out, /no data yet/);
    cf.state.d1.push({ name: "fbc-courses", uuid: "uuid-fbc-courses" });
    cf.state.buckets["fbc-media"] = { lifecycle: [DEFAULT_RULE], managed: false };
    const unmigrated = await run(["--live", "--yes"], { root, cf });
    assert.equal(unmigrated.code, 1, "no such table is a blocker, not a crash");
    assert.match(unmigrated.out, /no data yet/);
    cf.state.tables = { legal: "true", demo_published: 1, real_published: 0 };
    const notReady = await run(["--live", "--yes"], { root, cf });
    assert.match(notReady.out, /demo course is still published/);
    assert.deepEqual(writes(cf.state.calls), []);

    cf.state.tables = { legal: "true", demo_published: 0, real_published: 2 };
    cf.state.project.deployment_configs.preview.env_vars.RAZORPAY_KEY_ID = { type: "plain_text", value: "rzp_test_ABCDEF123" };
    const live = await run(["--live", "--yes"], { root, cf });
    assert.equal(live.code, 0, live.out);
    assert.equal(cf.state.project.deployment_configs.production.env_vars.RAZORPAY_KEY_ID.value, "rzp_live_ABCDEF123");
    assert.equal(cf.state.project.deployment_configs.preview.env_vars.RAZORPAY_KEY_ID.value, "rzp_test_ABCDEF123", "previews keep test keys");
    assert.ok(!cf.state.d1.some((d) => d.name === "fbc-courses-preview"), "go-live doesn't create preview resources");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--add-domain: attaches, then adds the proxied CNAME; idempotent; needs no Razorpay keys", async () => {
  const root = workspace({ razorpay: undefined, deployHookUrl: undefined });
  const cf = fakeCloudflare();
  try {
    const dry = await run(["--add-domain", "glow", "--dry-run"], { root, cf });
    assert.equal(dry.code, 0, dry.out);
    assert.deepEqual(writes(cf.state.calls), []);
    const done = await run(["--add-domain", "glow", "--yes"], { root, cf });
    assert.equal(done.code, 0, done.out);
    assert.deepEqual(cf.state.domains.map((d) => d.name), ["glow.feelingsbeautycare.in"]);
    assert.deepEqual(
      cf.state.dns.map((r) => [r.type, r.name, r.content, r.proxied]),
      [["CNAME", "glow.feelingsbeautycare.in", "feelings-courses.pages.dev", true]],
    );
    const order = writes(cf.state.calls);
    assert.ok(order[0].endsWith("/pages/projects/feelings-courses/domains") && order[1].endsWith("/dns_records"), "attach before DNS");
    cf.state.calls.length = 0;
    const again = await run(["--add-domain", "glow", "--yes"], { root, cf });
    assert.match(again.out, /nothing to do/);
    assert.deepEqual(writes(cf.state.calls), []);
    cf.state.dns.push({ type: "A", name: "bridal-pro.feelingsbeautycare.in", content: "192.0.2.1", proxied: true });
    const clash = await run(["--add-domain", "bridal-pro", "--yes"], { root, cf });
    assert.equal(clash.code, 1);
    assert.match(clash.out, /already has A → 192\.0\.2\.1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a wrangler config in the repo stops setup (it would own the bindings)", async () => {
  const root = workspace();
  writeFileSync(path.join(root, "wrangler.toml"), 'name = "x"\n');
  const cf = fakeCloudflare();
  try {
    const { code, out } = await run(["--dry-run"], { root, cf });
    assert.equal(code, 1);
    assert.match(out, /wrangler\.toml exists/);
    assert.deepEqual(cf.state.calls, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
