import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { ApiError, api } from '../api/client.ts';
import { type TakeoverPreview, type TakeoverRun, type TargetPlacement, HOOKED_STOP_WARNING } from '../../core/takeover.ts';
import { useRouter } from '../router.tsx';
import { closeTakeover, useTakeoverRequest } from './store.ts';
import { canStart, clonePathsOf, dialogTitle, runHeadline, stepMark, withRepoPath } from './takeover.ts';
import { RepoTable, TargetFolderPicker } from './TargetFolders.tsx';
import type { TakeoverRequest } from './takeover.ts';
import './takeover.css';

/** The dialog's own text of a failure. */
function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: unknown; errors?: Array<{ message?: unknown }> } | null;
    if (body && typeof body.message === 'string') return body.message;
    if (body && Array.isArray(body.errors) && typeof body.errors[0]?.message === 'string') return body.errors[0].message;
    return error.status === 0 ? 'Switchboard could not be reached' : `HTTP ${error.status}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Mounted once in the shell: the open take-over dialog, if any (`docs/peers.md` → *Taking a session over*). */
export function TakeoverHost() {
  const request = useTakeoverRequest();
  return request ? <TakeoverDialog key={`${request.sessionId}:${request.targetMachine ?? ''}`} request={request} /> : null;
}

/**
 * D65: **Take over to this machine** (a peer's session) / **Move to <machine>**
 * (this machine's session). It shows both machines' view first (the repos and what
 * happens to each: branch, uncommitted files, a clone needed with its path, the
 * stop warning of a hooked terminal, the CLI and the account on the target), asks
 * for the confirmation a hooked terminal needs, then shows the steps as they run
 * and, at the end, the new session (or the error and what was undone) and any
 * temporary branch that is still on the remote with its one-click delete.
 */
export function TakeoverDialog({ request }: { readonly request: TakeoverRequest }) {
  const { navigate } = useRouter();
  const direction = request.targetMachine === null ? 'take-over' : 'move';
  const [preview, setPreview] = useState<TakeoverPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});
  // D110: the folders chosen on the target (`null` = its saved folders); the preview says which it used.
  const [placement, setPlacement] = useState<TargetPlacement | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [run, setRun] = useState<TakeoverRun | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [deleted, setDeleted] = useState<Record<string, string>>({});
  const timer = useRef<number | undefined>(undefined);
  const running = starting || (run !== null && run.state === 'running');

  const loadPreview = (paths: Record<string, string> = {}, chosen: TargetPlacement | null | undefined = undefined): void => {
    setPreviewError(null);
    api
      .takeoverPreview({ sessionId: request.sessionId, targetMachine: request.targetMachine, ...(Object.keys(paths).length > 0 ? { clonePaths: paths } : {}), ...(chosen !== undefined ? { placement: chosen } : {}) })
      .then((next) => {
        setPreview(next);
        setPlacement(next.placement);
        setTyped((current) => {
          const out = { ...current };
          for (const repo of next.target.repos) if (repo.cloneTo && out[repo.key] === undefined) out[repo.key] = repo.cloneTo;
          return out;
        });
      })
      .catch((error: unknown) => setPreviewError(errorText(error)));
  };
  useEffect(() => {
    loadPreview();
    return () => window.clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !running) closeTakeover();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running]);

  const poll = (id: string): void => {
    api
      .takeoverRun(id)
      .then((next) => {
        setRun(next);
        if (next.state === 'running') timer.current = window.setTimeout(() => poll(id), 400);
      })
      .catch((error: unknown) => {
        setStartError(errorText(error));
        timer.current = window.setTimeout(() => poll(id), 1_500);
      });
  };

  const start = (): void => {
    if (!preview || !canStart(preview, confirmed, typed) || running) return;
    setStarting(true);
    setStartError(null);
    api
      .takeoverStart({
        sessionId: request.sessionId,
        targetMachine: request.targetMachine,
        clonePaths: clonePathsOf(preview, typed),
        ...(placement ? { placement } : {}),
        confirmStopTerminal: confirmed,
      })
      .then((next) => {
        setRun(next);
        poll(next.id);
      })
      .catch((error: unknown) => setStartError(errorText(error)))
      .finally(() => setStarting(false));
  };

  const sourceName = direction === 'take-over' ? request.machineName : (preview?.source.machine.name ?? 'this machine');
  const targetName = direction === 'take-over' ? (preview?.target.machine.name ?? 'this machine') : request.machineName;
  const finished = run !== null && run.state !== 'running';
  const close = (): void => {
    if (!running) closeTakeover();
  };
  const open = (): void => {
    if (run?.result) navigate({ view: 'session', id: run.result.sessionId, tab: 'chat' });
    closeTakeover();
  };
  const deleteLeftover = (machineId: string | null, id: string): void => {
    api
      .takeoverDeleteLeftover(machineId, id)
      .then(() => setDeleted((current) => ({ ...current, [id]: 'Deleted' })))
      .catch((error: unknown) => setDeleted((current) => ({ ...current, [id]: errorText(error) })));
  };

  return (
    <div className="sb-takeover-overlay" data-testid="takeover-overlay" onClick={close}>
      <div className="sb-takeover" role="dialog" aria-modal="true" aria-label={dialogTitle(direction, request.machineName)} data-testid="takeover-dialog" data-state={run ? run.state : preview ? 'preview' : 'loading'} onClick={(event: MouseEvent) => event.stopPropagation()}>
        <div className="sb-takeover-head">
          <div className="sb-takeover-title" data-testid="takeover-title">
            {dialogTitle(direction, request.machineName)}
          </div>
          <div className="sb-takeover-sub" data-testid="takeover-sub">
            {request.title} · {sourceName} → {targetName}
          </div>
        </div>
        <div className="sb-takeover-body">
          {previewError ? (
            <div className="sb-takeover-error" role="alert" data-testid="takeover-preview-error">
              {previewError}
            </div>
          ) : null}
          {!preview && !previewError ? <div className="sb-takeover-note" data-testid="takeover-loading">Checking both machines…</div> : null}
          {preview && !run ? (
            <>
              <div className="sb-takeover-section" data-testid="takeover-cli">
                {preview.target.cli.label} on the account “{preview.target.account.name}” of {preview.target.machine.name}
                {preview.target.cli.available ? '' : ` — ${preview.target.cli.reason ?? 'not available'}`}
              </div>
              <div className="sb-takeover-note" data-testid="takeover-conversation">
                {preview.source.conversation.kind === 'claude-transcript'
                  ? `The conversation is copied (${preview.source.conversation.files.length} file${preview.source.conversation.files.length === 1 ? '' : 's'}) and resumed with --resume.`
                  : (preview.source.conversation.note ?? 'The conversation is handed over.')}
              </div>
              <TargetFolderPicker
                machine={direction === 'move' ? request.targetMachine : null}
                machineName={targetName}
                placement={placement}
                remembered={preview.remembered}
                onChange={(next) => {
                  setPlacement(next);
                  // `null` = the saved folders again (the remembered ones are not re-applied).
                  loadPreview(clonePathsOf(preview, typed), next);
                }}
              />
              <RepoTable
                preview={preview}
                sourceName={sourceName}
                targetName={targetName}
                clonePaths={typed}
                onClonePath={(key, value) => setTyped((current) => ({ ...current, [key]: value }))}
                onCloneDone={() => loadPreview(clonePathsOf(preview, typed), placement)}
                onPick={(key, value) => {
                  const next = withRepoPath(placement, key, value);
                  setPlacement(next);
                  loadPreview(clonePathsOf(preview, typed), next);
                }}
              />
              {preview.stopsTerminal ? (
                <label className="sb-takeover-warning" data-testid="takeover-hooked-warning">
                  <span>{HOOKED_STOP_WARNING}</span>
                  <span className="sb-takeover-confirm">
                    <input type="checkbox" data-testid="takeover-confirm" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                    Stop that terminal's claude and take the session over
                  </span>
                </label>
              ) : null}
              {preview.blockers.length > 0 ? (
                <div className="sb-takeover-error" role="alert" data-testid="takeover-blockers">
                  {preview.blockers.map((blocker) => (
                    <div key={blocker}>{blocker}</div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
          {run ? (
            <>
              <div className="sb-takeover-headline" data-testid="takeover-headline" aria-live="polite">
                {runHeadline(run, request.machineName)}
              </div>
              <ol className="sb-takeover-steps" data-testid="takeover-steps">
                {run.steps.map((step) => (
                  <li key={step.id} className="sb-takeover-step" data-testid="takeover-step" data-step={step.id} data-status={step.status}>
                    <span className="sb-takeover-mark">{stepMark(step.status)}</span>
                    <span className="sb-takeover-step-label">{step.label}</span>
                    {step.detail ? <span className="sb-takeover-step-detail">{step.detail}</span> : null}
                  </li>
                ))}
              </ol>
              {run.error ? (
                <div className="sb-takeover-error" role="alert" data-testid="takeover-error">
                  {run.error.message}
                  {run.rollbackNotes.map((note) => (
                    <div key={note} data-testid="takeover-rollback-note">
                      {note}
                    </div>
                  ))}
                </div>
              ) : null}
              {run.leftovers.length > 0 ? (
                <div className="sb-takeover-leftovers" data-testid="takeover-leftovers">
                  {run.leftovers.map((leftover) => (
                    <div key={leftover.branch} className="sb-takeover-leftover" data-testid="takeover-leftover">
                      <span>
                        Temporary branch <code>{leftover.branch}</code> is still on {leftover.remoteName}
                        {leftover.reason ? ` (${leftover.reason})` : ''}
                      </span>
                      {leftover.id !== '' ? (
                        deleted[leftover.id] ? (
                          <span data-testid="takeover-leftover-result">{deleted[leftover.id]}</span>
                        ) : (
                          <button type="button" className="sb-button sb-takeover-outlined" data-testid="takeover-leftover-delete" onClick={() => deleteLeftover(leftover.machineId, leftover.id)}>
                            Delete it
                          </button>
                        )
                      ) : (
                        <span>delete it with <code>git push {leftover.remoteName} --delete {leftover.branch}</code></span>
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
              <button type="button" className="sb-takeover-link" data-testid="takeover-log-toggle" aria-expanded={showLog} onClick={() => setShowLog((open) => !open)}>
                {showLog ? 'Hide' : 'Show'} the git commands
              </button>
              {showLog ? (
                <pre className="sb-takeover-log" data-testid="takeover-log">
                  {run.log.join('\n')}
                </pre>
              ) : null}
            </>
          ) : null}
          {startError ? (
            <div className="sb-takeover-error" role="alert" data-testid="takeover-start-error">
              {startError}
            </div>
          ) : null}
        </div>
        <div className="sb-takeover-footer">
          {finished && run?.state === 'done' && run.result ? (
            <button type="button" className="sb-button sb-takeover-primary" data-testid="takeover-open" onClick={open}>
              Open the session
            </button>
          ) : null}
          {!run ? (
            <button type="button" className="sb-button sb-takeover-primary" data-testid="takeover-start" disabled={!canStart(preview, confirmed, typed) || running} aria-busy={running || undefined} onClick={start}>
              {direction === 'take-over' ? 'Take over' : 'Move'}
            </button>
          ) : null}
          <button type="button" className="sb-button sb-takeover-outlined" data-testid="takeover-close" disabled={running} onClick={close}>
            {finished ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}
