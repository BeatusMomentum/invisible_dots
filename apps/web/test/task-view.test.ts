import { describe, expect, it } from "vitest";
import { filterHistory, groupTasks, HISTORY_PAGE, isFinished, isRunning, priorityLabel, PRIORITIES, sectionOf, statusLabel, statusTone, workedSeconds } from "../src/lib/task-view";
import type { Task } from "../src/lib/types";
import { taskRecord as task } from "./support/control-plane";

const NOW = Date.parse("2026-03-10T12:00:00Z");
const iso = (offsetMin: number) => new Date(NOW + offsetMin * 60_000).toISOString();

describe("which section a task is in", () => {
  it("puts working and waiting tasks in Running, finished ones in History", () => {
    expect(sectionOf(task("a", { status: "RUNNING" }), NOW)).toBe("running");
    expect(sectionOf(task("a", { status: "WAITING_APPROVAL" }), NOW)).toBe("running");
    for (const status of ["COMPLETED", "FAILED", "CANCELLED"] as const) expect(sectionOf(task("a", { status }), NOW)).toBe("history");
  });

  it("separates a pending task that has a time ahead of it from the queue", () => {
    expect(sectionOf(task("a", { scheduled_at: iso(30) }), NOW)).toBe("scheduled");
    expect(sectionOf(task("a", { scheduled_at: iso(-30) }), NOW)).toBe("queue");
    expect(sectionOf(task("a"), NOW)).toBe("queue");
  });

  it("agrees with the helpers the rest of the page asks", () => {
    expect(isRunning("WAITING_APPROVAL")).toBe(true);
    expect(isRunning("PENDING")).toBe(false);
    expect(isFinished("CANCELLED")).toBe(true);
    expect(isFinished("RUNNING")).toBe(false);
  });
});

describe("groupTasks", () => {
  const tasks = [
    task("old-low", { priority: -10, created_at: iso(-300) }),
    task("new-urgent", { priority: 100, created_at: iso(-10) }),
    task("old-normal", { created_at: iso(-200) }),
    task("new-normal", { created_at: iso(-20) }),
    task("later", { scheduled_at: iso(600) }),
    task("sooner", { scheduled_at: iso(60) }),
    task("run-late", { status: "RUNNING", started_at: iso(-5) }),
    task("run-early", { status: "WAITING_APPROVAL", started_at: iso(-50) }),
    task("done-old", { status: "COMPLETED", finished_at: iso(-500) }),
    task("done-new", { status: "FAILED", finished_at: iso(-15) }),
  ];
  const sections = groupTasks(tasks, NOW);
  const ids = (list: Task[]) => list.map((t) => t.id);

  it("queues in the order the dispatcher takes them: priority, then age", () => {
    expect(ids(sections.queue)).toEqual(["new-urgent", "old-normal", "new-normal", "old-low"]);
  });

  it("orders the rest the way a person looks for them", () => {
    expect(ids(sections.running)).toEqual(["run-early", "run-late"]);
    expect(ids(sections.scheduled)).toEqual(["sooner", "later"]);
    expect(ids(sections.history)).toEqual(["done-new", "done-old"]);
  });

  it("loses and invents nothing", () => {
    expect(Object.values(sections).flat()).toHaveLength(tasks.length);
  });
});

describe("the history filter", () => {
  const history = [task("a", { status: "COMPLETED" }), task("b", { status: "FAILED" }), task("c", { status: "CANCELLED" }), task("d", { status: "COMPLETED" })];

  it("keeps the tasks that ended that way, or all of them", () => {
    expect(filterHistory(history, "all")).toHaveLength(4);
    expect(filterHistory(history, "COMPLETED").map((t) => t.id)).toEqual(["a", "d"]);
    expect(filterHistory(history, "FAILED").map((t) => t.id)).toEqual(["b"]);
    expect(filterHistory(history, "CANCELLED").map((t) => t.id)).toEqual(["c"]);
  });

  it("is shown a page at a time", () => {
    expect(HISTORY_PAGE).toBeGreaterThan(5);
  });
});

describe("how a task reads", () => {
  it("has a word and a tone for every state, and passes an unknown one through", () => {
    expect(statusLabel("PENDING")).toBe("Queued");
    expect(statusLabel("WAITING_APPROVAL")).toBe("Waiting for you");
    expect(statusTone("FAILED")).toBe("error");
    expect(statusTone("COMPLETED")).toBe("ok");
    expect(statusTone("WAITING_APPROVAL")).toBe("warn");
    expect(statusLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
    expect(statusTone("SOMETHING_NEW")).toBe("neutral");
  });

  it("names the four priorities, lowest first, and shows any other number as it is", () => {
    expect(PRIORITIES.map((p) => p.label)).toEqual(["Low", "Normal", "High", "Urgent"]);
    expect(PRIORITIES.map((p) => p.value)).toEqual([...PRIORITIES.map((p) => p.value)].sort((a, b) => a - b));
    expect(priorityLabel(0)).toBe("Normal");
    expect(priorityLabel(100)).toBe("Urgent");
    expect(priorityLabel(7)).toBe("Priority 7");
  });

  it("counts the time worked from the start to the end, or to now while it runs", () => {
    expect(workedSeconds({ started_at: null, finished_at: null }, NOW)).toBeNull();
    expect(workedSeconds({ started_at: iso(-2), finished_at: null }, NOW)).toBe(120);
    expect(workedSeconds({ started_at: iso(-10), finished_at: iso(-7) }, NOW)).toBe(180);
    expect(workedSeconds({ started_at: iso(5), finished_at: null }, NOW)).toBe(0);
  });
});
