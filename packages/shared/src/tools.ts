/**
 * The tool table of architecture section 8.3. Every package that offers,
 * checks or describes a tool reads it from here, so a tool exists in exactly
 * one place.
 */
import { redactProxy } from "./identity-rules.js";

/** The subset of JSON Schema the tool arguments use. */
export interface JsonSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: readonly (string | number)[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: JsonSchema;
}

export const PERMISSIONS = [
  "computer.exec",
  "computer.screenshot",
  "files.read",
  "files.write",
  "memory.read",
  "memory.write",
  "browser.identity.list",
  "browser.identity.create",
  "browser.identity.delete",
  "browser.identity.launch",
  "browser.identity.close",
  "browser.navigate",
  "browser.read",
  "browser.act",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}

export interface ToolDefinition {
  /** Function name sent to the model; `_` only, because OpenAI-style names cannot contain dots. */
  name: string;
  permission: Permission;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: JsonSchema & { type: "object"; properties: Record<string, JsonSchema>; required: string[] };
  /** The result carries an image that is sent to the model as an `image_url` part. */
  returnsImage: boolean;
  /** Offered only when `browser.identities.managed_by_dot` is true. */
  requiresManagedIdentities: boolean;
  /**
   * Arguments that are URLs which may carry a password (a proxy). Wherever a
   * call's arguments leave the guest (`approval.requested`), the password is
   * replaced: `redactToolArguments` is the one place that does it.
   */
  secretUrlArguments: readonly string[];
}

function args(properties: Record<string, JsonSchema>, required: string[]): ToolDefinition["parameters"] {
  return { type: "object", properties, required, additionalProperties: false };
}

const identityId: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Id of the browser identity, as returned by browser_identity_list or browser_identity_create.",
};

function tool<const N extends string>(
  name: N,
  permission: Permission,
  description: string,
  parameters: ToolDefinition["parameters"],
  options: { returnsImage?: boolean; requiresManagedIdentities?: boolean; secretUrlArguments?: readonly string[] } = {},
): ToolDefinition & { name: N } {
  return {
    name,
    permission,
    description,
    parameters,
    returnsImage: options.returnsImage ?? false,
    requiresManagedIdentities: options.requiresManagedIdentities ?? false,
    secretUrlArguments: options.secretUrlArguments ?? [],
  };
}

