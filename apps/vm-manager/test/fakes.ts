import { createHmac } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { GUEST_PROOF_CONTEXT, type ProcessPresence } from "@invisible-dots/shared";
import {
  CommandError,
  type CommandResult,
  type CommandRunner,
  type DetachedProcess,
  type ProcessControl,
  type ProcessExit,
  type RunOptions,
  type SpawnDetachedOptions,
} from "../src/index.js";

export interface RecordedCall {
  command: string;
  args: string[];
  options: RunOptions | undefined;
}

export type Handler = (command: string, args: string[]) => CommandResult | undefined | Promise<CommandResult | undefined>;

/** A failure as the runner would report it. */
export function fail(command: string, args: string[], stderr: string, exitCode = 1): never {
  throw new CommandError({ command, args, exitCode, stderr });
}

/** Records every command; `handler` answers them (undefined means success with empty output). */
export class FakeRunner implements CommandRunner {
  calls: RecordedCall[] = [];
  constructor(public handler: Handler = () => undefined) {}

  async run(command: string, args: readonly string[], options?: RunOptions): Promise<CommandResult> {
    const copy = [...args];
    this.calls.push({ command, args: copy, options });
    return (await this.handler(command, copy)) ?? { stdout: "", stderr: "" };
  }

  /** Every call as one "command arg arg" line, for readable assertions. */
  lines(): string[] {
    return this.calls.map((call) => [call.command, ...call.args].join(" "));
  }
}

/** How a fake QEMU behaves when spawned. */
export type FakeBehaviour =
  /** Exits at once after writing `output` to its log, like QEMU refusing its command line or the accelerator. */
  | { kind: "exit"; code: number; output: string }
  /** Sets up the port forward, then exits a moment later: QEMU refusing -cpu host when it builds the machine. */
  | { kind: "exitAfterForward"; code: number; output: string }
  /** Keeps running without ever listening on the guest port. */
  | { kind: "hang" }
  /**
   * Runs and forwards the guest port. `guestUp: false` is a VM whose guest
   * never boots (the forward accepts and drops every connection);
   * `ignorePoweroff` a guest that answers 202 and then does not power off.
   * `serial` and `qemuOutput` are written to the serial console and QEMU's log.
   */
  | { kind: "run"; guestUp?: boolean; ignorePoweroff?: boolean; serial?: string; qemuOutput?: string };

export interface FakeVm {
  pid: number;
  name: string;
  guestPort: number;
  /** The Dot token the guest read from its seed. */
  token: string;
  guestUp: boolean;
  ignorePoweroff: boolean;
  /** Guest requests as "METHOD /path", in order. */
  requests: string[];
  resolveExit: (exit: ProcessExit) => void;
  server?: Server;
  sockets: Set<Socket>;
}

/** The value after `flag` in an argv. */
export function argAfter(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) throw new Error(`no ${flag} in ${args.join(" ")}`);
  return args[index + 1]!;
}

/** The host port of the forward in an argv. */
export function guestPortOf(args: readonly string[]): number {
  return Number(/hostfwd=tcp:127\.0\.0\.1:(\d+)-:1024$/.exec(argAfter(args, "-netdev"))![1]);
}

/**
 * The token a guest would read from its seed: the seed ISO QEMU was given
 * holds config.json as a quoted YAML scalar inside user-data.
 */
export async function tokenInSeed(args: readonly string[]): Promise<string> {
  const drive = args.find((arg) => arg.includes("seed.iso"));
  const path = drive && /file=([^,]+)/.exec(drive)?.[1];
  if (!path) throw new Error(`no seed drive in ${args.join(" ")}`);
  const match = /token\\?":\\?"([A-Za-z0-9_-]+)/.exec((await readFile(path)).toString("latin1"));
  if (!match) throw new Error(`no token in ${path}`);
  return match[1]!;
}

