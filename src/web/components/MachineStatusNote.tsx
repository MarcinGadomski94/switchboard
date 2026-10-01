import { useState } from 'react';
import type { SessionMachine } from '../../core/peers.ts';
import { ApiError, api } from '../api/client.ts';
import { rememberMachine, useMachineStatus, useNow } from '../api/useMachines.ts';
import { machineStatusView } from './machine-status.ts';
import './machine-status.css';

/** Fix · peer reconnects: the button's words. */
export const RECONNECT_NOW = 'Reconnect now';

/**
 * Fix · peer reconnects: **Reconnect now** for machine `id`: cuts the wait and
 * tries at once (the service joins an attempt already running). While it tries
 * the button spins and is disabled; on failure the reason shows next to it.
 */
export function ReconnectButton({ id, className, testId = 'machine-reconnect' }: { readonly id: string; readonly className?: string; readonly testId?: string }) {
  const [trying, setTrying] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const reconnect = async (): Promise<void> => {
    if (trying) return;
    setTrying(true);
    setFailure(null);
    try {
      const result = await api.reconnectMachine(id);
      rememberMachine(result.machine);
      if (result.outcome !== 'online') setFailure(`Not reached: ${result.machine.connection?.lastFailure?.message ?? result.machine.lastError ?? result.outcome}`);
    } catch (caught) {
      setFailure(caught instanceof ApiError && caught.unreachable ? 'Switchboard is not reachable.' : 'The reconnect could not be started.');
    } finally {
      setTrying(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className={`sb-button sb-machine-reconnect${className ? ` ${className}` : ''}`}
        data-testid={testId}
        disabled={trying}
        aria-busy={trying || undefined}
        onClick={() => void reconnect()}
      >
        {trying ? <span className="sb-machine-spinner" aria-hidden="true" /> : null}
        {RECONNECT_NOW}
      </button>
      {failure ? (
        <span className="sb-machine-reconnect-failure" data-testid={`${testId}-failure`} role="alert">
          {failure}
        </span>
      ) : null}
    </>
  );
}

/**
 * Fix · peer reconnects (`docs/peers.md` → *Connection states*): the note of a
 * paired machine that is not online, live: "Reconnecting to studio-pc… · attempt
 * 3 · next try in 8 s" (a spinner; nothing is blocked) or "studio-pc is
 * unreachable · retrying in 8 s" with the last error, a hint and **Reconnect
 * now**. Renders nothing while the machine is online.
 */
export function MachineStatusNote({
  machine,
  testId,
  className,
  role = 'note',
}: {
  readonly machine: SessionMachine | null | undefined;
  readonly testId: string;
  readonly className: string;
  readonly role?: 'note' | 'status';
}) {
  const status = useMachineStatus(machine?.id);
  const live = machine && status ? { ...machine, name: status.name, state: status.state } : machine;
  const now = useNow(Boolean(live && live.state !== 'online'));
  const view = machineStatusView(live, status?.connection, now);
  if (!live || !view) return null;
  return (
    <div className={`${className} sb-machine-status`} data-testid={testId} data-state={live.state} role={role}>
      {view.busy ? <span className="sb-machine-spinner" data-testid={`${testId}-spinner`} aria-hidden="true" /> : null}
      <span className="sb-machine-status-line" data-testid={`${testId}-text`}>
        {view.line}
      </span>
      {view.canReconnect ? <ReconnectButton id={live.id} testId={`${testId}-reconnect`} /> : null}
      {view.detail && live.state !== 'reconnecting' ? (
        <span className="sb-machine-status-detail" data-testid={`${testId}-detail`}>
          {view.detail}
        </span>
      ) : null}
      {view.hint ? (
        <span className="sb-machine-status-hint" data-testid={`${testId}-hint`}>
          {view.hint}
        </span>
      ) : null}
    </div>
  );
}
