import { FirstRunGate } from '../modals/FirstRunGate.tsx';
import { ModalHost } from '../modals/ModalHost.tsx';
import { type Route, useRouter } from '../router.tsx';
import { TakeoverHost } from '../takeover/TakeoverDialog.tsx';
import { ContinueHookedHost } from '../hooked-continue/ContinueHookedDialog.tsx';
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
  const { state } = usePanes();
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
      <FirstRunGate />
    </div>
  );
}
