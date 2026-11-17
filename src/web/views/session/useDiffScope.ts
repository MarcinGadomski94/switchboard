import { useCallback, useEffect, useRef, useState } from 'react';
import type { DiffScope } from '../../../core/api.ts';
import { ApiError, api } from '../../api/client.ts';
import { SingleFlight } from '../../api/single-flight.ts';
import { type DiffCountLabel, type ScopeStorage, diffCountShown, diffTabCount, loadScope, pickedScope, saveScope } from './diff.ts';
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

/** D174: the view picked during a session's pending review (this page's life; a new review opens on For review again). */
const reviewPicks = new Map<string, { readonly since: string; readonly scope: DiffScope }>();

/**
 * D174: the To review strip's and card's **Open changes**: the session's Changes tab opens on For
 * review, even if another view was picked during this review. (Without a pending review the
 * tab does not offer it and shows its usual view.)
 */
export function showReviewScope(sessionId: string): void {
  reviewPicks.delete(sessionId);
  for (const listener of [...listeners]) listener(sessionId, 'review');
}

/**
 * D90: the Diff tab's view remembered for the session in this browser (`null` = none
 * picked: Since last commit), and the pick. The Diff tab and the session tab's
 * "Diff · n" count read the same choice, so a pick updates both.
 *
 * D174: while the session has a pending review (`reviewSince`, its `since`), the view is
 * For review until another is picked during that review ({@link pickedScope}); For review
 * itself is never stored in the browser.
 */
export function useDiffScope(sessionId: string, reviewSince: string | null = null): readonly [DiffScope | null, (scope: DiffScope) => void] {
  const [remembered, setRemembered] = useState<{ readonly sessionId: string; readonly scope: DiffScope | null }>(() => ({ sessionId, scope: loadScope(browserStorage(), sessionId) }));
  const [, setTick] = useState(0);
  const stored = remembered.sessionId === sessionId ? remembered.scope : loadScope(browserStorage(), sessionId);
  const current = pickedScope(stored, reviewSince, reviewPicks.get(sessionId) ?? null);
  useEffect(() => {
    const listener = (id: string, scope: DiffScope): void => {
      if (id !== sessionId) return;
      if (scope === 'review') setTick((n) => n + 1);
      else setRemembered({ sessionId, scope });
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [sessionId]);
  const pick = useCallback(
    (scope: DiffScope) => {
      if (reviewSince !== null) reviewPicks.set(sessionId, { since: reviewSince, scope });
      if (scope !== 'review') saveScope(browserStorage(), sessionId, scope);
      for (const listener of [...listeners]) listener(sessionId, scope);
    },
    [sessionId, reviewSince],
  );
  return [current, pick] as const;
}

/** The last count answered per session and asked view, so a revisit shows it at once (this page's life). */
const counted = new Map<string, { readonly files: number; readonly stale: boolean }>();

/** D144: a stale count is asked again after this long, doubling up to {@link STALE_RETRY_MAX_MS}, until it is fresh. */
export const STALE_RETRY_MS = 1_000;
export const STALE_RETRY_MAX_MS = 8_000;

interface CountState {
  readonly key: string;
  readonly files: number | null;
  /** D144: the number is not of the latest change yet (the server counts in the background), or none came yet. */
  readonly refreshing: boolean;
  readonly unsupported: boolean;
}

function initialCount(key: string): CountState {
  const known = counted.get(key);
  return { key, files: known?.files ?? null, refreshing: known ? known.stale : true, unsupported: false };
}

/**
 * D90 ruling (2026-10-09): the session tab's "Diff · n": the file count of the view
 * the Diff tab shows (`GET /api/sessions/{id}/diff/count?scope=`, names only),
 * fetched again on the Diff tab's triggers (`useSessionRefresh`). A machine without
 * the route (a paired machine before the ruling) refuses it: then the whole-branch
 * count of the session's detail (`detailFiles`) shows, as before.
 *
 * D144: one count request at a time (a trigger while one is on its way asks once more
 * after it, never drops it); the last number shows with "…" while the server's answer
 * is `stale` (it counts in the background; asked again after {@link STALE_RETRY_MS},
 * doubling) and "…" alone until the first answer. Returns the tab's count label
 * ({@link diffCountShown}).
 */
export function useDiffCount(sessionId: string, detailFiles: number | null, reviewSince: string | null = null): DiffCountLabel {
  const [scope] = useDiffScope(sessionId, reviewSince);
  const asked: DiffScope = scope ?? 'head';
  const key = `${sessionId}\u0000${asked}`;
  const [state, setState] = useState<CountState>(() => initialCount(key));
  const loads = useRef<{ readonly key: string; readonly flight: SingleFlight } | null>(null);
  useEffect(() => {
    let live = true;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let delay = STALE_RETRY_MS;
    const flight = new SingleFlight(() =>
      api.sessionDiffCount(sessionId, asked).then(
        (answer) => {
          if (!live) return;
          const stale = answer.stale === true;
          // Never counted yet (`at` null): the number this page knew, if any, stays until the first count lands.
          const files = stale && answer.at == null ? (counted.get(key)?.files ?? null) : answer.files;
          if (files !== null) counted.set(key, { files, stale });
          setState({ key, files, refreshing: stale, unsupported: false });
          if (retry) clearTimeout(retry);
          retry = null;
          if (stale) {
            retry = setTimeout(() => {
              retry = null;
              flight.run();
            }, delay);
            delay = Math.min(delay * 2, STALE_RETRY_MAX_MS);
          } else {
            delay = STALE_RETRY_MS;
          }
        },
        (caught: unknown) => {
          if (!live) return;
          // A paired machine before the ruling refuses the route (403 `peer-forbidden`; 404 / 501 elsewhere); anything else keeps what is known.
          // D174: a paired computer before D174 refuses `scope=review` (422): its whole-branch count shows.
          const unsupported = caught instanceof ApiError && (caught.status === 403 || caught.status === 404 || caught.status === 501 || (asked === 'review' && caught.status === 422));
          if (unsupported) setState({ key, files: null, refreshing: false, unsupported: true });
          else setState((current) => (current.key === key ? { ...current, refreshing: false } : current));
        },
      ),
    );
    loads.current = { key, flight };
    flight.run();
    return () => {
      live = false;
      flight.close();
      if (retry) clearTimeout(retry);
      if (loads.current?.flight === flight) loads.current = null;
    };
  }, [sessionId, asked, key]);
  const reload = useCallback(() => {
    const current = loads.current;
    if (current?.key === key) current.flight.run();
  }, [key]);
  useSessionRefresh(sessionId, reload);
  const mine = state.key === key ? state : initialCount(key);
  return diffCountShown(diffTabCount(mine.files, mine.unsupported, detailFiles), mine.refreshing && !mine.unsupported);
}
