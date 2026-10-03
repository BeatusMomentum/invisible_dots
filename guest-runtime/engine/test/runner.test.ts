/**
 * The runner on its own: a unit driven against a real `dot.db`, a scripted
 * model and a counting registry, without the HTTP fake or the driver.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DotStore } from "@invisible-dots/memory";
import type { ChatModel, ChatRequest, ChatResult, ToolCall } from "@invisible-dots/openrouter-client";
import { parseToolCall } from "@invisible-dots/openrouter-client";
import { offeredTools, parseRuntimeConfig, type DotRuntimeConfig } from "@invisible-dots/shared";
import { TaskQueue } from "@invisible-dots/task-runtime";
import { AgentRunner, type RunnerOptions } from "../src/agent/runner.js";
import { DurableApprovalLedger } from "../src/approval/durable.js";
import { toRequestMessages } from "../src/dot/request.js";
import { Checkpoint } from "../src/memory/checkpoint.js";
import { RunLedger } from "../src/run/ledger.js";
import type { RunRecord } from "../src/run/record.js";
import { ToolExecutor } from "../src/tool/executor.js";
import { silentLogger, type ThreadMessage } from "../src/types.js";
import { FakeRegistry, baseConfig } from "./helpers.js";

/** A model that answers from a script and records every request. */
export class ScriptedModel implements ChatModel {
  readonly configured = true;
  readonly requests: ChatRequest[] = [];
  readonly script: ((request: ChatRequest) => Partial<ChatResult> & { calls?: ToolCall[] })[] = [];

  async chat(request: ChatRequest): Promise<ChatResult> {
    this.requests.push(structuredClone(request));
    const next = this.script.shift();
    if (!next) throw new Error("the scripted model has no answer left");
    const answer = next(request);
    const calls = answer.calls ?? [];
    const text = answer.text ?? "";
    return {
      message: { role: "assistant", content: text === "" && calls.length > 0 ? null : text, ...(calls.length > 0 ? { tool_calls: calls } : {}) },
      text,
      toolCalls: calls.map(parseToolCall),
      finishReason: calls.length > 0 ? "tool_calls" : "stop",
      usage: answer.usage ?? { prompt_tokens: 10, completion_tokens: 1 },
      model: "test/model",
      generationId: null,
      attempts: 1,
    };
  }
}

export function call(id: string, name: string, args: unknown): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

interface Bench {
  dir: string;
  store: DotStore;
  model: ScriptedModel;
  registry: FakeRegistry;
  config: DotRuntimeConfig;
  record: RunRecord;
  run(options?: Partial<RunnerOptions>): ReturnType<AgentRunner["run"]>;
  thread(): ThreadMessage[];
  close(): void;
}

function bench(config: Record<string, unknown> = baseConfig): Bench {
  const dir = mkdtempSync(join(tmpdir(), "idots-runner-"));
  const store = DotStore.open(join(dir, "dot.db"));
  const queue = new TaskQueue(store);
  const ledger = new RunLedger(store, queue);
  const approvals = new DurableApprovalLedger(store, queue);
  const checkpoint = new Checkpoint(store, queue, ledger, approvals);
  const model = new ScriptedModel();
  const registry = new FakeRegistry();
  const parsed = parseRuntimeConfig(config);
  const { task } = queue.enqueue({ id: "t1", description: "do it" });
  const record = ledger.startTask(task, "do it");
  return {
    dir,
    store,
    model,
    registry,
    config: parsed,
    record,
    run(options = {}) {
      const runner = new AgentRunner(
        { model, executor: new ToolExecutor(registry, silentLogger), checkpoint, approvals, ledger, log: silentLogger, emit: () => {} },
        { maxTurns: 20, ...options },
      );
      return runner.run({
        record,
        config: parsed,
        tools: offeredTools(parsed),
        systemPrompt: () => "system",
        requestMessages: (thread) => toRequestMessages(thread),
        signal: new AbortController().signal,
        onState: () => {},
      });
    },
    thread() {
      return store.listMessages<ThreadMessage>("t1").map((m) => m.message);
    },
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let b: Bench | undefined;
afterEach(() => {
  b?.close();
  b = undefined;
});

describe("AgentRunner", () => {
  it("runs the calls of one answer at the same time", async () => {
    b = bench();
    let running = 0;
    let overlap = 0;
    const slow = async () => {
      running++;
      overlap = Math.max(overlap, running);
      await new Promise((r) => setTimeout(r, 30));
      running--;
      return { ok: true, text: "done" };
    };
    b.registry.handlers.set("files_read", slow);
    b.registry.handlers.set("files_list", slow);
    b.model.script.push(() => ({ calls: [call("a", "files_read", { path: "x" }), call("b", "files_list", { path: "." })] }), () => ({ text: "ok" }));
    expect(await b.run()).toEqual({ status: "completed", output: "ok" });
    expect(overlap).toBe(2);
  });

  it("warns once about a repeated call, then fails the unit when loop detection is on", async () => {
    b = bench();
    for (let i = 0; i < 6; i++) b.model.script.push(() => ({ calls: [call(`c${i}`, "files_list", { path: "." })] }));
    const outcome = await b.run({ loopDetection: { maxRepetitions: 3 } });
    expect(outcome.status).toBe("failed");
    expect(b.thread().some((m) => m.role === "user" && String(m.content).startsWith("WARNING: You appear to be repeating"))).toBe(true);
  });

  it("replaces tool results the model has already seen with a marker when asked", async () => {
    b = bench();
    b.registry.handlers.set("files_read", () => ({ ok: true, text: "z".repeat(2000) }));
    b.model.script.push(
      () => ({ calls: [call("r1", "files_read", { path: "a" })] }),
      () => ({ calls: [call("r2", "files_read", { path: "b" })] }),
      () => ({ text: "done" }),
    );
    await b.run({ compressToolResults: true });
    const last = b.model.requests.at(-1)!.messages;
    const r1 = last.find((m) => m.role === "tool" && m.tool_call_id === "r1")!;
    const r2 = last.find((m) => m.role === "tool" && m.tool_call_id === "r2")!;
    expect(r1.content).toBe("[Tool output compressed: 2000 chars, already processed]");
    expect(r2.content).toHaveLength(2000);
  });

  it("summarizes the older history once it exceeds the strategy's threshold", async () => {
    b = bench();
    b.registry.handlers.set("files_read", () => ({ ok: true, text: "y".repeat(1200) }));
    let turns = 0;
    const answer = (request: ChatRequest) => {
      if (!request.tools) return { text: "the files were read" };
      turns++;
      return turns <= 6 ? { calls: [call(`r${turns}`, "files_read", { path: `p${turns}` })] } : { text: "final" };
    };
    for (let i = 0; i < 20; i++) b.model.script.push(answer);
    const outcome = await b.run({ contextStrategy: { maxTokens: 1000 } });
    expect(outcome).toEqual({ status: "completed", output: "final" });
    const summaryRequest = b.model.requests.find((r) => !r.tools)!;
    expect(String(summaryRequest.messages[0]!.content)).toContain("Summarize the following conversation history");
    const after = b.model.requests.at(-1)!.messages;
    expect(after.some((m) => m.role === "user" && String(m.content).startsWith("[Conversation summary]"))).toBe(true);
  });
});
