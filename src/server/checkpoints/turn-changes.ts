/**
 * D180 · side panel: what each turn changed (contract and limits: `src/core/turn-changes.ts`).
 *
 * Reads only: the turn rows of `turn_checkpoints` and their trees (D80). "Now" is a
 * snapshot taken the way a save point is (`CheckpointGit.snapshot`: a throw-away
 * index, so the developer's index, HEAD and files are never touched; it adds objects
 * to the repo for content git has not seen, as every save point does).
 *
 * D180 (the developer, 2026-11-20): a turn's changes are only this agent's: the files its own
 * edit tools (Write, Edit, MultiEdit, NotebookEdit) named during the turn. Another agent or a
 * person editing the same working tree meanwhile does not count to it.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FileDiff } from '../../core/api.ts';
import type { TurnChange, TurnChanges, TurnChangesErrorCode } from '../../core/turn-changes.ts';
import { parsePatch, toFileDiff } from '../../core/worktrees.ts';
import type { CheckpointRecord } from '../db/repos/checkpoints.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { mapLimit } from '../map-limit.ts';
import { EDIT_TOOLS, canonicalPath, editedAbsolute, insideRelative } from '../worktrees/touched.ts';
import { CheckpointGit, type TreeSnapshot } from './git.ts';

/** HTTP status per error code. */
export const TURN_CHANGES_STATUS: Readonly<Record<TurnChangesErrorCode, number>> = { 'not-found': 404, 'no-checkpoint': 404, remote: 409, invalid: 422, unreadable: 500 };

/**
 * A short name per working tree for `FileDiff.solution`: its folder's name; two trees
 * with the same folder name (a main checkout and a separate copy of it) get their
 * parent folder in front, so their files stay apart.
 */
export function treeLabels(tops: readonly string[]): Map<string, string> {
  const uses = new Map<string, number>();
  for (const top of tops) uses.set(path.basename(top), (uses.get(path.basename(top)) ?? 0) + 1);
  const labels = new Map<string, string>();
  for (const top of tops) {
    const name = path.basename(top);
    labels.set(top, (uses.get(name) ?? 0) > 1 ? `${path.basename(path.dirname(top))}/${name}` : name);
  }
  return labels;
}

/** D180: git's arguments that limit a diff to `paths` (literal, never globs); none for `null` (the whole tree). */
export function pathspec(paths: readonly string[] | null): string[] {
  return paths === null ? [] : ['--', ...paths.map((file) => `:(literal)${file}`)];
}

/** A refusal the route turns into `{ error, message }`. */
export class TurnChangesError extends Error {
  readonly code: TurnChangesErrorCode;
  constructor(code: TurnChangesErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Where a turn ended: the snapshot the Diff takes when a turn ends (D90, `worktrees/touched.ts`), and when it was taken (epoch ms). */
export interface TurnEnds {
  endTree(sessionId: string, turn: number, repoPath: string): Promise<{ readonly tree: string; readonly at: number } | null>;
}

/** Options of {@link TurnChangesService}. */
export interface TurnChangesOptions {
  readonly store: Store;
  readonly git?: CheckpointGit;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * With it a turn's changes end where the turn ended, so what changes afterwards (by
   * hand, before the next message) is not counted to it. Without it, or for a turn
   * that ended before a restart: the next save point, else the files now.
   */
  readonly ends?: TurnEnds;
}

interface Counts {
  readonly files: number;
  readonly added: number;
  readonly removed: number;
}

/** Working trees read at once. */
const REPO_CONCURRENCY = 4;
/** Counted pairs of trees kept (a pair's answer never changes). */
const COUNTS_KEPT = 2000;

export class TurnChangesService {
  readonly #store: Store;
  readonly #git: CheckpointGit;
  readonly #ends: TurnEnds | null;
  readonly #counts = new Map<string, Counts>();

  constructor(options: TurnChangesOptions) {
    this.#store = options.store;
    this.#git = options.git ?? new CheckpointGit(options.env ? { env: options.env } : {});
    this.#ends = options.ends ?? null;
  }

  /** When the turn of a save point began (epoch ms): its message's time. The row itself is stored in the background and can be later. */
  async #began(row: CheckpointRecord): Promise<number> {
    const event = row.eventId === null ? null : await this.#store.events.get(row.eventId);
    return Date.parse(event?.ts ?? row.createdAt);
  }

