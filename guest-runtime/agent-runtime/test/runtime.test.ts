import { afterEach, describe, expect, it } from "vitest";
import { completion, harness, inbound, sentMessages, baseConfig, type Harness } from "./helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

function toolCall(id: string, name: string, args: unknown) {
  return { id, name, arguments: args };
}

describe("AgentRuntime: chat", () => {
  it("answers a user message with message.assistant in reply to it", async () => {
    h = await harness();
    h.fake.push(completion({ content: "Hello, I am fare-watch." }));
    const ev = inbound("user.message", { text: "who are you?" });
    expect(h.runtime.accept(ev)).toBe(true);
    await h.runtime.idle();

    const answers = h.events("message.assistant");
    expect(answers).toHaveLength(1);
    expect(answers[0]!.data).toEqual({ text: "Hello, I am fare-watch.", in_reply_to: ev.id });
    expect(h.states()).toEqual(["IDLE", "THINKING", "PLANNING", "DONE", "IDLE"]);

    const messages = sentMessages(h.fake, 0);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("You are fare-watch");
    expect(messages[0]!.content).toContain("Find the cheapest fare.");
    expect(messages[0]!.content).toContain("Write findings to ~/workspace/fares.csv.");
    expect(messages.at(-1)).toEqual({ role: "user", content: "who are you?" });
    expect(h.fake.requests[0]!.body.model).toBe("test/model");

    // A redelivered event is accepted once.
    expect(h.runtime.accept(ev)).toBe(false);
    await h.runtime.idle();
    expect(h.fake.requests).toHaveLength(1);
  });

  it("keeps one conversation across chat turns", async () => {
    h = await harness();
    h.fake.push(completion({ content: "first answer" }), completion({ content: "second answer" }));
    h.runtime.accept(inbound("user.message", { text: "one" }));
    h.runtime.accept(inbound("user.message", { text: "two" }));
    await h.runtime.idle();
    const second = sentMessages(h.fake, 1).slice(1);
    expect(second).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "two" },
    ]);
  });

  it("lists browser identities and memory keys in the system prompt", async () => {
    h = await harness();
    h.store.putIdentity({
      id: "shop-x1y2z3",
      name: "Shop",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: null,
      status: "available",
      profilePath: "/home/dot/browsers/shop-x1y2z3/profile",
    });
    h.store.remember("cheapest-day", "Tuesday");
    h.fake.push(completion({ content: "ok" }));
    h.runtime.accept(inbound("user.message", { text: "status?" }));
    await h.runtime.idle();
    const system = sentMessages(h.fake, 0)[0]!.content as string;
    expect(system).toContain('shop-x1y2z3 ("Shop"), available, never used');
    expect(system).toContain("- cheapest-day");
  });

  it("waits for the OpenRouter key instead of failing, then answers", async () => {
    h = await harness(baseConfig, { apiKey: false });
    h.runtime.accept(inbound("user.message", { text: "hi" }));
    await h.runtime.idle();
    expect(h.fake.requests).toHaveLength(0);
    h.model.setApiKey("pushed-later");
    h.fake.push(completion({ content: "now I can talk" }));
    h.runtime.modelConfigured();
    await h.runtime.idle();
    expect(h.events("message.assistant")[0]!.data).toMatchObject({ text: "now I can talk" });
  });

  it("tells the user when the model cannot be reached", async () => {
    h = await harness();
    h.fake.push({ status: 402, body: { error: { message: "Insufficient credits", code: 402 } } });
    h.runtime.accept(inbound("user.message", { text: "hi" }));
    await h.runtime.idle();
    const text = (h.events("message.assistant")[0]!.data as { text: string }).text;
    expect(text).toContain("insufficient_credits");
    expect(h.runtime.state).toBe("IDLE");
  });
});

