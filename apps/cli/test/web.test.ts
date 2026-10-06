import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
      parentPid: 4242,
    });
    expect(env).toEqual({
      PATH: "/bin",
      INVISIBLE_DOTS_HOME: "/data",
      INVISIBLE_DOTS_WEB_ALLOWED_HOSTS: "dots.example",
      INVISIBLE_DOTS_URL: "http://127.0.0.1:8787",
      INVISIBLE_DOTS_WEB_PARENT_PID: "4242",
      PORT: "3000",
      HOSTNAME: "127.0.0.1",
    });
  });

  it("passes the API token only when the server was given it in its environment", () => {
    const env = webEnvironment({
      env: { INVISIBLE_DOTS_TOKEN: "token-from-the-environment" },
      listen: { host: "127.0.0.1", port: 3000 },
      apiUrl: "http://127.0.0.1:8787",
      parentPid: 4242,
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
    expect(body.env.INVISIBLE_DOTS_WEB_PARENT_PID).toBe(String(process.pid));
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

  it("does not start at all when the build is incomplete", async () => {
    await expect(start("/nowhere/server.js", { build: { entry: "/nowhere/server.js", missing: "/nowhere/server.js" } })).rejects.toThrow(
      "the web client is not built (/nowhere/server.js does not exist); build it with: npm run build --workspace @invisible-dots/web",
    );
  });
});

describe("a server that is killed outright", { timeout: 60_000 }, () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const watcher = pathToFileURL(join(here, "..", "..", "web", "src", "lib", "parent.ts")).href;
  const webModule = pathToFileURL(join(here, "..", "src", "web.ts")).href;

  it("does not leave the web server holding its port: it exits once its parent is gone", async () => {
    // Windows ends a Node child with its parent on its own (libuv puts children in a job object), so the
    // orphan this guards against is a POSIX one; the web server's own exit is what keeps both the same.
    // What the web build's instrumentation.ts does with the pid it is given, around a plain HTTP server.
    const entry = await script(`
      import { createServer } from "node:http";
      import { exitWhenParentGone, parentPidFrom } from ${JSON.stringify(watcher)};
      createServer((req, res) => res.end("ok")).listen(Number(process.env.PORT), process.env.HOSTNAME);
      const exists = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
      const parentPid = parentPidFrom(process.env.INVISIBLE_DOTS_WEB_PARENT_PID);
      if (parentPid !== undefined) exitWhenParentGone(parentPid, { exists, onGone: () => process.exit(0), intervalMs: 100 });
    `);
    const port = await freePort();
    // The server stand-in: a process that starts the web server and then waits to be killed.
    const parentScript = join(root, "parent.mjs");
    await writeFile(
      parentScript,
      `
      import { startWebServer } from ${JSON.stringify(webModule)};
      const web = await startWebServer({
        build: { entry: ${JSON.stringify(entry)}, missing: undefined },
        listen: { host: "127.0.0.1", port: ${port} },
        apiUrl: "http://127.0.0.1:8787",
        env: { PATH: process.env.PATH },
        onUnexpectedExit: () => undefined,
      });
      console.log(web.url);
      setInterval(() => {}, 1000);
    `,
    );
    const parent = spawn(process.execPath, ["--import", "tsx", parentScript], { stdio: ["ignore", "pipe", "inherit"], cwd: join(here, "..") });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        parent.once("exit", () => reject(new Error("the stand-in server exited before the web server answered")));
        parent.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString().trim()));
      });
      expect((await fetch(url)).status).toBe(200);
      parent.kill("SIGKILL");
      await expect
        .poll(() => fetch(url, { signal: AbortSignal.timeout(500) }).then(() => "still answering", () => "gone"), { timeout: 15_000, interval: 200 })
        .toBe("gone");
    } finally {
      parent.kill("SIGKILL");
    }
  });
});
