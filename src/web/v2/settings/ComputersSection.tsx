import { useEffect, useState } from 'react';
import type { SessionProcesses } from '../../../core/api.ts';
import type { Machine, MachinesView, PairingCode } from '../../../core/peers.ts';
import { ApiError, accountsApi, api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { rememberMachine, rememberMachines } from '../../api/useMachines.ts';
import { codeTimeLeft, refusalText } from '../../views/settings/machines.ts';
import { Button, Card, Chip, Dialog, EmptyState, Field, Icon, Skeleton, StatusBadge, Switch, useToast } from '../components/index.ts';
import { COMPUTER_UPDATE_WORDS as U, SETTINGS_WORDS as W, computerProblem, computerStateToV2 } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { machineUpdateView } from '../../updates/machine-update.ts';
import { useMachineUpdate } from '../../updates/useMachineUpdate.ts';
import { useStatusPill } from '../shell/useShellData.ts';
import { formatBytes } from '../shell/status-model.ts';
import { offlineSince, secondsLeft } from './settings-model.ts';

function errorText(caught: unknown, fallback: string): string {
  if (caught instanceof ApiError) return refusalText(caught.body, fallback);
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

/** A clock tick every second while `on`. */
function useTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [on]);
  return now;
}

/**
 * D131 · lane R · Settings › Computers (the prototype's `#set-computers`): this
 * computer and the paired ones (online / reconnecting with the countdown and
 * Reconnect now / offline since …), their power (battery or ~W), CPU and memory,
 * background apps per computer (D127, Stop / Keep), the shared layout per
 * computer (D71) and the shared accounts (D98), Add a computer (D48's pairing
 * code) and Forget. Live from `/hub` (`machineState`, `system`). D140: each
 * paired computer's version and updates (Update with a confirm, Check for
 * updates, the progress, "Restarting… reconnects when it's back");
 * `?update=<machine id>` (a peer's "is available" item's Update) opens the confirm.
 */
