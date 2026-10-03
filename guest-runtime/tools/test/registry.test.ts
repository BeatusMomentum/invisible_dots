import { afterEach, describe, expect, it } from "vitest";
import { getTool, TOOLS, type BrowserIdentity, type ExecRequest } from "@invisible-dots/shared";
import type { CallToolResult } from "@invisible-dots/browser-manager";
import {
  createToolRegistry,
  type AgentdClient,
  type MemoryToolStore,
  type RegistryBrowsers,
  type ToolContext,
  type ToolEvent,
  type ToolOfferConfig,
} from "../src/index.js";
import { makeHarness, type Harness } from "../../browser-manager/test/helpers.js";

const PNG_BASE64 = Buffer.from("png").toString("base64");

function fakeAgentd() {
  const calls: { method: string; args: unknown[] }[] = [];
  const agentd: AgentdClient = {
    async health() {
      return { agentd: "ok", agent: { status: "down" }, uptime_s: 1 };
    },
    async system() {
      throw new Error("not used");
    },
    async exec(request: ExecRequest) {
      calls.push({ method: "exec", args: [request] });
      if (request.command === "sleep 99") return { exit_code: -1, stdout: "", stderr: "", timed_out: true };
      return { exit_code: request.command === "false" ? 1 : 0, stdout: "out", stderr: "", timed_out: false };
    },
    async readFile(path: string) {
      calls.push({ method: "readFile", args: [path] });
      if (path === "bin") return Buffer.from([0, 1, 2]);
      if (path === "big.txt") return Buffer.from("y".repeat(50_000));
      if (path === "boom") throw new Error("dot-agentd GET /v1/files answered 404 not_found: no such file");
      return Buffer.from("hello file");
    },
    async writeFile(path: string, content: string | Uint8Array) {
      calls.push({ method: "writeFile", args: [path, content] });
    },
    async listFiles(path: string) {
      calls.push({ method: "listFiles", args: [path] });
      return {
        entries: [
          { name: "z.txt", type: "file", size: 12, mtime: "2026-01-01T00:00:00Z" },
          { name: "docs", type: "dir", size: 0, mtime: "2026-01-01T00:00:00Z" },
        ],
      };
    },
    async screenshot() {
      calls.push({ method: "screenshot", args: [] });
      return Buffer.from("png");
    },
  };
  return { agentd, calls };
}

function fakeBrowsers() {
  const calls: { tool: string; id: string; args: Record<string, unknown> }[] = [];
  const identity: BrowserIdentity = {
    id: "shop-abc123",
    name: "shop",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: null,
    status: "available",
    profilePath: "/home/dot/browsers/shop-abc123/profile",
    proxy: "http://user:secret@proxy.test:8080",
  };
  const browsers: RegistryBrowsers = {
    async list() {
      return [identity];
    },
    async create(input) {
      calls.push({ tool: "create", id: "", args: { ...input } });
      return { ...identity, name: input.name };
    },
    async delete(id) {
      calls.push({ tool: "delete", id, args: {} });
      if (id === "nope") throw new Error(`no browser identity "${id}"`);
    },
    async launch(id) {
      calls.push({ tool: "launch", id, args: {} });
      return { ...identity, status: "open" };
    },
    async close(id) {
      calls.push({ tool: "close", id, args: {} });
    },
    async callTool(id, tool, args = {}): Promise<CallToolResult> {
      calls.push({ tool, id, args });
      if (tool === "browser_take_screenshot" || tool === "browser_click_at") {
        return { content: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }] };
      }
      if (tool === "browser_read_text" && args.selector === "#huge") return { content: [{ type: "text", text: "x".repeat(30_000) }] };
      if (tool === "browser_click" && args.selector === "#missing") {
        return { content: [{ type: "text", text: "no element matches #missing" }], isError: true };
      }
      return { content: [{ type: "text", text: `${tool} ok` }] };
    },
  };
  return { browsers, calls };
}

