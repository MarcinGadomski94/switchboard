import { useEffect, useState } from 'react';
import type { SystemInfo, Tool } from '../../core/api.ts';
import { openSessions } from '../../core/session-close.ts';
import { useLiveActivities } from '../activity/useActivity.ts';
import { api } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { useSessionListOf } from '../api/session-list.ts';
import { useHubEvent } from '../api/useHub.ts';
import { useThrottled } from '../api/useThrottled.ts';
import { useCloseSession } from '../components/CloseSession.tsx';
import { useFolderTags } from '../folders/useFolders.ts';
import { useModals } from '../modals/ModalHost.tsx';
import { Link, type Route, useRouter } from '../router.tsx';
import { useToolsChanged } from '../tools/events.ts';
import { TOOL_DOT, useProbeOnLoad, useToolState, useToolStates } from '../tools/probe.ts';
import { useFrameHelperSites } from '../tools/useFrameHelper.ts';
import { PANE_ID, PaneHideButton, usePanes } from './Panes.tsx';
import { SidebarSessions } from './SidebarSessions.tsx';
import { SidebarChats } from './SidebarChats.tsx';
import { onRevealChats } from './reveal-chats.ts';
import { isChat } from '../../core/chats.ts';
import { NavCell } from './NavCell.tsx';
import {
  type NavBadge,
  artifactsBadge,
  inboxBadge,
  schedulesBadge,
  solutionsBadge,
  todosBadge,
  toolsHeadCount,
  toolsNeedAttention,
} from './nav-grid.ts';
import type { NavIconName } from './nav-icons.tsx';
import { setSectionCollapsed, useToolsCollapsed } from './useToolsCollapsed.ts';
import { CliSwitcher } from './CliSwitcher.tsx';
import { cliBadgeOf } from './cli-switch.ts';
// Team (D100) hook (docs/team-removal.md).
import { useTeamHiddenSessions, withoutTeamMembers } from '../team/hidden.ts';
import { TeamNavItem, TeamSidebarEntry } from '../team/SidebarTeam.tsx';
// Plans (D99) hook (docs/plans-removal.md).
import { PlansNavItem } from '../plans/PlansNav.tsx';
import {
  type Meter,
  type UsageCell,
  type UsageGridLine,
  USAGE_GRID_COLUMNS,
  conflictCount,
  cpuMeter,
  processCount,
  ramMeter,
  urlHost,
  usageGridLines,
} from './format.ts';

/** `sessionUpdated` comes in bursts; the Solutions badge source reloads at most this often (M6.3). */
const SOLUTIONS_RELOAD_MS = 1_000;

/** D101: one cell of the navigation grid (its view, name, icon and badge). */
interface NavEntry {
  readonly view: 'inbox' | 'solutions' | 'schedules' | 'mcp' | 'artifacts' | 'history' | 'todos' | 'insights';
  readonly label: string;
  readonly icon: NavIconName;
  readonly badge: NavBadge | null;
}

/** The id of the TOOLS list (the header's toggle controls it). */
const TOOLS_LIST_ID = 'sb-tools-list';

/** `true` on macOS / iOS, where the palette shortcut reads ⌘K. */
function isApplePlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

/** Re-renders every `ms` so relative ages stay current. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

function isActive(route: Route, view: Route['view'], id?: string): boolean {
  if (route.view !== view) return false;
  if (id === undefined) return true;
  return 'id' in route && route.id === id;
}

/** One footer meter (CPU, RAM): label, 4 px bar, value. */
export function MeterRow({ label, meter, name }: { readonly label: string; readonly meter: Meter; readonly name: string }) {
  return (
    <div className="sb-meter" data-meter={name}>
      <span>{label}</span>
      <div className="sb-meter-track">
        <div className="sb-meter-fill" style={{ width: `${meter.pct}%` }} />
      </div>
      <span className="sb-meter-value">{meter.text}</span>
    </div>
  );
}

