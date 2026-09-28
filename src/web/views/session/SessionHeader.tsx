import { useState } from 'react';
import type { AttachWarning, AttachWarningReason, Session } from '../../../core/api.ts';
import { ApiError, api } from '../../api/client.ts';
import { Link, type SessionTab } from '../../router.tsx';
import { statusColor } from '../../shell/format.ts';
import {
  ATTACH_ANYWAY,
  ATTACH_HERE,
  CANCEL,
  CONTINUE_IN_TERMINAL,
  actionErrorText,
  attachWarningText,
  pauseButton,
  rootLine,
  tabLabels,
} from './session-header.ts';

/** Props of {@link SessionHeader}. */
export interface SessionHeaderProps {
  readonly sessionId: string;
  /** `null` while loading or when there is no such session. */
  readonly session: Session | null;
  /** `true` when the service answered 404 for the id. */
  readonly missing: boolean;
  readonly tab: SessionTab;
  /** Changed files (`SessionDetail.files`) and session artifacts, for the tab counts. */
  readonly files: number;
  readonly artifacts: number;
  /** A header action changed the session: reload it. */
  readonly onChanged: () => void;
}

function isAttachWarning(error: unknown): AttachWarning | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const body = error.body as Partial<AttachWarning> | null;
  return body && body.error === 'attach-warning' && Array.isArray(body.reasons) ? (body as AttachWarning) : null;
}

/**
 * Session header (SPEC → Session; prototype `vSession` header): status dot, name,
 * root path, Pause / Resume (D7), "⇄ Continue in terminal" / "⇄ Attach here"
 * (M0.4), the chips (k v, mono; loop / workflow chips blue) and the tabs
 * Chat · Timeline · Diff · n · Artifacts · n.
 *
 * "⇄ Continue in terminal" = `POST /detach` (the D7 stop; the handoff card then
 * shows the command). "⇄ Attach here" = `POST /attach`; when a terminal may still
 * hold the session (gap #5) the service answers 409 `attach-warning`, the warning
 * shows here, and "Attach anyway" repeats it with `{ confirm: true }`.
 */
export function SessionHeader({ sessionId, session, missing, tab, files, artifacts, onChanged }: SessionHeaderProps) {
  const [busy, setBusy] = useState<'pause' | 'resume' | 'detach' | 'attach' | null>(null);
  const [warning, setWarning] = useState<readonly AttachWarningReason[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: NonNullable<typeof busy>, call: () => Promise<unknown>): Promise<void> => {
    if (busy) return;
    setBusy(action);
    setError(null);
    try {
      await call();
      setWarning(null);
    } catch (caught) {
      const attachWarning = action === 'attach' ? isAttachWarning(caught) : null;
      if (attachWarning) setWarning(attachWarning.reasons);
      else setError(caught instanceof ApiError ? actionErrorText(caught.status, caught.body) : actionErrorText(0, null));
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  const pause = session ? pauseButton(session) : null;
  const attached = session?.attached ?? true;

  return (
    <div className="sb-sv-header" data-testid="session-header" data-session-id={sessionId}>
      <div className="sb-sv-top">
        <span className="sb-sv-dot" data-testid="session-dot" style={{ background: statusColor(session?.status ?? 'idle') }} />
        <div className="sb-sv-name" data-testid="session-name">
          {session?.name ?? sessionId}
        </div>
        <div className="sb-sv-root" data-testid="session-root">
          {missing ? 'no such session' : session ? rootLine(session.cwd) : ''}
        </div>
        <div className="sb-sv-actions">
          <button
            type="button"
            className="sb-button sb-sv-action"
            data-testid="session-pause"
            data-action={pause?.action}
            disabled={!session || pause?.disabled || busy !== null}
            aria-busy={busy === 'pause' || busy === 'resume' || undefined}
            title={pause?.disabled ? 'Attach here first: a terminal owns the session' : undefined}
            onClick={() =>
              pause && void run(pause.action, () => (pause.action === 'pause' ? api.pauseSession(sessionId) : api.resumeSession(sessionId)))
            }
          >
            {pause?.label ?? 'Pause'}
          </button>
          <button
            type="button"
            className="sb-button sb-sv-action"
            data-testid="session-handoff"
            data-action={attached ? 'detach' : 'attach'}
            disabled={!session || busy !== null}
            aria-busy={busy === 'detach' || busy === 'attach' || undefined}
            onClick={() => void run(attached ? 'detach' : 'attach', () => (attached ? api.detachSession(sessionId) : api.attachSession(sessionId)))}
          >
            {attached ? CONTINUE_IN_TERMINAL : ATTACH_HERE}
          </button>
        </div>
      </div>
      {warning ? (
        <div className="sb-sv-warning" role="alertdialog" aria-label="Attach here" data-testid="attach-warning">
          <div className="sb-sv-warning-text" data-testid="attach-warning-text">
            {attachWarningText(warning)}
          </div>
          <div className="sb-sv-warning-actions">
            <button
              type="button"
              className="sb-button sb-sv-primary"
              data-testid="attach-confirm"
              disabled={busy !== null}
              onClick={() => void run('attach', () => api.attachSession(sessionId, true))}
            >
              {ATTACH_ANYWAY}
            </button>
            <button type="button" className="sb-button sb-sv-outlined" data-testid="attach-cancel" disabled={busy !== null} onClick={() => setWarning(null)}>
              {CANCEL}
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="sb-sv-error" role="alert" data-testid="session-error">
          {error}
        </div>
      ) : null}
      <div className="sb-sv-chips" data-testid="session-chips">
        {(session?.chips ?? []).map((chip) => (
          <span key={`${chip.k} ${chip.v}`} className="sb-sv-chip" data-testid="session-chip" data-loop={chip.loop ? 'true' : 'false'}>
            <span className="sb-sv-chip-k">{chip.k} </span>
            {chip.v}
          </span>
        ))}
      </div>
      <div className="sb-sv-tabs" role="tablist">
        {tabLabels(files, artifacts).map((entry) => (
          <Link
            key={entry.tab}
            to={{ view: 'session', id: sessionId, tab: entry.tab }}
            className="sb-sv-tab"
            role="tab"
            data-testid={`session-tab-${entry.tab}`}
            aria-selected={entry.tab === tab}
          >
            {entry.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