  /**
   * The tree the turns of `row` ended with (`next`: the working tree's next save point);
   * `null` when no end snapshot of theirs is kept. An end taken after the next turn
   * began is that turn's, not this one's: a turn that ends before its own row is stored
   * leaves its end snapshot under the save point before it (`touched.ts` → `endTree`).
   */
  async #ended(sessionId: string, row: CheckpointRecord, next: CheckpointRecord | undefined): Promise<string | null> {
    if (!this.#ends) return null;
    const end = await this.#ends.endTree(sessionId, row.turnSeq, row.repoPath);
    if (!end) return null;
    if (next && end.at >= (await this.#began(next))) return null;
    return end.tree;
  }

  /** The session's turn rows per working tree, oldest turn first. */
  async #rows(sessionId: string): Promise<Map<string, CheckpointRecord[]>> {
    const byRepo = new Map<string, CheckpointRecord[]>();
    for (const row of await this.#store.checkpoints.listOf(sessionId, 'turn')) {
      const rows = byRepo.get(row.repoPath);
      if (rows) rows.push(row);
      else byRepo.set(row.repoPath, [row]);
    }
    for (const rows of byRepo.values()) rows.sort((a, b) => a.turnSeq - b.turnSeq || a.id - b.id);
    return byRepo;
  }

  /** `true` when the working tree's folder is no longer there (a removed copy). */
  async #gone(top: string): Promise<boolean> {
    return !(await stat(top).then(
      (info) => info.isDirectory(),
      () => false,
    ));
  }

