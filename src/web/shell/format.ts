import type { Session, SolutionGroup, SystemInfo, UsageWindow } from '../../core/api.ts';
import type { SessionStatus } from '../../core/model.ts';
import { USAGE_ROW_LABELS } from '../../core/usage.ts';

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

/** One usage row of the footer (D17): Session, Week, or a model's weekly limit. */
export interface UsageRow extends Meter {
  /** `session`, `week` or `model` (the `data-meter` value). */
  readonly key: UsageWindow['key'];
  readonly label: string;
  /** `key: 'model'`: the model's name. */
  readonly model?: string;
}

/** The value of a known window: `62% · 1h48` (bar = the %). */
function windowMeter(window: UsageWindow, now: number): Meter {
  return { pct: clampPct(window.pct), text: `${Math.round(window.pct)}% · ${formatResetsIn(window.resetsAt, now)}` };
}

/**
 * The footer's usage rows (D17, `docs/usage.md`): always **Session** and **Week**
 * (`unknown` while `usageWindows` has no such window, `—` before `/api/system`
 * answers), then one row per model window the server lists (it lists them only
 * while in use). Nothing is derived from `usagePct`: unknown stays unknown.
 */
export function usageRows(system: SystemInfo | null, now: number = Date.now()): UsageRow[] {
  const windows = system?.usageWindows ?? [];
  const fixed = (key: 'session' | 'week'): UsageRow => {
    const label = USAGE_ROW_LABELS[key];
    const window = windows.find((w) => w.key === key);
    if (window) return { key, label, ...windowMeter(window, now) };
    return { key, label, pct: 0, text: system ? 'unknown' : UNKNOWN };
  };
  return [
    fixed('session'),
    fixed('week'),
    ...windows.filter((w) => w.key === 'model').map((w): UsageRow => ({ key: 'model', label: w.label, model: w.model ?? w.label, ...windowMeter(w, now) })),
  ];
}

/** `3 bg processes` (gap #11: live supervised claude processes). */
export function processCount(system: SystemInfo | null): string {
  return system ? `${system.processes} bg processes` : '';
}

/** Solutions with a conflict (two sessions writing one working tree, M6.3). */
export function conflictCount(groups: readonly SolutionGroup[] | null): number {
  return (groups ?? []).reduce((sum, group) => sum + group.solutions.filter((s) => s.conflict).length, 0);
}
