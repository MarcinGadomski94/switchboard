import { describe, expect, it } from 'vitest';
import { type CronSchedule, cronLabel, nextRun, nextRuns, parseCron } from '../../src/core/cron.ts';
import { runSessionName } from '../../src/core/schedules.ts';

/** Parses or fails the test. */
function cron(expression: string): CronSchedule {
  const parsed = parseCron(expression);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.cron;
}

/** A local time (the scheduler runs on the machine's clock). */
const local = (month: number, day: number, hour = 0, minute = 0, second = 0): Date => new Date(2026, month - 1, day, hour, minute, second);

/** `YYYY-MM-DD HH:MM` in local time. */
function show(date: Date | null): string | null {
  if (!date) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

describe('parseCron (M7.1)', () => {
  it('parses the five fields: lists, ranges, steps, names, 7 = Sunday', () => {
    const c = cron('0,30 9-17/4 1,15 JAN-mar mon-fri');
    expect([...c.minutes]).toEqual([0, 30]);
    expect([...c.hours]).toEqual([9, 13, 17]);
    expect([...c.days]).toEqual([1, 15]);
    expect([...c.months]).toEqual([1, 2, 3]);
    expect([...c.weekdays]).toEqual([1, 2, 3, 4, 5]);
    expect(c.expression).toBe('0,30 9-17/4 1,15 jan-mar mon-fri');
    expect([...cron('0 0 * * 7').weekdays]).toEqual([0]);
    expect([...cron('0 0 * * 5-7').weekdays].sort()).toEqual([0, 5, 6]);
    expect([...cron('5/20 * * * *').minutes]).toEqual([5, 25, 45]);
    expect([...cron('*/15 * * * *').minutes]).toEqual([0, 15, 30, 45]);
    expect(cron('  0   2 *  * *  ').expression).toBe('0 2 * * *');
  });

  it('expands the macros', () => {
    expect(cron('@daily').expression).toBe('0 0 * * *');
    expect(cron('@Hourly').expression).toBe('0 * * * *');
    expect(cron('@weekly').expression).toBe('0 0 * * 0');
    expect(cron('@monthly').expression).toBe('0 0 1 * *');
    expect(cron('@yearly').expression).toBe('0 0 1 1 *');
  });

  it('refuses what is not a cron expression, with a sentence saying why', () => {
    const cases: Array<[string, RegExp]> = [
      ['', /enter a cron expression/],
      ['0 2 * *', /has 4/],
      ['0 2 * * * *', /has 6/],
      ['60 * * * *', /not a valid minute/],
      ['0 24 * * *', /not a valid hour/],
      ['0 0 0 * *', /not a valid day of month/],
      ['0 0 * 13 *', /not a valid month/],
      ['0 0 * * 8', /not a valid day of week/],
      ['0 0 * * funday', /not a valid day of week/],
      ['5-1 * * * *', /runs backwards/],
      ['*/0 * * * *', /step/],
      ['1,,2 * * * *', /empty list item/],
      ['@reboot', /not a supported macro/],
      ['a b c d e', /not a valid minute/],
    ];
    for (const [expression, message] of cases) {
      const parsed = parseCron(expression);
      expect(parsed.ok, expression).toBe(false);
      if (!parsed.ok) expect(parsed.error, expression).toMatch(message);
    }
  });
});

describe('nextRun / nextRuns (local time)', () => {
  it('finds the first matching minute strictly after the given time', () => {
    expect(show(nextRun(cron('0 2 * * *'), local(9, 28, 1, 59, 30)))).toBe('2026-09-28 02:00');
    expect(show(nextRun(cron('0 2 * * *'), local(9, 28, 2, 0, 0)))).toBe('2026-09-29 02:00');
    expect(show(nextRun(cron('0 2 * * *'), local(9, 28, 2, 0, 1)))).toBe('2026-09-29 02:00');
    expect(show(nextRun(cron('* * * * *'), local(9, 28, 10, 15, 59)))).toBe('2026-09-28 10:16');
    expect(show(nextRun(cron('0 */4 * * *'), local(9, 28, 10, 15)))).toBe('2026-09-28 12:00');
    // 2026-09-28 is a Monday.
    expect(show(nextRun(cron('30 8 * * 1-5'), local(9, 25, 9, 0)))).toBe('2026-09-28 08:30');
    expect(show(nextRun(cron('0 7 * * 1'), local(9, 28, 7, 0)))).toBe('2026-10-05 07:00');
    expect(show(nextRun(cron('0 0 31 * *'), local(9, 28)))).toBe('2026-10-31 00:00');
    expect(show(nextRun(cron('0 0 29 2 *'), local(9, 28)))).toBe('2028-02-29 00:00');
  });

  it('day of month and day of week: either matches when both are restricted, both must when one starts with *', () => {
    // 1st of the month OR Mondays (Vixie).
    expect(nextRuns(cron('0 9 1 * 1'), local(9, 28, 10), 3).map(show)).toEqual(['2026-10-01 09:00', '2026-10-05 09:00', '2026-10-12 09:00']);
    // Every other day of the month that is also a weekday (the */2 counts as unrestricted).
    expect(nextRuns(cron('0 9 */2 * 1-5'), local(9, 28, 10), 3).map(show)).toEqual(['2026-09-29 09:00', '2026-10-01 09:00', '2026-10-05 09:00']);
  });

  it('returns fewer runs when the expression never matches', () => {
    expect(nextRun(cron('0 0 30 2 *'), local(9, 28))).toBeNull();
    expect(nextRuns(cron('0 0 30 2 *'), local(9, 28), 3)).toEqual([]);
  });

  it('lists the next runs in order', () => {
    expect(nextRuns(cron('0 2 * * *'), local(9, 28, 12), 3).map(show)).toEqual(['2026-09-29 02:00', '2026-09-30 02:00', '2026-10-01 02:00']);
  });
});

describe('cronLabel (the readable preview)', () => {
  it('reads the prototype schedules as the prototype shows them', () => {
    expect(cronLabel('0 2 * * *')).toBe('02:00 daily');
    expect(cronLabel('0 */4 * * *')).toBe('every 4h');
    expect(cronLabel('30 8 * * 1-5')).toBe('08:30 weekdays');
    expect(cronLabel('0 7 * * 1')).toBe('Mon 07:00');
  });

  it('describes the common shapes', () => {
    expect(cronLabel('* * * * *')).toBe('every minute');
    expect(cronLabel('*/15 * * * *')).toBe('every 15 min');
    expect(cronLabel('0 * * * *')).toBe('hourly');
    expect(cronLabel('20 * * * *')).toBe('hourly at :20');
    expect(cronLabel('15 */6 * * *')).toBe('every 6h at :15');
    expect(cronLabel('0 9,17 * * *')).toBe('09:00, 17:00 daily');
    expect(cronLabel('0 10 * * 0,6')).toBe('10:00 weekends');
    expect(cronLabel('0 7 * * fri,mon,wed')).toBe('Mon, Wed, Fri 07:00');
    expect(cronLabel('0 7 * * 0')).toBe('Sun 07:00');
    expect(cronLabel('0 6 1 * *')).toBe('06:00 on the 1st monthly');
    expect(cronLabel('0 6 22 * *')).toBe('06:00 on the 22nd monthly');
    expect(cronLabel('@daily')).toBe('00:00 daily');
  });

  it('shows the expression itself for shapes it does not describe, and for invalid input', () => {
    expect(cronLabel('0 0 1 1 *')).toBe('0 0 1 1 *');
    expect(cronLabel('0 9 1 * 1')).toBe('0 9 1 * 1');
    expect(cronLabel('*/5 9-17 * * 1-5')).toBe('*/5 9-17 * * 1-5');
    expect(cronLabel('0 9-17 * * *')).toBe('0 9-17 * * *');
    expect(cronLabel('nonsense')).toBe('nonsense');
  });
});

describe('runSessionName', () => {
  it('names a run <schedule>-<MMDD>-<HHMM> (local), -<n> for a taken name, within 64 characters', () => {
    expect(runSessionName('nightly-build-verify', local(9, 29, 2, 0))).toBe('nightly-build-verify-0929-0200');
    expect(runSessionName('nightly-build-verify', local(9, 29, 2, 0), 2)).toBe('nightly-build-verify-0929-0200-2');
    const long = `${'a'.repeat(30)}-${'b'.repeat(30)}`;
    const name = runSessionName(long, local(12, 1, 23, 59), 12);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(name.endsWith('-1201-2359-12')).toBe(true);
  });
});
