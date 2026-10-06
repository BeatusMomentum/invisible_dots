import { describe, expect, it } from "vitest";
import {
  CHANNEL_KINDS,
  CHANNEL_STATUSES,
  HOST_EVENT_TYPES,
  INBOUND_EVENT_TYPES,
  isHostEventType,
  isInboundEventType,
  isOutboundEventType,
  isStoredEventType,
  OUTBOUND_EVENT_TYPES,
  parseInboundEvent,
  parseMessageOrigin,
  parseOutboundEvent,
  STORED_EVENT_TYPES,
  TOOL_TARGET_MAX,
  USAGE_EVENT_TYPES,
} from "../src/index.js";

const ts = "2026-10-02T08:15:00.000Z";

describe("event type lists", () => {
  it("name every type of the stored log once: the guest's, the host's and the person's message", () => {
    expect(new Set(STORED_EVENT_TYPES).size).toBe(STORED_EVENT_TYPES.length);
    expect(STORED_EVENT_TYPES).toHaveLength(OUTBOUND_EVENT_TYPES.length + HOST_EVENT_TYPES.length + 1);
    for (const type of ["tool.called", "task.progress", "memory.written", "approval.resolved", "channel.status", "user.message"]) {
      expect(isStoredEventType(type), type).toBe(true);
    }
    for (const type of ["tool.calls", "", "approval.received", "system.event", 7, undefined]) expect(isStoredEventType(type), String(type)).toBe(false);
  });

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

  it("lists the channel host events and what they carry", () => {
    expect(HOST_EVENT_TYPES.slice(-2)).toEqual(["channel.status", "channel.peer.paired"]);
    expect(isHostEventType("channel.status")).toBe(true);
    expect(isHostEventType("channel.peer.paired")).toBe(true);
    // A channel event is the host's own: the guest can never report one.
    expect(isOutboundEventType("channel.status")).toBe(false);
    expect(isInboundEventType("channel.peer.paired")).toBe(false);
    expect(CHANNEL_KINDS).toEqual(["telegram", "whatsapp"]);
    expect(CHANNEL_STATUSES).toEqual(["connecting", "connected", "needs_relink", "error"]);
  });
});

describe("parseMessageOrigin", () => {
  const origin = { channel: "telegram", binding_id: "chb_1", chat_id: "4242", external_id: "77" };

  it("returns the origin of a channel message as it is", () => {
    expect(parseMessageOrigin(origin)).toEqual(origin);
    expect(parseMessageOrigin({ ...origin, channel: "whatsapp" })).toEqual({ ...origin, channel: "whatsapp" });
  });

  it("is null for no origin and for anything that is not exactly one", () => {
    expect(parseMessageOrigin(undefined)).toBeNull();
    expect(parseMessageOrigin(null)).toBeNull();
    expect(parseMessageOrigin("telegram")).toBeNull();
    expect(parseMessageOrigin({ ...origin, channel: "sms" })).toBeNull();
    expect(parseMessageOrigin({ ...origin, chat_id: 4242 })).toBeNull();
    expect(parseMessageOrigin({ ...origin, external_id: "" })).toBeNull();
    expect(parseMessageOrigin({ ...origin, chat_id: "9".repeat(257) })).toBeNull();
    expect(parseMessageOrigin({ ...origin, extra: "x" })).toBeNull();
    const { binding_id: _binding, ...partial } = origin;
    expect(parseMessageOrigin(partial)).toBeNull();
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

describe("spent_usd (section 5.4)", () => {
  const events = [
    { type: "message.assistant", data: { text: "hi", in_reply_to: "m1" } },
    { type: "task.progress", data: { task_id: "task_1", text: "looking" } },
    { type: "task.completed", data: { task_id: "task_1", summary: "done" } },
    { type: "task.failed", data: { task_id: "task_1", error: "stopped" } },
  ] as const;

  it.each(events)("$type keeps the spend the engine reports, and is valid without it", ({ type, data }) => {
    expect(parseOutboundEvent({ seq: 1, id: "e", type, ts, data: { ...data, spent_usd: 0.0123 } }).data).toEqual({
      ...data,
      spent_usd: 0.0123,
    });
    expect(parseOutboundEvent({ seq: 1, id: "e", type, ts, data: { ...data, spent_usd: 0 } }).data).toEqual({ ...data, spent_usd: 0 });
    expect(parseOutboundEvent({ seq: 1, id: "e", type, ts, data }).data).toEqual(data);
  });

  it.each(events)("$type refuses a spend that is not an amount of USD", ({ type, data }) => {
    for (const spent_usd of [-0.5, "0.5", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseOutboundEvent({ seq: 1, id: "e", type, ts, data: { ...data, spent_usd } })).toThrow(/spent_usd/);
    }
  });

  it("is summed over the events that end a unit of spend, never over the running value of a task", () => {
    expect([...USAGE_EVENT_TYPES]).toEqual(["task.completed", "task.failed", "message.assistant"]);
    expect(USAGE_EVENT_TYPES.every((type) => isOutboundEventType(type))).toBe(true);
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

  it("keeps the one-line target of a tool call and refuses one that is empty, long or on several lines", () => {
    const data = { task_id: "t1", tool: "exec", permission: "computer.exec", decision: "allow", ok: true, duration_ms: 12 };
    const parse = (target: unknown) => parseOutboundEvent({ seq: 7, id: "e", type: "tool.called", ts, data: { ...data, target } });
    expect(parse("ls -la /home/dot").data).toEqual({ ...data, target: "ls -la /home/dot" });
    expect(parse("x".repeat(TOOL_TARGET_MAX)).data).toMatchObject({ target: "x".repeat(TOOL_TARGET_MAX) });
    expect(parseOutboundEvent({ seq: 8, id: "e", type: "tool.called", ts, data }).data).toEqual(data);
    expect(() => parse("x".repeat(TOOL_TARGET_MAX + 1))).toThrow(/target/);
    // The limit is in code points, as the engine cuts (zod 4 does not count UTF-16 units): a path of 200
    // emoji is cut to 159 and an ellipsis (invisible_engine_dots/tests/dots/test_targets.py), 160 in all.
    const emoji = String.fromCodePoint(0x1f600);
    const ellipsis = String.fromCodePoint(0x2026);
    expect(parse(emoji.repeat(TOOL_TARGET_MAX - 1) + ellipsis).data).toMatchObject({
      target: emoji.repeat(TOOL_TARGET_MAX - 1) + ellipsis,
    });
    expect(() => parse(emoji.repeat(TOOL_TARGET_MAX + 1))).toThrow(/target/);
    expect(() => parse("")).toThrow(/target/);
    expect(() => parse("one\ntwo")).toThrow(/target/);
    expect(() => parse("one\rtwo")).toThrow(/target/);
    expect(() => parse(5)).toThrow(/target/);
    expect(() => parse(null)).toThrow(/target/);
  });
});
