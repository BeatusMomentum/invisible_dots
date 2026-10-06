import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { locateWebBuild, startWebServer, webEnvironment, WebStartError, type WebServer, type WebServerOptions } from "../src/web.js";

let root: string;
let started: WebServer[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "idots-web-"));
});

afterEach(async () => {
  await Promise.all(started.map((web) => web.stop()));
  started = [];
  await rm(root, { recursive: true, force: true });
});

/** A server script that answers every request with the environment it was started with. */
const ECHO_SERVER = `
import { createServer } from "node:http";
createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ env: process.env, cwd: process.cwd() }));
}).listen(Number(process.env.PORT), process.env.HOSTNAME);
`;

async function script(source: string): Promise<string> {
  const entry = join(root, "server.mjs");
  await writeFile(entry, source);
  return entry;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

async function start(entry: string, over: Partial<WebServerOptions> = {}) {
  const port = await freePort();
  const exits: string[] = [];
  const web = await startWebServer({
    build: { entry, missing: undefined },
    listen: { host: "127.0.0.1", port },
    apiUrl: "http://127.0.0.1:8787",
    env: { PATH: process.env.PATH },
    onUnexpectedExit: (message) => exits.push(message),
    ...over,
  });
  started.push(web);
  return { web, port, exits };
}

describe("locateWebBuild", () => {
  it("names the server script and the first file of the build that is missing", async () => {
    const empty = await locateWebBuild(root);
    expect(empty.entry).toBe(join(root, "apps", "web", ".next", "standalone", "apps", "web", "server.js"));
    expect(empty.missing).toBe(empty.entry);

    const app = join(root, "apps", "web", ".next", "standalone", "apps", "web");
    await mkdir(app, { recursive: true });
    await writeFile(join(app, "server.js"), "");
    expect((await locateWebBuild(root)).missing).toBe(join(app, ".next", "static"));

    await mkdir(join(app, ".next", "static"), { recursive: true });
    expect((await locateWebBuild(root)).missing).toBeUndefined();
  });
});

describe("webEnvironment", () => {
  it("passes on where to listen and the API, the data directory and what the Host check allows, and nothing else", () => {
    const env = webEnvironment({
      env: {
        PATH: "/bin",
        INVISIBLE_DOTS_HOME: "/data",
        INVISIBLE_DOTS_WEB_ALLOWED_HOSTS: "dots.example",
        DATABASE_URL: "postgres://user:secret@db/dots",
        OPENROUTER_API_KEY: "sk-secret",
        INVISIBLE_DOTS_URL: "http://elsewhere:1",
      },
      listen: { host: "127.0.0.1", port: 3000 },
      apiUrl: "http://127.0.0.1:8787",
    });
    expect(env).toEqual({
      PATH: "/bin",
      INVISIBLE_DOTS_HOME: "/data",
      INVISIBLE_DOTS_WEB_ALLOWED_HOSTS: "dots.example",
      INVISIBLE_DOTS_URL: "http://127.0.0.1:8787",
      PORT: "3000",
      HOSTNAME: "127.0.0.1",
    });
  });

  it("passes the API token only when the server was given it in its environment", () => {
    const env = webEnvironment({
      env: { INVISIBLE_DOTS_TOKEN: "token-from-the-environment" },
      listen: { host: "127.0.0.1", port: 3000 },
      apiUrl: "http://127.0.0.1:8787",
    });
    expect(env.INVISIBLE_DOTS_TOKEN).toBe("token-from-the-environment");
  });
});

describe("startWebServer", { timeout: 30_000 }, () => {
  it("starts the script on the listen address with the web environment and answers at its url", async () => {
    const entry = await script(ECHO_SERVER);
    const { web, port } = await start(entry, { env: { PATH: process.env.PATH, DATABASE_URL: "postgres://user:secret@db/dots" } });
    expect(web.url).toBe(`http://127.0.0.1:${port}`);
    const body = (await (await fetch(web.url)).json()) as { env: Record<string, string>; cwd: string };
    expect(body.env.PORT).toBe(String(port));
    expect(body.env.HOSTNAME).toBe("127.0.0.1");
    expect(body.env.INVISIBLE_DOTS_URL).toBe("http://127.0.0.1:8787");
    expect(body.env.DATABASE_URL).toBeUndefined();
    // It runs in its own directory, never the server's.
    expect(realpathSync.native(body.cwd)).toBe(realpathSync.native(root));
  });

  it("stops the child: nothing answers afterwards, and a second stop is harmless", async () => {
    const entry = await script(ECHO_SERVER);
    const { web, exits } = await start(entry);
    await web.stop();
    await web.stop();
    await expect(fetch(web.url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    expect(exits).toEqual([]);
  });

  it("reports a child that exits later, once", async () => {
    const entry = await script(`
      import { createServer } from "node:http";
      createServer((req, res) => res.end("ok")).listen(Number(process.env.PORT), process.env.HOSTNAME);
      setTimeout(() => { console.error("out of memory"); process.exit(7); }, 1500);
    `);
    const { exits } = await start(entry);
    await expect.poll(() => exits.length, { timeout: 10_000 }).toBe(1);
    expect(exits[0]).toBe("the web server exited (exit code 7): out of memory");
  });

  it("fails with the child's own words when it exits before it answers", async () => {
    const entry = await script(`console.error("Error: listen EADDRINUSE"); process.exit(1);`);
    await expect(start(entry)).rejects.toThrow(new WebStartError("the web server exited (exit code 1): Error: listen EADDRINUSE"));
  });

  it("refuses a port something already answers on, instead of waiting on the wrong server", async () => {
    const other = await script(ECHO_SERVER);
    const { web, port } = await start(other);
    await expect(start(other, { listen: { host: "127.0.0.1", port } })).rejects.toThrow(
      `${web.url} is already in use; free the port or set INVISIBLE_DOTS_WEB_LISTEN to another host:port`,
    );
  });

  it("fails and kills the child when it does not answer in time", async () => {
    const entry = await script(`setInterval(() => {}, 1000);`);
    await expect(start(entry, { readyTimeoutMs: 600, stopTimeoutMs: 2000 })).rejects.toThrow(/did not answer at http:\/\/127\.0\.0\.1:\d+ within 0\.6 s/);
  });

  it("stops waiting when the signal aborts, and leaves no child", async () => {
    const entry = await script(`setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    await expect(start(entry, { signal: controller.signal })).rejects.toThrow("stopped while the web client was starting");
  });

  it("does not start at all when the build is incomplete, or the port is 0", async () => {
    await expect(start("/nowhere/server.js", { build: { entry: "/nowhere/server.js", missing: "/nowhere/server.js" } })).rejects.toThrow(
      "the web client is not built (/nowhere/server.js does not exist); build it with: npm run build --workspace @invisible-dots/web",
    );
    await expect(start("/nowhere/server.js", { listen: { host: "127.0.0.1", port: 0 } })).rejects.toThrow("INVISIBLE_DOTS_WEB_LISTEN needs a fixed port");
  });
});