/**
 * D66: one mini-bar of a usage grid line (its 4 px bar and its %). D23 / D46: with
 * a `pace` it carries `data-pace` (the bar's color, shell.css) and the bar a 2 px
 * marker at the allowance. `display: contents`: the bar and the % sit in the grid's columns.
 */
export function UsageCellView({ name, cell }: { readonly name: 'session' | 'week'; readonly cell: UsageCell }) {
  return (
    <span className="sb-usage-cell" data-window={name} data-known={String(cell.known)} data-pace={cell.pace?.state}>
      <span className="sb-meter-track">
        <span className="sb-meter-fill" style={{ width: `${cell.pct}%` }} />
        {cell.pace ? <span className="sb-meter-marker" data-testid="pace-marker" style={{ left: `calc(${cell.pace.markerPct}% - 1px)` }} /> : null}
      </span>
      <span className="sb-usage-pct">{cell.text}</span>
    </span>
  );
}

/** D66: one account's line of the usage grid; a click opens Settings → Accounts. D103: on credits, a badge row under it. */
function UsageLine({ line }: { readonly line: UsageGridLine }) {
  return (
    <>
      <UsageLineMain line={line} />
      {line.credits ? (
        <Link to={{ view: 'settings', section: 'accounts' }} className="sb-usage-credits" data-testid="usage-credits" data-account={line.key} title={line.title}>
          <span className="sb-credit-badge" data-testid="credit-badge">
            <span className="sb-credit-glyph" aria-hidden="true">
              {line.credits.glyph}
            </span>
            on credits
          </span>
          <span className="sb-usage-credits-text">{line.credits.text}</span>
        </Link>
      ) : null}
    </>
  );
}

function UsageLineMain({ line }: { readonly line: UsageGridLine }) {
  return (
    <Link
      to={{ view: 'settings', section: 'accounts' }}
      className="sb-usage-line"
      data-testid="usage-line"
      data-cli={line.cli}
      data-account={line.key}
      data-active={String(line.active)}
      data-spent={String(line.spent)}
      data-machines={line.machines}
      data-credits={line.credits ? 'true' : undefined}
      title={line.title}
    >
      <span className="sb-usage-dot">{line.active ? '●' : ''}</span>
      <span className="sb-usage-label">
        {line.label}
        {/* D98: the machines a shared account is on (only while a paired machine's accounts show). */}
        {line.machines ? (
          <span className="sb-usage-machines" data-testid="usage-machines">
            {` · ${line.machines}`}
          </span>
        ) : null}
      </span>
      {line.outUntil ? (
        <span className="sb-usage-out" data-testid="usage-out">
          {line.outUntil}
        </span>
      ) : (
        <>
          <UsageCellView name="session" cell={line.session} />
          <UsageCellView name="week" cell={line.week} />
        </>
      )}
    </Link>
  );
}

/** A TOOLS row: dot = reachability (M8.1, `tools/probe.ts`), name, host or "set URL". */
function SidebarTool({ tool, active }: { readonly tool: Tool; readonly active: boolean }) {
  const state = useToolState(tool);
  return (
    <Link to={{ view: 'tool', id: tool.id }} className="sb-tool" data-tool-state={state} aria-current={active ? 'page' : undefined}>
      <span className="sb-tool-dot" style={{ background: TOOL_DOT[state] }} />
      <span className="sb-tool-name">{tool.name}</span>
      <span className="sb-tool-host" data-testid="sidebar-tool-host" title={tool.url ?? undefined}>
        {urlHost(tool.url) || 'set URL'}
      </span>
    </Link>
  );
}

