import { useCallback, useEffect, useState } from 'react';
import type { Machine } from '../../core/peers.ts';
import { api } from '../api/client.ts';
import { useHubEvent } from '../api/useHub.ts';

type PairedView = { self: { id: string; name: string } | null; machines: readonly Machine[] };

/** The last view read (a remounted action, e.g. one the header moved into its ⋯ menu, starts from it, not empty). */
let lastView: PairedView = { self: null, machines: [] };

/** This machine and the paired ones, for the take-over actions (loaded once, refreshed when a machine's state changes). */
export function usePairedMachines(enabled = true): { readonly self: { readonly id: string; readonly name: string } | null; readonly machines: readonly Machine[] } {
  const [view, setView] = useState<PairedView>(lastView);
  const load = useCallback(() => {
    api
      .machines()
      .then((next) => {
        lastView = { self: next.self, machines: next.machines };
        setView(lastView);
      })
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
