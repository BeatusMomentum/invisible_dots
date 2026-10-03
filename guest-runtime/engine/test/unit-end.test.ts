/**
 * A unit that ends answers every call it left open, and the first start on
 * this engine repairs what the previous version left (architecture 8.7).
 */
import { afterEach, describe, expect, it } from "vitest";
import { FIRST_START_FLAG } from "../src/dot/intents.js";
import { NOT_EXECUTED_TEXT } from "../src/dot/request.js";
import { baseConfig, completion, harness, inbound, sentMessages, type Harness } from "./helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const toolCall = (id: string, name: string, args: unknown) => ({ id, name, arguments: args });
const call = (id: string, name: string, args: unknown) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

function failingIntentWrites(times = 1) {
  let left = times;
  return {
    at(point: string) {
      if (point === "intent:writing" && left > 0) {
        left--;
        throw new Error("disk full");
      }
    },
  };
}

type Msg = { role: string; tool_call_id?: string; content: unknown; tool_calls?: { id: string }[] };

/** Every call in a request is followed by its result. */
function pairedCalls(messages: Msg[]): boolean {
  const results = new Set(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  return messages.every((m) => (m.tool_calls ?? []).every((c) => results.has(c.id)));
}

describe("a unit that ends", () => {
  it("a unit that fails after the assistant commit answers its open calls", async () => {
    h = await harness(baseConfig, { faults: failingIntentWrites() });
    h.fake.push(completion({ content: null, tool_calls: [toolCall("a", "computer_exec", { command: "ls" }), toolCall("b", "files_list", { path: "." })] }));
    h.runtime.accept(inbound("task.created", { task_id: "t1", description: "x", priority: 0 }));
    await h.runtime.idle();
    expect(h.events("task.failed")).toHaveLength(1);
    const tools = h.store.listMessages<Msg>("t1").map((m) => m.message).filter((m) => m.role === "tool");
    expect(tools).toEqual([
      { role: "tool", tool_call_id: "a", content: NOT_EXECUTED_TEXT },
      { role: "tool", tool_call_id: "b", content: NOT_EXECUTED_TEXT },
    ]);
  });

  it("a chat turn after a failed turn sends no call without its result", async () => {
    h = await harness(baseConfig, { faults: failingIntentWrites() });
    h.fake.push(completion({ content: null, tool_calls: [toolCall("a", "files_list", { path: "." })] }), completion({ content: "fine now" }));
    h.runtime.accept(inbound("user.message", { text: "list it" }));
    await h.runtime.idle();
    h.runtime.accept(inbound("user.message", { text: "again?" }));
    await h.runtime.idle();
    expect(h.events("message.assistant").map((e) => (e.data as { text: string }).text)).toEqual(["I could not answer: disk full", "fine now"]);
    expect(pairedCalls(sentMessages(h.fake, 1) as Msg[])).toBe(true);
  });

  it("a cancelled task leaves no intents and no open call", async () => {
    h = await harness();
    h.fake.push(completion({ content: null, tool_calls: [toolCall("a", "files_list", { path: "." }), toolCall("d", "browser_identity_delete", { identity_id: "x-123456" })] }));
    h.runtime.accept(inbound("task.created", { task_id: "t1", description: "x", priority: 0 }));
    await h.runtime.idle();
    // As if a call of this thread had started and its process had died.
    const assistant = h.store.listMessages<Msg>("t1").find((m) => m.message.role === "assistant")!;
    h.store.recordIntent({ thread: "t1", messageId: assistant.id, callIndex: 1, toolCallId: "d", tool: "browser_identity_delete", permission: "browser.identity.delete", decision: "ask" });
    h.runtime.accept(inbound("system.event", { name: "task.cancelled", data: { task_id: "t1" } }));
    await h.runtime.idle();
    expect(h.store.listIntents("t1")).toEqual([]);
    expect(pairedCalls(h.store.listMessages<Msg>("t1").map((m) => m.message))).toBe(true);
    expect(h.runtime.stateAnswer()).toEqual({ state: "IDLE", current_task_id: null, pending_approval: null });
  });
});

describe("the first start on this engine", () => {
  /** A database as the previous version left it: the flag absent, the run record without its new fields. */
  async function previousVersion(): Promise<Harness> {
    const hh = await harness();
    await hh.runtime.stop();
    hh.store.deleteConfig(FIRST_START_FLAG);
    hh.store.insertTask({ id: "t1", description: "x", priority: 0 });
    hh.store.updateTask("t1", { status: "RUNNING", startedAt: "2026-01-01T00:00:00.000Z" });
    hh.store.appendMessage("t1", { role: "user", content: "New task: x" });
    hh.store.setConfig("active_unit", { kind: "task", taskId: "t1" });
    return hh;
  }

  it("the first-start pass marks only the first unanswered call", async () => {
    h = await previousVersion();
    h.store.appendMessage("t1", { role: "assistant", content: null, tool_calls: [call("a", "computer_exec", { command: "deploy" }), call("b", "files_list", { path: "." })] });
    h.fake.push(completion({ content: "checked" }));
    await h.restart();
    await h.runtime.idle();
    // The first call may have run: reported. The second provably never ran: it runs now.
    expect(h.registry.calls.map((c) => c.name)).toEqual(["files_list"]);
    expect(h.events("tool.called").map((e) => e.data)).toEqual([
      expect.objectContaining({ tool: "computer_exec", interrupted: true }),
      expect.objectContaining({ tool: "files_list", ok: true }),
    ]);
    expect(h.store.getConfig(FIRST_START_FLAG)).toBe(true);
  });

  it("a call whose approval was pending or replayed is not marked", async () => {
    h = await previousVersion();
    h.store.updateTask("t1", { status: "WAITING_APPROVAL" });
    h.store.appendMessage("t1", { role: "assistant", content: null, tool_calls: [call("d", "browser_identity_delete", { identity_id: "x-123456" })] });
    const base = { thread: "t1", taskId: "t1", tool: "browser_identity_delete", permission: "browser.identity.delete" as const, arguments: { identity_id: "x-123456" }, reason: "r" };
    h.store.insertPendingApproval({ ...base, approvalId: "apr_old", toolCallId: "d" });
    await h.restart();
    await h.runtime.idle();
    expect(h.store.listIntents("t1")).toEqual([]);
    expect(h.runtime.stateAnswer().pending_approval).toMatchObject({ approval_id: "apr_old" });

    // The decision arrived just before a stop, accepted but not applied by the previous version.
    await h.runtime.stop();
    h.store.deleteConfig(FIRST_START_FLAG);
    h.store.acceptInbound(inbound("approval.received", { approval_id: "apr_old", decision: "approve" }));
    h.fake.push(completion({ content: "deleted" }));
    await h.restart();
    await h.runtime.idle();
    expect(h.registry.calls.map((c) => c.name)).toEqual(["browser_identity_delete"]);
    expect(h.events("tool.called").map((e) => e.data)).toEqual([expect.objectContaining({ decision: "ask", ok: true })]);
  });

  it("a crash after the migration does not skip the pass", async () => {
    h = await previousVersion();
    h.store.deleteConfig("active_unit");
    h.store.updateTask("t1", { status: "FAILED" });
    h.store.appendMessage("t1", { role: "assistant", content: null, tool_calls: [call("z", "files_read", { path: "a" })] });
    // The schema is already at version 2: only the flag says whether the pass ran.
    expect(h.store.schemaVersion()).toBe(2);
    await h.restart();
    await h.runtime.idle();
    expect(h.store.listMessages<Msg>("t1").at(-1)!.message).toEqual({ role: "tool", tool_call_id: "z", content: NOT_EXECUTED_TEXT });
    expect(h.store.getConfig(FIRST_START_FLAG)).toBe(true);
  });
});
