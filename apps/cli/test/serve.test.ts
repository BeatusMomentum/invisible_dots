import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseListen } from "@invisible-dots/api";
import type { HostPaths } from "@invisible-dots/shared";
import { serve, type ServeDeps } from "../src/serve.js";
import type { WebServer, WebServerOptions } from "../src/web.js";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "idots-serve-"));
});

afterEach(() => rm(repoRoot, { recursive: true, force: true }));

async function buildWeb() {
  const app = join(repoRoot, "apps", "web", ".next", "standalone", "apps", "web");
  await mkdir(join(app, ".next", "static"), { recursive: true });
  await writeFile(join(app, "server.js"), "");
}

/** The control plane and the web server as fakes that record what happened to them, in order. */
function harness(over: { webStart?: (options: WebServerOptions) => Promise<WebServer> } = {}) {
  const log: string[] = [];
  const lines: string[] = [];
  const signals = new EventEmitter();
  const webOptions: WebServerOptions[] = [];
  const logger = {
    debug() {},
    info: (m: string) => lines.push(`info ${m}`),
    warn: (m: string) => lines.push(`warn ${m}`),
    error: (m: string) => lines.push(`error ${m}`),
  };
  let stopped!: () => void;
  const deps: ServeDeps = {
    startServer: async (options) => {
      log.push(`server start env=${options.env ? "given" : "none"}`);
      return {
        url: "http://127.0.0.1:8787",
        paths: { apiTokenPath: "/home/x/.invisible-dots/config/api.token" } as HostPaths,
        close: async () => {
          log.push("server close");
        },
      };
    },
    untilStopSignal: (close, _logger, emitter) =>
      new Promise<void>((resolve) => {
        stopped = resolve;
        emitter?.once("SIGINT", () => void close().then(resolve));
      }),
    parseListen,
    startWebServer:
      over.webStart ??
      (async (options) => {
        webOptions.push(options);
        log.push("web start");
        return {
          url: `http://${options.listen.host}:${options.listen.port}`,
          stop: async () => {
            log.push("web stop");
          },
        };
      }),
  };
  const run = (options: { web: boolean; env?: Record<string, string> }) =>
    serve({ env: options.env ?? {}, logger, web: options.web, repoRoot, signals }, deps);
  return { run, log, lines, signals, webOptions, release: () => stopped?.() };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("serve", () => {
  it("starts the control plane, then the web client on the default address pointed at it, and stops them in the other order", async () => {
    await buildWeb();
    const h = harness();
    const running = h.run({ web: true });
    await tick();
    expect(h.log).toEqual(["server start env=given", "web start"]);
    expect(h.webOptions[0]).toMatchObject({ listen: { host: "127.0.0.1", port: 3000 }, apiUrl: "http://127.0.0.1:8787" });
    expect(h.webOptions[0]!.build.missing).toBeUndefined();
    expect(h.lines).toContain("info API token in /home/x/.invisible-dots/config/api.token; stop with Ctrl+C (Dots keep running)");
    expect(h.lines).toContain("info web client at http://127.0.0.1:3000; sign in with the API token");
    h.signals.emit("SIGINT");
    await running;
    expect(h.log).toEqual(["server start env=given", "web start", "web stop", "server close"]);
  });

  it("listens where INVISIBLE_DOTS_WEB_LISTEN says", async () => {
    await buildWeb();
    const h = harness();
    const running = h.run({ web: true, env: { INVISIBLE_DOTS_WEB_LISTEN: "127.0.0.1:3100" } });
    await tick();
    expect(h.webOptions[0]!.listen).toEqual({ host: "127.0.0.1", port: 3100 });
    h.signals.emit("SIGINT");
    await running;
  });

  it("fails before starting anything when INVISIBLE_DOTS_WEB_LISTEN is malformed", async () => {
    const h = harness();
    await expect(h.run({ web: true, env: { INVISIBLE_DOTS_WEB_LISTEN: "three-thousand" } })).rejects.toThrow(/INVISIBLE_DOTS_WEB_LISTEN must look like/);
    expect(h.log).toEqual([]);
  });

  it("names the web client's own default, not the API's, when INVISIBLE_DOTS_WEB_LISTEN is malformed", async () => {
    const h = harness();
    await expect(h.run({ web: true, env: { INVISIBLE_DOTS_WEB_LISTEN: "three-thousand" } })).rejects.toThrow(
      'INVISIBLE_DOTS_WEB_LISTEN must look like "127.0.0.1:3000", got "three-thousand"',
    );
  });

  it("fails before starting anything when INVISIBLE_DOTS_WEB_LISTEN names port 0", async () => {
    const h = harness();
    await expect(h.run({ web: true, env: { INVISIBLE_DOTS_WEB_LISTEN: "127.0.0.1:0" } })).rejects.toThrow(
      'INVISIBLE_DOTS_WEB_LISTEN needs a fixed port, got "127.0.0.1:0"',
    );
    expect(h.log).toEqual([]);
  });

  it("does not start the web client with --no-web, and does not read INVISIBLE_DOTS_WEB_LISTEN", async () => {
    await buildWeb();
    const h = harness();
    const running = h.run({ web: false, env: { INVISIBLE_DOTS_WEB_LISTEN: "garbage" } });
    await tick();
    h.signals.emit("SIGINT");
    await running;
    expect(h.log).toEqual(["server start env=given", "server close"]);
  });

  it("keeps the control plane running, and says why, when the web client cannot start", async () => {
    const h = harness({
      webStart: async () => {
        throw new Error("http://127.0.0.1:3000 is already in use");
      },
    });
    const running = h.run({ web: true });
    await tick();
    expect(h.lines).toContain("warn web client not started: http://127.0.0.1:3000 is already in use; the control plane keeps running");
    expect(h.log).toEqual(["server start env=given"]);
    h.signals.emit("SIGINT");
    await running;
    expect(h.log).toEqual(["server start env=given", "server close"]);
  });

  it("closes the control plane on Ctrl+C while the web client is still starting, and ends that start", async () => {
    let aborted = false;
    const h = harness({
      webStart: (options) =>
        new Promise((_resolve, reject) => {
          options.signal!.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("stopped while the web client was starting"));
          });
        }),
    });
    await buildWeb();
    const running = h.run({ web: true });
    await tick();
    h.signals.emit("SIGINT");
    await running;
    expect(aborted).toBe(true);
    expect(h.log).toEqual(["server start env=given", "server close"]);
    // Ending the start is what the person asked for, not a failure to report.
    expect(h.lines.filter((line) => line.startsWith("warn"))).toEqual([]);
  });

  it("names the missing build in the web start it hands over, so the warning carries the fix", async () => {
    const h = harness();
    const running = h.run({ web: true });
    await tick();
    expect(h.webOptions[0]!.build.missing).toBe(h.webOptions[0]!.build.entry);
    h.signals.emit("SIGINT");
    await running;
  });
});
