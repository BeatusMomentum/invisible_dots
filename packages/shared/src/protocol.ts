/**
 * The host to guest protocol of architecture section 5: dot-agentd routes
 * (5.2), invisible-dots-agent routes (5.3), the guest filesystem (4.2) and
 * the environment variables every component reads. The host filesystem (3.2)
 * is in paths.ts, which needs node:path and so stays out of the web client.
 */
import type { DotRuntimeConfig } from "./config.js";
import type { ApprovalRequestedData } from "./events.js";
import type { AgentState } from "./states.js";

/**
 * POSIX join without node:path, so the web client can import this module.
 * Inputs are absolute directories and plain names, never ".." segments.
 */
function join(...parts: string[]): string {
  return parts.map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, ""))).join("/");
}

/**
 * dot-agentd listens on this TCP port inside the guest; QEMU forwards a free
 * port on the host's 127.0.0.1 to it (sections 3.5 and 5.1).
 */
export const GUEST_PORT = 1024;

/** stdout and stderr of `POST /v1/exec` are each capped at this many bytes. */
export const EXEC_OUTPUT_CAP_BYTES = 1024 * 1024;

/** Tool results longer than this are cut with a marker before they reach the model (section 8.5). */
export const TOOL_RESULT_MAX_CHARS = 12_000;

/**
 * The one truncation function: cut a text to at most `max` characters, the
 * marker included, saying how much the reader does not see. `head` keeps the
 * beginning; `head-tail` keeps about 70% from the beginning and 30% from the
 * end, for text whose last lines matter as much as its first.
 */
export function truncateText(text: string, max: number = TOOL_RESULT_MAX_CHARS, mode: "head" | "head-tail" = "head"): string {
  if (text.length <= max) return text;
  const marker = (omitted: number) =>
    mode === "head" ? `\n[... truncated: ${omitted} more characters not shown]` : `\n[... truncated: ${omitted} characters not shown ...]\n`;
  // The marker's length depends on the count it states, so size it for the worst case.
  const keep = max - marker(text.length).length;
  if (keep <= 0) return text.slice(0, max);
  if (mode === "head") return text.slice(0, keep) + marker(text.length - keep);
  const head = Math.ceil(keep * 0.7);
  const tail = keep - head;
  return text.slice(0, head) + marker(text.length - keep) + (tail > 0 ? text.slice(text.length - tail) : "");
}

/** The system prompt lists this many most recently updated memory keys (section 8.6). */
export const SYSTEM_PROMPT_MEMORY_KEYS = 20;

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_REFERER = "https://github.com/feder-cr/dots";
export const OPENROUTER_TITLE = "invisible_dots";

export const DEFAULT_LISTEN = "127.0.0.1:8787";
/** Where `invisible-dots server` serves the web client (section 9.7). */
export const DEFAULT_WEB_LISTEN = "127.0.0.1:3000";

/** Environment variable names. */
export const ENV = {
  /** The one host data directory (section 3.2); default `~/.invisible-dots`. */
  HOME: "INVISIBLE_DOTS_HOME",
  /** The one directory QEMU is looked for in, when set (section 3.1). */
  QEMU_DIR: "INVISIBLE_DOTS_QEMU_DIR",
  LISTEN: "INVISIBLE_DOTS_LISTEN",
  /** Where the web client listens when `invisible-dots server` starts it, as host:port. */
  WEB_LISTEN: "INVISIBLE_DOTS_WEB_LISTEN",
  /** Extra host names (comma separated) the web server may be reached by, besides loopback. */
  WEB_ALLOWED_HOSTS: "INVISIBLE_DOTS_WEB_ALLOWED_HOSTS",
  /** The API token itself, instead of the api.token file: the server's token, or the one a client sends. */
  TOKEN: "INVISIBLE_DOTS_TOKEN",
  /** Where clients (CLI, web server) reach the API. Default http://127.0.0.1:8787. */
  URL: "INVISIBLE_DOTS_URL",
  DATABASE_URL: "DATABASE_URL",
  /** Read by invisible-playwright-mcp, one value per browser identity (section 6). */
  MCP_HOME: "INVISIBLE_MCP_HOME",
  MCP_SESSION_ID: "INVISIBLE_MCP_SESSION_ID",
  PROFILE_DIR: "STEALTHFOX_PROFILE_DIR",
  HEADLESS: "STEALTHFOX_HEADLESS",
  PROXY: "STEALTHFOX_PROXY",
  DISPLAY: "DISPLAY",
} as const;

