/**
 * The adapter for an external PostgreSQL 16 or newer, used when DATABASE_URL
 * is set (architecture section 9.1). It is configured to return the same
 * JavaScript types as the PGlite adapter and to refuse the same things, so
 * code that passes against one passes against the other.
 */
import pg from "pg";
import { DbBase, INT8_OID, parseInt8, type Executor, type Queryable, type QueryResult } from "./db.js";

export const DEFAULT_POOL_SIZE = 10;

const typeParsers = {
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    oid === INT8_OID && format !== "binary" ? parseInt8 : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
};

/**
 * The connection string with its password replaced, for messages and logs:
 * DATABASE_URL usually carries a password.
 */
export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "<unparseable DATABASE_URL>";
  }
}

/**
 * Always the extended protocol, even without parameters: it accepts one
 * statement per call, as PGlite's query does, so a multi-statement string
 * that would pass here and fail on PGlite fails on both. Scripts go
 * through exec. `queryMode` is a node-postgres option its type definitions
 * do not list yet.
 */
function statement(sql: string, params: readonly unknown[]): pg.QueryConfig {
  return { text: sql, values: [...params], queryMode: "extended" } as pg.QueryConfig;
}

function toResult<R>(result: pg.QueryResult): QueryResult<R> {
  return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
}

function executor(client: pg.ClientBase): Executor {
  return {
    query: async <R>(sql: string, params: readonly unknown[] = []) => toResult<R>(await client.query(statement(sql, params))),
    exec: async (sql) => {
      // Without values node-postgres uses the simple protocol, which runs several statements.
      await client.query(sql);
    },
  };
}

export class PostgresDb extends DbBase {
  readonly kind = "pg" as const;

  /** The connection that holds session locks; opened on first use, ended by close. */
  #session: pg.Client | undefined;

  private constructor(
    private readonly pool: pg.Pool,
    private readonly connectionString: string,
  ) {
    super();
  }

  /** Connects and checks the server answers, failing with a message that names it (without its password). */
  static async open(connectionString: string, options: { poolSize?: number } = {}): Promise<PostgresDb> {
    const pool = new pg.Pool({ connectionString, max: options.poolSize ?? DEFAULT_POOL_SIZE, types: typeParsers });
    // An idle client that loses its server (PostgreSQL restarted) emits here;
    // without a listener the whole process would crash on it.
    pool.on("error", (error) => {
      console.error(`[database] idle PostgreSQL client error: ${error.message}`);
    });
    try {
      await pool.query("SELECT 1");
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw new Error(`cannot connect to PostgreSQL at ${redactDatabaseUrl(connectionString)}: ${(error as Error).message}`, {
        cause: error,
      });
    }
    return new PostgresDb(pool, connectionString);
  }

  protected async rawQuery(sql: string, params: readonly unknown[]): Promise<QueryResult> {
    return toResult(await this.pool.query(statement(sql, params)));
  }

  protected async rawExec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  protected async rawTransaction<T>(fn: (raw: Executor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    // A client whose ROLLBACK failed may still be inside the transaction: it
    // is destroyed rather than handed to the next caller.
    let broken: Error | undefined;
    try {
      await client.query("BEGIN");
      const result = await fn(executor(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch((rollbackError: Error) => {
        broken = rollbackError;
      });
      throw error;
    } finally {
      client.release(broken);
    }
  }

  protected async rawSessionConnection(): Promise<Queryable> {
    if (!this.#session) {
      const client = new pg.Client({ connectionString: this.connectionString, types: typeParsers });
      // A lost session connection loses its locks; the error is reported rather than crashing the process.
      client.on("error", (error) => {
        console.error(`[database] the session connection was lost: ${error.message}`);
      });
      await client.connect();
      this.#session = client;
    }
    return executor(this.#session);
  }

  protected async rawClose(): Promise<void> {
    await this.#session?.end().catch(() => undefined);
    await this.pool.end();
  }
}
