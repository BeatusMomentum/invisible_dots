/**
 * The Dot's state machine (architecture sections 8.1 to 8.6).
 *
 * Work is event driven: `accept()` records an inbound event and wakes a single
 * worker, which runs one unit of work at a time, either a chat turn on the
 * shared conversation or a task on its own thread, through the
 * {@link AgentRunner}. Everything a unit needs to continue lives in `dot.db`:
 * the thread messages, the task row, the pending approval and the run record.
 * That is what makes a restart, a sleep or an approval that takes a day all
 * the same case: the runner reads the thread, finds the tool calls that have
 * no result yet, and carries on.
 */
import { OpenRouterError, type ChatModel } from "@invisible-dots/openrouter-client";
import { CONVERSATION_THREAD, type DotStore } from "@invisible-dots/memory";
import {
  SYSTEM_PROMPT_MEMORY_KEYS,
  TASK_CANCELLED_SYSTEM_EVENT,
  WORKING_MEMORY_MESSAGES,
  parseRuntimeConfig,
  type AgentState,
  type AgentStateAnswer,
  type BrowserIdentity,
  type DotRuntimeConfig,
  type InboundEvent,
} from "@invisible-dots/shared";
import { TaskQueue } from "@invisible-dots/task-runtime";
import { AgentRunner, type RunnerDeps } from "../agent/runner.js";
import { DurableApprovalLedger } from "../approval/durable.js";
import { UnitAbort, abortReason } from "../errors.js";
import { Checkpoint } from "../memory/checkpoint.js";
import { RunLedger } from "../run/ledger.js";
import { describeRun, type RunRecord } from "../run/record.js";
import { ToolExecutor } from "../tool/executor.js";
import type { ToolRegistry } from "../tool/framework.js";
import { silentLogger, type Logger, type ThreadMessage } from "../types.js";
import { buildSystemPrompt, taskSeedMessage } from "./prompt.js";
import { toRequestMessages, trimThread } from "./request.js";

export interface DotRuntimeOptions {
  store: DotStore;
  registry: ToolRegistry;
  model: ChatModel;
  logger?: Logger;
  now?: () => Date;
  /** Identities listed in the system prompt; defaults to the store's table. */
  identities?: () => readonly BrowserIdentity[];
}

type UnitOutcome = "finished" | "suspended";

const KEY_RUNTIME_CONFIG = "runtime_config";

export class DotRuntime {
  readonly #store: DotStore;
  readonly #registry: ToolRegistry;
  readonly #model: ChatModel;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #identities: () => readonly BrowserIdentity[];
  readonly #queue: TaskQueue;
  readonly #ledger: RunLedger;
  readonly #approvals: DurableApprovalLedger;
  readonly #checkpoint: Checkpoint;
  readonly #deps: RunnerDeps;

  #config: DotRuntimeConfig | null = null;
  #state: AgentState = "IDLE";
  #started = false;
  #suspended = false;
  #stopped = false;
  #worker: Promise<void> | null = null;
  #rerun = false;
  #controller: AbortController | null = null;
  #activeTaskId: string | null = null;
  #waitingForKeyLogged = false;

  constructor(options: DotRuntimeOptions) {
    this.#store = options.store;
    this.#registry = options.registry;
    this.#model = options.model;
    this.#log = options.logger ?? silentLogger;
    this.#now = options.now ?? (() => new Date());
    this.#identities = options.identities ?? (() => this.#store.listIdentities());
    this.#queue = new TaskQueue(this.#store, { now: this.#now });
    this.#ledger = new RunLedger(this.#store, this.#queue);
    this.#approvals = new DurableApprovalLedger(this.#store, this.#queue);
    this.#checkpoint = new Checkpoint(this.#store, this.#queue, this.#ledger, this.#approvals);
    this.#deps = {
      model: this.#model,
      executor: new ToolExecutor(this.#registry, this.#log),
      checkpoint: this.#checkpoint,
      approvals: this.#approvals,
      ledger: this.#ledger,
      log: this.#log,
      emit: (event) => {
        this.#store.appendEvent(event.type, event.data as never);
      },
    };
  }

