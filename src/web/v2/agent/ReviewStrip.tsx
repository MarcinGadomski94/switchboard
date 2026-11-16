import { useState } from 'react';
import type { Session } from '../../../core/api.ts';
import { reviewStripText } from '../../../core/review.ts';
import { api } from '../../api/client.ts';
import { Button, Icon, useToast } from '../components/index.ts';
import { useV2Router } from '../nav.tsx';

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'It didn’t work. Try again.';
}

/**
 * D166 (`docs/inbox.md` → *To review*): above the composer, a green strip while the agent has
 * finished turns that changed files not reviewed yet: "Changed 3 files" with **Open changes** (the
 * Changes tab) and **Mark reviewed**. Replying to the agent reviews them too (the strip goes).
 */
export function ReviewStrip({ sessionId, session }: { readonly sessionId: string; readonly session: Pick<Session, 'review' | 'closedAt'> | null }) {
  const toast = useToast();
  const { navigate } = useV2Router();
  const [busy, setBusy] = useState(false);
  const pending = session && !session.closedAt ? (session.review ?? null) : null;
  if (!pending) return null;
  const mark = (): void => {
    setBusy(true);
    api.markReviewed(sessionId).then(
      () => setBusy(false),
      (error: unknown) => {
        setBusy(false);
        toast({ text: errorText(error), tone: 'error' });
      },
    );
  };
  return (
    <div className="v2-ag-dock-note v2-ag-review" role="status" data-testid="v2-agent-review" data-tour="v2-agent-review">
      <Icon name="eye" size="s" />
      <span className="v2-grow">
        <b>To review</b> · {reviewStripText(pending)}
      </span>
      <Button size="sm" icon="eye" onClick={() => navigate({ area: 'agent', id: sessionId, tab: 'changes' })} data-testid="v2-agent-review-changes">
        Open changes
      </Button>
      <Button size="sm" variant="primary" icon="check" disabled={busy} onClick={mark} data-testid="v2-agent-review-mark">
        Mark reviewed
      </Button>
    </div>
  );
}
