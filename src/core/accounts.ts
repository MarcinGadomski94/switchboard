/**
 * D63 (`docs/accounts.md`): CLI accounts and automatic switching on usage limits.
 * Pure, shared by the server (the switcher, the routes) and the UI (Settings →
 * Accounts): the profile and settings shapes, the limit-error reader and the
 * switch decision. No I/O; the clock is passed in.
 */
import { type CliProviderId, isCliProviderId } from './cli-providers.ts';

/** The id of a CLI's built-in "Default" profile (the developer's own login, no config-dir override). */
export function defaultProfileId(cli: CliProviderId): string {
  return `default-${cli}`;
}

/** `true` for a built-in Default profile id. */
export function isDefaultProfileId(id: string): boolean {
  return id === 'default-claude' || id === 'default-codex' || id === 'default-opencode';
}

/** Sign-in state of a profile as its CLI's own status command reports it (`null` = could not tell). */
export type ProfileSignIn = 'signed-in' | 'signed-out' | 'unknown';

/** The usage windows of a profile's latest reading (Claude Code readings; Codex's windows when known). */
export interface ProfileUsage {
  readonly fiveHourPct: number | null;
  readonly fiveHourResetsAt: string | null;
  readonly sevenDayPct: number | null;
  readonly sevenDayResetsAt: string | null;
  /** When the reading was taken (ISO). */
  readonly receivedAt: string | null;
}

/** Why a profile is out of allowance (until `until`). */
export interface ProfileExhausted {
  readonly until: string;
  readonly window: LimitWindow;
  readonly text: string | null;
}

/** One account profile as the API returns it (`GET /api/accounts`). */
export interface AccountProfile {
  readonly id: string;
  readonly cli: CliProviderId;
  readonly name: string;
  /** The profile's config / data folder; `null` for the built-in Default. */
  readonly dir: string | null;
  readonly builtin: boolean;
  readonly enabled: boolean;
  /** Priority within the CLI, 0 first. */
  readonly position: number;
  /** Uses the Default's settings / instructions / MCP config. */
  readonly shareSettings: boolean;
  readonly signIn: ProfileSignIn;
  /** The account the CLI says is signed in (email, plan), when its status reports it. */
  readonly account: string | null;
  readonly usage: ProfileUsage | null;
  readonly exhausted: ProfileExhausted | null;
  /** The terminal command that signs the profile in by hand (the "Copy terminal command" fallback). */
  readonly signInCommand: string;
  /** Sessions currently on it. */
  readonly sessions: number;
}

/** Where the settings live (`settings` table, one JSON value). */
export const ACCOUNT_SETTINGS_KEY = 'accounts.settings';

/** What happens when every profile of a CLI is spent. */
export type ExhaustedAction = 'notify' | 'switch-cli';

/** Which profile a new session starts on. */
export type NewSessionRule = 'first-with-allowance' | 'fixed';

/** After a reset: go back to the first profile, or stay where the session is. */
export type AfterReset = 'back-to-first' | 'stay';

/** Settings → Accounts → rules (`GET/PUT /api/accounts/settings`). */
export interface AccountSettings {
  /** Master toggle. */
  readonly enabled: boolean;
  /** Per-CLI toggles. */
  readonly perCli: Readonly<Record<CliProviderId, boolean>>;
  /** Switch earlier than the limit error, at these percentages (separate for the 5-hour and the weekly window). */
  readonly thresholds: { readonly enabled: boolean; readonly fiveHourPct: number; readonly weeklyPct: number };
  readonly afterReset: AfterReset;
  readonly newSessions: { readonly rule: NewSessionRule; readonly fixed: Readonly<Partial<Record<CliProviderId, string>>> };
  readonly exhausted: { readonly action: ExhaustedAction; readonly cli: CliProviderId | null };
  /** No threshold / reset switch of a session within this many seconds of its last switch. */
  readonly cooldownSeconds: number;
}

export const DEFAULT_ACCOUNT_SETTINGS: AccountSettings = {
  enabled: true,
  perCli: { claude: true, codex: true, opencode: true },
  thresholds: { enabled: true, fiveHourPct: 98, weeklyPct: 98 },
  afterReset: 'stay',
  newSessions: { rule: 'first-with-allowance', fixed: {} },
  exhausted: { action: 'notify', cli: null },
  cooldownSeconds: 120,
};

function pct(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(100, Math.round(value))) : fallback;
}

