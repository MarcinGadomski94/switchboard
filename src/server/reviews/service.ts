import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Session } from '../../core/api.ts';
import type { SessionStatus } from '../../core/model.ts';
import { isRemoteId } from '../../core/peers.ts';
import {
  REVIEW_COMMENT_MAX,
  REVIEW_COMMIT_MESSAGE_MAX,
  REVIEW_RECENT_LIMIT,
  REVIEW_SUMMARY_MAX,
  type Review,
  type ReviewActionId,
  type ReviewMode,
  type ReviewOutcome,
  type ReviewRepo,
  type ReviewTests,
  type BashCall,
  isReviewAction,
  sendBackMessage,
  testsFromCalls,
} from '../../core/reviews.ts';
import type { ReviewRecord } from '../db/repos/reviews.ts';
import { type ReviewData, dataOf, toReview } from './wire.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { type FolderRef, folderOfSession, repoSolutionName } from '../folders/ref.ts';
import type { HubBus, HubMessage } from '../hub/bus.ts';
import { inboxCount } from '../inbox/wire.ts';
import { type MergePlan, type RepoReading, ReviewGit, ReviewGitError, type ReviewTarget } from './git.ts';

/**
 * D79 "Review queue" (`docs/reviews.md`). When a turn of one of this machine's
 * sessions ends (its status goes from `run` to `idle` or `done`, as the D73 push
 * notifier and the D75 reminder read it) and the session has changes (uncommitted
 * changes in its working tree, or commits on its branch not merged into its base),
 * it gets a Review card, once per change set (a fingerprint). Reviews are post-hoc
 * and advisory: nothing here ever blocks or waits on an agent. The card's actions run
 * git / gh on the developer's click; a resolved card emits `reviewResolved`.
 */

/** Why the service refused an action. */
export type ReviewErrorCode = 'not-found' | 'unknown-action' | 'not-offered' | 'invalid' | 'gone' | 'busy' | 'refused' | 'send-failed';

/** A refused review action; `status` is the HTTP status. */
export class ReviewError extends Error {
  override name = 'ReviewError';
  readonly code: ReviewErrorCode | ReviewGitError['code'];
  readonly status: number;
  readonly conflicts: readonly string[];
  constructor(code: ReviewErrorCode | ReviewGitError['code'], status: number, message: string, conflicts: readonly string[] = []) {
    super(message);
    this.code = code;
    this.status = status;
    this.conflicts = conflicts;
  }
}

/** Options of {@link ReviewService}. */
export interface ReviewServiceOptions {
  readonly store: Store;
  readonly bus: HubBus;
  readonly git: ReviewGit;
  /** The main checkout a solution name means in a folder (the worktree manager's `resolveRepo`). */
  readonly resolveRepo: (solution: string, folder: FolderRef) => Promise<{ readonly repoPath: string }>;
  /** Settings → Sessions → *Raise review cards when a session with changes goes idle* (read at every turn's end). */
  readonly enabled: () => Promise<boolean>;
  /** Sends a text to the session as the developer's message (Send back); throws when it cannot be sent. */
  readonly send: (sessionId: string, text: string) => Promise<void>;
  readonly onError?: (error: unknown) => void;
}

/** The review cards: raising them at turn ends, reading them, their actions. */
export class ReviewService {
  readonly #options: ReviewServiceOptions;
  readonly #store: Store;
  readonly #git: ReviewGit;
  readonly #onError: (error: unknown) => void;
  readonly #status = new Map<string, SessionStatus>();
  /** One evaluation or action at a time per session. */
  readonly #runs = new Map<string, Promise<unknown>>();
  #unsubscribe: (() => void) | null = null;

  constructor(options: ReviewServiceOptions) {
    this.#options = options;
    this.#store = options.store;
    this.#git = options.git;
    this.#onError = options.onError ?? ((error) => console.error('switchboard reviews:', error));
  }

