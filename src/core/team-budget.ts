/**
 * D100 · Team budgets (`docs/team.md` → *Budgets*): a cheap estimate of a member's
 * share of its account's daily usage, from the usage readings Switchboard already
 * stores (D17 / D63: `usage_readings`, each with the session that reported it and
 * the account profile it belongs to).
 *
 * - The account's **daily allowance** is a seventh of its weekly window (100 % / 7
 *   ≈ 14.3 points of the weekly %).
 * - A member's **use today** is the sum of the rises of the account's weekly %
 *   between consecutive readings of that account, counted for the member when the
 *   later reading was reported by the member's session, since local midnight. A fall
 *   (the window reset) counts nothing.
 * - Its **share** is that use as a % of the daily allowance; the budget is exceeded
 *   when the share is above the member's `dailyPct`.
 *
 * Readings come in when a session reports its usage (rate-limit events, the poller),
 * so the estimate is coarse; it is only used to pause a member's Team loops, never
 * to stop a running turn.
 */

/** The reading fields the estimate uses. */
export interface BudgetReading {
  readonly receivedAt: string;
  readonly sessionId: string | null;
  readonly profileId: string;
  readonly sevenDayPct: number | null;
}

/** The weekly-window points that make one day's allowance. */
export const DAILY_ALLOWANCE_POINTS = 100 / 7;

/** Local midnight of `now`. */
export function dayStart(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * The weekly-% points the sessions `sessionIds` used since `since` (see the module
 * comment). `readings` in any order.
 */
export function pointsUsedSince(readings: readonly BudgetReading[], sessionIds: ReadonlySet<string>, since: Date): number {
  const sorted = [...readings].filter((r) => r.sevenDayPct !== null).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  const last = new Map<string, number>();
  let points = 0;
  for (const reading of sorted) {
    const pct = reading.sevenDayPct as number;
    const before = last.get(reading.profileId);
    last.set(reading.profileId, pct);
    if (before === undefined || pct <= before) continue;
    if (Date.parse(reading.receivedAt) < since.getTime()) continue;
    if (reading.sessionId !== null && sessionIds.has(reading.sessionId)) points += pct - before;
  }
  return points;
}

/** Use as a % of the daily allowance (rounded to one decimal). */
export function shareOfDaily(points: number): number {
  return Math.round((points / DAILY_ALLOWANCE_POINTS) * 1000) / 10;
}

/** `true` when a member with budget `dailyPct` (`null` = none) is over it with `usedPct` used today. */
export function overBudget(dailyPct: number | null, usedPct: number | null): boolean {
  return dailyPct !== null && usedPct !== null && usedPct > dailyPct;
}
