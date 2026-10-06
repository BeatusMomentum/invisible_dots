import type { DotConfig, DotState, PermissionDecision, VmState } from "@invisible-dots/shared";
import type { DotRecord, DotSummary } from "@invisible-dots/shared";
import { isUniqueViolation, isoRequired, type Queryable } from "./rows.js";

export class DotNameTakenError extends Error {
  constructor(readonly dotName: string) {
    super(`a Dot named "${dotName}" already exists`);
    this.name = "DotNameTakenError";
  }
}

/** A config was saved against a version of the Dot that is no longer the current one (`updateConfig`). */
export class DotChangedError extends Error {
  constructor(readonly dotId: string) {
    super(`Dot ${dotId} changed after it was read`);
    this.name = "DotChangedError";
  }
}

interface DotRow {
  id: string;
  name: string;
  config: DotConfig;
  status: DotState;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  computer_state?: VmState | null;
}

function toRecord(row: DotRow): DotRecord {
  return {
    id: row.id,
    name: row.name,
    config: row.config,
    status: row.status,
    error: row.error,
    created_at: isoRequired(row.created_at),
    updated_at: isoRequired(row.updated_at),
  };
}

function toSummary(row: DotRow): DotSummary {
  return { ...toRecord(row), computer_state: row.computer_state ?? null };
}

const SUMMARY_SELECT = `SELECT d.*, c.state AS computer_state FROM dots d LEFT JOIN computers c ON c.dot_id = d.id`;

export class DotsRepository {
  constructor(private readonly q: Queryable) {}

  async insert(input: { id: string; config: DotConfig; status: DotState }): Promise<DotRecord> {
    try {
      const { rows } = await this.q.query<DotRow>(
        "INSERT INTO dots (id, name, config, status) VALUES ($1, $2, $3, $4) RETURNING *",
        [input.id, input.config.name, JSON.stringify(input.config), input.status],
      );
      return toRecord(rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error, "dots_name_key")) throw new DotNameTakenError(input.config.name);
      throw error;
    }
  }

  async get(id: string): Promise<DotRecord | null> {
    const { rows } = await this.q.query<DotRow>("SELECT * FROM dots WHERE id = $1", [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * A Dot by id or by name. Ids carry a `_` and names cannot, so the two
   * never collide; the API and the CLI accept either.
   */
  async resolve(idOrName: string): Promise<DotSummary | null> {
    const { rows } = await this.q.query<DotRow>(`${SUMMARY_SELECT} WHERE d.id = $1 OR d.name = $1`, [idOrName]);
    return rows[0] ? toSummary(rows[0]) : null;
  }

  async list(): Promise<DotSummary[]> {
    const { rows } = await this.q.query<DotRow>(`${SUMMARY_SELECT} ORDER BY d.created_at, d.id`);
    return rows.map(toSummary);
  }

  /**
   * Replace the config. With `expectedUpdatedAt` (the `updated_at` the caller read, a millisecond ISO string) the row
   * is replaced only while it still has that value, so a save made from an old read cannot overwrite what was
   * saved since (an "always allow", another PATCH): `DotChangedError` otherwise, and null when there is no such Dot.
   */
  async updateConfig(id: string, config: DotConfig, expectedUpdatedAt?: string): Promise<DotRecord | null> {
    try {
      const { rows } = await this.q.query<DotRow>(
        // The column has microseconds and the API says milliseconds (a driver rounds them, a cast truncates): the same
        // instant is one a millisecond apart at most.
        `UPDATE dots SET name = $2, config = $3, updated_at = now()
          WHERE id = $1 AND ($4::timestamptz IS NULL OR abs(extract(epoch FROM (updated_at - $4::timestamptz))) < 0.001) RETURNING *`,
        [id, config.name, JSON.stringify(config), expectedUpdatedAt ?? null],
      );
      if (rows[0]) return toRecord(rows[0]);
      if (expectedUpdatedAt !== undefined && (await this.get(id))) throw new DotChangedError(id);
      return null;
    } catch (error) {
      if (isUniqueViolation(error, "dots_name_key")) throw new DotNameTakenError(config.name);
      throw error;
    }
  }

  /**
   * Set one permission in the Dot's config, in ONE statement that touches no other key: a PATCH or a second approval
   * running at the same time cannot be lost to a read-modify-write.
   */
  async setPermission(id: string, permission: string, decision: PermissionDecision): Promise<DotRecord | null> {
    const { rows } = await this.q.query<DotRow>(
      `UPDATE dots
          SET config = jsonb_set(config, '{permissions}', COALESCE(config->'permissions', '{}'::jsonb) || jsonb_build_object($2::text, $3::text), true),
              updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, permission, decision],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Set the status; `error` is cleared unless given, so a stale reason never outlives its ERROR. */
  async setStatus(id: string, status: DotState, error: string | null = null): Promise<DotRecord | null> {
    const { rows } = await this.q.query<DotRow>(
      "UPDATE dots SET status = $2, error = $3, updated_at = now() WHERE id = $1 RETURNING *",
      [id, status, error],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Delete the Dot and every secret scoped to it in ONE statement. `secrets.scope`
   * holds a Dot id or `global`, so no foreign key can cascade it; leaving the
   * rows would keep a deleted Dot's OpenRouter key and channel tokens forever.
   */
  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.q.query(
      "WITH gone AS (DELETE FROM secrets WHERE scope = $1) DELETE FROM dots WHERE id = $1",
      [id],
    );
    return (rowCount ?? 0) > 0;
  }
}
