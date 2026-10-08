import type { TourStatus } from '../../../core/tutorial.ts';
import type { RepoContext } from '../context.ts';
import { transaction } from '../database.ts';
import { Table, type TableSpec } from '../table.ts';

/** The settings key migration 0037 and {@link TutorialRepository.advance} keep the tutorial's last version in (the service's own, not a preference). */
export const LAST_VERSION_KEY = 'tutorial.lastVersion';

/** The settings key that remembers whether the tutorial first ran on a `new` install or an `existing` one (written once). */
export const INSTALL_KEY = 'tutorial.install';

/** D85 (0037): one tour's row in `tutorial_tours`. */
export interface TourRow {
  /** `main` or a What's-new feature id. */
  readonly tour: string;
  readonly status: TourStatus;
  /** The Switchboard version when the row was last written. */
  readonly version: string;
  readonly updatedAt: string;
}

const SPEC: TableSpec<TourRow> = {
  table: 'tutorial_tours',
  key: 'tour',
  fields: {
    tour: ['tour', 'text'],
    status: ['status', 'text'],
    version: ['version', 'text'],
    updatedAt: ['updated_at', 'text'],
  },
};

/** D85: the tours this machine has queued, finished or skipped (`docs/tutorial.md`). */
export class TutorialRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<TourRow>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
  }

  /** Every row, by tour id. */
  async list(): Promise<TourRow[]> {
    return this.#table.select('', [], 'tour');
  }

  /** Sets a tour's status (inserting its row when it has none). */
  async set(tour: string, status: TourStatus, version: string): Promise<TourRow> {
    const updatedAt = this.#ctx.now();
    this.#table
      .statement(
        'INSERT INTO tutorial_tours (tour, status, version, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (tour) DO UPDATE SET status = excluded.status, version = excluded.version, updated_at = excluded.updated_at',
      )
      .run(tour, status, version, updatedAt);
    return { tour, status, version, updatedAt };
  }

  /**
   * In one transaction: queues `tours` (status `pending`) that have no row yet
   * (rows already there are left alone) and stores `version` as the settings key
   * {@link LAST_VERSION_KEY}, the version the tutorial system last ran on (and
   * `install` as {@link INSTALL_KEY} when given).
   */
  async advance(tours: readonly string[], version: string, install?: 'new' | 'existing'): Promise<void> {
    transaction(this.#ctx.db, () => {
      const updatedAt = this.#ctx.now();
      const insert = this.#table.statement('INSERT INTO tutorial_tours (tour, status, version, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (tour) DO NOTHING');
      for (const tour of tours) insert.run(tour, 'pending', version, updatedAt);
      const setting = this.#table.statement('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
      setting.run(LAST_VERSION_KEY, JSON.stringify(version), updatedAt);
      if (install) setting.run(INSTALL_KEY, JSON.stringify(install), updatedAt);
    });
  }
}
