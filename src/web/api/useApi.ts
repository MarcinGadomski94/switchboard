import { type DependencyList, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './client.ts';

/** State of a {@link useApi} call. */
export interface ApiState<T> {
  /** The last successful result, `null` until there is one. */
  readonly data: T | null;
  /** The last error, `null` after a success. */
  readonly error: ApiError | null;
  readonly loading: boolean;
  /** `true` once the service has answered at all (any HTTP status). */
  readonly reachable: boolean | null;
  /** Fetches again. */
  readonly reload: () => void;
}

/**
 * Runs `fetcher` on mount and whenever `deps` change; `reload()` runs it again.
 * A 501 (route not implemented yet) or any other error leaves `data` at its last
 * value (`null` at first), so views render their empty state.
 */
export function useApi<T>(fetcher: () => Promise<T>, deps: DependencyList = []): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetcherRef.current().then(
      (result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
        setReachable(true);
        setLoading(false);
      },
      (caught: unknown) => {
        if (cancelled) return;
        const apiError = caught instanceof ApiError ? caught : new ApiError(0, String(caught));
        setError(apiError);
        setReachable(!apiError.unreachable);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
    // The caller's deps decide when to refetch (the fetcher itself is read through a ref).
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reachable, reload };
}
