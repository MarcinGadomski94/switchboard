import { describe, expect, it } from 'vitest';
import { nextCronMatch, parseCron } from '../../src/core/derive/cron-next.ts';

/** A local time (the cron's timezone), as `YYYY-MM-DD HH:MM`. */
function local(date: Date | null): string | null {
  if (!date) return null;
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

// Sunday 2026-09-27 14:03:30 local.
const AT = new Date(2026, 8, 27, 14, 3, 30);

describe('cron-next · parseCron', () => {
  it('accepts the 5-field forms CronCreate uses and refuses anything else', () => {
    for (const ok of ['*/5 * * * *', '0 9 * * 1-5', '7 * * * *', '30 14 28 2 *', '0 0 1,15 * *', '0 7 * * MON', '0 0 1 JAN *', '0 12 * * 7']) {
      expect(parseCron(ok), ok).not.toBeNull();
    }
    for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '*/0 * * * *', '5-1 * * * *', 'a * * * *']) {
      expect(parseCron(bad), bad).toBeNull();
    }
  });
});

describe('cron-next · nextCronMatch (local time, strictly after)', () => {
  it('steps, hourly on an off minute, daily, weekdays, one-shot dates', () => {
    expect(local(nextCronMatch('*/5 * * * *', AT))).toBe('2026-09-27 14:05');
    expect(local(nextCronMatch('7 * * * *', AT))).toBe('2026-09-27 14:07');
    expect(local(nextCronMatch('3 * * * *', AT))).toBe('2026-09-27 15:03');
    expect(local(nextCronMatch('0 2 * * *', AT))).toBe('2026-09-28 02:00');
    // Sunday → the next weekday is Monday.
    expect(local(nextCronMatch('30 8 * * 1-5', AT))).toBe('2026-09-28 08:30');
    expect(local(nextCronMatch('0 7 * * MON', AT))).toBe('2026-09-28 07:00');
    expect(local(nextCronMatch('30 14 28 2 *', AT))).toBe('2027-02-28 14:30');
    expect(local(nextCronMatch('0 0 1 JAN *', AT))).toBe('2027-01-01 00:00');
  });

  it('day of month and day of week: either when both are restricted, both when one starts with *', () => {
    // The 1st or any Monday: Monday 09-28 comes first.
    expect(local(nextCronMatch('0 9 1 * 1', AT))).toBe('2026-09-28 09:00');
    // Every other day of the month AND Sunday (Vixie): Sunday 09-27 is odd → today 14:05? no, 09:00 has passed → next odd Sunday.
    expect(local(nextCronMatch('0 9 */2 * 0', AT))).toBe('2026-10-11 09:00');
    // Sunday as 7.
    expect(local(nextCronMatch('0 12 * * 7', AT))).toBe('2026-10-04 12:00');
  });

  it('an exact match minute is not "next"; an impossible date or a bad expression gives null', () => {
    expect(local(nextCronMatch('3 14 * * *', new Date(2026, 8, 27, 14, 3, 0)))).toBe('2026-09-28 14:03');
    expect(nextCronMatch('0 0 31 2 *', AT)).toBeNull();
    expect(nextCronMatch('nope', AT)).toBeNull();
    expect(nextCronMatch('* * * * *', new Date(Number.NaN))).toBeNull();
  });
});
