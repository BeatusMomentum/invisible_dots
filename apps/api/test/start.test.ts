/**
 * The control plane started the way `invisible-dots server` starts it, on a
 * real INVISIBLE_DOTS_HOME with the embedded PGlite; only the VM layer is a
 * fake. Each test gets an empty home in the system's temp directory.
 */
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeChannelType } from "@invisible-dots/channels/testing";
import { FakeDriver, waitFor } from "@invisible-dots/scheduler/testing";
import { InvisibleDotsClient } from "@invisible-dots/sdk";
import { newId, parseDotConfig, permissionBitsEnforced } from "@invisible-dots/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { healthyDoctor } from "../../vm-manager/test/doctor-fakes.js";
import { startServer, STOP_SIGNALS, untilStopSignal, type RunningServer, type StartServerOptions } from "../src/index.js";

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

let home: string;
const running: RunningServer[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "idots-home-"));
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** An environment with nothing but the home: no DATABASE_URL, so PGlite; no token variable. */
function envFor(dir: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { INVISIBLE_DOTS_HOME: dir, ...extra };
}

async function start(options: StartServerOptions = {}): Promise<RunningServer> {
  const server = await startServer({
    env: envFor(home),
    listen: "127.0.0.1:0",
    logger: quiet,
    driver: new FakeDriver(),
    scheduler: { dispatchIntervalMs: 60_000, idleCheckIntervalMs: 60_000 },
    ...options,
  });
  running.push(server);
  return server;
}

