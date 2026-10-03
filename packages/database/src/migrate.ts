/**
 * Applies the plain SQL migrations in `migrations/` in file name order
 * (architecture section 9.1). Each file runs in its own transaction and is
 * recorded in `schema_migrations` in that same transaction, so a failed
 * migration leaves nothing half applied.
 *
 * Every transaction first takes a transaction-scoped advisory lock and only
 * then checks whether its file is already recorded. Two servers migrating
 * one external PostgreSQL at once therefore apply each file once; on PGlite
 * the lock is uncontended because its transactions already run one at a
 * time, but it is the same statement on both. A transaction-scoped lock is
 * used rather than a session lock because it needs no dedicated connection
 * and cannot be left held by a failure between lock and unlock.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";

/**
 * Arbitrary but fixed: every process that migrates this schema must use the
 * same key. The value spells "idots-mg" in ASCII.
 */
export const MIGRATION_LOCK_KEY = 0x69646f74732d6d67n;

/** The migrations shipped with this package (copied next to the bundle by the server build). */
export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL("./migrations/", import.meta.url));
}

export interface MigrationFile {
  version: string;
  sql: string;
}

const MIGRATION_NAME = /^(\d{4,})_[a-z0-9_]+\.sql$/;

export async function loadMigrations(dir: string = defaultMigrationsDir()): Promise<MigrationFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    throw new Error(`cannot read the migrations directory ${dir}: ${(error as Error).message}`, { cause: error });
  }
  const files = names.filter((name) => name.endsWith(".sql")).sort();
  const out: MigrationFile[] = [];
  for (const name of files) {
    if (!MIGRATION_NAME.test(name)) {
      throw new Error(`migration file "${name}" does not match NNNN_name.sql`);
    }
    out.push({ version: name.replace(/\.sql$/, ""), sql: await readFile(join(dir, name), "utf8") });
  }
  if (out.length === 0) throw new Error(`no migrations found in ${dir}`);
  return out;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function migrate(
  db: Db,
  options: { dir?: string; log?: (line: string) => void } = {},
): Promise<MigrateResult> {
  const migrations = await loadMigrations(options.dir);
  const log = options.log ?? (() => {});
  const result: MigrateResult = { applied: [], alreadyApplied: [] };
  for (const migration of migrations) {
    let applied: boolean;
    try {
      applied = await db.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY.toString()]);
        await tx.exec(
          "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
        );
        const done = await tx.query("SELECT 1 FROM schema_migrations WHERE version = $1", [migration.version]);
        if (done.rows.length > 0) return false;
        await tx.exec(migration.sql);
        await tx.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migration.version]);
        return true;
      });
    } catch (error) {
      throw new Error(`migration ${migration.version} failed: ${(error as Error).message}`, { cause: error });
    }
    if (applied) {
      log(`applied migration ${migration.version}`);
      result.applied.push(migration.version);
    } else {
      result.alreadyApplied.push(migration.version);
    }
  }
  return result;
}
