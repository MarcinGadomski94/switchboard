/**
 * Standard 5-field cron (`minute hour day-of-month month day-of-week`, local
 * time), as `CronCreate` takes it: the next firing of a `/loop` cron job for the
 * loop cards (M7.2, D9, `docs/derivations.md` → *Loop cards*).
 *
 * Supported per field: `*`, numbers, `a-b` ranges, `/n` steps (`*` or a range or
 * a start), comma lists, and the three-letter month (`JAN`…) and weekday
 * (`SUN`…) names. Day of week 0 and 7 are Sunday. When both day fields are
 * restricted (neither starts with `*`) a day matches either of them; otherwise it
 * must match both (Vixie cron's rule). The CLI's
 * firing jitter (recurring jobs up to 10 % of the period late) is not modelled:
 * the result is the schedule's own next match.
 */

/** A parsed cron expression. */
export interface CronSpec {
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number>;
  /** Day of month starts with `*`: both day lists must match (Vixie cron's rule), else either may. */
  readonly anyDay: boolean;
  /** Day of week starts with `*`: both day lists must match, else either may. */
  readonly anyWeekday: boolean;
}

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** How far ahead {@link nextCronMatch} looks before giving up (e.g. `0 0 31 2 *` never matches). */
const SEARCH_DAYS = 366 * 5;

function parseValue(text: string, names: readonly string[] | null, offset: number): number | null {
  if (/^\d+$/.test(text)) return Number(text);
  if (names) {
    const at = names.indexOf(text.toUpperCase());
    if (at >= 0) return at + offset;
  }
  return null;
}

/** One field as the sorted list of values it allows, or `null` when it is not valid. */
function parseField(field: string, min: number, max: number, names: readonly string[] | null, nameOffset: number): number[] | null {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const match = /^([^/]+)(?:\/(\d+))?$/.exec(part);
    if (!match) return null;
    const [, range = '', stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;
    let from: number;
    let to: number;
    if (range === '*') {
      from = min;
      to = max;
    } else if (range.includes('-')) {
      const [a = '', b = ''] = range.split('-');
      const start = parseValue(a, names, nameOffset);
      const end = parseValue(b, names, nameOffset);
      if (start === null || end === null) return null;
      from = start;
      to = end;
    } else {
      const single = parseValue(range, names, nameOffset);
      if (single === null) return null;
      from = single;
      to = stepText === undefined ? single : max;
    }
    if (from < min || to > max || from > to) return null;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

/** Parses a 5-field cron expression; `null` when it is not one. */
export function parseCron(expression: string): CronSpec | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute = '', hour = '', day = '', month = '', weekday = ''] = fields;
  const minutes = parseField(minute, 0, 59, null, 0);
  const hours = parseField(hour, 0, 23, null, 0);
  const days = parseField(day, 1, 31, null, 0);
  const months = parseField(month, 1, 12, MONTH_NAMES, 1);
  const weekdays = parseField(weekday, 0, 7, WEEKDAY_NAMES, 0);
  if (!minutes || !hours || !days || !months || !weekdays) return null;
  return {
    minutes,
    hours,
    days: new Set(days),
    months: new Set(months),
    weekdays: new Set(weekdays.map((d) => (d === 7 ? 0 : d))),
    anyDay: day.startsWith('*'),
    anyWeekday: weekday.startsWith('*'),
  };
}

function dayMatches(spec: CronSpec, date: Date): boolean {
  if (!spec.months.has(date.getMonth() + 1)) return false;
  const byDay = spec.days.has(date.getDate());
  const byWeekday = spec.weekdays.has(date.getDay());
  // Vixie cron: a `*`-field keeps both lists in force (AND); two restricted fields match either (OR).
  if (spec.anyDay || spec.anyWeekday) return byDay && byWeekday;
  return byDay || byWeekday;
}

/**
 * The first minute strictly after `after` (local time) that the cron expression
 * matches, or `null` when the expression is not valid or matches nothing in the
 * next five years.
 */
export function nextCronMatch(expression: string | CronSpec, after: Date): Date | null {
  const spec = typeof expression === 'string' ? parseCron(expression) : expression;
  if (!spec || Number.isNaN(after.getTime())) return null;
  const start = new Date(after.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  for (let offset = 0; offset <= SEARCH_DAYS; offset++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
    if (!dayMatches(spec, day)) continue;
    for (const hour of spec.hours) {
      for (const minute of spec.minutes) {
        const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
        if (candidate.getTime() >= start.getTime()) return candidate;
      }
    }
  }
  return null;
}