  /** Starts listening to the sessions' updates. */
  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#options.bus.subscribe((message) => this.#onMessage(message));
  }

  /** Stops listening; waits for the work in flight. */
  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    await this.idle();
  }

  /** Resolves once the work in flight is done (tests). */
  async idle(): Promise<void> {
    while (this.#runs.size > 0) await Promise.all([...this.#runs.values()].map((run) => run.catch(() => undefined)));
  }

  #onMessage(message: HubMessage): void {
    if (message.name !== 'sessionUpdated') return;
    const session: Session = message.payload;
    // A paired machine's session is its own machine's to review.
    if (isRemoteId(session.id)) return;
    const before = this.#status.get(session.id);
    this.#status.set(session.id, session.status);
    if (before !== 'run' || (session.status !== 'idle' && session.status !== 'done') || session.closedAt != null) return;
    void this.#serial(session.id, async () => {
      if (!(await this.#options.enabled())) return;
      await this.evaluate(session.id);
    }).catch((error: unknown) => this.#onError(error));
  }

  /** Runs `work` after the session's earlier work (evaluations and actions never overlap per session). */
  #serial<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#runs.get(sessionId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    this.#runs.set(sessionId, run);
    void run
      .catch(() => undefined)
      .finally(() => {
        if (this.#runs.get(sessionId) === run) this.#runs.delete(sessionId);
      });
    return run;
  }

  // ── raising ───────────────────────────────────────────────────────────

  /**
   * Reads the session's change set now and raises its review (once per change set):
   * a new card, the open card refreshed, or nothing (no changes, or the same change set
   * as the newest card). Answers the session's open review, if any. Called at a turn's
   * end; not serialized itself (callers are).
   */
  async evaluate(sessionId: string): Promise<Review | null> {
    const session = await this.#store.sessions.get(sessionId);
    if (!session || session.closedAt !== null) return null;
    const latest = await this.#store.reviews.latestOf(sessionId);
    // A pending card keeps what the developer did on it (an opened PR, the last note) when its data is refreshed.
    const read = await this.#read(session, latest?.state === 'pending' ? dataOf(latest) : null);
    if (read === null) return null;
    const result = await this.#store.reviews.raise(sessionId, read.fingerprint, read.data);
    if (result.kind !== 'unchanged') await this.#changed(sessionId);
    const open = await this.#store.reviews.openOf(sessionId);
    return open ? this.#toReview(open, session) : null;
  }

  /** The session's targets read now: `null` when nothing has changes. */
  async #read(session: SessionRecord, previous: ReviewData | null = null): Promise<{ readonly fingerprint: string; readonly data: ReviewData; readonly readings: RepoReading[] } | null> {
    const { mode, targets } = await this.#targets(session);
    const readings: RepoReading[] = [];
    for (const target of targets) {
      try {
        const reading = await this.#git.read(target, session.createdAt);
        if (reading && (reading.uncommitted > 0 || reading.commits.length > 0)) readings.push(reading);
      } catch (error) {
        this.#onError(error);
      }
    }
    if (readings.length === 0) return null;
    return { fingerprint: fingerprintOf(readings), data: await this.#data(session, mode, readings, previous), readings };
  }

  /**
   * The session's repositories: its live worktrees (`branch` mode), else the
   * repositories of its folder (`folder` mode): its solutions resolved in its folder
   * (a repo folder's one solution), else the repository its working folder is in.
   */
  async #targets(session: SessionRecord): Promise<{ readonly mode: ReviewMode; readonly targets: ReviewTarget[] }> {
    const worktrees = await this.#store.worktrees.list({ sessionId: session.id });
    if (worktrees.length > 0) {
      return {
        mode: 'branch',
        targets: worktrees.map((worktree) => ({ repo: worktree.repo, dir: worktree.path, mode: 'branch', worktreeId: worktree.id, repoPath: worktree.repoPath, baseRef: worktree.baseRef })),
      };
    }
    const repos = new Map<string, string>();
    const folder = folderOfSession(session);
    if (folder) {
      const names = session.solutions.length > 0 ? session.solutions : folder.kind === 'repo' ? [repoSolutionName(folder)] : [];
      for (const name of names) {
        try {
          const location = await this.#options.resolveRepo(name, folder);
          if (!repos.has(location.repoPath)) repos.set(location.repoPath, name);
        } catch {
          // Not a repository (any more): nothing to review there.
        }
      }
    }
    if (repos.size === 0 && session.cwd) {
      const top = await this.#git.topLevel(session.cwd);
      if (top) repos.set(top, path.basename(top));
    }
    return {
      mode: 'folder',
      targets: [...repos].map(([repoPath, repo]) => ({ repo, dir: repoPath, mode: 'folder', worktreeId: null, repoPath, baseRef: null })),
    };
  }

  async #data(session: SessionRecord, mode: ReviewMode, readings: readonly RepoReading[], previous: ReviewData | null): Promise<ReviewData> {
    const repos: ReviewRepo[] = readings.map((reading) => ({
      repo: reading.target.repo,
      dir: reading.target.dir,
      worktreeId: reading.target.worktreeId,
      branch: reading.branch,
      base: mode === 'branch' ? (reading.base?.branch ?? null) : reading.upstream,
      baseSource: mode === 'branch' ? (reading.base?.source ?? null) : null,
      files: reading.files,
      added: reading.added,
      removed: reading.removed,
      uncommitted: reading.uncommitted,
      commits: reading.commits,
      prUrl: previous?.repos.find((repo) => repo.repo === reading.target.repo)?.prUrl ?? null,
    }));
    return { mode, repos, summary: await this.#summary(session.id), tests: await this.#tests(session.id), note: previous?.note ?? null, conflicts: previous?.conflicts ?? [] };
  }

  /** The agent's last message (the main agent's, else any), cut. */
  async #summary(sessionId: string): Promise<string | null> {
    const main = await this.#store.agents.mainOf(sessionId);
    const [event] = await this.#store.events.assistantTextsNewestFirst(sessionId, { agentId: main?.id ?? null, words: [], limit: 1 });
    const payload = event?.payload as { text?: unknown } | undefined;
    const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
    if (text === '') return null;
    return text.length > REVIEW_SUMMARY_MAX ? `${text.slice(0, REVIEW_SUMMARY_MAX - 1)}…` : text;
  }

  /** The last test-like Bash call of the session's transcript (best effort). */
  async #tests(sessionId: string): Promise<ReviewTests> {
    const events = await this.#store.events.toolCallsNewestFirst(sessionId, 'Bash', 200);
    const calls: BashCall[] = [];
    for (const event of [...events].reverse()) {
      const payload = event.payload as { input?: { command?: unknown }; result?: unknown; isError?: unknown } | null;
      const command = payload?.input?.command;
      if (typeof command !== 'string') continue;
      calls.push({ command, result: typeof payload?.result === 'string' ? payload.result : undefined, isError: payload?.isError === true });
    }
    return testsFromCalls(calls);
  }

  /** A review of `sessionId` was raised, refreshed or acted on: the header badges (`reviewsChanged`) and the Inbox (`inboxChanged`) reload. */
  async #changed(sessionId: string): Promise<void> {
    this.#options.bus.publish('reviewsChanged', { sessionId });
    this.#options.bus.publish('inboxChanged', { count: await inboxCount(this.#store) });
  }

  // ── reading ───────────────────────────────────────────────────────────

  /**
   * `GET /api/reviews`: the open reviews (pending, then clean-up offers), oldest first,
   * each read from git again (a pending card whose changes are gone is closed as
   * dismissed), then the {@link REVIEW_RECENT_LIMIT} newest resolved ones.
   */
  async list(): Promise<Review[]> {
    const open: Review[] = [];
    for (const record of await this.#store.reviews.listOpen()) {
      const review = await this.#serial(record.sessionId, () => this.#refreshed(record.id)).catch((error: unknown) => {
        this.#onError(error);
        return null;
      });
      if (review && review.state !== 'resolved') open.push(review);
    }
    const recent: Review[] = [];
    for (const record of await this.#store.reviews.listRecent(REVIEW_RECENT_LIMIT)) {
      const review = await this.#review(record);
      if (review) recent.push(review);
    }
    return [...open, ...recent];
  }

  /** A stored review as the API shows it (no git read). */
  async get(id: string): Promise<Review | null> {
    const record = await this.#store.reviews.get(id);
    return record ? this.#review(record) : null;
  }

  /** `true` when `id` is a review (the Inbox's actions route). */
  async isReview(id: string): Promise<boolean> {
    return (await this.#store.reviews.get(id)) !== null;
  }

  async #review(record: ReviewRecord): Promise<Review | null> {
    const session = await this.#store.sessions.get(record.sessionId);
    return session ? this.#toReview(record, session) : null;
  }

  /** A pending review read from git again (its data refreshed); one whose changes are gone is resolved as dismissed. */
  async #refreshed(id: string): Promise<Review | null> {
    const record = await this.#store.reviews.get(id);
    if (!record) return null;
    const session = await this.#store.sessions.get(record.sessionId);
    if (!session) return null;
    if (record.state !== 'pending') return this.#toReview(record, session);
    const read = await this.#read(session, dataOf(record));
    if (read === null) {
      // D79 ruling: changes gone without a click (the agent pushed, reverted or merged them) count as done:
      // shown as "Handled by the agent", and `reviewResolved` says `dismissed` (the event contract is unchanged).
      const data = { ...dataOf(record), handledByAgent: true, note: 'Handled by the agent: its changes are no longer pending (pushed, reverted or merged).' };
      const resolved = await this.#store.reviews.resolve(record.id, 'dismissed', { data });
      if (resolved) {
        this.#resolved(session.id, 'dismissed');
        await this.#changed(session.id);
        return this.#toReview(resolved, session);
      }
      return this.#toReview(record, session);
    }
    if (read.fingerprint === record.fingerprint) return this.#toReview(record, session);
    const updated = (await this.#store.reviews.refresh(record.id, read.fingerprint, read.data)) ?? record;
    await this.#changed(session.id);
    return this.#toReview(updated, session);
  }

  #toReview(record: ReviewRecord, session: SessionRecord): Review {
    return toReview(record, session);
  }

  // ── actions ───────────────────────────────────────────────────────────

  /**
   * Runs a card's action (`POST /api/reviews/{id}/<action>`) on the card as it is now
   * (read from git again first). Answers the card afterwards.
   * @throws {ReviewError} 404 unknown review, 400 unknown action, 409 an action the
   * card does not offer now / changes gone / a git refusal (conflicts, uncommitted, …),
   * 422 a bad body (comment, message, confirm).
   */
  async act(id: string, action: string, body: unknown): Promise<Review> {
    if (!isReviewAction(action)) throw new ReviewError('unknown-action', 400, `no review action "${action}"`);
    const record = await this.#store.reviews.get(id);
    if (!record) throw new ReviewError('not-found', 404, `no review ${id}`);
    return this.#serial(record.sessionId, () => this.#act(id, action, body));
  }

  async #act(id: string, action: ReviewActionId, body: unknown): Promise<Review> {
    const fields = isRecord(body) ? body : {};
    // Checked before anything runs.
    const comment = action === 'send-back' ? checkText(fields['comment'], 'comment', REVIEW_COMMENT_MAX) : '';
    const message = action === 'commit' ? checkText(fields['message'], 'message', REVIEW_COMMIT_MESSAGE_MAX) : '';
    if ((action === 'discard' || action === 'cleanup') && fields['confirm'] !== true) {
      throw new ReviewError('invalid', 422, `${action === 'discard' ? 'Discard' : 'Clean up'} needs { confirm: true }`);
    }
    const before = await this.#store.reviews.get(id);
    if (!before) throw new ReviewError('not-found', 404, `no review ${id}`);
    const session = await this.#store.sessions.get(before.sessionId);
    if (!session) throw new ReviewError('not-found', 404, `the session of review ${id} is gone`);
    const current = await this.#refreshed(id);
    const record = await this.#store.reviews.get(id);
    if (!current || !record) throw new ReviewError('not-found', 404, `no review ${id}`);
    if (!current.actions.includes(action)) {
      const why = record.state === 'resolved' ? (before.state === 'pending' ? 'its changes are gone' : 'it is resolved') : 'it is not offered now';
      throw new ReviewError(record.state === 'resolved' && before.state === 'pending' ? 'gone' : 'not-offered', 409, `${action} is not available on this review: ${why}`);
    }
    const data = dataOf(record);
    try {
      switch (action) {
        case 'merge':
          return await this.#merge(record, session, data);
        case 'open-pr':
          return await this.#openPr(record, session, data);
        case 'commit':
          return await this.#commit(record, session, data, message);
        case 'send-back':
          return await this.#sendBack(record, session, comment);
        case 'discard':
          return await this.#discard(record, session, data);
        case 'cleanup':
          return await this.#cleanup(record, session, data);
        case 'dismiss':
          return await this.#dismiss(record, session);
      }
    } catch (error) {
      if (error instanceof ReviewGitError) {
        // The refusal's reason stays on the card (and conflicts are listed).
        await this.#store.reviews.setData(record.id, { ...data, note: error.message, conflicts: error.conflicts });
        await this.#changed(record.sessionId);
        throw new ReviewError(error.code, 409, error.message, error.conflicts);
      }
      throw error;
    }
  }

  /** Re-reads the session's targets with the card's mode (each repo of the card). */
  async #readAll(session: SessionRecord, data: ReviewData): Promise<RepoReading[]> {
    const { targets } = await this.#targets(session);
    const readings: RepoReading[] = [];
    for (const target of targets) {
      if (!data.repos.some((repo) => repo.repo === target.repo && repo.dir === target.dir)) continue;
      const reading = await this.#git.read(target, session.createdAt);
      if (reading) readings.push(reading);
    }
    return readings;
  }

  /** The fingerprint of the session's change set now (after an action). */
  async #fingerprintNow(session: SessionRecord): Promise<string> {
    const read = await this.#read(session);
    return read ? read.fingerprint : 'empty';
  }

  async #finish(record: ReviewRecord, session: SessionRecord, outcome: ReviewOutcome, data: ReviewData, cleanup: boolean): Promise<Review> {
    const fingerprint = await this.#fingerprintNow(session);
    const resolved = await this.#store.reviews.resolve(record.id, outcome, { cleanup, data, fingerprint });
    if (!resolved) throw new ReviewError('not-offered', 409, 'the review was resolved meanwhile');
    this.#resolved(session.id, outcome);
    await this.#changed(session.id);
    return this.#toReview(resolved, session);
  }

  #resolved(sessionId: string, outcome: ReviewOutcome): void {
    // D79 · the shared contract with lane A: exactly `{ sessionId, outcome }`.
    this.#options.bus.publish('reviewResolved', { sessionId, outcome });
  }

  async #merge(record: ReviewRecord, session: SessionRecord, data: ReviewData): Promise<Review> {
    const readings = await this.#readAll(session, data);
    // Every repo is checked (conflicts, uncommitted, a dirty base checkout) before any is merged.
    const plans: MergePlan[] = [];
    for (const reading of readings) plans.push(await this.#git.checkMerge(reading));
    const notes: string[] = [];
    for (const plan of plans) notes.push(await this.#git.merge(plan));
    return this.#finish(record, session, 'merged', { ...data, note: notes.join('\n'), conflicts: [] }, true);
  }

  async #openPr(record: ReviewRecord, session: SessionRecord, data: ReviewData): Promise<Review> {
    const readings = await this.#readAll(session, data);
    const title = session.title ?? session.name;
    const body = `${data.summary ?? `Changes from the Switchboard session ${title}.`}\n\n---\nOpened from a Switchboard review card.`;
    const repos = [...data.repos];
    const notes: string[] = [];
    for (const reading of readings) {
      const index = repos.findIndex((repo) => repo.repo === reading.target.repo && repo.dir === reading.target.dir);
      if (index >= 0 && repos[index]?.prUrl) continue;
      const url = await this.#git.openPullRequest(reading, title, body);
      if (index >= 0) repos[index] = { ...(repos[index] as ReviewRepo), prUrl: url };
      notes.push(`${reading.target.repo}: pull request ${url}`);
    }
    const updated = (await this.#store.reviews.setData(record.id, { ...data, repos, note: notes.join('\n') || data.note, conflicts: [] })) ?? record;
    await this.#changed(session.id);
    return this.#toReview(updated, session);
  }

  async #commit(record: ReviewRecord, session: SessionRecord, data: ReviewData, message: string): Promise<Review> {
    const readings = await this.#readAll(session, data);
    const notes: string[] = [];
    for (const reading of readings) {
      if (reading.uncommitted === 0) continue;
      const sha = await this.#git.commitAll(reading.target.dir, message);
      notes.push(`${reading.target.repo}: committed ${sha}`);
    }
    return this.#finish(record, session, 'committed', { ...data, note: notes.join('\n'), conflicts: [] }, false);
  }

  async #sendBack(record: ReviewRecord, session: SessionRecord, comment: string): Promise<Review> {
    try {
      await this.#options.send(session.id, sendBackMessage(comment));
    } catch (error) {
      throw new ReviewError('send-failed', 409, `the comment could not be sent: ${error instanceof Error ? error.message : String(error)}`);
    }
    return this.#finish(record, session, 'sent-back', { ...dataOf(record), note: `Sent back: ${comment.trim()}`, conflicts: [] }, false);
  }

  async #discard(record: ReviewRecord, session: SessionRecord, data: ReviewData): Promise<Review> {
    const readings = await this.#readAll(session, data);
    if (data.mode === 'branch') {
      for (const reading of readings) if (reading.base === null) throw new ReviewGitError('base-missing', `${reading.target.repo}: no base branch to reset to`);
      for (const reading of readings) await this.#git.discardBranch(reading);
      return this.#finish(record, session, 'discarded', { ...data, note: 'The branch was reset to its base; its commits and uncommitted changes are gone.', conflicts: [] }, true);
    }
    for (const reading of readings) await this.#git.discardFolder(reading.target.dir, reading.files);
    return this.#finish(record, session, 'discarded', { ...data, note: 'The uncommitted changes were reverted.', conflicts: [] }, false);
  }

  async #cleanup(record: ReviewRecord, session: SessionRecord, data: ReviewData): Promise<Review> {
    if (session.status === 'run') throw new ReviewError('busy', 409, 'the session is working in its worktree; clean up once its turn ends');
    const notes: string[] = [];
    for (const repo of data.repos) {
      if (repo.worktreeId === null || repo.branch === null) continue;
      const worktree = await this.#store.worktrees.get(repo.worktreeId);
      if (!worktree || worktree.removedAt !== null) continue;
      const baseTip = repo.base
        ? ((await this.#git.tipOf(worktree.repoPath, `refs/heads/${repo.base}`)) ?? (await this.#git.tipOf(worktree.repoPath, `refs/remotes/origin/${repo.base}`)))
        : null;
      await this.#git.cleanup({ repo: repo.repo, dir: worktree.path, mode: 'branch', worktreeId: worktree.id, repoPath: worktree.repoPath, baseRef: worktree.baseRef }, repo.branch, baseTip);
      await this.#store.worktrees.markRemoved(worktree.id);
      notes.push(`${repo.repo}: removed ${worktree.path} and the branch ${repo.branch}`);
    }
    const closed = await this.#store.reviews.closeCleanup(record.id, { ...data, note: notes.join('\n') || 'Nothing left to clean up.', conflicts: [] });
    await this.#changed(session.id);
    return this.#toReview(closed ?? record, session);
  }

  async #dismiss(record: ReviewRecord, session: SessionRecord): Promise<Review> {
    if (record.state === 'cleanup') {
      const data = dataOf(record);
      const closed = await this.#store.reviews.closeCleanup(record.id, { ...data, note: data.note ? `${data.note}\nThe worktree was kept.` : 'The worktree was kept.' });
      await this.#changed(session.id);
      return this.#toReview(closed ?? record, session);
    }
    return this.#finish(record, session, 'dismissed', dataOf(record), false);
  }
}

/** The fingerprint of a change set: each changed repo's own, in order. */
function fingerprintOf(readings: readonly RepoReading[]): string {
  const hash = createHash('sha256');
  for (const reading of [...readings].sort((a, b) => (a.target.dir < b.target.dir ? -1 : 1))) hash.update(`${reading.fingerprint}\n`);
  return hash.digest('hex');
}

function checkText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ReviewError('invalid', 422, `${field} must be a non-empty text`);
  if (value.length > max) throw new ReviewError('invalid', 422, `${field} must be at most ${max} characters`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
