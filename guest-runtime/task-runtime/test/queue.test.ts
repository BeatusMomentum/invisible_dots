import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DotStore } from "@invisible-dots/memory";
import { TaskQueue, TaskTransitionError } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function memoryQueue() {
  const store = new DotStore({ path: ":memory:" });
  return { store, queue: new TaskQueue(store) };
}

describe("TaskQueue", () => {
  it("serves priority first, then creation order, and dedupes ids", () => {
    const { queue } = memoryQueue();
    queue.enqueue({ id: "a", description: "a", priority: 1 });
    queue.enqueue({ id: "b", description: "b", priority: 3 });
    queue.enqueue({ id: "c", description: "c", priority: 3 });
    queue.enqueue({ id: "d", description: "d" });
    expect(queue.enqueue({ id: "a", description: "again", priority: 10 }).created).toBe(false);
    const order: string[] = [];
    for (let next = queue.peekNext(); next; next = queue.peekNext()) {
      order.push(next.id);
      queue.start(next.id);
      queue.complete(next.id, "done");
    }
    expect(order).toEqual(["b", "c", "a", "d"]);
  });

  it("walks the lifecycle and refuses impossible transitions", () => {
    const { queue } = memoryQueue();
    queue.enqueue({ id: "t", description: "x" });
    const started = queue.start("t");
    expect(started.status).toBe("RUNNING");
    expect(started.startedAt).not.toBeNull();
    expect(queue.waitForApproval("t").status).toBe("WAITING_APPROVAL");
    expect(queue.start("t").startedAt).toBe(started.startedAt);
    expect(queue.countStep("t", { prompt_tokens: 3, completion_tokens: 1, cost: null, requests: 1 })).toBe(1);
    expect(queue.countStep("t")).toBe(2);
    const done = queue.complete("t", "summary");
    expect(done).toMatchObject({ status: "COMPLETED", summary: "summary", steps: 2, usage: { prompt_tokens: 3 } });
    expect(() => queue.start("t")).toThrow(TaskTransitionError);
    expect(queue.cancel("t")).toBeUndefined();
  });

  it("cancels pending and running tasks", () => {
    const { queue } = memoryQueue();
    queue.enqueue({ id: "p", description: "x" });
    queue.enqueue({ id: "r", description: "y" });
    queue.start("r");
    expect(queue.cancel("p")?.status).toBe("CANCELLED");
    expect(queue.cancel("r")?.status).toBe("CANCELLED");
    expect(queue.cancel("missing")).toBeUndefined();
    expect(queue.pendingCount()).toBe(0);
  });

  it("finds the in-flight task again after a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "idots-queue-"));
    dirs.push(dir);
    const path = join(dir, "dot.db");
    const first = DotStore.open(path);
    const q1 = new TaskQueue(first);
    q1.enqueue({ id: "t1", description: "running when stopped" });
    q1.enqueue({ id: "t2", description: "still pending" });
    q1.start("t1");
    first.close();

    const second = DotStore.open(path);
    const q2 = new TaskQueue(second);
    expect(q2.inFlight()?.id).toBe("t1");
    expect(q2.peekNext()?.id).toBe("t2");
    second.close();
  });
});
