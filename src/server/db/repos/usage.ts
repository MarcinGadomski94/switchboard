import type { UsageSource } from '../../../core/model.ts';
import type { CreateInput, RepoContext } from '../context.ts';
import { Table, type TableSpec, defined } from '../table.ts';

/**
 * One Max usage reading (ARCHITECTURE → *Usage meter*). Percentages are 0–100:
 * `get_usage` reports 0–100, `rate_limit_event` 0–1 (the caller converts).
 * A missing window is `null` ("unknown"), never invented.
 */
export interface UsageReadingRecord {
  readonly id: number;
  readonly receivedAt: string;
  readonly source: UsageSource;
  readonly sessionId: string | null;
  readonly fiveHourPct: number | null;
  readonly fiveHourResetsAt: string | null;
  readonly sevenDayPct: number | null;
  readonly sevenDayResetsAt: string | null;
  /** The reading verbatim. */
  readonly raw: unknown;
}

/** Input of {@link UsageRepository.add}; `receivedAt` defaults to now. */
export type UsageReadingCreate = CreateInput<UsageReadingRecord, 'source', 'id'>;

const SPEC: TableSpec<UsageReadingRecord> = {
  table: 'usage_readings',
  key: 'id',
  fields: {
    id: ['id', 'int'],
    receivedAt: ['received_at', 'text'],
    source: ['source', 'text'],
    sessionId: ['session_id', 'text'],
    fiveHourPct: ['five_hour_pct', 'real'],
    fiveHourResetsAt: ['five_hour_resets_at', 'text'],
    sevenDayPct: ['seven_day_pct', 'real'],
    sevenDayResetsAt: ['seven_day_resets_at', 'text'],
    raw: ['raw', 'json'],
  },
};

/** Usage readings. */
export class UsageRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<UsageReadingRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
  }

  async add(input: UsageReadingCreate): Promise<UsageReadingRecord> {
    return this.#table.insert({ ...defined(input), receivedAt: input.receivedAt ?? this.#ctx.now() });
  }

  /** The newest reading (D17: of that `source` when given), or `null`. */
  async latest(source?: UsageSource): Promise<UsageReadingRecord | null> {
    return source === undefined
      ? this.#table.first('', [], 'received_at DESC, id DESC')
      : this.#table.first('source = ?', [source], 'received_at DESC, id DESC');
  }

  /** Readings received after `sinceTs` (all when omitted), oldest first. */
  async list(sinceTs?: string): Promise<UsageReadingRecord[]> {
    return sinceTs === undefined
      ? this.#table.select('', [], 'received_at, id')
      : this.#table.select('received_at > ?', [sinceTs], 'received_at, id');
  }

  /** Deletes readings received before `beforeTs`; returns how many. */
  async prune(beforeTs: string): Promise<number> {
    const result = this.#table.statement('DELETE FROM usage_readings WHERE received_at < ?').run(beforeTs);
    return Number(result.changes);
  }
}
