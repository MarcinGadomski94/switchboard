import { describe, expect, it } from 'vitest';
import {
  type AccountSettings,
  DEFAULT_ACCOUNT_SETTINGS,
  type ProfileSnapshot,
  accountSwitchLabel,
  allowanceBackAt,
  canUseCredits,
  creditsPause,
  decideAccountSwitch,
  defaultProfileId,
  exhaustedUntil,
  parseLimitError,
  parseResetTime,
  pickProfileForNewSession,
  readAccountSettings,
  sessionProfileId,
} from '../../src/core/accounts.ts';

const NOW = new Date(2026, 9, 1, 12, 0, 0); // local time, 12:00
const now = NOW.getTime();
const HOUR = 3_600_000;

function profile(id: string, position: number, extra: Partial<ProfileSnapshot> = {}): ProfileSnapshot {
  return { id, name: id.toUpperCase(), enabled: true, position, signedIn: true, exhaustedUntil: null, usage: null, ...extra };
}

function usage(five: number | null, week: number | null, resetsIn = 2 * HOUR): ProfileSnapshot['usage'] {
  const at = new Date(now + resetsIn).toISOString();
  return { fiveHourPct: five, fiveHourResetsAt: five === null ? null : at, sevenDayPct: week, sevenDayResetsAt: week === null ? null : at, receivedAt: new Date(now).toISOString() };
}

const settings = (patch: Partial<AccountSettings> = {}): AccountSettings => ({ ...DEFAULT_ACCOUNT_SETTINGS, ...patch });

const A = profile('a', 0);
const B = profile('b', 1);

describe('D63 · reading limit errors', () => {
  it("Claude Code's wording: session, weekly and a model's limit, with the reset", () => {
    expect(parseLimitError("You've hit your session limit · resets 2pm", 'claude', NOW)).toMatchObject({ window: 'session' });
    expect(parseLimitError("You've hit your weekly limit · resets Oct 5, 9am", 'claude', NOW)).toMatchObject({ window: 'weekly' });
    expect(parseLimitError("You've hit your Opus limit · resets 3:30pm", 'claude', NOW)).toMatchObject({ window: 'weekly' });
    expect(parseLimitError("You've hit your limit", 'claude', NOW)).toMatchObject({ window: 'unknown', resetsAt: null });
  });

  it('is not fooled by other limits or other errors', () => {
    expect(parseLimitError("You've hit your monthly spend limit", 'claude', NOW)).toBeNull();
    expect(parseLimitError("You've hit your team's shared budget", 'claude', NOW)).toBeNull();
    expect(parseLimitError('error_during_execution: tool failed', 'claude', NOW)).toBeNull();
    expect(parseLimitError('429 Too Many Requests', 'claude', NOW)).toBeNull();
    expect(parseLimitError('', 'claude', NOW)).toBeNull();
  });

  it("Codex's usage-limit error and OpenCode's provider 429", () => {
    expect(parseLimitError("You've hit your usage limit. Upgrade to Pro or try again at 3:20 PM.", 'codex', NOW)).toMatchObject({ window: 'unknown' });
    expect(parseLimitError('usage_limit_reached: the 5 hour window is full', 'codex', NOW)).toMatchObject({ window: 'session' });
    expect(parseLimitError('Rate limit exceeded: 429 Too Many Requests', 'opencode', NOW)).toMatchObject({ window: 'unknown' });
    expect(parseLimitError('Rate limit exceeded: 429 Too Many Requests', 'codex', NOW)).toBeNull();
  });

  it('reads the reset: a time of day (next one, local zone), a date, "in 3 hours"; none otherwise', () => {
    const at = (iso: string | null): Date => new Date(iso as string);
    expect(at(parseResetTime('resets 2pm', NOW)).getHours()).toBe(14);
    expect(at(parseResetTime('resets 2pm', NOW)).getDate()).toBe(1);
    // 11am has passed today: tomorrow.
    expect(at(parseResetTime('resets 11am', NOW)).getDate()).toBe(2);
    expect(at(parseResetTime('resets 2:05pm (Europe/Oslo)', NOW)).getMinutes()).toBe(5);
    const dated = at(parseResetTime('resets Oct 5, 9am', NOW));
    expect([dated.getMonth(), dated.getDate(), dated.getHours()]).toEqual([9, 5, 9]);
    expect(at(parseResetTime('resets in 3 hours', NOW)).getTime() - now).toBe(3 * HOUR);
    expect(parseResetTime('nothing to see', NOW)).toBeNull();
  });

  it('a spent profile stays spent until the reset: the CLI\'s, else the reading\'s, else a fallback by window', () => {
    const hit = (window: 'session' | 'weekly' | 'unknown', resetsAt: string | null) => ({ window, resetsAt, text: 't' });
    const when = new Date(now + HOUR).toISOString();
    expect(exhaustedUntil(hit('session', when), null, now)).toBe(when);
    expect(exhaustedUntil(hit('session', null), usage(100, 10, 2 * HOUR), now)).toBe(new Date(now + 2 * HOUR).toISOString());
    expect(exhaustedUntil(hit('session', null), null, now)).toBe(new Date(now + 5 * HOUR).toISOString());
    expect(exhaustedUntil(hit('weekly', null), null, now)).toBe(new Date(now + 24 * HOUR).toISOString());
    expect(exhaustedUntil(hit('unknown', null), null, now)).toBe(new Date(now + HOUR).toISOString());
  });
});

