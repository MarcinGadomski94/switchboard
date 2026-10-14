/**
 * D101 · the strokes of the icons of the sidebar's navigation grid (`docs/sidebar.md` → *Navigation
 * grid*): simple inline SVGs, 18 px, one stroke (~1.6) in `currentColor`, so a cell's
 * colour (rest, hover, selected) is the icon's. No icon library: the app draws its few
 * glyphs inline (the app bar's ☰ and search, the panes' toggles), and these follow them.
 * The component is `NavIcon` in `nav-icons.tsx`.
 */

/** A nav grid icon's name (one per view the grid opens). */
// Project memory (D107) hook: `memory` (docs/memory-removal.md).
export type NavIconName = 'inbox' | 'solutions' | 'schedules' | 'mcp' | 'artifacts' | 'history' | 'todos' | 'team' | 'plans' | 'memory' | 'search';

/** The strokes of each icon, on an 18 × 18 view box. */
export const NAV_ICON_GLYPHS: Readonly<Record<NavIconName, readonly string[]>> = {
  // A tray.
  inbox: ['M2.5 10.5 4.6 4h8.8l2.1 6.5v3.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z', 'M2.5 10.5h3.8l.9 1.8h3.6l.9-1.8h3.8'],
  // Stacked layers.
  solutions: ['M9 2.5 2.5 6 9 9.5 15.5 6z', 'M2.5 9 9 12.5 15.5 9', 'M2.5 12 9 15.5 15.5 12'],
  // Two arrows going round (a loop).
  schedules: ['M3 8.5a6 6 0 0 1 10.6-3.6', 'M15 9.5a6 6 0 0 1-10.6 3.6', 'M13.9 2.2v2.9H11', 'M4.1 15.8v-2.9H7'],
  // A plug.
  mcp: ['M6.5 2.5v3', 'M11.5 2.5v3', 'M4.5 5.5h9v2.5a4.5 4.5 0 0 1-9 0z', 'M9 12.5v3'],
  // A page with a folded corner.
  artifacts: ['M4.5 2.5h6l3 3v10h-9z', 'M10.5 2.5v3h3', 'M6.8 9.5h4.4', 'M6.8 12h4.4'],
  // A clock turned back.
  history: ['M3.4 7.2A6 6 0 1 1 3 9', 'M2.6 3.8v3.4H6', 'M9 5.8v3.4l2.3 1.4'],
  // A ticked box.
  todos: ['M4.5 2.5h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z', 'M5.8 9.2 8 11.4l4.2-4.6'],
  // A flag (⚑).
  team: ['M4.5 15.5v-13', 'M4.5 3h8.5l-2 3.2 2 3.3H4.5'],
  // Three nodes joined: a dependency graph.
  plans: ['M4 7a2 2 0 1 0 0 4 2 2 0 1 0 0-4z', 'M14 2a2 2 0 1 0 0 4 2 2 0 1 0 0-4z', 'M14 12a2 2 0 1 0 0 4 2 2 0 1 0 0-4z', 'M5.8 8.1 12.2 5', 'M5.8 9.9l6.4 3.1'],
  // A book with a bookmark (Project memory, D107).
  memory: ['M4 3.5a1.5 1.5 0 0 1 1.5-1.5h8v11.5h-8A1.5 1.5 0 0 0 4 15z', 'M4 15a1.5 1.5 0 0 0 1.5 1.5h8v-3', 'M8 2v5l1.5-1 1.5 1V2'],
  // A magnifier.
  search: ['M7.5 2.5a5 5 0 1 0 0 10 5 5 0 1 0 0-10z', 'M11.3 11.3 15.5 15.5'],
};

/** Every icon's name (the tests check each one is drawn). */
export const NAV_ICON_NAMES = Object.keys(NAV_ICON_GLYPHS) as readonly NavIconName[];

