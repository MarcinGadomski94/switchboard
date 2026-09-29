import { describe, expect, it } from 'vitest';
import { QueueTracker } from '../../src/core/derive/queued.ts';
import { deriveSessionStatus } from '../../src/core/derive/status.ts';
import { TURN_STOPPED_REASON, closedBatchText } from '../../src/core/session-close.ts';
import { interruptLine } from '../../src/core/stdin.ts';
import { STOPPED_LABEL, isInterruptedResult, stopTimeoutText, withdrawnDraft } from '../../src/core/stop-turn.ts';

/**
 * D50 · Stop the current turn: the pure rules (`src/core/stop-turn.ts`), the
 * interrupt line with `cancel_queued`, the queue withdrawal (`QueueTracker.withdraw`)
 * and the `stopped` outcome in the status derivation.
 */

describe('interruptLine (D7 / D50)', () => {
  it('plain for Pause; with cancel_queued for Stop', () => {
    expect(interruptLine('r1')).toEqual({ type: 'control_request', request_id: 'r1', request: { subtype: 'interrupt' } });
    expect(interruptLine('r2', { cancelQueued: true })).toEqual({ type: 'control_request', request_id: 'r2', request: { subtype: 'interrupt', cancel_queued: true } });
    expect(interruptLine('r3', { cancelQueued: false }).request).toEqual({ subtype: 'interrupt' });
  });
});

describe('isInterruptedResult', () => {
  it('aborted_streaming / aborted_tools, or error_during_execution without a reason; never a success or another error', () => {
    expect(isInterruptedResult({ subtype: 'error_during_execution', isError: true, terminalReason: 'aborted_streaming' })).toBe(true);
    expect(isInterruptedResult({ subtype: 'error_during_execution', isError: true, terminalReason: 'aborted_tools' })).toBe(true);
    expect(isInterruptedResult({ subtype: 'error_during_execution', isError: true, terminalReason: null })).toBe(true);
    expect(isInterruptedResult({ subtype: 'error_during_execution', isError: true, terminalReason: 'model_error' })).toBe(false);
    expect(isInterruptedResult({ subtype: 'error_max_turns', isError: true, terminalReason: null })).toBe(false);
    expect(isInterruptedResult({ subtype: 'success', isError: false, terminalReason: 'completed' })).toBe(false);
  });
});

describe('withdrawnDraft', () => {
  it('the withdrawn messages in order, blank-line separated; text already in the field comes after them', () => {
    expect(withdrawnDraft(['One.'], '')).toBe('One.');
    expect(withdrawnDraft(['One.', 'Two.'], '')).toBe('One.\n\nTwo.');
    expect(withdrawnDraft(['One.', 'Two.'], 'Typed meanwhile')).toBe('One.\n\nTwo.\n\nTyped meanwhile');
    expect(withdrawnDraft([], 'Typed')).toBe('Typed');
    expect(withdrawnDraft(['One.', '  '], '   ')).toBe('One.');
  });
});

describe('copy', () => {
  it('the Stopped line, the timeout line, the closed batch label', () => {
    expect(STOPPED_LABEL).toBe('Stopped');
    expect(stopTimeoutText(5_000)).toBe('Stop: the agent did not stop within 5 s. Pause ends the process.');
    expect(stopTimeoutText(400)).toBe('Stop: the agent did not stop within 1 s. Pause ends the process.');
    expect(closedBatchText(TURN_STOPPED_REASON)).toBe('Closed · turn stopped');
  });
});

describe('QueueTracker.withdraw (D50)', () => {
  it('takes back every message no turn started on, oldest first; one a turn started on stays; later init / replay never pick a withdrawn one', () => {
    const queue = new QueueTracker();
    queue.sent(1, 'running', null);
    expect(queue.turnStarted()).toBeNull();
    queue.sent(2, 'a', 'turn');
    queue.sent(3, 'b', 'turn');
    expect(queue.withdraw()).toEqual([
      { eventId: 2, text: 'a', wasQueued: true },
      { eventId: 3, text: 'b', wasQueued: true },
    ]);
    expect(queue.queued()).toEqual([]);
    // The running message's echo still delivers it.
    expect(queue.replayed('running')).toEqual({ eventId: 1, wasQueued: false, absorbed: false });
    // A late echo of a withdrawn one: delivered after all, flagged.
    expect(queue.replayed('b')).toEqual({ eventId: 3, wasQueued: false, absorbed: true, withdrawn: true });
    expect(queue.turnStarted()).toBeNull();
    expect(queue.replayed('unknown')).toBeNull();
  });

  it('the next message forgets the withdrawn ones; so does the process end', () => {
    const queue = new QueueTracker();
    queue.sent(1, 'a', null);
    expect(queue.withdraw()).toEqual([{ eventId: 1, text: 'a', wasQueued: false }]);
    queue.sent(2, 'b', null);
    // 'a' is no longer matched: an echo with its text now takes the oldest pending message.
    expect(queue.replayed('a')).toEqual({ eventId: 2, wasQueued: false, absorbed: true });
    queue.sent(3, 'c', 'turn');
    queue.withdraw();
    expect(queue.ended()).toEqual([]);
    expect(queue.replayed('c')).toBeNull();
  });
});

describe('deriveSessionStatus · a stopped turn (D50)', () => {
  it('live: idle after a stopped turn, unless something still runs or waits; ended: done', () => {
    const live = { live: true as const, openRequests: 0, turnRunning: false, runningAgents: 0, lastOutcome: 'stopped' as const };
    expect(deriveSessionStatus(live)).toBe('idle');
    expect(deriveSessionStatus({ ...live, runningAgents: 1 })).toBe('run');
    expect(deriveSessionStatus({ ...live, turnRunning: true })).toBe('run');
    expect(deriveSessionStatus({ ...live, openRequests: 1 })).toBe('need');
    expect(deriveSessionStatus({ live: false, stopReason: null, exitCode: 0, signal: null, spawnFailed: false, lastOutcome: 'stopped' })).toBe('done');
    expect(deriveSessionStatus({ live: false, stopReason: 'pause', exitCode: 1, signal: null, spawnFailed: false, lastOutcome: 'stopped' })).toBe('paused');
  });
});
