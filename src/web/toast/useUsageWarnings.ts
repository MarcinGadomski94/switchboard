import { useCallback, useEffect, useRef } from 'react';
import type { SystemInfo, UsageWarning } from '../../core/api.ts';
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

/** Every warning of a `system` payload (module-level: a stable default for the hook's memo). */
const allWarnings = (info: SystemInfo | null): readonly UsageWarning[] | undefined => info?.usageWarnings;

/**
 * The Max usage warnings in force not shown in this browser yet (`usageWarnings`
 * on `GET /api/system` when the page loads, then on every `system` hub event),
 * each handed to `onFresh` once per window and reset in this browser
 * (`docs/usage.md`). `select` narrows the warnings looked at (v2 leaves out one
 * whose window dropped below the threshold); by default all of them.
 * Shared by the classic toast ({@link useUsageWarnings}) and v2's (`docs/v2.md`).
 */
export function useFreshUsageWarnings(
  onFresh: (warning: UsageWarning, now: number, info: SystemInfo | null) => void,
  select: (info: SystemInfo | null, now: number) => readonly UsageWarning[] | undefined = allWarnings,
): void {
  const shown = useRef<Set<string> | null>(null);
  const handle = useCallback(
    (info: SystemInfo | null) => {
      const storage = browserStorage();
      shown.current ??= loadShownWarnings(storage);
      const now = Date.now();
      const fresh = warningsToShow(select(info, now), shown.current, now);
      if (fresh.length === 0) return;
      for (const warning of fresh) {
        shown.current.add(usageWarningKey(warning));
        onFresh(warning, now, info);
      }
      saveShownWarnings(storage, shown.current);
    },
    [onFresh, select],
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

/**
 * M9.2: shows a toast for every Max usage warning in force, once per window and
 * reset in this browser ({@link useFreshUsageWarnings}, `docs/usage.md`). Only a
 * toast: no sound, no OS notification, nothing is paused.
 */
export function useUsageWarnings(show: (toast: Toast) => void): void {
  const onFresh = useCallback((warning: UsageWarning, now: number) => show(usageWarningToast(warning, now)), [show]);
  useFreshUsageWarnings(onFresh);
}
