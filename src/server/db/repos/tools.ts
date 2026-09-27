import { randomUUID } from 'node:crypto';
import { type CreateInput, type Patch, type RepoContext, placeholders } from '../context.ts';
import { transaction } from '../database.ts';
import { Table, type TableSpec, defined } from '../table.ts';

/** An embedded tool (iframe) with its URL saved by Switchboard (gaps #13, #14). */
export interface ToolRecord {
  readonly id: string;
  readonly name: string;
  /** `null` = not configured. */
  readonly url: string | null;
  readonly description: string | null;
  readonly showInSidebar: boolean;
  /** Sort order. */
  readonly position: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Input of {@link ToolRepository.create}. */
export type ToolCreate = CreateInput<ToolRecord, 'name', 'createdAt' | 'updatedAt'>;

/** Input of {@link ToolRepository.update}. */
export type ToolPatch = Patch<ToolRecord, 'id' | 'createdAt' | 'updatedAt'>;

/** One tool for {@link ToolRepository.replaceAll}. */
export type ToolInput = ToolCreate & { readonly id: string };

const SPEC: TableSpec<ToolRecord> = {
  table: 'tools',
  key: 'id',
  fields: {
    id: ['id', 'text'],
    name: ['name', 'text'],
    url: ['url', 'text'],
    description: ['description', 'text'],
    showInSidebar: ['show_in_sidebar', 'bool'],
    position: ['position', 'int'],
    createdAt: ['created_at', 'text'],
    updatedAt: ['updated_at', 'text'],
  },
};

/** Embedded tools. */
export class ToolRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<ToolRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
  }

  async create(input: ToolCreate): Promise<ToolRecord> {
    const ts = this.#ctx.now();
    return this.#table.insert({ ...defined(input), id: input.id ?? randomUUID(), createdAt: ts, updatedAt: ts });
  }

  async get(id: string): Promise<ToolRecord | null> {
    return this.#table.get(id);
  }

  /** Tools in display order. */
  async list(): Promise<ToolRecord[]> {
    return this.#table.select('', [], 'position, created_at, rowid');
  }

  async update(id: string, patch: ToolPatch): Promise<ToolRecord | null> {
    return this.#table.update(id, { ...patch, updatedAt: this.#ctx.now() });
  }

  async delete(id: string): Promise<boolean> {
    return this.#table.delete(id);
  }

  /**
   * Replaces the whole list in one transaction (`PUT /api/tools`): tools not in
   * `tools` are deleted, the others inserted or updated, `position` = list index.
   */
  async replaceAll(tools: readonly ToolInput[]): Promise<ToolRecord[]> {
    return transaction(this.#ctx.db, () => {
      const ts = this.#ctx.now();
      const ids = tools.map((tool) => tool.id);
      if (ids.length === 0) {
        this.#table.statement('DELETE FROM tools').run();
      } else {
        this.#table.statement(`DELETE FROM tools WHERE id NOT IN (${placeholders(ids.length)})`).run(...ids);
      }
      tools.forEach((tool, position) => {
        const values = { ...defined(tool), position };
        if (!this.#table.update(tool.id, { ...values, updatedAt: ts })) {
          this.#table.insert({ ...values, createdAt: ts, updatedAt: ts });
        }
      });
      return this.#table.select('', [], 'position, created_at, rowid');
    });
  }
}
