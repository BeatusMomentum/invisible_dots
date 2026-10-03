/**
 * Crash tests with real processes (architecture section 8.7): the agent is
 * killed at a named point (SIGKILL on Linux, TerminateProcess on Windows), a
 * fresh process starts on the same dot.db, and the test checks what ran,
 * what the model was sent next, and the outbox.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DotStore } from "@invisible-dots/memory";
import type { InboundEvent, OutboundEvent } from "@invisible-dots/shared";
import { SUMMARY_SYSTEM_PROMPT } from "../../src/agent/compression.js";
import { completion, startFakeOpenRouter, type FakeOpenRouter, type RecordedRequest, type ScriptedReply } from "../../../openrouter-client/test/fake-openrouter.js";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const TSX = pathToFileURL(require.resolve("tsx")).href;

const baseConfig = { name: "crash-test", goal: "Survive.", model: { provider: "openrouter", id: "test/model" } };

class AgentProcess {
  readonly child: ChildProcess;
  readonly lines: string[] = [];
  readonly exited: Promise<number | null>;
  stderr = "";
  #waiters: { prefix: string; resolve: (line: string) => void }[] = [];

  constructor(args: string[]) {
    this.child = spawn(process.execPath, ["--import", TSX, join(here, "agent-process.ts"), ...args], { stdio: ["pipe", "pipe", "pipe"] });
    this.exited = new Promise((resolve) => this.child.once("exit", (code) => resolve(code)));
    this.child.stderr!.on("data", (chunk: Buffer) => (this.stderr += chunk.toString()));
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      this.lines.push(line);
      for (const waiter of this.#waiters.filter((w) => line.startsWith(w.prefix))) {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        waiter.resolve(line);
      }
    });
  }

  /** The next line starting with one of `prefixes` (or one already printed since the last call). */
  next(...prefixes: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (line: string) => {
        if (done) return;
        done = true;
        resolve(line);
      };
      for (const prefix of prefixes) this.#waiters.push({ prefix, resolve: finish });
      void this.exited.then((code) => {
        if (!done) reject(new Error(`the agent exited with ${code} before ${prefixes.join(" or ")}: ${this.stderr}`));
      });
    });
  }

  send(command: { cmd: string; event?: InboundEvent }): void {
    this.child.stdin!.write(`${JSON.stringify(command)}\n`);
  }

  async kill(): Promise<void> {
    this.child.kill("SIGKILL");
    await this.exited;
  }

  async exit(): Promise<void> {
    this.send({ cmd: "exit" });
    await this.exited;
  }
}

interface Scene {
  dir: string;
  db: string;
  executions: string;
  fake: FakeOpenRouter;
  config: Record<string, unknown>;
  start(kill?: { point: string; nth?: number }): Promise<{ agent: AgentProcess; openedMs: number }>;
  ran(): string[];
  outbox(): OutboundEvent[];
}

const scenes: Scene[] = [];
const agents: AgentProcess[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) if (agent.child.exitCode === null) await agent.kill();
  for (const scene of scenes.splice(0)) {
    await scene.fake.close();
    rmSync(scene.dir, { recursive: true, force: true });
  }
});

