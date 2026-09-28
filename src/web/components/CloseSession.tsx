import { type KeyboardEvent, type ReactNode, useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Session } from '../../core/api.ts';
import { CLOSE_CANCEL, CLOSE_NEEDS_CONFIRM, STOP_AND_CLOSE, closeAsks, closeConfirmText } from '../../core/session-close.ts';
import { displayTitle } from '../../core/session-title.ts';
import { ApiError, api } from '../api/client.ts';
import { actionErrorText } from '../views/session/session-header.ts';
import './close-session.css';

/** What closing needs to know about a session (the sidebar's and the header's `Session`). */
export type ClosableSession = Pick<Session, 'id' | 'name' | 'title' | 'displayTitle' | 'status' | 'activity' | 'live'>;

/** A refused close, for the session it belongs to. */
export interface CloseError {
  readonly sessionId: string;
  readonly text: string;
}

/** What {@link useCloseSession} gives its view. */
export interface CloseSessionControl {
  /** Starts closing `session`: asks first while it runs or waits (D33), else closes at once. */
  readonly request: (session: ClosableSession) => void;
  /** The session being closed (its Close controls wait), else `null`. */
  readonly busyId: string | null;
  /** A refusal outside the confirmation (the confirmation shows its own), else `null`. */
  readonly error: CloseError | null;
  /** The confirmation while it is open (rendered over the page through a portal), else `null`. */
  readonly dialog: ReactNode;
}

function refusal(caught: unknown): ApiError {
  return caught instanceof ApiError ? caught : new ApiError(0, String(caught));
}

function needsConfirm(error: ApiError): boolean {
  const body = error.body as { error?: unknown } | null;
  return error.status === 409 && typeof body === 'object' && body !== null && body.error === CLOSE_NEEDS_CONFIRM;
}

/**
 * Closing a session from the UI (D33, `docs/close-sessions.md`): a running or
 * waiting session (`closeAsks`) first gets the confirmation "Stop <title> and
 * close it? …" with **Stop & close** / **Cancel**; any other session is closed at
 * once (`POST /api/sessions/{id}/close`, with `confirm: true` when its idle
 * process is live, since the close stops it). A close the service refuses with
 * `close-needs-confirm` (the session started running meanwhile) opens the
 * confirmation instead. `onClosed` gets the closed session (the sidebar and the
 * header leave its view; the list follows `sessionUpdated`).
 */
export function useCloseSession(onClosed: (session: Session) => void): CloseSessionControl {
  const [asking, setAsking] = useState<ClosableSession | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<CloseError | null>(null);
  const busy = useRef(false);
  const closedRef = useRef(onClosed);
  closedRef.current = onClosed;

  const close = useCallback(async (session: ClosableSession, confirm: boolean): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    setBusyId(session.id);
    setError(null);
    try {
      const closed = await api.closeSession(session.id, confirm);
      setAsking(null);
      closedRef.current(closed);
    } catch (caught) {
      const apiError = refusal(caught);
      // It started running or waiting meanwhile: ask. Any other refusal is shown (in the confirmation when it is open).
      if (!confirm && needsConfirm(apiError)) setAsking(session);
      else setError({ sessionId: session.id, text: actionErrorText(apiError.status, apiError.body) });
    } finally {
      busy.current = false;
      setBusyId(null);
    }
  }, []);

  const request = useCallback(
    (session: ClosableSession): void => {
      if (busy.current) return;
      setError(null);
      if (closeAsks(session)) setAsking(session);
      else void close(session, session.live);
    },
    [close],
  );

  const cancel = (): void => {
    setAsking(null);
    setError(null);
  };

  const dialog = asking ? (
    <CloseConfirm
      title={displayTitle(asking)}
      busy={busyId === asking.id}
      error={error?.sessionId === asking.id ? error.text : null}
      onConfirm={() => void close(asking, true)}
      onCancel={cancel}
    />
  ) : null;

  return { request, busyId, error: asking ? null : error, dialog };
}

interface CloseConfirmProps {
  readonly title: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * The confirmation (D33): over the page like the other dialogs (overlay, SPEC
 * tokens, the attach warning's pill buttons). Esc or a click on the overlay
 * cancels; Cancel has the focus, so Enter never stops a session by accident.
 */
function CloseConfirm({ title, busy, error, onConfirm, onCancel }: CloseConfirmProps) {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onCancel();
    }
  };
  return createPortal(
    <div className="sb-close-overlay" data-testid="close-confirm-overlay" onClick={busy ? undefined : onCancel} onKeyDown={onKeyDown}>
      <div
        className="sb-close-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="sb-close-dialog-text"
        data-testid="close-confirm"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sb-close-text" id="sb-close-dialog-text" data-testid="close-confirm-text">
          {closeConfirmText(title)}
        </div>
        {error ? (
          <div className="sb-close-error" role="alert" data-testid="close-confirm-error">
            {error}
          </div>
        ) : null}
        <div className="sb-close-actions">
          <button type="button" className="sb-button sb-close-primary" data-testid="close-confirm-stop" disabled={busy} aria-busy={busy || undefined} onClick={onConfirm}>
            {STOP_AND_CLOSE}
          </button>
          <button type="button" className="sb-button sb-close-outlined" data-testid="close-confirm-cancel" disabled={busy} autoFocus onClick={onCancel}>
            {CLOSE_CANCEL}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
