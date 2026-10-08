/**
 * D79 "Review queue" (`docs/reviews.md`): when a session with changes goes idle it
 * gets a Review card (once per change set), shown in the Inbox and as a badge on the
 * session's header. Reviews are post-hoc and advisory: they never block an agent.
 * Wire types and pure helpers shared by the server and the UI. No I/O.
 */

/** How a review was resolved (`reviewResolved`, `session_reviews.outcome`). */
export const REVIEW_OUTCOMES = ['merged', 'committed', 'discarded', 'sent-back', 'dismissed'] as const;

/** One review outcome. */
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

/**
 * The bus event `reviewResolved` (the one shared contract between the review queue, D79,
 * and the todo runs, D76): emitted once when a review is resolved. The todo lists
 * (`src/server/todos/review-link.ts`) subscribe to it: an item whose run session it is
 * leaves `review`. Keep exactly this shape.
 */
export interface ReviewResolvedEvent {
  readonly sessionId: string;
  readonly outcome: ReviewOutcome;
}

/**
 * A review's state (`session_reviews.state`): `pending` waits for the developer;
 * `cleanup` is resolved (merged or discarded) with Clean up still offered; `resolved`
 * is done.
 */
export const REVIEW_STATES = ['pending', 'cleanup', 'resolved'] as const;

/** One review state. */
export type ReviewState = (typeof REVIEW_STATES)[number];

/**
 * What the session works in: `branch` = its own worktree(s) and branch (Merge / Open
 * PR); `folder` = directly in a folder's checkout (Commit).
 */
export type ReviewMode = 'branch' | 'folder';

/** The actions of a review card (`POST /api/reviews/{id}/<action>`). */
export const REVIEW_ACTIONS = ['merge', 'open-pr', 'commit', 'send-back', 'discard', 'cleanup', 'dismiss'] as const;

/** One review action. */
export type ReviewActionId = (typeof REVIEW_ACTIONS)[number];

/** Button labels of the actions. */
export const REVIEW_ACTION_LABELS: { readonly [K in ReviewActionId]: string } = {
  merge: 'Merge',
  'open-pr': 'Open PR',
  commit: 'Commit',
  'send-back': 'Send back',
  discard: 'Discard',
  cleanup: 'Clean up',
  dismiss: 'Dismiss',
};

/** One changed file of a review. */
export interface ReviewFile {
  /** The repo (solution) name. */
  readonly repo: string;
  /** Path inside the repo. */
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  /** A binary file (no line counts). */
  readonly binary: boolean;
  /** Still holds uncommitted changes (staged, unstaged or untracked). */
  readonly uncommitted: boolean;
}

/** One commit of a review (not merged into the base; for a folder session: made since it started and not on a remote). */
export interface ReviewCommit {
  readonly sha: string;
  readonly subject: string;
}

/** How a branch session's base was found (`docs/reviews.md` → *Base*). */
export type ReviewBaseSource = 'local' | 'origin' | 'default' | null;

/** One repository of a review. */
export interface ReviewRepo {
  /** Repo (solution) name. */
  readonly repo: string;
  /** Where the changes are: the worktree, or the folder's checkout. */
  readonly dir: string;
  /** The session's worktree (`branch` mode), else `null`. */
  readonly worktreeId: string | null;
  /** The checked-out branch (`null` on a detached HEAD). */
  readonly branch: string | null;
  /** `branch` mode: the local branch it merges into; `folder` mode: the branch's upstream, if any. */
  readonly base: string | null;
  readonly baseSource: ReviewBaseSource;
  readonly files: readonly ReviewFile[];
  readonly added: number;
  readonly removed: number;
  /** Files with uncommitted changes. */
  readonly uncommitted: number;
  readonly commits: readonly ReviewCommit[];
  /** The PR opened from the card (`Open PR`), when known. */
  readonly prUrl: string | null;
}

/** What the transcript says about tests (best effort). */
export interface ReviewTests {
  /** `passed` / `failed` from the last test-like Bash command's exit code; `not-reported` when there was none. */
  readonly status: 'passed' | 'failed' | 'not-reported';
  /** That command, verbatim (cut to 200 characters). */
  readonly command: string | null;
  readonly exitCode: number | null;
}

