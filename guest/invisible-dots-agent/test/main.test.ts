import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import { GUEST_PATHS } from "@invisible-dots/shared";
import { createJsonLogger, isInstalled, parseCommandLine, resolveSettings } from "../src/index.js";

describe("settings", () => {
  it("defaults to the guest layout", () => {
    const settings = resolveSettings([], {});
    expect(settings).toMatchObject({
      listen: { socketPath: GUEST_PATHS.agentSocket },
      dbPath: GUEST_PATHS.database,
      browsersDir: GUEST_PATHS.browsers,
      agentdSocket: GUEST_PATHS.agentdSocket,
      mcpCommand: ["invisible-playwright-mcp"],
      logLevel: "info",
    });
  });

  it("lets flags win over the environment", () => {
    const settings = resolveSettings(["--db", "/tmp/flag.db", "--listen", "127.0.0.1:9000"], {
      INVISIBLE_DOTS_DB: "/tmp/env.db",
      INVISIBLE_DOTS_AGENT_SOCKET: "/tmp/env.sock",
      INVISIBLE_DOTS_MCP_COMMAND: '["uvx", "invisible-playwright-mcp"]',
      INVISIBLE_DOTS_LOG_LEVEL: "debug",
    });
    expect(settings).toMatchObject({
      dbPath: "/tmp/flag.db",
      listen: { host: "127.0.0.1", port: 9000 },
      mcpCommand: ["uvx", "invisible-playwright-mcp"],
      logLevel: "debug",
    });
  });

  it("refuses bad values with a readable message", () => {
    expect(() => resolveSettings(["--log-level", "loud"], {})).toThrow(/invalid log level/);
    expect(() => resolveSettings(["--listen", "host:99999"], {})).toThrow(/invalid listen address/);
    expect(() => resolveSettings(["--nope"], {})).toThrow();
    expect(resolveSettings(["-h"], {})).toBe("help");
  });

  it("splits a command line", () => {
    expect(parseCommandLine("  uvx  invisible-playwright-mcp ")).toEqual(["uvx", "invisible-playwright-mcp"]);
    expect(() => parseCommandLine("[1]")).toThrow(/array of strings/);
  });
});

describe("logger and checks", () => {
  it("writes one JSON object per line and filters by level", () => {
    const lines: string[] = [];
    const log = createJsonLogger({ level: "info", write: (l) => lines.push(l), now: () => new Date(0) });
    log.debug("hidden");
    log.info("shown", { task_id: "t1", skipped: undefined });
    expect(lines).toEqual(['{"ts":"1970-01-01T00:00:00.000Z","level":"info","msg":"shown","task_id":"t1"}\n']);
  });

  it("finds a program on PATH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "idots-path-"));
    try {
      const program = join(dir, "fake-mcp");
      writeFileSync(program, "#!/bin/sh\n");
      chmodSync(program, 0o755);
      expect(await isInstalled("fake-mcp", { PATH: ["/nonexistent", dir].join(delimiter) })).toBe(true);
      expect(await isInstalled("missing-mcp", { PATH: dir })).toBe(false);
      expect(await isInstalled(program, {})).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
