import { useCallback, useEffect, useRef } from 'react';

/**
 * A stable function that runs `fn` once, `ms` after its first call; calls in
 * between are folded into that run. For reloads driven by bursty `/hub` events
 * (`sessionUpdated` fires on every status change). The pending run is dropped on
 * unmount.
 */
export function useThrottled(fn: () => void, ms: number): () => void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );
  return useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      fnRef.current();
    }, ms);
  }, [ms]);
}
