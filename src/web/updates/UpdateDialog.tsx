import { type MouseEvent, useState } from 'react';
import { confirmText, gitUpdateCommands, installKindLabel, manualStartCommand, phaseText, sessionsNote, updateRunning } from '../../core/updates.ts';
import { ApiError, api } from '../api/client.ts';
import { ReleaseNotes } from './ReleaseNotes.tsx';
import { canUpdate } from './updates-view.ts';
import { useUpdates } from './useUpdates.ts';
import './updates.css';

function refusal(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: unknown } | null;
    if (body && typeof body.message === 'string') return body.message;
    return error.unreachable ? 'Switchboard is not reachable.' : `HTTP ${error.status}`;
  }
  return String(error);
}

/**
 * D55 "What's new" (`docs/updates.md` → *The UI*): the newest release's notes
 * (Markdown), and for a release install **Update** with a confirmation that
 * says what happens and how many sessions resume after the restart; the
 * update's progress while it runs; for a git checkout the commands instead
 * (no Update). Opened from the banner, the Inbox item (through Settings) and
 * Settings → Updates.
 */
export function UpdateDialog({ onClose, confirm = false }: { readonly onClose: () => void; readonly confirm?: boolean }) {
  const { status, set } = useUpdates();
  const [confirming, setConfirming] = useState(confirm);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!status) return null;
  const latest = status.latest;
  const running = updateRunning(status.progress);
  const start = async (): Promise<void> => {
    if (!latest) return;
    setBusy(true);
    setError(null);
    try {
      set(await api.installUpdate(latest.version));
      setConfirming(false);
    } catch (caught) {
      setError(refusal(caught));
    } finally {
      setBusy(false);
    }
  };
  const progress = status.progress.phase !== 'idle' ? phaseText(status.progress) : '';
  return (
    <div className="sb-update-overlay" data-testid="update-dialog-overlay" onClick={() => (running ? undefined : onClose())}>
      <div className="sb-update-dialog" role="dialog" aria-modal="true" aria-label="What's new" data-testid="update-dialog" onClick={(event: MouseEvent) => event.stopPropagation()}>
        <div className="sb-update-head">
          <div className="sb-update-title">{latest ? latest.name : 'Switchboard updates'}</div>
          <div className="sb-update-sub" data-testid="update-dialog-sub">
            {`You run ${status.current} · ${installKindLabel(status.install.kind)}`}
            {latest?.publishedAt ? ` · released ${new Date(latest.publishedAt).toLocaleDateString()}` : ''}
          </div>
        </div>
        <div className="sb-update-body">
          {latest ? <ReleaseNotes notes={latest.notes} /> : <div className="sb-update-muted">No release found yet.</div>}
          {latest?.url ? (
            <a className="sb-update-link" href={latest.url} target="_blank" rel="noopener noreferrer">
              The release on GitHub ↗
            </a>
          ) : null}
          {status.install.kind === 'git' && status.available && latest ? (
            <div className="sb-update-git" data-testid="update-git">
              <div>This is a git checkout, so Switchboard does not update itself. Update it with:</div>
              <pre className="sb-update-code">{gitUpdateCommands(latest.tag).join('\n')}</pre>
            </div>
          ) : null}
          {confirming && latest && canUpdate(status) ? (
            <div className="sb-update-confirm" data-testid="update-confirm">
              <div>{confirmText(latest.version, status.restart)}</div>
              {status.restart === 'service' && sessionsNote(status.liveSessions) ? <div data-testid="update-sessions">{sessionsNote(status.liveSessions)}</div> : null}
            </div>
          ) : null}
          {progress ? (
            <div className="sb-update-progress" data-testid="update-progress" data-phase={status.progress.phase}>
              {progress}
              {status.progress.phase === 'restart-manually' && status.progress.dir ? (
                <pre className="sb-update-code">{manualStartCommand(status.progress.dir)}</pre>
              ) : null}
              {status.progress.message ? <div className="sb-update-muted">{status.progress.message}</div> : null}
            </div>
          ) : null}
          {error ? (
            <div className="sb-update-error" role="alert" data-testid="update-error">
              {error}
            </div>
          ) : null}
        </div>
        <div className="sb-update-footer">
          {canUpdate(status) && !confirming ? (
            <button type="button" className="sb-button sb-update-primary" data-testid="update-start" onClick={() => setConfirming(true)}>
              {`Update to ${latest?.version ?? ''}`}
            </button>
          ) : null}
          {canUpdate(status) && confirming ? (
            <>
              <button type="button" className="sb-button sb-update-primary" data-testid="update-confirm-button" disabled={busy} onClick={() => void start()}>
                {status.restart === 'service' ? 'Update and restart' : 'Update'}
              </button>
              <button type="button" className="sb-button sb-update-outlined" data-testid="update-cancel" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : null}
          <button type="button" className="sb-button sb-update-outlined" data-testid="update-close" disabled={running} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
