import { describe, expect, it } from "vitest";
import { getTool, offeredTools, parseRuntimeConfig } from "@invisible-dots/shared";
import { PolicyEngine } from "../src/index.js";

const base = { name: "p", goal: "g", model: { provider: "openrouter", id: "m/x" } };

describe("PolicyEngine", () => {
  it("applies the defaults of section 7", () => {
    const policy = new PolicyEngine(parseRuntimeConfig(base));
    expect(policy.decide("computer.exec")).toBe("allow");
    expect(policy.decide("files.write")).toBe("allow");
    expect(policy.decide("memory.read")).toBe("allow");
    expect(policy.decide("browser.act")).toBe("allow");
    expect(policy.decide("browser.identity.delete")).toBe("ask");
    expect(policy.decide("network.raw")).toBe("deny");
  });

  it("lets explicit entries win and follows updates", () => {
    const policy = new PolicyEngine(
      parseRuntimeConfig({ ...base, permissions: { "computer.exec": "ask", "browser.identity.delete": "allow" } }),
    );
    expect(policy.decide("computer.exec")).toBe("ask");
    expect(policy.decide("browser.identity.delete")).toBe("allow");
    policy.update(parseRuntimeConfig({ ...base, permissions: { "computer.exec": "deny" } }));
    expect(policy.decide("computer.exec")).toBe("deny");
  });

  it("decides tools by their declared permission and denies unknown or unoffered names", () => {
    const config = parseRuntimeConfig({
      ...base,
      browser: { identities: { managed_by_dot: false } },
      permissions: { "files.write": "deny" },
    });
    const policy = new PolicyEngine(config);
    const offered = offeredTools(config);
    expect(policy.decideTool("files_read", offered)).toMatchObject({ decision: "allow", permission: "files.read" });
    expect(policy.decideTool("files_write", offered)).toMatchObject({
      decision: "deny",
      reason: "files.write is denied by the Dot's configuration",
    });
    expect(policy.decideTool("rm_rf", offered)).toEqual({
      decision: "deny",
      permission: "",
      reason: 'the tool "rm_rf" does not exist',
    });
    expect(getTool("browser_identity_delete")).toBeDefined();
    expect(policy.decideTool("browser_identity_delete", offered).decision).toBe("deny");
  });
});
