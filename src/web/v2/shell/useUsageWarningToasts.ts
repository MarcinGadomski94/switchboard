import { useCallback } from 'react';
import type { SystemInfo, UsageWarning } from '../../../core/api.ts';
import { useFreshUsageWarnings } from '../../toast/useUsageWarnings.ts';
import { useToast } from '../components/index.ts';
import { useV2Router } from '../nav.tsx';
import { usageWarningToastText, warningsInForce } from '../shared/usage-warning-model.ts';

/** How long a usage warning's toast stays (longer than the default: it is not a reply to a click). */
export const USAGE_WARNING_TOAST_MS = 12_000;

/**
 * Fix after 2.0 · v2's toast for every Max usage warning in force
 * (`docs/v2.md` → *Usage warnings*): `Claude ‘Work’ — 5-hour window at 92% ·
 * Resets 15:40` with **View usage** (Settings › Usage & accounts). Shown once
 * per window and reset in this browser, the same memory as classic's toast
 * (`useFreshUsageWarnings`), so switching themes does not repeat one. Only a
 * toast, like classic: no sound, no OS notification, no push, nothing paused.
 */
export function useUsageWarningToasts(): void {
  const toast = useToast();
  const { navigate } = useV2Router();
  const onFresh = useCallback(
    (warning: UsageWarning, now: number, info: SystemInfo | null) =>
      toast({ text: usageWarningToastText(warning, info, now), tone: 'warn', actionLabel: 'View usage', undo: () => navigate('/settings/usage'), ms: USAGE_WARNING_TOAST_MS }),
    [toast, navigate],
  );
  useFreshUsageWarnings(onFresh, warningsInForce);
}
