/**
 * The Db interface on each adapter: every PostgreSQL feature the schema and
 * the repositories rely on, checked on PGlite always and on an external
 * PostgreSQL when DATABASE_URL is set, so a difference between the two
 * shows up here rather than in production.
 */
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { permissionBitsEnforced } from "@invisible-dots/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadMigrations,
  migrate,
  openDb,
  PGLITE_IN_MEMORY,
  PgliteDb,
  TransactionMisuseError,
  type Db,
  type DbKind,
  type Executor,
} from "../src/index.js";
import { createScratchPostgres, testAdapters } from "../src/testing.js";

const SETUP_TIMEOUT = 60_000;

/** A fresh, empty database of `kind`, and how to get rid of it. */
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

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe.each(testAdapters())("Db adapter %s", { timeout: SETUP_TIMEOUT }, (kind) => {
  let db: Db;
  let dispose: () => Promise<void>;

  beforeAll(async () => {
    ({ db, dispose } = await emptyDb(kind));
    await db.exec(`
      CREATE TABLE probe (
        id      bigserial PRIMARY KEY,
        name    text NOT NULL UNIQUE,
        doc     jsonb,
        blob    bytea,
        at      timestamptz NOT NULL DEFAULT now(),
        small   integer
      );
      CREATE TABLE claim (id integer PRIMARY KEY, taken boolean NOT NULL DEFAULT false);
      INSERT INTO claim (id) VALUES (1), (2);
    `);
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await dispose?.();
  }, SETUP_TIMEOUT);

  it("reports its kind", () => {
    expect(db.kind).toBe(kind);
  });

  it("round-trips jsonb, bytea, bigserial and timestamptz with the same JavaScript types", async () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255]);
    const doc = { nested: { list: [1, "two", null], flag: true }, text: "caf\u00e9 \u{1F600}" };
    const when = new Date("2031-02-03T04:05:06.789Z");
    const inserted = await db.query<{ id: number; doc: unknown; blob: Uint8Array; at: Date }>(
      "INSERT INTO probe (name, doc, blob, at) VALUES ($1, $2, $3, $4) RETURNING *",
      ["types", JSON.stringify(doc), Buffer.from(bytes), when],
    );
    const row = inserted.rows[0]!;
    expect(typeof row.id).toBe("number");
    expect(row.id).toBeGreaterThan(0);
    expect(row.doc).toEqual(doc);
    expect(row.blob).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(row.blob).equals(Buffer.from(bytes))).toBe(true);
    expect(row.at).toBeInstanceOf(Date);
    expect(row.at.toISOString()).toBe(when.toISOString());

    const next = await db.query<{ id: number }>("INSERT INTO probe (name) VALUES ('types-2') RETURNING id");
    expect(next.rows[0]!.id).toBe(row.id + 1);
  });

  it("parses int8 as a number and refuses one beyond 2^53", async () => {
    const count = await db.query<{ n: unknown }>("SELECT count(*) AS n FROM claim");
    expect(count.rows[0]!.n).toBe(2);
    await expect(db.query("SELECT 9007199254740993::bigint AS big")).rejects.toThrow(RangeError);
  });

  it("binds arrays, nulls and booleans the same way", async () => {
    const { rows } = await db.query<{ arr: string[]; is_null: boolean; flag: boolean; hit: boolean }>(
      "SELECT $1::text[] AS arr, $2::text IS NULL AS is_null, $3::boolean AS flag, 'b' = ANY($1::text[]) AS hit",
      [["a", "b"], null, true],
    );
    expect(rows[0]).toEqual({ arr: ["a", "b"], is_null: true, flag: true, hit: true });
  });

  it("reports rowCount from the command tag", async () => {
    await db.exec("CREATE TABLE counted (n integer)");
    expect((await db.query("INSERT INTO counted VALUES (1), (2), (3)")).rowCount).toBe(3);
    expect((await db.query("UPDATE counted SET n = n + 1 WHERE n > 1")).rowCount).toBe(2);
    expect((await db.query("SELECT * FROM counted")).rowCount).toBe(3);
    expect((await db.query("DELETE FROM counted WHERE n > 100")).rowCount).toBe(0);
    expect((await db.query("DELETE FROM counted RETURNING n")).rowCount).toBe(3);
  });

  it("query takes one statement; exec runs a script", async () => {
    await expect(db.query("SELECT 1; SELECT 2")).rejects.toThrow();
    await db.exec("CREATE TABLE script_a (x int); CREATE TABLE script_b (y int);");
    const { rows } = await db.query<{ a: string | null; b: string | null }>(
      "SELECT to_regclass('script_a')::text AS a, to_regclass('script_b')::text AS b",
    );
    expect(rows[0]).toEqual({ a: "script_a", b: "script_b" });
  });

  it("reports a unique violation with its SQLSTATE and constraint name", async () => {
    await db.query("INSERT INTO probe (name) VALUES ('dup')");
    const error = await db.query("INSERT INTO probe (name) VALUES ('dup')").then(
      () => null,
      (e: { code?: string; constraint?: string }) => e,
    );
    expect(error?.code).toBe("23505");
    expect(error?.constraint).toBe("probe_name_key");
  });

  it("commits a transaction that resolves and rolls back one that throws", async () => {
    const value = await db.transaction(async (tx) => {
      await tx.query("INSERT INTO probe (name) VALUES ('committed')");
      return 7;
    });
    expect(value).toBe(7);
    await expect(
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO probe (name) VALUES ('rolled-back')");
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    const { rows } = await db.query<{ name: string }>(
      "SELECT name FROM probe WHERE name IN ('committed', 'rolled-back') ORDER BY name",
    );
    expect(rows.map((r) => r.name)).toEqual(["committed"]);
  });

  it("refuses the outer handle inside a transaction and the transaction handle after it", async () => {
    let leaked: Executor | undefined;
    await expect(
      db.transaction(async (tx) => {
        leaked = tx;
        await db.query("SELECT 1");
      }),
    ).rejects.toBeInstanceOf(TransactionMisuseError);
    await expect(db.transaction(async () => db.transaction(async () => 1))).rejects.toBeInstanceOf(
      TransactionMisuseError,
    );
    await expect(leaked!.query("SELECT 1")).rejects.toBeInstanceOf(TransactionMisuseError);
    // The database is still usable afterwards.
    expect((await db.query<{ one: number }>("SELECT 1 AS one")).rows[0]!.one).toBe(1);
  });

  it("other work never sees a transaction's uncommitted rows", async () => {
    const inside = deferred();
    const release = deferred();
    const tx = db.transaction(async (t) => {
      await t.query("INSERT INTO probe (name) VALUES ('pending-row')");
      inside.resolve();
      await release.promise;
    });
    await inside.promise;
    // On pg this runs at once on another connection; on PGlite it waits for the transaction.
    const outside = db.query<{ n: number }>("SELECT count(*) AS n FROM probe WHERE name = 'pending-row'");
    const raced = await Promise.race([outside.then((r) => r.rows[0]!.n), new Promise((r) => setTimeout(() => r("waiting"), 200))]);
    expect(raced).toBe(kind === "pg" ? 0 : "waiting");
    release.resolve();
    await tx;
    expect((await outside).rows[0]!.n).toBe(kind === "pg" ? 0 : 1);
  });

  it("accepts FOR UPDATE SKIP LOCKED and transaction-scoped advisory locks", async () => {
    const claimed = await db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", ["7593125790409010535"]);
      const { rows } = await tx.query<{ id: number }>("SELECT id FROM claim WHERE NOT taken ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED");
      await tx.query("UPDATE claim SET taken = true WHERE id = $1", [rows[0]!.id]);
      return rows[0]!.id;
    });
    expect(claimed).toBe(1);
    await db.query("UPDATE claim SET taken = false");
  });

  if (kind === "pg") {
    it("pg: a second transaction skips the rows and the advisory lock the first one holds", async () => {
      const locked = deferred();
      const release = deferred();
      const first = db.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(42)");
        await tx.query("SELECT id FROM claim WHERE id = 1 FOR UPDATE");
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      const second = await db.transaction(async (tx) => {
        const lock = await tx.query<{ got: boolean }>("SELECT pg_try_advisory_xact_lock(42) AS got");
        const rows = await tx.query<{ id: number }>("SELECT id FROM claim ORDER BY id FOR UPDATE SKIP LOCKED");
        return { got: lock.rows[0]!.got, ids: rows.rows.map((r) => r.id) };
      });
      release.resolve();
      await first;
      expect(second).toEqual({ got: false, ids: [2] });
    });
  } else {
    it("pglite: transactions run one at a time, so a claim never meets a competitor", async () => {
      const order: string[] = [];
      const release = deferred();
      const entered = deferred();
      const first = db.transaction(async () => {
        order.push("first-begin");
        entered.resolve();
        await release.promise;
        order.push("first-end");
      });
      await entered.promise;
      const second = db.transaction(async () => {
        order.push("second");
      });
      await new Promise((r) => setTimeout(r, 100));
      expect(order).toEqual(["first-begin"]);
      release.resolve();
      await Promise.all([first, second]);
      expect(order).toEqual(["first-begin", "first-end", "second"]);
    });
  }

  it("refuses work after close", async () => {
    const extra = await emptyDb(kind);
    await extra.db.close();
    await extra.db.close();
    await expect(extra.db.query("SELECT 1")).rejects.toThrow(/closed/);
    await extra.dispose();
  });
});

