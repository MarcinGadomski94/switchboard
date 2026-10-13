import { describe, expect, it } from 'vitest';
import type { AccountProfile } from '../../src/core/accounts.ts';
import type { SessionEvent, SystemInfo } from '../../src/core/api.ts';
import { usageGridLines } from '../../src/web/shell/format.ts';
import { droppedOrder, exhaustedText, movedOrder, signInStatusText, signInText, usageText } from '../../src/web/views/settings/accounts.ts';
import { SETTINGS_SECTIONS } from '../../src/web/views/settings/model.ts';
import { providerFields } from '../../src/web/modals/new-session.ts';
import { chatItems } from '../../src/web/views/session/chat.ts';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const soon = (ms: number): string => new Date(NOW + ms).toISOString();

function profile(extra: Partial<AccountProfile> = {}): AccountProfile {
  return { id: 'p', cli: 'claude', name: 'Work', dir: '/x', builtin: false, enabled: true, position: 1, shareSettings: true, signIn: 'unknown', account: null, usage: null, exhausted: null, signInCommand: 'claude auth login', sessions: 0, ...extra };
}

describe('D63 · Settings → Accounts (web)', () => {
  it('the section is in the nav, after CLIs', () => {
    const keys = SETTINGS_SECTIONS.map((s) => s.key);
    expect(keys.indexOf('accounts')).toBe(keys.indexOf('clis') + 1);
  });

  it('sign-in line: the CLI\'s own status, never a guess; the Default is "your own login" until it says', () => {
    expect(signInText({ signIn: 'signed-in', account: 'me@example.test · max', builtin: false })).toBe('signed in · me@example.test · max');
    expect(signInText({ signIn: 'signed-out', account: null, builtin: false })).toBe('signed out');
    expect(signInText({ signIn: 'unknown', account: null, builtin: false })).toBe('unknown');
    expect(signInText({ signIn: 'unknown', account: null, builtin: true })).toBe('your own login');
  });

  it('usage: only windows that have not reset; spent: until when and why', () => {
    const usage = { fiveHourPct: 61.6, fiveHourResetsAt: soon(3_600_000), sevenDayPct: 10, sevenDayResetsAt: soon(-1000), receivedAt: null };
    expect(usageText(usage, NOW)).toBe('5h 62%');
    expect(usageText({ ...usage, sevenDayResetsAt: soon(86_400_000) }, NOW)).toBe('5h 62% · week 10%');
    expect(usageText(null, NOW)).toBeNull();
    expect(usageText({ ...usage, fiveHourPct: null, sevenDayPct: null }, NOW)).toBeNull();
    expect(exhaustedText(profile())).toBeNull();
    expect(exhaustedText(profile({ exhausted: { until: soon(3_600_000), window: 'weekly', text: null } }))).toMatch(/^Out of usage until .+ \(weekly limit\)$/);
  });

  it('priority order: arrows move one place (clamped); a drop goes before the target or last', () => {
    expect(movedOrder(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(movedOrder(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(movedOrder(['a', 'b', 'c'], 'b', 5)).toEqual(['a', 'c', 'b']);
    expect(movedOrder(['a', 'b'], 'zz', 1)).toEqual(['a', 'b']);
    expect(droppedOrder(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(droppedOrder(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a']);
  });

  it('sign-in progress texts', () => {
    const base = { id: 's', profileId: 'p', cli: 'claude' as const, url: null, code: null, instructions: null, error: null, command: 'c', canPasteBack: false, startedAt: '', expiresAt: '' };
    expect(signInStatusText({ ...base, state: 'waiting', url: 'https://x' })).toContain('Finish the sign-in in the tab that opened');
    expect(signInStatusText({ ...base, state: 'waiting' })).toContain('Waiting for the CLI');
    expect(signInStatusText({ ...base, state: 'timeout' })).toBe('The sign-in was not finished in 5 minutes.');
    expect(signInStatusText({ ...base, state: 'done' })).toBe('Signed in.');
  });

  it('the new-session body carries the account only with a CLI', () => {
    expect(providerFields({ provider: 'claude', profileId: 'p' })).toEqual({ provider: 'claude', profileId: 'p' });
    expect(providerFields({ provider: 'claude', profileId: null })).toEqual({ provider: 'claude' });
    expect(providerFields({ provider: null, profileId: 'p' })).toEqual({});
  });
});

describe('D63 · the footer line and the chat divider (web)', () => {
  it('D66: each account of a CLI with more than one is a grid line: the active one marked, a spent one with its time', () => {
    const system = {
      accountUsage: [
        { profileId: 'default-claude', cli: 'claude', name: 'Default', active: false, pct: 98.2, exhaustedUntil: soon(3_600_000) },
        { profileId: 'b', cli: 'claude', name: 'Private', active: true, pct: 10, exhaustedUntil: null },
        { profileId: 'c', cli: 'codex', name: 'Work', active: true, pct: null, exhaustedUntil: null },
      ],
    } as unknown as SystemInfo;
    const lines = usageGridLines(system, NOW);
    // Every account gets a line (a Codex one with no known window too, ruling 2026-10-04); the other CLI's lines come after Claude Code's.
    expect(lines.map((l) => [l.label, l.outUntil?.replace(/\d\d:\d\d/, 'HH:MM') ?? null, l.active, l.spent, l.session.text])).toEqual([
      ['Default', 'out until HH:MM', false, true, '—'],
      ['Private', null, true, false, '—'],
      ['Codex Work', null, true, false, '—'],
    ]);
    // Without accountUsage: the single Claude line.
    expect(usageGridLines({} as SystemInfo, NOW).map((l) => l.key)).toEqual(['cli:claude']);
    expect(usageGridLines(null, NOW).map((l) => l.key)).toEqual(['cli:claude']);
  });

  it('a switch of account is a divider with both account names; a failed one is not', () => {
    const event = (id: number, kind: SessionEvent['kind'], label: string, payload: unknown): SessionEvent => ({ id, sessionId: 's', agentId: null, ts: `2026-10-01T00:00:0${id}.000Z`, endTs: null, kind, label, payload });
    const items = chatItems(
      [
        event(1, 'text', 'hello', { type: 'user', text: 'hello', origin: 'user', delivered: true }),
        event(2, 'text', 'Switched account: Default → Private (session limit, resets 14:05)', { type: 'lifecycle', action: 'account-switched', fromProfile: 'Default', toProfile: 'Private', reason: 'session limit, resets 14:05' }),
        event(3, 'error', 'Could not switch to the account Work: boom', { type: 'lifecycle', action: 'account-switched', message: 'boom' }),
      ],
      [],
      null,
    );
    expect(items.map((item) => item.kind)).toEqual(['user', 'divider']);
    expect(items[1]).toMatchObject({ kind: 'divider', text: 'Switched account: Default → Private (session limit, resets 14:05)', from: 'Default', to: 'Private' });
  });
});

describe('D98 · accounts shared across paired machines (web)', () => {
  it('Settings: the shared account says where else it is, a paired machine\'s reading and spent mark say whose; a peer-only account names its machines', async () => {
    const { peerAccountText, sharedText, sharedUsageText } = await import('../../src/web/views/settings/accounts.ts');
    const shared = profile({ elsewhere: [{ machineId: 'm1', machineName: 'Studio', profileId: 'x', name: 'Work' }] });
    expect(sharedText(shared, 'Desk')).toBe('Same account on Desk + Studio · its name, order and usage are shared');
    expect(sharedText(profile(), 'Desk')).toBeNull();
    const usage = { fiveHourPct: 62, fiveHourResetsAt: soon(3_600_000), sevenDayPct: 10, sevenDayResetsAt: soon(86_400_000), receivedAt: soon(-1_000) };
    expect(sharedUsageText(profile({ usage, usageFrom: 'Studio' }), NOW)).toBe('5h 62% · week 10% (from Studio)');
    expect(sharedUsageText(profile({ usage }), NOW)).toBe('5h 62% · week 10%');
    expect(exhaustedText(profile({ exhausted: { until: soon(3_600_000), window: 'session', text: null, machine: 'Studio' } }))).toMatch(/^Out of usage until .+ \(session limit, found on Studio\)$/);
    expect(peerAccountText({ account: 'lab@example.com · pro', machines: [{ id: 'm1', name: 'Studio', profileId: 'a' }, { id: 'm2', name: 'Laptop', profileId: 'b' }] })).toBe('lab@example.com · pro · on Studio + Laptop');
    expect(peerAccountText({ account: null, machines: [{ id: 'm1', name: 'Studio', profileId: 'a' }] })).toBe('on Studio');
  });

  it('the footer grid: rows carry their machines once a paired machine\'s accounts show; a newer reading from a paired machine replaces the meter\'s bars of the active account', () => {
    const windows = (pct: number) => [
      { key: 'session' as const, label: 'Session', pct, resetsAt: soon(3_600_000) },
      { key: 'week' as const, label: 'Week', pct: 5, resetsAt: soon(86_400_000) },
    ];
    const system = {
      usageWindows: windows(11),
      accountUsage: [
        { profileId: 'default-claude', cli: 'claude', name: 'Work', active: true, pct: 80, exhaustedUntil: null, windows: windows(80), machines: ['Desk', 'Studio'], windowsFrom: 'Studio' },
        { profileId: 'r~m1~lab', cli: 'claude', name: 'Lab', active: false, pct: 30, exhaustedUntil: null, windows: windows(30), machines: ['Studio'] },
      ],
    } as unknown as SystemInfo;
    const lines = usageGridLines(system, NOW);
    expect(lines.map((l) => [l.label, l.machines, l.session.text])).toEqual([
      ['Work', 'Desk + Studio', '80%'],
      ['Lab', 'Studio', '30%'],
    ]);
    expect(lines[0]?.title).toContain('On Desk + Studio · reading from Studio');
    // Without a paired machine's accounts nothing changes: no machines, the meter's bars.
    const alone = usageGridLines({ usageWindows: windows(11) } as unknown as SystemInfo, NOW);
    expect(alone.map((l) => [l.label, l.machines, l.session.text])).toEqual([['Claude', undefined, '11%']]);
  });
});
