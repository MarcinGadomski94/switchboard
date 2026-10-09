import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Session } from '../../core/api.ts';
import type { SessionStatus } from '../../core/model.ts';
import { isRemoteId } from '../../core/peers.ts';
import { CheckpointGit } from '../checkpoints/git.ts';
import type { CheckpointRecord } from '../db/repos/checkpoints.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import type { HubBus } from '../hub/bus.ts';

/**
 * D90 (`docs/worktrees.md` → *Diff* → *Touched files*): the files a session touched
 * in a working tree it uses **in place**, so the Diff tab's default view ("Since
 * last commit") shows only the session's own uncommitted changes there, not
 * everyone's. Two sources, united:
 *
 * 1. **Tool events** (always): the paths of its Write / Edit / MultiEdit /
 *    NotebookEdit calls (main agent and subagents).
 * 2. **Checkpoints** (D80, when the turn has one in that working tree): the files
 *    that changed between a turn's checkpoint and the turn's end, which also
 *    catches what Bash created, changed or deleted. The turn's end is the
 *    snapshot taken when the session's status went from `run` to `idle` / `done`
 *    (as D79's review cards read a turn's end; kept in memory), else
 *    the next turn's checkpoint; a running turn is compared with the working tree
 *    now. The latest turn of a session that ended before a restart has no end
 *    snapshot: only its tool events count.
 *
 * The result is a superset of the session's own edits only where another edit
 * landed in the same file during one of its turns; the Diff intersects it with
 * the uncommitted changes. Reading never writes anything but git objects (the
 * D80 throw-away-index snapshot): no refs, no index, no files.
 */

/** The file-editing tools whose `file_path` / `notebook_path` names a touched file. */
export const EDIT_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/** End snapshots kept in memory (oldest dropped first). */
const MAX_ENDS = 2_000;
/** Memoized tree-to-tree path lists (trees are immutable, so a pair's answer never changes). */
const MAX_PAIRS = 2_000;

/** The git the touched files need (the D80 helper; tests may pass their own). */
export interface TouchedGit {
  snapshot(top: string): Promise<{ readonly tree: string }>;
  diff(top: string, from: string, to: string): Promise<ReadonlyArray<{ readonly path: string }>>;
}

/** Options of {@link SessionTouchedFiles}. */
export interface SessionTouchedFilesOptions {
  readonly store: Store;
  /** Defaults to a {@link CheckpointGit} with `env`. */
  readonly git?: TouchedGit;
  readonly env?: NodeJS.ProcessEnv;
  readonly onError?: (error: unknown) => void;
}

/**
 * The longest existing ancestor of `file` resolved through symlinks, with the
 * rest appended (a deleted file still maps into its repo; macOS `/var` →
 * `/private/var`).
 */
