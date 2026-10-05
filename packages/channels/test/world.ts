/**
 * The world the hub tests run in: the real Scheduler with a FakeDriver and a FakeGuest (which answers a user
 * message with `echo: <text>`) on a test database, and hubs started next to it. Whatever a test makes is closed by
 * `closeAll`, newest first.
 */
import type { Database } from "@invisible-dots/database";
import { Scheduler } from "@invisible-dots/scheduler";
import { FakeDriver, ManualClock, waitUntilSettledReady } from "@invisible-dots/scheduler/testing";
import { ChannelHub, type ChannelHubOptions, type ChannelType } from "../src/index.js";
import { FakeChannelType } from "../src/testing.js";

const yaml = (name: string) => `name: ${name}\ngoal: keep watch\nmodel:\n  provider: openrouter\n  id: test/model\n`;

export const FAST_BACKOFF = { initialMs: 1, maxMs: 5, jitter: 0 };

/** Let the hub and the event loops settle: nothing they would do in the meantime is left undone. */
export const quiet = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

export function makeWorlds(db: Database) {
  const closers: (() => Promise<unknown>)[] = [];
  let seq = 0;

  async function world() {
    const driver = new FakeDriver();
    const scheduler = new Scheduler({
      db,
      driver,
      clock: new ManualClock(),
      lifecycle: { healthPollMs: 5, readyTimeoutMs: 3_000, pumpRetryMs: 10, pumpMaxRetryMs: 50 },
      dispatcher: { retryDelayMs: 0, maxDeliveryAttempts: 2 },
    });
    closers.push(() => scheduler.close());
    const clock = new ManualClock();
    /** A hub on this scheduler, started; `type` is what the hub makes channels with (default a FakeChannelType). */
    async function hub<T extends ChannelType = FakeChannelType>(type?: T, options: Partial<ChannelHubOptions> = {}) {
      const made = (type ?? new FakeChannelType()) as T;
      const h = new ChannelHub({ db, host: scheduler, types: [made], clock, backoff: FAST_BACKOFF, ...options });
      closers.push(() => h.close());
      await h.start();
      return { hub: h, type: made };
    }
    async function dot(name = `dot-${++seq}-${Math.random().toString(36).slice(2, 6)}`) {
      const created = await scheduler.createDot(yaml(name));
      await waitUntilSettledReady(scheduler, driver, created.id, name);
      return { ...created, guest: driver.guestOf(created.id) };
    }
    return { driver, scheduler, clock, hub, dot };
  }

  async function closeAll(): Promise<void> {
    for (const close of closers.splice(0).reverse()) await close();
  }

  return { world, closeAll };
}

export type World = Awaited<ReturnType<ReturnType<typeof makeWorlds>["world"]>>;
