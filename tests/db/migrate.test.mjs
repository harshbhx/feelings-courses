// Runtime self-migration (functions/_lib/migrate.ts) and the statement splitter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TestD1, loadMigrations } from "../helpers/d1.mjs";
import { splitSql } from "../../scripts/lib/migrations.mjs";
import { applyMigrations, ensureMigrated, resetMigrationState } from "../../functions/_lib/migrate.ts";
import { MIGRATIONS } from "../../functions/_generated/migrations.ts";

const all = loadMigrations();

test("the embedded migrations are exactly migrations/*.sql", () => {
  assert.deepEqual(MIGRATIONS, all);
  assert.deepEqual(all.map((m) => m.name).slice(0, 2), ["0001_init.sql", "0002_seed.sql"]);
});

test("a fresh database is migrated, in wrangler's d1_migrations format", async () => {
  const db = new TestD1();
  assert.deepEqual(await applyMigrations(db, all), all.map((m) => m.name));
  const columns = db.rows("PRAGMA table_info(d1_migrations)").map((c) => c.name);
  assert.deepEqual(columns, ["id", "name", "applied_at"]);
  const rows = db.rows("SELECT id, name, applied_at FROM d1_migrations ORDER BY id");
  assert.deepEqual(rows.map((r) => r.name), all.map((m) => m.name));
  assert.match(rows[0].applied_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  // Running again applies nothing.
  assert.deepEqual(await applyMigrations(db, all), []);
});

test("two concurrent runs apply each migration once", async () => {
  const db = new TestD1();
  const [a, b] = await Promise.all([applyMigrations(db, all), applyMigrations(db, all)]);
  assert.deepEqual([...a, ...b].sort(), all.map((m) => m.name).sort());
  assert.equal(db.get("SELECT count(*) AS n FROM d1_migrations").n, all.length);
  assert.equal(db.get("SELECT count(*) AS n FROM courses").n, 4, "the seed ran once");
});

test("a failing migration applies nothing and is not recorded", async () => {
  const db = new TestD1();
  await applyMigrations(db, all.slice(0, 1));
  const bad = { name: "0099_bad.sql", statements: ["CREATE TABLE extra (id INTEGER PRIMARY KEY)", "INSERT INTO nope VALUES (1)"] };
  await assert.rejects(applyMigrations(db, [...all.slice(0, 1), bad]), /0099_bad\.sql failed/);
  assert.equal(db.get("SELECT count(*) AS n FROM sqlite_master WHERE name = 'extra'").n, 0, "rolled back");
  assert.equal(db.get("SELECT count(*) AS n FROM d1_migrations WHERE name = '0099_bad.sql'").n, 0);
});

test("ensureMigrated runs once per isolate and retries after a failure", async () => {
  resetMigrationState();
  const db = new TestD1();
  let fail = true;
  const flaky = { name: "0001_flaky.sql", statements: ["CREATE TABLE t (id INTEGER)"] };
  const realBatch = db.batch.bind(db);
  db.batch = async (stmts) => {
    if (fail) throw new Error("D1_ERROR: network");
    return realBatch(stmts);
  };
  await assert.rejects(ensureMigrated(db, [flaky]));
  fail = false;
  await Promise.all([ensureMigrated(db, [flaky]), ensureMigrated(db, [flaky])]);
  assert.equal(db.get("SELECT count(*) AS n FROM d1_migrations").n, 1);
  const prepared = db.log.length;
  await ensureMigrated(db, [flaky]);
  assert.equal(db.log.length, prepared, "no queries once migrated");
  resetMigrationState();
});

test("splitSql: semicolons in strings and comments don't split", () => {
  assert.deepEqual(splitSql("-- a; comment\nSELECT 'a;b'; /* c;d */ SELECT \"x;y\";\n\nSELECT 1"), [
    "SELECT 'a;b'",
    'SELECT "x;y"',
    "SELECT 1",
  ]);
  assert.deepEqual(splitSql("SELECT 'it''s; fine';"), ["SELECT 'it''s; fine'"]);
  assert.throws(() => splitSql("CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END;"), /triggers/);
  assert.throws(() => splitSql("SELECT 'open"), /unterminated/);
});

test("migration files keep wrangler's rule: no semicolon inside a comment", () => {
  for (const m of all) {
    const text = readFileSync(path.join(import.meta.dirname, "..", "..", "migrations", m.name), "utf8");
    text.split("\n").forEach((line, i) => {
      const comment = line.indexOf("--");
      if (comment !== -1 && !line.slice(0, comment).includes("'")) {
        assert.ok(!line.slice(comment).includes(";"), `${m.name}:${i + 1} has a semicolon in a comment`);
      }
    });
  }
});
