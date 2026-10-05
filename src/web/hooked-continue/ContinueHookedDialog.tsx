import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { STOP_AND_CONTINUE_LABEL, STOP_TERMINAL_WARNING } from '../../core/hooked-continue.ts';
import { ApiError, api } from '../api/client.ts';
import { useRouter } from '../router.tsx';
import { type ContinueHookedRequest, closeContinueHooked, useContinueHookedRequest } from './store.ts';
import { continueRefusal, continueTitle } from './continue.ts';
import '../takeover/takeover.css';

/** Mounted once in the shell: the open Continue-in-Switchboard dialog, if any. */
export function ContinueHookedHost() {
  const request = useContinueHookedRequest();
  return request ? <ContinueHookedDialog key={request.sessionId} request={request} /> : null;
}

type Phase = { readonly kind: 'working' } | { readonly kind: 'confirm'; readonly pid: number | null } | { readonly kind: 'stopping' } | { readonly kind: 'error'; readonly text: string };

/**
 * D72 (`docs/peers.md` → *Continuing a hooked session in Switchboard*): continues a
 * hooked terminal session as a Switchboard-run one. It asks the service at once:
 * a terminal that is gone converts straight away (the dialog closes and the session
 * opens); a terminal whose `claude` still runs asks for the confirmation (the
 * take-over's kind of warning) and then stops it and continues; a refusal shows
 * its reason (nothing changed).
 */
export function ContinueHookedDialog({ request }: { readonly request: ContinueHookedRequest }) {
  const { navigate } = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'working' });
  const started = useRef(false);
  const busy = phase.kind === 'working' || phase.kind === 'stopping';

  const call = (confirm: boolean): void => {
    setPhase(confirm ? { kind: 'stopping' } : { kind: 'working' });
    api.continueHookedSession(request.sessionId, confirm).then(
      () => {
        closeContinueHooked();
        navigate({ view: 'session', id: request.sessionId, tab: 'chat' });
      },
      (error: unknown) => {
        const failed = error instanceof ApiError ? error : new ApiError(0, String(error));
        const view = continueRefusal(failed.status, failed.body);
        // A second "running" after the confirmation cannot ask again: it is the reason.
        setPhase(view.kind === 'confirm' && confirm ? { kind: 'error', text: "The terminal's claude is still running." } : view);
      },
    );
  };
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    call(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) closeContinueHooked();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy]);
  const close = (): void => {
    if (!busy) closeContinueHooked();
  };

  return (
    <div className="sb-takeover-overlay" data-testid="continue-hooked-overlay" onClick={close}>
      <div
        className="sb-takeover"
        role="dialog"
        aria-modal="true"
        aria-label={continueTitle(request.machineName)}
        data-testid="continue-hooked-dialog"
        data-state={phase.kind}
        onClick={(event: MouseEvent) => event.stopPropagation()}
      >
        <div className="sb-takeover-head">
          <div className="sb-takeover-title" data-testid="continue-hooked-title">
            {continueTitle(request.machineName)}
          </div>
          <div className="sb-takeover-sub">{request.title}</div>
        </div>
        <div className="sb-takeover-body">
          {phase.kind === 'working' ? <div className="sb-takeover-headline" aria-live="polite">Continuing…</div> : null}
          {phase.kind === 'stopping' ? (
            <div className="sb-takeover-headline" aria-live="polite">
              Stopping the terminal's claude, then continuing…
            </div>
          ) : null}
          {phase.kind === 'confirm' ? (
            <div className="sb-takeover-warning" data-testid="continue-hooked-warning">
              <span>{STOP_TERMINAL_WARNING}</span>
              {phase.pid !== null ? <span className="sb-takeover-sub">{`claude process ${phase.pid}`}</span> : null}
            </div>
          ) : null}
          {phase.kind === 'error' ? (
            <div className="sb-takeover-error" role="alert" data-testid="continue-hooked-error">
              {phase.text}
            </div>
          ) : null}
        </div>
        <div className="sb-takeover-footer">
          {phase.kind === 'confirm' ? (
            <button type="button" className="sb-button sb-takeover-primary" data-testid="continue-hooked-confirm" onClick={() => call(true)}>
              {STOP_AND_CONTINUE_LABEL}
            </button>
          ) : null}
          <button type="button" className="sb-button sb-takeover-outlined" data-testid="continue-hooked-close" disabled={busy} onClick={close}>
            {phase.kind === 'error' ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}
