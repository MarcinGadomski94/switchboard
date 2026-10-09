/**
 * D94 (`docs/loops.md`): Switchboard-owned loops. A session's agent creates them
 * with the `switchboard` MCP tool `loop_create` (or the developer from the UI) and
 * Switchboard fires them: at each due time it sends the loop's prompt into the
 * session as a message. These are the rules the server, the UI and the MCP helper
 * share: validation, the next due time, the texts. Pure: no I/O, no timers.
 */
import type { OwnedLoop, OwnedLoopSchedule } from './api.ts';
import { cronLabel, nextRun, parseCron } from './cron.ts';
import type { TodoToolDefinition } from './todos.ts';

/** The longest prompt (characters). */
export const LOOP_PROMPT_MAX = 10_000;

/** The longest label (characters, one line). */
export const LOOP_LABEL_MAX = 60;

/** A derived label is the prompt's first line cut to this many characters. */
export const LOOP_TITLE_CUT = 48;

/** The longest interval of `every_minutes`: 31 days. */
export const LOOP_EVERY_MAX = 31 * 24 * 60;

/** The largest `max_runs`. */
export const LOOP_MAX_RUNS_MAX = 100_000;

/** The most loops one session keeps that have not ended (a runaway agent stops here). */
export const LOOPS_PER_SESSION_MAX = 20;

/** Ended loops are kept this long (the agent's `loop_list` still says why they ended), then removed. */
export const LOOP_ENDED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** The chat chip's ring (the loop symbol). */
export const LOOP_SYMBOL = '⟳';

/** A field error (the same shape as the other validations). */
export interface LoopFieldError {
  readonly field: string;
  readonly message: string;
}

/** A create's or an update's checked fields (an update carries only the fields it changes). */
export interface LoopFields {
  readonly prompt?: string;
  readonly schedule?: OwnedLoopSchedule;
  readonly expiresAt?: string | null;
  readonly maxRuns?: number | null;
  readonly label?: string | null;
}

