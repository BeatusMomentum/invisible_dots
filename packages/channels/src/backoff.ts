/** Exponential backoff with jitter, for a failing adapter and for a send that keeps failing. */
export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  /** Growth per failure; default 2. */
  factor?: number;
  /** Fraction of the delay that is random, 0 to 1; default 0.2. */
  jitter?: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 1_000, maxMs: 60_000 };

export class Backoff {
  #failures = 0;

  constructor(
    private readonly options: BackoffOptions,
    private readonly random: () => number = Math.random,
  ) {}

  /** The delay before the next attempt; every call counts one more failure. */
  next(): number {
    const factor = this.options.factor ?? 2;
    const jitter = this.options.jitter ?? 0.2;
    const base = Math.min(this.options.maxMs, this.options.initialMs * factor ** this.#failures);
    this.#failures++;
    // Jitter only shortens the wait, so the maximum is a real maximum.
    return Math.max(0, Math.round(base * (1 - jitter * this.random())));
  }

  /** The thing works again: start over from the initial delay. */
  reset(): void {
    this.#failures = 0;
  }
}
