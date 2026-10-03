/**
 * Defects the upstream engine had, kept as regression tests: each was found
 * in practice, and each is cheap to keep out.
 */
import { afterEach, describe, expect, it } from "vitest";
import { OpenRouterClient } from "@invisible-dots/openrouter-client";
import { DotRuntime } from "../src/dot/index.js";
import { FakeRegistry, completion, harness, inbound, sentMessages, type Harness } from "./helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("upstream defects that stay out", () => {
  it("the task seed carries no task id and no title header", async () => {
    h = await harness();
    h.fake.push(completion({ content: "done" }));
    h.runtime.accept(inbound("task.created", { task_id: "t17-overwrite", description: "Overwrite notes.txt with hello.", priority: 0 }));
    await h.runtime.idle();
    const seed = sentMessages(h.fake, 0)[1]!.content as string;
    expect(seed).toBe("New task: Overwrite notes.txt with hello.");
    expect(seed).not.toContain("t17-overwrite");
    expect(seed).not.toMatch(/^#/m);
  });

  it("JSON in the assistant's text runs nothing", async () => {
    h = await harness();
    const text = 'I will call it: {"name": "computer_exec", "arguments": {"command": "rm -rf /tmp/x"}}';
    h.fake.push(completion({ content: text }));
    h.runtime.accept(inbound("task.created", { task_id: "t1", description: "x", priority: 0 }));
    await h.runtime.idle();
    expect(h.registry.calls).toEqual([]);
    expect(h.events("tool.called")).toEqual([]);
    expect(h.events("task.completed")[0]!.data).toEqual({ task_id: "t1", summary: text });
  });

  it("a one-word task with an ask tool suspends and survives a restart", async () => {
    h = await harness();
    h.fake.push(completion({ content: null, tool_calls: [{ id: "d", name: "browser_identity_delete", arguments: { identity_id: "old-abc123" } }] }));
    h.runtime.accept(inbound("task.created", { task_id: "t1", description: "tidy", priority: 0 }));
    await h.runtime.idle();
    expect(h.runtime.state).toBe("WAITING_APPROVAL");
    const { approval_id } = h.events("approval.requested")[0]!.data as { approval_id: string };
    await h.restart();
    expect(h.runtime.stateAnswer().pending_approval).toMatchObject({ approval_id });
    h.fake.push(completion({ content: "tidied" }));
    h.runtime.accept(inbound("approval.received", { approval_id, decision: "approve" }));
    await h.runtime.idle();
    expect(h.registry.calls.map((c) => c.name)).toEqual(["browser_identity_delete"]);
    expect(h.events("task.completed")[0]!.data).toEqual({ task_id: "t1", summary: "tidied" });
  });

  it("the engine cannot be constructed without a store", () => {
    const options = { registry: new FakeRegistry(), model: new OpenRouterClient({ apiKey: "k" }) };
    expect(() => new DotRuntime(options as unknown as ConstructorParameters<typeof DotRuntime>[0])).toThrow("needs a store");
  });
});
