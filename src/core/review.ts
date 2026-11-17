/**
 * D166 (`docs/inbox.md` → *To review*): a finished turn that changed files is **unread until
 * reviewed**, never just "done" (developer request after a dev.to comment: "I treat a finished task
 * as unread until I've reviewed the diff"). Pure rules; `src/server/review/service.ts` applies them.
 *
 * - Only a turn whose tool calls edited files (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, the
 *   main agent's or a subagent's) makes the agent **To review**; a turn that only answered or ran
 *   commands stays Done.
 * - Further file-changing turns before a review keep one pending review and grow it.
 * - It is cleared by **Mark reviewed** (the agent page, its Needs-you card) or by the developer's
 *   next message to the agent; opening the diff does not clear it.
 * - A project step's run (a todo / plan run, `todoLink`) is reviewed through the project (its
 *   merge / confirmation), so it never gets one.
 */

/** The edits of the turns since the last review (`Session.review`, stored on the session). */
export interface ReviewPending {
  /** When the first unreviewed file-changing turn ended (ISO): the episode. */
  readonly since: string;
  /** How many file-changing turns ended since the last review. */
  readonly turns: number;
  /** How many distinct files they changed. */
  readonly fileCount: number;
  /** The paths (as the tool calls wrote them), at most {@link REVIEW_FILES_MAX}. */
  readonly files: readonly string[];
  /**
   * Additive (D174): the session's turn (its user message's place, 1 = the first) the review
   * started at: the first file-changing turn. The "For review" diff starts at that turn's D80
   * checkpoint (`docs/worktrees.md` → *For review (D174)*). Absent on a review stored before D174.
   */
  readonly turn?: number;
  /** Additive (D174): when that turn's user message was sent (ISO): the git fallback's moment when the turn has no checkpoint. */
  readonly startedAt?: string;
}

/** D174: where a new review starts (the first file-changing turn's number and start), when known. */
export interface ReviewStart {
  readonly turn: number | null;
  readonly startedAt: string | null;
}

/** What a session stores (`sessions.review`, 0056). */
export interface SessionReview {
  readonly pending: ReviewPending | null;
  /** The last event read for edits; `null` = not read yet (the next turn end starts at its prompt). */
  readonly cursor: number | null;
}

/** At most this many paths are kept on a pending review (the count goes on). */
export const REVIEW_FILES_MAX = 50;

/** The tool calls that edit files (as `src/server/worktrees/touched.ts`'s `EDIT_TOOLS`). */
export const REVIEW_EDIT_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/**
 * A pending review with one more file-changing turn (its `paths`), ended at `at` (ISO). A new
 * review (`pending` null) records where it started (`start`, D174); a growing one keeps its start.
 */
export function addReviewTurn(pending: ReviewPending | null, paths: readonly string[], at: string, start: ReviewStart | null = null): ReviewPending {
  const seen = new Set(pending?.files ?? []);
  const fresh = paths.filter((path) => !seen.has(path));
  const files = [...(pending?.files ?? []), ...fresh].slice(0, REVIEW_FILES_MAX);
  const turn = pending ? pending.turn : (start?.turn ?? undefined);
  const startedAt = pending ? pending.startedAt : (start?.startedAt ?? undefined);
  return {
    since: pending?.since ?? at,
    turns: (pending?.turns ?? 0) + 1,
    fileCount: (pending?.fileCount ?? 0) + fresh.length,
    files,
    ...(turn !== undefined ? { turn } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
  };
}

/** Whether a session gets reviews at all: never a project step's run (`todoLink`). */
export function reviewsSession(session: { readonly todoLink?: unknown }): boolean {
  return session.todoLink === null || session.todoLink === undefined;
}

/** "3 files" / "1 file". */
export function filesText(count: number): string {
  return `${count} file${count === 1 ? '' : 's'}`;
}

/** The Needs-you card's title: "Review: Checkout fix · 3 files changed". */
export function reviewItemTitle(agent: string, pending: Pick<ReviewPending, 'fileCount'>): string {
  return `Review: ${agent} · ${filesText(pending.fileCount)} changed`;
}

/** The card's detail: the turns and the first files by name. */
export function reviewItemDetail(pending: ReviewPending): string {
  const names = pending.files.slice(0, 5).map((path) => path.split(/[\\/]/).pop() ?? path);
  const more = pending.fileCount > names.length ? `, and ${pending.fileCount - names.length} more` : '';
  const turns = pending.turns === 1 ? 'Its last turn' : `Its last ${pending.turns} turns`;
  return `${turns} changed ${filesText(pending.fileCount)}: ${names.join(', ')}${more}. Review the changes, then Mark reviewed (or reply to the agent).`;
}

/** The agent page's strip: "Changed 3 files". */
export function reviewStripText(pending: Pick<ReviewPending, 'fileCount' | 'turns'>): string {
  return `Changed ${filesText(pending.fileCount)}${pending.turns > 1 ? ` in ${pending.turns} turns` : ''}`;
}

/** A stored review read defensively (anything unreadable: nothing pending, not read yet). */
export function readSessionReview(value: unknown): SessionReview {
  if (typeof value !== 'object' || value === null) return { pending: null, cursor: null };
  const record = value as Record<string, unknown>;
  const cursor = typeof record['cursor'] === 'number' && Number.isFinite(record['cursor']) ? record['cursor'] : null;
  const raw = record['pending'];
  if (typeof raw !== 'object' || raw === null) return { pending: null, cursor };
  const p = raw as Record<string, unknown>;
  if (typeof p['since'] !== 'string' || typeof p['turns'] !== 'number' || typeof p['fileCount'] !== 'number' || !Array.isArray(p['files'])) return { pending: null, cursor };
  const turn = typeof p['turn'] === 'number' && Number.isInteger(p['turn']) && p['turn'] >= 1 ? p['turn'] : undefined;
  const startedAt = typeof p['startedAt'] === 'string' ? p['startedAt'] : undefined;
  return {
    pending: { since: p['since'], turns: p['turns'], fileCount: p['fileCount'], files: p['files'].filter((f): f is string => typeof f === 'string'), ...(turn !== undefined ? { turn } : {}), ...(startedAt !== undefined ? { startedAt } : {}) },
    cursor,
  };
}
