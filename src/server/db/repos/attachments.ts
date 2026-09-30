import type { SQLInputValue } from 'node:sqlite';
import type { AttachmentKind } from '../../../core/attachments.ts';
import type { RepoContext } from '../context.ts';
import { Table, type TableSpec } from '../table.ts';

/** D57: a stored attachment (`attachments`, migration 0020); the bytes are a file in the data folder. */
export interface AttachmentRecord {
  readonly id: string;
  /** The session it belongs to; `null` = staged by the New-session form (bound when its session starts). */
  readonly sessionId: string | null;
  readonly name: string;
  readonly mediaType: string;
  readonly kind: AttachmentKind;
  readonly size: number;
  /** The stored file's name inside its folder. */
  readonly file: string;
  /** A PDF's page count as read from its bytes; `null` otherwise. */
  readonly pages: number | null;
  readonly createdAt: string;
}

const SPEC: TableSpec<AttachmentRecord> = {
  table: 'attachments',
  key: 'id',
  fields: {
    id: ['id', 'text'],
    sessionId: ['session_id', 'text'],
    name: ['name', 'text'],
    mediaType: ['media_type', 'text'],
    kind: ['kind', 'text'],
    size: ['size', 'int'],
    file: ['file', 'text'],
    pages: ['pages', 'int'],
    createdAt: ['created_at', 'text'],
  },
};

/** The attachments' rows (D57). */
export class AttachmentRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<AttachmentRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
  }

  async create(input: Omit<AttachmentRecord, 'createdAt'> & { readonly createdAt?: string }): Promise<AttachmentRecord> {
    return this.#table.insert({ ...input, createdAt: input.createdAt ?? this.#ctx.now() });
  }

  async get(id: string): Promise<AttachmentRecord | null> {
    return this.#table.get(id);
  }

  /** The rows of these ids that belong to `sessionId` (`null` = staged), in the order of `ids`; unknown ids are left out. */
  async listIn(sessionId: string | null, ids: readonly string[]): Promise<AttachmentRecord[]> {
    const out: AttachmentRecord[] = [];
    for (const id of ids) {
      const row = this.#table.get(id);
      if (row && row.sessionId === sessionId) out.push(row);
    }
    return out;
  }

  /** Every row, oldest first (the start's cleanup). */
  async list(): Promise<AttachmentRecord[]> {
    return this.#table.select('1 = 1', [], 'created_at');
  }

  /** Rows created before `iso`, oldest first. */
  async olderThan(iso: string): Promise<AttachmentRecord[]> {
    return this.#table.select('created_at < ?', [iso], 'created_at');
  }

  /** Binds a staged row to its session (its file moves into the session's folder under the same name). */
  async bind(id: string, sessionId: string): Promise<AttachmentRecord | null> {
    return this.#table.update(id, { sessionId });
  }

  /** Makes a row staged again (a move into its session's folder failed). */
  async unbind(id: string): Promise<AttachmentRecord | null> {
    return this.#table.update(id, { sessionId: null });
  }

  async delete(id: string): Promise<boolean> {
    return this.#table.delete(id as SQLInputValue);
  }
}
