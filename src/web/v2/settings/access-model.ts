import type { MachinesView } from '../../../core/peers.ts';
import { type ComputerThrough, blockedComputers, type UserProfile } from '../../../core/user-profiles.ts';

/**
 * D173 / D176 · Settings → Profiles → *Computers…* (`docs/profiles.md` → *Admins and computer
 * access*): the computers the checklist shows and how each starts. Pure; unit-tested.
 */

/** A computer the checklist shows: this one, a paired one, or one known only through a paired one. */
export interface KnownComputer {
  readonly id: string;
  readonly name: string;
  readonly self: boolean;
  /** D176: the paired computer it is known through (`null`: this computer or a paired one). */
  readonly through: string | null;
}

/** This computer, then the paired ones, then the ones known only through a paired one (D176). */
export function knownComputers(machines: Pick<MachinesView, 'self' | 'machines'> | null, others: readonly ComputerThrough[] | undefined): KnownComputer[] {
  if (!machines) return [];
  const out: KnownComputer[] = [{ id: machines.self.id, name: machines.self.name, self: true, through: null }, ...machines.machines.map((machine) => ({ id: machine.id, name: machine.name, self: false, through: null }))];
  const seen = new Set(out.map((computer) => computer.id));
  for (const other of others ?? []) if (!seen.has(other.id)) out.push({ id: other.id, name: other.name, self: false, through: other.through });
  return out;
}

/** A checklist row: the computer, whether it starts ticked, and whether the list was never decided for it (D176). */
export interface AccessRow extends KnownComputer {
  readonly checked: boolean;
  /** D176: the list was set without this computer in view: it is allowed until the admin decides. */
  readonly undecided: boolean;
}

/** The checklist rows of `profile` over the `known` computers. An undecided computer starts ticked (it is allowed now). */
export function accessRows(profile: Pick<UserProfile, 'computers' | 'decidedFor'>, known: readonly KnownComputer[]): AccessRow[] {
  const computers = profile.computers ?? null;
  const decided = profile.decidedFor ?? null;
  return known.map((computer) => {
    const undecided = computers !== null && decided !== null && !decided.includes(computer.id);
    return { ...computer, undecided, checked: computers === null || undecided || computers.includes(computer.id) };
  });
}

/** Whether saving `picked` (or every computer, `all`) changes the profile's access (an undecided row shown counts as a change: it gets decided). */
export function accessChanged(profile: Pick<UserProfile, 'computers' | 'decidedFor'>, rows: readonly AccessRow[], all: boolean, picked: ReadonlySet<string>): boolean {
  const computers = profile.computers ?? null;
  if (all) return computers !== null;
  if (computers === null) return true;
  if (rows.some((row) => row.undecided)) return true;
  if ((profile.decidedFor ?? null) === null) return true;
  return computers.length !== picked.size || !computers.every((id) => picked.has(id));
}

/** A computer's name for the row summary (this one marked; an id nobody knows shows as itself). */
function nameOf(id: string, known: readonly KnownComputer[], thisComputer: string): string {
  const computer = known.find((entry) => entry.id === id);
  if (!computer) return id;
  return computer.self ? `${computer.name} (${thisComputer})` : computer.name;
}

/**
 * The row's summary: every computer; D176 lists: the computers it is blocked on ("Not on …"), others
 * allowed; D173's plain list: "Only …".
 */
export function accessSummary(profile: Pick<UserProfile, 'computers' | 'decidedFor'>, known: readonly KnownComputer[], thisComputer: string): { readonly kind: 'all' | 'not-on' | 'only'; readonly names: readonly string[] } {
  const computers = profile.computers ?? null;
  if (computers === null) return { kind: 'all', names: [] };
  const blocked = blockedComputers(computers, profile.decidedFor);
  if (blocked !== null) return blocked.length === 0 ? { kind: 'all', names: [] } : { kind: 'not-on', names: blocked.map((id) => nameOf(id, known, thisComputer)) };
  return { kind: 'only', names: computers.map((id) => nameOf(id, known, thisComputer)) };
}
