import type { BrowserIdentityManager, CallToolResult } from "@invisible-dots/browser-manager";
import {
  getTool,
  offeredTools,
  redactProxy,
  truncateText,
  TOOL_RESULT_MAX_CHARS,
  type BrowserIdentity,
  type ToolDefinition,
  type ToolName,
} from "@invisible-dots/shared";
import type { AgentdClient } from "./agentd.js";
import type { MemoryToolStore, ToolContext, ToolImage, ToolOfferConfig, ToolRegistry, ToolResult } from "./types.js";
import { validateArguments } from "./validate.js";

/** What the registry uses of the browser manager; a structural subset so tests can pass a fake. */
export type RegistryBrowsers = Pick<BrowserIdentityManager, "list" | "create" | "delete" | "launch" | "close" | "callTool">;

export interface ToolRegistryDeps {
  agentd: AgentdClient;
  browsers: RegistryBrowsers;
  /** Absent when memory is disabled; the memory tools then answer that it is. */
  store?: MemoryToolStore;
  /**
   * The current configuration. When given, a call to a tool this config does
   * not offer is refused, so a model that remembers a tool from an older
   * config cannot reach it.
   */
  config?: () => ToolOfferConfig;
  /** Text results are cut to this many characters. Default 12000 (section 8.5). */
  maxTextChars?: number;
  /** Hits returned by memory_search. Default 10. */
  memorySearchLimit?: number;
}

function fail(text: string): ToolResult {
  return { ok: false, text };
}

/** The key the browser tools press for the navigation shortcuts; Playwright key names, as the MCP server takes them. */
const BROWSER_KEYS = {
  scrollUp: "PageUp",
  scrollDown: "PageDown",
  back: "Alt+ArrowLeft",
  forward: "Alt+ArrowRight",
  reload: "F5",
} as const;

function describeIdentity(identity: BrowserIdentity) {
  return {
    id: identity.id,
    name: identity.name,
    status: identity.status,
    created_at: identity.createdAt,
    last_used_at: identity.lastUsedAt,
    // The model chose the proxy, but its password has no business in the conversation log.
    ...(identity.proxy ? { proxy: redactProxy(identity.proxy) } : {}),
  };
}

