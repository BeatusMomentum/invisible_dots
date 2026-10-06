/**
 * What a person who is linking an account sees, kept in memory only: the code their phone scans is a short-lived
 * way into the account, so it is never stored, logged or put in the event log. The hub publishes a frame whenever
 * the adapter shows a code or its status changes; a watcher gets the state it joins at, then every change, up to
 * the last frame (`linked` or `failed`).
 */
import type { ChannelLinkFrame } from "@invisible-dots/shared";

export const isLastFrame = (frame: ChannelLinkFrame): boolean => frame.state === "linked" || frame.state === "failed";

export class LinkSessions {
  readonly #latest = new Map<string, ChannelLinkFrame>();
  readonly #watchers = new Map<string, Set<(frame: ChannelLinkFrame) => void>>();

  /** The newest frame of the binding, or undefined before any. */
  latest(bindingId: string): ChannelLinkFrame | undefined {
    return this.#latest.get(bindingId);
  }

  publish(bindingId: string, frame: ChannelLinkFrame): void {
    this.#latest.set(bindingId, frame);
    for (const watcher of this.#watchers.get(bindingId) ?? []) watcher(frame);
  }

  /** The binding is gone: its last frame goes with it. */
  forget(bindingId: string): void {
    this.#latest.delete(bindingId);
  }

  /** `initial`, then every frame published after, ending after the last frame or when `signal` aborts. */
  async *watch(bindingId: string, initial: ChannelLinkFrame, signal: AbortSignal): AsyncGenerator<ChannelLinkFrame> {
    const queue: ChannelLinkFrame[] = [initial];
    let wake: (() => void) | null = null;
    const watcher = (frame: ChannelLinkFrame) => {
      queue.push(frame);
      wake?.();
    };
    const onAbort = () => wake?.();
    signal.addEventListener("abort", onAbort);
    const watchers = this.#watchers.get(bindingId) ?? new Set();
    watchers.add(watcher);
    this.#watchers.set(bindingId, watchers);
    try {
      while (!signal.aborted) {
        const frame = queue.shift();
        if (frame === undefined) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
          continue;
        }
        yield frame;
        if (isLastFrame(frame)) return;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      watchers.delete(watcher);
      if (watchers.size === 0) this.#watchers.delete(bindingId);
    }
  }
}
