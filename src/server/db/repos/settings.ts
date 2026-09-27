import type { RepoContext } from '../context.ts';
import { transaction } from '../database.ts';
import { Table, type TableSpec } from '../table.ts';

/** One setting: a key and a JSON value. */
export interface SettingRecord {
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt: string;
}

const SPEC: TableSpec<SettingRecord> = {
  table: 'settings',
  key: 'key',
  fields: {
    key: ['key', 'text'],
    value: ['value', 'json'],
    updatedAt: ['updated_at', 'text'],
  },
};

/** Key/value settings (JSON values). Nothing is stored until something is set. */
export class SettingRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<SettingRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
  }

  /** The value, or `undefined` when the key is not set. */
  async get(key: string): Promise<unknown> {
    const record = this.#table.get(key);
    return record ? record.value : undefined;
  }

  /** Every setting as an object. */
  async getAll(): Promise<Record<string, unknown>> {
    return Object.fromEntries(this.#table.select('', [], 'key').map((record) => [record.key, record.value]));
  }

  /** Sets one value (`null` is stored as JSON null; use {@link delete} to unset). */
  async set(key: string, value: unknown): Promise<void> {
    this.#set(key, value, this.#ctx.now());
  }

  /** Sets several values in one transaction. */
  async setMany(values: Readonly<Record<string, unknown>>): Promise<void> {
    transaction(this.#ctx.db, () => {
      const ts = this.#ctx.now();
      for (const [key, value] of Object.entries(values)) this.#set(key, value, ts);
    });
  }

  #set(key: string, value: unknown, ts: string): void {
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError(`setting ${key}: value is not JSON-serializable`);
    this.#table
      .statement(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(key, text, ts);
  }

  async delete(key: string): Promise<boolean> {
    return this.#table.delete(key);
  }
}
