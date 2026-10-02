/**
 * Test support: a throwaway database per test file, so files can run in
 * parallel against one PostgreSQL server without seeing each other's rows.
 */
import { randomBytes } from "node:crypto";
import { writeSync } from "node:fs";
import pg from "pg";
import { Database } from "./database.js";

export const TEST_DATABASE_URL = process.env.DATABASE_URL;

/**
 * Print a banner that is hard to miss when the PostgreSQL tests are going to
 * be skipped, so a green run without a database is never mistaken for a
 * full one.
 */
export function warnIfNoDatabase(suite: string): boolean {
  if (TEST_DATABASE_URL) return false;
  const line = "*".repeat(78);
  // Straight to file descriptor 2: the test runner buffers console output of
  // files whose tests are all skipped, and this banner must always show.
  writeSync(
    2,
    `\n${line}\n*** DATABASE_URL is not set: SKIPPING the PostgreSQL tests of ${suite}.\n` +
      `*** Start one with: docker run -d --rm -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:18\n` +
      `*** and set DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres\n${line}\n`,
  );
  return true;
}

export interface TestDatabase {
  db: Database;
  url: string;
  drop(): Promise<void>;
}

/** A fresh, migrated database next to the one DATABASE_URL names. */
export async function createTestDatabase(baseUrl: string = TEST_DATABASE_URL ?? ""): Promise<TestDatabase> {
  if (!baseUrl) throw new Error("createTestDatabase needs DATABASE_URL");
  const name = `idots_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const db = Database.connect({ connectionString: url.toString(), masterKey: randomBytes(32), max: 5 });
  await db.migrate();
  return {
    db,
    url: url.toString(),
    async drop() {
      await db.close();
      const cleanup = new pg.Client({ connectionString: baseUrl });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
