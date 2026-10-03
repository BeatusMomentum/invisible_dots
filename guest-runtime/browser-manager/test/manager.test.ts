import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrowserIdentityError,
  childEnvironment,
  resultText,
  type BrowserIdentityEvent,
} from "../src/index.js";
import { makeHarness, readRecord, writeControl, type Harness } from "./helpers.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const types = (events: BrowserIdentityEvent[]) => events.map((e) => e.type);

describe("identity records", () => {
  it("creates the directory layout and a metadata.json that follows the record", async () => {
    harness = await makeHarness();
    const identity = await harness.manager.create({ name: "Shopping Account" });
    expect(identity.id).toMatch(/^shopping-account-[0-9a-z]{6}$/);
    const root = join(harness.dir, "browsers", identity.id);
    expect(existsSync(join(root, "profile"))).toBe(true);
    expect(existsSync(join(root, "mcp"))).toBe(true);
    const metadata = JSON.parse(await readFile(join(root, "metadata.json"), "utf8"));
    expect(metadata).toMatchObject({ id: identity.id, name: "Shopping Account", status: "available", lastUsedAt: null });
    expect(metadata.proxy).toBeUndefined();

    await harness.manager.launch(identity.id);
    const afterLaunch = JSON.parse(await readFile(join(root, "metadata.json"), "utf8"));
    expect(afterLaunch.status).toBe("open");
    expect(typeof afterLaunch.lastUsedAt).toBe("string");

    await harness.manager.close(identity.id);
    const afterClose = JSON.parse(await readFile(join(root, "metadata.json"), "utf8"));
    expect(afterClose.status).toBe("available");
    expect(types(harness.events)).toEqual([
      "browser.identity.created",
      "browser.identity.launched",
      "browser.identity.closed",
    ]);
    expect(harness.events[0]!.data).toEqual({ identity_id: identity.id, name: "Shopping Account" });
  });

  it("refuses an empty name, a bad proxy and more than max_identities", async () => {
    harness = await makeHarness({ maxIdentities: 2 });
    await expect(harness.manager.create({ name: "   " })).rejects.toThrow(/non-empty name/);
    await expect(harness.manager.create({ name: "a", proxy: "ftp://host:21" })).rejects.toThrow(/http, https, socks4 or socks5/);
    await expect(harness.manager.create({ name: "a", proxy: "not a url" })).rejects.toThrow(/must be a URL/);
    await harness.manager.create({ name: "one" });
    await harness.manager.create({ name: "two" });
    await expect(harness.manager.create({ name: "three" })).rejects.toThrow(/max_identities 2/);
  });

  it("delete closes the session, removes the directory and the record", async () => {
    harness = await makeHarness();
    const identity = await harness.manager.create({ name: "temp" });
    await harness.manager.launch(identity.id);
    const root = join(harness.dir, "browsers", identity.id);
    await harness.manager.delete(identity.id);
    expect(existsSync(root)).toBe(false);
    expect(await harness.manager.get(identity.id)).toBeNull();
    expect(harness.manager.isOpen(identity.id)).toBe(false);
    expect(types(harness.events).slice(-2)).toEqual(["browser.identity.closed", "browser.identity.deleted"]);
    await expect(harness.manager.delete(identity.id)).rejects.toBeInstanceOf(BrowserIdentityError);
  });

  it("refuses ids that could leave the browsers directory", async () => {
    harness = await makeHarness();
    await expect(harness.manager.launch("../etc")).rejects.toThrow(/no browser identity/);
    await expect(harness.manager.delete("a/../../b")).rejects.toThrow(/no browser identity/);
    expect(await harness.manager.get("..")).toBeNull();
  });

  it("reports a stored open status as available when no session runs", async () => {
    harness = await makeHarness();
    const identity = await harness.manager.create({ name: "stale" });
    await harness.persistence.putIdentity({ ...identity, status: "open" });
    expect((await harness.manager.get(identity.id))!.status).toBe("available");
    expect((await harness.manager.list())[0]!.status).toBe("available");
  });
});

