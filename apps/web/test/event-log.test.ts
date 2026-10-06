import { MAX_EVENT_PAGE, type StoredEvent } from "@invisible-dots/shared/browser";
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
    const client = clientOf(log(2 * MAX_EVENT_PAGE + 500));
    const read = await readEventLog(client, "d1", (event) => event.type === "tool.called");
    expect(read).toHaveLength(Math.ceil((2 * MAX_EVENT_PAGE + 500) / 3));
    expect(read.every((event) => event.type === "tool.called")).toBe(true);
    expect(read.map((event) => event.id)).toEqual([...read.map((event) => event.id)].sort((a, b) => a - b));
    expect(client.asked.map((a) => a.after)).toEqual([0, MAX_EVENT_PAGE, 2 * MAX_EVENT_PAGE]);
  });

  it("reads a log the way the control plane serves it: pages cut at the cap it publishes, never longer", async () => {
    // A control plane that clamps like the store does, and a log of three pages and a bit.
    const events = log(3 * MAX_EVENT_PAGE + 7);
    const asked: number[] = [];
    const client = {
      async events(_dot: string, options: { after?: number; limit?: number } = {}) {
        asked.push(options.limit ?? 0);
        return events.filter((e) => e.id > (options.after ?? 0)).slice(0, Math.min(options.limit ?? MAX_EVENT_PAGE, MAX_EVENT_PAGE));
      },
    };
    expect(await readEventLog(client, "d1", () => true)).toHaveLength(events.length);
    expect(asked).toEqual([MAX_EVENT_PAGE, MAX_EVENT_PAGE, MAX_EVENT_PAGE, MAX_EVENT_PAGE]);
  });

  it("returns an empty log as nothing", async () => {
    expect(await readEventLog(clientOf([]), "d1", () => true)).toEqual([]);
  });
});
