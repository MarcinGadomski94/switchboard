import type { Session, SolutionGroup, SystemInfo } from '../../core/api.ts';
import type { SessionStatus } from '../../core/model.ts';

/** CSS variable of a status dot color (SPEC tokens). */
export function statusColor(status: SessionStatus): string {
  return `var(--status-${status === 'paused' ? 'idle' : status})`;
}

/** Age for the sidebar (`now`, `1m`, `3h`, `2d`) from an ISO time. */
export function formatAge(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return 'now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The sidebar's mode line, as the prototype builds it for a new session:
 * `orch|single · QA|feature · UI-first|integration`. Parts the session does not
 * have are left out.
 */
export function modeLine(session: Pick<Session, 'mode' | 'workType' | 'phase'>): string {
  const parts: string[] = [];
  if (session.mode) parts.push(session.mode === 'orchestrator' ? 'orch' : 'single');
  if (session.workType) parts.push(session.workType === 'qa' ? 'QA' : 'feature');
  if (session.phase) parts.push(session.phase === 'ui-first' ? 'UI-first' : 'integration');
  return parts.join(' · ');
}

/** Host of a tool URL without the scheme (`http://localhost:3000` → `localhost:3000`). */
export function urlHost(url: string | null): string {
  return (url ?? '').replace(/^https?:\/\//, '');
}

const GIB = 1024 ** 3;

/** One footer meter: bar width (0–100) and its value text. */
export interface Meter {
  readonly pct: number;
  readonly text: string;
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** Shown when a value is not available (never invented). */
export const UNKNOWN = '—';

/** CPU meter (`12%`). */
export function cpuMeter(system: SystemInfo | null): Meter {
  if (!system) return { pct: 0, text: UNKNOWN };
  return { pct: clampPct(system.cpu), text: `${Math.round(system.cpu)}%` };
}

/** RAM meter (`12.5/64 GB`). */
export function ramMeter(system: SystemInfo | null): Meter {
  if (!system || system.ramTotal <= 0) return { pct: 0, text: UNKNOWN };
  const used = system.ramUsed / GIB;
  const total = system.ramTotal / GIB;
  return { pct: clampPct((system.ramUsed / system.ramTotal) * 100), text: `${used.toFixed(1)}/${Math.round(total)} GB` };
}

/** Time left until `iso` as `2h05` (or `45m`). */
export function formatResetsIn(iso: string, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h${String(rest).padStart(2, '0')}` : `${rest}m`;
}

/** Max usage meter (`40% · 2h05`); `unknown` without a reading (ARCHITECTURE → Usage meter). */
export function maxMeter(system: SystemInfo | null, now: number = Date.now()): Meter {
  if (!system) return { pct: 0, text: UNKNOWN };
  if (system.usagePct === undefined) return { pct: 0, text: 'unknown' };
  const pct = Math.round(system.usagePct);
  const reset = system.usageResetsAt ? ` · ${formatResetsIn(system.usageResetsAt, now)}` : '';
  return { pct: clampPct(system.usagePct), text: `${pct}%${reset}` };
}

/** `3 bg processes` (gap #11: live supervised claude processes). */
export function processCount(system: SystemInfo | null): string {
  return system ? `${system.processes} bg processes` : '';
}

/** Solutions with a conflict (two sessions writing one working tree, M6.3). */
export function conflictCount(groups: readonly SolutionGroup[] | null): number {
  return (groups ?? []).reduce((sum, group) => sum + group.solutions.filter((s) => s.conflict).length, 0);
}
