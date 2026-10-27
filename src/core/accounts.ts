/**
 * D63 (`docs/accounts.md`): CLI accounts and automatic switching on usage limits.
 * Pure, shared by the server (the switcher, the routes) and the UI (Settings →
 * Accounts): the profile and settings shapes, the limit-error reader and the
 * switch decision. No I/O; the clock is passed in.
 */
import { type CliProviderId, isCliProviderId } from './cli-providers.ts';
import { type AccountCredits, creditsInUse, creditsUsable } from './credits.ts';

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
  /**
   * Additive (D103, `docs/accounts.md` → *Credits*): the account's credit state
   * (on credits, credit limit / used / left, the period's reset), read from the
   * same readings; omitted / `null` while nothing is known about credits.
   */
  readonly credits?: AccountCredits | null;
}

/** Why a profile is out of allowance (until `until`). */
export interface ProfileExhausted {
  readonly until: string;
  readonly window: LimitWindow;
  readonly text: string | null;
  /** D98: the paired machine that found it spent (omitted: this one). */
  readonly machine?: string;
}

/** D98: the same account (identity) on a connected paired machine. */
export interface AccountElsewhere {
  readonly machineId: string;
  readonly machineName: string;
  /** Its profile id there. */
  readonly profileId: string;
  /** Its name there (the same once the shared name has gone round). */
  readonly name: string;
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
  /**
   * Additive (D98, `docs/accounts.md` → *Shared across paired machines*): the
   * identity of the account it is signed in to (`claude:<email>`), when known;
   * the same identity on a paired machine is the same account.
   */
  readonly identity?: string;
  /** Additive (D98): the same account on the connected paired machines (omitted when none). */
  readonly elsewhere?: readonly AccountElsewhere[];
  /** Additive (D98): `usage` is a paired machine's newer reading (that machine's name). */
  readonly usageFrom?: string;
}

/** Where the settings live (`settings` table, one JSON value). */
export const ACCOUNT_SETTINGS_KEY = 'accounts.settings';

/** What happens when every profile of a CLI is spent. */
export type ExhaustedAction = 'notify' | 'switch-cli';

/**
 * Which profile a new session starts on. Since D138 a mirror of {@link AccountSettings.choice}
 * kept for older clients: `fixed` while the CLI has an overall account choice.
 */
export type NewSessionRule = 'first-with-allowance' | 'fixed';

/** After a reset: go back to the first profile, or stay where the session is. */
export type AfterReset = 'back-to-first' | 'stay';

/**
 * D103: when no account of a CLI has subscription allowance left: keep working on
 * an account that pays from credits (default), or pause new turns until an
 * account resets.
 */
export type OutOfAllowance = 'use-credits' | 'pause';

/** Settings → Accounts → rules (`GET/PUT /api/accounts/settings`). */
export interface AccountSettings {
  /** Master toggle. */
  readonly enabled: boolean;
  /** Per-CLI toggles. */
  readonly perCli: Readonly<Record<CliProviderId, boolean>>;
  /** Switch earlier than the limit error, at these percentages (separate for the 5-hour and the weekly window). */
  readonly thresholds: { readonly enabled: boolean; readonly fiveHourPct: number; readonly weeklyPct: number };
  readonly afterReset: AfterReset;
  /**
   * D138: a mirror of {@link choice} for older clients (`fixed` = the CLI has a choice). A PUT
   * that sends only `newSessions` (an older client) still sets the choice, without moving sessions.
   */
  readonly newSessions: { readonly rule: NewSessionRule; readonly fixed: Readonly<Partial<Record<CliProviderId, string>>> };
  /**
   * D138 (`docs/accounts.md` → *Choosing the account*): the overall account choice per CLI
   * (profile id; absent = Automatic). New sessions start on it and running ones are moved to
   * it when it is chosen (`PUT /api/accounts/choice`); it is the preferred account of the
   * automatic switcher, not a pin. It absorbs D63's "New sessions start on: a fixed account"
   * (a stored `newSessions.rule: fixed` is read as the choice).
   */
  readonly choice: Readonly<Partial<Record<CliProviderId, string>>>;
  readonly exhausted: { readonly action: ExhaustedAction; readonly cli: CliProviderId | null };
  /** No threshold / reset switch of a session within this many seconds of its last switch. */
  readonly cooldownSeconds: number;
  /** D103: "When every account is out of allowance" (Settings → Accounts). */
  readonly outOfAllowance: OutOfAllowance;
}

