import type { SessionProcess, SessionProcessKind, SessionProcesses, TrackedProcessTotals } from '../../core/api.ts';
import { kindLabel, memoryLabel } from '../../core/processes.ts';

/**
 * D127 (`docs/processes.md`): the pure parts of the Processes views (the session panel's
 * section, Settings → Processes, the sidebar footer's line).
 */

/** How often a Processes view reads again while it is open (the tracker samples every 30 s; Stop / Keep read at once). */
export const PROCESSES_POLL_MS = 15_000;

/** A process's age: `<1m`, `27m`, `3h05`, `2d4h`. */
export function ageLabel(startedAt: string, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 60_000));
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/** The kind's short tag (`build`, `test`, `dev`, `other`). */
export function kindTag(kind: SessionProcessKind): string {
  return kind === 'build-server' ? 'build' : kind === 'test-host' ? 'test' : kind === 'dev-server' ? 'dev' : 'other';
}

/** The kind as words, for tooltips (`build server`). */
export { kindLabel, memoryLabel };

/** The footer line (`procs 4.5 GB`), `null` when nothing is tracked. */
export function footerLine(totals: TrackedProcessTotals | undefined): { readonly text: string; readonly title: string } | null {
  if (!totals || totals.count === 0) return null;
  const memory = memoryLabel(totals.rssBytes);
  return {
    text: `procs ${memory}`,
    title: `${totals.count} ${totals.count === 1 ? 'process' : 'processes'} left running by sessions (${memory}). Open Settings → Processes.`,
  };
}

/** A session's status line under its list: when its processes stop by themselves. */
export function stopLine(view: Pick<SessionProcesses, 'working' | 'closed' | 'stopsAt' | 'processes'>, idleStopMinutes: number | null, now: number = Date.now()): string {
  const open = view.processes.filter((process) => !process.keep).length;
  if (view.processes.length === 0) return 'Nothing left running.';
  if (open === 0) return 'All kept: never stopped automatically.';
  if (view.working) return 'Working now: nothing is stopped while it works.';
  if (view.stopsAt) {
    const minutes = Math.max(0, Math.ceil((Date.parse(view.stopsAt) - now) / 60_000));
    return minutes <= 0 ? 'Stopping now (idle).' : `Stops in ${minutes} min if it stays idle${idleStopMinutes ? ` (after ${idleStopMinutes} min idle)` : ''}.`;
  }
  if (idleStopMinutes === 0) return 'Idle stop is off: stopped when the session is closed.';
  return 'Stopped when the session is idle or closed.';
}

/** The process's tooltip: what it is, its command, and why it is kept. */
export function processTitle(process: SessionProcess): string {
  const kept = process.keep ? `\nKept${process.keptBy === 'agent' ? ' by the agent' : ''}${process.keepReason ? `: ${process.keepReason}` : ''}` : '';
  return `${kindLabel(process.kind)} · pid ${process.pid}\n${process.command}${kept}`;
}
