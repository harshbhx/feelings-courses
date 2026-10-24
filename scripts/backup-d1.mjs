// An offline copy of the database on this computer (W7, docs/ops/BACKUPS.md, layer 3):
//
//   node scripts/backup-d1.mjs                 production (fbc-courses) → backups/fbc-courses-<time>.sql
//   node scripts/backup-d1.mjs --preview       the preview database
//   node scripts/backup-d1.mjs --db <name> --out <dir>
//
// Runs Cloudflare's own `wrangler d1 export --remote` (schema and data, the format
// `wrangler d1 execute --file` restores), then prints the file's size and SHA-256 so a copy can be
// checked later. Needs `npx wrangler login` once. Read-only on Cloudflare's side.
//
// backups/ is gitignored: the file holds students' names, emails and phone numbers. Keep it private.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const value = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

const db = value("--db") ?? (args.includes("--preview") ? "fbc-courses-preview" : "fbc-courses");
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(db)) {
  console.error(`backup-d1: "${db}" is not a database name.`);
  process.exit(1);
}
const outDir = path.resolve(root, value("--out") ?? "backups");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
const file = path.join(outDir, `${db}-${stamp}.sql`);

console.log(`backup-d1: exporting ${db} (remote) to ${path.relative(root, file)} …`);
const run = spawnSync("npx", ["--yes", "wrangler", "d1", "export", db, "--remote", "--output", file], { cwd: root, stdio: "inherit" });
if (run.status !== 0) {
  console.error("backup-d1: wrangler failed (logged in? `npx wrangler login`).");
  process.exit(run.status ?? 1);
}

const bytes = readFileSync(file);
const sha = createHash("sha256").update(bytes).digest("hex");
const tables = (bytes.toString("utf8").match(/^CREATE TABLE/gm) ?? []).length;
console.log(`backup-d1: ${(statSync(file).size / 1024).toFixed(1)} KB, ${tables} tables, sha256 ${sha}`);
console.log("Restore (into a NEW database first, then check it): docs/ops/BACKUPS.md");
