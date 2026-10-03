import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  checkIdentityRequest,
  GUEST_DISPLAY,
  IdentityRequestError,
  isValidIdentityId,
  newIdentityId,
  redactProxy,
  type BrowserIdentity,
  type BrowserIdentityEventData,
  type BrowserIdentityStatus,
} from "@invisible-dots/shared";
import { childEnvironment } from "./env.js";
import type { IdentityPersistence } from "./persistence.js";

export type { CallToolResult };

export type BrowserIdentityEventType =
  | "browser.identity.created"
  | "browser.identity.deleted"
  | "browser.identity.launched"
  | "browser.identity.closed";

export interface BrowserIdentityEvent {
  type: BrowserIdentityEventType;
  data: BrowserIdentityEventData;
}

export interface BrowserIdentityManagerOptions {
  persistence: IdentityPersistence;
  /** Root of the identity directories, `/home/dot/browsers` in the guest. */
  browsersDir: string;
  maxOpen: number;
  maxIdentities: number;
  /** Command and arguments that start one MCP server. Default `["invisible-playwright-mcp"]`. */
  mcpCommand?: string[];
  /** Environment the child's allowlisted variables are taken from. Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** X display the browser draws on. Default `:0`. */
  display?: string;
  emit?: (event: BrowserIdentityEvent) => void;
  log?: (line: string) => void;
  /** How long a launch keeps asking `browser_open` while the engine downloads. Default 15 minutes. */
  openDeadlineMs?: number;
  /** First wait between two `browser_open` attempts; doubles up to `openRetryMaxMs`. Default 2 s. */
  openRetryInitialMs?: number;
  openRetryMaxMs?: number;
  /** Timeout of one MCP request. Default 120 s: a navigation waits on the network. */
  requestTimeoutMs?: number;
}

export interface CreateIdentityInput {
  name: string;
  proxy?: string | undefined;
}

export interface CallToolOptions {
  signal?: AbortSignal;
}

/** An error whose message is meant to be shown as is, to the model or in an API answer. */
export class BrowserIdentityError extends Error {
  constructor(
    readonly code: "not_found" | "invalid" | "limit" | "launch_failed" | "crashed",
    message: string,
  ) {
    super(message);
    this.name = "BrowserIdentityError";
  }
}

interface Session {
  client: Client;
  transport: StdioClientTransport;
  /** Set before an intentional close so the exit is not reported as a crash. */
  closing: boolean;
}

/** The MCP server's own browser, the one carrying the identity. */
const MAIN_BROWSER = "main";
/** `browser_open` answers this when the browser started; anything else that is not an error is the engine's progress. */
const OPENED = /\bbrowser is open\b/i;
/** What the MCP server answers when its browser closed under it while the process lives on. */
const BROWSER_LOST = /\bbrowser is (?:gone|not open)\b/i;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The text parts of a tool result, joined. */
export function resultText(result: CallToolResult): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}


/**
 * Browser identities and the `invisible-playwright-mcp` process of each open
 * one (architecture section 6). Launches, closes and deletes are serialized,
 * which keeps the open count and the LRU order consistent when the agent and
 * the API act at the same time.
 */
function checkLimits(limits: { maxOpen: number; maxIdentities: number }): void {
  if (!Number.isInteger(limits.maxOpen) || limits.maxOpen < 1) throw new Error("maxOpen must be an integer of at least 1");
  if (!Number.isInteger(limits.maxIdentities) || limits.maxIdentities < 1) {
    throw new Error("maxIdentities must be an integer of at least 1");
  }
}

export class BrowserIdentityManager {
  private readonly sessions = new Map<string, Session>();
  /** Open identity ids, least recently used first. */
  private readonly recency: string[] = [];
  private lock: Promise<unknown> = Promise.resolve();
  private readonly persistence: IdentityPersistence;
  private readonly browsersDir: string;
  private maxOpen: number;
  private maxIdentities: number;
  private readonly mcpCommand: string[];
  private readonly baseEnv: Record<string, string | undefined>;
  private readonly display: string;
  private readonly emitEvent: (event: BrowserIdentityEvent) => void;
  private readonly log: (line: string) => void;
  private readonly openDeadlineMs: number;
  private readonly openRetryInitialMs: number;
  private readonly openRetryMaxMs: number;
  private readonly requestTimeoutMs: number;

