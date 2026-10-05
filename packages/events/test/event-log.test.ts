import type { EventQuery } from "@invisible-dots/database";
import { createTestDatabase, testAdapters } from "@invisible-dots/database/testing";
import type { StoredEvent } from "@invisible-dots/shared";
import { describe, expect, it } from "vitest";
import { EventLog, StreamOverflowError, type EventStore } from "../src/index.js";

/** An in-memory store with the same semantics as the events table. */
class MemoryStore implements EventStore {
  rows: StoredEvent[] = [];
  #next = 1;

  async insertHost(dotId: string, type: string, data: Record<string, unknown>): Promise<StoredEvent> {
    const row: StoredEvent = {
      id: this.#next++,
      dot_id: dotId,
      type: type as StoredEvent["type"],
      data,
      source: "host",
      guest_seq: null,
      created_at: new Date().toISOString(),
    };
    this.rows.push(row);
    return row;
  }

  async list(q: EventQuery = {}): Promise<StoredEvent[]> {
    return this.rows
      .filter((r) => (q.dotId === undefined || r.dot_id === q.dotId) && r.id > (q.after ?? 0))
      .slice(0, q.limit ?? 500);
  }

  async tail(dotId: string, count: number): Promise<StoredEvent[]> {
    return this.rows.filter((r) => r.dot_id === dotId).slice(-count);
  }
}

async function take<T>(iterator: AsyncIterator<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  while (out.length < n) {
    const next = await iterator.next();
    if (next.done) break;
    out.push(next.value);
  }
  return out;
}

describe("EventLog fan-out", () => {
  it("delivers appended events to matching subscribers only", async () => {
    const log = new EventLog(new MemoryStore());
    const all: number[] = [];
    const onlyA: number[] = [];
    const stopAll = log.subscribe({}, (e) => all.push(e.id));
    log.subscribe({ dotId: "dot_a" }, (e) => onlyA.push(e.id));
    await log.appendHost("dot_a", "computer.started", {});
    await log.appendHost("dot_b", "computer.started", {});
    stopAll();
    await log.appendHost("dot_a", "computer.stopped", {});
    expect(all).toEqual([1, 2]);
    expect(onlyA).toEqual([1, 3]);
    expect(log.subscriberCount).toBe(1);
  });

  it("a throwing subscriber does not stop the others", async () => {
    const lines: string[] = [];
    const log = new EventLog(new MemoryStore(), (l) => lines.push(l));
    const got: number[] = [];
    log.subscribe({}, () => {
      throw new Error("bad listener");
    });
    log.subscribe({}, (e) => got.push(e.id));
    await log.appendHost("dot_a", "computer.started", {});
    expect(got).toEqual([1]);
    expect(lines[0]).toMatch(/bad listener/);
  });

  it("stream replays after a cursor, then follows live events without gaps or duplicates", async () => {
    const store = new MemoryStore();
    const log = new EventLog(store);
    await log.appendHost("dot_a", "computer.started", {});
    await log.appendHost("dot_b", "computer.started", {});
    await log.appendHost("dot_a", "computer.state", { state: "RUNNING" });

    const controller = new AbortController();
    const it = log.stream({ dotId: "dot_a" }, { after: 1, signal: controller.signal });
    const first = await take(it, 1);
    expect(first.map((e) => e.id)).toEqual([3]);

    // Published while the replay is done: arrives exactly once.
    await log.appendHost("dot_a", "computer.stopped", {});
    await log.appendHost("dot_b", "computer.stopped", {});
    await log.appendUserMessage("dot_a", { message_id: "msg_1", text: "hi" });
    const live = await take(it, 2);
    expect(live.map((e) => [e.id, e.type])).toEqual([
      [4, "computer.stopped"],
      [6, "user.message"],
    ]);
    controller.abort();
    expect((await it.next()).done).toBe(true);
    expect(log.subscriberCount).toBe(0);
  });

  it("keeps the origin of a channel message in the data of the user.message it logs, and none for any other", async () => {
    const store = new MemoryStore();
    const log = new EventLog(store);
    const origin = { channel: "telegram", binding_id: "chb_1", chat_id: "4242", external_id: "77" } as const;
    const fromChannel = await log.appendUserMessage("dot_a", { message_id: "msg_1", text: "hi", origin });
    const fromWeb = await log.appendUserMessage("dot_a", { message_id: "msg_2", text: "hello" });
    expect(fromChannel.data).toEqual({ message_id: "msg_1", text: "hi", origin });
    expect(fromWeb.data).toEqual({ message_id: "msg_2", text: "hello" });
    expect("origin" in fromWeb.data).toBe(false);
  });

  it("skips live copies of events the replay already returned", async () => {
    const store = new MemoryStore();
    const log = new EventLog(store);
    const it = log.stream({}, { after: 0 });
    // Inserted before the replay query runs but published after it: the
    // replay sees the row and the live path must not repeat it.
    const row = await store.insertHost("dot_a", "computer.started", {});
    const first = await it.next();
    log.publish(row);
    await log.appendHost("dot_a", "computer.stopped", {});
    const second = await it.next();
    expect(first.value?.id).toBe(row.id);
    expect(second.value?.type).toBe("computer.stopped");
    await it.return(undefined);
  });

  it("ends a stream that falls too far behind with StreamOverflowError", async () => {
    const log = new EventLog(new MemoryStore());
    const it = log.stream({}, { bufferLimit: 2 });
    const pending = it.next();
    await log.appendHost("dot_a", "computer.started", {});
    expect((await pending).value?.id).toBe(1);
    for (let i = 0; i < 4; i++) await log.appendHost("dot_a", "computer.started", {});
    await expect(take(it, 5)).rejects.toBeInstanceOf(StreamOverflowError);
  });
});

describe.each(testAdapters())("EventLog on %s", { timeout: 60_000 }, (kind) => {
  it("guest events are stored once and published by the caller after commit", async () => {
    const t = await createTestDatabase(kind);
    try {
      const { db } = t;
      const log = new EventLog(db.events);
      const seen: StoredEvent[] = [];
      log.subscribe({ dotId: "dot_x" }, (e) => seen.push(e));
      const event = {
        seq: 1,
        id: "evt-1",
        type: "task.progress" as const,
        ts: new Date().toISOString(),
        data: { task_id: "task_1", text: "halfway" },
      };
      const stored = await db.transaction((tx) => log.appendGuest(tx, "dot_x", event));
      expect(seen).toHaveLength(0);
      log.publish(stored!);
      expect(seen.map((e) => e.guest_seq)).toEqual([1]);
      expect(await db.transaction((tx) => log.appendGuest(tx, "dot_x", event))).toBeNull();
      const host = await log.appendHost("dot_x", "computer.state", { state: "STOPPED" });
      expect((await log.query({ dotId: "dot_x" })).map((e) => e.id)).toEqual([stored!.id, host.id]);
      expect((await log.tail("dot_x", 1))[0]?.id).toBe(host.id);
    } finally {
      await t.drop();
    }
  });
});
