/**
 * The engine's answers to `GET /automations` and `GET /tools` and the data of its automation events, against the host's
 * description of them. The engine's own
 * test (`invisible_engine_dots/tests/dots/test_wire_shapes.py`) writes what it really answers into `wire_shapes.json`;
 * here that file is parsed with the schemas of `packages/shared` and the host's fake guest is held to the same
 * answers, so neither side can move a key, or a rule of what the model is offered, without a suite failing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  automationSchema,
  MAX_RUN_AT_MS,
  parseDotConfig,
  parseOutboundEvent,
  PERMISSIONS,
  toolInfoSchema,
  toRuntimeConfig,
  type DotRuntimeConfig,
} from "@invisible-dots/shared";
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
) as { automations: unknown[]; limits: { max_run_at_ms: number }; outbound_event_data: { type: string; data: unknown }[]; tool_offering: OfferingCase[] };

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

  it("the last time the engine lets an automation run is the last time the host's schemas accept", () => {
    expect(shapes.limits.max_run_at_ms).toBe(MAX_RUN_AT_MS);
    const first = shapes.automations[0] as Record<string, unknown>;
    expect(automationSchema.safeParse({ ...first, next_run_at_ms: MAX_RUN_AT_MS }).success).toBe(true);
    expect(automationSchema.safeParse({ ...first, next_run_at_ms: MAX_RUN_AT_MS + 1 }).success).toBe(false);
    expect(new Date(MAX_RUN_AT_MS).toISOString()).toBe("9999-12-31T23:59:59.999Z");
  });

  it("every automation event the engine writes parses as the outbound event it is, with the time or null, and the host's fake guest says the same", async () => {
    expect(shapes.outbound_event_data.map((event) => event.type)).toEqual(["automation.next_run", "automation.next_run"]);
    for (const [index, { type, data }] of shapes.outbound_event_data.entries()) {
      const event = { seq: index + 1, id: `evt_${index}`, type, ts: "2026-10-06T09:00:00.000Z", data };
      expect(parseOutboundEvent(event).data, JSON.stringify(event)).toEqual(data);
    }
    expect(shapes.outbound_event_data.map((event) => (event.data as { next_run_at_ms: number | null }).next_run_at_ms)).toEqual([1_790_000_000_000, null]);

    const guest = new FakeGuest("token-for-shapes");
    guest.running = true;
    const row = automationSchema.parse(shapes.automations[0]);
    guest.putAutomation({ ...row, next_run_at_ms: 1_790_000_000_000 });
    expect(guest.outbox.map((event) => ({ type: event.type, data: event.data }))).toEqual([shapes.outbound_event_data[0]]);
    await guest.deleteAutomation(row.id);
    expect(guest.outbox.map((event) => ({ type: event.type, data: event.data }))).toEqual(shapes.outbound_event_data);
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
