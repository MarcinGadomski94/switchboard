/**
 * Scheduled runs (M7.1, `docs/schedules.md`): names shared by the server (the
 * session a run starts) and the New-session modal's Schedule section (the
 * worktree folders its summary shows). Pure.
 */

/** Longest session name (the contract's kebab-case rule, `sessions/validate.ts`). */
const NAME_LIMIT = 64;

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * The session name of a run: `<schedule>-<MMDD>-<HHMM>` in local time, plus
 * `-<n>` from `attempt` 2 on (when the name is taken); the schedule's part is cut
 * so the whole stays within 64 characters and kebab-case.
 */
export function runSessionName(scheduleName: string, at: Date, attempt = 1): string {
  const stamp = `${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
  const suffix = attempt > 1 ? `-${attempt}` : '';
  const room = NAME_LIMIT - stamp.length - suffix.length - 1;
  const base = scheduleName.slice(0, room).replace(/-+$/, '') || 'schedule';
  return `${base}-${stamp}${suffix}`;
}
