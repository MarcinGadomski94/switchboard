import { randomUUID } from 'node:crypto';
import type { ScheduleRunResult, ScheduleRunTrigger } from '../../../core/model.ts';
import type { CreateInput, Patch, RepoContext } from '../context.ts';
import { Table, type TableSpec, defined } from '../table.ts';

/** A schedule: a session template run on a cron expression (D8; no defaults, gap #6). */
export interface ScheduleRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly cron: string;
  /** Session config (NewSession shape) + prompt, as saved by the New-session modal. */
  readonly template: unknown;
  readonly paused: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One run of a schedule. */
export interface ScheduleRunRecord {
  readonly id: string;
  readonly scheduleId: string;
  /** When it started. */
  readonly ts: string;
  readonly finishedAt: string | null;
  readonly result: ScheduleRunResult;
  /** Short result copy (e.g. `OK · 5 projects reindexed`). */
  readonly summary: string | null;
  /** The session it started, if any. */
  readonly sessionId: string | null;
  readonly triggeredBy: ScheduleRunTrigger;
}

/** Input of {@link ScheduleRepository.create}. */
export type ScheduleCreate = CreateInput<ScheduleRecord, 'name' | 'cron' | 'template', 'createdAt' | 'updatedAt'>;

/** Input of {@link ScheduleRepository.update}. */
export type SchedulePatch = Patch<ScheduleRecord, 'id' | 'createdAt' | 'updatedAt'>;

/** Input of {@link ScheduleRepository.addRun}; `ts` defaults to now, `result` to `running`. */
export type ScheduleRunCreate = CreateInput<ScheduleRunRecord, 'scheduleId'>;

/** Input of {@link ScheduleRepository.updateRun}. */
export type ScheduleRunPatch = Patch<ScheduleRunRecord, 'id' | 'scheduleId'>;

const SPEC: TableSpec<ScheduleRecord> = {
  table: 'schedules',
  key: 'id',
  fields: {
    id: ['id', 'text'],
    name: ['name', 'text'],
    description: ['description', 'text'],
    cron: ['cron', 'text'],
    template: ['template', 'json'],
    paused: ['paused', 'bool'],
    createdAt: ['created_at', 'text'],
    updatedAt: ['updated_at', 'text'],
  },
};

const RUN_SPEC: TableSpec<ScheduleRunRecord> = {
  table: 'schedule_runs',
  key: 'id',
  fields: {
    id: ['id', 'text'],
    scheduleId: ['schedule_id', 'text'],
    ts: ['ts', 'text'],
    finishedAt: ['finished_at', 'text'],
    result: ['result', 'text'],
    summary: ['summary', 'text'],
    sessionId: ['session_id', 'text'],
    triggeredBy: ['triggered_by', 'text'],
  },
};

/** Schedules and their runs. */
export class ScheduleRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<ScheduleRecord>;
  readonly #runs: Table<ScheduleRunRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
    this.#runs = new Table(ctx.db, RUN_SPEC);
  }

  /** Stores a new schedule; the name must be unique. */
  async create(input: ScheduleCreate): Promise<ScheduleRecord> {
    const ts = this.#ctx.now();
    return this.#table.insert({ ...defined(input), id: input.id ?? randomUUID(), createdAt: ts, updatedAt: ts });
  }

  async get(id: string): Promise<ScheduleRecord | null> {
    return this.#table.get(id);
  }

  async getByName(name: string): Promise<ScheduleRecord | null> {
    return this.#table.first('name = ?', [name]);
  }

  /** Schedules in creation order. */
  async list(): Promise<ScheduleRecord[]> {
    return this.#table.select('', [], 'created_at, rowid');
  }

  async update(id: string, patch: SchedulePatch): Promise<ScheduleRecord | null> {
    return this.#table.update(id, { ...patch, updatedAt: this.#ctx.now() });
  }

  /** Deletes a schedule and its runs. */
  async delete(id: string): Promise<boolean> {
    return this.#table.delete(id);
  }

  async addRun(input: ScheduleRunCreate): Promise<ScheduleRunRecord> {
    return this.#runs.insert({ ...defined(input), id: input.id ?? randomUUID(), ts: input.ts ?? this.#ctx.now() });
  }

  async getRun(id: string): Promise<ScheduleRunRecord | null> {
    return this.#runs.get(id);
  }

  async updateRun(id: string, patch: ScheduleRunPatch): Promise<ScheduleRunRecord | null> {
    return this.#runs.update(id, patch);
  }

  /** The newest `limit` runs (the history strip shows 14), oldest first. */
  async recentRuns(scheduleId: string, limit = 14): Promise<ScheduleRunRecord[]> {
    return this.#runs.select('schedule_id = ?', [scheduleId], 'ts DESC, rowid DESC', limit).reverse();
  }
}
