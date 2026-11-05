/**
 * D156 (`docs/peers.md` → *Cleaning up the source after a move (D156)*): what a
 * successful move leaves on the computer the agent came from, what Switchboard may
 * remove there by itself (the developer's "Clean up on <source> after a successful
 * move", or **Clean up on this computer…** on an already moved agent) and the list
 * of what is left for the developer to remove by hand. Pure; shared with the UI.
 *
 * Safety (the rules {@link decideWorktreeCleanup} and {@link decideBranchCleanup} encode):
 * - never a main checkout, a repo, a workspace file or anything that did not travel;
 * - a carried worktree is removed only when it is as the move captured it (same HEAD,
 *   no new uncommitted change); `--force` only when its uncommitted changes are exactly
 *   what the move carried (the same tree as the WIP commit); never `git worktree prune`;
 * - a move from an older Switchboard (nothing recorded of what travelled): only a clean
 *   worktree whose commits are all on a remote, never `--force`;
 * - its local branch is deleted with `git branch -d` only when the remote has it at the
 *   same commit (never `-D`, never a protected branch).
 */

/** What one line of a clean-up is about. */
export type SourceCleanupKind = 'session' | 'worktree' | 'branch' | 'conversation' | 'main-checkout' | 'repo' | 'workspace-file' | 'folder';

/** One thing removed, or left for the developer (with the reason it is left). */
export interface SourceCleanupItem {
  readonly kind: SourceCleanupKind;
  /** The path (a branch: `<repo path> <branch>`), copyable as is. */
  readonly path: string;
  /** What was done, or why it is left. */
  readonly text: string;
}

/**
 * The clean-up of one moved agent on its source computer: a preview (`ran: false`:
 * what it would remove) or what a run removed, and the manual list.
 */
export interface SourceCleanupReport {
  /** The source session (as the source computer names it). */
  readonly sessionId: string;
  readonly title: string;
  /** The source computer (where this list applies). */
  readonly machine: string;
  /** Where the agent moved to. */
  readonly movedTo: string;
  readonly at: string;
  /** `false`: a preview (`removed` = what it would remove); `true`: what the run removed. */
  readonly ran: boolean;
  /** An older move: what travelled was not recorded, so it is read from the agent's record (conservative). */
  readonly derived: boolean;
  readonly removed: readonly SourceCleanupItem[];
  /** What the developer may still remove by hand (Switchboard deletes nothing of this). */
  readonly manual: readonly SourceCleanupItem[];
  /** The clean-up could not run (an older source, the source unreachable…); `null` when it ran. */
  readonly error: string | null;
}

/**
 * Recorded on the source session at the end of a move (`sessions.moved_to` JSON,
 * `carried`): what travelled, so a later clean-up knows what it may remove.
 * Absent on sessions moved by an older Switchboard.
 */
export interface MoveCarried {
  readonly version: 1;
  readonly repos: ReadonlyArray<CarriedRepo>;
  /** Repos and worktrees the agent works in that did not travel (skipped, left out), with why. */
  readonly notCarried: ReadonlyArray<{ readonly name: string; readonly kind: 'main' | 'worktree'; readonly path: string; readonly reason: string }>;
  /** The conversation files the move copied (absolute paths on the source). */
  readonly conversation: readonly string[];
  /** The workspace root and the workspace files the move sent (names relative to it). */
  readonly workspaceRoot: string | null;
  readonly workspaceFiles: readonly string[];
}

/** One repo the move carried, as it was captured. */
export interface CarriedRepo {
  readonly name: string;
  readonly kind: 'main' | 'worktree';
  readonly path: string;
  readonly mainPath: string;
  readonly branch: string;
  readonly remoteName: string;
  /** HEAD when it was captured. */
  readonly headSha: string;
  /** The WIP commit's tree (its uncommitted changes as carried); `null` = it had none. */
  readonly wipTree: string | null;
  readonly uncommitted: number;
}

