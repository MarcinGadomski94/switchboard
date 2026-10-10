import type { Store } from './store.ts';

/** How often the maintenance looks whether the database is idle. */
export const MAINTENANCE_EVERY_MS = 10 * 60_000;

/** No event written for this long counts as idle. */
export const MAINTENANCE_IDLE_MS = 60_000;

/**
 * D95 (`docs/performance.md` → *Database maintenance*): the long-lived connection's
 * upkeep. At start `PRAGMA optimize=0x10002` (SQLite's advice for a connection
 * that stays open, with `analysis_limit` 400); then every {@link MAINTENANCE_EVERY_MS}, once no event was
 * written for {@link MAINTENANCE_IDLE_MS}: `PRAGMA optimize` and
 * `PRAGMA wal_checkpoint(TRUNCATE)` (the WAL file goes back to empty instead of
 * staying at its largest size). A step that cannot run now (another connection reads) is
 * left for the next round. `stop()` ends it (before the store closes).
 */
export class DatabaseMaintenance {
  readonly #store: Store;
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;
  readonly #timer: ReturnType<typeof setInterval> | null;

  constructor(store: Store, options: { readonly everyMs?: number; readonly now?: () => number; readonly onError?: (error: unknown) => void; readonly timer?: boolean } = {}) {
    this.#store = store;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? ((error) => console.error('switchboard database maintenance:', error));
    try {
      // A bounded ANALYZE (SQLite's advice with optimize): a few hundred rows per index, not the whole history.
      store.db.exec('PRAGMA analysis_limit=400');
      store.db.exec('PRAGMA optimize=0x10002');
    } catch (error) {
      this.#onError(error);
    }
    if (options.timer === false) {
      this.#timer = null;
      return;
    }
    this.#timer = setInterval(() => void this.run(), options.everyMs ?? MAINTENANCE_EVERY_MS);
    this.#timer.unref?.();
  }

  /** One round: `true` when it ran (the database was idle), `false` when it waited. */
  async run(): Promise<boolean> {
    const last = this.#store.events.lastWriteAt;
    if (last !== null && this.#now() - last < MAINTENANCE_IDLE_MS) return false;
    try {
      // optimize first: what it writes (statistics) goes out of the WAL with the checkpoint.
      this.#store.db.exec('PRAGMA optimize');
      this.#store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (error) {
      this.#onError(error);
    }
    return true;
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }
}
