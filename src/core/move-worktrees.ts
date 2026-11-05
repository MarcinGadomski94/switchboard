import { folderNameProblem, joinTargetPath, relativeInside, sameTargetPath, targetBaseName, targetParent } from './workspace-move.ts';

/**
 * D153 (`docs/peers.md` → *A complete move (D152)* → *The agent's own worktrees*
 * and *A target checkout with uncommitted changes*): the pure part of two rulings
 * on a complete move (developer, 2026-11-05):
 *
 * 1. **Stash after confirming.** A target checkout with uncommitted changes is no
 *    hard blocker: the dialog lists its changed files and offers "Stash them on
 *    <PC>"; only after that confirmation the target runs `git stash push
 *    --include-untracked -m "<message>"` there, and the stash is never dropped or
 *    popped by Switchboard (the result says how to restore it).
 * 2. **The agent's own worktrees** (Claude Code's `.claude/worktrees/*` and other
 *    git worktrees of a repo it uses) are grouped under their repo, and one is
 *    carried only when its branch has a remote-tracking branch and is not merged;
 *    the others are listed as skipped with the reason (a warning when they hold
 *    uncommitted changes, which stay on the source).
 *
 * No file system, no git: shared by the server and the UI.
 */

// ── the agent's own worktrees ─────────────────────────────────────────────

/** Why one of the agent's own worktrees is not carried. */
export type WorktreeSkipReason = 'no-remote-branch' | 'merged';

/** What the source read about one of the agent's own worktrees (`TakeoverGit.worktreeCarryFacts`). */
export interface WorktreeCarryFacts {
  /** The branch checked out there; `null` for a detached HEAD. */
  readonly branch: string | null;
  /** Its upstream (`origin/feature/x`) when one is configured **and** the remote-tracking branch exists; `null` otherwise. */
  readonly upstream: string | null;
  /** What it is merged into (`origin/main`, "its pull request"); `null` when not merged (or not known). */
  readonly mergedInto: string | null;
}

/** Whether to carry one of the agent's own worktrees, and why not. */
export type WorktreeCarryDecision = { readonly carry: true } | { readonly carry: false; readonly reason: WorktreeSkipReason; readonly text: string };

/**
 * The ruling (D153): carried only when its branch has a remote-tracking branch AND
 * is not merged. No remote branch first (a branch that was never pushed, or whose
 * remote branch is gone, e.g. deleted after its merge), then merged. Pure.
 */
export function worktreeCarry(facts: WorktreeCarryFacts): WorktreeCarryDecision {
  if (facts.branch === null) return { carry: false, reason: 'no-remote-branch', text: 'no remote branch (a detached HEAD)' };
  if (facts.upstream === null) return { carry: false, reason: 'no-remote-branch', text: 'no remote branch' };
  if (facts.mergedInto !== null) return { carry: false, reason: 'merged', text: `merged into ${facts.mergedInto}` };
  return { carry: true };
}

/** One of the agent's own worktrees the move does not carry (`SourceInspect.skippedWorktrees`). */
export interface SkippedWorktree {
  /** The repo's name (its main checkout's folder). */
  readonly name: string;
  /** The worktree on the source. */
  readonly path: string;
  /** The repo's main checkout on the source (what it is grouped under). */
  readonly mainPath: string;
  readonly branch: string | null;
  readonly reason: WorktreeSkipReason;
  /** "no remote branch", "merged into origin/main". */
  readonly text: string;
  /** Its uncommitted files (untracked included). */
  readonly uncommitted: number;
  /** "Its 3 uncommitted files stay on pc-office." when it has any, else `null`. */
  readonly warning: string | null;
}

/** The warning of a skipped worktree with uncommitted changes (they are not carried: they stay on the source). */
export function skippedWarning(uncommitted: number, sourceMachine: string): string | null {
  if (uncommitted <= 0) return null;
  return `Its ${uncommitted} uncommitted file${uncommitted === 1 ? '' : 's'} stay${uncommitted === 1 ? 's' : ''} on ${sourceMachine}.`;
}

/**
 * Where an agent's own worktree sits relative to its main checkout, `/`-separated,
 * so the target can put it at the same place next to its checkout there: inside it
 * (`.claude/worktrees/attest-release`) or beside it (`../app-wt-fix`). `null` when
 * it is elsewhere (the target then uses its usual `../<repo>-wt-<session>`).
 */