  constructor(options: BrowserIdentityManagerOptions) {
    checkLimits(options);
    const command = options.mcpCommand ?? ["invisible-playwright-mcp"];
    if (command.length === 0 || !command[0]) throw new Error("mcpCommand must name a program");
    this.persistence = options.persistence;
    this.browsersDir = options.browsersDir;
    this.maxOpen = options.maxOpen;
    this.maxIdentities = options.maxIdentities;
    this.mcpCommand = command;
    this.baseEnv = options.env ?? process.env;
    this.display = options.display ?? GUEST_DISPLAY;
    this.emitEvent = options.emit ?? (() => {});
    this.log = options.log ?? ((line) => process.stderr.write(`[browser-manager] ${line}\n`));
    this.openDeadlineMs = options.openDeadlineMs ?? 15 * 60_000;
    this.openRetryInitialMs = options.openRetryInitialMs ?? 2_000;
    this.openRetryMaxMs = options.openRetryMaxMs ?? 30_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  }

  get limits(): { maxOpen: number; maxIdentities: number } {
    return { maxOpen: this.maxOpen, maxIdentities: this.maxIdentities };
  }

  /**
   * Apply new `max_open` / `max_identities` values from a config change.
   * Sessions beyond a lower `maxOpen` are closed, least recently used first;
   * the others stay open. A lower `maxIdentities` deletes nothing: it only
   * refuses new identities until enough are deleted.
   */
  async setLimits(limits: { maxOpen: number; maxIdentities: number }): Promise<void> {
    checkLimits(limits);
    return this.locked(async () => {
      this.maxOpen = limits.maxOpen;
      this.maxIdentities = limits.maxIdentities;
      while (this.sessions.size > this.maxOpen) {
        const oldest = this.recency[0];
        if (oldest === undefined) break;
        this.log(`closing identity ${oldest}, the least recently used, to stay within the new max_open ${this.maxOpen}`);
        await this.closeUnlocked(oldest);
      }
    });
  }

  /** Number of identities with a running MCP process. */
  get openCount(): number {
    return this.sessions.size;
  }

  isOpen(id: string): boolean {
    return this.sessions.has(id);
  }

  private locked<T>(work: () => Promise<T>): Promise<T> {
    const next = this.lock.then(work, work);
    this.lock = next.catch(() => undefined);
    return next;
  }

  private paths(id: string) {
    const root = join(this.browsersDir, id);
    return { root, profile: join(root, "profile"), mcp: join(root, "mcp"), metadata: join(root, "metadata.json") };
  }

  /** The record as callers see it: `open` follows the live sessions, not what was stored before a restart. */
  private view(record: BrowserIdentity): BrowserIdentity {
    let status: BrowserIdentityStatus = record.status;
    if (this.sessions.has(record.id)) status = "open";
    else if (status === "open") status = "available";
    return { ...record, status };
  }

  private emit(type: BrowserIdentityEventType, record: BrowserIdentity): void {
    try {
      this.emitEvent({ type, data: { identity_id: record.id, name: record.name } });
    } catch (error) {
      this.log(`emitting ${type} for ${record.id} failed: ${(error as Error).message}`);
    }
  }

