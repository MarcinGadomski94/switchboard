import type { Session, SolutionGroup, Tool } from '../../core/api.ts';
import { modeLine, urlHost } from '../shell/format.ts';

/**
 * The ⌘K / Ctrl+K palette's model (SPEC → Modals → Palette, M8.3), pure so the
 * Vitest suite covers it. It follows the prototype's `PAL` list: the six views,
 * the "New session" action, the embedded tools, the sessions and the solutions,
 * in that order, filtered by a case-insensitive substring of
 * `label kind hint` and cut to {@link PALETTE_MAX_RESULTS}. Everything but the
 * views and the action comes from the API (`docs/derivations.md` → *Palette*).
 */

/** Kind label of a result (shown upper-cased). */
export type PaletteKind = 'view' | 'action' | 'tool' | 'session' | 'solution';

/**
 * The routes the palette navigates to: a structural subset of the router's
 * `Route` (`router.tsx`), declared here so this model stays free of JSX modules.
 */
export type PaletteRoute =
  | { readonly view: 'inbox' | 'solutions' | 'schedules' | 'artifacts' | 'history' }
  | { readonly view: 'session'; readonly id: string; readonly tab: 'chat' }
  | { readonly view: 'tool'; readonly id: string }
  | { readonly view: 'settings'; readonly section: null };

/** What picking a result does. */
export type PaletteTarget =
  /** Navigate to a view, a tool or a session. */
  | { readonly type: 'route'; readonly route: PaletteRoute }
  /** Open the New-session modal. */
  | { readonly type: 'new-session' }
  /** Open the Solutions view with this solution (its `path`) selected. */
  | { readonly type: 'solution'; readonly path: string };

/** One palette result: a kind label, the label and a mono hint (may be empty). */
export interface PaletteEntry {
  /** Stable React key, unique in the list. */
  readonly key: string;
  readonly kind: PaletteKind;
  readonly label: string;
  readonly hint: string;
  readonly target: PaletteTarget;
}

/** At most this many results are shown (prototype `.slice(0, 10)`). */
export const PALETTE_MAX_RESULTS = 10;

/** Placeholder of the palette's input (prototype copy). */
export const PALETTE_PLACEHOLDER = 'Jump to a session, solution, view or tool…';

/** The views the palette lists, in the prototype's order, with their labels. */
export const PALETTE_VIEWS: ReadonlyArray<readonly [route: PaletteRoute, label: string]> = [
  [{ view: 'inbox' }, 'Inbox'],
  [{ view: 'solutions' }, 'Solutions'],
  [{ view: 'schedules' }, 'Schedules & loops'],
  [{ view: 'artifacts' }, 'Artifacts'],
  [{ view: 'history' }, 'History'],
  [{ view: 'settings', section: null }, 'Settings'],
];

/** What the palette lists besides the fixed views and action: the API's lists (`null` = not loaded / not available). */
export interface PaletteData {
  readonly sessions: readonly Session[] | null;
  readonly tools: readonly Tool[] | null;
  readonly solutions: readonly SolutionGroup[] | null;
}

/**
 * Every palette entry, unfiltered: views · New session · tools (hint = the URL's
 * host, empty when not configured) · sessions (hint = the sidebar's mode line) ·
 * solutions (hint = the folder group, e.g. `microfrontends/`). Lists that are not
 * available yet add nothing.
 */
export function paletteEntries(data: PaletteData): PaletteEntry[] {
  const entries: PaletteEntry[] = PALETTE_VIEWS.map(([route, label]) => ({
    key: `view:${route.view}`,
    kind: 'view',
    label,
    hint: '',
    target: { type: 'route', route },
  }));
  entries.push({ key: 'action:new-session', kind: 'action', label: 'New session', hint: '', target: { type: 'new-session' } });
  for (const tool of data.tools ?? []) {
    entries.push({ key: `tool:${tool.id}`, kind: 'tool', label: tool.name, hint: urlHost(tool.url), target: { type: 'route', route: { view: 'tool', id: tool.id } } });
  }
  for (const session of data.sessions ?? []) {
    entries.push({
      key: `session:${session.id}`,
      kind: 'session',
      label: session.name,
      hint: modeLine(session),
      target: { type: 'route', route: { view: 'session', id: session.id, tab: 'chat' } },
    });
  }
  for (const group of data.solutions ?? []) {
    for (const solution of group.solutions) {
      entries.push({ key: `solution:${solution.path}`, kind: 'solution', label: solution.name, hint: group.folder, target: { type: 'solution', path: solution.path } });
    }
  }
  return entries;
}

/**
 * The results for `query`: entries whose `label kind hint` contains the query
 * (case-insensitive; an empty query keeps all), in list order, at most
 * {@link PALETTE_MAX_RESULTS}.
 */
export function filterPalette(entries: readonly PaletteEntry[], query: string): PaletteEntry[] {
  const q = query.toLowerCase();
  const matches = q ? entries.filter((entry) => `${entry.label} ${entry.kind} ${entry.hint}`.toLowerCase().includes(q)) : [...entries];
  return matches.slice(0, PALETTE_MAX_RESULTS);
}

/** The highlighted row for a stored index: clamped into the results (0 when there are none). */
export function clampIndex(index: number, count: number): number {
  return Math.max(0, Math.min(index, count - 1));
}

/** The index after ↑ (`-1`) or ↓ (`+1`): it stops at the first and the last row, no wrap. */
export function moveIndex(index: number, count: number, step: 1 | -1): number {
  return clampIndex(clampIndex(index, count) + step, count);
}
