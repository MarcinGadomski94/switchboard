import { useCallback, useEffect, useState } from 'react';
import type { DiffScope } from '../../../core/api.ts';
import { ApiError, api } from '../../api/client.ts';
import { type ScopeStorage, diffTabCount, loadScope, saveScope } from './diff.ts';
import { useSessionRefresh } from './useSessionRefresh.ts';

/** `window.localStorage`, or `null` where reading it throws (blocked site data). */
export function browserStorage(): ScopeStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** The pages' components showing a session's view (the Diff tab and the tab count) hear each pick. */
const listeners = new Set<(sessionId: string, scope: DiffScope) => void>();

/**
 * D90: the Diff tab's view remembered for the session in this browser (`null` = none
 * picked: Since last commit), and the pick. The Diff tab and the session tab's
 * "Diff · n" count read the same choice, so a pick updates both.
 */
export function useDiffScope(sessionId: string): readonly [DiffScope | null, (scope: DiffScope) => void] {
  const [remembered, setRemembered] = useState<{ readonly sessionId: string; readonly scope: DiffScope | null }>(() => ({ sessionId, scope: loadScope(browserStorage(), sessionId) }));
  const current = remembered.sessionId === sessionId ? remembered.scope : loadScope(browserStorage(), sessionId);
  useEffect(() => {
    const listener = (id: string, scope: DiffScope): void => {
      if (id === sessionId) setRemembered({ sessionId, scope });
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [sessionId]);
  const pick = useCallback(
    (scope: DiffScope) => {
      saveScope(browserStorage(), sessionId, scope);
      for (const listener of [...listeners]) listener(sessionId, scope);
    },
    [sessionId],
  );
  return [current, pick] as const;
}

/** The last count answered per session and asked view, so a revisit shows it at once (this page's life). */
const counted = new Map<string, number>();

/**
 * D90 ruling (2026-10-09): the session tab's "Diff · n": the file count of the view
 * the Diff tab shows (`GET /api/sessions/{id}/diff/count?scope=`, names only),
 * fetched again on the Diff tab's triggers (`useSessionRefresh`). A machine without
 * the route (a paired machine before the ruling) refuses it: then the whole-branch
 * count of the session's detail (`detailFiles`) shows, as before.
 */
export function useDiffCount(sessionId: string, detailFiles: number | null): number | null {
  const [scope] = useDiffScope(sessionId);
  const asked: DiffScope = scope ?? 'head';
  const key = `${sessionId}\u0000${asked}`;
  const [state, setState] = useState<{ readonly key: string; readonly files: number | null; readonly unsupported: boolean }>(() => ({ key, files: counted.get(key) ?? null, unsupported: false }));
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useSessionRefresh(sessionId, reload);
  useEffect(() => {
    let live = true;
    api.sessionDiffCount(sessionId, asked).then(
      (answer) => {
        counted.set(key, answer.files);
        if (live) setState({ key, files: answer.files, unsupported: false });
      },
      (caught: unknown) => {
        // A paired machine before the ruling refuses the route (403 `peer-forbidden`; 404 / 501 elsewhere); anything else keeps what is known.
        const unsupported = caught instanceof ApiError && (caught.status === 403 || caught.status === 404 || caught.status === 501);
        if (live && unsupported) setState({ key, files: null, unsupported: true });
      },
    );
    return () => {
      live = false;
    };
  }, [sessionId, asked, key, tick]);
  const mine = state.key === key ? state : { key, files: counted.get(key) ?? null, unsupported: false };
  return diffTabCount(mine.files, mine.unsupported, detailFiles);
}
