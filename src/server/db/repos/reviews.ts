import { randomBytes } from 'node:crypto';
import type { ReviewOutcome, ReviewState } from '../../../core/reviews.ts';
import type { RepoContext } from '../context.ts';
import { transaction } from '../database.ts';
import { Table, type TableSpec } from '../table.ts';

/** D79: a stored review card (`session_reviews`, migration 0033). */
export interface ReviewRecord {
  readonly id: string;
  readonly sessionId: string;
  /** The change set's fingerprint when raised or last read. */
  readonly fingerprint: string;
  readonly state: ReviewState;
  readonly outcome: ReviewOutcome | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt: string | null;
  /** The card's data as last read (the service owns its shape). */
  readonly data: unknown;
}

const SPEC: TableSpec<ReviewRecord> = {
  table: 'session_reviews',
  key: 'id',
  fields: {
    id: ['id', 'text'],
    sessionId: ['session_id', 'text'],
    fingerprint: ['fingerprint', 'text'],
    state: ['state', 'text'],
    outcome: ['outcome', 'text'],
    createdAt: ['created_at', 'text'],
    updatedAt: ['updated_at', 'text'],
    resolvedAt: ['resolved_at', 'text'],
    data: ['data', 'json'],
  },
};

/** What {@link ReviewRepository.raise} did. */
export type RaiseResult =
  | { readonly kind: 'raised'; readonly record: ReviewRecord }
  | { readonly kind: 'refreshed'; readonly record: ReviewRecord }
  | { readonly kind: 'unchanged'; readonly record: ReviewRecord };

/**
 * D79: the review cards. Each method runs to completion without yielding (node:sqlite
 * is synchronous); {@link raise} runs in one transaction.
 */
export class ReviewRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<ReviewRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
  }

  async get(id: string): Promise<ReviewRecord | null> {
    return this.#table.get(id);
  }

  /** The session's newest review (any state), or `null`. */
  async latestOf(sessionId: string): Promise<ReviewRecord | null> {
    return this.#table.first('session_id = ?', [sessionId], 'created_at DESC, rowid DESC');
  }

  /** The session's open review (`pending` or `cleanup`), newest first, or `null`. */
  async openOf(sessionId: string): Promise<ReviewRecord | null> {
    return this.#table.first("session_id = ? AND state IN ('pending', 'cleanup')", [sessionId], 'created_at DESC, rowid DESC');
  }

  /** Open reviews (`pending` and `cleanup`), oldest first. */
  async listOpen(): Promise<ReviewRecord[]> {
    return this.#table.select("state IN ('pending', 'cleanup')", [], 'created_at, rowid');
  }

  /** The newest resolved reviews, newest first. */
  async listRecent(limit: number): Promise<ReviewRecord[]> {
    return this.#table.select("state = 'resolved'", [], 'resolved_at DESC, rowid DESC', limit);
  }

  /** How many reviews are open (the Inbox count). */
  async countOpen(): Promise<number> {
    const row = this.#table.statement("SELECT COUNT(*) AS n FROM session_reviews WHERE state IN ('pending', 'cleanup')").get();
    return Number(row?.['n'] ?? 0);
  }

  /**
   * A turn of `sessionId` ended with this change set: once per change set (D79).
   * - the newest review has the same fingerprint (open or resolved) → `unchanged`;
   * - an open `pending` review with another fingerprint → its data is refreshed (`refreshed`);
   * - otherwise (none, or the newest is resolved / in clean-up) → a new `pending` review (`raised`).
   *   A review still in `cleanup` is resolved (its clean-up no longer offered) when a new one is raised.
   */
  async raise(sessionId: string, fingerprint: string, data: unknown): Promise<RaiseResult> {
    return transaction(this.#ctx.db, () => {
      const now = this.#ctx.now();
      const latest = this.#table.first('session_id = ?', [sessionId], 'created_at DESC, rowid DESC');
      if (latest && latest.fingerprint === fingerprint) return { kind: 'unchanged', record: latest } as const;
      if (latest && latest.state === 'pending') {
        const record = this.#table.update(latest.id, { fingerprint, data, updatedAt: now }) ?? latest;
        return { kind: 'refreshed', record } as const;
      }
      if (latest && latest.state === 'cleanup') this.#table.update(latest.id, { state: 'resolved', updatedAt: now });
      const record = this.#table.insert({ id: randomBytes(6).toString('hex'), sessionId, fingerprint, state: 'pending', outcome: null, createdAt: now, updatedAt: now, resolvedAt: null, data });
      return { kind: 'raised', record } as const;
    });
  }

  /** Stores freshly read data (and fingerprint) of a review. */
  async refresh(id: string, fingerprint: string, data: unknown): Promise<ReviewRecord | null> {
    return this.#table.update(id, { fingerprint, data, updatedAt: this.#ctx.now() });
  }

  /** Replaces a review's data (a note, a PR link) without touching its fingerprint. */
  async setData(id: string, data: unknown): Promise<ReviewRecord | null> {
    return this.#table.update(id, { data, updatedAt: this.#ctx.now() });
  }

  /**
   * Resolves a pending review with `outcome`; `cleanup: true` leaves it in `cleanup`
   * (Clean up offered). `null` when it is not pending.
   */
  async resolve(id: string, outcome: ReviewOutcome, options: { readonly cleanup?: boolean; readonly data?: unknown; readonly fingerprint?: string } = {}): Promise<ReviewRecord | null> {
    return transaction(this.#ctx.db, () => {
      const current = this.#table.get(id);
      if (!current || current.state !== 'pending') return null;
      const now = this.#ctx.now();
      return this.#table.update(id, {
        state: options.cleanup ? 'cleanup' : 'resolved',
        outcome,
        resolvedAt: now,
        updatedAt: now,
        ...(options.data !== undefined ? { data: options.data } : {}),
        // The change set as it is after the action: the next turn end raises a new card only when it changes again.
        ...(options.fingerprint !== undefined ? { fingerprint: options.fingerprint } : {}),
      });
    });
  }

  /** Ends a review's clean-up offer (cleaned up, or kept). `null` when it is not in `cleanup`. */
  async closeCleanup(id: string, data?: unknown): Promise<ReviewRecord | null> {
    return transaction(this.#ctx.db, () => {
      const current = this.#table.get(id);
      if (!current || current.state !== 'cleanup') return null;
      return this.#table.update(id, { state: 'resolved', updatedAt: this.#ctx.now(), ...(data !== undefined ? { data } : {}) });
    });
  }
}