const base = { cli: 'claude' as const, currentId: 'a', pinned: false, idle: true, lastSwitchAt: null, now };
const limit = { kind: 'limit' as const, hit: { window: 'session' as const, resetsAt: new Date(now + 2 * HOUR).toISOString(), text: "You've hit your session limit" } };

describe('D63 · the switch decision', () => {
  it('limit error: marks the profile spent until its reset and switches to the next one', () => {
    const d = decideAccountSwitch({ ...base, settings: settings(), trigger: limit, profiles: [A, B] });
    expect(d).toMatchObject({ action: 'switch', to: 'b', mark: { profileId: 'a', window: 'session', until: limit.hit.resetsAt } });
    expect(d.reason).toMatch(/^session limit, resets \d\d:\d\d$/);
  });

  it('the next profile must have allowance: not disabled, not signed out, not spent, not at its limit', () => {
    const c = profile('c', 2);
    const profiles = [A, profile('b', 1, { enabled: false }), c];
    expect(decideAccountSwitch({ ...base, settings: settings(), trigger: limit, profiles }).to).toBe('c');
    expect(decideAccountSwitch({ ...base, settings: settings(), trigger: limit, profiles: [A, profile('b', 1, { signedIn: false }), c] }).to).toBe('c');
    expect(decideAccountSwitch({ ...base, settings: settings(), trigger: limit, profiles: [A, profile('b', 1, { exhaustedUntil: new Date(now + HOUR).toISOString() }), c] }).to).toBe('c');
    expect(decideAccountSwitch({ ...base, settings: settings(), trigger: limit, profiles: [A, profile('b', 1, { usage: usage(100, 20) }), c] }).to).toBe('c');
    // A mark that has passed is no mark.
    expect(decideAccountSwitch({ ...base, settings: settings(), trigger: limit, profiles: [A, profile('b', 1, { exhaustedUntil: new Date(now - HOUR).toISOString() })] }).to).toBe('b');
  });

  it('prefers a profile under the thresholds, else one just under 100 %', () => {
    const near = profile('b', 1, { usage: usage(99, 10) });
    const fine = profile('c', 2, { usage: usage(10, 10) });
    expect(decideAccountSwitch({ ...base, settings: settings(), trigger: limit, profiles: [A, near, fine] }).to).toBe('c');
    expect(decideAccountSwitch({ ...base, settings: settings(), trigger: limit, profiles: [A, near] }).to).toBe('b');
  });

  it('every profile spent: stop and notify (default), or hand over to the chosen other CLI', () => {
    const spent = profile('b', 1, { exhaustedUntil: new Date(now + HOUR).toISOString() });
    expect(decideAccountSwitch({ ...base, settings: settings(), trigger: limit, profiles: [A, spent] })).toMatchObject({ action: 'exhausted', mark: { profileId: 'a' } });
    const toCodex = settings({ exhausted: { action: 'switch-cli', cli: 'codex' } });
    expect(decideAccountSwitch({ ...base, settings: toCodex, trigger: limit, profiles: [A, spent] })).toMatchObject({ action: 'switch-cli', toCli: 'codex' });
    // The CLI itself is never the target of "switch to another CLI".
    expect(decideAccountSwitch({ ...base, settings: settings({ exhausted: { action: 'switch-cli', cli: 'claude' } }), trigger: limit, profiles: [A, spent] }).action).toBe('exhausted');
  });

  it('a pinned session does not switch (its profile is still marked spent); the toggles turn everything off', () => {
    expect(decideAccountSwitch({ ...base, pinned: true, settings: settings(), trigger: limit, profiles: [A, B] })).toMatchObject({ action: 'none', mark: { profileId: 'a' } });
    expect(decideAccountSwitch({ ...base, settings: settings({ enabled: false }), trigger: limit, profiles: [A, B] }).action).toBe('none');
    expect(decideAccountSwitch({ ...base, settings: settings({ perCli: { ...DEFAULT_ACCOUNT_SETTINGS.perCli, claude: false } }), trigger: limit, profiles: [A, B] }).action).toBe('none');
    expect(decideAccountSwitch({ ...base, cli: 'codex', settings: settings({ perCli: { ...DEFAULT_ACCOUNT_SETTINGS.perCli, claude: false } }), trigger: limit, profiles: [A, B] }).action).toBe('switch');
  });

  it('threshold: past 98 % of either window moves the session to a profile under the thresholds; never a stop', () => {
    const hot = profile('a', 0, { usage: usage(98, 10) });
    expect(decideAccountSwitch({ ...base, settings: settings(), trigger: { kind: 'threshold' }, profiles: [hot, B] })).toMatchObject({ action: 'switch', to: 'b', reason: 'session at 98 %' });
    expect(decideAccountSwitch({ ...base, settings: settings(), trigger: { kind: 'threshold' }, profiles: [profile('a', 0, { usage: usage(10, 99) }), B] }).reason).toBe('weekly at 99 %');
    // The 5-hour and weekly percentages are separate settings.
    const weekly = settings({ thresholds: { enabled: true, fiveHourPct: 98, weeklyPct: 100 } });
    expect(decideAccountSwitch({ ...base, settings: weekly, trigger: { kind: 'threshold' }, profiles: [profile('a', 0, { usage: usage(10, 99) }), B] }).action).toBe('none');
    // No other profile under the thresholds: nothing happens (the real limit error is the next trigger).
    expect(decideAccountSwitch({ ...base, settings: settings(), trigger: { kind: 'threshold' }, profiles: [hot, profile('b', 1, { usage: usage(99, 0) })] }).action).toBe('none');
    expect(decideAccountSwitch({ ...base, settings: settings({ thresholds: { ...DEFAULT_ACCOUNT_SETTINGS.thresholds, enabled: false } }), trigger: { kind: 'threshold' }, profiles: [hot, B] }).action).toBe('none');
    // A window whose reset has passed does not count (the reading is old).
    expect(decideAccountSwitch({ ...base, settings: settings(), trigger: { kind: 'threshold' }, profiles: [profile('a', 0, { usage: usage(99, 0, -HOUR) }), B] }).action).toBe('none');
  });

  it('cooldown: no threshold or reset switch right after a switch; a limit error always acts', () => {
    const hot = profile('a', 0, { usage: usage(99, 10) });
    const recent = now - 30_000;
    expect(decideAccountSwitch({ ...base, lastSwitchAt: recent, settings: settings(), trigger: { kind: 'threshold' }, profiles: [hot, B] })).toMatchObject({ action: 'none', reason: 'cooldown after the last switch' });
    expect(decideAccountSwitch({ ...base, lastSwitchAt: now - 200_000, settings: settings(), trigger: { kind: 'threshold' }, profiles: [hot, B] }).action).toBe('switch');
    expect(decideAccountSwitch({ ...base, lastSwitchAt: recent, settings: settings(), trigger: limit, profiles: [A, B] }).action).toBe('switch');
  });

  it('after a reset: "switch back to the first profile" only for an idle session on a lower-priority profile; "stay" never', () => {
    const onB = { ...base, currentId: 'b', settings: settings({ afterReset: 'back-to-first' }), trigger: { kind: 'reset' as const } };
    // A was spent until a moment ago.
    const aBack = profile('a', 0, { exhaustedUntil: new Date(now - 1_000).toISOString() });
    expect(decideAccountSwitch({ ...onB, profiles: [aBack, B] })).toMatchObject({ action: 'switch', to: 'a' });
    expect(decideAccountSwitch({ ...onB, idle: false, profiles: [aBack, B] }).action).toBe('none');
    expect(decideAccountSwitch({ ...onB, profiles: [profile('a', 0, { exhaustedUntil: new Date(now + HOUR).toISOString() }), B] }).action).toBe('none');
    expect(decideAccountSwitch({ ...onB, settings: settings({ afterReset: 'stay' }), profiles: [aBack, B] }).action).toBe('none');
    // Already on the first profile with allowance.
    expect(decideAccountSwitch({ ...base, currentId: 'a', settings: settings({ afterReset: 'back-to-first' }), trigger: { kind: 'reset' }, profiles: [A, B] }).action).toBe('none');
  });

  it('no loops: two profiles that both hit their limit leave the second one with nowhere to go until a reset', () => {
    // A hits its limit: B is chosen. B hits its limit right after: A is still marked spent, so nothing is left.
    const first = decideAccountSwitch({ ...base, settings: settings(), trigger: limit, profiles: [A, B] });
    const aSpent = { ...A, exhaustedUntil: first.mark?.until ?? null };
    const second = decideAccountSwitch({ ...base, currentId: 'b', settings: settings(), trigger: limit, profiles: [aSpent, B] });
    expect(second.action).toBe('exhausted');
  });
});

