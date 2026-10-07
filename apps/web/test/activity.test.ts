import type { StoredEvent } from "@invisible-dots/shared/browser";
import { describe, expect, it } from "vitest";
import { exportName, matchesSearch, toJsonl, typesFor } from "../src/lib/activity";
import { typesOf, viewEvent } from "../src/lib/events/view";

function event(id: number, type: string, data: Record<string, unknown> = {}): StoredEvent {
  return { id, dot_id: "d1", type, data, source: "guest", guest_seq: id, created_at: "2026-03-10T12:00:00.000Z" } as StoredEvent;
}

describe("typesFor", () => {
  it("asks for every type of the families chosen, and for no type at all when none is chosen", () => {
    expect(typesFor([])).toBeUndefined();
    expect(typesFor(["tools", "browser"])).toEqual(["tool.called", ...typesOf("browser")]);
    expect(typesFor(["tasks"])).toEqual(["task.created", "task.started", "task.progress", "task.completed", "task.failed", "task.cancelled"]);
  });
});

describe("matchesSearch", () => {
  const tool = viewEvent(event(1, "tool.called", { tool: "exec", target: "ls -la /home/dot", permission: "computer.exec", decision: "allow", ok: true, duration_ms: 5 }));
  const reply = viewEvent(event(2, "message.assistant", { text: "The cheapest day is Tuesday." }));

  it("matches the words of the line the row shows, in its title, its detail and its type, whatever the case", () => {
    expect(matchesSearch(tool, "")).toBe(true);
    expect(matchesSearch(tool, "   ")).toBe(true);
    expect(matchesSearch(tool, "LS -LA")).toBe(true);
    expect(matchesSearch(tool, "ran a command")).toBe(true);
    expect(matchesSearch(tool, "tool.called")).toBe(true);
    expect(matchesSearch(reply, "cheapest tuesday")).toBe(true);
  });

  it("needs every word, and does not match what the row does not say", () => {
    expect(matchesSearch(reply, "cheapest friday")).toBe(false);
    expect(matchesSearch(tool, "tuesday")).toBe(false);
    // Data that is not in the line is not searched: the search is over what is on screen.
    expect(matchesSearch(viewEvent(event(3, "message.assistant", { text: "a.md", secret: "hunter2" })), "hunter2")).toBe(false);
  });

  it("matches the channel a message came through", () => {
    const via = viewEvent(event(4, "user.message", { message_id: "m", text: "hi", origin: { channel: "telegram", binding_id: "b", chat_id: "1", external_id: "2" } }));
    expect(matchesSearch(via, "telegram")).toBe(true);
  });
});

describe("the export", () => {
  it("writes one JSON object per line, oldest first, each as the control plane stored it", () => {
    const events = [event(7, "agent.state", { state: "IDLE" }), event(5, "message.assistant", { text: "a.md" })];
    const text = toJsonl(events);
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([events[1], events[0]]);
    // The list given is left as it was.
    expect(events.map((e) => e.id)).toEqual([7, 5]);
  });

  it("writes nothing for no events, and keeps a line break out of a line whatever the data holds", () => {
    expect(toJsonl([])).toBe("");
    const lines = toJsonl([event(1, "message.assistant", { text: "a\nb c" })]).trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).data.text).toBe("a\nb c");
  });

  it("names the file after the Dot and the range of events it holds", () => {
    expect(exportName("dot_1", [event(7, "agent.state"), event(5, "agent.state"), event(9, "agent.state")])).toBe("dot_1-events-5-9.jsonl");
    expect(exportName("dot_1", [])).toBe("dot_1-events.jsonl");
  });
});
