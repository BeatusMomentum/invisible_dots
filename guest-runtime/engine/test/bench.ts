/**
 * The engine's parts wired by hand: a real `dot.db` (a file, or in memory),
 * a scripted model and a counting registry, without the HTTP fake or the
 * driver. For tests of the runner and of the context budget.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DotStore } from "@invisible-dots/memory";
import { parseToolCall, type ChatModel, type ChatRequest, type ChatResult, type ToolCall } from "@invisible-dots/openrouter-client";
import { offeredTools, parseRuntimeConfig, type DotRuntimeConfig } from "@invisible-dots/shared";
import { TaskQueue } from "@invisible-dots/task-runtime";
import { ContextManager } from "../src/agent/compression.js";
import { AgentRunner, type RunnerOptions } from "../src/agent/runner.js";
import { DurableApprovalLedger } from "../src/approval/durable.js";
import { Checkpoint } from "../src/memory/checkpoint.js";
import { RunLedger } from "../src/run/ledger.js";
import type { RunRecord } from "../src/run/record.js";
import { ToolExecutor } from "../src/tool/executor.js";
import { NO_FAULTS, silentLogger, type ThreadMessage } from "../src/types.js";
import { TokenEstimator } from "../src/utils/tokens.js";
import { FakeRegistry, baseConfig } from "./helpers.js";

export type Answer = Partial<ChatResult> & { calls?: ToolCall[] };

/** A model that answers from a script, or from `respond` once the script is empty, and records every request. */
export class ScriptedModel implements ChatModel {
  readonly configured = true;
  readonly requests: ChatRequest[] = [];
  readonly script: ((request: ChatRequest) => Answer)[] = [];
  respond: ((request: ChatRequest) => Answer) | undefined;

  async chat(request: ChatRequest): Promise<ChatResult> {
    this.requests.push(structuredClone(request));
    const next = this.script.shift() ?? this.respond;
    if (!next) throw new Error("the scripted model has no answer left");
    const answer = next(request);
    const calls = answer.calls ?? [];
    const text = answer.text ?? "";
    return {
      message: { role: "assistant", content: text === "" && calls.length > 0 ? null : text, ...(calls.length > 0 ? { tool_calls: calls } : {}) },
      text,
      toolCalls: calls.map(parseToolCall),
      finishReason: answer.finishReason ?? (calls.length > 0 ? "tool_calls" : "stop"),
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

export interface Bench {
  store: DotStore;
  model: ScriptedModel;
  registry: FakeRegistry;
  config: DotRuntimeConfig;
  record: RunRecord;
  ledger: RunLedger;
  estimator: TokenEstimator;
  context: ContextManager;
  run(options?: Partial<RunnerOptions>): ReturnType<AgentRunner["run"]>;
  /** The unit as the context manager sees it. */
  unit(): Parameters<ContextManager["prepare"]>[0];
  thread(): ThreadMessage[];
  close(): void;
}

export function bench(config: Record<string, unknown> = baseConfig, options: { memory?: boolean; chat?: boolean } = {}): Bench {
  const dir = options.memory ? undefined : mkdtempSync(join(tmpdir(), "idots-bench-"));
  const store = DotStore.open(dir ? join(dir, "dot.db") : ":memory:");
  const queue = new TaskQueue(store);
  const ledger = new RunLedger(store, queue);
  const approvals = new DurableApprovalLedger(store, queue);
  const checkpoint = new Checkpoint(store, queue, ledger, approvals, NO_FAULTS);
  const model = new ScriptedModel();
  const registry = new FakeRegistry();
  const executor = new ToolExecutor(registry, silentLogger);
  const estimator = new TokenEstimator();
  const context = new ContextManager({ model, store, ledger, executor, estimator, log: silentLogger, faults: NO_FAULTS, emit: () => {} });
  const parsed = parseRuntimeConfig(config);
  let record: RunRecord;
  if (options.chat) {
    record = ledger.startChat("ev1", "hello");
  } else {
    const { task } = queue.enqueue({ id: "t1", description: "do it" });
    record = ledger.startTask(task, "do it");
  }
  const thread = record.kind === "chat" ? "conversation" : "t1";
  const signal = new AbortController().signal;
  const unit = () => ({ record: ledger.get() ?? record, config: parsed, tools: offeredTools(parsed), systemPrompt: () => "system", signal });
  return {
    store,
    model,
    registry,
    config: parsed,
    record,
    ledger,
    estimator,
    context,
    unit,
    run(runnerOptions = {}) {
      const runner = new AgentRunner(
        {
          model,
          executor,
          context,
          estimator,
          checkpoint,
          approvals,
          ledger,
          log: silentLogger,
          faults: NO_FAULTS,
          executing: new Set<string>(),
          emit: () => {},
        },
        { maxTurns: 20, ...runnerOptions },
      );
      return runner.run({ ...unit(), onState: () => {} });
    },
    thread() {
      return store.listMessages<ThreadMessage>(thread).map((m) => m.message);
    },
    close() {
      store.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}
