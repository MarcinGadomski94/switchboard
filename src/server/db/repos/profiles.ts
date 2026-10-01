import { randomUUID } from 'node:crypto';
import type { CliProviderId } from '../../../core/cli-providers.ts';
import { type CreateInput, type Patch, type RepoContext } from '../context.ts';
import { Table, type TableSpec, defined } from '../table.ts';

/** D63 (0024): one account profile of a CLI. */
export interface ProfileRecord {
  readonly id: string;
  readonly cli: CliProviderId;
  readonly name: string;
  /** The config / data folder; `null` for the built-in Default. */
  readonly dir: string | null;
  readonly builtin: boolean;
  readonly enabled: boolean;
  readonly position: number;
  readonly shareSettings: boolean;
  readonly exhaustedUntil: string | null;
  readonly exhaustedWindow: string | null;
  readonly exhaustedText: string | null;
  readonly createdAt: string;
}

export type ProfileCreate = CreateInput<ProfileRecord, 'cli' | 'name', 'createdAt' | 'position'>;
export type ProfilePatch = Patch<ProfileRecord, 'id' | 'cli' | 'createdAt' | 'builtin'>;

const SPEC: TableSpec<ProfileRecord> = {
  table: 'cli_profiles',
  key: 'id',
  fields: {
    id: ['id', 'text'],
    cli: ['cli', 'text'],
    name: ['name', 'text'],
    dir: ['dir', 'text'],
    builtin: ['builtin', 'bool'],
    enabled: ['enabled', 'bool'],
    position: ['position', 'int'],
    shareSettings: ['share_settings', 'bool'],
    exhaustedUntil: ['exhausted_until', 'text'],
    exhaustedWindow: ['exhausted_window', 'text'],
    exhaustedText: ['exhausted_text', 'text'],
    createdAt: ['created_at', 'text'],
  },
};

/** Account profiles (`cli_profiles`, `docs/accounts.md`). */
export class ProfileRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<ProfileRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
  }

  async get(id: string): Promise<ProfileRecord | null> {
    return this.#table.get(id);
  }

  /** Profiles in priority order (every CLI, or one). */
  async list(cli?: CliProviderId): Promise<ProfileRecord[]> {
    return cli === undefined ? this.#table.select('', [], 'cli, position, created_at') : this.#table.select('cli = ?', [cli], 'position, created_at');
  }

  /** Adds a profile last in its CLI's order. */
  async create(input: ProfileCreate): Promise<ProfileRecord> {
    const last = this.#ctx.db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM cli_profiles WHERE cli = ?').get(input.cli);
    const position = Number(last?.['p'] ?? -1) + 1;
    return this.#table.insert({ ...defined(input), id: input.id ?? randomUUID(), position, createdAt: this.#ctx.now() });
  }

  async update(id: string, patch: ProfilePatch): Promise<ProfileRecord | null> {
    return this.#table.update(id, patch);
  }

  /** Stores the new order of a CLI's profiles (`ids` first, anything left out after them). */
  async reorder(cli: CliProviderId, ids: readonly string[]): Promise<void> {
    const all = await this.list(cli);
    const order = [...ids.filter((id) => all.some((p) => p.id === id)), ...all.map((p) => p.id).filter((id) => !ids.includes(id))];
    const set = this.#ctx.db.prepare('UPDATE cli_profiles SET position = ? WHERE id = ?');
    order.forEach((id, index) => set.run(index, id));
  }

  async delete(id: string): Promise<boolean> {
    return this.#table.delete(id);
  }
}