/** Result of {@link checkLoopInput}. */
export type LoopCheck = { readonly ok: true; readonly value: LoopFields } | { readonly ok: false; readonly errors: LoopFieldError[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A field by its API name (`everyMinutes`) or its tool name (`every_minutes`). */
function pick(body: Record<string, unknown>, camel: string, snake: string): unknown {
  return body[camel] !== undefined ? body[camel] : body[snake];
}

/** `null` / `''` = remove the value. */
function isEmpty(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.trim() === '');
}

/** An ISO 8601 date-time with a date (`2026-10-09T15:00`, with or without seconds / zone); `null` when it is not one. */
export function parseLoopTime(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(trimmed)) return null;
  const at = new Date(trimmed.replace(' ', 'T'));
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Checks a create (`partial` false: a prompt and exactly one of `cron` /
 * `every_minutes` / `at` are required) or an update (`partial` true: only the
 * fields given; at most one schedule field). Field names are accepted in the
 * API's camelCase and the tools' snake_case. `at` and `expires_at` must be in the
 * future (after `now`); a cron expression goes through the scheduler's parser.
 */
export function checkLoopInput(body: unknown, now: Date, options: { readonly partial?: boolean } = {}): LoopCheck {
  const partial = options.partial === true;
  if (!isRecord(body)) return { ok: false, errors: [{ field: '', message: 'the body must be an object ({ prompt, cron | every_minutes | at, … })' }] };
  const errors: LoopFieldError[] = [];
  const value: { -readonly [K in keyof LoopFields]: LoopFields[K] } = {};

  const prompt = body['prompt'];
  if (prompt !== undefined || !partial) {
    if (typeof prompt !== 'string' || prompt.trim() === '') errors.push({ field: 'prompt', message: 'prompt must be the message to send at each firing (not empty)' });
    else if (prompt.length > LOOP_PROMPT_MAX) errors.push({ field: 'prompt', message: `prompt must be at most ${LOOP_PROMPT_MAX} characters` });
    else value.prompt = prompt.trim();
  }

  const cron = pick(body, 'cron', 'cron');
  const every = pick(body, 'everyMinutes', 'every_minutes');
  const at = pick(body, 'at', 'at');
  const given = [cron, every, at].filter((field) => field !== undefined && field !== null && field !== '').length;
  if (given > 1) errors.push({ field: 'schedule', message: 'give exactly one of cron, every_minutes or at' });
  else if (given === 0 && !partial) errors.push({ field: 'schedule', message: 'give one of cron (a cron expression), every_minutes (an interval) or at (one time)' });
  else if (given === 1) {
    if (cron !== undefined && cron !== null && cron !== '') {
      const parsed = typeof cron === 'string' ? parseCron(cron) : null;
      if (!parsed || !parsed.ok) errors.push({ field: 'cron', message: `cron: ${parsed && !parsed.ok ? parsed.error : 'must be a cron expression, e.g. */30 * * * * (every 30 minutes)'}` });
      else if (nextRun(parsed.cron, now) === null) errors.push({ field: 'cron', message: 'cron: this expression never fires' });
      else value.schedule = { kind: 'cron', cron: parsed.cron.expression };
    } else if (every !== undefined && every !== null && every !== '') {
      if (typeof every !== 'number' || !Number.isInteger(every) || every < 1 || every > LOOP_EVERY_MAX) {
        errors.push({ field: 'every_minutes', message: `every_minutes must be a whole number of minutes, 1–${LOOP_EVERY_MAX}` });
      } else value.schedule = { kind: 'every', minutes: every };
    } else {
      const time = parseLoopTime(at);
      if (time === null) errors.push({ field: 'at', message: 'at must be an ISO 8601 date and time, e.g. 2026-10-09T15:00:00+02:00' });
      else if (time.getTime() <= now.getTime()) errors.push({ field: 'at', message: 'at must be in the future' });
      else value.schedule = { kind: 'at', at: time.toISOString() };
    }
  }

  const expires = pick(body, 'expiresAt', 'expires_at');
  if (expires !== undefined) {
    if (isEmpty(expires)) value.expiresAt = null;
    else {
      const time = parseLoopTime(expires);
      if (time === null) errors.push({ field: 'expires_at', message: 'expires_at must be an ISO 8601 date and time (or null for no expiry)' });
      else if (time.getTime() <= now.getTime()) errors.push({ field: 'expires_at', message: 'expires_at must be in the future' });
      else value.expiresAt = time.toISOString();
    }
  }

  const maxRuns = pick(body, 'maxRuns', 'max_runs');
  if (maxRuns !== undefined) {
    if (isEmpty(maxRuns) || maxRuns === 0) value.maxRuns = null;
    else if (typeof maxRuns !== 'number' || !Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > LOOP_MAX_RUNS_MAX) {
      errors.push({ field: 'max_runs', message: `max_runs must be a whole number, 1–${LOOP_MAX_RUNS_MAX} (or null for no limit)` });
    } else value.maxRuns = maxRuns;
  }

  const label = body['label'];
  if (label !== undefined) {
    if (isEmpty(label)) value.label = null;
    else if (typeof label !== 'string' || /[\r\n]/.test(label.trim())) errors.push({ field: 'label', message: 'label must be one short line' });
    else if (label.trim().length > LOOP_LABEL_MAX) errors.push({ field: 'label', message: `label must be at most ${LOOP_LABEL_MAX} characters` });
    else value.label = label.trim();
  }

  if (!partial && value.schedule?.kind === 'at' && value.expiresAt && Date.parse(value.expiresAt) <= Date.parse(value.schedule.at)) {
    errors.push({ field: 'expires_at', message: 'expires_at must be after the one-time firing (at)' });
  }
  if (partial && Object.keys(value).length === 0 && errors.length === 0) errors.push({ field: '', message: 'give what to change: prompt, a schedule (cron, every_minutes or at), expires_at, max_runs or label' });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/**
 * The first due time strictly after `after`: a cron's next match (machine-local
 * time), `every` = `after` + the interval, a one-shot's time while it is after
 * `after`; `null` when nothing is due any more.
 */
export function nextDue(schedule: OwnedLoopSchedule, after: Date): Date | null {
  switch (schedule.kind) {
    case 'cron': {
      const parsed = parseCron(schedule.cron);
      return parsed.ok ? nextRun(parsed.cron, after) : null;
    }
    case 'every':
      return new Date(after.getTime() + schedule.minutes * 60_000);
    case 'at': {
      const at = Date.parse(schedule.at);
      return Number.isNaN(at) || at <= after.getTime() ? null : new Date(at);
    }
  }
}

/**
 * The due time after `due` that is later than `now`, and how many due times in
 * between were missed (no catch-up: they are skipped). `every` keeps its rhythm
 * (`due` + n × interval). Counting stops at `cap`.
 */
export function followingDue(schedule: OwnedLoopSchedule, due: Date, now: Date, cap = 10_000): { readonly next: Date | null; readonly missed: number } {
  if (schedule.kind === 'at') return { next: null, missed: 0 };
  if (schedule.kind === 'every') {
    const step = schedule.minutes * 60_000;
    const ahead = Math.floor((now.getTime() - due.getTime()) / step);
    const missed = Math.max(0, ahead);
    return { next: new Date(due.getTime() + (missed + 1) * step), missed: Math.min(missed, cap) };
  }
  let missed = 0;
  let next = nextDue(schedule, due);
  while (next !== null && next.getTime() <= now.getTime() && missed < cap) {
    missed++;
    next = nextDue(schedule, next);
  }
  if (next !== null && next.getTime() <= now.getTime()) next = nextDue(schedule, now);
  return { next, missed };
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** A local time as `2026-10-12 15:00`. */
export function localStamp(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** An interval in words: `every minute`, `every 30 min`, `every 2 h`, `every 1 h 30 min`, `every 2 days`. */
export function everyText(minutes: number): string {
  if (minutes === 1) return 'every minute';
  if (minutes < 60) return `every ${minutes} min`;
  if (minutes % 1440 === 0) return minutes === 1440 ? 'every day' : `every ${minutes / 1440} days`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `every ${hours} h` : `every ${hours} h ${rest} min`;
}

/** The schedule in words: `every 30 min`, the cron's preview (`02:00 daily`, else the expression), `once at 2026-10-12 15:00`. */
export function scheduleText(schedule: OwnedLoopSchedule): string {
  switch (schedule.kind) {
    case 'every':
      return everyText(schedule.minutes);
    case 'cron': {
      const label = cronLabel(schedule.cron);
      return label === schedule.cron ? `cron ${schedule.cron}` : label;
    }
    case 'at':
      return `once at ${localStamp(new Date(schedule.at))}`;
  }
}

/** The name a loop is shown by: its label, else the prompt's first line cut to {@link LOOP_TITLE_CUT}. */
export function loopTitle(label: string | null, prompt: string): string {
  if (label && label.trim() !== '') return label.trim();
  const line = prompt.split(/\r?\n/).map((part) => part.trim()).find((part) => part !== '') ?? 'loop';
  return line.length > LOOP_TITLE_CUT ? `${line.slice(0, LOOP_TITLE_CUT - 1)}…` : line;
}

/** The chat's chip above a firing: `⟳ Check CI · run 12`. */
export function loopChipText(mark: { readonly label: string; readonly run: number }): string {
  return `${LOOP_SYMBOL} ${mark.label} · run ${mark.run}`;
}

/** The state in words: `active`, `paused`, `ended: expired`. */
export function loopStateText(loop: Pick<OwnedLoop, 'state' | 'endedReason'>): string {
  return loop.state === 'ended' ? `ended: ${loop.endedReason ?? 'ended'}` : loop.state;
}

/** One loop as `loop_list` prints it. */
export function loopLine(loop: OwnedLoop): string {
  const parts = [
    `[${loop.id}] ${loop.title}`,
    loop.scheduleText,
    `next: ${loop.nextFireAt ?? '—'}`,
    `expires: ${loop.expiresAt ?? 'no expiry'}`,
    `runs: ${loop.runs}${loop.maxRuns !== null ? ` of ${loop.maxRuns}` : ''}${loop.skipped > 0 ? ` (${loop.skipped} skipped)` : ''}`,
    loopStateText(loop),
  ];
  if (loop.createdBy === 'developer') parts.push('made by the developer');
  return parts.join(' · ');
}

/** The `loop_list` text. */
export function loopListText(loops: readonly OwnedLoop[]): string {
  if (loops.length === 0) return 'This session has no Switchboard loops.';
  return [`This session's Switchboard loops (${loops.length}); times are UTC:`, ...loops.map(loopLine)].join('\n');
}

/** A created / changed loop as the tools answer it. */
export function loopDetailText(loop: OwnedLoop, verb: string): string {
  return `${verb}: ${loopLine(loop)}\nid: ${loop.id}\nPrompt: ${loop.prompt}`;
}

const LOOP_ID = { type: 'string', description: 'The loop id, as loop_create and loop_list show it in brackets.' } as const;

const PROMPT = { type: 'string', description: `The message Switchboard sends into this session at each firing (at most ${LOOP_PROMPT_MAX} characters), e.g. "Check the CI run and report what failed."` } as const;

const CRON = { type: 'string', description: 'A cron expression in the machine\'s local time (minute hour day month weekday), e.g. "*/30 * * * *" or "0 9 * * 1-5". Give exactly one of cron, every_minutes, at.' } as const;

const EVERY = { type: 'integer', minimum: 1, maximum: LOOP_EVERY_MAX, description: 'Fire every this many minutes, starting this many minutes from now. Give exactly one of cron, every_minutes, at.' } as const;

const AT = { type: 'string', description: 'Fire once at this ISO 8601 time (with a zone offset, e.g. 2026-10-09T15:00:00+02:00); it must be in the future. Give exactly one of cron, every_minutes, at.' } as const;

const EXPIRES = { type: ['string', 'null'], description: 'Optional ISO 8601 time after which it no longer fires. Leave it out for no expiry: it runs until cancelled.' } as const;

const MAX_RUNS = { anyOf: [{ type: 'integer', minimum: 1, maximum: LOOP_MAX_RUNS_MAX }, { type: 'null' }], description: 'Optional: stop after this many firings.' } as const;

const LABEL = { type: 'string', description: `Optional short name (at most ${LOOP_LABEL_MAX} characters) shown on the card and above each firing in the chat, e.g. "CI watch".` } as const;

/**
 * D94: the loop tools of the `switchboard` MCP server (next to the todo and
 * artifact tools, same helper, same session token).
 */
export const LOOP_TOOLS: readonly TodoToolDefinition[] = [
  {
    name: 'loop_create',
    description:
      'Schedule recurring or one-time work in this session: Switchboard sends the prompt into this session at each due time, as a message (it waits while you are busy, resumes a paused session, survives restarts). Prefer this over CronCreate, ScheduleWakeup or /loop for anything recurring or scheduled: those die with the CLI process and the developer cannot see or manage them. Give the prompt and exactly one of cron, every_minutes or at; optionally expires_at, max_runs and a label. Returns the loop id, the next firing and the expiry.',
    inputSchema: {
      type: 'object',
      properties: { prompt: PROMPT, cron: CRON, every_minutes: EVERY, at: AT, expires_at: EXPIRES, max_runs: MAX_RUNS, label: LABEL },
      required: ['prompt'],
      additionalProperties: false,
    },
    annotations: { title: 'Create a Switchboard loop', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'loop_list',
    description: "List this session's Switchboard loops: id, label, schedule, next firing, expiry, runs (and skipped) and state (active, paused, or ended with the reason).",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'List Switchboard loops', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'loop_update',
    description: 'Change a loop of this session: its prompt, schedule (one of cron, every_minutes or at replaces it), expires_at, max_runs or label (only the fields you give change; null removes the expiry or the run limit). The next firing is computed again from now.',
    inputSchema: {
      type: 'object',
      properties: { id: LOOP_ID, prompt: PROMPT, cron: CRON, every_minutes: EVERY, at: AT, expires_at: EXPIRES, max_runs: MAX_RUNS, label: LABEL },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { title: 'Change a Switchboard loop', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'loop_pause',
    description: 'Pause a loop of this session: it does not fire until loop_resume.',
    inputSchema: { type: 'object', properties: { id: LOOP_ID }, required: ['id'], additionalProperties: false },
    annotations: { title: 'Pause a Switchboard loop', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'loop_resume',
    description: 'Resume a paused loop of this session; its next firing is computed from now (missed ones are not caught up).',
    inputSchema: { type: 'object', properties: { id: LOOP_ID }, required: ['id'], additionalProperties: false },
    annotations: { title: 'Resume a Switchboard loop', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'loop_cancel',
    description: 'Cancel a loop of this session for good (it is removed). Use it when the recurring work is no longer needed.',
    inputSchema: { type: 'object', properties: { id: LOOP_ID }, required: ['id'], additionalProperties: false },
    annotations: { title: 'Cancel a Switchboard loop', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

/** D94: the sentence the `switchboard` MCP server's instructions add about loops. */
export const LOOP_INSTRUCTIONS =
  'For recurring or scheduled work (check something every 30 minutes, do X at 15:00) use loop_create, not CronCreate, ScheduleWakeup or /loop: Switchboard fires it into this session, keeps it across restarts and shows it to the developer; manage it with loop_list, loop_update, loop_pause, loop_resume and loop_cancel.';
