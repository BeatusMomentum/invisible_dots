/**
 * The default adapter: PGlite, a single-user PostgreSQL in WebAssembly that
 * runs inside the server process with its data in INVISIBLE_DOTS_HOME/db
 * (architecture sections 3.2 and 9.1), so a host needs nothing installed.
 *
 * PGlite has one connection. A transaction holds it until it ends, and any
 * other statement waits its turn, so transactions are serialized rather than
 * concurrent: FOR UPDATE SKIP LOCKED is accepted and correct, but it never
 * has another transaction's lock to skip.
 *
 * PGlite does not lock its data directory against a second process. The
 * server's own lock on INVISIBLE_DOTS_HOME (apps/api) is what keeps a second
 * server from opening the same directory; anything else that opens it must
 * hold that lock too.
 */
import { PGlite } from "@electric-sql/pglite";
import { ensurePrivateDir } from "@invisible-dots/shared";
import { DbBase, INT8_OID, parseInt8, type Executor, type Queryable, type QueryResult } from "./db.js";

/** A data directory value that keeps the database in memory (tests). */
export const PGLITE_IN_MEMORY = "memory://";

type PgliteResult = { rows: unknown[]; rowCount?: number; affectedRows?: number };

function toResult<R>(result: PgliteResult): QueryResult<R> {
  // rowCount comes from the command tag, which is what node-postgres reports too.
  return { rows: result.rows as R[], rowCount: result.rowCount ?? result.affectedRows ?? result.rows.length };
}

export class PgliteDb extends DbBase {
  readonly kind = "pglite" as const;

  private constructor(
    private readonly pg: PGlite,
    /** The data directory, or PGLITE_IN_MEMORY. */
    readonly dataDir: string,
  ) {
    super();
  }

  /**
   * Opens the database in `dataDir`, creating the directory (mode 0700: the
   * database holds the encrypted secrets and every Dot's configuration) and
   * initializing a cluster in it on first use.
   */
  static async open(dataDir: string): Promise<PgliteDb> {
    if (dataDir !== PGLITE_IN_MEMORY) await ensurePrivateDir(dataDir);
    let pg: PGlite;
    try {
      pg = await PGlite.create(dataDir, { parsers: { [INT8_OID]: parseInt8 } });
    } catch (error) {
      throw new Error(`cannot open the embedded PostgreSQL in ${dataDir}: ${(error as Error).message}`, { cause: error });
    }
    return new PgliteDb(pg, dataDir);
  }

  protected async rawQuery(sql: string, params: readonly unknown[]): Promise<QueryResult> {
    return toResult(await this.pg.query(sql, [...params]));
  }

  protected async rawExec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  protected rawTransaction<T>(fn: (raw: Executor) => Promise<T>): Promise<T> {
    return this.pg.transaction((tx) =>
      fn({
        query: async <R>(sql: string, params: readonly unknown[] = []) => toResult<R>(await tx.query(sql, [...params])),
        exec: async (sql) => {
          await tx.exec(sql);
        },
      }),
    );
  }

  /** PGlite's one connection lives as long as the instance, so it holds a session lock until close. */
  protected async rawSessionConnection(): Promise<Queryable> {
    return { query: async <R>(sql: string, params: readonly unknown[] = []) => toResult<R>(await this.pg.query(sql, [...params])) };
  }

  protected async rawClose(): Promise<void> {
    await this.pg.close();
  }
}
