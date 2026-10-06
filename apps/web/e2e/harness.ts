/**
 * The real control plane and the real web server, for the browser tests: `startServer` of apps/api in this process
 * on a temporary INVISIBLE_DOTS_HOME (PGlite), with FakeDriver for the VM layer, so a test can drive what a Dot's
 * computer does (`driver.guestOf(id)`); and `next start` of the built web client as a child, pointed at it.
 * The channels run for real too, on what the hub's own tests use: the Telegram adapter talks to a Bot API server of this
 * process (`bots`) and the WhatsApp adapter to a connection a test plays (`whatsapp`). Only `next build` has to have run before.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, type RunningServer } from "@invisible-dots/api";
import { TelegramChannelType, WhatsAppChannelType } from "@invisible-dots/channels";
import { FakeBotApi, FakeWhatsAppConnector } from "@invisible-dots/channels/testing";
import { FakeDriver, waitUntilSettledReady } from "@invisible-dots/scheduler/testing";
import { InvisibleDotsClient, type DotRecord } from "@invisible-dots/sdk";
import { ENV, type DoctorCheck } from "@invisible-dots/shared";
import { healthyDoctor, ok } from "../../vm-manager/test/doctor-fakes.js";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

export interface Harness {
  /** The web client, as the browser opens it. */
  webUrl: string;
  /** INVISIBLE_DOTS_HOME of the control plane: what its health answer calls the data directory. */
  home: string;
  /** The control plane behind it. */
  control: RunningServer;
  driver: FakeDriver;
  /** The Bot API the Telegram adapter polls: a test makes bots, writes to them as a person and reads what they sent. */
  bots: FakeBotApi;
  /** The WhatsApp connection of every Dot, played by a test: `whatsapp.current` is the newest. */
  whatsapp: FakeWhatsAppConnector;
  /** The control plane's SDK client, signed in with its token. */
  api: InvisibleDotsClient;
  /** The token the login page asks for. */
  token: string;
  /**
   * The host the doctor looks at: a healthy one (QEMU, an accelerator, disk), so a test does not depend on the machine
   * it runs on. A test changes what the images row says; the page's next check shows it.
   */
  host: { images: DoctorCheck[] };
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

export interface HarnessOptions {
  /**
   * Whether the control plane already holds an OpenRouter key (the default), as a host does once it has been set up.
   * Without one, no Dot reaches READY, so this is for the pages a person sees before the first Dot.
   */
  withKey?: boolean;
}

export async function startHarness({ withKey = true }: HarnessOptions = {}): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "idots-e2e-"));
  const driver = new FakeDriver();
  const bots = await FakeBotApi.start();
  const whatsapp = new FakeWhatsAppConnector();
  const host = {
    images: [ok("golden-image", "golden image", "golden-1.qcow2 matches its manifest"), ok("runtime-image", "runtime ISO", "runtime-1.iso matches its manifest")],
  };
  const control = await startServer({
    env: { INVISIBLE_DOTS_HOME: home },
    listen: "127.0.0.1:0",
    logger: quiet,
    driver,
    channelTypes: [new TelegramChannelType({ apiRoot: bots.apiRoot, pollSeconds: 1 }), new WhatsAppChannelType({ connector: () => whatsapp, pauseMs: () => 0 })],
    doctor: { ...healthyDoctor().deps, images: async () => host.images },
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
    await bots.close();
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
  if (withKey) await api.setOpenRouterKey("sk-or-e2e-0123456789abcdef");
  return {
    webUrl,
    home,
    control,
    driver,
    bots,
    whatsapp,
    host,
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
