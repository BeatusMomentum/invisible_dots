/**
 * One tool step (architecture sections 8.4 and 8.7): calls run one at a time,
 * each with its intent committed first; a crash between a call and its result
 * is resolved by the call's replay-safety; a model request is paid for at
 * most three times.
 */
import { afterEach, describe, expect, it } from "vitest";
import { baseConfig, completion, harness, inbound, sentMessages, type Harness } from "./helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const toolCall = (id: string, name: string, args: unknown) => ({ id, name, arguments: args });
const task = (id = "t1") => inbound("task.created", { task_id: id, description: "x", priority: 0 });
const toolMessages = (hh: Harness, thread = "t1") =>
  hh.store
    .listMessages<{ role: string; tool_call_id?: string; content: string }>(thread)
    .map((m) => m.message)
    .filter((m) => m.role === "tool");

function approvalId(hh: Harness, nth = 0): string {
  return (hh.events("approval.requested")[nth]!.data as { approval_id: string }).approval_id;
}

describe("a tool step", () => {
  it("allow, ask, allow: the third call waits for the decision", async () => {
    h = await harness();
    h.fake.push(
      completion({
        content: null,
        tool_calls: [
          toolCall("a", "files_read", { path: "x" }),
          toolCall("b", "browser_identity_delete", { identity_id: "old-abc123" }),
          toolCall("c", "files_list", { path: "." }),
        ],
      }),
      completion({ content: "done" }),
    );
    h.runtime.accept(task());
    await h.runtime.idle();
    expect(h.registry.calls.map((c) => c.name)).toEqual(["files_read"]);
    h.runtime.accept(inbound("approval.received", { approval_id: approvalId(h), decision: "approve" }));
    await h.runtime.idle();
    expect(h.registry.calls.map((c) => c.name)).toEqual(["files_read", "browser_identity_delete", "files_list"]);
    expect(toolMessages(h).map((m) => m.tool_call_id)).toEqual(["a", "b", "c"]);
  });

  it("a rejection note is in the next request", async () => {
    h = await harness();
    h.fake.push(completion({ content: null, tool_calls: [toolCall("d", "browser_identity_delete", { identity_id: "x-123456" })] }), completion({ content: "ok" }));
    h.runtime.accept(task());
    await h.runtime.idle();
    h.runtime.accept(inbound("approval.received", { approval_id: approvalId(h), decision: "reject", note: "not that one" }));
    await h.runtime.idle();
    expect(sentMessages(h.fake, 1).at(-1)).toEqual({ role: "tool", tool_call_id: "d", content: "Error: Rejected by the user: not that one" });
  });

  it("an approval note survives a 20,000-character result", async () => {
    h = await harness({ ...baseConfig, permissions: { "files.read": "ask" } });
    h.registry.handlers.set("files_read", () => ({ ok: true, text: "y".repeat(20_000) }));
    h.fake.push(completion({ content: null, tool_calls: [toolCall("r", "files_read", { path: "big" })] }), completion({ content: "ok" }));
    h.runtime.accept(task());
    await h.runtime.idle();
    h.runtime.accept(inbound("approval.received", { approval_id: approvalId(h), decision: "approve", note: "only the header matters" }));
    await h.runtime.idle();
    const content = sentMessages(h.fake, 1).at(-1)!.content as string;
    expect(content.endsWith("\n(The user approved this call with a note: only the header matters)")).toBe(true);
  });

  it("a failed state write stops the unit before any tool runs", async () => {
    let fail = true;
    h = await harness(baseConfig, {
      faults: {
        at(point) {
          if (point === "intent:writing" && fail) {
            fail = false;
            throw new Error("disk full");
          }
        },
      },
    });
    h.fake.push(completion({ content: null, tool_calls: [toolCall("e", "computer_exec", { command: "touch x" })] }));
    h.runtime.accept(task());
    await h.runtime.idle();
    expect(h.registry.calls).toEqual([]);
    expect(h.events("task.failed")[0]!.data).toMatchObject({ task_id: "t1", error: "disk full" });
  });

  it("rows written per tool call do not grow with the length of the task", async () => {
    h = await harness();
    for (let i = 0; i < 8; i++) h.fake.push(completion({ content: null, tool_calls: [toolCall(`c${i}`, "files_list", { path: `d${i}` })] }));
    h.fake.push(completion({ content: "done" }));
    const configRows = () => ["runtime_config", "active_unit"].filter((k) => h!.store.getConfig(k) !== undefined).length;
    h.runtime.accept(task());
    await h.runtime.idle();
    // Per call: one assistant message and one tool message; no snapshot of the thread anywhere.
    expect(h.store.countMessages("t1")).toBe(1 + 8 * 2 + 1);
    expect(h.events("tool.called")).toHaveLength(8);
    expect(h.store.listIntents("t1")).toEqual([]);
    expect(configRows()).toBe(1);
  });
});

