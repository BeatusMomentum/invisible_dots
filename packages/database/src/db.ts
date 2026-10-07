/**
 * The one interface the repositories talk to (architecture section 9.1). Two
 * adapters implement it: PGlite, PostgreSQL compiled to WebAssembly and run
 * inside this process (the default), and node-postgres against an external
 * server (when DATABASE_URL is set). The SQL is the same for both; this file
 * holds what has to behave the same on both and is not SQL: how a 64-bit
 * integer comes back, and what happens when a transaction is misused.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type DbKind = "pglite" | "pg";

/**
 * A result row; the repositories narrow it to their own row interfaces.
 * `any` rather than `unknown` because an interface without an index
 * signature is assignable only to the former.
 */
export type Row = { [column: string]: any };

export interface QueryResult<R = Row> {
  rows: R[];
  /** Rows returned by a SELECT, or changed by an INSERT, UPDATE or DELETE. */
  rowCount: number;
}

/** What a repository needs: one parameterized statement at a time. */
export interface Queryable {
  query<R = Row>(sql: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
}

/** A Queryable that can also run a script of several statements (a migration file). */
export interface Executor extends Queryable {
  /** Runs `sql`, which may hold several statements and takes no parameters. */
  exec(sql: string): Promise<void>;
}

export interface Db extends Executor {
  readonly kind: DbKind;
  /**
   * Runs `fn` in one transaction: it commits when `fn` resolves and rolls
   * back when it throws. Every statement of the transaction must go through
   * `tx`; using this handle instead from inside `fn` throws (see
   * TransactionMisuseError).
   */
  transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T>;
  /**
   * Take the session-level advisory lock `key` for as long as this handle
   * stays open: true when this handle now holds it, false when another
   * session does. The same statement on both adapters; on an external
   * PostgreSQL it runs on a connection of its own that lives until `close`,
   * because a pooled connection would hand the lock back to the pool.
   */
  holdSessionLock(key: bigint): Promise<boolean>;
  /** Closes the connection or pool; later calls fail. Calling it twice is harmless. */
  close(): Promise<void>;
}

/** Object id of int8 / bigint in pg_type. */
export const INT8_OID = 20;

/**
 * The one int8 parser of both adapters. node-postgres returns int8 as a
 * string and PGlite as a number or a BigInt depending on its size, so without
 * this the same row would have different JavaScript types per adapter. Every
 * int8 here (event ids, guest sequence numbers, counts) stays far below 2^53;
 * a value above it is refused instead of being rounded silently.
 */
export function parseInt8(text: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`the bigint value ${text} is outside the range a JavaScript number holds exactly`);
  }
  return value;
}

/**
 * A statement on the Db handle from inside that Db's own transaction. On
 * PGlite, which has one connection, it would wait forever for the
 * transaction it is part of; on PostgreSQL it would silently run outside the
 * transaction. Both adapters throw this instead, so the bug shows up the
 * same way on both.
 */
export class TransactionMisuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransactionMisuseError";
  }
}

interface TransactionScope {
  owner: object;
  open: boolean;
}

const scopes = new AsyncLocalStorage<TransactionScope>();

/**
 * The behaviour both adapters share; a subclass supplies only the raw
 * operations of its driver.
 */
export abstract class DbBase implements Db {
  abstract readonly kind: DbKind;
  #closed = false;

  protected abstract rawQuery(sql: string, params: readonly unknown[]): Promise<QueryResult>;
  protected abstract rawExec(sql: string): Promise<void>;
  /** Runs `fn` between BEGIN and COMMIT (ROLLBACK when it throws) on one connection. */
  protected abstract rawTransaction<T>(fn: (raw: Executor) => Promise<T>): Promise<T>;
  /** A connection that stays open until close, for a session-level lock. */
  protected abstract rawSessionConnection(): Promise<Queryable>;
  protected abstract rawClose(): Promise<void>;

  // async, so that misuse rejects like every other database failure instead of throwing synchronously.
  async query<R = Row>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
    this.#checkUsable("query");
    return (await this.rawQuery(sql, params)) as QueryResult<R>;
  }

  async exec(sql: string): Promise<void> {
    this.#checkUsable("exec");
    await this.rawExec(sql);
  }

  async transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
    this.#checkUsable("transaction");
    return this.rawTransaction(async (raw) => {
      const scope: TransactionScope = { owner: this, open: true };
      const checkOpen = (what: string) => {
        if (!scope.open) {
          throw new TransactionMisuseError(`${what} on a transaction handle after its transaction ended`);
        }
      };
      const tx: Executor = {
        query: async <R>(sql: string, params: readonly unknown[] = []) => {
          checkOpen("query");
          return raw.query<R>(sql, params);
        },
        exec: async (sql: string) => {
          checkOpen("exec");
          await raw.exec(sql);
        },
      };
      try {
        return await scopes.run(scope, () => fn(tx));
      } finally {
        scope.open = false;
      }
    });
  }

  async holdSessionLock(key: bigint): Promise<boolean> {
    this.#checkUsable("holdSessionLock");
    const connection = await this.rawSessionConnection();
    const { rows } = await connection.query<{ held: boolean }>("SELECT pg_try_advisory_lock($1) AS held", [key.toString()]);
    return rows[0]?.held === true;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.rawClose();
  }

  #checkUsable(what: string): void {
    if (this.#closed) throw new Error(`${what} on a closed ${this.kind} database`);
    const scope = scopes.getStore();
    if (scope?.open && scope.owner === this) {
      throw new TransactionMisuseError(
        `${what} on the database handle from inside one of its transactions: use the transaction's handle`,
      );
    }
  }
}
