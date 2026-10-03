/**
 * An inbound event is recorded and applied in one transaction, and an event
 * accepted but never applied (a crash between the two in older code) is
 * applied at the next start.
 */
import { afterEach, describe, expect, it } from "vitest";
import { baseConfig, completion, harness, inbound, type Harness } from "./helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** A fault seam that throws the `nth` time `point` is reached, as a failed write there would. */
function failOnceAt(point: string, nth = 1) {
  let seen = 0;
  return {
    at(p: string) {
      if (p === point && ++seen === nth) throw new Error(`injected fault at ${point}`);
    },
  };
}

const toolCall = (id: string, name: string, args: unknown) => ({ id, name, arguments: args });

describe("inbound events", () => {
  it("accept is all or nothing", async () => {
    h = await harness(baseConfig, { apiKey: false, faults: failOnceAt("accept:applied") });
    const ev = inbound("task.created", { task_id: "t1", description: "x", priority: 0 });
    expect(() => h!.runtime.accept(ev)).toThrow(/injected fault/);
    expect(h.store.pendingInbound()).toEqual([]);
    expect(h.runtime.tasks.get("t1")).toBeUndefined();
    // The host sends it again, since the outcome of the send was unknown.
    expect(h.runtime.accept(ev)).toBe(true);
    expect(h.runtime.tasks.get("t1")?.status).toBe("PENDING");
  });

  it("an unprocessed approval.received is applied at start", async () => {
    h = await harness();
    h.fake.push(completion({ content: null, tool_calls: [toolCall("d1", "browser_identity_delete", { identity_id: "a-123456" })] }));
    h.runtime.accept(inbound("task.created", { task_id: "t1", description: "x", priority: 0 }));
    await h.runtime.idle();
    const { approval_id } = h.events("approval.requested")[0]!.data as { approval_id: string };
    await h.runtime.stop();
    // What the older three-statement accept could leave behind: the row, never applied.
    h.store.acceptInbound(inbound("approval.received", { approval_id, decision: "approve" }));
    h.fake.push(completion({ content: "deleted" }));
    await h.restart();
    await h.runtime.idle();
    expect(h.registry.calls.map((c) => c.name)).toEqual(["browser_identity_delete"]);
    expect(h.events("task.completed")[0]!.data).toMatchObject({ task_id: "t1", summary: "deleted" });
    expect(h.store.pendingInbound()).toEqual([]);
  });

  it("an unprocessed task.created is queued at start", async () => {
    h = await harness();
    await h.runtime.stop();
    h.store.acceptInbound(inbound("task.created", { task_id: "late", description: "x", priority: 0 }));
    h.fake.push(completion({ content: "done" }));
    await h.restart();
    await h.runtime.idle();
    expect(h.events("task.completed")[0]!.data).toMatchObject({ task_id: "late", summary: "done" });
  });

  it("a second decision for the same approval is ignored, and still marked processed", async () => {
    h = await harness();
    h.fake.push(completion({ content: null, tool_calls: [toolCall("d1", "browser_identity_delete", { identity_id: "a-123456" })] }));
    h.runtime.accept(inbound("task.created", { task_id: "t1", description: "x", priority: 0 }));
    await h.runtime.idle();
    const { approval_id } = h.events("approval.requested")[0]!.data as { approval_id: string };
    h.fake.push(completion({ content: "kept it" }));
    h.runtime.accept(inbound("approval.received", { approval_id, decision: "reject", note: "keep" }));
    h.runtime.accept(inbound("approval.received", { approval_id, decision: "approve" }));
    await h.runtime.idle();
    expect(h.registry.calls).toEqual([]);
    expect(h.store.pendingInbound()).toEqual([]);
    expect(h.events("task.completed")[0]!.data).toMatchObject({ summary: "kept it" });
  });

  it("a cancel that rolls back has not aborted the unit", async () => {
    h = await harness(baseConfig, { faults: failOnceAt("accept:applied", 2) });
    let release!: () => void;
    h.fake.push({ ...completion({ content: "finished anyway" }), hold: new Promise<void>((resolve) => (release = resolve)) });
    h.runtime.accept(inbound("task.created", { task_id: "slow", description: "x", priority: 0 }));
    // The second accept, the cancel, fails before its transaction commits.
    await h.fake.waitForRequests(1);
    expect(() => h!.runtime.accept(inbound("system.event", { name: "task.cancelled", data: { task_id: "slow" } }))).toThrow(/injected/);
    release();
    await h.runtime.idle();
    expect(h.runtime.tasks.get("slow")!.status).toBe("COMPLETED");
    expect(h.events("task.completed")[0]!.data).toMatchObject({ task_id: "slow", summary: "finished anyway" });
  });
});
