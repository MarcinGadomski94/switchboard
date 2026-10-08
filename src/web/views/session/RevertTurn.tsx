import { type KeyboardEvent, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { type CheckpointFileChange, type CheckpointPlan, type CheckpointRepoPlan, FILES_ONLY_LABEL, REDO_LABEL, REVERT_TURN_LABEL } from '../../../core/checkpoints.ts';
import { ApiError, api } from '../../api/client.ts';
import { actionErrorText } from './session-header.ts';
import { type RevertRequest, type TurnRevert, closeRevert, openRevert, refreshCheckpoints, useRevertRequest } from './checkpoints.ts';
import './revert.css';

/** Mounted once in the shell: the open revert confirmation, if any (over the page, through a portal). */
export function RevertHost() {
  const request = useRevertRequest();
  return request ? <RevertDialog key={`${request.sessionId}:${request.turn}`} request={request} /> : null;
}

/** The mark of a file in the confirmation: what the revert does with it. */
const CHANGE_MARKS: Readonly<Record<CheckpointFileChange['change'], { readonly mark: string; readonly title: string }>> = {
  added: { mark: '+', title: 'restored (it was there before this turn)' },
  modified: { mark: '~', title: 'changed back' },
  deleted: { mark: '−', title: 'removed (made after this turn began)' },
};

/** `turns N..M` / `turn N`. */
function turnsText(plan: CheckpointPlan): string {
  return plan.latestTurn > plan.turn ? `turns ${plan.turn}..${plan.latestTurn}` : `turn ${plan.turn}`;
}

/** What happens to one working tree's branch, as a line (`null` = nothing). */
function headLine(repo: CheckpointRepoPlan): string | null {
  const { head } = repo;
  if (head.action === 'reset') return `${head.branch ?? 'HEAD'} goes back ${head.commits} commit${head.commits === 1 ? '' : 's'} (the agent's, not pushed)`;
  if (head.action === 'refused') return head.reason;
  return null;
}

function errorOf(caught: unknown): ApiError {
  return caught instanceof ApiError ? caught : new ApiError(0, String(caught));
}

/**
 * D80: "Revert to before turn N?" (`docs/undo.md` → *The confirmation*): the
 * message's first line, what goes (turns N..M), every file that changes per working
 * tree (+ restored, ~ changed back, − removed; ignored files are never touched), and
 * what happens to the branch. When the branch cannot go back (another branch, a
 * rewritten history, pushed commits) the reason shows and only **Revert files only**
 * is offered. Esc, a click outside and Cancel close it; Cancel has the focus.
 */
export function RevertDialog({ request }: { readonly request: RevertRequest }) {
  const [plan, setPlan] = useState<CheckpointPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.checkpointPlan(request.sessionId, request.turn).then(
      (answer) => {
        if (live) setPlan(answer);
      },
      (caught: unknown) => {
        const failed = errorOf(caught);
        if (live) setError(actionErrorText(failed.status, failed.body));
      },
    );
    return () => {
      live = false;
    };
  }, [request.sessionId, request.turn]);

  const revert = (filesOnly: boolean): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    api.revertTurn(request.sessionId, request.turn, filesOnly).then(
      () => {
        setBusy(false);
        closeRevert();
        refreshCheckpoints(request.sessionId);
      },
      (caught: unknown) => {
        const failed = errorOf(caught);
        const body = failed.body as { error?: unknown; plan?: CheckpointPlan } | null;
        setBusy(false);
        // The branch stopped being movable meanwhile: the dialog shows why and offers files only.
        if (body?.error === 'files-only-needed' && body.plan) setPlan(body.plan);
        else setError(actionErrorText(failed.status, failed.body));
        refreshCheckpoints(request.sessionId);
      },
    );
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!busy) closeRevert();
    }
  };
  const nothing = plan !== null && plan.repos.every((repo) => repo.fileCount === 0 && repo.head.action !== 'reset');

  return createPortal(
    <div className="sb-revert-overlay" data-testid="revert-overlay" onClick={busy ? undefined : closeRevert} onKeyDown={onKeyDown}>
      <div
        className="sb-revert-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="sb-revert-title"
        data-testid="revert-dialog"
        data-turn={request.turn}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sb-revert-title" id="sb-revert-title" data-testid="revert-title">
          Revert to before turn {request.turn}?
        </div>
        {plan ? (
          <>
            {plan.firstLine ? (
              <div className="sb-revert-quote" data-testid="revert-quote">
                {plan.firstLine}
              </div>
            ) : null}
            <div className="sb-revert-text" data-testid="revert-text">
              The files go back to how they were before this turn: the changes of {turnsText(plan)} are undone. The conversation stays; the agent is told with
              your next message. Ignored files are left alone. Redo undoes the revert.
            </div>
            <div className="sb-revert-repos" data-testid="revert-repos">
              {plan.repos.map((repo) => (
                <div className="sb-revert-repo" key={repo.path} data-testid="revert-repo" data-name={repo.name} title={repo.path}>
                  <div className="sb-revert-repo-head">
                    <span className="sb-revert-repo-name">{repo.name}</span>
                    <span className="sb-revert-repo-count" data-testid="revert-file-count">
                      {repo.fileCount === 0 ? 'no file changes' : `${repo.fileCount} file${repo.fileCount === 1 ? '' : 's'}`}
                    </span>
                  </div>
                  {headLine(repo) ? (
                    <div className="sb-revert-branch" data-testid="revert-branch" data-action={repo.head.action}>
                      {headLine(repo)}
                    </div>
                  ) : null}
                  {repo.files.length > 0 ? (
                    <ul className="sb-revert-files" data-testid="revert-files">
                      {repo.files.map((file) => (
                        <li key={file.path} className="sb-revert-file" data-testid="revert-file" data-change={file.change} title={CHANGE_MARKS[file.change].title}>
                          <span className="sb-revert-mark" aria-hidden="true">
                            {CHANGE_MARKS[file.change].mark}
                          </span>
                          <span className="sb-revert-path">{file.path}</span>
                        </li>
                      ))}
                      {repo.fileCount > repo.files.length ? <li className="sb-revert-more">…and {repo.fileCount - repo.files.length} more</li> : null}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
            {nothing ? (
              <div className="sb-revert-text" data-testid="revert-nothing">
                Nothing changes: the files are as they were before this turn.
              </div>
            ) : null}
            {plan.filesOnlyReason ? (
              <div className="sb-revert-warning" role="note" data-testid="revert-files-only-reason">
                {plan.filesOnlyReason}
              </div>
            ) : null}
          </>
        ) : error ? null : (
          <div className="sb-revert-text" data-testid="revert-loading">
            Reading what changed…
          </div>
        )}
        {error ? (
          <div className="sb-revert-error" role="alert" data-testid="revert-error">
            {error}
          </div>
        ) : null}
        <div className="sb-revert-actions">
          {plan ? (
            <button
              type="button"
              className="sb-button sb-revert-primary"
              data-testid={plan.filesOnlyReason ? 'revert-files-only' : 'revert-confirm'}
              disabled={busy}
              aria-busy={busy || undefined}
              onClick={() => revert(plan.filesOnlyReason !== null)}
            >
              {plan.filesOnlyReason ? FILES_ONLY_LABEL : 'Revert'}
            </button>
          ) : null}
          <button type="button" className="sb-button sb-revert-outlined" data-testid="revert-cancel" disabled={busy} autoFocus onClick={closeRevert}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Glyph of the turn action (↶, drawn so it has no text: the bubble's copy stays the message). */
function RevertGlyph() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
      <path d="M4.2 2.6 1.8 5l2.4 2.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.1 5h5.2a2.8 2.8 0 0 1 0 5.6H5.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * D80: the action beside a user bubble (left of it, shown on hover and focus; on a
 * touch screen always, faintly): opens the confirmation of a revert to before that
 * turn. Disabled with the reason as its tooltip when the turn has no checkpoint or a
 * turn runs. Icon only and absolutely placed: the bubble keeps its box and copy.
 */
export function TurnRevertButton({ sessionId, revert }: { readonly sessionId: string; readonly revert: TurnRevert }) {
  const label = revert.reason ?? `${REVERT_TURN_LABEL} (turn ${revert.turn})`;
  return (
    <button
      type="button"
      className="sb-chat-revert"
      data-testid="chat-revert"
      data-tour="undo-turn"
      data-turn={revert.turn ?? undefined}
      data-disabled={revert.reason ? 'true' : undefined}
      aria-label={revert.reason ? `${REVERT_TURN_LABEL}: ${revert.reason}` : `${REVERT_TURN_LABEL} (turn ${revert.turn})`}
      aria-disabled={revert.reason ? true : undefined}
      title={label}
      onClick={() => {
        if (revert.turn !== null && revert.reason === null) openRevert({ sessionId, turn: revert.turn });
      }}
    >
      <RevertGlyph />
    </button>
  );
}

/** D80: Redo on the newest revert's divider (undoes it; gone once a message was sent after it). */
export function RedoButton({ sessionId }: { readonly sessionId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const redo = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    api.redoRevert(sessionId).then(
      () => {
        setBusy(false);
        refreshCheckpoints(sessionId);
      },
      (caught: unknown) => {
        const failed = errorOf(caught);
        setBusy(false);
        setError(actionErrorText(failed.status, failed.body));
        refreshCheckpoints(sessionId);
      },
    );
  };
  return (
    <>
      <button type="button" className="sb-chat-redo" data-testid="chat-redo" disabled={busy} aria-busy={busy || undefined} title="Undo this revert: the files (and the branch) come back as they were before it" onClick={redo}>
        {REDO_LABEL}
      </button>
      {error ? (
        <span className="sb-chat-redo-error" role="alert" data-testid="chat-redo-error">
          {error}
        </span>
      ) : null}
    </>
  );
}
