import { useEffect, useState } from 'react';
import type { SystemInfo } from '../../core/api.ts';
import { api } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { useHubEvent } from '../api/useHub.ts';
import { useModals } from '../modals/ModalHost.tsx';
import { Link, type Route, useRouter } from '../router.tsx';
import {
  type Meter,
  conflictCount,
  cpuMeter,
  formatAge,
  maxMeter,
  modeLine,
  processCount,
  ramMeter,
  statusColor,
  urlHost,
} from './format.ts';

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

function MeterRow({ label, meter, name }: { readonly label: string; readonly meter: Meter; readonly name: string }) {
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
 * The sidebar (SPEC → Shell), top to bottom: logo + ⌘K badge · "+ New session" ·
 * nav with badges · TOOLS · SESSIONS · Settings · machine footer. Everything it
 * lists comes from the API (sessions, tools, inbox, solutions, schedules,
 * artifacts, system) and the `/hub` stream; while a route is not implemented yet
 * (501) or unreachable, its part stays empty and the meters read "—".
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

  useHubEvent('sessionUpdated', () => sessions.reload());
  useHubEvent('inboxChanged', () => inbox.reload());
  useHubEvent('worktreeRemovable', () => solutions.reload());
  useHubEvent('scheduleRun', () => schedules.reload());
  useHubEvent('system', (payload) => setLiveSystem(payload));

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
          <Link
            key={tool.id}
            to={{ view: 'tool', id: tool.id }}
            className="sb-tool"
            aria-current={isActive(route, 'tool', tool.id) ? 'page' : undefined}
          >
            <span className="sb-tool-dot" style={{ background: tool.url ? 'var(--muted-2)' : 'var(--status-idle)' }} />
            <span className="sb-tool-name">{tool.name}</span>
            <span className="sb-tool-host">{urlHost(tool.url) || 'set URL'}</span>
          </Link>
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
            <span className="sb-session-dot" style={{ background: statusColor(session.status) }} />
            <div className="sb-session-body">
              <div className="sb-session-head">
                <span className="sb-session-name">{session.name}</span>
                <span className="sb-session-age">{formatAge(session.lastActivityAt ?? session.createdAt, now)}</span>
              </div>
              <div className="sb-session-mode">{modeLine(session)}</div>
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
        <MeterRow label="Max" name="max" meter={maxMeter(info, now)} />
      </div>
    </aside>
  );
}
