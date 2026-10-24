/**
 * The `settings` table: typed JSON values (src/shared/types.ts SettingsMap). Every workstream reads
 * and writes settings through these functions, so a key's type is defined once.
 */
import type { SettingKey, SettingsMap } from "../../../src/shared/types.ts";
import type { Db, DbStatement } from "./d1.ts";
import { unixNow } from "./d1.ts";

/** One setting's value, or null when the key has no row (or holds invalid JSON). */
export async function getSetting<K extends SettingKey>(db: Db, key: K): Promise<SettingsMap[K] | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as SettingsMap[K];
  } catch {
    return null;
  }
}

/** Several settings in one query. Missing keys are absent from the result. */
export async function getSettings<K extends SettingKey>(db: Db, keys: readonly K[]): Promise<Partial<Pick<SettingsMap, K>>> {
  if (keys.length === 0) return {};
  const { results } = await db
    .prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => "?").join(", ")})`)
    .bind(...keys)
    .all<{ key: K; value: string }>();
  const out: Partial<Pick<SettingsMap, K>> = {};
  for (const row of results) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      /* skipped: invalid JSON can't be stored (CHECK json_valid), but never throw on read */
    }
  }
  return out;
}

/** An upsert of one setting, to put in a batch. */
export function setSettingStatement<K extends SettingKey>(db: Db, key: K, value: SettingsMap[K], now = unixNow()): DbStatement {
  return db
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(key, JSON.stringify(value), now);
}

/** Writes one setting on its own. */
export async function setSetting<K extends SettingKey>(db: Db, key: K, value: SettingsMap[K], now = unixNow()): Promise<void> {
  await setSettingStatement(db, key, value, now).run();
}

/**
 * content_version + 1 (creates it at 1), to put in the same batch as a content change. Read the
 * new value afterwards with getSetting(db, "content_version").
 */
export function bumpContentVersionStatement(db: Db, now = unixNow()): DbStatement {
  return db
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('content_version', '1', ?) " +
        "ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at",
    )
    .bind(now);
}
