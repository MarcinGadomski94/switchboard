import { useEffect, useState } from 'react';
import type { SystemInfo, Tool } from '../../core/api.ts';
import { SessionActivityOr } from '../activity/ActivityViews.tsx';
import { useLiveActivities } from '../activity/useActivity.ts';
import { api } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { useHubEvent } from '../api/useHub.ts';
import { useThrottled } from '../api/useThrottled.ts';
import { FolderTag } from '../folders/FolderTag.tsx';
import { useFolderTags } from '../folders/useFolders.ts';
import { useModals } from '../modals/ModalHost.tsx';
import { Link, type Route, useRouter } from '../router.tsx';
import { useToolsChanged } from '../tools/events.ts';
import { TOOL_DOT, useProbeOnLoad, useToolState } from '../tools/probe.ts';
import {
  type Meter,
  type WeekPaceView,
  conflictCount,
  cpuMeter,
  formatAge,
  modeLine,
  processCount,
  ramMeter,
  statusColor,
  urlHost,
  usageRows,
} from './format.ts';

/** `sessionUpdated` comes in bursts; the Solutions badge source reloads at most this often (M6.3). */
const SOLUTIONS_RELOAD_MS = 1_000;

/** Badge style of a nav item (prototype navDef kinds). */
type BadgeKind = 'need' | 'warn' | 'fail' | null;

interface NavEntry {
  readonly view: 'inbox' | 'solutions' | 'schedules' | 'artifacts' | 'history';
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

/**
 * One footer meter: label, 4 px bar, value. D23: with a `pace` (the known Week row)
 * the row carries `data-pace` (the bar's color, shell.css) and the pace `title`,
 * and the bar a 2 px marker at the allowance.
 */
export function MeterRow({ label, meter, name, model, pace }: { readonly label: string; readonly meter: Meter; readonly name: string; readonly model?: string; readonly pace?: WeekPaceView }) {
  return (
    <div className="sb-meter" data-meter={name} data-model={model} data-pace={pace?.state} title={pace?.title}>
      <span>{label}</span>
      <div className="sb-meter-track">
        <div className="sb-meter-fill" style={{ width: `${meter.pct}%` }} />
        {pace ? <div className="sb-meter-marker" data-testid="pace-marker" style={{ left: `calc(${pace.markerPct}% - 1px)` }} /> : null}
      </div>
      <span className="sb-meter-value">{meter.text}</span>
    </div>
  );
}

/** A TOOLS row: dot = reachability (M8.1, `tools/probe.ts`), name, host or "set URL". */
function SidebarTool({ tool, active }: { readonly tool: Tool; readonly active: boolean }) {
  const state = useToolState(tool);
  return (
    <Link to={{ view: 'tool', id: tool.id }} className="sb-tool" data-tool-state={state} aria-current={active ? 'page' : undefined}>
      <span className="sb-tool-dot" style={{ background: TOOL_DOT[state] }} />
      <span className="sb-tool-name">{tool.name}</span>
      <span className="sb-tool-host">{urlHost(tool.url) || 'set URL'}</span>
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
 * and time in place of the mode line, and its dot pulses.
 */
export function Sidebar() {
  const { route } = useRouter();
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

  useHubEvent('sessionUpdated', () => sessions.reload());
  useHubEvent('inboxChanged', () => inbox.reload());
  useHubEvent('worktreeRemovable', () => solutions.reload());
  // The conflict badge (M6.3) follows sessions starting, ending and moving to worktrees.
  useHubEvent('sessionUpdated', useThrottled(solutions.reload, SOLUTIONS_RELOAD_MS));
  useHubEvent('scheduleRun', () => schedules.reload());
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
    { view: 'artifacts', label: 'Artifacts', badge: artifacts.data?.length ? String(artifacts.data.length) : '', kind: null },
    { view: 'history', label: 'History', badge: '', kind: null },
  ];

  const sidebarTools = (tools.data ?? []).filter((tool) => tool.showInSidebar);
  useProbeOnLoad(tools.data);
  const sessionList = sessions.data ?? [];
  const reachable = system.reachable ?? sessions.reachable;

  return (
    <aside className="sb-sidebar" data-testid="sidebar">
      <div className="sb-brand">
        <div className="sb-brand-mark">S</div>
        <div className="sb-brand-name">Switchboard</div>
        <button type="button" className="sb-button sb-brand-kbd" data-testid="open-palette" onClick={() => open('palette')}>
          {isApplePlatform() ? '⌘K' : 'Ctrl K'}
        </button>
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

      <div className="sb-section-label">
        Sessions
        <span className="sb-section-count">{sessions.data ? String(sessionList.length) : ''}</span>
      </div>
      <div className="sb-sessions" data-testid="sidebar-sessions">
        {sessionList.map((session) => (
          <Link
            key={session.id}
            to={{ view: 'session', id: session.id, tab: 'chat' }}
            className="sb-session"
            aria-current={isActive(route, 'session', session.id) ? 'page' : undefined}
          >
            <span className="sb-session-dot" data-activity={activityOf(session.id)?.state} style={{ background: statusColor(session.status) }} />
            <div className="sb-session-body">
              <div className="sb-session-head">
                <span className="sb-session-name">{session.name}</span>
                <span className="sb-session-age">{formatAge(session.lastActivityAt ?? session.createdAt, now)}</span>
              </div>
              <div className="sb-session-mode">
                <FolderTag name={tagOf(session)} title={session.folderPath} />
                <SessionActivityOr activity={activityOf(session.id)}>{modeLine(session)}</SessionActivityOr>
              </div>
            </div>
          </Link>
        ))}
      </div>

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
          <span className="sb-footer-label">claude code</span>
          <span data-testid="process-count">{processCount(info)}</span>
          <span className="sb-footer-address" data-testid="service-address">
            {window.location.host}
          </span>
        </div>
        <MeterRow label="CPU" name="cpu" meter={cpuMeter(info)} />
        <MeterRow label="RAM" name="ram" meter={ramMeter(info)} />
        {/* D17: Session + Week (+ a model's weekly limit while in use) replace the prototype's one "Max" row. */}
        <div className="sb-usage" data-testid="usage-meters">
          {usageRows(info, now).map((row) => (
            <MeterRow key={row.model ? `model:${row.model}` : row.key} label={row.label} name={row.key} meter={row} {...(row.model ? { model: row.model } : {})} {...(row.pace ? { pace: row.pace } : {})} />
          ))}
        </div>
      </div>
    </aside>
  );
}
