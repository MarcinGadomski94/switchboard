import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { FolderListing, SetupState } from '../../core/api.ts';
import { SETUP_KEYS, WARN_AT_KEY, warnAtPct } from '../../core/setup.ts';
import type { Store } from '../db/store.ts';
import type { FolderService } from '../folders/service.ts';

/** Browse… lists at most this many subfolders. */
export const MAX_FOLDERS = 500;

/** Why a setup call was refused, with its HTTP status. */
export type SetupErrorCode = 'invalid' | 'not-found';

const STATUS: Readonly<Record<SetupErrorCode, number>> = { invalid: 422, 'not-found': 404 };

/** A refused setup call (`docs/setup.md` → *API*). */
export class SetupError extends Error {
  override name = 'SetupError';
  readonly code: SetupErrorCode;
  readonly status: number;

  constructor(code: SetupErrorCode, message: string) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
  }
}

/** Options for {@link SetupService}. */
export interface SetupServiceOptions {
  readonly store: Store;
  /** The saved folders (D14): the wizard's "Add your first folder" step and Browse…'s starting folder. */
  readonly folders: FolderService;
  /** Open the wizard by itself while setup is not done (`SWITCHBOARD_SETUP_WIZARD` ≠ `off`). Default `true`. */
  readonly autoOpen?: boolean;
  readonly now?: () => Date;
}

/** `SWITCHBOARD_SETUP_WIZARD=off` stops the wizard from opening by itself (Settings → Run setup again still opens it). */
export function setupWizardAutoOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SWITCHBOARD_SETUP_WIZARD']?.trim().toLowerCase() !== 'off';
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

/**
 * The first-run setup (M5.3, `docs/setup.md`; D14): whether the wizard was
 * finished, the saved folders its "Add your first folder" step shows (skippable;
 * folders are added through `POST /api/folders`), Browse…'s folder listing and
 * the usage threshold the last step shows. There is no workspace root to
 * configure any more: every session picks its folder. Only reads the file
 * system; the only writes are its own settings rows.
 */
export class SetupService {
  readonly #store: Store;
  readonly #folders: FolderService;
  readonly #autoOpen: boolean;
  readonly #now: () => Date;

  constructor(options: SetupServiceOptions) {
    this.#store = options.store;
    this.#folders = options.folders;
    this.#autoOpen = options.autoOpen ?? true;
    this.#now = options.now ?? (() => new Date());
  }

  /** `GET /api/setup`. */
  async state(): Promise<SetupState> {
    const [completed, threshold, folders] = await Promise.all([
      this.#store.settings.get(SETUP_KEYS.completedAt),
      this.#store.settings.get(WARN_AT_KEY),
      this.#folders.list(),
    ]);
    const completedAt = typeof completed === 'string' ? completed : null;
    return {
      completedAt,
      autoOpen: this.#autoOpen && completedAt === null,
      folders,
      warnAtPct: warnAtPct(threshold),
    };
  }

  /** Marks the setup as done (the wizard's Finish). */
  async complete(): Promise<SetupState> {
    await this.#store.settings.set(SETUP_KEYS.completedAt, this.#now().toISOString());
    return this.state();
  }

  /**
   * Browse…: the subfolders of `input` (default: the default folder, else the
   * home folder), hidden ones left out, sorted by name, at most {@link MAX_FOLDERS}.
   * Folder names only; nothing is opened below them.
   */
  async folders(input?: string): Promise<FolderListing> {
    const typed = input?.trim() ? this.#folders.expand(input.trim()) : await this.#folders.browseStart();
    if (!path.isAbsolute(typed)) throw new SetupError('invalid', 'enter an absolute path');
    const folder = path.resolve(typed);
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new SetupError('not-found', `no folder ${folder}`);
      throw error;
    }
    const names = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_FOLDERS);
    const parent = path.dirname(folder);
    return { path: folder, parent: parent === folder ? null : parent, folders: names.map((name) => ({ name, path: path.join(folder, name) })) };
  }
}
