import type { ComputerRecord, VmState } from "@invisible-dots/shared";
import type { SecretBox } from "./crypto.js";
import { iso, isoRequired, type Queryable } from "./rows.js";

interface ComputerRow {
  dot_id: string;
  vm_name: string;
  guest_port: number | null;
  pid: number | null;
  state: VmState;
  golden_image: string | null;
  runtime_image: string | null;
  token_enc: Uint8Array;
  event_cursor: number;
  last_active_at: Date | null;
  last_error: string | null;
  updated_at: Date;
}

function toRecord(row: ComputerRow): ComputerRecord {
  return {
    dot_id: row.dot_id,
    vm_name: row.vm_name,
    guest_port: row.guest_port,
    pid: row.pid,
    state: row.state,
    golden_image: row.golden_image,
    runtime_image: row.runtime_image,
    event_cursor: row.event_cursor,
    last_active_at: iso(row.last_active_at),
    last_error: row.last_error,
    updated_at: isoRequired(row.updated_at),
  };
}

const tokenAad = (dotId: string) => `computer-token:${dotId}`;

/** The QEMU process of a running VM and the host port forwarded to its dot-agentd (sections 3.4 and 3.5). */
export interface VmProcess {
  pid: number;
  guestPort: number;
}

export class ComputersRepository {
  constructor(
    private readonly q: Queryable,
    private readonly box: SecretBox,
  ) {}

  /** A computer with no process yet: the port and pid are recorded at each start. */
  async insert(input: { dotId: string; vmName: string; state: VmState; token: string }): Promise<ComputerRecord> {
    const { rows } = await this.q.query<ComputerRow>(
      `INSERT INTO computers (dot_id, vm_name, state, token_enc) VALUES ($1, $2, $3, $4) RETURNING *`,
      [input.dotId, input.vmName, input.state, this.box.encrypt(input.token, tokenAad(input.dotId))],
    );
    return toRecord(rows[0]!);
  }

  async get(dotId: string): Promise<ComputerRecord | null> {
    const { rows } = await this.q.query<ComputerRow>("SELECT * FROM computers WHERE dot_id = $1", [dotId]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async list(): Promise<ComputerRecord[]> {
    const { rows } = await this.q.query<ComputerRow>("SELECT * FROM computers ORDER BY dot_id");
    return rows.map(toRecord);
  }

  /** The Dot's own token, decrypted (section 5.1). */
  async token(dotId: string): Promise<string> {
    const { rows } = await this.q.query<Pick<ComputerRow, "token_enc">>(
      "SELECT token_enc FROM computers WHERE dot_id = $1",
      [dotId],
    );
    if (!rows[0]) throw new Error(`no computer for Dot ${dotId}`);
    return this.box.decrypt(rows[0].token_enc, tokenAad(dotId));
  }

  /**
   * Set the state. `lastError` replaces the stored error when given (null
   * clears it) and leaves it alone when undefined.
   */
  async setState(dotId: string, state: VmState, lastError?: string | null): Promise<ComputerRecord | null> {
    const { rows } =
      lastError === undefined
        ? await this.q.query<ComputerRow>(
            "UPDATE computers SET state = $2, updated_at = now() WHERE dot_id = $1 RETURNING *",
            [dotId, state],
          )
        : await this.q.query<ComputerRow>(
            "UPDATE computers SET state = $2, last_error = $3, updated_at = now() WHERE dot_id = $1 RETURNING *",
            [dotId, state, lastError],
          );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async setImages(dotId: string, goldenImage: string, runtimeImage: string): Promise<void> {
    await this.q.query(
      "UPDATE computers SET golden_image = $2, runtime_image = $3, updated_at = now() WHERE dot_id = $1",
      [dotId, goldenImage, runtimeImage],
    );
  }

  /**
   * Record the running QEMU process, or clear it (null) once it is gone.
   * The port is chosen anew at every start, so a stopped computer keeps no
   * port that another VM may have been given since.
   */
  async setProcess(dotId: string, process: VmProcess | null): Promise<ComputerRecord | null> {
    const { rows } = await this.q.query<ComputerRow>(
      "UPDATE computers SET pid = $2, guest_port = $3, updated_at = now() WHERE dot_id = $1 RETURNING *",
      [dotId, process?.pid ?? null, process?.guestPort ?? null],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Record that the host saved every guest event up to `seq`. GREATEST keeps
   * the cursor from moving backwards if an old event is replayed.
   */
  async advanceCursor(dotId: string, seq: number, activeAt: Date): Promise<void> {
    await this.q.query(
      `UPDATE computers SET event_cursor = GREATEST(event_cursor, $2), last_active_at = $3, updated_at = now() WHERE dot_id = $1`,
      [dotId, seq, activeAt],
    );
  }

  async touch(dotId: string, activeAt: Date): Promise<void> {
    await this.q.query("UPDATE computers SET last_active_at = $2 WHERE dot_id = $1", [dotId, activeAt]);
  }
}
