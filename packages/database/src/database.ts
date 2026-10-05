import { ENV, hostPaths } from "@invisible-dots/shared";
import { ApprovalsRepository } from "./approvals.js";
import { ChannelsRepository } from "./channels.js";
import { ComputersRepository } from "./computers.js";
import { SecretBox } from "./crypto.js";
import type { Db, Queryable, QueryResult, Row } from "./db.js";
import { DotsRepository } from "./dots.js";
import { EventsRepository } from "./events.js";
import { InboundRepository } from "./inbound.js";
import { migrate, type MigrateResult } from "./migrate.js";
import { PgliteDb } from "./pglite.js";
import { PostgresDb, redactDatabaseUrl } from "./postgres.js";
import { SecretsRepository } from "./secrets.js";
import { TasksRepository } from "./tasks.js";

/** Key of the session-level advisory lock one server holds on its database ("idots-sv" in ASCII). */
export const INSTANCE_LOCK_KEY = 0x69646f74732d7376n;

/** Every repository, bound to one handle (the database, or a transaction). */
export class Repositories {
  readonly dots: DotsRepository;
  readonly computers: ComputersRepository;
  readonly tasks: TasksRepository;
  readonly events: EventsRepository;
  readonly inbound: InboundRepository;
  readonly approvals: ApprovalsRepository;
  readonly secrets: SecretsRepository;
  readonly channels: ChannelsRepository;

  constructor(q: Queryable, box: SecretBox) {
    this.dots = new DotsRepository(q);
    this.computers = new ComputersRepository(q, box);
    this.tasks = new TasksRepository(q);
    this.events = new EventsRepository(q);
    this.inbound = new InboundRepository(q);
    this.approvals = new ApprovalsRepository(q);
    this.secrets = new SecretsRepository(q, box);
    this.channels = new ChannelsRepository(q);
  }
}

/** Which database to open: the embedded one in a directory, or an external server. */
export type DatabaseTarget = { kind: "pglite"; dataDir: string } | { kind: "pg"; url: string };

/**
 * The one place that decides between the two adapters (section 9.1):
 * DATABASE_URL, when set and not blank, names an external PostgreSQL;
 * otherwise the embedded PGlite keeps its data in INVISIBLE_DOTS_HOME/db.
 */
export function databaseTarget(env: Record<string, string | undefined> = process.env): DatabaseTarget {
  const url = env[ENV.DATABASE_URL]?.trim();
  if (url) return { kind: "pg", url };
  return { kind: "pglite", dataDir: hostPaths(env).dbDir };
}

/** The target for logs and error messages, with any password hidden. */
export function describeDatabaseTarget(target: DatabaseTarget): string {
  return target.kind === "pg" ? `PostgreSQL at ${redactDatabaseUrl(target.url)}` : `embedded PostgreSQL (PGlite) in ${target.dataDir}`;
}

/** Opens the adapter for `target`; for PGlite the directory and the cluster are created on first use. */
export function openDb(target: DatabaseTarget, options: { poolSize?: number } = {}): Promise<Db> {
  return target.kind === "pg" ? PostgresDb.open(target.url, options) : PgliteDb.open(target.dataDir);
}

export interface DatabaseOptions {
  target: DatabaseTarget;
  masterKey: Uint8Array;
  /** Connections in the pool of an external server (default 10); PGlite has one. */
  poolSize?: number;
}

export class Database extends Repositories {
  readonly #db: Db;
  readonly #box: SecretBox;

  private constructor(db: Db, box: SecretBox) {
    super(db, box);
    this.#db = db;
    this.#box = box;
  }

  /** Opens the database. Call `migrate` before using the repositories. */
  static async open(options: DatabaseOptions): Promise<Database> {
    // The key is checked before anything is opened, so a bad key leaves no pool or PGlite instance behind.
    const box = new SecretBox(options.masterKey);
    return new Database(await openDb(options.target, { poolSize: options.poolSize }), box);
  }

  get kind(): Db["kind"] {
    return this.#db.kind;
  }

  migrate(options: { dir?: string; log?: (line: string) => void } = {}): Promise<MigrateResult> {
    return migrate(this.#db, options);
  }

  /**
   * Claim this database for one control plane, for as long as it stays
   * open: false when another server already holds it. Two servers on one
   * database would both reconcile, dispatch and stop each other's Dots (one
   * finds no disk for the other's VMs and marks them ERROR), and
   * `server.lock` only guards one INVISIBLE_DOTS_HOME, so the database is
   * claimed too. The lock is PostgreSQL's own and goes when the session
   * does, so a server that died leaves nothing to clean up.
   */
  holdInstanceLock(): Promise<boolean> {
    return this.#db.holdSessionLock(INSTANCE_LOCK_KEY);
  }

  /** One statement outside the repositories (diagnostics, tests). */
  query<R = Row>(sql: string, params?: readonly unknown[]): Promise<QueryResult<R>> {
    return this.#db.query<R>(sql, params);
  }

  /** Run `fn` in one transaction; it commits when `fn` resolves and rolls back when it throws. */
  transaction<T>(fn: (tx: Repositories) => Promise<T>): Promise<T> {
    return this.#db.transaction((tx) => fn(new Repositories(tx, this.#box)));
  }

  /**
   * Whether anything is stored encrypted under the master key (a secret or
   * a Dot token). A server that had to generate a new master key must find
   * nothing here: otherwise the old key was lost and every such value is
   * unreadable.
   */
  async holdsEncryptedValues(): Promise<boolean> {
    const { rows } = await this.#db.query<{ found: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM secrets) OR EXISTS (SELECT 1 FROM computers) AS found",
    );
    return rows[0]?.found === true;
  }

  close(): Promise<void> {
    return this.#db.close();
  }
}
