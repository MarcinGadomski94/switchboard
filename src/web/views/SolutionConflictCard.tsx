import { useId, useState } from 'react';
import type { Solution } from '../../core/api.ts';
import { TICKET_BRANCH_EXAMPLE, checkTicketBranch, tidyTicketBranch } from '../../core/ticket-branch.ts';
import { api } from '../api/client.ts';
import { MOVE_CONFIRM, type MoveAction, conflictCard, isolateErrorText, moveConfirmText } from './solutions-conflict.ts';

/** D32: the confirm step of one action: its session and the Branch field as typed (`null` = the suggestion). */
interface Confirming {
  readonly action: MoveAction;
  readonly branch: string | null;
}

/**
 * The conflict warning card of the Solutions detail panel (M6.3, SPEC →
 * Solutions; prototype `sd.warn`): which sessions write the repo without a
 * worktree of their own, and one "Move … to worktree" action per session in the
 * main checkout. D32: an action first opens a confirm step under the buttons
 * that asks for the new worktree's branch, named after the ticket (pre-filled
 * from a title that starts with a ticket key, tidied on blur, its check under
 * it); its "Move to worktree" is `POST /api/solutions/{repo}/isolate
 * { sessionId, branch }` (gap #2): the worktree is created, the session is
 * paused and resumed with a message to continue there; the developer's working
 * tree is never touched. `onMoved` reloads the list afterwards.
 */
export function SolutionConflictCard({ solution, onMoved }: { readonly solution: Solution; readonly onMoved: () => void }) {
  const card = conflictCard(solution);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const noteId = useId();
  if (!card) return null;

  // The confirmed session may have left the card (moved by another click, or ended).
  const open = confirming && card.actions.some((action) => action.sessionId === confirming.action.sessionId) ? confirming : null;
  const branch = open ? (open.branch ?? open.action.suggestedBranch) : '';
  const check = checkTicketBranch(branch);

  const ask = (action: MoveAction): void => {
    if (busy) return;
    setError(null);
    setConfirming(open?.action.sessionId === action.sessionId ? null : { action, branch: null });
  };

  const move = async (): Promise<void> => {
    if (busy || !open || !check.ok) return;
    const { action } = open;
    setBusy(action.sessionId);
    setError(null);
    try {
      await api.isolate(action.repo, action.sessionId, check.name);
      setConfirming(null);
      onMoved();
    } catch (caught) {
      setError(isolateErrorText(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="sb-sol-conflict" data-testid="conflict-card">
      <div className="sb-sol-conflict-text" data-testid="conflict-text">
        {card.text}
      </div>
      {card.actions.length > 0 ? (
        <div className="sb-sol-conflict-actions">
          {card.actions.map((action) => (
            <button
              key={action.sessionId}
              type="button"
              className="sb-button sb-sol-move"
              data-testid="conflict-move"
              data-session={action.sessionId}
              disabled={action.disabled || busy !== null}
              aria-busy={busy === action.sessionId || undefined}
              aria-expanded={open?.action.sessionId === action.sessionId}
              title={action.title || undefined}
              onClick={() => ask(action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
      {open ? (
        <div className="sb-sol-move-confirm" data-testid="conflict-confirm" data-session={open.action.sessionId}>
          <div className="sb-sol-move-confirm-text" data-testid="conflict-confirm-text">
            {moveConfirmText(open.action)}
          </div>
          <div className="sb-sol-move-confirm-row">
            <input
              className="sb-sol-move-branch"
              data-testid="conflict-branch"
              aria-label="Branch"
              aria-invalid={!check.ok}
              aria-describedby={noteId}
              value={branch}
              placeholder={TICKET_BRANCH_EXAMPLE}
              spellCheck={false}
              autoComplete="off"
              disabled={busy !== null}
              onChange={(event) => {
                setConfirming({ action: open.action, branch: event.target.value });
                setError(null);
              }}
              onBlur={() => {
                if (open.branch === null) return;
                const tidy = tidyTicketBranch(open.branch);
                if (tidy !== open.branch) setConfirming({ action: open.action, branch: tidy });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void move();
                if (event.key === 'Escape') setConfirming(null);
              }}
            />
            <button type="button" className="sb-button sb-sol-move" data-testid="conflict-confirm-move" disabled={!check.ok || busy !== null} aria-busy={busy !== null || undefined} onClick={() => void move()}>
              {MOVE_CONFIRM}
            </button>
            <button type="button" className="sb-button sb-sol-move-cancel" data-testid="conflict-confirm-cancel" disabled={busy !== null} onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </div>
          <div id={noteId} className="sb-sol-move-branch-note" data-testid="conflict-branch-note" data-ok={check.ok ? 'true' : 'false'}>
            {check.ok ? '⎇ the branch of the new worktree' : check.message}
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="sb-sol-conflict-error" role="alert" data-testid="conflict-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}
