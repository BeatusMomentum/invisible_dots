/**
 * The host to guest protocol of architecture section 5: dot-agentd routes
 * (5.2), invisible-dots-agent routes (5.3), the guest filesystem (4.2), the
 * host filesystem (3.2) and the environment variables every component reads.
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

/** dot-agentd listens on this vsock port (section 5.1). */
export const VSOCK_PORT = 1024;

/** stdout and stderr of `POST /v1/exec` are each capped at this many bytes. */
export const EXEC_OUTPUT_CAP_BYTES = 1024 * 1024;

/** Tool results longer than this are cut with a marker before they reach the model (section 8.5). */
export const TOOL_RESULT_MAX_CHARS = 12_000;

/** Working memory keeps this many messages plus the system prompt (section 8.6). */
export const WORKING_MEMORY_MESSAGES = 40;

/** The system prompt lists this many most recently updated memory keys (section 8.6). */
export const SYSTEM_PROMPT_MEMORY_KEYS = 20;

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_REFERER = "https://github.com/feder-cr/dots";
export const OPENROUTER_TITLE = "invisible_dots";

export const DEFAULT_LISTEN = "127.0.0.1:8787";
export const DEFAULT_CID_BASE = 10_000;

/** 0, 1 and 2 are reserved vsock CIDs (hypervisor, local, host); 0xFFFFFFFF is VMADDR_CID_ANY. */
export const MIN_GUEST_CID = 3;
export const MAX_GUEST_CID = 0xfffffffe;

/** The first CID the control plane allocates, from INVISIBLE_DOTS_CID_BASE (section 3.5). */
export function cidBaseFromEnv(env: Record<string, string | undefined> = globalThis.process?.env ?? {}): number {
  const raw = env[ENV.CID_BASE];
  if (raw === undefined || raw.trim() === "") return DEFAULT_CID_BASE;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_GUEST_CID || value > MAX_GUEST_CID) {
    throw new Error(`${ENV.CID_BASE}="${raw}" is not a valid vsock CID (an integer from ${MIN_GUEST_CID} to ${MAX_GUEST_CID})`);
  }
  return value;
}

/** Environment variable names. */
export const ENV = {
  STATE_DIR: "INVISIBLE_DOTS_STATE_DIR",
  RUN_DIR: "INVISIBLE_DOTS_RUN_DIR",
  CONFIG_DIR: "INVISIBLE_DOTS_CONFIG_DIR",
  CID_BASE: "INVISIBLE_DOTS_CID_BASE",
  LISTEN: "INVISIBLE_DOTS_LISTEN",
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
  stateDir: "/home/dot/state",
  database: "/home/dot/state/dot.db",
  browsers: "/home/dot/browsers",
  runDir: "/run/invisible-dots",
  agentdSocket: "/run/invisible-dots/agentd.sock",
  agentSocket: "/run/invisible-dots/agent.sock",
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

/** Host directories (section 3.2), honouring the INVISIBLE_DOTS_*_DIR overrides. */
export function hostPaths(env: Record<string, string | undefined> = globalThis.process?.env ?? {}) {
  const stateDir = env[ENV.STATE_DIR] || "/var/lib/invisible-dots";
  const runDir = env[ENV.RUN_DIR] || "/run/invisible-dots";
  const configDir = env[ENV.CONFIG_DIR] || "/etc/invisible-dots";
  const vmsDir = join(stateDir, "vms");
  const imagesDir = join(stateDir, "images");
  return {
    stateDir,
    runDir,
    configDir,
    imagesDir,
    vmsDir,
    snapshotsDir: join(stateDir, "snapshots"),
    artifactsDir: join(stateDir, "artifacts"),
    backupsDir: join(stateDir, "backups"),
    serverEnv: join(configDir, "server.env"),
    masterKey: join(configDir, "master.key"),
    apiToken: join(configDir, "api.token"),
    goldenImage: (version: string) => join(imagesDir, `golden-${version}.qcow2`),
    runtimeImage: (version: string) => join(imagesDir, `runtime-${version}.iso`),
    vmDir: (dotId: string) => join(vmsDir, dotId),
    vmDisk: (dotId: string) => join(vmsDir, dotId, "disk.qcow2"),
    vmSeed: (dotId: string) => join(vmsDir, dotId, "seed.iso"),
    vmSerialLog: (dotId: string) => join(vmsDir, dotId, "serial.log"),
    bridgeSocket: (dotId: string) => join(runDir, `dot-${dotId}.sock`),
  };
}
export type HostPaths = ReturnType<typeof hostPaths>;

/** The libvirt domain name of a Dot (section 3.4). */
export function domainName(dotId: string): string {
  return `invisible-dot-${dotId}`;
}

/** The libvirt network every Dot's NIC is attached to. */
export const LIBVIRT_NETWORK = "invisible-dots";

export const AGENTD_ROUTES = {
  health: "/v1/health",
  system: "/v1/system",
  exec: "/v1/exec",
  files: "/v1/files",
  filesList: "/v1/files/list",
  screenshot: "/v1/screenshot",
  /** Prefix of the reverse proxy to the agent socket. */
  agent: "/v1/agent",
} as const;

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