function isUtf8Text(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

type Args = Record<string, unknown>;
type Handler = (args: Args, ctx: ToolContext, definition: ToolDefinition) => Promise<ToolResult>;

export function createToolRegistry(deps: ToolRegistryDeps): ToolRegistry {
  const maxText = deps.maxTextChars ?? TOOL_RESULT_MAX_CHARS;
  const searchLimit = deps.memorySearchLimit ?? 10;
  const signalOf = (ctx: ToolContext) => ({ signal: ctx.signal });

  /** Turns an MCP answer into a tool result; images are kept only for tools that show them to the model. */
  function fromMcp(result: CallToolResult, definition: ToolDefinition, fallback: string): ToolResult {
    const texts: string[] = [];
    const images: ToolImage[] = [];
    for (const part of result.content) {
      if (part.type === "text") texts.push(part.text);
      else if (part.type === "image") images.push({ mimeType: part.mimeType, base64: part.data });
    }
    let text = texts.join("\n").trim();
    if (!definition.returnsImage && images.length > 0) {
      text = text || `${fallback} (the browser took a screenshot; call browser_screenshot to see the page)`;
    }
    if (!text) text = definition.returnsImage && images.length > 0 ? "screenshot taken" : fallback;
    const out: ToolResult = { ok: !result.isError, text };
    if (definition.returnsImage) {
      if (images.length === 0 && !result.isError) return fail(`${definition.name}: the browser returned no image. ${text}`);
      if (images.length > 0) out.images = images;
    }
    return out;
  }

  function browserAction(mcpTool: string, mapArgs: (args: Args) => Args, fallback: (args: Args) => string): Handler {
    return async (args, ctx, definition) => {
      const id = args.identity_id as string;
      const result = await deps.browsers.callTool(id, mcpTool, mapArgs(args), signalOf(ctx));
      return fromMcp(result, definition, fallback(args));
    };
  }

  function needStore(): MemoryToolStore {
    if (!deps.store) throw new Error("long-term memory is disabled for this Dot");
    return deps.store;
  }

  const handlers: Record<ToolName, Handler> = {
    async computer_exec(args, ctx) {
      const seconds = args.timeout_seconds as number | undefined;
      const answer = await deps.agentd.exec(
        {
          command: args.command as string,
          ...(args.cwd !== undefined ? { cwd: args.cwd as string } : {}),
          ...(seconds !== undefined ? { timeout_ms: seconds * 1000 } : {}),
        },
        signalOf(ctx),
      );
      const lines = [`exit_code: ${answer.exit_code}${answer.timed_out ? " (killed: timed out)" : ""}`];
      lines.push(answer.stdout ? `stdout:\n${answer.stdout}` : "stdout: (empty)");
      lines.push(answer.stderr ? `stderr:\n${answer.stderr}` : "stderr: (empty)");
      // A non-zero exit is an answer the model reads (grep finding nothing exits 1); only a kill is a failure.
      return { ok: !answer.timed_out, text: lines.join("\n") };
    },

    async computer_screenshot(_args, ctx) {
      const png = await deps.agentd.screenshot(signalOf(ctx));
      return { ok: true, text: "screenshot of the desktop", images: [{ mimeType: "image/png", base64: png.toString("base64") }] };
    },

    async files_read(args, ctx) {
      const path = args.path as string;
      const bytes = await deps.agentd.readFile(path, signalOf(ctx));
      const text = isUtf8Text(bytes);
      if (text === null) return fail(`${path} is a binary file of ${bytes.length} bytes; it cannot be shown as text`);
      return { ok: true, text: text.length === 0 ? `${path} is empty` : text };
    },

    async files_write(args, ctx) {
      const path = args.path as string;
      const content = args.content as string;
      await deps.agentd.writeFile(path, content, signalOf(ctx));
      return { ok: true, text: `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}` };
    },

    async files_list(args, ctx) {
      const path = args.path as string;
      const { entries } = await deps.agentd.listFiles(path, signalOf(ctx));
      if (entries.length === 0) return { ok: true, text: `${path} is empty` };
      const rows = [...entries]
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1))
        .map((e) => `${e.type.padEnd(5)} ${String(e.size).padStart(10)}  ${e.mtime}  ${e.name}${e.type === "dir" ? "/" : ""}`);
      return { ok: true, text: rows.join("\n") };
    },

    async memory_remember(args, ctx) {
      const key = args.key as string;
      await needStore().remember(key, args.content as string);
      ctx.emit({ type: "memory.written", data: { key } });
      return { ok: true, text: `remembered "${key}"` };
    },

    async memory_search(args) {
      const query = args.query as string;
      const hits = await needStore().search(query, searchLimit);
      if (hits.length === 0) return { ok: true, text: `no memories match "${query}"` };
      return {
        ok: true,
        text: hits.map((h) => `## ${h.key}${h.updated_at ? ` (updated ${h.updated_at})` : ""}\n${h.content}`).join("\n\n"),
      };
    },

    async browser_identity_list() {
      const identities = await deps.browsers.list();
      if (identities.length === 0) return { ok: true, text: "there are no browser identities yet" };
      return { ok: true, text: JSON.stringify(identities.map(describeIdentity), null, 2) };
    },

    async browser_identity_create(args) {
      const identity = await deps.browsers.create({
        name: args.name as string,
        ...(args.proxy !== undefined ? { proxy: args.proxy as string } : {}),
      });
      return { ok: true, text: `created browser identity ${JSON.stringify(describeIdentity(identity))}` };
    },

    async browser_identity_delete(args) {
      const id = args.identity_id as string;
      await deps.browsers.delete(id);
      return { ok: true, text: `deleted browser identity ${id} and its profile` };
    },

    async browser_identity_launch(args) {
      const identity = await deps.browsers.launch(args.identity_id as string);
      return { ok: true, text: `the browser of identity ${identity.id} (${identity.name}) is open` };
    },

    async browser_identity_close(args) {
      const id = args.identity_id as string;
      await deps.browsers.close(id);
      return { ok: true, text: `closed the browser of identity ${id}; its profile stays on disk` };
    },

    browser_navigate: browserAction("browser_navigate", (a) => ({ url: a.url }), (a) => `navigated to ${String(a.url)}`),
    browser_snapshot: browserAction("browser_snapshot", () => ({}), () => "the page has no interactive elements"),
    browser_read_text: browserAction(
      "browser_read_text",
      (a) => ({ ...(a.selector !== undefined ? { selector: a.selector } : {}), max_chars: maxText }),
      () => "(no text)",
    ),
    browser_click: browserAction("browser_click", (a) => ({ selector: a.selector }), (a) => `clicked ${String(a.selector)}`),
    browser_click_at: browserAction("browser_click_at", (a) => ({ x: a.x, y: a.y }), (a) => `clicked at (${String(a.x)}, ${String(a.y)})`),
    browser_type: browserAction(
      "browser_type",
      (a) => ({ selector: a.selector, text: a.text }),
      (a) => `typed into ${String(a.selector)}`,
    ),
    browser_press_key: browserAction("browser_press_key", (a) => ({ key: a.key }), (a) => `pressed ${String(a.key)}`),
    browser_scroll: browserAction(
      "browser_press_key",
      (a) => ({ key: a.direction === "up" ? BROWSER_KEYS.scrollUp : BROWSER_KEYS.scrollDown }),
      (a) => `scrolled ${String(a.direction)}`,
    ),
    browser_back: browserAction("browser_press_key", () => ({ key: BROWSER_KEYS.back }), () => "went back"),
    browser_forward: browserAction("browser_press_key", () => ({ key: BROWSER_KEYS.forward }), () => "went forward"),
    browser_reload: browserAction("browser_press_key", () => ({ key: BROWSER_KEYS.reload }), () => "reloaded"),
    browser_screenshot: browserAction("browser_take_screenshot", () => ({}), () => "screenshot taken"),
  };

  return {
    definitions(config: ToolOfferConfig): ToolDefinition[] {
      return offeredTools(config).filter((t) => config.memory.enabled || !t.permission.startsWith("memory."));
    },

    async call(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const definition = getTool(name);
      if (!definition) return fail(`unknown tool "${name}"`);
      if (deps.config && !this.definitions(deps.config()).some((t) => t.name === name)) {
        return fail(`the tool "${name}" is not available to this Dot with its current configuration`);
      }
      const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
      const errors = validateArguments(definition.parameters, args);
      if (errors.length > 0) return fail(`invalid arguments for ${name}: ${errors.join("; ")}`);
      if (ctx.signal.aborted) return fail(`${name} was cancelled before it ran`);

      try {
        const result = await handlers[name as ToolName](args as Args, ctx, definition);
        return { ...result, text: truncateText(result.text, maxText) };
      } catch (error) {
        if (ctx.signal.aborted) return fail(`${name} was cancelled`);
        const message = error instanceof Error ? error.message : String(error);
        return fail(truncateText(`${name} failed: ${message}`, maxText));
      }
    },
  };
}
