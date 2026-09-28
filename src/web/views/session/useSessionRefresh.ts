import { useEffect, useRef } from 'react';
import { useHubEvent, useHubStatus } from '../../api/useHub.ts';
import { useThrottled } from '../../api/useThrottled.ts';
import { refreshesDiff } from './diff.ts';

/** Bursts of `/hub` events fold into one fetch per this many ms. */
export const SESSION_REFRESH_MS = 500;

/**
 * Calls `reload` (folded to one call per {@link SESSION_REFRESH_MS}) whenever
 * the session's changed files or artifacts can have changed: a `/hub` `event`
 * of the session whose kind can touch files (`refreshesDiff`: edits, shell
 * commands, loop steps, other tools, results, failures), the session's
 * `sessionUpdated`, the hub stream reopening (events missed while it was down)
 * and the window regaining focus (edits made outside Switchboard). Shared by the
 * Diff tab (M4.5) and the Artifacts tab (M4.6); `docs/derivations.md`.
 */
export function useSessionRefresh(sessionId: string, reload: () => void): void {
  const refresh = useThrottled(reload, SESSION_REFRESH_MS);

  useHubEvent('event', (payload) => {
    if (payload.sessionId === sessionId && refreshesDiff(payload.event.kind)) refresh();
  });
  useHubEvent('sessionUpdated', (session) => {
    if (session.id === sessionId) refresh();
  });

  const hub = useHubStatus();
  const wasOpen = useRef<boolean | null>(null);
  useEffect(() => {
    if (hub === 'open') {
      if (wasOpen.current === false) refresh();
      wasOpen.current = true;
    } else if (wasOpen.current === true) {
      wasOpen.current = false;
    }
  }, [hub, refresh]);
  useEffect(() => {
    const onFocus = (): void => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);
}
