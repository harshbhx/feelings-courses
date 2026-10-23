// D1's lower SQLite limits, which node:sqlite doesn't have: the test shim refuses what D1 refuses
// (tests/helpers/d1.mjs checkD1Limits), the migrations stay within them, and the admin search's
// LIKE pattern always fits. The values were checked against `wrangler d1 execute --local`
// (workerd's D1): 6 compound terms and a 51-byte LIKE pattern fail there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, D1_LIMITS, checkD1Limits, loadMigrations } from "../helpers/d1.mjs";
import { likePattern, MAX_LIKE_PATTERN_BYTES } from "../../functions/_lib/db/validate.ts";

const bytes = (s) => new TextEncoder().encode(s).length;
const compound = (n) => Array.from({ length: n }, (_, i) => `SELECT ${i + 1}`).join(" UNION ALL ");

test("the shim refuses a compound SELECT over 5 terms, as D1 does", async () => {
  const db = await createTestDb({ migrate: false });
  assert.equal(await db.prepare(`SELECT count(*) AS n FROM (${compound(5)})`).first("n"), 5);
  await assert.rejects(db.prepare(`SELECT count(*) AS n FROM (${compound(6)})`).first("n"), /too many terms in compound SELECT/);
  // A VALUES list is not a compound SELECT on D1.
  const values = Array.from({ length: 20 }, (_, i) => `(${i})`).join(", ");
  assert.equal(await db.prepare(`SELECT count(*) AS n FROM (VALUES ${values})`).first("n"), 20);
});

test("the shim refuses more than 100 bound parameters, as D1 does", async () => {
  const db = await createTestDb({ migrate: false });
  const sql = (n) => `SELECT ${Array.from({ length: n }, () => "?").join(" + ")} AS n`;
  assert.equal(await db.prepare(sql(100)).bind(...Array(100).fill(1)).first("n"), 100);
  await assert.rejects(db.prepare(sql(101)).bind(...Array(101).fill(1)).first("n"), /too many SQL variables/);
});

test("the shim refuses a LIKE pattern over 50 bytes, as D1 does", () => {
  const sql = "SELECT 1 WHERE 'x' LIKE ? ESCAPE '\\'";
  assert.doesNotThrow(() => checkD1Limits(sql, [`%${"a".repeat(48)}%`]));
  assert.throws(() => checkD1Limits(sql, [`%${"a".repeat(49)}%`]), /LIKE or GLOB pattern too complex/);
});

test("every migration statement is within D1's limits", () => {
  for (const { name, statements } of loadMigrations()) {
    for (const sql of statements) {
      assert.doesNotThrow(() => checkD1Limits(sql), `${name}: ${sql.slice(0, 80)}…`);
    }
  }
  assert.equal(D1_LIMITS.likePatternBytes, MAX_LIKE_PATTERN_BYTES);
});

test("likePattern always fits D1's 50-byte limit and keeps the start of the term", () => {
  const email = "a.very.long.student.email.address.for.testing@example-domain.co.in";
  const p = likePattern(email);
  assert.ok(bytes(p) <= MAX_LIKE_PATTERN_BYTES, `${bytes(p)} bytes`);
  assert.ok(p.startsWith("%a.very.long") && p.endsWith("%"));

  const gujarati = "ધ્રુવીબેન પ્રજાપતિ મહેતા શાહ"; // 3 bytes a letter in UTF-8
  const g = likePattern(gujarati);
  assert.ok(bytes(g) <= MAX_LIKE_PATTERN_BYTES, `${bytes(g)} bytes`);
  assert.ok(gujarati.startsWith(g.slice(1, -1)));

  // Escapes count, and are never cut in half.
  const escaped = likePattern("%".repeat(40));
  assert.ok(bytes(escaped) <= MAX_LIKE_PATTERN_BYTES);
  assert.match(escaped, /^%(\\%)+%$/);

  // Short terms are unchanged.
  assert.equal(likePattern("Riya_P"), "%Riya\\_P%");
  assert.equal(likePattern("  "), null);
});
