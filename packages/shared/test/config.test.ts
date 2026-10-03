import { describe, expect, it } from "vitest";
import {
  computerResources,
  DotConfigError,
  parseDotConfig,
  parseDuration,
  parseRuntimeConfig,
  parseSize,
  parseSizeMiB,
  PERMISSIONS,
  resolvePermission,
  safeParseDotConfig,
  toRuntimeConfig,
} from "../src/index.js";

const FULL_YAML = `
name: fare-watch
goal: >
  Check one-way fares from Milan to Lisbon every morning and report the cheapest day.
instructions: >
  Write findings to ~/workspace/fares.csv.
model:
  provider: openrouter
  id: z-ai/glm-5.3-flash
models:
  fast: openai/gpt-5-mini
computer:
  cpu: 2
  memory: 4gb
  disk: 40gb
  idle_timeout: 15m
browser:
  identities:
    managed_by_dot: true
    max_identities: 20
    max_open: 3
permissions:
  computer.exec: allow
  browser.identity.delete: ask
memory:
  enabled: true
limits:
  max_steps_per_task: 60
  context_tokens: 32000
`;

const MINIMAL = { name: "a", goal: "do it", model: { provider: "openrouter", id: "openrouter/auto" } };

function issuesOf(input: unknown): string[] {
  const result = safeParseDotConfig(input);
  if (result.ok) throw new Error("expected the config to be rejected");
  return result.error.issues.map((i) => `${i.path}: ${i.message}`);
}

describe("parseSize", () => {
  it("parses binary units", () => {
    expect(parseSize("4gb")).toBe(4 * 1024 ** 3);
    expect(parseSize("512MB")).toBe(512 * 1024 ** 2);
    expect(parseSize("1.5 GiB")).toBe(1.5 * 1024 ** 3);
    expect(parseSize("1tb")).toBe(1024 ** 4);
    expect(parseSize("100b")).toBe(100);
    expect(parseSizeMiB("4gb")).toBe(4096);
  });

  it("refuses bare numbers and unknown units", () => {
    expect(() => parseSize("4096")).toThrow(/followed by a unit/);
    expect(() => parseSize("4 parsecs")).toThrow(/unknown unit/);
    expect(() => parseSize("")).toThrow();
  });
});

describe("parseDuration", () => {
  it("parses single and compound durations", () => {
    expect(parseDuration("15m")).toBe(15 * 60_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("250ms")).toBe(250);
  });

  it("reads zero as never", () => {
    expect(parseDuration("0")).toBeNull();
    expect(parseDuration(0)).toBeNull();
    expect(parseDuration("0s")).toBeNull();
  });

  it("refuses garbage", () => {
    expect(() => parseDuration("15")).toThrow(/invalid duration/);
    expect(() => parseDuration(15)).toThrow(/needs a unit/);
    expect(() => parseDuration("15 minutes")).toThrow(/invalid duration/);
    expect(() => parseDuration("")).toThrow();
  });
});

