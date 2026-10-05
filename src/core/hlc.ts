/**
 * D71 · a hybrid logical clock (`docs/sidebar.md` → *Shared layout (D71)*): the
 * timestamps of the shared sidebar layout's items, so "last write wins" means
 * the same on every machine. A clock reads
 * `<ms, base 36, 9 digits>.<counter, base 36, 4 digits>.<machine id>`, compared
 * as a plain string: wall time first, then the counter (several writes in one
 * millisecond, or a peer's clock ahead of ours), then the machine id (a
 * deterministic tie-break). The empty string is older than every clock (layout
 * rows from before D71, migration 0029).
 */

/** The clock of rows written before D71: older than any clock. */
export const NO_CLOCK = '';

const MS_DIGITS = 9;
const COUNTER_DIGITS = 4;
const COUNTER_MAX = 36 ** COUNTER_DIGITS - 1;

/** A parsed clock. */
export interface ClockParts {
  readonly ms: number;
  readonly counter: number;
  readonly node: string;
}

/** Reads a clock (`null` for {@link NO_CLOCK} or anything malformed). */
export function parseClock(clock: string): ClockParts | null {
  const match = /^([0-9a-z]{9})\.([0-9a-z]{4})\.(.*)$/.exec(clock);
  if (!match) return null;
  return { ms: Number.parseInt(match[1] as string, 36), counter: Number.parseInt(match[2] as string, 36), node: match[3] as string };
}

/** Writes a clock. */
export function formatClock(parts: ClockParts): string {
  return `${parts.ms.toString(36).padStart(MS_DIGITS, '0')}.${parts.counter.toString(36).padStart(COUNTER_DIGITS, '0')}.${parts.node}`;
}

/** `true` for a clock {@link formatClock} writes, or {@link NO_CLOCK}. */
export function isClock(value: unknown): value is string {
  return value === NO_CLOCK || (typeof value === 'string' && value.length <= 120 && parseClock(value) !== null);
}

/** One machine's clock. */
export class HybridClock {
  #node: string;
  #ms = 0;
  #counter = 0;
  readonly #now: () => number;

  constructor(node: string, now: () => number = Date.now) {
    this.#node = node;
    this.#now = now;
  }

  /** The machine id written into each clock (set once this machine's id is known). */
  set node(node: string) {
    this.#node = node;
  }

  get node(): string {
    return this.#node;
  }

  /** A clock later than every clock this one has written or seen. */
  next(): string {
    const wall = this.#now();
    if (wall > this.#ms) {
      this.#ms = wall;
      this.#counter = 0;
    } else if (this.#counter >= COUNTER_MAX) {
      this.#ms += 1;
      this.#counter = 0;
    } else {
      this.#counter += 1;
    }
    return formatClock({ ms: this.#ms, counter: this.#counter, node: this.#node });
  }

  /** A peer's clock was seen: the next one written here is later than it. */
  observe(clock: string): void {
    const parts = parseClock(clock);
    if (!parts) return;
    if (parts.ms > this.#ms || (parts.ms === this.#ms && parts.counter > this.#counter)) {
      this.#ms = parts.ms;
      this.#counter = parts.counter;
    }
  }
}
