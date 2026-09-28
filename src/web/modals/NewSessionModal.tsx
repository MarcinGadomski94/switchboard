import { type MouseEvent, useState } from 'react';
import type { NewSessionPrefill, Schedule } from '../../core/api.ts';
import { ApiError, api } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { useHubEvent } from '../api/useHub.ts';
import { useThrottled } from '../api/useThrottled.ts';
import { useRouter } from '../router.tsx';
import {
  COORDINATION_OPTIONS,
  MODE_OPTIONS,
  type NewSessionForm,
  PHASE_OPTIONS,
  type PillOption,
  RECOMMENDED,
  STACK_OPTIONS,
  WORK_TYPE_OPTIONS,
  canStart,
  chipGroups,
  formFromPrefill,
  sanitizeName,
  showsCoordination,
  showsQa,
  startErrorText,
  summaryLines,
  toNewSession,
  toggleSolution,
  workspaceRoot,
} from './new-session.ts';
import { ScheduleSection } from './ScheduleSection.tsx';
import { type ScheduleDraft, canSaveSchedule, cronPreview, saveErrorText, scheduleSummaryLines, toScheduleInput } from './schedule-form.ts';
import './new-session.css';

/** `sessionUpdated` comes in bursts; the name check's session list reloads at most this often. */
const SESSIONS_RELOAD_MS = 1_000;

/** The message of a failed `GET /api/solutions` (as in the Solutions view). */
function solutionsErrorText(error: ApiError): string {
  const body = error.body as { error?: unknown; message?: unknown } | null;
  if (body?.error === 'no-folder') return 'No folder is saved yet. Add a workspace or a git repository in Settings.';
  if (typeof body?.message === 'string') return body.message;
  return error.unreachable ? 'Switchboard is not reachable.' : `The solutions could not be loaded (HTTP ${error.status}).`;
}