describe('D63 · new sessions and settings', () => {
  it('a new session takes the first profile with allowance, or the fixed one', () => {
    const spent = profile('a', 0, { exhaustedUntil: new Date(now + HOUR).toISOString() });
    expect(pickProfileForNewSession(settings(), 'claude', [spent, B], now)).toBe('b');
    expect(pickProfileForNewSession(settings(), 'claude', [A, B], now)).toBe('a');
    expect(pickProfileForNewSession(settings({ newSessions: { rule: 'fixed', fixed: { claude: 'b' } } }), 'claude', [A, B], now)).toBe('b');
    // A fixed profile that is gone or disabled falls back to the rule.
    expect(pickProfileForNewSession(settings({ newSessions: { rule: 'fixed', fixed: { claude: 'b' } } }), 'claude', [A, profile('b', 1, { enabled: false })], now)).toBe('a');
    expect(pickProfileForNewSession(settings({ enabled: false }), 'claude', [spent, B], now)).toBeNull();
    // Everything spent: nothing is picked (the caller uses the Default).
    expect(pickProfileForNewSession(settings(), 'claude', [spent, profile('b', 1, { exhaustedUntil: new Date(now + HOUR).toISOString() })], now)).toBeNull();
  });

  it('settings are read defensively over the defaults', () => {
    expect(readAccountSettings(undefined)).toEqual(DEFAULT_ACCOUNT_SETTINGS);
    const read = readAccountSettings({ enabled: false, thresholds: { fiveHourPct: 500, weeklyPct: 'x' }, afterReset: 'nope', exhausted: { action: 'switch-cli', cli: 'codex' }, cooldownSeconds: -4, perCli: { codex: false }, newSessions: { rule: 'fixed', fixed: { claude: 'p', bogus: 'q' } } });
    expect(read).toMatchObject({ enabled: false, afterReset: 'stay', cooldownSeconds: 0, perCli: { claude: true, codex: false, opencode: true }, exhausted: { action: 'switch-cli', cli: 'codex' } });
    expect(read.thresholds).toEqual({ enabled: true, fiveHourPct: 100, weeklyPct: 98 });
    expect(read.newSessions).toEqual({ rule: 'fixed', fixed: { claude: 'p' } });
  });

  it('a session without a stored profile is on the Default of its CLI; the divider text', () => {
    expect(sessionProfileId({ provider: 'codex', profileId: null })).toBe('default-codex');
    expect(sessionProfileId({ provider: 'claude', profileId: 'x' })).toBe('x');
    expect(defaultProfileId('opencode')).toBe('default-opencode');
    expect(accountSwitchLabel('Work', 'Private', 'session limit, resets 14:05')).toBe('Switched account: Work → Private (session limit, resets 14:05)');
  });
});

