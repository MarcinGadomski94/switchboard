import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FolderListing, SetupState, WorkspaceRootCheck, WorkspaceRootSource } from '../../core/api.ts';
import { SETUP_KEYS, WARN_AT_KEY, countLines, routerTitle, warnAtPct } from '../../core/setup.ts';
import type { ServerConfig } from '../config.ts';
import type { Store } from '../db/store.ts';

/** The router file at the workspace root (as the scanner reads it). */
const ROUTER_FILE = 'AGENTS.md';

/** Browse… lists at most this many subfolders. */
export const MAX_FOLDERS = 500;

/** Why a setup call was refused, with its HTTP status. */
export type SetupErrorCode = 'invalid' | 'root-from-env' | 'sessions-live' | 'not-found';

const STATUS: Readonly<Record<SetupErrorCode, number>> = { invalid: 422, 'root-from-env': 409, 'sessions-live': 409, 'not-found': 404 };

/** A refused setup call (`docs/setup.md` → *API*). */
export class SetupError extends Error {
  override name = 'SetupError';
  readonly code: SetupErrorCode;
  readonly status: number;
  /** The root check behind an `invalid` root. */
  readonly check: WorkspaceRootCheck | null;

  constructor(code: SetupErrorCode, message: string, check: WorkspaceRootCheck | null = null) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.check = check;
  }
}

/** Options for {@link SetupService}. */
export interface SetupServiceOptions {
  readonly store: Store;
  /** `SWITCHBOARD_WORKSPACE_ROOT` (absolute) or `null`; when set it wins and the wizard cannot change it. */
  readonly envRoot: string | null;
  /** Open the wizard by itself while setup is not done (`SWITCHBOARD_SETUP_WIZARD` ≠ `off`). Default `true`. */
  readonly autoOpen?: boolean;
  /** Home folder: `~` in typed paths and the folder Browse… starts in without a root. Default `os.homedir()`. */
  readonly home?: string;
  readonly now?: () => Date;
}

/** `SWITCHBOARD_SETUP_WIZARD=off` stops the wizard from opening by itself (Settings → Run setup again still opens it). */
export function setupWizardAutoOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SWITCHBOARD_SETUP_WIZARD']?.trim().toLowerCase() !== 'off';
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

type RootListener = (root: string | null) => void;

/**
 * The first-run setup (M5.3, `docs/setup.md`): whether the wizard was finished,
 * the workspace root (the environment's, else the one chosen in the wizard,
 * stored in the settings table and handed to the services that start sessions,
 * scan and create worktrees, at once), the root check, Browse…'s folder listing
 * and the usage threshold the last step shows. Only reads the file system; the
 * only writes are its own settings rows.
 */
export class SetupService {
  readonly #store: Store;
  readonly #envRoot: string | null;
  readonly #autoOpen: boolean;
  readonly #home: string;
  readonly #now: () => Date;
  readonly #listeners = new Set<RootListener>();
  #stored: string | null = null;

  constructor(options: SetupServiceOptions) {
    this.#store = options.store;
    this.#envRoot = options.envRoot;
    this.#autoOpen = options.autoOpen ?? true;
    this.#home = options.home ?? os.homedir();
    this.#now = options.now ?? (() => new Date());
  }

  /** A service with the stored root loaded (call before creating the services that use the root). */
  static async open(options: SetupServiceOptions): Promise<SetupService> {
    const service = new SetupService(options);
    await service.load();
    return service;
  }

  /** Reads the stored root (an absolute path string, anything else is ignored). */
  async load(): Promise<void> {
    const value = await this.#store.settings.get(SETUP_KEYS.workspaceRoot);
    this.#stored = typeof value === 'string' && path.isAbsolute(value) ? value : null;
  }

  /** The workspace root in effect: `SWITCHBOARD_WORKSPACE_ROOT`, else the wizard's, else `null`. */
  get workspaceRoot(): string | null {
    return this.#envRoot ?? this.#stored;
  }