function fakeStore() {
  const data = new Map<string, string>();
  const store: MemoryToolStore = {
    remember(key, content) {
      data.set(key, content);
    },
    search(query) {
      return [...data.entries()]
        .filter(([, content]) => content.includes(query))
        .map(([key, content]) => ({ key, content, updated_at: "2026-01-01T00:00:00Z" }));
    },
  };
  return { store, data };
}

function context(signal: AbortSignal = new AbortController().signal) {
  const events: ToolEvent[] = [];
  const ctx: ToolContext = { taskId: "task_1", signal, emit: (event) => events.push(event) };
  return { ctx, events };
}

function setup(config?: ToolOfferConfig) {
  const agentd = fakeAgentd();
  const browsers = fakeBrowsers();
  const memory = fakeStore();
  const registry = createToolRegistry({
    agentd: agentd.agentd,
    browsers: browsers.browsers,
    store: memory.store,
    ...(config ? { config: () => config } : {}),
  });
  return { registry, agentd, browsers, memory };
}

const full: ToolOfferConfig = { browser: { identities: { managed_by_dot: true } }, memory: { enabled: true } };

describe("definitions", () => {
  it("offers every tool of the table with the shared permission and schema", () => {
    const { registry } = setup();
    const defs = registry.definitions(full);
    expect(defs.map((d) => d.name)).toEqual(TOOLS.map((t) => t.name));
    for (const def of defs) expect(def).toBe(getTool(def.name));
    const permission = (name: string) => defs.find((d) => d.name === name)!.permission;
    expect(permission("computer_exec")).toBe("computer.exec");
    expect(permission("files_list")).toBe("files.read");
    expect(permission("browser_identity_delete")).toBe("browser.identity.delete");
    expect(permission("browser_navigate")).toBe("browser.navigate");
    expect(permission("browser_screenshot")).toBe("browser.read");
    expect(permission("browser_reload")).toBe("browser.act");
    expect(permission("memory_search")).toBe("memory.read");
  });

  it("leaves out identity create and delete when the Dot does not manage identities", () => {
    const { registry } = setup();
    const names = registry.definitions({ ...full, browser: { identities: { managed_by_dot: false } } }).map((d) => d.name);
    expect(names).not.toContain("browser_identity_create");
    expect(names).not.toContain("browser_identity_delete");
    expect(names).toContain("browser_identity_launch");
  });

  it("leaves out the memory tools when memory is disabled", () => {
    const { registry } = setup();
    const names = registry.definitions({ ...full, memory: { enabled: false } }).map((d) => d.name);
    expect(names.filter((n) => n.startsWith("memory_"))).toEqual([]);
    expect(names).toContain("files_read");
  });
});

describe("argument validation", () => {
  it("refuses missing, mistyped, unknown and out-of-range arguments with a clear message", async () => {
    const { registry, agentd } = setup();
    const { ctx } = context();
    const missing = await registry.call("computer_exec", {}, ctx);
    expect(missing).toEqual({ ok: false, text: "invalid arguments for computer_exec: command is required" });
    const typed = await registry.call("files_write", { path: "a", content: 5 }, ctx);
    expect(typed.text).toContain("content must be a string, got number");
    const extra = await registry.call("files_read", { path: "a", mode: "x" }, ctx);
    expect(extra.text).toContain("mode is not an accepted argument");
    const range = await registry.call("computer_exec", { command: "ls", timeout_seconds: 1.5 }, ctx);
    expect(range.text).toContain("timeout_seconds must be an integer");
    const enumBad = await registry.call("browser_scroll", { identity_id: "a", direction: "left" }, ctx);
    expect(enumBad.text).toContain('direction must be one of "up", "down"');
    const empty = await registry.call("browser_navigate", { identity_id: "", url: "https://x" }, ctx);
    expect(empty.text).toContain("identity_id must not be empty");
    const notObject = await registry.call("files_read", "path", ctx);
    expect(notObject.text).toContain("arguments must be an object, got string");
    expect(agentd.calls).toEqual([]);
  });

  it("accepts null arguments for a tool without parameters", async () => {
    const { registry } = setup();
    const result = await registry.call("browser_identity_list", null, context().ctx);
    expect(result.ok).toBe(true);
  });

  it("refuses unknown tools and tools the current config does not offer", async () => {
    const { registry } = setup({ ...full, browser: { identities: { managed_by_dot: false } } });
    expect(await registry.call("browser_open", {}, context().ctx)).toEqual({ ok: false, text: 'unknown tool "browser_open"' });
    const hidden = await registry.call("browser_identity_delete", { identity_id: "a" }, context().ctx);
    expect(hidden.ok).toBe(false);
    expect(hidden.text).toContain("not available");
  });

  it("does not run a call whose signal is already aborted", async () => {
    const { registry, agentd } = setup();
    const controller = new AbortController();
    controller.abort();
    const result = await registry.call("computer_exec", { command: "ls" }, context(controller.signal).ctx);
    expect(result.ok).toBe(false);
    expect(agentd.calls).toEqual([]);
  });
});

