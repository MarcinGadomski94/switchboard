import { describe, expect, it } from 'vitest';
import type { OwnedLoop, Session } from '../../src/core/api.ts';
import { chatItems } from '../../src/web/views/session/chat.ts';
import { EMPTY_LOOP_DRAFT, draftFromLoop, draftInput, localInput, ownedLoopCards, runsText } from '../../src/web/views/owned-loops.ts';

/** D94: the Switchboard loop cards and the New loop… / Edit form (`src/web/views/owned-loops.ts`). */

const local = (hour: number, minute = 0, day = 9): Date => new Date(2026, 9, day, hour, minute, 0, 0);
const NOW = local(10);

function loop(overrides: Partial<OwnedLoop> = {}): OwnedLoop {
  return {
    id: 'a1b2c3d4e5',
    sessionId: 's1',
    label: 'CI watch',
    title: 'CI watch',
    prompt: 'Check CI.\nThen report.',
    schedule: { kind: 'every', minutes: 30 },
    scheduleText: 'every 30 min',
    expiresAt: null,
    maxRuns: null,
    state: 'active',
    endedReason: null,
    runs: 12,
    skipped: 1,
    lastFiredAt: local(9, 30).toISOString(),
    lastError: null,
    nextFireAt: local(10, 30).toISOString(),
    createdBy: 'agent',
    createdAt: '2026-10-09T07:00:00.000Z',
    updatedAt: '2026-10-09T07:00:00.000Z',
    ...overrides,
  };
}

function session(loops: OwnedLoop[], overrides: Partial<Session> = {}): Session {
  return { id: 's1', name: 'ci-session', title: 'CI babysitter', status: 'idle', createdAt: '2026-10-09T06:00:00.000Z', loops: [], ownedLoops: loops, ...overrides } as unknown as Session;
}

describe('ownedLoopCards', () => {
  it('one card per loop that has not ended: schedule, exact next, expiry ("no expiry"), runs (+ skipped), state', () => {
    const cards = ownedLoopCards([session([loop(), loop({ id: 'b', state: 'ended', endedReason: 'expired' }), loop({ id: 'c', state: 'paused', nextFireAt: null, expiresAt: local(10, 0, 12).toISOString(), maxRuns: 20, skipped: 0, createdAt: '2026-10-09T08:00:00.000Z' })])], NOW);
    expect(cards.map((card) => [card.id, card.sessionName, card.title, card.promptLine, card.stateText, card.facts.map((fact) => `${fact.k}=${fact.v}`)])).toEqual([
      ['a1b2c3d4e5', 'CI babysitter', 'CI watch', 'Check CI.', 'active', ['Schedule=every 30 min', 'Next=10:30', 'Expires=no expiry', 'Runs=12 (1 skipped)']],
      ['c', 'CI babysitter', 'CI watch', 'Check CI.', 'paused', ['Schedule=every 30 min', 'Next=paused', 'Expires=in 3 days', 'Runs=12 of 20']],
    ]);
    expect(ownedLoopCards([session([loop({ state: 'ended', endedReason: 'session closed' })])], NOW, { includeEnded: true })[0]?.stateText).toBe('ended: session closed');
    expect(runsText({ runs: 0, maxRuns: null, skipped: 0 })).toBe('0');
  });
});

describe('the New loop… / Edit form', () => {
  it('turns the fields into an OwnedLoopInput, or says what is wrong', () => {
    expect(draftInput({ ...EMPTY_LOOP_DRAFT, prompt: ' Check ' }, NOW)).toEqual({ ok: true, input: { prompt: 'Check', everyMinutes: 30, expiresAt: null, maxRuns: null, label: null } });
    expect(draftInput({ ...EMPTY_LOOP_DRAFT, prompt: 'x', kind: 'cron', cron: '0 9 * * 1-5', maxRuns: '5', label: 'Mornings' }, NOW)).toEqual({ ok: true, input: { prompt: 'x', cron: '0 9 * * 1-5', expiresAt: null, maxRuns: 5, label: 'Mornings' } });
    expect(draftInput({ ...EMPTY_LOOP_DRAFT, prompt: 'x', kind: 'at', at: '2026-10-09T15:00', expires: '2026-10-10T00:00' }, NOW)).toEqual({
      ok: true,
      input: { prompt: 'x', at: local(15).toISOString(), expiresAt: local(0, 0, 10).toISOString(), maxRuns: null, label: null },
    });
    for (const [draft, words] of [
      [EMPTY_LOOP_DRAFT, 'Write the prompt'],
      [{ ...EMPTY_LOOP_DRAFT, prompt: 'x', every: '0' }, 'Every:'],
      [{ ...EMPTY_LOOP_DRAFT, prompt: 'x', kind: 'cron', cron: '* *' }, 'Cron:'],
      [{ ...EMPTY_LOOP_DRAFT, prompt: 'x', kind: 'at', at: '2026-10-09T09:00' }, 'Once at:'],
      [{ ...EMPTY_LOOP_DRAFT, prompt: 'x', expires: '2026-10-09T09:00' }, 'Expires:'],
      [{ ...EMPTY_LOOP_DRAFT, prompt: 'x', maxRuns: 'many' }, 'Max runs:'],
    ] as const) {
      const checked = draftInput(draft, NOW);
      expect(checked.ok).toBe(false);
      expect(checked.ok ? '' : checked.error).toContain(words);
    }
  });

  it('Edit starts from the loop', () => {
    expect(draftFromLoop(loop({ expiresAt: local(18).toISOString(), maxRuns: 4 }))).toEqual({ prompt: 'Check CI.\nThen report.', kind: 'every', every: '30', cron: '', at: '', expires: '2026-10-09T18:00', maxRuns: '4', label: 'CI watch' });
    expect(localInput(null)).toBe('');
  });
});

describe('the chat', () => {
  it('a firing carries its loop mark to the bubble (the chip)', () => {
    const items = chatItems([{ id: 1, sessionId: 's1', agentId: null, ts: '2026-10-09T08:00:00.000Z', endTs: null, kind: 'text', label: 'Check CI.', payload: { type: 'user', text: 'Check CI.', origin: 'service', delivered: true, loop: { id: 'a1b2c3d4e5', label: 'CI watch', run: 12 } } }], [], null);
    expect(items[0]).toMatchObject({ kind: 'user', origin: 'service', loop: { label: 'CI watch', run: 12 } });
  });
});
