import { newId, type TaskState } from "@invisible-dots/shared";
import type { TaskRecord, TaskRunRecord } from "@invisible-dots/shared";
import { iso, isoRequired, type Queryable } from "./rows.js";

interface TaskRow {
  id: string;
  dot_id: string;
  description: string;
  priority: number;
  status: TaskState;
  created_at: Date;
  scheduled_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  summary: string | null;
  error: string | null;
}

interface TaskRunRow {
  id: string;
  task_id: string;
  started_at: Date;
  delivered_at: Date | null;
  finished_at: Date | null;
  outcome: string | null;
}

function toTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    dot_id: row.dot_id,
    description: row.description,
    priority: row.priority,
    status: row.status,
    created_at: isoRequired(row.created_at),
    scheduled_at: iso(row.scheduled_at),
    started_at: iso(row.started_at),
    finished_at: iso(row.finished_at),
    summary: row.summary,
    error: row.error,
  };
}

function toRun(row: TaskRunRow): TaskRunRecord {
  return {
    id: row.id,
    task_id: row.task_id,
    started_at: isoRequired(row.started_at),
    delivered_at: iso(row.delivered_at),
    finished_at: iso(row.finished_at),
    outcome: row.outcome,
  };
}

/** Task states in which a Dot counts as busy: the dispatcher sends it nothing else (section 9.2). */
const ACTIVE = "('RUNNING', 'WAITING_APPROVAL')";
const TERMINAL = "('COMPLETED', 'FAILED', 'CANCELLED')";

/**
 * The claim of section 9.2. The task row and its Dot row are both locked:
 * a second dispatcher running the same statement skips every task of a Dot
 * that is being claimed, instead of claiming a second task for it before the
 * first one's RUNNING status is committed. Higher priority first, then
 * creation order.
 */
export const CLAIM_SQL = `
SELECT t.*
  FROM tasks t
  JOIN dots d ON d.id = t.dot_id
  JOIN computers c ON c.dot_id = t.dot_id
 WHERE t.status = 'PENDING'
   AND (t.scheduled_at IS NULL OR t.scheduled_at <= now())
   AND d.status NOT IN ('CREATING', 'DISABLED')
   AND c.state NOT IN ('PROVISIONING', 'DELETING')
   AND NOT EXISTS (SELECT 1 FROM tasks busy WHERE busy.dot_id = t.dot_id AND busy.status IN ${ACTIVE})
 ORDER BY t.priority DESC, t.created_at, t.id
 LIMIT 1
   FOR UPDATE OF t, d SKIP LOCKED`;

export interface ClaimedTask {
  task: TaskRecord;
  run: TaskRunRecord;
}

export class TasksRepository {
  constructor(private readonly q: Queryable) {}

  async insert(input: {
    id: string;
    dotId: string;
    description: string;
    priority?: number;
    scheduledAt?: Date | null;
  }): Promise<TaskRecord> {
    const { rows } = await this.q.query<TaskRow>(
      `INSERT INTO tasks (id, dot_id, description, priority, status, scheduled_at)
       VALUES ($1, $2, $3, $4, 'PENDING', $5) RETURNING *`,
      [input.id, input.dotId, input.description, input.priority ?? 0, input.scheduledAt ?? null],
    );
    return toTask(rows[0]!);
  }

  async get(id: string): Promise<TaskRecord | null> {
    const { rows } = await this.q.query<TaskRow>("SELECT * FROM tasks WHERE id = $1", [id]);
    return rows[0] ? toTask(rows[0]) : null;
  }

  async listByDot(dotId: string, options: { status?: TaskState; limit?: number } = {}): Promise<TaskRecord[]> {
    const { rows } = await this.q.query<TaskRow>(
      `SELECT * FROM tasks WHERE dot_id = $1 AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC, id DESC LIMIT $3`,
      [dotId, options.status ?? null, options.limit ?? 200],
    );
    return rows.map(toTask);
  }

  async runs(taskId: string): Promise<TaskRunRecord[]> {
    const { rows } = await this.q.query<TaskRunRow>(
      "SELECT * FROM task_runs WHERE task_id = $1 ORDER BY started_at, id",
      [taskId],
    );
    return rows.map(toRun);
  }

