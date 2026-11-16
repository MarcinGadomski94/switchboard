import { describe, expect, it } from 'vitest';
import type { LearningSample } from '../../src/core/estimate-learning.ts';
import { correctedAccuracy } from '../../src/core/insights.ts';
import { type Plan, type PlanItemFacts, type PlanLearning, planEstimateNote, planStatusText, planView } from '../../src/core/plans.ts';

/**
 * D167 (`docs/plans.md` → *Self-correcting time left*): the plan's time left from the items'
 * learned likely durations (critical path and concurrency as before), a running item's working
 * time, the raw figure kept, and the developer's reviews apart; Insights' corrected accuracy.
 */

const NOW = Date.parse('2026-11-16T12:00:00.000Z');

function item(id: string, extra: Partial<PlanItemFacts> = {}): PlanItemFacts {
  return {
    id,
    todoId: `t-${id}`,
    key: null,
    title: id,
    hold: false,
    solutions: [],
    state: 'pending',
    reason: null,
    note: null,
    waitingOn: null,
    runSessionId: null,
    branch: null,
    prUrl: null,
    checks: null,
    conflicts: 0,
    estimateMinutes: 120,
    position: 0,
    startedAt: null,
    waitingSince: null,
    mergedAt: null,
    doneAt: null,
    sessionStatus: null,
    ...extra,
  };
}

const LEARNING: PlanLearning = { basis: 'folder', sampleSize: 30, reviewWaitMinutes: 20, answerWaitMinutes: 8 };

describe('the self-correcting time left', () => {
  it('a 9h plan whose steps learned ≈0.13× reads about 1h 10m; the raw 9h is kept', () => {
    // Three chains of 3h each (raw), 3 slots: 3h raw; with likely 24m per 3h step… five steps of 108m raw, 14m likely.
    const items = ['a', 'b', 'c', 'd', 'e'].map((id, i) => item(id, { estimateMinutes: 108, likelyMinutes: 14, position: i }));
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'd' },
      { from: 'd', to: 'e' },
    ];
    const view = planView({ mode: 'developer', targetBranch: 'dev', maxConcurrency: 3, items, edges, now: NOW, learning: LEARNING });
    expect(view.estimate?.rawMinutesLeft).toBe(540);
    expect(view.estimatedMinutesLeft).toBe(70);
    expect(view.estimate).toMatchObject({ likelyMinutesLeft: 70, reviewsLeft: 5, reviewWaitMinutes: 20, basis: 'folder', sampleSize: 30 });
    expect(view.criticalPath.minutes).toBe(70);
  });

  it('concurrency spreads the corrected work like the raw one', () => {
    const items = Array.from({ length: 6 }, (_, i) => item(`i${i}`, { estimateMinutes: 90, likelyMinutes: 12, position: i }));
    const view = planView({ mode: 'agents', targetBranch: 'dev', maxConcurrency: 3, items, edges: [], now: NOW, learning: LEARNING });
    expect(view.estimatedMinutesLeft).toBe(24);
    expect(view.estimate?.rawMinutesLeft).toBe(180);
    // Agents merge: no review waits for the developer.
    expect(view.estimate?.reviewsLeft).toBe(0);
  });

  it('a running item counts its working time so far, not the wall clock (nights it waited)', () => {
    const running = item('r', { state: 'running', startedAt: new Date(NOW - 10 * 3600_000).toISOString(), estimateMinutes: 120, likelyMinutes: 30, workedMinutes: 20, sessionStatus: 'run' });
    const view = planView({ mode: 'agents', targetBranch: 'dev', maxConcurrency: 3, items: [running], edges: [], now: NOW, learning: LEARNING });
    expect(view.estimatedMinutesLeft).toBe(10);
  });

  it('without learning the plan reads as before (raw estimates, wall clock), no estimate field', () => {
    const items = [item('x', { estimateMinutes: 90, likelyMinutes: 12 })];
    const view = planView({ mode: 'agents', targetBranch: 'dev', maxConcurrency: 3, items, edges: [], now: NOW });
    expect(view.estimatedMinutesLeft).toBe(90);
    expect(view.estimate).toBeUndefined();
  });

  it('plan_status tells the agent the corrected time, the raw one, the reviews and each item’s likely time', () => {
    const items = [item('a', { estimateMinutes: 90, likelyMinutes: 12 })];
    const view = planView({ mode: 'developer', targetBranch: 'dev', maxConcurrency: 3, items, edges: [], now: NOW, learning: LEARNING });
    expect(planEstimateNote(view.estimate)).toBe(' (agents estimated 90 min; learned from 30 finished in this folder; + 1 review by the developer, ~20 min each)');
    const plan = { id: 'p', title: 'P', state: 'running', mergeMode: 'developer', targetBranch: 'dev', baseBranch: 'dev', allowProtectedTarget: false, repos: [], held: null, progress: view.progress, estimatedMinutesLeft: view.estimatedMinutesLeft, estimate: view.estimate, items: view.items } as unknown as Plan;
    const text = planStatusText(plan);
    expect(text).toContain('about 12 min left (agents estimated 90 min');
    expect(text).toContain('est 90m → likely 12m');
  });
});

describe('Insights: the corrected estimates’ accuracy', () => {
  it('judged with what was learned before each item: the raw estimates mostly miss, the corrected ones land', () => {
    const at = (i: number): string => new Date(Date.parse('2026-11-02T08:00:00.000Z') + i * 6 * 3600_000).toISOString();
    const history: LearningSample[] = Array.from({ length: 30 }, (_, i) => ({ estimateMinutes: 90, workingMinutes: 90 * (0.1 + (i % 5) / 100), folder: '/ws', provider: 'claude', model: 'opus', completedAt: at(i) }));
    const todos = history.map((sample) => ({ estimateMinutes: sample.estimateMinutes, workingMs: sample.workingMinutes * 60_000, actualMs: sample.workingMinutes * 60_000, folder: '/ws', provider: 'claude', model: 'opus', completedAt: sample.completedAt }));
    const result = correctedAccuracy(todos, history);
    expect(result?.count).toBe(30);
    // The first 5 had no history yet: their raw estimate stands.
    expect(result?.corrected).toBe(25);
    const within = (result?.buckets ?? []).filter((b) => b.key === 'half-to-one' || b.key === 'one-to-two').reduce((sum, b) => sum + b.count, 0);
    expect(within).toBe(25);
    expect(result?.trend.length).toBeGreaterThanOrEqual(2);
    expect(result?.trend.at(-1)?.correctedPct).toBe(100);
    expect(result?.trend.at(-1)?.rawPct).toBe(0);
    expect(correctedAccuracy([], history)).toBeNull();
  });
});
