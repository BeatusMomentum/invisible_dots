import { describe, expect, it } from "vitest";
import { getTool, offeredTools, parseDotConfig, PERMISSIONS, TOOL_NAMES, TOOLS } from "../src/index.js";

describe("tool table", () => {
  it("has the 24 tools of section 8.3 with unique, dot-free names", () => {
    expect(TOOLS).toHaveLength(24);
    expect(new Set(TOOL_NAMES).size).toBe(TOOLS.length);
    for (const name of TOOL_NAMES) expect(name).toMatch(/^[a-z_]+$/);
  });

  it("maps tools to the permissions of section 8.3", () => {
    expect(getTool("computer_exec")?.permission).toBe("computer.exec");
    expect(getTool("files_list")?.permission).toBe("files.read");
    expect(getTool("memory_remember")?.permission).toBe("memory.write");
    expect(getTool("browser_snapshot")?.permission).toBe("browser.read");
    expect(getTool("browser_scroll")?.permission).toBe("browser.act");
    expect(getTool("browser_reload")?.permission).toBe("browser.act");
    expect(getTool("browser_identity_delete")?.permission).toBe("browser.identity.delete");
    expect(getTool("nope")).toBeUndefined();
    // Every declared permission is used by some tool, and every tool uses a declared one.
    expect(new Set(TOOLS.map((t) => t.permission))).toEqual(new Set(PERMISSIONS));
  });

  it("declares argument schemas that agree with section 8.3", () => {
    const exec = getTool("computer_exec")!;
    expect(Object.keys(exec.parameters.properties)).toEqual(["command", "cwd", "timeout_seconds"]);
    expect(exec.parameters.required).toEqual(["command"]);
    expect(getTool("browser_click_at")!.parameters.required).toEqual(["identity_id", "x", "y"]);
    expect(getTool("browser_scroll")!.parameters.properties.direction?.enum).toEqual(["up", "down"]);
    expect(getTool("browser_identity_create")!.parameters.required).toEqual(["name"]);
    for (const tool of TOOLS) {
      expect(tool.parameters.additionalProperties).toBe(false);
      for (const key of tool.parameters.required) expect(tool.parameters.properties).toHaveProperty(key);
      if (tool.name.startsWith("browser_") && tool.name !== "browser_identity_list" && tool.name !== "browser_identity_create") {
        expect(tool.parameters.required).toContain("identity_id");
      }
    }
  });

  it("marks the tools whose result is an image", () => {
    expect(TOOLS.filter((t) => t.returnsImage).map((t) => t.name)).toEqual(["computer_screenshot", "browser_screenshot"]);
  });
});

describe("offeredTools", () => {
  const base = { name: "a", goal: "g", model: { provider: "openrouter", id: "m/x" } };

  it("offers everything when the Dot manages its identities", () => {
    expect(offeredTools(parseDotConfig(base))).toHaveLength(24);
  });

  it("leaves out create and delete when it does not", () => {
    const names = offeredTools(parseDotConfig({ ...base, browser: { identities: { managed_by_dot: false } } })).map(
      (t) => t.name,
    );
    expect(names).toHaveLength(22);
    expect(names).not.toContain("browser_identity_create");
    expect(names).not.toContain("browser_identity_delete");
    expect(names).toContain("browser_identity_launch");
  });

  it("declares which tools may run again after a crash (section 8.7)", () => {
    const replaySafe = TOOLS.filter((t) => t.replaySafe).map((t) => t.name);
    expect(replaySafe.sort()).toEqual(
      [
        "computer_screenshot",
        "files_read",
        "files_list",
        "files_write",
        "memory_remember",
        "memory_search",
        "browser_identity_list",
        "browser_identity_launch",
        "browser_identity_close",
        "browser_snapshot",
        "browser_read_text",
        "browser_screenshot",
      ].sort(),
    );
    // A navigation can consume a one-time link, and the rest act on the world.
    for (const name of ["computer_exec", "browser_identity_create", "browser_identity_delete", "browser_navigate", "browser_click", "browser_type"]) {
      expect(getTool(name)?.replaySafe, name).toBe(false);
    }
  });
});
