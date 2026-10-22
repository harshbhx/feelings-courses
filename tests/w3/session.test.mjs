// W3 sessions, login tokens and enrollment checks (functions/_lib/session.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  consumeLoginToken,
  createSession,
  issueLoginToken,
  peekLoginToken,
  readSession,
  requireEnrollment,
  revokeAllSessions,
  safeRedirectPath,
  sessionToken,
  TOKEN_RE,
} from "../../functions/_lib/session.ts";
import { sha256Hex } from "../../functions/_lib/crypto.ts";
import { SESSION_COOKIE, SESSION_TTL } from "../../functions/_lib/config.ts";
import { cookiesFrom, req } from "../helpers/http.mjs";
import { ASHA, DAY, env, LIVE_KEYS, NOW, sessionCookie, setupDb, TEST_KEYS } from "./fixtures.mjs";

const UA = (name) => ({ headers: { "User-Agent": name } });

test("createSession: __Host- cookie with a random token; D1 keeps only its hash", async () => {
  const db = await setupDb();
  const { cookie } = await createSession(db, ASHA.id, req("/signin", UA("Phone A")), NOW);
  const response = new Response(null, { headers: { "Set-Cookie": cookie } });
  const parsed = cookiesFrom(response)[SESSION_COOKIE];
  assert.ok(parsed, "sets the session cookie");
  assert.match(parsed.value, TOKEN_RE);
  assert.equal(parsed.attributes.httponly, true);
  assert.equal(parsed.attributes.secure, true);
  assert.equal(parsed.attributes.path, "/");
  assert.equal(parsed.attributes.samesite, "Lax");
  assert.equal(parsed.attributes.domain, undefined, "__Host- cookies have no Domain");
  assert.equal(Number(parsed.attributes["max-age"]), SESSION_TTL);

  const row = db.get("SELECT * FROM sessions WHERE student_id = ?", ASHA.id);
  assert.equal(row.token_hash, await sha256Hex(parsed.value));
  assert.notEqual(row.token_hash, parsed.value);
  assert.equal(row.user_agent, "Phone A");
  assert.equal(row.expires_at, NOW + SESSION_TTL);
  assert.equal(JSON.stringify(db.rows("SELECT * FROM sessions")).includes(parsed.value), false, "raw token never stored");
});

test("device limit: the 3rd sign-in revokes the oldest session; 2 stay live", async () => {
  const db = await setupDb();
  const a = await sessionCookie(db, ASHA.id, { now: NOW - 300, userAgent: "A" });
  const b = await sessionCookie(db, ASHA.id, { now: NOW - 200, userAgent: "B" });
  const c = await sessionCookie(db, ASHA.id, { now: NOW - 100, userAgent: "C" });
  const live = db.rows("SELECT user_agent FROM sessions WHERE student_id = 1 AND revoked_at IS NULL ORDER BY id").map((r) => r.user_agent);
  assert.deepEqual(live, ["B", "C"]);
  assert.equal(await readSession(env(db), req("/", { cookie: a }), NOW), null, "the oldest device is signed out");
  assert.ok(await readSession(env(db), req("/", { cookie: b }), NOW));
  assert.ok(await readSession(env(db), req("/", { cookie: c }), NOW));
});

test("device limit counts only live sessions, and another student's sessions don't count", async () => {
  const db = await setupDb();
  await sessionCookie(db, ASHA.id, { now: NOW - 500, userAgent: "expired" });
  db.sqlite.exec(`UPDATE sessions SET expires_at = ${NOW - 450} WHERE user_agent = 'expired'`);
  await sessionCookie(db, 2, { now: NOW - 400, userAgent: "Bina" });
  await sessionCookie(db, ASHA.id, { now: NOW - 300, userAgent: "A" });
  await sessionCookie(db, ASHA.id, { now: NOW - 200, userAgent: "B" });
  const asha = db.rows("SELECT user_agent FROM sessions WHERE student_id = 1 AND revoked_at IS NULL ORDER BY id").map((r) => r.user_agent);
  assert.deepEqual(asha, ["expired", "A", "B"], "the expired one isn't revoked, just ignored");
  assert.equal(db.get("SELECT revoked_at FROM sessions WHERE user_agent = 'Bina'").revoked_at, null);
});

test("signing in again on the same device replaces its session instead of using another slot", async () => {
  const db = await setupDb();
  const other = await sessionCookie(db, ASHA.id, { now: NOW - 300, userAgent: "Laptop" });
  const phone = await sessionCookie(db, ASHA.id, { now: NOW - 200, userAgent: "Phone" });
  const { cookie } = await createSession(db, ASHA.id, req("/signin", { cookie: phone, headers: { "User-Agent": "Phone" } }), NOW);
  assert.ok(await readSession(env(db), req("/", { cookie: other }), NOW), "the laptop stays signed in");
  assert.equal(await readSession(env(db), req("/", { cookie: phone }), NOW), null, "the phone's old token is gone");
  assert.ok(await readSession(env(db), req("/", { cookie: cookie.split(";")[0] }), NOW));
});

