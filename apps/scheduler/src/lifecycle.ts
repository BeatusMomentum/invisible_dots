/**
 * The life of a Dot's computer on the host: create (section 9.4), the READY
 * procedure (9.3), sleep and wake (9.5), reboot, delete, the guest event
 * pump, and reconciliation with libvirt after a control plane restart.
 *
 * Every operation that changes a computer's state runs under a per-Dot lock,
 * so a wake and an idle sleep of the same Dot can never interleave.
 */
import type { Database } from "@invisible-dots/database";
import type { EventLog } from "@invisible-dots/events";
import {
  computerResources,
  toRuntimeConfig,
  type DotState,
  type HealthAnswer,
  type OutboundEvent,
  type StoredEvent,
  type VmState,
} from "@invisible-dots/shared";
import type { ComputerDriver, ComputerSpecInput, GuestApi } from "./driver.js";
import { applyGuestEvent, dotStatusForAgent } from "./guest-events.js";
import { ControlPlaneError, errorMessage, KeyedMutex, sleep, type Clock, type Logger } from "./support.js";

export interface LifecycleOptions {
  /** How long a started VM may take to pass the READY procedure. Default 10 minutes (a first boot runs cloud-init). */
  readyTimeoutMs: number;
  /** Interval between health polls while waiting for READY. Default 2 s. */
  healthPollMs: number;
  /** Per-request timeout of a health poll. Default 5 s. */
  healthRequestTimeoutMs: number;
  /** First retry delay of the event pump after a failure; doubles up to `pumpMaxRetryMs`. */
  pumpRetryMs: number;
  pumpMaxRetryMs: number;
  /** Time the agent gets to flush its state before a shutdown (section 9.5). */
  prepareSleepTimeoutMs: number;
}

export const DEFAULT_LIFECYCLE_OPTIONS: LifecycleOptions = {
  readyTimeoutMs: 10 * 60_000,
  healthPollMs: 2_000,
  healthRequestTimeoutMs: 5_000,
  pumpRetryMs: 1_000,
  pumpMaxRetryMs: 30_000,
  prepareSleepTimeoutMs: 60_000,
};

export interface LifecycleDeps {
  db: Database;
  events: EventLog;
  driver: ComputerDriver;
  clock: Clock;
  logger: Logger;
  options?: Partial<LifecycleOptions>;
  /** Called when a task reached a terminal state or a Dot became READY: the dispatcher may have work to hand out. */
  onWorkPossible?: () => void;
}

export type StopReason = "idle" | "user";

/** Part of the error a Dot gets when READY failed only for want of a key; setting a key retries those Dots. */
export const MISSING_KEY_MESSAGE = "no OpenRouter API key is configured";

/** The READY procedure failed; the message says which step and why. */
export class NotReadyError extends ControlPlaneError {
  constructor(dotId: string, message: string) {
    super(503, "computer_not_ready", `Dot ${dotId}: ${message}`);
    this.name = "NotReadyError";
  }
}

export class Lifecycle {
  readonly #db: Database;
  readonly #events: EventLog;
  readonly #driver: ComputerDriver;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #opts: LifecycleOptions;
  readonly #onWorkPossible: () => void;
  readonly #mutex = new KeyedMutex();
  /** Dots whose READY procedure completed since their computer last started. */
  readonly #ready = new Set<string>();
  readonly #pumps = new Map<string, AbortController>();
  readonly #pumpDone = new Map<string, Promise<void>>();
  #closed = false;

  constructor(deps: LifecycleDeps) {
    this.#db = deps.db;
    this.#events = deps.events;
    this.#driver = deps.driver;
    this.#clock = deps.clock;
    this.#log = deps.logger;
    this.#opts = { ...DEFAULT_LIFECYCLE_OPTIONS, ...deps.options };
    this.#onWorkPossible = deps.onWorkPossible ?? (() => {});
  }