// These start real MCP server processes (tsx): a loaded machine needs more than the default 5 s per test.
describe("launch", { timeout: 60_000 }, () => {
  it("starts the MCP server with exactly the allowlisted environment", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test-not-a-real-key";
    process.env.SOME_OTHER_SECRET = "hidden";
    try {
      harness = await makeHarness({ display: ":7" });
      const identity = await harness.manager.create({ name: "env check", proxy: "http://user:pw@proxy.test:8080" });
      await harness.manager.launch(identity.id);
      const root = join(harness.dir, "browsers", identity.id);
      const [start] = await readRecord(join(root, "mcp"));
      const env = start!.env!;
      expect(env.INVISIBLE_MCP_HOME).toBe(join(root, "mcp"));
      expect(env.INVISIBLE_MCP_SESSION_ID).toBe(identity.id);
      expect(env.STEALTHFOX_PROFILE_DIR).toBe(join(root, "profile"));
      expect(env.STEALTHFOX_HEADLESS).toBe("0");
      expect(env.DISPLAY).toBe(":7");
      expect(env.STEALTHFOX_PROXY).toBe("http://user:pw@proxy.test:8080");
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(env.SOME_OTHER_SECRET).toBeUndefined();
    } finally {
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.SOME_OTHER_SECRET;
    }
  });

  it("leaves STEALTHFOX_PROXY unset for an identity without a proxy, even if the agent has one", () => {
    const env = childEnvironment(
      { identityId: "a-1", profileDir: "/p", mcpHome: "/m", display: ":0" },
      { PATH: "/usr/bin", STEALTHFOX_PROXY: "http://leak:1", OPENROUTER_API_KEY: "k", BASH_FUNC: "() { :; }", HOME: "() { x; }" },
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      INVISIBLE_MCP_HOME: "/m",
      INVISIBLE_MCP_SESSION_ID: "a-1",
      STEALTHFOX_PROFILE_DIR: "/p",
      STEALTHFOX_HEADLESS: "0",
      DISPLAY: ":0",
    });
  });

  it("calls browser_open with only the browser role, and retries while the engine downloads", async () => {
    harness = await makeHarness();
    const identity = await harness.manager.create({ name: "slow engine", proxy: "socks5://proxy.test:1080" });
    const mcpHome = join(harness.dir, "browsers", identity.id, "mcp");
    await writeControl(mcpHome, { downloadingAnswers: 2 });
    await harness.manager.launch(identity.id);
    const opens = (await readRecord(mcpHome)).filter((e) => e.name === "browser_open");
    expect(opens).toHaveLength(3);
    for (const call of opens) expect(call.args).toEqual({ browser: "main" });
    expect(harness.logs.some((line) => line.includes("not ready yet"))).toBe(true);
  });

  it("gives up after the open deadline with the server's last answer", async () => {
    harness = await makeHarness({ openDeadlineMs: 50, openRetryInitialMs: 30, openRetryMaxMs: 30 });
    const identity = await harness.manager.create({ name: "never ready" });
    await writeControl(join(harness.dir, "browsers", identity.id, "mcp"), { downloadingAnswers: 1000 });
    await expect(harness.manager.launch(identity.id)).rejects.toThrow(/was not ready within .*downloading now/);
    expect(harness.manager.isOpen(identity.id)).toBe(false);
  });

  it("reports a browser that did not start and leaves nothing open", async () => {
    harness = await makeHarness();
    const identity = await harness.manager.create({ name: "bad proxy" });
    await writeControl(join(harness.dir, "browsers", identity.id, "mcp"), { failOpen: true });
    await expect(harness.manager.launch(identity.id)).rejects.toThrow(/browser_open failed .*did NOT start/);
    expect(harness.manager.openCount).toBe(0);
  });

  it("reports a command that cannot be started", async () => {
    harness = await makeHarness({ mcpCommand: [join(tmpdir(), "no-such-mcp-binary-for-idots")] });
    const identity = await harness.manager.create({ name: "missing" });
    await expect(harness.manager.launch(identity.id)).rejects.toThrow(/could not start/);
    expect(harness.manager.openCount).toBe(0);
  });
});

