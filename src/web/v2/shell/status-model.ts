import type { SystemInfo } from '../../../core/api.ts';
import type { Machine } from '../../../core/peers.ts';
import { powerView } from '../../../core/power.ts';
import { type UsageGridLine, usageGridLines } from '../../shell/format.ts';
import { type Tone, computerProblem, computerStateToV2 } from '../glossary.ts';
import type { NeedsItem } from '../shared/needs-you-model.ts';

/**
 * D131 · the top bar's status pill and its popover (`docs/v2.md` → *Shell*), from
 * what the classic footer reads: `GET /api/system` (live via `system`: usage per
 * account, this computer's power, CPU / RAM, background apps) and the paired
 * computers (`GET /api/machines`, live via `machineState`). Pure; unit-tested.
 */

/** One account in the popover. */
export interface PillAccount {
  readonly key: string;
  readonly name: string;
  /** `In use` (new agents start here), `Paid extra`, `Out until 14:05`, or none. */
  readonly badge: { readonly text: string; readonly tone: Tone; readonly icon?: string } | null;
  /** The 5-hour and weekly windows (`null` while unknown). */
  readonly session: number | null;
  readonly week: number | null;
  /** A line instead of the bars (out of usage, paid extra's balance). */
  readonly note: string | null;
}

/** One computer in the popover. */
export interface PillComputer {
  readonly id: string | null;
  readonly name: string;
  readonly self: boolean;
  readonly state: 'online' | 'reconnecting' | 'offline';
  /** `CPU 34% · RAM 18.2/32 GB · 3 background apps 1.9 GB` (this one), else why it is offline. */
  readonly detail: string;
  /** `64% · 2h10`, `~210 W`; `null` without a reading. */
  readonly power: string | null;
  readonly powerKind: 'battery' | 'plug' | null;
}

/** The pill and its popover. */
export interface StatusPill {
  /** The pill's usage part: the active account and its 5-hour use, or `null` before the first reading. */
  readonly usage: { readonly label: string; readonly pct: number | null; readonly tone: Tone; readonly icon: string } | null;
  /** This computer's power (`64%`, `~210 W`), `null` without a reading. */
  readonly power: { readonly text: string; readonly kind: 'battery' | 'plug' } | null;
  /** `2 online`, or what is offline / reconnecting. */
  readonly computers: { readonly text: string; readonly tone: Tone; readonly icon: string };
  /** `3 background apps · 1.9 GB`, `null` while none. */
  readonly backgroundApps: string | null;
  readonly accounts: readonly PillAccount[];
  readonly computerRows: readonly PillComputer[];
  /** The paired computers that are not online (the top bar's offline / reconnecting chip). */
  readonly away: readonly PillComputer[];
}

/** `1.9 GB`, `412 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function gb(bytes: number): string {
  // `18.2`, `32` (one decimal, none when whole: the prototype's `18.2/32 GB`).
  return String(Number((bytes / 1024 ** 3).toFixed(1)));
}

function account(line: UsageGridLine): PillAccount {
  let badge: PillAccount['badge'] = null;
  let note: string | null = null;
  if (line.credits) {
    badge = { text: 'Paid extra', tone: 'amber', icon: 'wallet' };
    note = `Out of usage · ${line.credits.text}`;
  } else if (line.spent && line.outUntil) {
    badge = { text: line.outUntil.replace(/^out/, 'Out'), tone: 'grey' };
    note = 'Out of usage';
  } else if (line.active) badge = { text: 'In use', tone: 'blue' };
  return { key: line.key, name: line.label, badge, session: line.session.known ? line.session.pct : null, week: line.week.known ? line.week.pct : null, note };
}

/** The tone of a usage percentage (amber from `warnAt`, red when spent). */
export function usageTone(pct: number | null, spent: boolean, warnAt = 90): Tone {
  if (spent) return 'red';
  if (pct !== null && pct >= warnAt) return 'amber';
  return 'green';
}

