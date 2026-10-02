/**
 * The per-Dot vsock bridge of architecture section 5.1:
 *
 *   socat UNIX-LISTEN:<run>/dot-<id>.sock,fork,mode=600 VSOCK-CONNECT:<cid>:1024
 *
 * One socat process per running VM. It is restarted when it dies on its own,
 * and stopped (with its socket removed) when the VM stops.
 */
import { stat, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { VSOCK_PORT } from "@invisible-dots/shared";
import type { Logger } from "./logger.js";
import type { CommandRunner, SpawnedProcess } from "./runner.js";

export interface BridgeOptions {
  dotId: string;
  cid: number;
  socketPath: string;
  runner: CommandRunner;
  logger: Logger;
  /** The socat executable. Default "socat". */
  socatCommand?: string;
  /** How long `start()` waits for the socket to appear. Default 5 s. */
  readyTimeoutMs?: number;
  /** Delay before restarting a socat that died. Doubles on each consecutive failure, capped at 30 s. */
  restartDelayMs?: number;
  /** Decides whether the socket is there. The default suits unix sockets and Windows named pipes. */
  socketExists?: (path: string) => Promise<boolean>;
}

export function bridgeArgs(socketPath: string, cid: number): string[] {
  return [`UNIX-LISTEN:${socketPath},fork,mode=600`, `VSOCK-CONNECT:${cid}:${VSOCK_PORT}`];
}

/**
 * Unix sockets are checked with stat, which does not dial the guest. Named
 * pipes (Windows, tests only) cannot be stat'ed reliably, so they are probed
 * with a connection that is closed at once.
 */
export async function defaultSocketExists(path: string): Promise<boolean> {
  if (path.startsWith("\\\\.\\pipe\\")) {
    return new Promise((resolve) => {
      const socket = connect(path);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
  }
  try {
    return (await stat(path)).isSocket();
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class VsockBridge {
  readonly dotId: string;
  readonly cid: number;
  readonly socketPath: string;
  private readonly options: BridgeOptions;
  private process: SpawnedProcess | undefined;
  private stopping = false;
  /** Set once the first start succeeded: a bridge that never came up is reported, not retried. */
  private supervised = false;
  private restartTimer: NodeJS.Timeout | undefined;
  private consecutiveFailures = 0;
  private restarts = 0;
  private exitWaiters: Array<() => void> = [];

  constructor(options: BridgeOptions) {
    this.options = options;
    this.dotId = options.dotId;
    this.cid = options.cid;
    this.socketPath = options.socketPath;
  }

  get running(): boolean {
    return this.process !== undefined;
  }

  /** How many times socat was restarted after dying on its own. */
  get restartCount(): number {
    return this.restarts;
  }

  /** Start socat and resolve once the socket exists. Rejects with socat's stderr if it dies first. */
  async start(): Promise<void> {
    this.stopping = false;
    if (this.process) return;
    this.supervised = false;
    try {
      await this.launch();
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.supervised = true;
  }

  private async removeStaleSocket(): Promise<void> {
    if (this.socketPath.startsWith("\\\\.\\pipe\\")) return;
    // A socket file left by a socat that was killed hard makes UNIX-LISTEN fail with EADDRINUSE.
    await unlink(this.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private async launch(): Promise<void> {
    const { runner, logger } = this.options;
    const command = this.options.socatCommand ?? "socat";
    const args = bridgeArgs(this.socketPath, this.cid);
    await this.removeStaleSocket();
    const child = runner.spawn(command, args);
    this.process = child;
    let exitInfo: string | undefined;
    child.onExit((code, signal, error) => {
      exitInfo = error ? error.message : signal ? `killed by ${signal}` : `exited with code ${code}`;
      this.onExit(child, exitInfo);
    });
    logger.info("vsock bridge started", { dotId: this.dotId, cid: this.cid, socket: this.socketPath, pid: child.pid });

    const exists = this.options.socketExists ?? defaultSocketExists;
    const timeoutMs = this.options.readyTimeoutMs ?? 5000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exitInfo !== undefined) {
        throw new Error(
          `vsock bridge for dot ${this.dotId} (${command} ${args.join(" ")}) ${exitInfo} before its socket appeared` +
            `${child.stderrTail().trim() ? `: ${child.stderrTail().trim()}` : ""}`,
        );
      }
      if (await exists(this.socketPath)) {
        this.consecutiveFailures = 0;
        return;
      }
      await sleep(25);
    }
    child.kill("SIGTERM");
    throw new Error(`vsock bridge for dot ${this.dotId}: socket ${this.socketPath} did not appear within ${timeoutMs} ms`);
  }

  private onExit(child: SpawnedProcess, info: string): void {
    if (this.process !== child) return;
    this.process = undefined;
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const waiter of waiters) waiter();
    if (this.stopping || !this.supervised) return;

    this.consecutiveFailures++;
    const base = this.options.restartDelayMs ?? 1000;
    const delay = Math.min(base * 2 ** (this.consecutiveFailures - 1), 30_000);
    this.options.logger.warn("vsock bridge died, restarting", {
      dotId: this.dotId,
      cid: this.cid,
      reason: info,
      stderr: child.stderrTail().trim() || undefined,
      restartInMs: delay,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.stopping || this.process) return;
      this.restarts++;
      this.launch().catch((error: unknown) => {
        this.options.logger.error("vsock bridge restart failed", { dotId: this.dotId, error: (error as Error).message });
        // launch() leaves this.process set only if socat is still alive; a dead one already scheduled the next try.
      });
    }, delay);
  }

  /** Stop socat (SIGTERM, then SIGKILL after 3 s) and remove the socket. Never restarts afterwards. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const child = this.process;
    if (child) {
      const exited = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(killTimer);
      this.options.logger.info("vsock bridge stopped", { dotId: this.dotId });
    }
    await this.removeStaleSocket().catch(() => {});
  }
}