describe.each(testAdapters())("migrate on %s", { timeout: SETUP_TIMEOUT }, (kind) => {
  it("two concurrent runs on a fresh database apply each file once", async () => {
    const versions = (await loadMigrations()).map((m) => m.version);
    if (kind === "pglite") {
      const db = await PgliteDb.open(PGLITE_IN_MEMORY);
      try {
        const results = await Promise.all([migrate(db), migrate(db)]);
        expect(results.flatMap((r) => r.applied).sort()).toEqual(versions);
        expect(results.flatMap((r) => r.alreadyApplied).sort()).toEqual(versions);
      } finally {
        await db.close();
      }
      return;
    }
    // Two pools, as two servers would have: the advisory lock is what serializes them.
    const scratch = await createScratchPostgres();
    const dbs = [
      await openDb({ kind: "pg", url: scratch.url }),
      await openDb({ kind: "pg", url: scratch.url }),
    ];
    try {
      const results = await Promise.all(dbs.map((d) => migrate(d)));
      expect(results.flatMap((r) => r.applied).sort()).toEqual(versions);
    } finally {
      await Promise.all(dbs.map((d) => d.close()));
      await scratch.drop();
    }
  });

  it("a failing migration is rolled back and named in the error", async () => {
    const { db, dispose } = await emptyDb(kind);
    const dir = await mkdtemp(join(tmpdir(), "idots-mig-"));
    try {
      await writeFile(join(dir, "0001_first.sql"), "CREATE TABLE first_table (a int);");
      await writeFile(join(dir, "0002_broken.sql"), "CREATE TABLE zz_partial (a int); SELECT nope FROM nowhere;");
      await expect(migrate(db, { dir })).rejects.toThrow(/migration 0002_broken failed/);
      const { rows } = await db.query<{ first: string | null; partial: string | null; versions: string[] }>(
        `SELECT to_regclass('first_table')::text AS first, to_regclass('zz_partial')::text AS partial,
                (SELECT array_agg(version ORDER BY version) FROM schema_migrations) AS versions`,
      );
      expect(rows[0]).toEqual({ first: "first_table", partial: null, versions: ["0001_first"] });
    } finally {
      await rm(dir, { recursive: true, force: true });
      await dispose();
    }
  });
});

describe("PGlite on disk", { timeout: SETUP_TIMEOUT }, () => {
  it("creates its data directory on first use and keeps the data across a reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "idots-pglite-"));
    const dataDir = join(root, "home", "db");
    try {
      const first = await PgliteDb.open(dataDir);
      try {
        await migrate(first);
        await first.query(
          "INSERT INTO dots (id, name, config, status) VALUES ('dot_disk', 'disk', $1, 'READY')",
          [JSON.stringify({ name: "disk" })],
        );
      } finally {
        await first.close();
      }
      if (permissionBitsEnforced()) {
        expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
      }
      const second = await PgliteDb.open(dataDir);
      try {
        expect((await migrate(second)).applied).toEqual([]);
        const { rows } = await second.query<{ config: unknown }>("SELECT config FROM dots WHERE id = 'dot_disk'");
        expect(rows[0]?.config).toEqual({ name: "disk" });
      } finally {
        await second.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