/** The pill and popover from the readings. `selfName` = this computer's name (`GET /api/machines` → `self`). */
export function statusPill(system: SystemInfo | null, machines: readonly Machine[], selfName: string, now: number = Date.now(), warnAt = 90): StatusPill {
  const lines = system ? usageGridLines(system, now) : [];
  const active = lines.find((line) => line.active) ?? lines.find((line) => line.cli === 'claude') ?? lines[0] ?? null;
  const usage = active
    ? {
        label: `${active.label} ${active.spent ? 'out' : active.session.known ? `${Math.round(active.session.pct)}%` : '—'}`,
        pct: active.session.known ? active.session.pct : null,
        tone: active.credits ? ('amber' as Tone) : usageTone(active.session.known ? active.session.pct : null, active.spent, warnAt),
        icon: active.spent || active.credits ? 'wallet' : 'check-circle',
      }
    : null;
  const view = powerView(system?.power);
  const power = view ? { text: view.short, kind: system?.power?.kind === 'estimated' ? ('plug' as const) : ('battery' as const) } : null;
  const tracked = system?.trackedProcesses;
  const backgroundApps = tracked && tracked.count > 0 ? `${tracked.count} background app${tracked.count === 1 ? '' : 's'} · ${formatBytes(tracked.rssBytes)}` : null;
  const selfDetail = system ? [`CPU ${Math.round(system.cpu)}%`, `RAM ${gb(system.ramUsed)}/${gb(system.ramTotal)} GB`, ...(backgroundApps ? [backgroundApps] : [])].join(' · ') : '';
  const rows: PillComputer[] = [{ id: null, name: selfName, self: true, state: 'online', detail: selfDetail, power: view?.text ?? null, powerKind: power?.kind ?? null }];
  for (const machine of machines) {
    const state = computerStateToV2(machine.state);
    const peerPower = powerView(machine.power);
    const since = machine.lastSeenAt && state !== 'online' ? ` since ${new Date(machine.lastSeenAt).toTimeString().slice(0, 5)}` : '';
    rows.push({
      id: machine.id,
      name: machine.name,
      self: false,
      state,
      detail: state === 'online' ? 'Online' : state === 'reconnecting' ? 'Reconnecting…' : `Offline${since} · ${computerProblem(machine.state) ?? 'Reconnects automatically.'}`,
      power: state === 'online' ? (peerPower?.text ?? null) : null,
      powerKind: peerPower ? (machine.power?.kind === 'estimated' ? 'plug' : 'battery') : null,
    });
  }
  const away = rows.filter((row) => !row.self && row.state !== 'online');
  const online = rows.filter((row) => row.state === 'online').length;
  const offline = away.filter((row) => row.state === 'offline').length;
  const reconnecting = away.length - offline;
  const computers =
    offline > 0
      ? { text: `${offline} offline`, tone: 'grey' as Tone, icon: 'offline' }
      : reconnecting > 0
        ? { text: 'Reconnecting', tone: 'amber' as Tone, icon: 'refresh' }
        : { text: `${online} online`, tone: 'grey' as Tone, icon: rows.length > 1 ? 'desktop' : 'laptop' };
  return { usage, power, computers, backgroundApps, accounts: lines.map(account), computerRows: rows, away };
}

/** The rail's counts. */
export interface RailCounts {
  readonly home: number;
  readonly agents: number;
  readonly projects: number;
  readonly crews: number;
}

/**
 * The rail's counts from the merged items (pure). A teammate's item counts for
 * Crews, never Agents: `teammates` (their session ids) catches the ones the
 * merge has not tagged with their crew (fix after 2.0).
 */
export function railCounts(items: readonly NeedsItem[], teammates: ReadonlySet<string> = new Set()): RailCounts {
  let agents = 0;
  let projects = 0;
  let crews = 0;
  for (const item of items) {
    if (item.crew || (item.agent?.sessionId && teammates.has(item.agent.sessionId))) crews += 1;
    else if (item.route?.startsWith('/plans/') || item.kind === 'pick') projects += 1;
    else if (item.agent?.sessionId) agents += 1;
  }
  return { home: items.length, agents, projects, crews };
}
