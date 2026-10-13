import { type AnchorHTMLAttributes, type MouseEvent, type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * A small history router for the app's views (no dependency). The server answers
 * every non-file GET with index.html (src/server/web.ts), so these paths also
 * work on reload:
 *
 * | Path | View |
 * |---|---|
 * | `/`, `/inbox` | Inbox |
 * | `/sessions/:id[/:tab]` | Session (tab: chat · timeline · diff · artifacts) |
 * | `/sessions/:id/agents/:agentId` | Session, chat tab: that subagent's own chat (D36) |
 * | `/sessions/:id/artifacts/:artifactId` | Session, Artifacts tab with that artifact open (D89) |
 * | `/sessions/:id/events/:eventId` | D97: Session, chat tab, scrolled to that event and highlighted (a search result) |
 * | `/sessions/:id/agents/:agentId/events/:eventId` | D97: that subagent's chat at that event |
 * | `/solutions` | Solutions |
 * | `/schedules` | Schedules & loops |
 * | `/mcp` | MCP servers (D61) |
 * | `/artifacts` | Artifacts |
 * | `/history` | History |
 * | `/todos` | Todos: every session's todo list (D68) |
 * | `/search` | D97: Search across everything (the query in `?q=`) |
 * | `/share` | D81: a share from the phone's share sheet: "Add to which session?" (the shared fields in the query) |
 * | `/tools/:id` | Embedded tool |
 * | `/settings[/:section]` | Settings |
 * | `/team` | D100: the Team page (only while Team is on; Team (D100) hook, docs/team-removal.md) |
 *
 * Unknown paths show the Inbox.
 */

/** The views of the sidebar nav (SPEC → Shell) plus the session, tool and settings views. */
// Team (D100) hook: the `team` view (docs/team-removal.md).
export type ViewName = 'inbox' | 'session' | 'solutions' | 'schedules' | 'mcp' | 'artifacts' | 'history' | 'todos' | 'search' | 'share' | 'tool' | 'settings' | 'team';

/** Session view tabs (SPEC → Session). */
export const SESSION_TABS = ['chat', 'timeline', 'diff', 'artifacts'] as const;
/** A session view tab. */
export type SessionTab = (typeof SESSION_TABS)[number];

/** The parsed current location. */
export type Route =
  | { readonly view: 'inbox' | 'solutions' | 'schedules' | 'mcp' | 'artifacts' | 'history' | 'todos' | 'search' | 'share' | 'team' }
  | {
      readonly view: 'session';
      readonly id: string;
      readonly tab: SessionTab;
      /** D36: a subagent's id: the chat tab shows that subagent's own chat (`/sessions/{id}/agents/{agentId}`). */
      readonly agentId?: string;
      /** D89: the Artifacts tab opens this artifact (`/sessions/{id}/artifacts/{artifactId}`). */
      readonly artifactId?: string;
      /** D97: the chat opens at this event, scrolled to it and highlighted (`/sessions/{id}[/agents/{agentId}]/events/{eventId}`). */
      readonly eventId?: number;
    }
  | { readonly view: 'tool'; readonly id: string }
  | { readonly view: 'settings'; readonly section: string | null };

const SIMPLE_VIEWS = ['inbox', 'solutions', 'schedules', 'mcp', 'artifacts', 'history', 'todos', 'search', 'share', 'team'] as const;

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** D97: a positive whole event id in a path. */
function isEventId(value: string | undefined): value is string {
  return value !== undefined && /^[1-9][0-9]{0,15}$/.test(value);
}

/** Parses a pathname into a {@link Route}. */
export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean).map(decode);
  const [head, a, b, c, d, e] = parts;
  if (head === undefined) return { view: 'inbox' };
  if ((SIMPLE_VIEWS as readonly string[]).includes(head) && parts.length === 1) {
    return { view: head as (typeof SIMPLE_VIEWS)[number] };
  }
  if (head === 'sessions' && a) {
    // D36: `/sessions/{id}/agents/{agentId}` is the chat tab in subagent mode.
    // D97: `…/events/{eventId}` opens the chat at that event (a search result).
    if (b === 'agents' && c && d === 'events' && isEventId(e)) return { view: 'session', id: a, tab: 'chat', agentId: c, eventId: Number(e) };
    if (b === 'agents' && c) return { view: 'session', id: a, tab: 'chat', agentId: c };
    if (b === 'events' && isEventId(c)) return { view: 'session', id: a, tab: 'chat', eventId: Number(c) };
    // D89: `/sessions/{id}/artifacts/{artifactId}` opens that artifact in the Artifacts tab.
    if (b === 'artifacts' && c) return { view: 'session', id: a, tab: 'artifacts', artifactId: c };
    const tab = (SESSION_TABS as readonly string[]).includes(b ?? '') ? (b as SessionTab) : 'chat';
    return { view: 'session', id: a, tab };
  }
  if (head === 'tools' && a) return { view: 'tool', id: a };
  if (head === 'settings') return { view: 'settings', section: a ?? null };
  return { view: 'inbox' };
}

