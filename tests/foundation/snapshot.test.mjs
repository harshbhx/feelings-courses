// scripts/snapshot.mjs: where the build's content comes from (plan 1.1 bootstrap edge cases).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSnapshot, resolveSnapshot, writeResult } from "../../scripts/snapshot.mjs";
import { seedSnapshot } from "../../src/data/seed-snapshot.ts";

const MAIN = { CF_PAGES_BRANCH: "main" };
const good = seedSnapshot(1_761_200_000);

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push(url);
    return handler(url, init, calls.length);
  };
  fn.calls = calls;
  return fn;
}
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("preview branches and local builds use the seed without fetching", async () => {
  const f = fakeFetch(() => assert.fail("must not fetch"));
  assert.deepEqual(await resolveSnapshot({ env: {}, fetchImpl: f }), { source: "seed" });
  assert.deepEqual(await resolveSnapshot({ env: { CF_PAGES_BRANCH: "feat/x" }, fetchImpl: f }), { source: "seed" });
  assert.deepEqual(await resolveSnapshot({ env: { ...MAIN, SNAPSHOT_SOURCE: "seed" }, fetchImpl: f }), { source: "seed" });
});

test("main with a live endpoint uses it", async () => {
  const f = fakeFetch(() => jsonRes(good));
  const r = await resolveSnapshot({ env: MAIN, fetchImpl: f });
  assert.equal(r.source, "live");
  assert.deepEqual(r.snapshot, good);
  assert.equal(f.calls[0], "https://courses.feelingsbeautycare.in/api/public/snapshot");
});

test("main, endpoint 404 (first deploy): seed with a warning", async () => {
  const r = await resolveSnapshot({ env: MAIN, fetchImpl: fakeFetch(() => new Response("nope", { status: 404 })) });
  assert.equal(r.source, "seed");
  assert.match(r.warning, /404/);
});

test("main, endpoint missing and Pages answers its HTML fallback with 200: seed with a warning", async () => {
  const html = () => new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } });
  const r = await resolveSnapshot({ env: MAIN, fetchImpl: fakeFetch(html) });
  assert.equal(r.source, "seed");
  assert.match(r.warning, /text\/html/);
});

test("main, 5xx or unreachable (after one retry): the build fails", async () => {
  const f500 = fakeFetch(() => new Response("down", { status: 503 }));
  await assert.rejects(resolveSnapshot({ env: MAIN, fetchImpl: f500 }), /answered 503/);
  assert.equal(f500.calls.length, 2);
  const fNet = fakeFetch(() => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(resolveSnapshot({ env: MAIN, fetchImpl: fNet }), /unreachable/);
  // A 5xx then a 200 recovers.
  const flaky = fakeFetch((_, __, n) => (n === 1 ? new Response("", { status: 502 }) : jsonRes(good)));
  assert.equal((await resolveSnapshot({ env: MAIN, fetchImpl: flaky })).source, "live");
});

test("main, JSON that isn't a snapshot: the build fails", async () => {
  await assert.rejects(resolveSnapshot({ env: MAIN, fetchImpl: fakeFetch(() => jsonRes({ error: "x" })) }), /isn't a snapshot/);
});

test("SNAPSHOT_URL: used as given; a 404 there fails instead of falling back", async () => {
  const f = fakeFetch(() => jsonRes(good));
  const r = await resolveSnapshot({ env: { SNAPSHOT_URL: "https://example.test/snap.json" }, fetchImpl: f });
  assert.equal(r.source, "url");
  assert.equal(f.calls[0], "https://example.test/snap.json");
  await assert.rejects(
    resolveSnapshot({ env: { SNAPSHOT_URL: "https://example.test/x" }, fetchImpl: fakeFetch(() => new Response("", { status: 404 })) }),
    /answered 404/,
  );
});

test("isSnapshot accepts the seed and refuses junk", () => {
  assert.equal(isSnapshot(good), true);
  for (const bad of [null, [], {}, { ...good, courses: "x" }, { ...good, contentVersion: 1.5 }, { ...good, settings: null }]) {
    assert.equal(isSnapshot(bad), false);
  }
});

test("writeResult writes a fetched snapshot and removes it for the seed", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fbc-snap-"));
  const file = path.join(dir, "generated", "snapshot.json");
  writeResult({ source: "live", snapshot: good }, file);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { source: "live", snapshot: good });
  writeResult({ source: "seed" }, file);
  assert.equal(existsSync(file), false);
  rmSync(dir, { recursive: true, force: true });
});
