import { describe, expect, it } from 'vitest';
import {
  FRESH_OFFER_PCT_CHOICES,
  continuationNumber,
  continuedFromLabel,
  continuedInLabel,
  freshName,
  freshOfferState,
  freshOfferText,
  freshTitle,
  keepSnooze,
} from '../../src/core/fresh-session.ts';
import { inheritPlace } from '../../src/core/sidebar-layout.ts';
import type { Session, SessionEvent } from '../../src/core/api.ts';
import { peerAnswerKind, peerEvent, peerSession } from '../../src/core/peer-wire.ts';
import { peerApiAllowed } from '../../src/server/peers/service.ts';

const base = { enabled: true, thresholdPct: 80, percent: 82, eligible: true, busy: false, snoozedAt: null };

describe('D83 · the offer', () => {
  it('shows at or past the threshold, on, eligible, between turns', () => {
    expect(freshOfferState(base)).toBe(true);
    expect(freshOfferState({ ...base, percent: 80 })).toBe(true);
    expect(freshOfferState({ ...base, percent: 79 })).toBe(false);
    expect(freshOfferState({ ...base, percent: null })).toBe(false);
    expect(freshOfferState({ ...base, enabled: false })).toBe(false);
    expect(freshOfferState({ ...base, eligible: false })).toBe(false);
    // Refused while a turn runs: offered after it ends.
    expect(freshOfferState({ ...base, busy: true })).toBe(false);
  });

  it('Not now snoozes until +10 points; a drop below the threshold forgets the snooze', () => {
    expect(freshOfferState({ ...base, snoozedAt: 82, percent: 91 })).toBe(false);
    expect(freshOfferState({ ...base, snoozedAt: 82, percent: 92 })).toBe(true);
    expect(keepSnooze(82, 90, 80)).toBe(82);
    expect(keepSnooze(82, 30, 80)).toBeNull();
    expect(keepSnooze(82, null, 80)).toBe(82);
    expect(keepSnooze(null, 90, 80)).toBeNull();
  });

  it('copy and choices', () => {
    expect(freshOfferText(82.4)).toBe('Context 82% — Continue in a fresh session');
    expect(continuedFromLabel('Fix login')).toBe('Continued from Fix login');
    expect(continuedInLabel('Fix login (2)')).toBe('Continued in Fix login (2)');
    expect(FRESH_OFFER_PCT_CHOICES).toEqual([50, 55, 60, 65, 70, 75, 80, 85, 90, 95]);
  });
});

describe('D83 · the fresh session’s name and title', () => {
  it('numbers the first continuation and counts on in a chain', () => {
    expect(freshTitle('Fix login', false, 2)).toBe('Fix login (2)');
    expect(freshTitle('Fix login (2)', true, 3)).toBe('Fix login (3)');
    // A title that happens to end in (n) without being continued keeps it.
    expect(freshTitle('Try (1)', false, 2)).toBe('Try (1) (2)');
    expect(freshTitle('x'.repeat(80), false, 2)).toHaveLength(80);
    expect(freshName('fix-login', false, 2)).toBe('fix-login-2');
    expect(freshName('fix-login-2', true, 3)).toBe('fix-login-3');
    expect(freshName('proj-3010', false, 2)).toBe('proj-3010-2');
    expect(freshName('a'.repeat(64), false, 2)).toHaveLength(64);
    expect(continuationNumber('Fix login (2)', true)).toBe(2);
    expect(continuationNumber('Fix login (2)', false)).toBe(1);
  });
});

describe('D83 · inheritPlace (the sidebar)', () => {
  const layout = { pinned: ['a', 'old'], folders: [{ id: 'f', name: 'F', collapsed: false, sessionIds: ['x'], parentId: null }], loose: ['y'] };
  it('takes the old session’s pin, folder or loose position', () => {
    expect(inheritPlace(layout, 'old', 'new')).toEqual({ ...layout, pinned: ['a', 'new'] });
    expect(inheritPlace(layout, 'x', 'new')?.folders[0]?.sessionIds).toEqual(['new']);
    expect(inheritPlace(layout, 'y', 'new')?.loose).toEqual(['new']);
  });
  it('nothing to do when the old one was never placed or the new one is placed', () => {
    expect(inheritPlace(layout, 'unplaced', 'new')).toBeNull();
    expect(inheritPlace(layout, 'old', 'a')).toBeNull();
  });
});

describe('D83 · a paired machine’s session', () => {
  const machine = { id: 'm1', name: 'Studio', state: 'online' as const };
  it('the route is on the peer API, answers a wrapped session; links and dividers are namespaced', () => {
    expect(peerApiAllowed('POST', '/api/sessions/s1/fresh')).toBe(true);
    expect(peerApiAllowed('GET', '/api/sessions/s1/fresh')).toBe(false);
    expect(peerAnswerKind('POST', '/api/sessions/s1/fresh')).toBe('wrapped');
    const session = peerSession(machine, { id: 's2', continuedFrom: { sessionId: 's1', title: 'Fix' }, continuedTo: null, loops: [] } as unknown as Session);
    expect(session.continuedFrom).toEqual({ sessionId: 'r~m1~s1', title: 'Fix' });
    expect(session.continuedTo).toBeNull();
    const event = peerEvent(machine, { id: 1, sessionId: 's2', payload: { type: 'lifecycle', action: 'continued-from', linkedSessionId: 's1' } } as unknown as SessionEvent);
    expect(event.payload).toMatchObject({ linkedSessionId: 'r~m1~s1' });
  });
});
