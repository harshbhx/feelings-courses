// Fetches the content snapshot for the build (plan 1.1), before `astro build`:
//
//   node scripts/snapshot.mjs
//
// | Situation                                              | Result                                   |
// |--------------------------------------------------------|------------------------------------------|
// | SNAPSHOT_SOURCE=seed                                   | seed (from src/data/course.ts)            |
// | SNAPSHOT_URL set                                       | fetch it; anything but a valid snapshot   |
// |                                                        | fails the build                           |
// | CF_PAGES_BRANCH=main, endpoint answers 200 + snapshot  | use it                                    |
// | ... answers 404, or 200 that isn't JSON (the live      | seed, with a warning (first deploy: the   |
// |     deployment predates the endpoint)                  | endpoint doesn't exist yet)               |
// | ... answers 5xx, is unreachable, or sends bad JSON     | FAIL the build: the previous deployment   |
// |                                                        | stays live, a site missing courses never  |
// |                                                        | ships                                     |
// | preview branches, local builds                         | seed                                      |
//
// "Seed" means src/generated/snapshot.json is removed and src/data/snapshot.ts falls back to the
// seed snapshot (src/data/seed-snapshot.ts). A fetched snapshot is written there with its source.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
export const OUT_FILE = path.join(root, "src", "generated", "snapshot.json");
const DEFAULT_HUB = "courses.feelingsbeautycare.in";
const TIMEOUT_MS = 15_000;

class SnapshotError extends Error {}

/** A minimal shape check: enough to refuse an error page or a truncated body. */
export function isSnapshot(value) {
  return (
    !!value &&
    typeof value === "object" &&
    Number.isInteger(value.contentVersion) &&
    Number.isInteger(value.generatedAt) &&
    Array.isArray(value.courses) &&
    value.courses.every((c) => c && typeof c.slug === "string" && typeof c.title === "string" && Array.isArray(c.modules)) &&
    !!value.settings &&
    typeof value.settings === "object"
  );
}

async function fetchOnce(url, fetchImpl) {
  return fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/**
 * Decides where the snapshot comes from. Returns { source: "seed" | "live" | "url", snapshot?,
 * warning? } or throws SnapshotError (fail the build).
 */
export async function resolveSnapshot({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (env.SNAPSHOT_SOURCE === "seed") return { source: "seed" };

  const explicit = env.SNAPSHOT_URL?.trim();
  const onMain = env.CF_PAGES_BRANCH === "main";
  if (!explicit && !onMain) return { source: "seed" };

  const url = explicit || `https://${env.HUB_HOST?.trim() || DEFAULT_HUB}/api/public/snapshot`;
  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetchOnce(url, fetchImpl);
      if (res.status < 500 || attempt === 2) break;
    } catch (err) {
      if (attempt === 2) throw new SnapshotError(`snapshot: ${url} is unreachable (${err?.message ?? err}).`);
    }
  }

  const type = res.headers.get("Content-Type") ?? "";
  if (!explicit && (res.status === 404 || (res.status === 200 && !type.includes("application/json")))) {
    return {
      source: "seed",
      warning: `snapshot: ${url} answered ${res.status}${res.status === 200 ? ` (${type || "no content type"})` : ""}; the endpoint isn't live yet, so the seed is used.`,
    };
  }
  if (res.status !== 200) throw new SnapshotError(`snapshot: ${url} answered ${res.status}. Not building with missing content.`);

  let body;
  try {
    body = await res.json();
  } catch {
    throw new SnapshotError(`snapshot: ${url} sent a body that isn't JSON.`);
  }
  if (!isSnapshot(body)) throw new SnapshotError(`snapshot: ${url} sent JSON that isn't a snapshot.`);
  return { source: explicit ? "url" : "live", snapshot: body };
}

/** Writes or removes src/generated/snapshot.json for the result. */
export function writeResult(result, file = OUT_FILE) {
  if (result.source === "seed") {
    if (existsSync(file)) rmSync(file);
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ source: result.source, snapshot: result.snapshot }) + "\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const result = await resolveSnapshot();
    if (result.warning) console.warn(`WARNING ${result.warning}`);
    writeResult(result);
    const count = result.snapshot ? `${result.snapshot.courses.length} course(s), version ${result.snapshot.contentVersion}` : "src/data/course.ts";
    console.log(`snapshot: ${result.source} (${count})`);
  } catch (err) {
    console.error(err instanceof SnapshotError ? err.message : `snapshot: ${err?.stack ?? err}`);
    process.exit(1);
  }
}
