import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePythonLock } from "../../../guest/image-builder/src/python-lock.js";
import { argumentProblems, REAL_TOOLS, REAL_TOOLS_FIXTURE } from "./fixtures/mcp-schema.js";

describe("the real MCP tools the fake server is held to", () => {
  it("are those of the invisible-playwright-mcp version the golden image installs", () => {
    const lock = parsePythonLock(readFileSync(new URL("../../../guest/image-builder/builder/mcp-requirements.lock", import.meta.url), "utf8"));
    expect(REAL_TOOLS_FIXTURE.package).toBe("invisible-playwright-mcp");
    // A new pinned version needs a new capture of its tools/list (the fixture's own note says how).
    expect(REAL_TOOLS_FIXTURE.version).toBe(lock.mcpVersion);
    expect(REAL_TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(["browser_open", "browser_close", "browser_navigate", "browser_type"]));
  });

  it("refuse an argument the real server lacks, a missing required one and a wrong type", () => {
    expect(argumentProblems("browser_type", { selector: "#q", text: "hi", browser: "main" })).toEqual([]);
    expect(argumentProblems("browser_type", { selector: "#q", value: "hi" })).toEqual(['it has no argument "value"', '"text" is required']);
    expect(argumentProblems("browser_click_at", { x: "10", y: 20 })).toEqual(['"x" does not match its schema ("10")']);
    expect(argumentProblems("browser_open", { browser: "other" })).toEqual(['"browser" does not match its schema ("other")']);
    expect(argumentProblems("browser_teleport", {})).toEqual(["the real server has no tool browser_teleport"]);
  });
});