export const TOOLS = [
  tool(
    "computer_exec",
    "computer.exec",
    "Run a shell command on your computer with `bash -lc` and return its exit code, stdout and stderr (each capped at 1 MiB).",
    args(
      {
        command: { type: "string", minLength: 1, description: "The command line to run." },
        cwd: { type: "string", description: "Working directory; relative paths resolve against /home/dot." },
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 3600,
          description: "Kill the command after this many seconds.",
        },
      },
      ["command"],
    ),
  ),
  tool(
    "computer_screenshot",
    "computer.screenshot",
    "Take a screenshot of your computer's desktop. The image is shown to you.",
    args({}, []),
    { returnsImage: true },
  ),
  tool(
    "files_read",
    "files.read",
    "Read a file on your computer. Relative paths resolve against /home/dot.",
    args({ path: { type: "string", minLength: 1, description: "Path of the file to read." } }, ["path"]),
  ),
  tool(
    "files_write",
    "files.write",
    "Write a text file on your computer, replacing it if it exists. Relative paths resolve against /home/dot.",
    args(
      {
        path: { type: "string", minLength: 1, description: "Path of the file to write." },
        content: { type: "string", description: "The full new content of the file." },
      },
      ["path", "content"],
    ),
  ),
  tool(
    "files_list",
    "files.read",
    "List a directory on your computer. Relative paths resolve against /home/dot.",
    args({ path: { type: "string", minLength: 1, description: "Directory to list." } }, ["path"]),
  ),
  tool(
    "memory_remember",
    "memory.write",
    "Store a long-term memory under a key, replacing any previous content for that key.",
    args(
      {
        key: { type: "string", minLength: 1, maxLength: 200, description: "Short stable name for the memory." },
        content: { type: "string", description: "What to remember." },
      },
      ["key", "content"],
    ),
  ),
  tool(
    "memory_search",
    "memory.read",
    "Full-text search over your long-term memories.",
    args({ query: { type: "string", minLength: 1, description: "Words to search for." } }, ["query"]),
  ),
  tool("browser_identity_list", "browser.identity.list", "List your browser identities and whether each is open.", args({}, [])),
  tool(
    "browser_identity_create",
    "browser.identity.create",
    "Create a new browser identity: a separate browser profile with its own cookies, storage, logins and fingerprint.",
    args(
      {
        name: { type: "string", minLength: 1, maxLength: 80, description: "Human-readable name of the identity." },
        proxy: {
          type: "string",
          description: "Optional proxy URL every launch of this identity uses, e.g. http://user:pass@host:port.",
        },
      },
      ["name"],
    ),
    { requiresManagedIdentities: true, secretUrlArguments: ["proxy"] },
  ),
  tool(
    "browser_identity_delete",
    "browser.identity.delete",
    "Delete a browser identity and its whole profile from disk. This cannot be undone.",
    args({ identity_id: identityId }, ["identity_id"]),
    { requiresManagedIdentities: true },
  ),
  tool(
    "browser_identity_launch",
    "browser.identity.launch",
    "Open the browser of an identity on your desktop.",
    args({ identity_id: identityId }, ["identity_id"]),
  ),
  tool(
    "browser_identity_close",
    "browser.identity.close",
    "Close the browser of an identity. Its profile stays on disk.",
    args({ identity_id: identityId }, ["identity_id"]),
  ),
  tool(
    "browser_navigate",
    "browser.navigate",
    "Load a URL in the browser of an identity, launching it first if it is not open.",
    args(
      { identity_id: identityId, url: { type: "string", minLength: 1, description: "Absolute URL to load." } },
      ["identity_id", "url"],
    ),
  ),
  tool(
    "browser_snapshot",
    "browser.read",
    "Describe the interactive elements of the current page, with a selector and viewport coordinates for each.",
    args({ identity_id: identityId }, ["identity_id"]),
  ),
  tool(
    "browser_read_text",
    "browser.read",
    "Read the visible text of the current page, or of the element matching a selector.",
    args(
      {
        identity_id: identityId,
        selector: { type: "string", description: "Optional CSS selector; the whole page when omitted." },
      },
      ["identity_id"],
    ),
  ),
  tool(
    "browser_click",
    "browser.act",
    "Click the element matching a selector with the real pointer.",
    args(
      { identity_id: identityId, selector: { type: "string", minLength: 1, description: "Selector from browser_snapshot." } },
      ["identity_id", "selector"],
    ),
  ),
  tool(
    "browser_click_at",
    "browser.act",
    "Click at viewport coordinates with the real pointer.",
    args(
      {
        identity_id: identityId,
        x: { type: "number", minimum: 0, description: "Viewport x in CSS pixels." },
        y: { type: "number", minimum: 0, description: "Viewport y in CSS pixels." },
      },
      ["identity_id", "x", "y"],
    ),
  ),
  tool(
    "browser_type",
    "browser.act",
    "Focus the element matching a selector and type text into it with the real keyboard.",
    args(
      {
        identity_id: identityId,
        selector: { type: "string", minLength: 1, description: "Selector from browser_snapshot." },
        text: { type: "string", description: "Text to type." },
      },
      ["identity_id", "selector", "text"],
    ),
  ),
  tool(
    "browser_press_key",
    "browser.act",
    "Press a key or key combination, e.g. Enter, Escape, Control+A.",
    args(
      { identity_id: identityId, key: { type: "string", minLength: 1, description: "Key name or combination." } },
      ["identity_id", "key"],
    ),
  ),
  tool(
    "browser_scroll",
    "browser.act",
    "Scroll the page one screen up or down (PageUp / PageDown).",
    args({ identity_id: identityId, direction: { type: "string", enum: ["up", "down"] } }, ["identity_id", "direction"]),
  ),
  tool("browser_back", "browser.act", "Go back in history (Alt+Left).", args({ identity_id: identityId }, ["identity_id"])),
  tool(
    "browser_forward",
    "browser.act",
    "Go forward in history (Alt+Right).",
    args({ identity_id: identityId }, ["identity_id"]),
  ),
  tool("browser_reload", "browser.act", "Reload the page (F5).", args({ identity_id: identityId }, ["identity_id"])),
  tool(
    "browser_screenshot",
    "browser.read",
    "Take a screenshot of the browser of an identity. The image is shown to you.",
    args({ identity_id: identityId }, ["identity_id"]),
    { returnsImage: true },
  ),
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

export const TOOL_NAMES: readonly ToolName[] = TOOLS.map((t) => t.name);

const byName = new Map<string, ToolDefinition>(TOOLS.map((t) => [t.name, t]));

/**
 * A tool call's arguments as they may leave the guest: every argument the
 * tool lists in `secretUrlArguments` has its password replaced. Unknown
 * tools and arguments that are not strings pass unchanged.
 */
export function redactToolArguments(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const secret = getTool(name)?.secretUrlArguments ?? [];
  if (secret.length === 0) return args;
  const out: Record<string, unknown> = { ...args };
  for (const key of secret) {
    const value = out[key];
    if (typeof value === "string" && value !== "") out[key] = redactProxy(value);
  }
  return out;
}

export function getTool(name: string): ToolDefinition | undefined {
  return byName.get(name);
}

/**
 * The tools a Dot is offered. When the Dot does not manage its identities the
 * create and delete tools are left out entirely, rather than offered and denied,
 * so the model never plans around them (section 8.3).
 */
export function offeredTools(config: { browser: { identities: { managed_by_dot: boolean } } }): ToolDefinition[] {
  const managed = config.browser.identities.managed_by_dot;
  return TOOLS.filter((t) => managed || !t.requiresManagedIdentities);
}
