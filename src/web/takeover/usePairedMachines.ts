import { useCallback, useEffect, useState } from 'react';
import type { Machine } from '../../core/peers.ts';
import { api } from '../api/client.ts';
import { useHubEvent } from '../api/useHub.ts';

/** This machine and the paired ones, for the take-over actions (loaded once, refreshed when a machine's state changes). */
export function usePairedMachines(enabled = true): { readonly self: { readonly id: string; readonly name: string } | null; readonly machines: readonly Machine[] } {
  const [view, setView] = useState<{ self: { id: string; name: string } | null; machines: readonly Machine[] }>({ self: null, machines: [] });
  const load = useCallback(() => {
    api
      .machines()
      .then((next) => setView({ self: next.self, machines: next.machines }))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (enabled) load();
  }, [enabled, load]);
  useHubEvent('machineState', () => {
    if (enabled) load();
  });
  return view;
}
