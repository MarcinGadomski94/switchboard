import { useEffect, useRef, useState } from 'react';
import type { NewSessionPrefill, Schedule } from '../../core/api.ts';
import { ApiError, api } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { useHubEvent } from '../api/useHub.ts';
import { useThrottled } from '../api/useThrottled.ts';
import { FolderTag } from '../folders/FolderTag.tsx';
import { useFolderTags } from '../folders/useFolders.ts';
import { MachineTag } from '../components/MachineTag.tsx';
import { useModals } from '../modals/ModalHost.tsx';
import { actionErrorText, scheduleRows, toneColor } from './schedule-table.ts';
import './schedule-table.css';

/** Session updates come in bursts; `running` (Run now ↔ Running) follows them at most this often. */
const SESSIONS_RELOAD_MS = 1_000;
/** The relative Next / Failed … ago texts are redrawn this often. */
const CLOCK_MS = 30_000;
/** D52: the list is read again this often (a paired machine's schedules change there without an event here). */
const PEERS_RELOAD_MS = 15_000;

/** The message of a failed `GET /api/schedules`. */
function loadErrorText(error: ApiError): string {
  if (error.unreachable) return 'Switchboard is not reachable.';
  const body = error.body as { message?: unknown } | null;
  return typeof body?.message === 'string' ? body.message : `The schedules could not be loaded (HTTP ${error.status}).`;
}

/**
 * The Schedules & loops header and schedule table (M7.1; SPEC → Schedules & loops,
 * prototype `vSchedules`): "+ New scheduled run" opens the New-session modal with
 * its Schedule section (D8); a row's name opens it prefilled (Edit); Run now and
 * Pause / Resume call the contract's routes. Reloads on `/hub` `scheduleRun` and
 * `sessionUpdated`, and after the modal closes.
 */
export function ScheduleHeader() {
  const { open } = useModals();
  return (
    <div className="sb-sch-head">
      <div className="sb-sch-title">Schedules &amp; loops</div>
      <div className="sb-sch-sub">scheduled Claude Code runs + long-running loops</div>
      <button type="button" className="sb-button sb-sch-new" data-testid="schedule-new" onClick={() => open('new-session', { schedule: {} })}>
        + New scheduled run
      </button>
    </div>
  );
}

/**
 * The schedule table (see {@link ScheduleHeader}). D14: a schedule that starts its
 * runs in a folder other than the default one carries its tag after the name; Edit
 * reopens the form with the template's folder.
 */
export function ScheduleTable() {
  const schedules = useApi(api.schedules);
  const { tagOf, titleOf } = useFolderTags();
  const { modal, open } = useModals();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = schedules.reload;
  useHubEvent('scheduleRun', () => reload());
  useHubEvent('sessionUpdated', useThrottled(reload, SESSIONS_RELOAD_MS));

  // After "Save schedule" the modal closes: show the new or edited row.
  const lastModal = useRef(modal);
  useEffect(() => {
    if (lastModal.current === 'new-session' && modal === null) reload();
    lastModal.current = modal;
  }, [modal, reload]);

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(timer);
  }, [schedules.data]);

  // D52: a paired machine's schedules (saved, paused or deleted there; its state) follow within this period.
  useEffect(() => {
    const timer = window.setInterval(() => reload(), PEERS_RELOAD_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  const act = async (id: string, action: () => Promise<Schedule>): Promise<void> => {
    setBusy(id);
    setError(null);
    try {
      await action();
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : new ApiError(0, String(caught));
      setError(actionErrorText(apiError.status, apiError.body));
    } finally {
      setBusy(null);
      reload();
    }
  };

  const edit = (schedule: Schedule): void => {
    const template = typeof schedule.template === 'object' && schedule.template !== null ? (schedule.template as NewSessionPrefill) : null;
    open('new-session', { prefill: { ...template, name: schedule.name }, schedule: { id: schedule.id, cron: schedule.cron } });
  };

  const rows = scheduleRows(schedules.data ?? [], now);
  const byId = new Map((schedules.data ?? []).map((schedule) => [schedule.id, schedule]));

  return (
    <div className="sb-sch-table" data-testid="schedule-table">
      <div className="sb-sch-row sb-sch-row--head">
        <span />
        <span>Run</span>
        <span>Schedule</span>
        <span>Last 14 runs</span>
        <span>Next</span>
        <span />
      </div>
      {rows.map((row) => (
        <div key={row.id} className="sb-sch-row" data-testid="schedule-row" data-schedule={row.name} data-machine={row.machine?.id}>
          <span className="sb-sch-dot" data-testid="schedule-dot" data-tone={row.dot} style={{ background: toneColor(row.dot) }} />
          <button
            type="button"
            className="sb-button sb-sch-names"
            data-testid="schedule-edit"
            title={row.blocked ?? 'Edit schedule'}
            disabled={row.blocked !== null}
            onClick={() => {
              const schedule = byId.get(row.id);
              if (schedule) edit(schedule);
            }}
          >
            <span className="sb-sch-name" data-testid="schedule-name">
              {row.name}
              {/* D52: a peer's schedule names its machine (its folder ids are that machine's: no local folder tag). */}
              {row.machine ? (
                <MachineTag machine={row.machine} testId="schedule-machine" />
              ) : (
                <FolderTag name={tagOf({ folder: byId.get(row.id)?.folder ?? null })} title={titleOf({ folder: byId.get(row.id)?.folder ?? null })} />
              )}
            </span>
            <span className="sb-sch-desc" data-testid="schedule-desc">
              {row.description}
            </span>
          </button>
          <span className="sb-sch-cron" data-testid="schedule-cron" title={row.cron}>
            {row.cronText}
          </span>
          <div className="sb-sch-runs">
            <div className="sb-sch-strip" data-testid="schedule-strip">
              {row.strip.map((tone, index) => (
                <span key={index} className="sb-sch-cell" data-testid="schedule-cell" data-tone={tone} style={{ background: toneColor(tone) }} />
              ))}
            </div>
            <span className="sb-sch-last" data-testid="schedule-last">
              {row.last}
            </span>
          </div>
          <span className="sb-sch-next" data-testid="schedule-next">
            {row.next}
          </span>
          <div className="sb-sch-actions">
            <button
              type="button"
              className="sb-button sb-sch-action"
              data-testid="schedule-run"
              title={row.blocked ?? undefined}
              disabled={row.runDisabled || busy === row.id || row.blocked !== null}
              onClick={() => void act(row.id, () => api.runSchedule(row.id))}
            >
              {row.runLabel}
            </button>
            <button
              type="button"
              className="sb-button sb-sch-action"
              data-testid="schedule-pause"
              title={row.blocked ?? undefined}
              disabled={busy === row.id || row.blocked !== null}
              onClick={() => void act(row.id, () => (byId.get(row.id)?.paused ? api.resumeSchedule(row.id) : api.pauseSchedule(row.id)))}
            >
              {row.pauseLabel}
            </button>
          </div>
        </div>
      ))}
      {schedules.data && rows.length === 0 ? (
        <div className="sb-sch-note" data-testid="schedule-empty">
          No scheduled runs yet. “+ New scheduled run” saves a session template with a cron schedule.
        </div>
      ) : null}
      {schedules.error && !schedules.data ? (
        <div className="sb-sch-note" data-testid="schedule-load-error">
          {loadErrorText(schedules.error)}
        </div>
      ) : null}
      {error ? (
        <div className="sb-sch-error" data-testid="schedule-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
