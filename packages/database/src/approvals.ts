import type { ApprovalRequestedData, ApprovalStatus } from "@invisible-dots/shared";
import type { ApprovalRecord } from "@invisible-dots/shared";
import { iso, isoRequired, type Queryable } from "./rows.js";

interface ApprovalRow {
  id: string;
  dot_id: string;
  task_id: string | null;
  tool: string;
  permission: string;
  arguments: Record<string, unknown>;
  reason: string;
  status: ApprovalStatus;
  note: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

function toRecord(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    dot_id: row.dot_id,
    task_id: row.task_id,
    tool: row.tool,
    permission: row.permission,
    arguments: row.arguments,
    reason: row.reason,
    status: row.status,
    note: row.note,
    created_at: isoRequired(row.created_at),
    resolved_at: iso(row.resolved_at),
  };
}

export class ApprovalsRepository {
  constructor(private readonly q: Queryable) {}

  /**
   * Record an `approval.requested` event; a replayed event is ignored and
   * returns null. `expired` records a request whose task had already ended
   * when it arrived, so it never shows up as pending.
   */
  async insertRequested(
    dotId: string,
    data: ApprovalRequestedData,
    status: "pending" | "expired" = "pending",
  ): Promise<ApprovalRecord | null> {
    const { rows } = await this.q.query<ApprovalRow>(
      `INSERT INTO approvals (id, dot_id, task_id, tool, permission, arguments, reason, status, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text, CASE WHEN $8::text = 'pending' THEN NULL ELSE now() END)
       ON CONFLICT (id) DO NOTHING RETURNING *`,
      [
        data.approval_id,
        dotId,
        data.task_id ?? null,
        data.tool,
        data.permission,
        JSON.stringify(data.arguments),
        data.reason,
        status,
      ],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async get(id: string): Promise<ApprovalRecord | null> {
    const { rows } = await this.q.query<ApprovalRow>("SELECT * FROM approvals WHERE id = $1", [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** The Dot's approvals whose id ends with `suffix` (compared in lowercase), oldest first: how a short code typed in a chat finds its approval. */
  async endingWith(dotId: string, suffix: string): Promise<ApprovalRecord[]> {
    const { rows } = await this.q.query<ApprovalRow>(
      "SELECT * FROM approvals WHERE dot_id = $1 AND lower(right(id, char_length($2::text))) = lower($2::text) ORDER BY created_at, id",
      [dotId, suffix],
    );
    return rows.map(toRecord);
  }

  async list(options: { status?: ApprovalStatus; dotId?: string; limit?: number } = {}): Promise<ApprovalRecord[]> {
    const { rows } = await this.q.query<ApprovalRow>(
      `SELECT * FROM approvals
        WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR dot_id = $2)
        ORDER BY created_at, id LIMIT $3`,
      [options.status ?? null, options.dotId ?? null, options.limit ?? 500],
    );
    return rows.map(toRecord);
  }

  /** Resolve a pending approval; null when it does not exist or was already resolved. */
  async resolve(id: string, status: "approved" | "rejected", note: string | null): Promise<ApprovalRecord | null> {
    const { rows } = await this.q.query<ApprovalRow>(
      `UPDATE approvals SET status = $2, note = $3, resolved_at = now()
        WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id, status, note],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}
