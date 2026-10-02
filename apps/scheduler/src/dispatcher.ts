/**
 * Hands PENDING tasks to their Dots (section 9.2): claim one task per idle
 * Dot with SKIP LOCKED, wake the Dot when it sleeps, then deliver
 * `task.created`. A delivery that fails puts the task back in the queue with
 * a delay; after `maxDeliveryAttempts` failures the task is FAILED.
 */
import type { ClaimedTask, Database } from "@invisible-dots/database";
import { newId, type InboundEvent } from "@invisible-dots/shared";
import type { Lifecycle } from "./lifecycle.js";
import { errorMessage, type Clock, type Logger } from "./support.js";

export interface DispatcherOptions {
  maxDeliveryAttempts: number;
  /** Delay before a failed delivery is retried; multiplied by the attempt number. */
  retryDelayMs: number;
}

export const DEFAULT_DISPATCHER_OPTIONS: DispatcherOptions = {
  maxDeliveryAttempts: 3,
  retryDelayMs: 30_000,
};

export class Dispatcher {
  #running: Promise<void> | null = null;
  #again = false;
  readonly #inFlight = new Set<Promise<void>>();
  readonly #opts: DispatcherOptions;

  constructor(
    private readonly db: Database,
    private readonly lifecycle: Lifecycle,
    private readonly clock: Clock,
    private readonly log: Logger,
    options: Partial<DispatcherOptions> = {},
  ) {
    this.#opts = { ...DEFAULT_DISPATCHER_OPTIONS, ...options };
  }

  /**
   * Claim every task that can run now and start delivering each. Calls that
   * arrive while a pass is running schedule one more pass instead of running
   * concurrently. Resolves when the pass (not the deliveries) is over.
   */
  dispatch(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      try {
        do {
          this.#again = false;
          for (;;) {
            const claimed = await this.db.transaction((tx) => tx.tasks.claimNext());
            if (!claimed) break;
            this.log.info("task claimed", { taskId: claimed.task.id, dotId: claimed.task.dot_id });
            const delivery = this.#deliver(claimed)
              .catch((error) => this.log.error("task delivery bookkeeping failed", { taskId: claimed.task.id, error: errorMessage(error) }))
              .finally(() => this.#inFlight.delete(delivery));
            this.#inFlight.add(delivery);
          }
        } while (this.#again);
      } catch (error) {
        this.log.error("dispatch pass failed", { error: errorMessage(error) });
      } finally {
        this.#running = null;
      }
    })();
    return this.#running;
  }

  /** Wait for the current pass and every delivery it started (tests and shutdown). */
  async settle(): Promise<void> {
    while (this.#running || this.#inFlight.size > 0) {
      await this.#running;
      await Promise.all([...this.#inFlight]);
    }
  }

  async #deliver({ task, run }: ClaimedTask): Promise<void> {
    try {
      await this.lifecycle.ensureReady(task.dot_id);
      const event: InboundEvent<"task.created"> = {
        id: newId("evt"),
        type: "task.created",
        ts: this.clock.now().toISOString(),
        data: { task_id: task.id, description: task.description, priority: task.priority },
      };
      try {
        await (await this.lifecycle.guest(task.dot_id)).postEvent(event);
      } catch (error) {
        this.lifecycle.markSuspect(task.dot_id);
        throw error;
      }
      await this.db.tasks.markDelivered(run.id);
      await this.db.computers.touch(task.dot_id, this.clock.now());
      this.log.info("task delivered", { taskId: task.id, dotId: task.dot_id });
    } catch (error) {
      const reason = errorMessage(error);
      const attempts = (await this.db.tasks.failedDeliveries(task.id)) + 1;
      if (attempts >= this.#opts.maxDeliveryAttempts) {
        this.log.error("task delivery failed for good", { taskId: task.id, attempts, error: reason });
        await this.db.tasks.transition(task.id, "FAILED", {
          error: `could not be delivered to the Dot after ${attempts} attempts: ${reason}`,
        });
      } else {
        const delay = this.#opts.retryDelayMs * attempts;
        // scheduled_at is compared with the database's now(), so a zero delay is "no date" rather than this host's now.
        const retryAt = delay > 0 ? new Date(Date.now() + delay) : null;
        this.log.warn("task delivery failed, will retry", { taskId: task.id, attempts, retryAt, error: reason });
        await this.db.tasks.requeue(task.id, run.id, `undelivered: ${reason}`, retryAt);
        const timer = setTimeout(() => void this.dispatch(), delay);
        timer.unref();
      }
    }
  }
}