describe("AgentRuntime: tasks and tools", () => {
  it("runs a tool call and completes with the final answer as summary", async () => {
    h = await harness();
    h.registry.handlers.set("files_read", () => ({ ok: true, text: "date,fare\n2026-03-03,39" }));
    h.fake.push(
      completion({ content: "Reading the file.", tool_calls: [toolCall("c1", "files_read", { path: "workspace/fares.csv" })] }, {
        prompt_tokens: 100,
        completion_tokens: 10,
        cost: 0.001,
      }),
      completion({ content: "Cheapest day is 2026-03-03 at 39 EUR." }, { prompt_tokens: 150, completion_tokens: 12, cost: 0.002 }),
    );
    h.runtime.accept(inbound("task.created", { task_id: "task_1", description: "Find the cheapest day", priority: 0 }));
    await h.runtime.idle();

    expect(h.registry.calls).toEqual([{ name: "files_read", args: { path: "workspace/fares.csv" }, taskId: "task_1" }]);
    const types = h.events().map((e) => e.type);
    expect(types).toContain("task.started");
    expect(h.events("task.progress")[0]!.data).toEqual({ task_id: "task_1", text: "Reading the file." });
    expect(h.events("tool.called")[0]!.data).toMatchObject({
      task_id: "task_1",
      tool: "files_read",
      permission: "files.read",
      decision: "allow",
      ok: true,
    });
    expect(h.events("task.completed")[0]!.data).toEqual({ task_id: "task_1", summary: "Cheapest day is 2026-03-03 at 39 EUR." });
    expect(h.states()).toEqual(["IDLE", "THINKING", "PLANNING", "EXECUTING", "THINKING", "PLANNING", "DONE", "IDLE"]);

    const second = sentMessages(h.fake, 1);
    expect(second[0]!.content).toContain("You are working on task task_1");
    expect(second.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: "date,fare\n2026-03-03,39" });

    const task = h.runtime.tasks.get("task_1")!;
    expect(task.status).toBe("COMPLETED");
    expect(task.steps).toBe(2);
    expect(task.usage).toMatchObject({ prompt_tokens: 250, completion_tokens: 22, requests: 2 });
    expect(task.usage!.cost).toBeCloseTo(0.003);
  });

  it("seeds a task with the recent conversation", async () => {
    h = await harness();
    h.fake.push(completion({ content: "noted" }), completion({ content: "done" }));
    h.runtime.accept(inbound("user.message", { text: "Only look at morning flights." }));
    await h.runtime.idle();
    h.runtime.accept(inbound("task.created", { task_id: "t2", description: "Check fares", priority: 0 }));
    await h.runtime.idle();
    const seed = sentMessages(h.fake, 1)[1]!.content as string;
    expect(seed).toContain("Owner: Only look at morning flights.");
    expect(seed).toContain("New task: Check fares");
  });

  it("runs queued tasks by priority, then creation order", async () => {
    // Without a key nothing runs, so all three are queued before the first starts.
    h = await harness(baseConfig, { apiKey: false });
    h.fake.push(completion({ content: "a" }), completion({ content: "b" }), completion({ content: "c" }));
    h.runtime.accept(inbound("task.created", { task_id: "low", description: "low", priority: 0 }));
    h.runtime.accept(inbound("task.created", { task_id: "high", description: "high", priority: 5 }));
    h.runtime.accept(inbound("task.created", { task_id: "low2", description: "low2", priority: 0 }));
    await h.runtime.idle();
    expect(h.events("task.started")).toEqual([]);
    h.model.setApiKey("k");
    h.runtime.modelConfigured();
    await h.runtime.idle();
    const order = h.events("task.started").map((e) => (e.data as { task_id: string }).task_id);
    expect(order).toEqual(["high", "low", "low2"]);
  });

  it("sends tool images to the model as image_url parts after the tool results", async () => {
    h = await harness();
    h.registry.handlers.set("computer_screenshot", () => ({
      ok: true,
      text: "screenshot taken",
      images: [{ mimeType: "image/png", base64: "iVBORw0KGgo=" }],
    }));
    h.fake.push(
      completion({ content: null, tool_calls: [toolCall("s1", "computer_screenshot", {})] }),
      completion({ content: "I see the desktop." }),
    );
    h.runtime.accept(inbound("user.message", { text: "what is on screen?" }));
    await h.runtime.idle();
    const sent = sentMessages(h.fake, 1);
    expect(sent.at(-2)).toEqual({ role: "tool", tool_call_id: "s1", content: "screenshot taken" });
    expect(sent.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Images returned by the tool calls above:" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      ],
    });
  });

  it("cuts long tool results", async () => {
    h = await harness();
    h.registry.handlers.set("files_read", () => ({ ok: true, text: "y".repeat(20_000) }));
    h.fake.push(completion({ content: null, tool_calls: [toolCall("c1", "files_read", { path: "big" })] }), completion({ content: "ok" }));
    h.runtime.accept(inbound("user.message", { text: "read it" }));
    await h.runtime.idle();
    const tool = sentMessages(h.fake, 1).at(-1)!;
    expect((tool.content as string).length).toBeLessThan(12_100);
    expect(tool.content).toContain("truncated: 8000 more characters");
  });

  it("turns a throwing tool and bad arguments into error results", async () => {
    h = await harness();
    h.registry.handlers.set("files_read", () => {
      throw new Error("disk on fire");
    });
    h.fake.push(
      completion({
        content: null,
        tool_calls: [toolCall("c1", "files_read", { path: "x" }), toolCall("c2", "files_list", "{broken")],
      }),
      completion({ content: "gave up" }),
    );
    h.runtime.accept(inbound("user.message", { text: "go" }));
    await h.runtime.idle();
    const sent = sentMessages(h.fake, 1);
    expect(sent.at(-2)!.content).toBe("Error: files_read failed: disk on fire");
    expect(sent.at(-1)!.content).toContain("Invalid arguments for files_list");
    expect(h.registry.calls.map((c) => c.name)).toEqual(["files_read"]);
    expect(h.events("tool.called").map((e) => (e.data as { ok: boolean }).ok)).toEqual([false, false]);
  });

  it("lets tools emit outbound events", async () => {
    h = await harness();
    h.registry.handlers.set("memory_remember", (args, ctx) => {
      ctx.emit({ type: "memory.written", data: { key: (args as { key: string }).key } });
      return { ok: true, text: "remembered" };
    });
    h.fake.push(
      completion({ content: null, tool_calls: [toolCall("m1", "memory_remember", { key: "k1", content: "v" })] }),
      completion({ content: "stored" }),
    );
    h.runtime.accept(inbound("user.message", { text: "remember" }));
    await h.runtime.idle();
    expect(h.events("memory.written")[0]!.data).toEqual({ key: "k1" });
  });
});

