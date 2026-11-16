import { describe, expect, it } from 'vitest';
import type { SessionTodo } from '../../src/core/api.ts';
import type { Plan } from '../../src/core/plans.ts';
import { estimateText } from '../../src/web/v2/agents/tasks/tasks-model.ts';
import { estimatesTile } from '../../src/web/v2/insights/insights-model.ts';
import { timeLeft, timeLeftDetail, timeLeftTitle } from '../../src/web/v2/projects/project-model.ts';
import { timeLeftText } from '../../src/web/plans/model.ts';

/** D167: what the v2 cards, the project header and Insights show from the learned estimates. */

const NOW = Date.parse('2026-11-16T12:00:00.000Z');

function plan(extra: Partial<Plan> = {}): Pick<Plan, 'estimatedMinutesLeft' | 'state' | 'estimate'> {
  return { state: 'running', estimatedMinutesLeft: 70, estimate: { likelyMinutesLeft: 70, rawMinutesLeft: 540, reviewsLeft: 2, reviewWaitMinutes: 20, answerWaitMinutes: null, basis: 'folder', sampleSize: 30 }, ...extra } as Pick<Plan, 'estimatedMinutesLeft' | 'state' | 'estimate'>;
}

describe('the project time left', () => {
  it('about 1.2h left · agents estimated 9h · + your 2 reviews (~20m each)', () => {
    expect(timeLeft(plan())).toBe('about 1.2h left');
    expect(timeLeftDetail(plan())).toBe('agents estimated 9h · + your 2 reviews (~20m each)');
    expect(timeLeftTitle(plan())).toBe('Corrected by what Switchboard learned from 30 finished tasks in this folder');
    expect(timeLeftText(plan() as Plan)).toBe('~1.2h left (agents: 9h)');
  });

  it('nothing learned yet, or an older machine: the line reads as before', () => {
    const none = plan({ estimate: { likelyMinutesLeft: 540, rawMinutesLeft: 540, reviewsLeft: 0, reviewWaitMinutes: null, answerWaitMinutes: null, basis: 'none', sampleSize: 0 }, estimatedMinutesLeft: 540 });
    expect(timeLeftDetail(none)).toBeNull();
    expect(timeLeftTitle(none)).toBeUndefined();
    expect(timeLeftDetail({ state: 'running', estimatedMinutesLeft: 60 })).toBeNull();
  });
});

describe('the task card', () => {
  const todo = (extra: Partial<SessionTodo>): SessionTodo => ({ state: 'open', estimateMinutes: 90, actualMs: null, startedAt: null, workingMs: null, workingSince: null, workingShare: null, ...extra }) as SessionTodo;
  it('not done: likely ~12m (est 1h 30m); done: took vs est as before', () => {
    expect(estimateText(todo({ likely: { minutes: 12, factor: 0.13, basis: 'folder', sampleSize: 30 } }), NOW)).toBe('likely ~12m (est 1h 30m)');
    expect(estimateText(todo({ likely: { minutes: 90, factor: 1, basis: 'none', sampleSize: 2 } }), NOW)).toBe('est 1h 30m');
    expect(estimateText(todo({ state: 'done', likely: { minutes: 12, factor: 0.13, basis: 'folder', sampleSize: 30 }, actualMs: 600_000, workingMs: 600_000 }), NOW)).toBe('est 1h 30m · took 10m');
  });
});

describe('Insights', () => {
  const buckets = (within: number, outside: number) => [
    { key: 'under-half' as const, label: '< 0.5×', count: outside },
    { key: 'half-to-one' as const, label: '0.5–1×', count: within },
    { key: 'one-to-two' as const, label: '1–2×', count: 0 },
    { key: 'over-two' as const, label: '> 2×', count: 0 },
  ];
  it('the tile shows the corrected accuracy with the raw one, and the weekly learning', () => {
    const view = estimatesTile({ count: 10, buckets: buckets(1, 9), correctedAccuracy: { count: 10, buckets: buckets(8, 2), corrected: 8, trend: [{ correctedPct: 40 }, { correctedPct: 80 }, { correctedPct: 90 }] } });
    expect(view.value).toBe(0.8);
    expect(view.raw).toBe(0.1);
    expect(view.learning).toBe('Corrected by what Switchboard learned: 80% within ½–2× (raw 10%) · weekly 40% → 80% → 90%');
    expect(estimatesTile({ count: 10, buckets: buckets(1, 9) })).toEqual({ value: 0.1, raw: 0.1, learning: null });
  });
});
