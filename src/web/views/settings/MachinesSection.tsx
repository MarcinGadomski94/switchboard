import { useEffect, useState } from 'react';
import type { Machine, PairingCode } from '../../../core/peers.ts';
import { ApiError, api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { rememberMachine, rememberMachines } from '../../api/useMachines.ts';
import { ReconnectButton } from '../../components/MachineStatusNote.tsx';
import { machineStatusView } from '../../components/machine-status.ts';
import { codeTimeLeft, listenerDescription, machineDetail, machineStateColor, machineStateLabel, refusalText } from './machines.ts';
import { Row, SectionTitle } from './rows.tsx';
import { MachineHooks } from './MachineHooks.tsx';
import './machines.css';

/**
 * A fallback refresh while the section is open: the rows follow the `/hub` event
 * `machineState` live (fix · peer reconnects; before it, a 3 s poll).
 */
const REFRESH_MS = 15_000;

function errorText(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? refusalText(caught.body, fallback) : fallback;
}

/**
 * Settings → Machines (D48, `docs/peers.md`): this machine, the peer listener
 * switch (off by default; binds only the Tailscale address), "Allow a new peer"
 * (a one-time code), "Add machine" (the other machine's Tailscale address and its
 * code), and the paired machines with their state (online / offline / auth failed
 * / no address), Rename and Remove; D48 P4: for this machine and each online
 * one, its terminal hooks and "Hook into…" (`MachineHooks`).
 */
export function MachinesSection() {
  const view = useApi(api.machines);
  // Fix · peer reconnects: every connection change (state, an attempt, the next try) shows at once.
  useHubEvent('machineState', (machine) => {
    rememberMachine(machine);
    view.reload();
  });
  useEffect(() => {
    if (view.data) rememberMachines(view.data.machines);
  }, [view.data]);
  const [tick, setTick] = useState(0);
  const [code, setCode] = useState<PairingCode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [address, setAddress] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      setTick((n) => n + 1);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (tick > 0 && tick % (REFRESH_MS / 1_000) === 0) view.reload();
    // Only the tick drives the refresh.
  }, [tick]);

  const run = async (key: string, action: () => Promise<unknown>, fallback: string): Promise<void> => {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorText(caught, fallback));
    } finally {
      setBusy(null);
      view.reload();
    }
  };

  const data = view.data;
  const left = code ? codeTimeLeft(code.expiresAt, now) : null;
  return (
    <>
      <SectionTitle withLede>Machines</SectionTitle>
      <div className="sb-set-lede">
        Pair this Switchboard with others on your tailnet: their sessions and Inbox items show here with a machine tag, and you can start sessions there.
      </div>
      {data ? (
        <>
          <Row
            id="self"
            label="This machine"
            description={
              <>
                <span data-testid="machines-self-id">{`id ${data.self.id}`}</span>
                {/* D48 P4: this machine's own terminal sessions and hooks. */}
                <MachineHooks machine={null} name={data.self.name} />
              </>
            }
          >
            <span className="sb-set-value" data-testid="machines-self-name">
              {data.self.name}
            </span>
          </Row>
          <Row id="peer-listener" label="Peer listener" description={<span data-testid="machines-listener-desc">{listenerDescription(data.listener)}</span>}>
            <button
              type="button"
              className="sb-set-value-button"
              data-testid="machines-listener"
              role="switch"
              aria-checked={data.listener.enabled}
              aria-label="Peer listener"
              disabled={busy !== null}
              onClick={() => void run('listener', () => api.setListener({ enabled: !data.listener.enabled }), 'The peer listener could not be changed.')}
            >
              {data.listener.enabled ? 'on' : 'off'}
            </button>
          </Row>
          <Row
            id="allow-peer"
            label="Allow a new peer"
            description={
              code && left ? (
                <span>
                  Type this code on the other machine (Add machine) within <span data-testid="machines-code-left">{left}</span>. It works once.
                </span>
              ) : (
                'Shows a one-time code (10 minutes, single use) for another machine to pair with this one. The peer listener must be on.'
              )
            }
          >
            {code && left ? (
              <span className="sb-mach-code" data-testid="machines-code">
                {code.code}
              </span>
            ) : (
              <button
                type="button"
                className="sb-set-action"
                data-testid="machines-allow"
                disabled={busy !== null}
                onClick={() => void run('code', async () => setCode(await api.pairingCode()), 'No code could be made.')}
              >
                Allow a new peer
              </button>
            )}
          </Row>
          <div className="sb-set-row sb-mach-add" data-row="add-machine">
            <div className="sb-set-row-text">
              <div className="sb-set-row-label">Add machine</div>
              <div className="sb-set-row-desc">The other machine's Tailscale address (100.x.y.z, port 13002 unless you changed it) and the code it shows.</div>
            </div>
            <form
              className="sb-mach-add-form"
              onSubmit={(event) => {
                event.preventDefault();
                void run(
                  'add',
                  async () => {
                    await api.addMachine({ address, code: typed });
                    setAddress('');
                    setTyped('');
                  },
                  'The machine could not be added.',
                );
              }}
            >
              <input className="sb-set-input" data-testid="machines-add-address" placeholder="100.101.102.103" value={address} onChange={(event) => setAddress(event.target.value)} aria-label="Address" />
              <input className="sb-set-input sb-mach-code-input" data-testid="machines-add-code" placeholder="XXXX-XXXX" value={typed} onChange={(event) => setTyped(event.target.value)} aria-label="Code" />
              <button type="submit" className="sb-set-action" data-testid="machines-add" disabled={busy !== null || address.trim() === '' || typed.trim() === ''}>
                Add
              </button>
            </form>
          </div>
          {error ? (
            <div className="sb-set-note sb-set-error" role="alert" data-testid="machines-error">
              {error}
            </div>
          ) : null}
          <div className="sb-mach-list" data-testid="machines-list">
            {data.machines.map((machine) => (
              <MachineRow key={machine.id} machine={machine} busy={busy !== null} run={run} now={now} />
            ))}
            {data.machines.length === 0 ? (
              <div className="sb-set-note" data-testid="machines-empty">
                No paired machines.
              </div>
            ) : null}
          </div>
        </>
      ) : null}
      {!data && view.error ? (
        <div className="sb-set-note sb-set-error" data-testid="settings-note">
          Machines could not be loaded.
        </div>
      ) : null}
    </>
  );
}