describe("open sessions", { timeout: 60_000 }, () => {
  it("closes the least recently used identity beyond max_open", async () => {
    harness = await makeHarness({ maxOpen: 2 });
    const a = await harness.manager.create({ name: "a" });
    const b = await harness.manager.create({ name: "b" });
    const c = await harness.manager.create({ name: "c" });
    await harness.manager.launch(a.id);
    await harness.manager.launch(b.id);
    // Using a makes b the least recently used.
    await harness.manager.callTool(a.id, "browser_status", {});
    await harness.manager.launch(c.id);
    expect(harness.manager.isOpen(a.id)).toBe(true);
    expect(harness.manager.isOpen(b.id)).toBe(false);
    expect(harness.manager.isOpen(c.id)).toBe(true);
    expect(harness.manager.openCount).toBe(2);
    const closed = harness.events.filter((e) => e.type === "browser.identity.closed").map((e) => e.data.identity_id);
    expect(closed).toEqual([b.id]);
    const bCalls = await readRecord(join(harness.dir, "browsers", b.id, "mcp"));
    expect(bCalls.some((e) => e.name === "browser_close")).toBe(true);
  });

  it("launches a closed identity on first use and passes browser main", async () => {
    harness = await makeHarness();
    const identity = await harness.manager.create({ name: "lazy" });
    const result = await harness.manager.callTool(identity.id, "browser_navigate", { url: "https://example.com/" });
    expect(resultText(result)).toBe("200 https://example.com/");
    expect(harness.manager.isOpen(identity.id)).toBe(true);
    const calls = await readRecord(join(harness.dir, "browsers", identity.id, "mcp"));
    expect(calls.find((e) => e.name === "browser_navigate")!.args).toEqual({ url: "https://example.com/", browser: "main" });
  });

  it("relaunches the server after it crashed", async () => {
    harness = await makeHarness();
    const identity = await harness.manager.create({ name: "crashy" });
    await harness.manager.launch(identity.id);
    await expect(harness.manager.callTool(identity.id, "browser_navigate", { url: "crash://now" })).rejects.toThrow(
      /exited during browser_navigate/,
    );
    expect(harness.manager.isOpen(identity.id)).toBe(false);
    await until(() => harness!.events.some((e) => e.type === "browser.identity.closed"));
    expect((await harness.manager.get(identity.id))!.status).toBe("available");

    const result = await harness.manager.callTool(identity.id, "browser_navigate", { url: "https://example.org/" });
    expect(resultText(result)).toContain("example.org");
    const starts = (await readRecord(join(harness.dir, "browsers", identity.id, "mcp"))).filter((e) => e.kind === "start");
    expect(starts).toHaveLength(2);
    expect(starts[0]!.pid).not.toBe(starts[1]!.pid);
  });

  it("reopens the browser once when the server says it is gone", async () => {
    harness = await makeHarness();
    const identity = await harness.manager.create({ name: "lost browser" });
    const mcpHome = join(harness.dir, "browsers", identity.id, "mcp");
    await writeControl(mcpHome, { loseBrowserOnce: true });
    const result = await harness.manager.callTool(identity.id, "browser_snapshot", {});
    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain("selector: #go");
    const names = (await readRecord(mcpHome)).filter((e) => e.kind === "call").map((e) => e.name);
    expect(names).toEqual(["browser_open", "browser_snapshot", "browser_open", "browser_snapshot"]);
  });

  it("setLimits closes only the sessions beyond a lower max_open and caps new identities", async () => {
    harness = await makeHarness({ maxOpen: 3, maxIdentities: 5 });
    const a = await harness.manager.create({ name: "a" });
    const b = await harness.manager.create({ name: "b" });
    const c = await harness.manager.create({ name: "c" });
    await harness.manager.launch(a.id);
    await harness.manager.launch(b.id);
    await harness.manager.launch(c.id);
    await harness.manager.setLimits({ maxOpen: 1, maxIdentities: 3 });
    expect(harness.manager.limits).toEqual({ maxOpen: 1, maxIdentities: 3 });
    expect([a, b, c].map((i) => harness!.manager.isOpen(i.id))).toEqual([false, false, true]);
    await expect(harness.manager.create({ name: "d" })).rejects.toThrow(/max_identities 3/);
    await harness.manager.setLimits({ maxOpen: 2, maxIdentities: 4 });
    await harness.manager.launch(a.id);
    expect(harness.manager.openCount).toBe(2);
    expect((await harness.manager.create({ name: "d" })).name).toBe("d");
    await expect(harness.manager.setLimits({ maxOpen: 0, maxIdentities: 4 })).rejects.toThrow(/maxOpen/);
  });

  it("closeAll stops every server", async () => {
    harness = await makeHarness();
    const a = await harness.manager.create({ name: "a" });
    const b = await harness.manager.create({ name: "b" });
    await Promise.all([harness.manager.launch(a.id), harness.manager.launch(b.id)]);
    expect(harness.manager.openCount).toBe(2);
    await harness.manager.closeAll();
    expect(harness.manager.openCount).toBe(0);
    expect((await harness.manager.list()).every((i) => i.status === "available")).toBe(true);
  });
});
