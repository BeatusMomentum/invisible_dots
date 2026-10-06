import { MAX_EVENT_PAGE, type StoredEvent } from "@invisible-dots/shared/browser";
import { describe, expect, it } from "vitest";
import { readEventLog } from "../src/lib/event-log";

function log(count: number): StoredEvent[] {
  return Array.from({ length: count }, (_, i) => ({ id: i + 1, dot_id: "d1", type: i % 3 === 0 ? "tool.called" : "agent.state", data: {}, source: "guest", guest_seq: i, created_at: "2026-03-10T12:00:00Z" }) as StoredEvent);
}

function clientOf(events: StoredEvent[]) {
  const asked: Array<{ after?: number; limit?: number; types?: readonly string[] }> = [];
  return {
    asked,
    // The control plane's filter: the types a caller names are kept in the database, the limit counts what is kept.
    async events(_dot: string, options: { after?: number; limit?: number; types?: readonly string[] } = {}) {
      asked.push(options);
      return events.filter((e) => e.id > (options.after ?? 0) && (!options.types || options.types.includes(e.type))).slice(0, options.limit);
    },
  };
}

describe("readEventLog", () => {
  it("asks the control plane for the types it reads and pages through what is kept, oldest first", async () => {
    const client = clientOf(log(5 * MAX_EVENT_PAGE + 500));
    const read = await readEventLog(client, "d1", { types: ["tool.called"] });
    expect(read).toHaveLength(Math.ceil((5 * MAX_EVENT_PAGE + 500) / 3));
    expect(read.every((event) => event.type === "tool.called")).toBe(true);
    expect(read.map((event) => event.id)).toEqual([...read.map((event) => event.id)].sort((a, b) => a - b));
    // Every page asked for the type: the log was not read in full to be cut here (a third of it is that type, so two pages).
    expect(client.asked.every((a) => a.types?.join() === "tool.called")).toBe(true);
    expect(client.asked).toHaveLength(2);
    expect(client.asked.map((a) => a.after)).toEqual([0, read[MAX_EVENT_PAGE - 1]!.id]);
  });

  it("also keeps only what the caller's predicate accepts, for what a type alone cannot say", async () => {
    const client = clientOf(log(30));
    const read = await readEventLog(client, "d1", { types: ["tool.called", "agent.state"], keep: (event) => event.id % 2 === 0 });
    expect(read.map((event) => event.id)).toEqual(Array.from({ length: 15 }, (_, i) => 2 * (i + 1)));
  });

  it("reads a log the way the control plane serves it: pages cut at the cap it publishes, never longer", async () => {
    // A control plane that clamps like the store does, and a log of three pages and a bit.
    const events = log(3 * MAX_EVENT_PAGE + 7);
    const asked: number[] = [];
    const client = {
      async events(_dot: string, options: { after?: number; limit?: number; types?: readonly string[] } = {}) {
        asked.push(options.limit ?? 0);
        return events.filter((e) => e.id > (options.after ?? 0)).slice(0, Math.min(options.limit ?? MAX_EVENT_PAGE, MAX_EVENT_PAGE));
      },
    };
    expect(await readEventLog(client, "d1", { types: ["tool.called", "agent.state"] })).toHaveLength(events.length);
    expect(asked).toEqual([MAX_EVENT_PAGE, MAX_EVENT_PAGE, MAX_EVENT_PAGE, MAX_EVENT_PAGE]);
  });

  it("returns an empty log as nothing", async () => {
    expect(await readEventLog(clientOf([]), "d1", { types: ["tool.called"] })).toEqual([]);
  });
});
