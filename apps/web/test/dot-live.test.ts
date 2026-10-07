import type { StoredEvent } from "@invisible-dots/shared/browser";
import { describe, expect, it } from "vitest";
import { applyLiveEvent, dismissRestart, dotIdFromPath, liveOf, markRead, type LiveDots } from "../src/lib/dot-live";

let n = 0;
const event = (dotId: string, type: string, data: Record<string, unknown> = {}): StoredEvent =>
  ({ id: ++n, dot_id: dotId, type, data, source: "guest", guest_seq: n, created_at: "2026-01-01T00:00:00Z" }) as StoredEvent;

function fold(events: StoredEvent[], open: string | null = null, from: LiveDots = {}): LiveDots {
  return events.reduce((live, e) => applyLiveEvent(live, e, open), from);
}

describe("what the live stream says about a Dot", () => {
  it("remembers the newest agent state, per Dot", () => {
    const live = fold([event("a", "agent.state", { state: "THINKING" }), event("b", "agent.state", { state: "IDLE" }), event("a", "agent.state", { state: "EXECUTING" })]);
    expect(liveOf(live, "a").agent).toBe("EXECUTING");
    expect(liveOf(live, "b").agent).toBe("IDLE");
    expect(liveOf(live, "c").agent).toBeNull();
  });

  it("flags a restart that interrupted work, until the agent works again or the person dismisses it", () => {
    let live = fold([event("a", "agent.state", { state: "EXECUTING" }), event("a", "agent.started")]);
    expect(liveOf(live, "a")).toMatchObject({ agent: null, restarted: true });
    // The agent says idle on its way up: the warning stays, the person has not seen it.
    live = fold([event("a", "agent.state", { state: "IDLE" })], null, live);
    expect(liveOf(live, "a").restarted).toBe(true);
    expect(liveOf(dismissRestart(live, "a"), "a").restarted).toBe(false);
    live = fold([event("a", "agent.state", { state: "THINKING" })], null, live);
    expect(liveOf(live, "a").restarted).toBe(false);
  });

  it("does not flag the first start, nor a start after the agent was idle", () => {
    expect(liveOf(fold([event("a", "agent.started")]), "a").restarted).toBe(false);
    expect(liveOf(fold([event("a", "agent.state", { state: "IDLE" }), event("a", "agent.started")]), "a").restarted).toBe(false);
    expect(liveOf(fold([event("a", "agent.state", { state: "DONE" }), event("a", "agent.started")]), "a").restarted).toBe(false);
  });

  it("flags a start after waiting for an approval as an interruption too", () => {
    expect(liveOf(fold([event("a", "agent.state", { state: "WAITING_APPROVAL" }), event("a", "agent.started")]), "a").restarted).toBe(true);
  });

  it("marks a reply unread unless that Dot's page is open, and read when the page opens", () => {
    let live = fold([event("a", "message.assistant", { text: "hi" }), event("b", "message.assistant", { text: "hi" })], "b");
    expect(liveOf(live, "a").unread).toBe(true);
    expect(liveOf(live, "b").unread).toBe(false);
    live = markRead(live, "a");
    expect(liveOf(live, "a").unread).toBe(false);
  });

  it("forgets a deleted Dot, and ignores the events that say nothing about it", () => {
    const live = fold([event("a", "agent.state", { state: "THINKING" })]);
    expect(applyLiveEvent(live, event("a", "task.started", { task_id: "t" }), null)).toBe(live);
    expect(applyLiveEvent(live, event("b", "dot.deleted"), null)).toBe(live);
    expect("a" in applyLiveEvent(live, event("a", "dot.deleted"), null)).toBe(false);
  });

  it("hands back the same object when nothing changed, so a quiet event does not re-render the rail", () => {
    const live = fold([event("a", "agent.state", { state: "THINKING" })]);
    expect(applyLiveEvent(live, event("a", "agent.state", { state: "THINKING" }), null)).toBe(live);
    expect(markRead(live, "a")).toBe(live);
  });
});

