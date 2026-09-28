import { realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Folder, FolderCheck } from '../../core/api.ts';
import type { FolderRecord } from '../db/repos/folders.ts';
import type { Store } from '../db/store.ts';
import { expandHome, inspectFolder } from './inspect.ts';
import { type FolderRef, folderRefOf } from './ref.ts';

/**
 * Why a folder call was refused (`docs/folders.md` → *API*). D18 adds
 * `invalid-label` (a custom name over {@link FOLDER_LABEL_MAX} characters, or not
 * a string) and `label-taken` (another saved folder has that name, ignoring case).
 */
export type FolderErrorCode = 'invalid' | 'not-found' | 'no-folder' | 'folder-in-use' | 'folder-missing' | 'invalid-label' | 'label-taken';

const STATUS: Readonly<Record<FolderErrorCode, number>> = {
  invalid: 422,
  'not-found': 404,
  'no-folder': 409,
  'folder-in-use': 409,
  'folder-missing': 409,
  'invalid-label': 422,
  'label-taken': 409,
};

/** D18: the longest custom name a saved folder may have, in characters (Unicode code points). */
export const FOLDER_LABEL_MAX = 40;

/**
 * A custom folder name as it is stored (D18): trimmed; empty (or `null` /
 * `undefined`) means none, so the folder shows its own name again.
 * @throws {FolderError} `invalid-label` when it is longer than {@link FOLDER_LABEL_MAX} characters.
 */
export function normalizeFolderLabel(input: string | null | undefined): string | null {
  const label = (input ?? '').trim();
  if (label === '') return null;
  const length = [...label].length;
  if (length > FOLDER_LABEL_MAX) {
    throw new FolderError('invalid-label', `a folder name has at most ${FOLDER_LABEL_MAX} characters; this one has ${length}`);
  }
  return label;
}

/** `true` for the database's refusal of a second folder with the same label (the `folders_label` index, 0005). */
function isLabelConflict(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: (?:folders\.label|index 'folders_label')/.test(error.message);
}

function labelTaken(label: string, other: Pick<FolderRecord, 'path'> | null): FolderError {
  return new FolderError('label-taken', other ? `"${label}" is already the name of another folder (${other.path}); pick another name` : `"${label}" is already the name of another folder; pick another name`);
}

/** A refused folder call, with its HTTP status. */
export class FolderError extends Error {
  override name = 'FolderError';
  readonly code: FolderErrorCode;
  readonly status: number;
  /** The check behind an `invalid` path. */
  readonly check: FolderCheck | null;
  /** The schedules behind `folder-in-use`. */
  readonly schedules: readonly string[];

  constructor(code: FolderErrorCode, message: string, extra: { readonly check?: FolderCheck; readonly schedules?: readonly string[] } = {}) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.check = extra.check ?? null;
    this.schedules = extra.schedules ?? [];
  }
}

/** Options for {@link FolderService}. */
export interface FolderServiceOptions {
  readonly store: Store;
  /** `~` in typed paths (default `os.homedir()`). */
  readonly home?: string;
  /** Called when a background step fails (default: `console.error`). */
  readonly onError?: (error: unknown) => void;
  /**
   * Checks answered without the disk, by path (demo mode: the prototype's
   * `D:\\acme` folder, which is not on this machine, `demoFolderChecks`).
   */
  readonly knownChecks?: ReadonlyMap<string, FolderCheck>;
}

/** Message of `no-folder`. */
export const NO_FOLDER_MESSAGE = 'no folder is saved yet: add a workspace or a git repository (Settings → Folders)';

/**
 * The saved folders (D14, `docs/folders.md`): list (with a live check each), add
 * (a workspace or a git main checkout, else 422), remove, the one default, and
 * which folder a request means. Every session, scan, schedule and Codebase Memory
 * view names its folder through this service; there is no configured root.
 */
export class FolderService {
  readonly #store: Store;
  readonly #home: string;
  readonly #onError: (error: unknown) => void;
  readonly #knownChecks: ReadonlyMap<string, FolderCheck>;

  constructor(options: FolderServiceOptions) {
    this.#store = options.store;
    this.#home = options.home ?? os.homedir();
    this.#onError = options.onError ?? ((error) => console.error('switchboard folders:', error));
    this.#knownChecks = options.knownChecks ?? new Map();
  }

  /** A service whose stored folders were reconciled with the disk ({@link reconcile}). */
  static async open(options: FolderServiceOptions): Promise<FolderService> {
    const service = new FolderService(options);
    await service.reconcile();
    return service;
  }

