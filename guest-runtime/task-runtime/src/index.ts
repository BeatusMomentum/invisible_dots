/**
 * The Dot's local task queue (architecture section 8.2): tasks arrive as
 * `task.created`, run one at a time in priority order (higher first) and then
 * creation order, and live in `dot.db` so that a restart neither loses nor
 * repeats them. A task that was RUNNING or WAITING_APPROVAL when the process
 * stopped is resumed, not started again from scratch.
 */
import type { DotStore, TaskRecord, UsageRecord } from "@invisible-dots/memory";
import { TERMINAL_TASK_STATES, type TaskState } from "@invisible-dots/shared";

export type { TaskRecord } from "@invisible-dots/memory";

/** Which state may follow which. Anything else is a bug in the caller. */
const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  PENDING: ["RUNNING", "CANCELLED"],
  RUNNING: ["WAITING_APPROVAL", "COMPLETED", "FAILED", "CANCELLED"],
  WAITING_APPROVAL: ["RUNNING", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export class TaskTransitionError extends Error {
  constructor(taskId: string, from: TaskState, to: TaskState) {
    super(`task ${taskId} cannot go from ${from} to ${to}`);
    this.name = "TaskTransitionError";
  }
}

export class TaskQueue {
  readonly #store: DotStore;
  readonly #now: () => Date;

  constructor(store: DotStore, options: { now?: () => Date } = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
  }

  /** Queue a task. A task id seen before is not queued twice (`created: false`). */
  enqueue(input: { id: string; description: string; priority?: number }): { task: TaskRecord; created: boolean } {
    return this.#store.insertTask({ id: input.id, description: input.description, priority: input.priority ?? 0 });
  }

  get(id: string): TaskRecord | undefined {
    return this.#store.getTask(id);
  }

  list(status?: readonly TaskState[]): TaskRecord[] {
    return this.#store.listTasks(status === undefined ? {} : { status });
  }

  /** The task that was in flight when the process last stopped, if any. */
  inFlight(): TaskRecord | undefined {
    return this.#store.listTasks({ status: ["RUNNING", "WAITING_APPROVAL"] })[0];
  }

  /** The next PENDING task in queue order, without changing it. */
  peekNext(): TaskRecord | undefined {
    return this.#store.listTasks({ status: ["PENDING"] })[0];
  }

  pendingCount(): number {
    return this.#store.listTasks({ status: ["PENDING"] }).length;
  }

  start(id: string): TaskRecord {
    const task = this.#require(id);
    // A resumed task keeps its original start time.
    return this.#move(task, "RUNNING", task.startedAt === null ? { startedAt: this.#iso() } : {});
  }

  waitForApproval(id: string): TaskRecord {
    return this.#move(this.#require(id), "WAITING_APPROVAL");
  }

  complete(id: string, summary: string, usage?: UsageRecord): TaskRecord {
    return this.#move(this.#require(id), "COMPLETED", { summary, finishedAt: this.#iso(), ...(usage ? { usage } : {}) });
  }

  fail(id: string, error: string, usage?: UsageRecord): TaskRecord {
    return this.#move(this.#require(id), "FAILED", { error, finishedAt: this.#iso(), ...(usage ? { usage } : {}) });
  }

  /** Cancel a task that has not finished; returns undefined when it already had. */
  cancel(id: string): TaskRecord | undefined {
    const task = this.#store.getTask(id);
    if (!task || TERMINAL_TASK_STATES.includes(task.status)) return undefined;
    return this.#move(task, "CANCELLED", { finishedAt: this.#iso() });
  }

  /** Record one more model turn; returns the new count. */
  countStep(id: string, usage?: UsageRecord): number {
    const task = this.#require(id);
    return this.#store.updateTask(id, { steps: task.steps + 1, ...(usage ? { usage } : {}) }).steps;
  }

  #move(task: TaskRecord, to: TaskState, extra: Parameters<DotStore["updateTask"]>[1] = {}): TaskRecord {
    if (task.status === to) return this.#store.updateTask(task.id, extra);
    if (!TRANSITIONS[task.status].includes(to)) throw new TaskTransitionError(task.id, task.status, to);
    return this.#store.updateTask(task.id, { ...extra, status: to });
  }

  #require(id: string): TaskRecord {
    const task = this.#store.getTask(id);
    if (!task) throw new Error(`no task with id "${id}"`);
    return task;
  }

  #iso(): string {
    return this.#now().toISOString();
  }
}
