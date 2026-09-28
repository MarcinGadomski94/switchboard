import type { CronPreview } from './schedule-form.ts';

/**
 * Section 7 · Schedule of the New-session modal (M7.1, D8): the cron field, its
 * readable preview (`02:00 daily`) and the next 3 run times. Shown only when the
 * modal was opened by "+ New scheduled run" or a schedule's Edit (section 3 for a
 * repo folder, D14).
 */
export function ScheduleSection({
  cron,
  preview,
  onCron,
  number = 7,
}: {
  readonly cron: string;
  readonly preview: CronPreview;
  readonly onCron: (cron: string) => void;
  /** The section's number: 7 after the router sections, 3 for a repo folder (D14: Task, Solution, Schedule). */
  readonly number?: number;
}) {
  const state = preview.ok ? 'ok' : cron.trim() === '' ? 'empty' : 'invalid';
  return (
    <div className="sb-ns-section" data-testid="ns-section" data-section="schedule">
      <div className="sb-ns-label">{`${number} · Schedule`}</div>
      <div className="sb-ns-schedule">
        <input
          className="sb-ns-input sb-ns-input--name"
          data-testid="ns-cron"
          aria-label="Cron expression"
          value={cron}
          placeholder="0 2 * * *"
          spellCheck={false}
          onChange={(event) => onCron(event.target.value)}
        />
        <span className="sb-ns-cron-preview" data-testid="ns-cron-preview" data-state={state}>
          {preview.ok ? preview.label : (preview.error ?? '')}
        </span>
      </div>
      {preview.ok ? (
        <div className="sb-ns-cron-runs" data-testid="ns-cron-runs">
          <span className="sb-ns-cron-runs-label">Next runs</span>
          {preview.runs.map((run) => (
            <span key={run} className="sb-ns-cron-run" data-testid="ns-cron-run">
              {run}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
