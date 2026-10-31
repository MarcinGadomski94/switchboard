import { describe, expect, it } from 'vitest';
import { PLAN_OVER_STATES, type PlanState, planIsOver, splitPlansByDone } from '../../src/core/plans.ts';

/** D150 · the Projects list's Done section: which plans are over, and their order. */

function plan(id: string, state: PlanState, createdAt: string, finishedAt: string | null = null) {
  return { id, state, createdAt, finishedAt };
}

describe('D150 · splitPlansByDone', () => {
  it('done and cancelled are over; draft, running and paused are active', () => {
    expect(PLAN_OVER_STATES).toEqual(['done', 'cancelled']);
    expect((['draft', 'running', 'paused', 'done', 'cancelled'] as const).map((state) => planIsOver({ state }))).toEqual([false, false, false, true, true]);
  });

  it('keeps the active ones in the order given; the done ones newest finished first', () => {
    const plans = [
      plan('run', 'running', '2026-10-01T00:00:00Z'),
      plan('old-done', 'done', '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z'),
      plan('draft', 'draft', '2026-10-02T00:00:00Z'),
      plan('cancelled', 'cancelled', '2026-09-01T00:00:00Z', '2026-10-20T00:00:00Z'),
      plan('paused', 'paused', '2026-10-03T00:00:00Z'),
      plan('no-finish', 'done', '2026-10-10T00:00:00Z'),
    ];
    const split = splitPlansByDone(plans);
    expect(split.active.map((p) => p.id)).toEqual(['run', 'draft', 'paused']);
    expect(split.done.map((p) => p.id)).toEqual(['cancelled', 'no-finish', 'old-done']);
  });

  it('nothing over: an empty Done', () => {
    expect(splitPlansByDone([plan('a', 'draft', '2026-10-01T00:00:00Z')]).done).toEqual([]);
  });
});
