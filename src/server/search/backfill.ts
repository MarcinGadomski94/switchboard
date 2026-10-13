import type { SearchIndexing } from '../../core/search.ts';
import type { Store } from '../db/store.ts';
import { SEARCH_INDEX_VERSION, SEARCH_ITEM_SOURCES, type SearchItemKind } from '../db/repos/search.ts';

/** Events (or source rows) per backfill step. */
export const BACKFILL_BATCH = 250;

/** A step stops adding batches after this long (ms): the event loop is never held longer. */
export const BACKFILL_STEP_BUDGET_MS = 15;

/** While events are being written (one within this many ms), the backfill waits… */
export const BACKFILL_IDLE_MS = 250;

/** …but never longer than this between two steps, so it finishes under a constant stream too. */
export const BACKFILL_MAX_WAIT_MS = 1_000;

/** The first step runs this long after start (startup's own work goes first). */
export const BACKFILL_START_DELAY_MS = 1_500;

/** Options of {@link SearchBackfill}. */
export interface SearchBackfillOptions {
  readonly batch?: number;
  readonly stepBudgetMs?: number;
  readonly idleMs?: number;
  readonly maxWaitMs?: number;
  readonly startDelayMs?: number;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
  /** Called after each step (tests, the bench). */
  readonly onStep?: (progress: SearchIndexing) => void;
}

/** `search_state` keys. */
const KEY = {
  version: 'version',
  eventsUpto: 'events.upto',
  eventsDone: 'events.done',
  items: (kind: SearchItemKind) => `items.${kind}.done`,
  complete: 'complete',
} as const;

/**
 * D97 (`docs/search.md` → *Backfill*): fills the index with what was written before
 * it existed (or before {@link SEARCH_INDEX_VERSION} changed), in the background:
 * bounded steps ({@link BACKFILL_BATCH} rows, at most {@link BACKFILL_STEP_BUDGET_MS})
 * on timers, each after the database was free of event writes for
 * {@link BACKFILL_IDLE_MS} (at most {@link BACKFILL_MAX_WAIT_MS} of waiting), so
 * startup and event writes never wait on it. Progress is stored after every step
 * (`search_state`): a restart resumes where it stopped. Events newer than the
 * backfill's start are indexed by their own write; the sessions, todos, artifacts and
 * History rows are kept by triggers from migration 0042 on.
 */
export class SearchBackfill {
  readonly #store: Store;
  readonly #batch: number;
  readonly #budget: number;
  readonly #idle: number;
  readonly #maxWait: number;
  readonly #startDelay: number;
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;
  readonly #onStep: ((progress: SearchIndexing) => void) | undefined;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;
  #done = false;
  #initialized = false;
  #total = 0;
  #processed = 0;
  #waitingSince: number | null = null;
  /** ms spent in steps (the bench's backfill time without the waits). */
  busyMs = 0;
  /** When the backfill finished (ms since the epoch), `null` before. */
  finishedAt: number | null = null;

  constructor(store: Store, options: SearchBackfillOptions = {}) {
    this.#store = store;
    this.#batch = options.batch ?? BACKFILL_BATCH;
    this.#budget = options.stepBudgetMs ?? BACKFILL_STEP_BUDGET_MS;
    this.#idle = options.idleMs ?? BACKFILL_IDLE_MS;
    this.#maxWait = options.maxWaitMs ?? BACKFILL_MAX_WAIT_MS;
    this.#startDelay = options.startDelayMs ?? BACKFILL_START_DELAY_MS;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? ((error) => console.error('switchboard search backfill:', error));
    this.#onStep = options.onStep;
    if (!store.search.enabled) this.#done = true;
  }

  /** Where it stands: `done`, and the share of rows indexed. */
  progress(): SearchIndexing {
    if (this.#done) return { done: true, percent: 100 };
    if (!this.#initialized) return { done: false, percent: 0 };
    const percent = this.#total === 0 ? 100 : Math.min(99, Math.floor((this.#processed / this.#total) * 100));
    return { done: false, percent };
  }

  /** Starts the background steps (nothing to do once complete). */
  start(): void {
    if (this.#done || this.#stopped || this.#timer) return;
    this.#schedule(this.#startDelay);
  }

  /** Stops the timers (before the store closes); progress so far is kept. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Runs every step now, without waits (tests and the bench). */
  runToEnd(): SearchIndexing {
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
      // A failing step is tried again later (the database may be busy).
      this.#schedule(this.#maxWait * 5);
      return;
    }
    if (!this.#done) this.#schedule(0);
  }

  #init(): void {
    const search = this.#store.search;
    if (search.getState(KEY.version) !== String(SEARCH_INDEX_VERSION)) {
      // A new index version: every event again (the items are rewritten too; their triggers keep them current).
      if (search.getState(KEY.version) !== null) search.clearEvents();
      search.setState(KEY.eventsUpto, String(search.maxEventId()));
      search.setState(KEY.eventsDone, '0');
      for (const [kind] of SEARCH_ITEM_SOURCES) search.setState(KEY.items(kind), '0');
      search.setState(KEY.complete, '0');
      search.setState(KEY.version, String(SEARCH_INDEX_VERSION));
    }
    if (search.getState(KEY.complete) === '1') {
      this.#done = true;
      this.finishedAt = this.#now();
      return;
    }
    const upto = Number(search.getState(KEY.eventsUpto) ?? 0);
    const done = Number(search.getState(KEY.eventsDone) ?? 0);
    let total = search.countEvents(0, upto);
    let processed = search.countEvents(0, Math.min(done, upto));
    // The source rows still to walk (a source already walked adds nothing).
    for (const [kind] of SEARCH_ITEM_SOURCES) {
      const at = search.getState(KEY.items(kind));
      if (at !== 'end') total += search.countItems(kind, Number(at ?? 0));
    }
    this.#total = total;
    this.#processed = processed;
    this.#initialized = true;
  }

  /** One bounded step (synchronous: the database is). */
  step(): void {
    if (this.#done) return;
    const started = performance.now();
    if (!this.#initialized) this.#init();
    const search = this.#store.search;
    try {
      // At least one batch per step (so a zero budget still progresses), more while the budget lasts.
      let first = true;
      while (!this.#done && (first || performance.now() - started < this.#budget)) {
        first = false;
        // Items first (few rows), then events.
        const kind = SEARCH_ITEM_SOURCES.find(([k]) => search.getState(KEY.items(k)) !== 'end')?.[0];
        if (kind) {
          const at = Number(search.getState(KEY.items(kind)) ?? 0);
          const { last, read } = search.backfillItems(kind, at, this.#batch);
          this.#processed += read;
          search.setState(KEY.items(kind), read < this.#batch ? 'end' : String(last));
          continue;
        }
        const upto = Number(search.getState(KEY.eventsUpto) ?? 0);
        const at = Number(search.getState(KEY.eventsDone) ?? 0);
        const { last, read } = search.backfillEvents(at, upto, this.#batch);
        this.#processed += read;
        if (read < this.#batch || last >= upto) {
          search.setState(KEY.eventsDone, String(upto));
          search.setState(KEY.complete, '1');
          this.#done = true;
          this.finishedAt = this.#now();
        } else {
          search.setState(KEY.eventsDone, String(last));
        }
      }
    } finally {
      this.busyMs += performance.now() - started;
      this.#onStep?.(this.progress());
    }
  }
}
