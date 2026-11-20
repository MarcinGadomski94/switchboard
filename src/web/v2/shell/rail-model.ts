import type { PinnedEntry } from '../shared/pinned-model.ts';

/**
 * D181 · the icon rail's small rules (`docs/v2.md` → *Rail*), pure so they are tested
 * without a browser.
 */

/**
 * D181: the computer a pinned or recent agent's row names. A paired computer's agent: its
 * computer's name. This computer's agent: this computer's name, but only once a computer is
 * paired (with none, every agent runs here and the name says nothing). `null` = no name.
 */
export function rowComputerName(machine: { readonly name: string } | null | undefined, selfName: string | null, anyPaired: boolean): string | null {
  if (machine) return machine.name;
  return anyPaired && selfName ? selfName : null;
}

/**
 * D181: the Pinned icon's count: what the pinned entries need from you (an agent's Needs-you
 * items, a crew's, a project's steps that need you), summed. 0 = no badge.
 */
export function pinnedNeeds(entries: readonly PinnedEntry[], needsOf: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.kind === 'agent') total += needsOf.get(entry.id) ?? 0;
    else if (entry.kind === 'crew') total += entry.crew.needs;
    else total += entry.project.needs;
  }
  return total;
}

/** D181: a rail item's tooltip: its label, and what its badge counts when it shows one. */
export function railTip(label: string, badge: string | null): string {
  return badge ? `${label} · ${badge}` : label;
}
