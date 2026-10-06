import type { StoredEvent } from "@invisible-dots/shared/browser";
import { describe, expect, it } from "vitest";
import { readEventLog } from "../src/lib/event-log";

function log(count: number): StoredEvent[] {
  return Array.from({ length: count }, (_, i) => ({ id: i + 1, dot_id: "d1", type: i % 3 === 0 ? "tool.called" : "agent.state", data: {}, source: "guest", guest_seq: i, created_at: "2026-03-10T12:00:00Z" }) as StoredEvent);
}

function clientOf(events: StoredEvent[]) {
  const asked: Array<{ after?: number; limit?: number }> = [];
  return {
    asked,
    async events(_dot: string, options: { after?: number; limit?: number } = {}) {
      asked.push(options);
      return events.filter((e) => e.id > (options.after ?? 0)).slice(0, options.limit);
    },
  };
}

describe("readEventLog", () => {
  it("keeps what the caller's predicate accepts, oldest first, from every page", async () => {
    const client = clientOf(log(2500));
    const read = await readEventLog(client, "d1", (event) => event.type === "tool.called");
    expect(read).toHaveLength(Math.ceil(2500 / 3));
    expect(read.every((event) => event.type === "tool.called")).toBe(true);
    expect(read.map((event) => event.id)).toEqual([...read.map((event) => event.id)].sort((a, b) => a - b));
    expect(client.asked.map((a) => a.after)).toEqual([0, 1000, 2000]);
  });

  it("asks for nothing more once told to stop, and returns what it had", async () => {
    const controller = new AbortController();
    const client = clientOf(log(3000));
    const events = client.events.bind(client);
    client.events = async (dot, options) => {
      const page = await events(dot, options);
      controller.abort();
      return page;
    };
    const read = await readEventLog(client, "d1", () => true, controller.signal);
    expect(client.asked).toHaveLength(1);
    expect(read).toEqual([]);
  });

  it("returns an empty log as nothing", async () => {
    expect(await readEventLog(clientOf([]), "d1", () => true)).toEqual([]);
  });
});
