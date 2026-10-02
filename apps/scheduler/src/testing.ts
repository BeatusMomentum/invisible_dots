/**
 * In-process stand-ins for the VM layer and the guest agent, used by the
 * scheduler and API tests. FakeGuest follows the guest protocol of
 * architecture section 5: health that comes up after a boot, a key held in
 * memory only (lost on every reboot), an outbox with monotonically
 * increasing `seq` replayed after a cursor, and browser identities.
 */
import {
  newId,
  newIdentityId,
  type AgentState,
  type AgentStateAnswer,
  type BrowserIdentity,
  type BrowserIdentityListAnswer,
  type CreateBrowserIdentityRequest,
  type DotRuntimeConfig,
  type GuestChecks,
  type HealthAnswer,
  type InboundEvent,
  type OutboundEvent,
  type OutboundEventDataMap,
  type OutboundEventType,
  type SystemAnswer,
  type VmState,
} from "@invisible-dots/shared";
import type { ComputerDriver, ComputerSpecInput, DomainState, GuestApi, StartedComputer } from "./driver.js";

/** The error shape of vm-manager's GuestRequestError: a status (0 = unreachable) and the guest's code. */
export class FakeGuestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "FakeGuestError";
  }
}

export type InboundHandler = (event: InboundEvent, guest: FakeGuest) => void | Promise<void>;

/**
 * The default agent: a task runs at once and completes; a message gets an
 * answer; an approval resumes and completes the task it belongs to.
 */
export const completeEverything: InboundHandler = (event, guest) => {
  switch (event.type) {
    case "task.created":
      guest.emit("agent.state", { state: "THINKING" });
      guest.emit("task.started", { task_id: event.data.task_id });
      guest.emit("task.completed", { task_id: event.data.task_id, summary: `done: ${event.data.description}` });
      guest.emit("agent.state", { state: "IDLE" });
      break;
    case "user.message":
      guest.emit("message.assistant", { text: `echo: ${event.data.text}`, in_reply_to: event.id });
      break;
    case "approval.received": {
      const pending = guest.pendingApproval;
      guest.pendingApproval = null;
      guest.emit("agent.state", { state: "EXECUTING" });
      if (pending?.task_id) {
        guest.emit("task.completed", { task_id: pending.task_id, summary: `approval ${event.data.decision}d` });
      }
      guest.emit("agent.state", { state: "IDLE" });
      break;
    }
    default:
      break;
  }
};

export class FakeGuest implements GuestApi {
  /** Whether the VM is powered on; every call fails as unreachable when it is not. */
  running = false;
  /** Health polls answered with agent "starting" after each boot before it reports "ok". */
  bootPolls = 1;
  #pollsSinceBoot = 0;
  #bootedAt = 0;
  agentState: AgentState = "IDLE";
  openrouterKey: string | null = null;
  config: DotRuntimeConfig | null = null;
  checks: GuestChecks = { filesystem_writable: true, network_reachable: true, browser_installed: true };
  readonly outbox: OutboundEvent[] = [];
  readonly inbound: InboundEvent[] = [];
  readonly identities = new Map<string, BrowserIdentity>();
  readonly calls: string[] = [];
  pendingApproval: { approval_id: string; task_id?: string } | null = null;
  onInbound: InboundHandler = completeEverything;
  /** When set, `postEvent` fails with it once. */
  failNextPost: Error | null = null;
  boots = 0;
  #seq = 0;
  #wakers = new Set<() => void>();
  #streams = new Set<AbortController>();

  constructor(readonly token: string) {}

  boot(): void {
    this.running = true;
    this.boots++;
    this.#pollsSinceBoot = 0;
    this.#bootedAt = Date.now();
    this.openrouterKey = null;
    this.agentState = "IDLE";
  }

  powerOff(): void {
    this.running = false;
    this.disconnectStreams();
  }

