// Applies migrations/*.sql to a real (local) D1, the way production does: through the runtime's own
// functions/_lib/migrate.ts on workerd's SQLite, which has D1's limits (node:sqlite in the tests
// doesn't). Then applies them again (nothing must happen) and checks the seed is there.
//
//   node --experimental-strip-types --no-warnings --import ./tests/helpers/register.mjs scripts/ci/d1-check.mjs
//
// Uses wrangler's getPlatformProxy with a throwaway config in a temp folder: no Cloudflare account,
// no network, nothing persisted. CI (the Verify workflow) runs it. Exit 1 on any problem.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getPlatformProxy } from "wrangler";
import { loadMigrations } from "../lib/migrations.mjs";
import { applyMigrations } from "../../functions/_lib/migrate.ts";

const dir = mkdtempSync(path.join(tmpdir(), "fc-d1-check-"));
const config = path.join(dir, "wrangler.json");
writeFileSync(
  config,
  JSON.stringify({
    name: "fc-d1-check",
    compatibility_date: "2026-10-01",
    d1_databases: [{ binding: "DB", database_name: "fc-d1-check", database_id: "00000000-0000-0000-0000-000000000000" }],
  }),
);

const problems = [];
const proxy = await getPlatformProxy({ configPath: config, persist: false });
try {
  const db = proxy.env.DB;
  const migrations = loadMigrations();
  const names = migrations.map((m) => m.name);

  let first;
  try {
    first = await applyMigrations(db, migrations);
  } catch (err) {
    problems.push(`first run failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (first && JSON.stringify(first) !== JSON.stringify(names)) problems.push(`first run applied ${JSON.stringify(first)}, expected ${JSON.stringify(names)}`);

  if (first) {
    const second = await applyMigrations(db, migrations);
    if (second.length) problems.push(`second run applied ${JSON.stringify(second)} (must be idempotent)`);

    const { results } = await db.prepare("SELECT name FROM d1_migrations ORDER BY id").all();
    const recorded = results.map((r) => r.name);
    if (JSON.stringify(recorded) !== JSON.stringify(names)) problems.push(`d1_migrations has ${JSON.stringify(recorded)}`);

    const counts = await db
      .prepare("SELECT (SELECT count(*) FROM courses) AS courses, (SELECT count(*) FROM modules) AS modules, (SELECT count(*) FROM lessons) AS lessons, (SELECT count(*) FROM settings) AS settings")
      .first();
    for (const [table, n] of Object.entries(counts ?? {})) if (!(n > 0)) problems.push(`${table} is empty after the seed`);
    console.log(`d1-check: applied ${names.join(", ")} on workerd's D1; again: nothing; seed rows ${JSON.stringify(counts)}`);
  }
} finally {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
}

if (problems.length) {
  console.error(`d1-check: ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("d1-check: migrations apply cleanly on D1 and are idempotent.");
