// functions/_lib/ratelimit.ts: fixed windows in D1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../helpers/d1.mjs";
import { bucketKey, cleanupRateLimits, hit, peek } from "../../functions/_lib/ratelimit.ts";
import { RATE_LIMITS } from "../../functions/_lib/config.ts";

const db = await createTestDb({ only: ["0001_init.sql"] });
// The start of a 15-minute window (fixed windows are aligned to the epoch).
const base = Math.floor(1_761_200_100 / 900) * 900;

test("counts hits and refuses the one over the limit", async () => {
  const rule = RATE_LIMITS.restore_ip; // 5 per 15 min
  const results = [];
  for (let i = 0; i < 6; i++) results.push(await hit(db, "restore_ip", "203.0.113.9", { now: base + i }));
  assert.deepEqual(results.map((r) => r.count), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(results.map((r) => r.allowed), [true, true, true, true, true, false]);
  assert.equal(results[5].limit, rule.limit);
  assert.equal(results[5].resetAt, base + rule.window);
  assert.equal(results[5].retryAfter, rule.window - 5);
});

test("subjects and rules are counted separately", async () => {
  const a = await hit(db, "restore_ip", "198.51.100.1", { now: base });
  const b = await hit(db, "order_ip", "203.0.113.9", { now: base });
  assert.equal(a.count, 1);
  assert.equal(b.count, 1);
});

test("a new window starts from zero", async () => {
  const next = await hit(db, "restore_ip", "203.0.113.9", { now: base + 900 });
  assert.equal(next.count, 1);
  assert.equal(next.allowed, true);
});

test("peek reads without counting", async () => {
  const before = await peek(db, "restore_ip", "203.0.113.9", { now: base + 1 });
  const again = await peek(db, "restore_ip", "203.0.113.9", { now: base + 1 });
  assert.equal(before.count, 6);
  assert.equal(again.count, 6);
  assert.equal(before.allowed, false);
});

test("custom rules and unknown names", async () => {
  const r = await hit(db, "custom", "x", { rule: { limit: 1, window: 60 }, now: base });
  assert.equal(r.allowed, true);
  await assert.rejects(hit(db, "no_such_rule", "x"), /unknown rule/);
});

test("odd subjects are encoded into a safe bucket key", () => {
  const key = bucketKey("restore_ip", "fe80::1%eth0 <script>", { limit: 1, window: 60 }, 120);
  assert.match(key, /^restore_ip:[A-Za-z0-9_.:@+%-]+:120$/);
});

test("expired buckets are cleaned up", async () => {
  const later = base + 900 + 86_400 + 900 + 1;
  const removed = await cleanupRateLimits(db, later);
  assert.ok(removed >= 4, `removed ${removed}`);
  assert.equal(db.get("SELECT count(*) AS n FROM rate_limits").n, 0);
});