/** The last clean-up, kept on the session (`moved_to` JSON, `cleanup`). */
export interface SourceCleanupRecord {
  readonly at: string;
  readonly removed: number;
  readonly manual: number;
}

/** The facts of one worktree at clean-up time. */
export interface WorktreeCleanupFacts {
  readonly exists: boolean;
  /** A linked worktree (not the repo's main checkout). */
  readonly linked: boolean;
  readonly head: string | null;
  readonly uncommitted: number;
  /** The tree of its current state (HEAD + every uncommitted change, untracked included, ignored not). */
  readonly currentTree: string | null;
  /** Ignored entries that do not look regenerable (a `.env`, local settings): they never travel. */
  readonly keptIgnored: readonly string[];
  /** Other open or archived sessions that work in it. */
  readonly usedBy: readonly string[];
  /** Commits of HEAD that are on no remote (`null`: unknown). */
  readonly localOnly: number | null;
  /** As the move captured it; `null` = an older move (nothing recorded). */
  readonly carried: Pick<CarriedRepo, 'headSha' | 'wipTree'> | null;
}

/** Remove (and whether `--force` is needed: only for exactly the carried changes), or keep with why. */
export type WorktreeCleanupDecision = { readonly remove: true; readonly force: boolean } | { readonly remove: false; readonly why: string };

/** Folders git ignores that are rebuilt by tools (their loss is no loss). */
const REGENERABLE = new Set(['node_modules', 'bin', 'obj', 'dist', 'build', 'out', 'target', 'coverage', '.next', '.nuxt', '.turbo', '.cache', '__pycache__', '.pytest_cache', '.gradle', '.vs', '.idea', '.DS_Store', 'Thumbs.db']);