/**
 * The sidebar (SPEC → Shell), top to bottom: logo + ⌘K badge · "+ New session" ·
 * nav (D101: an icon grid, each icon with its badge) · TOOLS (D101: collapsible) ·
 * SESSIONS · Settings · machine footer. Everything it
 * lists comes from the API (sessions, tools, inbox, solutions, schedules,
 * artifacts, system) and the `/hub` stream; while a route is not implemented yet
 * (501) or unreachable, its part stays empty and the meters read "—". D14: a
 * session from a folder other than the default one carries its folder's tag at
 * the start of its mode line. D19: a running session's row shows its current action
 * and time in place of the mode line, and its dot pulses. D33: closed sessions are
 * not listed (`GET /api/sessions` leaves them out); a row's × (hover / focus)
 * closes its session, asking first while it runs or waits (`useCloseSession`),
 * and closing the session on screen goes to the Inbox. D41: the brand row's hide
 * button slides the sidebar out; while `hidden` it stays mounted (its lists keep
 * loading) but is inert and hidden from assistive technology. D54: the SESSIONS
 * list groups Pinned, the sidebar folders and the loose sessions (`SidebarSessions`).
 */
export function Sidebar({ hidden = false }: { readonly hidden?: boolean }) {
  const { route, navigate } = useRouter();
  const modals = useModals();
  // D74: on tablets and phones the sidebar is a drawer; a dialog opened from it closes it first.
  const panes = usePanes();
  const open = (...args: Parameters<typeof modals.open>): void => {
    if (panes.compact) panes.setHidden('sidebar', true);
    modals.open(...args);
  };
  const now = useNow(30_000);
  // D106: ⌘K → Chats shows the CHATS section (the drawer / a hidden sidebar first).
  useEffect(
    () =>
      onRevealChats(() => {
        panes.setHidden('sidebar', false);
        setSectionCollapsed('ui.chatsCollapsed', false);
      }),
    [panes],
  );

  // D95 follow-up 2: the page's shared list, patched from /hub (no read per sessionUpdated).
  const sessions = useSessionListOf();
  // Team (D100) hook (docs/team-removal.md).
  const teamHidden = useTeamHiddenSessions();
  const tools = useApi(api.tools);
  const inbox = useApi(api.inbox);
  const solutions = useApi(api.solutions);
  const schedules = useApi(api.schedules);
  const artifacts = useApi(() => api.artifacts());
  const system = useApi(api.system);
  const [liveSystem, setLiveSystem] = useState<SystemInfo | null>(null);
  const { tagOf } = useFolderTags();
  const activityOf = useLiveActivities(sessions.data);
  const closer = useCloseSession((closed) => {
    // (The list follows the close's sessionUpdated.)
    // D33: the session on screen was closed: its view goes, the Inbox comes.
    if (route.view === 'session' && route.id === closed.id) navigate({ view: 'inbox' });
  });

  useHubEvent('inboxChanged', () => inbox.reload());
  useHubEvent('worktreeRemovable', () => solutions.reload());
  // The conflict badge (M6.3) follows sessions starting, ending and moving to worktrees.
  useHubEvent('sessionUpdated', useThrottled(solutions.reload, SOLUTIONS_RELOAD_MS));
  useHubEvent('scheduleRun', () => schedules.reload());
  // D52: a schedule saved, paused, resumed or deleted (here or on a paired machine).
  useHubEvent('schedulesChanged', () => schedules.reload());
  useHubEvent('system', (payload) => setLiveSystem(payload));
  // D89: the Artifacts badge counts the artifacts saved on purpose (here and on the paired machines).
  useHubEvent('artifactsChanged', useThrottled(artifacts.reload, SOLUTIONS_RELOAD_MS));
  useToolsChanged(() => tools.reload()); // Settings → Embedded tools saved (M8.2)

  const info = liveSystem ?? system.data;
  const inboxCount = inbox.data?.length ?? 0;
  const conflicts = conflictCount(solutions.data);
  const failed = (schedules.data ?? []).filter((s) => s.runs[s.runs.length - 1]?.result === 'fail').length;

  // D68: every open session's open todos (this machine's and the paired machines'), from the session list.
  const openTodos = openSessions(sessions.data ?? []).reduce((sum, session) => sum + (session.openTodoCount ?? 0), 0);
  // D101: the cells of the navigation grid, with the counts and indicators the text items showed.
  const nav: readonly NavEntry[] = [
    { view: 'inbox', label: 'Inbox', icon: 'inbox', badge: inboxBadge(inboxCount) },
    { view: 'solutions', label: 'Solutions', icon: 'solutions', badge: solutionsBadge(conflicts) },
    { view: 'schedules', label: 'Schedules & loops', icon: 'schedules', badge: schedulesBadge(failed) },
    // D61: the MCP servers page.
    { view: 'mcp', label: 'MCP', icon: 'mcp', badge: null },
    { view: 'artifacts', label: 'Artifacts', icon: 'artifacts', badge: artifactsBadge(artifacts.data?.length ?? 0) },
    { view: 'history', label: 'History', icon: 'history', badge: null },
    // D68: the Todos page (after the prototype's items, like D61's MCP: the others keep their places).
    { view: 'todos', label: 'Todos', icon: 'todos', badge: todosBadge(openTodos) },
    // D108: the Insights page (after the others: they keep their places).
    { view: 'insights', label: 'Insights', icon: 'insights', badge: null },
  ];

  const sidebarTools = (tools.data ?? []).filter((tool) => tool.showInSidebar);
  // D101: TOOLS collapses to its header (stored per install); a stopped tool shows a dot on the collapsed header.
  const [toolsCollapsed, toggleTools] = useToolsCollapsed();
  const toolsAttention = toolsNeedAttention(useToolStates(sidebarTools));
  const toolsCount = toolsHeadCount(toolsCollapsed, sidebarTools.length);
  useProbeOnLoad(tools.data);
  useFrameHelperSites(tools.data); // D28 ruling: the saved site tools' hosts, for the frame helper's rules in this tab
  // D33: the list is already open sessions only; a closed one never shows even from a stale payload.
  // Team (D100) hook: team members' sessions leave SESSIONS while Team is on (one filter; docs/team-removal.md).
  // D106: chats are listed under CHATS, never under SESSIONS.
  const sessionList = withoutTeamMembers(openSessions(sessions.data ?? []), teamHidden).filter((session) => !isChat(session));
  const chatList = openSessions(sessions.data ?? []).filter(isChat);
  const reachable = system.reachable ?? sessions.reachable;

  return (
    <aside className="sb-sidebar" data-testid="sidebar" id={PANE_ID.sidebar} inert={hidden} aria-hidden={hidden || undefined}>
      <div className="sb-brand">
        <div className="sb-brand-mark">S</div>
        <div className="sb-brand-name">Switchboard</div>
        <button type="button" className="sb-button sb-brand-kbd" data-testid="open-palette" data-tour="palette" onClick={() => open('palette')}>
          {isApplePlatform() ? '⌘K' : 'Ctrl K'}
        </button>
        {/* D41: after the row's own parts (their child paths are the prototype's); drawn before the ⌘K key (shell.css). */}
        <PaneHideButton pane="sidebar" className="sb-brand-hide" />
      </div>

      <div className="sb-new-wrap">
        <button type="button" className="sb-button sb-new" data-testid="new-session" data-tour="new-session" onClick={() => open('new-session')}>
          + New session
        </button>
      </div>

      {/* D101: the views as an icon grid (5 columns; 4 with names in the D74 drawer): NavCell.tsx, nav-grid.ts. */}
      <nav className="sb-nav" aria-label="Views" data-testid="nav-grid" data-tour="nav">
        {nav.map((item) => (
          <NavCell
            key={item.view}
            to={{ view: item.view }}
            label={item.label}
            icon={item.icon}
            badge={item.badge}
            active={isActive(route, item.view)}
            testId={`nav-${item.view}`}
            tour={item.view}
          />
        ))}
        {/* Team (D100) hook: the Team cell, only while Team is on (nothing while off). */}
        <TeamNavItem />
        {/* Plans (D99) hook: the Plans cell, only while Plans is on (nothing while off). */}
        <PlansNavItem />
      </nav>

      {/* D101: the header toggles the list (▾ / ▸, the count and a stopped tool's dot while collapsed); + Add does not. */}
      <div className="sb-section-label sb-tools-head" data-testid="tools-head" data-collapsed={toolsCollapsed ? 'true' : undefined}>
        <button type="button" className="sb-section-toggle" data-testid="tools-toggle" aria-expanded={!toolsCollapsed} aria-controls={TOOLS_LIST_ID} onClick={toggleTools}>
          <span className="sb-section-chevron" aria-hidden="true">
            {toolsCollapsed ? '▸' : '▾'}
          </span>
          Tools
          {toolsCount ? (
            <span className="sb-section-collapsed-count" data-testid="tools-count">
              {toolsCount}
            </span>
          ) : null}
          {toolsCollapsed && toolsAttention ? <span className="sb-tools-attention" data-testid="tools-attention" title="A tool is not reachable" /> : null}
        </button>
        <Link to={{ view: 'settings', section: 'tools' }} className="sb-section-action" data-testid="add-tool">
          + Add
        </Link>
      </div>
      <div className="sb-tools" data-testid="sidebar-tools" id={TOOLS_LIST_ID} hidden={toolsCollapsed}>
        {sidebarTools.map((tool) => (
          <SidebarTool key={tool.id} tool={tool} active={isActive(route, 'tool', tool.id)} />
        ))}
      </div>

      {/* Team (D100) hook: ⚑ Team · <name> · N members above SESSIONS, only while Team is on. */}
      <TeamSidebarEntry />
      {/* D106: the CHATS section (always shown; folds like TOOLS). */}
      <SidebarChats chats={chatList} loaded={sessions.data !== null} activityOf={activityOf} closer={closer} isCurrent={(id) => isActive(route, 'session', id)} now={now} onNew={() => open('new-chat')} />
      {/* D54: the SESSIONS label and list (Pinned, folders, loose sessions): SidebarSessions.tsx. */}
      <SidebarSessions
        sessions={sessionList}
        loaded={sessions.data !== null}
        activityOf={activityOf}
        closer={closer}
        isCurrent={(id) => isActive(route, 'session', id)}
        tagOf={tagOf}
        cliBadge={cliBadgeOf(sessionList)}
        now={now}
      />
      {closer.error ? (
        <div className="sb-session-close-error" role="alert" data-testid="sidebar-close-error">
          {closer.error.text}
        </div>
      ) : null}
      {closer.dialog}

      <Link
        to={{ view: 'settings', section: null }}
        className="sb-settings"
        data-testid="nav-settings"
        aria-current={isActive(route, 'settings') ? 'page' : undefined}
      >
        Settings
      </Link>

      <div className="sb-footer" data-testid="machine-footer">
        <div className="sb-footer-service">
          <span className="sb-footer-dot" data-state={reachable === false ? 'down' : 'up'} />
          {/* D62 P6: the default CLI for new sessions (its label in the prototype's place and style) and "Switch running sessions…". */}
          <CliSwitcher sessions={sessionList} />
          <span data-testid="process-count">{processCount(info)}</span>
          <span className="sb-footer-address" data-testid="service-address">
            {window.location.host}
          </span>
        </div>
        <MeterRow label="CPU" name="cpu" meter={cpuMeter(info)} />
        <MeterRow label="RAM" name="ram" meter={ramMeter(info)} />
        {/* D66: the usage grid (one line per account, the 5-hour and the weekly window) replaces D17's rows and D63's line. */}
        <div className="sb-usage" data-testid="usage-meters" data-tour="usage">
          <div className="sb-usage-head" data-testid="usage-grid-header" aria-hidden="true">
            <span className="sb-usage-col" data-col="session">
              {USAGE_GRID_COLUMNS.session}
            </span>
            <span className="sb-usage-col" data-col="week">
              {USAGE_GRID_COLUMNS.week}
            </span>
          </div>
          {usageGridLines(info, now).map((line) => (
            <UsageLine key={line.key} line={line} />
          ))}
        </div>
      </div>
    </aside>
  );
}
