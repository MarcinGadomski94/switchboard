import { useState } from 'react';
import { ApiError, api } from '../api/client.ts';
import { refusalMessage } from './machine-update.ts';

/** D140: a paired computer's Check for updates / Update, with the call's state and its refusal. */
export interface MachineUpdateActions {
  /** The call running now. */
  readonly busy: 'check' | 'install' | null;
  /** The last call's refusal ("Can't update itself here: …", "try again in 6 min"), `null` after a success. */
  readonly error: string | null;
  check(): Promise<boolean>;
  install(version: string): Promise<boolean>;
}

function errorText(caught: unknown, fallback: string): string {
  if (caught instanceof ApiError) return caught.unreachable ? 'Switchboard is not reachable.' : refusalMessage(caught.body, fallback);
  return fallback;
}

/**
 * D140 (`docs/updates.md` → *Remote updates*): Check for updates and Update on
 * paired computer `machineId` (through `/api/machines/{id}/api/updates/*`). The
 * progress itself arrives as the machine's `Machine.update` (`machineState`).
 */
export function useMachineUpdate(machineId: string): MachineUpdateActions {
  const [busy, setBusy] = useState<'check' | 'install' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (kind: 'check' | 'install', call: () => Promise<unknown>, fallback: string): Promise<boolean> => {
    setBusy(kind);
    setError(null);
    try {
      await call();
      return true;
    } catch (caught) {
      setError(errorText(caught, fallback));
      return false;
    } finally {
      setBusy(null);
    }
  };
  return {
    busy,
    error,
    check: () => run('check', () => api.checkUpdates(machineId), 'The check could not be started.'),
    install: (version) => run('install', () => api.installUpdate(version, machineId), 'The update could not be started.'),
  };
}