/** `true` for an ignored entry (`git status --ignored`'s path) that tools rebuild. */
export function regenerableIgnored(entry: string): boolean {
  return entry
    .split(/[\\/]+/)
    .filter((segment) => segment !== '')
    .some((segment) => REGENERABLE.has(segment));
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Whether a carried (or, for an older move, a found) worktree may be removed. */
export function decideWorktreeCleanup(facts: WorktreeCleanupFacts): WorktreeCleanupDecision {
  if (!facts.exists) return { remove: false, why: 'its folder is gone' };
  if (!facts.linked) return { remove: false, why: 'it is a main checkout: Switchboard never removes one' };
  if (facts.usedBy.length > 0) return { remove: false, why: `also used by ${facts.usedBy.join(', ')}` };
  if (facts.keptIgnored.length > 0) return { remove: false, why: `it has ignored files that did not travel (${facts.keptIgnored.slice(0, 3).join(', ')}${facts.keptIgnored.length > 3 ? ', …' : ''})` };
  if (facts.head === null) return { remove: false, why: 'its HEAD cannot be read' };
  if (facts.carried) {
    if (facts.head !== facts.carried.headSha) return { remove: false, why: 'it changed since the move (new commits)' };
    if (facts.uncommitted === 0) return { remove: true, force: false };
    if (facts.currentTree !== null && facts.carried.wipTree !== null && facts.currentTree === facts.carried.wipTree) return { remove: true, force: true };
    return { remove: false, why: `it changed since the move (${plural(facts.uncommitted, 'uncommitted file')} that did not travel)` };
  }
  // An older move: what travelled is unknown, so only a clean worktree whose commits are all on a remote.
  if (facts.uncommitted > 0) return { remove: false, why: `${plural(facts.uncommitted, 'uncommitted file')} (an older move: what travelled is not known)` };
  if (facts.localOnly === null) return { remove: false, why: 'its commits cannot be checked against the remote' };
  if (facts.localOnly > 0) return { remove: false, why: `it has local commits (${plural(facts.localOnly, 'commit')} only on this computer)` };
  return { remove: true, force: false };
}

/** Whether a removed worktree's local branch may be deleted (`git branch -d`, never `-D`). */
export function decideBranchCleanup(input: { readonly branch: string | null; readonly protectedReason: string | null; readonly localTip: string | null; readonly remoteTip: string | null; readonly remote: string }): { readonly delete: true } | { readonly delete: false; readonly why: string } {
  if (input.branch === null) return { delete: false, why: 'no branch' };
  if (input.protectedReason !== null) return { delete: false, why: `kept: ${input.protectedReason}` };
  if (input.localTip === null) return { delete: false, why: 'its tip cannot be read' };
  if (input.remoteTip === null) return { delete: false, why: `not on ${input.remote}: its commits are only on this computer` };
  if (input.remoteTip !== input.localTip) return { delete: false, why: `${input.remote} has it at another commit: it has commits only on this computer` };
  return { delete: true };
}

/** The request's `cleanupSource` (`true` only when exactly `true`). */
export function cleanupSourceOf(value: unknown): boolean {
  return value === true;
}

/** The checkbox's words. */
export function cleanupCheckboxLabel(source: string): string {
  return `Clean up on ${source} after a successful move`;
}

/** The checkbox's hint. */
export const CLEANUP_CHECKBOX_HINT = 'Archives the old agent, removes its worktrees that moved (only when nothing changed since) and its copy of the conversation. Never a main checkout, a repo or workspace files. Everything left is listed.';

/** The browser-storage key that remembers the checkbox on this computer. */
export const CLEANUP_SOURCE_PREF = 'sb.move.cleanupSource';

/** One line per manual item: the path, then why it is left (plain text, copyable). */
export function manualListText(items: readonly SourceCleanupItem[]): string {
  return items.map((item) => `${item.path}\t# ${item.text}`).join('\n');
}

/** One line on a clean-up: "Removed 3 things on Mac; 2 left for you to remove by hand." */
export function cleanupSummary(report: Pick<SourceCleanupReport, 'ran' | 'removed' | 'manual' | 'machine' | 'error'>): string {
  if (report.error) return `The clean-up on ${report.machine} did not run: ${report.error.replace(/[.\s]+$/, '')}.`;
  const removed = report.removed.length;
  const left = report.manual.length;
  const head = report.ran ? (removed === 0 ? `Nothing was removed on ${report.machine}` : `Removed ${plural(removed, 'thing')} on ${report.machine}`) : removed === 0 ? `Nothing to remove automatically on ${report.machine}` : `Would remove ${plural(removed, 'thing')} on ${report.machine}`;
  return `${head}; ${left === 0 ? 'nothing left to remove by hand' : `${left} left for you to remove by hand`}.`;
}

/** The labels of the item kinds (the dialog's groups). */
export const SOURCE_CLEANUP_KIND_LABELS: Readonly<Record<SourceCleanupKind, string>> = {
  session: 'Agent',
  worktree: 'Worktree',
  branch: 'Branch',
  conversation: 'Conversation file',
  'main-checkout': 'Main checkout',
  repo: 'Repo',
  'workspace-file': 'Workspace file',
  folder: 'Folder',
};

/** A {@link SourceCleanupReport} from untrusted JSON (a peer, the session's record); `null` when it is not one. */
export function readCleanupReport(value: unknown): SourceCleanupReport | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const items = (list: unknown): SourceCleanupItem[] =>
    (Array.isArray(list) ? list : [])
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .filter((entry) => typeof entry['path'] === 'string' && typeof entry['text'] === 'string' && typeof entry['kind'] === 'string')
      .map((entry) => ({ kind: entry['kind'] as SourceCleanupKind, path: entry['path'] as string, text: entry['text'] as string }));
  const text = (field: string, fallback = ''): string => (typeof record[field] === 'string' ? (record[field] as string) : fallback);
  return {
    sessionId: text('sessionId'),
    title: text('title'),
    machine: text('machine', 'the other computer'),
    movedTo: text('movedTo'),
    at: text('at'),
    ran: record['ran'] === true,
    derived: record['derived'] === true,
    removed: items(record['removed']),
    manual: items(record['manual']),
    error: typeof record['error'] === 'string' ? record['error'] : null,
  };
}
