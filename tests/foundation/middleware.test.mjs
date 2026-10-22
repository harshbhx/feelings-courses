// functions/_middleware.ts: migrate → hostRouting → learn gate, and the demo unchanged without D1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../../functions/_middleware.ts";
import { resetMigrationState } from "../../functions/_lib/migrate.ts";
import { TestD1 } from "../helpers/d1.mjs";
import { context, req } from "../helpers/http.mjs";

test("without a DB binding (before setup) the site behaves as before", async () => {
  const home = context({ request: req("/"), env: {} });
  const res = await onRequest(home);
  assert.equal(res.status, 200);
  assert.equal(home.nextCalls.length, 1, "static pages pass straight on");

  // The course area is still gated by the demo's cookie check: no cookie → the price card.
  const learn = context({ request: req("/learn"), env: {} });
  const locked = await onRequest(learn);
  assert.equal(locked.status, 302);
  assert.equal(locked.headers.get("Location"), "/?locked=1#pricing");
  assert.equal(learn.nextCalls.length, 0);

  const odd = await onRequest(context({ request: req("/%6cearn/soft-glam"), env: {} }));
  assert.equal(odd.status, 302, "odd spellings of /learn stay gated");
});

test("with a DB binding the first request migrates, then passes on", async () => {
  resetMigrationState();
  const db = new TestD1();
  const ctx = context({ request: req("/"), env: { DB: db } });
  const res = await onRequest(ctx);
  assert.equal(res.status, 200);
  assert.ok(db.get("SELECT count(*) AS n FROM d1_migrations").n >= 2);
  assert.equal(db.get("SELECT slug FROM courses WHERE id = 1").slug, "selfmakeup");
  const before = db.log.length;
  await onRequest(context({ request: req("/catalog"), env: { DB: db } }));
  assert.equal(db.log.length, before, "later requests in the isolate run no migration queries");
  resetMigrationState();
});

test("a failing migration doesn't take the site down", async () => {
  resetMigrationState();
  const broken = {
    prepare() {
      throw new Error("D1_ERROR: unavailable");
    },
    batch() {
      throw new Error("D1_ERROR: unavailable");
    },
  };
  const original = console.error;
  console.error = () => {};
  try {
    const res = await onRequest(context({ request: req("/"), env: { DB: broken } }));
    assert.equal(res.status, 200);
  } finally {
    console.error = original;
    resetMigrationState();
  }
});