/** A review card (`GET /api/reviews`, `InboxItem.review`). */
export interface Review {
  readonly id: string;
  readonly sessionId: string;
  /** The session's display title (title, else name). */
  readonly sessionTitle: string;
  /** The session's folder (its path), when known. */
  readonly folderPath: string | null;
  readonly mode: ReviewMode;
  readonly state: ReviewState;
  readonly outcome: ReviewOutcome | null;
  readonly createdAt: string;
  /** When the card's data was last read from git. */
  readonly updatedAt: string;
  readonly resolvedAt: string | null;
  readonly repos: readonly ReviewRepo[];
  /** Totals over {@link repos}. */
  readonly fileCount: number;
  readonly added: number;
  readonly removed: number;
  readonly uncommitted: number;
  readonly commitCount: number;
  /** The agent's last message (cut to 2,000 characters), else `null`. */
  readonly summary: string | null;
  readonly tests: ReviewTests;
  /** The actions offered now (the first is primary). */
  readonly actions: readonly ReviewActionId[];
  /** `commit`: the drafted message (from the summary). */
  readonly commitMessage: string;
  /** The last action's note (a refusal's reason, a merge's result). */
  readonly note: string | null;
  /**
   * D79 ruling: `true` when the card closed itself because its changes disappeared
   * without a click (the agent pushed, reverted or merged them itself): it counts as
   * done, is shown as "Handled by the agent", and its `reviewResolved` outcome is `dismissed`.
   */
  readonly handledByAgent: boolean;
  /** Files that conflict (a refused Merge). */
  readonly conflicts: readonly string[];
  /** Additive (D48): the paired machine the review is on (its ids are remote ids); absent for this machine's own. */
  readonly machine?: { readonly id: string; readonly name: string; readonly state: string } | null;
}

/** `GET /api/reviews`: pending (and clean-up) reviews, then the recent resolved ones. */
export interface ReviewList {
  readonly pending: readonly Review[];
  readonly recent: readonly Review[];
}

/** Body of `POST /api/reviews/{id}/send-back`. */
export interface ReviewSendBackInput {
  readonly comment: string;
}

/** Body of `POST /api/reviews/{id}/commit`. */
export interface ReviewCommitInput {
  readonly message: string;
}

/** Body of `POST /api/reviews/{id}/discard` and `…/cleanup` (the confirmation). */
export interface ReviewConfirmInput {
  readonly confirm: true;
}

/** Longest Send back comment. */
export const REVIEW_COMMENT_MAX = 4_000;

/** Longest commit message. */
export const REVIEW_COMMIT_MESSAGE_MAX = 4_000;

/** Longest summary kept on a card. */
export const REVIEW_SUMMARY_MAX = 2_000;

/** How many resolved reviews `GET /api/reviews` lists. */
export const REVIEW_RECENT_LIMIT = 20;

/**
 * The actions of a card in `state` and `mode` (the first is primary):
 * - pending, `branch`: Merge, Open PR (until a PR is known), Send back, Discard, Dismiss;
 * - pending, `folder`, with uncommitted changes: Commit, Send back, Discard, Dismiss;
 * - pending, `folder`, everything committed: Send back, Dismiss;
 * - `cleanup`: Clean up, Dismiss (keeps the worktree);
 * - resolved: none.
 */
export function reviewActions(state: ReviewState, mode: ReviewMode, repos: readonly Pick<ReviewRepo, 'uncommitted' | 'prUrl' | 'worktreeId'>[]): ReviewActionId[] {
  if (state === 'resolved') return [];
  if (state === 'cleanup') return ['cleanup', 'dismiss'];
  if (mode === 'branch') {
    const prOpen = repos.length > 0 && repos.every((repo) => repo.prUrl !== null);
    return prOpen ? ['merge', 'send-back', 'discard', 'dismiss'] : ['merge', 'open-pr', 'send-back', 'discard', 'dismiss'];
  }
  const uncommitted = repos.some((repo) => repo.uncommitted > 0);
  return uncommitted ? ['commit', 'send-back', 'discard', 'dismiss'] : ['send-back', 'dismiss'];
}

/** `true` for one of {@link REVIEW_ACTIONS}. */
export function isReviewAction(value: unknown): value is ReviewActionId {
  return typeof value === 'string' && (REVIEW_ACTIONS as readonly string[]).includes(value);
}

/** `true` for one of {@link REVIEW_STATES}. */
export function isReviewState(value: unknown): value is ReviewState {
  return typeof value === 'string' && (REVIEW_STATES as readonly string[]).includes(value);
}

/** `true` for one of {@link REVIEW_OUTCOMES}. */
export function isReviewOutcome(value: unknown): value is ReviewOutcome {
  return typeof value === 'string' && (REVIEW_OUTCOMES as readonly string[]).includes(value);
}

/**
 * A test-like shell command (best effort): a test runner or a `test` script of a
 * package manager / build tool. `npm test`, `npm run test:unit`, `npx vitest run`,
 * `pytest -q`, `go test ./...`, `cargo test`, `dotnet test`, `make test`, …
 */
const TEST_COMMAND =
  /(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w:-]+)?|(?:npx|pnpm\s+exec|yarn|bunx)\s+(?:vitest|jest|playwright\s+test|mocha|ava)|vitest|jest|mocha|pytest|py\.test|tox|nox|rspec|phpunit|(?:go|cargo|dotnet|mix|deno|swift|zig)\s+test|(?:mvn|mvnw|\.\/mvnw)\s+(?:\S+\s+)*test|(?:gradle|gradlew|\.\/gradlew)\s+(?:\S+\s+)*test|make\s+(?:\S+\s+)*(?:test|check)|ctest|python\d?(?:\.\d+)?\s+-m\s+(?:pytest|unittest))(?=$|[\s;&|)])/;

