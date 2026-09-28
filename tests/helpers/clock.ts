import type { SchedulerClock } from '../../src/server/schedules/scheduler.ts';

interface FakeTimer {
  readonly at: number;
  readonly callback: () => void;
}

/**
 * A manual clock for the scheduler (M7.1): `now()` only moves when the test says
 * so, and timers fire in time order while {@link FakeClock.advanceTo} walks
 * forward, each followed by `settle` (the scheduler's `settled()`), so a firing's
 * work is done before the next timer is looked at.
 */
export class FakeClock implements SchedulerClock {
  #now: number;
  #seq = 0;
  readonly #timers = new Map<number, FakeTimer>();

  constructor(start: Date) {
    this.#now = start.getTime();
  }

  now(): Date {
    return new Date(this.#now);
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.#now + Math.max(ms, 0), callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  /** The pending timers' delays from now, soonest first. */
  delays(): number[] {
    return [...this.#timers.values()].map((timer) => timer.at - this.#now).sort((a, b) => a - b);
  }

  /** Moves to `target`, firing every timer due on the way (in order), awaiting `settle` after each. */
  async advanceTo(target: Date, settle: () => Promise<void>): Promise<void> {
    for (;;) {
      const due = [...this.#timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!due || due[1].at > target.getTime()) break;
      this.#timers.delete(due[0]);
      this.#now = Math.max(this.#now, due[1].at);
      due[1].callback();
      await settle();
    }
    this.#now = Math.max(this.#now, target.getTime());
  }

  /** Jumps to `target` without firing anything (a machine that slept, a service that was down). */
  jumpTo(target: Date): void {
    this.#now = target.getTime();
  }
}
