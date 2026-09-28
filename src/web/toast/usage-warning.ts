import type { UsageWarning } from '../../core/api.ts';
import { usageWindowLabel } from '../../core/usage.ts';
import { formatResetsIn } from '../shell/format.ts';
import type { ToastContent } from './notify.ts';

/**
 * The Max usage warning toast (M9.2, `docs/usage.md`). The server fires a warning
 * once per window until that window resets and lists it on `/api/system` and the
 * `system` event (`usageWarnings`) while it is in force; this page shows each one
 * as a toast once ("just warn": nothing is paused). Which ones this browser has
 * shown is remembered in `localStorage` (a per-viewer convenience; without it a
 * reload may show a warning again).
 */

/** `localStorage` key of the warnings this browser has shown. */
export const SHOWN_WARNINGS_KEY = 'switchboard.usageWarningsShown';

/** At most this many keys are remembered (a warning per window and reset; old ones are useless). */
const MAX_REMEMBERED = 20;

/** One key per window (D17: per model for a model-scoped one) and reset: a later reset of the same window is a new warning. */
export function usageWarningKey(warning: Pick<UsageWarning, 'window' | 'resetsAt' | 'model'>): string {
  const window = warning.window === 'model' ? `model:${warning.model ?? ''}` : warning.window;
  return `${window}@${warning.resetsAt}`;
}

/**
 * The toast for a warning: `Max usage 91%` · `5-hour window`, and the text
 * `Your Max 5-hour window reached 91% (warning at 90%). It resets in 1h48. Nothing is paused automatically.`
 * A model-scoped window (D17) reads `Fable weekly limit`. No session to jump to (only "Later").
 */
export function usageWarningToast(warning: UsageWarning, now: number = Date.now()): ToastContent {
  const label = usageWindowLabel(warning);
  const pct = Math.round(warning.pct);
  return {
    id: `usage-${usageWarningKey(warning)}`,
    title: `Max usage ${pct}%`,
    sub: label,
    branch: '',
    text: `Your Max ${label} reached ${pct}% (warning at ${warning.threshold}%). It resets in ${formatResetsIn(warning.resetsAt, now)}. Nothing is paused automatically.`,
    sessionId: null,
  };
}

/** The warnings of a `system` payload not shown yet and still in force at `now`. */
export function warningsToShow(warnings: readonly UsageWarning[] | undefined, shown: ReadonlySet<string>, now: number = Date.now()): UsageWarning[] {
  return (warnings ?? []).filter((warning) => !shown.has(usageWarningKey(warning)) && Date.parse(warning.resetsAt) > now);
}

/** The minimal storage this needs (`window.localStorage`; tests pass a map). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The keys this browser has shown; empty when storage is missing, blocked or holds something else. */
export function loadShownWarnings(storage: KeyValueStorage | null): Set<string> {
  try {
    const raw = storage?.getItem(SHOWN_WARNINGS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Remembers the shown keys (the newest {@link MAX_REMEMBERED}); storage failures are ignored. */
export function saveShownWarnings(storage: KeyValueStorage | null, shown: ReadonlySet<string>): void {
  try {
    storage?.setItem(SHOWN_WARNINGS_KEY, JSON.stringify([...shown].slice(-MAX_REMEMBERED)));
  } catch {
    // Private window, blocked storage: the in-page memory still stops repeats.
  }
}