  /** Writes the record to the persistence and mirrors it into `metadata.json`. */
  private async save(record: BrowserIdentity): Promise<void> {
    await this.persistence.putIdentity(record);
    const paths = this.paths(record.id);
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.metadata, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  private async require(id: string): Promise<BrowserIdentity> {
    if (!isValidIdentityId(id)) throw new BrowserIdentityError("not_found", `no browser identity "${id}"`);
    const record = await this.persistence.getIdentity(id);
    if (!record) throw new BrowserIdentityError("not_found", `no browser identity "${id}"`);
    return record;
  }

  async list(): Promise<BrowserIdentity[]> {
    const records = await this.persistence.listIdentities();
    return records.map((r) => this.view(r)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(id: string): Promise<BrowserIdentity | null> {
    if (!isValidIdentityId(id)) return null;
    const record = await this.persistence.getIdentity(id);
    return record ? this.view(record) : null;
  }

  create(input: CreateIdentityInput): Promise<BrowserIdentity> {
    return this.locked(async () => {
      const existing = await this.persistence.listIdentities();
      let checked: { name: string; proxy?: string };
      try {
        checked = checkIdentityRequest(input, existing.length, this.maxIdentities);
      } catch (error) {
        if (error instanceof IdentityRequestError) throw new BrowserIdentityError(error.code, error.message);
        throw error;
      }
      const { name, proxy } = checked;
      const taken = new Set(existing.map((r) => r.id));
      let id = newIdentityId(name);
      while (taken.has(id)) id = newIdentityId(name);

      const paths = this.paths(id);
      await mkdir(paths.profile, { recursive: true });
      await mkdir(paths.mcp, { recursive: true });
      const record: BrowserIdentity = {
        id,
        name,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        status: "available",
        profilePath: paths.profile,
        ...(proxy ? { proxy } : {}),
      };
      await this.save(record);
      this.log(`created identity ${id} (${name})${proxy ? ` with proxy ${redactProxy(proxy)}` : ""}`);
      this.emit("browser.identity.created", record);
      return record;
    });
  }

  delete(id: string): Promise<void> {
    return this.locked(async () => {
      const record = await this.require(id);
      if (this.sessions.has(id)) await this.closeUnlocked(id);
      // Removed before the record: a directory left behind by a failed rm would
      // otherwise be invisible, while a record whose directory is gone can be deleted again.
      await rm(this.paths(id).root, { recursive: true, force: true });
      await this.persistence.deleteIdentity(id);
      this.log(`deleted identity ${id} and its profile`);
      this.emit("browser.identity.deleted", record);
    });
  }

  launch(id: string): Promise<BrowserIdentity> {
    return this.locked(() => this.launchUnlocked(id));
  }

  close(id: string): Promise<void> {
    return this.locked(async () => {
      await this.require(id);
      await this.closeUnlocked(id);
    });
  }

  closeAll(): Promise<void> {
    return this.locked(async () => {
      await Promise.all([...this.sessions.keys()].map((id) => this.closeUnlocked(id)));
    });
  }

  /**
   * Calls a tool of the identity's MCP server, launching the identity first
   * when it is not open. `browser: "main"` is always added, so the caller
   * never chooses which of the server's browsers it acts in.
   */
  async callTool(
    id: string,
    toolName: string,
    args: Record<string, unknown> = {},
    options: CallToolOptions = {},
  ): Promise<CallToolResult> {
    if (!this.sessions.has(id)) await this.launch(id);
    const session = this.sessions.get(id);
    if (!session) throw new BrowserIdentityError("crashed", `the browser of identity "${id}" closed while it was being opened`);
    this.touch(id);

    const first = await this.request(id, session, toolName, args, options);
    if (!first.isError || !BROWSER_LOST.test(resultText(first))) return first;

    // The process is alive but its browser closed under it (a crash of Firefox,
    // or the window closed on the desktop): open it again and repeat once.
    this.log(`identity ${id}: the MCP server reports its browser closed; reopening it and repeating ${toolName}`);
    await this.openBrowser(id, session.client, options.signal);
    return this.request(id, session, toolName, args, options);
  }

  private async request(
    id: string,
    session: Session,
    toolName: string,
    args: Record<string, unknown>,
    options: CallToolOptions,
  ): Promise<CallToolResult> {
    try {
      const result = await session.client.callTool(
        { name: toolName, arguments: { ...args, browser: MAIN_BROWSER } },
        undefined,
        { timeout: this.requestTimeoutMs, ...(options.signal ? { signal: options.signal } : {}) },
      );
      return result as CallToolResult;
    } catch (error) {
      if (!this.sessions.has(id)) {
        throw new BrowserIdentityError(
          "crashed",
          `the browser process of identity "${id}" exited during ${toolName}; it will be started again on the next browser action`,
        );
      }
      throw error;
    }
  }

  private touch(id: string): void {
    const index = this.recency.indexOf(id);
    if (index !== -1) this.recency.splice(index, 1);
    this.recency.push(id);
  }

  private forget(id: string): void {
    this.sessions.delete(id);
    const index = this.recency.indexOf(id);
    if (index !== -1) this.recency.splice(index, 1);
  }

  private async launchUnlocked(id: string): Promise<BrowserIdentity> {
    const record = await this.require(id);
    if (this.sessions.has(id)) {
      this.touch(id);
      return this.view(record);
    }
    while (this.sessions.size >= this.maxOpen) {
      const oldest = this.recency[0];
      if (oldest === undefined) break;
      this.log(`closing identity ${oldest}, the least recently used, to stay within max_open ${this.maxOpen}`);
      await this.closeUnlocked(oldest);
    }

    const paths = this.paths(id);
    await mkdir(paths.profile, { recursive: true });
    await mkdir(paths.mcp, { recursive: true });
    const env = childEnvironment(
      { identityId: id, profileDir: paths.profile, mcpHome: paths.mcp, display: this.display, proxy: record.proxy },
      this.baseEnv,
    );
    const [command, ...args] = this.mcpCommand as [string, ...string[]];
    const transport = new StdioClientTransport({ command, args, env, cwd: paths.root, stderr: "pipe" });
    transport.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim()) this.log(`identity ${id} mcp: ${line}`);
    });
    const client = new Client({ name: "invisible-dots-browser-manager", version: "0.0.0" });
    const session: Session = { client, transport, closing: false };

    client.onclose = () => {
      if (this.sessions.get(id) !== session) return;
      this.forget(id);
      if (session.closing) return;
      this.log(`identity ${id}: the MCP server exited unexpectedly; it will be started again on next use`);
      // Under the lock, so it cannot rewrite metadata.json after a concurrent delete removed the directory.
      void this.locked(() => this.markClosed(record.id)).catch((error: Error) => this.log(`identity ${id}: recording the exit failed: ${error.message}`));
    };

    this.log(`launching identity ${id}: ${this.mcpCommand.join(" ")}`);
    try {
      await client.connect(transport, { timeout: this.requestTimeoutMs });
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw new BrowserIdentityError(
        "launch_failed",
        `could not start "${this.mcpCommand.join(" ")}" for identity "${id}": ${(error as Error).message}`,
      );
    }
    this.sessions.set(id, session);
    this.touch(id);

    try {
      await this.openBrowser(id, client);
    } catch (error) {
      session.closing = true;
      this.forget(id);
      await client.close().catch(() => undefined);
      if (error instanceof BrowserIdentityError) throw error;
      throw new BrowserIdentityError("launch_failed", `identity "${id}": ${(error as Error).message}`);
    }

    const opened: BrowserIdentity = { ...record, status: "open", lastUsedAt: new Date().toISOString() };
    await this.save(opened);
    this.log(`identity ${id} is open`);
    this.emit("browser.identity.launched", opened);
    return opened;
  }