export async function canonicalPath(file: string): Promise<string> {
  const absolute = path.resolve(file);
  let current = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** `file` relative to `top` with `/` separators, `null` when it is not inside `top`. */
export function insideRelative(top: string, file: string): string | null {
  const relative = path.relative(top, file);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

/** D90: which files a session touched in one working tree (see the module comment). */
export class SessionTouchedFiles {
  readonly #store: Store;
  readonly #git: TouchedGit;
  readonly #onError: (error: unknown) => void;
  /** `<session>\0<turn>\0<repo top>` → the tree when that turn ended. */
  readonly #ends = new Map<string, string>();
  /** The same keys while their snapshot is being taken (a Diff read right at the turn's end waits for it). */
  readonly #pending = new Map<string, Promise<string | null>>();
  readonly #pairs = new Map<string, readonly string[]>();
  readonly #status = new Map<string, SessionStatus>();
  #unsubscribe: (() => void) | null = null;

  constructor(options: SessionTouchedFilesOptions) {
    this.#store = options.store;
    this.#git = options.git ?? new CheckpointGit(options.env ? { env: options.env } : {});
    this.#onError = options.onError ?? ((error) => console.error('switchboard touched files:', error));
  }

  /** Starts taking an end snapshot of each turn (a session's status going from `run` to `idle` / `done`); returns the stop function. */
  listen(bus: HubBus): () => void {
    this.#unsubscribe?.();
    const unsubscribe = bus.subscribe((message) => {
      if (message.name !== 'sessionUpdated') return;
      const session: Session = message.payload;
      if (isRemoteId(session.id)) return;
      const before = this.#status.get(session.id);
      this.#status.set(session.id, session.status);
      if (before === 'run' && (session.status === 'idle' || session.status === 'done')) this.turnEnded(session.id);
    });
    this.#unsubscribe = unsubscribe;
    return () => {
      unsubscribe();
      if (this.#unsubscribe === unsubscribe) this.#unsubscribe = null;
    };
  }

  /** Stops listening and waits for the snapshots in flight. */
  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    await this.idle();
  }

  /** Resolves once no end snapshot is being taken (tests). */
  async idle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending.values()]);
  }

  /**
   * A turn of the session ended: snapshots each working tree its latest turn has a
   * checkpoint in, as that turn's end. Started synchronously (a Diff read that
   * arrives next waits for it); never throws.
   */
  turnEnded(sessionId: string): void {
    const work = (async (): Promise<void> => {
      const rows = await this.#store.checkpoints.listOf(sessionId, 'turn');
      const latest = rows.reduce((top, row) => Math.max(top, row.turnSeq), 0);
      for (const row of rows.filter((r) => r.turnSeq === latest)) {
        const key = endKey(sessionId, row.turnSeq, row.repoPath);
        // A turn that went on by itself (a background task's end) ends again: the later end wins.
        if (this.#pending.has(key)) continue;
        const snap = this.#snapshot(row.repoPath).then((tree) => {
          if (tree !== null) this.#remember(key, tree);
          return tree;
        });
        this.#pending.set(key, snap);
        void snap.finally(() => this.#pending.delete(key));
      }
    })();
    const marker = `${sessionId}\u0000listing`;
    const tracked = work.then(
      () => null,
      (error: unknown) => {
        this.#onError(error);
        return null;
      },
    );
    this.#pending.set(marker, tracked);
    void tracked.finally(() => this.#pending.delete(marker));
  }

  /**
   * The files `session` touched inside the working tree `top` (relative paths,
   * `/`-separated): its edit tools' paths plus, where it has checkpoints there,
   * what changed during each of its turns.
   */
  async paths(session: Pick<SessionRecord, 'id' | 'cwd' | 'status'>, top: string): Promise<Set<string>> {
    const repo = await canonicalPath(top);
    const out = new Set<string>();
    for (const written of await this.#store.events.editedFilePaths(session.id, EDIT_TOOLS)) {
      const absolute = path.isAbsolute(written) ? written : session.cwd ? path.resolve(session.cwd, written) : null;
      if (absolute === null) continue;
      const relative = insideRelative(repo, await canonicalPath(absolute));
      if (relative !== null) out.add(relative);
    }
    // The listing of a just-ended turn's snapshots starts synchronously; wait for it.
    await this.#pending.get(`${session.id}\u0000listing`);
    const rows = await this.#turnRows(session.id, repo);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as CheckpointRecord;
      const end = await this.#endOf(session, row, rows[i + 1] ?? null, i === rows.length - 1);
      if (end === null) continue;
      try {
        for (const file of await this.#changed(row.repoPath, row.tree, end)) out.add(file);
      } catch (error) {
        this.#onError(error);
      }
    }
    return out;
  }

  /** The session's turn checkpoints in `repo` (one per turn, oldest first). */
  async #turnRows(sessionId: string, repo: string): Promise<CheckpointRecord[]> {
    const byTurn = new Map<number, CheckpointRecord>();
    for (const row of await this.#store.checkpoints.listOf(sessionId, 'turn')) {
      if (byTurn.has(row.turnSeq)) continue;
      if (row.repoPath !== repo && (await canonicalPath(row.repoPath)) !== repo) continue;
      byTurn.set(row.turnSeq, row);
    }
    return [...byTurn.values()].sort((a, b) => a.turnSeq - b.turnSeq);
  }

  /** The tree a turn ended with: its end snapshot, else the next turn's checkpoint, else (running, latest) the working tree now. */
  async #endOf(session: Pick<SessionRecord, 'id' | 'status'>, row: CheckpointRecord, next: CheckpointRecord | null, latest: boolean): Promise<string | null> {
    const key = endKey(session.id, row.turnSeq, row.repoPath);
    const pending = this.#pending.get(key);
    if (pending) await pending;
    const ended = this.#ends.get(key);
    if (ended !== undefined) return ended;
    if (next !== null) return next.tree;
    if (latest && session.status === 'run') return this.#snapshot(row.repoPath);
    return null;
  }

  async #snapshot(top: string): Promise<string | null> {
    try {
      return (await this.#git.snapshot(top)).tree;
    } catch (error) {
      this.#onError(error);
      return null;
    }
  }

  async #changed(top: string, from: string, to: string): Promise<readonly string[]> {
    if (from === to) return [];
    const key = `${from}\u0000${to}`;
    const known = this.#pairs.get(key);
    if (known) return known;
    const files = (await this.#git.diff(top, from, to)).map((change) => change.path);
    this.#pairs.set(key, files);
    if (this.#pairs.size > MAX_PAIRS) this.#pairs.delete(this.#pairs.keys().next().value as string);
    return files;
  }

  #remember(key: string, tree: string): void {
    this.#ends.set(key, tree);
    if (this.#ends.size > MAX_ENDS) this.#ends.delete(this.#ends.keys().next().value as string);
  }
}

function endKey(sessionId: string, turn: number, repo: string): string {
  return `${sessionId}\u0000${turn}\u0000${repo}`;
}