describe("AgentRuntime: policy", () => {
  it("denies a call without running it and tells the model why", async () => {
    h = await harness({ ...baseConfig, permissions: { "computer.exec": "deny" } });
    h.fake.push(
      completion({ content: null, tool_calls: [toolCall("e1", "computer_exec", { command: "rm -rf /" })] }),
      completion({ content: "I am not allowed to run commands." }),
    );
    h.runtime.accept(inbound("task.created", { task_id: "t", description: "clean up", priority: 0 }));
    await h.runtime.idle();
    expect(h.registry.calls).toEqual([]);
    expect(sentMessages(h.fake, 1).at(-1)!.content).toBe(
      "Error: Denied by policy: computer.exec is denied by the Dot's configuration.",
    );
    expect(h.events("tool.called")[0]!.data).toMatchObject({ decision: "deny", ok: false, duration_ms: 0 });
    expect(h.events("task.completed")).toHaveLength(1);
  });

  it("denies a tool name nobody offered", async () => {
    h = await harness({ ...baseConfig, browser: { identities: { managed_by_dot: false } } });
    h.fake.push(
      completion({ content: null, tool_calls: [toolCall("d1", "browser_identity_create", { name: "x" })] }),
      completion({ content: "ok" }),
    );
    h.runtime.accept(inbound("user.message", { text: "make one" }));
    await h.runtime.idle();
    expect(h.registry.calls).toEqual([]);
    expect(h.events("tool.called")[0]!.data).toMatchObject({ tool: "browser_identity_create", permission: "", decision: "deny" });
    expect(h.fake.requests[0]!.body.tools as unknown[]).not.toContainEqual(
      expect.objectContaining({ function: expect.objectContaining({ name: "browser_identity_create" }) }),
    );
  });

  it("asks, waits, and runs the call once approved", async () => {
    h = await harness();
    h.fake.push(
      completion({
        content: "This identity is no longer needed.",
        tool_calls: [toolCall("d1", "browser_identity_delete", { identity_id: "old-abc123" })],
      }),
      completion({ content: "Deleted the old identity." }),
    );
    h.runtime.accept(inbound("task.created", { task_id: "t1", description: "tidy identities", priority: 0 }));
    await h.runtime.idle();

    expect(h.registry.calls).toEqual([]);
    expect(h.runtime.state).toBe("WAITING_APPROVAL");
    const requested = h.events("approval.requested")[0]!.data as { approval_id: string };
    expect(requested).toMatchObject({
      task_id: "t1",
      tool: "browser_identity_delete",
      permission: "browser.identity.delete",
      arguments: { identity_id: "old-abc123" },
    });
    expect((requested as unknown as { reason: string }).reason).toContain("This identity is no longer needed.");
    expect(h.runtime.stateAnswer()).toMatchObject({
      state: "WAITING_APPROVAL",
      current_task_id: "t1",
      pending_approval: { approval_id: requested.approval_id },
    });
    expect(h.runtime.tasks.get("t1")!.status).toBe("WAITING_APPROVAL");

    h.runtime.accept(inbound("approval.received", { approval_id: requested.approval_id, decision: "approve" }));
    await h.runtime.idle();

    expect(h.registry.calls.map((c) => c.name)).toEqual(["browser_identity_delete"]);
    expect(h.events("tool.called")[0]!.data).toMatchObject({ decision: "ask", ok: true });
    expect(h.events("task.completed")[0]!.data).toEqual({ task_id: "t1", summary: "Deleted the old identity." });
    expect(h.runtime.stateAnswer()).toEqual({ state: "IDLE", current_task_id: null, pending_approval: null });
    expect(h.states()).toEqual([
      "IDLE",
      "THINKING",
      "PLANNING",
      "WAITING_APPROVAL",
      "EXECUTING",
      "THINKING",
      "PLANNING",
      "DONE",
      "IDLE",
    ]);
  });

  it("returns a rejection with the note to the model, which gives up", async () => {
    h = await harness();
    h.fake.push(
      completion({ content: null, tool_calls: [toolCall("d1", "browser_identity_delete", { identity_id: "old-abc123" })] }),
      completion({ content: "The user does not want it deleted; leaving it." }),
    );
    h.runtime.accept(inbound("task.created", { task_id: "t1", description: "tidy", priority: 0 }));
    await h.runtime.idle();
    const { approval_id } = h.events("approval.requested")[0]!.data as { approval_id: string };
    h.runtime.accept(inbound("approval.received", { approval_id, decision: "reject", note: "keep it for now" }));
    await h.runtime.idle();

    expect(h.registry.calls).toEqual([]);
    expect(sentMessages(h.fake, 1).at(-1)!.content).toBe("Error: The call was rejected by the user: keep it for now");
    expect(h.events("tool.called")[0]!.data).toMatchObject({ decision: "ask", ok: false });
    expect(h.events("task.completed")[0]!.data).toMatchObject({ summary: "The user does not want it deleted; leaving it." });
  });

  it("ignores an approval it does not know", async () => {
    h = await harness();
    h.runtime.accept(inbound("approval.received", { approval_id: "apr_nope", decision: "approve" }));
    await h.runtime.idle();
    expect(h.fake.requests).toHaveLength(0);
  });
});

