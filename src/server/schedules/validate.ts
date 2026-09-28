import { parseCron } from '../../core/cron.ts';
import { type FieldError, type ValidNewSession, type ValidationFolder, validateNewSession } from '../sessions/validate.ts';

/** A schedule's stored template (D8; D14): the validated NewSession each run starts, with its folder's id. */
export type ScheduleTemplate = ValidNewSession & {
  /** The saved folder the runs start in (D14). */
  readonly folder: string | null;
};

/** A validated `POST /api/schedules` body (`ScheduleInput`, M7.1 / D8). */
export interface ValidScheduleInput {
  /** Set for an Edit: the schedule to replace. */
  readonly id: string | null;
  /** The expression as normalized by the parser (single spaces, lower case; macros expanded). */
  readonly cron: string;
  /** The session template: the NewSession each run starts, its `task` being the prompt, with its folder (D14). */
  readonly template: ScheduleTemplate;
  /** The schedule's name = `template.name`. */
  readonly name: string;
  /** The first line of the prompt, as the table's description. */
  readonly description: string;
}

/** Result of {@link validateScheduleInput}. */
export type ScheduleInputValidation = { readonly ok: true; readonly value: ValidScheduleInput } | { readonly ok: false; readonly errors: FieldError[] };

/** What the validation needs to know beyond the body. */
export interface ScheduleInputChecks {
  /** `true` if another schedule (not `exceptId`) has this name. */
  readonly scheduleNameTaken: (name: string, exceptId: string | null) => Promise<boolean>;
  /** The New-session read-only check (the workspace scan, M6.1). */
  readonly readOnly?: (solution: string) => Promise<boolean>;
  /**
   * The folder the runs start in (D14), resolved by the caller from
   * `template.folder` (default folder when omitted); its id goes into the stored
   * template. Without it the template is validated as a workspace session.
   */
  readonly folder?: ValidationFolder & { readonly id: string | null };
}

/** Longest description kept from the prompt's first line. */
const DESCRIPTION_LIMIT = 160;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The description the table shows: the prompt's first non-empty line, cut at {@link DESCRIPTION_LIMIT} characters. */
export function scheduleDescription(task: string): string {
  const line = task.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
  return line.length > DESCRIPTION_LIMIT ? `${line.slice(0, DESCRIPTION_LIMIT - 1)}…` : line;
}

/**
 * Validates a `POST /api/schedules` body (M7.1, D8): a valid cron expression, and
 * a template that is a valid NewSession (the contract's rules: kebab-case name,
 * solutions not empty and never read-only, `qa` for QA) with a non-empty task,
 * because the task is the prompt every run starts with. The template's name is
 * the schedule's name: unique among schedules (runs get their own session names,
 * `docs/schedules.md`). Field names of template errors carry a `template.` prefix.
 */
export async function validateScheduleInput(body: unknown, checks: ScheduleInputChecks): Promise<ScheduleInputValidation> {
  if (!isRecord(body)) return { ok: false, errors: [{ field: '', message: 'the body must be a ScheduleInput object ({ cron, template })' }] };
  const errors: FieldError[] = [];
  const rawId = body['id'];
  let id: string | null = null;
  if (rawId !== undefined && rawId !== null) {
    if (typeof rawId !== 'string' || rawId === '') errors.push({ field: 'id', message: 'id must be the id of an existing schedule' });
    else id = rawId;
  }

  const rawCron = body['cron'];
  let cron = '';
  if (typeof rawCron !== 'string') {
    errors.push({ field: 'cron', message: 'cron must be a cron expression, e.g. 0 2 * * * (02:00 daily)' });
  } else {
    const parsed = parseCron(rawCron);
    if (parsed.ok) cron = parsed.cron.expression;
    else errors.push({ field: 'cron', message: `cron: ${parsed.error}` });
  }

  const template = body['template'];
  let session: ValidNewSession | null = null;
  if (!isRecord(template)) {
    errors.push({ field: 'template', message: 'template must be the NewSession each run starts' });
  } else {
    const result = await validateNewSession(template, {
      // Runs get their own names (<schedule>-<MMDD>-<HHMM>); the schedule's name is checked among schedules below.
      nameTaken: async () => false,
      ...(checks.readOnly ? { readOnly: checks.readOnly } : {}),
      ...(checks.folder ? { folder: checks.folder } : {}),
    });
    if (!result.ok) {
      for (const error of result.errors) errors.push({ field: error.field ? `template.${error.field}` : 'template', message: error.message });
    } else {
      session = result.value;
      if (session.task.trim() === '') errors.push({ field: 'template.task', message: 'a scheduled run needs a task: it is the prompt every run starts with' });
      else if (await checks.scheduleNameTaken(session.name, id)) errors.push({ field: 'template.name', message: `a schedule named "${session.name}" already exists` });
    }
  }

  if (errors.length > 0 || session === null) return { ok: false, errors };
  const value: ValidScheduleInput = {
    id,
    cron,
    template: { ...session, task: session.task.trim(), folder: checks.folder?.id ?? null },
    name: session.name,
    description: scheduleDescription(session.task),
  };
  return { ok: true, value };
}