function send(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/**
 * dot-agentd's `GET /v1/proof` (section 5.1), computed the guest's way, with
 * the token the guest read from its seed. Answers true when it served it.
 */
export function serveProof(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  token: string,
): boolean {
  const url = new URL(request.url ?? "/", "http://guest");
  if (request.method !== "GET" || url.pathname !== "/v1/proof") return false;
  const nonce = url.searchParams.get("nonce") ?? "";
  send(response, 200, { proof: createHmac("sha256", token).update(`${GUEST_PROOF_CONTEXT}${nonce}`).digest("hex") });
  return true;
}

/**
 * A pretend QEMU: the ProcessControl the vm-manager spawns and kills it
 * with, and, like QEMU's user networking, a real TCP listener on the guest
 * port of its argv for as long as it "runs", with dot-agentd's health and
 * poweroff routes behind it. It parses the real argv, so a wrong argv breaks
 * these tests too.
 */
export class FakeQemuHost implements ProcessControl {
  spawned: { command: string; args: string[]; logPath: string; cwd: string; env: Record<string, string> }[] = [];
  vms = new Map<number, FakeVm>();
  alive = new Set<number>();
  killed: number[] = [];
  /** Decides each spawn's behaviour; `attempt` counts spawns from 1. */
  behaviour: (args: string[], attempt: number) => FakeBehaviour = () => ({ kind: "run" });
  /** Pids that exist for this user but are not QEMU (a recycled pid). */
  foreignPids = new Set<number>();
  /** Pids that exist and belong to another user (process.kill answers EPERM). */
  otherUserPids = new Set<number>();
  private nextPid = 4000;

  async spawnDetached(command: string, args: readonly string[], options: SpawnDetachedOptions): Promise<DetachedProcess> {
    const argv = [...args];
    this.spawned.push({ command, args: argv, logPath: options.logPath, cwd: options.cwd, env: options.env });
    const pid = this.nextPid++;
    const behaviour = this.behaviour(argv, this.spawned.length);
    let resolveExit!: (exit: ProcessExit) => void;
    const exited = new Promise<ProcessExit>((resolve) => (resolveExit = resolve));
    if (behaviour.kind === "exit") {
      appendFileSync(options.logPath, behaviour.output);
      resolveExit({ code: behaviour.code, signal: null });
      return { pid, exited };
    }
    const run = behaviour.kind === "run" ? behaviour : undefined;
    const vm: FakeVm = {
      pid,
      name: argAfter(argv, "-name"),
      guestPort: guestPortOf(argv),
      token: await tokenInSeed(argv),
      guestUp: run?.guestUp ?? true,
      ignorePoweroff: run?.ignorePoweroff ?? false,
      requests: [],
      resolveExit,
      sockets: new Set(),
    };
    this.alive.add(pid);
    this.vms.set(pid, vm);
    if (run?.qemuOutput) appendFileSync(options.logPath, run.qemuOutput);
    if (run?.serial) writeFileSync(/^file:(.*)$/.exec(argAfter(argv, "-serial"))![1]!, run.serial);
    if (behaviour.kind !== "hang") await this.openForward(vm);
    if (behaviour.kind === "exitAfterForward") {
      setTimeout(() => {
        appendFileSync(options.logPath, behaviour.output);
        this.terminate(vm, { code: behaviour.code, signal: null });
      }, 2);
    }
    return { pid, exited };
  }

  /** QEMU's user networking listening on the guest port, with dot-agentd behind it. */
  protected async openForward(vm: FakeVm): Promise<void> {
    const server = createServer((request, response) => {
      vm.requests.push(`${request.method} ${request.url}`);
      // Nothing listens on port 1024 in a guest that is not up: the forward drops the connection.
      if (!vm.guestUp) {
        request.socket.destroy();
        return;
      }
      if (serveProof(request, response, vm.token)) return;
      if (request.headers.authorization !== `Bearer ${vm.token}`) return send(response, 401, { error: "unauthorized", message: "bad token" });
      if (request.method === "GET" && request.url === "/v1/health") {
        return send(response, 200, { agentd: "ok", agent: { status: "ok", state: "IDLE", openrouter_configured: false }, uptime_s: 1 });
      }
      if (request.method === "POST" && request.url === "/v1/system/poweroff") {
        send(response, 202, { status: "powering_off" });
        if (!vm.ignorePoweroff) setTimeout(() => this.terminate(vm), 5);
        return;
      }
      send(response, 404, { error: "not_found", message: `${request.method} ${request.url}` });
    });
    server.on("connection", (socket) => {
      vm.sockets.add(socket);
      socket.on("close", () => vm.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(vm.guestPort, "127.0.0.1", () => resolve());
    });
    vm.server = server;
  }

  /** QEMU's listener goes away with the process. */
  protected closeForward(vm: FakeVm): void {
    for (const socket of vm.sockets) socket.destroy();
    vm.server?.close();
  }

  presence(pid: number): ProcessPresence {
    if (this.alive.has(pid) || this.foreignPids.has(pid)) return "ours";
    return this.otherUserPids.has(pid) ? "foreign" : "gone";
  }

  kill(pid: number): void {
    this.killed.push(pid);
    const vm = this.vms.get(pid);
    if (vm) this.terminate(vm, { code: null, signal: "SIGKILL" });
  }

  /** The one running VM, for tests that start one. */
  only(): FakeVm {
    const running = [...this.vms.values()];
    if (running.length !== 1) throw new Error(`expected one fake VM, there are ${running.length}`);
    return running[0]!;
  }

  /** The QEMU process ends: its listener closes and its exit is reported. */
  terminate(vm: FakeVm, exit: ProcessExit = { code: 0, signal: null }): void {
    if (!this.alive.delete(vm.pid)) return;
    this.vms.delete(vm.pid);
    this.closeForward(vm);
    vm.resolveExit(exit);
  }
}
