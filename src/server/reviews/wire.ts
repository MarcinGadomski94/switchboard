import type { InboxItem } from '../../core/api.ts';
import {
  type Review,
  type ReviewMode,
  type ReviewRepo,
  type ReviewTests,
  draftCommitMessage,
  reviewActions,
  reviewTitle,
  testsLine,
} from '../../core/reviews.ts';
import type { ReviewRecord } from '../db/repos/reviews.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';

/**
 * D79 (`docs/reviews.md`): a stored review as the API and the Inbox show it. Pure
 * over the stored row (no git read: `ReviewService` keeps the rows fresh).
 */

/** The data a review row stores (`session_reviews.data`). */
export interface ReviewData {
  readonly mode: ReviewMode;
  readonly repos: readonly ReviewRepo[];
  readonly summary: string | null;
  readonly tests: ReviewTests;
  readonly note: string | null;
  readonly conflicts: readonly string[];
  /** D79 ruling: the card closed itself (its changes disappeared without a click). */
  readonly handledByAgent?: boolean;
}

/** The review's stored data with defaults for anything missing. */
export function dataOf(record: Pick<ReviewRecord, 'data'>): ReviewData {
  const raw = isRecord(record.data) ? record.data : {};
  return {
    mode: raw['mode'] === 'folder' ? 'folder' : 'branch',
    repos: Array.isArray(raw['repos']) ? (raw['repos'] as ReviewRepo[]) : [],
    summary: typeof raw['summary'] === 'string' ? raw['summary'] : null,
    tests: isRecord(raw['tests']) ? (raw['tests'] as unknown as ReviewTests) : { status: 'not-reported', command: null, exitCode: null },
    note: typeof raw['note'] === 'string' ? raw['note'] : null,
    conflicts: Array.isArray(raw['conflicts']) ? (raw['conflicts'] as string[]) : [],
    handledByAgent: raw['handledByAgent'] === true,
  };
}

/** A stored review as the API shows it. */
export function toReview(record: ReviewRecord, session: Pick<SessionRecord, 'title' | 'name' | 'root' | 'cwd'>): Review {
  const data = dataOf(record);
  const title = session.title ?? session.name;
  const sum = (pick: (repo: ReviewRepo) => number): number => data.repos.reduce((total, repo) => total + pick(repo), 0);
  return {
    id: record.id,
    sessionId: record.sessionId,
    sessionTitle: title,
    folderPath: session.root ?? session.cwd ?? null,
    mode: data.mode,
    state: record.state,
    outcome: record.outcome,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    resolvedAt: record.resolvedAt,
    repos: data.repos,
    fileCount: sum((repo) => repo.files.length),
    added: sum((repo) => repo.added),
    removed: sum((repo) => repo.removed),
    uncommitted: sum((repo) => repo.uncommitted),
    commitCount: sum((repo) => repo.commits.length),
    summary: data.summary,
    tests: data.tests,
    actions: reviewActions(record.state, data.mode, data.repos),
    commitMessage: draftCommitMessage(data.summary, title),
    note: data.note,
    conflicts: data.conflicts,
    handledByAgent: data.handledByAgent === true,
  };
}

/**
 * The Inbox item of an open review: kind `review`, the session as its source, status
 * `need` while pending (`done` while only Clean up is offered), the title from the
 * diff stats, the tests line as its detail, one branch chip per repo
 * (`<repo> ⎇ <branch> → <base>`), and the card itself (`review`).
 */
export function reviewItem(review: Review, sessionName: string): InboxItem {
  return {
    id: review.id,
    kind: 'review',
    sessionId: review.sessionId,
    source: sessionName,
    sourceTitle: review.sessionTitle,
    status: review.state === 'pending' ? 'need' : 'done',
    title: reviewTitle(review),
    label: review.state === 'pending' ? 'Review' : 'Clean up',
    detail: review.state === 'pending' ? testsLine(review.tests) : (review.note ?? ''),
    createdAt: review.createdAt,
    branches: review.repos.filter((repo) => repo.branch !== null).map((repo) => ({ solution: repo.repo, branch: repo.base ? `${repo.branch} → ${repo.base}` : (repo.branch as string) })),
    review,
  };
}

/** The open reviews' Inbox items, oldest first (`listInbox`). */
export async function reviewItems(store: Store): Promise<InboxItem[]> {
  const items: InboxItem[] = [];
  for (const record of await store.reviews.listOpen()) {
    const session = await store.sessions.get(record.sessionId);
    if (session) items.push(reviewItem(toReview(record, session), session.name));
  }
  return items;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
