import { type SessionMachine, machineTagSuffix } from '../../core/peers.ts';
import { useLiveMachine, useMachineStatus } from '../api/useMachines.ts';
import { PowerBadge } from './Power.tsx';
import './machine-tag.css';

/** D48: what the tag says after the name when the machine cannot be reached now. */
export const UNREACHABLE = 'unreachable';

/**
 * D48 (`docs/peers.md`): the small mono tag of a peer's session or Inbox item: the
 * machine's name, and its state while it is not online ("· reconnecting…" during
 * the grace period after a drop, "· unreachable" after it, "· auth failed", "· no
 * address"; fix · peer reconnects). Its sessions stay listed; the peer keeps
 * running them. The state follows the machine's live status (`machineState`).
 * Nothing renders for this machine's own rows (`machine` absent or `null`).
 * D125: while online, a small power indicator follows the name (`🔋64%`,
 * `~210 W`) when the machine reports one (`Machine.power`).
 */
export function MachineTag({ machine: given, testId = 'machine-tag' }: { readonly machine: SessionMachine | null | undefined; readonly testId?: string }) {
  const machine = useLiveMachine(given);
  const power = useMachineStatus(given?.id)?.power;
  if (!machine) return null;
  const suffix = machineTagSuffix(machine.state);
  const showPower = machine.state === 'online' && power !== undefined;
  return (
    <span
      className="sb-machine-tag"
      data-testid={testId}
      data-state={machine.state}
      {...(showPower ? { 'data-power': power.kind } : {})}
      title={
        suffix === null
          ? `Runs on ${machine.name}`
          : machine.state === 'reconnecting'
            ? `Runs on ${machine.name}; the connection dropped and is being restored`
            : `Runs on ${machine.name}, which cannot be reached now (${machine.state})`
      }
    >
      {suffix === null ? machine.name : `${machine.name} · ${suffix}`}
      {showPower ? <PowerBadge power={power} /> : null}
    </span>
  );
}