  /** End every open event stream, as a dropped connection would. */
  disconnectStreams(): void {
    for (const controller of this.#streams) controller.abort();
    this.#streams.clear();
    this.#wake();
  }

  #wake(): void {
    for (const w of [...this.#wakers]) w();
  }

  #reachable(what: string): void {
    this.calls.push(what);
    if (!this.running) {
      if (this.#rebootDelayMs !== null) {
        setTimeout(() => this.boot(), this.#rebootDelayMs);
        this.#rebootDelayMs = null;
      }
      throw new FakeGuestError(0, `${what}: connect ENOENT (the VM is off)`);
    }
  }

  #rebootDelayMs: number | null = null;

  /**
   * Power off and come back `delayMs` after the first call that finds the
   * guest down. A real reboot is seconds of downtime that a poll always sees;
   * booting on a plain timer instead would let a slow test machine miss it.
   */
  reboot(delayMs: number): void {
    this.powerOff();
    this.#rebootDelayMs = delayMs;
  }

  /** Append an outbound event to the outbox, as the agent does before streaming it. */
  emit<T extends OutboundEventType>(type: T, data: OutboundEventDataMap[T]): OutboundEvent {
    if (type === "agent.state") this.agentState = (data as { state: AgentState }).state;
    if (type === "approval.requested") {
      const d = data as OutboundEventDataMap["approval.requested"];
      this.pendingApproval = { approval_id: d.approval_id, ...(d.task_id ? { task_id: d.task_id } : {}) };
      this.agentState = "WAITING_APPROVAL";
    }
    const event = { seq: ++this.#seq, id: newId("evt"), type, ts: new Date().toISOString(), data } as OutboundEvent;
    this.outbox.push(event);
    this.#wake();
    return event;
  }

  /** Ask for an approval from inside a task, as the policy engine does on `ask`. */
  requestApproval(taskId: string | undefined, tool = "browser_identity_delete"): string {
    const approvalId = newId("apr");
    this.emit("agent.state", { state: "WAITING_APPROVAL" });
    this.emit("approval.requested", {
      approval_id: approvalId,
      ...(taskId ? { task_id: taskId } : {}),
      tool,
      permission: "browser.identity.delete",
      arguments: { identity_id: "shop-abc123" },
      reason: "the tool needs approval",
    });
    return approvalId;
  }

  async health(): Promise<HealthAnswer> {
    this.#reachable("health");
    this.#pollsSinceBoot++;
    // A real guest has been up for several seconds by the time its agent answers.
    const uptime = 5 + Math.floor((Date.now() - this.#bootedAt) / 1000);
    if (this.#pollsSinceBoot <= this.bootPolls) {
      return { agentd: "ok", agent: { status: "down" }, uptime_s: uptime };
    }
    return {
      agentd: "ok",
      agent: {
        status: "ok",
        state: this.agentState,
        openrouter_configured: this.openrouterKey !== null,
        browser: { identities: this.identities.size, open: 0 },
        checks: { ...this.checks },
      },
      uptime_s: uptime,
    };
  }

  async system(): Promise<SystemAnswer> {
    this.#reachable("system");
    return {
      hostname: "invisible-dot-fake",
      uptime_s: 5 + Math.floor((Date.now() - this.#bootedAt) / 1000),
      cpus: 2,
      mem_total_bytes: 4 * 1024 ** 3,
      mem_available_bytes: 3 * 1024 ** 3,
      disk_total_bytes: 40 * 1024 ** 3,
      disk_free_bytes: 35 * 1024 ** 3,
    };
  }

  async pushSecrets(key: string): Promise<void> {
    this.#reachable("pushSecrets");
    this.openrouterKey = key;
  }

  async putConfig(config: DotRuntimeConfig): Promise<void> {
    this.#reachable("putConfig");
    this.config = config;
  }

  async postEvent(event: InboundEvent): Promise<{ accepted: true }> {
    this.#reachable(`postEvent:${event.type}`);
    if (this.failNextPost) {
      const error = this.failNextPost;
      this.failNextPost = null;
      throw error;
    }
    this.inbound.push(event);
    await this.onInbound(event, this);
    return { accepted: true };
  }

  async state(): Promise<AgentStateAnswer> {
    this.#reachable("state");
    return { state: this.agentState, current_task_id: null, pending_approval: null };
  }

  async listBrowserIdentities(): Promise<BrowserIdentityListAnswer> {
    this.#reachable("listBrowserIdentities");
    return { identities: [...this.identities.values()] };
  }

  async createBrowserIdentity(body: CreateBrowserIdentityRequest): Promise<BrowserIdentity> {
    this.#reachable("createBrowserIdentity");
    const id = newIdentityId(body.name);
    const identity: BrowserIdentity = {
      id,
      name: body.name,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      status: "available",
      profilePath: `/home/dot/browsers/${id}/profile`,
      ...(body.proxy ? { proxy: body.proxy } : {}),
    };
    this.identities.set(id, identity);
    this.emit("browser.identity.created", { identity_id: id, name: body.name });
    return identity;
  }

  async getBrowserIdentity(id: string): Promise<BrowserIdentity> {
    this.#reachable("getBrowserIdentity");
    const identity = this.identities.get(id);
    if (!identity) throw new FakeGuestError(404, `identity ${id} not found`, "not_found");
    return identity;
  }

  async deleteBrowserIdentity(id: string): Promise<void> {
    this.#reachable("deleteBrowserIdentity");
    const identity = this.identities.get(id);
    if (!identity) throw new FakeGuestError(404, `identity ${id} not found`, "not_found");
    this.identities.delete(id);
    this.emit("browser.identity.deleted", { identity_id: id, name: identity.name });
  }

  async prepareSleep(): Promise<void> {
    this.#reachable("prepareSleep");
  }

  async screenshot(): Promise<Uint8Array> {
    this.#reachable("screenshot");
    // The PNG signature and nothing else: enough for a content check.
    return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }

  /** The outbox after `after`, then every new event, until aborted or disconnected. */
  async *events(options: { after?: number; signal?: AbortSignal }): AsyncGenerator<OutboundEvent> {
    this.#reachable("events");
    const own = new AbortController();
    this.#streams.add(own);
    let after = options.after ?? 0;
    try {
      for (;;) {
        if (options.signal?.aborted) return;
        if (own.signal.aborted) throw new FakeGuestError(0, "event stream disconnected");
        const next = this.outbox.find((e) => e.seq > after);
        if (next) {
          after = next.seq;
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          const done = () => {
            this.#wakers.delete(done);
            options.signal?.removeEventListener("abort", done);
            resolve();
          };
          this.#wakers.add(done);
          options.signal?.addEventListener("abort", done, { once: true });
        });
      }
    } finally {
      this.#streams.delete(own);
    }
  }
}

interface FakeDomain {
  defined: boolean;
  state: VmState;
  cid: number;
  token: string;
}

export type DriverOperation = "create" | "start" | "stop" | "reboot" | "destroy" | "attach";

/** A ComputerDriver that keeps its "VMs" in memory and boots a FakeGuest in each. */
export class FakeDriver implements ComputerDriver {
  readonly domains = new Map<string, FakeDomain>();
  readonly guests = new Map<string, FakeGuest>();
  readonly calls: string[] = [];
  /** CIDs "another program on the host" holds: start moves off them, like vm-manager does. */
  readonly hostTakenCids = new Set<number>();
  readonly #failures = new Map<DriverOperation, { error: Error; times: number }>();
  /** Applied to every new guest, e.g. to install a custom agent behaviour. */
  configureGuest: (guest: FakeGuest) => void = () => {};
  rebootDelayMs = 30;
  goldenImage = "/var/lib/invisible-dots/images/golden-test.qcow2";
  runtimeImage = "/var/lib/invisible-dots/images/runtime-test.iso";

  /** Make the next `times` calls of `operation` fail with `error`. */
  failNext(operation: DriverOperation, error: Error = new Error(`${operation} failed (injected)`), times = 1): void {
    this.#failures.set(operation, { error, times });
  }

  #enter(operation: DriverOperation, dotId: string): void {
    this.calls.push(`${operation}:${dotId}`);
    const failure = this.#failures.get(operation);
    if (failure) {
      if (--failure.times <= 0) this.#failures.delete(operation);
      throw failure.error;
    }
  }

  guestOf(dotId: string): FakeGuest {
    const guest = this.guests.get(dotId);
    if (!guest) throw new Error(`no fake guest for ${dotId}`);
    return guest;
  }

  async create(spec: ComputerSpecInput) {
    this.#enter("create", spec.dotId);
    const existing = this.domains.get(spec.dotId);
    this.domains.set(spec.dotId, { defined: true, state: existing?.state ?? "STOPPED", cid: spec.cid, token: spec.token });
    if (!this.guests.has(spec.dotId)) {
      const guest = new FakeGuest(spec.token);
      this.configureGuest(guest);
      this.guests.set(spec.dotId, guest);
    }
    return { domainName: `invisible-dot-${spec.dotId}`, goldenImage: this.goldenImage, runtimeImage: this.runtimeImage };
  }

  async start(spec: ComputerSpecInput & { goldenImage: string }, reservedCids: readonly number[]): Promise<StartedComputer> {
    this.#enter("start", spec.dotId);
    const domain = this.domains.get(spec.dotId);
    if (!domain?.defined) throw new Error(`domain invisible-dot-${spec.dotId} is not defined`);
    if (domain.state === "RUNNING") return { cid: domain.cid, runtimeImage: this.runtimeImage, alreadyRunning: true };
    let cid = spec.cid;
    const taken = new Set([...reservedCids, ...this.hostTakenCids]);
    while (taken.has(cid)) cid++;
    domain.cid = cid;
    domain.state = "RUNNING";
    this.guestOf(spec.dotId).boot();
    return { cid, runtimeImage: this.runtimeImage, alreadyRunning: false };
  }

  async stop(dotId: string) {
    this.#enter("stop", dotId);
    const domain = this.domains.get(dotId);
    if (domain) domain.state = "STOPPED";
    this.guests.get(dotId)?.powerOff();
    return { forced: false };
  }

  async reboot(dotId: string) {
    this.#enter("reboot", dotId);
    const guest = this.guestOf(dotId);
    guest.reboot(this.rebootDelayMs);
  }

  async destroy(dotId: string) {
    this.#enter("destroy", dotId);
    this.guests.get(dotId)?.powerOff();
    this.domains.delete(dotId);
    this.guests.delete(dotId);
  }

  async state(dotId: string): Promise<DomainState> {
    const domain = this.domains.get(dotId);
    if (!domain) return { defined: false, state: "STOPPED", detail: null };
    return { defined: true, state: domain.state, detail: domain.state === "RUNNING" ? "running" : "shut off" };
  }

  async attach(dotId: string, cid: number) {
    this.#enter("attach", dotId);
    const domain = this.domains.get(dotId);
    if (domain) domain.cid = cid;
  }

  guest(dotId: string, token: string): GuestApi {
    const guest = this.guestOf(dotId);
    if (token !== guest.token) {
      // Every call is refused, like dot-agentd answering 401 to a wrong token.
      return new Proxy(guest, {
        get: () => async () => {
          throw new FakeGuestError(401, "unauthorized", "unauthorized");
        },
      });
    }
    return guest;
  }

  async close() {}
}

/** Poll until `predicate` holds; fails with `what` after `timeoutMs`. */
export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  what: string,
  timeoutMs = 5_000,
  intervalMs = 10,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** A clock tests move by hand. */
export class ManualClock {
  #now: number;
  constructor(start: Date = new Date()) {
    this.#now = start.getTime();
  }
  now(): Date {
    return new Date(this.#now);
  }
  advance(ms: number): void {
    this.#now += ms;
  }
}
