import { type ReactNode, useEffect, useState } from 'react';
import { reviewBadgeText } from '../../../core/reviews.ts';
import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { ReviewCard } from '../../components/ReviewCard.tsx';
import { openReviewOf } from '../../components/review-card.ts';

/**
 * D79 (`docs/reviews.md` → *Session header*): the session's open Review card as a badge
 * at the start of the header's chips row (`Review`, or `Clean up` after a merge / discard); a click
 * opens the same card as the Inbox shows, under the top row. Nothing is mounted while
 * the session has no open review (the visual oracle's header is unchanged). The list
 * reloads on `/hub` `reviewsChanged` for this session.
 */
export function useSessionReview(sessionId: string): { readonly badge: ReactNode; readonly panel: ReactNode } {
  const reviews = useApi(api.reviews, [sessionId]);
  const [open, setOpen] = useState(false);
  useHubEvent('reviewsChanged', (payload) => {
    if (payload.sessionId === sessionId) reviews.reload();
  });
  useEffect(() => setOpen(false), [sessionId]);
  const review = openReviewOf(reviews.data ?? [], sessionId);
  if (!review) return { badge: null, panel: null };
  const badge = (
    <button
      type="button"
      className="sb-button sb-sv-review-badge"
      data-testid="session-review-badge"
      data-state={review.state}
      aria-expanded={open}
      title={review.state === 'pending' ? 'Changes are ready for review' : 'Merged or discarded: clean up the worktree?'}
      onClick={() => setOpen(!open)}
    >
      <span className="sb-sv-review-dot" aria-hidden="true" />
      {reviewBadgeText(review)}
    </button>
  );
  const panel = open ? (
    <div className="sb-sv-review-panel" data-testid="session-review-panel">
      <ReviewCard review={review} variant="popover" onChanged={() => reviews.reload()} />
    </div>
  ) : null;
  return { badge, panel };
}
