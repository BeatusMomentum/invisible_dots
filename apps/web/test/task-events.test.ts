import type { StoredEvent } from "@invisible-dots/shared/browser";
import { describe, expect, it } from "vitest";
import { isTaskEvent, loadTaskEvents, mergeTaskEvents, progressOf, storyOf, taskIdOf } from "../src/lib/task-events";

let n = 0;
function event(type: string, data: Record<string, unknown> = {}, at = `2026-03-10T12:00:${String(n).padStart(2, "0")}Z`): StoredEvent {
  n += 1;
  return { id: n, dot_id: "d1", type, data, source: "guest", guest_seq: n, created_at: at } as StoredEvent;
}

describe("which events can belong to a task", () => {
  it("are the ones that name a task, and approval answers, which name only the approval", () => {
    expect(isTaskEvent(event("task.progress", { task_id: "t1", text: "x" }))).toBe(true);
    expect(isTaskEvent(event("tool.called", { task_id: "t1", tool: "exec" }))).toBe(true);
    expect(isTaskEvent(event("approval.resolved", { approval_id: "a1", decision: "approve" }))).toBe(true);
    expect(isTaskEvent(event("tool.called", { tool: "exec" }))).toBe(false);
    expect(isTaskEvent(event("message.assistant", { text: "hi" }))).toBe(false);
    expect(taskIdOf(event("task.started", { task_id: "t9" }))).toBe("t9");
    expect(taskIdOf(event("agent.state", { state: "IDLE" }))).toBe("");
  });

  it("merge in id order without repeating one", () => {
    const a = event("task.started", { task_id: "t1" });
    const b = event("task.progress", { task_id: "t1", text: "one" });
    const chat = event("message.assistant", { text: "not a task" });
    const merged = mergeTaskEvents([b], [a, b, chat]);
    expect(merged.map((e) => e.id)).toEqual([a.id, b.id]);
  });
});

describe("loadTaskEvents", () => {
  it("reads the log page by page to its end and keeps the events of tasks", async () => {
    const log: StoredEvent[] = [];
    for (let i = 0; i < 2300; i++) log.push(i % 2 === 0 ? event("task.progress", { task_id: "t1", text: `p${i}` }) : event("agent.state", { state: "IDLE" }));
    const asked: Array<{ after?: number; limit?: number }> = [];
    const client = {
      async events(_dot: string, options: { after?: number; limit?: number } = {}) {
        asked.push(options);
        return log.filter((e) => e.id > (options.after ?? 0)).slice(0, options.limit);
      },
    };
    const read = await loadTaskEvents(client, "d1");
    expect(read).toHaveLength(1150);
    expect(read.every((e) => e.type === "task.progress")).toBe(true);
    // 1000, 1000, 300: the short page ends it.
    expect(asked).toHaveLength(3);
    expect(asked.map((a) => a.limit)).toEqual([1000, 1000, 1000]);
    expect(asked[1]!.after).toBe(log[999]!.id);
  });

  it("ends on a page that is exactly full only after asking once more", async () => {
    const log = Array.from({ length: 1000 }, (_, i) => event("task.progress", { task_id: "t1", text: String(i) }));
    let calls = 0;
    const client = {
      async events(_dot: string, options: { after?: number; limit?: number } = {}) {
        calls++;
        return log.filter((e) => e.id > (options.after ?? 0)).slice(0, options.limit);
      },
    };
    expect(await loadTaskEvents(client, "d1")).toHaveLength(1000);
    expect(calls).toBe(2);
  });

  it("lets a failure through and stops reading when told to", async () => {
    await expect(
      loadTaskEvents(
        {
          async events() {
            throw new Error("the log is down");
          },
        },
        "d1",
      ),
    ).rejects.toThrow("the log is down");
    const controller = new AbortController();
    let calls = 0;
    const full = Array.from({ length: 1000 }, (_, i) => event("task.progress", { task_id: "t1", text: String(i) }));
    const client = {
      async events() {
        calls++;
        controller.abort();
        return full;
      },
    };
    await loadTaskEvents(client, "d1", controller.signal);
    expect(calls).toBe(1);
  });
});

