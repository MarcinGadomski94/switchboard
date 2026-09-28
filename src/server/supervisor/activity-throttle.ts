/**
 * D19: the `/hub` `activity` event goes out at most once per interval per session
 * (`docs/hub.md`). Thinking-token ticks can arrive many times a second; the first
 * change after a quiet interval is sent at once, later ones fold into one trailing
 * send of the newest value when the interval is over. Nothing is lost: the last
 * value always goes out.
 */

/** Default interval between two `activity` events of one session (ms). */
export const ACTIVITY_INTERVAL_MS = 1_000;

/** The clock and timers of a {@link LatestThrottle} (tests pass fake ones). */
export interface ThrottleTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Real timers; the pending timer never keeps the process alive. */
export const REAL_TIMERS: ThrottleTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Options for {@link LatestThrottle}. */
export interface LatestThrottleOptions<T> {
  /** Minimum gap between two sends (ms). */
  readonly intervalMs: number;
  readonly send: (value: T) => void;
  /** Identity of a value: a trailing value equal to the last one sent is dropped (default `JSON.stringify`). */
  readonly key?: (value: T) => string;
  readonly timers?: ThrottleTimers;
}

/** Sends the newest pushed value, at most once per `intervalMs` (leading + trailing). */
export class LatestThrottle<T> {
  readonly #intervalMs: number;
  readonly #send: (value: T) => void;
  readonly #key: (value: T) => string;
  readonly #timers: ThrottleTimers;
  #lastSentAt = Number.NEGATIVE_INFINITY;
  #lastKey: string | null = null;
  #pending: { readonly value: T } | null = null;
  #timer: unknown = null;

  constructor(options: LatestThrottleOptions<T>) {
    this.#intervalMs = options.intervalMs;
    this.#send = options.send;
    this.#key = options.key ?? ((value) => JSON.stringify(value));
    this.#timers = options.timers ?? REAL_TIMERS;
  }

  /** Sends `value` now when the interval since the last send is over, else as the trailing send. */
  push(value: T): void {
    const wait = this.#lastSentAt + this.#intervalMs - this.#timers.now();
    if (wait <= 0 && this.#timer === null) {
      this.#deliver(value);
      return;
    }
    this.#pending = { value };
    if (this.#timer === null) this.#timer = this.#timers.setTimeout(() => this.#fire(), Math.max(wait, 0));
  }

  /** Drops a pending trailing send. */
  cancel(): void {
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
    this.#pending = null;
  }

  #fire(): void {
    this.#timer = null;
    const pending = this.#pending;
    this.#pending = null;
    if (pending && this.#key(pending.value) !== this.#lastKey) this.#deliver(pending.value);
  }

  #deliver(value: T): void {
    this.#lastSentAt = this.#timers.now();
    this.#lastKey = this.#key(value);
    this.#send(value);
  }
}