describe("computer and files", () => {
  it("runs exec with the timeout in milliseconds and reports the exit code", async () => {
    const { registry, agentd } = setup();
    const { ctx } = context();
    const result = await registry.call("computer_exec", { command: "false", cwd: "workspace", timeout_seconds: 30 }, ctx);
    expect(agentd.calls[0]!.args[0]).toEqual({ command: "false", cwd: "workspace", timeout_ms: 30_000 });
    expect(result.ok).toBe(true);
    expect(result.text).toBe("exit_code: 1\nstdout:\nout\nstderr: (empty)");
    const killed = await registry.call("computer_exec", { command: "sleep 99" }, ctx);
    expect(killed.ok).toBe(false);
    expect(killed.text).toContain("killed: timed out");
  });

  it("returns the desktop screenshot as an image", async () => {
    const { registry } = setup();
    const result = await registry.call("computer_screenshot", {}, context().ctx);
    expect(result.images).toEqual([{ mimeType: "image/png", base64: PNG_BASE64 }]);
  });

  it("reads text files, refuses binary ones and caps long ones", async () => {
    const { registry } = setup();
    const { ctx } = context();
    expect(await registry.call("files_read", { path: "a.txt" }, ctx)).toEqual({ ok: true, text: "hello file" });
    const binary = await registry.call("files_read", { path: "bin" }, ctx);
    expect(binary).toEqual({ ok: false, text: "bin is a binary file of 3 bytes; it cannot be shown as text" });
    const big = await registry.call("files_read", { path: "big.txt" }, ctx);
    expect(big.text.length).toBeLessThanOrEqual(12_000);
    expect(big.text).toMatch(/\[\.\.\. truncated: \d+ more characters not shown\]$/);
    const failed = await registry.call("files_read", { path: "boom" }, ctx);
    expect(failed).toEqual({ ok: false, text: "files_read failed: dot-agentd GET /v1/files answered 404 not_found: no such file" });
  });

  it("writes and lists files", async () => {
    const { registry, agentd } = setup();
    const { ctx } = context();
    // "caffe" plus a combining grave accent: 6 characters, 7 bytes in UTF-8.
    const accented = "caffe" + String.fromCodePoint(0x300);
    const written = await registry.call("files_write", { path: "notes.md", content: accented }, ctx);
    expect(written.text).toBe("wrote 7 bytes to notes.md");
    expect(agentd.calls[0]).toEqual({ method: "writeFile", args: ["notes.md", accented] });
    const listed = await registry.call("files_list", { path: "workspace" }, ctx);
    expect(listed.text.split("\n")[0]).toMatch(/^dir .* docs\/$/);
    expect(listed.text.split("\n")[1]).toMatch(/^file .* z\.txt$/);
  });
});

describe("memory", () => {
  it("remembers, emits memory.written and finds it again", async () => {
    const { registry } = setup();
    const { ctx, events } = context();
    expect((await registry.call("memory_remember", { key: "fares", content: "Tuesday is cheapest" }, ctx)).ok).toBe(true);
    expect(events).toEqual([{ type: "memory.written", data: { key: "fares" } }]);
    const found = await registry.call("memory_search", { query: "Tuesday" }, ctx);
    expect(found.text).toContain("## fares");
    expect(found.text).toContain("Tuesday is cheapest");
    expect((await registry.call("memory_search", { query: "nothing" }, ctx)).text).toBe('no memories match "nothing"');
  });

  it("says memory is disabled when no store was given", async () => {
    const registry = createToolRegistry({ agentd: fakeAgentd().agentd, browsers: fakeBrowsers().browsers });
    const result = await registry.call("memory_search", { query: "x" }, context().ctx);
    expect(result).toEqual({ ok: false, text: "memory_search failed: long-term memory is disabled for this Dot" });
  });
});

