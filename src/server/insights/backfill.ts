import type { InsightsBackfillState } from '../../core/insights.ts';
import type { Store } from '../db/store.ts';

/** Candidate events (results and lifecycle lines) per backfill batch. */
export const INSIGHTS_BACKFILL_BATCH = 500;

/** A step stops adding batches after this long (ms). */
export const INSIGHTS_BACKFILL_STEP_BUDGET_MS = 15;

/** While events are being written (one within this many ms), the backfill waits… */
export const INSIGHTS_BACKFILL_IDLE_MS = 250;

/** …but never longer than this between two steps. */
export const INSIGHTS_BACKFILL_MAX_WAIT_MS = 1_000;

/** The first step runs this long after start (after D97's search backfill has begun). */
export const INSIGHTS_BACKFILL_START_DELAY_MS = 2_000;

/** Options of {@link InsightsBackfill}. */
export interface InsightsBackfillOptions {
  readonly batch?: number;
  readonly stepBudgetMs?: number;
  readonly idleMs?: number;
  readonly maxWaitMs?: number;
  readonly startDelayMs?: number;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

/**
 * D108 (`docs/insights.md` → *Rollup and backfill*): adds the events written before
 * migration 0045 to the daily rollup, in the background, the way D97's search backfill
 * does: bounded steps ({@link INSIGHTS_BACKFILL_BATCH} candidate events, at most
 * {@link INSIGHTS_BACKFILL_STEP_BUDGET_MS}) on timers, each after the database was free of
 * event writes for {@link INSIGHTS_BACKFILL_IDLE_MS} (at most
 * {@link INSIGHTS_BACKFILL_MAX_WAIT_MS} of waiting). Progress (`insight_state.events.done`)
 * is stored in each batch's own transaction, so a restart resumes and
 * never counts an event twice. Events after `events.upto` are rolled up by their own write.
 */
export class InsightsBackfill {
  readonly #store: Store;
  readonly #batch: number;
  readonly #budget: number;
  readonly #idle: number;
  readonly #maxWait: number;
  readonly #startDelay: number;
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;
  #done = false;
  #initialized = false;
  #total = 0;
  #processed = 0;
  #waitingSince: number | null = null;
  /** ms spent in steps (the bench). */
  busyMs = 0;
  finishedAt: number | null = null;

  constructor(store: Store, options: InsightsBackfillOptions = {}) {
    this.#store = store;
    this.#batch = options.batch ?? INSIGHTS_BACKFILL_BATCH;
    this.#budget = options.stepBudgetMs ?? INSIGHTS_BACKFILL_STEP_BUDGET_MS;
    this.#idle = options.idleMs ?? INSIGHTS_BACKFILL_IDLE_MS;
    this.#maxWait = options.maxWaitMs ?? INSIGHTS_BACKFILL_MAX_WAIT_MS;
    this.#startDelay = options.startDelayMs ?? INSIGHTS_BACKFILL_START_DELAY_MS;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? ((error) => console.error('switchboard insights backfill:', error));
    if (!store.insights.enabled) this.#done = true;
  }

  /** Where it stands. */
  progress(): InsightsBackfillState {
    if (this.#done) return { done: true, percent: 100 };
    if (!this.#initialized) {
      // Not started yet: complete when nothing is left (a fresh install, or a finished earlier run).
      const insights = this.#store.insights;
      if (Number(insights.getState('events.done') ?? 0) >= insights.upto) return { done: true, percent: 100 };
      return { done: false, percent: 0 };
    }
    return { done: false, percent: this.#total === 0 ? 99 : Math.min(99, Math.floor((this.#processed / this.#total) * 100)) };
  }

  start(): void {
    if (this.#done || this.#stopped || this.#timer) return;
    this.#schedule(this.#startDelay);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Every step now, without waits (tests and the bench). */
  runToEnd(): InsightsBackfillState {
    while (!this.#done) this.step();
    return this.progress();
  }

  #schedule(ms: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#tick();
    }, ms);
    this.#timer.unref?.();
  }

  #tick(): void {
    if (this.#stopped || this.#done) return;
    const last = this.#store.events.lastWriteAt;
    const now = this.#now();
    if (last !== null && now - last < this.#idle) {
      this.#waitingSince ??= now;
      if (now - this.#waitingSince < this.#maxWait) {
        this.#schedule(Math.max(10, this.#idle - (now - last)));
        return;
      }
    }
    this.#waitingSince = null;
    try {
      this.step();
    } catch (error) {
      this.#onError(error);
      this.#schedule(this.#maxWait * 5);
      return;
    }
    if (!this.#done) this.#schedule(0);
  }

  #init(): void {
    const insights = this.#store.insights;
    const done = Number(insights.getState('events.done') ?? 0);
    this.#total = insights.countEvents(0, insights.upto);
    this.#processed = insights.countEvents(0, Math.min(done, insights.upto));
    this.#initialized = true;
    if (done >= insights.upto) this.#finish();
  }

  #finish(): void {
    this.#done = true;
    this.finishedAt = this.#now();
  }

  /** One bounded step. */
  step(): void {
    if (this.#done) return;
    const started = performance.now();
    try {
      if (!this.#initialized) this.#init();
      const insights = this.#store.insights;
      let first = true;
      while (!this.#done && (first || performance.now() - started < this.#budget)) {
        first = false;
        const upto = insights.upto;
        const at = Number(insights.getState('events.done') ?? 0);
        const { last, read } = insights.backfillEvents(at, upto, this.#batch);
        this.#processed += read;
        // The repository stored the progress with the batch.
        if (read < this.#batch || last >= upto) this.#finish();
      }
    } finally {
      this.busyMs += performance.now() - started;
    }
  }
}
