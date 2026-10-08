import type { Review, ReviewActionId, ReviewRepo } from '../../core/reviews.ts';

/**
 * D79 (`docs/reviews.md` → *The card*): the review card's pure state and copy, shared by
 * the Inbox and the session header's badge.
 */

/** Actions that open a form on the card first (the rest run on click). */
export type ReviewForm = 'commit' | 'send-back' | 'discard' | 'cleanup';

/** `true` when the action needs its form (a message, a comment, a confirmation). */
export function needsForm(action: ReviewActionId): action is ReviewForm {
  return action === 'commit' || action === 'send-back' || action === 'discard' || action === 'cleanup';
}

/** Discard and Clean up stay on the desktop (D79 device policy): a paired device does not offer them. */
export const DESKTOP_ONLY_ACTIONS: readonly ReviewActionId[] = ['discard', 'cleanup'];

/** The actions the card shows here: all of them on this computer, without the desktop-only ones on a device. */
export function shownActions(actions: readonly ReviewActionId[], onDevice: boolean): ReviewActionId[] {
  return onDevice ? actions.filter((action) => !DESKTOP_ONLY_ACTIONS.includes(action)) : [...actions];
}

/** `⎇ <branch> → <base>` (the base when known; `detached HEAD` without a branch). */
export function repoLine(repo: Pick<ReviewRepo, 'branch' | 'base'>): string {
  const branch = repo.branch === null ? 'detached HEAD' : `⎇ ${repo.branch}`;
  return repo.base ? `${branch} → ${repo.base}` : branch;
}

/** The stats line: `3 files · +40 −2 · 1 uncommitted · 2 commits`. */
export function statsLine(review: Pick<Review, 'fileCount' | 'added' | 'removed' | 'uncommitted' | 'commitCount'>): string {
  const parts = [`${review.fileCount} file${review.fileCount === 1 ? '' : 's'}`, `+${review.added} −${review.removed}`];
  if (review.uncommitted > 0) parts.push(`${review.uncommitted} uncommitted`);
  if (review.commitCount > 0) parts.push(`${review.commitCount} commit${review.commitCount === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** The warning of a Discard (what it removes, per mode). */
export function discardWarning(review: Pick<Review, 'mode' | 'repos'>): string {
  if (review.mode === 'branch') {
    const names = review.repos.map((repo) => `${repo.branch ?? 'the branch'}${repo.base ? ` (reset to ${repo.base})` : ''}`).join(', ');
    return `Discard drops this branch's changes for good: the worktree is reset to its base, so its commits and its uncommitted changes (new files too) are gone: ${names}. Clean up then removes the worktree and deletes the branch.`;
  }
  const count = review.repos.reduce((sum, repo) => sum + repo.files.filter((file) => file.uncommitted).length, 0);
  return `Discard reverts the ${count} uncommitted file${count === 1 ? '' : 's'} listed above for good (new files are deleted). Commits stay.`;
}

/** The text of the Clean up confirmation. */
export function cleanupWarning(review: Pick<Review, 'repos'>): string {
  const names = review.repos.filter((repo) => repo.worktreeId !== null).map((repo) => `${repo.dir} and the branch ${repo.branch ?? ''}`.trim());
  return `Clean up removes ${names.join('; ') || 'the worktree and its local branch'}. The branch's work is already in its base.`;
}

/** The note under the Commit message field. */
export function commitHint(review: Pick<Review, 'repos'>): string {
  const repos = review.repos.filter((repo) => repo.uncommitted > 0).map((repo) => repo.repo);
  return `Commits every current change in ${repos.join(', ') || 'the repo'} (git add -A); the repo's hooks run. Nothing is pushed.`;
}

/** The note under the Send back comment. */
export const SEND_BACK_HINT = 'Your comment goes to the session as a message; the card closes as sent back.';

/** The refusal line of an action (`Not done: <message>`). */
export function reviewRefusal(status: number, body: unknown): string {
  const message = typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string' ? (body as { message: string }).message : null;
  if (status === 403) return 'Not done: this device may not do that; use Switchboard on the computer.';
  if (message) return `Not done: ${message}`;
  return status === 0 ? 'Not done: Switchboard is not reachable.' : `Not done: HTTP ${status}`;
}

/** The conflicts of a refused Merge from a refusal body (`conflicts`), else none. */
export function refusalConflicts(body: unknown): string[] {
  const value = typeof body === 'object' && body !== null ? (body as { conflicts?: unknown }).conflicts : undefined;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** A session's open review in a list (pending first, then clean-up), else `null`. */
export function openReviewOf(reviews: readonly Review[], sessionId: string): Review | null {
  const own = reviews.filter((review) => review.sessionId === sessionId && review.state !== 'resolved');
  return own.find((review) => review.state === 'pending') ?? own[0] ?? null;
}
