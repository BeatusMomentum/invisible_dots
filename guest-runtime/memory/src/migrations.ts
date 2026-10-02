/**
 * Schema of `dot.db`. Migrations are append-only: a released one is never
 * edited, a change is a new entry, because a Dot's disk outlives every version
 * of this code.
 */
export const MIGRATIONS: readonly { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "initial",
    sql: `
      CREATE TABLE config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- One row per message of a thread: "conversation" for chat turns, the task id for a task.
      CREATE TABLE conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX conversation_messages_thread ON conversation_messages (thread, id);

      -- Inbound events, kept until handled so that a restart loses no chat turn,
      -- and so that a redelivered event id is accepted once.
      CREATE TABLE inbox (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        ts TEXT NOT NULL,
        received_seq INTEGER NOT NULL,
        processed_at TEXT
      );
      CREATE INDEX inbox_pending ON inbox (processed_at, received_seq);

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        -- Creation order inside the guest; ties on priority are broken by it.
        queue_seq INTEGER NOT NULL UNIQUE,
        description TEXT NOT NULL,
        priority INTEGER NOT NULL,
        status TEXT NOT NULL,
        steps INTEGER NOT NULL DEFAULT 0,
        usage TEXT,
        summary TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX tasks_status ON tasks (status, priority DESC, queue_seq);

      CREATE TABLE memories (
        key TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX memories_updated ON memories (updated_at DESC);
      CREATE VIRTUAL TABLE memories_fts USING fts5 (key, content, content='memories', content_rowid='rowid');
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts (rowid, key, content) VALUES (new.rowid, new.key, new.content);
      END;
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts (memories_fts, rowid, key, content) VALUES ('delete', old.rowid, old.key, old.content);
      END;
      CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts (memories_fts, rowid, key, content) VALUES ('delete', old.rowid, old.key, old.content);
        INSERT INTO memories_fts (rowid, key, content) VALUES (new.rowid, new.key, new.content);
      END;

      -- AUTOINCREMENT, not plain rowid: a seq is never handed out twice, even after rows are pruned.
      CREATE TABLE outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        ts TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE pending_approvals (
        approval_id TEXT PRIMARY KEY,
        thread TEXT NOT NULL,
        task_id TEXT,
        tool_call_id TEXT NOT NULL UNIQUE,
        tool TEXT NOT NULL,
        permission TEXT NOT NULL,
        arguments TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        note TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE browser_identities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        status TEXT NOT NULL,
        proxy TEXT,
        profile_path TEXT NOT NULL
      );
    `,
  },
];
