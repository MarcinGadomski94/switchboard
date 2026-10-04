import { useEffect, useState } from 'react';
import type { SystemInfo, Tool } from '../../core/api.ts';
import { openSessions } from '../../core/session-close.ts';
import { useLiveActivities } from '../activity/useActivity.ts';
import { api } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { useHubEvent } from '../api/useHub.ts';
import { useThrottled } from '../api/useThrottled.ts';
import { useCloseSession } from '../components/CloseSession.tsx';
import { useFolderTags } from '../folders/useFolders.ts';
import { useModals } from '../modals/ModalHost.tsx';
import { Link, type Route, useRouter } from '../router.tsx';
import { useToolsChanged } from '../tools/events.ts';
import { TOOL_DOT, useProbeOnLoad, useToolState } from '../tools/probe.ts';
import { useFrameHelperSites } from '../tools/useFrameHelper.ts';
import { PANE_ID, PaneHideButton } from './Panes.tsx';
import { SidebarSessions } from './SidebarSessions.tsx';
import { CliSwitcher } from './CliSwitcher.tsx';
import { cliBadgeOf } from './cli-switch.ts';
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

/** Badge style of a nav item (prototype navDef kinds). */
type BadgeKind = 'need' | 'warn' | 'fail' | null;

interface NavEntry {
  readonly view: 'inbox' | 'solutions' | 'schedules' | 'mcp' | 'artifacts' | 'history';
  readonly label: string;
  readonly badge: string;
  readonly kind: BadgeKind;
}

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

/** D66: one account's line of the usage grid; a click opens Settings → Accounts. */
function UsageLine({ line }: { readonly line: UsageGridLine }) {
  return (
    <Link
      to={{ view: 'settings', section: 'accounts' }}
      className="sb-usage-line"
      data-testid="usage-line"
      data-cli={line.cli}
      data-account={line.key}
      data-active={String(line.active)}
      data-spent={String(line.spent)}
      title={line.title}
    >
      <span className="sb-usage-dot">{line.active ? '●' : ''}</span>
      <span className="sb-usage-label">{line.label}</span>
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
 * nav with badges · TOOLS · SESSIONS · Settings · machine footer. Everything it
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
  const { open } = useModals();
  const now = useNow(30_000);

  const sessions = useApi(api.listSessions);
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
    sessions.reload();
    // D33: the session on screen was closed: its view goes, the Inbox comes.
    if (route.view === 'session' && route.id === closed.id) navigate({ view: 'inbox' });
  });

  useHubEvent('sessionUpdated', () => sessions.reload());
  useHubEvent('inboxChanged', () => inbox.reload());
  useHubEvent('worktreeRemovable', () => solutions.reload());
  // The conflict badge (M6.3) follows sessions starting, ending and moving to worktrees.
  useHubEvent('sessionUpdated', useThrottled(solutions.reload, SOLUTIONS_RELOAD_MS));
  useHubEvent('scheduleRun', () => schedules.reload());
  // D52: a schedule saved, paused, resumed or deleted (here or on a paired machine).
  useHubEvent('schedulesChanged', () => schedules.reload());
  useHubEvent('system', (payload) => setLiveSystem(payload));
  useToolsChanged(() => tools.reload()); // Settings → Embedded tools saved (M8.2)

  const info = liveSystem ?? system.data;
  const inboxCount = inbox.data?.length ?? 0;
  const conflicts = conflictCount(solutions.data);
  const failed = (schedules.data ?? []).filter((s) => s.runs[s.runs.length - 1]?.result === 'fail').length;

  const nav: readonly NavEntry[] = [
    { view: 'inbox', label: 'Inbox', badge: inboxCount ? String(inboxCount) : '', kind: inboxCount ? 'need' : null },
    { view: 'solutions', label: 'Solutions', badge: conflicts ? `${conflicts} conflict${conflicts === 1 ? '' : 's'}` : '', kind: conflicts ? 'warn' : null },
    { view: 'schedules', label: 'Schedules & loops', badge: failed ? `${failed} failed` : '', kind: failed ? 'fail' : null },
    // D61: the MCP servers page.
    { view: 'mcp', label: 'MCP', badge: '', kind: null },
    { view: 'artifacts', label: 'Artifacts', badge: artifacts.data?.length ? String(artifacts.data.length) : '', kind: null },
    { view: 'history', label: 'History', badge: '', kind: null },
  ];

  const sidebarTools = (tools.data ?? []).filter((tool) => tool.showInSidebar);
  useProbeOnLoad(tools.data);
  useFrameHelperSites(tools.data); // D28 ruling: the saved site tools' hosts, for the frame helper's rules in this tab
  // D33: the list is already open sessions only; a closed one never shows even from a stale payload.
  const sessionList = openSessions(sessions.data ?? []);
  const reachable = system.reachable ?? sessions.reachable;

  return (
    <aside className="sb-sidebar" data-testid="sidebar" id={PANE_ID.sidebar} inert={hidden} aria-hidden={hidden || undefined}>
      <div className="sb-brand">
        <div className="sb-brand-mark">S</div>
        <div className="sb-brand-name">Switchboard</div>
        <button type="button" className="sb-button sb-brand-kbd" data-testid="open-palette" onClick={() => open('palette')}>
          {isApplePlatform() ? '⌘K' : 'Ctrl K'}
        </button>
        {/* D41: after the row's own parts (their child paths are the prototype's); drawn before the ⌘K key (shell.css). */}
        <PaneHideButton pane="sidebar" className="sb-brand-hide" />
      </div>

      <div className="sb-new-wrap">
        <button type="button" className="sb-button sb-new" data-testid="new-session" onClick={() => open('new-session')}>
          + New session
        </button>
      </div>

      <nav className="sb-nav" aria-label="Views">
        {nav.map((item) => (
          <Link
            key={item.view}
            to={{ view: item.view }}
            className="sb-nav-item"
            data-testid={`nav-${item.view}`}
            aria-current={isActive(route, item.view) ? 'page' : undefined}
          >
            <span>{item.label}</span>
            <span className="sb-badge" data-kind={item.kind ?? undefined}>
              {item.badge}
            </span>
          </Link>
        ))}
      </nav>

      <div className="sb-section-label">
        Tools
        <Link to={{ view: 'settings', section: 'tools' }} className="sb-section-action" data-testid="add-tool">
          + Add
        </Link>
      </div>
      <div className="sb-tools" data-testid="sidebar-tools">
        {sidebarTools.map((tool) => (
          <SidebarTool key={tool.id} tool={tool} active={isActive(route, 'tool', tool.id)} />
        ))}
      </div>

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
        <div className="sb-usage" data-testid="usage-meters">
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
