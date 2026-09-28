import type { ScheduleInput } from '../../core/api.ts';
import { MONTH_LABELS, WEEKDAY_LABELS, cronLabel, nextRuns, parseCron } from '../../core/cron.ts';
import { runSessionName } from '../../core/schedules.ts';
import { type FormFolder, type NewSessionForm, type SummaryLine, formComplete, nameTaken, sessionName, summaryLines, toSessionBody } from './new-session.ts';

/**
 * Pure logic of the New-session modal's Schedule section (M7.1, D8): the modal
 * opened by "+ New scheduled run" (or a row's Edit) shows a 7th section with the
 * cron field, its readable preview and the next 3 run times, and "Save schedule"
 * instead of "Start session". Rules: `docs/schedules.md` → *New scheduled run*.
 */

/** What the modal opens in schedule mode with: nothing for a new schedule, the schedule's id + cron for Edit. */
export interface ScheduleDraft {
  /** The schedule an Edit replaces. */
  readonly id?: string;
  readonly cron?: string;
}

/** How many upcoming run times the section lists (D8). */
export const PREVIEW_RUNS = 3;

/** The cron field's live preview. */
export interface CronPreview {
  readonly ok: boolean;
  /** The readable preview (`02:00 daily`); empty while invalid. */
  readonly label: string;
  /** The next {@link PREVIEW_RUNS} run times as {@link formatRunTime} writes them. */
  readonly runs: readonly string[];
  /** The first run as a date (the summary's worktree folders are named after it). */
  readonly first: Date | null;
  /** Why the expression is not valid; `null` when it is. */
  readonly error: string | null;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** A run time in the section: `Tue 29 Sep · 02:00` (local time). */
export function formatRunTime(date: Date): string {
  return `${WEEKDAY_LABELS[date.getDay()]} ${date.getDate()} ${MONTH_LABELS[date.getMonth()]} · ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The preview of the cron field at `now`. */
export function cronPreview(text: string, now: Date): CronPreview {
  const parsed = parseCron(text);
  if (!parsed.ok) return { ok: false, label: '', runs: [], first: null, error: parsed.error };
  const runs = nextRuns(parsed.cron, now, PREVIEW_RUNS);
  if (runs.length === 0) return { ok: false, label: cronLabel(parsed.cron), runs: [], first: null, error: 'this expression never runs (no such date)' };
  return { ok: true, label: cronLabel(parsed.cron), runs: runs.map(formatRunTime), first: runs[0] ?? null, error: null };
}

/**
 * "Save schedule" is enabled: what "Start session" needs (solutions, the QA
 * sources; nothing more for a repo folder, D14), a name no other schedule has
 * (the schedule's name keeps its rules: it is not a D22 title), plus a task — the
 * prompt of every run — and a valid cron expression.
 */
export function canSaveSchedule(form: NewSessionForm, preview: CronPreview, takenScheduleNames: readonly string[], folder: FormFolder | null = null): boolean {
  return formComplete(form, folder) && !nameTaken(form, takenScheduleNames) && form.task.trim() !== '' && preview.ok;
}

/**
 * The summary in schedule mode: the New-session summary for the first run's
 * session (`<name>-<MMDD>-<HHMM>`, so the worktree folders are the ones that run
 * gets), a `schedule` line after `ultracode`, and the schedule's own warnings
 * before the closing line.
 */
export function scheduleSummaryLines(
  form: NewSessionForm,
  root: string | null,
  preview: CronPreview,
  takenScheduleNames: readonly string[],
  folder: FormFolder | null = null,
): SummaryLine[] {
  const name = sessionName(form);
  const runName = preview.first ? runSessionName(name, preview.first) : `${name}-<MMDD>-<HHMM>`;
  const lines = summaryLines({ ...form, name: runName }, root, [], folder, 'as-typed');
  const at = lines.findIndex((line) => line.text.startsWith('ultracode'));
  lines.splice(at + 1, 0, { text: `schedule  ${preview.ok ? preview.label : '—'}`, tone: 'value' });
  const warnings: SummaryLine[] = [];
  if (takenScheduleNames.includes(name)) warnings.push({ text: '⚠ a schedule with this name exists', tone: 'warn' });
  if (form.task.trim() === '') warnings.push({ text: '⚠ add the task: it is the prompt of every run', tone: 'warn' });
  if (!preview.ok) warnings.push({ text: '⚠ enter a valid cron expression', tone: 'warn' });
  lines.splice(lines.length - 2, 0, ...warnings);
  return lines;
}

/**
 * The `POST /api/schedules` body (`ScheduleInput`): the template is exactly what
 * "Start session" would post, so it carries the form's folder (D14; a repo
 * folder's template is a `NewRepoSession`).
 */
export function toScheduleInput(form: NewSessionForm, cron: string, id: string | undefined, folder: FormFolder | null = null): ScheduleInput {
  return { ...(id ? { id } : {}), cron: cron.trim(), template: toSessionBody(form, folder) };
}

/** The line shown when `POST /api/schedules` refuses (`Not saved: …`). */
export function saveErrorText(status: number, body: unknown): string {
  if (typeof body === 'object' && body !== null) {
    const record = body as { errors?: unknown; message?: unknown };
    if (Array.isArray(record.errors)) {
      const messages = record.errors
        .map((e) => (typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message : null))
        .filter((m): m is string => m !== null);
      if (messages.length > 0) return `Not saved: ${messages.join('; ')}`;
    }
    if (typeof record.message === 'string' && record.message !== '') return `Not saved: ${record.message}`;
  }
  return status === 0 ? 'Not saved: Switchboard is not reachable.' : `Not saved: HTTP ${status}`;
}
