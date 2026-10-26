import { useEffect, useMemo, useState } from 'react';
import type { SessionListItem, SystemInfo } from '../../../core/api.ts';
import type { DevicesView } from '../../../core/devices.ts';
import type { SidebarLayout } from '../../../core/sidebar-layout.ts';
import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { useMachines } from '../../api/useMachines.ts';
import { useSessionListOf } from '../../api/session-list.ts';
import { useNeedsYou } from '../shared/needs-you.ts';
import { useTeamMembers } from '../shared/teammates.ts';
import { type RailCounts, type StatusPill, railCounts, statusPill } from './status-model.ts';

export { type RailCounts, railCounts } from './status-model.ts';

/**
 * D131 · what the shell shows, from the APIs and hub events the classic sidebar
 * and footer use: the usage and computers (`/api/system`, `system`; the paired
 * machines), this computer's name (`/api/machines` → `self`), the phones
 * (`/api/devices`), the pins (`/api/sidebar`, `sidebarLayoutChanged`) and the
 * "needs you" counts per rail item.
 */

/** The usage, power and computers of the status pill, live. */
export function useStatusPill(): { readonly pill: StatusPill; readonly system: SystemInfo | null } {
  const system = useApi(api.system);
  const [live, setLive] = useState<SystemInfo | null>(null);
  useHubEvent('system', (payload) => setLive(payload));
  const machines = useMachines();
  const self = useApi(api.machines);
  const info = live ?? system.data;
  const name = self.data?.self.name ?? 'This computer';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const pill = useMemo(() => statusPill(info, machines, name, now), [info, machines, name, now]);
  return { pill, system: info };
}

/** The paired phones (none on a phone itself: the route is this computer's only). */
export function usePhones(): DevicesView['devices'] {
  const devices = useApi(() => api.devices().catch(() => ({ access: null, devices: [] }) as unknown as DevicesView));
  return devices.data?.devices ?? [];
}

/** The pinned agents (the shared sidebar layout's pins, D71), in order, with their sessions. */
export function usePins(): readonly SessionListItem[] {
  const layout = useApi(api.sidebarLayout);
  useHubEvent('sidebarLayoutChanged', () => layout.reload());
  const sessions = useSessionListOf();
  return useMemo(() => {
    const pinned = (layout.data as SidebarLayout | null)?.pinned ?? [];
    const byId = new Map((sessions.data ?? []).map((session) => [session.id, session]));
    return pinned.map((id) => byId.get(id)).filter((session): session is SessionListItem => session !== undefined && !session.closedAt);
  }, [layout.data, sessions.data]);
}

/** The rail's counts, live. */
export function useRailCounts(): RailCounts {
  const { items } = useNeedsYou();
  const members = useTeamMembers();
  return useMemo(() => railCounts(items, new Set(members.keys())), [items, members]);
}
