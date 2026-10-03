/**
 * Test support. Every database suite runs against PGlite always, and also
 * against an external PostgreSQL when DATABASE_URL is set (architecture
 * section 9.1: the suite runs against both adapters). Each test database is
 * a fresh one, so test files can run in parallel without seeing each
 * other's rows.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { Database } from "./database.js";
import type { DbKind } from "./db.js";
import { PGLITE_IN_MEMORY } from "./pglite.js";

/** The adapters this run tests: PGlite, plus PostgreSQL when DATABASE_URL is set. */
export function testAdapters(env: Record<string, string | undefined> = process.env): DbKind[] {
  return env.DATABASE_URL?.trim() ? ["pglite", "pg"] : ["pglite"];
}

export interface TestDatabase {
  db: Database;
  kind: DbKind;
  /** The connection string of the database created for this test (pg only). */
  url?: string;
  drop(): Promise<void>;
}

/**
 * A fresh, migrated database. PGlite is an in-memory instance; on pg it is a
 * new database next to the one DATABASE_URL names, dropped by `drop`.
 */
export async function createTestDatabase(
  kind: DbKind = "pglite",
  env: Record<string, string | undefined> = process.env,
): Promise<TestDatabase> {
  const masterKey = randomBytes(32);
  if (kind === "pglite") {
    const db = await Database.open({ target: { kind: "pglite", dataDir: PGLITE_IN_MEMORY }, masterKey });
    await db.migrate();
    return { db, kind, drop: () => db.close() };
  }
  const { url, drop } = await createScratchPostgres(env);
  try {
    const db = await Database.open({ target: { kind: "pg", url }, masterKey, poolSize: 5 });
    await db.migrate();
    return {
      db,
      kind,
      url,
      async drop() {
        await db.close();
        await drop();
      },
    };
  } catch (error) {
    await drop().catch(() => undefined);
    throw error;
  }
}

/** An empty database on the server DATABASE_URL names, and the way to drop it. */
export async function createScratchPostgres(
  env: Record<string, string | undefined> = process.env,
): Promise<{ url: string; drop(): Promise<void> }> {
  const baseUrl = env.DATABASE_URL?.trim();
  if (!baseUrl) throw new Error("a PostgreSQL test database needs DATABASE_URL");
  const name = `idots_test_${randomBytes(6).toString("hex")}`;
  await adminQuery(baseUrl, `CREATE DATABASE ${name}`);
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: () => adminQuery(baseUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
  };
}

async function adminQuery(url: string, sql: string): Promise<void> {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}