export function worktreeLayout(mainPath: string, worktreePath: string): string | null {
  const inside = relativeInside(mainPath, worktreePath);
  if (inside !== null) return inside.length > 0 ? inside.join('/') : null;
  const parent = targetParent(mainPath);
  if (parent !== mainPath && sameTargetPath(targetParent(worktreePath), parent)) {
    const name = targetBaseName(worktreePath);
    return name !== '' ? `../${name}` : null;
  }
  return null;
}

/** Most segments a worktree layout may have. */
const LAYOUT_MAX_SEGMENTS = 8;

/**
 * `true` for a layout the target may use as is: `/`-separated folder names that
 * are valid on Windows too, no `.` / `..` (except one leading `..` followed by
 * exactly one name), no `.git`, at most 8 segments. Anything else falls back to
 * the usual worktree path. Pure.
 */
export function isSafeWorktreeLayout(layout: unknown): layout is string {
  if (typeof layout !== 'string' || layout === '' || layout.length > 512) return false;
  const parts = layout.split('/');
  if (parts.length > LAYOUT_MAX_SEGMENTS) return false;
  const names = parts[0] === '..' ? parts.slice(1) : parts;
  if (parts[0] === '..' && names.length !== 1) return false;
  return names.every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git' && folderNameProblem(part) === null);
}

/** The worktree's path on the target: the layout under (or beside) the target's checkout. */
export function worktreeAtTarget(targetMain: string, layout: string): string {
  const parts = layout.split('/');
  if (parts[0] === '..') return joinTargetPath(targetParent(targetMain), ...parts.slice(1));
  return joinTargetPath(targetMain, ...parts);
}

/** What a repo row needs to be grouped under its main checkout. */
export interface GroupableRepo {
  readonly name: string;
  readonly path: string;
  /** Absent = the main checkout. */
  readonly kind?: 'main' | 'worktree';
  /** The repo's main checkout (equal to `path` for the main checkout itself); absent = `path`. */
  readonly mainPath?: string;
}

/** One repo with its worktrees nested (the move plan's and Works in's grouping). */
export interface RepoGroup<T extends GroupableRepo> {
  /** The main checkout (the group's key). */
  readonly mainPath: string;
  /** The repo's name: its main checkout's row's, else that folder's name. */
  readonly name: string;
  /** The main checkout's own row, when it is listed. */
  readonly main: T | null;
  /** Its worktrees that are listed (carried), in their order. */
  readonly worktrees: readonly T[];
  /** Its worktrees that are skipped, with the reason. */
  readonly skipped: readonly SkippedWorktree[];
}

/**
 * Groups rows by their main checkout: one entry per repo with its worktrees
 * nested (and the skipped ones under it), in the order the repos first appear.
 * Paths are compared the target's way (Windows without case). Pure.
 */
export function groupByRepo<T extends GroupableRepo>(rows: readonly T[], skipped: readonly SkippedWorktree[] = []): RepoGroup<T>[] {
  const groups: Array<{ mainPath: string; name: string | null; main: T | null; worktrees: T[]; skipped: SkippedWorktree[] }> = [];
  const groupOf = (mainPath: string): (typeof groups)[number] => {
    let group = groups.find((entry) => sameTargetPath(entry.mainPath, mainPath));
    if (!group) {
      group = { mainPath, name: null, main: null, worktrees: [], skipped: [] };
      groups.push(group);
    }
    return group;
  };
  for (const row of rows) {
    const mainPath = row.mainPath ?? row.path;
    const group = groupOf(mainPath);
    if (row.kind !== 'worktree' && sameTargetPath(row.path, mainPath) && group.main === null) {
      group.main = row;
      group.name = row.name;
    } else group.worktrees.push(row);
  }
  for (const entry of skipped) groupOf(entry.mainPath).skipped.push(entry);
  return groups.map((group) => ({ mainPath: group.mainPath, name: group.name ?? targetBaseName(group.mainPath), main: group.main, worktrees: group.worktrees, skipped: group.skipped }));
}

/** The short name of a worktree inside its group: its folder's name. */
export function worktreeLabel(row: Pick<GroupableRepo, 'path'>): string {
  return targetBaseName(row.path);
}

// ── a target checkout with uncommitted changes ────────────────────────────

