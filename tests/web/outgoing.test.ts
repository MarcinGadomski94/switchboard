import { afterEach, describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../src/core/api.ts';
import {
  OUTGOING_SETTLE_MS,
  addOutgoing,
  dropOutgoing,
  matchOutgoing,
  outgoingOf,
  outgoingSent,
  resetOutgoing,
  settledOutgoing,
  subscribeOutgoing,
} from '../../src/web/views/session/outgoing.ts';

/**
 * Fix · queued send feedback (`src/web/views/session/outgoing.ts`): the messages
 * the composer showed as sent before the service answered, and how their own
 * events replace them (never two bubbles; one event stands for one message).
 */

function userEvent(id: number, text: string, extra: Record<string, unknown> = {}): SessionEvent {
  return { id, sessionId: 's1', agentId: null, ts: `2026-10-20T10:00:${String(id).padStart(2, '0')}.000Z`, endTs: null, kind: 'text', label: text, payload: { type: 'user', text, origin: 'user', delivered: false, ...extra } } as SessionEvent;
}

function agentEvent(id: number, text: string): SessionEvent {
  return { id, sessionId: 's1', agentId: null, ts: `2026-10-20T10:00:${String(id).padStart(2, '0')}.000Z`, endTs: null, kind: 'text', label: text, payload: { type: 'assistant', text } } as SessionEvent;
}

afterEach(() => resetOutgoing());

describe('the outgoing store', () => {
  it('keeps messages per session in order, marks them answered and drops them; listeners hear each change', () => {
    let changes = 0;
    const unsubscribe = subscribeOutgoing(() => {
      changes += 1;
    });
    const a = addOutgoing('s1', { text: 'first', attachments: [], queued: 'turn', afterId: 3 });
    const b = addOutgoing('s1', { text: 'second', attachments: [], queued: 'turn', afterId: 3 });
    addOutgoing('s2', { text: 'elsewhere', attachments: [], queued: null, afterId: 0 });
    expect(outgoingOf('s1').map((item) => [item.text, item.state])).toEqual([
      ['first', 'sending'],
      ['second', 'sending'],
    ]);
    const before = outgoingOf('s1');
    expect(outgoingOf('s1')).toBe(before); // stable until it changes
    outgoingSent('s1', a, 1_000);
    expect(outgoingOf('s1')[0]).toMatchObject({ state: 'sent', sentAt: 1_000 });
    dropOutgoing('s1', b);
    dropOutgoing('s1', 'unknown');
    expect(outgoingOf('s1').map((item) => item.text)).toEqual(['first']);
    expect(outgoingOf('s2').map((item) => item.text)).toEqual(['elsewhere']);
    expect(changes).toBe(5);
    unsubscribe();
  });
});

describe('matchOutgoing', () => {
  it('an event newer than the send with the same text replaces the message; an older one with that text does not', () => {
    addOutgoing('s1', { text: 'Keep it short.', attachments: [], queued: 'turn', afterId: 5 });
    const list = outgoingOf('s1');
    const older = matchOutgoing([userEvent(4, 'Keep it short.'), agentEvent(5, 'OK')], list);
    expect(older.shown.size).toBe(0);
    expect(older.waiting.map((item) => item.text)).toEqual(['Keep it short.']);
    const newer = matchOutgoing([userEvent(4, 'Keep it short.'), agentEvent(5, 'OK'), userEvent(6, 'Keep it short.', { queued: 'turn' })], list);
    expect([...newer.shown]).toEqual([list[0]?.key]);
    expect(newer.waiting).toEqual([]);
  });

  it('two sends of the same text need two events (each event stands for one message)', () => {
    addOutgoing('s1', { text: 'again', attachments: [], queued: 'turn', afterId: 1 });
    addOutgoing('s1', { text: 'again', attachments: [], queued: 'turn', afterId: 1 });
    const list = outgoingOf('s1');
    const one = matchOutgoing([userEvent(2, 'again')], list);
    expect(one.shown.size).toBe(1);
    expect(one.waiting).toHaveLength(1);
    expect(matchOutgoing([userEvent(2, 'again'), userEvent(3, 'again')], list).waiting).toEqual([]);
  });

  it('outbox notes the service put first count (the text ends the message); attachments-only messages match any new user event', () => {
    addOutgoing('s1', { text: 'Go on.', attachments: [], queued: 'turn', afterId: 0 });
    addOutgoing('s1', { text: '', attachments: [{ id: 'a1', name: 'shot.png', size: 10, kind: 'image', mediaType: '' }], queued: 'turn', afterId: 0 });
    const list = outgoingOf('s1');
    const result = matchOutgoing([userEvent(1, 'Switchboard restarted.\n\nGo on.'), userEvent(2, '')], list);
    expect(result.waiting).toEqual([]);
    // Not just any text ending with it.
    expect(matchOutgoing([userEvent(1, 'Please Go on.')], [list[0]!]).waiting).toHaveLength(1);
  });
});

describe('settledOutgoing', () => {
  it('an answered message goes once its event is shown, or after the settle time; one still sending stays', () => {
    const sending = addOutgoing('s1', { text: 'a', attachments: [], queued: 'turn', afterId: 0 });
    const shown = addOutgoing('s1', { text: 'b', attachments: [], queued: 'turn', afterId: 0 });
    const late = addOutgoing('s1', { text: 'c', attachments: [], queued: 'turn', afterId: 0 });
    outgoingSent('s1', shown, 1_000);
    outgoingSent('s1', late, 1_000);
    const list = outgoingOf('s1');
    expect(settledOutgoing(list, new Set([shown, sending]), 2_000)).toEqual([shown]);
    expect(settledOutgoing(list, new Set(), 1_000 + OUTGOING_SETTLE_MS)).toEqual([shown, late]);
  });
});