  /**
   * Claim the next due task and open a run for it. Must run inside a
   * transaction (`Database.transaction`): the row locks of CLAIM_SQL last
   * until it commits.
   */
  async claimNext(): Promise<ClaimedTask | null> {
    const { rows } = await this.q.query<TaskRow>(CLAIM_SQL);
    const claimed = rows[0];
    if (!claimed) return null;
    const { rows: updated } = await this.q.query<TaskRow>(
      "UPDATE tasks SET status = 'RUNNING', started_at = COALESCE(started_at, now()) WHERE id = $1 RETURNING *",
      [claimed.id],
    );
    const { rows: runs } = await this.q.query<TaskRunRow>(
      "INSERT INTO task_runs (id, task_id) VALUES ($1, $2) RETURNING *",
      [newId("run"), claimed.id],
    );
    return { task: toTask(updated[0]!), run: toRun(runs[0]!) };
  }

  async markDelivered(runId: string): Promise<void> {
    await this.q.query("UPDATE task_runs SET delivered_at = now() WHERE id = $1", [runId]);
  }

  /**
   * Put a claimed task back in the queue after its delivery failed, closing
   * the run with `outcome`. A task that was cancelled meanwhile stays
   * cancelled.
   */
  async requeue(taskId: string, runId: string, outcome: string, scheduledAt: Date | null): Promise<void> {
    await this.q.query(
      "UPDATE task_runs SET finished_at = now(), outcome = $2 WHERE id = $1 AND finished_at IS NULL",
      [runId, outcome],
    );
    await this.q.query(
      `UPDATE tasks SET status = 'PENDING', scheduled_at = $2 WHERE id = $1 AND status NOT IN ${TERMINAL}`,
      [taskId, scheduledAt],
    );
  }

  /** How many runs of a task ended without reaching the guest. */
  async failedDeliveries(taskId: string): Promise<number> {
    const { rows } = await this.q.query<{ n: string }>(
      "SELECT count(*) AS n FROM task_runs WHERE task_id = $1 AND delivered_at IS NULL AND finished_at IS NOT NULL",
      [taskId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Move a task to `status` from the guest's events. A task already in a
   * terminal state is left alone (a cancelled task the guest finishes
   * anyway stays cancelled); returns the updated task or null. With
   * `dotId`, only a task of that Dot moves: a guest can never touch another
   * Dot's tasks by naming their ids.
   */
  async transition(
    taskId: string,
    status: TaskState,
    fields: { summary?: string; error?: string; dotId?: string } = {},
  ): Promise<TaskRecord | null> {
    const terminal = status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
    const { rows } = await this.q.query<TaskRow>(
      `UPDATE tasks
          SET status = $2,
              started_at = CASE WHEN $2 IN ('RUNNING', 'WAITING_APPROVAL') THEN COALESCE(started_at, now()) ELSE started_at END,
              finished_at = CASE WHEN $3 THEN now() ELSE finished_at END,
              summary = COALESCE($4, summary),
              error = COALESCE($5, error)
        WHERE id = $1 AND status NOT IN ${TERMINAL} AND ($6::text IS NULL OR dot_id = $6)
        RETURNING *`,
      [taskId, status, terminal, fields.summary ?? null, fields.error ?? null, fields.dotId ?? null],
    );
    if (rows[0] && terminal) {
      await this.q.query(
        "UPDATE task_runs SET finished_at = now(), outcome = $2 WHERE task_id = $1 AND finished_at IS NULL",
        [taskId, status.toLowerCase()],
      );
    }
    return rows[0] ? toTask(rows[0]) : null;
  }

  /** Whether the Dot has work: a due PENDING task, or one RUNNING or WAITING_APPROVAL (section 9.5). */
  async hasWork(dotId: string, now: Date): Promise<boolean> {
    const { rows } = await this.q.query(
      `SELECT 1 FROM tasks
        WHERE dot_id = $1
          AND (status IN ${ACTIVE} OR (status = 'PENDING' AND (scheduled_at IS NULL OR scheduled_at <= $2)))
        LIMIT 1`,
      [dotId, now],
    );
    return rows.length > 0;
  }

  /** Runs opened by a dispatcher that stopped before the guest got the task (recovery at startup). */
  async interruptedRuns(): Promise<TaskRunRecord[]> {
    const { rows } = await this.q.query<TaskRunRow>(
      "SELECT * FROM task_runs WHERE delivered_at IS NULL AND finished_at IS NULL ORDER BY started_at",
    );
    return rows.map(toRun);
  }

  /** The tasks a Dot's guest is working on, as the host last heard. */
  async activeForDot(dotId: string): Promise<TaskRecord[]> {
    const { rows } = await this.q.query<TaskRow>(
      `SELECT * FROM tasks WHERE dot_id = $1 AND status IN ${ACTIVE} ORDER BY created_at`,
      [dotId],
    );
    return rows.map(toTask);
  }
}
