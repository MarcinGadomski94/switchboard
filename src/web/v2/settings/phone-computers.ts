import type { DeviceComputer } from '../../../core/devices-sync.ts';

/**
 * D189 (`docs/devices.md` → *One pairing for all your computers*): the computers a paired phone can
 * switch to, as Settings › Phones on the phone lists them, and the copy kept for the offline page
 * (the app's own origin can show where else to go when this computer cannot be reached).
 */

/** Where the phone keeps the list (per origin: each computer's app keeps its own copy). */
export const PHONE_COMPUTERS_KEY = 'sb.phone.computers';

/** One row. */
export interface PhoneComputerRow {
  readonly id: string;
  readonly name: string;
  readonly current: boolean;
  /** The Switch button is offered. */
  readonly canSwitch: boolean;
  /** Why it is not (or what it is), in plain words. */
  readonly note: string;
}

/** The rows: this computer first, then the others by name. */
export function phoneComputerRows(computers: readonly DeviceComputer[]): PhoneComputerRow[] {
  const sorted = [...computers].sort((a, b) => (a.current === b.current ? a.name.localeCompare(b.name) : a.current ? -1 : 1));
  return sorted.map((c) => {
    if (c.current) return { id: c.id, name: c.name, current: true, canSwitch: false, note: 'This computer' };
    if (!c.synced) return { id: c.id, name: c.name, current: false, canSwitch: false, note: 'Update Switchboard there to use this phone with it' };
    if (!c.origin) return { id: c.id, name: c.name, current: false, canSwitch: false, note: 'Not reachable from phones now (off, or its phone access is off)' };
    return { id: c.id, name: c.name, current: false, canSwitch: true, note: 'Ready' };
  });
}

/** What the offline page may link to: the computers with a device origin, other than this one. */
export interface StoredComputer {
  readonly name: string;
  readonly origin: string;
}

/** The list to store (only `https://` origins, or the tests' loopback ones). */
export function storedComputers(computers: readonly DeviceComputer[]): StoredComputer[] {
  return computers
    .filter((c) => !c.current && c.origin !== null && /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$)/.test(c.origin))
    .map((c) => ({ name: c.name, origin: c.origin as string }));
}