/** The pathname of a {@link Route}. */
export function routePath(route: Route): string {
  switch (route.view) {
    case 'session':
      if (route.agentId) return `/sessions/${encodeURIComponent(route.id)}/agents/${encodeURIComponent(route.agentId)}${route.eventId === undefined ? '' : `/events/${route.eventId}`}`;
      if (route.tab === 'chat' && route.eventId !== undefined) return `/sessions/${encodeURIComponent(route.id)}/events/${route.eventId}`;
      if (route.tab === 'artifacts' && route.artifactId) return `/sessions/${encodeURIComponent(route.id)}/artifacts/${encodeURIComponent(route.artifactId)}`;
      return `/sessions/${encodeURIComponent(route.id)}${route.tab === 'chat' ? '' : `/${route.tab}`}`;
    case 'tool':
      return `/tools/${encodeURIComponent(route.id)}`;
    case 'settings':
      return route.section ? `/settings/${encodeURIComponent(route.section)}` : '/settings';
    default:
      return `/${route.view}`;
  }
}

interface RouterValue {
  readonly route: Route;
  /** D97: the address's query (`location.search`, e.g. `?q=…` on the Search page); `''` without one. */
  readonly search: string;
  readonly navigate: (to: Route | string, options?: { readonly replace?: boolean }) => void;
  /**
   * D36: returns to `to`: one step back in the browser's history when the current
   * entry was opened from `to` inside the app (so Back and Forward stay in step),
   * else a plain navigation to it (a reloaded or pasted address).
   */
  readonly backTo: (to: Route) => void;
}

/** What the router keeps in `history.state` (D36): the path an entry was opened from inside the app. */
interface RouterHistoryState {
  readonly from?: string;
}

/** D36: the path the current history entry was opened from inside the app, `null` when unknown. */
function openedFrom(): string | null {
  const state = window.history.state as RouterHistoryState | null;
  return state && typeof state.from === 'string' ? state.from : null;
}

const RouterContext = createContext<RouterValue | null>(null);

/** Provides the current route; listens to back/forward. */
export function RouterProvider({ children }: { readonly children: ReactNode }) {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  // D97: the query too (the Search page keeps its text in `?q=`); a path without one clears it.
  const [search, setSearch] = useState(() => window.location.search);

  useEffect(() => {
    const onPop = (): void => {
      setPathname(window.location.pathname);
      setSearch(window.location.search);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: Route | string, options?: { readonly replace?: boolean }) => {
    const target = typeof to === 'string' ? to : routePath(to);
    // D97: a string target may carry a query (`/search?q=…`): the path and the query are kept apart.
    const cut = target.indexOf('?');
    const path = cut < 0 ? target : target.slice(0, cut);
    const query = cut < 0 ? '' : target.slice(cut);
    if (path !== window.location.pathname || query !== window.location.search) {
      if (options?.replace) window.history.replaceState(null, '', target);
      else window.history.pushState({ from: window.location.pathname } satisfies RouterHistoryState, '', target);
    }
    setPathname(path);
    setSearch(query);
  }, []);

  const backTo = useCallback(
    (to: Route) => {
      if (openedFrom() === routePath(to)) window.history.back();
      else navigate(to);
    },
    [navigate],
  );

  const value = useMemo<RouterValue>(() => ({ route: parseRoute(pathname), search, navigate, backTo }), [pathname, search, navigate, backTo]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

/** The current route and `navigate`. */
export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error('useRouter outside RouterProvider');
  return value;
}

/** An `<a>` that navigates client-side on a plain left click (modifier clicks open a new tab as usual). */
export function Link({ to, onClick, ...rest }: { readonly to: Route } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const { navigate } = useRouter();
  const href = routePath(to);
  const handle = (event: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return <a {...rest} href={href} onClick={handle} />;
}