describe("parseDotConfig", () => {
  it("parses the example of section 7", () => {
    const config = parseDotConfig(FULL_YAML);
    expect(config.name).toBe("fare-watch");
    expect(config.model).toEqual({ provider: "openrouter", id: "z-ai/glm-5.3-flash" });
    expect(config.models).toEqual({ fast: "openai/gpt-5-mini" });
    expect(config.computer).toEqual({ cpu: 2, memory: "4gb", disk: "40gb", idle_timeout: "15m" });
    expect(config.permissions).toEqual({ "computer.exec": "allow", "browser.identity.delete": "ask" });
    expect(config.instructions).toContain("fares.csv");
  });

  it("applies every default to a minimal config", () => {
    const config = parseDotConfig(MINIMAL);
    expect(config).toEqual({
      name: "a",
      goal: "do it",
      model: { provider: "openrouter", id: "openrouter/auto" },
      models: {},
      computer: { cpu: 2, memory: "4gb", disk: "40gb", idle_timeout: "15m" },
      browser: { identities: { managed_by_dot: true, max_identities: 20, max_open: 3 } },
      permissions: {},
      memory: { enabled: true },
      limits: { max_steps_per_task: 60, context_tokens: 32_000 },
    });
  });

  it("fills defaults inside a partially given section", () => {
    const config = parseDotConfig({ ...MINIMAL, computer: { cpu: 4 }, browser: { identities: { max_open: 1 } } });
    expect(config.computer).toEqual({ cpu: 4, memory: "4gb", disk: "40gb", idle_timeout: "15m" });
    expect(config.browser.identities).toEqual({ managed_by_dot: true, max_identities: 20, max_open: 1 });
  });

  it("is idempotent, so a stored config can be parsed again", () => {
    const once = parseDotConfig(FULL_YAML);
    expect(parseDotConfig(once)).toEqual(once);
    expect(parseDotConfig(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it("accepts idle_timeout 0 written as a YAML number and keeps it a string", () => {
    const config = parseDotConfig(FULL_YAML.replace("idle_timeout: 15m", "idle_timeout: 0"));
    expect(config.computer.idle_timeout).toBe("0");
    expect(computerResources(config).idleTimeoutMs).toBeNull();
  });

  it("validates the name", () => {
    expect(issuesOf({ ...MINIMAL, name: "Fare Watch" })[0]).toMatch(/^name: /);
    expect(issuesOf({ ...MINIMAL, name: "" })[0]).toMatch(/^name: /);
    expect(issuesOf({ ...MINIMAL, name: "a".repeat(41) })[0]).toMatch(/^name: /);
    expect(parseDotConfig({ ...MINIMAL, name: "a".repeat(40) }).name).toHaveLength(40);
    expect(parseDotConfig({ ...MINIMAL, name: "dot-2" }).name).toBe("dot-2");
  });

  it("accepts only the openrouter provider", () => {
    const issues = issuesOf({ ...MINIMAL, model: { provider: "openai", id: "gpt-5" } });
    expect(issues).toEqual(['model.provider: model.provider must be "openrouter"']);
  });

  it("requires goal and model", () => {
    const issues = issuesOf({ name: "a" });
    expect(issues.some((i) => i.startsWith("goal:"))).toBe(true);
    expect(issues.some((i) => i.startsWith("model:"))).toBe(true);
  });

  it("enforces the resource ranges", () => {
    expect(issuesOf({ ...MINIMAL, computer: { cpu: 0 } })[0]).toMatch(/^computer\.cpu:/);
    expect(issuesOf({ ...MINIMAL, computer: { cpu: 17 } })[0]).toMatch(/^computer\.cpu:/);
    expect(issuesOf({ ...MINIMAL, computer: { cpu: 1.5 } })[0]).toMatch(/integer/);
    expect(issuesOf({ ...MINIMAL, computer: { memory: "1gb" } })[0]).toMatch(/between 2gb and 64gb/);
    expect(issuesOf({ ...MINIMAL, computer: { memory: "65gb" } })[0]).toMatch(/between 2gb and 64gb/);
    expect(issuesOf({ ...MINIMAL, computer: { disk: "10gb" } })[0]).toMatch(/between 20gb and 1024gb/);
    expect(issuesOf({ ...MINIMAL, computer: { disk: "2tb" } })[0]).toMatch(/between 20gb and 1024gb/);
    expect(issuesOf({ ...MINIMAL, computer: { memory: "4096" } })[0]).toMatch(/followed by a unit/);
    expect(issuesOf({ ...MINIMAL, computer: { idle_timeout: "soon" } })[0]).toMatch(/invalid duration/);
    expect(parseDotConfig({ ...MINIMAL, computer: { memory: "2048mb", disk: "1tb" } }).computer.disk).toBe("1tb");
  });

  it("refuses max_open above max_identities", () => {
    const issues = issuesOf({ ...MINIMAL, browser: { identities: { max_identities: 2, max_open: 3 } } });
    expect(issues).toEqual(["browser.identities.max_open: max_open (3) cannot exceed max_identities (2)"]);
  });

  it("refuses unknown keys and unknown permissions", () => {
    expect(issuesOf({ ...MINIMAL, extra: 1 })[0]).toMatch(/extra/);
    expect(issuesOf({ ...MINIMAL, computer: { gpu: 1 } })[0]).toMatch(/gpu/);
    expect(issuesOf({ ...MINIMAL, permissions: { "computer.exe": "deny" } })).toEqual([
      'permissions.computer.exe: unknown permission "computer.exe"',
    ]);
    expect(issuesOf({ ...MINIMAL, permissions: { "computer.exec": "maybe" } })[0]).toMatch(/^permissions\.computer\.exec:/);
  });

  it("reports invalid YAML as a config error", () => {
    expect(() => parseDotConfig("name: [unclosed")).toThrow(DotConfigError);
    expect(() => parseDotConfig("name: [unclosed")).toThrow(/not valid YAML/);
  });

  it("lists every issue in the error message", () => {
    try {
      parseDotConfig({ name: "BAD", goal: "", model: { provider: "x", id: "y" } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DotConfigError);
      expect((error as Error).message).toMatch(/name: .*goal: .*model\.provider: /);
    }
  });
});

describe("computerResources", () => {
  it("turns the strings into numbers", () => {
    expect(computerResources(parseDotConfig(FULL_YAML))).toEqual({
      cpus: 2,
      memoryBytes: 4 * 1024 ** 3,
      memoryMiB: 4096,
      diskBytes: 40 * 1024 ** 3,
      idleTimeoutMs: 900_000,
    });
  });
});

describe("toRuntimeConfig / parseRuntimeConfig", () => {
  it("drops the computer section and nothing else", () => {
    const config = parseDotConfig(FULL_YAML);
    const runtime = toRuntimeConfig(config);
    expect(runtime).not.toHaveProperty("computer");
    expect({ ...runtime, computer: config.computer }).toEqual(config);
  });

  it("round-trips through the guest validator", () => {
    const runtime = toRuntimeConfig(parseDotConfig(FULL_YAML));
    expect(parseRuntimeConfig(JSON.parse(JSON.stringify(runtime)))).toEqual(runtime);
  });

  it("refuses a runtime config that carries a computer section", () => {
    expect(() => parseRuntimeConfig(parseDotConfig(FULL_YAML))).toThrow(/no computer section/);
    expect(() => parseRuntimeConfig([])).toThrow(/must be an object/);
  });
});

describe("resolvePermission", () => {
  const defaults = parseDotConfig(MINIMAL);

  it("allows every known permission by default except identity deletion", () => {
    for (const permission of PERMISSIONS) {
      expect(resolvePermission(defaults, permission)).toBe(permission === "browser.identity.delete" ? "ask" : "allow");
    }
  });

  it("lets the config override a default", () => {
    const config = parseDotConfig({
      ...MINIMAL,
      permissions: { "computer.exec": "deny", "browser.identity.delete": "allow", "files.write": "ask" },
    });
    expect(resolvePermission(config, "computer.exec")).toBe("deny");
    expect(resolvePermission(config, "browser.identity.delete")).toBe("allow");
    expect(resolvePermission(config, "files.write")).toBe("ask");
    expect(resolvePermission(config, "files.read")).toBe("allow");
  });

  it("denies a permission the registry does not know, whatever the config says", () => {
    expect(resolvePermission(defaults, "computer.reboot")).toBe("deny");
    expect(resolvePermission(defaults, "network.raw")).toBe("deny");
    expect(resolvePermission({ permissions: { "computer.reboot": "allow" } } as never, "computer.reboot")).toBe("deny");
  });
});
