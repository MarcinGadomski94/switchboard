/**
 * D100 · what the Team page keeps in this browser (`localStorage`): the suggestions
 * the developer dismissed (Undo brings one back) and the suggestions the banner's
 * "Later" put away (the banner comes back when a new one appears). Nothing of it is
 * a setting; losing it only shows a suggestion again. Plus the brief highlight of a
 * returned session's row in the sidebar.
 */

const DISMISSED = 'sb.team.dismissed';
const LATER = 'sb.team.bannerLater';

function read(key: string): string[] | null {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : null;
  } catch {
    return null;
  }
}

function write(key: string, value: readonly string[]): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode / full storage: kept for this page only.
  }
}

/** The dismissed suggestions' session ids. */
export function dismissedSuggestions(): Set<string> {
  return new Set(read(DISMISSED) ?? []);
}

/** Dismisses (`true`) or brings back (`false`) a suggestion. */
export function setDismissed(sessionId: string, dismissed: boolean): Set<string> {
  const set = dismissedSuggestions();
  if (dismissed) set.add(sessionId);
  else set.delete(sessionId);
  write(DISMISSED, [...set]);
  return set;
}

/** The suggestion ids the banner was put away with ("Later"); `null` = never. */
export function bannerLaterIds(): string[] | null {
  return read(LATER);
}

/** "Later": the banner stays away until a suggestion not in `ids` appears. */
export function setBannerLater(ids: readonly string[]): void {
  write(LATER, ids);
}

/** How long a returned session's row stays highlighted in the sidebar. */
export const RETURNED_HIGHLIGHT_MS = 2_500;

/**
 * Highlights the returned session's sidebar row for a moment once it is listed again
 * (after `teamChanged` reaches the sidebar). DOM only: the sidebar knows nothing of it.
 */
export function highlightReturnedRow(sessionId: string): void {
  if (typeof document === 'undefined') return;
  const deadline = Date.now() + 5_000;
  const find = (): void => {
    const row = document.querySelector<HTMLElement>(`[data-testid="sidebar-sessions"] a.sb-session[data-session-id="${CSS.escape(sessionId)}"]`);
    if (row) {
      row.setAttribute('data-team-returned', 'true');
      row.scrollIntoView({ block: 'nearest' });
      setTimeout(() => row.removeAttribute('data-team-returned'), RETURNED_HIGHLIGHT_MS);
      return;
    }
    if (Date.now() < deadline) setTimeout(find, 100);
  };
  find();
}

const LAST_TEAM = 'sb.team.last';

/** D100 follow-up 2026-10-14: the team last shown on the Team page (`/team` opens it), `null` when none. */
export function lastTeam(): string | null {
  try {
    return globalThis.localStorage?.getItem(LAST_TEAM) ?? null;
  } catch {
    return null;
  }
}

/** Remembers the team shown on the Team page. */
export function setLastTeam(teamId: string): void {
  try {
    globalThis.localStorage?.setItem(LAST_TEAM, teamId);
  } catch {
    // Private mode / full storage: `/team` opens the first team.
  }
}
