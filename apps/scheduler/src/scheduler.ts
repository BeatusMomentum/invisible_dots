/**
 * The control plane's operations, one method per thing the API can ask for.
 * The API is a thin HTTP layer over this class; everything that touches the
 * database, the VM layer or a guest happens here.
 */
import { randomBytes } from "node:crypto";
import { DotChangedError, DotNameTakenError, GLOBAL_SCOPE, OPENROUTER_KEY_NAME, type Database } from "@invisible-dots/database";
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
  UsageAnswer,
} from "@invisible-dots/shared";
import {
  checkHomePath,
  checkOpenRouterKey,
  computerResources,
  DotConfigError,
  isPermission,
  isStoredEventType,
  MAX_HOST_FILE_BYTES,
  newId,
  parseDotConfig,
  parseMessageOrigin,
  parseSize,
  TASK_CANCELLED_SYSTEM_EVENT,
  TERMINAL_TASK_STATES,
  vmName,
  type ApprovalStatus,
  type Automation,
  type BrowserIdentity,
  type CreateBrowserIdentityRequest,
  type DotConfig,
  type FilesListAnswer,
  type InboundEvent,
  type MessageOrigin,
  type StoredEvent,
  type SystemAnswer,
  type ToolInfo,
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

/**
 * The engine's browser answers that carry a code with a status that is not a 4xx (architecture section 5, the
 * identity routes): `busy` while a call holds the browser, and the three failures of a browser itself. They pass
 * through to the API as they are.
 */
const ENGINE_BROWSER_ANSWERS: Readonly<Record<string, number>> = {
  busy: 503,
  frame_failed: 502,
  crashed: 502,
  launch_failed: 502,
};

/** A path the files routes may read, normalized; the 400 of the rule of `checkHomePath` otherwise. */
function homePath(raw: unknown): string {
  const checked = checkHomePath(raw);
  if (!checked.ok) throw new ControlPlaneError(400, "invalid_path", checked.problem);
  return checked.path;
}

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

  /**
   * Replace the Dot's config. `expectedConfigVersion` (the `config_version` of the Dot as the caller read it) makes the
   * save conditional: when the config changed since (the person answered "Always allow" in another view, another
   * save), it is a 409 `dot_changed` and nothing is written, so a form opened before cannot silently undo what
   * happened after. A change of the Dot's status (a task turn, an approval waiting) is not a change of the config.
   */
  async updateDot(idOrName: string, configInput: unknown, expectedConfigVersion?: unknown): Promise<DotRecord> {
    if (expectedConfigVersion !== undefined && (typeof expectedConfigVersion !== "number" || !Number.isInteger(expectedConfigVersion) || expectedConfigVersion < 1)) {
      throw new ControlPlaneError(400, "invalid_request", "expected_config_version must be the config_version of the Dot, a positive integer");
    }
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
      updated = await this.db.dots.updateConfig(current.id, config, expectedConfigVersion);
    } catch (error) {
      if (error instanceof DotChangedError) {
        throw new ControlPlaneError(409, "dot_changed", `Dot ${current.name} changed after you read it: read it again and apply the change to what it is now`);
      }
      if (error instanceof DotNameTakenError) throw new ControlPlaneError(409, "name_taken", error.message);
      throw error;
    }
    if (!updated) throw notFound("Dot", idOrName);
    await this.#configChanged(updated);
    return updated;
  }

  /**
   * The Dot's saved config changed (a PATCH, an "always allow"): push it to the guest like a PATCH does and log
   * `dot.updated`. A failed push does not fail the change: the config is pushed again on the next READY.
   */
  async #configChanged(dot: DotRecord): Promise<void> {
    let pushed = false;
    try {
      pushed = await this.lifecycle.syncGuest(dot.id);
    } catch (error) {
      this.#log.warn("config saved but the push to the guest failed; it is pushed again on the next READY", {
        dotId: dot.id,
        error: errorMessage(error),
      });
      this.lifecycle.markSuspect(dot.id);
    }
    await this.events.appendHost(dot.id, "dot.updated", { name: dot.name, pushed_to_guest: pushed });
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
   * failed wake or a control plane restart. `origin` names the channel chat
   * the message came from; it is kept in the event log (the one place a reply
   * is routed back by) and never sent to the guest. Only code inside the
   * control plane passes one: the HTTP route does not take it.
   */
  async sendMessage(idOrName: string, text: string, origin?: MessageOrigin): Promise<MessageAnswer> {
    if (typeof text !== "string" || text.trim() === "") {
      throw new ControlPlaneError(400, "invalid_request", "text must be a non-empty string");
    }
    if (origin !== undefined && parseMessageOrigin(origin) === null) {
      throw new ControlPlaneError(400, "invalid_request", "origin must be a channel, a binding id, a chat id and an external id");
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
      // The event first: its insert takes the event-order lock (database events.ts). A channel message
      // already logged is not stored again, so what a redelivery finds is exactly what the first delivery
      // committed: the message and its queue row together, or neither.
      const logged = await this.events.appendUserMessageIn(tx, dot.id, { message_id: messageId, text, ...(origin && { origin }) });
      if (logged) await tx.inbound.enqueue(dot.id, event);
      return logged;
    });
    if (!stored) return this.#answerRedelivery(dot.id, origin!);
    this.events.publish(stored);
    const delivery = await this.#deliver(dot.id, event.id);
    return { message_id: messageId, event_id: stored.id, delivery };
  }

  /** The answer for a channel message that was already handed to the Dot: the same message, delivered if it is not yet. */
  async #answerRedelivery(dotId: string, origin: MessageOrigin): Promise<MessageAnswer> {
    const logged = await this.events.userMessageOfOrigin(dotId, origin.binding_id, origin.external_id);
    const messageId = logged?.data.message_id;
    if (!logged || typeof messageId !== "string") throw new Error(`a channel message is stored twice but cannot be found: ${origin.binding_id}`);
    return { message_id: messageId, event_id: logged.id, delivery: await this.#deliver(dotId, messageId) };
  }

  async conversation(idOrName: string, limit = 500): Promise<ConversationMessage[]> {
    const dot = await this.requireDot(idOrName);
    const events = await this.events.query({
      dotId: dot.id,
      types: [USER_MESSAGE_EVENT, "message.assistant"],
      limit,
    });
    return events.map((e) => {
      // StoredEvent.type lists the contract's event types; the user side is logged as USER_MESSAGE_EVENT.
      const user = (e.type as string) === USER_MESSAGE_EVENT;
      const origin = user ? parseMessageOrigin(e.data.origin) : null;
      return {
        event_id: e.id,
        role: user ? "user" : "assistant",
        text: String(e.data.text ?? ""),
        in_reply_to: typeof e.data.in_reply_to === "string" ? e.data.in_reply_to : null,
        ...(origin && { origin }),
        created_at: e.created_at,
      };
    });
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

  /**
   * Run a guest call and turn its failure into an API error: the guest's own 4xx passes through, and so do the
   * engine's coded browser answers that are not 4xx (`ENGINE_BROWSER_ANSWERS`): a coded answer is the engine
   * speaking, not a silence, so the UI can tell a busy or crashed browser from an unreachable computer.
   */
  async #guestCall<T>(dotId: string, what: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const status = guestErrorStatus(error);
      const code = guestErrorCode(error);
      if ((status >= 400 && status < 500 && status !== 401) || (code !== undefined && ENGINE_BROWSER_ANSWERS[code] === status)) {
        throw new ControlPlaneError(status, code ?? "guest_error", errorMessage(error));
      }
      this.#log.warn("guest call failed", { dotId, what, error: errorMessage(error) });
      throw new ControlPlaneError(502, "guest_unavailable", `${what}: the Dot's computer did not answer: ${errorMessage(error)}`);
    }
  }

  async screenshot(idOrName: string): Promise<Uint8Array> {
    const { dotId, guest } = await this.#runningGuest(idOrName);
    return this.#guestCall(dotId, "screenshot", () => guest.screenshot());
  }

  /** The files of a directory under /home/dot, as dot-agentd lists them; `path` defaults to home itself. */
  async listFiles(idOrName: string, path: string = "~"): Promise<FilesListAnswer> {
    const checked = homePath(path);
    const { dotId, guest } = await this.#runningGuest(idOrName);
    const { entries } = await this.#guestCall(dotId, "list files", () => guest.listFiles(checked));
    return { path: checked, entries };
  }

  /** The bytes of a file under /home/dot; a file larger than MAX_HOST_FILE_BYTES is a 413. */
  async readFile(idOrName: string, path: unknown): Promise<{ path: string; content: Uint8Array }> {
    const checked = homePath(path);
    const { dotId, guest } = await this.#runningGuest(idOrName);
    const content = await this.#guestCall(dotId, "read a file", () => guest.readFile(checked, { maxBytes: MAX_HOST_FILE_BYTES }));
    return { path: checked, content };
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

  /** The JPEG of an open identity's window: 409 `not_open` when it is closed, 503 `busy` while a call holds it. */
  async identityFrame(idOrName: string, identityId: string): Promise<Uint8Array> {
    const { dotId, guest } = await this.#runningGuest(idOrName);
    return this.#guestCall(dotId, "get the frame of a browser identity", () => guest.getBrowserIdentityFrame(identityId));
  }

  async closeIdentity(idOrName: string, identityId: string): Promise<void> {
    const { dotId, guest } = await this.#runningGuest(idOrName);
    await this.#guestCall(dotId, "close a browser identity", () => guest.closeBrowserIdentity(identityId));
  }

  // Automations and tools: what the Dot's engine keeps (its cron jobs, its tool table), through the computer

  async listAutomations(idOrName: string): Promise<Automation[]> {
    const { dotId, guest } = await this.#runningGuest(idOrName);
    return (await this.#guestCall(dotId, "list automations", () => guest.listAutomations())).automations;
  }

  /** Pause (`enabled: false`) or resume an automation; the answer is the automation as it is now. */
  async setAutomationEnabled(idOrName: string, automationId: string, enabled: unknown): Promise<Automation> {
    if (typeof enabled !== "boolean") throw new ControlPlaneError(400, "invalid_request", "enabled must be true or false");
    const { dotId, guest } = await this.#runningGuest(idOrName);
    return this.#guestCall(dotId, "set an automation", () => guest.setAutomationEnabled(automationId, enabled));
  }

  async deleteAutomation(idOrName: string, automationId: string): Promise<void> {
    const { dotId, guest } = await this.#runningGuest(idOrName);
    await this.#guestCall(dotId, "delete an automation", () => guest.deleteAutomation(automationId));
  }

  /** The Dot's tools, each with the permission it exercises and whether the model is offered it now. */
  async listTools(idOrName: string): Promise<ToolInfo[]> {
    const { dotId, guest } = await this.#runningGuest(idOrName);
    return (await this.#guestCall(dotId, "list tools", () => guest.listTools())).tools;
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
   *
   * `always` (an approval only) is "allow this from now on": in the same
   * transaction `permissions[<the approval's permission>]` becomes `allow` in
   * the Dot's config, and the config is pushed to the guest before the answer
   * is delivered, so what the approved call does next is not asked again: the
   * Dot's deliveries are held (`InboundDelivery.hold`) from before the commit
   * until the push is over, so no flush overtakes it. A push that fails does
   * not fail the answer; the guest gets the config on its next READY. An
   * answer that loses the race for the approval (409) changes nothing.
   */
  async resolveApproval(
    id: string,
    decision: "approve" | "reject",
    answer: { note?: string; always?: true } = {},
  ): Promise<ApprovalRecord> {
    const { note, always } = answer;
    if (note !== undefined && typeof note !== "string") {
      throw new ControlPlaneError(400, "invalid_request", "note must be a string");
    }
    if (always !== undefined && always !== true) {
      throw new ControlPlaneError(400, "invalid_request", "always must be true");
    }
    if (always && decision !== "approve") {
      throw new ControlPlaneError(400, "invalid_request", "always applies to an approval, not to a rejection");
    }
    const existing = await this.db.approvals.get(id);
    if (!existing) throw notFound("approval", id);
    // A pending approval stored before its permission was removed from PERMISSIONS: a config cannot name it any more.
    if (always && !isPermission(existing.permission)) {
      throw new ControlPlaneError(
        400,
        "invalid_request",
        `"${existing.permission}" is not a permission a Dot's config can set, so it cannot be allowed for good`,
      );
    }
    const event: InboundEvent<"approval.received"> = {
      id: newId("evt"),
      type: "approval.received",
      ts: this.#clock.now().toISOString(),
      data: { approval_id: id, decision, ...(note !== undefined ? { note } : {}) },
    };
    // From its commit on, any flush may send the answer: the Dot's deliveries wait until the config that "always"
    // changed has reached the guest, so the approved call's next use of the permission is not asked again.
    const release = always ? this.inbound.hold(existing.dot_id) : undefined;
    let resolved: ApprovalRecord;
    try {
      const stored = await this.db.transaction(async (tx) => {
        // The event first: its insert takes the event-order lock (database events.ts).
        const logged = await this.events.appendHostIn(tx, existing.dot_id, "approval.resolved", {
          approval_id: id,
          decision,
          ...(note !== undefined ? { note } : {}),
          ...(always ? { always } : {}),
        });
        const resolved = await tx.approvals.resolve(id, decision === "approve" ? "approved" : "rejected", note ?? null);
        if (!resolved) {
          const current = await tx.approvals.get(id);
          throw new ControlPlaneError(409, "already_resolved", `approval ${id} is already ${current?.status ?? existing.status}`);
        }
        const reconfigured = always ? await tx.dots.setPermission(resolved.dot_id, resolved.permission, "allow") : null;
        if (always && !reconfigured) throw notFound("Dot", resolved.dot_id);
        if (resolved.task_id) await tx.tasks.transition(resolved.task_id, "RUNNING", { dotId: resolved.dot_id });
        await tx.inbound.enqueue(resolved.dot_id, event);
        return { logged, resolved, reconfigured };
      });
      resolved = stored.resolved;
      this.events.publish(stored.logged);
      if (stored.reconfigured) await this.#configChanged(stored.reconfigured);
    } finally {
      release?.();
    }
    await this.#deliver(resolved.dot_id, event.id);
    return resolved;
  }

  // Events and secrets

  /** The id of a Dot whose history is read: a deleted Dot's history stays readable by id. */
  async #historyDotId(idOrName: string): Promise<string> {
    const dot = await this.db.dots.resolve(idOrName);
    const dotId = dot?.id ?? (idOrName.includes("_") ? idOrName : undefined);
    if (!dotId) throw notFound("Dot", idOrName);
    return dotId;
  }

  /**
   * The Dot's events, oldest first: those after an id, of these types (an unknown type name is a 400, so a typo
   * does not look like a quiet Dot) and of this task.
   */
  async listEvents(
    idOrName: string,
    filter: { after?: number; limit?: number; types?: readonly string[]; taskId?: string } = {},
  ): Promise<StoredEvent[]> {
    const unknown = filter.types?.filter((type) => !isStoredEventType(type)) ?? [];
    if (unknown.length > 0) throw new ControlPlaneError(400, "invalid_request", `unknown event type: ${unknown.join(", ")}`);
    if (filter.taskId === "") throw new ControlPlaneError(400, "invalid_request", "task_id must not be empty");
    const types = filter.types === undefined || filter.types.length === 0 ? undefined : filter.types;
    return this.events.query({ dotId: await this.#historyDotId(idOrName), after: filter.after, limit: filter.limit, types, taskId: filter.taskId });
  }

  /** The model spend the Dot's guest reported since `since` (every event when omitted), from the event log. */
  async usage(idOrName: string, since?: Date): Promise<UsageAnswer> {
    const dotId = await this.#historyDotId(idOrName);
    return { dot_id: dotId, since: since?.toISOString() ?? null, spent_usd: await this.db.events.spentUsd(dotId, since) };
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
