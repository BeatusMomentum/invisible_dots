/**
 * The control plane's operations, one method per thing the API can ask for.
 * The API is a thin HTTP layer over this class; everything that touches the
 * database, the VM layer or a guest happens here.
 */
import { randomBytes } from "node:crypto";
import { DotNameTakenError, isUniqueViolation, type Database } from "@invisible-dots/database";
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
  computerResources,
  DEFAULT_CID_BASE,
  domainName,
  DotConfigError,
  newId,
  parseDotConfig,
  parseSize,
  TASK_CANCELLED_SYSTEM_EVENT,
  TERMINAL_TASK_STATES,
  type ApprovalStatus,
  type BrowserIdentity,
  type CreateBrowserIdentityRequest,
  type DotConfig,
  type InboundEvent,
  type StoredEvent,
  type SystemAnswer,
} from "@invisible-dots/shared";
import { Dispatcher, type DispatcherOptions } from "./dispatcher.js";
import { guestErrorCode, guestErrorStatus, type ComputerDriver, type GuestApi } from "./driver.js";
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
  /** First vsock CID to allocate (INVISIBLE_DOTS_CID_BASE, default 10000). */
  cidBase?: number;
  /** How often PENDING tasks are looked for besides the immediate pass on every change. Default 5 s. */
  dispatchIntervalMs?: number;
  /** How often idle Dots are looked for. Default 30 s. */
  idleCheckIntervalMs?: number;
  lifecycle?: Partial<LifecycleOptions>;
  dispatcher?: Partial<DispatcherOptions>;
}

const TOKEN_BYTES = 32;
const MAX_CID_RACE_RETRIES = 5;

export class Scheduler {
  readonly db: Database;
  readonly events: EventLog;
  readonly lifecycle: Lifecycle;
  readonly dispatcher: Dispatcher;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #cidBase: number;
  readonly #dispatchIntervalMs: number;
  readonly #idleCheckIntervalMs: number;
  readonly #background = new Set<Promise<unknown>>();
  /** Inbound events per Dot, delivered in order once the Dot is READY. */
  readonly #inbound = new Map<string, Promise<void>>();
  readonly #provisioning = new Map<string, Promise<void>>();
  readonly #timers: NodeJS.Timeout[] = [];
  #started = false;

  constructor(options: SchedulerOptions) {
    this.db = options.db;
    this.#clock = options.clock ?? systemClock;
    this.#log = options.logger ?? silentLogger;
    this.events =
      options.events ?? new EventLog(options.db.events, (line) => this.#log.warn(line));
    this.#cidBase = options.cidBase ?? DEFAULT_CID_BASE;
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
    });
    this.dispatcher = new Dispatcher(options.db, this.lifecycle, this.#clock, this.#log, options.dispatcher);
  }

