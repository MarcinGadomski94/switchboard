import type { UpdateStatus } from '../../core/updates.ts';
import { bannerState } from '../../core/updates.ts';

/**
 * Pure helpers of the D55 update UI (banner, dialog, Settings → Updates),
 * kept free of React for unit tests. The copy itself is in `core/updates.ts`.
 */

/** What the banner shows: a newer release, an update's progress, "updated: reload", or nothing. */
export type BannerKind = 'available' | 'progress' | 'reload' | null;

/**
 * The banner of `status` for a page that first saw version `pageVersion`
 * (`null` = none yet): `reload` once the service runs another version than the
 * page was loaded with (the update restarted it), unless `hidden` (closed here).
 */
export function bannerKind(status: UpdateStatus | null, pageVersion: string | null, hidden: ReadonlySet<string> = new Set()): BannerKind {
  if (!status) return null;
  if (pageVersion !== null && status.current !== pageVersion) return hidden.has(`reload:${status.current}`) ? null : 'reload';
  const state = bannerState(status);
  if (state === 'progress') {
    const key = `progress:${status.progress.phase}:${status.progress.at ?? ''}`;
    // Only an ended update can be closed from the banner; a running one stays.
    return status.progress.phase === 'failed' || status.progress.phase === 'restart-manually' ? (hidden.has(key) ? null : 'progress') : 'progress';
  }
  return state;
}

/** The key the banner's × hides (see {@link bannerKind}); `null` when × dismisses on the server (a new release). */
export function hideKey(status: UpdateStatus, kind: BannerKind): string | null {
  if (kind === 'reload') return `reload:${status.current}`;
  if (kind === 'progress') return `progress:${status.progress.phase}:${status.progress.at ?? ''}`;
  return null;
}

/** `true` when the banner / dialog / Settings offer **Update** (a release install, a newer release, nothing running). */
export function canUpdate(status: UpdateStatus | null): boolean {
  if (!status || status.install.kind !== 'release' || !status.available || !status.latest || status.checking) return false;
  const phase = status.progress.phase;
  return phase === 'idle' || phase === 'failed';
}

/** A check or update time as the UI shows it (local date and time, minutes). */
export function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Settings → Updates "Latest release" description. */
export function latestDescription(status: UpdateStatus): string {
  if (!status.latest) return status.lastCheck?.ok ? 'No release published yet' : 'Not known yet';
  return status.available ? `Newer than yours (${status.current})` : "You're up to date";
}

/** Settings → Updates "Restart" value and description. */
export function restartRow(status: UpdateStatus): { readonly value: string; readonly description: string } {
  if (status.install.kind === 'git') return { value: 'by hand', description: 'A git checkout is updated with git; Switchboard only tells you about new releases' };
  return status.restart === 'service'
    ? { value: 'automatic', description: 'This Switchboard runs as the login service, which starts the new version' }
    : { value: 'by hand', description: 'Not running as the login service (Start at login): restart it yourself after an update' };
}
