import type { AccountProfile, ProfileUsage } from '../../../core/accounts.ts';
import { clock } from '../../../core/accounts.ts';
import type { AccountSignIn } from '../../api/client.ts';
import { type PeerOnlyAccount, machinesLabel } from '../../../core/shared-accounts.ts';
import { creditsInUse, creditsMoneyText, creditsResetDay } from '../../../core/credits.ts';

/**
 * D63 · Settings → Accounts (`docs/accounts.md`): the pure part. Nothing here is
 * invented: what the CLI's status or the readings do not say reads "unknown".
 */

/** The sign-in line: "signed in · me@example.test · max", "signed out", "unknown". */
export function signInText(profile: Pick<AccountProfile, 'signIn' | 'account' | 'builtin'>): string {
  if (profile.signIn === 'signed-in') return `signed in${profile.account ? ` · ${profile.account}` : ''}`;
  if (profile.signIn === 'signed-out') return 'signed out';
  return profile.builtin ? 'your own login' : 'unknown';
}

/** A usage reading's windows that have not reset yet, "5h 62% · week 10%"; `null` when none is known. */
export function usageText(usage: ProfileUsage | null, now: number = Date.now()): string | null {
  if (!usage) return null;
  const live = (resetsAt: string | null): boolean => resetsAt !== null && Date.parse(resetsAt) > now;
  const parts: string[] = [];
  if (usage.fiveHourPct !== null && live(usage.fiveHourResetsAt)) parts.push(`5h ${Math.round(usage.fiveHourPct)}%`);
  if (usage.sevenDayPct !== null && live(usage.sevenDayResetsAt)) parts.push(`week ${Math.round(usage.sevenDayPct)}%`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * D103: an account's credits line: on credits, "On credits until 13:00 · €12.40
 * left of €50 · credits reset 1 Nov"; credits on but not in use, "Credits: €12.40
 * left of €50 · reset 1 Nov" ("credits enabled · balance unknown" without the
 * amounts); `null` when its credits are off or unknown (nothing is shown).
 */
export function creditsText(usage: Pick<ProfileUsage, 'credits'> | null, now: number = Date.now()): { readonly onCredits: boolean; readonly text: string } | null {
  const credits = usage?.credits;
  if (!credits) return null;
  const on = creditsInUse(credits, now);
  if (!on && credits.enabled !== true) return null;
  const money = creditsMoneyText(credits);
  const reset = credits.resetsAt && Date.parse(credits.resetsAt) > now ? `credits reset ${creditsResetDay(credits.resetsAt)}` : null;
  if (on) return { onCredits: true, text: [`On credits until ${clock(credits.until as string, new Date(now))}`, money, reset].filter(Boolean).join(' · ') };
  return { onCredits: false, text: [`Credits: ${money ?? 'enabled'}`, reset].filter(Boolean).join(' · ') };
}

/** "Out of usage until 14:05 (session limit)" while the profile is spent. */
export function exhaustedText(profile: Pick<AccountProfile, 'exhausted'>): string | null {
  const spent = profile.exhausted;
  if (!spent) return null;
  const what = spent.window === 'session' ? 'session limit' : spent.window === 'weekly' ? 'weekly limit' : 'usage limit';
  return `Out of usage until ${clock(spent.until)} (${what}${spent.machine ? `, found on ${spent.machine}` : ''})`;
}

/**
 * D98: the line of an account that is on paired machines too: "Same account on Desk + Studio · its name,
 * order and usage are shared" (`self` = this machine's name); `null` when it is here only.
 */
export function sharedText(profile: Pick<AccountProfile, 'elsewhere'>, self: string | null): string | null {
  const names = (profile.elsewhere ?? []).map((e) => e.machineName);
  if (names.length === 0) return null;
  return `Same account on ${machinesLabel([self ?? 'this machine', ...names])} · its name, order and usage are shared`;
}

/** D98: a reading that came from a paired machine says so: "5h 62% · week 10% (from Studio)". */
export function sharedUsageText(profile: Pick<AccountProfile, 'usage' | 'usageFrom'>, now: number = Date.now()): string | null {
  const text = usageText(profile.usage, now);
  return text && profile.usageFrom ? `${text} (from ${profile.usageFrom})` : text;
}

/** D98: a paired machine's account that is not here: "lab@example.com · pro · on Studio". */
export function peerAccountText(account: Pick<PeerOnlyAccount, 'account' | 'machines'>): string {
  return [account.account, `on ${machinesLabel(account.machines.map((m) => m.name))}`].filter((part): part is string => !!part).join(' · ');
}

/** The new order after moving `id` by `delta` places (clamped); the same list when it cannot move. */
export function movedOrder(ids: readonly string[], id: string, delta: number): string[] {
  const index = ids.indexOf(id);
  if (index < 0) return [...ids];
  const target = Math.max(0, Math.min(ids.length - 1, index + delta));
  if (target === index) return [...ids];
  const out = [...ids];
  out.splice(index, 1);
  out.splice(target, 0, id);
  return out;
}

/** The order after dropping `id` where `before` is (null = last). */
export function droppedOrder(ids: readonly string[], id: string, before: string | null): string[] {
  const without = ids.filter((x) => x !== id);
  const at = before === null ? without.length : without.indexOf(before);
  without.splice(at < 0 ? without.length : at, 0, id);
  return without;
}

/** What the sign-in panel says for a state. */
export function signInStatusText(state: AccountSignIn): string {
  switch (state.state) {
    case 'starting':
      return 'Starting the sign-in…';
    case 'waiting':
      return state.url ? 'Finish the sign-in in the tab that opened. This page notices when it is done.' : 'Waiting for the CLI to print its sign-in page…';
    case 'done':
      return 'Signed in.';
    case 'cancelled':
      return 'Sign-in cancelled.';
    case 'timeout':
      return 'The sign-in was not finished in 5 minutes.';
    case 'failed':
      return 'The sign-in did not finish.';
  }
}

/** The "Copy terminal command" fallback also names what to do after. */
export const TERMINAL_HINT = 'Run it in a terminal, finish the sign-in there, then press Check.';