export const DEFAULT_ACCOUNT_SETTINGS: AccountSettings = {
  enabled: true,
  perCli: { claude: true, codex: true, opencode: true },
  thresholds: { enabled: true, fiveHourPct: 98, weeklyPct: 98 },
  afterReset: 'stay',
  newSessions: { rule: 'first-with-allowance', fixed: {} },
  choice: {},
  exhausted: { action: 'notify', cli: null },
  cooldownSeconds: 120,
  outOfAllowance: 'use-credits',
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
  // D138: the overall choice; an install from before D138 has only the "fixed account" rule, read as the choice.
  const choice: Partial<Record<CliProviderId, string>> = {};
  if (typeof o['choice'] === 'object' && o['choice'] !== null && !Array.isArray(o['choice'])) {
    for (const [cli, id] of Object.entries(rec(o['choice']))) if (isCliProviderId(cli) && typeof id === 'string' && id !== '') choice[cli] = id;
  } else if (newSessions['rule'] === 'fixed') {
    Object.assign(choice, fixed);
  }
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
    newSessions: choiceMirror(choice),
    choice,
    exhausted: {
      action: exhausted['action'] === 'switch-cli' || exhausted['action'] === 'notify' ? exhausted['action'] : d.exhausted.action,
      cli: isCliProviderId(exhausted['cli']) ? exhausted['cli'] : null,
    },
    cooldownSeconds: typeof cooldown === 'number' && Number.isFinite(cooldown) ? Math.max(0, Math.min(3600, Math.round(cooldown))) : d.cooldownSeconds,
    outOfAllowance: o['outOfAllowance'] === 'pause' || o['outOfAllowance'] === 'use-credits' ? o['outOfAllowance'] : d.outOfAllowance,
  };
}

/** D138: the `newSessions` mirror of an overall choice (older clients read the rule from it). */
export function choiceMirror(choice: Readonly<Partial<Record<CliProviderId, string>>>): AccountSettings['newSessions'] {
  return Object.keys(choice).length > 0 ? { rule: 'fixed', fixed: { ...choice } } : { rule: 'first-with-allowance', fixed: {} };
}

