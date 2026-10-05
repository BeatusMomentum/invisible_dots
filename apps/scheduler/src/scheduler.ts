/**
 * The control plane's operations, one method per thing the API can ask for.
 * The API is a thin HTTP layer over this class; everything that touches the
 * database, the VM layer or a guest happens here.
 */
import { randomBytes } from "node:crypto";
import { DotNameTakenError, GLOBAL_SCOPE, OPENROUTER_KEY_NAME, type Database } from "@invisible-dots/database";
import { EventLog, USER_MESSAGE_EVENT } from "@invisible-dots/events";
import type {
  AcceptedAnswer,
  ApprovalRecord,
  ComputerAnswer,
  ConversationMessage,
  CreateTaskRequest,
  DotRecord,
  DotSummary,
  MessageAnswer,
  TaskRecord,
} from "@invisible-dots/shared";
import {
  checkOpenRouterKey,
  computerResources,
  DotConfigError,
  newId,
  parseDotConfig,
  parseSize,
  TASK_CANCELLED_SYSTEM_EVENT,
  TERMINAL_TASK_STATES,
  vmName,
  type ApprovalStatus,
  type BrowserIdentity,
  type CreateBrowserIdentityRequest,
  type DotConfig,
  type InboundEvent,
  type StoredEvent,
  type SystemAnswer,
} from "@invisible-dots/shared";
import { Dispatcher } from "./dispatcher.js";
import { guestErrorCode, guestErrorStatus, type ComputerDriver, type GuestApi } from "./driver.js";
import { InboundDelivery, type InboundDeliveryOptions } from "./inbound.js";
import { Lifecycle, MISSING_KEY_MESSAGE, type LifecycleOptions } from "./lifecycle.js";
import {
  ControlPlaneError,
  errorMessage,
  notFound,
  silentLogger,
  systemClock,
  type Clock,
  type Logger,
} from "./support.js";

export interface SchedulerOptions {
  db: Database;
  driver: ComputerDriver;
  events?: EventLog;
  clock?: Clock;
  logger?: Logger;
  /** How often PENDING tasks are looked for besides the immediate pass on every change. Default 5 s. */
  dispatchIntervalMs?: number;
  /** How often idle Dots are looked for. Default 30 s. */
  idleCheckIntervalMs?: number;
  lifecycle?: Partial<LifecycleOptions>;
  /** How inbound events (tasks, messages, approvals) are retried, and when a task's delivery gives up. */
  dispatcher?: Partial<InboundDeliveryOptions>;
}

const TOKEN_BYTES = 32;

export class Scheduler {
  readonly db: Database;
  readonly events: EventLog;
  readonly lifecycle: Lifecycle;
  readonly dispatcher: Dispatcher;
  /** Sends what is stored for the guests in `inbound_events`, waking Dots that sleep. */
  readonly inbound: InboundDelivery;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #dispatchIntervalMs: number;
  readonly #idleCheckIntervalMs: number;
  readonly #background = new Set<Promise<unknown>>();
  readonly #provisioning = new Map<string, Promise<void>>();
  readonly #timers: NodeJS.Timeout[] = [];
  #started = false;

