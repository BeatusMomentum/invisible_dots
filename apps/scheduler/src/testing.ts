/**
 * In-process stand-ins for the VM layer and the guest agent, used by the
 * scheduler and API tests. FakeGuest follows the guest protocol of
 * architecture section 5: health that comes up after a boot, a key held in
 * memory only (lost on every reboot and every agent restart), `agent.started`
 * at every start of the agent, inbound events accepted once per id, an
 * outbox with monotonically increasing `seq` replayed after a cursor, and
 * browser identities under the same rules as the real agent's.
 */
import {
  checkIdentityRequest,
  IDENTITY_ERROR_STATUS,
  IdentityRequestError,
  newId,
  newIdentityId,
  pollGuestHealth,
  type AgentState,
  type AgentStateAnswer,
  type BrowserIdentity,
  type BrowserIdentityListAnswer,
  type CreateBrowserIdentityRequest,
  type DotRuntimeConfig,
  type GuestChecks,
  type HealthAnswer,
  type IdentityErrorCode,
  type InboundEvent,
  type OutboundEvent,
  type OutboundEventDataMap,
  type OutboundEventType,
  type SystemAnswer,
  type VmState,
} from "@invisible-dots/shared";
import type {
  ComputerDriver,
  ComputerSpecInput,
  ComputerState,
  CreatedComputer,
  GuestApi,
  GuestEndpoint,
  StartedComputer,
  WaitForHealthOptions,
} from "./driver.js";

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
  /** While set, a frame of an open identity answers 503 `busy`, as when a call of the Dot holds the browser. */
  identityBusy = false;
  /** While set, a frame of an open identity answers with this code and its status of the shared table, as when the engine's browser fails. */
  identityFault: IdentityErrorCode | null = null;
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
    this.emit("agent.started", {});
  }

  /**
   * The agent process restarts inside a running VM (systemd after a crash):
   * its key is gone, its event stream drops, and it announces its start.
   */
  restartAgent(): void {
    this.agentRestarts++;
    this.openrouterKey = null;
    this.disconnectStreams();
    this.emit("agent.started", {});
  }

  agentRestarts = 0;

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

  #openIdentities(): BrowserIdentity[] {
    return [...this.identities.values()].filter((identity) => identity.status === "open");
  }

  /** The Dot opens an identity's browser (the engine does it for a tool call; the host only observes it). */
  launchIdentity(id: string): void {
    const identity = this.identities.get(id);
    if (!identity) throw new Error(`no identity ${id}`);
    this.identities.set(id, { ...identity, status: "open", lastUsedAt: new Date().toISOString() });
    this.emit("browser.identity.launched", { identity_id: id, name: identity.name });
  }

  #reachable(what: string): void {
    this.calls.push(what);
    if (!this.running) {
      if (this.#rebootDelayMs !== null) {
        setTimeout(() => this.boot(), this.#rebootDelayMs);
        this.#rebootDelayMs = null;
      }
      throw new FakeGuestError(0, `${what}: connect ECONNREFUSED (the VM is off)`, "ECONNREFUSED");
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
        browser: { identities: this.identities.size, open: this.#openIdentities().length },
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
    // Like the agent's inbox: an id it already accepted is accepted again and ignored.
    if (this.inbound.some((e) => e.id === event.id)) return { accepted: true };
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
    let checked: { name: string; proxy?: string };
    try {
      // The agent's own rules: before any config the schema default of 20 applies.
      checked = checkIdentityRequest(body, this.identities.size, this.config?.browser.identities.max_identities ?? 20);
    } catch (error) {
      if (error instanceof IdentityRequestError) throw new FakeGuestError(error.code === "limit" ? 409 : 400, error.message, error.code);
      throw error;
    }
    const id = newIdentityId(checked.name);
    const identity: BrowserIdentity = {
      id,
      name: checked.name,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      status: "available",
      profilePath: `/home/dot/browsers/${id}/profile`,
      ...(checked.proxy ? { proxy: checked.proxy } : {}),
    };
    this.identities.set(id, identity);
    this.emit("browser.identity.created", { identity_id: id, name: checked.name });
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

  async getBrowserIdentityFrame(id: string): Promise<Uint8Array> {
    this.#reachable("getBrowserIdentityFrame");
    const identity = this.identities.get(id);
    if (!identity) throw new FakeGuestError(404, `no browser identity "${id}"`, "not_found");
    if (identity.status !== "open") {
      throw new FakeGuestError(409, `identity ${id} is not open; call browser_identity_launch first`, "not_open");
    }
    if (this.identityBusy) {
      throw new FakeGuestError(IDENTITY_ERROR_STATUS.busy, `browser identity "${id}" is busy with a call; ask again in a moment`, "busy");
    }
    if (this.identityFault) {
      throw new FakeGuestError(IDENTITY_ERROR_STATUS[this.identityFault], `browser identity "${id}" failed: ${this.identityFault}`, this.identityFault);
    }
    // The JPEG markers of an empty image: enough for a content check.
    return Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  }

  async closeBrowserIdentity(id: string): Promise<void> {
    this.#reachable("closeBrowserIdentity");
    const identity = this.identities.get(id);
    if (!identity) throw new FakeGuestError(404, `no browser identity "${id}"`, "not_found");
    if (identity.status !== "open") return;
    this.identities.set(id, { ...identity, status: "available" });
    this.emit("browser.identity.closed", { identity_id: id, name: identity.name });
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

interface FakeVm {
  state: VmState;
  guestPort: number | null;
  pid: number | null;
  token: string;
}

export type DriverOperation = "create" | "start" | "stop" | "reboot" | "destroy";

/** The first port FakeDriver hands out; far from anything a test binds, and never really bound. */
const FAKE_FIRST_PORT = 47_000;

/**
 * A ComputerDriver that keeps its "VMs" in memory and boots a FakeGuest in
 * each. Like QEMU with a fresh port forward, every start gets a new port,
 * and a guest is reached only through the port its VM runs with now.
 */
export class FakeDriver implements ComputerDriver {
  readonly vms = new Map<string, FakeVm>();
  readonly guests = new Map<string, FakeGuest>();
  readonly calls: string[] = [];
  readonly #failures = new Map<DriverOperation, { error: Error; times: number }>();
  #nextPort = FAKE_FIRST_PORT;
  #nextPid = 9_000;
  /** Applied to every new guest, e.g. to install a custom agent behaviour. */
  configureGuest: (guest: FakeGuest) => void = () => {};
  rebootDelayMs = 30;
  goldenImage = "images/golden-test.qcow2";
  runtimeImage = "images/runtime-test.iso";

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

  /** Power a VM off behind the control plane's back, as a crash or a host reboot would. */
  crash(dotId: string): void {
    const vm = this.vms.get(dotId);
    if (vm) Object.assign(vm, { state: "STOPPED", guestPort: null, pid: null });
    this.guests.get(dotId)?.powerOff();
  }

  async create(spec: ComputerSpecInput): Promise<CreatedComputer> {
    this.#enter("create", spec.dotId);
    if (!this.vms.has(spec.dotId)) this.vms.set(spec.dotId, { state: "STOPPED", guestPort: null, pid: null, token: spec.token });
    if (!this.guests.has(spec.dotId)) {
      const guest = new FakeGuest(spec.token);
      this.configureGuest(guest);
      this.guests.set(spec.dotId, guest);
    }
    return { goldenImage: this.goldenImage, runtimeImage: this.runtimeImage };
  }

  async start(spec: ComputerSpecInput & { goldenImage: string }): Promise<StartedComputer> {
    this.#enter("start", spec.dotId);
    const vm = this.vms.get(spec.dotId);
    if (!vm) throw new Error(`the disk of ${spec.dotId} does not exist`);
    if (vm.state === "RUNNING" && vm.guestPort !== null && vm.pid !== null) {
      return { guestPort: vm.guestPort, pid: vm.pid, runtimeImage: this.runtimeImage, alreadyRunning: true };
    }
    Object.assign(vm, { state: "RUNNING", guestPort: this.#nextPort++, pid: this.#nextPid++ });
    this.guestOf(spec.dotId).boot();
    return { guestPort: vm.guestPort!, pid: vm.pid!, runtimeImage: this.runtimeImage, alreadyRunning: false };
  }

  async stop(dotId: string, token: string) {
    this.#enter("stop", dotId);
    // Like dot-agentd: the poweroff needs the Dot's token.
    if (this.vms.get(dotId) && token !== this.vms.get(dotId)!.token) throw new FakeGuestError(401, "unauthorized", "unauthorized");
    this.crash(dotId);
    return { forced: false };
  }

  /** Like the real one: the guest goes down, comes back a moment later, and the port changes. */
  async reboot(spec: ComputerSpecInput & { goldenImage: string }): Promise<StartedComputer> {
    this.#enter("reboot", spec.dotId);
    const vm = this.vms.get(spec.dotId);
    if (!vm) throw new Error(`the disk of ${spec.dotId} does not exist`);
    Object.assign(vm, { state: "RUNNING", guestPort: this.#nextPort++, pid: this.#nextPid++ });
    this.guestOf(spec.dotId).reboot(this.rebootDelayMs);
    return { guestPort: vm.guestPort!, pid: vm.pid!, runtimeImage: this.runtimeImage, alreadyRunning: false };
  }

  /** vm-manager's rule and loop (pollGuestHealth), with "QEMU exited" as the check, as VmManager has. */
  async waitForHealth(endpoint: GuestEndpoint, token: string, options: WaitForHealthOptions): Promise<HealthAnswer> {
    const source = { address: `fake:${endpoint.port}`, health: (o: { timeoutMs?: number }) => this.guest(endpoint, token).health(o) };
    return pollGuestHealth(source, {
      timeoutMs: options.timeoutMs,
      intervalMs: options.intervalMs,
      requestTimeoutMs: options.requestTimeoutMs,
      check: () => {
        if (this.vms.get(endpoint.dotId)?.state !== "RUNNING") throw new Error(`QEMU of ${endpoint.dotId} is not running any more`);
      },
    });
  }

  async destroy(dotId: string) {
    this.#enter("destroy", dotId);
    this.guests.get(dotId)?.powerOff();
    this.vms.delete(dotId);
    this.guests.delete(dotId);
  }

  async state(dotId: string): Promise<ComputerState> {
    const vm = this.vms.get(dotId);
    if (!vm) return { exists: false, state: "STOPPED", pid: null, guestPort: null, detail: null };
    return { exists: true, state: vm.state, pid: vm.pid, guestPort: vm.guestPort, detail: vm.state === "RUNNING" ? "running" : null };
  }

  guest(endpoint: GuestEndpoint, token: string): GuestApi {
    const vm = this.vms.get(endpoint.dotId);
    const guest = this.guests.get(endpoint.dotId);
    const refuse = (status: number, message: string, code?: string) =>
      new Proxy({} as GuestApi, {
        // Not a thenable: `await` on the client must not call "then" and hang.
        get: (_target, property) =>
          property === "then"
            ? undefined
            : async () => {
                throw new FakeGuestError(status, message, code);
              },
      });
    // A port the VM no longer runs with reaches nothing, like a stale forward after a restart.
    if (!vm || !guest || vm.guestPort !== endpoint.port) {
      return refuse(0, `connect ECONNREFUSED 127.0.0.1:${endpoint.port}`, "ECONNREFUSED");
    }
    // Every call is refused, like dot-agentd answering 401 to a wrong token.
    if (token !== guest.token) return refuse(401, "unauthorized", "unauthorized");
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

/**
 * Wait until the Dot is READY and doing nothing: no lifecycle operation
 * under its lock, every event its fake guest emitted so far stored by the
 * pump, and what READY and those events started in the background done too
 * (the flush of its outbox, the push an agent.started asks for). A test that
 * starts earlier races that work: an idle check skips a Dot whose outbox is
 * being flushed, and a guest event stored later counts as activity, which is
 * right in a server and a coin toss in a test.
 */
export async function waitUntilSettledReady(
  scheduler: {
    db: { dots: { get(id: string): Promise<{ status: string } | null> }; computers: { get(id: string): Promise<{ event_cursor: number } | null> } };
    lifecycle: { isBusy(id: string): boolean };
    settle(): Promise<void>;
  },
  driver: FakeDriver,
  dotId: string,
  what: string,
): Promise<void> {
  await waitFor(async () => (await scheduler.db.dots.get(dotId))?.status === "READY" && !scheduler.lifecycle.isBusy(dotId), `${what} READY`);
  const lastSeq = driver.guestOf(dotId).outbox.at(-1)?.seq ?? 0;
  await waitFor(async () => ((await scheduler.db.computers.get(dotId))?.event_cursor ?? 0) >= lastSeq, `${what}'s guest events stored`);
  await scheduler.settle();
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
