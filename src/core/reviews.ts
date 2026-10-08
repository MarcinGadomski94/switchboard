/**
 * The review queue's shared event (D76 with lane B's review queue): published on the
 * bus as `reviewResolved` when the review card of a session is resolved. The todo
 * lists (D76, `docs/todos.md` → *Review*) subscribe to it: an item whose run session
 * it is leaves `review`. Kept minimal on purpose (both lanes define this same shape).
 */

/** How a review card was resolved. */
export type ReviewOutcome = 'merged' | 'committed' | 'discarded' | 'sent-back' | 'dismissed';

/** The `reviewResolved` payload: the session whose review card was resolved, and how. */
export interface ReviewResolvedEvent {
  readonly sessionId: string;
  readonly outcome: ReviewOutcome;
}