/** `true` when a Bash command looks like it runs tests ({@link TEST_COMMAND}). */
export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command);
}

/**
 * The exit code of a Bash tool result: Claude Code reports a failure as an error
 * result starting `Exit code <n>`; a result that is not an error exited 0; an error
 * without that line is `1` (it failed, the code is unknown).
 */
export function bashExitCode(result: string | undefined, isError: boolean | undefined): number | null {
  if (result === undefined) return null;
  const match = /^\s*Exit code (\d+)/.exec(result);
  if (match) return Number(match[1]);
  return isError === true ? 1 : 0;
}

/** One finished Bash call, oldest first (what {@link testsFromCalls} reads). */
export interface BashCall {
  readonly command: string;
  readonly result: string | undefined;
  readonly isError: boolean | undefined;
}

/** The last test-like Bash call with a result, as {@link ReviewTests}; `not-reported` without one. */
export function testsFromCalls(calls: readonly BashCall[]): ReviewTests {
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i] as BashCall;
    if (!isTestCommand(call.command)) continue;
    const exitCode = bashExitCode(call.result, call.isError);
    if (exitCode === null) continue;
    const command = call.command.length > 200 ? `${call.command.slice(0, 199)}…` : call.command;
    return { status: exitCode === 0 ? 'passed' : 'failed', command, exitCode };
  }
  return { status: 'not-reported', command: null, exitCode: null };
}

/** The card's tests line: `Tests passed · npm test`, `Tests failed (exit 1) · …`, `Tests not reported`. */
export function testsLine(tests: ReviewTests): string {
  if (tests.status === 'not-reported') return 'Tests not reported';
  const head = tests.status === 'passed' ? 'Tests passed' : `Tests failed (exit ${tests.exitCode ?? '?'})`;
  return tests.command ? `${head} · ${tests.command}` : head;
}

/**
 * The drafted commit message of a folder session's card: the summary's first
 * non-empty line (Markdown heading / list marks and emphasis removed, cut to 72
 * characters) as the subject, the rest of the summary (cut) as the body; without
 * a summary `Changes from <session>`.
 */
export function draftCommitMessage(summary: string | null, sessionTitle: string): string {
  const text = (summary ?? '').replace(/\r\n?/g, '\n').trim();
  const lines = text.split('\n');
  const firstIndex = lines.findIndex((line) => line.trim() !== '');
  if (firstIndex < 0) return `Changes from ${sessionTitle}`.slice(0, 72);
  const clean = (line: string): string =>
    line
      .trim()
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/\*\*|__|`/g, '')
      .trim();
  let subject = clean(lines[firstIndex] as string);
  if (subject.length > 72) subject = `${subject.slice(0, 71).trimEnd()}…`;
  const body = lines
    .slice(firstIndex + 1)
    .join('\n')
    .trim();
  const cutBody = body.length > 1_500 ? `${body.slice(0, 1_499).trimEnd()}…` : body;
  return cutBody === '' ? subject : `${subject}\n\n${cutBody}`;
}

/** The Send back message the session gets: the developer's comment, introduced. */
export function sendBackMessage(comment: string): string {
  return `Review: your changes were sent back with this comment:\n\n${comment.trim()}`;
}

/** The Inbox title of a review: `Review: <n> files changed (+a −r)`, or the commits when nothing is uncommitted. */
export function reviewTitle(review: Pick<Review, 'state' | 'outcome' | 'fileCount' | 'added' | 'removed' | 'commitCount'>): string {
  if (review.state === 'cleanup') return review.outcome === 'discarded' ? 'Discarded — clean up the worktree?' : 'Merged — clean up the worktree?';
  const files = `${review.fileCount} file${review.fileCount === 1 ? '' : 's'} changed (+${review.added} −${review.removed})`;
  if (review.fileCount > 0) return files;
  return `${review.commitCount} commit${review.commitCount === 1 ? '' : 's'} to review`;
}

/** The header badge's words for a session's open review. */
export function reviewBadgeText(review: Pick<Review, 'state'>): string {
  return review.state === 'cleanup' ? 'Clean up' : 'Review';
}

/** The words of a resolved card: "Handled by the agent" for one that closed itself, else its outcome's label. */
export function resolutionLabel(review: Pick<Review, 'outcome' | 'handledByAgent'>): string | null {
  if (review.handledByAgent) return HANDLED_BY_AGENT;
  return review.outcome ? REVIEW_OUTCOME_LABELS[review.outcome] : null;
}

/** D79 ruling: the label of a card whose changes disappeared without a click. */
export const HANDLED_BY_AGENT = 'Handled by the agent';

/** The words of an outcome (recent reviews, the resolved card). */
export const REVIEW_OUTCOME_LABELS: { readonly [K in ReviewOutcome]: string } = {
  merged: 'Merged',
  committed: 'Committed',
  discarded: 'Discarded',
  'sent-back': 'Sent back',
  dismissed: 'Dismissed',
};