describe("AgentRuntime: limits and lifecycle", () => {
  it("fails a task that exceeds max_steps_per_task", async () => {
    h = await harness({ ...baseConfig, limits: { max_steps_per_task: 2 } });
    for (let i = 0; i < 3; i++) h.fake.push(completion({ content: null, tool_calls: [toolCall(`c${i}`, "files_list", { path: "." })] }));
    h.runtime.accept(inbound("task.created", { task_id: "loop", description: "loop forever", priority: 0 }));
    await h.runtime.idle();
    expect(h.fake.requests).toHaveLength(2);
    const failed = h.events("task.failed")[0]!.data as { task_id: string; error: string };
    expect(failed.task_id).toBe("loop");
    expect(failed.error).toContain("max_steps_per_task is 2");
    expect(h.runtime.tasks.get("loop")!.status).toBe("FAILED");
    expect(h.runtime.state).toBe("IDLE");
  });

  it("cancels a task through system.event task.cancelled while it waits for approval", async () => {
    h = await harness();
    h.fake.push(completion({ content: null, tool_calls: [toolCall("d1", "browser_identity_delete", { identity_id: "a-123456" })] }));
    h.runtime.accept(inbound("task.created", { task_id: "t1", description: "x", priority: 0 }));
    await h.runtime.idle();
    h.runtime.accept(inbound("system.event", { name: "task.cancelled", data: { task_id: "t1" } }));
    await h.runtime.idle();
    expect(h.runtime.tasks.get("t1")!.status).toBe("CANCELLED");
    expect(h.runtime.stateAnswer()).toEqual({ state: "IDLE", current_task_id: null, pending_approval: null });
  });

  it("cancels a task whose model request is in flight", async () => {
    h = await harness();
    h.fake.push({ ...completion({ content: "too late" }), delayMs: 300 }, completion({ content: "next task done" }));
    h.runtime.accept(inbound("task.created", { task_id: "slow", description: "x", priority: 0 }));
    h.runtime.accept(inbound("task.created", { task_id: "next", description: "y", priority: 0 }));
    await new Promise((r) => setTimeout(r, 50));
    h.runtime.accept(inbound("system.event", { name: "task.cancelled", data: { task_id: "slow" } }));
    await h.runtime.idle();
    expect(h.runtime.tasks.get("slow")!.status).toBe("CANCELLED");
    expect(h.events("task.completed").map((e) => (e.data as { task_id: string }).task_id)).toEqual(["next"]);
  });

  it("keeps the outbox seq and the pending approval across a restart", async () => {
    h = await harness();
    h.fake.push(completion({ content: null, tool_calls: [toolCall("d1", "browser_identity_delete", { identity_id: "a-123456" })] }));
    h.runtime.accept(inbound("task.created", { task_id: "t1", description: "x", priority: 0 }));
    await h.runtime.idle();
    const lastSeq = h.store.lastSeq();
    const { approval_id } = h.events("approval.requested")[0]!.data as { approval_id: string };

    await h.restart();
    // The restart announces the state again, after the old events.
    const restartState = h.store.readAfter(lastSeq);
    expect(restartState[0]).toMatchObject({ seq: lastSeq + 1, type: "agent.state", data: { state: "WAITING_APPROVAL" } });
    expect(h.runtime.stateAnswer()).toMatchObject({ current_task_id: "t1", pending_approval: { approval_id } });

    h.fake.push(completion({ content: "deleted after the reboot" }));
    h.runtime.accept(inbound("approval.received", { approval_id, decision: "approve" }));
    await h.runtime.idle();
    expect(h.registry.calls.map((c) => c.name)).toEqual(["browser_identity_delete"]);
    expect(h.events("task.completed")[0]!.data).toMatchObject({ task_id: "t1", summary: "deleted after the reboot" });
  });

  it("resumes a task that was RUNNING when the agent stopped", async () => {
    h = await harness();
    h.fake.push(completion({ content: null, tool_calls: [toolCall("c1", "files_read", { path: "a" })] }), {
      ...completion({ content: "never seen" }),
      delayMs: 400,
    });
    h.runtime.accept(inbound("task.created", { task_id: "t1", description: "x", priority: 0 }));
    // Let the first turn and the tool run, then stop during the second model request.
    await new Promise((r) => setTimeout(r, 150));
    expect(h.fake.requests).toHaveLength(2);
    await h.restart();
    expect(h.runtime.tasks.get("t1")!.status).toBe("RUNNING");

    h.fake.push(completion({ content: "finished after restart" }));
    await h.runtime.idle();
    expect(h.registry.calls).toHaveLength(1);
    expect(h.events("task.started")).toHaveLength(1);
    expect(h.events("task.completed")[0]!.data).toMatchObject({ task_id: "t1", summary: "finished after restart" });
    // The resumed turn sees the tool result from before the restart.
    expect(sentMessages(h.fake, h.fake.requests.length - 1).at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });

  it("answers a chat message that arrived just before a restart", async () => {
    h = await harness(baseConfig, { apiKey: false });
    h.runtime.accept(inbound("user.message", { text: "are you there?" }));
    await h.restart();
    h.model.setApiKey("k");
    h.fake.push(completion({ content: "yes" }));
    h.runtime.modelConfigured();
    await h.runtime.idle();
    expect(h.events("message.assistant")[0]!.data).toMatchObject({ text: "yes" });
    expect(sentMessages(h.fake, 0).filter((m) => m.role === "user")).toHaveLength(1);
  });
});
