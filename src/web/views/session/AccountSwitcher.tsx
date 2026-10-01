import { type ReactNode, useEffect, useState } from 'react';
import type { AccountProfile } from '../../../core/accounts.ts';
import type { Session } from '../../../core/api.ts';
import { CLI_LABELS, readCliProvider } from '../../../core/cli-providers.ts';
import { ApiError, api, machineApi } from '../../api/client.ts';
import { exhaustedText } from '../settings/accounts.ts';
import { actionErrorText } from './session-header.ts';

/**
 * D63: the session header's account (`docs/accounts.md` → *Per session*): the name of
 * the account the session runs on, the **Switch account** action (a picker of the
 * CLI's other accounts that asks first), and the **pin** that keeps automatic
 * switching away from the session. Shown only when its CLI has more than one account.
 * While a switch runs the header says so (`Session.accountSwitching`).
 */
export function useAccountSwitcher(session: Session | null, onChanged: () => void): { readonly picker: ReactNode; readonly panel: ReactNode } {
  const machine = session?.machine?.id ?? null;
  const sessionId = session?.id ?? null;
  const profileId = session?.profileId ?? null;
  const [profiles, setProfiles] = useState<readonly AccountProfile[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    machineApi(machine)
      .accounts()
      .then(
        (value) => live && setProfiles(value.profiles),
        () => live && setProfiles([]),
      );
    return () => {
      live = false;
    };
    // The list is read again when the session's account changes (a switch, automatic or not).
  }, [machine, profileId, sessionId]);
  useEffect(() => {
    setPending(null);
    setError(null);
  }, [sessionId]);
  if (!session) return { picker: null, panel: null };
  const cli = readCliProvider(session.provider);
  const mine = profiles.filter((p) => p.cli === cli);
  if (mine.length < 2) return { picker: null, panel: null };
  const current = mine.find((p) => p.id === profileId) ?? mine.find((p) => p.builtin) ?? mine[0];
  const target = mine.find((p) => p.id === pending) ?? null;
  const switching = session.accountSwitching === true;
  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
      setPending(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? actionErrorText(caught.status, caught.body) : actionErrorText(0, null));
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  const pinned = session.profilePinned === true;
  const picker = (
    <div className="sb-sv-cli sb-sv-account" data-testid="session-account" data-profile-id={current?.id} data-pinned={String(pinned)}>
      {switching ? (
        <span className="sb-sv-cli-progress" data-testid="session-account-progress" role="status">
          Switching account…
        </span>
      ) : (
        <>
          <select
            className="sb-cli-picker"
            data-testid="session-account-picker"
            aria-label="Account"
            title={`${CLI_LABELS[cli]} account: switch this session to another one`}
            value={current?.id ?? ''}
            disabled={busy}
            onChange={(event) => setPending(event.target.value === current?.id ? null : event.target.value)}
          >
            {mine.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.enabled && p.id !== current?.id} title={exhaustedText(p) ?? undefined}>
                {p.name}
                {p.exhausted ? ' (out of usage)' : !p.enabled ? ' (disabled)' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="sb-button sb-sv-action"
            data-testid="session-account-pin"
            aria-pressed={pinned}
            title={pinned ? 'Pinned: automatic switching leaves this session on its account. Click to unpin.' : 'Pin the session to its account: automatic switching leaves it alone.'}
            disabled={busy}
            onClick={() => void run(() => api.pinProfile(session.id, !pinned))}
          >
            {pinned ? 'Pinned' : 'Pin'}
          </button>
        </>
      )}
    </div>
  );
  const panel =
    (target && !switching) || error ? (
      <>
        {target && !switching ? (
          <div className="sb-sv-warning" role="alertdialog" aria-label="Switch account" data-testid="session-account-confirm">
            <div className="sb-sv-warning-text">
              Switch this session from {current?.name} to {target.name}? The conversation is copied to that account and resumed there; a turn that is running is interrupted and picked up again.
              {target.exhausted ? ` ${exhaustedText(target)}.` : ''}
            </div>
            <div className="sb-sv-warning-actions">
              <button type="button" className="sb-button sb-sv-primary" data-testid="session-account-switch" disabled={busy} onClick={() => void run(() => api.switchAccount(session.id, target.id))}>
                Switch account
              </button>
              <button type="button" className="sb-button sb-sv-outlined" data-testid="session-account-cancel" disabled={busy} onClick={() => setPending(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        {error ? (
          <div className="sb-sv-error" role="alert" data-testid="session-account-error">
            {error}
          </div>
        ) : null}
      </>
    ) : null;
  return { picker, panel };
}
