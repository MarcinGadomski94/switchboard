import type { RepoContext } from '../context.ts';
import { Table, type TableSpec } from '../table.ts';

/** A parsed transcript file for History, valid while its `(size, mtimeMs)` match (M7.4). */
export interface HistoryCacheEntry {
  /** Absolute path of the `<sessionId>.jsonl` transcript. */
  readonly transcriptPath: string;
  readonly claudeSessionId: string;
  readonly size: number;
  readonly mtimeMs: number;
  /** The parsed History row; `null` when the file yields no row (stub, other root, …). */
  readonly item: unknown;
  readonly parsedAt: string;
}

/** Input of {@link HistoryCacheRepository.upsert}; `parsedAt` defaults to now. */
export type HistoryCacheInput = Omit<HistoryCacheEntry, 'parsedAt'> & { readonly parsedAt?: string };

const SPEC: TableSpec<HistoryCacheEntry> = {
  table: 'history_cache',
  key: 'transcriptPath',
  fields: {
    transcriptPath: ['transcript_path', 'text'],
    claudeSessionId: ['claude_session_id', 'text'],
    size: ['size', 'int'],
    mtimeMs: ['mtime_ms', 'real'],
    item: ['item', 'json'],
    parsedAt: ['parsed_at', 'text'],
  },
};

/** The History parse cache. */
export class HistoryCacheRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<HistoryCacheEntry>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
  }

  async get(transcriptPath: string): Promise<HistoryCacheEntry | null> {
    return this.#table.get(transcriptPath);
  }

  /** The cached entry if it still matches `size` and `mtimeMs`, else `null`. */
  async getFresh(transcriptPath: string, size: number, mtimeMs: number): Promise<HistoryCacheEntry | null> {
    const entry = this.#table.get(transcriptPath);
    return entry && entry.size === size && entry.mtimeMs === mtimeMs ? entry : null;
  }

  /** Inserts or replaces the entry for its path. */
  async upsert(input: HistoryCacheInput): Promise<HistoryCacheEntry> {
    const entry: HistoryCacheEntry = { ...input, parsedAt: input.parsedAt ?? this.#ctx.now() };
    const row = this.#table
      .statement(
        `INSERT INTO history_cache (transcript_path, claude_session_id, size, mtime_ms, item, parsed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (transcript_path) DO UPDATE SET claude_session_id = excluded.claude_session_id,
           size = excluded.size, mtime_ms = excluded.mtime_ms, item = excluded.item, parsed_at = excluded.parsed_at
         RETURNING *`,
      )
      .get(
        entry.transcriptPath,
        entry.claudeSessionId,
        entry.size,
        entry.mtimeMs,
        entry.item === null || entry.item === undefined ? null : JSON.stringify(entry.item),
        entry.parsedAt,
      );
    return row ? this.#table.fromRow(row) : entry;
  }

  /** Every entry, by path. */
  async list(): Promise<HistoryCacheEntry[]> {
    return this.#table.select('', [], 'transcript_path');
  }

  async delete(transcriptPath: string): Promise<boolean> {
    return this.#table.delete(transcriptPath);
  }
}
