/**
 * Loop defences and the cost cap (architecture section 8.2): each ends the
 * unit with a reason the owner can read, and each holds across a restart.
 */
import { afterEach, describe, expect, it } from "vitest";
import { LOOP_NOTICE, LOOP_STOP_TEXT } from "../src/agent/loop-detector.js";
import { TRUNCATED_NOTICE } from "../src/agent/runner.js";
import { bench, call, type Bench } from "./bench.js";
import { baseConfig, completion, harness, inbound, sentMessages, type Harness } from "./helpers.js";

let b: Bench | undefined;
let h: Harness | undefined;
afterEach(async () => {
  b?.close();
  b = undefined;
  await h?.close();
  h = undefined;
});

const toolCall = (id: string, name: string, args: unknown) => ({ id, name, arguments: args });
const notices = (messages: readonly { role: string; content: unknown }[]) => messages.filter((m) => m.role === "user" && m.content === LOOP_NOTICE).length;

describe("loop defences", () => {
  it("three identical rounds with identical results stop the task", async () => {
    b = bench();
    let n = 0;
    b.model.respond = () => ({ calls: [call(`c${n++}`, "files_list", { path: "." })] });
    const outcome = await b.run();
    expect(outcome).toEqual({ status: "failed", error: LOOP_STOP_TEXT });
    // Three rounds, the notice, a fourth identical round, then the stop.
    expect(b.model.requests).toHaveLength(4);
    expect(notices(b.thread())).toBe(1);
  });

  it("identical calls with changing results do not", async () => {
    b = bench();
    let polled = 0;
    b.registry.handlers.set("files_list", () => ({ ok: true, text: `entries: ${polled++}` }));
    let n = 0;
    b.model.respond = () => (n < 6 ? { calls: [call(`c${n++}`, "files_list", { path: "." })] } : { text: "it settled" });
    expect(await b.run()).toEqual({ status: "completed", output: "it settled" });
    expect(notices(b.thread())).toBe(0);
  });

  it("two chat turns that each repeat once do not fail", async () => {
    h = await harness();
    const twice = (prefix: string) => [
      completion({ content: null, tool_calls: [toolCall(`${prefix}1`, "files_list", { path: "." })] }),
      completion({ content: null, tool_calls: [toolCall(`${prefix}2`, "files_list", { path: "." })] }),
    ];
    h.fake.push(...twice("a"), completion({ content: "first" }), ...twice("b"), completion({ content: "second" }));
    h.runtime.accept(inbound("user.message", { text: "list" }));
    await h.runtime.idle();
    h.runtime.accept(inbound("user.message", { text: "list again" }));
    await h.runtime.idle();
    expect(h.events("message.assistant").map((e) => (e.data as { text: string }).text)).toEqual(["first", "second"]);
  });

  it("the streak survives a restart", async () => {
    h = await harness(baseConfig, { crash: { point: "model:answered", after: 3 } });
    for (let i = 0; i < 6; i++) h.fake.push(completion({ content: null, tool_calls: [toolCall(`c${i}`, "files_list", { path: "." })] }));
    h.runtime.accept(inbound("task.created", { task_id: "t1", description: "x", priority: 0 }));
    await h.runtime.idle();
    await h.restart();
    await h.runtime.idle();
    expect(h.events("task.failed")[0]!.data).toEqual({ task_id: "t1", error: LOOP_STOP_TEXT });
    expect(notices(h.store.listMessages<{ role: string; content: unknown }>("t1").map((m) => m.message))).toBe(1);
  });

  it("a truncated response runs no tools", async () => {
    b = bench();
    b.model.script.push(
      () => ({ text: "I will write it all", calls: [call("w", "files_write", { path: "a", content: "half" })], finishReason: "length" }),
      () => ({ text: "short answer" }),
    );
    expect(await b.run()).toEqual({ status: "completed", output: "short answer" });
    expect(b.registry.calls).toEqual([]);
    expect(b.thread().slice(1, 3)).toEqual([
      { role: "assistant", content: "I will write it all" },
      { role: "user", content: TRUNCATED_NOTICE },
    ]);
    expect(b.model.requests[1]!.messages.at(-1)).toEqual({ role: "user", content: TRUNCATED_NOTICE });
  });
});

describe("the cost cap", () => {
  it("the cost cap stops before the next request", async () => {
    b = bench({ ...baseConfig, limits: { max_cost_per_task_usd: 0.01 } });
    let n = 0;
    b.model.respond = () => ({ calls: [call(`c${n}`, "files_read", { path: `p${n++}` })], usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0.006 } });
    expect(await b.run()).toEqual({ status: "failed", error: "stopped: cost cap reached (0.0120 USD of 0.01)" });
    expect(b.model.requests).toHaveLength(2);
  });

  it("the cost cap survives a restart", async () => {
    h = await harness({ ...baseConfig, limits: { max_cost_per_task_usd: 0.01 } }, { crash: { point: "tool:executed" } });
    h.fake.push(
      completion({ content: null, tool_calls: [toolCall("r", "files_read", { path: "a" })] }, { prompt_tokens: 10, completion_tokens: 1, cost: 0.012 }),
      completion({ content: "never asked" }),
    );
    h.runtime.accept(inbound("task.created", { task_id: "t1", description: "x", priority: 0 }));
    await h.runtime.idle();
    await h.restart();
    await h.runtime.idle();
    expect(h.fake.requests).toHaveLength(1);
    expect(h.events("task.failed")[0]!.data).toEqual({ task_id: "t1", error: "stopped: cost cap reached (0.0120 USD of 0.01)" });
    expect(sentMessages(h.fake, 0).length).toBeGreaterThan(0);
  });
});
