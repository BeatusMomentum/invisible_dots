/**
 * The guest's own checks (architecture section 9.3): the host calls a Dot
 * READY only when they pass. They run at most once per `ttlMs` because the
 * host polls `/health` while it waits.
 */
import { constants } from "node:fs";
import { access, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { delimiter, isAbsolute, join } from "node:path";
import type { GuestChecks } from "@invisible-dots/shared";

export interface GuestCheckOptions {
  /** A directory the agent must be able to write: the state directory. */
  writableDir: string;
  /** `host:port` reached with a plain TCP connect. Default `openrouter.ai:443`. */
  networkTarget?: string;
  /** The program that starts the browser layer's MCP server. */
  browserCommand: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  ttlMs?: number;
}

export function createGuestChecks(options: GuestCheckOptions): () => Promise<GuestChecks> {
  const ttl = options.ttlMs ?? 30_000;
  const timeout = options.timeoutMs ?? 3_000;
  let cached: { at: number; value: GuestChecks } | undefined;
  let running: Promise<GuestChecks> | undefined;

  const run = async (): Promise<GuestChecks> => {
    const [filesystem_writable, network_reachable, browser_installed] = await Promise.all([
      canWrite(options.writableDir),
      canConnect(options.networkTarget ?? "openrouter.ai:443", timeout),
      isInstalled(options.browserCommand, options.env ?? process.env),
    ]);
    return { filesystem_writable, network_reachable, browser_installed };
  };

  return async () => {
    if (cached && Date.now() - cached.at < ttl) return cached.value;
    running ??= run().finally(() => {
      running = undefined;
    });
    const value = await running;
    cached = { at: Date.now(), value };
    return value;
  };
}

async function canWrite(dir: string): Promise<boolean> {
  const probe = join(dir, `.write-check-${process.pid}`);
  try {
    await writeFile(probe, "ok");
    await rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function canConnect(target: string, timeoutMs: number): Promise<boolean> {
  const index = target.lastIndexOf(":");
  const host = index > 0 ? target.slice(0, index) : target;
  const port = index > 0 ? Number(target.slice(index + 1)) : 443;
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Whether `command` names an executable file, directly or through PATH. */
export async function isInstalled(command: string, env: Record<string, string | undefined>): Promise<boolean> {
  const mode = process.platform === "win32" ? constants.F_OK : constants.X_OK;
  const candidates = isAbsolute(command) || command.includes("/")
    ? [command]
    : (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, mode);
      return true;
    } catch {
      // try the next PATH entry
    }
  }
  return false;
}
