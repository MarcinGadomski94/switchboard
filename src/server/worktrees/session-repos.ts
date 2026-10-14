import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { solutionCandidates } from '../../core/worktrees.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { WorktreeRecord } from '../db/repos/worktrees.ts';
import type { Store } from '../db/store.ts';
import { type FolderRef, folderOfSession, repoSolutionName } from '../folders/ref.ts';
import { isReadOnlyByLayout } from '../sessions/validate.ts';
import { isWorkingTreeTop, watchedCheckoutOf } from '../solutions/checkout.ts';
import type { SessionTouchedFiles } from './touched.ts';

/**
 * The repositories a session works in (D79 / D80 / D90 follow-up 2026-10-13,
 * `docs/worktrees.md` → *Which repositories*): the ONE answer turn checkpoints and
 * the Diff tab both read, so they never disagree (D102: review cards, its first
 * reader, were removed).
 *
 * - **worktrees**: the session's registered worktrees (`worktrees` rows);
 * - **in place**, deduplicated by real path, in this order:
 *   1. its declared solutions resolved in its folder for **watching**: a main
 *      checkout or a **linked worktree** (an agent-made `…-wt-…` folder; its
 *      `.git` is a file), else the one nested main checkout. A solution that has
 *      a registered worktree, read-only layout folders (`deprecated/`,
 *      `infrastructure/`) and ambiguous names are left out. A repo folder's one
 *      solution is the repo when the session names none;
 *   2. the git working trees of the files the session edited (its Write / Edit /
 *      MultiEdit / NotebookEdit calls, D90's source), wherever they are, inside
 *      the folder or not, but never a read-only layout folder of a workspace;
 *   3. its cwd's working tree, when it is not a workspace session, or when
 *      nothing else was found.
 *
 * Creating worktrees keeps its own strict resolution (`WorktreeManager.resolveRepo`,
 * main checkouts only); nothing here is used for that.
 *
 * Cheap per turn: the edited files are read incrementally (only the edit events
 * stored since the last call) and their working trees are remembered per session;
 * the declared solutions are resolved again only when the session's solutions,
 * folder or cwd change, when it edited something new, or after {@link RESOLVE_TTL_MS}.
 */

/** Where a watched in-place repository came from. */
export type WatchedRepoSource = 'solution' | 'edited' | 'cwd';

/** One working tree a session uses in place. */
export interface WatchedRepo {
  /** The declared solution name, else the working tree's folder name. */
  readonly name: string;
  /** The working tree's top folder (real path). */
  readonly top: string;
  readonly source: WatchedRepoSource;
}

/** The repositories a session works in. */
export interface SessionRepoSet {
  readonly worktrees: readonly WorktreeRecord[];
  readonly inPlace: readonly WatchedRepo[];
  /**
   * The working trees (real paths) the session's edits fell in, first edit first,
   * before any de-duplication: a declared solution's checkout the session also
   * edited is listed here though `inPlace` names it once as `solution`, and so is
   * a registered worktree. Solutions (2026-10-14) reads it to tell a checkout the
   * session really wrote in from one it only names.
   */
  readonly editedTops: readonly string[];
}

/** How long the declared solutions' resolution is reused without any change (a folder made meanwhile shows up after it). */
export const RESOLVE_TTL_MS = 30_000;

/** Sessions whose answers are remembered (oldest dropped first). */
const MAX_SESSIONS = 500;

interface Entry {
  /** Newest edit event read. */
  lastEditId: number;
  /** The edited files' working trees, first edit first (`null`: in no git working tree). */
  readonly edited: Map<string, string | null>;
  /** The edited files' folders already resolved (folder → top). */
  readonly folders: Map<string, string | null>;
  declaredKey: string | null;
  declaredAt: number;
  declared: WatchedRepo[];
}

/** Options of {@link SessionRepos}. */
export interface SessionReposOptions {
  readonly store: Store;
  readonly touched: Pick<SessionTouchedFiles, 'editedFilesAfter'>;
  /** Epoch ms (tests). */
  readonly now?: () => number;
}

/** The repositories a session works in (see the module comment). */
export class SessionRepos {
  readonly #store: Store;
  readonly #touched: Pick<SessionTouchedFiles, 'editedFilesAfter'>;
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry>();

  constructor(options: SessionReposOptions) {
    this.#store = options.store;
    this.#touched = options.touched;
    this.#now = options.now ?? Date.now;
  }