describe('D103 · prefer subscription allowance over credits', () => {
  const credits = (on: boolean, resetsIn = 2 * HOUR): NonNullable<ProfileSnapshot['usage']>['credits'] => ({
    onCredits: on,
    until: on ? new Date(now + resetsIn).toISOString() : null,
    enabled: true,
    currency: 'EUR',
    limit: 50,
    used: 37.6,
    left: 12.4,
    resetsAt: null,
    limitReached: false,
    at: new Date(now).toISOString(),
  });
  // Acme Work: weekly at 100 % and still answering, paid from credits. Acme Private: its 5-hour window at 100 %, no credits.
  const work = profile('work', 0, { usage: { ...(usage(20, 100) as object), credits: credits(true) } as ProfileSnapshot['usage'] });
  const privateOut = profile('private', 1, { usage: usage(100, 40) });
  const privateBack = profile('private', 1, { usage: usage(3, 40) });

  it('an account on credits has no allowance; it can take work at cost', () => {
    expect(canUseCredits(work, now)).toBe(true);
    expect(canUseCredits(privateOut, now)).toBe(false);
    expect(canUseCredits({ ...work, exhaustedUntil: new Date(now + HOUR).toISOString() }, now)).toBe(false);
    expect(allowanceBackAt(work, now)).toBe(new Date(now + 2 * HOUR).toISOString());
    expect(allowanceBackAt(privateBack, now)).toBeNull();
  });

  it('new sessions prefer any account with allowance; none: the one on credits ("use credits"), or none ("pause")', () => {
    expect(pickProfileForNewSession(settings(), 'claude', [work, privateBack], now)).toBe('private');
    expect(pickProfileForNewSession(settings(), 'claude', [privateOut, { ...work, position: 1 }], now)).toBe('work');
    expect(pickProfileForNewSession(settings({ outOfAllowance: 'pause' }), 'claude', [work, privateOut], now)).toBeNull();
  });

  it('the switcher prefers allowance over credits: a limit error goes to an account with allowance, else to one on credits', () => {
    const hit = { ...base, currentId: 'private', trigger: limit, settings: settings() };
    expect(decideAccountSwitch({ ...hit, profiles: [work, privateOut, profile('spare', 2, { usage: usage(10, 10) })] })).toMatchObject({ action: 'switch', to: 'spare' });
    const paid = decideAccountSwitch({ ...hit, profiles: [work, privateOut] });
    expect(paid).toMatchObject({ action: 'switch', to: 'work', mark: { profileId: 'private' } });
    expect(paid.reason).toContain('using credits on WORK');
    // "pause": no switch to credits; the every-account rule as before.
    expect(decideAccountSwitch({ ...hit, profiles: [work, privateOut], settings: settings({ outOfAllowance: 'pause' }) })).toMatchObject({ action: 'exhausted' });
  });

  it('a reset moves a session on credits back to an account with allowance at the turn boundary, never mid-turn', () => {
    const input = { ...base, currentId: 'work', trigger: { kind: 'threshold' as const }, settings: settings({ thresholds: { enabled: false, fiveHourPct: 98, weeklyPct: 98 } }) };
    expect(decideAccountSwitch({ ...input, profiles: [work, privateBack], idle: false })).toMatchObject({ action: 'none', reason: 'a turn is running: moving off credits when it ends' });
    expect(decideAccountSwitch({ ...input, profiles: [work, privateBack], idle: true })).toEqual({ action: 'switch', to: 'private', reason: 'moved off credits: PRIVATE has allowance again' });
    // Pinned, or within the cooldown: stays.
    expect(decideAccountSwitch({ ...input, profiles: [work, privateBack], pinned: true })).toMatchObject({ action: 'none' });
    expect(decideAccountSwitch({ ...input, profiles: [work, privateBack], lastSwitchAt: now - 1000 })).toMatchObject({ action: 'none', reason: 'cooldown after the last switch' });
  });

  it('all out: a session stays on credits by default', () => {
    const input = { ...base, currentId: 'work', trigger: { kind: 'threshold' as const }, settings: settings() };
    expect(decideAccountSwitch({ ...input, profiles: [work, privateOut] })).toMatchObject({ action: 'none', reason: 'no account has allowance: staying on credits' });
    expect(creditsPause(settings(), 'claude', [work, privateOut], now)).toBe(false);
  });

  it('"pause new turns": paused while no account has allowance, until the first one is back; not with one that has allowance', () => {
    const pause = settings({ outOfAllowance: 'pause' });
    expect(creditsPause(pause, 'claude', [work, profile('private', 1, { usage: usage(100, 40, HOUR) })], now)).toEqual({ until: new Date(now + HOUR).toISOString(), name: 'PRIVATE' });
    expect(creditsPause(pause, 'claude', [work, privateBack], now)).toBe(false);
    expect(creditsPause({ ...pause, enabled: false }, 'claude', [work, privateOut], now)).toBe(false);
    expect(readAccountSettings({ outOfAllowance: 'pause' }).outOfAllowance).toBe('pause');
    expect(readAccountSettings({ outOfAllowance: 'x' }).outOfAllowance).toBe('use-credits');
  });
});
