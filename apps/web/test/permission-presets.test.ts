import { PERMISSIONS, parseDotConfig, resolvePermission, toRuntimeConfig } from "@invisible-dots/shared";
import { describe, expect, it } from "vitest";
import { PRESET_IDS, PRESETS, presetOf, presetPermissions } from "../src/lib/permission-presets";

const BASE = { name: "p", goal: "g", model: { provider: "openrouter", id: "a/b" } };

function resolved(preset: (typeof PRESET_IDS)[number]) {
  return toRuntimeConfig(parseDotConfig({ ...BASE, permissions: presetPermissions(preset) })).permissions;
}

describe("the permission presets", () => {
  it("are accepted by the schema, which refuses a permission it does not know", () => {
    for (const id of PRESET_IDS) expect(() => parseDotConfig({ ...BASE, permissions: presetPermissions(id) })).not.toThrow();
  });

  it("Balanced is the shipped defaults and writes nothing", () => {
    expect(presetPermissions("balanced")).toEqual({});
    const defaults = parseDotConfig(BASE);
    for (const permission of PERMISSIONS) expect(resolved("balanced")[permission]).toBe(resolvePermission(defaults, permission));
  });

  it("Careful asks before commands and file changes and leaves every other permission at its default", () => {
    const careful = resolved("careful");
    const defaults = resolved("balanced");
    expect(careful["computer.exec"]).toBe("ask");
    expect(careful["files.write"]).toBe("ask");
    for (const permission of PERMISSIONS) {
      if (permission !== "computer.exec" && permission !== "files.write") expect(careful[permission]).toBe(defaults[permission]);
    }
  });

  it("Autonomous allows everything except deleting a browser identity, which still asks", () => {
    const autonomous = resolved("autonomous");
    for (const permission of PERMISSIONS) {
      expect(autonomous[permission]).toBe(permission === "browser.identity.delete" ? "ask" : "allow");
    }
  });

  it("hand out copies, so editing one never changes the preset", () => {
    const copy = presetPermissions("careful");
    copy["files.write"] = "deny";
    expect(PRESETS.careful.permissions["files.write"]).toBe("ask");
  });
});

describe("presetOf", () => {
  it("names the preset a permission map amounts to", () => {
    for (const id of PRESET_IDS) expect(presetOf(presetPermissions(id))).toBe(id);
  });

  it("counts an explicit value equal to the default as the default", () => {
    expect(presetOf({ "computer.exec": "allow", "browser.identity.delete": "ask" })).toBe("balanced");
  });

  it("is null for permissions that match no preset", () => {
    expect(presetOf({ "computer.exec": "deny" })).toBeNull();
    // Half of Careful is not Careful.
    expect(presetOf({ "files.write": "ask" })).toBeNull();
  });
});