function MachineRow({
  machine,
  busy,
  run,
  now,
}: {
  readonly machine: Machine;
  readonly busy: boolean;
  readonly run: (key: string, action: () => Promise<unknown>, fallback: string) => Promise<void>;
  readonly now: number;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(machine.name);
  // Fix · peer reconnects: what the connection is doing (countdown, last error, hint) and Reconnect now.
  const status = machineStatusView(machine, machine.connection, now);
  return (
    <div className="sb-set-row sb-mach" data-testid="machine" data-machine-id={machine.id} data-state={machine.state}>
      <div className="sb-set-row-text">
        <div className="sb-set-row-label sb-mach-label">
          <span className="sb-mach-dot" style={{ background: machineStateColor(machine.state) }} />
          {renaming ? (
            <input className="sb-set-input" data-testid="machine-rename-input" value={name} onChange={(event) => setName(event.target.value)} aria-label="Machine name" />
          ) : (
            <span data-testid="machine-name">{machine.name}</span>
          )}
          <span className="sb-mach-state" data-testid="machine-state">
            {status?.busy ? <span className="sb-machine-spinner" data-testid="machine-spinner" aria-hidden="true" /> : null}
            {machineStateLabel(machine.state)}
          </span>
        </div>
        <div className="sb-set-row-desc" data-mono="" data-testid="machine-detail">
          {machineDetail(machine)}
        </div>
        {status ? (
          <div className="sb-set-row-desc sb-mach-status" data-testid="machine-status" role="status">
            <span data-testid="machine-status-text">{status.line}</span>
            {status.detail ? <span data-testid="machine-status-detail">{status.detail}</span> : null}
            {status.hint ? <span data-testid="machine-status-hint">{status.hint}</span> : null}
          </div>
        ) : null}
        {/* D48 P4: that machine's terminal sessions and hooks, through its peer API. */}
        {machine.state === 'online' ? <MachineHooks machine={machine.id} name={machine.name} /> : null}
      </div>
      <div className="sb-set-folder-actions">
        {status?.canReconnect ? <ReconnectButton id={machine.id} className="sb-set-action" testId="machine-reconnect" /> : null}
        {renaming ? (
          <>
            <button
              type="button"
              className="sb-set-action"
              data-testid="machine-rename-save"
              disabled={busy}
              onClick={() => void run('rename', () => api.renameMachine(machine.id, name), 'The name could not be saved.').then(() => setRenaming(false))}
            >
              Save
            </button>
            <button type="button" className="sb-set-action" onClick={() => setRenaming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="sb-set-action" data-testid="machine-rename" disabled={busy} onClick={() => setRenaming(true)}>
            Rename
          </button>
        )}
        <button
          type="button"
          className="sb-set-action"
          data-testid="machine-remove"
          disabled={busy}
          onClick={() => void run('remove', () => api.removeMachine(machine.id), 'The machine could not be removed.')}
        >
          Remove
        </button>
      </div>
    </div>
  );
}
