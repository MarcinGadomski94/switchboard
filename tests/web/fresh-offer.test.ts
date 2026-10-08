import { describe, expect, it } from 'vitest';
import type { Session } from '../../src/core/api.ts';
import { FRESH_BUSY_REASON, FRESH_HOOKED_REASON } from '../../src/core/fresh-session.ts';
import { chatItems } from '../../src/web/views/session/chat.ts';
import { freshActionState, freshAsked, freshBusy, freshEligible, loadSnooze, markFreshAsked, saveSnooze, takeFreshAsked } from '../../src/web/views/session/fresh-offer.ts';

const ctx = { tokens: 170000, window: 200000, percent: 85, band: 'high' } as unknown as Session['context'];
const session = (overrides: Partial<Session> = {}): Session => ({ id: 's1', status: 'done', hooked: false, closedAt: null, attached: true, context: ctx, providerSwitch: null, accountSwitching: false, movedTo: null, freshContinue: null, ...overrides }) as Session;

function memory(): { getItem(key: string): string | null; setItem(key: string, value: string): void } {
  const map = new Map<string, string>();
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => void map.set(key, value) };
}

describe('D83 · the offer bar (UI rules)', () => {
  it('eligible: Switchboard runs it, open, attached, with a meter, nothing switching', () => {
    expect(freshEligible(session())).toBe(true);
    expect(freshEligible(session({ hooked: true }))).toBe(false);
    expect(freshEligible(session({ closedAt: '2026-10-08T10:00:00Z' }))).toBe(false);
    expect(freshEligible(session({ attached: false }))).toBe(false);
    expect(freshEligible(session({ context: null }))).toBe(false);
    expect(freshEligible(session({ accountSwitching: true }))).toBe(false);
    expect(freshEligible(null)).toBe(false);
  });

  it('busy while a turn runs or waits, or live activity shows', () => {
    expect(freshBusy(session({ status: 'run' }), null)).toBe(true);
    expect(freshBusy(session({ status: 'need' }), null)).toBe(true);
    expect(freshBusy(session(), { state: 'thinking' })).toBe(true);
    expect(freshBusy(session(), null)).toBe(false);
  });

  it('snoozes per session in storage; forgetting one keeps the others', () => {
    const storage = memory();
    expect(loadSnooze(storage, 's1')).toBeNull();
    saveSnooze(storage, 's1', 85);
    saveSnooze(storage, 's2', 90);
    expect(loadSnooze(storage, 's1')).toBe(85);
    saveSnooze(storage, 's1', null);
    expect(loadSnooze(storage, 's1')).toBeNull();
    expect(loadSnooze(storage, 's2')).toBe(90);
    expect(loadSnooze(null, 's2')).toBeNull();
  });

  it('the ⋯ menu: hidden for closed / moved, disabled with why for hooked, busy, switching', () => {
    expect(freshActionState(session())).toEqual({ shown: true, disabledReason: null });
    expect(freshActionState(session({ closedAt: 'x' })).shown).toBe(false);
    expect(freshActionState(session({ hooked: true }))).toEqual({ shown: true, disabledReason: FRESH_HOOKED_REASON });
    expect(freshActionState(session({ status: 'run' }))).toEqual({ shown: true, disabledReason: FRESH_BUSY_REASON });
    expect(freshActionState(session({ freshContinue: { step: 'handover' } })).disabledReason).toBe('Already continuing in a fresh session.');
  });

  it('remembers which sessions this tab asked to continue', () => {
    markFreshAsked('a');
    expect(freshAsked('a')).toBe(true);
    expect(takeFreshAsked('a')).toBe(true);
    expect(takeFreshAsked('a')).toBe(false);
  });

  it('the chat: "Continued from / in" dividers carry the other session', () => {
    const events = [
      { id: 1, sessionId: 's2', agentId: null, kind: 'text', label: 'Continued from Fix login', ts: '2026-10-08T10:00:00Z', payload: { type: 'lifecycle', action: 'continued-from', linkedSessionId: 's1' } },
      { id: 2, sessionId: 's2', agentId: null, kind: 'error', label: 'Could not continue in a fresh session: x', ts: '2026-10-08T10:00:01Z', payload: { type: 'lifecycle', action: 'continued-in', message: 'x' } },
    ] as unknown as Parameters<typeof chatItems>[0];
    const items = chatItems(events, [], null, []);
    expect(items.filter((item) => item.kind === 'divider')).toEqual([expect.objectContaining({ kind: 'divider', text: 'Continued from Fix login', linkedSessionId: 's1' })]);
  });
});