  /** Where {@link workspaceRoot} comes from. */
  get rootSource(): WorkspaceRootSource | null {
    if (this.#envRoot) return 'env';
    return this.#stored ? 'setup' : null;
  }

  /** Called with the new root after the wizard changed it. Returns an unsubscribe function. */
  onRootChange(listener: RootListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * `config` with a `workspaceRoot` that reads {@link workspaceRoot} on every
   * access, so code that reads the configuration per request follows the wizard.
   */
  liveConfig(config: ServerConfig): ServerConfig {
    const live = { ...config };
    Object.defineProperty(live, 'workspaceRoot', { get: () => this.workspaceRoot, enumerable: true, configurable: true });
    return live;
  }

  /** `GET /api/setup`. */
  async state(): Promise<SetupState> {
    const [completed, threshold] = await Promise.all([this.#store.settings.get(SETUP_KEYS.completedAt), this.#store.settings.get(WARN_AT_KEY)]);
    const completedAt = typeof completed === 'string' ? completed : null;
    const root = this.workspaceRoot;
    return {
      completedAt,
      autoOpen: this.#autoOpen && completedAt === null,
      workspaceRoot: { path: root, source: this.rootSource, check: root ? await this.checkRoot(root) : null },
      warnAtPct: warnAtPct(threshold),
    };
  }

  /** What `input` (an absolute path, or `~/…`) holds: a folder with an `AGENTS.md` (its title + line count), a folder without, or nothing. */
  async checkRoot(input: string): Promise<WorkspaceRootCheck> {
    const typed = this.#expand(input.trim());
    if (!path.isAbsolute(typed)) return { path: input.trim(), state: 'not-absolute', router: null };
    const folder = path.resolve(typed);
    try {
      if (!(await stat(folder)).isDirectory()) return { path: folder, state: 'missing', router: null };
    } catch {
      return { path: folder, state: 'missing', router: null };
    }
    let text: string;
    try {
      text = await readFile(path.join(folder, ROUTER_FILE), 'utf8');
    } catch {
      return { path: folder, state: 'no-router', router: null };
    }
    return { path: folder, state: 'ok', router: { title: routerTitle(text), lines: countLines(text) } };
  }

  /**
   * Saves `input` as the workspace root and hands it to the services
   * ({@link onRootChange}). Refused while `SWITCHBOARD_WORKSPACE_ROOT` is set
   * (409 `root-from-env`), for anything but a folder with an `AGENTS.md` (422
   * `invalid`), and, when it changes the root, while supervised `claude`
   * processes run (`liveProcesses` > 0: 409 `sessions-live`). Sessions keep the
   * folder they started in (their stored cwd); only new ones use the new root.
   */
  async saveRoot(input: string, options: { readonly liveProcesses?: number } = {}): Promise<SetupState> {
    if (this.#envRoot) {
      throw new SetupError('root-from-env', `the workspace root is set by SWITCHBOARD_WORKSPACE_ROOT (${this.#envRoot})`);
    }
    const check = await this.checkRoot(input);
    if (check.state !== 'ok') throw new SetupError('invalid', rootProblem(check), check);
    if (check.path !== this.#stored) {
      if ((options.liveProcesses ?? 0) > 0) {
        throw new SetupError('sessions-live', 'pause or finish the running sessions before changing the workspace root');
      }
      await this.#store.settings.set(SETUP_KEYS.workspaceRoot, check.path);
      this.#stored = check.path;
      for (const listener of this.#listeners) listener(this.workspaceRoot);
    }
    return this.state();
  }

  /** Marks the setup as done (the wizard's Finish). */
  async complete(): Promise<SetupState> {
    await this.#store.settings.set(SETUP_KEYS.completedAt, this.#now().toISOString());
    return this.state();
  }

  /**
   * Browse…: the subfolders of `input` (default: the workspace root, else the
   * home folder), hidden ones left out, sorted by name, at most {@link MAX_FOLDERS}.
   * Folder names only; nothing is opened below them.
   */
  async folders(input?: string): Promise<FolderListing> {
    const typed = input?.trim() ? this.#expand(input.trim()) : (this.workspaceRoot ?? this.#home);
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

  #expand(typed: string): string {
    if (typed === '~') return this.#home;
    if (typed.startsWith('~/') || typed.startsWith('~\\')) return path.join(this.#home, typed.slice(2));
    return typed;
  }
}

/** The refusal message for a root that is not a folder with an `AGENTS.md`. */
export function rootProblem(check: WorkspaceRootCheck): string {
  switch (check.state) {
    case 'not-absolute':
      return 'enter an absolute path';
    case 'missing':
      return 'folder not found';
    case 'no-router':
      return 'no AGENTS.md in this folder';
    case 'ok':
      return '';
  }
}
