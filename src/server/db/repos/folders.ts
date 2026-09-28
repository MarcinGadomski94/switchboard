import { randomUUID } from 'node:crypto';
import type { FolderKind } from '../../../core/model.ts';
import type { CreateInput, Patch, RepoContext } from '../context.ts';
import { transaction } from '../database.ts';
import { Table, type TableSpec, defined } from '../table.ts';

/** A saved folder (D14): a workspace or a git repo sessions can start in. */
export interface FolderRecord {
  readonly id: string;
  /** Absolute path as the developer gave it (`~` expanded). */
  readonly path: string;
  /** The folder resolved on disk (realpath): unique, the folder's identity. */
  readonly canonicalPath: string;
  /** What the folder was when it was added (`docs/folders.md` → *Kinds*). */
  readonly kind: FolderKind;
  /** The folder a session, a scan or a schedule uses when none is named. At most one. */
  readonly isDefault: boolean;
  readonly addedAt: string;
  /** When a session last started in it; `null` before the first. */
  readonly lastUsedAt: string | null;
}

/** Input of {@link FolderRepository.create}; `id` defaults to a random UUID, `isDefault` to `false`. */
export type FolderCreate = CreateInput<FolderRecord, 'path' | 'canonicalPath' | 'kind', 'addedAt'>;

/** Input of {@link FolderRepository.update}. */
export type FolderPatch = Patch<FolderRecord, 'id' | 'addedAt' | 'isDefault'>;

const SPEC: TableSpec<FolderRecord> = {
  table: 'folders',
  key: 'id',
  fields: {
    id: ['id', 'text'],
    path: ['path', 'text'],
    canonicalPath: ['canonical_path', 'text'],
    kind: ['kind', 'text'],
    isDefault: ['is_default', 'bool'],
    addedAt: ['added_at', 'text'],
    lastUsedAt: ['last_used_at', 'text'],
  },
};

/**
 * The display order of the saved list (D14: "the default preselected, then most
 * recently used"): the default first, then by last use (newest first, never-used
 * last), then in the order they were added.
 */
const LIST_ORDER = 'is_default DESC, last_used_at IS NULL, last_used_at DESC, added_at, rowid';

/**
 * Saved folders (D14). Keeps the "at most one default" rule (a partial unique
 * index): {@link setDefault} moves the mark in one transaction. Deleting a folder
 * leaves the sessions and schedules that used it with a `null` folder id (their
 * `root` stays).
 */
export class FolderRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<FolderRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
  }

  /** Stores a new folder. The canonical path must be unique; `isDefault: true` fails while another folder is the default (use {@link setDefault}). */
  async create(input: FolderCreate): Promise<FolderRecord> {
    return this.#table.insert({ ...defined(input), id: input.id ?? randomUUID(), addedAt: this.#ctx.now() });
  }

  async get(id: string): Promise<FolderRecord | null> {
    return this.#table.get(id);
  }

  /** The folder with this canonical path, or `null`. */
  async getByCanonicalPath(canonicalPath: string): Promise<FolderRecord | null> {
    return this.#table.first('canonical_path = ?', [canonicalPath]);
  }

  /** The default folder, or `null` (no folder saved). */
  async getDefault(): Promise<FolderRecord | null> {
    return this.#table.first('is_default = 1');
  }

  /** Every saved folder: the default first, then most recently used, then in the order added. */
  async list(): Promise<FolderRecord[]> {
    return this.#table.select('', [], LIST_ORDER);
  }

  /** Updates the given fields; `null` if there is no such folder. The default mark moves only through {@link setDefault}. */
  async update(id: string, patch: FolderPatch): Promise<FolderRecord | null> {
    return this.#table.update(id, patch);
  }

  /** Makes `id` the one default folder (clears the others in the same transaction); `null` if there is no such folder. */
  async setDefault(id: string): Promise<FolderRecord | null> {
    return transaction(this.#ctx.db, () => {
      if (!this.#table.get(id)) return null;
      this.#table.statement('UPDATE folders SET is_default = 0 WHERE is_default = 1 AND id <> ?').run(id);
      return this.#table.update(id, { isDefault: true });
    });
  }

  /** Records that a session started in the folder now. */
  async markUsed(id: string): Promise<FolderRecord | null> {
    return this.#table.update(id, { lastUsedAt: this.#ctx.now() });
  }

  /** Deletes the folder; sessions and schedules that used it keep their `root` and lose the id. `true` if it existed. */
  async delete(id: string): Promise<boolean> {
    return this.#table.delete(id);
  }

  /**
   * Links the sessions that have no saved folder but ran in this one (their
   * `root` is the folder's canonical path, or the path as given) to it, e.g. after
   * the folder was removed and added again. Returns how many were linked.
   */
  async linkSessions(folder: Pick<FolderRecord, 'id' | 'path' | 'canonicalPath'>): Promise<number> {
    const result = this.#table
      .statement('UPDATE sessions SET folder_id = ? WHERE folder_id IS NULL AND root IS NOT NULL AND root IN (?, ?)')
      .run(folder.id, folder.canonicalPath, folder.path);
    return Number(result.changes);
  }

  /** Names of the schedules whose runs start in this folder (they block its removal, `docs/folders.md`). */
  async scheduleNames(id: string): Promise<string[]> {
    return this.#table
      .statement('SELECT name FROM schedules WHERE folder_id = ? ORDER BY name')
      .all(id)
      .map((row) => String(row['name']));
  }
}
