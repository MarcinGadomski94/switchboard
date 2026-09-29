import type { SessionMachine } from '../../core/peers.ts';
import './machine-tag.css';

/** D48: what the tag says after the name when the machine cannot be reached now. */
export const UNREACHABLE = 'unreachable';

/**
 * D48 (`docs/peers.md`): the small mono tag of a peer's session or Inbox item: the
 * machine's name, and "· unreachable" while the machine is not online (its
 * sessions stay listed; the peer keeps running them). Nothing renders for this
 * machine's own rows (`machine` absent or `null`).
 */
export function MachineTag({ machine, testId = 'machine-tag' }: { readonly machine: SessionMachine | null | undefined; readonly testId?: string }) {
  if (!machine) return null;
  const reachable = machine.state === 'online';
  return (
    <span
      className="sb-machine-tag"
      data-testid={testId}
      data-state={machine.state}
      title={reachable ? `Runs on ${machine.name}` : `Runs on ${machine.name}, which cannot be reached now (${machine.state})`}
    >
      {reachable ? machine.name : `${machine.name} · ${UNREACHABLE}`}
    </span>
  );
}
