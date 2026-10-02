import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserIdentityManager, MemoryIdentityPersistence, type BrowserIdentityEvent, type BrowserIdentityManagerOptions } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** Starts the fake server through tsx, from an absolute URL so the child's working directory does not matter. */
export const FAKE_MCP_COMMAND = [
  process.execPath,
  "--import",
  pathToFileURL(require.resolve("tsx")).href,
  join(here, "fixtures", "fake-mcp-server.ts"),
];

export interface RecordedEntry {
  kind: "start" | "call";
  pid?: number;
  env?: Record<string, string>;
  name?: string;
  args?: Record<string, unknown>;
}

export async function readRecord(mcpHome: string): Promise<RecordedEntry[]> {
  try {
    const text = await readFile(join(mcpHome, "record.jsonl"), "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as RecordedEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function writeControl(mcpHome: string, control: Record<string, unknown>): Promise<void> {
  await writeFile(join(mcpHome, "control.json"), JSON.stringify(control));
}

export interface Harness {
  dir: string;
  manager: BrowserIdentityManager;
  persistence: MemoryIdentityPersistence;
  events: BrowserIdentityEvent[];
  logs: string[];
  cleanup(): Promise<void>;
}

export async function makeHarness(overrides: Partial<BrowserIdentityManagerOptions> = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "idots-bm-"));
  const persistence = new MemoryIdentityPersistence();
  const events: BrowserIdentityEvent[] = [];
  const logs: string[] = [];
  const manager = new BrowserIdentityManager({
    persistence,
    browsersDir: join(dir, "browsers"),
    maxOpen: 3,
    maxIdentities: 20,
    mcpCommand: FAKE_MCP_COMMAND,
    emit: (event) => events.push(event),
    log: (line) => logs.push(line),
    openRetryInitialMs: 10,
    openRetryMaxMs: 20,
    requestTimeoutMs: 20_000,
    ...overrides,
  });
  return {
    dir,
    manager,
    persistence,
    events,
    logs,
    async cleanup() {
      await manager.closeAll();
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