test("createSession refuses an erased or unknown student", async () => {
  const db = await setupDb();
  await assert.rejects(createSession(db, 3, req("/"), NOW), /can't sign in/);
  await assert.rejects(createSession(db, 999, req("/"), NOW), /can't sign in/);
  assert.equal(db.get("SELECT count(*) AS n FROM sessions").n, 0);
});

test("readSession: valid, malformed, unknown, revoked, expired, erased", async () => {
  const db = await setupDb();
  const cookie = await sessionCookie(db, ASHA.id);
  const ref = await readSession(env(db), req("/", { cookie }), NOW);
  assert.equal(ref.studentId, ASHA.id);
  assert.match(ref.tokenHash, /^[0-9a-f]{64}$/);

  assert.equal(await readSession(env(db), req("/"), NOW), null, "no cookie");
  assert.equal(await readSession(env(db), req("/", { cookie: `${SESSION_COOKIE}=short` }), NOW), null, "malformed");
  assert.equal(await readSession(env(db), req("/", { cookie: `${SESSION_COOKIE}=${"A".repeat(43)}` }), NOW), null, "unknown");
  assert.equal(await readSession({}, req("/", { cookie }), NOW), null, "no DB bound");
  assert.equal(await readSession(env(db), req("/", { cookie }), NOW + SESSION_TTL), null, "expired");

  db.sqlite.exec("UPDATE students SET erased_at = 1, name = NULL, phone = NULL, email = NULL WHERE id = 1");
  assert.equal(await readSession(env(db), req("/", { cookie }), NOW), null, "erased student");
});

test("readSession touches last_seen_at at most daily and slides the expiry", async () => {
  const db = await setupDb();
  const cookie = await sessionCookie(db, ASHA.id);
  const writes = () => db.log.filter((sql) => sql.startsWith("UPDATE sessions SET last_seen_at")).length;
  await readSession(env(db), req("/", { cookie }), NOW + 3600);
  assert.equal(writes(), 0, "within a day: no write");
  await readSession(env(db), req("/", { cookie }), NOW + 2 * DAY);
  assert.equal(writes(), 1);
  const row = db.get("SELECT last_seen_at, expires_at FROM sessions");
  assert.equal(row.last_seen_at, NOW + 2 * DAY);
  assert.equal(row.expires_at, NOW + 2 * DAY + SESSION_TTL);
});

test("revokeAllSessions signs every device out", async () => {
  const db = await setupDb();
  const a = await sessionCookie(db, ASHA.id, { now: NOW - 10 });
  const b = await sessionCookie(db, ASHA.id);
  assert.equal(await revokeAllSessions(db, ASHA.id, NOW), 2);
  for (const cookie of [a, b]) assert.equal(await readSession(env(db), req("/", { cookie }), NOW), null);
});

test("sessionToken takes only a well-formed cookie value", () => {
  const good = "a".repeat(43);
  assert.equal(sessionToken(req("/", { cookie: `x=1; ${SESSION_COOKIE}=${good}` })), good);
  assert.equal(sessionToken(req("/", { cookie: `${SESSION_COOKIE}=${good}x` })), null);
  assert.equal(sessionToken(req("/", { cookie: `${SESSION_COOKIE}=${"a".repeat(42)}'` })), null);
});

test("safeRedirectPath allows same-site paths only", () => {
  assert.equal(safeRedirectPath("/account"), "/account");
  assert.equal(safeRedirectPath("/learn/selfmakeup?x=1#top"), "/learn/selfmakeup?x=1#top");
  assert.equal(safeRedirectPath("/a/../account"), "/account");
  for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example/", "account", "", "/a b", "/x\n", "/x\t", null, 5, "/" + "a".repeat(400)]) {
    assert.equal(safeRedirectPath(bad), null, `refuses ${JSON.stringify(bad)}`);
  }
});

test("login tokens: hash stored, single use, expiry by purpose", async () => {
  const db = await setupDb();
  const token = await issueLoginToken(db, ASHA.id, "handoff", "/receipt/1?k=abc", NOW);
  assert.match(token, TOKEN_RE);
  const row = db.get("SELECT * FROM login_tokens");
  assert.equal(row.token_hash, await sha256Hex(token));
  assert.equal(row.expires_at, NOW + 600);
  assert.equal(row.redirect_path, "/receipt/1?k=abc");

  assert.equal(await peekLoginToken(db, token, NOW), "handoff");
  assert.equal(await peekLoginToken(db, token, NOW), "handoff", "peeking doesn't use it");
  const used = await consumeLoginToken(db, token, NOW + 60);
  assert.deepEqual(used, { studentId: ASHA.id, purpose: "handoff", redirectPath: "/receipt/1?k=abc" });
  assert.equal(await consumeLoginToken(db, token, NOW + 61), null, "second use refused");
  assert.equal(await peekLoginToken(db, token, NOW + 61), null);

  const late = await issueLoginToken(db, ASHA.id, "handoff", "/account", NOW);
  assert.equal(await consumeLoginToken(db, late, NOW + 601), null, "handoff tokens last 10 minutes");
  const link = await issueLoginToken(db, ASHA.id, "admin_link", "/account", NOW);
  assert.ok(await consumeLoginToken(db, link, NOW + DAY - 1), "admin links last 24 hours");
});

test("login tokens: racing consumers, only one wins", async () => {
  const db = await setupDb();
  const token = await issueLoginToken(db, ASHA.id, "admin_link", "/account", NOW);
  const results = await Promise.all([consumeLoginToken(db, token, NOW), consumeLoginToken(db, token, NOW), consumeLoginToken(db, token, NOW)]);
  assert.equal(results.filter(Boolean).length, 1);
});

test("a new admin link replaces the student's unused older ones", async () => {
  const db = await setupDb();
  const first = await issueLoginToken(db, ASHA.id, "admin_link", "/account", NOW);
  const handoff = await issueLoginToken(db, ASHA.id, "handoff", "/account", NOW);
  const second = await issueLoginToken(db, ASHA.id, "admin_link", "/account", NOW + 5);
  assert.equal(await consumeLoginToken(db, first, NOW + 10), null);
  assert.ok(await consumeLoginToken(db, handoff, NOW + 10), "handoff tokens are untouched");
  assert.ok(await consumeLoginToken(db, second, NOW + 10));
});

test("issueLoginToken refuses bad input; consume refuses erased students and junk", async () => {
  const db = await setupDb();
  await assert.rejects(issueLoginToken(db, ASHA.id, "admin_link", "https://evil.example/", NOW), /path on this site/);
  await assert.rejects(issueLoginToken(db, ASHA.id, "admin_link", "//evil.example", NOW), /path on this site/);
  await assert.rejects(issueLoginToken(db, ASHA.id, "other", "/account", NOW), /purpose/);
  await assert.rejects(issueLoginToken(db, 3, "admin_link", "/account", NOW), /can't sign in/);
  const token = await issueLoginToken(db, ASHA.id, "admin_link", "/account", NOW);
  db.sqlite.exec("UPDATE students SET erased_at = 1, name = NULL, phone = NULL, email = NULL WHERE id = 1");
  assert.equal(await consumeLoginToken(db, token, NOW), null);
  for (const junk of [null, "", "x".repeat(43) + "y", "../../etc", 42]) assert.equal(await consumeLoginToken(db, junk, NOW), null);
});

test("requireEnrollment: active, expired, revoked, deleted course, other student's course", async () => {
  const db = await setupDb();
  const cookie = await sessionCookie(db, ASHA.id);
  const request = req("/learn/selfmakeup", { cookie });
  const ref = await requireEnrollment(env(db), request, "selfmakeup", NOW);
  assert.equal(ref.studentId, ASHA.id);
  assert.equal(ref.courseId, 1);
  assert.equal(ref.enrollmentId, 1);
  const session = await readSession(env(db), request, NOW);
  assert.equal(ref.sessionTag, session.tokenHash.slice(0, 16));

  assert.equal(await requireEnrollment(env(db), request, "old-class", NOW), null, "expired (1 year passed)");
  assert.equal(await requireEnrollment(env(db), request, "gone-class", NOW), null, "deleted course");
  assert.equal(await requireEnrollment(env(db), request, "diploma", NOW), null, "not enrolled");
  assert.equal(await requireEnrollment(env(db), request, "../x", NOW), null, "bad slug");
  assert.equal(await requireEnrollment(env(db), req("/learn/selfmakeup"), "selfmakeup", NOW), null, "no session");
  assert.equal(await requireEnrollment(env(db), request, "selfmakeup", NOW + 400 * DAY), null, "expires a year after purchase");

  const bina = await sessionCookie(db, 2);
  assert.equal(await requireEnrollment(env(db), req("/", { cookie: bina }), "selfmakeup", NOW), null, "revoked (refunded)");
});

test("requireEnrollment: a test-mode enrollment stops working once payments are live", async () => {
  const db = await setupDb();
  const cookie = await sessionCookie(db, ASHA.id);
  const request = req("/learn/selfmakeup", { cookie });
  assert.ok(await requireEnrollment(env(db, TEST_KEYS), request, "selfmakeup", NOW), "test keys: test enrollment works");
  assert.equal(await requireEnrollment(env(db, LIVE_KEYS), request, "selfmakeup", NOW), null, "live keys: test enrollment refused");
  assert.ok(await requireEnrollment(env(db, LIVE_KEYS), request, "evening-class", NOW), "live keys: live enrollment works");
});
