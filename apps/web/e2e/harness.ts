/**
 * The real control plane and the real web server, for the browser tests: `startServer` of apps/api in this process
 * on a temporary INVISIBLE_DOTS_HOME (PGlite), with FakeDriver for the VM layer, so a test can drive what a Dot's
 * computer does (`driver.guestOf(id)`); and `next start` of the built web client as a child, pointed at it.
 * Only `next build` has to have run before.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, type RunningServer } from "@invisible-dots/api";
import { FakeDriver, waitUntilSettledReady } from "@invisible-dots/scheduler/testing";
import { InvisibleDotsClient, type DotRecord } from "@invisible-dots/sdk";
import { ENV } from "@invisible-dots/shared";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

export interface Harness {
  /** The web client, as the browser opens it. */
  webUrl: string;
  /** The control plane behind it. */
  control: RunningServer;
  driver: FakeDriver;
  /** The control plane's SDK client, signed in with its token. */
  api: InvisibleDotsClient;
  /** The token the login page asks for. */
  token: string;
  /** A Dot whose computer is up and READY. */
  createDot(name: string, goal?: string): Promise<DotRecord>;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("no port"))));
    });
  });
}

async function waitForWeb(url: string, child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`next start exited with ${child.exitCode}:\n${output()}`);
    try {
      if ((await fetch(`${url}/login`)).ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`next start did not answer within 60 s:\n${output()}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function startHarness(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "idots-e2e-"));
  const driver = new FakeDriver();
  const control = await startServer({
    env: { INVISIBLE_DOTS_HOME: home },
    listen: "127.0.0.1:0",
    logger: quiet,
    driver,
    // Quick polls, so a Dot is READY in milliseconds; the slow background loops are not needed.
    scheduler: {
      dispatchIntervalMs: 60_000,
      idleCheckIntervalMs: 60_000,
      lifecycle: { healthPollMs: 20, readyTimeoutMs: 15_000, pumpRetryMs: 20 },
      dispatcher: { retryDelayMs: 0 },
    },
  });

  const port = await freePort();
  const log: string[] = [];
  const next = spawn(process.execPath, [join(WEB_ROOT, "../../node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: WEB_ROOT,
    env: { ...process.env, INVISIBLE_DOTS_HOME: home, [ENV.URL]: control.url, [ENV.TOKEN]: control.token, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  next.stdout.on("data", (chunk: Buffer) => log.push(String(chunk)));
  next.stderr.on("data", (chunk: Buffer) => log.push(String(chunk)));
  const webUrl = `http://127.0.0.1:${port}`;

  const close = async () => {
    next.kill();
    await control.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  try {
    await waitForWeb(webUrl, next, () => log.join(""));
  } catch (error) {
    await close();
    throw error;
  }

  const api = new InvisibleDotsClient({ baseUrl: control.url, token: control.token });
  // A Dot is not READY until the guest holds a key (the READY procedure pushes it); the fake guest accepts any.
  await api.setOpenRouterKey("sk-or-e2e-0123456789abcdef");
  return {
    webUrl,
    control,
    driver,
    api,
    token: control.token,
    async createDot(name, goal = "watch the fares") {
      const dot = await api.createDot(`name: ${name}\ngoal: ${goal}\nmodel:\n  provider: openrouter\n  id: test/model\ncomputer:\n  idle_timeout: 15m\n`);
      await waitUntilSettledReady(control.scheduler, driver, dot.id, name);
      return dot;
    },
    close,
  };
}
