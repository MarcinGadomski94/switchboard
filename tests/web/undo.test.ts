import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../src/core/api.ts';
import { type SessionCheckpoints, redoDivider, revertDivider } from '../../src/core/checkpoints.ts';
import { chatItems } from '../../src/web/views/session/chat.ts';
import { NO_CHECKPOINT, STOP_FIRST, checkpointsKey, lastTurnRevert, turnRevertFor } from '../../src/web/views/session/checkpoints.ts';

/** D80 (web): the chat's revert dividers, the turn action on each user bubble, *Undo last turn*. */

const event = (id: number, label: string, payload: unknown): SessionEvent => ({ id, sessionId: 's', agentId: null, ts: `2026-10-08T00:00:0${id}.000Z`, endTs: null, kind: 'text', label, payload });

function checkpoints(extra: Partial<SessionCheckpoints> = {}): SessionCheckpoints {
  return {
    enabled: true,
    unsupported: null,
    turns: [
      { turn: 1, eventId: 1, createdAt: '', repos: ['/r'], firstLine: 'one' },
      { turn: 2, eventId: 4, createdAt: '', repos: ['/r'], firstLine: 'two' },
    ],
    latestTurn: 2,
    running: false,
    redo: null,
    ...extra,
  };
}

describe('D80: the chat', () => {
  it('a revert and its Redo are dividers (the conversation is not rewound)', () => {
    const items = chatItems(
      [
        event(1, 'one', { type: 'user', text: 'one', origin: 'user', delivered: true }),
        event(2, revertDivider(1), { type: 'lifecycle', action: 'reverted', turn: 1, latestTurn: 1 }),
        event(3, redoDivider(1), { type: 'lifecycle', action: 'revert-undone', turn: 1, latestTurn: 1 }),
      ],
      [],
      null,
    );
    expect(items.map((item) => item.kind)).toEqual(['user', 'divider', 'divider']);
    expect(items[1]).toMatchObject({ text: 'Reverted to before turn 1', revert: 'reverted' });
    expect(items[2]).toMatchObject({ text: 'Undid the revert to before turn 1', revert: 'undone' });
  });

  it('the turn action: the turn when it has a checkpoint, disabled with the reason otherwise; nothing before the read', () => {
    expect(turnRevertFor(null, 1)).toBeNull();
    expect(turnRevertFor(checkpoints(), 4)).toEqual({ turn: 2, reason: null });
    expect(turnRevertFor(checkpoints(), 9)).toEqual({ turn: null, reason: NO_CHECKPOINT });
    expect(turnRevertFor(checkpoints({ running: true }), 1)).toEqual({ turn: 1, reason: STOP_FIRST });
    expect(turnRevertFor(checkpoints({ turns: [], unsupported: 'not a repo' }), 1)).toEqual({ turn: null, reason: 'not a repo' });
  });

  it('Undo last turn (ruling D80-q1): the newest turn when it has a checkpoint, else disabled with the reason; none before any turn', () => {
    expect(lastTurnRevert(checkpoints())).toEqual({ turn: 2, reason: null });
    expect(lastTurnRevert(checkpoints({ running: true }))).toEqual({ turn: 2, reason: STOP_FIRST });
    // The newest turn (3) has no checkpoint, earlier ones do: disabled, saying why.
    expect(lastTurnRevert(checkpoints({ latestTurn: 3 }))).toEqual({ turn: null, reason: NO_CHECKPOINT });
    expect(lastTurnRevert(checkpoints({ turns: [], unsupported: 'not a repo' }))).toEqual({ turn: null, reason: 'not a repo' });
    expect(lastTurnRevert(checkpoints({ turns: [], latestTurn: 0 }))).toBeNull();
    expect(lastTurnRevert(null)).toBeNull();
  });
});

describe('D95 · when the chat reads the checkpoints again', () => {
  const ev = (id: number, payload: unknown): SessionEvent => ({ id, sessionId: 's', agentId: null, ts: `2026-10-10T10:00:${String(id).padStart(2, '0')}.000Z`, endTs: null, kind: 'text', label: '', payload }) as SessionEvent;
  const user = (id: number, extra: object = {}) => ev(id, { type: 'user', text: 'hi', origin: 'user', delivered: true, ...extra });
  it('a new turn, a withdrawn or no longer queued message, a revert divider and the status change the key; other events do not', () => {
    const base = [user(1), ev(2, { type: 'assistant', text: 'a', messageId: null })];
    const key = checkpointsKey(base, 'run');
    expect(checkpointsKey([...base, ev(3, { type: 'tool', name: 'Read', toolUseId: 't', input: {} })], 'run')).toBe(key);
    expect(checkpointsKey([...base, ev(3, { type: 'result', isError: false })], 'run')).toBe(key);
    expect(checkpointsKey(base, 'done')).not.toBe(key);
    expect(checkpointsKey([...base, user(4)], 'run')).not.toBe(key);
    expect(checkpointsKey([user(1, { withdrawn: true }), base[1] as SessionEvent], 'run')).not.toBe(key);
    expect(checkpointsKey([user(1, { queued: 'turn' }), base[1] as SessionEvent], 'run')).not.toBe(key);
    expect(checkpointsKey([...base, ev(5, { type: 'lifecycle', action: 'reverted' })], 'run')).not.toBe(key);
  });
});