/** D138: the overall account choice of `cli` (`null` = Automatic); settings built without `choice` read the D63 fixed rule. */
export function overallChoiceOf(settings: AccountSettings, cli: CliProviderId): string | null {
  const choice = (settings.choice as AccountSettings['choice'] | undefined) ?? {};
  if (Object.keys(choice).length > 0) return choice[cli] ?? null;
  return settings.newSessions.rule === 'fixed' ? (settings.newSessions.fixed[cli] ?? null) : null;
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
  /**
   * D138: the session's chosen account (its Project's, else the overall choice), `null` /
   * absent = Automatic. A preference, not a pin: it is the first target when it has allowance,
   * and when the session leaves it because it ran out the divider says so ({@link chosenOutLabel}).
   */
  readonly preferredId?: string | null;
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
  /** D138: the whole divider text when it is not "Switched account: A → B (reason)" (the chosen account ran out). */
  readonly label?: string;
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

/** D103: the first profile (priority order, not `skip`) with allowance: under the thresholds, else just under 100 %; `null` when none has. */
export function firstProfileWithAllowance(profiles: readonly ProfileSnapshot[], settings: AccountSettings, now: number, skip: string | null = null): ProfileSnapshot | null {
  return firstWithAllowance(profiles, settings, now, skip);
}

/** D103: the profile runs on credits now (a plan window at its limit, requests paid from credits). */
export function onCredits(profile: Pick<ProfileSnapshot, 'usage'>, now: number): boolean {
  return creditsInUse(profile.usage?.credits, now);
}

/**
 * D103: `true` when the profile can take work **at cost**: enabled, not signed
 * out, not known spent, and paying from credits (or able to: credits on, their
 * limit not reached). An account with allowance is always preferred to one of these.
 */
export function canUseCredits(profile: ProfileSnapshot, now: number): boolean {
  if (!profile.enabled || profile.signedIn === false) return false;
  if (profile.exhaustedUntil && Date.parse(profile.exhaustedUntil) > now) return false;
  return creditsUsable(profile.usage?.credits, now);
}

/** D103: the first profile (priority order) that can take work from credits. */
function firstOnCredits(profiles: readonly ProfileSnapshot[], now: number, skip: string | null): ProfileSnapshot | null {
  return [...profiles].filter((p) => p.id !== skip).sort((a, b) => a.position - b.position).find((p) => canUseCredits(p, now)) ?? null;
}

/**
 * D103: when a profile has allowance again at the earliest (ISO): `null` when it
 * has allowance now. The later of its spent mark and its full windows' resets;
 * `null` too when that is not known.
 */
export function allowanceBackAt(profile: ProfileSnapshot, now: number): string | null {
  const ahead = (iso: string | null | undefined): number | null => {
    const ms = iso ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(ms) && ms > now ? ms : null;
  };
  const times = [ahead(profile.exhaustedUntil)];
  const usage = profile.usage;
  if (usage?.fiveHourPct !== null && usage?.fiveHourPct !== undefined && usage.fiveHourPct >= 100) times.push(ahead(usage.fiveHourResetsAt));
  if (usage?.sevenDayPct !== null && usage?.sevenDayPct !== undefined && usage.sevenDayPct >= 100) times.push(ahead(usage.sevenDayResetsAt));
  const known = times.filter((t): t is number => t !== null);
  return known.length > 0 ? new Date(Math.max(...known)).toISOString() : null;
}

/**
 * D103 "pause new turns": the setting is `pause`, automatic switching is on for
 * the CLI and no enabled profile of it has allowance (here or, D98, by a paired
 * machine's reading). Returns the earliest time one is back (`null` when unknown),
 * or `false` when new turns may run.
 */
export function creditsPause(settings: AccountSettings, cli: CliProviderId, profiles: readonly ProfileSnapshot[], now: number): { readonly until: string | null; readonly name: string | null } | false {
  if (settings.outOfAllowance !== 'pause' || !settings.enabled || !settings.perCli[cli]) return false;
  const enabled = profiles.filter((p) => p.enabled && p.signedIn !== false);
  if (enabled.length === 0 || enabled.some((p) => hasAllowance(p, settings, 'hard', now))) return false;
  let best: { until: string | null; name: string | null } = { until: null, name: null };
  for (const p of enabled) {
    const back = allowanceBackAt(p, now);
    if (back !== null && (best.until === null || Date.parse(back) < Date.parse(best.until))) best = { until: back, name: p.name };
  }
  return best;
}

/**
 * The profile a new session of `cli` starts on (`null` = none has allowance: the caller uses the Default / first enabled).
 * D138: `preferred` is the chosen account (a Project's, else the overall choice; `undefined` = the
 * overall choice of `settings`, `null` = Automatic). It is a preference, not a pin: while automatic
 * switching is on for the CLI and the chosen account has no allowance, the automatic pick takes over
 * (and the chosen one is still used when nothing else has allowance either).
 */
export function pickProfileForNewSession(settings: AccountSettings, cli: CliProviderId, profiles: readonly ProfileSnapshot[], now: number, preferred?: string | null): string | null {
  const chosenId = preferred === undefined ? overallChoiceOf(settings, cli) : preferred;
  const chosen = chosenId ? (profiles.find((p) => p.id === chosenId && p.enabled) ?? null) : null;
  const switching = settings.enabled && settings.perCli[cli];
  if (chosen && (!switching || hasAllowance(chosen, settings, settings.thresholds.enabled ? 'threshold' : 'hard', now))) return chosen.id;
  if (!switching) return null;
  // D103: an account with allowance first; none: one that pays from credits (unless new turns pause instead).
  const auto = firstWithAllowance(profiles, settings, now, null)?.id ?? (settings.outOfAllowance === 'use-credits' ? firstOnCredits(profiles, now, null)?.id ?? null : null);
  return auto ?? chosen?.id ?? null;
}

// ── D138: choosing the account (docs/accounts.md → *Choosing the account*) ─────

/** D138: where a session's account comes from, strongest first. */
export type AccountChoiceSource = 'pinned' | 'project' | 'overall' | 'automatic';

/** D138: the account a session should be on, and why ({@link resolveAccountPreference}). */
export interface AccountPreference {
  /** The preferred profile id; `null` = Automatic (the rules decide). */
  readonly profileId: string | null;
  readonly source: AccountChoiceSource;
}

/**
 * D138 precedence, one place: a session's own **pin** > its **Project's** account > the
 * **overall** choice > the **automatic** rules. `project` / `overall` are profile ids of the
 * session's CLI (`null` / absent = Automatic); `usable` filters out ids that are gone, disabled
 * or of another CLI (they count as Automatic).
 */
export function resolveAccountPreference(input: {
  readonly pinned: boolean;
  readonly currentId: string;
  readonly project?: string | null;
  readonly overall?: string | null;
  readonly usable?: (profileId: string) => boolean;
}): AccountPreference {
  const ok = (id: string | null | undefined): id is string => typeof id === 'string' && id !== '' && (input.usable ? input.usable(id) : true);
  if (input.pinned) return { profileId: input.currentId, source: 'pinned' };
  if (ok(input.project)) return { profileId: input.project, source: 'project' };
  if (ok(input.overall)) return { profileId: input.overall, source: 'overall' };
  return { profileId: null, source: 'automatic' };
}

/** D138: one open session as the move selection sees it. */
export interface MoveCandidate {
  readonly id: string;
  readonly cli: CliProviderId;
  /** The profile it runs on now. */
  readonly profileId: string;
  readonly pinned: boolean;
  /** Its Project's account for its CLI (`null` = none: the Project is on Automatic, or there is no Project). */
  readonly projectAccount: string | null;
  /** A turn runs now (moving interrupts it). */
  readonly running: boolean;
}

/** D138: which sessions a new choice moves, and the counts the confirm shows. */
export interface MoveSelection {
  /** The sessions to move (in the order given). */
  readonly move: readonly string[];
  /** How many of them have a running turn (it is interrupted, then continued). */
  readonly running: number;
  /** Left where they are: pinned, on a Project with its own account, already there. */
  readonly skipped: { readonly pinned: number; readonly project: number; readonly already: number };
}

/**
 * D138: the live sessions a choice moves to `toId` (`null` = Automatic: nothing moves).
 * `scope: overall`: every session of the CLI except pinned ones and those whose Project has
 * its own account; `scope: project`: only the sessions given (the Project's), except pinned ones.
 * Sessions already on `toId` stay.
 */
export function selectSessionsToMove(candidates: readonly MoveCandidate[], cli: CliProviderId, toId: string | null, scope: 'overall' | 'project'): MoveSelection {
  const move: string[] = [];
  let running = 0;
  const skipped = { pinned: 0, project: 0, already: 0 };
  if (toId === null) return { move, running, skipped };
  for (const c of candidates) {
    if (c.cli !== cli) continue;
    if (c.pinned) {
      skipped.pinned++;
      continue;
    }
    if (scope === 'overall' && c.projectAccount !== null) {
      skipped.project++;
      continue;
    }
    if (c.profileId === toId) {
      skipped.already++;
      continue;
    }
    move.push(c.id);
    if (c.running) running++;
  }
  return { move, running, skipped };
}

/**
 * D138: the confirm of a choice: "Move 5 agents to B? 1 running turn will be interrupted."
 * (`null` when nothing moves).
 */
export function moveConfirmText(selection: Pick<MoveSelection, 'move' | 'running'>, toName: string, nouns: { readonly one: string; readonly many: string } = { one: 'agent', many: 'agents' }): string | null {
  const n = selection.move.length;
  if (n === 0) return null;
  const head = `Move ${n} ${n === 1 ? nouns.one : nouns.many} to ${toName}?`;
  if (selection.running === 0) return head;
  return `${head} ${selection.running} running ${selection.running === 1 ? 'turn' : 'turns'} will be interrupted.`;
}

/** D138: the reason a choice moved a session (the divider says "Switched account: A → B (overall choice)"). */
export function choiceMoveReason(source: 'overall' | 'project'): string {
  return source === 'project' ? "the project's account" : 'overall choice';
}

/**
 * D138: the chat divider when the chosen account (a Project's or the overall choice) runs out and
 * the automatic rules move the session: "B is out of usage until 14:05; switched to A".
 */
export function chosenOutLabel(fromName: string, toName: string, until: string | null, now: number): string {
  return `${fromName} is out of usage${until ? ` until ${clock(until, new Date(now))}` : ''}; switched to ${toName}`;
}

/** D138: the message that picks a session up after a choice moved it mid-turn. */
export const CONTINUE_AFTER_CHOICE = 'Continue where you left off: the account changed because a different account was chosen, and the turn that was running was interrupted.';

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
  // D138: the chosen account (a Project's, else the overall choice) is the first target while it has allowance.
  const preferred = input.preferredId ? (view.find((p) => p.id === input.preferredId && p.id !== input.currentId) ?? null) : null;
  const prefer = (fallback: ProfileSnapshot | null, level: 'threshold' | 'any'): ProfileSnapshot | null =>
    preferred && (hasAllowance(preferred, settings, 'threshold', now) || (level === 'any' && hasAllowance(preferred, settings, 'hard', now))) ? preferred : fallback;
  // D138: leaving the chosen account because it ran out: the divider says so.
  const leavingChosen = input.preferredId !== null && input.preferredId !== undefined && input.preferredId === input.currentId;
  const chosenOut = (target: ProfileSnapshot, until: string | null, why?: string): { label?: string } =>
    leavingChosen ? { label: why ? `${current?.name ?? 'The chosen account'} is near its limit (${why}); switched to ${target.name}` : chosenOutLabel(current?.name ?? 'The chosen account', target.name, until, now) } : {};

  if (trigger.kind === 'limit') {
    const target = prefer(firstWithAllowance(view, settings, now, input.currentId), 'any');
    const label = limitLabel(trigger.hit, now);
    if (target) return { action: 'switch', to: target.id, reason: label, ...(mark ? { mark } : {}), ...chosenOut(target, mark?.until ?? null) };
    if (settings.exhausted.action === 'switch-cli' && settings.exhausted.cli && settings.exhausted.cli !== cli) {
      return { action: 'switch-cli', toCli: settings.exhausted.cli, reason: `every ${cli} account is out of usage (${label})`, ...(mark ? { mark } : {}) };
    }
    // D103: no account has allowance: one that pays from credits takes the session ("use credits", the default).
    const paid = settings.outOfAllowance === 'use-credits' ? firstOnCredits(view, now, input.currentId) : null;
    if (paid) return { action: 'switch', to: paid.id, reason: `${label}; no account has allowance, using credits on ${paid.name}`, ...(mark ? { mark } : {}) };
    return { action: 'exhausted', reason: `every account is out of usage (${label})`, ...(mark ? { mark } : {}) };
  }

  if (!current) return none('the session\'s profile is unknown');
  if (cooling) return none('cooldown after the last switch');
  if (trigger.kind === 'threshold') {
    // D98: the current account is known spent (here, or by a paired machine sharing it): move before a turn fails on it,
    // to an account with allowance (under the thresholds, else just under 100 %), never a stop.
    if (current.exhaustedUntil && Date.parse(current.exhaustedUntil) > now) {
      const target = prefer(firstWithAllowance(view, settings, now, current.id), 'any');
      if (!target) return none('no other account has allowance');
      return { action: 'switch', to: target.id, reason: `out of usage until ${clock(current.exhaustedUntil, new Date(now))}`, ...chosenOut(target, current.exhaustedUntil) };
    }
    // D103: the current account pays from credits: back to an account with allowance as soon as one has it,
    // at a turn boundary only (never mid-turn), also with early switching off; none: stay on credits.
    if (onCredits(current, now)) {
      const target = prefer(firstWithAllowance(view, settings, now, current.id), 'any');
      if (!target) return none('no account has allowance: staying on credits');
      if (!input.idle) return none('a turn is running: moving off credits when it ends');
      return { action: 'switch', to: target.id, reason: `moved off credits: ${target.name} has allowance again` };
    }
    if (!settings.thresholds.enabled) return none('early switching is off');
    if (hasAllowance(current, settings, 'threshold', now)) return none('under the thresholds');
    const target = prefer(view.filter((p) => p.id !== current.id).sort((a, b) => a.position - b.position).find((p) => hasAllowance(p, settings, 'threshold', now)) ?? null, 'threshold');
    if (!target) return none('no other account is under the thresholds');
    return { action: 'switch', to: target.id, reason: thresholdLabel(current, settings), ...chosenOut(target, null, thresholdLabel(current, settings)) };
  }
  // reset
  if (settings.afterReset !== 'back-to-first') return none('staying on the current account');
  if (!input.idle) return none('a turn is running');
  // D138: with a chosen account, "switch back" means back to it (when it has allowance again), never away from it.
  if (input.preferredId) {
    if (input.preferredId === current.id) return none('already on the chosen account');
    if (preferred && hasAllowance(preferred, settings, 'threshold', now)) return { action: 'switch', to: preferred.id, reason: `${preferred.name} has allowance again` };
    if (preferred) return none('the chosen account has no allowance yet');
  }
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
