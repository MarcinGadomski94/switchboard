import { api } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { useHubEvent } from '../api/useHub.ts';
import { Link, type Route, useRouter } from '../router.tsx';
import { PANE_ID, usePanes } from './Panes.tsx';
import type { Pane } from './panes.ts';

/**
 * D74 · the compact layouts' top app bar and drawer controls (`docs/responsive.md`).
 * Mounted only on tablets and phones, so the desktop DOM is the prototype's.
 */

/** The title a page carries in the app bar. */
export function pageTitle(route: Route, toolName: string | null = null): string {
  switch (route.view) {
    case 'inbox':
      return 'Inbox';
    case 'solutions':
      return 'Solutions';
    case 'schedules':
      return 'Schedules & loops';
    case 'mcp':
      return 'MCP';
    case 'artifacts':
      return 'Artifacts';
    case 'history':
      return 'History';
    case 'todos':
      return 'Todos';
    case 'share':
      return 'Add to todos';
    case 'settings':
      return 'Settings';
    case 'tool':
      return toolName ?? 'Tool';
    case 'session':
      return 'Session';
  }
}

/** The number of Inbox items, live (`inboxChanged`). */
export function useInboxCount(): number {
  const inbox = useApi(api.inbox);
  useHubEvent('inboxChanged', () => inbox.reload());
  return inbox.data?.length ?? 0;
}

function MenuGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path d="M3 5h12M3 9h12M3 13h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function PanelGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8.5 2.5v9" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/**
 * The button that opens a drawer: the sidebar (☰, with the Inbox count as a
 * badge when `badge` > 0) or the session's right panel. It carries
 * `data-pane-handle`, so focus comes back to it when its drawer closes (D41's
 * focus rule, `Panes.tsx`).
 */
export function DrawerButton({ pane, badge = 0, className = '' }: { readonly pane: Pane; readonly badge?: number; readonly className?: string }) {
  const { state, toggle } = usePanes();
  const open = pane === 'sidebar' ? !state.sidebarHidden : !state.rightPanelHidden;
  const label = pane === 'sidebar' ? 'Menu' : 'Agents & terminal';
  return (
    <button
      type="button"
      className={`sb-button sb-drawer-button ${className}`}
      data-testid={pane === 'sidebar' ? 'drawer-open' : 'panel-open'}
      data-pane-handle={pane}
      aria-label={badge > 0 ? `${label} (${badge} in Inbox)` : label}
      aria-controls={PANE_ID[pane]}
      aria-expanded={open}
      onClick={() => toggle(pane)}
    >
      {pane === 'sidebar' ? <MenuGlyph /> : <PanelGlyph />}
      {badge > 0 ? (
        <span className="sb-drawer-badge" aria-hidden="true">
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The top app bar of the tablet and phone layouts: the menu button (the sidebar
 * drawer), the current page's title and the Inbox with its count. The session
 * view has none: its own header starts with the menu button (`SessionHeader`).
 */
export function AppBar() {
  const { route } = useRouter();
  const inbox = useInboxCount();
  const tools = useApi(api.tools);
  const toolName = route.view === 'tool' ? (tools.data?.find((tool) => tool.id === route.id)?.name ?? null) : null;
  return (
    <header className="sb-appbar" data-testid="app-bar">
      <DrawerButton pane="sidebar" />
      <h1 className="sb-appbar-title" data-testid="app-bar-title">
        {pageTitle(route, toolName)}
      </h1>
      <Link to={{ view: 'inbox' }} className="sb-appbar-inbox" data-testid="app-bar-inbox" aria-current={route.view === 'inbox' ? 'page' : undefined}>
        Inbox
        {inbox > 0 ? (
          <span className="sb-badge" data-kind="need" data-testid="app-bar-inbox-count">
            {inbox}
          </span>
        ) : null}
      </Link>
    </header>
  );
}