  /** Recover from the previous run, then start the dispatch and idle timers. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    for (const run of await this.db.tasks.interruptedRuns()) {
      this.#log.warn("recovery: task was claimed but never delivered, back to the queue", { taskId: run.task_id });
      await this.db.tasks.requeue(run.task_id, run.id, "interrupted by a control plane restart", null);
    }
    for (const work of await this.lifecycle.recover()) this.#track(work);
    this.#track(this.dispatcher.dispatch());
    const every = (ms: number, fn: () => Promise<unknown>) => {
      const timer = setInterval(() => void fn().catch((e) => this.#log.error("timer failed", { error: errorMessage(e) })), ms);
      timer.unref();
      this.#timers.push(timer);
    };
    every(this.#dispatchIntervalMs, () => this.dispatcher.dispatch());
    every(this.#idleCheckIntervalMs, () => this.idleCheck());
  }

  /** Stop the timers and the event pumps and wait for in-flight work. VMs keep running. */
  async close(): Promise<void> {
    for (const timer of this.#timers.splice(0)) clearInterval(timer);
    await this.settle().catch(() => {});
    await this.lifecycle.close();
  }

  /** Wait until every background operation started so far has finished (used by tests and shutdown). */
  async settle(): Promise<void> {
    for (;;) {
      await this.dispatcher.settle();
      const pending = [...this.#background, ...this.#inbound.values()];
      if (pending.length === 0) return;
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

  /** Section 9.4: insert the Dot as CREATING with its CID and token, then provision it in the background. */
  async createDot(configInput: unknown): Promise<DotRecord> {
    const config = this.#parseConfig(configInput);
    const id = newId("dot");
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    let dot: DotRecord | undefined;
    const excluded: number[] = [];
    for (let attempt = 1; !dot; attempt++) {
      try {
        dot = await this.db.transaction(async (tx) => {
          const record = await tx.dots.insert({ id, config, status: "CREATING" });
          const cid = await tx.computers.nextFreeCid(this.#cidBase, excluded);
          excluded.push(cid);
          await tx.computers.insert({ dotId: id, domainName: domainName(id), cid, state: "PROVISIONING", token });
          return record;
        });
      } catch (error) {
        if (error instanceof DotNameTakenError) throw new ControlPlaneError(409, "name_taken", error.message);
        // Another Dot took the same CID between our read and our insert: take the next one.
        if (isUniqueViolation(error, "computers_cid_key") && attempt < MAX_CID_RACE_RETRIES) continue;
        throw error;
      }
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
      pushed = await this.lifecycle.pushConfig(current.id);
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

  async sendMessage(idOrName: string, text: string): Promise<MessageAnswer> {
    if (typeof text !== "string" || text.trim() === "") {
      throw new ControlPlaneError(400, "invalid_request", "text must be a non-empty string");
    }
    const dot = await this.requireDot(idOrName);
    const messageId = newId("msg");
    const stored = await this.events.appendUserMessage(dot.id, { message_id: messageId, text });
    const event: InboundEvent<"user.message"> = {
      id: messageId,
      type: "user.message",
      ts: this.#clock.now().toISOString(),
      data: { text },
    };
    const delivery = await this.#deliverInbound(dot.id, event);
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
   * Deliver an inbound event: at once when the Dot is READY and nothing is
   * queued before it, otherwise in the background after waking it, in the
   * order the events arrived.
   */
  async #deliverInbound(dotId: string, event: InboundEvent): Promise<"delivered" | "queued"> {
    if (!this.#inbound.has(dotId) && this.lifecycle.isReady(dotId)) {
      try {
        await this.#post(dotId, event);
        return "delivered";
      } catch (error) {
        this.#log.warn("direct delivery failed, queueing", { dotId, type: event.type, error: errorMessage(error) });
      }
    }
    const previous = this.#inbound.get(dotId) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await this.#provisioning.get(dotId)?.catch(() => {});
        await this.lifecycle.ensureReady(dotId);
        await this.#post(dotId, event);
        this.#log.info("queued event delivered", { dotId, type: event.type, id: event.id });
      } catch (error) {
        this.#log.error("queued event could not be delivered and was dropped", {
          dotId,
          type: event.type,
          id: event.id,
          error: errorMessage(error),
        });
      }
    });
    this.#inbound.set(dotId, next);
    void next.finally(() => {
      if (this.#inbound.get(dotId) === next) this.#inbound.delete(dotId);
    });
    return "queued";
  }

  async #post(dotId: string, event: InboundEvent): Promise<void> {
    try {
      await (await this.lifecycle.guest(dotId)).postEvent(event);
    } catch (error) {
      this.lifecycle.markSuspect(dotId);
      throw error;
    }
    await this.db.computers.touch(dotId, this.#clock.now());
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
   * Cancel a task. A PENDING one simply never runs. For one the guest already
   * has, the contract has no dedicated inbound event, so the guest is told
   * with `system.event { name: "task.cancelled" }` when it is reachable.
   */
  async cancelTask(id: string): Promise<TaskRecord> {
    const task = await this.getTask(id);
    if (TERMINAL_TASK_STATES.includes(task.status)) {
      throw new ControlPlaneError(409, "task_finished", `task ${id} is already ${task.status}`);
    }
    const cancelled = await this.db.tasks.transition(id, "CANCELLED", { error: "cancelled by the user" });
    if (!cancelled) throw new ControlPlaneError(409, "task_finished", `task ${id} finished meanwhile`);
    await this.events.appendHost(task.dot_id, "task.cancelled", { task_id: id });
    if (task.status !== "PENDING" && this.lifecycle.isReady(task.dot_id)) {
      const event: InboundEvent<"system.event"> = {
        id: newId("evt"),
        type: "system.event",
        ts: this.#clock.now().toISOString(),
        data: { name: TASK_CANCELLED_SYSTEM_EVENT, data: { task_id: id } },
      };
      await this.#post(task.dot_id, event).catch((error) =>
        this.#log.warn("could not tell the guest about a cancelled task", { taskId: id, error: errorMessage(error) }),
      );
    }
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

  async resolveApproval(id: string, decision: "approve" | "reject", note?: string): Promise<ApprovalRecord> {
    if (note !== undefined && typeof note !== "string") {
      throw new ControlPlaneError(400, "invalid_request", "note must be a string");
    }
    const existing = await this.db.approvals.get(id);
    if (!existing) throw notFound("approval", id);
    const resolved = await this.db.approvals.resolve(id, decision === "approve" ? "approved" : "rejected", note ?? null);
    if (!resolved) throw new ControlPlaneError(409, "already_resolved", `approval ${id} is already ${existing.status}`);
    if (resolved.task_id) await this.db.tasks.transition(resolved.task_id, "RUNNING", { dotId: resolved.dot_id });
    await this.events.appendHost(resolved.dot_id, "approval.resolved", {
      approval_id: id,
      decision,
      ...(note !== undefined ? { note } : {}),
    });
    const event: InboundEvent<"approval.received"> = {
      id: newId("evt"),
      type: "approval.received",
      ts: this.#clock.now().toISOString(),
      data: { approval_id: id, decision, ...(note !== undefined ? { note } : {}) },
    };
    await this.#deliverInbound(resolved.dot_id, event);
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
    if (typeof value !== "string" || value.trim() === "") {
      throw new ControlPlaneError(400, "invalid_request", "value must be a non-empty string");
    }
    let scope = "global";
    if (dotIdOrName !== undefined && dotIdOrName !== null) {
      if (typeof dotIdOrName !== "string") throw new ControlPlaneError(400, "invalid_request", "dot_id must be a string");
      scope = (await this.requireDot(dotIdOrName)).id;
    }
    await this.db.secrets.put(scope, "openrouter_api_key", value.trim());
    let pushed = 0;
    const targets = scope === "global" ? this.lifecycle.readyDots() : [scope];
    for (const dotId of targets) {
      try {
        if (await this.lifecycle.pushSecret(dotId)) pushed++;
      } catch (error) {
        this.#log.warn("could not push the new OpenRouter key", { dotId, error: errorMessage(error) });
        this.lifecycle.markSuspect(dotId);
      }
    }
    // Dots that failed READY only for want of a key can be retried now.
    for (const dot of await this.db.dots.list()) {
      const missedKey = dot.error?.includes(MISSING_KEY_MESSAGE) ?? false;
      if (dot.status === "ERROR" && missedKey && (scope === "global" || scope === dot.id)) {
        this.#runInBackground("READY after a new key", dot.id, () => this.lifecycle.ensureReady(dot.id));
      }
    }
    return { pushed };
  }

  // Idle sleep (section 9.5)

  /**
   * Put every Dot to sleep that is READY with an IDLE agent, has no due or
   * active task, and was not active for its `idle_timeout`. Returns the ids
   * of the Dots it started stopping.
   */
  async idleCheck(): Promise<string[]> {
    const now = this.#clock.now();
    const sleeping: string[] = [];
    for (const dotId of this.lifecycle.readyDots()) {
      if (this.lifecycle.isBusy(dotId) || this.#inbound.has(dotId)) continue;
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

  async health(): Promise<{ database: "ok" }> {
    try {
      await this.db.ping();
    } catch (error) {
      throw new ControlPlaneError(503, "database_unavailable", `the database did not answer: ${errorMessage(error)}`);
    }
    return { database: "ok" };
  }
}
