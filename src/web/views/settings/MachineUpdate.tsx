import { useState } from 'react';
import type { Machine } from '../../../core/peers.ts';
import { remoteAgentsText, remoteConfirmText, remoteConfirmTitle } from '../../../core/updates.ts';
import { machineUpdateView } from '../../updates/machine-update.ts';
import { useMachineUpdate } from '../../updates/useMachineUpdate.ts';

/**
 * D140 (`docs/updates.md` → *Remote updates*): a paired machine's version and
 * updates in its classic Settings → Machines row: "Switchboard 2.4.2 · Update
 * available: 2.4.3", **Update…** (an inline confirm: what happens, how many
 * agents run there) and **Check for updates**, the progress, "Restarting…
 * reconnects when it's back", the reason where it cannot update itself, and a
 * refused call's message. Nothing for a machine that reports no update state.
 */
export function MachineUpdate({ machine }: { readonly machine: Machine }) {
  const view = machineUpdateView(machine);
  const actions = useMachineUpdate(machine.id);
  const [confirming, setConfirming] = useState(false);
  if (view.stage === 'unknown') return null;
  const latest = view.latest;
  const summary = [
    view.current ? `Switchboard ${view.current}` : null,
    view.stage === 'available' || view.stage === 'blocked' || view.stage === 'failed' ? `Update available: ${latest ?? ''}` : null,
    view.stage === 'up-to-date' ? 'up to date' : null,
    view.stage === 'checking' ? 'checking for updates…' : null,
    view.stage === 'restarting' ? "Restarting… reconnects when it's back" : null,
    view.updatedBy && view.current && view.stage !== 'running' && view.stage !== 'restarting' ? `updated to ${view.current} (asked from ${view.updatedBy})` : null,
  ].filter(Boolean);
  return (
    <div className="sb-set-row-desc sb-mach-update" data-testid="machine-update" data-stage={view.stage}>
      <span data-testid="machine-update-text">{summary.join(' · ')}</span>
      {view.stage === 'running' && view.detail ? <span data-testid="machine-update-progress">{view.detail}</span> : null}
      {view.stage === 'blocked' && view.blocked ? <span data-testid="machine-update-blocked">{view.blocked}</span> : null}
      {(view.stage === 'failed' || view.stage === 'check-failed') && view.detail ? (
        <span className="sb-set-error" role="alert" data-testid="machine-update-error">
          {view.stage === 'check-failed' ? `The last check failed: ${view.detail}` : view.detail}
        </span>
      ) : null}
      {actions.error ? (
        <span className="sb-set-error" role="alert" data-testid="machine-update-refused">
          {actions.error}
        </span>
      ) : null}
      {confirming && latest ? (
        <span className="sb-mach-update-confirm" data-testid="machine-update-confirm">
          <b>{remoteConfirmTitle(machine.name, latest)}</b> {remoteConfirmText()} {remoteAgentsText(view.liveSessions)}
          <span className="sb-mach-update-actions">
            <button
              type="button"
              className="sb-set-action"
              data-testid="machine-update-confirm-button"
              disabled={actions.busy !== null}
              onClick={() => {
                setConfirming(false);
                void actions.install(latest);
              }}
            >
              Update and restart
            </button>
            <button type="button" className="sb-set-action" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        </span>
      ) : view.canUpdate || view.canCheck ? (
        <span className="sb-mach-update-actions">
          {view.canUpdate ? (
            <button type="button" className="sb-set-action" data-testid="machine-update-button" disabled={actions.busy !== null} onClick={() => setConfirming(true)}>
              {`Update to ${latest ?? ''}…`}
            </button>
          ) : null}
          {view.canCheck ? (
            <button type="button" className="sb-set-action" data-testid="machine-update-check" disabled={actions.busy !== null} onClick={() => void actions.check()}>
              {actions.busy === 'check' ? 'Checking…' : 'Check for updates'}
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
