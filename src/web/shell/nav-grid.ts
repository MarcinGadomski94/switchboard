import { type EditableSettings, readKnownSettings } from '../../core/settings.ts';

/**
 * D101 · the sidebar's navigation as an icon grid, and the collapsible TOOLS section
 * (`docs/sidebar.md` → *Navigation grid*, *TOOLS*). The pure parts: the grid's columns,
 * each cell's badge (the counts and indicators the text items showed before D101), its
 * tooltip, and the TOOLS header's state. The React side is `NavCell.tsx` and `Sidebar.tsx`.
 */

/** Columns of the grid on the desktop sidebar (two rows for today's seven items). */
export const NAV_GRID_COLUMNS = 5;

/** Columns of the grid in the tablet / phone drawer (D74), where each cell shows its name under the icon. */
export const NAV_DRAWER_COLUMNS = 4;

/**
 * How a badge is drawn: `need` amber (waits for you: Inbox, Team), `warn` an amber "!"
 * (Solutions' conflicts), `fail` red (failed schedules), `run` blue (running plans),
 * `count` a neutral number (artifacts, open todos).
 */
export type NavBadgeKind = 'need' | 'warn' | 'fail' | 'run' | 'count';

/** A cell's badge: the short text on the icon's corner and the full text for the tooltip. */
export interface NavBadge {
  readonly text: string;
  readonly kind: NavBadgeKind;
  /** The full wording, e.g. "1 conflict" (the cell's tooltip ends with it). */
  readonly title: string;
}

/** The most a badge spells out; a larger count reads "99+" (the tooltip has the number). */
export const BADGE_MAX = 99;

/** A count as a badge shows it: `n`, or "99+" above {@link BADGE_MAX}. */
export function badgeCount(n: number): string {
  return n > BADGE_MAX ? `${BADGE_MAX}+` : String(n);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A number badge of `kind`, `null` for nothing to show. */
function countBadge(n: number, kind: NavBadgeKind, title: string): NavBadge | null {
  return n > 0 ? { text: badgeCount(n), kind, title } : null;
}

/** Inbox: the items waiting (amber). */
export function inboxBadge(count: number): NavBadge | null {
  return countBadge(count, 'need', plural(count, 'item waiting', 'items waiting'));
}

/** Solutions: shared working trees in conflict (an amber "!", "1 conflict" in the tooltip). */
export function solutionsBadge(conflicts: number): NavBadge | null {
  return conflicts > 0 ? { text: '!', kind: 'warn', title: plural(conflicts, 'conflict', 'conflicts') } : null;
}

/** Schedules & loops: schedules whose last run failed (red). */
export function schedulesBadge(failed: number): NavBadge | null {
  return countBadge(failed, 'fail', `${failed} failed`);
}

/** Artifacts: the artifacts saved on purpose (D89; neutral). */
export function artifactsBadge(count: number): NavBadge | null {
  return countBadge(count, 'count', plural(count, 'artifact', 'artifacts'));
}

/** Todos: the open todos of the open sessions (D68; neutral). */
export function todosBadge(count: number): NavBadge | null {
  return countBadge(count, 'count', plural(count, 'open todo', 'open todos'));
}

/** Team (D100): members that need you (amber). */
export function teamBadge(count: number): NavBadge | null {
  return countBadge(count, 'need', `${count} need${count === 1 ? 's' : ''} you`);
}

/** Plans (D99): plans running now (blue). */
export function plansBadge(running: number): NavBadge | null {
  return countBadge(running, 'run', `${running} running`);
}

/** A cell's tooltip: its full name, then its badge's full text ("Solutions · 1 conflict"). */
export function navTitle(label: string, badge: NavBadge | null): string {
  return badge ? `${label} · ${badge.title}` : label;
}

/** Rows the grid takes for `cells` cells in `columns` columns. */
export function navRows(cells: number, columns: number): number {
  return Math.ceil(Math.max(0, cells) / Math.max(1, columns));
}

/** D101: the stored TOOLS state in a `GET /api/settings` body (missing or mistyped reads as expanded). */
export function toolsCollapsedFromSettings(body: Readonly<Record<string, unknown>> | null | undefined): boolean {
  return readKnownSettings(body)['ui.toolsCollapsed'];
}

/** The `PUT /api/settings` body that stores the TOOLS state. */
export function toolsCollapsedPatch(collapsed: boolean): Partial<EditableSettings> {
  return { 'ui.toolsCollapsed': collapsed };
}

/** The count after "Tools" while collapsed ("(2)"), empty while expanded or without tools. */
export function toolsHeadCount(collapsed: boolean, tools: number): string {
  return collapsed && tools > 0 ? `(${tools})` : '';
}

/** A tool state as the TOOLS header reads it (`tools/probe.ts`). */
export type ToolHealth = 'unset' | 'idle' | 'checking' | 'up' | 'down';

/** The collapsed header's dot: a sidebar tool is stopped / unreachable (its probe said `down`). */
export function toolsNeedAttention(states: readonly ToolHealth[]): boolean {
  return states.includes('down');
}
