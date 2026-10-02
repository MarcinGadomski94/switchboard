import { describe, expect, it } from 'vitest';
import type { SessionActivity } from '../../src/core/api.ts';
import { chatActivityLine, formatQuiet, sessionActivityLabel, staleHint, waitingText } from '../../src/web/activity/activity.ts';
import { hookedQueuedNote } from '../../src/web/views/session/chat.ts';
import { hookedDeliveryNote, hooksOutdatedNote } from '../../src/web/views/session/session-header.ts';

/** D53: a hooked session's live line (the staleness hint, waiting for permission) and its queued message's words. */

const START = '2026-09-29T10:00:00.000Z';
const t0 = Date.parse(START);
const at = (seconds: number): number => t0 + seconds * 1000;
const iso = (seconds: number): string => new Date(at(seconds)).toISOString();

function activity(fields: Partial<SessionActivity> = {}): SessionActivity {
  return { turnStartedAt: START, state: 'thinking', since: START, tool: null, summary: null, thinkingTokens: null, agents: {}, background: [], ...fields };
}

describe('the staleness hint (D53)', () => {
  it('formatQuiet: minutes, then hours', () => {
    expect(formatQuiet(3 * 60_000 + 59_000)).toBe('3m');
    expect(formatQuiet(65 * 60_000)).toBe('1h 5m');
  });

  it('a running turn quiet for 3 minutes adds `no activity for 3m` to the chat line and the sidebar row', () => {
    const quiet = activity({ state: 'tool', since: iso(10), tool: 'Bash', summary: 'npm test', quietSince: iso(10) });
    expect(chatActivityLine(quiet, at(10 + 179))).toEqual({ state: 'tool', glyph: '●', text: 'Bash: npm test', time: '2:59', tokens: null });
    expect(chatActivityLine(quiet, at(10 + 180))).toMatchObject({ text: 'Bash: npm test', time: '3:00', stale: 'no activity for 3m' });
    expect(sessionActivityLabel(quiet, at(10 + 300))).toMatchObject({ text: 'Bash: npm test', stale: 'no activity for 5m' });
    expect(staleHint(activity({ quietSince: iso(0) }), at(240))).toBe('no activity for 4m');
  });

  it('never for a supervised session (no quietSince) nor while waiting for the developer', () => {
    expect(chatActivityLine(activity(), at(3600)).stale).toBeUndefined();
    expect(chatActivityLine(activity({ state: 'waiting', tool: 'Bash', quietSince: iso(0) }), at(3600)).stale).toBeUndefined();
  });
});

describe('waiting for permission (D53)', () => {
  it('a hooked session\'s held PermissionRequest names its tool; a supervised wait reads as before', () => {
    expect(waitingText('Bash')).toBe('Waiting for permission: Bash');
    expect(waitingText(null)).toBe('Waiting for you');
    expect(chatActivityLine(activity({ state: 'waiting', since: iso(5), tool: 'Bash', summary: 'rm -rf dist' }), at(17))).toEqual({
      state: 'waiting',
      glyph: '⏸',
      text: 'Waiting for permission: Bash',
      time: '0:12',
      tokens: null,
    });
    expect(chatActivityLine(activity({ state: 'waiting', since: iso(5) }), at(17)).text).toBe('Waiting for you');
  });
});

describe('what a queued message waits on (D53)', () => {
  it('hooked sessions only; nothing when the delivery needs no words', () => {
    expect(hookedQueuedNote({ hooked: true, hookStatus: { waiter: false, hookSeen: false, delivery: 'no-waiter' } })).toBe(
      'No hook listening yet — type anything in that terminal once (the hooks were installed after this session started)',
    );
    expect(hookedQueuedNote({ hooked: true, hookStatus: { waiter: true, hookSeen: true, delivery: 'handed' } })).toBe('Waiting for the session to take it up (delivered to its hook)');
    expect(hookedQueuedNote({ hooked: true, hookStatus: { waiter: true, hookSeen: true, delivery: null } })).toBeNull();
    expect(hookedQueuedNote({ hooked: false, hookStatus: { waiter: false, hookSeen: false, delivery: 'ended' } })).toBeNull();
    expect(hookedQueuedNote(null)).toBeNull();
  });

  it('the header note adds only the unusual cases (no hook listening, ended)', () => {
    expect(hookedDeliveryNote({ hooked: true, hookStatus: { waiter: false, hookSeen: true, delivery: 'no-waiter' } })).toContain('No hook listening yet');
    expect(hookedDeliveryNote({ hooked: true, hookStatus: { waiter: false, hookSeen: true, delivery: 'ended' } })).toBe('Session ended');
    expect(hookedDeliveryNote({ hooked: true, hookStatus: { waiter: false, hookSeen: true, delivery: 'waiter-stopped' } })).toBe(
      'The hook stopped listening (it expired or Switchboard restarted) — it re-arms at the next turn; update the hooks to prevent this',
    );
    expect(hookedDeliveryNote({ hooked: true, hookStatus: { waiter: true, hookSeen: true, delivery: 'turn' } })).toBeNull();
  });

  it('outdated hooks add their own note, with the machine name; up-to-date ones none', () => {
    const status = { waiter: true, hookSeen: true, delivery: null, hooksOutdated: true } as const;
    expect(hooksOutdatedNote({ hooked: true, hookStatus: status })).toBe('Hooks are outdated on this machine — Update hooks so idle sessions stay reachable');
    expect(hooksOutdatedNote({ hooked: true, hookStatus: status, machine: { name: 'Studio PC' } })).toBe('Hooks are outdated on Studio PC — Update hooks so idle sessions stay reachable');
    expect(hooksOutdatedNote({ hooked: true, hookStatus: { ...status, hooksOutdated: false } })).toBeNull();
    expect(hooksOutdatedNote({ hooked: false, hookStatus: status })).toBeNull();
  });
});
