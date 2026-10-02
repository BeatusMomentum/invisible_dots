/**
 * `dot.db` (architecture sections 4.2, 5.3 and 8.6): the conversation, the
 * local task queue, long-term memories with full-text search, the outbox of
 * outbound events, pending approvals, the runtime config and the browser
 * identities. One synchronous SQLite connection owned by the agent process.
 *
 * Secrets never go through this class: the OpenRouter key lives in memory only.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  newId,
  type BrowserIdentity,
  type BrowserIdentityStatus,
  type InboundEvent,
  type InboundEventType,
  type OutboundEvent,
  type OutboundEventDataMap,
  type OutboundEventType,
  type Permission,
  type TaskState,
} from "@invisible-dots/shared";
import { MIGRATIONS } from "./migrations.js";

export interface DotStoreOptions {
  /** File path, or ":memory:" for tests. */
  path: string;
  now?: () => Date;
}

/** The conversation thread every chat turn shares (section 8.2). */
export const CONVERSATION_THREAD = "conversation";

export interface StoredMessage<M = Record<string, unknown>> {
  id: number;
  thread: string;
  message: M;
  createdAt: string;
}

export interface InboxEntry {
  id: string;
  type: InboundEventType;
  data: Record<string, unknown>;
  ts: string;
  receivedSeq: number;
  processedAt: string | null;
}

export interface UsageRecord {
  prompt_tokens: number;
  completion_tokens: number;
  cost: number | null;
  requests: number;
}

export interface TaskRecord {
  id: string;
  queueSeq: number;
  description: string;
  priority: number;
  status: TaskState;
  steps: number;
  usage: UsageRecord | null;
  summary: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type TaskPatch = Partial<Pick<TaskRecord, "status" | "steps" | "usage" | "summary" | "error" | "startedAt" | "finishedAt">>;

export interface MemoryRecord {
  key: string;
  content: string;
  updatedAt: string;
}

export interface MemorySearchHit extends MemoryRecord {
  /** bm25 rank: lower is a better match. */
  rank: number;
}

export type ApprovalRowStatus = "pending" | "approved" | "rejected";

export interface PendingApprovalRecord {
  approvalId: string;
  /** The thread the suspended call belongs to: the conversation or a task id. */
  thread: string;
  taskId: string | null;
  toolCallId: string;
  tool: string;
  permission: Permission;
  arguments: Record<string, unknown>;
  reason: string;
  status: ApprovalRowStatus;
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export type OutboxListener = (event: OutboundEvent) => void;

type Row = Record<string, SQLInputValue>;

export class DotStore {
  readonly path: string;
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  readonly #listeners = new Set<OutboxListener>();
  #closed = false;

  constructor(options: DotStoreOptions) {
    this.path = options.path;
    this.#now = options.now ?? (() => new Date());
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
    this.#db = new DatabaseSync(options.path);
    // WAL keeps readers (the SSE replay) from blocking the writer; FULL sync
    // because an outbox row the host has not seen must survive a power cut.
    if (options.path !== ":memory:") this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.#migrate();
  }