  constructor(options: SchedulerOptions) {
    this.db = options.db;
    this.#clock = options.clock ?? systemClock;
    this.#log = options.logger ?? silentLogger;
    this.events =
      options.events ?? new EventLog(options.db.events, (line) => this.#log.warn(line));
    this.#dispatchIntervalMs = options.dispatchIntervalMs ?? 5_000;
    this.#idleCheckIntervalMs = options.idleCheckIntervalMs ?? 30_000;
    this.lifecycle = new Lifecycle({
      db: options.db,
      events: this.events,
      driver: options.driver,
      clock: this.#clock,
      logger: this.#log,
      options: options.lifecycle,
      onWorkPossible: () => void this.dispatcher.dispatch(),
      onReady: (dotId) => void this.inbound.kick(dotId),
    });
    this.inbound = new InboundDelivery({
      db: options.db,
      lifecycle: this.lifecycle,
      clock: this.#clock,
      logger: this.#log,
      provisioned: async (dotId) => {
        await this.#provisioning.get(dotId)?.catch(() => {});
      },
      onTaskSettled: () => void this.dispatcher.dispatch(),
      options: options.dispatcher,
    });
    this.dispatcher = new Dispatcher(options.db, this.#clock, this.#log, (dotId) => void this.inbound.kick(dotId));
  }

  /**
   * Recover from the previous run, then start the timers. Nothing is
   * requeued: a task claimed before the restart still has its task.created
   * in the outbox, and the guest ignores it if an earlier send reached it.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    for (const work of await this.lifecycle.recover()) this.#track(work);
    this.#track(this.pass());
    const every = (ms: number, fn: () => Promise<unknown>) => {
      const timer = setInterval(() => void fn().catch((e) => this.#log.error("timer failed", { error: errorMessage(e) })), ms);
      timer.unref();
      this.#timers.push(timer);
    };
    every(this.#dispatchIntervalMs, () => this.pass());
    every(this.#idleCheckIntervalMs, () => this.idleCheck());
  }

  /**
   * One round of looking for work (section 9.5): claim due tasks, send the
   * inbound rows whose retry time came, and wake stopped Dots whose new work
   * waits behind a task their guest has not finished.
   */
  async pass(): Promise<void> {
    await this.dispatcher.dispatch();
    await this.inbound.kickDue();
    for (const dotId of await this.db.tasks.stoppedDotsWithBlockedWork()) {
      if (this.lifecycle.isBusy(dotId)) continue;
      this.#log.info("waking a stopped Dot: new work waits behind its unfinished task", { dotId });
      this.#runInBackground("wake for blocked work", dotId, () => this.lifecycle.ensureReady(dotId));
    }
  }

  /** Stop the timers and the event pumps and wait for in-flight work. VMs keep running. */
  async close(): Promise<void> {
    for (const timer of this.#timers.splice(0)) clearInterval(timer);
    this.inbound.close();
    await this.settle().catch(() => {});
    await this.lifecycle.close();
  }

  /** Wait until every background operation started so far has finished (used by tests and shutdown). */
  async settle(): Promise<void> {
    for (;;) {
      await this.dispatcher.settle();
      await this.inbound.settle();
      await this.lifecycle.settle();
      const pending = [...this.#background];
      if (pending.length === 0) {
        // Each of the three may have started work in another while it settled.
        if (!this.dispatcher.busy && !this.inbound.busy && !this.lifecycle.busy) return;
        continue;
      }
      await Promise.allSettled(pending);
    }
  }

  #track<T>(work: Promise<T>): Promise<T> {
    const tracked = work.finally(() => this.#background.delete(tracked));
    tracked.catch(() => {});
    this.#background.add(tracked);
    return work;
  }

  /** Run something in the background and log its failure. */
  #runInBackground(what: string, dotId: string, work: () => Promise<unknown>): void {
    this.#track(
      work().catch((error) => {
        this.#log.error(`${what} failed`, { dotId, error: errorMessage(error) });
      }),
    );
  }

  // Dots

  async requireDot(idOrName: string): Promise<DotSummary> {
    const dot = await this.db.dots.resolve(idOrName);
    if (!dot) throw notFound("Dot", idOrName);
    return dot;
  }

  listDots(): Promise<DotSummary[]> {
    return this.db.dots.list();
  }

  #parseConfig(input: unknown): DotConfig {
    if (input === undefined || input === null) {
      throw new ControlPlaneError(400, "invalid_request", "the body needs a config: YAML text or an object");
    }
    try {
      return parseDotConfig(input);
    } catch (error) {
      if (error instanceof DotConfigError) throw new ControlPlaneError(400, "invalid_config", error.message, error.issues);
      throw error;
    }
  }

  /**
   * Section 9.4: insert the Dot as CREATING with its computer row and a new
   * token in one transaction, then provision it in the background (overlay,
   * seed, port, QEMU, READY).
   */
  async createDot(configInput: unknown): Promise<DotRecord> {
    const config = this.#parseConfig(configInput);
    const id = newId("dot");
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    let dot: DotRecord;
    try {
      dot = await this.db.transaction(async (tx) => {
        const record = await tx.dots.insert({ id, config, status: "CREATING" });
        await tx.computers.insert({ dotId: id, vmName: vmName(id), state: "PROVISIONING", token });
        return record;
      });
    } catch (error) {
      if (error instanceof DotNameTakenError) throw new ControlPlaneError(409, "name_taken", error.message);
      throw error;
    }
    await this.events.appendHost(id, "dot.created", { name: config.name });
    await this.events.appendHost(id, "computer.state", { state: "PROVISIONING" });
    this.#log.info("dot created", { dotId: id, name: config.name });
    const provisioning = this.lifecycle.provision(id);
    this.#provisioning.set(id, provisioning);
    this.#runInBackground("provisioning", id, () =>
      provisioning.finally(() => {
        this.#provisioning.delete(id);
      }),
    );
    return dot;
  }

