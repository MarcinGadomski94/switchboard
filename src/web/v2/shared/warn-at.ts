import { useEffect, useSyncExternalStore } from 'react';
import { DEFAULT_WARN_AT_PCT, WARN_AT_PCT_SETTING, warnThreshold } from '../../../core/usage.ts';
import { api } from '../../api/client.ts';

/**
 * Fix after 2.0 · the developer's usage warning threshold (`usage.warnAtPct`,
 * Settings › Usage & accounts → "Warn at") for v2's status pill and Settings
 * (`docs/v2.md` → *Usage warnings*): read once from `GET /api/settings`, saved
 * with `PUT /api/settings`; every v2 view sees a save at once. A change made in
 * a classic Advanced page shows here after a reload (there is no settings event).
 */

let value = DEFAULT_WARN_AT_PCT;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: number): void {
  if (next === value) return;
  value = next;
  for (const listener of listeners) listener();
}

function load(): void {
  loading ??= api.settings().then(
    (settings) => set(warnThreshold(settings[WARN_AT_PCT_SETTING])),
    () => {
      loading = null;
    },
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The threshold (90 until read, or when the stored one is not a whole 1–100). */
export function useWarnAt(): number {
  useEffect(load, []);
  return useSyncExternalStore(subscribe, () => value, () => value);
}

/** Saves the threshold (the same setting classic's "Warn at Max usage" saves); rejects when the server refuses. */
export async function saveWarnAt(pct: number): Promise<number> {
  const saved = await api.saveSettings({ [WARN_AT_PCT_SETTING]: pct });
  const next = warnThreshold(saved[WARN_AT_PCT_SETTING] ?? pct);
  set(next);
  return next;
}
