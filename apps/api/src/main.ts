/**
 * invisible-dots-server: the control plane as one process (section 2). It
 * composes the database, the vm-manager, the scheduler and the HTTP API,
 * recovers the state of the previous run, and shuts down cleanly on SIGINT
 * and SIGTERM. VMs keep running across a restart of this process.
 */
import { fileURLToPath } from "node:url";
import { Database, loadMasterKey } from "@invisible-dots/database";
import { errorMessage, prefixedStderrLogger, Scheduler } from "@invisible-dots/scheduler";
import { cidBaseFromEnv, ENV, hostPaths } from "@invisible-dots/shared";
import { VmManager } from "@invisible-dots/vm-manager";
import { loadApiToken, parseListen, readServerEnv } from "./config.js";
import { API_VERSION, buildServer } from "./server.js";
import { VmManagerDriver } from "./vm-driver.js";

export async function main(): Promise<void> {
  // server.env is what systemd loads; reading it here makes a manual start behave the same.
  const fileEnv = await readServerEnv(hostPaths(process.env).serverEnv);
  const env: Record<string, string | undefined> = { ...fileEnv, ...process.env };
  const logger = prefixedStderrLogger("invisible-dots", env.INVISIBLE_DOTS_DEBUG === "1");

  const databaseUrl = env[ENV.DATABASE_URL];
  if (!databaseUrl) {
    throw new Error(`${ENV.DATABASE_URL} is not set (in the environment or in ${hostPaths(env).serverEnv})`);
  }
  const listen = parseListen(env[ENV.LISTEN] || undefined);
  const [masterKey, token] = await Promise.all([loadMasterKey(env), loadApiToken(env)]);

  const db = Database.connect({ connectionString: databaseUrl, masterKey });
  try {
    await db.ping();
  } catch (error) {
    await db.close().catch(() => {});
    throw new Error(`cannot connect to PostgreSQL at ${redact(databaseUrl)}: ${errorMessage(error)}`, { cause: error });
  }
  const migrated = await db.migrate({ log: (line) => logger.info(line) });
  logger.info("database ready", { applied: migrated.applied.length, total: migrated.applied.length + migrated.alreadyApplied.length });

  const vm = new VmManager({
    env,
    logger: prefixedStderrLogger("vm-manager", env.INVISIBLE_DOTS_DEBUG === "1"),
    // apps/api/src/main.ts and the bundle apps/api/dist/*.mjs sit at the same depth under the repository.
    virtualizationDir: fileURLToPath(new URL("../../../virtualization/", import.meta.url)),
  });
  const scheduler = new Scheduler({
    db,
    driver: new VmManagerDriver(vm),
    logger: prefixedStderrLogger("scheduler", env.INVISIBLE_DOTS_DEBUG === "1"),
    cidBase: cidBaseFromEnv(env),
  });
  const app = buildServer({ scheduler, token, logger });

  let stopping: Promise<void> | null = null;
  const shutdown = (signal: string) => {
    if (stopping) {
      logger.warn(`second ${signal}, exiting without waiting`);
      process.exit(1);
    }
    logger.info(`${signal} received, shutting down (VMs keep running)`);
    stopping = (async () => {
      await app.close().catch((e) => logger.error("closing the API failed", { error: errorMessage(e) }));
      await scheduler.close().catch((e) => logger.error("closing the scheduler failed", { error: errorMessage(e) }));
      await db.close().catch((e) => logger.error("closing the database failed", { error: errorMessage(e) }));
      logger.info("stopped");
      process.exit(0);
    })();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await scheduler.start();
  await app.listen({ host: listen.host, port: listen.port });
  logger.info(`invisible-dots-server ${API_VERSION} listening`, { address: `http://${listen.host}:${listen.port}` });
}

/** A connection string without its password, for error messages. */
function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "<unparseable DATABASE_URL>";
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`invisible-dots-server: ${errorMessage(error)}\n`);
  process.exit(1);
});