  isReady(dotId: string): boolean {
    return this.#ready.has(dotId);
  }

  /** Whether a lifecycle operation is queued or running for the Dot. */
  isBusy(dotId: string): boolean {
    return this.#mutex.isBusy(dotId);
  }

  async guest(dotId: string): Promise<GuestApi> {
    return this.#driver.guest(dotId, await this.#db.computers.token(dotId));
  }

  async #setVmState(dotId: string, state: VmState, lastError?: string | null): Promise<void> {
    const before = await this.#db.computers.get(dotId);
    await this.#db.computers.setState(dotId, state, lastError);
    if (before?.state !== state) await this.#events.appendHost(dotId, "computer.state", { state });
  }

  async #setDotStatus(dotId: string, status: DotState, error: string | null = null): Promise<void> {
    const dot = await this.#db.dots.setStatus(dotId, status, error);
    if (dot && status === "ERROR") {
      await this.#events.appendHost(dotId, "dot.updated", { name: dot.name, status, error });
    }
  }

  /** Record a lifecycle failure on both rows, log it, and rethrow it. */
  async #fail(dotId: string, step: string, error: unknown): Promise<never> {
    const message = `${step} failed: ${errorMessage(error)}`;
    this.#log.error(message, { dotId });
    await this.#setVmState(dotId, "ERROR", message).catch(() => {});
    await this.#setDotStatus(dotId, "ERROR", message).catch(() => {});
    throw error instanceof ControlPlaneError ? error : new ControlPlaneError(502, "computer_error", `Dot ${dotId}: ${message}`);
  }

  async #spec(dotId: string): Promise<ComputerSpecInput & { goldenImage: string | null; state: VmState }> {
    const [dot, computer] = await Promise.all([this.#db.dots.get(dotId), this.#db.computers.get(dotId)]);
    if (!dot || !computer) throw new ControlPlaneError(404, "not_found", `Dot ${dotId} has no computer`);
    return {
      dotId,
      cid: computer.cid,
      token: await this.#db.computers.token(dotId),
      resources: computerResources(dot.config),
      goldenImage: computer.golden_image,
      state: computer.state,
    };
  }

  /** Section 9.4: provision the computer of a Dot inserted as CREATING, start it and bring it to READY. */
  provision(dotId: string): Promise<void> {
    return this.#mutex.run(dotId, async () => {
      const spec = await this.#spec(dotId);
      this.#log.info("provisioning computer", { dotId, cid: spec.cid });
      let created;
      try {
        created = await this.#driver.create(spec);
      } catch (error) {
        return this.#fail(dotId, "create", error);
      }
      await this.#db.computers.setImages(dotId, created.goldenImage, created.runtimeImage);
      await this.#startLocked(dotId);
    });
  }

  /**
   * Make sure the Dot can take work: start a stopped computer, finish the
   * READY procedure of a running one that is not READY yet. Resolves once
   * READY; throws (and leaves the Dot in ERROR) when that fails.
   */
  async ensureReady(dotId: string): Promise<void> {
    if (this.#ready.has(dotId)) return;
    await this.#mutex.run(dotId, async () => {
      if (this.#ready.has(dotId)) return;
      const computer = await this.#db.computers.get(dotId);
      if (!computer) throw new ControlPlaneError(404, "not_found", `Dot ${dotId} has no computer`);
      if (computer.state === "DELETING") throw new ControlPlaneError(409, "dot_deleting", `Dot ${dotId} is being deleted`);
      if (computer.state === "PROVISIONING") {
        throw new ControlPlaneError(409, "dot_provisioning", `Dot ${dotId} is still being provisioned`);
      }
      const domain = await this.#driver.state(dotId);
      if (domain.defined && domain.state === "RUNNING") {
        await this.#adoptRunning(dotId, computer.cid);
      } else {
        await this.#startLocked(dotId);
      }
    });
  }

  async #startLocked(dotId: string): Promise<void> {
    const spec = await this.#spec(dotId);
    if (!spec.goldenImage) {
      return this.#fail(dotId, "start", new Error("the computer has no golden image recorded; it was never created"));
    }
    await this.#setVmState(dotId, "STARTING");
    const reserved = (await this.#db.computers.list()).filter((c) => c.dot_id !== dotId).map((c) => c.cid);
    let started;
    try {
      started = await this.#driver.start({ ...spec, goldenImage: spec.goldenImage }, reserved);
    } catch (error) {
      return this.#fail(dotId, "start", error);
    }
    if (started.cid !== spec.cid) {
      this.#log.warn("computer started on another vsock CID", { dotId, requested: spec.cid, cid: started.cid });
      await this.#db.computers.setCid(dotId, started.cid);
    }
    await this.#db.computers.setImages(dotId, spec.goldenImage, started.runtimeImage);
    await this.#setVmState(dotId, "RUNNING", null);
    await this.#events.appendHost(dotId, "computer.started", { cid: started.cid, runtime_image: started.runtimeImage });
    await this.#readyProcedure(dotId);
  }

  /** A running domain the control plane is not attached to (after a restart, or after a failed READY). */
  async #adoptRunning(dotId: string, cid: number): Promise<void> {
    try {
      await this.#driver.attach(dotId, cid);
    } catch (error) {
      return this.#fail(dotId, "attach to the running computer", error);
    }
    await this.#setVmState(dotId, "RUNNING", null);
    await this.#readyProcedure(dotId);
  }

  /**
   * Section 9.3: wait for dot-agentd and the agent, push the OpenRouter key,
   * push the runtime config, then require the agent to report the key and
   * every self-check. Only then is the Dot READY and its events pumped.
   */
  async #readyProcedure(dotId: string, bootedAfter?: { uptimeBelow: number }): Promise<void> {
    const deadline = Date.now() + this.#opts.readyTimeoutMs;
    const guest = await this.guest(dotId);
    let health: HealthAnswer | undefined;
    let lastProblem = "no answer yet";
    // After a reboot, an answer only counts once it comes from the new boot:
    // the guest was unreachable in between, or its uptime went down.
    let wentDown = false;
    for (;;) {
      try {
        health = await guest.health({ timeoutMs: this.#opts.healthRequestTimeoutMs });
        if (bootedAfter && !wentDown && health.uptime_s >= bootedAfter.uptimeBelow) {
          lastProblem = `the guest has not rebooted yet (uptime ${health.uptime_s} s)`;
        } else if (health.agentd === "ok" && health.agent.status === "ok") {
          break;
        } else {
          lastProblem = `agentd ${health.agentd}, agent ${health.agent.status}`;
        }
      } catch (error) {
        if ((error as { status?: unknown }).status === 401) {
          return this.#fail(dotId, "READY", new Error("the guest refused the Dot token (401)"));
        }
        lastProblem = errorMessage(error);
        wentDown = true;
      }
      if (Date.now() + this.#opts.healthPollMs > deadline) {
        return this.#fail(
          dotId,
          "READY",
          new Error(`the guest was not healthy within ${this.#opts.readyTimeoutMs} ms; last problem: ${lastProblem}`),
        );
      }
      this.#log.debug("waiting for guest health", { dotId, problem: lastProblem });
      await sleep(this.#opts.healthPollMs);
    }

    const key = await this.#db.secrets.openRouterKey(dotId);
    if (!key) {
      return this.#fail(
        dotId,
        "READY",
        new NotReadyError(dotId, `${MISSING_KEY_MESSAGE}; set one with PUT /api/secrets/openrouter`),
      );
    }
    const dot = await this.#db.dots.get(dotId);
    if (!dot) throw new ControlPlaneError(404, "not_found", `Dot ${dotId} not found`);
    try {
      await guest.pushSecrets(key);
      await guest.putConfig(toRuntimeConfig(dot.config));
      health = await guest.health({ timeoutMs: this.#opts.healthRequestTimeoutMs });
    } catch (error) {
      return this.#fail(dotId, "READY (secret and config push)", error);
    }
    const problems: string[] = [];
    if (health.agent.status !== "ok") problems.push(`agent status ${health.agent.status}`);
    else {
      if (!health.agent.openrouter_configured) problems.push("the agent does not report the OpenRouter key as configured");
      const checks = health.agent.checks;
      if (!checks) problems.push("the agent reports no self-checks");
      else {
        if (!checks.filesystem_writable) problems.push("filesystem not writable");
        if (!checks.network_reachable) problems.push("network not reachable");
        if (!checks.browser_installed) problems.push("browser layer not installed");
      }
    }
    if (problems.length > 0) {
      return this.#fail(dotId, "READY", new NotReadyError(dotId, problems.join("; ")));
    }

    let agentState;
    try {
      agentState = await guest.state();
    } catch (error) {
      return this.#fail(dotId, "READY (agent state)", error);
    }
    this.#ready.add(dotId);
    await this.#db.computers.touch(dotId, this.#clock.now());
    // The status comes from the state snapshot before the pump starts, so a
    // pumped agent.state, which is newer than the snapshot, always wins.
    await this.#setDotStatus(dotId, dotStatusForAgent(agentState.state));
    this.#startPump(dotId);
    this.#log.info("dot ready", { dotId, agent: agentState.state });
    this.#onWorkPossible();
  }

  /** Put the Dot to sleep, or stop it on the user's request (section 9.5). */
  stop(dotId: string, reason: StopReason): Promise<void> {
    return this.#mutex.run(dotId, async () => {
      const computer = await this.#db.computers.get(dotId);
      if (!computer) throw new ControlPlaneError(404, "not_found", `Dot ${dotId} has no computer`);
      if (computer.state === "STOPPED") return;
      if (computer.state === "DELETING" || computer.state === "PROVISIONING") {
        throw new ControlPlaneError(409, "invalid_state", `Dot ${dotId} cannot be stopped while ${computer.state}`);
      }
      this.#log.info("stopping computer", { dotId, reason });
      await this.#setVmState(dotId, "STOPPING");
      if (this.#ready.has(dotId)) {
        try {
          const guest = await this.guest(dotId);
          await guest.prepareSleep(this.#opts.prepareSleepTimeoutMs);
        } catch (error) {
          // The shutdown still happens: the guest flushes its own state on SIGTERM too.
          this.#log.warn("prepare-sleep failed, shutting down anyway", { dotId, error: errorMessage(error) });
        }
      }
      this.#ready.delete(dotId);
      await this.#stopPump(dotId);
      let result;
      try {
        result = await this.#driver.stop(dotId);
      } catch (error) {
        return this.#fail(dotId, "stop", error);
      }
      await this.#setVmState(dotId, "STOPPED", null);
      await this.#events.appendHost(dotId, "computer.stopped", { reason, forced: result.forced });
      await this.#setDotStatus(dotId, "IDLE");
    });
  }

  /** `virsh reboot`, then the READY procedure against the new boot. */
  reboot(dotId: string): Promise<void> {
    return this.#mutex.run(dotId, async () => {
      const computer = await this.#db.computers.get(dotId);
      if (!computer) throw new ControlPlaneError(404, "not_found", `Dot ${dotId} has no computer`);
      if (computer.state !== "RUNNING") {
        throw new ControlPlaneError(409, "computer_stopped", `Dot ${dotId} cannot be rebooted while ${computer.state}`);
      }
      const guest = await this.guest(dotId);
      // The uptime tells the new boot from the old one, which may still answer for a moment.
      const uptime = await guest.health({ timeoutMs: this.#opts.healthRequestTimeoutMs }).then(
        (h) => h.uptime_s,
        () => undefined,
      );
      this.#ready.delete(dotId);
      await this.#stopPump(dotId);
      await this.#setVmState(dotId, "STARTING");
      try {
        await this.#driver.reboot(dotId);
      } catch (error) {
        return this.#fail(dotId, "reboot", error);
      }
      await this.#setVmState(dotId, "RUNNING", null);
      await this.#events.appendHost(dotId, "computer.started", { cid: computer.cid, reboot: true });
      await this.#readyProcedure(dotId, uptime === undefined ? undefined : { uptimeBelow: uptime });
    });
  }

  /** Destroy the VM and its disk, then remove the Dot's rows (the event log keeps its history). */
  remove(dotId: string): Promise<void> {
    return this.#mutex.run(dotId, async () => {
      const dot = await this.#db.dots.get(dotId);
      if (!dot) return;
      await this.#setVmState(dotId, "DELETING");
      this.#ready.delete(dotId);
      await this.#stopPump(dotId);
      try {
        await this.#driver.destroy(dotId);
      } catch (error) {
        return this.#fail(dotId, "delete", error);
      }
      await this.#db.dots.delete(dotId);
      await this.#events.appendHost(dotId, "dot.deleted", { name: dot.name });
      this.#log.info("dot deleted", { dotId, name: dot.name });
    });
  }

  /** Push the current runtime config to a READY guest (after PATCH). */
  async pushConfig(dotId: string): Promise<boolean> {
    if (!this.#ready.has(dotId)) return false;
    const dot = await this.#db.dots.get(dotId);
    if (!dot) return false;
    await (await this.guest(dotId)).putConfig(toRuntimeConfig(dot.config));
    return true;
  }

  /** Push the OpenRouter key again to a READY guest (after it changed). */
  async pushSecret(dotId: string): Promise<boolean> {
    if (!this.#ready.has(dotId)) return false;
    const key = await this.#db.secrets.openRouterKey(dotId);
    if (!key) return false;
    await (await this.guest(dotId)).pushSecrets(key);
    return true;
  }

  readyDots(): string[] {
    return [...this.#ready];
  }

  /** A failed call means the guest may be gone: the next delivery re-checks READY instead of trusting it. */
  markSuspect(dotId: string): void {
    this.#ready.delete(dotId);
  }

  #startPump(dotId: string): void {
    if (this.#pumps.has(dotId) || this.#closed) return;
    const controller = new AbortController();
    this.#pumps.set(dotId, controller);
    const done = this.#pump(dotId, controller.signal).finally(() => {
      if (this.#pumps.get(dotId) === controller) this.#pumps.delete(dotId);
      this.#pumpDone.delete(dotId);
    });
    this.#pumpDone.set(dotId, done);
  }

  async #stopPump(dotId: string): Promise<void> {
    this.#pumps.get(dotId)?.abort();
    await this.#pumpDone.get(dotId);
  }

  /**
   * Consume the guest's outbound stream from the stored cursor. Every event
   * is stored, applied and the cursor advanced in ONE transaction, so a crash
   * between two events loses nothing and applies nothing twice. On a failure
   * the loop starts over from the cursor in the database.
   */
  async #pump(dotId: string, signal: AbortSignal): Promise<void> {
    let delay = this.#opts.pumpRetryMs;
    while (!signal.aborted) {
      try {
        const computer = await this.#db.computers.get(dotId);
        if (!computer) return;
        const guest = await this.guest(dotId);
        this.#log.debug("event pump connecting", { dotId, after: computer.event_cursor });
        for await (const event of guest.events({ after: computer.event_cursor, signal })) {
          if (signal.aborted) return;
          await this.handleGuestEvent(dotId, event);
          delay = this.#opts.pumpRetryMs;
        }
        if (signal.aborted) return;
        this.#log.warn("guest event stream ended", { dotId });
      } catch (error) {
        if (signal.aborted) return;
        this.#log.warn("event pump failed, retrying", { dotId, error: errorMessage(error), retryMs: delay });
      }
      await sleep(delay, signal);
      delay = Math.min(delay * 2, this.#opts.pumpMaxRetryMs);
    }
  }

  /** Store and apply one guest event; exported for recovery tools and tests. */
  async handleGuestEvent(dotId: string, event: OutboundEvent): Promise<StoredEvent | null> {
    const now = this.#clock.now();
    const { stored, applied } = await this.#db.transaction(async (tx) => {
      const stored = await this.#events.appendGuest(tx, dotId, event);
      await tx.computers.advanceCursor(dotId, event.seq, now);
      const applied = stored ? await applyGuestEvent(tx, dotId, event) : { taskSettled: false };
      return { stored, applied };
    });
    if (stored) this.#events.publish(stored);
    if (applied.taskSettled) this.#onWorkPossible();
    return stored;
  }

  /**
   * After a control plane restart: bring the database in line with what
   * libvirt says, finish interrupted operations, and run the READY procedure
   * for every computer that is still running. Returns once each Dot's
   * recovery has started; the slow parts continue in the background.
   */
  async recover(): Promise<Promise<void>[]> {
    const background: Promise<void>[] = [];
    const track = (dotId: string, what: string, work: Promise<void>) =>
      background.push(work.catch((error) => this.#log.error(`recovery: ${what} failed`, { dotId, error: errorMessage(error) })));

    for (const computer of await this.#db.computers.list()) {
      const dotId = computer.dot_id;
      if (computer.state === "PROVISIONING") {
        this.#log.info("recovery: resuming provisioning", { dotId });
        track(dotId, "provisioning", this.provision(dotId));
        continue;
      }
      if (computer.state === "DELETING") {
        this.#log.info("recovery: resuming deletion", { dotId });
        track(dotId, "deletion", this.remove(dotId));
        continue;
      }
      let domain;
      try {
        domain = await this.#driver.state(dotId);
      } catch (error) {
        this.#log.error("recovery: cannot read the domain state", { dotId, error: errorMessage(error) });
        continue;
      }
      if (!domain.defined) {
        await this.#setVmState(dotId, "ERROR", "the libvirt domain is missing");
        await this.#setDotStatus(dotId, "ERROR", "the libvirt domain is missing");
        continue;
      }
      if (domain.state === "RUNNING") {
        if (computer.state === "STOPPING") {
          this.#log.info("recovery: finishing an interrupted stop", { dotId });
          await this.#db.computers.setState(dotId, "RUNNING");
          track(dotId, "stop", this.stop(dotId, "user"));
        } else {
          this.#log.info("recovery: reattaching to a running computer", { dotId, was: computer.state });
          track(dotId, "reattach", this.#mutex.run(dotId, () => this.#adoptRunning(dotId, computer.cid)));
        }
      } else if (domain.state === "STOPPING") {
        track(dotId, "stop", this.stop(dotId, "user"));
      } else if (domain.state === "STOPPED") {
        if (computer.state !== "STOPPED") {
          this.#log.info("recovery: computer is off", { dotId, was: computer.state });
          await this.#setVmState(dotId, "STOPPED");
          const dot = await this.#db.dots.get(dotId);
          if (dot && dot.status !== "DISABLED" && dot.status !== "ERROR") await this.#setDotStatus(dotId, "IDLE");
        }
      } else {
        const message = `libvirt reports the domain as "${domain.detail ?? domain.state}"`;
        await this.#setVmState(dotId, "ERROR", message);
        await this.#setDotStatus(dotId, "ERROR", message);
      }
    }
    return background;
  }

  /** Stop every pump and release the driver's host resources. VMs keep running. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#pumps.values()) controller.abort();
    await Promise.all(this.#pumpDone.values());
    await this.#driver.close();
  }
}
