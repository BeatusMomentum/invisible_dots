/**
 * The agent of the crash tests: the engine on a real dot.db, in a process of
 * its own. At the named fault point it says KILLME on stdout and blocks, so
 * the test kills it right there (SIGKILL on Linux, TerminateProcess on
 * Windows) with nothing more done. Every tool execution is appended to a
 * file first, so executions survive the kill.
 *
 * argv: dbPath modelUrl executionsFile configJson [killPoint [killNth]]
 * stdin, one JSON command per line: {"cmd":"accept","event":...}, {"cmd":"idle"}, {"cmd":"state"}, {"cmd":"exit"}
 * stdout: STARTED <ms to open dot.db>, IDLE, STATE <state answer>, KILLME <point>
 */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { DotStore, DotStoreLockedError } from "@invisible-dots/memory";
import { OpenRouterClient } from "@invisible-dots/openrouter-client";
import { offeredTools, truncateText, type DotRuntimeConfig, type InboundEvent } from "@invisible-dots/shared";
import { DotRuntime, type ToolContext } from "../../src/dot/index.js";

const [dbPath, modelUrl, executionsFile, configJson, killPoint = "", killNth = "1"] = process.argv.slice(2) as [string, string, string, string, string?, string?];

let seen = 0;
const faults = {
  at(point: string) {
    if (point !== killPoint || ++seen !== Number(killNth)) return;
    process.stdout.write(`KILLME ${point}\n`);
    // Block the whole process: nothing runs again until the kill.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  },
};

const started = Date.now();
let store: DotStore;
try {
  store = DotStore.open(dbPath);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(error instanceof DotStoreLockedError ? 3 : 1);
}
const opened = Date.now() - started;

const registry = {
  definitions: (config: DotRuntimeConfig) => offeredTools(config),
  async call(name: string, args: unknown, _ctx: ToolContext) {
    appendFileSync(executionsFile, `${name}\t${JSON.stringify(args)}\n`);
    const path = (args as { path?: string }).path ?? "";
    const text = path.startsWith("big") ? `${path}: ${"x".repeat(20_000)}` : `${name} done`;
    return { ok: true, text: truncateText(text) };
  },
};
const model = new OpenRouterClient({ apiKey: "test-key", url: modelUrl, sleep: async () => {} });
const runtime = new DotRuntime({ store, registry, model, faults });
runtime.setConfig(JSON.parse(configJson));
runtime.start();
process.stdout.write(`STARTED ${opened}\n`);

for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line) as { cmd: string; event?: InboundEvent };
  if (command.cmd === "accept") runtime.accept(command.event!);
  if (command.cmd === "state") {
    process.stdout.write(`STATE ${JSON.stringify(runtime.stateAnswer())}\n`);
    continue;
  }
  if (command.cmd === "exit") {
    await runtime.stop();
    store.close();
    process.exit(0);
  }
  await runtime.idle();
  process.stdout.write("IDLE\n");
}
