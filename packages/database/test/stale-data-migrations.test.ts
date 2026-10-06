/**
 * The migrations that clean up data written before a rule existed: secrets of Dots that were
 * deleted, and stored Dot configs that name a model role or a permission the schema has since
 * removed. Each runs on a database that already holds the old data, on PGlite always and on an
 * external PostgreSQL when DATABASE_URL is set.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRuntimeConfig, toRuntimeConfig, parseDotConfig } from "@invisible-dots/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, migrate, openDb, PGLITE_IN_MEMORY, PgliteDb, type Db, type DbKind } from "../src/index.js";
import { createScratchPostgres, testAdapters } from "../src/testing.js";

const SETUP_TIMEOUT = 60_000;
const ORPHANED_SECRETS = "0005_orphaned_secrets";
const REMOVED_CONFIG_NAMES = "0006_removed_config_names";

async function emptyDb(kind: DbKind): Promise<{ db: Db; dispose(): Promise<void> }> {
  if (kind === "pglite") {
    const db = await PgliteDb.open(PGLITE_IN_MEMORY);
    return { db, dispose: () => db.close() };
  }
  const scratch = await createScratchPostgres();
  const db = await openDb({ kind: "pg", url: scratch.url }, { poolSize: 4 });
  return {
    db,
    async dispose() {
      await db.close();
      await scratch.drop();
    },
  };
}

/** Migrate `db` with every migration that comes before `version`: the database as it was then. */
async function migrateBefore(db: Db, version: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "idots-stale-"));
  try {
    for (const file of await loadMigrations()) {
      if (file.version < version) await writeFile(join(dir, `${file.version}.sql`), file.sql);
    }
    await migrate(db, { dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const config = (extra: Record<string, unknown>) => ({
  name: "old-dot",
  goal: "a Dot stored before the change",
  model: { provider: "openrouter", id: "test/model" },
  ...extra,
});

async function insertDot(db: Db, id: string, name: string, stored: unknown): Promise<void> {
  await db.query("INSERT INTO dots (id, name, config, status) VALUES ($1, $2, $3::jsonb, 'READY')", [
    id,
    name,
    JSON.stringify({ ...(stored as object), name }),
  ]);
}

async function storedConfig(db: Db, id: string): Promise<Record<string, any>> {
  const { rows } = await db.query<{ config: Record<string, any> }>("SELECT config FROM dots WHERE id = $1", [id]);
  return rows[0]!.config;
}

describe.each(testAdapters())("migrations that clean up old data on %s", { timeout: SETUP_TIMEOUT }, (kind) => {
  let db: Db;
  let dispose: () => Promise<void>;

  beforeAll(async () => {
    ({ db, dispose } = await emptyDb(kind));
    await migrateBefore(db, ORPHANED_SECRETS);
    // Dots as they were stored before the schema closed its lists.
    await insertDot(db, "dot_old", "old-dot", config({
      models: { fast: "test/fast", summary: "test/small", decide: "test/big" },
      permissions: { "web.fetch": "allow", "files.write": "deny", subagents: "ask", "message.send": "ask", "memory.write": "allow" },
    }));
    await insertDot(db, "dot_roles_only", "roles-only", config({ models: { fast: "test/fast" } }));
    await insertDot(db, "dot_clean", "clean-dot", config({ models: { summary: "test/small" }, permissions: { "computer.exec": "ask" } }));
    await insertDot(db, "dot_bare", "bare-dot", config({}));
    for (const [scope, name] of [
      ["global", "openrouter_api_key"],
      ["dot_old", "openrouter_api_key"],
      ["dot_gone", "openrouter_api_key"],
      ["dot_gone_too", "telegram_token"],
    ] as const) {
      await db.query("INSERT INTO secrets (scope, name, value_enc) VALUES ($1, $2, $3)", [scope, name, Buffer.from("sealed")]);
    }
    await migrate(db);
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await dispose?.();
  }, SETUP_TIMEOUT);

  it("deletes the secrets of Dots that no longer exist and keeps the global one and a live Dot's", async () => {
    const { rows } = await db.query<{ scope: string; name: string }>("SELECT scope, name FROM secrets ORDER BY scope, name");
    expect(rows).toEqual([
      { scope: "dot_old", name: "openrouter_api_key" },
      { scope: "global", name: "openrouter_api_key" },
    ]);
  });

  it("removes the model roles the schema no longer knows and keeps summary", async () => {
    expect((await storedConfig(db, "dot_old")).models).toEqual({ summary: "test/small" });
    expect((await storedConfig(db, "dot_roles_only")).models).toEqual({});
  });

  it("removes the five permission names that were deleted and keeps every other", async () => {
    expect((await storedConfig(db, "dot_old")).permissions).toEqual({ "files.write": "deny" });
  });

  it("leaves a config that names nothing removed, and one without those sections, as it was", async () => {
    expect(await storedConfig(db, "dot_clean")).toEqual({
      ...config({ models: { summary: "test/small" }, permissions: { "computer.exec": "ask" } }),
      name: "clean-dot",
    });
    expect(await storedConfig(db, "dot_bare")).toEqual({ ...config({}), name: "bare-dot" });
  });

  it("makes a config stored before the change one the schema and the engine's config accept", async () => {
    for (const id of ["dot_old", "dot_roles_only", "dot_clean", "dot_bare"]) {
      const stored = await storedConfig(db, id);
      expect(() => parseDotConfig(stored), id).not.toThrow();
      const { computer: _computer, ...runtime } = toRuntimeConfig(parseDotConfig(stored)) as Record<string, unknown>;
      expect(() => parseRuntimeConfig(runtime), id).not.toThrow();
    }
  });

  it("runs once: a second migrate applies nothing", async () => {
    const again = await migrate(db);
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toEqual(expect.arrayContaining([ORPHANED_SECRETS, REMOVED_CONFIG_NAMES]));
  });
});