  /**
   * The working tree as it is now; `null` when its folder is gone (a removed copy: left
   * out). A folder that is there and that git cannot read is an error (`unreadable`),
   * never "nothing changed".
   */
  async #now(top: string): Promise<TreeSnapshot | null> {
    try {
      return await this.#git.snapshot(top);
    } catch (error) {
      if (await this.#gone(top)) return null;
      throw new TurnChangesError('unreadable', `git could not read ${path.basename(top)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * D180: the files this agent's own edit tools named in the events after `afterEventId` and
   * before `beforeEventId` (`null`: until now), as paths inside the working tree `top`
   * (`/`-separated). `null` when the turn's message is unknown (`afterEventId` null): then the
   * whole tree counts, as before.
   */
  async #own(session: Pick<SessionRecord, 'id' | 'cwd'>, top: string, afterEventId: number | null, beforeEventId: number | null): Promise<string[] | null> {
    if (afterEventId === null) return null;
    const repo = await canonicalPath(top);
    const out = new Set<string>();
    for (const written of await this.#store.events.editedFilePathsBetween(session.id, EDIT_TOOLS, afterEventId, beforeEventId)) {
      const absolute = editedAbsolute(session, written);
      if (absolute === null) continue;
      const relative = insideRelative(repo, await canonicalPath(absolute));
      if (relative !== null) out.add(relative);
    }
    return [...out].sort();
  }

  /** How many files and lines differ between two trees (`own`: only those paths); `null` when git cannot say (a tree is gone). */
  async #count(top: string, from: string, to: string, own: readonly string[] | null): Promise<Counts | null> {
    const key = `${from}\u0000${to}\u0000${own === null ? '*' : own.join('\u0000')}`;
    const known = this.#counts.get(key);
    if (known) return known;
    const result = await this.#git.try(top, ['diff-tree', '-r', '-z', '--no-renames', '--numstat', from, to, ...pathspec(own)]);
    if (!result.ok) return null;
    let files = 0;
    let added = 0;
    let removed = 0;
    for (const record of result.raw.split('\0')) {
      const [plus, minus, ...name] = record.split('\t');
      if (plus === undefined || minus === undefined || name.length === 0) continue;
      files += 1;
      // A binary file has `-` for both.
      added += Number(plus) || 0;
      removed += Number(minus) || 0;
    }
    const counts: Counts = { files, added, removed };
    this.#counts.set(key, counts);
    if (this.#counts.size > COUNTS_KEPT) {
      const oldest = this.#counts.keys().next();
      if (!oldest.done) this.#counts.delete(oldest.value);
    }
    return counts;
  }

  /** `GET …/turn-changes`: the turns that changed files. */
  async list(sessionId: string): Promise<TurnChanges> {
    const session = await this.#store.sessions.get(sessionId);
    if (!session) throw new TurnChangesError('not-found', `No such agent: ${sessionId}`);
    const byRepo = await this.#rows(sessionId);
    const latestTurn = await this.#store.events.countUserMessages(sessionId);

    // Per working tree: each save point against where its turn ended, else the next save point, else (the newest) the files now; only the files this agent edited in those turns (D180).
    const perRepo = await mapLimit([...byRepo], REPO_CONCURRENCY, async ([top, rows]): Promise<TurnChange[]> => {
      const found: TurnChange[] = [];
      try {
        for (const [index, row] of rows.entries()) {
          const next = rows[index + 1];
          const own = await this.#own(session, top, row.eventId, next?.eventId ?? null);
          if (own !== null && own.length === 0) continue;
          const toTree = (await this.#ended(sessionId, row, next)) ?? (next ? next.tree : ((await this.#now(top))?.tree ?? null));
          if (toTree === null || toTree === row.tree) continue;
          const counts = await this.#count(top, row.tree, toTree, own);
          if (!counts || counts.files === 0) continue;
          found.push({ turn: row.turnSeq, eventId: row.eventId, through: next ? next.turnSeq - 1 : Math.max(latestTurn, row.turnSeq), ...counts });
        }
      } catch {
        // A working tree that cannot be read has no counts (its turns show no chip); the other trees still do.
      }
      return found;
    });
    const merged = new Map<number, TurnChange>();
    for (const change of perRepo.flat()) {
      const had = merged.get(change.turn);
      merged.set(
        change.turn,
        had ? { turn: change.turn, eventId: had.eventId ?? change.eventId, through: Math.max(had.through, change.through), files: had.files + change.files, added: had.added + change.added, removed: had.removed + change.removed } : change,
      );
    }

    return { turns: [...merged.values()].sort((a, b) => a.turn - b.turn), latestTurn };
  }

  /**
   * `GET …/turn-changes/diff`: every working tree from before turn `from` until turn
   * `to` ended (its end snapshot, else the next save point after it), or until now
   * (`to` = `null`, and when neither exists). A working tree without a save point at
   * `from` starts at its first later one.
   */
  async diff(sessionId: string, from: number, to: number | null): Promise<FileDiff[]> {
    const session = await this.#store.sessions.get(sessionId);
    if (!session) throw new TurnChangesError('not-found', `No such agent: ${sessionId}`);
    if (to !== null && to < from) throw new TurnChangesError('invalid', 'to must not be before from');
    const byRepo = await this.#rows(sessionId);
    if (![...byRepo.values()].some((rows) => rows.some((row) => row.turnSeq === from))) {
      throw new TurnChangesError('no-checkpoint', `Turn ${from} has no save point (it was taken while save points were off, or it was pruned).`);
    }
    const labels = treeLabels([...byRepo.keys()]);
    const problems: string[] = [];
    const perRepo = await mapLimit([...byRepo], REPO_CONCURRENCY, async ([top, rows]): Promise<FileDiff[]> => {
      try {
        return await this.#diffTree(session, top, rows, from, to, labels.get(top) ?? path.basename(top));
      } catch (error) {
        // One working tree that cannot be read does not take the others' diff away.
        problems.push(error instanceof Error ? error.message : String(error));
        return [];
      }
    });
    const files = perRepo.flat();
    if (files.length === 0 && problems.length > 0) throw new TurnChangesError('unreadable', problems[0] ?? 'git could not read the working tree');
    return files;
  }

  /** {@link diff} for one working tree. */
  async #diffTree(session: Pick<SessionRecord, 'id' | 'cwd'>, top: string, rows: readonly CheckpointRecord[], from: number, to: number | null, solution: string): Promise<FileDiff[]> {
    const sessionId = session.id;
    const fromRow = rows.find((row) => row.turnSeq >= from);
    if (!fromRow) return [];
    let toTree: string | null = null;
    let branch: string | null = fromRow.branch;
    /** D180: the next turn's message after the range (the edits counted end there), `null` = until now. */
    let beforeEventId: number | null = null;
    if (to !== null) {
      if (fromRow.turnSeq > to) return [];
      // The save point whose turns include `to` (the last one at or before it), and the first one after.
      let last = fromRow;
      for (const row of rows) if (row.turnSeq <= to && row.turnSeq > last.turnSeq) last = row;
      const after = rows.find((row) => row.turnSeq > to);
      toTree = (await this.#ended(sessionId, last, after)) ?? after?.tree ?? null;
      branch = (after ?? last).branch;
      beforeEventId = after?.eventId ?? null;
    }
    const own = await this.#own(session, top, fromRow.eventId, beforeEventId);
    if (own !== null && own.length === 0) return [];
    // Until now: the files as they are (also what was changed by hand).
    const live = toTree === null;
    // A working tree that is gone (a removed copy) or cannot be compared is a problem of this tree: `diff` leaves it out when another tree has changes, and says so when none has.
    const gone = `${path.basename(top)} is no longer on this computer.`;
    if (toTree === null) {
      const now = await this.#now(top);
      if (!now) throw new TurnChangesError('unreadable', gone);
      toTree = now.tree;
      branch = now.branch;
    }
    if (toTree === fromRow.tree) return [];
    const patch = await this.#git.try(top, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', fromRow.tree, toTree, ...pathspec(own)]);
    if (!patch.ok) throw new TurnChangesError('unreadable', (await this.#gone(top)) ? gone : `git could not compare ${path.basename(top)}: ${patch.error}`);
    return parsePatch(patch.raw).map((file) => toFileDiff(solution, branch, file, live));
  }
}
