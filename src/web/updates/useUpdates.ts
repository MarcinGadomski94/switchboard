import { useEffect, useRef, useState } from 'react';
import type { UpdateStatus } from '../../core/updates.ts';
import { ApiError, api } from '../api/client.ts';
import { useHubEvent, useHubStatus } from '../api/useHub.ts';

/** The version the page first saw the service run (to notice a restart into another version). */
let pageVersion: string | null = null;

/** The updater's state for a component (D55). */
export interface UpdatesState {
  /** `null` until loaded, or when the updater is off (501). */
  readonly status: UpdateStatus | null;
  /** `true` when the service answered 501 (updates off, the demo). */
  readonly off: boolean;
  /** The version this page was loaded with. */
  readonly pageVersion: string | null;
  /** Replaces the state with an answer (after an action). */
  readonly set: (status: UpdateStatus) => void;
}

/**
 * `GET /api/updates`, kept current by `updateChanged` and loaded again whenever
 * the `/hub` stream (re)opens, e.g. after the restart of an update.
 */
export function useUpdates(): UpdatesState {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [off, setOff] = useState(false);
  const hub = useHubStatus();
  const mounted = useRef(true);
  const set = (next: UpdateStatus): void => {
    pageVersion ??= next.current;
    setStatus(next);
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (hub !== 'open' && status !== null) return;
    api.updates().then(
      (next) => {
        if (!mounted.current) return;
        setOff(false);
        set(next);
      },
      (error: unknown) => {
        if (mounted.current && error instanceof ApiError && error.notImplemented) setOff(true);
      },
    );
    // Reload on every (re)opened stream; the status itself does not trigger it.
  }, [hub]);

  useHubEvent('updateChanged', (next) => set(next));
  return { status, off, pageVersion, set };
}
