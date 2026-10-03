/**
 * The Dot's state machine and reasoning loop (architecture sections 8.1 to
 * 8.6).
 *
 * Work is event driven: `accept()` records an inbound event and wakes a single
 * worker, which runs one unit of work at a time, either a chat turn on the
 * shared conversation or a task on its own thread. Everything a unit needs to
 * continue lives in `dot.db`: the thread messages, the task row, the pending
 * approval and the "active unit" record. That is what makes a restart, a
 * sleep or an approval that takes a day all the same case: the worker reads
 * the thread, finds the tool calls that have no result yet, and carries on.
 */
import {
  OpenRouterError,
  UsageAccumulator,
  parseToolCall,
  toFunctionTools,
  type ChatModel,
  type ParsedToolCall,
  type ToolCall,
} from "@invisible-dots/openrouter-client";
import { CONVERSATION_THREAD, type DotStore, type PendingApprovalRecord } from "@invisible-dots/memory";
import { PolicyEngine } from "@invisible-dots/policy";
import {
  SYSTEM_PROMPT_MEMORY_KEYS,
  TASK_CANCELLED_SYSTEM_EVENT,
  WORKING_MEMORY_MESSAGES,
  newId,
  parseRuntimeConfig,
  redactToolArguments,
  truncateText,
  type AgentState,
  type AgentStateAnswer,
  type BrowserIdentity,
  type DotRuntimeConfig,
  type InboundEvent,
  type PolicyDecision,
} from "@invisible-dots/shared";
import { TaskQueue } from "@invisible-dots/task-runtime";
import { buildSystemPrompt, taskSeedMessage } from "./prompt.js";
import { silentLogger, type Logger, type StoredToolMessage, type ThreadMessage, type ToolRegistry, type ToolResult } from "./types.js";
import { toRequestMessages, trimThread, unansweredToolCalls } from "./working-memory.js";

export interface AgentRuntimeOptions {
  store: DotStore;
  registry: ToolRegistry;
  model: ChatModel;
  logger?: Logger;
  now?: () => Date;
  /** Identities listed in the system prompt; defaults to the store's table. */
  identities?: () => readonly BrowserIdentity[];
}

/** The unit of work in flight, persisted so a restart picks it up again. */
type ActiveUnit =
  | { kind: "chat"; eventId: string; text: string; steps: number; usage: ReturnType<UsageAccumulator["toJSON"]> }
  | { kind: "task"; taskId: string };

type UnitOutcome = "finished" | "suspended";

const KEY_RUNTIME_CONFIG = "runtime_config";
const KEY_ACTIVE_UNIT = "active_unit";

/** Thrown into a running unit to stop it; the reason says what happens to its state. */
class UnitAbort extends Error {
  constructor(readonly reason: "suspend" | "cancel") {
    super(reason === "suspend" ? "the agent is preparing to sleep" : "the task was cancelled");
    this.name = "UnitAbort";
  }
}

export class AgentRuntime {
  readonly #store: DotStore;
  readonly #registry: ToolRegistry;
  readonly #model: ChatModel;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #identities: () => readonly BrowserIdentity[];
  readonly #queue: TaskQueue;
  readonly #policy = new PolicyEngine({ permissions: {} });

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