describe("what the live stream says when the computer goes off", () => {
  it("ends the agent's state and what its task reported, whatever stops it: a stop, a state other than running, an error", () => {
    const working = [event("a", "agent.state", { state: "THINKING" }), event("a", "task.progress", { task_id: "t1", text: "reading" })];
    for (const off of [event("a", "computer.stopped", { reason: "user" }), event("a", "computer.state", { state: "STOPPING" }), event("a", "computer.state", { state: "STOPPED" }), event("a", "computer.state", { state: "ERROR" }), event("a", "computer.state", { state: "STARTING" })]) {
      const live = fold([off], null, fold(working));
      expect(liveOf(live, "a"), off.type + JSON.stringify(off.data)).toMatchObject({ agent: null, progress: null });
    }
  });

  it("keeps it while the computer runs, and does not touch another Dot's", () => {
    const live = fold([event("a", "agent.state", { state: "THINKING" }), event("b", "agent.state", { state: "EXECUTING" })]);
    expect(applyLiveEvent(live, event("a", "computer.state", { state: "RUNNING" }), null)).toBe(live);
    expect(liveOf(applyLiveEvent(live, event("a", "computer.stopped"), null), "b").agent).toBe("EXECUTING");
  });

  it("is told again by the agent that comes up: a state after the stop is the new one", () => {
    const live = fold([event("a", "agent.state", { state: "THINKING" }), event("a", "computer.stopped"), event("a", "agent.started"), event("a", "agent.state", { state: "IDLE" })]);
    expect(liveOf(live, "a").agent).toBe("IDLE");
  });

  it("is not undone by an event of the log that is older than what is known (a read of the newest agent event arriving late)", () => {
    const stale = event("a", "agent.state", { state: "EXECUTING" });
    const live = fold([event("a", "agent.state", { state: "THINKING" }), event("a", "computer.stopped")]);
    expect(applyLiveEvent(live, stale, "a")).toBe(live);
    // And a newer one is taken.
    expect(liveOf(applyLiveEvent(live, event("a", "agent.state", { state: "IDLE" }), "a"), "a").agent).toBe("IDLE");
  });

  it("is what the log says when nothing newer is known: the newest agent event read for a page opened mid-turn", () => {
    expect(liveOf(applyLiveEvent({}, event("a", "agent.state", { state: "EXECUTING" }), "a"), "a").agent).toBe("EXECUTING");
    expect(liveOf(applyLiveEvent({}, event("a", "agent.started"), "a"), "a").agent).toBeNull();
  });
});

describe("what a running task last reported", () => {
  it("is the newest progress line of the Dot, until that task ends", () => {
    let live = fold([event("a", "task.progress", { task_id: "t1", text: "reading" }), event("a", "task.progress", { task_id: "t1", text: "writing" })]);
    expect(liveOf(live, "a").progress).toEqual({ taskId: "t1", text: "writing" });
    expect(liveOf(live, "b").progress).toBeNull();
    // Another task finishing says nothing about this one.
    live = fold([event("a", "task.completed", { task_id: "other", summary: "ok" })], null, live);
    expect(liveOf(live, "a").progress).not.toBeNull();
    for (const type of ["task.completed", "task.failed", "task.cancelled"]) {
      const ended = fold([event("a", type, { task_id: "t1" })], null, live);
      expect(liveOf(ended, "a").progress).toBeNull();
    }
  });

  it("is forgotten when the agent starts again: the run it belonged to is gone", () => {
    const live = fold([event("a", "task.progress", { task_id: "t1", text: "reading" }), event("a", "agent.started")]);
    expect(liveOf(live, "a").progress).toBeNull();
  });

  it("ignores a progress event that is not a line of a task", () => {
    const live = fold([event("a", "agent.state", { state: "THINKING" })]);
    expect(applyLiveEvent(live, event("a", "task.progress", { text: "no task" }), null)).toBe(live);
    expect(applyLiveEvent(live, event("a", "task.progress", { task_id: "t1" }), null)).toBe(live);
  });
});

describe("the Dot a path belongs to", () => {
  it("reads it from the /dots/<id>/ prefix, decoded, and from nothing else", () => {
    expect(dotIdFromPath("/dots/dot_abc/chat")).toBe("dot_abc");
    expect(dotIdFromPath("/dots/dot_abc")).toBe("dot_abc");
    expect(dotIdFromPath("/dots/a%20b/tasks")).toBe("a b");
    expect(dotIdFromPath("/dots/%E0%A4%A/chat")).toBeNull();
    expect(dotIdFromPath("/")).toBeNull();
    expect(dotIdFromPath("/approvals")).toBeNull();
    expect(dotIdFromPath("/dots")).toBeNull();
  });
});