  /** Open (creating it and its directory if needed) the store at `path`. */
  static open(path: string): DotStore {
    return new DotStore({ path });
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    if (this.#closed) return;
    this.checkpoint();
    this.#closed = true;
    this.#listeners.clear();
    this.#db.close();
  }

  /** Move the WAL into the main file, so a VM shut down next leaves one self-contained file. */
  checkpoint(): void {
    if (this.#closed || this.path === ":memory:") return;
    this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  /** Run `fn` in one transaction; nested calls join the outer one. */
  transaction<T>(fn: () => T): T {
    if (this.#db.isTransaction) return fn();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  schemaVersion(): number {
    const row = this.#db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null } | undefined;
    return row?.v ?? 0;
  }

  #migrate(): void {
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    const current = this.schemaVersion();
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      this.transaction(() => {
        this.#db.exec(migration.sql);
        this.#db
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, this.#iso());
      });
    }
  }

  #iso(): string {
    return this.#now().toISOString();
  }


  getConfig<T = unknown>(key: string): T | undefined {
    const row = this.#db.prepare("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.value) as T);
  }

  setConfig(key: string, value: unknown): void {
    this.#db
      .prepare(
        "INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(key, JSON.stringify(value), this.#iso());
  }

  deleteConfig(key: string): void {
    this.#db.prepare("DELETE FROM config WHERE key = ?").run(key);
  }


  appendMessage<M extends object>(thread: string, message: M): StoredMessage<M> {
    const createdAt = this.#iso();
    const result = this.#db
      .prepare("INSERT INTO conversation_messages (thread, message, created_at) VALUES (?, ?, ?)")
      .run(thread, JSON.stringify(message), createdAt);
    return { id: Number(result.lastInsertRowid), thread, message, createdAt };
  }

  /** Messages of a thread in order; with `limit`, only the last `limit` of them. */
  listMessages<M = Record<string, unknown>>(thread: string, options: { limit?: number } = {}): StoredMessage<M>[] {
    const rows = (
      options.limit === undefined
        ? this.#db.prepare("SELECT * FROM conversation_messages WHERE thread = ? ORDER BY id").all(thread)
        : this.#db
            .prepare("SELECT * FROM conversation_messages WHERE thread = ? ORDER BY id DESC LIMIT ?")
            .all(thread, options.limit)
            .reverse()
    ) as { id: number; thread: string; message: string; created_at: string }[];
    return rows.map((r) => ({ id: r.id, thread: r.thread, message: JSON.parse(r.message) as M, createdAt: r.created_at }));
  }

  countMessages(thread: string): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM conversation_messages WHERE thread = ?").get(thread) as { n: number };
    return row.n;
  }


  /** Record an inbound event; false when an event with that id was already accepted. */
  acceptInbound(event: InboundEvent): boolean {
    return this.transaction(() => {
      const exists = this.#db.prepare("SELECT 1 FROM inbox WHERE id = ?").get(event.id);
      if (exists) return false;
      const next = this.#db.prepare("SELECT COALESCE(MAX(received_seq), 0) + 1 AS n FROM inbox").get() as { n: number };
      this.#db
        .prepare("INSERT INTO inbox (id, type, data, ts, received_seq) VALUES (?, ?, ?, ?, ?)")
        .run(event.id, event.type, JSON.stringify(event.data), event.ts, next.n);
      return true;
    });
  }

  /** Accepted events not yet handled, in arrival order. */
  pendingInbound(types?: readonly InboundEventType[]): InboxEntry[] {
    const rows = this.#db
      .prepare("SELECT * FROM inbox WHERE processed_at IS NULL ORDER BY received_seq")
      .all() as { id: string; type: InboundEventType; data: string; ts: string; received_seq: number; processed_at: string | null }[];
    return rows
      .filter((r) => types === undefined || types.includes(r.type))
      .map((r) => ({
        id: r.id,
        type: r.type,
        data: JSON.parse(r.data) as Record<string, unknown>,
        ts: r.ts,
        receivedSeq: r.received_seq,
        processedAt: r.processed_at,
      }));
  }

  markInboundProcessed(id: string): void {
    this.#db.prepare("UPDATE inbox SET processed_at = ? WHERE id = ? AND processed_at IS NULL").run(this.#iso(), id);
  }


  /** Insert a PENDING task; an id that already exists is returned as it is, with `created: false`. */
  insertTask(input: { id: string; description: string; priority: number }): { task: TaskRecord; created: boolean } {
    return this.transaction(() => {
      const existing = this.getTask(input.id);
      if (existing) return { task: existing, created: false };
      const next = this.#db.prepare("SELECT COALESCE(MAX(queue_seq), 0) + 1 AS n FROM tasks").get() as { n: number };
      this.#db
        .prepare(
          "INSERT INTO tasks (id, queue_seq, description, priority, status, created_at) VALUES (?, ?, ?, ?, 'PENDING', ?)",
        )
        .run(input.id, next.n, input.description, input.priority, this.#iso());
      return { task: this.getTask(input.id)!, created: true };
    });
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : taskFromRow(row);
  }

  /** Tasks in queue order: priority (higher first), then creation order. */
  listTasks(options: { status?: readonly TaskState[] } = {}): TaskRecord[] {
    const rows = this.#db.prepare("SELECT * FROM tasks ORDER BY priority DESC, queue_seq").all() as Row[];
    const tasks = rows.map(taskFromRow);
    return options.status === undefined ? tasks : tasks.filter((t) => options.status!.includes(t.status));
  }

  updateTask(id: string, patch: TaskPatch): TaskRecord {
    const columns: Record<keyof TaskPatch, string> = {
      status: "status",
      steps: "steps",
      usage: "usage",
      summary: "summary",
      error: "error",
      startedAt: "started_at",
      finishedAt: "finished_at",
    };
    const sets: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [key, value] of Object.entries(patch) as [keyof TaskPatch, unknown][]) {
      if (value === undefined) continue;
      sets.push(`${columns[key]} = ?`);
      values.push(key === "usage" ? (value === null ? null : JSON.stringify(value)) : (value as SQLInputValue));
    }
    if (sets.length > 0) {
      const result = this.#db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
      if (result.changes === 0) throw new Error(`no task with id "${id}"`);
    }
    const task = this.getTask(id);
    if (!task) throw new Error(`no task with id "${id}"`);
    return task;
  }


  remember(key: string, content: string): MemoryRecord {
    const updatedAt = this.#iso();
    this.#db
      .prepare(
        "INSERT INTO memories (key, content, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
      )
      .run(key, content, updatedAt);
    return { key, content, updatedAt };
  }

  getMemory(key: string): MemoryRecord | undefined {
    const row = this.#db.prepare("SELECT key, content, updated_at FROM memories WHERE key = ?").get(key) as
      | { key: string; content: string; updated_at: string }
      | undefined;
    return row === undefined ? undefined : { key: row.key, content: row.content, updatedAt: row.updated_at };
  }

  forget(key: string): boolean {
    return this.#db.prepare("DELETE FROM memories WHERE key = ?").run(key).changes > 0;
  }

  /** The keys of the `limit` most recently updated memories, newest first. */
  recentMemoryKeys(limit: number): string[] {
    const rows = this.#db
      .prepare("SELECT key FROM memories ORDER BY updated_at DESC, rowid DESC LIMIT ?")
      .all(limit) as { key: string }[];
    return rows.map((r) => r.key);
  }

  /**
   * Full-text search over keys and contents. The query is free text from the
   * model, so it is reduced to plain words (each matched as a prefix, any of
   * them may match) rather than passed as FTS5 syntax that could fail to parse.
   */
  searchMemories(query: string, limit = 10): MemorySearchHit[] {
    const words = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (words.length === 0) return [];
    const match = words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(" OR ");
    const rows = this.#db
      .prepare(
        `SELECT m.key, m.content, m.updated_at, bm25(memories_fts) AS rank
         FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(match, limit) as { key: string; content: string; updated_at: string; rank: number }[];
    return rows.map((r) => ({ key: r.key, content: r.content, updatedAt: r.updated_at, rank: r.rank }));
  }


  /**
   * Persist an outbound event and then hand it to live subscribers. The row is
   * committed before anyone sees it, so a stream never shows an event a
   * restart could take back.
   */
  appendEvent<T extends OutboundEventType>(type: T, data: OutboundEventDataMap[T]): OutboundEvent<T> {
    const id = newId("evt");
    const ts = this.#iso();
    const result = this.#db
      .prepare("INSERT INTO outbox (id, type, ts, data) VALUES (?, ?, ?, ?)")
      .run(id, type, ts, JSON.stringify(data));
    const event = { seq: Number(result.lastInsertRowid), id, type, ts, data } as OutboundEvent<T>;
    for (const listener of this.#listeners) {
      try {
        listener(event as OutboundEvent);
      } catch {
        // A broken subscriber (a closed SSE socket) must not fail the writer.
      }
    }
    return event;
  }

  /** Events with `seq` greater than `after`, oldest first. */
  readAfter(after: number, limit = 500): OutboundEvent[] {
    const rows = this.#db
      .prepare("SELECT seq, id, type, ts, data FROM outbox WHERE seq > ? ORDER BY seq LIMIT ?")
      .all(after, limit) as { seq: number; id: string; type: OutboundEventType; ts: string; data: string }[];
    return rows.map((r) => ({ seq: r.seq, id: r.id, type: r.type, ts: r.ts, data: JSON.parse(r.data) }) as OutboundEvent);
  }

  lastSeq(): number {
    const row = this.#db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'outbox'").get() as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  /** Receive every event appended from now on; returns the unsubscribe function. */
  subscribe(listener: OutboxListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }


  insertPendingApproval(
    input: Omit<PendingApprovalRecord, "status" | "note" | "createdAt" | "resolvedAt">,
  ): PendingApprovalRecord {
    this.#db
      .prepare(
        `INSERT INTO pending_approvals (approval_id, thread, task_id, tool_call_id, tool, permission, arguments, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.approvalId,
        input.thread,
        input.taskId,
        input.toolCallId,
        input.tool,
        input.permission,
        JSON.stringify(input.arguments),
        input.reason,
        this.#iso(),
      );
    return this.getApproval(input.approvalId)!;
  }

  getApproval(approvalId: string): PendingApprovalRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM pending_approvals WHERE approval_id = ?").get(approvalId) as Row | undefined;
    return row === undefined ? undefined : approvalFromRow(row);
  }

  getApprovalByToolCall(toolCallId: string): PendingApprovalRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM pending_approvals WHERE tool_call_id = ?").get(toolCallId) as Row | undefined;
    return row === undefined ? undefined : approvalFromRow(row);
  }

