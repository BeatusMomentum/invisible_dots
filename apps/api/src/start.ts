/**
 * The control plane as one process (architecture section 2): the database,
 * the vm-manager, the scheduler and the HTTP API, composed in the order a
 * first start needs. `invisible-dots server` calls `startServer` and waits
 * with `untilStopSignal`; tests call `startServer` and close the handle
 * themselves.
 */
import type { Database } from "@invisible-dots/database";
import { errorMessage, prefixedStderrLogger, Scheduler, type ComputerDriver, type Logger, type SchedulerOptions } from "@invisible-dots/scheduler";
import { ensureDir, ENV, hostPaths, type HostPaths } from "@invisible-dots/shared";
import { loadOrCreateApiToken, loadOrGenerateMasterKey, parseListen, saveMasterKey, type ListenAddress } from "./config.js";
import { assertNothingEncrypted, openControlPlaneDatabase } from "./database.js";
import { acquireServerLock } from "./lock.js";
import { API_VERSION, buildServer, type FastifyInstance } from "./server.js";
import { createVmDriver } from "./vm-driver.js";

export interface StartServerOptions {
  /** Where every setting is read from; default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Overrides INVISIBLE_DOTS_LISTEN; port 0 picks a free port (tests). */
  listen?: string;
  logger?: Logger;
  /** The VM layer; default the real one over QEMU. Tests pass a fake. */
  driver?: ComputerDriver;
  /** Passed through to the Scheduler (timers, lifecycle and dispatcher tuning). */
  scheduler?: Omit<SchedulerOptions, "db" | "driver" | "logger">;
}

/** The logger of the `invisible-dots` process: lines on stderr prefixed with its name, debug lines when INVISIBLE_DOTS_DEBUG=1. */
export function serverLogger(env: Record<string, string | undefined> = process.env): Logger {
  return prefixedStderrLogger("invisible-dots", env.INVISIBLE_DOTS_DEBUG === "1");
}

export interface RunningServer {
  /** The base URL clients use, e.g. http://127.0.0.1:8787. */
  url: string;
  address: ListenAddress;
  token: string;
  paths: HostPaths;
  /** "pglite" or "pg", as the database adapter reports it. */
  database: string;
  /** Secrets this start created because they did not exist yet. */
  created: { apiToken: boolean; masterKey: boolean };
  app: FastifyInstance;
  scheduler: Scheduler;
  db: Database;
  /** Stop the API, the scheduler and the database. VMs keep running. Idempotent. */
  close(): Promise<void>;
}

/**
 * Start the control plane and resolve once the API listens. Every resource
 * taken before a failure is released again, so a failed start leaves no
 * lock, open database or listening socket behind.
 */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const env = options.env ?? process.env;
  const debug = env.INVISIBLE_DOTS_DEBUG === "1";
  const logger = options.logger ?? serverLogger(env);
  const paths = hostPaths(env);
  const listen = parseListen(options.listen ?? (env[ENV.LISTEN] || undefined));

  const cleanup: (() => Promise<unknown>)[] = [];
  const unwind = async () => {
    for (const step of cleanup.splice(0).reverse()) {
      await step().catch((error) => logger.error("cleanup step failed", { error: errorMessage(error) }));
    }
  };

  try {
    const lock = await acquireServerLock(paths);
    cleanup.push(() => lock.release());
    await ensureDir(paths.logsDir, 0o700);

    const [token, masterKey] = await Promise.all([loadOrCreateApiToken(paths, env), loadOrGenerateMasterKey(paths)]);
    if (token.created) logger.info("created the API token", { path: token.origin });

    const db = await openControlPlaneDatabase({ env, masterKey: masterKey.value, logger });
    cleanup.push(() => db.close());
    if (masterKey.created) {
      // Only an empty database may get a new key; see loadOrGenerateMasterKey.
      await assertNothingEncrypted(db, masterKey.origin);
      await saveMasterKey(paths, masterKey.value);
      logger.info("created the master key", { path: masterKey.origin });
    }

    const driver = options.driver ?? createVmDriver({ env, paths, logger: prefixedStderrLogger("vm-manager", debug) });
    const scheduler = new Scheduler({
      ...options.scheduler,
      db,
      driver,
      logger: options.logger ?? prefixedStderrLogger("scheduler", debug),
    });
    cleanup.push(() => scheduler.close());
    const app = buildServer({ scheduler, token: token.value, logger });
    cleanup.push(() => app.close());

    await scheduler.start();
    await app.listen({ host: listen.host, port: listen.port });
    const bound = app.server.address();
    const address: ListenAddress = typeof bound === "object" && bound ? { host: listen.host, port: bound.port } : listen;
    const host = address.host.includes(":") ? `[${address.host}]` : address.host;
    const url = `http://${host}:${address.port}`;
    logger.info(`invisible-dots server ${API_VERSION} listening`, { url, home: paths.home, database: db.kind });

    let closing: Promise<void> | null = null;
    return {
      url,
      address,
      token: token.value,
      paths,
      database: db.kind,
      created: { apiToken: token.created, masterKey: masterKey.created },
      app,
      scheduler,
      db,
      close: () => (closing ??= unwind()),
    };
  } catch (error) {
    await unwind();
    throw error;
  }
}

/**
 * Every way the person or the system asks a foreground server to stop:
 * Ctrl+C, a service manager, a closed terminal (SIGHUP; Node raises it on
 * Windows too when the console window is closed, a few seconds before
 * Windows ends the process) and Ctrl+Break on Windows (SIGBREAK). All take
 * the same clean path, which closes the embedded database and releases the
 * lock. They are event names Node accepts on both hosts; one that a host
 * never raises simply never fires.
 */
export const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;

/**
 * Resolve once `close` has finished after the first stop signal; a second
 * signal exits at once. `signals` is the process, or a stand-in in tests.
 */
export function untilStopSignal(close: () => Promise<void>, logger: Logger, signals: NodeJS.EventEmitter = process): Promise<void> {
  return new Promise<void>((resolve) => {
    let stopping = false;
    const onSignal = (signal: NodeJS.Signals) => {
      if (stopping) {
        logger.warn(`second ${signal}, exiting without waiting`);
        process.exit(1);
      }
      stopping = true;
      logger.info(`${signal} received, shutting down (VMs keep running)`);
      void close().finally(() => {
        for (const name of STOP_SIGNALS) signals.off(name, onSignal);
        logger.info("stopped");
        resolve();
      });
    };
    for (const name of STOP_SIGNALS) signals.on(name, onSignal);
  });
}
