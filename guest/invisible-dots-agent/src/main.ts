/**
 * Entry point of `invisible-dots-agent.service`. Every setting has a default
 * that matches the guest layout of architecture section 4.2; environment
 * variables override the defaults and command line flags override both.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { GUEST_PATHS } from "@invisible-dots/shared";
import { createAgent, type ListenTarget } from "./agent.js";
import { createJsonLogger, isLogLevel } from "./logger.js";

export const AGENT_ENV = {
  SOCKET: "INVISIBLE_DOTS_AGENT_SOCKET",
  LISTEN: "INVISIBLE_DOTS_AGENT_LISTEN",
  DB: "INVISIBLE_DOTS_DB",
  BROWSERS_DIR: "INVISIBLE_DOTS_BROWSERS_DIR",
  AGENTD_SOCKET: "INVISIBLE_DOTS_AGENTD_SOCKET",
  MCP_COMMAND: "INVISIBLE_DOTS_MCP_COMMAND",
  OPENROUTER_URL: "INVISIBLE_DOTS_OPENROUTER_URL",
  NETWORK_CHECK: "INVISIBLE_DOTS_NETWORK_CHECK",
  GUEST_CONFIG: "INVISIBLE_DOTS_GUEST_CONFIG",
  LOG_LEVEL: "INVISIBLE_DOTS_LOG_LEVEL",
} as const;

const USAGE = `invisible-dots-agent: the Dot's main process

Options (environment variable in brackets):
  --socket <path>         unix socket to serve on [${AGENT_ENV.SOCKET}] (default ${GUEST_PATHS.agentSocket})
  --listen <host:port>    serve on TCP instead, for development [${AGENT_ENV.LISTEN}]
  --db <path>             SQLite state [${AGENT_ENV.DB}] (default ${GUEST_PATHS.database})
  --browsers-dir <path>   browser identities [${AGENT_ENV.BROWSERS_DIR}] (default ${GUEST_PATHS.browsers})
  --agentd-socket <path>  dot-agentd local API [${AGENT_ENV.AGENTD_SOCKET}] (default ${GUEST_PATHS.agentdSocket})
  --mcp-command <cmd>     browser MCP server command line [${AGENT_ENV.MCP_COMMAND}] (default invisible-playwright-mcp)
  --log-level <level>     debug, info, warn or error [${AGENT_ENV.LOG_LEVEL}] (default info)
  -h, --help              show this help

Also read: ${AGENT_ENV.OPENROUTER_URL} (chat completions URL override), ${AGENT_ENV.NETWORK_CHECK}
(host:port probed by the network health check, default openrouter.ai:443), ${AGENT_ENV.GUEST_CONFIG}
(default ${GUEST_PATHS.config}, read for the dot id only).
`;

export interface MainSettings {
  listen: ListenTarget;
  dbPath: string;
  browsersDir: string;
  agentdSocket: string;
  mcpCommand: string[];
  logLevel: "debug" | "info" | "warn" | "error";
  openrouterUrl: string | undefined;
  networkCheckTarget: string | undefined;
  guestConfigPath: string;
}

/** Resolve the settings from flags and environment; throws with a readable message on bad input. */
export function resolveSettings(argv: string[], env: Record<string, string | undefined>): MainSettings | "help" {
  const { values } = parseArgs({
    args: argv,
    options: {
      socket: { type: "string" },
      listen: { type: "string" },
      db: { type: "string" },
      "browsers-dir": { type: "string" },
      "agentd-socket": { type: "string" },
      "mcp-command": { type: "string" },
      "log-level": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) return "help";

  const pick = (flag: string | undefined, name: string) => flag ?? (env[name] || undefined);
  const listenText = pick(values.listen, AGENT_ENV.LISTEN);
  const socketPath = pick(values.socket, AGENT_ENV.SOCKET) ?? GUEST_PATHS.agentSocket;
  const listen: ListenTarget = listenText ? parseHostPort(listenText) : { socketPath };

  const logLevel = pick(values["log-level"], AGENT_ENV.LOG_LEVEL) ?? "info";
  if (!isLogLevel(logLevel)) throw new Error(`invalid log level "${logLevel}": use debug, info, warn or error`);

  const mcpText = pick(values["mcp-command"], AGENT_ENV.MCP_COMMAND) ?? "invisible-playwright-mcp";
  const mcpCommand = parseCommandLine(mcpText);
  if (mcpCommand.length === 0) throw new Error("the MCP command is empty");

  return {
    listen,
    dbPath: pick(values.db, AGENT_ENV.DB) ?? GUEST_PATHS.database,
    browsersDir: pick(values["browsers-dir"], AGENT_ENV.BROWSERS_DIR) ?? GUEST_PATHS.browsers,
    agentdSocket: pick(values["agentd-socket"], AGENT_ENV.AGENTD_SOCKET) ?? GUEST_PATHS.agentdSocket,
    mcpCommand,
    logLevel,
    openrouterUrl: env[AGENT_ENV.OPENROUTER_URL] || undefined,
    networkCheckTarget: env[AGENT_ENV.NETWORK_CHECK] || undefined,
    guestConfigPath: env[AGENT_ENV.GUEST_CONFIG] || GUEST_PATHS.config,
  };
}

function parseHostPort(text: string): { host: string; port: number } {
  const index = text.lastIndexOf(":");
  const host = index > 0 ? text.slice(0, index) : "127.0.0.1";
  const port = Number(index >= 0 ? text.slice(index + 1) : text);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid listen address "${text}": expected host:port`);
  return { host, port };
}

/** A JSON array of strings, or words split on whitespace. */
export function parseCommandLine(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || !parsed.every((p) => typeof p === "string")) {
      throw new Error("the MCP command, when JSON, must be an array of strings");
    }
    return parsed;
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

/** The dot id from the cloud-init config, for log lines. The token in the same file is never read out. */
function readDotId(path: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { dotId?: unknown };
    return typeof parsed.dotId === "string" ? parsed.dotId : undefined;
  } catch {
    return undefined;
  }
}

export async function main(argv: string[] = process.argv.slice(2), env = process.env): Promise<void> {
  let settings: MainSettings | "help";
  try {
    settings = resolveSettings(argv, env);
  } catch (error) {
    process.stderr.write(`invisible-dots-agent: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    process.exit(2);
  }
  if (settings === "help") {
    process.stdout.write(USAGE);
    return;
  }

  const dotId = readDotId(settings.guestConfigPath);
  const base = createJsonLogger({ level: settings.logLevel });
  const logger = dotId
    ? {
        debug: (m: string, f?: Record<string, unknown>) => base.debug(m, { dot_id: dotId, ...f }),
        info: (m: string, f?: Record<string, unknown>) => base.info(m, { dot_id: dotId, ...f }),
        warn: (m: string, f?: Record<string, unknown>) => base.warn(m, { dot_id: dotId, ...f }),
        error: (m: string, f?: Record<string, unknown>) => base.error(m, { dot_id: dotId, ...f }),
      }
    : base;

  const agent = createAgent({
    listen: settings.listen,
    dbPath: settings.dbPath,
    browsersDir: settings.browsersDir,
    agentdSocket: settings.agentdSocket,
    mcpCommand: settings.mcpCommand,
    logger,
    env,
    ...(settings.openrouterUrl ? { openrouterUrl: settings.openrouterUrl } : {}),
    ...(settings.networkCheckTarget ? { networkCheckTarget: settings.networkCheckTarget } : {}),
  });

  let signals = 0;
  const onSignal = (signal: NodeJS.Signals) => {
    signals += 1;
    if (signals > 1) {
      logger.warn("second signal: exiting without a clean shutdown", { signal });
      process.exit(1);
    }
    logger.info("signal received", { signal });
    agent.shutdown().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error("shutdown failed", { error: error instanceof Error ? error.message : String(error) });
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  process.on("uncaughtException", (error) => {
    // systemd restarts the unit; the state on disk is what the next start resumes from.
    logger.error("uncaught exception", { error: error.message, stack: error.stack });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled rejection", { error: reason instanceof Error ? reason.message : String(reason) });
  });

  try {
    await agent.start();
  } catch (error) {
    logger.error("could not start", { error: error instanceof Error ? error.message : String(error) });
    await agent.shutdown().catch(() => undefined);
    process.exit(1);
  }
}