/** A stored value read defensively over the defaults. */
export function readAccountSettings(value: unknown): AccountSettings {
  const d = DEFAULT_ACCOUNT_SETTINGS;
  const o = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const perCli = rec(o['perCli']);
  const thresholds = rec(o['thresholds']);
  const newSessions = rec(o['newSessions']);
  const exhausted = rec(o['exhausted']);
  const fixedRaw = rec(newSessions['fixed']);
  const fixed: Partial<Record<CliProviderId, string>> = {};
  for (const [cli, id] of Object.entries(fixedRaw)) if (isCliProviderId(cli) && typeof id === 'string' && id !== '') fixed[cli] = id;
  const cooldown = o['cooldownSeconds'];
  return {
    enabled: typeof o['enabled'] === 'boolean' ? o['enabled'] : d.enabled,
    perCli: {
      claude: typeof perCli['claude'] === 'boolean' ? perCli['claude'] : d.perCli.claude,
      codex: typeof perCli['codex'] === 'boolean' ? perCli['codex'] : d.perCli.codex,
      opencode: typeof perCli['opencode'] === 'boolean' ? perCli['opencode'] : d.perCli.opencode,
    },
    thresholds: {
      enabled: typeof thresholds['enabled'] === 'boolean' ? thresholds['enabled'] : d.thresholds.enabled,
      fiveHourPct: pct(thresholds['fiveHourPct'], d.thresholds.fiveHourPct),
      weeklyPct: pct(thresholds['weeklyPct'], d.thresholds.weeklyPct),
    },
    afterReset: o['afterReset'] === 'back-to-first' || o['afterReset'] === 'stay' ? o['afterReset'] : d.afterReset,
    newSessions: { rule: newSessions['rule'] === 'fixed' || newSessions['rule'] === 'first-with-allowance' ? newSessions['rule'] : d.newSessions.rule, fixed },
    exhausted: {
      action: exhausted['action'] === 'switch-cli' || exhausted['action'] === 'notify' ? exhausted['action'] : d.exhausted.action,
      cli: isCliProviderId(exhausted['cli']) ? exhausted['cli'] : null,
    },
    cooldownSeconds: typeof cooldown === 'number' && Number.isFinite(cooldown) ? Math.max(0, Math.min(3600, Math.round(cooldown))) : d.cooldownSeconds,
  };
}

// ── limit errors ─────────────────────────────────────────────────────────────

/** Which usage window a limit error is about. */
export type LimitWindow = 'session' | 'weekly' | 'unknown';

/** A usage-limit error read from a CLI's text. */
export interface LimitHit {
  readonly window: LimitWindow;
  /** When the CLI says the limit resets (ISO), `null` when it did not say or it could not be read. */
  readonly resetsAt: string | null;
  /** The CLI's own text (trimmed, one line). */
  readonly text: string;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The reset time in a CLI's limit text ("resets 2pm", "resets 2:05pm (Europe/Oslo)",
 * "resets Oct 5, 2pm", "try again at 3:20 PM", "resets in 3 hours"), as an ISO time
 * after `now`; `null` when there is none. A time of day has no zone in it (or a
 * zone in parentheses that is ignored): it is read in this machine's zone
 * (ASSUMED D63-reset-zone), the next such time after `now`.
 */
