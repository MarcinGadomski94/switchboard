import {
  MAIN_TOUR_ID,
  type TourOutcome,
  type TourRecord,
  type TutorialState,
  type WhatsNewFeature,
  WHATS_NEW,
  featuresAfter,
  isTourId,
  tutorialVersion,
} from '../../core/tutorial.ts';
import type { Store } from '../db/store.ts';
import { INSTALL_KEY, LAST_VERSION_KEY, type TourRow } from '../db/repos/tutorial.ts';

/** Options for {@link TutorialService}. */
export interface TutorialServiceOptions {
  readonly store: Store;
  /** This build's version (`package.json`). */
  readonly appVersion: string;
  /** Let the UI open a pending tour by itself (`false` in demo mode and with `SWITCHBOARD_TUTORIAL=off`). Default `true`. */
  readonly autoOpen?: boolean;
  /** The What's-new registry (tests pass their own). */
  readonly registry?: readonly WhatsNewFeature[];
}

/** `SWITCHBOARD_TUTORIAL=off` stops tours from opening by themselves (Settings → Tutorial and ⌘K → Tutorial still replay them). */
export function tutorialAutoOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SWITCHBOARD_TUTORIAL']?.trim().toLowerCase() !== 'off';
}

/** An unknown tour id (`PUT /api/tutorial/tours/{id}` → 404). */
export class UnknownTourError extends Error {
  override name = 'UnknownTourError';
}

/**
 * D85 · the tutorial's state on this machine (`docs/tutorial.md`). One flag
 * per machine (every browser and paired device of this Switchboard shares it).
 *
 * On its first read after a start it catches up: when the tutorial system has
 * never run here (no `tutorial.lastVersion`, which migration 0037 sets only for
 * an install that already had data) it queues the main tour; otherwise it
 * queues the What's-new mini-tours of the features introduced after the last
 * version it ran on. Either way it then stores this build's
 * {@link tutorialVersion} as the last version. A tour already finished or
 * skipped is never queued again.
 */
export class TutorialService {
  readonly #store: Store;
  readonly #version: string;
  readonly #autoOpen: boolean;
  readonly #registry: readonly WhatsNewFeature[];
  #ready: Promise<void> | null = null;

  constructor(options: TutorialServiceOptions) {
    this.#store = options.store;
    this.#registry = options.registry ?? WHATS_NEW;
    this.#version = tutorialVersion(options.appVersion, this.#registry);
    this.#autoOpen = options.autoOpen ?? true;
  }

  async #catchUp(): Promise<void> {
    const [last, install] = await Promise.all([this.#store.settings.get(LAST_VERSION_KEY), this.#store.settings.get(INSTALL_KEY)]);
    if (typeof last !== 'string') {
      // Migration 0037 found no data: a brand-new install gets the main tour (and no What's-new: the tour covers it all).
      await this.#store.tutorial.advance([MAIN_TOUR_ID], this.#version, 'new');
      return;
    }
    // An install that had data before the tutorial (0037 set the version it starts from), or a later start of any install:
    // the mini-tours of what came after the last version the tutorial ran on.
    const fresh = featuresAfter(last, this.#registry).map((feature) => feature.id);
    const kind = install === 'new' || install === 'existing' ? undefined : 'existing';
    if (fresh.length > 0 || last !== this.#version || kind) await this.#store.tutorial.advance(fresh, this.#version, kind);
  }

  #caughtUp(): Promise<void> {
    this.#ready ??= this.#catchUp().catch((error: unknown) => {
      this.#ready = null;
      throw error;
    });
    return this.#ready;
  }

  /** `GET /api/tutorial`. */
  async state(): Promise<TutorialState> {
    await this.#caughtUp();
    const rows = new Map((await this.#store.tutorial.list()).map((row) => [row.tour, row] as const));
    const record = (row: TourRow | undefined): TourRecord => ({ status: row?.status ?? null, updatedAt: row?.updatedAt ?? null });
    const [last, install] = await Promise.all([this.#store.settings.get(LAST_VERSION_KEY), this.#store.settings.get(INSTALL_KEY)]);
    return {
      autoOpen: this.#autoOpen,
      install: install === 'existing' ? 'existing' : 'new',
      lastVersion: typeof last === 'string' ? last : this.#version,
      main: record(rows.get(MAIN_TOUR_ID)),
      whatsNew: this.#registry.map((feature) => ({ id: feature.id, title: feature.title, version: feature.version, ...record(rows.get(feature.id)) })),
    };
  }

  /** `PUT /api/tutorial/tours/{id}`: a tour was finished or skipped (also a replay). */
  async record(tour: string, outcome: TourOutcome): Promise<TutorialState> {
    if (!isTourId(tour, this.#registry)) throw new UnknownTourError(`no tour ${tour}`);
    await this.#caughtUp();
    await this.#store.tutorial.set(tour, outcome.status, this.#version);
    return this.state();
  }
}
