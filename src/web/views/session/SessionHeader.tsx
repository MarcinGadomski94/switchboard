import { useEffect, useState } from 'react';
import type { AttachWarning, AttachWarningReason, Session } from '../../../core/api.ts';
import { REMOTE_COPY_NOTE, remoteSessionUrl } from '../../../core/remote-session.ts';
import { CLOSE_LABEL, REOPEN_LABEL, isClosed } from '../../../core/session-close.ts';
import { ApiError, api } from '../../api/client.ts';
import { useCloseSession } from '../../components/CloseSession.tsx';
import { InlineTitle } from '../../components/InlineTitle.tsx';
import { PhoneGlyph } from '../../components/PhoneGlyph.tsx';
import { Link, type SessionTab, useRouter } from '../../router.tsx';
import { statusColor } from '../../shell/format.ts';
import {
  ATTACH_ANYWAY,
  ATTACH_HERE,
  CANCEL,
  CONTINUE_IN_TERMINAL,
  REMOTE_LABEL,
  REMOTE_LINK_LABEL,
  actionErrorText,
  attachWarningText,
  pauseButton,
  remoteToggle,
  rootLine,
  tabLabels,
} from './session-header.ts';
import { ModelPicker } from './ModelPicker.tsx';
import { RemotePopover } from './RemotePopover.tsx';

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
 * Session header (SPEC → Session; prototype `vSession` header): status dot, name
 * (D22: its display title; a click renames it in place, `InlineTitle`),
 * root path, Pause / Resume (D7), "⇄ Continue in terminal" / "⇄ Attach here"
 * (M0.4), the chips (k v, mono; loop / workflow chips blue) and the tabs
 * Chat · Timeline · Diff · n · Artifacts · n.
 *
 * "⇄ Continue in terminal" = `POST /detach` (the D7 stop; the handoff card then
 * shows the command). "⇄ Attach here" = `POST /attach`; when a terminal may still
 * hold the session (gap #5) the service answers 409 `attach-warning`, the warning
 * shows here, and "Attach anyway" repeats it with `{ confirm: true }`.
 *
 * D24: a **Remote** toggle before Pause (`PUT /api/sessions/{id}/remote`), off by
 * default, disabled with the reason as its tooltip unless the process is live and
 * Remote Control is available; while it is on, "Link & QR" opens the popover (the
 * claude.ai link, its QR code, the transcript note), which also opens by itself
 * once Remote is turned on. A refusal shows the server's text (the CLI's, verbatim).
 * Sessions without Remote state (`remote: null`, the demo's) show no toggle.
 * D25: a local copy of a remote session gets a note under the top row (new work
 * stays local) with a link to the remote session on claude.ai.
 * D31: the model and effort picker (`Opus 5.5 · high ▾`, {@link ModelPicker}) is
 * the first header action; sessions without model information (the demo's) show none.
 * D33: **Close** first among the actions (so Pause and "Continue in terminal" keep
 * the prototype's places): it closes the session, asking first while it runs or
 * waits (`useCloseSession`), then the Inbox opens. A closed session (reached by
 * its address) shows **Reopen** there instead.
 */
export function SessionHeader({ sessionId, session, missing, tab, files, artifacts, onChanged }: SessionHeaderProps) {
  const { navigate } = useRouter();
  const [busy, setBusy] = useState<'pause' | 'resume' | 'detach' | 'attach' | 'remote' | 'reopen' | null>(null);
  // D33: closed from the session view: the Inbox opens (the sidebar follows `sessionUpdated`).
  const closer = useCloseSession(() => navigate({ view: 'inbox' }));
  const closed = session ? isClosed(session) : false;
  const [warning, setWarning] = useState<readonly AttachWarningReason[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [popover, setPopover] = useState(false);
  const shownError = error ?? closer.error?.text ?? null;

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
  const remote = session ? remoteToggle(session) : null;

  // D24: on → off (or on and back) never leaves the popover of an old link open.
  const remoteUrl = remote?.url ?? null;
  useEffect(() => {
    if (remoteUrl === null) setPopover(false);
  }, [remoteUrl]);
  // …nor the popover of another session when the view switches sessions.
  useEffect(() => setPopover(false), [sessionId]);

  const toggleRemote = async (): Promise<void> => {
    if (!remote || remote.disabled || busy) return;
    const enabled = !remote.on;
    setBusy('remote');
    setError(null);
    try {
      const updated = await api.setRemote(sessionId, enabled);
      // Turned on: show the link and the QR code at once.
      setPopover(enabled && (updated.remote?.url ?? null) !== null);
    } catch (caught) {
      setError(caught instanceof ApiError ? actionErrorText(caught.status, caught.body) : actionErrorText(0, null));
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  return (
    <div className="sb-sv-header" data-testid="session-header" data-session-id={sessionId}>
      <div className="sb-sv-top">
        <span className="sb-sv-dot" data-testid="session-dot" style={{ background: statusColor(session?.status ?? 'idle') }} />
        {session ? (
          <InlineTitle session={session} gesture="click" as="div" className="sb-sv-name" testId="session-name" onRenamed={onChanged} />
        ) : (
          <div className="sb-sv-name" data-testid="session-name">
            {sessionId}
          </div>
        )}
        <div className="sb-sv-root" data-testid="session-root" title={session && !missing ? rootLine(session) : undefined}>
          <span className="sb-sv-root-text">{missing ? 'no such session' : session ? rootLine(session) : ''}</span>
        </div>
        <div className="sb-sv-actions">
          {session ? <ModelPicker sessionId={sessionId} session={session} onChanged={onChanged} /> : null}
          <button
            type="button"
            className="sb-button sb-sv-action"
            data-testid="session-close"
            data-action={closed ? 'reopen' : 'close'}
            disabled={!session || busy !== null || closer.busyId !== null}
            aria-busy={busy === 'reopen' || closer.busyId === sessionId || undefined}
            onClick={() => {
              if (!session) return;
              if (closed) void run('reopen', () => api.reopenSession(sessionId));
              else closer.request(session);
            }}
          >
            {closed ? REOPEN_LABEL : CLOSE_LABEL}
          </button>
          {remote ? (
            <div className="sb-sv-remote" data-testid="session-remote">
              <button
                type="button"
                role="switch"
                aria-checked={remote.on}
                className="sb-button sb-sv-action sb-sv-remote-toggle"
                data-testid="session-remote-toggle"
                data-state={remote.on ? 'on' : 'off'}
                data-reason={remote.reason ?? undefined}
                disabled={remote.disabled || busy !== null}
                aria-busy={busy === 'remote' || undefined}
                title={remote.title}
                onClick={() => void toggleRemote()}
              >
                <PhoneGlyph className="sb-sv-remote-glyph" />
                {REMOTE_LABEL}
              </button>
              {remote.url ? (
                <button
                  type="button"
                  className="sb-button sb-sv-action"
                  data-testid="session-remote-link"
                  aria-expanded={popover}
                  aria-haspopup="dialog"
                  onClick={() => setPopover((open) => !open)}
                >
                  {REMOTE_LINK_LABEL}
                </button>
              ) : null}
              {popover && remote.url ? <RemotePopover url={remote.url} onClose={() => setPopover(false)} /> : null}
            </div>
          ) : null}
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
      {session?.remoteSource ? (
        <div className="sb-sv-remote-copy" data-testid="session-remote-copy-note">
          <span>{REMOTE_COPY_NOTE}</span>
          <a
            className="sb-sv-remote-copy-link"
            data-testid="session-remote-copy-link"
            href={remoteSessionUrl(session.remoteSource)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {session.remoteSource}
          </a>
        </div>
      ) : null}
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
      {shownError ? (
        <div className="sb-sv-error" role="alert" data-testid="session-error">
          {shownError}
        </div>
      ) : null}
      {closer.dialog}
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