  /**
   * Startup housekeeping: a stored canonical path that no longer matches the
   * folder on disk is refreshed (the 0003 migration copies the wizard's root
   * as given), a list without a default gets one (the most recently used), and
   * sessions without a saved folder that ran in a saved one are linked to it.
   * Missing folders are left as they are (the list shows the problem).
   */
  async reconcile(): Promise<void> {
    const folders = await this.#store.folders.list();
    for (const folder of folders) {
      try {
        const real = await realpath(folder.path);
        if (real !== folder.canonicalPath && !(await this.#store.folders.getByCanonicalPath(real))) {
          await this.#store.folders.update(folder.id, { canonicalPath: real });
        }
        await this.#store.folders.linkSessions({ ...folder, canonicalPath: real });
      } catch {
        await this.#store.folders.linkSessions(folder);
      }
    }
    await this.#ensureDefault();
  }

  // ── reading ─────────────────────────────────────────────────────────────

  /** `GET /api/folders`: every saved folder with its live check, the default first, then most recently used. */
  async list(): Promise<Folder[]> {
    const records = await this.#store.folders.list();
    return Promise.all(records.map((record) => this.#toFolder(record)));
  }

  /** One saved folder. @throws {FolderError} `not-found`. */
  async get(id: string): Promise<Folder> {
    return this.#toFolder(await this.#record(id));
  }

  /** `GET /api/folders/check?path=`: what `input` is (D14 kinds), without saving anything. */
  check(input: string): Promise<FolderCheck> {
    const known = this.#knownChecks.get(input);
    return known ? Promise.resolve(known) : inspectFolder(input, { home: this.#home });
  }

  /** The default folder's record, or `null` when none is saved. */
  defaultRecord(): Promise<FolderRecord | null> {
    return this.#store.folders.getDefault();
  }

  // ── changes ─────────────────────────────────────────────────────────────

  /**
   * `POST /api/folders`: saves a workspace or a git repo, with an optional custom
   * name (D18, `label`: trimmed, empty = none). A path whose folder is saved
   * already (same canonical path) returns that folder (`created: false`); a
   * non-empty `label` is then given to it by the {@link rename} rules, an empty
   * one leaves its name as it is. The first saved folder becomes the default.
   * Sessions that ran in the folder before (it was removed and is added again)
   * are linked to it. A refused name saves nothing.
   * @throws {FolderError} `invalid` (with the check) for anything but a workspace
   * or a repo; `invalid-label` (over 40 characters); `label-taken` (another saved
   * folder has that name, ignoring case).
   */
  async add(input: string, label?: string | null): Promise<{ readonly folder: Folder; readonly created: boolean }> {
    const check = await this.check(input);
    if (check.kind === null || check.canonicalPath === null) throw new FolderError('invalid', check.message || 'not a workspace or a git repository', { check });
    const wanted = normalizeFolderLabel(label);
    const existing = await this.#store.folders.getByCanonicalPath(check.canonicalPath);
    if (existing) {
      const named = wanted !== null && wanted !== existing.label ? await this.#setLabel(existing, wanted) : existing;
      return { folder: await this.#toFolder(named, check), created: false };
    }
    if (wanted !== null) {
      const other = await this.#store.folders.getByLabel(wanted);
      if (other) throw labelTaken(wanted, other);
    }
    let record: FolderRecord;
    try {
      record = await this.#store.folders.create({ path: check.path, canonicalPath: check.canonicalPath, kind: check.kind, label: wanted });
    } catch (error) {
      if (wanted !== null && isLabelConflict(error)) throw labelTaken(wanted, await this.#store.folders.getByLabel(wanted));
      throw error;
    }
    await this.#store.folders.linkSessions(record);
    await this.#ensureDefault();
    return { folder: await this.#toFolder((await this.#store.folders.get(record.id)) ?? record, check), created: true };
  }

  /**
   * `DELETE /api/folders/{id}`: removes a folder from the list. Its sessions keep
   * their folder path (and lose the id); the default moves to the most recently
   * used folder left. Refused while a schedule starts its runs there.
   * @throws {FolderError} `not-found`, `folder-in-use`.
   */
  async remove(id: string): Promise<Folder[]> {
    const record = await this.#record(id);
    const schedules = await this.#store.folders.scheduleNames(record.id);
    if (schedules.length > 0) {
      throw new FolderError('folder-in-use', `schedules start their runs in ${record.path}: ${schedules.join(', ')}; change or delete them first`, { schedules });
    }
    await this.#store.folders.delete(record.id);
    await this.#ensureDefault();
    return this.list();
  }

  /**
   * `PUT /api/folders/{id}/label` (D18, Rename in Settings → Folders): gives the
   * folder a custom name, trimmed; an empty name (or `null`) removes it, so the
   * folder shows its own name again. The folder's own name, which its worktrees
   * are named after, does not change. Returns the whole list, as the other changes do.
   * @throws {FolderError} `not-found`; `invalid-label` (over 40 characters);
   * `label-taken` (another saved folder has that name, ignoring case).
   */
  async rename(id: string, label: string | null): Promise<Folder[]> {
    const record = await this.#record(id);
    await this.#setLabel(record, normalizeFolderLabel(label));
    return this.list();
  }

  /** `PUT /api/folders/{id}/default`. @throws {FolderError} `not-found`. */
  async setDefault(id: string): Promise<Folder[]> {
    await this.#record(id);
    await this.#store.folders.setDefault(id);
    return this.list();
  }

  /** Records that a session started in the saved folder `id` (the form lists recently used folders first). */
  async markUsed(id: string | null): Promise<void> {
    if (id === null) return;
    try {
      await this.#store.folders.markUsed(id);
    } catch (error) {
      this.#onError(error);
    }
  }

  // ── resolving ───────────────────────────────────────────────────────────

  /**
   * The folder a view asks for (`?folder=` of `GET /api/solutions` and
   * `/api/codebase-memory`): omitted = the default; a saved folder's id; or an
   * absolute path that is a saved folder's or a session's folder (D14: the
   * switcher also offers the folders open sessions use, which may have left the
   * saved list). Nothing is read from disk here: the views report a missing folder.
   * @throws {FolderError} `no-folder` (nothing saved), `not-found`.
   */
  async resolveForView(param?: string | null): Promise<FolderRef> {
    const wanted = param?.trim() ?? '';
    if (wanted === '') return folderRefOf(await this.#defaultOrThrow());
    const byId = await this.#store.folders.get(wanted);
    if (byId) return folderRefOf(byId);
    if (path.isAbsolute(wanted)) {
      const resolved = path.resolve(wanted);
      for (const record of await this.#store.folders.list()) {
        if (record.path === resolved || record.canonicalPath === resolved) return folderRefOf(record);
      }
      for (const session of await this.#store.sessions.list()) {
        if (session.root === resolved && session.rootKind) return { id: session.folderId, path: session.root, root: session.root, kind: session.rootKind };
      }
    }
    throw new FolderError('not-found', `no saved folder or session folder ${wanted}`);
  }

  /**
   * The folder a new session (or a schedule) starts in: `id` = a saved folder,
   * omitted = the default. The folder must still be a folder on disk; its
   * canonical path is taken now (and stored when it moved). The kind is the one
   * it was saved with.
   * @throws {FolderError} `not-found` (unknown id), `no-folder`, `folder-missing`.
   */
  async resolveForSession(id?: string | null): Promise<FolderRef> {
    const record = id ? await this.#record(id) : await this.#defaultOrThrow();
    let root: string;
    try {
      root = await realpath(record.path);
      if (!(await stat(root)).isDirectory()) throw new Error('not a folder');
    } catch {
      throw new FolderError('folder-missing', `the folder ${record.path} does not exist any more`);
    }
    if (root !== record.canonicalPath && !(await this.#store.folders.getByCanonicalPath(root))) {
      await this.#store.folders.update(record.id, { canonicalPath: root });
    }
    return { id: record.id, path: record.path, root, kind: record.kind };
  }

  /** Browse…'s starting folder: the default folder, else the home folder. */
  async browseStart(): Promise<string> {
    return (await this.#store.folders.getDefault())?.path ?? this.#home;
  }

  /** `~` expansion with this service's home folder. */
  expand(typed: string): string {
    return expandHome(typed, this.#home);
  }

  // ── internals ───────────────────────────────────────────────────────────

  async #record(id: string): Promise<FolderRecord> {
    const record = await this.#store.folders.get(id);
    if (!record) throw new FolderError('not-found', `no saved folder ${id}`);
    return record;
  }

  async #defaultOrThrow(): Promise<FolderRecord> {
    const record = await this.#store.folders.getDefault();
    if (!record) throw new FolderError('no-folder', NO_FOLDER_MESSAGE);
    return record;
  }

  /** Stores `label` (already normalized) on `record`, refused when another saved folder has it (ignoring case). */
  async #setLabel(record: FolderRecord, label: string | null): Promise<FolderRecord> {
    if (label !== null) {
      const other = await this.#store.folders.getByLabel(label);
      if (other && other.id !== record.id) throw labelTaken(label, other);
    }
    try {
      return (await this.#store.folders.update(record.id, { label })) ?? record;
    } catch (error) {
      if (label !== null && isLabelConflict(error)) throw labelTaken(label, await this.#store.folders.getByLabel(label));
      throw error;
    }
  }

  /** Keeps exactly one default while folders are saved: the most recently used (else the first added). */
  async #ensureDefault(): Promise<void> {
    if (await this.#store.folders.getDefault()) return;
    const first = (await this.#store.folders.list())[0];
    if (first) await this.#store.folders.setDefault(first.id);
  }

  async #toFolder(record: FolderRecord, known?: FolderCheck): Promise<Folder> {
    const name = path.basename(record.path) || record.path;
    return {
      id: record.id,
      path: record.path,
      canonicalPath: record.canonicalPath,
      name,
      label: record.label,
      displayName: record.label ?? name,
      kind: record.kind,
      isDefault: record.isDefault,
      addedAt: record.addedAt,
      lastUsedAt: record.lastUsedAt,
      check: known ?? (await this.check(record.path)),
    };
  }
}
