// Reads migrations/NNNN_name.sql and splits each file into statements. Shared by
// scripts/embed-migrations.mjs (build) and tests/helpers/d1.mjs (tests), so the runtime and the
// tests apply exactly the same statements.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "..", "..", "migrations");
const NAME_RE = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * Splits SQL into statements on semicolons outside strings, quoted identifiers and comments.
 * Comments are dropped. Triggers (BEGIN … END) are refused: their inner semicolons would need
 * wrangler's own rules, and the schema doesn't use them.
 */
export function splitSql(sql) {
  const statements = [];
  let current = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) throw new Error("splitSql: unterminated /* comment");
      i = end + 2;
      current += " ";
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new Error(`splitSql: unterminated ${c} quote`);
        if (sql[j] === close) {
          if (close !== "]" && sql[j + 1] === close) {
            j += 2; // doubled quote inside the string
            continue;
          }
          break;
        }
        j++;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === ";") {
      push();
      i++;
      continue;
    }
    current += c;
    i++;
  }
  push();
  return statements;

  function push() {
    const text = current
      .split("\n")
      .map((line) => line.replace(/\s+$/, ""))
      .filter((line) => line.trim() !== "")
      .join("\n")
      .trim();
    current = "";
    if (!text) return;
    if (/^CREATE\s+(?:TEMP\w*\s+)?TRIGGER\b/i.test(text)) {
      throw new Error("splitSql: triggers are not supported in migrations");
    }
    statements.push(text);
  }
}

/** Every migration file, in name order: [{ name: "0001_init.sql", statements: [...] }]. */
export function loadMigrations(dir = MIGRATIONS_DIR) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (!NAME_RE.test(file)) throw new Error(`migrations/${file}: name must look like 0003_add_thing.sql`);
  }
  return files.map((name) => {
    const statements = splitSql(readFileSync(path.join(dir, name), "utf8"));
    if (statements.length === 0) throw new Error(`migrations/${name} has no statements`);
    return { name, statements };
  });
}
