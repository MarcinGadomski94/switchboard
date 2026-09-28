/**
 * A readable label for a 5-field cron expression, in the prototype's wording
 * (Schedules: `02:00 daily`, `every 4h`, `08:30 weekdays`, `Mon 07:00`). Only
 * these shapes are rewritten; anything else is returned as written, so a label is
 * never guessed. Used by Settings → Schedules (M8.2); M7.1's readable preview may
 * extend it.
 */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function clock(hour: string, minute: string): string | null {
  if (!/^\d{1,2}$/.test(hour) || !/^\d{1,2}$/.test(minute)) return null;
  const h = Number(hour);
  const m = Number(minute);
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** `0 2 * * *` → `02:00 daily`; `0 *\/4 * * *` → `every 4h`; `30 8 * * 1-5` → `08:30 weekdays`; `0 7 * * 1` → `Mon 07:00`; else the expression. */
export function cronLabel(expression: string): string {
  const text = expression.trim();
  const fields = text.split(/\s+/);
  if (fields.length !== 5) return text;
  const [minute = '', hour = '', dom = '', month = '', dow = ''] = fields;
  if (dom !== '*' || month !== '*') return text;
  const every = /^\*\/(\d+)$/.exec(hour);
  if (every && minute === '0' && dow === '*') return `every ${Number(every[1])}h`;
  const at = clock(hour, minute);
  if (!at) return text;
  if (dow === '*') return `${at} daily`;
  if (dow === '1-5') return `${at} weekdays`;
  if (/^[0-7]$/.test(dow)) return `${DAYS[Number(dow) % 7]} ${at}`;
  return text;
}
