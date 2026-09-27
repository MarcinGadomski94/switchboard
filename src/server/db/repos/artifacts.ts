import { randomUUID } from 'node:crypto';
import type { ArtifactType } from '../../../core/model.ts';
import { type CreateInput, type Patch, type RepoContext, placeholders } from '../context.ts';
import { transaction } from '../database.ts';
import { Table, type TableSpec, defined } from '../table.ts';

/** An artifact a session produced (gap #9). */
export interface ArtifactRecord {
  readonly id: string;
  readonly type: ArtifactType;
  readonly name: string;
  /** Solution name, or `null` for the workspace root. */
  readonly solution: string | null;
  readonly branch: string | null;
  readonly sessionId: string | null;
  /** Short meta copy (e.g. `locked`, `+284 −12`, `open`). */
  readonly meta: string | null;
  /** File path for file artifacts. */
  readonly path: string | null;
  /** URL for PR artifacts. */
  readonly url: string | null;
  readonly data: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Input of {@link ArtifactRepository.create} / {@link ArtifactRepository.upsert}. */
export type ArtifactCreate = CreateInput<ArtifactRecord, 'type' | 'name', 'createdAt' | 'updatedAt'>;

/** Input of {@link ArtifactRepository.update}. */
export type ArtifactPatch = Patch<ArtifactRecord, 'id' | 'createdAt' | 'updatedAt'>;

/** Query of {@link ArtifactRepository.list}. */
export interface ArtifactQuery {
  readonly types?: readonly ArtifactType[];
  readonly sessionId?: string;
  /** Case-insensitive substring over name, meta, solution and branch. */
  readonly q?: string;
}

const SPEC: TableSpec<ArtifactRecord> = {
  table: 'artifacts',
  key: 'id',
  fields: {
    id: ['id', 'text'],
    type: ['type', 'text'],
    name: ['name', 'text'],
    solution: ['solution', 'text'],
    branch: ['branch', 'text'],
    sessionId: ['session_id', 'text'],
    meta: ['meta', 'text'],
    path: ['path', 'text'],
    url: ['url', 'text'],
    data: ['data', 'json'],
    createdAt: ['created_at', 'text'],
    updatedAt: ['updated_at', 'text'],
  },
};

/** `%`, `_` and `\` escaped for `LIKE … ESCAPE '\'`. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Artifacts. */
export class ArtifactRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<ArtifactRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
  }

  async create(input: ArtifactCreate): Promise<ArtifactRecord> {
    const ts = this.#ctx.now();
    return this.#table.insert({ ...defined(input), id: input.id ?? randomUUID(), createdAt: ts, updatedAt: ts });
  }

  /** Inserts, or updates the artifact with the same `id` (keeping its `createdAt`). */
  async upsert(input: ArtifactCreate & { readonly id: string }): Promise<ArtifactRecord> {
    return transaction(this.#ctx.db, () => {
      const ts = this.#ctx.now();
      if (this.#table.get(input.id)) {
        const updated = this.#table.update(input.id, { ...defined(input), updatedAt: ts });
        if (updated) return updated;
      }
      return this.#table.insert({ ...defined(input), createdAt: ts, updatedAt: ts });
    });
  }

  async get(id: string): Promise<ArtifactRecord | null> {
    return this.#table.get(id);
  }

  /** Artifacts, most recently updated first. */
  async list(query: ArtifactQuery = {}): Promise<ArtifactRecord[]> {
    const where: string[] = [];
    const params: string[] = [];
    if (query.types) {
      if (query.types.length === 0) return [];
      where.push(`type IN (${placeholders(query.types.length)})`);
      params.push(...query.types);
    }
    if (query.sessionId !== undefined) {
      where.push('session_id = ?');
      params.push(query.sessionId);
    }
    const q = query.q?.trim();
    if (q) {
      const pattern = likePattern(q);
      where.push(
        `(name LIKE ? ESCAPE '\\' OR meta LIKE ? ESCAPE '\\' OR solution LIKE ? ESCAPE '\\' OR branch LIKE ? ESCAPE '\\')`,
      );
      params.push(pattern, pattern, pattern, pattern);
    }
    return this.#table.select(where.join(' AND '), params, 'updated_at DESC, rowid DESC');
  }

  async update(id: string, patch: ArtifactPatch): Promise<ArtifactRecord | null> {
    return this.#table.update(id, { ...patch, updatedAt: this.#ctx.now() });
  }

  async delete(id: string): Promise<boolean> {
    return this.#table.delete(id);
  }
}
