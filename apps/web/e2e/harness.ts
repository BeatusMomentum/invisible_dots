/**
 * The real control plane and the real web server, for the browser tests: `startServer` of apps/api in this process
 * on a temporary INVISIBLE_DOTS_HOME (PGlite), with FakeDriver for the VM layer, so a test can drive what a Dot's
 * computer does (`driver.guestOf(id)`); and the web client as the product ships and runs it: the built standalone
 * server (`.next/standalone/apps/web/server.js` with its copied static files) started by the CLI's own `startWebServer`,
 * with the reduced environment `invisible-dots server` gives it (`webEnvironment`), pointed at that control plane.
 * The channels run for real too, on what the hub's own tests use: the Telegram adapter talks to a Bot API server of this
 * process (`bots`) and the WhatsApp adapter to a connection a test plays (`whatsapp`). Only `npm run build --workspace
 * @invisible-dots/web` has to have run before (the standalone build, not only `next build`).
 */
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
import { locateWebBuild, startWebServer, type WebServer } from "../../cli/src/web.js";
import { healthyDoctor, ok } from "../../vm-manager/test/doctor-fakes.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
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
  /** The API token of this control plane (the web server reads it itself; the tests call the API with it). */
  token: string;
  /**
   * The host the doctor looks at: a healthy one (QEMU, an accelerator, disk), so a test does not depend on the machine
   * it runs on. A test changes what the images row says; the page's next check shows it.
   */
  host: { images: DoctorCheck[] };
  /** A Dot whose computer is up and READY. */
  createDot(name: string, goal?: string): Promise<DotRecord>;
  /** The control plane stops answering (its server closes) while the web client goes on: what a person sees when the API dies. `close` still cleans up. */
  stopApi(): Promise<void>;
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

  let web: WebServer;
  let unexpectedExit: string | undefined;
  try {
    web = await startWebServer({
      build: await locateWebBuild(REPO_ROOT),
      listen: { host: "127.0.0.1", port: await freePort() },
      apiUrl: control.url,
      // What `invisible-dots server` has in its own environment: the web server gets the allowlisted part of it.
      env: { ...process.env, [ENV.HOME]: home, [ENV.TOKEN]: control.token },
      onUnexpectedExit: (message) => (unexpectedExit = message),
    });
  } catch (error) {
    await control.close();
    await bots.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    throw error;
  }
  const webUrl = web.url;

  let apiStopped = false;
  const stopApi = async () => {
    if (apiStopped) return;
    apiStopped = true;
    await control.close();
  };
  const close = async () => {
    await web.stop();
    await stopApi();
    await bots.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  if (unexpectedExit !== undefined) {
    await close();
    throw new Error(unexpectedExit);
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
    stopApi,
    close,
  };
}
