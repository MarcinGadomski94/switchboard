import { sameTargetPath } from './workspace-move.ts';

/**
 * D157 (`docs/peers.md` → *A target branch with commits the source does not have
 * (D157)*): the target's branch has commits the commit being restored does not
 * contain ("diverged"). Instead of refusing at apply, the plan lists them and the
 * developer may confirm **Overwrite them on <PC> (keep a backup branch)**: the
 * target then keeps its old tip on a new `switchboard/backup/…` branch and moves
 * the branch to the restored commit. Pure; shared with the UI.
 */

/** One commit the target's branch has that the source's does not. */
export interface DivergedCommit {
  /** Short commit id. */
  readonly sha: string;
  /** Its subject line (control characters removed, at most 120 characters). */
  readonly subject: string;
}

/** What the target's branch has that the source's does not (read on the target by the plan). */
export interface TargetDiverged {
  readonly branch: string;
  /** How many commits (all of them, not only the listed ones). */
  readonly count: number;
  /** The newest ones first, at most {@link DIVERGED_LISTED}. */
  readonly commits: readonly DivergedCommit[];
  readonly truncated: boolean;
}

/** At most this many diverged commits are listed. */
export const DIVERGED_LISTED = 20;

/** A branch the move overwrote on the target, with the backup branch that keeps its old tip (never deleted by Switchboard). */
export interface MoveOverwrite {
  /** The checkout (the target's path). */
  readonly path: string;
  /** The target machine's name. */
  readonly machine: string;
  readonly branch: string;
  /** The backup branch (`switchboard/backup/<branch>-<YYYYMMDD-HHMM>`) at {@link oldTip}. */
  readonly backup: string;
  readonly oldTip: string;
  /** The restored commit the branch was moved to. */
  readonly newTip: string;
  /** How many commits were replaced (the old tip's commits not in the restored one). */
  readonly count: number;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** A commit subject as shown: one line, no control characters, at most 120 characters. */
export function cleanSubject(subject: string): string {
  // eslint-disable-next-line no-control-regex
  return subject.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120);
}

/** "3 commits: a1b2c3d Fix login, …" (at most `shown`). */
export function divergedLine(diverged: TargetDiverged, shown = 5): string {
  const listed = diverged.commits.slice(0, shown).map((commit) => `${commit.sha} ${commit.subject}`.trim());
  const more = diverged.count - listed.length;
  const count = plural(diverged.count, 'commit');
  if (listed.length === 0) return count;
  return `${count}: ${listed.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/** The checkbox's label. */
export function overwriteLabel(machine: string): string {
  return `Overwrite them on ${machine} (keep a backup branch)`;
}

/** The headline of the choice: "<PC>'s <branch> in <path> has N commits that aren't on <source>". */
export function divergedHeadline(machine: string, path: string, source: string, diverged: TargetDiverged): string {
  return `${machine}'s ${diverged.branch} in ${path} has ${plural(diverged.count, 'commit')} that ${diverged.count === 1 ? "isn't" : "aren't"} on ${source}`;
}

/** The blocker without the confirmation: the commits and the ways out. */
export function divergedBlocker(machine: string, path: string, source: string, diverged: TargetDiverged): string {
  return `${divergedHeadline(machine, path, source, diverged)} (${divergedLine(diverged)}): tick "${overwriteLabel(machine)}", or use another folder there, or clone it fresh`;
}

/** The plan's line once the overwrite is confirmed. */
export function overwriteSummary(machine: string, path: string, diverged: TargetDiverged): string {
  return `Use ${path}; keep ${diverged.branch}'s ${plural(diverged.count, 'commit')} there on a backup branch on ${machine}, then move ${diverged.branch} to the restored commit`;
}

/** The backup branch's name: `switchboard/backup/<branch>-<YYYYMMDD-HHMM>` (local time), `-2`, `-3`… when taken. */
export function backupBranchName(branch: string, at: Date, attempt = 1): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}`;
  return `switchboard/backup/${branch}-${stamp}${attempt > 1 ? `-${attempt}` : ''}`;
}

/** What the result, the audit line and the Moves record say (the developer's wording). */
export function overwriteNote(overwrite: MoveOverwrite): string {
  return `${plural(overwrite.count, 'commit')} on ${overwrite.branch} ${overwrite.count === 1 ? 'was' : 'were'} replaced on ${overwrite.machine} (${overwrite.path}); they are kept on ${overwrite.backup} (git log ${overwrite.backup})`;
}

/** At most this many checkouts may be confirmed for overwriting in one request. */
export const OVERWRITE_TARGETS_MAX = 200;

/** `overwriteTargets` from a request body: target checkout paths; `undefined` when absent, `null` when malformed. */
export function overwriteTargetsOf(value: unknown): string[] | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > OVERWRITE_TARGETS_MAX || value.some((entry) => typeof entry !== 'string' || entry === '' || entry.length > 4096)) return null;
  return [...new Set(value as string[])];
}

/** `true` when the developer confirmed overwriting the diverged branch(es) in `checkout` (paths compared the target's way). */
export function overwriteConfirmed(overwriteTargets: readonly string[] | undefined, checkout: string): boolean {
  return (overwriteTargets ?? []).some((entry) => sameTargetPath(entry, checkout));
}
