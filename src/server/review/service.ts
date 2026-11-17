import type { Session } from '../../core/api.ts';
import { isRemoteId } from '../../core/peers.ts';
import { type ReviewStart, type SessionReview, REVIEW_EDIT_TOOLS, addReviewTurn, readSessionReview, reviewItemDetail, reviewItemTitle, reviewsSession } from '../../core/review.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import type { HubBus, HubMessage } from '../hub/bus.ts';
import type { SystemItemService } from '../inbox/system-items.ts';

/** The longest agent name in an item's title. */
const TITLE_MAX = 80;

/** Options of {@link ReviewService}. */
export interface ReviewServiceOptions {
  readonly store: Store;
  readonly bus: HubBus;
  readonly systemItems: Pick<SystemItemService, 'reviewNotice' | 'closeReviewNotices'> | null;
  /** Publishes the session's `sessionUpdated` (its `review` changed). */
  readonly announce: (sessionId: string) => Promise<void>;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

function agentName(record: Pick<SessionRecord, 'title' | 'name'>): string {
  const title = (record.title ?? '').trim() || record.name;
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title;
}

/**
 * D166 (`docs/inbox.md` → *To review*): follows this computer's sessions (`sessionUpdated`) and, at
 * the end of each turn (`run` → `idle` / `done`), reads the turn's file edits (its tool calls
 * after the previous turn's end, `core/review.ts` → {@link REVIEW_EDIT_TOOLS}). A turn that edited
 * files adds to the agent's pending review (stored on the session, `sessions.review`) and raises or
 * updates its one "Review: <agent>" Needs-you item; {@link clear} (Mark reviewed, or the developer's
 * next message) ends the episode. Paired computers raise their own sessions' items (merged into
 * this Inbox like every system item); a project step's run never gets one (reviewed through the
 * project).
 */
export class ReviewService {
  readonly #o: ReviewServiceOptions;
  readonly #onError: (error: unknown) => void;
  /** Each session's status as last seen (a turn ends when `run` becomes `idle` / `done`). */
  readonly #status = new Map<string, string>();
  /** One change at a time per session. */
  readonly #runs = new Map<string, Promise<void>>();
  #unsubscribe: (() => void) | null = null;

  constructor(options: ReviewServiceOptions) {
    this.#o = options;
    this.#onError = options.onError ?? ((error) => console.error('switchboard review:', error));
  }

  /** Follows the sessions. */
  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#o.bus.subscribe((message) => this.#onMessage(message));
  }

  /** Stops following; waits for the changes in flight. */
  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    await this.idle();
  }

  /** Resolves once the changes in flight are done (tests). */
  async idle(): Promise<void> {
    while (this.#runs.size > 0) await Promise.all([...this.#runs.values()].map((run) => run.catch(() => undefined)));
  }

  #onMessage(message: HubMessage): void {
    if (message.name !== 'sessionUpdated') return;
    const session: Session = message.payload;
    // A paired computer reads its own sessions' turns.
    if (isRemoteId(session.id) || session.machine) return;
    const before = this.#status.get(session.id);
    this.#status.set(session.id, session.status);
    if (session.closedAt) {
      if (session.review) this.#queue(session.id, () => this.#closed(session.id));
      return;
    }
    if (before === 'run' && (session.status === 'idle' || session.status === 'done')) this.#queue(session.id, () => this.#turnEnded(session.id));
  }

  /** A turn of `sessionId` ended: its edits, if any, go into the agent's pending review. */
  async #turnEnded(sessionId: string): Promise<void> {
    const record = await this.#o.store.sessions.get(sessionId);
    if (!record || record.closedAt !== null || !reviewsSession(record)) return;
    const review = readSessionReview(record.review);
    // Not read yet: the turn's edits are the ones after its prompt.
    const after = review.cursor ?? (await this.#o.store.events.latestUserMessageId(sessionId));
    const { paths, lastId, firstId } = await this.#o.store.events.editedFilePathsAfter(sessionId, REVIEW_EDIT_TOOLS, after);
    const cursor = Math.max(lastId, await this.#o.store.events.newestId(sessionId));
    if (paths.length === 0) {
      if (cursor !== review.cursor) await this.#save(sessionId, { pending: review.pending, cursor });
      return;
    }
    const start = review.pending === null && firstId !== null ? await this.#startOf(sessionId, firstId) : null;
    const pending = addReviewTurn(review.pending, paths, new Date((this.#o.now ?? Date.now)()).toISOString(), start);
    await this.#save(sessionId, { pending, cursor });
    await this.#o.systemItems?.reviewNotice({ sessionId, dedupe: `review:${sessionId}:${pending.since}`, source: agentName(record), title: reviewItemTitle(agentName(record), pending), detail: reviewItemDetail(pending) });
    await this.#o.announce(sessionId);
  }

  /**
   * D174: where a new review starts: the turn of its first edit (the user messages up to the
   * one before it; the D80 checkpoint of that turn is the For review diff's base) and when that
   * message was sent. Without a user message before the edit: unknown.
   */
  async #startOf(sessionId: string, firstEditId: number): Promise<ReviewStart | null> {
    const message = await this.#o.store.events.userMessageAtOrBefore(sessionId, firstEditId);
    if (message === null) return null;
    return { turn: await this.#o.store.events.countUserMessages(sessionId, message.id), startedAt: message.ts };
  }

  /**
   * Ends the agent's pending review (Mark reviewed, or the developer's message: `outcome`): its
   * Needs-you item closes and the next turn's edits start a new one. Answers whether one was pending.
   */
  async clear(sessionId: string, outcome: 'reviewed' | 'replied' = 'reviewed'): Promise<boolean> {
    let had = false;
    await this.#queueAndWait(sessionId, async () => {
      const record = await this.#o.store.sessions.get(sessionId);
      if (!record) return;
      const review = readSessionReview(record.review);
      had = review.pending !== null;
      if (!had) return;
      await this.#save(sessionId, { pending: null, cursor: Math.max(review.cursor ?? 0, await this.#o.store.events.newestId(sessionId)) });
      await this.#o.systemItems?.closeReviewNotices(sessionId, outcome);
      await this.#o.announce(sessionId);
    });
    return had;
  }

  /** An archived agent: its item closes (its pending review stays stored, not shown). */
  async #closed(sessionId: string): Promise<void> {
    await this.#o.systemItems?.closeReviewNotices(sessionId, 'closed');
  }

  async #save(sessionId: string, review: SessionReview): Promise<void> {
    await this.#o.store.sessions.update(sessionId, { review });
  }

  #queue(sessionId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.#runs.get(sessionId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(work)
      .catch((error: unknown) => this.#onError(error));
    this.#runs.set(sessionId, run);
    void run.finally(() => {
      if (this.#runs.get(sessionId) === run) this.#runs.delete(sessionId);
    });
    return run;
  }

  async #queueAndWait(sessionId: string, work: () => Promise<void>): Promise<void> {
    await this.#queue(sessionId, work);
  }
}