/** A model that answers by the shape of the request, so a repeated request gets the same answer. */
function responder(round: (calls: number) => ScriptedReply) {
  return (request: RecordedRequest): ScriptedReply => {
    const messages = request.body.messages as { role: string; content: unknown; tool_calls?: unknown[] }[];
    if (messages[0]?.content === SUMMARY_SYSTEM_PROMPT) return completion({ content: "the agent read big files; nothing else matters" });
    // Progress is what the model can still see: calls made, or the newest "bigN" result once a summary hid the older ones.
    const visible = messages.filter((m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0).length;
    const read = messages.flatMap((m) => (m.role === "tool" && typeof m.content === "string" ? [/^big(\d+):/.exec(m.content)] : []));
    const newest = Math.max(-1, ...read.map((r) => (r ? Number(r[1]) : -1)));
    return round(Math.max(visible, newest + 1));
  };
}

async function scene(round: (calls: number) => ScriptedReply, config: Record<string, unknown> = baseConfig): Promise<Scene> {
  const dir = mkdtempSync(join(tmpdir(), "idots-crash-"));
  const fake = await startFakeOpenRouter(responder(round));
  const s: Scene = {
    dir,
    db: join(dir, "dot.db"),
    executions: join(dir, "executions.log"),
    fake,
    config,
    async start(kill) {
      const args = [s.db, fake.url, s.executions, JSON.stringify(config), ...(kill ? [kill.point, String(kill.nth ?? 1)] : [])];
      const agent = new AgentProcess(args);
      agents.push(agent);
      const line = await agent.next("STARTED");
      return { agent, openedMs: Number(line.split(" ")[1]) };
    },
    ran() {
      try {
        return readFileSync(s.executions, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")[0]!);
      } catch {
        return [];
      }
    },
    outbox() {
      const store = DotStore.open(s.db);
      try {
        return store.readAfter(0, 10_000);
      } finally {
        store.close();
      }
    },
  };
  scenes.push(s);
  return s;
}

let counter = 0;
function event<T extends InboundEvent["type"]>(type: T, data: Extract<InboundEvent, { type: T }>["data"]): InboundEvent {
  counter++;
  return { id: `crash_${counter}_${Date.now()}`, type, ts: new Date().toISOString(), data } as InboundEvent;
}

const task = () => event("task.created", { task_id: "t1", description: "do the thing", priority: 0 });
const oneCall = (name: string, args: unknown) => (calls: number) =>
  calls === 0 ? completion({ content: null, tool_calls: [{ id: "c1", name, arguments: args }] }) : completion({ content: "done" });

/** Kill A at the point, then let B resume to idle; returns B's time to open dot.db. */
async function crashAndResume(s: Scene, point: string, before: (a: AgentProcess) => void, nth = 1): Promise<number> {
  const { agent: a } = await s.start({ point, nth });
  before(a);
  await a.next("KILLME");
  await a.kill();
  const { agent: b, openedMs } = await s.start();
  b.send({ cmd: "idle" });
  await b.next("IDLE");
  await b.exit();
  return openedMs;
}

function expectCleanOutbox(events: readonly OutboundEvent[]): void {
  // No gap: a killed transaction takes its seqs back, as a rolled back one does.
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
}

const toolCalled = (events: readonly OutboundEvent[]) => events.filter((e) => e.type === "tool.called").map((e) => e.data as Record<string, unknown>);
const lastRequest = (s: Scene) => s.fake.requests.at(-1)!.body.messages as { role: string; content: unknown; tool_call_id?: string }[];

describe("crash recovery with real processes", { timeout: 120_000 }, () => {
  it("1: killed during accept, after the inbox insert: nothing was accepted, and the redelivery runs once", async () => {
    const s = await scene(oneCall("files_list", { path: "." }));
    const ev = task();
    const { agent: a } = await s.start({ point: "accept:inserted" });
    a.send({ cmd: "accept", event: ev });
    await a.next("KILLME");
    await a.kill();
    const { agent: b } = await s.start();
    b.send({ cmd: "accept", event: ev });
    await b.next("IDLE");
    await b.exit();
    expect(s.ran()).toEqual(["files_list"]);
    const events = s.outbox();
    expectCleanOutbox(events);
    expect(events.filter((e) => e.type === "task.completed")).toHaveLength(1);
  });

  it("2: killed after the model response, before the assistant commit: the step is asked again, once", async () => {
    const s = await scene(oneCall("files_list", { path: "." }));
    const opened = await crashAndResume(s, "model:answered", (a) => a.send({ cmd: "accept", event: task() }));
    expect(opened).toBeLessThan(1000);
    expect(s.ran()).toEqual(["files_list"]);
    expect(s.fake.requests).toHaveLength(3);
    const events = s.outbox();
    expectCleanOutbox(events);
    expect(toolCalled(events)).toHaveLength(1);
  });

  it("3: killed after the intent commit, before execute: a call that is not replay-safe is reported, not run", async () => {
    const s = await scene(oneCall("computer_exec", { command: "deploy" }));
    await crashAndResume(s, "intent:committed", (a) => a.send({ cmd: "accept", event: task() }));
    expect(s.ran()).toEqual([]);
    const called = toolCalled(s.outbox());
    expect(called).toEqual([expect.objectContaining({ tool: "computer_exec", interrupted: true, ok: false })]);
    expect(lastRequest(s).at(-1)!.content).toContain("This call was interrupted before its result was recorded.");
  });

  for (const variant of [
    { name: "replay-safe, allowed", tool: "files_read", ask: false, ran: 2, interrupted: false },
    { name: "not replay-safe, allowed", tool: "computer_exec", ask: false, ran: 1, interrupted: true },
    { name: "replay-safe, approved", tool: "files_read", ask: true, ran: 2, interrupted: false },
    { name: "not replay-safe, approved", tool: "computer_exec", ask: true, ran: 1, interrupted: true },
  ]) {
    it(`4: killed after execute, before the result commit (${variant.name})`, async () => {
      const permission = variant.tool === "files_read" ? "files.read" : "computer.exec";
      const config = variant.ask ? { ...baseConfig, permissions: { [permission]: "ask" } } : baseConfig;
      const args = variant.tool === "files_read" ? { path: "notes" } : { command: "make" };
      const s = await scene(oneCall(variant.tool, args), config);
      const { agent: a } = await s.start({ point: "tool:executed" });
      a.send({ cmd: "accept", event: task() });
      if (variant.ask) {
        await a.next("IDLE");
        // dot.db is the agent's alone: the pending approval is read through the agent, as the host does.
        a.send({ cmd: "state" });
        const state = JSON.parse((await a.next("STATE")).slice("STATE ".length)) as { pending_approval: { approval_id: string } };
        a.send({ cmd: "accept", event: event("approval.received", { approval_id: state.pending_approval.approval_id, decision: "approve" }) });
      }
      await a.next("KILLME");
      await a.kill();
      const { agent: b } = await s.start();
      b.send({ cmd: "idle" });
      await b.next("IDLE");
      await b.exit();
      expect(s.ran()).toHaveLength(variant.ran);
      const events = s.outbox();
      expectCleanOutbox(events);
      const called = toolCalled(events);
      expect(called).toHaveLength(1);
      expect(called[0]).toMatchObject({ tool: variant.tool, decision: variant.ask ? "ask" : "allow" });
      expect(called[0]!.interrupted === true).toBe(variant.interrupted);
      expect(events.filter((e) => e.type === "approval.requested")).toHaveLength(variant.ask ? 1 : 0);
      expect(events.filter((e) => e.type === "task.completed")).toHaveLength(1);
      if (variant.interrupted && variant.ask) {
        expect(lastRequest(s).at(-1)!.content).toContain("The user's approval was used by that attempt");
      }
    });
  }

  it("5: killed during the summary call: the next process summarizes again and goes on", async () => {
    const config = { ...baseConfig, limits: { context_tokens: 8000 } };
    const rounds = (calls: number) =>
      calls < 6 ? completion({ content: null, tool_calls: [{ id: `r${calls}`, name: "files_read", arguments: { path: `big${calls}` } }] }) : completion({ content: "done" });
    const s = await scene(rounds, config);
    const { agent: a } = await s.start();
    a.send({ cmd: "accept", event: task() });
    // Kill while a summary request is in flight.
    for (;;) {
      await s.fake.waitForRequests(s.fake.requests.length + 1);
      const last = s.fake.requests.at(-1)!.body.messages as { content: unknown }[];
      if (last[0]?.content === SUMMARY_SYSTEM_PROMPT) break;
    }
    await a.kill();
    const { agent: b } = await s.start();
    b.send({ cmd: "idle" });
    await b.next("IDLE");
    await b.exit();
    const events = s.outbox();
    expectCleanOutbox(events);
    expect(events.filter((e) => e.type === "task.completed")).toHaveLength(1);
    // Every call ran once and has one tool.called: the kill hit no tool.
    expect(toolCalled(events)).toHaveLength(6);
    expect(s.ran()).toHaveLength(6);
  });

  it("6: killed after the summary call, before the summary commit: the summary is made again, and no call runs twice", async () => {
    const config = { ...baseConfig, limits: { context_tokens: 8000 } };
    const rounds = (calls: number) =>
      calls < 6 ? completion({ content: null, tool_calls: [{ id: `r${calls}`, name: "files_read", arguments: { path: `big${calls}` } }] }) : completion({ content: "done" });
    const s = await scene(rounds, config);
    await crashAndResume(s, "summary:answered", (a) => a.send({ cmd: "accept", event: task() }));
    const events = s.outbox();
    expectCleanOutbox(events);
    expect(events.filter((e) => e.type === "task.completed")).toHaveLength(1);
    expect(toolCalled(events)).toHaveLength(6);
    expect(s.ran()).toHaveLength(6);
    expect(s.fake.requests.filter((r) => (r.body.messages as { content: unknown }[])[0]?.content === SUMMARY_SYSTEM_PROMPT).length).toBeGreaterThanOrEqual(2);
  });

  it("7: a replay-safe call killed twice in a row is reported, not run a third time", async () => {
    const s = await scene(oneCall("files_read", { path: "notes" }));
    const { agent: a } = await s.start({ point: "tool:executed" });
    a.send({ cmd: "accept", event: task() });
    await a.next("KILLME");
    await a.kill();
    const { agent: b } = await s.start({ point: "tool:executed" });
    await b.next("KILLME");
    await b.kill();
    const { agent: c } = await s.start();
    c.send({ cmd: "idle" });
    await c.next("IDLE");
    await c.exit();
    expect(s.ran()).toEqual(["files_read", "files_read"]);
    expect(toolCalled(s.outbox())).toEqual([expect.objectContaining({ tool: "files_read", interrupted: true })]);
    expect(lastRequest(s).at(-1)!.content).toContain("It stopped the agent twice");
  });

  it("8: a second process on the same dot.db, while the first is alive, exits without touching it", async () => {
    const s = await scene(oneCall("files_list", { path: "." }));
    const { agent: a } = await s.start();
    const second = new AgentProcess([s.db, s.fake.url, s.executions, JSON.stringify(baseConfig)]);
    agents.push(second);
    expect(await second.exited).toBe(3);
    expect(second.stderr).toContain("another agent owns");
    a.send({ cmd: "accept", event: task() });
    await a.next("IDLE");
    await a.exit();
    expect(s.ran()).toEqual(["files_list"]);
  });
});
