import { type SessionMachine, machineTagSuffix } from '../../core/peers.ts';
import { useLiveMachine } from '../api/useMachines.ts';
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
 */
export function MachineTag({ machine: given, testId = 'machine-tag' }: { readonly machine: SessionMachine | null | undefined; readonly testId?: string }) {
  const machine = useLiveMachine(given);
  if (!machine) return null;
  const suffix = machineTagSuffix(machine.state);
  return (
    <span
      className="sb-machine-tag"
      data-testid={testId}
      data-state={machine.state}
      title={
        suffix === null
          ? `Runs on ${machine.name}`
          : machine.state === 'reconnecting'
            ? `Runs on ${machine.name}; the connection dropped and is being restored`
            : `Runs on ${machine.name}, which cannot be reached now (${machine.state})`
      }
    >
      {suffix === null ? machine.name : `${machine.name} · ${suffix}`}
    </span>
  );
}
