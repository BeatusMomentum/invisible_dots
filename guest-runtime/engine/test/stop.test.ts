/**
 * Stopping (architecture sections 5.3 and 8.7): a prepare-sleep or a
 * shutdown abandons a model request at once and gives a running tool the
 * stop grace to finish and record its result.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/dot/index.js";
import { completion, harness, inbound, sentMessages, type Harness } from "./helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const toolCall = (id: string, name: string, args: unknown) => ({ id, name, arguments: args });

describe("the stop grace", () => {
  it("a tool that finishes within the grace records its result", async () => {
    h = await harness(undefined, { stopGraceMs: 5_000 });
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    h.registry.handlers.set("computer_exec", async () => {
      started();
      await new Promise((r) => setTimeout(r, 150));
      return { ok: true, text: "exit_code: 0" };
    });
    h.fake.push(completion({ content: null, tool_calls: [toolCall("e", "computer_exec", { command: "make" })] }), completion({ content: "built" }));
    h.runtime.accept(inbound("task.created", { task_id: "t1", description: "x", priority: 0 }));
    await running;
    await h.runtime.suspend();
    expect(h.events("tool.called").map((e) => e.data)).toEqual([expect.objectContaining({ tool: "computer_exec", ok: true })]);
    expect(h.store.listIntents("t1")).toEqual([]);
    h.runtime.modelConfigured();
    await h.runtime.idle();
    expect(h.events("task.completed")[0]!.data).toEqual({ task_id: "t1", summary: "built" });
  });

  it("suspend, POST /secrets, a non-replay-safe call cut at the grace: the tool counter stays at 1 and the call is reported as interrupted", async () => {
    h = await harness(undefined, { stopGraceMs: 100 });
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    h.registry.handlers.set("computer_exec", async (_args: unknown, ctx: ToolContext) => {
      started();
      // dot-agentd's request is cancelled only when the signal fires; the command itself runs on.
      await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { ok: false, text: "computer_exec was cancelled" };
    });
    h.fake.push(completion({ content: null, tool_calls: [toolCall("e", "computer_exec", { command: "deploy" })] }), completion({ content: "checked" }));
    h.runtime.accept(inbound("task.created", { task_id: "t1", description: "x", priority: 0 }));
    await running;
    await h.runtime.suspend();
    expect(h.events("tool.called")).toEqual([]);
    expect(h.store.listIntents("t1")).toHaveLength(1);
    // The stop failed and the VM kept running: the host's READY procedure pushes the key again.
    h.runtime.modelConfigured();
    await h.runtime.idle();
    expect(h.registry.calls).toHaveLength(1);
    expect(h.events("tool.called")[0]!.data).toMatchObject({ tool: "computer_exec", ok: false, interrupted: true });
    expect(sentMessages(h.fake, 1).at(-1)!.content).toContain("It may have taken effect, and it may still be running.");
    expect(h.events("task.completed")[0]!.data).toEqual({ task_id: "t1", summary: "checked" });
  });
});
