import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FolderKind } from '../../../core/model.ts';
import { type ProfileScope, scopeSees } from '../../../core/user-profiles.ts';
import { currentProfileScope } from '../../user-profiles/context.ts';
import type { CreateInput, Patch, RepoContext } from '../context.ts';
import { transaction } from '../database.ts';
import { Table, type TableSpec, defined } from '../table.ts';

/** A saved folder (D14): a workspace or a git repo sessions can start in; D59: or a plain folder (Simple sessions only). */
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
  /**
   * D18: the folder's custom name (trimmed, at most 40 characters, unique among
   * saved folders ignoring case: `FolderService` keeps these rules); `null` = none,
   * the folder shows its own name (its last path segment).
   */
  readonly label: string | null;
  /**
   * D169 (0057): the profile the folder is bound to (D165); `null` = shared by every profile.
   * A bound folder is invisible to the other profiles ({@link folderVisible}).
   */
  readonly userProfileId: string | null;
}

/** Input of {@link FolderRepository.create}; `id` defaults to a random UUID, `isDefault` to `false`. */
export type FolderCreate = CreateInput<FolderRecord, 'path' | 'canonicalPath' | 'kind', 'addedAt' | 'userProfileId'> & { readonly userProfileId?: string | null };

/** Input of {@link FolderRepository.update}. */
export type FolderPatch = Patch<FolderRecord, 'id' | 'addedAt' | 'isDefault'>;

/**
 * D169: whether the current request may see folder `record`: a shared folder always; a bound one
 * only in its own profile's scope. Outside any request (Switchboard's own work: startup, schedulers)
 * and for the internal scope `'*'` every folder is visible.
 */
export function folderVisible(record: Pick<FolderRecord, 'userProfileId'>, scope: ProfileScope | undefined = currentProfileScope()): boolean {
  if (!record.userProfileId || scope === undefined) return true;
  return scopeSees(scope, record.userProfileId);
}

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
    label: ['label', 'text'],
    userProfileId: ['user_profile_id', 'text'],
  },
};

/** D169: whether `dir` (an absolute path) is folder `record` or inside it (its canonical path or the path as given). */
export function folderContains(record: Pick<FolderRecord, 'path' | 'canonicalPath'>, dir: string): boolean {
  const resolved = path.resolve(dir);
  return [...new Set([record.canonicalPath, record.path])].some((root) => {
    const base = path.resolve(root);
    return resolved === base || resolved.startsWith(base.endsWith(path.sep) ? base : `${base}${path.sep}`);
  });
}

/** D169: the owner of the innermost bound folder that holds `dir`, `null` when none does. */
export function boundOwnerOf(records: readonly FolderRecord[], dir: string): string | null {
  const holding = records.filter((record) => !!record.userProfileId && folderContains(record, dir));
  holding.sort((a, b) => b.canonicalPath.length - a.canonicalPath.length);
  return holding[0]?.userProfileId ?? null;
}

function visibleOrNull(record: FolderRecord | null): FolderRecord | null {
  return record && folderVisible(record) ? record : null;
}

/** How two folder labels are compared (D18: case-insensitive): NFC, lower case. */
export function labelKey(label: string): string {
  return label.normalize('NFC').toLowerCase();
}

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
    // D169: the binding is written only when given (NULL = shared is the column's own default).
    const { userProfileId, ...rest } = input;
    return this.#table.insert({ ...defined(rest), ...(userProfileId ? { userProfileId } : {}), id: input.id ?? randomUUID(), addedAt: this.#ctx.now() } as FolderRecord);
  }

  /** D169: the folder, `null` when there is none or the current request may not see it ({@link folderVisible}). */
  async get(id: string): Promise<FolderRecord | null> {
    return visibleOrNull(this.#table.get(id));
  }

  /** D169: the folder whatever its binding (internal work; never answer a request with it unchecked). */
  async getAny(id: string): Promise<FolderRecord | null> {
    return this.#table.get(id);
  }

  /** The folder with this canonical path, or `null` (D169: also when the current request may not see it). */
  async getByCanonicalPath(canonicalPath: string): Promise<FolderRecord | null> {
    return visibleOrNull(this.#table.first('canonical_path = ?', [canonicalPath]));
  }

  /** D169: the folder with this canonical path whatever its binding (uniqueness checks, a terminal's adoption). */
  async getByCanonicalPathAny(canonicalPath: string): Promise<FolderRecord | null> {
    return this.#table.first('canonical_path = ?', [canonicalPath]);
  }

  /**
   * The saved folder whose label is `label` ignoring case (D18), or `null`. SQLite's
   * NOCASE folds ASCII only, so the labels are compared here in full Unicode lower case.
   */
  async getByLabel(label: string): Promise<FolderRecord | null> {
    const wanted = labelKey(label);
    return this.#table.select('label IS NOT NULL').find((record) => record.label !== null && labelKey(record.label) === wanted) ?? null;
  }

  /**
   * The default folder, or `null` (no folder saved). D169: in a request that may not see the
   * default, its first visible folder in the list order (the default of that profile's view).
   */
  async getDefault(): Promise<FolderRecord | null> {
    const marked = this.#table.first('is_default = 1');
    if (marked === null || folderVisible(marked)) return marked;
    return (await this.list())[0] ?? null;
  }

  /** D169: the stored default mark whatever its binding (keeping exactly one default). */
  async getDefaultAny(): Promise<FolderRecord | null> {
    return this.#table.first('is_default = 1');
  }

  /** Every saved folder the current request may see (D169): the default first, then most recently used, then in the order added. */
  async list(): Promise<FolderRecord[]> {
    return this.#table.select('', [], LIST_ORDER).filter((record) => folderVisible(record));
  }

  /** D169: every saved folder whatever its binding (startup reconcile, the default mark, internal work). */
  async listAll(): Promise<FolderRecord[]> {
    return this.#table.select('', [], LIST_ORDER);
  }

  /** D169: binds the folder to `userProfileId` (`null` = shared again); `null` when there is no such folder. */
  async setUserProfile(id: string, userProfileId: string | null): Promise<FolderRecord | null> {
    return this.#table.update(id, { userProfileId });
  }

  /** D169: a deleted profile's folders are shared again (answers how many). */
  async unbindProfile(userProfileId: string): Promise<number> {
    return Number(this.#table.statement('UPDATE folders SET user_profile_id = NULL WHERE user_profile_id = ?').run(userProfileId).changes);
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
   * A session that has no kind yet (a terminal session followed from its cwd) takes
   * the folder's (2026-11-05, migration 0054: else a workspace reads as plain, D59).
   */
  async linkSessions(folder: Pick<FolderRecord, 'id' | 'path' | 'canonicalPath' | 'kind'>): Promise<number> {
    const result = this.#table
      .statement('UPDATE sessions SET folder_id = ?, root_kind = COALESCE(root_kind, ?) WHERE folder_id IS NULL AND root IS NOT NULL AND root IN (?, ?)')
      .run(folder.id, folder.kind === 'plain' ? null : folder.kind, folder.canonicalPath, folder.path);
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