describe("browser tools", () => {
  it("maps each tool to the MCP tool and arguments of section 8.3", async () => {
    const { registry, browsers } = setup();
    const { ctx } = context();
    const id = "shop-abc123";
    await registry.call("browser_navigate", { identity_id: id, url: "https://example.com" }, ctx);
    await registry.call("browser_snapshot", { identity_id: id }, ctx);
    await registry.call("browser_read_text", { identity_id: id }, ctx);
    await registry.call("browser_read_text", { identity_id: id, selector: "main" }, ctx);
    await registry.call("browser_click", { identity_id: id, selector: "#go" }, ctx);
    await registry.call("browser_click_at", { identity_id: id, x: 10, y: 20.5 }, ctx);
    await registry.call("browser_type", { identity_id: id, selector: "#q", text: "hi" }, ctx);
    await registry.call("browser_press_key", { identity_id: id, key: "Enter" }, ctx);
    await registry.call("browser_scroll", { identity_id: id, direction: "down" }, ctx);
    await registry.call("browser_scroll", { identity_id: id, direction: "up" }, ctx);
    await registry.call("browser_back", { identity_id: id }, ctx);
    await registry.call("browser_forward", { identity_id: id }, ctx);
    await registry.call("browser_reload", { identity_id: id }, ctx);
    await registry.call("browser_screenshot", { identity_id: id }, ctx);
    expect(browsers.calls.map(({ tool, args }) => [tool, args])).toEqual([
      ["browser_navigate", { url: "https://example.com" }],
      ["browser_snapshot", {}],
      ["browser_read_text", { max_chars: 12_000 }],
      ["browser_read_text", { selector: "main", max_chars: 12_000 }],
      ["browser_click", { selector: "#go" }],
      ["browser_click_at", { x: 10, y: 20.5 }],
      ["browser_type", { selector: "#q", text: "hi" }],
      ["browser_press_key", { key: "Enter" }],
      ["browser_press_key", { key: "PageDown" }],
      ["browser_press_key", { key: "PageUp" }],
      ["browser_press_key", { key: "Alt+ArrowLeft" }],
      ["browser_press_key", { key: "Alt+ArrowRight" }],
      ["browser_press_key", { key: "F5" }],
      ["browser_take_screenshot", {}],
    ]);
    expect(browsers.calls.every((c) => c.id === id)).toBe(true);
  });

  it("passes the screenshot image on and keeps click_at's image out of the conversation", async () => {
    const { registry } = setup();
    const { ctx } = context();
    const shot = await registry.call("browser_screenshot", { identity_id: "a" }, ctx);
    expect(shot).toEqual({ ok: true, text: "screenshot taken", images: [{ mimeType: "image/png", base64: PNG_BASE64 }] });
    const click = await registry.call("browser_click_at", { identity_id: "a", x: 1, y: 2 }, ctx);
    expect(click.images).toBeUndefined();
    expect(click.text).toContain("clicked at (1, 2)");
  });

  it("reports MCP errors as failed results and caps long text", async () => {
    const { registry } = setup();
    const { ctx } = context();
    expect(await registry.call("browser_click", { identity_id: "a", selector: "#missing" }, ctx)).toEqual({
      ok: false,
      text: "no element matches #missing",
    });
    const huge = await registry.call("browser_read_text", { identity_id: "a", selector: "#huge" }, ctx);
    expect(huge.ok).toBe(true);
    expect(huge.text.length).toBeLessThanOrEqual(12_000);
    expect(huge.text).toContain("more characters not shown");
  });

  it("manages identities and never shows a proxy password", async () => {
    const { registry, browsers } = setup();
    const { ctx } = context();
    const listed = await registry.call("browser_identity_list", {}, ctx);
    expect(listed.text).toContain("shop-abc123");
    expect(listed.text).not.toContain("secret");
    const created = await registry.call("browser_identity_create", { name: "work", proxy: "http://u:secret@p.test:1" }, ctx);
    expect(created.ok).toBe(true);
    expect(created.text).not.toContain("secret");
    expect(browsers.calls[0]).toEqual({ tool: "create", id: "", args: { name: "work", proxy: "http://u:secret@p.test:1" } });
    expect((await registry.call("browser_identity_launch", { identity_id: "shop-abc123" }, ctx)).text).toContain("is open");
    expect((await registry.call("browser_identity_close", { identity_id: "shop-abc123" }, ctx)).ok).toBe(true);
    const missing = await registry.call("browser_identity_delete", { identity_id: "nope" }, ctx);
    expect(missing).toEqual({ ok: false, text: 'browser_identity_delete failed: no browser identity "nope"' });
  });
});

