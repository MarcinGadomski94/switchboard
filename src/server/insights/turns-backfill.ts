import type { InsightsBackfillState } from '../../core/insights.ts';
import { USAGE_MAX_SPAN_MS } from '../../core/usage-breakdown.ts';
import type { Store } from '../db/store.ts';
import { INSIGHTS_BACKFILL_BATCH, INSIGHTS_BACKFILL_IDLE_MS, INSIGHTS_BACKFILL_MAX_WAIT_MS, INSIGHTS_BACKFILL_START_DELAY_MS, INSIGHTS_BACKFILL_STEP_BUDGET_MS } from './backfill.ts';

/** Options of {@link UsageTurnsBackfill}. */
export interface UsageTurnsBackfillOptions {
  readonly batch?: number;
  readonly stepBudgetMs?: number;
  readonly idleMs?: number;
  readonly maxWaitMs?: number;
  readonly startDelayMs?: number;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

/**
 * D134 (`docs/insights.md` → *Usage breakdown*): adds the turns of the last 8 days before
 * migration 0050 to `insight_turns`, in the background, exactly like D108's rollup backfill
 * (`./backfill.ts`): bounded steps on timers, waiting while events are being written, the
 * progress (`insight_state.turns.done`) stored in each batch's transaction (a restart resumes,
 * never adds a turn twice; the event id is the row's key anyway). It starts at the first event
 * of the last 8 days (found once, by a binary search over the event ids); older turns are
 * never added (the breakdown reads at most a weekly window).
 */
export class UsageTurnsBackfill {
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
  #from = 0;
  #initialized = false;
  #waitingSince: number | null = null;

  constructor(store: Store, options: UsageTurnsBackfillOptions = {}) {
    this.#store = store;
    this.#batch = options.batch ?? INSIGHTS_BACKFILL_BATCH;
    this.#budget = options.stepBudgetMs ?? INSIGHTS_BACKFILL_STEP_BUDGET_MS;
    this.#idle = options.idleMs ?? INSIGHTS_BACKFILL_IDLE_MS;
    this.#maxWait = options.maxWaitMs ?? INSIGHTS_BACKFILL_MAX_WAIT_MS;
    this.#startDelay = options.startDelayMs ?? INSIGHTS_BACKFILL_START_DELAY_MS;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? ((error) => console.error('switchboard usage turns backfill:', error));
    if (!store.insights.turnsEnabled) this.#done = true;
  }

  /** Where it stands. */
  progress(): InsightsBackfillState {
    if (this.#done) return { done: true, percent: 100 };
    const insights = this.#store.insights;
    const upto = insights.turnsUpto;
    const doneRaw = insights.getState('turns.done');
    if (upto === 0 || (doneRaw !== null && Number(doneRaw) >= upto)) return { done: true, percent: 100 };
    if (!this.#initialized || doneRaw === null) return { done: false, percent: 0 };
    const span = Math.max(1, upto - this.#from);
    return { done: false, percent: Math.min(99, Math.floor(((Number(doneRaw) - this.#from) / span) * 100)) };
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
    const upto = insights.turnsUpto;
    if (insights.getState('turns.done') === null) {
      // First run: start at the first event of the last 8 days.
      const first = upto === 0 ? 0 : insights.firstEventIdSince(new Date(this.#now() - USAGE_MAX_SPAN_MS).toISOString());
      insights.setState('turns.done', String(Math.min(upto, Math.max(0, first - 1))));
    }
    const done = Number(insights.getState('turns.done') ?? 0);
    this.#from = done;
    this.#initialized = true;
    if (done >= upto) this.#done = true;
  }

  /** One bounded step. */
  step(): void {
    if (this.#done) return;
    if (!this.#initialized) this.#init();
    const started = performance.now();
    const insights = this.#store.insights;
    let first = true;
    while (!this.#done && (first || performance.now() - started < this.#budget)) {
      first = false;
      const upto = insights.turnsUpto;
      const at = Number(insights.getState('turns.done') ?? 0);
      const { last, read } = insights.backfillTurns(at, upto, this.#batch);
      if (read < this.#batch || last >= upto) this.#done = true;
    }
  }
}
