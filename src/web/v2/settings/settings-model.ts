import type { AccountProfile, AccountSettings } from '../../../core/accounts.ts';
import { clock } from '../../../core/accounts.ts';
import { CLI_LABELS, type CliProviderId } from '../../../core/cli-providers.ts';
import { creditsInUse, creditsMoneyText, creditsResetDay } from '../../../core/credits.ts';
import type { V2Status } from '../glossary.ts';

/**
 * D131 · lane R · the pure part of v2 Settings: account cards, the switching
 * rules in plain words, countdowns. DOM-free (unit-tested in
 * `tests/web/v2-settings.test.ts`).
 */

/** The percentages "Switch when an account reaches" offers (the prototype's). */
export const SWITCH_AT_CHOICES: readonly number[] = [90, 95, 98, 100];

/**
 * The one "Switch when an account reaches" value of the account rules (D63
 * thresholds: the 5-hour and the weekly one). `100` = only at the limit error
 * (the thresholds off). Two different thresholds show the lower one.
 */
export function switchAtOf(settings: Pick<AccountSettings, 'thresholds'>): number {
  if (!settings.thresholds.enabled) return 100;
  return Math.min(settings.thresholds.fiveHourPct, settings.thresholds.weeklyPct);
}

/** The settings patch for a "Switch when an account reaches" choice (both windows; 100 = at the limit error only). */
export function switchAtPatch(pct: number): { readonly thresholds: { readonly enabled: boolean; readonly fiveHourPct?: number; readonly weeklyPct?: number } } {
  if (pct >= 100) return { thresholds: { enabled: false } };
  return { thresholds: { enabled: true, fiveHourPct: pct, weeklyPct: pct } };
}

/** The choices shown: the four, plus a stored value that is none of them (set in classic). */
export function switchAtChoices(current: number): readonly number[] {
  return SWITCH_AT_CHOICES.includes(current) ? SWITCH_AT_CHOICES : [...SWITCH_AT_CHOICES, current].sort((a, b) => a - b);
}

/** One usage window of an account card: used % and "left", or unknown. */
export interface UsageWindow {
  readonly label: string;
  /** Used, 0–100; `null` when no reading is live. */
  readonly used: number | null;
  /** "28% left", "Resets 14:05", or "No reading yet". */
  readonly text: string;
}

/** An account card (Settings › Usage & accounts). */
export interface AccountCardView {
  readonly id: string;
  readonly cli: CliProviderId;
  /** `Claude “Work”`, `Codex`. */
  readonly title: string;
  readonly status: V2Status;
  readonly statusLabel: string;
  readonly signedIn: boolean;
  /** The CLI's account line (email · plan), or what is known. */
  readonly who: string | null;
  readonly windows: readonly UsageWindow[];
  /** Paid extra usage, when the account has it on (or runs on it). */
  readonly credits: { readonly onCredits: boolean; readonly text: string } | null;
  /** Out of usage until … */
  readonly outUntil: string | null;
  readonly sessions: number;
}

function live(resetsAt: string | null, now: number): boolean {
  return resetsAt !== null && Date.parse(resetsAt) > now;
}

function windowOf(label: string, pct: number | null, resetsAt: string | null, now: number): UsageWindow {
  if (pct === null || !live(resetsAt, now)) return { label, used: null, text: 'No reading yet' };
  const used = Math.max(0, Math.min(100, Math.round(pct)));
  return { label, used, text: `${100 - used}% left · resets ${clock(resetsAt as string, new Date(now))}` };
}

/** `Claude “Work”` (a named account of a CLI), `Claude Code` (its own login). */
export function accountTitle(profile: Pick<AccountProfile, 'cli' | 'name' | 'builtin'>): string {
  const engine = profile.cli === 'claude' ? 'Claude' : CLI_LABELS[profile.cli];
  if (profile.builtin && (profile.name === 'Default' || profile.name === '')) return CLI_LABELS[profile.cli];
  return `${engine} “${profile.name}”`;
}

/** The card of one account: its status word (icon + word + colour via `V2Status`), windows, paid extra. */
export function accountCard(profile: AccountProfile, inUse: boolean, now: number = Date.now()): AccountCardView {
  const usage = profile.usage;
  const credits = usage?.credits ?? null;
  const onCredits = creditsInUse(credits, now);
  const out = profile.exhausted && Date.parse(profile.exhausted.until) > now ? clock(profile.exhausted.until, new Date(now)) : null;
  let creditsLine: AccountCardView['credits'] = null;
  if (credits && (onCredits || credits.enabled === true)) {
    const money = creditsMoneyText(credits);
    const reset = credits.resetsAt && Date.parse(credits.resetsAt) > now ? `resets ${creditsResetDay(credits.resetsAt)}` : null;
    creditsLine = { onCredits, text: [money ?? 'on', reset].filter(Boolean).join(' · ') };
  }
  const signedIn = profile.signIn === 'signed-in' || (profile.builtin && profile.signIn !== 'signed-out');
  let status: V2Status;
  let statusLabel: string;
  if (!profile.enabled) {
    status = 'paused';
    statusLabel = 'Turned off';
  } else if (!signedIn) {
    status = 'offline';
    statusLabel = 'Signed out';
  } else if (onCredits) {
    status = 'needs';
    statusLabel = 'On paid extra';
  } else if (out) {
    status = 'needs';
    statusLabel = 'Out of usage';
  } else if (inUse) {
    status = 'working';
    statusLabel = 'In use now';
  } else {
    status = 'idle';
    statusLabel = 'Available';
  }
  return {
    id: profile.id,
    cli: profile.cli,
    title: accountTitle(profile),
    status,
    statusLabel,
    signedIn,
    who: profile.account,
    windows: [windowOf('5 hours', usage?.fiveHourPct ?? null, usage?.fiveHourResetsAt ?? null, now), windowOf('Week', usage?.sevenDayPct ?? null, usage?.sevenDayResetsAt ?? null, now)],
    credits: creditsLine,
    outUntil: out,
    sessions: profile.sessions,
  };
}

/**
 * Which account of each engine new agents use now: the first enabled, signed-in
 * one that is not out of usage (the order is the switching order).
 */
export function inUseIds(profiles: readonly AccountProfile[], now: number = Date.now()): ReadonlySet<string> {
  const ids = new Set<string>();
  const byCli = new Map<CliProviderId, AccountProfile[]>();
  for (const profile of [...profiles].sort((a, b) => a.position - b.position)) {
    const list = byCli.get(profile.cli) ?? [];
    list.push(profile);
    byCli.set(profile.cli, list);
  }
  for (const list of byCli.values()) {
    const first = list.find((p) => p.enabled && p.signIn !== 'signed-out' && !(p.exhausted && Date.parse(p.exhausted.until) > now));
    if (first) ids.add(first.id);
  }
  return ids;
}

/** Seconds until an ISO time (never below 0), `null` without one. */
export function secondsLeft(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.ceil(ms / 1000));
}

/** "Offline since 09:12" (or plain "Offline"). */
export function offlineSince(lastSeenAt: string | null, now: number = Date.now()): string {
  return lastSeenAt ? `Offline since ${clock(lastSeenAt, new Date(now))}` : 'Offline';
}