  get state(): AgentState {
    return this.#state;
  }

  get started(): boolean {
    return this.#started;
  }

  get config(): DotRuntimeConfig | null {
    return this.#config;
  }

  get tasks(): TaskQueue {
    return this.#queue;
  }

  /**
   * Load the persisted config and work, announce the current state and resume
   * whatever was in flight when the process last stopped.
   */
  start(): void {
    if (this.#started) return;
    const stored = this.#store.getConfig<unknown>(KEY_RUNTIME_CONFIG);
    if (stored !== undefined) {
      try {
        this.#config = parseRuntimeConfig(stored);
      } catch (error) {
        this.#log.error("stored runtime config is invalid; waiting for PUT /config", { error: errorText(error) });
      }
    }
    const resumed = this.#ledger.adoptOrphan();
    if (resumed) this.#log.info("resuming work interrupted by the last stop", describeRun(resumed));
    if (resumed?.kind === "task") this.#activeTaskId = resumed.taskId;
    this.#started = true;
    // The host pushes the OpenRouter key again when it sees this: a restart of
    // this process inside a running VM loses it, since it lives in memory only.
    this.#store.appendEvent("agent.started", {});
    // The outbox may end on THINKING from before the stop; say where we really are.
    this.#emitState(this.#approvals.pending() ? "WAITING_APPROVAL" : "IDLE", true);
    this.#kick();
  }

  /** Validate, persist and apply a runtime config (`PUT /config`). */
  setConfig(input: unknown): DotRuntimeConfig {
    const config = parseRuntimeConfig(input);
    this.#store.setConfig(KEY_RUNTIME_CONFIG, config);
    this.#config = config;
    this.#log.info("runtime config updated", { name: config.name, model: config.model.id });
    this.#kick();
    return config;
  }

  /**
   * The OpenRouter key arrived (`POST /secrets`). The host pushes it on every
   * READY transition and only to a guest it considers READY, so it also ends
   * a suspension from a prepare-sleep that was not followed by a shutdown
   * (the stop failed and the VM kept running): work that waited can go on.
   */
  modelConfigured(): void {
    this.#waitingForKeyLogged = false;
    if (this.#suspended && !this.#stopped) this.#log.info("resuming work: the host pushed the key, so no shutdown is coming");
    this.#suspended = false;
    this.#kick();
  }

  /**
   * Record an inbound event (`POST /events`). Returns false for an event id
   * that was already accepted, which is still a success for the caller.
   */
  accept(event: InboundEvent): boolean {
    if (this.#stopped) throw new Error("the agent is shutting down");
    const fresh = this.#store.acceptInbound(event);
    if (!fresh) {
      this.#log.debug("inbound event already accepted", { id: event.id, type: event.type });
      return false;
    }
    this.#log.info("inbound event accepted", { id: event.id, type: event.type });
    switch (event.type) {
      case "user.message":
        // Stays in the inbox until the chat turn has been answered.
        break;
      case "task.created": {
        const { created } = this.#queue.enqueue({
          id: event.data.task_id,
          description: event.data.description,
          priority: event.data.priority,
        });
        if (!created) this.#log.warn("task already known, not queued again", { task_id: event.data.task_id });
        this.#store.markInboundProcessed(event.id);
        break;
      }
      case "approval.received": {
        const outcome = this.#approvals.decide(event.data.approval_id, event.data.decision, event.data.note);
        if (outcome === "unknown") this.#log.warn("approval.received for an unknown approval; ignored", { approval_id: event.data.approval_id });
        else if (outcome === "already decided") this.#log.warn("approval.received for an approval already resolved; ignored", { approval_id: event.data.approval_id });
        else this.#log.info("approval resolved", { approval_id: event.data.approval_id, decision: event.data.decision });
        this.#store.markInboundProcessed(event.id);
        break;
      }
      case "system.event":
        this.#systemEvent(event.data.name, event.data.data);
        this.#store.markInboundProcessed(event.id);
        break;
    }
    // New work after a prepare-sleep means the host changed its mind.
    this.#suspended = false;
    this.#kick();
    return true;
  }

  stateAnswer(): AgentStateAnswer {
    const pending = this.#approvals.pending();
    return {
      state: this.#state,
      current_task_id: this.#activeTaskId,
      pending_approval: pending
        ? {
            approval_id: pending.approvalId,
            ...(pending.taskId ? { task_id: pending.taskId } : {}),
            tool: pending.tool,
            permission: pending.permission,
            arguments: pending.arguments,
            reason: pending.reason,
          }
        : null,
    };
  }

  /**
   * Stop working without losing anything (`POST /prepare-sleep`): a model
   * request or tool call in flight is abandoned and redone after the next
   * boot. New inbound events lift the suspension.
   */
  async suspend(): Promise<void> {
    this.#suspended = true;
    this.#controller?.abort(new UnitAbort("suspend"));
    await this.idle();
  }

  /** Like `suspend`, for good: used on SIGTERM. */
  async stop(): Promise<void> {
    this.#stopped = true;
    await this.suspend();
  }

  /** Resolves once the worker has nothing left it can do right now. */
  async idle(): Promise<void> {
    while (this.#worker) await this.#worker;
  }

  #kick(): void {
    if (!this.#started) return;
    if (this.#worker) {
      this.#rerun = true;
      return;
    }
    this.#worker = this.#drain()
      .catch((error: unknown) => {
        this.#log.error("agent worker crashed", { error: errorText(error) });
      })
      .finally(() => {
        this.#worker = null;
        if (this.#rerun && !this.#stopped) {
          this.#rerun = false;
          this.#kick();
        }
      });
  }

  async #drain(): Promise<void> {
    for (;;) {
      this.#rerun = false;
      if (this.#suspended || this.#stopped) return;
      if (!this.#config) {
        if (this.#hasWork()) this.#log.info("work is waiting for the runtime config (PUT /config)");
        return;
      }
      if (!this.#model.configured) {
        if (this.#hasWork() && !this.#waitingForKeyLogged) {
          this.#waitingForKeyLogged = true;
          this.#log.info("work is waiting for the OpenRouter key (POST /secrets)");
        }
        return;
      }
      const record = this.#nextUnit();
      if (!record) return;
      const outcome = await this.#runUnit(record);
      if (outcome === "suspended") return;
    }
  }

  #hasWork(): boolean {
    return (
      this.#ledger.get() !== undefined ||
      this.#store.pendingInbound(["user.message"]).length > 0 ||
      this.#queue.peekNext() !== undefined
    );
  }

  /** The active unit first; then chat turns, which someone is waiting on; then tasks. */
  #nextUnit(): RunRecord | undefined {
    const active = this.#ledger.get();
    if (active) {
      if (this.#approvals.pending()) return undefined; // blocked until the user decides
      return active;
    }
    const message = this.#store.pendingInbound(["user.message"])[0];
    if (message) return this.#ledger.startChat(message.id, String(message.data.text ?? ""));
    const task = this.#queue.peekNext();
    if (task) {
      const conversation = this.#store
        .listMessages<ThreadMessage>(CONVERSATION_THREAD, { limit: WORKING_MEMORY_MESSAGES })
        .map((m) => m.message);
      const record = this.#ledger.startTask(task, taskSeedMessage(task.description, conversation));
      this.#log.info("task started", { task_id: task.id, priority: task.priority });
      return record;
    }
    return undefined;
  }

  async #runUnit(record: RunRecord): Promise<UnitOutcome> {
    const controller = new AbortController();
    this.#controller = controller;
    this.#activeTaskId = record.kind === "task" ? record.taskId : null;
    try {
      if (record.kind === "task") {
        const task = this.#queue.get(record.taskId);
        if (!task || task.status === "CANCELLED" || task.status === "COMPLETED" || task.status === "FAILED") {
          this.#finishUnit(record);
          return "finished";
        }
        if (task.status === "WAITING_APPROVAL") this.#queue.start(task.id);
      }
      const config = this.#config!;
      const runner = new AgentRunner(this.#deps, { maxTurns: config.limits.max_steps_per_task });
      const tools = this.#registry.definitions(config);
      const outcome = await runner.run({
        record,
        config,
        tools,
        systemPrompt: () => this.#systemPrompt(record, config),
        requestMessages: (thread) => toRequestMessages(trimThread(thread)),
        signal: controller.signal,
        onState: (state) => this.#emitState(state),
      });
      if (outcome.status === "suspended") return "suspended";
      if (outcome.status === "failed") {
        this.#failUnit(record, outcome.error);
        return "finished";
      }
      this.#checkpoint.complete(record, outcome.output);
      this.#log.info("unit completed", describeRun(record));
      this.#doneThenIdle();
      return "finished";
    } catch (error) {
      if (error instanceof UnitAbort || controller.signal.aborted) {
        if (abortReason(controller.signal) === "cancel") {
          this.#log.info("unit stopped: task cancelled", describeRun(record));
          this.#finishUnit(record);
          return "finished";
        }
        this.#log.info("unit paused for sleep; it resumes after the next start", describeRun(record));
        this.#emitState("IDLE");
        return "suspended";
      }
      this.#log.error("unit failed", { ...describeRun(record), error: errorText(error) });
      this.#failUnit(record, failureText(error));
      return "finished";
    } finally {
      this.#controller = null;
    }
  }

  #systemPrompt(record: RunRecord, config: DotRuntimeConfig): string {
    const task = record.kind === "task" ? this.#queue.get(record.taskId) : undefined;
    return buildSystemPrompt({
      config,
      identities: this.#identities(),
      memoryKeys: config.memory.enabled ? this.#store.recentMemoryKeys(SYSTEM_PROMPT_MEMORY_KEYS) : [],
      now: this.#now(),
      ...(task ? { task: { id: task.id, description: task.description } } : {}),
    });
  }

  #systemEvent(name: string, data: Record<string, unknown>): void {
    if (name === TASK_CANCELLED_SYSTEM_EVENT) {
      const taskId = typeof data.task_id === "string" ? data.task_id : "";
      this.#cancelTask(taskId);
      return;
    }
    this.#log.info("system event recorded", { name });
  }

