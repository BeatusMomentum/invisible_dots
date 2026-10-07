/** Small pieces the scheduler is built from: clock, logger, a per-key lock and the error types the API maps to HTTP. */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** The logger shape vm-manager uses too, so one logger serves the whole process. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function prefixedStderrLogger(prefix: string, debug = false): Logger {
  const write = (level: string, message: string, fields?: Record<string, unknown>) => {
    const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
    process.stderr.write(`${new Date().toISOString()} [${prefix}] ${level} ${message}${suffix}\n`);
  };
  return {
    debug: debug ? (m, f) => write("debug", m, f) : () => {},
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Serializes work per key: lifecycle operations on one Dot (create, start,
 * stop, reboot, delete) run one after the other, operations on different
 * Dots run in parallel.
 */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    const tail = result.catch(() => {});
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return result;
  }

  isBusy(key: string): boolean {
    return this.#tails.has(key);
  }
}

/** An error with the HTTP status and `error` code the API answers with (section 9.6). */
export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

export const notFound = (what: string, id: string) => new ControlPlaneError(404, "not_found", `${what} "${id}" not found`);

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
