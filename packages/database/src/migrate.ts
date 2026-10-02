/**
 * Applies the plain SQL migrations in `migrations/` in file name order. Each
 * file runs in its own transaction and is recorded in `schema_migrations`, so
 * a failed migration leaves nothing half applied. A session advisory lock
 * keeps two servers starting at once from applying the same file twice.
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

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
    out.push({ version: name.replace(/\.sql$/, ""), sql: await readFile(`${dir.replace(/[\\/]+$/, "")}/${name}`, "utf8") });
  }
  if (out.length === 0) throw new Error(`no migrations found in ${dir}`);
  return out;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function migrate(
  pool: Pool,
  options: { dir?: string; log?: (line: string) => void } = {},
): Promise<MigrateResult> {
  const migrations = await loadMigrations(options.dir);
  const log = options.log ?? (() => {});
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY.toString()]);
    try {
      await client.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const done = new Set(
        (await client.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version),
      );
      const result: MigrateResult = { applied: [], alreadyApplied: [] };
      for (const migration of migrations) {
        if (done.has(migration.version)) {
          result.alreadyApplied.push(migration.version);
          continue;
        }
        await client.query("BEGIN");
        try {
          await client.query(migration.sql);
          await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migration.version]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw new Error(`migration ${migration.version} failed: ${(error as Error).message}`, { cause: error });
        }
        log(`applied migration ${migration.version}`);
        result.applied.push(migration.version);
      }
      return result;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY.toString()]);
    }
  } finally {
    client.release();
  }
}