  #cancelTask(taskId: string): void {
    const cancelled = this.#queue.cancel(taskId);
    if (!cancelled) {
      this.#log.warn("cancel for a task that is unknown or already finished; ignored", { task_id: taskId });
      return;
    }
    this.#approvals.dropThread(taskId);
    this.#log.info("task cancelled", { task_id: taskId });
    const active = this.#ledger.get();
    if (active?.kind !== "task" || active.taskId !== taskId) return;
    if (this.#controller) {
      this.#controller.abort(new UnitAbort("cancel"));
    } else {
      // Not running: it was waiting for an approval.
      this.#finishUnit(active);
    }
  }

  #failUnit(record: RunRecord, error: string): void {
    this.#checkpoint.fail(record, error);
    this.#doneThenIdle();
  }

  /** Drop a unit that ended without an answer of its own (a cancelled task). */
  #finishUnit(record: RunRecord): void {
    this.#checkpoint.drop();
    if (record.kind === "task" && this.#activeTaskId === record.taskId) this.#activeTaskId = null;
    this.#emitState("IDLE");
  }

  #doneThenIdle(): void {
    this.#activeTaskId = null;
    this.#emitState("DONE");
    this.#emitState("IDLE");
  }

  #emitState(state: AgentState, force = false): void {
    if (!force && state === this.#state) return;
    this.#state = state;
    this.#store.appendEvent("agent.state", { state });
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureText(error: unknown): string {
  if (error instanceof OpenRouterError) return `model request failed (${error.code}): ${error.message}`;
  return errorText(error);
}
