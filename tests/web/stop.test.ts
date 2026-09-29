import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../src/core/api.ts';
import { STOP_LABEL, STOPPING_LABEL, STOP_TOOLTIP } from '../../src/core/stop-turn.ts';
import { chatItems, chatMessages, stepMark } from '../../src/web/views/session/chat.ts';
import { canStop, escStops, stoppableBackground } from '../../src/web/views/session/stop.ts';
import type { BackgroundTask } from '../../src/core/api.ts';

/**
 * D50 · Stop in the composer (`docs/chat.md` → *Stop*): when ■ Stop replaces
 * Send (`canStop`), when Esc stops the turn and when it belongs to something else
 * (`escStops`: an open popover / dialog / menu closes first, another text field
 * keeps its Esc, no turn = nothing), and what the chat shows: no bubble for a
 * withdrawn message, the "■ Stopped" line, the ✕ line of a Stop that timed out.
 */

const MAIN = 'agent-main';
let clock = 0;

function event(id: number, payload: unknown, extra: Partial<SessionEvent> = {}): SessionEvent {
  clock += 1;
  return {
    id,
    sessionId: 's',
    agentId: MAIN,
    ts: `2026-09-29T10:00:${String(clock).padStart(2, '0')}.000Z`,
    endTs: null,
    kind: 'text',
    label: '',
    payload,
    ...extra,
  };
}

describe('canStop', () => {
  it('a live session that runs a turn or waits on the developer; not background-only work, not idle / done / paused, not without a process', () => {
    expect(canStop({ live: true, status: 'run', activity: { state: 'thinking' } })).toBe(true);
    // A message waits for its turn (no activity yet).
    expect(canStop({ live: true, status: 'run', activity: null })).toBe(true);
    expect(canStop({ live: true, status: 'need', activity: { state: 'waiting' } })).toBe(true);
    // D30 / D43: only background work: no turn to stop.
    expect(canStop({ live: true, status: 'run', activity: { state: 'background' } })).toBe(false);
    for (const status of ['idle', 'done', 'fail', 'paused'] as const) expect(canStop({ live: true, status, activity: null })).toBe(false);
    expect(canStop({ live: false, status: 'run', activity: null })).toBe(false);
    expect(canStop(null)).toBe(false);
  });
});

describe('escStops', () => {
  const press = (overrides: Partial<Parameters<typeof escStops>[0]> = {}) => ({
    key: 'Escape',
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    ...overrides,
  });
  const free = { stoppable: true, stopping: false, overlayOpen: false, editingElsewhere: false };

  it('Esc stops a running turn when nothing else owns the key (the composer\'s own field included)', () => {
    expect(escStops(press(), free)).toBe(true);
  });

  it('an open popover / dialog / menu closes first; another text field keeps its Esc', () => {
    expect(escStops(press(), { ...free, overlayOpen: true })).toBe(false);
    expect(escStops(press(), { ...free, editingElsewhere: true })).toBe(false);
  });

  it('no turn running, or a Stop already waiting: nothing', () => {
    expect(escStops(press(), { ...free, stoppable: false })).toBe(false);
    expect(escStops(press(), { ...free, stopping: true })).toBe(false);
  });

  it('other keys, modifiers (Ctrl+C stays copy), an IME composing, or a handler that took it: nothing', () => {
    expect(escStops(press({ key: 'c', ctrlKey: true }), free)).toBe(false);
    expect(escStops(press({ key: 'Enter' }), free)).toBe(false);
    expect(escStops(press({ ctrlKey: true }), free)).toBe(false);
    expect(escStops(press({ metaKey: true }), free)).toBe(false);
    expect(escStops(press({ shiftKey: true }), free)).toBe(false);
    expect(escStops(press({ altKey: true }), free)).toBe(false);
    expect(escStops(press({ isComposing: true }), free)).toBe(false);
    expect(escStops(press({ defaultPrevented: true }), free)).toBe(false);
  });

  it('the button copy', () => {
    expect(STOP_LABEL).toBe('Stop');
    expect(STOPPING_LABEL).toBe('Stopping…');
    expect(STOP_TOOLTIP).toBe('Stop the current turn (Esc)');
  });
});

