/**
 * The web server as a child of `invisible-dots server` (architecture section
 * 9.7) must not outlive it. A normal stop kills the child, but a `kill -9` or
 * a crash of the parent skips that, and the orphan would keep the port (and
 * an older build) for the next start. So the child watches its parent: the
 * parent names its pid in INVISIBLE_DOTS_WEB_PARENT_PID, and the child exits
 * once that process is gone. No dependencies, so a plain `node` can load it.
 */

export interface ParentWatchOptions {
  /** Whether a process with this pid exists (shared's processExists). */
  exists: (pid: number) => boolean;
  /** Called once when the parent is gone. */
  onGone: () => void;
  /** How often the parent is looked at. */
  intervalMs?: number;
}

export const PARENT_WATCH_INTERVAL_MS = 1000;

/** Watch `parentPid`; returns the function that stops watching. The timer never keeps the process alive by itself. */
export function exitWhenParentGone(parentPid: number, options: ParentWatchOptions): () => void {
  const timer = setInterval(() => {
    if (options.exists(parentPid)) return;
    clearInterval(timer);
    options.onGone();
  }, options.intervalMs ?? PARENT_WATCH_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** The parent pid a server was started with, or undefined when it was not started by `invisible-dots server`. */
export function parentPidFrom(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return undefined;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : undefined;
}
