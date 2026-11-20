/**
 * D181 · the rail's small rules (`docs/v2.md` → *Shell*), pure so they are tested without a browser.
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