describe("progressOf", () => {
  it("is the newest progress line of that task, or null", () => {
    const events = [
      event("task.progress", { task_id: "t1", text: "first" }),
      event("task.progress", { task_id: "t2", text: "other task" }),
      event("task.progress", { task_id: "t1", text: "second" }),
      event("tool.called", { task_id: "t1", tool: "exec" }),
    ];
    expect(progressOf(events, "t1")?.text).toBe("second");
    expect(progressOf(events, "t2")?.text).toBe("other task");
    expect(progressOf(events, "t3")).toBeNull();
    expect(progressOf([], "t1")).toBeNull();
  });
});

describe("storyOf", () => {
  const events = [
    event("task.created", { task_id: "t1", description: "Write it", priority: 10 }),
    event("task.started", { task_id: "t1" }),
    event("task.progress", { task_id: "t1", text: "Reading the sources" }),
    event("tool.called", { task_id: "t1", tool: "exec", permission: "computer.exec", decision: "allow", ok: true, duration_ms: 1200, target: "ls -la" }),
    event("tool.called", { task_id: "t2", tool: "exec", decision: "allow", ok: true, duration_ms: 5 }),
    event("approval.requested", { task_id: "t1", approval_id: "a1", tool: "write_file", permission: "files.write", reason: "needs to save the report", arguments: {} }),
    event("approval.resolved", { approval_id: "a1", decision: "approve", note: "go on" }),
    event("approval.resolved", { approval_id: "other", decision: "reject" }),
    event("tool.called", { task_id: "t1", tool: "browser_navigate", decision: "deny", ok: false, duration_ms: 0 }),
    event("tool.called", { task_id: "t1", tool: "exec", decision: "allow", ok: false, duration_ms: 0, interrupted: true }),
    event("task.completed", { task_id: "t1", summary: "Done: **report.md**" }),
  ];

  it("lists one task's steps in order, each typed, and none of another task's", () => {
    const story = storyOf(events, "t1");
    expect(story.map((s) => s.kind)).toEqual(["created", "started", "progress", "tool", "approval", "tool", "tool", "completed"]);
    expect(story[0]).toMatchObject({ kind: "created", description: "Write it", priority: 10 });
    expect(story[2]).toMatchObject({ kind: "progress", text: "Reading the sources" });
    expect(story[3]).toMatchObject({ kind: "tool", tool: "exec", target: "ls -la", ok: true, durationMs: 1200, interrupted: false });
    expect(story[7]).toMatchObject({ kind: "completed", summary: "Done: **report.md**" });
  });

  it("folds an approval and its answer into one step, found by the approval's id", () => {
    const approval = storyOf(events, "t1").find((s) => s.kind === "approval");
    expect(approval).toMatchObject({ approvalId: "a1", tool: "write_file", reason: "needs to save the report", outcome: "approved", note: "go on" });
    const waiting = storyOf(events.slice(0, 6), "t1").find((s) => s.kind === "approval");
    expect(waiting).toMatchObject({ outcome: "waiting", note: "" });
  });

  it("keeps a refused call and an interrupted one for what they are", () => {
    const tools = storyOf(events, "t1").filter((s) => s.kind === "tool");
    expect(tools[1]).toMatchObject({ tool: "browser_navigate", decision: "deny", ok: false });
    expect(tools[2]).toMatchObject({ interrupted: true, ok: false });
  });

  it("ends a failed task with its error and a cancelled one with that", () => {
    const failed = storyOf([event("task.failed", { task_id: "t5", error: "cost cap reached" })], "t5");
    expect(failed).toEqual([expect.objectContaining({ kind: "failed", error: "cost cap reached" })]);
    const cancelled = storyOf([event("task.cancelled", { task_id: "t6" })], "t6");
    expect(cancelled.map((s) => s.kind)).toEqual(["cancelled"]);
    expect(storyOf(events, "nope")).toEqual([]);
  });
});