describe("with the real browser manager and a fake MCP server", () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it("launches a closed identity on the first browser action and returns the screenshot", async () => {
    harness = await makeHarness();
    const registry = createToolRegistry({ agentd: fakeAgentd().agentd, browsers: harness.manager });
    const { ctx } = context();
    const created = await registry.call("browser_identity_create", { name: "real path" }, ctx);
    expect(created.ok).toBe(true);
    const id = (await harness.manager.list())[0]!.id;
    expect(harness.manager.isOpen(id)).toBe(false);

    const navigated = await registry.call("browser_navigate", { identity_id: id, url: "https://example.com/" }, ctx);
    expect(navigated).toEqual({ ok: true, text: "200 https://example.com/" });
    expect(harness.manager.isOpen(id)).toBe(true);

    const back = await registry.call("browser_back", { identity_id: id }, ctx);
    expect(back.text).toBe("pressed Alt+ArrowLeft");
    const shot = await registry.call("browser_screenshot", { identity_id: id }, ctx);
    expect(shot.images?.[0]?.mimeType).toBe("image/png");
    const unknown = await registry.call("browser_snapshot", { identity_id: "no-such-identity" }, ctx);
    expect(unknown).toEqual({ ok: false, text: 'browser_snapshot failed: no browser identity "no-such-identity"' });
  });

  it("calls every browser tool with arguments the real server's schema accepts", async () => {
    // The fake refuses any argument name, type or omission the pinned
    // invisible-playwright-mcp would refuse (fixtures/mcp-tools.json).
    harness = await makeHarness();
    const registry = createToolRegistry({ agentd: fakeAgentd().agentd, browsers: harness.manager });
    const { ctx } = context();
    await registry.call("browser_identity_create", { name: "schema" }, ctx);
    const identity_id = (await harness.manager.list())[0]!.id;
    const calls: Array<[string, Record<string, unknown>]> = [
      ["browser_navigate", { url: "https://example.com/" }],
      ["browser_snapshot", {}],
      ["browser_read_text", {}],
      ["browser_read_text", { selector: "h1" }],
      ["browser_click", { selector: "#go" }],
      ["browser_click_at", { x: 10, y: 20 }],
      ["browser_type", { selector: "#q", text: "hello" }],
      ["browser_press_key", { key: "Enter" }],
      ["browser_scroll", { direction: "up" }],
      ["browser_scroll", { direction: "down" }],
      ["browser_back", {}],
      ["browser_forward", {}],
      ["browser_reload", {}],
      ["browser_screenshot", {}],
    ];
    const offered = new Set(registry.definitions(full).map((t) => t.name));
    const covered = new Set(calls.map(([name]) => name));
    // Every browser tool the model can see is in the list above.
    expect([...offered].filter((name) => name.startsWith("browser_") && !name.startsWith("browser_identity_")).sort()).toEqual([...covered].sort());
    for (const [name, args] of calls) {
      const result = await registry.call(name, { identity_id, ...args }, ctx);
      expect(result.ok, `${name}: ${result.text}`).toBe(true);
    }
  });
});