  /** The session's worktrees and the working trees it uses in place. Never throws for an unreadable folder (it is left out). */
  async of(session: SessionRecord): Promise<SessionRepoSet> {
    const worktrees = await this.#store.worktrees.list({ sessionId: session.id });
    const entry = this.#entry(session.id);
    const folder = folderOfSession(session);
    const root = folder ? await realOrNull(folder.root) : null;
    const workspaceRoot = folder?.kind === 'workspace' ? root : null;

    // The edited files' working trees (only the edits stored since the last call are read).
    const { files, lastId } = await this.#touched.editedFilesAfter(session, entry.lastEditId);
    const editedSomethingNew = lastId !== entry.lastEditId && files.length > 0;
    entry.lastEditId = lastId;
    for (const file of files) {
      if (entry.edited.has(file)) continue;
      entry.edited.set(file, await this.#topOfFile(entry, file));
    }

    // The declared solutions, resolved again when something changed.
    const worktreeKey = worktrees.map((w) => `${w.id}:${w.repo}:${w.repoPath}`).join('|');
    const key = JSON.stringify([folder?.kind ?? null, root, session.solutions, worktreeKey]);
    if (entry.declaredKey !== key || editedSomethingNew || this.#now() - entry.declaredAt > RESOLVE_TTL_MS) {
      entry.declared = folder && root ? await declaredRepos(session, folder, root, worktrees) : [];
      entry.declaredKey = key;
      entry.declaredAt = this.#now();
    }

    const worktreeTops = new Set<string>();
    for (const worktree of worktrees) worktreeTops.add((await realOrNull(worktree.path)) ?? worktree.path);
    const out: WatchedRepo[] = [];
    const add = (repo: WatchedRepo): void => {
      if (worktreeTops.has(repo.top) || out.some((known) => known.top === repo.top)) return;
      if (workspaceRoot !== null && readOnlyInside(workspaceRoot, repo.top)) return;
      out.push(repo);
    };
    for (const repo of entry.declared) add(repo);
    for (const top of entry.edited.values()) if (top !== null) add({ name: path.basename(top), top, source: 'edited' });
    if (session.cwd && (folder?.kind !== 'workspace' || (out.length === 0 && worktrees.length === 0))) {
      const top = await topOfDir(session.cwd);
      if (top !== null) add({ name: path.basename(top), top, source: 'cwd' });
    }
    const editedTops = [...new Set([...entry.edited.values()].filter((top): top is string => top !== null))];
    return { worktrees, inPlace: out, editedTops };
  }

  /** Forgets a session's remembered answer (tests; a session that is gone). */
  forget(sessionId: string): void {
    this.#entries.delete(sessionId);
  }

  #entry(sessionId: string): Entry {
    let entry = this.#entries.get(sessionId);
    if (entry) {
      // Most recently used last.
      this.#entries.delete(sessionId);
      this.#entries.set(sessionId, entry);
      return entry;
    }
    entry = { lastEditId: 0, edited: new Map(), folders: new Map(), declaredKey: null, declaredAt: 0, declared: [] };
    this.#entries.set(sessionId, entry);
    if (this.#entries.size > MAX_SESSIONS) this.#entries.delete(this.#entries.keys().next().value as string);
    return entry;
  }

  async #topOfFile(entry: Entry, file: string): Promise<string | null> {
    const dir = path.dirname(file);
    if (entry.folders.has(dir)) return entry.folders.get(dir) ?? null;
    const top = await topOfDir(dir);
    entry.folders.set(dir, top);
    return top;
  }
}

/** The declared solutions resolved for watching (see the module comment, rule 1). */
async function declaredRepos(session: SessionRecord, folder: FolderRef, root: string, worktrees: readonly WorktreeRecord[]): Promise<WatchedRepo[]> {
  if (folder.kind === 'plain') return [];
  const names = session.solutions.length > 0 ? session.solutions : folder.kind === 'repo' ? [repoSolutionName(folder)] : [];
  const mainCheckouts = new Set<string>();
  for (const worktree of worktrees) mainCheckouts.add((await realOrNull(worktree.repoPath)) ?? worktree.repoPath);
  const out: WatchedRepo[] = [];
  for (const name of names) {
    if (worktrees.some((worktree) => worktree.repo === name)) continue;
    const top = await watchedSolution(name, folder, root);
    if (top === null || mainCheckouts.has(top) || out.some((known) => known.top === top)) continue;
    out.push({ name, top, source: 'solution' });
  }
  return out;
}

/** A solution name's working tree for watching (a main checkout or a linked worktree), `null` when none or ambiguous. */
async function watchedSolution(solution: string, folder: FolderRef, root: string): Promise<string | null> {
  if (folder.kind === 'repo') {
    if (solution !== repoSolutionName(folder) && solution !== path.basename(folder.path)) return null;
    return (await isWorkingTreeTop(root)) ? root : null;
  }
  if (isReadOnlyByLayout(solution)) return null;
  const found = new Set<string>();
  for (const candidate of solutionCandidates(root, solution) ?? []) {
    const checkout = await watchedCheckoutOf(candidate);
    if (checkout === null) continue;
    found.add((await realOrNull(checkout)) ?? checkout);
  }
  return found.size === 1 ? ([...found][0] as string) : null;
}

/** The top of the git working tree `dir` (or its nearest existing ancestor) is in: the nearest folder with a `.git` entry; `null` outside one. */
export async function topOfDir(dir: string): Promise<string | null> {
  let current = (await realOrNull(dir)) ?? path.resolve(dir);
  for (;;) {
    if (await isWorkingTreeTop(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = (await realOrNull(parent)) ?? parent;
  }
}

/** `true` when `top` lies in a read-only layout folder (`deprecated/`, `infrastructure/`) of the workspace `root`. */
function readOnlyInside(root: string, top: string): boolean {
  const relative = path.relative(root, top);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return isReadOnlyByLayout(relative);
}

async function realOrNull(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