describe("stopping on a signal", { timeout: 120_000 }, () => {
  it("closes the database and releases the lock on every way a terminal or a service stops it", async () => {
    // Closing the console window (SIGHUP, also on Windows) and Ctrl+Break (SIGBREAK) included.
    expect([...STOP_SIGNALS]).toEqual(["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]);
    for (const signal of STOP_SIGNALS) {
      const server = await startServer({
        env: envFor(home),
        listen: "127.0.0.1:0",
        logger: quiet,
        driver: new FakeDriver(),
        scheduler: { dispatchIntervalMs: 60_000, idleCheckIntervalMs: 60_000 },
      });
      const signals = new EventEmitter();
      const done = untilStopSignal(() => server.close(), quiet, signals);
      expect(existsSync(join(home, "server.lock"))).toBe(true);
      signals.emit(signal, signal);
      await done;
      expect(existsSync(join(home, "server.lock")), signal).toBe(false);
      expect(signals.eventNames()).toEqual([]);
    }
  });
});

async function stopped(server: RunningServer): Promise<void> {
  running.splice(running.indexOf(server), 1);
  await server.close();
}

// A first PGlite start runs initdb on disk, which takes seconds on a slow machine.
describe("startServer on an empty INVISIBLE_DOTS_HOME", { timeout: 120_000 }, () => {
  it("creates api.token and master.key, opens PGlite in db/, and serves the API with that token", async () => {
    const server = await start();
    expect(server.database).toBe("pglite");
    expect(server.created).toEqual({ apiToken: true, masterKey: true });

    const tokenFile = await readFile(join(home, "config", "api.token"), "utf8");
    expect(tokenFile).toBe(`${server.token}\n`);
    expect(server.token).toMatch(/^[0-9a-f]{64}$/);
    const key = await readFile(join(home, "config", "master.key"));
    expect(key.length).toBe(32);
    expect((await readdir(join(home, "db"))).length).toBeGreaterThan(0);
    if (permissionBitsEnforced()) {
      expect((await stat(join(home, "config", "api.token"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(home, "config", "master.key"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(home, "config"))).mode & 0o777).toBe(0o700);
    }

    const api = new InvisibleDotsClient({ baseUrl: server.url, token: server.token });
    expect(await api.health()).toMatchObject({ status: "ok", database: "ok", openrouter_configured: false });
    await api.setOpenRouterKey("sk-or-first");
    expect(await api.health()).toMatchObject({ openrouter_configured: true });
    const refused = await fetch(`${server.url}/api/health`, { headers: { authorization: "Bearer wrong-token-0123456789" } });
    expect(refused.status).toBe(401);

    await stopped(server);
    await expect(stat(server.paths.serverLockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serves the host report: the machine's rows, this home's images, and the OpenRouter row from its own Scheduler", async () => {
    // The machine (QEMU, the accelerator, the disk) is faked; the images, the home and the key are this server's own.
    const { findQemu, run, accelerator, acceleratorAccess, freeSpace } = healthyDoctor().deps;
    const server = await start({ doctor: { findQemu, run, accelerator, acceleratorAccess, freeSpace } });
    const api = new InvisibleDotsClient({ baseUrl: server.url, token: server.token });

    const before = await api.doctor();
    expect(before.checks.map((c) => c.id)).toEqual(["node", "qemu", "qemu-img", "accelerator", "accelerator-probe", "disk", "golden-image", "runtime-image", "openrouter"]);
    expect(before.ok).toBe(false);
    const row = (id: string) => before.checks.find((c) => c.id === id);
    expect(row("qemu")?.status).toBe("ok");
    expect(row("golden-image")).toMatchObject({ status: "missing", detail: `none in ${server.paths.imagesDir}`, fix: "invisible-dots image build" });
    expect(row("runtime-image")?.status).toBe("missing");
    expect(row("openrouter")).toMatchObject({ status: "missing", detail: "no key stored", fix: "invisible-dots secret openrouter" });

    await api.setOpenRouterKey("sk-or-first");
    expect((await api.doctor()).checks.find((c) => c.id === "openrouter")).toEqual({ id: "openrouter", label: "OpenRouter key", status: "ok", detail: "stored" });
  });

  it("runs one host report at a time: requests that arrive while it runs share its answer", async () => {
    // The accelerator probe is the slow row; the onboarding checklist asks again and again.
    const base = healthyDoctor().deps;
    let probes = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acceleratorAccess = async () => {
      probes += 1;
      await gate;
      return base.acceleratorAccess();
    };
    const server = await start({ doctor: { ...base, acceleratorAccess } });
    const api = new InvisibleDotsClient({ baseUrl: server.url, token: server.token });

    const together = Promise.all([api.doctor(), api.doctor(), api.doctor()]);
    await waitFor(() => probes === 1, "the first request to start the probe");
    // Time for the other two requests to reach the server while the probe is held.
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    const [first, second, third] = await together;
    expect(probes).toBe(1);
    expect(second).toEqual(first);
    expect(third).toEqual(first);

    // Once it has answered, the next request runs it again.
    await api.doctor();
    expect(probes).toBe(2);
  });

  it("a restart keeps the token, the key and the data", async () => {
    const first = await start();
    await first.db.secrets.put("global", "openrouter_api_key", "sk-or-kept");
    const token = first.token;
    await stopped(first);

    const second = await start();
    expect(second.created).toEqual({ apiToken: false, masterKey: false });
    expect(second.token).toBe(token);
    expect(await second.db.secrets.openRouterKey("dot_none")).toBe("sk-or-kept");
  });

  it("starts the channels stored in the database with the server and stops them when it closes", async () => {
    const first = await start({ channelTypes: [new FakeChannelType()] });
    const dotId = newId("dot");
    await first.db.dots.insert({
      id: dotId,
      config: parseDotConfig("name: channeled\ngoal: test goal\nmodel:\n  provider: openrouter\n  id: test/model\n"),
      status: "DISABLED",
    });
    await first.channels.add(dotId, "telegram");
    await stopped(first);

    const type = new FakeChannelType();
    const second = await start({ channelTypes: [type] });
    const channel = await waitFor(() => type.channels.at(-1)?.sink && type.channels.at(-1), "the stored channel to run");
    expect(await second.channels.list(dotId)).toHaveLength(1);
    await stopped(second);
    expect(channel.sink).toBeNull();
  });

  it("refuses a second server on the same home while the first runs", async () => {
    const first = await start();
    // In one process the second start is caught by the lock's own record of what it holds.
    await expect(start()).rejects.toThrow(/already holds the invisible-dots server lock/);
    const api = new InvisibleDotsClient({ baseUrl: first.url, token: first.token });
    expect(await api.health()).toMatchObject({ status: "ok" });
  });

  it("takes over the lock of a server that died", async () => {
    await writeFile(join(home, "server.lock"), "999999999\n");
    const server = await start();
    expect(JSON.parse(await readFile(server.paths.serverLockPath, "utf8"))).toMatchObject({ pid: process.pid });
  });

  it("refuses to start when master.key is gone but the database holds encrypted values, and writes no new key", async () => {
    const first = await start();
    await first.db.secrets.put("global", "openrouter_api_key", "sk-or-locked");
    await stopped(first);
    await rm(join(home, "config", "master.key"));

    await expect(start()).rejects.toThrow(/master\.key/);
    await expect(stat(join(home, "config", "master.key"))).rejects.toMatchObject({ code: "ENOENT" });
    // The failed start released everything it took: a later start can take the lock.
    await expect(stat(join(home, "server.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("INVISIBLE_DOTS_TOKEN replaces the token file and none is written", async () => {
    const token = "env-token-0123456789abcdef";
    const server = await start({ env: envFor(home, { INVISIBLE_DOTS_TOKEN: token }) });
    expect(server.token).toBe(token);
    expect(server.created.apiToken).toBe(false);
    await expect(stat(join(home, "config", "api.token"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a failed start releases the lock and the database", async () => {
    await expect(start({ listen: "not-an-address:http" })).rejects.toThrow(/INVISIBLE_DOTS_LISTEN/);
    await expect(start({ env: envFor(home, { INVISIBLE_DOTS_TOKEN: "short" }) })).rejects.toThrow(/shorter/);
    await expect(stat(join(home, "server.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    const server = await start();
    expect(server.database).toBe("pglite");
  });

  it("with INVISIBLE_DOTS_WHATSAPP=1 and no WhatsApp client installed, starts anyway and says in the log how to install it", async () => {
    const warnings: string[] = [];
    const logger = { ...quiet, warn: (message: string) => void warnings.push(message) };
    const server = await start({ env: envFor(home, { INVISIBLE_DOTS_WHATSAPP: "1" }), logger, whatsappClientDir: join(home, "no-client") });
    expect(warnings.filter((m) => m.includes("WhatsApp client is not installed"))).toHaveLength(1);
    expect(warnings.join("\n")).toContain("npm run whatsapp:install");
    expect(server.channels.kinds).toEqual(["telegram", "whatsapp"]);
    const api = new InvisibleDotsClient({ baseUrl: server.url, token: server.token });
    expect(await api.health()).toMatchObject({ status: "ok" });
  });

  it("says nothing of the WhatsApp client when WhatsApp is not asked for, or when the client is there", async () => {
    const client = join(home, "client");
    await mkdir(join(client, "node_modules", "baileys"), { recursive: true });
    await writeFile(join(client, "package.json"), "{}");
    await writeFile(join(client, "node_modules", "baileys", "package.json"), JSON.stringify({ name: "baileys", main: "index.js" }));
    await writeFile(join(client, "node_modules", "baileys", "index.js"), "");
    const warnings: string[] = [];
    const logger = { ...quiet, warn: (message: string) => void warnings.push(message) };
    const first = await start({ logger, whatsappClientDir: join(home, "no-client") });
    await stopped(first);
    await start({ env: envFor(home, { INVISIBLE_DOTS_WHATSAPP: "1" }), logger, whatsappClientDir: client });
    expect(warnings.filter((m) => m.includes("WhatsApp"))).toEqual([]);
  });
});
