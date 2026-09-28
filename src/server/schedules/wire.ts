import type { Schedule, ScheduleRun } from '../../core/api.ts';
import type { ScheduleRecord, ScheduleRunRecord } from '../db/repos/schedules.ts';

/** A stored run as the 14-run strip gets it. */
export function toScheduleRun(run: ScheduleRunRecord): ScheduleRun {
  return {
    ts: run.ts,
    result: run.result,
    summary: run.summary,
    finishedAt: run.finishedAt,
    sessionId: run.sessionId,
    triggeredBy: run.triggeredBy,
  };
}

/**
 * `GET /api/schedules` item (M7.1): the stored schedule, its newest runs (oldest
 * first, at most 14), when it fires next, whether a run is in progress and the
 * folder its runs start in (D14).
 */
export function toSchedule(schedule: ScheduleRecord, runs: readonly ScheduleRunRecord[], nextRunAt: Date | null, running: boolean): Schedule {
  return {
    id: schedule.id,
    name: schedule.name,
    description: schedule.description,
    cron: schedule.cron,
    paused: schedule.paused,
    template: schedule.template,
    runs: runs.slice(-14).map(toScheduleRun),
    nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
    running,
    folder: schedule.folderId,
  };
}