  /**
   * `browser_open` with nothing but the browser role: the environment is the
   * only source of the profile and proxy, and the seed lives in the profile.
   * While the engine is still downloading the server answers with its progress
   * instead of a browser, so this asks again with backoff until the deadline.
   */
  private async openBrowser(id: string, client: Client, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.openDeadlineMs;
    let wait = this.openRetryInitialMs;
    for (;;) {
      const result = (await client.callTool({ name: "browser_open", arguments: { browser: MAIN_BROWSER } }, undefined, {
        timeout: this.requestTimeoutMs,
        ...(signal ? { signal } : {}),
      })) as CallToolResult;
      const text = resultText(result);
      if (result.isError) throw new BrowserIdentityError("launch_failed", `browser_open failed for identity "${id}": ${text}`);
      if (OPENED.test(text)) return;
      if (Date.now() + wait > deadline) {
        throw new BrowserIdentityError(
          "launch_failed",
          `the browser of identity "${id}" was not ready within ${Math.round(this.openDeadlineMs / 1000)} s; last answer: ${text}`,
        );
      }
      this.log(`identity ${id}: browser not ready yet (${text}); asking again in ${wait} ms`);
      await sleep(wait, signal);
      wait = Math.min(wait * 2, this.openRetryMaxMs);
    }
  }

  private async markClosed(id: string): Promise<void> {
    const record = await this.persistence.getIdentity(id);
    if (!record) return;
    const closed: BrowserIdentity = { ...record, status: "available" };
    await this.save(closed);
    this.emit("browser.identity.closed", closed);
  }

  private async closeUnlocked(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.closing = true;
    try {
      // Closing the browser before the process lets the server shut Firefox
      // down cleanly, so the profile is flushed rather than left locked.
      await session.client.callTool({ name: "browser_close", arguments: { browser: MAIN_BROWSER } }, undefined, {
        timeout: 30_000,
      });
    } catch (error) {
      this.log(`identity ${id}: browser_close failed (${(error as Error).message}); stopping the process anyway`);
    }
    this.forget(id);
    await session.client.close().catch(() => undefined);
    this.log(`identity ${id} closed`);
    await this.markClosed(id);
  }
}
