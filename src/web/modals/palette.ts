import type { Session, SolutionGroup, Tool } from '../../core/api.ts';
import { openSessions } from '../../core/session-close.ts';
import { displayTitle } from '../../core/session-title.ts';
import { captureTargets, captureTitle, paletteTodoText } from '../../core/todo-capture.ts';
import { TODO_TITLE_MAX } from '../../core/todos.ts';
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
export type PaletteKind = 'view' | 'action' | 'tool' | 'session' | 'solution' | 'todo';

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
  | { readonly type: 'solution'; readonly path: string }
  /** D81: "Add todo…": the query becomes `todo ` (the palette stays open for the title). */
  | { readonly type: 'add-todo' }
  /** D81: capture `title` (and `note`, the whole text when the title had to be cut) into the session. */
  | { readonly type: 'capture'; readonly sessionId: string; readonly title: string; readonly note: string | null }
  /** D81: `todo ` without a title yet: nothing to pick. */
  | { readonly type: 'none' }
  /** D85: replay the tutorial's main tour. */
  | { readonly type: 'tutorial' };

/** One palette result: a kind label, the label and a mono hint (may be empty). */
export interface PaletteEntry {
  /** Stable React key, unique in the list. */
  readonly key: string;
  readonly kind: PaletteKind;
  readonly label: string;
  readonly hint: string;
  readonly target: PaletteTarget;
  /** Extra text the filter matches but the row does not show (D22: a titled session's short name). */
  readonly also?: string;
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
 * host, empty when not configured) · sessions (label = the display title, D22: the
 * title, else the name; a titled session's name is searched too; hint = the
 * sidebar's mode line; D33: closed sessions are left out) ·
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
  // D81: quick capture (typing `todo <text>` does the same directly).
  entries.push({ key: 'action:add-todo', kind: 'action', label: ADD_TODO_LABEL, hint: 'todo <title>', target: { type: 'add-todo' } });
  for (const tool of data.tools ?? []) {
    entries.push({ key: `tool:${tool.id}`, kind: 'tool', label: tool.name, hint: urlHost(tool.url), target: { type: 'route', route: { view: 'tool', id: tool.id } } });
  }
  // D33: closed sessions are not offered (the service leaves them out already; a stale list may still hold one).
  for (const session of openSessions(data.sessions ?? [])) {
    const label = displayTitle(session);
    entries.push({
      key: `session:${session.id}`,
      kind: 'session',
      label,
      hint: modeLine(session),
      target: { type: 'route', route: { view: 'session', id: session.id, tab: 'chat' } },
      ...(label !== session.name ? { also: session.name } : {}),
    });
  }
  for (const group of data.solutions ?? []) {
    for (const solution of group.solutions) {
      entries.push({ key: `solution:${solution.path}`, kind: 'solution', label: solution.name, hint: group.folder, target: { type: 'solution', path: solution.path } });
    }
  }
  // D85: the tutorial's replay, last (the prototype's first ten results stay as they were).
  entries.push({ key: 'action:tutorial', kind: 'action', label: TUTORIAL_LABEL, hint: 'replay the tour', target: { type: 'tutorial' }, also: "tour what's new help guide" });
  return entries;
}

/**
 * The results for `query`: entries whose `label kind hint` contains the query
 * (case-insensitive; an empty query keeps all), or (D22) whose hidden `also` text
 * does, in list order, at most {@link PALETTE_MAX_RESULTS}.
 */
export function filterPalette(entries: readonly PaletteEntry[], query: string): PaletteEntry[] {
  const q = query.toLowerCase();
  const matches = q
    ? entries.filter((entry) => `${entry.label} ${entry.kind} ${entry.hint}`.toLowerCase().includes(q) || (entry.also?.toLowerCase().includes(q) ?? false))
    : [...entries];
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

/** D81: the palette's capture action (picking it types `todo ` for the title). */
export const ADD_TODO_LABEL = 'Add todo…';

/** D85: the palette's replay of the tutorial. */
export const TUTORIAL_LABEL = 'Tutorial';

/** D81: the query "Add todo…" fills in. */
export const ADD_TODO_QUERY = 'todo ';

/**
 * D81 · `todo <text>` (`docs/todos.md` → *Quick capture (D81)*): the results while the query is
 * a `todo` command ({@link paletteTodoText}), `null` otherwise. In a session, the first row adds
 * the item to that session; then (and outside a session, only) the other open sessions, most
 * recently active first, as targets to pick. The title is the text (cut at a word to 120
 * characters, the whole text then kept as the note). `todo ` alone: one row asking for the title.
 */
export function paletteTodoEntries(query: string, sessions: readonly Session[] | null, currentSessionId: string | null): PaletteEntry[] | null {
  const text = paletteTodoText(query);
  if (text === null) return null;
  if (text === '') return [{ key: 'todo:empty', kind: 'todo', label: ADD_TODO_LABEL, hint: 'type the title', target: { type: 'none' } }];
  const title = text.length <= TODO_TITLE_MAX && !/[\r\n]/.test(text) ? text : captureTitle(text, TODO_TITLE_MAX);
  const note = title === text ? null : text;
  const targets = captureTargets(sessions ?? []);
  const current = currentSessionId === null ? undefined : targets.find((session) => session.id === currentSessionId);
  const rows: PaletteEntry[] = [];
  if (current) {
    rows.push({ key: `todo:${current.id}`, kind: 'todo', label: `Add “${title}”`, hint: `to ${displayTitle(current)}`, target: { type: 'capture', sessionId: current.id, title, note } });
  }
  for (const session of targets) {
    if (session.id === current?.id) continue;
    rows.push({ key: `todo:${session.id}`, kind: 'todo', label: current ? `Add to ${displayTitle(session)}` : displayTitle(session), hint: current ? '' : `add “${title}”`, target: { type: 'capture', sessionId: session.id, title, note } });
  }
  return rows.slice(0, PALETTE_MAX_RESULTS);
}
