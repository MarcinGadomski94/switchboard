import { type ReactNode, useEffect, useState } from 'react';
import type { CliOverview, Session } from '../../../core/api.ts';
import type { CliProviderId } from '../../../core/cli-providers.ts';
import { ApiError, api, machineApi } from '../../api/client.ts';
import { CliPicker } from '../../components/CliPicker.tsx';
import { actionErrorText } from './session-header.ts';
import { sessionProvider, switchConfirmText, switchProgressText } from './provider-switch.ts';

/**
 * D62 P5: the session header's CLI switcher (`picker`, among the header actions)
 * and its confirmation / error (`panel`, under the top row like Attach's warning). Picking another CLI asks first
 * ({@link switchConfirmText}), then `POST /api/sessions/{id}/provider`; while the
 * switch runs the header says what it does (`Session.providerSwitch`). A CLI that
 * cannot be chosen is listed disabled with its reason. On a peer's session the
 * CLIs are that machine's.
 */
export function useProviderSwitcher(session: Session | null, onChanged: () => void): { readonly picker: ReactNode; readonly panel: ReactNode } {
  const state = useSwitcherState(session, onChanged);
  return state;
}

function useSwitcherState(session: Session | null, onChanged: () => void): { readonly picker: ReactNode; readonly panel: ReactNode } {
  const machine = session?.machine?.id ?? null;
  const [overview, setOverview] = useState<CliOverview | null>(null);
  const [pending, setPending] = useState<CliProviderId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    machineApi(machine)
      .clis()
      .then(
        (value) => live && setOverview(value),
        () => live && setOverview(null),
      );
    return () => {
      live = false;
    };
  }, [machine]);
  const sessionId = session?.id ?? null;
  useEffect(() => {
    setPending(null);
    setError(null);
  }, [sessionId]);
  if (!session) return { picker: null, panel: null };
  const current = sessionProvider(session);
  const running = session.providerSwitch ?? null;
  const confirm = async (): Promise<void> => {
    if (!pending || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.switchProvider(session.id, pending);
      setPending(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? actionErrorText(caught.status, caught.body) : actionErrorText(0, null));
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  const picker = (
    <div className="sb-sv-cli" data-testid="session-cli" data-provider={current} data-switching={running ? running.to : undefined}>
      {running ? (
        <span className="sb-sv-cli-progress" data-testid="session-cli-progress" role="status">
          {switchProgressText(running)}
        </span>
      ) : (
        <CliPicker testId="session-cli-picker" label="CLI" value={pending ?? current} overview={overview} disabled={busy} onPick={(provider) => setPending(provider === current ? null : provider)} />
      )}
    </div>
  );
  const panel =
    (pending && !running) || error ? (
      <>
        {pending && !running ? (
          <div className="sb-sv-warning" role="alertdialog" aria-label="Switch CLI" data-testid="session-cli-confirm">
            <div className="sb-sv-warning-text">{switchConfirmText(current, pending)}</div>
            <div className="sb-sv-warning-actions">
              <button type="button" className="sb-button sb-sv-primary" data-testid="session-cli-switch" disabled={busy} onClick={() => void confirm()}>
                Switch
              </button>
              <button type="button" className="sb-button sb-sv-outlined" data-testid="session-cli-cancel" disabled={busy} onClick={() => setPending(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        {error ? (
          <div className="sb-sv-error" role="alert" data-testid="session-cli-error">
            {error}
          </div>
        ) : null}
      </>
    ) : null;
  return { picker, panel };
}
