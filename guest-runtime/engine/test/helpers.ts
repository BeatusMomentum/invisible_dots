import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DotStore } from "@invisible-dots/memory";
import { OpenRouterClient } from "@invisible-dots/openrouter-client";
import { offeredTools, type DotRuntimeConfig, type InboundEvent, type OutboundEvent } from "@invisible-dots/shared";
import { DotRuntime, type FaultSeam, type ToolContext, type ToolRegistry, type ToolResult } from "../src/dot/index.js";
import { startFakeOpenRouter, type FakeOpenRouter } from "../../openrouter-client/test/fake-openrouter.js";

export { completion } from "../../openrouter-client/test/fake-openrouter.js";

export const baseConfig = {
  name: "fare-watch",
  goal: "Find the cheapest fare.",
  instructions: "Write findings to ~/workspace/fares.csv.",
  model: { provider: "openrouter", id: "test/model" },
};

export interface RecordedCall {
  name: string;
  args: unknown;
  taskId: string | undefined;
}

export class FakeRegistry implements ToolRegistry {
  calls: RecordedCall[] = [];
  handlers = new Map<string, (args: unknown, ctx: ToolContext) => Promise<ToolResult> | ToolResult>();

  definitions(config: DotRuntimeConfig) {
    return offeredTools(config);
  }

  async call(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    this.calls.push({ name, args, taskId: ctx.taskId });
    const handler = this.handlers.get(name);
    if (!handler) return { ok: true, text: `${name} ran` };
    return handler(args, ctx);
  }
}

export interface Harness {
  dir: string;
  dbPath: string;
  fake: FakeOpenRouter;
  store: DotStore;
  registry: FakeRegistry;
  model: OpenRouterClient;
  runtime: DotRuntime;
  /** Close the store and start a new runtime on the same database, as after a reboot. */
  restart(): Promise<void>;
  events(type?: OutboundEvent["type"]): OutboundEvent[];
  states(): string[];
  close(): Promise<void>;
}

export async function harness(
  config: Record<string, unknown> = baseConfig,
  options: { apiKey?: boolean; faults?: FaultSeam } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "idots-agent-"));
  const dbPath = join(dir, "dot.db");
  const fake = await startFakeOpenRouter();
  const registry = new FakeRegistry();

  const build = () => {
    const store = DotStore.open(dbPath);
    const model = new OpenRouterClient({
      ...(options.apiKey === false ? {} : { apiKey: "test-key" }),
      url: fake.url,
      sleep: async () => {},
    });
    const runtime = new DotRuntime({ store, registry, model, ...(options.faults ? { faults: options.faults } : {}) });
    return { store, model, runtime };
  };

  const first = build();
  first.runtime.setConfig(config);
  first.runtime.start();

  const h: Harness = {
    dir,
    dbPath,
    fake,
    registry,
    ...first,
    async restart() {
      await h.runtime.stop();
      h.store.close();
      const next = build();
      h.store = next.store;
      h.model = next.model;
      h.runtime = next.runtime;
      h.runtime.start();
    },
    events(type) {
      const all = h.store.readAfter(0, 10_000);
      return type ? all.filter((e) => e.type === type) : all;
    },
    states() {
      return h.events("agent.state").map((e) => (e.data as { state: string }).state);
    },
    async close() {
      await h.runtime.stop();
      h.store.close();
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

let counter = 0;
export function inbound<T extends InboundEvent["type"]>(type: T, data: Extract<InboundEvent, { type: T }>["data"]): InboundEvent {
  counter += 1;
  return { id: `in_${counter}_${Date.now()}`, type, ts: new Date().toISOString(), data } as InboundEvent;
}

/** The request messages the model received on request `index`. */
export function sentMessages(fake: FakeOpenRouter, index: number): { role: string; content: unknown; tool_call_id?: string }[] {
  return fake.requests[index]!.body.messages as { role: string; content: unknown; tool_call_id?: string }[];
}
