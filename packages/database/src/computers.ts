import type { VmState } from "@invisible-dots/shared";
import type { ComputerRecord } from "@invisible-dots/shared";
import type { SecretBox } from "./crypto.js";
import { iso, isoRequired, num, type Queryable } from "./rows.js";

interface ComputerRow {
  dot_id: string;
  domain_name: string;
  cid: number;
  state: VmState;
  golden_image: string | null;
  runtime_image: string | null;
  token_enc: Buffer;
  event_cursor: string;
  last_active_at: Date | null;
  last_error: string | null;
  updated_at: Date;
}

function toRecord(row: ComputerRow): ComputerRecord {
  return {
    dot_id: row.dot_id,
    domain_name: row.domain_name,
    cid: row.cid,
    state: row.state,
    golden_image: row.golden_image,
    runtime_image: row.runtime_image,
    event_cursor: num(row.event_cursor) ?? 0,
    last_active_at: iso(row.last_active_at),
    last_error: row.last_error,
    updated_at: isoRequired(row.updated_at),
  };
}

const tokenAad = (dotId: string) => `computer-token:${dotId}`;

/** CIDs 0 to 2 are reserved by the vsock specification (hypervisor, local, host). */
const MIN_CID = 3;
/** The largest CID the kernel accepts for a guest (u32 minus the reserved VMADDR_CID_ANY). */
const MAX_CID = 0xfffffffe;

export class ComputersRepository {
  constructor(
    private readonly q: Queryable,
    private readonly box: SecretBox,
  ) {}

  async insert(input: { dotId: string; domainName: string; cid: number; state: VmState; token: string }): Promise<ComputerRecord> {
    const { rows } = await this.q.query<ComputerRow>(
      `INSERT INTO computers (dot_id, domain_name, cid, state, token_enc) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [input.dotId, input.domainName, input.cid, input.state, this.box.encrypt(input.token, tokenAad(input.dotId))],
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

  async setCid(dotId: string, cid: number): Promise<void> {
    await this.q.query("UPDATE computers SET cid = $2, updated_at = now() WHERE dot_id = $1", [dotId, cid]);
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

  /**
   * The lowest CID at or above `base` that no computer holds and that is not
   * in `exclude` (CIDs another program on the host turned out to hold). The
   * unique constraint on `cid` settles a race between two allocations.
   */
  async nextFreeCid(base: number, exclude: Iterable<number> = []): Promise<number> {
    const start = Math.max(base, MIN_CID);
    const { rows } = await this.q.query<{ cid: number }>("SELECT cid FROM computers WHERE cid >= $1 ORDER BY cid", [start]);
    const taken = new Set<number>(rows.map((r) => r.cid));
    for (const cid of exclude) taken.add(cid);
    let cid = start;
    while (taken.has(cid)) cid++;
    if (cid > MAX_CID) throw new Error("no free vsock CID left");
    return cid;
  }
}