export function parseResetTime(text: string, now: Date): string | null {
  const rel = /(?:resets?|try again|retry|available)\s+in\s+(?:(\d+)\s*(?:d|days?))?\s*(?:(\d+)\s*(?:h|hours?|hrs?))?\s*(?:(\d+)\s*(?:m|min|minutes?))?/i.exec(text);
  if (rel && (rel[1] || rel[2] || rel[3])) {
    const ms = (Number(rel[1] ?? 0) * 24 * 60 + Number(rel[2] ?? 0) * 60 + Number(rel[3] ?? 0)) * 60_000;
    if (ms > 0) return new Date(now.getTime() + ms).toISOString();
  }
  const m = /(?:resets?|try again at|until|at)\s+(?:(?:on\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (!m || (m[5] === undefined && m[4] === undefined && m[1] === undefined)) return null;
  let hour = Number(m[3]);
  const minute = Number(m[4] ?? 0);
  const meridiem = m[5]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (m[1] !== undefined) {
    at.setMonth(MONTHS.indexOf(m[1].toLowerCase()), Number(m[2]));
    if (at.getTime() <= now.getTime()) at.setFullYear(at.getFullYear() + 1);
  } else if (at.getTime() <= now.getTime()) {
    at.setDate(at.getDate() + 1);
  }
  return at.toISOString();
}

/** What kind of CLI's text is read: Claude Code's wording only, or the looser provider errors of Codex / OpenCode. */
export type LimitStrictness = 'claude' | 'codex' | 'opencode';

/**
 * Reads a usage-limit error out of a CLI's error text, `null` when the text is not
 * one: Claude Code's "You've hit your session limit · resets 2pm" / "… weekly limit
 * …" / "… Opus limit …"; Codex's "You've hit your usage limit … try again at …"
 * (`usage_limit_reached`); OpenCode's provider 429 / quota errors (the loosest:
 * OpenCode reports no plan limits, only the provider's error, ASSUMED D63-oc-limit).
 */
export function parseLimitError(text: string, cli: LimitStrictness, now: Date = new Date()): LimitHit | null {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one === '') return null;
  const mine = /you(?:'|’)?ve (?:hit|reached) your ([a-z0-9 -]*?)\s*limit/i.exec(one);
  let window: LimitWindow | null = null;
  if (mine) {
    const word = (mine[1] ?? '').toLowerCase();
    window = /session|5[- ]?hour|five[- ]?hour/.test(word) ? 'session' : /week|7[- ]?day|seven[- ]?day|opus|sonnet|fable|haiku/.test(word) ? 'weekly' : 'unknown';
    if (/monthly spend|team|channel|credits/.test(one.toLowerCase()) && !/session|weekly/.test(word)) return null;
  } else if (cli !== 'claude' && /usage[_ ]limit|rate[_ ]limit[_ ]reached|usage_limit_reached/i.test(one)) {
    window = /weekly|week/i.test(one) ? 'weekly' : /5[- ]?hour|five[- ]?hour|session/i.test(one) ? 'session' : 'unknown';
  } else if (cli === 'opencode' && /\b429\b|too many requests|insufficient[_ ]quota|exceeded your current quota|quota (?:exceeded|exhausted)|rate[_ ]limit(?:ed)?/i.test(one)) {
    window = 'unknown';
  }
  if (window === null) return null;
  return { window, resetsAt: parseResetTime(one, now), text: one.slice(0, 300) };
}

// ── the switch decision ──────────────────────────────────────────────────────

/** What the decision needs to know about one profile. */
export interface ProfileSnapshot {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly position: number;
  /** `false` only when the CLI said signed out. */
  readonly signedIn: boolean | null;
  readonly exhaustedUntil: string | null;
  readonly usage: ProfileUsage | null;
}

/** Why the decision runs. */
export type SwitchTrigger =
  /** The CLI's limit error on the session's current profile. */
  | { readonly kind: 'limit'; readonly hit: LimitHit }
  /** The periodic check: the current profile's usage may be past a threshold. */
  | { readonly kind: 'threshold' }
  /** The periodic check after resets: a higher-priority profile may have allowance again. */
  | { readonly kind: 'reset' };

/** Input of {@link decideAccountSwitch}. */
export interface DecideInput {
  readonly settings: AccountSettings;
  readonly cli: CliProviderId;
  readonly trigger: SwitchTrigger;
  /** Every enabled-or-not profile of the CLI. */
  readonly profiles: readonly ProfileSnapshot[];
  /** The profile the session runs on. */
  readonly currentId: string;
  readonly pinned: boolean;
  /** No turn runs (a reset-triggered switch never interrupts one). */
  readonly idle: boolean;
  /** When the session last switched (epoch ms), `null` when never. */
  readonly lastSwitchAt: number | null;
  readonly now: number;
}

/** A profile to mark spent. */
export interface ExhaustedMark {
  readonly profileId: string;
  readonly until: string;
  readonly window: LimitWindow;
  readonly text: string | null;
}

/** The decision. */
export type SwitchDecision = {
  readonly action: 'none' | 'switch' | 'switch-cli' | 'exhausted';
  /** The profile to switch to (`switch`), the CLI (`switch-cli`). */
  readonly to?: string;
  readonly toCli?: CliProviderId;
  /** Why (shown in the divider / the Inbox item / the log). */
  readonly reason: string;
  /** The current profile is spent: remember it until its reset. */
  readonly mark?: ExhaustedMark;
};

/** The unread-reset fallbacks of {@link exhaustedUntil} (ASSUMED D63-reset-fallback). */
const FALLBACK_MS: Readonly<Record<LimitWindow, number>> = { session: 5 * 3_600_000, weekly: 24 * 3_600_000, unknown: 3_600_000 };

/** When a profile that just hit `hit` is usable again: the CLI's reset, else the reading's, else a fallback. */
export function exhaustedUntil(hit: LimitHit, usage: ProfileUsage | null, now: number): string {
  const future = (iso: string | null): number | null => {
    const ms = iso ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(ms) && ms > now ? ms : null;
  };
  const fromUsage =
    hit.window === 'session' ? future(usage?.fiveHourResetsAt ?? null) : hit.window === 'weekly' ? future(usage?.sevenDayResetsAt ?? null) : null;
  return new Date(future(hit.resetsAt) ?? fromUsage ?? now + FALLBACK_MS[hit.window]).toISOString();
}

function windowFull(pctValue: number | null, resetsAt: string | null, limit: number, now: number): boolean {
  if (pctValue === null || pctValue < limit) return false;
  const reset = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  return !Number.isFinite(reset) || reset > now;
}

/** How strict {@link hasAllowance} is: under the early-switch thresholds, or just not at 100 %. */
export type AllowanceLevel = 'threshold' | 'hard';

/** `true` when the profile can take work: enabled, not signed out, not spent, and under the limit of `level`. */
export function hasAllowance(profile: ProfileSnapshot, settings: AccountSettings, level: AllowanceLevel, now: number): boolean {
  if (!profile.enabled || profile.signedIn === false) return false;
  if (profile.exhaustedUntil && Date.parse(profile.exhaustedUntil) > now) return false;
  const five = level === 'hard' ? 100 : settings.thresholds.fiveHourPct;
  const week = level === 'hard' ? 100 : settings.thresholds.weeklyPct;
  const usage = profile.usage;
  if (!usage) return true;
  return !windowFull(usage.fiveHourPct, usage.fiveHourResetsAt, five, now) && !windowFull(usage.sevenDayPct, usage.sevenDayResetsAt, week, now);
}

function firstWithAllowance(profiles: readonly ProfileSnapshot[], settings: AccountSettings, now: number, skip: string | null): ProfileSnapshot | null {
  const ordered = [...profiles].filter((p) => p.id !== skip).sort((a, b) => a.position - b.position);
  return ordered.find((p) => hasAllowance(p, settings, 'threshold', now)) ?? ordered.find((p) => hasAllowance(p, settings, 'hard', now)) ?? null;
}

/** The profile a new session of `cli` starts on (`null` = none has allowance: the caller uses the Default / first enabled). */
export function pickProfileForNewSession(settings: AccountSettings, cli: CliProviderId, profiles: readonly ProfileSnapshot[], now: number): string | null {
  const fixed = settings.newSessions.rule === 'fixed' ? settings.newSessions.fixed[cli] : undefined;
  if (fixed) {
    const chosen = profiles.find((p) => p.id === fixed && p.enabled);
    if (chosen) return chosen.id;
  }
  if (!settings.enabled || !settings.perCli[cli]) return null;
  return firstWithAllowance(profiles, settings, now, null)?.id ?? null;
}

/**
 * The automatic switch rules (`docs/accounts.md` → *Rules*), one decision:
 * - master and per-CLI toggles; a **pinned** session never switches (a limit error
 *   still marks its profile spent);
 * - **limit error:** the profile is marked spent until its reset; the session goes
 *   to the first other profile with allowance (under the thresholds, else just
 *   under 100 %); none: the "every profile is spent" rule (stop and notify, or
 *   hand over to another CLI);
 * - **threshold** (past the early-switch %): only to a profile under the thresholds,
 *   and not within the cooldown of the last switch; never a stop;
 * - **reset** ("switch back to the first profile"): an idle session on a lower
 *   priority profile returns to a higher one that has allowance again, not within the cooldown.
 * A profile known spent is never a target until its reset, so there are no loops.
 */
export function decideAccountSwitch(input: DecideInput): SwitchDecision {
  const { settings, cli, trigger, profiles, now } = input;
  const current = profiles.find((p) => p.id === input.currentId) ?? null;
  const mark: ExhaustedMark | undefined =
    trigger.kind === 'limit'
      ? { profileId: input.currentId, until: exhaustedUntil(trigger.hit, current?.usage ?? null, now), window: trigger.hit.window, text: trigger.hit.text }
      : undefined;
  const none = (reason: string): SwitchDecision => ({ action: 'none', reason, ...(mark ? { mark } : {}) });
  if (!settings.enabled) return none('automatic switching is off');
  if (!settings.perCli[cli]) return none(`automatic switching is off for this CLI`);
  if (input.pinned) return none('the session is pinned to its account');
  const cooling = input.lastSwitchAt !== null && now - input.lastSwitchAt < settings.cooldownSeconds * 1000;
  // The profiles as the decision sees them: the spent mark of this very error counts at once.
  const view = profiles.map((p) => (mark && p.id === mark.profileId ? { ...p, exhaustedUntil: mark.until } : p));

  if (trigger.kind === 'limit') {
    const target = firstWithAllowance(view, settings, now, input.currentId);
    const label = limitLabel(trigger.hit, now);
    if (target) return { action: 'switch', to: target.id, reason: label, ...(mark ? { mark } : {}) };
    if (settings.exhausted.action === 'switch-cli' && settings.exhausted.cli && settings.exhausted.cli !== cli) {
      return { action: 'switch-cli', toCli: settings.exhausted.cli, reason: `every ${cli} account is out of usage (${label})`, ...(mark ? { mark } : {}) };
    }
    return { action: 'exhausted', reason: `every account is out of usage (${label})`, ...(mark ? { mark } : {}) };
  }

  if (!current) return none('the session\'s profile is unknown');
  if (cooling) return none('cooldown after the last switch');
  if (trigger.kind === 'threshold') {
    if (!settings.thresholds.enabled) return none('early switching is off');
    if (hasAllowance(current, settings, 'threshold', now)) return none('under the thresholds');
    const target = view.filter((p) => p.id !== current.id).sort((a, b) => a.position - b.position).find((p) => hasAllowance(p, settings, 'threshold', now));
    if (!target) return none('no other account is under the thresholds');
    return { action: 'switch', to: target.id, reason: thresholdLabel(current, settings) };
  }
  // reset
  if (settings.afterReset !== 'back-to-first') return none('staying on the current account');
  if (!input.idle) return none('a turn is running');
  const first = firstWithAllowance(view, settings, now, null);
  if (!first || first.id === current.id || first.position > current.position) return none('already on the first account with allowance');
  return { action: 'switch', to: first.id, reason: 'the first account has allowance again' };
}

function limitLabel(hit: LimitHit, now: number): string {
  const what = hit.window === 'session' ? 'session limit' : hit.window === 'weekly' ? 'weekly limit' : 'usage limit';
  return hit.resetsAt ? `${what}, resets ${clock(hit.resetsAt, new Date(now))}` : what;
}

function thresholdLabel(current: ProfileSnapshot, settings: AccountSettings): string {
  const usage = current.usage;
  const five = usage?.fiveHourPct ?? null;
  const week = usage?.sevenDayPct ?? null;
  if (five !== null && five >= settings.thresholds.fiveHourPct) return `session at ${Math.round(five)} %`;
  if (week !== null && week >= settings.thresholds.weeklyPct) return `weekly at ${Math.round(week)} %`;
  return 'near the limit';
}

/** `HH:MM` in this machine's zone (a date is added when it is not today). */
export function clock(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getDate()} ${MONTHS[d.getMonth()] ?? ''} ${hm}`;
}

/** The chat divider of an account switch: "Switched account: A → B (session limit, resets 14:05)". */
export function accountSwitchLabel(from: string, to: string, reason: string): string {
  return `Switched account: ${from} → ${to}${reason ? ` (${reason})` : ''}`;
}

/** The message that picks a switched session up again after an interrupted turn (ASSUMED D63-continue). */
export const CONTINUE_AFTER_SWITCH = 'Continue where you left off: the account changed because of a usage limit, and the turn that was running was interrupted.';

/** The profile a session runs on: its stored one, else the Default of its CLI. */
export function sessionProfileId(session: { readonly provider: CliProviderId; readonly profileId?: string | null }): string {
  return session.profileId ?? defaultProfileId(session.provider);
}

/** A name for the profile folder / list: trimmed, 1-40 characters, no control characters. `null` when invalid. */
export function cleanProfileName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  return name.length >= 1 && name.length <= 40 && !/[\u0000-\u001f]/.test(name) ? name : null;
}
