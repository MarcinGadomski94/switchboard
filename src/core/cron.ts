/**
 * Cron expressions of the scheduler (M7.1, D8, `docs/schedules.md`): the classic
 * five fields `minute hour day-of-month month day-of-week`, evaluated in the
 * machine's local time. Pure: no timers, no I/O. Used by the server (when a
 * schedule fires, `nextRunAt`) and by the New-session modal's Schedule section
 * (the readable preview and the next run times while the developer types).
 *
 * Supported: `*`, numbers, `a-b` ranges, `/step` on `*`, a range or a start
 * (`5/15` = 5-59/15), comma lists, month names `jan`–`dec`, weekday names
 * `sun`–`sat` (0 and 7 are Sunday), and the macros `@yearly` / `@annually`,
 * `@monthly`, `@weekly`, `@daily` / `@midnight`, `@hourly`. Day of month and day
 * of week follow the Vixie cron rule: when both are restricted (neither starts
 * with `*`), a day matches if either matches; otherwise both must match.
 */

/** A parsed cron expression. */
export interface CronSchedule {
  /** The five fields joined by single spaces (a macro is expanded). */
  readonly expression: string;
  /** The five fields as written (lower case, macro expanded). */
  readonly fields: readonly [minute: string, hour: string, day: string, month: string, weekday: string];
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  /** Days of the month, 1–31. */
  readonly days: ReadonlySet<number>;
  /** Months, 1–12. */
  readonly months: ReadonlySet<number>;
  /** Days of the week, 0 (Sunday) – 6. */
  readonly weekdays: ReadonlySet<number>;
  /** The day-of-month field starts with `*` (unrestricted for the Vixie rule). */
  readonly dayStar: boolean;
  /** The day-of-week field starts with `*`. */
  readonly weekdayStar: boolean;
}

/** Result of {@link parseCron}: the schedule, or a sentence saying what is wrong. */
export type CronParse = { readonly ok: true; readonly cron: CronSchedule } | { readonly ok: false; readonly error: string };

const MACROS: Readonly<Record<string, string>> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const;
const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** Weekday labels of the readable preview, 0 = Sunday. */
export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
/** Month labels, 0 = January. */
export const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

interface FieldSpec {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
  /** Offset of `names[0]` (months start at 1). */
  readonly nameBase?: number;
}

const FIELDS: readonly FieldSpec[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day of month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  // 7 is Sunday too (folded into 0 below).
  { label: 'day of week', min: 0, max: 7, names: WEEKDAY_NAMES, nameBase: 0 },
];

function parseValue(text: string, spec: FieldSpec): number | null {
  if (/^\d+$/.test(text)) {
    const value = Number(text);
    return value >= spec.min && value <= spec.max ? value : null;
  }
  const index = spec.names?.indexOf(text as never) ?? -1;
  return index === -1 ? null : index + (spec.nameBase ?? 0);
}

/** One field's values, or an error sentence. */
function parseField(raw: string, spec: FieldSpec): { readonly values: Set<number> } | { readonly error: string } {
  const values = new Set<number>();
  const bad = (part: string): { error: string } => ({ error: `"${part}" is not a valid ${spec.label} (${spec.min}–${spec.max === 7 ? 6 : spec.max}${spec.names ? ' or a name' : ''})` });
  for (const part of raw.split(',')) {
    if (part === '') return { error: `the ${spec.label} field has an empty list item` };
    const [range = '', stepText, extra] = part.split('/');
    if (extra !== undefined) return bad(part);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) return { error: `"${part}": the step must be a whole number of at least 1` };
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (range === '*') {
      from = spec.min;
      to = spec.max === 7 ? 6 : spec.max;
    } else if (range.includes('-')) {
      const [a = '', b = '', more] = range.split('-');
      if (more !== undefined) return bad(part);
      const start = parseValue(a, spec);
      const end = parseValue(b, spec);
      if (start === null || end === null) return bad(part);
      if (start > end) return { error: `"${part}": the range runs backwards` };
      from = start;
      to = end;
    } else {
      const value = parseValue(range, spec);
      if (value === null) return bad(part);
      from = value;
      // `5/15` = from 5 to the end, every 15 (Vixie).
      to = stepText === undefined ? value : spec.max === 7 ? 6 : spec.max;
    }
    for (let value = from; value <= to; value += step) values.add(spec.max === 7 && value === 7 ? 0 : value);
  }
  return { values };
}

/**
 * Parses a cron expression (five fields or a macro, case-insensitive, any
 * whitespace between fields).
 */
export function parseCron(expression: string): CronParse {
  const trimmed = expression.trim().toLowerCase();
  if (trimmed === '') return { ok: false, error: 'enter a cron expression, e.g. 0 2 * * * (02:00 daily)' };
  const expanded = MACROS[trimmed] ?? (trimmed.startsWith('@') ? null : trimmed);
  if (expanded === null) return { ok: false, error: `"${trimmed}" is not a supported macro (@hourly, @daily, @weekly, @monthly, @yearly)` };
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) return { ok: false, error: `a cron expression has 5 fields (minute hour day month weekday), this one has ${parts.length}` };
  const sets: Set<number>[] = [];
  for (const [index, spec] of FIELDS.entries()) {
    const parsed = parseField(parts[index] ?? '', spec);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    sets.push(parsed.values);
  }
  const [minute = '', hour = '', day = '', month = '', weekday = ''] = parts;
  const [minutes, hours, days, months, weekdays] = sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  return {
    ok: true,
    cron: {
      expression: parts.join(' '),
      fields: [minute, hour, day, month, weekday],
      minutes,
      hours,
      days,
      months,
      weekdays,
      dayStar: day.startsWith('*'),
      weekdayStar: weekday.startsWith('*'),
    },
  };
}

