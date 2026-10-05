import { describe, expect, it } from 'vitest';
import { buildHistoryRows } from '../../src/core/history.ts';
import { HOOK_GRACE_MS, type TerminalFacts, judgeTerminal, messagesToResend, offersHookedContinue } from '../../src/core/hooked-continue.ts';
import { peerAnswerKind } from '../../src/core/peer-wire.ts';
import { peerApiAllowed } from '../../src/server/peers/service.ts';

/** D72 (pure): the terminal's liveness, the messages re-sent, who offers it, the History flag and the peer API. */

const CS = 'c0ffee00-1111-4222-8333-944455556666';
const NOW = Date.parse('2026-10-05T12:00:00.000Z');

function facts(extra: Partial<TerminalFacts> = {}): TerminalFacts {
  return { registry: [], claudeSessionId: CS, ended: false, hookPid: null, hookPidAlive: null, lastHookAt: null, now: NOW, ...extra };
}

describe('D72: judging the terminal', () => {
  it('listed by the registry: running, with the registry\'s pid', () => {
    expect(judgeTerminal(facts({ registry: [{ sessionId: 'other', pid: 7 }, { sessionId: CS, pid: 4242 }], hookPid: 99, hookPidAlive: false }))).toEqual({ state: 'running', pid: 4242 });
  });

  it('not listed: gone, unless a hook reported within the grace and its pid is alive or unknown', () => {
    expect(judgeTerminal(facts())).toEqual({ state: 'gone' });
    expect(judgeTerminal(facts({ lastHookAt: NOW - HOOK_GRACE_MS - 1 }))).toEqual({ state: 'gone' });
    expect(judgeTerminal(facts({ lastHookAt: NOW - 1_000 })).state).toBe('unknown');
    expect(judgeTerminal(facts({ lastHookAt: NOW - 1_000, hookPid: 12, hookPidAlive: true })).state).toBe('unknown');
    // Its pid is dead (the stop just ended it), or SessionEnd came: gone.
    expect(judgeTerminal(facts({ lastHookAt: NOW - 1_000, hookPid: 12, hookPidAlive: false }))).toEqual({ state: 'gone' });
    expect(judgeTerminal(facts({ lastHookAt: NOW - 1_000, ended: true }))).toEqual({ state: 'gone' });
  });

  it('registry unreadable: gone only on SessionEnd or a dead hook pid, else unknown (never assumed gone)', () => {
    expect(judgeTerminal(facts({ registry: null })).state).toBe('unknown');
    expect(judgeTerminal(facts({ registry: null, hookPid: 12, hookPidAlive: true })).state).toBe('unknown');
    expect(judgeTerminal(facts({ registry: null, hookPid: 12, hookPidAlive: false }))).toEqual({ state: 'gone' });
    expect(judgeTerminal(facts({ registry: null, ended: true }))).toEqual({ state: 'gone' });
  });
});

describe('D72: the messages the new process gets', () => {
  it('the mailbox, plus handed bubbles the transcript never showed (first), each text once', () => {
    expect(messagesToResend([], [])).toEqual([]);
    expect(messagesToResend([{ eventId: 1, text: 'a' }, { eventId: 2, text: 'b' }], ['a', 'b'])).toEqual(['a', 'b']);
    // `old` was handed to a waiter (no longer in the mailbox) and never reached the transcript.
    expect(messagesToResend([{ eventId: 1, text: 'old' }, { eventId: 2, text: 'new' }], ['new'])).toEqual(['old', 'new']);
    // Same text twice: each mailbox entry matches one bubble.
    expect(messagesToResend([{ eventId: 1, text: 'ok' }, { eventId: 2, text: 'ok' }], ['ok'])).toEqual(['ok', 'ok']);
    // A mailbox entry without a bubble (a stale question's answers) still goes.
    expect(messagesToResend([], ['answers'])).toEqual(['answers']);
  });
});

describe('D72: who offers it', () => {
  const base = { hooked: true, closedAt: null, movedTo: null, machine: null };
  it('an open hooked session (this machine\'s, or a reachable peer\'s)', () => {
    expect(offersHookedContinue(base)).toBe(true);
    expect(offersHookedContinue({ ...base, hooked: false })).toBe(false);
    expect(offersHookedContinue({ ...base, closedAt: '2026-10-05T00:00:00.000Z' })).toBe(false);
    expect(offersHookedContinue({ ...base, machine: { id: 'abcdefghijkl', name: 'pc', state: 'online' } })).toBe(true);
    expect(offersHookedContinue({ ...base, machine: { id: 'abcdefghijkl', name: 'pc', state: 'offline' } })).toBe(false);
  });

  it('History marks an open hooked session\'s row (not a closed one\'s)', () => {
    const session = (id: string, extra: Record<string, unknown>) => ({
      id,
      name: id,
      claudeSessionId: `${id}-cs`,
      status: 'idle' as const,
      task: '',
      workType: null,
      mode: null,
      phase: null,
      solutions: [],
      createdAt: '2026-10-05T10:00:00.000Z',
      worktrees: [],
      folder: null,
      folderPath: null,
      origin: 'terminal' as const,
      ...extra,
    });
    const rows = buildHistoryRows({ sessions: [session('open', { hooked: true }), session('shut', { hooked: true, closedAt: '2026-10-05T11:00:00.000Z' }), session('plain', {})], transcripts: [], roots: [], caseInsensitive: false, now: NOW });
    expect(Object.fromEntries(rows.map((row) => [row.item.name, row.item.hooked ?? false]))).toEqual({ open: true, shut: false, plain: false });
  });
});

describe('D72: the peer API', () => {
  it('allows the continue (runs on the terminal\'s machine) and maps its answer as a session', () => {
    expect(peerApiAllowed('POST', '/api/sessions/s1/continue-in-switchboard')).toBe(true);
    expect(peerApiAllowed('GET', '/api/sessions/s1/continue-in-switchboard')).toBe(false);
    expect(peerAnswerKind('POST', '/api/sessions/s1/continue-in-switchboard')).toBe('session');
  });
});