export function ComputersSection() {
  const view = useApi(api.machines);
  const router = useV2Router();
  const askUpdate = new URLSearchParams(router.search).get('update');
  const { pill } = useStatusPill();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [forgetting, setForgetting] = useState<Machine | null>(null);
  useHubEvent('machineState', (machine) => {
    rememberMachine(machine);
    view.reload();
  });
  useEffect(() => {
    if (view.data) rememberMachines(view.data.machines);
  }, [view.data]);
  const machines = view.data?.machines ?? [];
  const now = useTick(machines.some((m) => m.state !== 'online'));

  if (!view.data) {
    return (
      <div className="v2-set-stack" data-testid="v2-set-computers-loading">
        {view.error ? (
          <EmptyState icon="alert" tone="grey" title={W.loadError} />
        ) : (
          <Card pad>
            <Skeleton width="35%" height={14} />
            <Skeleton lines={2} style={{ marginTop: 12 }} />
          </Card>
        )}
      </div>
    );
  }
  const data: MachinesView = view.data;
  const self = pill.computerRows.find((row) => row.self);
  return (
    <div className="v2-set-stack" data-testid="v2-set-computers">
      <p className="v2-muted v2-set-p">{W.computersSub}</p>
      <Card pad className="v2-set-card v2-comp" data-testid="v2-computer" data-self="">
        <div className="v2-comp-icon">
          <Icon name="laptop" size="l" />
        </div>
        <div className="v2-grow">
          <div className="v2-set-card-h">
            <h3>{data.self.name}</h3>
            <Chip tone="outline" size="s">
              {W.thisComputer}
            </Chip>
          </div>
          {self?.detail ? <div className="v2-muted v2-set-small">{self.detail}</div> : null}
        </div>
        <div className="v2-comp-side">
          <StatusBadge status="online" />
          {self?.power ? (
            <div className="v2-comp-power" data-testid="v2-computer-power">
              <Icon name={self.powerKind === 'plug' ? 'bolt' : 'battery'} size="s" />
              <b>{self.power}</b>
            </div>
          ) : null}
        </div>
      </Card>
      {machines.length === 0 ? <p className="v2-muted v2-set-small">{W.noComputers}</p> : null}
      {machines.map((machine) => (
        <ComputerCard
          key={machine.id}
          machine={machine}
          now={now}
          power={pill.computerRows.find((row) => row.id === machine.id)?.power ?? null}
          onForget={() => setForgetting(machine)}
          onChanged={view.reload}
          askUpdate={askUpdate === machine.id}
          onAsked={() => router.navigate('/settings/computers', { replace: true })}
        />
      ))}
      <BackgroundApps selfName={data.self.name} machines={machines} />
      <SharedLayout machines={machines} onChanged={view.reload} />
      <SharedAccounts />
      <div>
        <Button icon="plus" onClick={() => setAdding(true)} data-testid="v2-add-computer">
          {W.addComputer}
        </Button>
      </div>
      <AddComputerDialog open={adding} onClose={() => setAdding(false)} listenerOn={data.listener.enabled} listening={data.listener.listening} onChanged={view.reload} />
      <Dialog
        open={forgetting !== null}
        onClose={() => setForgetting(null)}
        title={forgetting ? `${W.forget} ${forgetting.name}?` : W.forget}
        icon="desktop"
        testId="v2-forget-dialog"
        footer={
          <>
            <Button onClick={() => setForgetting(null)}>Cancel</Button>
            <Button
              variant="danger"
              data-testid="v2-forget-confirm"
              onClick={() => {
                const machine = forgetting;
                setForgetting(null);
                if (!machine) return;
                void api.removeMachine(machine.id).then(
                  () => {
                    toast({ text: `${machine.name} is forgotten.` });
                    view.reload();
                  },
                  (caught: unknown) => toast({ text: errorText(caught, 'It could not be forgotten.'), tone: 'error' }),
                );
              }}
            >
              {W.forget}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{W.forgetConfirm}</p>
      </Dialog>
    </div>
  );
}

/** A paired computer: its state (icon + word + colour), the countdown and Reconnect now, power, Forget. */
function ComputerCard({
  machine,
  now,
  power,
  onForget,
  onChanged,
  askUpdate,
  onAsked,
}: {
  readonly machine: Machine;
  readonly now: number;
  readonly power: string | null;
  readonly onForget: () => void;
  readonly onChanged: () => void;
  readonly askUpdate: boolean;
  readonly onAsked: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const state = computerStateToV2(machine.state);
  const retry = secondsLeft(machine.connection?.nextAttemptAt, now);
  const reconnect = (): void => {
    setBusy(true);
    api
      .reconnectMachine(machine.id)
      .then(
        (result) => {
          rememberMachine(result.machine);
          if (result.outcome !== 'online') toast({ text: `${machine.name} is still not reachable${machine.connection?.lastFailure ? `: ${machine.connection.lastFailure.message}` : '.'}`, tone: 'error' });
          onChanged();
        },
        (caught: unknown) => toast({ text: errorText(caught, 'It could not reconnect.'), tone: 'error' }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Card pad className="v2-set-card v2-comp" data-testid="v2-computer" data-machine-id={machine.id} data-state={state}>
      <div className="v2-comp-icon">
        <Icon name="desktop" size="l" />
      </div>
      <div className="v2-grow">
        <div className="v2-set-card-h">
          <h3>{machine.name}</h3>
        </div>
        {state === 'reconnecting' ? (
          <div className="v2-comp-recon" data-testid="v2-computer-reconnecting">
            <Chip tone="amber" icon="refresh">
              {`Reconnecting…${retry !== null ? ` ${W.retryIn} ` : ''}`}
              {retry !== null ? <b data-testid="v2-computer-countdown">{retry}</b> : null}
              {retry !== null ? 's' : ''}
            </Chip>
            <Button size="sm" disabled={busy} onClick={reconnect} data-testid="v2-computer-reconnect">
              {W.reconnectNow}
            </Button>
          </div>
        ) : null}
        {state === 'offline' ? (
          <div className="v2-comp-off" data-testid="v2-computer-offline">
            <span>
              {offlineSince(machine.lastSeenAt, now)}. {computerProblem(machine.state) ?? ''} Agents there are paused, nothing is lost.
              {retry !== null ? ` Next try in ${retry} s.` : ''}
            </span>
            {machine.state === 'offline' ? (
              <Button size="sm" disabled={busy} onClick={reconnect} data-testid="v2-computer-reconnect">
                {W.reconnectNow}
              </Button>
            ) : null}
          </div>
        ) : null}
        {machine.connection?.lastFailure && state !== 'online' ? <div className="v2-muted v2-set-small">{`Last error: ${machine.connection.lastFailure.message}`}</div> : null}
        {state === 'online' && machine.address ? <div className="v2-muted v2-set-small">{machine.address}</div> : null}
        <ComputerUpdate machine={machine} ask={askUpdate} onAsked={onAsked} />
      </div>
      <div className="v2-comp-side">
        <StatusBadge status={state} />
        {power && state === 'online' ? (
          <div className="v2-comp-power" data-testid="v2-computer-power">
            <Icon name={machine.power?.kind === 'estimated' ? 'bolt' : 'battery'} size="s" />
            <b>{power}</b>
          </div>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onForget} data-testid="v2-computer-forget">
          {W.forget}
        </Button>
      </div>
    </Card>
  );
}

/**
 * D140: a paired computer's version and updates on its card: "Update available:
 * 2.4.3" with **Update** (a confirm first: what happens, how many agents run
 * there) and **Check for updates**, the progress while it updates, "Restarting…
 * reconnects when it's back" while it is away, the reason where it cannot update
 * itself, and a refused call's message. Nothing for a computer that reports no
 * update state.
 */
function ComputerUpdate({ machine, ask, onAsked }: { readonly machine: Machine; readonly ask: boolean; readonly onAsked: () => void }) {
  const view = machineUpdateView(machine);
  const actions = useMachineUpdate(machine.id);
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!ask) return;
    if (view.canUpdate) setConfirming(true);
    onAsked();
  }, [ask, view.canUpdate]);
  if (view.stage === 'unknown') return null;
  const latest = view.latest;
  const install = (): void => {
    setConfirming(false);
    if (!latest) return;
    void actions.install(latest).then((ok) => {
      if (ok) toast({ text: U.started(machine.name, latest) });
    });
  };
  return (
    <div className="v2-comp-update" data-testid="v2-computer-update" data-tour="v2-computer-update" data-stage={view.stage}>
      <div className="v2-comp-update-line">
        {view.current ? (
          <span className="v2-muted v2-set-small" data-testid="v2-computer-version">
            {U.version(view.current)}
          </span>
        ) : null}
        {view.stage === 'available' || view.stage === 'blocked' || view.stage === 'failed' ? (
          <Chip tone="green" icon="download" size="s">
            <span data-testid="v2-computer-update-available">{U.available(latest ?? '')}</span>
          </Chip>
        ) : null}
        {view.stage === 'up-to-date' ? <span className="v2-muted v2-set-small">{U.upToDate}</span> : null}
        {view.stage === 'checking' ? <span className="v2-muted v2-set-small">{U.checking}</span> : null}
        {view.stage === 'restarting' ? (
          <Chip tone="amber" icon="refresh" size="s">
            <span data-testid="v2-computer-update-restarting">{U.restarting}</span>
          </Chip>
        ) : null}
        {view.updatedBy && view.current && view.stage !== 'running' && view.stage !== 'restarting' ? <span className="v2-muted v2-set-small">{U.updatedBy(view.current, view.updatedBy)}</span> : null}
      </div>
      {view.stage === 'running' ? (
        <div className="v2-set-small" data-testid="v2-computer-update-progress">
          {view.detail}
        </div>
      ) : null}
      {view.stage === 'blocked' && view.blocked ? (
        <div className="v2-muted v2-set-small" data-testid="v2-computer-update-blocked">
          {view.blocked}
        </div>
      ) : null}
      {(view.stage === 'failed' || view.stage === 'check-failed') && view.detail ? (
        <div className="v2-set-small v2-comp-update-error" role="alert" data-testid="v2-computer-update-error">
          {view.stage === 'check-failed' ? `${U.checkFailed}: ${view.detail}` : view.detail}
        </div>
      ) : null}
      {actions.error ? (
        <div className="v2-set-small v2-comp-update-error" role="alert" data-testid="v2-computer-update-refused">
          {actions.error}
        </div>
      ) : null}
      {view.canUpdate || view.canCheck ? (
        <div className="v2-comp-update-actions">
          {view.canUpdate ? (
            <Button size="sm" variant="primary" disabled={actions.busy !== null} onClick={() => setConfirming(true)} data-testid="v2-computer-update-button">
              {U.update}
            </Button>
          ) : null}
          {view.canCheck ? (
            <Button size="sm" disabled={actions.busy !== null} onClick={() => void actions.check()} data-testid="v2-computer-update-check">
              {actions.busy === 'check' ? U.checking : U.check}
            </Button>
          ) : null}
        </div>
      ) : null}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={U.confirmTitle(machine.name, latest ?? '')}
        icon="refresh"
        testId="v2-computer-update-confirm"
        footer={
          <>
            <Button onClick={() => setConfirming(false)}>{U.cancel}</Button>
            <Button variant="primary" onClick={install} data-testid="v2-computer-update-confirm-button">
              {U.confirm}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{U.confirmText}</p>
        <p className="v2-muted" style={{ margin: '8px 0 0' }} data-testid="v2-computer-update-agents">
          {U.agents(view.liveSessions)}
        </p>
      </Dialog>
    </div>
  );
}

/** D127: background apps per computer (each with Stop / Keep), from `GET /api/processes` (this computer's and the paired ones'). */
function BackgroundApps({ selfName, machines }: { readonly selfName: string; readonly machines: readonly Machine[] }) {
  const overview = useApi(() => api.processes(), []);
  const toast = useToast();
  const groups = new Map<string, { name: string; sessions: SessionProcesses[] }>();
  groups.set('', { name: selfName, sessions: [] });
  for (const machine of machines) groups.set(machine.id, { name: machine.name, sessions: [] });
  for (const session of overview.data?.sessions ?? []) {
    const key = session.machine?.id ?? '';
    const group = groups.get(key) ?? { name: session.machine?.name ?? selfName, sessions: [] };
    group.sessions.push(session);
    groups.set(key, group);
  }
  const act = (promise: Promise<unknown>, done: string): void => {
    promise.then(
      () => {
        toast({ text: done });
        overview.reload();
      },
      (caught: unknown) => toast({ text: errorText(caught, 'It could not be done.'), tone: 'error' }),
    );
  };
  return (
    <Card pad className="v2-set-card" data-testid="v2-background-apps">
      <h3>{W.backgroundApps}</h3>
      {!overview.data && !overview.error ? <Skeleton lines={2} /> : null}
      {[...groups.entries()].map(([key, group]) => {
        const processes = group.sessions.flatMap((session) => session.processes.map((process) => ({ session, process })));
        const unavailable = overview.data?.unavailable?.find((u) => u.machine.id === key);
        return (
          <div className="v2-bg-group" key={key || 'self'} data-testid="v2-bg-computer" data-machine={key || 'self'}>
            <div className="v2-set-row">
              <b className="v2-grow">{group.name}</b>
              {processes.length > 0 ? (
                <Button
                  size="sm"
                  onClick={() => act(Promise.all(processes.filter(({ process }) => !process.keep).map(({ session, process }) => api.stopProcess(session.sessionId, process.pid))), `Stopped the background apps on ${group.name} that are not kept.`)}
                  data-testid="v2-bg-stop-all"
                >
                  {W.stopAll}
                </Button>
              ) : null}
            </div>
            {unavailable ? <div className="v2-muted v2-set-small">{`Not checked: ${unavailable.reason}`}</div> : null}
            {processes.length === 0 && !unavailable ? <div className="v2-muted v2-set-small">{W.noBackgroundApps}</div> : null}
            {processes.map(({ session, process }) => (
              <div className="v2-bg-row" key={`${session.sessionId}:${process.pid}`} data-testid="v2-bg-app">
                <Icon name="cpu" size="s" />
                <span className="v2-grow">
                  <b>{process.name}</b> <span className="v2-muted">{`${formatBytes(process.rssBytes)} · ${session.title}`}</span>
                  {process.keep ? <span className="v2-muted">{` · ${W.kept}${process.keepReason ? `: ${process.keepReason}` : ''}`}</span> : null}
                </span>
                <Button size="sm" onClick={() => act(api.keepProcess(session.sessionId, process.pid, !process.keep), process.keep ? `${process.name} may stop when idle again.` : `${process.name} keeps running.`)}>
                  {process.keep ? 'Don’t keep' : W.keep}
                </Button>
                <Button size="sm" onClick={() => act(api.stopProcess(session.sessionId, process.pid), `Stopped ${process.name}.`)}>
                  {W.stop}
                </Button>
              </div>
            ))}
          </div>
        );
      })}
    </Card>
  );
}

/** D71: share the folder layout with each paired computer (a switch per computer). */
function SharedLayout({ machines, onChanged }: { readonly machines: readonly Machine[]; readonly onChanged: () => void }) {
  const toast = useToast();
  return (
    <Card pad className="v2-set-card" data-testid="v2-shared-layout">
      <div className="v2-set-card-h">
        <Icon name="folder" />
        <h3 className="v2-grow">{W.sharedLayout}</h3>
      </div>
      <p className="v2-muted v2-set-small">{W.sharedLayoutSub}</p>
      {machines.length === 0 ? <p className="v2-muted v2-set-small">{W.noComputers}</p> : null}
      {machines.map((machine) => {
        const sync = machine.sidebarSync;
        const on = sync?.enabled === true;
        const word = !on ? 'Off' : sync?.state === 'synced' ? 'In sync' : sync?.state === 'waiting' ? 'Waiting for the other computer' : sync?.state === 'unsupported' ? 'Update Switchboard there' : sync?.state === 'error' ? (sync.error ?? 'Failed') : sync?.state === 'unreachable' ? 'Catches up when it is back' : 'Connecting…';
        return (
          <div className="v2-set-row" key={machine.id} data-testid="v2-shared-layout-row">
            <span className="v2-grow">
              <b>{machine.name}</b> <span className="v2-muted">· {word}</span>
            </span>
            <Switch
              checked={on}
              label={`Share the layout with ${machine.name}`}
              onChange={(next) =>
                void api.setMachineSidebarSync(machine.id, next).then(onChanged, (caught: unknown) => toast({ text: errorText(caught, 'It could not be changed.'), tone: 'error' }))
              }
            />
          </div>
        );
      })}
    </Card>
  );
}

/** D98: the accounts this computer shares with paired ones (automatic: there is no switch). */
function SharedAccounts() {
  const overview = useApi(() => accountsApi(null).overview(false), []);
  const shared = (overview.data?.profiles ?? []).filter((p) => (p.elsewhere ?? []).length > 0);
  return (
    <Card pad className="v2-set-card" data-testid="v2-shared-accounts">
      <h3>{W.sharedAccounts}</h3>
      <p className="v2-muted v2-set-small">{W.sharedAccountsSub}</p>
      {shared.length === 0 ? <p className="v2-muted v2-set-small">{W.sharedAccountsNone}</p> : null}
      {shared.map((profile) => (
        <div className="v2-set-row" key={profile.id}>
          <span className="v2-grow">
            {profile.name} <span className="v2-muted">· also on {(profile.elsewhere ?? []).map((e) => e.machineName).join(', ')}</span>
          </span>
          <Chip tone="green" icon="check" size="s">
            Shared
          </Chip>
        </div>
      ))}
    </Card>
  );
}

/** D48: Add a computer: a one-time code for the other computer (and pairing by its address and code). */
function AddComputerDialog({ open, onClose, listenerOn, listening, onChanged }: { readonly open: boolean; readonly onClose: () => void; readonly listenerOn: boolean; readonly listening: string | null; readonly onChanged: () => void }) {
  const [code, setCode] = useState<PairingCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const now = useTick(open);
  useEffect(() => {
    if (!open) {
      setCode(null);
      setError(null);
      return;
    }
    if (!listenerOn) return;
    api.pairingCode().then(setCode, (caught: unknown) => setError(errorText(caught, 'No code could be made.')));
  }, [open, listenerOn]);
  const left = code ? codeTimeLeft(code.expiresAt, now) : null;
  return (
    <Dialog open={open} onClose={onClose} title={W.addComputer} icon="desktop" testId="v2-add-computer-dialog" footer={<Button onClick={onClose}>Close</Button>}>
      {!listenerOn ? (
        <div className="v2-set-row" style={{ borderTop: 0 }}>
          <span className="v2-grow">Let other computers reach this one (over Tailscale only).</span>
          <Switch
            checked={false}
            label="Let other computers reach this one"
            testId="v2-listener-switch"
            onChange={() => void api.setListener({ enabled: true }).then(onChanged, (caught: unknown) => setError(errorText(caught, 'It could not be turned on.')))}
          />
        </div>
      ) : (
        <>
          <ol className="v2-set-steps">
            <li>Install Switchboard on the other computer.</li>
            <li>Open Settings › Computers there and choose Add a computer.</li>
            <li>{`Type this computer’s address${listening ? ` (${listening})` : ''} and this code:`}</li>
          </ol>
          <div className="v2-pair-code" data-testid="v2-pair-code">
            {code && left ? code.code : <Skeleton width="60%" height={28} />}
          </div>
          <p className="v2-muted v2-set-small">{left ? `Valid for ${left}, once, only on your private network. Accounts and layout are shared once it joins.` : 'Making a code…'}</p>
        </>
      )}
      <form
        className="v2-pair-form"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          api
            .addMachine({ address: address.trim(), code: typed.trim() })
            .then(
              (machine) => {
                toast({ text: `${machine.name} is paired.` });
                setAddress('');
                setTyped('');
                onChanged();
                onClose();
              },
              (caught: unknown) => setError(errorText(caught, 'The computer could not be added.')),
            )
            .finally(() => setBusy(false));
        }}
      >
        <h4>Or join another computer</h4>
        <Field label="Its address" placeholder="100.101.102.103" value={address} onChange={(event) => setAddress(event.currentTarget.value)} data-testid="v2-pair-address" />
        <Field label="The code it shows" placeholder="XXXX-XXXX" value={typed} onChange={(event) => setTyped(event.currentTarget.value)} data-testid="v2-pair-typed" />
        <Button type="submit" disabled={busy || address.trim() === '' || typed.trim() === ''}>
          Pair
        </Button>
      </form>
      {error ? (
        <div className="v2-set-error" role="alert">
          {error}
        </div>
      ) : null}
    </Dialog>
  );
}
