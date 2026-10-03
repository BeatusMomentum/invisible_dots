/**
 * Composition of the Dot's process: the store, the model client, the
 * browser identities, the tool registry, the runtime and the HTTP server.
 */
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DotRuntime, type Logger, type ToolRegistry } from "@invisible-dots/engine";
import { BrowserIdentityManager } from "@invisible-dots/browser-manager";
import { DotStore } from "@invisible-dots/memory";
import { OpenRouterClient } from "@invisible-dots/openrouter-client";
import { socketIsAFile, type DotRuntimeConfig, type GuestChecks } from "@invisible-dots/shared";
import { createToolRegistry, SocketAgentdClient, type MemoryToolStore } from "@invisible-dots/tools";
import { createGuestChecks } from "./checks.js";
import type { IdentityLimits } from "./identities.js";
import { createAgentServer } from "./server.js";

export type ListenTarget = { socketPath: string } | { host: string; port: number };

export interface AgentOptions {
  listen: ListenTarget;
  dbPath: string;
  browsersDir: string;
  agentdSocket: string;
  /** Command and arguments of the browser layer's MCP server. */
  mcpCommand: string[];
  logger: Logger;
  openrouterUrl?: string;
  networkCheckTarget?: string;
  env?: Record<string, string | undefined>;
  /** Replaces the real tool registry, for tests. */
  registry?: ToolRegistry;
  /** Replaces the guest checks, for tests. */
  checks?: () => Promise<GuestChecks>;
}

/** Schema defaults of `browser.identities`, used until a config arrives. */
const DEFAULT_LIMITS: IdentityLimits = { maxOpen: 3, maxIdentities: 20 };

function limitsOf(config: DotRuntimeConfig): IdentityLimits {
  return { maxOpen: config.browser.identities.max_open, maxIdentities: config.browser.identities.max_identities };
}

export interface Agent {
  store: DotStore;
  model: OpenRouterClient;
  runtime: DotRuntime;
  identities: BrowserIdentityManager;
  /** Listen, then start the runtime; resolves with the bound address. */
  start(): Promise<string>;
  /** Stop taking requests, pause work, close browsers, flush and close the database. */
  shutdown(): Promise<void>;
}

export function createAgent(options: AgentOptions): Agent {
  const log = options.logger;
  const env = options.env ?? process.env;
  const store = DotStore.open(options.dbPath);
  const model = new OpenRouterClient({
    ...(options.openrouterUrl ? { url: options.openrouterUrl } : {}),
    logger: { warn: (m, f) => log.warn(m, f), debug: (m, f) => log.debug(m, f) },
  });

  const identities = new BrowserIdentityManager({
    persistence: store,
    browsersDir: options.browsersDir,
    ...DEFAULT_LIMITS,
    mcpCommand: options.mcpCommand,
    env,
    emit: (event) => {
      store.appendEvent(event.type, event.data);
    },
    log: (line) => log.info(line, { component: "browser-manager" }),
  });
  /** Apply the limits of a config; open browsers within the new max_open stay open. */
  const applyLimits = async (config: DotRuntimeConfig) => {
    const next = limitsOf(config);
    const current = identities.limits;
    if (next.maxOpen === current.maxOpen && next.maxIdentities === current.maxIdentities) return;
    await identities.setLimits(next);
    log.info("browser identity limits changed", { ...next, open: identities.openCount });
  };

  // The memory package keeps hit fields in camelCase; the tools speak the wire's snake_case.
  const memory: MemoryToolStore = {
    remember: (key, content) => {
      store.remember(key, content);
    },
    search: (query, limit) =>
      store.searchMemories(query, limit).map((hit) => ({ key: hit.key, content: hit.content, updated_at: hit.updatedAt })),
  };

  const registry =
    options.registry ??
    createToolRegistry({
      agentd: new SocketAgentdClient({ socketPath: options.agentdSocket }),
      browsers: identities,
      store: memory,
    });
  const agentRuntime = new DotRuntime({ store, registry, model, logger: log });

  const checks =
    options.checks ??
    createGuestChecks({
      writableDir: dirname(options.dbPath),
      browserCommand: options.mcpCommand[0] ?? "invisible-playwright-mcp",
      env,
      ...(options.networkCheckTarget ? { networkTarget: options.networkCheckTarget } : {}),
    });

  const http = createAgentServer({
    runtime: agentRuntime,
    store,
    model,
    identities,
    checks,
    logger: log,
    onConfig: applyLimits,
  });

  let shuttingDown: Promise<void> | undefined;

  return {
    store,
    model,
    runtime: agentRuntime,
    identities,

    async start() {
      const address = await listen(http.server, options.listen);
      agentRuntime.start();
      if (agentRuntime.config) await applyLimits(agentRuntime.config);
      log.info("invisible-dots-agent listening", {
        address,
        db: options.dbPath,
        configured: agentRuntime.config !== null,
        last_seq: store.lastSeq(),
      });
      return address;
    },

    shutdown() {
      shuttingDown ??= (async () => {
        log.info("shutting down");
        const closed = new Promise<void>((resolve) => http.server.close(() => resolve()));
        http.closeStreams();
        await agentRuntime.stop();
        try {
          await identities.closeAll();
        } catch (error) {
          log.warn("closing browser sessions failed", { error: error instanceof Error ? error.message : String(error) });
        }
        http.server.closeIdleConnections();
        await closed;
        store.close();
        if ("socketPath" in options.listen && socketIsAFile(options.listen.socketPath)) {
          await rm(options.listen.socketPath, { force: true });
        }
        log.info("shut down cleanly");
      })();
      return shuttingDown;
    },
  };
}

async function listen(server: Server, target: ListenTarget): Promise<string> {
  if ("socketPath" in target) {
    // Only a unix socket is a file; the named pipe a test on a Windows host
    // listens on has no directory, no leftover and no permission bits.
    const isFile = socketIsAFile(target.socketPath);
    if (isFile) {
      await mkdir(dirname(target.socketPath), { recursive: true });
      // A socket file left by a crash makes listen fail with EADDRINUSE.
      await rm(target.socketPath, { force: true });
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(target.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    // dot-agentd runs as the same user; nobody else may talk to the agent.
    if (isFile) await chmod(target.socketPath, 0o600);
    return target.socketPath;
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(target.port, target.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `${address.address}:${address.port}`;
}