/** At most this many changed file names are listed per checkout (the counts are complete). */
export const TARGET_CHANGES_LISTED = 50;

/** The uncommitted changes of a target checkout the restore needs (read on the target). */
export interface TargetChanges {
  /** Changed file names, relative to the checkout, `/`-separated (at most {@link TARGET_CHANGES_LISTED}). */
  readonly files: readonly string[];
  readonly modified: number;
  readonly untracked: number;
  readonly total: number;
  /** More files changed than are listed. */
  readonly truncated: boolean;
}

/** "3 files: a.txt, b.txt, notes/c.md" / "60 files: a, b, … and 57 more" (at most `shown` names). */
export function changesLine(changes: TargetChanges, shown = 5): string {
  const names = changes.files.slice(0, shown);
  const more = changes.total - names.length;
  const count = `${changes.total} file${changes.total === 1 ? '' : 's'}`;
  if (names.length === 0) return count;
  return `${count}: ${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/**
 * The blocker of a target checkout with uncommitted changes the restore would
 * check a branch out in, when the developer did not confirm stashing them. It keeps
 * the old words ("has uncommitted changes on the target") and adds the files and
 * the way out.
 */
export function dirtyTargetBlocker(checkout: string, machine: string, changes: TargetChanges | null): string {
  const what = changes ? ` (${changesLine(changes)})` : '';
  return `${checkout} has uncommitted changes on the target${what}: commit or stash them first, or choose "Stash them on ${machine}"`;
}

/** The plan's line for a checkout whose changes will be stashed first. */
export function stashSummary(checkout: string, machine: string, changes: TargetChanges | null, branch: string): string {
  const count = changes ? `${changes.total} uncommitted file${changes.total === 1 ? '' : 's'}` : 'its uncommitted files';
  return `Use ${checkout}; stash ${count} there on ${machine} first (kept: you restore them), then check out ${branch}`;
}

/** A local date and time for the stash message: `2026-11-05 14:03`. */
export function stashStamp(at: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

/** The stash's message (the developer's ruling): `switchboard: before moving <agent> from <source> (<date>)`. */
export function stashMessage(agent: string, source: string, at: Date): string {
  const clean = (value: string): string => value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120);
  return `switchboard: before moving ${clean(agent)} from ${clean(source)} (${stashStamp(at)})`;
}

/** A stash the move made on the target (it stays there: never dropped or popped by Switchboard). */
export interface MoveStash {
  /** The checkout it was made in (the target's path). */
  readonly path: string;
  /** The target machine's name. */
  readonly machine: string;
  /** The stash's message (how `git stash list` shows it, after "On <branch>: "). */
  readonly message: string;
  /** How many files it holds (untracked included). */
  readonly files: number;
  /** The stash commit (`refs/stash` right after), `null` when it could not be read. */
  readonly commit: string | null;
}

/** How the result and the undo say a stash exists and how to get it back. */
export function stashNote(stash: MoveStash): string {
  return `Stashed ${stash.files} uncommitted file${stash.files === 1 ? '' : 's'} in ${stash.path} on ${stash.machine} as "${stash.message}". It is kept there: run git stash list in that folder to find it, then git stash apply stash@{N} (or git stash pop) to restore it.`;
}

/** The audit line of a stash (the run log and the target's service log; counts and the message only, never a file name). */
export function stashAudit(stash: MoveStash): string {
  return `stashed ${stash.files} uncommitted file${stash.files === 1 ? '' : 's'} in ${stash.path} on ${stash.machine} before the move: "${stash.message}" (kept; restore with git stash list / git stash apply)`;
}

/** At most this many checkouts may be confirmed for stashing in one request. */
export const STASH_TARGETS_MAX = 200;

/** `stashTargets` from a request body: target checkout paths; `undefined` when absent, `null` when malformed. */
export function stashTargetsOf(value: unknown): string[] | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > STASH_TARGETS_MAX || value.some((entry) => typeof entry !== 'string' || entry === '' || entry.length > 4096)) return null;
  return [...new Set(value as string[])];
}

/** `true` when the developer confirmed stashing in `checkout` (paths compared the target's way). */
export function stashConfirmed(stashTargets: readonly string[] | undefined, checkout: string): boolean {
  return (stashTargets ?? []).some((entry) => sameTargetPath(entry, checkout));
}
