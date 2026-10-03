import { describe, expect, it } from "vitest";
import { getTool, offeredTools, parseRuntimeConfig } from "@invisible-dots/shared";
import { decideTool } from "../src/dot/index.js";

const base = { name: "p", goal: "g", model: { provider: "openrouter", id: "m/x" } };

describe("decideTool", () => {
  it("applies the defaults of section 7 through each tool's permission", () => {
    const config = parseRuntimeConfig(base);
    const offered = offeredTools(config);
    expect(decideTool(config, offered, "computer_exec").decision).toBe("allow");
    expect(decideTool(config, offered, "files_write").decision).toBe("allow");
    expect(decideTool(config, offered, "memory_search").decision).toBe("allow");
    expect(decideTool(config, offered, "browser_click").decision).toBe("allow");
    expect(decideTool(config, offered, "browser_identity_delete")).toMatchObject({
      decision: "ask",
      permission: "browser.identity.delete",
      reason: "browser.identity.delete requires the user's approval (the default policy)",
    });
  });

  it("lets explicit entries win, decided on the config it is given", () => {
    const config = parseRuntimeConfig({ ...base, permissions: { "computer.exec": "ask", "browser.identity.delete": "allow" } });
    const offered = offeredTools(config);
    expect(decideTool(config, offered, "computer_exec").decision).toBe("ask");
    expect(decideTool(config, offered, "browser_identity_delete").decision).toBe("allow");
    const next = parseRuntimeConfig({ ...base, permissions: { "computer.exec": "deny" } });
    expect(decideTool(next, offeredTools(next), "computer_exec").decision).toBe("deny");
  });

  it("denies unknown or unoffered names", () => {
    const config = parseRuntimeConfig({
      ...base,
      browser: { identities: { managed_by_dot: false } },
      permissions: { "files.write": "deny" },
    });
    const offered = offeredTools(config);
    expect(decideTool(config, offered, "files_read")).toMatchObject({ decision: "allow", permission: "files.read" });
    expect(decideTool(config, offered, "files_write")).toMatchObject({
      decision: "deny",
      reason: "files.write is denied by the Dot's configuration",
    });
    expect(decideTool(config, offered, "rm_rf")).toEqual({ decision: "deny", permission: "", reason: 'the tool "rm_rf" does not exist' });
    expect(getTool("browser_identity_delete")).toBeDefined();
    expect(decideTool(config, offered, "browser_identity_delete").decision).toBe("deny");
  });
});
