import { useId, useState } from 'react';
import type { Solution } from '../../core/api.ts';
import { TICKET_BRANCH_EXAMPLE, checkTicketBranch, tidyTicketBranch } from '../../core/ticket-branch.ts';
import { api } from '../api/client.ts';
import { BRANCH_MODE_LABELS, type BranchMode, existingConfirmText, isolateBody, pickedBranch, pickerNote } from './branch-picker.ts';
import { ExistingBranchPicker, useRepoBranches } from './ExistingBranchPicker.tsx';
import { MOVE_CONFIRM, type MoveAction, conflictCard, isolateErrorText, moveConfirmText } from './solutions-conflict.ts';

/**
 * D32: the confirm step of one action: its session and the Branch field as typed
 * (`null` = the suggestion). D60: the choice (a new branch or an existing one),
 * the picker's search and the picked branch's name.
 */
interface Confirming {
  readonly action: MoveAction;
  readonly branch: string | null;
  readonly mode: BranchMode;
  readonly search: string;
  readonly picked: string | null;
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
 * tree is never touched. `onMoved` reloads the list afterwards. D60: the step
 * offers **New branch** (the D32 field) or **Existing branch** (a searchable
 * list of the repo's local and remote branches, `ExistingBranchPicker`); the
 * latter posts `{ sessionId, existingBranch }`.
 */
export function SolutionConflictCard({ solution, onMoved }: { readonly solution: Solution; readonly onMoved: () => void }) {
  const card = conflictCard(solution);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const noteId = useId();
  // The confirmed session may have left the card (moved by another click, or ended).
  const open = card && confirming && card.actions.some((action) => action.sessionId === confirming.action.sessionId) ? confirming : null;
  const existing = open?.mode === 'existing';
  // D60: before the early return (a hook); `null` = nothing loaded.
  const picker = useRepoBranches(existing && open ? { repo: open.action.repo, sessionId: open.action.sessionId } : null);
  if (!card) return null;

  const branch = open ? (open.branch ?? open.action.suggestedBranch) : '';
  const check = checkTicketBranch(branch);
  const picked = existing ? pickedBranch(picker.load.list?.branches ?? null, open?.picked ?? null) : null;
  const note = pickerNote(picked);
  const ready = existing ? picked !== null : check.ok;

  const ask = (action: MoveAction): void => {
    if (busy) return;
    setError(null);
    setConfirming(open?.action.sessionId === action.sessionId ? null : { action, branch: null, mode: 'new', search: '', picked: null });
  };

  const update = (patch: Partial<Omit<Confirming, 'action'>>): void => {
    if (!open) return;
    setConfirming({ ...open, ...patch });
    setError(null);
  };

  const move = async (): Promise<void> => {
    if (busy || !open || !ready) return;
    const { action } = open;
    const body = picked ? isolateBody(action.sessionId, { mode: 'existing', branch: picked }) : check.ok ? isolateBody(action.sessionId, { mode: 'new', branch: check.name }) : null;
    if (!body) return;
    setBusy(action.sessionId);
    setError(null);
    try {
      await api.isolate(action.repo, body);
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
          <div className="sb-sol-move-mode" role="radiogroup" aria-label="Branch of the worktree" data-testid="conflict-mode">
            {(['new', 'existing'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                className="sb-button sb-sol-move-mode-option"
                data-testid={`conflict-mode-${mode}`}
                aria-checked={open.mode === mode}
                disabled={busy !== null}
                onClick={() => update({ mode })}
              >
                {BRANCH_MODE_LABELS[mode]}
              </button>
            ))}
          </div>
          <div className="sb-sol-move-confirm-text" data-testid="conflict-confirm-text">
            {existing ? existingConfirmText(open.action) : moveConfirmText(open.action)}
          </div>
          {existing ? (
            <>
              <ExistingBranchPicker
                load={picker.load}
                search={open.search}
                picked={open.picked}
                disabled={busy !== null}
                onSearch={(search) => update({ search })}
                onPick={(choice) => update({ picked: choice.name })}
                onRefresh={picker.refresh}
                onEnter={() => void move()}
                onEscape={() => setConfirming(null)}
              />
              <div className="sb-sol-move-confirm-row sb-sol-move-confirm-end">
                <button type="button" className="sb-button sb-sol-move" data-testid="conflict-confirm-move" disabled={!ready || busy !== null} aria-busy={busy !== null || undefined} onClick={() => void move()}>
                  {MOVE_CONFIRM}
                </button>
                <button type="button" className="sb-button sb-sol-move-cancel" data-testid="conflict-confirm-cancel" disabled={busy !== null} onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </div>
              <div className="sb-sol-move-branch-note" data-testid="conflict-branch-note" data-ok={note.ok ? 'true' : 'false'}>
                {note.text}
              </div>
            </>
          ) : (
            <>
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
              onChange={(event) => update({ branch: event.target.value })}
              onBlur={() => {
                if (open.branch === null) return;
                const tidy = tidyTicketBranch(open.branch);
                if (tidy !== open.branch) setConfirming({ ...open, branch: tidy });
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
            </>
          )}
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
