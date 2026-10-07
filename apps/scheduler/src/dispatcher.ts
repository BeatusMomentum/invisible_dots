/**
 * Hands PENDING tasks to their Dots (section 9.2): claim one task per idle
 * Dot with SKIP LOCKED. The claim stores the task's `task.created` in the
 * inbound outbox in the same transaction; sending it, waking the Dot first
 * when it sleeps, and failing the task when it cannot be delivered, is the
 * inbound delivery's job (inbound.ts).
 */
import type { Database } from "@invisible-dots/database";
import { errorMessage, type Clock, type Logger } from "./support.js";

export class Dispatcher {
  #running: Promise<void> | null = null;
  #again = false;

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly log: Logger,
    /** Called with the Dot of every claimed task: its task.created is waiting in the outbox. */
    private readonly deliver: (dotId: string) => void,
  ) {}

  /**
   * Claim every task that can run now. Calls that arrive while a pass is
   * running schedule one more pass instead of running concurrently, so one
   * dispatcher never races itself. Resolves when the pass is over.
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
            const ts = this.clock.now().toISOString();
            const claimed = await this.db.transaction((tx) => tx.tasks.claimNext(ts));
            if (!claimed) break;
            this.log.info("task claimed", { taskId: claimed.task.id, dotId: claimed.task.dot_id });
            this.deliver(claimed.task.dot_id);
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

  /** Whether a pass is running. */
  get busy(): boolean {
    return this.#running !== null;
  }

  /** Wait for the current pass (tests and shutdown). */
  async settle(): Promise<void> {
    while (this.#running) await this.#running;
  }
}