describe('the chat after a Stop', () => {
  it('a withdrawn message has no bubble; the stopped result is the "■ Stopped" step line; a timed-out Stop is a ✕ line', () => {
    const task = event(1, { type: 'user', text: 'Task.', origin: 'task', delivered: true });
    const withdrawn = event(2, { type: 'user', text: 'Queued.', origin: 'user', delivered: false, withdrawn: true });
    const agent = event(3, { type: 'assistant', text: 'Working…', messageId: 'm1' });
    const stopped = event(4, { type: 'result', subtype: 'error_during_execution', isError: true, text: null, terminalReason: 'aborted_streaming', errors: [], taskNotification: false, numTurns: 1, durationMs: 10, costUsd: 0, stopped: true }, { label: 'Stopped' });
    const timeout = event(5, { type: 'stop', outcome: 'timeout', waitedMs: 5000, missing: 'ack' }, { kind: 'error', label: 'Stop: the agent did not stop within 5 s. Pause ends the process.' });
    const events = [task, withdrawn, agent, stopped, timeout];

    expect(stepMark(stopped)).toBe('■');
    expect(stepMark(timeout)).toBe('✕');
    const items = chatItems(events, [], MAIN);
    expect(items.map((item) => item.kind)).toEqual(['user', 'agent', 'agent']);
    expect(items.filter((item) => item.kind === 'user').map((item) => item.text)).toEqual(['Task.']);
    const block = items[1];
    expect(block?.kind === 'agent' ? block.steps.map((step) => `${step.mark} ${step.label}`) : []).toEqual(['■ Stopped']);
    const after = items[2];
    expect(after?.kind === 'agent' ? after.steps.map((step) => `${step.mark} ${step.label}`) : []).toEqual([
      '✕ Stop: the agent did not stop within 5 s. Pause ends the process.',
    ]);
    expect(chatMessages(events).map((message) => message.text)).toEqual(['Task.', 'Working…']);
  });

  it('a failed turn that was not stopped stays a ✕ line', () => {
    const failed = event(1, { type: 'result', subtype: 'error_during_execution', isError: true, text: null, terminalReason: 'aborted_streaming', errors: [], taskNotification: false, numTurns: 1, durationMs: 10, costUsd: 0 });
    expect(stepMark(failed)).toBe('✕');
  });
});

describe('D48 P4 and the background offer (D50 rulings)', () => {
  const bash: BackgroundTask = { id: 'b1', toolUseId: 't1', kind: 'bash', summary: 'npm run dev', startedAt: '2026-09-29T10:00:00.000Z', github: false };
  const wakeup: BackgroundTask = { id: 't2', toolUseId: 't2', kind: 'wakeup', summary: 'check CI', startedAt: '2026-09-29T10:00:01.000Z', wakeAt: '2026-09-29T10:05:00.000Z', github: false };

  it('a hooked terminal session never offers Stop (its turns are stopped in the terminal)', () => {
    expect(canStop({ live: true, status: 'run', activity: { state: 'thinking' }, hooked: true })).toBe(false);
    expect(canStop({ live: true, status: 'run', activity: { state: 'thinking' }, hooked: false })).toBe(true);
  });

  it('Stop background tasks: only while no turn runs and background tasks wait; not for wake-ups only, a hooked session or without a process', () => {
    const waiting = { live: true, status: 'done' as const, activity: { state: 'background', background: [bash, wakeup] } };
    expect(stoppableBackground(waiting)).toEqual([bash, wakeup]);
    expect(stoppableBackground({ ...waiting, activity: { state: 'background', background: [wakeup] } })).toEqual([]);
    expect(stoppableBackground({ ...waiting, hooked: true })).toEqual([]);
    expect(stoppableBackground({ ...waiting, live: false })).toEqual([]);
    // A turn runs: that is Stop's (the list is then the turn's, not offered).
    expect(stoppableBackground({ live: true, status: 'run', activity: { state: 'thinking', background: [bash] } })).toEqual([]);
    expect(stoppableBackground(null)).toEqual([]);
  });
});
