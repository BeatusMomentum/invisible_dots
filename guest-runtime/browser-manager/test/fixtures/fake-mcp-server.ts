/**
 * A stand-in for `invisible-playwright-mcp` over stdio. It speaks real MCP
 * through the SDK, answers with the same sentences the real server uses, and
 * appends what it was started with and every call it received to
 * `$INVISIBLE_MCP_HOME/record.jsonl`, so tests can assert on the child's
 * environment and arguments. Behaviour is steered by
 * `$INVISIBLE_MCP_HOME/control.json`, since the manager's environment
 * allowlist would drop any custom variable.
 *
 * Its tools/list is the real server's (mcp-tools.json, captured from the
 * version the golden image pins), and every call is checked against that
 * schema: an argument the real server does not have, a missing required one
 * or one of the wrong type is refused, so a renamed parameter fails here and
 * not only inside a Dot.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { argumentProblems, REAL_TOOLS } from "./mcp-schema.js";

interface Control {
  /** browser_open answers with download progress this many times before opening. */
  downloadingAnswers?: number;
  /** browser_open fails as the real server does when Firefox does not start. */
  failOpen?: boolean;
  /** The first page action after opening reports the browser gone, as after a Firefox crash. */
  loseBrowserOnce?: boolean;
}

const home = process.env.INVISIBLE_MCP_HOME ?? process.cwd();
const recordFile = join(home, "record.jsonl");
const controlFile = join(home, "control.json");
const control: Control = existsSync(controlFile) ? (JSON.parse(readFileSync(controlFile, "utf8")) as Control) : {};

function record(entry: Record<string, unknown>): void {
  appendFileSync(recordFile, `${JSON.stringify(entry)}\n`);
}

record({ kind: "start", pid: process.pid, argv: process.argv.slice(2), env: process.env });

let downloadingLeft = control.downloadingAnswers ?? 0;
let loseBrowser = control.loseBrowserOnce ?? false;
let open = false;
let url = "about:blank";

const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] });
const error = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }], isError: true });
// A 1x1 transparent PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const server = new Server({ name: "fake-stealth", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: REAL_TOOLS.map((tool) => ({ name: tool.name, inputSchema: { type: "object" as const, ...tool.inputSchema } })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  record({ kind: "call", name, args });
  const problems = argumentProblems(name, args);
  if (problems.length > 0) return error(`invalid arguments for ${name}: ${problems.join("; ")}`);
  const role = typeof args.browser === "string" ? args.browser : "main";

  if (name === "browser_open") {
    if (control.failOpen) return error(`the ${role} browser did NOT start: proxy refused the connection`);
    if (downloadingLeft > 0) {
      downloadingLeft--;
      return text("the engine is not on this machine yet and is downloading now: 40% of 90 MB. Call browser_open again in a minute; nothing else needs doing.");
    }
    open = true;
    return text(`the ${role} browser is open. seed: remembered by the profile`);
  }
  if (name === "browser_close") {
    if (!open) return text(`the ${role} browser is not open.`);
    open = false;
    return text(`the ${role} browser is closed.`);
  }
  if (!open) return error(`the ${role} browser is not open. Call browser_open to open it.`);
  if (loseBrowser) {
    loseBrowser = false;
    open = false;
    return error(`the ${role} browser is gone: it closed or crashed. Call browser_open to open it again.`);
  }

  switch (name) {
    case "browser_status":
      return text(`the ${role} browser is open on ${url}`);
    case "browser_navigate":
      if (args.url === "crash://now") {
        // Exit without answering, like a server killed mid-call.
        process.exit(3);
      }
      url = String(args.url);
      return text(`200 ${url}`);
    case "browser_snapshot":
      return text(`title: Fake\nurl: ${url}\n- button "Go" selector: #go at: [10, 20]`);
    case "browser_read_text":
      if (args.selector === "#huge") return text("x".repeat(20_000));
      return text(`text of ${String(args.selector ?? "body")}`);
    case "browser_take_screenshot":
      return { content: [{ type: "image", data: PNG, mimeType: "image/png" }] };
    case "browser_click_at":
      return { content: [{ type: "image", data: PNG, mimeType: "image/png" }] };
    case "browser_click":
      return text(`clicked ${String(args.selector)}`);
    case "browser_type":
      return text(`typed into ${String(args.selector)}`);
    case "browser_press_key":
      return text(`pressed ${String(args.key)}`);
    default:
      return error(`unknown tool ${name}`);
  }
});

await server.connect(new StdioServerTransport());
