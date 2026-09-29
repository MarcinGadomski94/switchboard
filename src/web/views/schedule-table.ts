import type { Schedule, ScheduleRun } from '../../core/api.ts';
import { WEEKDAY_LABELS, MONTH_LABELS, cronLabel } from '../../core/cron.ts';
import type { ScheduleRunResult, SessionStatus } from '../../core/model.ts';
import { type SessionMachine, offlineReason } from '../../core/peers.ts';
import { formatAge } from '../shell/format.ts';

/**
 * Pure model of the Schedules & loops view's schedule table (M7.1, SPEC →
 * Schedules & loops; prototype `SCH` / `scheds`): per schedule the status dot,
 * name + description, the readable cron, the 14-run strip with the last result,
 * the next run and the Run now / Pause buttons. Everything comes from
 * `GET /api/schedules`; the copy rules are in `docs/schedules.md` → *The table*.
 */

/** Cells in the history strip (SPEC: a 14-run strip). */
export const STRIP_LENGTH = 14;

/** Color of a strip cell or dot: a status token, or `none` (#26272c: skipped / no run). */
export type CellTone = SessionStatus | 'none';

/** One row of the table. */
export interface ScheduleRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** The readable cron (`02:00 daily`), or the expression when it has no short form. */
  readonly cronText: string;
  /** The raw expression (the cell's tooltip). */
  readonly cron: string;
  readonly dot: CellTone;
  /** 14 cells, oldest first; missing runs at the start are `none`. */
  readonly strip: readonly CellTone[];
  /** The last result line (`OK · …`, `Failed 38m ago · …`, `Running now…`). */
  readonly last: string;
  /** Next run (`in 23h 22m`, `tomorrow 08:30`, `Mon 07:00`, `paused`). */
  readonly next: string;
  /** `Run now`, or `Running` while a run is in progress (then disabled). */
  readonly runLabel: string;
  readonly runDisabled: boolean;
  /** `Pause` / `Resume`. */
  readonly pauseLabel: string;
  /** D52: the paired machine the schedule lives on (its tag); `null` for this machine's own. */
  readonly machine: SessionMachine | null;
  /** D52: why nothing can be done with it now (`<machine> is offline — reconnect to continue`); `null` when it can. */
  readonly blocked: string | null;
}

/** The strip / dot tone of a run result (prototype `rs`: g ok, r fail, a need, b running, n skipped). */
export function resultTone(result: ScheduleRunResult): CellTone {
  switch (result) {
    case 'ok':
      return 'done';
    case 'fail':
      return 'fail';
    case 'need':
      return 'need';
    case 'running':
      return 'run';
    default:
      return 'none';
  }
}

/** The CSS color of a tone (SPEC status tokens; `none` = `--status-none`, #26272c). */
export function toneColor(tone: CellTone): string {
  return `var(--status-${tone === 'paused' ? 'idle' : tone})`;
}

/** The 14 cells: the newest runs, oldest first, padded with `none` at the start. */
export function stripCells(runs: readonly ScheduleRun[]): CellTone[] {
  const recent = runs.slice(-STRIP_LENGTH).map((run) => resultTone(run.result));
  return [...Array.from({ length: STRIP_LENGTH - recent.length }, (): CellTone => 'none'), ...recent];
}

/** The status dot: idle while paused, else the newest run that was not skipped; idle without one. */
export function dotTone(schedule: Pick<Schedule, 'paused' | 'runs'>): CellTone {
  if (schedule.paused) return 'idle';
  for (let i = schedule.runs.length - 1; i >= 0; i--) {
    const run = schedule.runs[i];
    if (run && run.result !== 'skipped') return resultTone(run.result);
  }
  return 'idle';
}

/** The last result line (prototype copy: `OK · 5 projects reindexed`, `Failed 38m ago · Android XamlC`, `Asked: include QA coverage?`, `Running now…`). */
export function lastLine(runs: readonly ScheduleRun[], now: number = Date.now()): string {
  const run = runs[runs.length - 1];
  if (!run) return 'No runs yet';
  const summary = run.summary?.trim() ?? '';
  switch (run.result) {
    case 'running':
      return 'Running now…';
    case 'ok':
      return summary ? `OK · ${summary}` : 'OK';
    case 'need':
      return summary ? `Asked: ${summary}` : 'Waiting for you';
    case 'skipped':
      return summary ? `Skipped · ${summary}` : 'Skipped';
    case 'fail': {
      const age = formatAge(run.finishedAt ?? run.ts, now);
      const when = age === 'now' ? 'Failed just now' : `Failed ${age} ago`;
      return summary ? `${when} · ${summary}` : when;
    }
  }
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** `HH:MM` local time. */
export function clockTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * The Next column: `paused`; `in 1h 12m` within a day (minutes rounded up);
 * `tomorrow 08:30`; `Mon 07:00` within a week; else `29 Oct 07:00`; `—` when the
 * expression never fires again.
 */
export function nextLine(schedule: Pick<Schedule, 'paused' | 'nextRunAt'>, now: number = Date.now()): string {
  if (schedule.paused) return 'paused';
  if (!schedule.nextRunAt) return '—';
  const next = new Date(schedule.nextRunAt);
  const ms = next.getTime() - now;
  if (!Number.isFinite(ms)) return '—';
  if (ms < 24 * 3_600_000) {
    const minutes = Math.max(Math.ceil(ms / 60_000), 0);
    if (minutes === 0) return 'now';
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0) return `in ${rest}m`;
    return rest === 0 ? `in ${hours}h` : `in ${hours}h ${rest}m`;
  }
  const days = Math.round((startOfDay(next) - startOfDay(new Date(now))) / 86_400_000);
  if (days === 1) return `tomorrow ${clockTime(next)}`;
  if (days < 7) return `${WEEKDAY_LABELS[next.getDay()]} ${clockTime(next)}`;
  return `${next.getDate()} ${MONTH_LABELS[next.getMonth()]} ${clockTime(next)}`;
}

/** The table's rows, in the API's order (creation order). */
export function scheduleRows(schedules: readonly Schedule[], now: number = Date.now()): ScheduleRow[] {
  return schedules.map((schedule) => {
    const running = schedule.running === true;
    return {
      id: schedule.id,
      name: schedule.name,
      description: schedule.description,
      cronText: cronLabel(schedule.cron),
      cron: schedule.cron,
      dot: dotTone(schedule),
      strip: stripCells(schedule.runs),
      last: lastLine(schedule.runs, now),
      next: nextLine(schedule, now),
      runLabel: running ? 'Running' : 'Run now',
      runDisabled: running,
      pauseLabel: schedule.paused ? 'Resume' : 'Pause',
      machine: schedule.machine ?? null,
      blocked: offlineReason(schedule.machine),
    };
  });
}

/** The line shown when a schedule action is refused (`Not done: …`). */
export function actionErrorText(status: number, body: unknown): string {
  if (typeof body === 'object' && body !== null) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return `Not done: ${message}`;
  }
  return status === 0 ? 'Not done: Switchboard is not reachable.' : `Not done: HTTP ${status}`;
}
