import { describe, expect, it } from "vitest";
import { describeEvent, mergeEvents, truncate } from "../src/lib/timeline";
import type { StoredEvent } from "../src/lib/types";

function event(id: number, type: string, data: Record<string, unknown>, source: "host" | "guest" = "guest"): StoredEvent {
  return {
    id,
    dot_id: "dot_1",
    type: type as StoredEvent["type"],
    data,
    source,
    guest_seq: source === "guest" ? id : null,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("describeEvent", () => {
  it("describes a completed task as a success", () => {
    const entry = describeEvent(event(1, "task.completed", { task_id: "task_a", summary: "Cheapest day is Tuesday." }));
    expect(entry).toMatchObject({ title: "Task completed", detail: "task_a: Cheapest day is Tuesday.", tone: "ok" });
  });

  it("describes a failed task as an error", () => {
    const entry = describeEvent(event(2, "task.failed", { task_id: "task_b", error: "max steps exceeded" }));
    expect(entry).toMatchObject({ title: "Task failed", tone: "error" });
    expect(entry.detail).toContain("max steps exceeded");
  });

  it("describes an approval request with tool, permission and reason", () => {
    const entry = describeEvent(
      event(3, "approval.requested", {
        approval_id: "apr_1",
        tool: "browser_identity_delete",
        permission: "browser.identity.delete",
        arguments: { identity_id: "shop-ab12cd" },
        reason: "cleanup",
      }),
    );
    expect(entry.tone).toBe("warn");
    expect(entry.detail).toBe("browser_identity_delete [browser.identity.delete] - cleanup");
  });

  it("marks denied and failed tool calls as errors and successful ones as neutral", () => {
    const ok = describeEvent(
      event(4, "tool.called", { tool: "computer_exec", permission: "computer.exec", decision: "allow", ok: true, duration_ms: 41.6 }),
    );
    expect(ok).toMatchObject({ title: "Tool computer_exec", detail: "ok in 42 ms [computer.exec]", tone: "neutral" });
    const denied = describeEvent(
      event(5, "tool.called", { tool: "nope", permission: "", decision: "deny", ok: false, duration_ms: 0 }),
    );
    expect(denied).toMatchObject({ detail: "denied in 0 ms", tone: "error" });
  });

  it("names browser identities by name and id", () => {
    const entry = describeEvent(event(6, "browser.identity.created", { identity_id: "shop-ab12cd", name: "shop" }));
    expect(entry).toMatchObject({ title: "Browser identity created", detail: "shop (shop-ab12cd)" });
  });

  it("describes host events and resolutions", () => {
    expect(describeEvent(event(7, "computer.state", { state: "ERROR" }, "host"))).toMatchObject({
      title: "Computer state",
      detail: "ERROR",
      tone: "error",
      source: "host",
    });
    expect(describeEvent(event(8, "approval.resolved", { approval_id: "apr_1", decision: "reject", note: "no" }, "host")))
      .toMatchObject({ title: "Rejected", detail: "apr_1 - no", tone: "warn" });
  });

  it("falls back to the raw data for an unknown type and tolerates missing fields", () => {
    expect(describeEvent(event(9, "something.new", { a: 1 })).detail).toBe('{"a":1}');
    expect(describeEvent(event(10, "task.progress", {})).detail).toBe("");
  });

  it("truncates long details to one line", () => {
    const long = `${"word ".repeat(200)}\nend`;
    const detail = describeEvent(event(11, "message.assistant", { text: long })).detail;
    expect(detail.length).toBeLessThanOrEqual(280);
    expect(detail).not.toContain("\n");
    expect(detail.endsWith("...")).toBe(true);
    expect(truncate("short")).toBe("short");
  });
});

describe("mergeEvents", () => {
  it("orders by id and drops duplicates from a replayed stream", () => {
    const a = event(1, "agent.state", { state: "IDLE" });
    const b = event(2, "agent.state", { state: "THINKING" });
    const c = event(3, "agent.state", { state: "IDLE" });
    expect(mergeEvents([a, c], [b, c]).map((e) => e.id)).toEqual([1, 2, 3]);
  });
});
