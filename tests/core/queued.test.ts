import { describe, expect, it } from 'vitest';
import { QueueTracker, queuedReason, withoutQueued } from '../../src/core/derive/queued.ts';
import type { UserPayload } from '../../src/core/event-payload.ts';

/**
 * D44 (`docs/derivations.md` → *Queued messages*): which messages written to a
 * process the agent has not taken up yet. The CLI takes a stdin message up when a
 * turn starts on it (`system/init`) or when a running turn absorbs it (its replay,
 * mid-turn); its replay comes at the latest just before that turn's first
 * assistant line.
 */

describe('queuedReason', () => {
  it('sent idle → never queued; sent while a turn runs → turn; sent to a session without a process → resume', () => {
    expect(queuedReason({ turnRunning: false, resuming: false })).toBeNull();
    expect(queuedReason({ turnRunning: true, resuming: false })).toBe('turn');
    expect(queuedReason({ turnRunning: false, resuming: true })).toBe('resume');
    // A process started for the message runs nothing yet; if it did, the running turn is what the message waits for.
    expect(queuedReason({ turnRunning: true, resuming: true })).toBe('turn');
  });
});

describe('QueueTracker', () => {
  it('sent mid-turn: queued until the next turn starts on it (init), then delivered by its replay', () => {
    const queue = new QueueTracker();
    queue.sent(1, 'first', null);
    // The first message's turn starts; it never waited.
    expect(queue.turnStarted()).toBeNull();
    // Written while that turn runs.
    queue.sent(2, 'second', 'turn');
    expect(queue.queued()).toEqual([{ eventId: 2, reason: 'turn' }]);
    // The first message's replay (just before its first assistant line) changes nothing for the second.
    expect(queue.replayed('first')).toEqual({ eventId: 1, wasQueued: false, absorbed: false });
    expect(queue.queued()).toEqual([{ eventId: 2, reason: 'turn' }]);
    // After the first turn's result, the next init starts the second message's turn: its clock goes.
    expect(queue.turnStarted()).toBe(2);
    expect(queue.queued()).toEqual([]);
    // Its replay then only delivers it.
    expect(queue.replayed('second')).toEqual({ eventId: 2, wasQueued: false, absorbed: false });
  });

  it('a replay without an init (a running turn absorbed the message at a tool boundary) takes it up too: absorbed, no result of its own', () => {
    const queue = new QueueTracker();
    queue.sent(1, 'first', null);
    expect(queue.turnStarted()).toBeNull();
    queue.sent(2, 'second', 'turn');
    expect(queue.replayed('second')).toEqual({ eventId: 2, wasQueued: true, absorbed: true });
    expect(queue.queued()).toEqual([]);
    expect(queue.replayed('first')).toEqual({ eventId: 1, wasQueued: false, absorbed: false });
    expect(queue.replayed('none')).toBeNull();
  });

  it('two messages merged into one turn: the one echoed before its turn started is absorbed; the other is taken up by the init', () => {
    const queue = new QueueTracker();
    queue.sent(1, 'running', null);
    queue.turnStarted();
    queue.replayed('running');
    queue.sent(2, 'b', 'turn');
    queue.sent(3, 'c', 'turn');
    // The CLI takes b and c into one turn: c is echoed at once, then the turn's init, then b's echo.
    expect(queue.replayed('c')).toEqual({ eventId: 3, wasQueued: true, absorbed: true });
    expect(queue.turnStarted()).toBe(2);
    expect(queue.replayed('b')).toEqual({ eventId: 2, wasQueued: false, absorbed: false });
  });

  it('a first message whose replay never came does not hold the next one back: each init takes the oldest message no turn started on', () => {
    const queue = new QueueTracker();
    queue.sent(1, 'interrupted', null);
    expect(queue.turnStarted()).toBeNull();
    queue.sent(2, 'next', 'turn');
    queue.sent(3, 'after that', 'turn');
    expect(queue.turnStarted()).toBe(2);
    expect(queue.queued()).toEqual([{ eventId: 3, reason: 'turn' }]);
    expect(queue.turnStarted()).toBe(3);
    expect(queue.turnStarted()).toBeNull();
  });

  it('a replay whose text differs (whitespace) delivers the oldest pending message', () => {
    const queue = new QueueTracker();
    queue.sent(1, 'a', 'turn');
    queue.sent(2, 'b', 'turn');
    expect(queue.replayed('a ')).toEqual({ eventId: 1, wasQueued: true, absorbed: true });
    expect(queue.queued()).toEqual([{ eventId: 2, reason: 'turn' }]);
  });

  it('resume: a message the resumed process has not taken up yet waits until its turn starts', () => {
    const queue = new QueueTracker();
    queue.sent(7, 'Are you there?', 'resume');
    expect(queue.queued()).toEqual([{ eventId: 7, reason: 'resume' }]);
    expect(queue.turnStarted()).toBe(7);
    expect(queue.queued()).toEqual([]);
  });

  it('the process ends: the messages still queued lose the clock (never taken up), the others are forgotten', () => {
    const queue = new QueueTracker();
    queue.sent(1, 'running', null);
    queue.turnStarted();
    queue.sent(2, 'waiting', 'turn');
    queue.sent(3, 'waiting too', 'turn');
    expect(queue.ended()).toEqual([2, 3]);
    expect(queue.queued()).toEqual([]);
    expect(queue.replayed('running')).toBeNull();
  });
});

describe('withoutQueued', () => {
  it('drops `queued` and keeps every other field; a payload without it is returned as is', () => {
    const queued: UserPayload = { type: 'user', text: 'hi', origin: 'user', delivered: false, queued: 'turn' };
    expect(withoutQueued(queued)).toEqual({ type: 'user', text: 'hi', origin: 'user', delivered: false });
    expect('queued' in withoutQueued(queued)).toBe(false);
    const plain: UserPayload = { type: 'user', text: 'hi', origin: 'user', delivered: true };
    expect(withoutQueued(plain)).toBe(plain);
  });
});