function Pills<T extends string>({
  group,
  label,
  options,
  value,
  onPick,
}: {
  readonly group: string;
  readonly label: string;
  readonly options: ReadonlyArray<PillOption<T>>;
  readonly value: T | null;
  readonly onPick: (value: T) => void;
}) {
  return (
    <div className="sb-ns-pills" role="radiogroup" aria-label={label}>
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          className="sb-button sb-ns-pill"
          data-testid="ns-pill"
          data-group={group}
          data-value={option}
          data-selected={value === option ? 'true' : 'false'}
          onClick={() => onPick(option)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function Toggle({ name, title, description, on, onToggle }: { readonly name: string; readonly title: string; readonly description: string; readonly on: boolean; readonly onToggle: () => void }) {
  return (
    <div className="sb-ns-toggle-row">
      <div className="sb-ns-toggle-text">
        <div className="sb-ns-toggle-title">{title}</div>
        <div className="sb-ns-toggle-desc">{description}</div>
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label={title} className="sb-button sb-ns-switch" data-testid={`ns-switch-${name}`} data-on={on ? 'true' : 'false'} onClick={onToggle}>
        <span className="sb-ns-knob" />
      </button>
    </div>
  );
}

/**
 * New-session modal (M5.1, SPEC → Modals → New session; prototype `mNew`): 1080px,
 * `1fr | 360px`. Left: sections 1–6 (task first; work type, mode, solutions from
 * the workspace scan with read-only folders locked, phase, then mobile
 * coordination for a single-solution feature session with a `*-front`, or the QA
 * contract for test-authoring). Right: the Worktree / Ultracode toggles, the live
 * mono summary with the worktree folders (gap #1), Cancel and "Start session",
 * which posts `POST /api/sessions` and opens the new session. `prefill` (M3.3, the
 * Inbox's "Open fix session") replaces the defaults; the dialog also carries it as
 * `data-prefill` (JSON). With `schedule` (M7.1, D8: "+ New scheduled run", or a
 * schedule's Edit with its id + cron) it adds section 7 · Schedule and "Save
 * schedule" posts `POST /api/schedules` instead (`docs/schedules.md`). Details:
 * `docs/new-session.md`.
 */
export function NewSessionModal({
  onClose,
  prefill = null,
  schedule = null,
}: {
  readonly onClose: () => void;
  readonly prefill?: NewSessionPrefill | null;
  readonly schedule?: ScheduleDraft | null;
}) {
  const { navigate } = useRouter();
  const solutions = useApi(api.solutions);
  const sessions = useApi(api.listSessions);
  useHubEvent('sessionUpdated', useThrottled(sessions.reload, SESSIONS_RELOAD_MS));

  const scheduling = schedule !== null;
  const schedules = useApi((): Promise<Schedule[]> => (scheduling ? api.schedules() : Promise.resolve([])), [scheduling]);
  const [cron, setCron] = useState(() => schedule?.cron ?? '');

  const [form, setForm] = useState<NewSessionForm>(() => formFromPrefill(prefill));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = (patch: Partial<NewSessionForm>): void => {
    setForm((current) => ({ ...current, ...patch }));
    setError(null);
  };

  const takenNames = (sessions.data ?? []).map((session) => session.name);
  const scanned = solutions.data ?? (solutions.error ? [] : null);
  const groups = chipGroups(scanned, form.solutions);
  const takenScheduleNames = (schedules.data ?? []).filter((s) => s.id !== schedule?.id).map((s) => s.name);
  const preview = cronPreview(cron, new Date());
  const lines = scheduling
    ? scheduleSummaryLines(form, workspaceRoot(solutions.data), preview, takenScheduleNames)
    : summaryLines(form, workspaceRoot(solutions.data), takenNames);
  const startable = (scheduling ? canSaveSchedule(form, preview, takenScheduleNames) : canStart(form, takenNames)) && !busy;
  const title = scheduling ? (schedule.id ? 'Edit scheduled run' : 'New scheduled run') : 'New session';

  const saveSchedule = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.createSchedule(toScheduleInput(form, cron, schedule?.id));
      onClose();
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : new ApiError(0, String(caught));
      setError(saveErrorText(apiError.status, apiError.body));
      schedules.reload();
      setBusy(false);
    }
  };

  const start = async (): Promise<void> => {
    if (!startable) return;
    if (scheduling) return saveSchedule();
    setBusy(true);
    setError(null);
    try {
      const session = await api.createSession(toNewSession(form));
      onClose();
      navigate({ view: 'session', id: session.id, tab: 'chat' });
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : new ApiError(0, String(caught));
      setError(startErrorText(apiError.status, apiError.body));
      sessions.reload();
      setBusy(false);
    }
  };

  return (
    <div className="sb-overlay" data-modal="new-session" onClick={onClose}>
      <div
        className="sb-modal-new"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="modal-new-session"
        data-schedule={scheduling ? (schedule.id ?? 'new') : undefined}
        data-prefill={prefill ? JSON.stringify(prefill) : undefined}
        onClick={(event: MouseEvent) => event.stopPropagation()}
      >
        <div className="sb-ns-form">
          <div className="sb-ns-head">
            <div className="sb-ns-title" data-testid="ns-title">
              {title}
            </div>
            <div className="sb-ns-sub">Claude Code · background · Max</div>
            <button type="button" className="sb-button sb-ns-recommended" data-testid="ns-recommended" onClick={() => update(RECOMMENDED)}>
              Accept recommended
            </button>
          </div>

          <div className="sb-ns-section" data-testid="ns-section" data-section="task">
            <div className="sb-ns-label">1 · Task definition</div>
            <div className="sb-ns-task">
              <input
                className="sb-ns-input sb-ns-input--name"
                data-testid="ns-name"
                aria-label="Session name"
                value={form.name}
                placeholder="session-name"
                spellCheck={false}
                onChange={(event) => update({ name: sanitizeName(event.target.value) })}
              />
              <input
                className="sb-ns-input"
                data-testid="ns-task"
                aria-label="Task"
                value={form.task}
                placeholder="What should be implemented?"
                onChange={(event) => update({ task: event.target.value })}
              />
            </div>
          </div>

          <div className="sb-ns-section" data-testid="ns-section" data-section="work-type">
            <div className="sb-ns-label">2 · Work type</div>
            <Pills group="work-type" label="Work type" options={WORK_TYPE_OPTIONS} value={form.workType} onPick={(workType) => update({ workType })} />
          </div>

          <div className="sb-ns-section" data-testid="ns-section" data-section="mode">
            <div className="sb-ns-label">3 · Mode</div>
            <Pills group="mode" label="Mode" options={MODE_OPTIONS} value={form.mode} onPick={(mode) => update({ mode })} />
          </div>

          <div className="sb-ns-section sb-ns-section--solutions" data-testid="ns-section" data-section="solutions">
            <div className="sb-ns-label sb-ns-label--row">
              4 · Solutions in scope
              <span className="sb-ns-hint" data-testid="ns-solutions-hint">
                {form.solutions.length} selected · read-only folders locked
              </span>
            </div>
            {groups.map((group) => (
              <div key={group.folder} className="sb-ns-group" data-testid="ns-group" data-folder={group.folder}>
                <span className="sb-ns-folder">{group.folder}</span>
                <div className="sb-ns-chips">
                  {group.chips.map((chip) => (
                    <button
                      key={chip.value}
                      type="button"
                      className="sb-button sb-ns-chip"
                      data-testid="ns-chip"
                      data-solution={chip.value}
                      data-selected={chip.selected ? 'true' : 'false'}
                      data-locked={chip.locked ? 'true' : undefined}
                      aria-pressed={chip.locked ? undefined : chip.selected}
                      disabled={chip.locked}
                      title={chip.locked ? 'Read-only: never a write target' : undefined}
                      onClick={() => update({ solutions: toggleSolution(form.solutions, chip.value) })}
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {solutions.error && !solutions.data ? (
              <div className="sb-ns-note" data-testid="ns-solutions-note">
                {solutionsErrorText(solutions.error)}
              </div>
            ) : null}
            {solutions.data && solutions.data.length === 0 ? (
              <div className="sb-ns-note" data-testid="ns-solutions-note">
                No solutions found in the workspace.
              </div>
            ) : null}
          </div>

          <div className="sb-ns-section" data-testid="ns-section" data-section="phase">
            <div className="sb-ns-label">5 · Phase</div>
            <Pills group="phase" label="Phase" options={PHASE_OPTIONS} value={form.phase} onPick={(phase) => update({ phase })} />
          </div>

          {showsCoordination(form) ? (
            <div className="sb-ns-section" data-testid="ns-section" data-section="coordination">
              <div className="sb-ns-label">6 · Mobile coordination</div>
              <Pills group="coordination" label="Mobile coordination" options={COORDINATION_OPTIONS} value={form.coordination} onPick={(coordination) => update({ coordination })} />
            </div>
          ) : null}

          {showsQa(form) ? (
            <div className="sb-ns-section sb-ns-section--qa" data-testid="ns-section" data-section="qa">
              <div className="sb-ns-label">6 · QA contract</div>
              <Pills group="stack" label="Stack under test" options={STACK_OPTIONS} value={form.stack} onPick={(stack) => update({ stack })} />
              <div className="sb-ns-qa-fields">
                <input
                  className="sb-ns-input sb-ns-input--qa"
                  data-testid="ns-confluence"
                  aria-label="Confluence page URL"
                  value={form.confluenceUrl}
                  placeholder="Confluence page URL (required)"
                  spellCheck={false}
                  onChange={(event) => update({ confluenceUrl: event.target.value })}
                />
                <input
                  className="sb-ns-input sb-ns-input--qa"
                  data-testid="ns-figma"
                  aria-label="Figma frame URLs"
                  value={form.figmaUrls}
                  placeholder="Figma frame URL per breakpoint (required)"
                  spellCheck={false}
                  onChange={(event) => update({ figmaUrls: event.target.value })}
                />
              </div>
            </div>
          ) : null}

          {scheduling ? (
            <ScheduleSection
              cron={cron}
              preview={preview}
              onCron={(value) => {
                setCron(value);
                setError(null);
              }}
            />
          ) : null}
        </div>

        <div className="sb-ns-side">
          <div className="sb-ns-side-label">Launch</div>
          <div className="sb-ns-toggles">
            <Toggle name="worktrees" title="Worktree per solution" description="Kept until the PR is merged on GitHub" on={form.worktrees} onToggle={() => update({ worktrees: !form.worktrees })} />
            <Toggle name="ultracode" title="Ultracode (workflows)" description="Dispatch via the Workflow tool" on={form.ultracode} onToggle={() => update({ ultracode: !form.ultracode })} />
          </div>
          <div className="sb-ns-side-label sb-ns-side-label--summary">Summary</div>
          <div className="sb-ns-summary" data-testid="ns-summary">
            {lines.map((line, index) => (
              <div key={index} className="sb-ns-summary-line" data-testid="ns-summary-line" data-tone={line.tone}>
                {line.text}
              </div>
            ))}
          </div>
          {error ? (
            <div className="sb-ns-error" data-testid="ns-error" role="alert">
              {error}
            </div>
          ) : null}
          <div className="sb-ns-actions">
            <button type="button" className="sb-button sb-ns-cancel" data-testid="ns-cancel" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="sb-button sb-ns-start"
              data-testid={scheduling ? 'ns-save-schedule' : 'ns-start'}
              disabled={!startable}
              onClick={() => void start()}
            >
              {scheduling ? 'Save schedule' : 'Start session'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
