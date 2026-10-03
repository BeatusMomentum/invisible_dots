import { describe, expect, it } from "vitest";
import {
  HOST_EVENT_TYPES,
  INBOUND_EVENT_TYPES,
  isHostEventType,
  isInboundEventType,
  isOutboundEventType,
  OUTBOUND_EVENT_TYPES,
  parseInboundEvent,
  parseOutboundEvent,
} from "../src/index.js";

const ts = "2026-10-02T08:15:00.000Z";

describe("event type lists", () => {
  it("match section 5.4", () => {
    expect(INBOUND_EVENT_TYPES).toEqual(["user.message", "task.created", "approval.received", "system.event"]);
    expect(OUTBOUND_EVENT_TYPES).toHaveLength(14);
    expect(OUTBOUND_EVENT_TYPES).toContain("browser.identity.launched");
    expect(OUTBOUND_EVENT_TYPES).toContain("agent.started");
    expect(HOST_EVENT_TYPES).toContain("computer.state");
    expect(isInboundEventType("user.message")).toBe(true);
    expect(isOutboundEventType("user.message")).toBe(false);
    expect(isHostEventType("approval.resolved")).toBe(true);
  });
});

describe("parseInboundEvent", () => {
  it("accepts each inbound type", () => {
    expect(parseInboundEvent({ id: "evt_1", type: "user.message", ts, data: { text: "hi" } }).type).toBe("user.message");
    expect(
      parseInboundEvent({
        id: "evt_2",
        type: "task.created",
        ts,
        data: { task_id: "task_1", description: "check fares", priority: 0 },
      }).data,
    ).toEqual({ task_id: "task_1", description: "check fares", priority: 0 });
    expect(
      parseInboundEvent({
        id: "evt_3",
        type: "approval.received",
        ts,
        data: { approval_id: "apr_1", decision: "reject", note: "not now" },
      }).type,
    ).toBe("approval.received");
    expect(
      parseInboundEvent({ id: "evt_4", type: "system.event", ts: "2026-10-02T10:15:00+02:00", data: { name: "x", data: {} } })
        .type,
    ).toBe("system.event");
  });

  it("rejects unknown types, bad data and bad timestamps", () => {
    expect(() => parseInboundEvent({ id: "e", type: "agent.state", ts, data: {} })).toThrow(/invalid inbound event/);
    expect(() => parseInboundEvent({ id: "e", type: "user.message", ts, data: { text: "" } })).toThrow(/data\.text/);
    expect(() =>
      parseInboundEvent({ id: "e", type: "approval.received", ts, data: { approval_id: "a", decision: "maybe" } }),
    ).toThrow(/data\.decision/);
    expect(() => parseInboundEvent({ id: "e", type: "user.message", ts: "yesterday", data: { text: "x" } })).toThrow(/ts/);
    expect(() => parseInboundEvent(null)).toThrow(/invalid inbound event/);
  });
});

describe("parseOutboundEvent", () => {
  it("accepts a well-formed event and rejects a wrong agent state", () => {
    expect(parseOutboundEvent({ seq: 1, id: "e", type: "agent.state", ts, data: { state: "THINKING" } }).seq).toBe(1);
    expect(() => parseOutboundEvent({ seq: 2, id: "e", type: "agent.state", ts, data: { state: "NAPPING" } })).toThrow(
      /data\.state/,
    );
    expect(() => parseOutboundEvent({ seq: 0, id: "e", type: "memory.written", ts, data: { key: "k" } })).toThrow(/seq/);
  });

  it("checks the permission of an approval request", () => {
    const event = {
      seq: 3,
      id: "e",
      type: "approval.requested",
      ts,
      data: {
        approval_id: "apr_1",
        tool: "browser_identity_delete",
        permission: "browser.identity.delete",
        arguments: { identity_id: "shop-ab12cd" },
        reason: "asked by policy",
      },
    };
    expect(parseOutboundEvent(event).type).toBe("approval.requested");
    expect(() => parseOutboundEvent({ ...event, data: { ...event.data, permission: "root" } })).toThrow(/permission/);
  });

  it("keeps the interrupted mark of a tool call, so the host records that its outcome is unknown", () => {
    const data = { task_id: "t1", tool: "computer_exec", permission: "computer.exec", decision: "allow", ok: false, duration_ms: 0 };
    const parsed = parseOutboundEvent({ seq: 4, id: "e", type: "tool.called", ts, data: { ...data, interrupted: true } });
    expect(parsed.data).toEqual({ ...data, interrupted: true });
    expect(parseOutboundEvent({ seq: 5, id: "e", type: "tool.called", ts, data }).data).toEqual(data);
    expect(() => parseOutboundEvent({ seq: 6, id: "e", type: "tool.called", ts, data: { ...data, interrupted: false } })).toThrow(/interrupted/);
  });
});
