import { randomUUID } from 'node:crypto';
import type { CreateInput, Patch, RepoContext } from '../context.ts';
import { Table, type TableSpec, defined } from '../table.ts';

/** A loop observed in a session (D9): values are never invented, unknown ones stay `null`. */
export interface LoopRecord {
  readonly id: string;
  readonly sessionId: string;
  /** Observed source: `/loop`, `ScheduleWakeup`, `CronCreate`, `Workflow`, … */
  readonly kind: string;
  /** Card subtitle, e.g. `/loop 1h · Plan-Act-Verify`. */
  readonly label: string | null;
  readonly iteration: number | null;
  /** From a `.loop/progress.md` only (D9). */
  readonly cap: number | null;
  /** From a `.loop/progress.md` only (D9). */
  readonly breakerCount: number | null;
  readonly breakerState: string | null;
  readonly nextFireAt: string | null;
  readonly expiresAt: string | null;
  /** Per-iteration results for the strip. */
  readonly iterations: unknown[];
  /** The `.loop/progress.md` it was read from. */
  readonly progressPath: string | null;
  readonly note: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Input of {@link LoopRepository.create}. */
export type LoopCreate = CreateInput<LoopRecord, 'sessionId' | 'kind', 'createdAt' | 'updatedAt'>;

/** Input of {@link LoopRepository.update}. */
export type LoopPatch = Patch<LoopRecord, 'id' | 'sessionId' | 'createdAt' | 'updatedAt'>;

const SPEC: TableSpec<LoopRecord> = {
  table: 'loops',
  key: 'id',
  fields: {
    id: ['id', 'text'],
    sessionId: ['session_id', 'text'],
    kind: ['kind', 'text'],
    label: ['label', 'text'],
    iteration: ['iteration', 'int'],
    cap: ['cap', 'int'],
    breakerCount: ['breaker_count', 'int'],
    breakerState: ['breaker_state', 'text'],
    nextFireAt: ['next_fire_at', 'text'],
    expiresAt: ['expires_at', 'text'],
    iterations: ['iterations', 'json'],
    progressPath: ['progress_path', 'text'],
    note: ['note', 'text'],
    createdAt: ['created_at', 'text'],
    updatedAt: ['updated_at', 'text'],
  },
};

/** Loops of sessions. */
export class LoopRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<LoopRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
  }

  async create(input: LoopCreate): Promise<LoopRecord> {
    const ts = this.#ctx.now();
    return this.#table.insert({ ...defined(input), id: input.id ?? randomUUID(), createdAt: ts, updatedAt: ts });
  }

  async get(id: string): Promise<LoopRecord | null> {
    return this.#table.get(id);
  }

  /** Loops (of one session when `sessionId` is given), oldest first. */
  async list(sessionId?: string): Promise<LoopRecord[]> {
    return sessionId === undefined
      ? this.#table.select('', [], 'created_at, rowid')
      : this.#table.select('session_id = ?', [sessionId], 'created_at, rowid');
  }

  async update(id: string, patch: LoopPatch): Promise<LoopRecord | null> {
    return this.#table.update(id, { ...patch, updatedAt: this.#ctx.now() });
  }

  async delete(id: string): Promise<boolean> {
    return this.#table.delete(id);
  }
}
