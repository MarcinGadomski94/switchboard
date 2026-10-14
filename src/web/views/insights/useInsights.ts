import { useCallback, useEffect, useRef, useState } from 'react';
import type { InsightsAnswer, InsightsMachines } from '../../../core/insights.ts';
import { ApiError, api } from '../../api/client.ts';

/** The page's data: the newest answer, the error, loading. */
export interface InsightsState {
  readonly data: InsightsAnswer | null;
  readonly error: ApiError | null;
  readonly loading: boolean;
  readonly reload: () => void;
}

/**
 * D108 ruling (merged machines): the page's answer. `machine` `null` = All machines (merged),
 * `local` = this machine, else a paired machine's own Insights (through its peer API). The
 * merged view never waits for a paired machine: the first answer (`peers=cached`) shows this
 * machine's numbers (and any paired machine's recent copy); when a machine is still pending,
 * a second request (`peers=wait`) fills it in.
 */
export function useInsights(query: string, machine: string | null): InsightsState {
  const [data, setData] = useState<InsightsAnswer | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const mine = (generation.current += 1);
    const current = (): boolean => generation.current === mine;
    setLoading(true);
    const fail = (caught: unknown): void => {
      if (!current()) return;
      setError(caught instanceof ApiError ? caught : new ApiError(0, String(caught)));
      setLoading(false);
    };
    const show = (answer: InsightsAnswer): void => {
      if (!current()) return;
      setData(answer);
      setError(null);
    };
    if (machine !== null && machine !== 'local') {
      api.insights(`${query}&machine=local`, machine).then((answer) => {
        show(answer);
        if (current()) setLoading(false);
      }, fail);
    } else {
      const scope = machine === 'local' ? 'local' : 'all';
      api.insights(`${query}&machine=${scope}&peers=cached`).then(async (answer) => {
        show(answer);
        if (scope === 'all' && answer.machines.pending.length > 0 && current()) {
          try {
            show(await api.insights(`${query}&machine=all&peers=wait`));
          } catch {
            // The first answer stays; its notice says what is missing.
          }
        }
        if (current()) setLoading(false);
      }, fail);
    }
  }, [query, machine, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload };
}

/** The header's note on the machines of a merged answer; `null` when every paired machine is in it (or none is paired). */
export function machinesNotice(machines: InsightsMachines): string | null {
  const names = (list: ReadonlyArray<{ readonly name: string }>): string => list.map((m) => m.name).join(', ');
  if (machines.scope !== 'all') return null;
  if (machines.missing.length > 0) return machines.included.length === 1 ? `This machine only — ${names(machines.missing)} not reachable` : `${names(machines.missing)} not reachable (not included)`;
  if (machines.pending.length > 0) return `Adding ${names(machines.pending)}…`;
  return machines.included.length > 1 ? `All machines: ${names(machines.included)}` : null;
}