  listApprovals(options: { status?: ApprovalRowStatus } = {}): PendingApprovalRecord[] {
    const rows = (
      options.status === undefined
        ? this.#db.prepare("SELECT * FROM pending_approvals ORDER BY created_at, rowid").all()
        : this.#db.prepare("SELECT * FROM pending_approvals WHERE status = ? ORDER BY created_at, rowid").all(options.status)
    ) as Row[];
    return rows.map(approvalFromRow);
  }

  /** Record the user's decision; false when the approval is unknown or already resolved. */
  resolveApproval(approvalId: string, status: "approved" | "rejected", note?: string): boolean {
    const result = this.#db
      .prepare("UPDATE pending_approvals SET status = ?, note = ?, resolved_at = ? WHERE approval_id = ? AND status = 'pending'")
      .run(status, note ?? null, this.#iso(), approvalId);
    return result.changes > 0;
  }

  deleteApproval(approvalId: string): void {
    this.#db.prepare("DELETE FROM pending_approvals WHERE approval_id = ?").run(approvalId);
  }

  deleteApprovalsForThread(thread: string): void {
    this.#db.prepare("DELETE FROM pending_approvals WHERE thread = ?").run(thread);
  }


  putIdentity(identity: BrowserIdentity): void {
    this.#db
      .prepare(
        `INSERT INTO browser_identities (id, name, created_at, last_used_at, status, proxy, profile_path)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, last_used_at = excluded.last_used_at,
           status = excluded.status, proxy = excluded.proxy, profile_path = excluded.profile_path`,
      )
      .run(
        identity.id,
        identity.name,
        identity.createdAt,
        identity.lastUsedAt,
        identity.status,
        identity.proxy ?? null,
        identity.profilePath,
      );
  }

  getIdentity(id: string): BrowserIdentity | undefined {
    const row = this.#db.prepare("SELECT * FROM browser_identities WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : identityFromRow(row);
  }

  /** Identities in creation order. */
  listIdentities(): BrowserIdentity[] {
    const rows = this.#db.prepare("SELECT * FROM browser_identities ORDER BY created_at, rowid").all() as Row[];
    return rows.map(identityFromRow);
  }

  deleteIdentity(id: string): void {
    this.#db.prepare("DELETE FROM browser_identities WHERE id = ?").run(id);
  }
}

function taskFromRow(row: Row): TaskRecord {
  return {
    id: row.id as string,
    queueSeq: row.queue_seq as number,
    description: row.description as string,
    priority: row.priority as number,
    status: row.status as TaskState,
    steps: row.steps as number,
    usage: row.usage === null ? null : (JSON.parse(row.usage as string) as UsageRecord),
    summary: row.summary as string | null,
    error: row.error as string | null,
    createdAt: row.created_at as string,
    startedAt: row.started_at as string | null,
    finishedAt: row.finished_at as string | null,
  };
}

function approvalFromRow(row: Row): PendingApprovalRecord {
  return {
    approvalId: row.approval_id as string,
    thread: row.thread as string,
    taskId: row.task_id as string | null,
    toolCallId: row.tool_call_id as string,
    tool: row.tool as string,
    permission: row.permission as Permission,
    arguments: JSON.parse(row.arguments as string) as Record<string, unknown>,
    reason: row.reason as string,
    status: row.status as ApprovalRowStatus,
    note: row.note as string | null,
    createdAt: row.created_at as string,
    resolvedAt: row.resolved_at as string | null,
  };
}

function identityFromRow(row: Row): BrowserIdentity {
  const identity: BrowserIdentity = {
    id: row.id as string,
    name: row.name as string,
    createdAt: row.created_at as string,
    lastUsedAt: row.last_used_at as string | null,
    status: row.status as BrowserIdentityStatus,
    profilePath: row.profile_path as string,
  };
  if (row.proxy !== null) identity.proxy = row.proxy as string;
  return identity;
}