describe("crash recovery of a tool step", () => {
  it("a tool result and its tool.called commit together or not at all", async () => {
    h = await harness(baseConfig, { crash: { point: "result:writing" } });
    h.fake.push(completion({ content: null, tool_calls: [toolCall("r", "files_read", { path: "a" })] }), completion({ content: "read" }));
    h.runtime.accept(task());
    await h.runtime.idle();
    await h.restart();
    await h.runtime.idle();
    expect(toolMessages(h)).toHaveLength(1);
    expect(h.events("tool.called")).toHaveLength(1);
    expect(h.events("task.completed")).toHaveLength(1);
  });

  it("a replay-safe approved call re-runs without a new approval", async () => {
    h = await harness({ ...baseConfig, permissions: { "files.read": "ask" } }, { crash: { point: "tool:executed" } });
    h.fake.push(completion({ content: null, tool_calls: [toolCall("r", "files_read", { path: "a" })] }), completion({ content: "read" }));
    h.runtime.accept(task());
    await h.runtime.idle();
    h.runtime.accept(inbound("approval.received", { approval_id: approvalId(h), decision: "approve" }));
    await h.runtime.idle();
    await h.restart();
    await h.runtime.idle();
    expect(h.registry.calls.map((c) => c.name)).toEqual(["files_read", "files_read"]);
    expect(h.events("approval.requested")).toHaveLength(1);
    expect(h.events("tool.called").map((e) => e.data)).toEqual([expect.objectContaining({ tool: "files_read", decision: "ask", ok: true })]);
    expect(h.events("task.completed")).toHaveLength(1);
  });

  it("a replay-safe call that crashes the agent twice is reported, not run a third time", async () => {
    h = await harness(baseConfig, { crash: { point: "tool:executed", times: 2 } });
    h.fake.push(completion({ content: null, tool_calls: [toolCall("r", "files_read", { path: "a" })] }), completion({ content: "gave up" }));
    h.runtime.accept(task());
    await h.runtime.idle();
    await h.restart();
    await h.runtime.idle();
    await h.restart();
    await h.runtime.idle();
    expect(h.registry.calls).toHaveLength(2);
    const result = toolMessages(h)[0]!.content;
    expect(result).toContain("This call was interrupted before its result was recorded.");
    expect(result).toContain("It stopped the agent twice");
    expect(h.events("tool.called")[0]!.data).toMatchObject({ tool: "files_read", ok: false, duration_ms: 0, interrupted: true });
  });

  it("an interrupted call's tool.called carries the permission and decision of its time", async () => {
    h = await harness({ ...baseConfig, permissions: { "computer.exec": "ask" } }, { crash: { point: "tool:executed" } });
    h.fake.push(completion({ content: null, tool_calls: [toolCall("e", "computer_exec", { command: "make deploy" })] }), completion({ content: "checked" }));
    h.runtime.accept(task());
    await h.runtime.idle();
    h.runtime.accept(inbound("approval.received", { approval_id: approvalId(h), decision: "approve" }));
    await h.runtime.idle();
    await h.restart();
    // The owner changed the policy while the agent was down.
    h.runtime.setConfig({ ...baseConfig, permissions: { "computer.exec": "deny" } });
    await h.runtime.idle();
    expect(h.registry.calls).toHaveLength(1);
    expect(h.events("tool.called")[0]!.data).toEqual({
      task_id: "t1",
      tool: "computer_exec",
      permission: "computer.exec",
      decision: "ask",
      ok: false,
      duration_ms: 0,
      interrupted: true,
    });
    const sent = sentMessages(h.fake, 1).at(-1)!.content as string;
    expect(sent).toContain("It may have taken effect, and it may still be running.");
    expect(sent).toContain("The user's approval was used by that attempt; calling it again asks again.");
    expect(h.store.listIntents("t1")).toEqual([]);
    expect(h.store.listApprovals()).toEqual([]);
  });

  it("two calls with the same provider id in different rounds are told apart", async () => {
    h = await harness({ ...baseConfig, permissions: { "computer.exec": "ask" } });
    h.fake.push(
      completion({ content: null, tool_calls: [toolCall("call_0", "computer_exec", { command: "one" })] }),
      completion({ content: null, tool_calls: [toolCall("call_0", "computer_exec", { command: "two" })] }),
      completion({ content: "both" }),
    );
    h.runtime.accept(task());
    await h.runtime.idle();
    h.runtime.accept(inbound("approval.received", { approval_id: approvalId(h, 0), decision: "approve" }));
    await h.runtime.idle();
    // The second round's call has the same id: it is a new call, and it asks again.
    expect(h.events("approval.requested")).toHaveLength(2);
    h.runtime.accept(inbound("approval.received", { approval_id: approvalId(h, 1), decision: "approve" }));
    await h.runtime.idle();
    expect(h.registry.calls.map((c) => (c.args as { command: string }).command)).toEqual(["one", "two"]);
    expect(h.events("task.completed")).toHaveLength(1);
  });

  it("three crashes before the assistant commit fail the unit", async () => {
    h = await harness(baseConfig, { crash: { point: "model:answered", times: 3 } });
    for (let i = 0; i < 4; i++) h.fake.push(completion({ content: "lost" }));
    h.runtime.accept(task());
    await h.runtime.idle();
    for (let i = 0; i < 3; i++) {
      await h.restart();
      await h.runtime.idle();
    }
    expect(h.fake.requests).toHaveLength(3);
    expect(h.events("task.failed")[0]!.data).toEqual({ task_id: "t1", error: "stopped: the model request failed to complete 3 times" });
  });
});
