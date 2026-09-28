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
 * | `/solutions` | Solutions |
 * | `/schedules` | Schedules & loops |
 * | `/artifacts` | Artifacts |
 * | `/history` | History |
 * | `/tools/:id` | Embedded tool |
 * | `/settings[/:section]` | Settings |
 *
 * Unknown paths show the Inbox.
 */

/** The views of the sidebar nav (SPEC → Shell) plus the session, tool and settings views. */
export type ViewName = 'inbox' | 'session' | 'solutions' | 'schedules' | 'artifacts' | 'history' | 'tool' | 'settings';

/** Session view tabs (SPEC → Session). */
export const SESSION_TABS = ['chat', 'timeline', 'diff', 'artifacts'] as const;
/** A session view tab. */
export type SessionTab = (typeof SESSION_TABS)[number];

/** The parsed current location. */
export type Route =
  | { readonly view: 'inbox' | 'solutions' | 'schedules' | 'artifacts' | 'history' }
  | {
      readonly view: 'session';
      readonly id: string;
      readonly tab: SessionTab;
      /** D36: a subagent's id: the chat tab shows that subagent's own chat (`/sessions/{id}/agents/{agentId}`). */
      readonly agentId?: string;
    }
  | { readonly view: 'tool'; readonly id: string }
  | { readonly view: 'settings'; readonly section: string | null };

const SIMPLE_VIEWS = ['inbox', 'solutions', 'schedules', 'artifacts', 'history'] as const;

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Parses a pathname into a {@link Route}. */
export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean).map(decode);
  const [head, a, b, c] = parts;
  if (head === undefined) return { view: 'inbox' };
  if ((SIMPLE_VIEWS as readonly string[]).includes(head) && parts.length === 1) {
    return { view: head as (typeof SIMPLE_VIEWS)[number] };
  }
  if (head === 'sessions' && a) {
    // D36: `/sessions/{id}/agents/{agentId}` is the chat tab in subagent mode.
    if (b === 'agents' && c) return { view: 'session', id: a, tab: 'chat', agentId: c };
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
      if (route.agentId) return `/sessions/${encodeURIComponent(route.id)}/agents/${encodeURIComponent(route.agentId)}`;
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

  useEffect(() => {
    const onPop = (): void => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: Route | string, options?: { readonly replace?: boolean }) => {
    const target = typeof to === 'string' ? to : routePath(to);
    if (target !== window.location.pathname) {
      if (options?.replace) window.history.replaceState(null, '', target);
      else window.history.pushState({ from: window.location.pathname } satisfies RouterHistoryState, '', target);
    }
    setPathname(target);
  }, []);

  const backTo = useCallback(
    (to: Route) => {
      if (openedFrom() === routePath(to)) window.history.back();
      else navigate(to);
    },
    [navigate],
  );

  const value = useMemo<RouterValue>(() => ({ route: parseRoute(pathname), navigate, backTo }), [pathname, navigate, backTo]);
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
