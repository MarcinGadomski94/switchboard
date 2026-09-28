import { useCallback, useEffect, useRef } from 'react';
import type { SystemInfo } from '../../core/api.ts';
import { api } from '../api/client.ts';
import { useHubEvent } from '../api/useHub.ts';
import type { Toast } from './ToastHost.tsx';
import { type KeyValueStorage, loadShownWarnings, saveShownWarnings, usageWarningKey, usageWarningToast, warningsToShow } from './usage-warning.ts';

/** `window.localStorage`, or `null` where reading it throws (blocked site data). */
function browserStorage(): KeyValueStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * M9.2: shows a toast for every Max usage warning in force (`usageWarnings` on
 * `GET /api/system` when the page loads, then on every `system` hub event), once
 * per window and reset in this browser (`docs/usage.md`). Only a toast: no sound,
 * no OS notification, nothing is paused.
 */
export function useUsageWarnings(show: (toast: Toast) => void): void {
  const shown = useRef<Set<string> | null>(null);
  const handle = useCallback(
    (info: SystemInfo | null) => {
      const storage = browserStorage();
      shown.current ??= loadShownWarnings(storage);
      const now = Date.now();
      const fresh = warningsToShow(info?.usageWarnings, shown.current, now);
      if (fresh.length === 0) return;
      for (const warning of fresh) {
        shown.current.add(usageWarningKey(warning));
        show(usageWarningToast(warning, now));
      }
      saveShownWarnings(storage, shown.current);
    },
    [show],
  );
  useEffect(() => {
    let cancelled = false;
    api.system().then(
      (info) => {
        if (!cancelled) handle(info);
      },
      // 501 / 503 / unreachable: no warnings to show.
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [handle]);
  useHubEvent('system', handle);
}