  async updateDot(idOrName: string, configInput: unknown): Promise<DotRecord> {
    const current = await this.requireDot(idOrName);
    const config = this.#parseConfig(configInput);
    if (parseSize(config.computer.disk) < parseSize(current.config.computer.disk)) {
      throw new ControlPlaneError(
        409,
        "disk_shrink",
        `computer.disk cannot shrink from ${current.config.computer.disk} to ${config.computer.disk}: the filesystem on it would be destroyed`,
      );
    }
    let updated: DotRecord | null;
    try {
      updated = await this.db.dots.updateConfig(current.id, config);
    } catch (error) {
      if (error instanceof DotNameTakenError) throw new ControlPlaneError(409, "name_taken", error.message);
      throw error;
    }
    if (!updated) throw notFound("Dot", idOrName);
    let pushed = false;
    try {
      pushed = await this.lifecycle.syncGuest(current.id);
    } catch (error) {
      this.#log.warn("config saved but the push to the guest failed; it is pushed again on the next READY", {
        dotId: current.id,
        error: errorMessage(error),
      });
      this.lifecycle.markSuspect(current.id);
    }
    await this.events.appendHost(current.id, "dot.updated", { name: config.name, pushed_to_guest: pushed });
    return updated;
  }

  async deleteDot(idOrName: string): Promise<AcceptedAnswer> {
    const dot = await this.requireDot(idOrName);
    this.#runInBackground("deletion", dot.id, () => this.lifecycle.remove(dot.id));
    return { accepted: true };
  }

  // Messages

  /**
   * Log the message and store it for the guest in one transaction, so a
   * message the person saw accepted always reaches the Dot, also across a
   * failed wake or a control plane restart.
   */
  async sendMessage(idOrName: string, text: string): Promise<MessageAnswer> {
    if (typeof text !== "string" || text.trim() === "") {
      throw new ControlPlaneError(400, "invalid_request", "text must be a non-empty string");
    }
    const dot = await this.requireDot(idOrName);
    const messageId = newId("msg");
    const event: InboundEvent<"user.message"> = {
      id: messageId,
      type: "user.message",
      ts: this.#clock.now().toISOString(),
      data: { text },
    };
    const stored = await this.db.transaction(async (tx) => {
      // The event first: its insert takes the event-order lock (database events.ts).
      const logged = await this.events.appendUserMessageIn(tx, dot.id, { message_id: messageId, text });
      await tx.inbound.enqueue(dot.id, event);
      return logged;
    });
    this.events.publish(stored);
    const delivery = await this.#deliver(dot.id, event.id);
    return { message_id: messageId, event_id: stored.id, delivery };
  }

  async conversation(idOrName: string, limit = 500): Promise<ConversationMessage[]> {
    const dot = await this.requireDot(idOrName);
    const events = await this.events.query({
      dotId: dot.id,
      types: [USER_MESSAGE_EVENT, "message.assistant"],
      limit,
    });
    return events.map((e) => ({
      event_id: e.id,
      // StoredEvent.type lists the contract's event types; the user side is logged as USER_MESSAGE_EVENT.
      role: (e.type as string) === USER_MESSAGE_EVENT ? "user" : "assistant",
      text: String(e.data.text ?? ""),
      in_reply_to: typeof e.data.in_reply_to === "string" ? e.data.in_reply_to : null,
      created_at: e.created_at,
    }));
  }

  /**
   * Send what is stored for the Dot. A READY Dot gets it before this
   * returns ("delivered"); otherwise it is sent once the Dot is woken, in the
   * background ("queued"), and stays stored until then.
   */
  async #deliver(dotId: string, eventId: string): Promise<"delivered" | "queued"> {
    if (!this.lifecycle.isReady(dotId)) {
      void this.inbound.kick(dotId);
      return "queued";
    }
    await this.inbound.kick(dotId);
    return (await this.db.inbound.get(eventId))?.delivered_at ? "delivered" : "queued";
  }

  // Tasks

  async createTask(idOrName: string, body: Partial<CreateTaskRequest>): Promise<TaskRecord> {
    const dot = await this.requireDot(idOrName);
    if (typeof body.description !== "string" || body.description.trim() === "") {
      throw new ControlPlaneError(400, "invalid_request", "description must be a non-empty string");
    }
    if (body.priority !== undefined && (!Number.isInteger(body.priority) || Math.abs(body.priority) > 1_000_000)) {
      throw new ControlPlaneError(400, "invalid_request", "priority must be an integer from -1000000 to 1000000");
    }
    let scheduledAt: Date | null = null;
    if (body.scheduled_at !== undefined && body.scheduled_at !== null) {
      scheduledAt = new Date(body.scheduled_at);
      if (typeof body.scheduled_at !== "string" || Number.isNaN(scheduledAt.getTime())) {
        throw new ControlPlaneError(400, "invalid_request", "scheduled_at must be an ISO 8601 timestamp");
      }
    }
    const task = await this.db.tasks.insert({
      id: newId("task"),
      dotId: dot.id,
      description: body.description,
      priority: body.priority ?? 0,
      scheduledAt,
    });
    await this.events.appendHost(dot.id, "task.created", {
      task_id: task.id,
      description: task.description,
      priority: task.priority,
    });
    void this.dispatcher.dispatch();
    return task;
  }

  async listTasks(idOrName: string): Promise<TaskRecord[]> {
    const dot = await this.requireDot(idOrName);
    return this.db.tasks.listByDot(dot.id);
  }

  async getTask(id: string): Promise<TaskRecord> {
    const task = await this.db.tasks.get(id);
    if (!task) throw notFound("task", id);
    return task;
  }

  /**
   * Cancel a task. A PENDING one simply never runs. Otherwise, in the same
   * transaction: when no send of its task.created ever began, that event is
   * dropped and the guest never hears of the task; when one began, the
   * guest may hold the task, so `system.event { name: "task.cancelled" }`
   * is stored behind it and reaches the guest even if it sleeps now (the
   * contract has no dedicated inbound cancel). The previous state comes from
   * the update itself, never from an earlier read.
   */
  async cancelTask(id: string): Promise<TaskRecord> {
    const task = await this.getTask(id);
    if (TERMINAL_TASK_STATES.includes(task.status)) {
      throw new ControlPlaneError(409, "task_finished", `task ${id} is already ${task.status}`);
    }
    const { logged, cancelled, tellGuest } = await this.db.transaction(async (tx) => {
      // The event first: its insert takes the event-order lock (database events.ts).
      const logged = await this.events.appendHostIn(tx, task.dot_id, "task.cancelled", { task_id: id });
      const moved = await tx.tasks.transition(id, "CANCELLED", { error: "cancelled by the user" });
      if (!moved) throw new ControlPlaneError(409, "task_finished", `task ${id} finished meanwhile`);
      let tellGuest = false;
      if (moved.previous !== "PENDING" && !(await tx.inbound.dropUnsent(id, "the task was cancelled before it was delivered"))) {
        const event: InboundEvent<"system.event"> = {
          id: newId("evt"),
          type: "system.event",
          ts: this.#clock.now().toISOString(),
          data: { name: TASK_CANCELLED_SYSTEM_EVENT, data: { task_id: id } },
        };
        await tx.inbound.enqueue(task.dot_id, event, { taskId: id });
        tellGuest = true;
      }
      return { logged, cancelled: moved.task, tellGuest };
    });
    this.events.publish(logged);
    if (tellGuest) void this.inbound.kick(task.dot_id);
    void this.dispatcher.dispatch();
    return cancelled;
  }

  // Computer

  async computer(idOrName: string): Promise<ComputerAnswer> {
    const dot = await this.requireDot(idOrName);
    const computer = await this.db.computers.get(dot.id);
    if (!computer) throw notFound("computer of Dot", idOrName);
    const ready = this.lifecycle.isReady(dot.id);
    let system: SystemAnswer | null = null;
    if (ready) {
      // Live figures are a convenience of this answer: a guest that is slow or
      // briefly unreachable must not turn the whole route into an error.
      try {
        system = await (await this.lifecycle.guest(dot.id)).system();
      } catch (error) {
        this.#log.debug("live system figures unavailable", { dotId: dot.id, error: errorMessage(error) });
      }
    }
    return { ...computer, ready, system };
  }

  async startComputer(idOrName: string): Promise<AcceptedAnswer> {
    const dot = await this.requireDot(idOrName);
    if (dot.computer_state === "PROVISIONING" || dot.computer_state === "DELETING") {
      throw new ControlPlaneError(409, "invalid_state", `the computer is ${dot.computer_state}`);
    }
    this.#runInBackground("start", dot.id, () => this.lifecycle.ensureReady(dot.id));
    return { accepted: true };
  }

  async stopComputer(idOrName: string): Promise<AcceptedAnswer> {
    const dot = await this.requireDot(idOrName);
    if (dot.computer_state === "PROVISIONING" || dot.computer_state === "DELETING") {
      throw new ControlPlaneError(409, "invalid_state", `the computer is ${dot.computer_state}`);
    }
    this.#runInBackground("stop", dot.id, () => this.lifecycle.stop(dot.id, "user"));
    return { accepted: true };
  }

  async rebootComputer(idOrName: string): Promise<AcceptedAnswer> {
    const dot = await this.requireDot(idOrName);
    if (dot.computer_state !== "RUNNING") {
      throw new ControlPlaneError(409, "computer_stopped", `the computer is ${dot.computer_state ?? "missing"}`);
    }
    this.#runInBackground("reboot", dot.id, () => this.lifecycle.reboot(dot.id));
    return { accepted: true };
  }

  /** A guest for a Dot whose computer is running; 409 computer_stopped otherwise (section 9.6). */
  async #runningGuest(idOrName: string): Promise<{ dotId: string; guest: GuestApi }> {
    const dot = await this.requireDot(idOrName);
    if (dot.computer_state !== "RUNNING") {
      throw new ControlPlaneError(
        409,
        "computer_stopped",
        `the computer of Dot ${dot.name} is ${dot.computer_state ?? "missing"}; start it first`,
      );
    }
    return { dotId: dot.id, guest: await this.lifecycle.guest(dot.id) };
  }

  /** Run a guest call and turn its failure into an API error: the guest's own 4xx passes through. */
  async #guestCall<T>(dotId: string, what: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const status = guestErrorStatus(error);
      if (status >= 400 && status < 500 && status !== 401) {
        throw new ControlPlaneError(status, guestErrorCode(error) ?? "guest_error", errorMessage(error));
      }
      this.#log.warn("guest call failed", { dotId, what, error: errorMessage(error) });
      throw new ControlPlaneError(502, "guest_unavailable", `${what}: the Dot's computer did not answer: ${errorMessage(error)}`);
    }
  }

  async screenshot(idOrName: string): Promise<Uint8Array> {
    const { dotId, guest } = await this.#runningGuest(idOrName);
    return this.#guestCall(dotId, "screenshot", () => guest.screenshot());
  }

  async listIdentities(idOrName: string): Promise<BrowserIdentity[]> {
    const { dotId, guest } = await this.#runningGuest(idOrName);
    return (await this.#guestCall(dotId, "list browser identities", () => guest.listBrowserIdentities())).identities;
  }

  async createIdentity(idOrName: string, body: Partial<CreateBrowserIdentityRequest>): Promise<BrowserIdentity> {
    if (typeof body.name !== "string" || body.name.trim() === "") {
      throw new ControlPlaneError(400, "invalid_request", "name must be a non-empty string");
    }
    if (body.proxy !== undefined && typeof body.proxy !== "string") {
      throw new ControlPlaneError(400, "invalid_request", "proxy must be a string");
    }
    const { dotId, guest } = await this.#runningGuest(idOrName);
    const request: CreateBrowserIdentityRequest = { name: body.name, ...(body.proxy ? { proxy: body.proxy } : {}) };
    return this.#guestCall(dotId, "create a browser identity", () => guest.createBrowserIdentity(request));
  }

  async getIdentity(idOrName: string, identityId: string): Promise<BrowserIdentity> {
    const { dotId, guest } = await this.#runningGuest(idOrName);
    return this.#guestCall(dotId, "get a browser identity", () => guest.getBrowserIdentity(identityId));
  }

  async deleteIdentity(idOrName: string, identityId: string): Promise<void> {
    const { dotId, guest } = await this.#runningGuest(idOrName);
    await this.#guestCall(dotId, "delete a browser identity", () => guest.deleteBrowserIdentity(identityId));
  }

  // Approvals

  listApprovals(status?: ApprovalStatus): Promise<ApprovalRecord[]> {
    return this.db.approvals.list({ status });
  }

  /**
   * Record the decision, move the task back to RUNNING and store the
   * `approval.received` for the guest, in one transaction: a decision the
   * person saw accepted always reaches the guest, also when the Dot sleeps
   * and its wake fails or the control plane restarts first.
   */
  async resolveApproval(id: string, decision: "approve" | "reject", note?: string): Promise<ApprovalRecord> {
    if (note !== undefined && typeof note !== "string") {
      throw new ControlPlaneError(400, "invalid_request", "note must be a string");
    }
    const existing = await this.db.approvals.get(id);
    if (!existing) throw notFound("approval", id);
    const event: InboundEvent<"approval.received"> = {
      id: newId("evt"),
      type: "approval.received",
      ts: this.#clock.now().toISOString(),
      data: { approval_id: id, decision, ...(note !== undefined ? { note } : {}) },
    };
    const { logged, resolved } = await this.db.transaction(async (tx) => {
      // The event first: its insert takes the event-order lock (database events.ts).
      const logged = await this.events.appendHostIn(tx, existing.dot_id, "approval.resolved", {
        approval_id: id,
        decision,
        ...(note !== undefined ? { note } : {}),
      });
      const resolved = await tx.approvals.resolve(id, decision === "approve" ? "approved" : "rejected", note ?? null);
      if (!resolved) {
        const current = await tx.approvals.get(id);
        throw new ControlPlaneError(409, "already_resolved", `approval ${id} is already ${current?.status ?? existing.status}`);
      }
      if (resolved.task_id) await tx.tasks.transition(resolved.task_id, "RUNNING", { dotId: resolved.dot_id });
      await tx.inbound.enqueue(resolved.dot_id, event);
      return { logged, resolved };
    });
    this.events.publish(logged);
    await this.#deliver(resolved.dot_id, event.id);
    return resolved;
  }

  // Events and secrets

  async listEvents(idOrName: string, after?: number, limit?: number): Promise<StoredEvent[]> {
    const dot = await this.db.dots.resolve(idOrName);
    // A deleted Dot's history stays readable by id.
    const dotId = dot?.id ?? (idOrName.includes("_") ? idOrName : undefined);
    if (!dotId) throw notFound("Dot", idOrName);
    return this.events.query({ dotId, after, limit });
  }

  /** Store the OpenRouter key (global or per Dot) and push it to the READY guests it applies to. */
  async setOpenRouterKey(value: unknown, dotIdOrName?: unknown): Promise<{ pushed: number }> {
    const checked = checkOpenRouterKey(value);
    if (!checked.ok) throw new ControlPlaneError(400, "invalid_request", checked.problem);
    let scope = GLOBAL_SCOPE;
    if (dotIdOrName !== undefined && dotIdOrName !== null) {
      if (typeof dotIdOrName !== "string") throw new ControlPlaneError(400, "invalid_request", "dot_id must be a string");
      scope = (await this.requireDot(dotIdOrName)).id;
    }
    await this.db.secrets.put(scope, OPENROUTER_KEY_NAME, checked.key);
    let pushed = 0;
    // Every Dot it applies to, READY or not: one whose READY is under way must notice the change too.
    const targets = scope === GLOBAL_SCOPE ? (await this.db.dots.list()).map((d) => d.id) : [scope];
    for (const dotId of targets) {
      try {
        if (await this.lifecycle.syncGuest(dotId)) pushed++;
      } catch (error) {
        this.#log.warn("could not push the new OpenRouter key", { dotId, error: errorMessage(error) });
        this.lifecycle.markSuspect(dotId);
      }
    }
    // Dots that failed READY only for want of a key can be retried now.
    for (const dot of await this.db.dots.list()) {
      const missedKey = dot.error?.includes(MISSING_KEY_MESSAGE) ?? false;
      if (dot.status === "ERROR" && missedKey && (scope === GLOBAL_SCOPE || scope === dot.id)) {
        this.#runInBackground("READY after a new key", dot.id, () => this.lifecycle.ensureReady(dot.id));
      }
    }
    return { pushed };
  }

  // Idle sleep (section 9.5)

  /**
   * Put every Dot to sleep that is READY with an IDLE agent, has no work
   * (no due or active task, nothing waiting to reach its guest), and was not
   * active for its `idle_timeout`. Returns the ids of the Dots it started
   * stopping; the stop checks all of it again under the Dot's lock and is
   * called off when work arrived meanwhile.
   */
  async idleCheck(): Promise<string[]> {
    const now = this.#clock.now();
    const sleeping: string[] = [];
    for (const dotId of this.lifecycle.readyDots()) {
      if (this.lifecycle.isBusy(dotId) || this.inbound.isFlushing(dotId)) continue;
      const [dot, computer] = await Promise.all([this.db.dots.get(dotId), this.db.computers.get(dotId)]);
      if (!dot || !computer || computer.state !== "RUNNING" || dot.status !== "READY") continue;
      const timeout = computerResources(dot.config).idleTimeoutMs;
      if (timeout === null) continue;
      const lastActive = new Date(computer.last_active_at ?? computer.updated_at).getTime();
      if (now.getTime() - lastActive < timeout) continue;
      if (await this.db.tasks.hasWork(dotId, now)) continue;
      this.#log.info("dot idle, going to sleep", { dotId, idleMs: now.getTime() - lastActive });
      sleeping.push(dotId);
      this.#runInBackground("idle sleep", dotId, () => this.lifecycle.stop(dotId, "idle"));
    }
    return sleeping;
  }

  /** The database answers, and whether the global OpenRouter key is stored (and decrypts). */
  async health(): Promise<{ database: "ok"; openrouter_configured: boolean }> {
    let key: string | null;
    try {
      key = await this.db.secrets.get(GLOBAL_SCOPE, OPENROUTER_KEY_NAME);
    } catch (error) {
      throw new ControlPlaneError(503, "database_unavailable", `the database did not answer: ${errorMessage(error)}`);
    }
    return { database: "ok", openrouter_configured: key !== null };
  }
}
