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
import { ToolView } from '../views/ToolView.tsx';
import { SessionView } from '../views/session/SessionView.tsx';
import { PaneHandle, usePanes } from './Panes.tsx';
import { Sidebar } from './Sidebar.tsx';
import { AppBar } from './AppBar.tsx';
import { TouchTooltip } from './TouchTooltip.tsx';
import './shell.css';

function View({ route }: { readonly route: Route }) {
  switch (route.view) {
    case 'inbox':
      return <InboxView />;
    case 'session':
      return <SessionView key={route.id} sessionId={route.id} tab={route.tab} agentId={route.agentId ?? null} />;
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
    case 'tool':
      return <ToolView key={route.id} toolId={route.id} />;
    case 'settings':
      return <SettingsView section={route.section} />;
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
  const { route } = useRouter();
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
    </div>
  );
}
