import type { DiffScope, FileDiff } from '../../../core/api.ts';

/**
 * D174 follow-up (2026-11-20, "changes should never disappear during the review panel is on"):
 * the For review list the side panel's Changes holds while it shows it. A review clears on the
 * server when the developer replies to the agent or marks it reviewed (D166); the panel then keeps
 * the last list, marked reviewed, until the developer picks another view, switches tab, closes
 * the panel or opens another agent (all of which drop it).
 */
export interface HeldReview {
  readonly sessionId: string;
  /** The files of earlier reviews this panel showed (the review cleared, then a new one began while shown). */
  readonly earlier: readonly FileDiff[];
  /** What the panel shows: {@link earlier} with the newest For review answer over it. */
  readonly files: readonly FileDiff[];
  /** The review cleared while shown: the list stays, marked reviewed. */
  readonly reviewed: boolean;
}

export type HeldReviewEvent =
  /** A For review answer arrived while For review is shown and a review is pending. */
  | { readonly type: 'answer'; readonly sessionId: string; readonly files: readonly FileDiff[] }
  /** The agent's views came back without a pending review. */
  | { readonly type: 'cleared'; readonly sessionId: string }
  /** The developer picked another view (or a turn), or another agent is shown. */
  | { readonly type: 'leave' };

const keyOf = (file: FileDiff): string => `${file.solution}\u0000${file.path}`;

/** `earlier` with `newer` over it (a file in both: the newer diff), in path order. */
export function mergeReviewFiles(earlier: readonly FileDiff[], newer: readonly FileDiff[]): FileDiff[] {
  const byKey = new Map<string, FileDiff>();
  for (const file of earlier) byKey.set(keyOf(file), file);
  for (const file of newer) byKey.set(keyOf(file), file);
  return [...byKey.values()].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
}

/** The held list after `event`. */
export function nextHeldReview(held: HeldReview | null, event: HeldReviewEvent): HeldReview | null {
  if (event.type === 'leave') return null;
  const mine = held !== null && held.sessionId === event.sessionId ? held : null;
  if (event.type === 'cleared') return mine !== null && !mine.reviewed ? { ...mine, reviewed: true } : held;
  // A new review began after the last one cleared: what was shown stays, the new files over it.
  const earlier = mine === null ? [] : mine.reviewed ? mine.files : mine.earlier;
  return { sessionId: event.sessionId, earlier, files: mergeReviewFiles(earlier, event.files), reviewed: false };
}

/**
 * What the panel shows: For review with the held list while it holds one for this agent (a
 * cleared review included), else the view it would show anyway (`scope`) with no held list.
 */
export function shownReview(held: HeldReview | null, input: { readonly sessionId: string; readonly scope: DiffScope; readonly reviewOffered: boolean; readonly viewKind: 'scope' | 'turn' }): { readonly scope: DiffScope; readonly held: HeldReview | null } {
  const mine = held !== null && held.sessionId === input.sessionId && input.viewKind === 'scope' ? held : null;
  if (mine === null) return { scope: input.scope, held: null };
  // A held list means For review is shown (any other pick drops it): the review cleared → still For review, reviewed
  // (also in the render before the `cleared` event is applied, so another view never flashes in between).
  if (!input.reviewOffered) return { scope: 'review', held: mine.reviewed ? mine : { ...mine, reviewed: true } };
  return input.scope === 'review' ? { scope: 'review', held: mine } : { scope: input.scope, held: null };
}

/** The picker's views: For review stays listed (first) while the panel holds a cleared review. */
export function heldScopeOptions(options: readonly DiffScope[], held: HeldReview | null): DiffScope[] {
  return held !== null && held.reviewed && !options.includes('review') ? ['review', ...options] : [...options];
}