  constructor(options: AgentRuntimeOptions) {
    this.#store = options.store;
    this.#registry = options.registry;
    this.#model = options.model;
    this.#log = options.logger ?? silentLogger;
    this.#now = options.now ?? (() => new Date());
    this.#identities = options.identities ?? (() => this.#store.listIdentities());
    this.#queue = new TaskQueue(this.#store, { now: this.#now });
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
        this.#applyConfig(parseRuntimeConfig(stored));
      } catch (error) {
        this.#log.error("stored runtime config is invalid; waiting for PUT /config", { error: errorText(error) });
      }
    }
    const active = this.#activeUnit();
    if (!active) {
      // A crash between starting a task and recording it as active leaves a RUNNING task behind.
      const orphan = this.#queue.inFlight();
      if (orphan) this.#setActiveUnit({ kind: "task", taskId: orphan.id });
    }
    const resumed = this.#activeUnit();
    if (resumed) this.#log.info("resuming work interrupted by the last stop", describeUnit(resumed));
    if (resumed?.kind === "task") this.#activeTaskId = resumed.taskId;
    this.#started = true;
    // The host pushes the OpenRouter key again when it sees this: a restart of
    // this process inside a running VM loses it, since it lives in memory only.
    this.#store.appendEvent("agent.started", {});
    // The outbox may end on THINKING from before the stop; say where we really are.
    this.#emitState(this.#pendingApprovalRecord() ? "WAITING_APPROVAL" : "IDLE", true);
    this.#kick();
  }

  /** Validate, persist and apply a runtime config (`PUT /config`). */
  setConfig(input: unknown): DotRuntimeConfig {
    const config = parseRuntimeConfig(input);
    this.#store.setConfig(KEY_RUNTIME_CONFIG, config);
    this.#applyConfig(config);
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
      case "approval.received":
        this.#resolveApproval(event.data.approval_id, event.data.decision, event.data.note);
        this.#store.markInboundProcessed(event.id);
        break;
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
    const pending = this.#pendingApprovalRecord();
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

  #applyConfig(config: DotRuntimeConfig): void {
    this.#config = config;
    this.#policy.update(config);
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
      const unit = this.#nextUnit();
      if (!unit) return;
      const outcome = await this.#runUnit(unit);
      if (outcome === "suspended") return;
    }
  }

  #hasWork(): boolean {
    return (
      this.#activeUnit() !== undefined ||
      this.#store.pendingInbound(["user.message"]).length > 0 ||
      this.#queue.peekNext() !== undefined
    );
  }

  /** The active unit first; then chat turns, which someone is waiting on; then tasks. */
  #nextUnit(): ActiveUnit | undefined {
    const active = this.#activeUnit();
    if (active) {
      const pending = this.#pendingApprovalRecord();
      if (pending) return undefined; // blocked until the user decides
      return active;
    }
    const message = this.#store.pendingInbound(["user.message"])[0];
    if (message) {
      const unit: ActiveUnit = {
        kind: "chat",
        eventId: message.id,
        text: String(message.data.text ?? ""),
        steps: 0,
        usage: new UsageAccumulator().toJSON(),
      };
      this.#store.transaction(() => {
        this.#store.appendMessage<ThreadMessage>(CONVERSATION_THREAD, { role: "user", content: unit.text });
        this.#setActiveUnit(unit);
      });
      return unit;
    }
    const task = this.#queue.peekNext();
    if (task) {
      const conversation = this.#store
        .listMessages<ThreadMessage>(CONVERSATION_THREAD, { limit: WORKING_MEMORY_MESSAGES })
        .map((m) => m.message);
      this.#store.transaction(() => {
        this.#queue.start(task.id);
        this.#store.appendMessage<ThreadMessage>(task.id, { role: "user", content: taskSeedMessage(task.description, conversation) });
        this.#setActiveUnit({ kind: "task", taskId: task.id });
        this.#store.appendEvent("task.started", { task_id: task.id });
      });
      this.#log.info("task started", { task_id: task.id, priority: task.priority });
      return { kind: "task", taskId: task.id };
    }
    return undefined;
  }

  async #runUnit(unit: ActiveUnit): Promise<UnitOutcome> {
    const controller = new AbortController();
    this.#controller = controller;
    this.#activeTaskId = unit.kind === "task" ? unit.taskId : null;
    try {
      if (unit.kind === "task") {
        const task = this.#queue.get(unit.taskId);
        if (!task || task.status === "CANCELLED" || task.status === "COMPLETED" || task.status === "FAILED") {
          this.#finishUnit(unit);
          return "finished";
        }
        if (task.status === "WAITING_APPROVAL") this.#queue.start(task.id);
      }
      return await this.#loop(unit, controller.signal);
    } catch (error) {
      if (error instanceof UnitAbort || controller.signal.aborted) {
        const reason = controller.signal.reason instanceof UnitAbort ? controller.signal.reason.reason : "suspend";
        if (reason === "cancel") {
          this.#log.info("unit stopped: task cancelled", describeUnit(unit));
          this.#finishUnit(unit);
          return "finished";
        }
        this.#log.info("unit paused for sleep; it resumes after the next start", describeUnit(unit));
        this.#emitState("IDLE");
        return "suspended";
      }
      this.#log.error("unit failed", { ...describeUnit(unit), error: errorText(error) });
      this.#failUnit(unit, failureText(error));
      return "finished";
    } finally {
      this.#controller = null;
    }
  }

  async #loop(unit: ActiveUnit, signal: AbortSignal): Promise<UnitOutcome> {
    const thread = unit.kind === "chat" ? CONVERSATION_THREAD : unit.taskId;
    for (;;) {
      throwIfAborted(signal);
      const config = this.#config!;
      const recent = this.#store.listMessages<ThreadMessage>(thread, { limit: WORKING_MEMORY_MESSAGES * 5 }).map((m) => m.message);

      const open = unansweredToolCalls(recent);
      if (open.length > 0) {
        const outcome = await this.#runToolCalls(unit, thread, recent, open, signal);
        if (outcome === "suspended") return "suspended";
        continue;
      }

      const steps = this.#steps(unit);
      if (steps >= config.limits.max_steps_per_task) {
        const text = `stopped after ${steps} model turns without a final answer (limits.max_steps_per_task is ${config.limits.max_steps_per_task})`;
        this.#log.warn("step limit reached", { ...describeUnit(unit), steps });
        this.#failUnit(unit, text);
        return "finished";
      }

      this.#emitState("THINKING");
      const definitions = this.#registry.definitions(config);
      const task = unit.kind === "task" ? this.#queue.get(unit.taskId) : undefined;
      const system = buildSystemPrompt({
        config,
        identities: this.#identities(),
        memoryKeys: config.memory.enabled ? this.#store.recentMemoryKeys(SYSTEM_PROMPT_MEMORY_KEYS) : [],
        now: this.#now(),
        ...(task ? { task: { id: task.id, description: task.description } } : {}),
      });
      const history = trimThread(recent);
      const started = Date.now();
      const result = await this.#model.chat(
        {
          model: config.model.id,
          messages: [{ role: "system", content: system }, ...toRequestMessages(history)],
          ...(definitions.length > 0 ? { tools: toFunctionTools(definitions) } : {}),
        },
        { signal },
      );
      throwIfAborted(signal);
      this.#log.info("model answered", {
        ...describeUnit(unit),
        model: result.model,
        tool_calls: result.toolCalls.length,
        prompt_tokens: result.usage.prompt_tokens,
        completion_tokens: result.usage.completion_tokens,
        cost: result.usage.cost,
        attempts: result.attempts,
        duration_ms: Date.now() - started,
      });

      this.#emitState("PLANNING");
      this.#store.transaction(() => {
        this.#store.appendMessage<ThreadMessage>(thread, result.message);
        this.#countStep(unit, result.usage);
      });

      if (result.toolCalls.length === 0) {
        this.#completeUnit(unit, result.text.trim() === "" ? "(no answer)" : result.text);
        return "finished";
      }
      if (unit.kind === "task" && result.text.trim() !== "") {
        this.#store.appendEvent("task.progress", { task_id: unit.taskId, text: result.text });
      }
    }
  }

  async #runToolCalls(
    unit: ActiveUnit,
    thread: string,
    recent: readonly ThreadMessage[],
    calls: readonly ToolCall[],
    signal: AbortSignal,
  ): Promise<UnitOutcome> {
    const config = this.#config!;
    const offered = this.#registry.definitions(config);
    const taskId = unit.kind === "task" ? unit.taskId : undefined;
    const assistantText = lastAssistantText(recent);

    for (const call of calls) {
      throwIfAborted(signal);
      const parsed = parseToolCall(call);
      const verdict = this.#policy.decideTool(parsed.name, offered);
      let result: ToolResult;
      let durationMs = 0;

      if (verdict.decision === "deny") {
        result = { ok: false, text: `Denied by policy: ${verdict.reason}.` };
      } else if (parsed.arguments === null) {
        result = { ok: false, text: `Invalid arguments for ${parsed.name}: ${parsed.argumentsError}. Send a JSON object.` };
      } else if (verdict.decision === "ask") {
        const approval = this.#store.getApprovalByToolCall(call.id);
        if (!approval) {
          this.#requestApproval(unit, thread, parsed, verdict.permission, verdict.reason, assistantText);
          return "suspended";
        }
        if (approval.status === "pending") {
          this.#emitState("WAITING_APPROVAL");
          return "suspended";
        }
        if (approval.status === "rejected") {
          result = { ok: false, text: `The call was rejected by the user${approval.note ? `: ${approval.note}` : "."}` };
        } else {
          ({ result, durationMs } = await this.#execute(parsed, taskId, signal));
          if (approval.note) result = { ...result, text: `${result.text}\n(The user approved this call with a note: ${approval.note})` };
        }
      } else {
        ({ result, durationMs } = await this.#execute(parsed, taskId, signal));
      }

      const message: StoredToolMessage = {
        role: "tool",
        tool_call_id: call.id,
        content: truncateText(result.ok ? result.text : `Error: ${result.text}`),
        ...(result.images && result.images.length > 0 ? { images: result.images } : {}),
      };
      this.#store.transaction(() => {
        this.#store.appendMessage<ThreadMessage>(thread, message);
        const approval = this.#store.getApprovalByToolCall(call.id);
        if (approval) this.#store.deleteApproval(approval.approvalId);
        this.#store.appendEvent("tool.called", {
          ...(taskId ? { task_id: taskId } : {}),
          tool: parsed.name,
          permission: verdict.permission,
          decision: verdict.decision as PolicyDecision,
          ok: result.ok,
          duration_ms: durationMs,
        });
      });
    }
    return "finished";
  }

  async #execute(
    call: ParsedToolCall,
    taskId: string | undefined,
    signal: AbortSignal,
  ): Promise<{ result: ToolResult; durationMs: number }> {
    this.#emitState("EXECUTING");
    const started = Date.now();
    let result: ToolResult;
    try {
      result = await this.#registry.call(call.name, call.arguments, {
        ...(taskId ? { taskId } : {}),
        signal,
        emit: (event) => {
          this.#store.appendEvent(event.type, event.data as never);
        },
      });
    } catch (error) {
      throwIfAborted(signal);
      result = { ok: false, text: `${call.name} failed: ${errorText(error)}` };
    }
    throwIfAborted(signal);
    const durationMs = Date.now() - started;
    this.#log.info("tool called", { tool: call.name, ok: result.ok, duration_ms: durationMs, task_id: taskId });
    return { result, durationMs };
  }

  #requestApproval(
    unit: ActiveUnit,
    thread: string,
    call: ParsedToolCall,
    permission: string,
    policyReason: string,
    assistantText: string,
  ): void {
    const approvalId = newId("apr");
    const taskId = unit.kind === "task" ? unit.taskId : null;
    const reason = assistantText.trim() === "" ? policyReason : `${policyReason}. The agent said: ${assistantText.trim()}`;
    this.#store.transaction(() => {
      this.#store.insertPendingApproval({
        approvalId,
        thread,
        taskId,
        toolCallId: call.id,
        tool: call.name,
        permission: permission as PendingApprovalRecord["permission"],
        arguments: call.arguments ?? {},
        reason,
      });
      if (taskId) this.#queue.waitForApproval(taskId);
      // The pending row above keeps the call whole, so an approval runs it as asked; what leaves
      // the guest for the host's event log, approvals table and SSE has its secrets replaced.
      this.#store.appendEvent("approval.requested", {
        approval_id: approvalId,
        ...(taskId ? { task_id: taskId } : {}),
        tool: call.name,
        permission: permission as PendingApprovalRecord["permission"],
        arguments: redactToolArguments(call.name, call.arguments ?? {}),
        reason,
      });
    });
    this.#log.info("approval requested", { approval_id: approvalId, tool: call.name, task_id: taskId });
    this.#emitState("WAITING_APPROVAL");
  }

  #resolveApproval(approvalId: string, decision: "approve" | "reject", note: string | undefined): void {
    const approval = this.#store.getApproval(approvalId);
    if (!approval) {
      this.#log.warn("approval.received for an unknown approval; ignored", { approval_id: approvalId });
      return;
    }
    if (!this.#store.resolveApproval(approvalId, decision === "approve" ? "approved" : "rejected", note)) {
      this.#log.warn("approval.received for an approval already resolved; ignored", { approval_id: approvalId });
      return;
    }
    this.#log.info("approval resolved", { approval_id: approvalId, decision });
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
    this.#store.deleteApprovalsForThread(taskId);
    this.#log.info("task cancelled", { task_id: taskId });
    const active = this.#activeUnit();
    if (active?.kind !== "task" || active.taskId !== taskId) return;
    if (this.#controller) {
      this.#controller.abort(new UnitAbort("cancel"));
    } else {
      // Not running: it was waiting for an approval.
      this.#finishUnit(active);
    }
  }

  #completeUnit(unit: ActiveUnit, text: string): void {
    this.#store.transaction(() => {
      if (unit.kind === "chat") {
        this.#store.appendEvent("message.assistant", { text, in_reply_to: unit.eventId });
        this.#store.markInboundProcessed(unit.eventId);
      } else {
        const task = this.#queue.complete(unit.taskId, text);
        this.#store.appendEvent("task.completed", { task_id: unit.taskId, summary: text });
        // The chat should know what its tasks concluded.
        this.#store.appendMessage<ThreadMessage>(CONVERSATION_THREAD, {
          role: "assistant",
          content: `[Task ${task.id} completed: ${task.description}]\n${text}`,
        });
      }
      this.#store.deleteConfig(KEY_ACTIVE_UNIT);
    });
    this.#log.info("unit completed", describeUnit(unit));
    this.#doneThenIdle();
  }

  #failUnit(unit: ActiveUnit, error: string): void {
    this.#store.transaction(() => {
      if (unit.kind === "chat") {
        const text = `I could not answer: ${error}`;
        this.#store.appendMessage<ThreadMessage>(CONVERSATION_THREAD, { role: "assistant", content: text });
        this.#store.appendEvent("message.assistant", { text, in_reply_to: unit.eventId });
        this.#store.markInboundProcessed(unit.eventId);
      } else {
        const task = this.#queue.get(unit.taskId);
        if (task && task.status !== "CANCELLED" && task.status !== "COMPLETED" && task.status !== "FAILED") {
          this.#queue.fail(unit.taskId, error);
          this.#store.appendEvent("task.failed", { task_id: unit.taskId, error });
        }
      }
      this.#store.deleteApprovalsForThread(unit.kind === "chat" ? CONVERSATION_THREAD : unit.taskId);
      this.#store.deleteConfig(KEY_ACTIVE_UNIT);
    });
    this.#doneThenIdle();
  }

  /** Drop a unit that ended without an answer of its own (a cancelled task). */
  #finishUnit(unit: ActiveUnit): void {
    this.#store.deleteConfig(KEY_ACTIVE_UNIT);
    if (unit.kind === "task" && this.#activeTaskId === unit.taskId) this.#activeTaskId = null;
    this.#emitState("IDLE");
  }

  #doneThenIdle(): void {
    this.#activeTaskId = null;
    this.#emitState("DONE");
    this.#emitState("IDLE");
  }

  #steps(unit: ActiveUnit): number {
    if (unit.kind === "chat") return (this.#activeUnit() as Extract<ActiveUnit, { kind: "chat" }> | undefined)?.steps ?? unit.steps;
    return this.#queue.get(unit.taskId)?.steps ?? 0;
  }

  #countStep(unit: ActiveUnit, usage: { prompt_tokens: number; completion_tokens: number; cost?: number }): void {
    if (unit.kind === "chat") {
      const current = (this.#activeUnit() as Extract<ActiveUnit, { kind: "chat" }> | undefined) ?? unit;
      const total = new UsageAccumulator(current.usage);
      total.add(usage);
      this.#setActiveUnit({ ...current, steps: current.steps + 1, usage: total.toJSON() });
      return;
    }
    const task = this.#queue.get(unit.taskId);
    const total = new UsageAccumulator(task?.usage ?? undefined);
    total.add(usage);
    this.#queue.countStep(unit.taskId, total.toJSON());
  }

  #emitState(state: AgentState, force = false): void {
    if (!force && state === this.#state) return;
    this.#state = state;
    this.#store.appendEvent("agent.state", { state });
  }

  #activeUnit(): ActiveUnit | undefined {
    return this.#store.getConfig<ActiveUnit>(KEY_ACTIVE_UNIT);
  }

  #setActiveUnit(unit: ActiveUnit): void {
    this.#store.setConfig(KEY_ACTIVE_UNIT, unit);
  }

  #pendingApprovalRecord(): PendingApprovalRecord | undefined {
    return this.#store.listApprovals({ status: "pending" })[0];
  }
}

function lastAssistantText(messages: readonly ThreadMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant") return m.content ?? "";
  }
  return "";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof UnitAbort ? signal.reason : new UnitAbort("suspend");
}

function describeUnit(unit: ActiveUnit): Record<string, unknown> {
  return unit.kind === "chat" ? { unit: "chat", event_id: unit.eventId } : { unit: "task", task_id: unit.taskId };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureText(error: unknown): string {
  if (error instanceof OpenRouterError) return `model request failed (${error.code}): ${error.message}`;
  return errorText(error);
}
