import type { EventSource, OutboundEvent, StoredEvent } from "@invisible-dots/shared";
import { isoRequired, num, type Queryable } from "./rows.js";

interface EventRow {
  id: string;
  dot_id: string;
  type: string;
  data: Record<string, unknown>;
  source: EventSource;
  guest_seq: string | null;
  created_at: Date;
}

function toStored(row: EventRow): StoredEvent {
  return {
    id: num(row.id)!,
    dot_id: row.dot_id,
    type: row.type as StoredEvent["type"],
    data: row.data,
    source: row.source,
    guest_seq: num(row.guest_seq),
    created_at: isoRequired(row.created_at),
  };
}

export interface EventQuery {
  /** Only events of this Dot; every Dot when omitted. */
  dotId?: string;
  /** Only events with an id greater than this. */
  after?: number;
  /** Only these types. */
  types?: readonly string[];
  /** At most this many, oldest first (default 500). */
  limit?: number;
}

export const MAX_EVENT_PAGE = 1000;

export class EventsRepository {
  constructor(private readonly q: Queryable) {}

  async insertHost(dotId: string, type: string, data: Record<string, unknown>): Promise<StoredEvent> {
    const { rows } = await this.q.query<EventRow>(
      "INSERT INTO events (dot_id, type, data, source) VALUES ($1, $2, $3, 'host') RETURNING *",
      [dotId, type, JSON.stringify(data)],
    );
    return toStored(rows[0]!);
  }

  /**
   * Store a guest event. The guest replays from the cursor after every
   * reconnect, so the same `seq` can arrive twice: the second copy is
   * dropped and null comes back.
   */
  async insertGuest(dotId: string, event: OutboundEvent): Promise<StoredEvent | null> {
    // The guest's own event id and timestamp are kept inside data, so nothing it sent is lost.
    const data = { ...event.data, guest_event_id: event.id, guest_ts: event.ts };
    const { rows } = await this.q.query<EventRow>(
      `INSERT INTO events (dot_id, type, data, source, guest_seq) VALUES ($1, $2, $3, 'guest', $4)
       ON CONFLICT (dot_id, guest_seq) DO NOTHING RETURNING *`,
      [dotId, event.type, JSON.stringify(data), event.seq],
    );
    return rows[0] ? toStored(rows[0]) : null;
  }

  async list(query: EventQuery = {}): Promise<StoredEvent[]> {
    const limit = Math.min(Math.max(query.limit ?? 500, 1), MAX_EVENT_PAGE);
    const { rows } = await this.q.query<EventRow>(
      `SELECT * FROM events
        WHERE ($1::text IS NULL OR dot_id = $1)
          AND id > $2
          AND ($3::text[] IS NULL OR type = ANY($3))
        ORDER BY id
        LIMIT $4`,
      [query.dotId ?? null, query.after ?? 0, query.types ? [...query.types] : null, limit],
    );
    return rows.map(toStored);
  }

  /** The newest events of a Dot, returned oldest first (for `logs`-style tails). */
  async tail(dotId: string, count: number): Promise<StoredEvent[]> {
    const { rows } = await this.q.query<EventRow>(
      "SELECT * FROM (SELECT * FROM events WHERE dot_id = $1 ORDER BY id DESC LIMIT $2) t ORDER BY id",
      [dotId, Math.min(Math.max(count, 1), MAX_EVENT_PAGE)],
    );
    return rows.map(toStored);
  }

  async latestId(): Promise<number> {
    const { rows } = await this.q.query<{ id: string | null }>("SELECT max(id) AS id FROM events");
    return num(rows[0]?.id) ?? 0;
  }
}