/** `true` if the local calendar day of `date` matches the day-of-month / day-of-week fields (Vixie rule). */
function dayMatches(cron: CronSchedule, date: Date): boolean {
  const byDay = cron.days.has(date.getDate());
  const byWeekday = cron.weekdays.has(date.getDay());
  if (cron.dayStar || cron.weekdayStar) return byDay && byWeekday;
  return byDay || byWeekday;
}

/** How far ahead {@link nextRun} looks before it gives up (covers leap days). */
const HORIZON_YEARS = 8;

/**
 * The first local minute strictly after `after` that matches, or `null` when
 * none comes within {@link HORIZON_YEARS} (e.g. `0 0 30 2 *`). A local time the
 * DST switch skips is not run that day; a repeated one runs once.
 */
export function nextRun(cron: CronSchedule, after: Date): Date | null {
  let date = new Date(after.getTime());
  date.setSeconds(0, 0);
  date = new Date(date.getTime() + 60_000);
  const limit = new Date(after.getFullYear() + HORIZON_YEARS, after.getMonth(), after.getDate()).getTime();
  const forward = (next: Date): Date => (next.getTime() > date.getTime() ? next : new Date(date.getTime() + 60_000));
  while (date.getTime() <= limit) {
    if (!cron.months.has(date.getMonth() + 1)) {
      date = forward(new Date(date.getFullYear(), date.getMonth() + 1, 1, 0, 0, 0, 0));
    } else if (!dayMatches(cron, date)) {
      date = forward(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0));
    } else if (!cron.hours.has(date.getHours())) {
      date = forward(new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours() + 1, 0, 0, 0));
    } else if (!cron.minutes.has(date.getMinutes())) {
      date = new Date(date.getTime() + 60_000);
    } else {
      return date;
    }
  }
  return null;
}

/** The next `count` run times strictly after `after` (fewer when the expression runs out). */
export function nextRuns(cron: CronSchedule, after: Date, count: number): Date[] {
  const runs: Date[] = [];
  let from = after;
  while (runs.length < count) {
    const next = nextRun(cron, from);
    if (!next) break;
    runs.push(next);
    from = next;
  }
  return runs;
}

const pad = (value: number): string => String(value).padStart(2, '0');

function single(field: string): number | null {
  return /^\d+$/.test(field) ? Number(field) : null;
}

function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  return `${day}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] ?? 'th'}`;
}

/** `*` (1) or a step over the whole range, `*` + `/n` (n); `null` for anything else. */
function everyStep(field: string): number | null {
  if (field === '*') return 1;
  const match = /^\*\/(\d+)$/.exec(field);
  return match ? Number(match[1]) : null;
}

function sameSet(set: ReadonlySet<number>, values: readonly number[]): boolean {
  return set.size === values.length && values.every((value) => set.has(value));
}

/** The weekday part of a preview: `weekdays`, `weekends`, or `Mon, Wed`. */
function weekdayText(cron: CronSchedule): { readonly text: string; readonly before: boolean } | null {
  if (cron.fields[4] === '*') return { text: 'daily', before: false };
  if (sameSet(cron.weekdays, [1, 2, 3, 4, 5])) return { text: 'weekdays', before: false };
  if (sameSet(cron.weekdays, [0, 6])) return { text: 'weekends', before: false };
  if (!/^[a-z0-9,]+$/.test(cron.fields[4])) return null;
  // Monday first, Sunday last.
  const days = [...cron.weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  return { text: days.map((day) => WEEKDAY_LABELS[day]).join(', '), before: true };
}

/**
 * A short readable preview of an expression (prototype copy: `02:00 daily`,
 * `every 4h`, `08:30 weekdays`, `Mon 07:00`). Shapes it does not describe, and
 * invalid expressions, come back as the expression itself, so the preview never
 * says something the expression does not do.
 */
export function cronLabel(input: string | CronSchedule): string {
  let cron: CronSchedule;
  if (typeof input === 'string') {
    const parsed = parseCron(input);
    if (!parsed.ok) return input.trim();
    cron = parsed.cron;
  } else {
    cron = input;
  }
  const [minute, hour, day, month] = cron.fields;
  if (month !== '*') return cron.expression;
  const m = single(minute);
  const hourStep = everyStep(hour);
  const minuteStep = everyStep(minute);

  if (day === '*' && cron.fields[4] === '*') {
    if (minuteStep === 1 && hourStep === 1) return 'every minute';
    if (minuteStep !== null && hourStep === 1) return `every ${minuteStep} min`;
    if (m !== null && hourStep === 1) return m === 0 ? 'hourly' : `hourly at :${pad(m)}`;
    if (m !== null && hourStep !== null) return m === 0 ? `every ${hourStep}h` : `every ${hourStep}h at :${pad(m)}`;
  }

  // Fixed times of day: one minute, one or more listed hours.
  if (m === null || !/^\d+(,\d+)*$/.test(hour)) return cron.expression;
  const times = [...cron.hours].sort((a, b) => a - b).map((h) => `${pad(h)}:${pad(m)}`).join(', ');
  const dayOfMonth = single(day);
  if (day !== '*') {
    if (dayOfMonth === null || cron.fields[4] !== '*') return cron.expression;
    return `${times} on the ${ordinal(dayOfMonth)} monthly`;
  }
  const weekdays = weekdayText(cron);
  if (!weekdays) return cron.expression;
  return weekdays.before ? `${weekdays.text} ${times}` : `${times} ${weekdays.text}`;
}