/** The X display the guest desktop runs on. */
export const GUEST_DISPLAY = ":0";

/** Guest paths (section 4.2). The guest is always Linux, so these are POSIX paths. */
export const GUEST_PATHS = {
  config: "/etc/invisible-dots/config.json",
  runtime: "/opt/invisible-dots",
  home: "/home/dot",
  workspace: "/home/dot/workspace",
  downloads: "/home/dot/downloads",
  documents: "/home/dot/documents",
  memory: "/home/dot/memory",
  browsers: "/home/dot/browsers",
  runDir: "/run/invisible-dots",
  agentdSocket: "/run/invisible-dots/agentd.sock",
  /** The engine's API, in a directory of the engine's user dot cannot write (architecture 4.2). */
  agentSocket: "/run/invisible-dots-agent/agent.sock",
} as const;

/** Paths of one browser identity under a browsers root (default `/home/dot/browsers`). */
export function identityPaths(identityId: string, browsersDir: string = GUEST_PATHS.browsers) {
  const root = join(browsersDir, identityId);
  return {
    root,
    profile: join(root, "profile"),
    mcp: join(root, "mcp"),
    metadata: join(root, "metadata.json"),
  };
}

/** `/etc/invisible-dots/config.json` in the guest, written by cloud-init. */
export interface GuestBootConfig {
  dotId: string;
  token: string;
}

/** The QEMU `-name` of a Dot's VM, also stored as `computers.vm_name` (sections 3.4 and 9.1). */
export function vmName(dotId: string): string {
  return `invisible-dot-${dotId}`;
}

export const AGENTD_ROUTES = {
  health: "/v1/health",
  system: "/v1/system",
  exec: "/v1/exec",
  files: "/v1/files",
  filesList: "/v1/files/list",
  screenshot: "/v1/screenshot",
  /**
   * The one route without the token (section 5.1): `?nonce=<hex>` answers
   * `{ proof }`, the HMAC-SHA256 of GUEST_PROOF_CONTEXT plus the nonce under
   * the Dot token. The host asks it before it sends the token anywhere, so a
   * process that took over a stale guest port never sees the token.
   */
  proof: "/v1/proof",
  /**
   * How the control plane stops a VM (section 3.4): the guest powers itself
   * off and QEMU exits with it. Served on the TCP port only, never on the
   * agent's socket: powering off is the control plane's decision.
   */
  poweroff: "/v1/system/poweroff",
  /** Prefix of the reverse proxy to the agent socket. */
  agent: "/v1/agent",
} as const;

/** What `GET /v1/proof` signs before the nonce; dot-agentd's Go code holds the same bytes. */
export const GUEST_PROOF_CONTEXT = "invisible-dots guest proof v1\n";

/** `GET /v1/proof` answer: lowercase hex. */
export interface ProofAnswer {
  proof: string;
}

export const AGENT_ROUTES = {
  health: "/health",
  secrets: "/secrets",
  config: "/config",
  events: "/events",
  eventsStream: "/events/stream",
  state: "/state",
  browserIdentities: "/browser-identities",
  browserIdentity: (id: string) => `/browser-identities/${encodeURIComponent(id)}`,
  prepareSleep: "/prepare-sleep",
} as const;

/** Guest self-checks the host needs before it calls a Dot READY (section 9.3). */
export interface GuestChecks {
  filesystem_writable: boolean;
  network_reachable: boolean;
  browser_installed: boolean;
}

/**
 * `GET /health` of the agent. The guest checks live here, not in dot-agentd:
 * the agent writes the state, reaches OpenRouter and starts the browser layer,
 * so it is the process that can tell whether those work.
 */
export interface AgentHealthAnswer {
  status: "ok" | "starting";
  state: AgentState;
  openrouter_configured: boolean;
  browser: { identities: number; open: number };
  checks: GuestChecks;
}

