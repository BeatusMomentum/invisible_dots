/**
 * The engine's answers to `GET /automations` and `GET /tools`, against the host's description of them. The engine's own
 * test (`invisible_engine_dots/tests/dots/test_wire_shapes.py`) writes what it really answers into `wire_shapes.json`;
 * here that file is parsed with the schemas of `packages/shared` and the host's fake guest is held to the same
 * answers, so neither side can move a key, or a rule of what the model is offered, without a suite failing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { automationSchema, parseDotConfig, PERMISSIONS, toolInfoSchema, toRuntimeConfig, type DotRuntimeConfig } from "@invisible-dots/shared";
import { describe, expect, it } from "vitest";
import { FakeGuest } from "../src/testing.js";

interface OfferingCase {
  permissions: Record<string, string>;
  memory_enabled: boolean;
  managed_identities: boolean;
  offered: string[];
  tools: unknown[];
}

const shapes = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../invisible_engine_dots/tests/dots/wire_shapes.json", import.meta.url)), "utf8"),
) as { automations: unknown[]; tool_offering: OfferingCase[] };

const baseConfig = toRuntimeConfig(parseDotConfig("name: shapes\ngoal: check\nmodel:\n  provider: openrouter\n  id: test/model\n"));

function configFor(offering: OfferingCase): DotRuntimeConfig {
  return {
    ...baseConfig,
    permissions: offering.permissions as DotRuntimeConfig["permissions"],
    memory: { enabled: offering.memory_enabled },
    browser: { identities: { ...baseConfig.browser.identities, managed_by_dot: offering.managed_identities } },
  };
}

describe("what the engine answers, as the host describes it", () => {
  it("every automation the engine shows parses with the automation schema, and a schema key the engine lacks or has extra is refused", () => {
    expect(shapes.automations.length).toBeGreaterThanOrEqual(3);
    for (const row of shapes.automations) expect(automationSchema.safeParse(row).error?.issues, JSON.stringify(row)).toBeUndefined();

    const first = shapes.automations[0] as Record<string, unknown>;
    const { id: _id, ...missing } = first;
    expect(automationSchema.safeParse(missing).success).toBe(false);
    expect(automationSchema.safeParse({ ...first, renamed_key: 1 }).success).toBe(false);
    expect(automationSchema.safeParse({ ...first, schedule: { kind: "every", every_ms: 1, extra: true } }).success).toBe(false);
  });

  it("every tool row the engine shows parses with the tool schema, in the order of its table, under a permission the host knows", () => {
    for (const offering of shapes.tool_offering) {
      for (const row of offering.tools) expect(toolInfoSchema.safeParse(row).error?.issues, JSON.stringify(row)).toBeUndefined();
      const names = (offering.tools as { name: string }[]).map((row) => row.name);
      expect(names).toEqual((shapes.tool_offering[0]!.tools as { name: string }[]).map((row) => row.name));
      expect((offering.tools as { permission: string }[]).every((row) => PERMISSIONS.includes(row.permission as never))).toBe(true);
    }
  });

  it("the fake guest holds the engine's tools to the same permissions, and offers what the engine offers for the same config", async () => {
    const engineRows = new Map((shapes.tool_offering[0]!.tools as { name: string; permission: string }[]).map((row) => [row.name, row.permission]));
    for (const offering of shapes.tool_offering) {
      const guest = new FakeGuest("token-for-shapes");
      guest.running = true;
      guest.config = configFor(offering);
      const { tools } = await guest.listTools();
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(engineRows.get(tool.name), `the engine has no tool ${tool.name}`).toBe(tool.permission);
        expect(tool.offered, `${tool.name} with ${JSON.stringify(offering.permissions)}, memory ${offering.memory_enabled}, managed identities ${offering.managed_identities}`).toBe(offering.offered.includes(tool.name));
      }
    }
    // The memory switch is among what is compared: some case has a memory tool allowed and not offered.
    expect(shapes.tool_offering.some((o) => !o.memory_enabled && o.permissions["memory.read"] === "allow" && !o.offered.includes("memory_get"))).toBe(true);
    // So is the identity switch: some case grants the tool that creates an identity and is not offered it.
    expect(shapes.tool_offering.some((o) => !o.managed_identities && o.permissions["browser.identity.create"] === "allow" && !o.offered.includes("browser_identity_create"))).toBe(true);
  });

  it("the fake guest lists automations in the engine's shape", async () => {
    const guest = new FakeGuest("token-for-shapes");
    guest.running = true;
    for (const row of shapes.automations) guest.putAutomation(automationSchema.parse(row));
    const { automations } = await guest.listAutomations();
    expect(automations).toEqual(shapes.automations);
  });
});
