import { useState } from 'react';
import type { Solution } from '../../core/api.ts';
import { api } from '../api/client.ts';
import { conflictCard, isolateErrorText } from './solutions-conflict.ts';

/**
 * The conflict warning card of the Solutions detail panel (M6.3, SPEC →
 * Solutions; prototype `sd.warn`): which sessions write the repo without a
 * worktree of their own, and one "Move … to worktree" action per session in the
 * main checkout. The action is `POST /api/solutions/{repo}/isolate` (gap #2):
 * the worktree is created, the session is paused and resumed with a message to
 * continue there; the developer's working tree is never touched. `onMoved`
 * reloads the list afterwards.
 */
export function SolutionConflictCard({ solution, onMoved }: { readonly solution: Solution; readonly onMoved: () => void }) {
  const card = conflictCard(solution);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!card) return null;

  const move = async (sessionId: string, repo: string): Promise<void> => {
    if (busy) return;
    setBusy(sessionId);
    setError(null);
    try {
      await api.isolate(repo, sessionId);
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
              title={action.title || undefined}
              onClick={() => void move(action.sessionId, action.repo)}
            >
              {action.label}
            </button>
          ))}
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