/** What dot-agentd reports for the agent when its socket does not answer. */
export interface AgentDown {
  status: "down";
  /** Why dot-agentd could not reach the agent (socket missing, timeout, bad answer). */
  error?: string;
}

/** `GET /v1/health` of dot-agentd. */
export interface HealthAnswer {
  agentd: "ok";
  agent: AgentHealthAnswer | AgentDown;
  uptime_s: number;
}

/** `GET /v1/system`. */
export interface SystemAnswer {
  hostname: string;
  uptime_s: number;
  cpus: number;
  mem_total_bytes: number;
  mem_available_bytes: number;
  disk_total_bytes: number;
  disk_free_bytes: number;
}

/** `POST /v1/exec` body. The command runs as `bash -lc <command>`. */
export interface ExecRequest {
  command: string;
  cwd?: string;
  timeout_ms?: number;
}

/** `POST /v1/exec` answer. `exit_code` is -1 when the process was killed by the timeout or a signal. */
export interface ExecAnswer {
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

export type FileEntryType = "file" | "dir" | "other";

export interface FileEntry {
  name: string;
  type: FileEntryType;
  size: number;
  /** Modification time, RFC 3339 / ISO 8601 in UTC. */
  mtime: string;
}

/** `GET /v1/files/list`. */
export interface FileListAnswer {
  entries: FileEntry[];
}

/** `POST /secrets`. */
export interface SecretsRequest {
  openrouter_api_key: string;
}

/**
 * What an OpenRouter key is made of, as one rule with two readers: the host refuses a key that breaks it when the
 * user enters it (`checkOpenRouterKey`), and the guest engine refuses it again on `POST /secrets`
 * (nanobot/dots/protocol.py keeps a copy of these two constants; tests/repo/vendored-nanobot.test.ts keeps the
 * copy equal). The key travels in an Authorization header, so it is printable ASCII with no space; any other
 * character makes the HTTP stack refuse the request with an error whose text is the whole header.
 */
export const OPENROUTER_KEY_PATTERN = "[!-~]+";
export const OPENROUTER_KEY_RULE = "the key must be printable ASCII without spaces, as it travels in a header";

/** A key as the host stores it (the value with its ends trimmed), or why the value is not one. The key is never in the problem. */
export type OpenRouterKeyCheck = { ok: true; key: string } | { ok: false; problem: string };

export function checkOpenRouterKey(value: unknown): OpenRouterKeyCheck {
  if (typeof value !== "string" || value.trim() === "") return { ok: false, problem: "value must be a non-empty string" };
  const key = value.trim();
  if (!new RegExp(`^${OPENROUTER_KEY_PATTERN}$`).test(key)) return { ok: false, problem: `value is not an OpenRouter key: ${OPENROUTER_KEY_RULE}` };
  return { ok: true, key };
}

/** `PUT /config` body. */
export type PutConfigRequest = DotRuntimeConfig;

/** `POST /events` answer (status 202). */
export interface PostEventAnswer {
  accepted: true;
}

/** A tool call parked until the user approves or rejects it. */
export type PendingApproval = ApprovalRequestedData;

/** `GET /state`. */
export interface AgentStateAnswer {
  state: AgentState;
  current_task_id: string | null;
  pending_approval: PendingApproval | null;
}

export const BROWSER_IDENTITY_STATUSES = ["available", "open", "archived"] as const;
export type BrowserIdentityStatus = (typeof BROWSER_IDENTITY_STATUSES)[number];

/** One browser identity, as stored in `metadata.json` and returned by the identity routes. */
export interface BrowserIdentity {
  id: string;
  name: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601, null until the first launch. */
  lastUsedAt: string | null;
  status: BrowserIdentityStatus;
  profilePath: string;
  proxy?: string;
}

/** `POST /browser-identities` body. */
export interface CreateBrowserIdentityRequest {
  name: string;
  proxy?: string;
}

/** `GET /browser-identities`. */
export interface BrowserIdentityListAnswer {
  identities: BrowserIdentity[];
}

/** Every error body, on the host API and in the guest (section 9.6). */
export interface ErrorAnswer {
  error: string;
  message: string;
}
