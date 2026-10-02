import pg from "pg";
import { ApprovalsRepository } from "./approvals.js";
import { ComputersRepository } from "./computers.js";
import { SecretBox } from "./crypto.js";
import { DotsRepository } from "./dots.js";
import { EventsRepository } from "./events.js";
import { migrate, type MigrateResult } from "./migrate.js";
import type { Queryable } from "./rows.js";
import { SecretsRepository } from "./secrets.js";
import { TasksRepository } from "./tasks.js";

/** Every repository, bound to one connection (the pool, or a transaction's client). */
export class Repositories {
  readonly dots: DotsRepository;
  readonly computers: ComputersRepository;
  readonly tasks: TasksRepository;
  readonly events: EventsRepository;
  readonly approvals: ApprovalsRepository;
  readonly secrets: SecretsRepository;

  constructor(q: Queryable, box: SecretBox) {
    this.dots = new DotsRepository(q);
    this.computers = new ComputersRepository(q, box);
    this.tasks = new TasksRepository(q);
    this.events = new EventsRepository(q);
    this.approvals = new ApprovalsRepository(q);
    this.secrets = new SecretsRepository(q, box);
  }
}

export interface DatabaseOptions {
  connectionString: string;
  masterKey: Uint8Array;
  /** Pool size (default 10). */
  max?: number;
}

export class Database extends Repositories {
  readonly pool: pg.Pool;
  readonly #box: SecretBox;

  private constructor(pool: pg.Pool, box: SecretBox) {
    super(pool, box);
    this.pool = pool;
    this.#box = box;
  }

  static connect(options: DatabaseOptions): Database {
    const pool = new pg.Pool({ connectionString: options.connectionString, max: options.max ?? 10 });
    // An idle client that loses its server (PostgreSQL restarted) emits here;
    // without a listener the whole process would crash on it.
    pool.on("error", (error) => {
      console.error(`[database] idle client error: ${error.message}`);
    });
    return new Database(pool, new SecretBox(options.masterKey));
  }

  migrate(options: { dir?: string; log?: (line: string) => void } = {}): Promise<MigrateResult> {
    return migrate(this.pool, options);
  }

  /** Fails with a clear message when the server cannot be reached. */
  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  /** Run `fn` in one transaction; it commits when `fn` resolves and rolls back when it throws. */
  async transaction<T>(fn: (tx: Repositories) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(new Repositories(client, this.#box));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
