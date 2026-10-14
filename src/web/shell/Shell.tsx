import { useEffect } from 'react';
import { FirstRunGate } from '../modals/FirstRunGate.tsx';
import { ModalHost } from '../modals/ModalHost.tsx';
import { type Route, useRouter } from '../router.tsx';
import { TakeoverHost } from '../takeover/TakeoverDialog.tsx';
import { ContinueHookedHost } from '../hooked-continue/ContinueHookedDialog.tsx';
import { RevertHost } from '../views/session/RevertTurn.tsx';
import { ToastHost } from '../toast/ToastHost.tsx';
import { UpdateBanner } from '../updates/UpdateBanner.tsx';
import { ArtifactsView } from '../views/ArtifactsView.tsx';
import { HistoryView } from '../views/HistoryView.tsx';
import { InboxView } from '../views/InboxView.tsx';
import { McpView } from '../views/McpView.tsx';
import { SchedulesView } from '../views/SchedulesView.tsx';
import { SettingsView } from '../views/SettingsView.tsx';
import { SolutionsView } from '../views/SolutionsView.tsx';
import { TodosView } from '../views/TodosView.tsx';
import { SearchView } from '../views/SearchView.tsx';
import { InsightsView } from '../views/insights/InsightsView.tsx';
import { SharePage } from '../capture/SharePage.tsx';
import { ToolView } from '../views/ToolView.tsx';
import { SessionView } from '../views/session/SessionView.tsx';
import { PaneHandle, usePanes } from './Panes.tsx';
import { Sidebar } from './Sidebar.tsx';
import { AppBar } from './AppBar.tsx';
import { TouchTooltip } from './TouchTooltip.tsx';
import { TourHost } from '../tutorial/TourHost.tsx';
// Team (D100) hook: the Team page (docs/team-removal.md).
import { TeamPage } from '../team/TeamPage.tsx';
// Plans (D99) hook: the Plans pages (docs/plans-removal.md).
import { PlanPage } from '../plans/PlanPage.tsx';
import { PlansPage } from '../plans/PlansPage.tsx';
// Project memory (D107) hook: the Memory page (docs/memory-removal.md).
import { MemoryPage } from '../memory/MemoryPage.tsx';
import './shell.css';

function View({ route }: { readonly route: Route }) {
  switch (route.view) {
    case 'inbox':
      return <InboxView />;
    case 'session':
      return <SessionView key={route.id} sessionId={route.id} tab={route.tab} agentId={route.agentId ?? null} artifactId={route.artifactId ?? null} eventId={route.eventId ?? null} />;
    case 'solutions':
      return <SolutionsView />;
    case 'schedules':
      return <SchedulesView />;
    case 'mcp':
      return <McpView />;
    case 'artifacts':
      return <ArtifactsView />;
    case 'history':
      return <HistoryView />;
    case 'todos':
      return <TodosView />;
    case 'search':
      return <SearchView />;
    case 'insights':
      return <InsightsView />;
    case 'share':
      return <SharePage />;
    case 'tool':
      return <ToolView key={route.id} toolId={route.id} />;
    case 'settings':
      return <SettingsView section={route.section} />;
    case 'team':
      return <TeamPage />;
    // Plans (D99) hook (docs/plans-removal.md).
    case 'plans':
      return <PlansPage />;
    case 'plan':
      return <PlanPage key={route.id} planId={route.id} />;
    // Project memory (D107) hook (docs/memory-removal.md).
    case 'memory':
      return <MemoryPage />;
  }
}

/**
 * The app shell (SPEC → Shell): grid `256px | 1fr`, full height; the sidebar on
 * the left, the current view in the main area, the toast and the modals on top.
 * D41: a hidden sidebar slides out, its column narrows to a slim rail, the reveal
 * handle (after the main area, so the prototype's children keep their places),
 * and the main area takes the freed width (`docs/panes.md`).
 */
export function Shell() {
  const { route, navigate } = useRouter();
  // D97: ⌘⇧F / Ctrl+Shift+F opens the Search page (its field focused; on the page: the field again).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== 'f') return;
      event.preventDefault();
      const field = document.querySelector<HTMLInputElement>('[data-testid="search-input"]');
      if (field) field.focus();
      else navigate({ view: 'search' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
  const { state, layout, compact, setHidden } = usePanes();
  // D74 (docs/responsive.md): on tablets and phones the sidebar is a drawer over the page, opened from the app bar
  // (the session view's header holds the menu button instead); desktop renders exactly what it did before.
  if (compact) {
    const drawerOpen = !state.sidebarHidden;
    return (
      <div className="sb-shell" data-testid="shell" data-layout={layout} data-drawer={drawerOpen ? 'open' : 'closed'}>
        {route.view === 'session' ? null : <AppBar />}
        <Sidebar hidden={!drawerOpen} />
        {drawerOpen ? <div className="sb-scrim sb-drawer-scrim" data-testid="drawer-scrim" aria-hidden="true" onClick={() => setHidden('sidebar', true)} /> : null}
        <main className="sb-main" data-testid="main" inert={drawerOpen}>
          <View route={route} />
        </main>
        <UpdateBanner />
        <ToastHost />
        <ModalHost />
        <TakeoverHost />
        <ContinueHookedHost />
        <RevertHost />
        <FirstRunGate />
        <TouchTooltip />
        <TourHost />
      </div>
    );
  }
  return (
    <div className="sb-shell" data-testid="shell" data-sidebar={state.sidebarHidden ? 'hidden' : undefined}>
      <Sidebar hidden={state.sidebarHidden} />
      <main className="sb-main" data-testid="main">
        <View route={route} />
      </main>
      {state.sidebarHidden ? <PaneHandle pane="sidebar" /> : null}
      <UpdateBanner />
      <ToastHost />
      <ModalHost />
      {/* D65: the take-over dialog (a session taken over to / from a paired machine). */}
      <TakeoverHost />
      {/* D72: Continue in Switchboard of a hooked terminal session. */}
      <ContinueHookedHost />
      {/* D80: the revert confirmation (a portal over the page; nothing here while it is closed). */}
      <RevertHost />
      <FirstRunGate />
      {/* D74: a touch screen's long-press tooltip (after everything, so the prototype's child paths hold). */}
      <TouchTooltip />
      {/* D85: the tutorial (its gate renders nothing; a running tour is a portal on <body>). */}
      <TourHost />
    </div>
  );
}
