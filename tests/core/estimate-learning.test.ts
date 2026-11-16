import { describe, expect, it } from 'vitest';
import {
  LEARNING_CLAMP,
  LEARNING_MIN,
  type LearningSample,
  type ReviewWaitSample,
  agentEstimateText,
  buildEstimateModel,
  correctedAtTheTime,
  learnReviewWaits,
  learnedFactor,
  learningLine,
  likelyMinutes,
  likelyText,
  reviewWaitKind,
} from '../../src/core/estimate-learning.ts';

/**
 * D167 (`docs/todos.md` → *Self-correcting estimates*): the learned correction. Fixtures shaped
 * like the developer's real history (6 Notatio projects, 50 steps measured in working time, at
 * 0.09–0.15× their estimates, aggregate ≈ 0.13×).
 */

const T0 = Date.parse('2026-11-01T08:00:00.000Z');

function sample(estimate: number, ratio: number, index: number, extra: Partial<LearningSample> = {}): LearningSample {
  return { estimateMinutes: estimate, workingMinutes: estimate * ratio, folder: '/ws/notatio', provider: 'claude', model: 'opus', completedAt: new Date(T0 + index * 60_000).toISOString(), ...extra };
}

/** 50 steps estimated 30–240 min that took 0.09–0.15× (the evidence). */
function evidence(): LearningSample[] {
  return Array.from({ length: 50 }, (_, i) => sample([30, 60, 90, 120, 180, 240][i % 6] as number, 0.09 + (i % 7) / 100, i));
}

describe('the learned factor', () => {
  it('learns ≈0.13× from the evidence and corrects a 9h estimate to about 1h 10m', () => {
    const model = buildEstimateModel(evidence());
    const nine = likelyMinutes(model, 540, { folder: '/ws/notatio' });
    expect(nine.basis).toBe('folder');
    expect(nine.factor).toBeGreaterThan(0.09);
    expect(nine.factor).toBeLessThan(0.16);
    expect(nine.minutes).toBeGreaterThanOrEqual(49);
    expect(nine.minutes).toBeLessThanOrEqual(86);
    expect(nine.sampleSize).toBeGreaterThanOrEqual(LEARNING_MIN);
    // A 90m estimate: likely ~12m.
    expect(likelyMinutes(model, 90, { folder: '/ws/notatio' }).minutes).toBeLessThanOrEqual(14);
  });

  it('too little history: no correction (the estimate stands, basis none)', () => {
    const model = buildEstimateModel(evidence().slice(0, LEARNING_MIN - 1));
    expect(likelyMinutes(model, 90, { folder: '/ws/notatio' })).toEqual({ minutes: 90, factor: 1, basis: 'none', sampleSize: LEARNING_MIN - 1 });
    expect(learnedFactor([])).toBeNull();
  });

  it('a folder with its own history uses it; a folder without falls back to every folder', () => {
    const fast = Array.from({ length: 8 }, (_, i) => sample(60, 0.13, i, { folder: '/ws/a' }));
    const slow = Array.from({ length: 8 }, (_, i) => sample(60, 1.2, i + 20, { folder: '/ws/b' }));
    const model = buildEstimateModel([...fast, ...slow]);
    expect(likelyMinutes(model, 60, { folder: '/ws/a' })).toMatchObject({ basis: 'folder', minutes: 8 });
    expect(likelyMinutes(model, 60, { folder: '/ws/b' })).toMatchObject({ basis: 'folder', minutes: 72 });
    expect(likelyMinutes(model, 60, { folder: '/ws/new' }).basis).toBe('global');
  });

  it('a band without enough history uses the folder’s other bands', () => {
    const small = Array.from({ length: 6 }, (_, i) => sample(30, 0.2, i));
    const model = buildEstimateModel(small);
    // 120 min is in the 1–4 h band, which has nothing: the folder's whole history answers.
    expect(likelyMinutes(model, 120, { folder: '/ws/notatio' })).toMatchObject({ basis: 'folder', minutes: 24 });
  });

  it('a CLI / model that estimates differently gets its own factor; one that agrees keeps the group’s', () => {
    const opus = Array.from({ length: 12 }, (_, i) => sample(60, 0.13, i, { model: 'opus' }));
    const sonnet = Array.from({ length: 6 }, (_, i) => sample(60, 0.6, i + 30, { model: 'sonnet' }));
    const model = buildEstimateModel([...opus, ...sonnet]);
    const sonnetLikely = likelyMinutes(model, 60, { folder: '/ws/notatio', provider: 'claude', model: 'sonnet' });
    expect(sonnetLikely.basis).toBe('model');
    expect(sonnetLikely.minutes).toBe(36);
    expect(likelyMinutes(model, 60, { folder: '/ws/notatio', provider: 'claude', model: 'opus' }).basis).toBe('folder');
  });

  it('the factor is clamped', () => {
    expect(learnedFactor(Array.from({ length: 6 }, (_, i) => sample(600, 0.001, i)))).toBe(LEARNING_CLAMP[0]);
    expect(learnedFactor(Array.from({ length: 6 }, (_, i) => sample(10, 40, i)))).toBe(LEARNING_CLAMP[1]);
  });

  it('recent items weigh more: a change in how agents estimate shows within a few items', () => {
    const old = Array.from({ length: 10 }, (_, i) => sample(60, 1, i));
    const recent = Array.from({ length: 10 }, (_, i) => sample(60, 0.2, i + 100));
    expect(likelyMinutes(buildEstimateModel([...old, ...recent]), 60, { folder: '/ws/notatio' }).minutes).toBe(12);
  });

  it('a median: one item that ran long does not drag every estimate', () => {
    const steady = Array.from({ length: 9 }, (_, i) => sample(60, 0.15, i));
    const stuck = sample(60, 5, 50);
    expect(likelyMinutes(buildEstimateModel([...steady, stuck]), 60, { folder: '/ws/notatio' }).minutes).toBe(9);
  });

  it('no look-ahead: an item is corrected only by what finished before it', () => {
    const history = evidence();
    const first = history[0] as LearningSample;
    expect(correctedAtTheTime(first, history).basis).toBe('none');
    const late = history[49] as LearningSample;
    expect(correctedAtTheTime(late, history).basis).toBe('folder');
  });
});

describe('the words', () => {
  const model = buildEstimateModel(evidence());
  it('cards and agents see the likely time next to the estimate', () => {
    const likely = likelyMinutes(model, 90, { folder: '/ws/notatio' });
    expect(likelyText(90, likely)).toBe(`likely ~${likely.minutes}m (est 1h 30m)`);
    expect(likelyText(90, { minutes: 90, basis: 'none' })).toBe('est ~1h 30m');
    expect(agentEstimateText(90, likely)).toBe(`est 90m → likely ${likely.minutes}m`);
  });

  it('the agent’s line says what was learned and that Switchboard corrects it', () => {
    const line = learningLine(model, { folder: '/ws/notatio' }) as string;
    expect(line).toMatch(/^Learned from 30 finished in this folder: estimates take 0\.1\d×/);
    expect(line).toContain('est 90m → likely');
    expect(line).toContain('Switchboard shows the corrected time');
    expect(learningLine(buildEstimateModel([]), {})).toBeNull();
  });
});

describe('the developer’s waits', () => {
  const at = (minute: number): string => new Date(T0 + minute * 60_000).toISOString();
  it('a span that ends with the item’s merge or done is a review; anything else an answer', () => {
    expect(reviewWaitKind({ endedAt: at(10) }, { mergedAt: at(11), doneAt: null })).toBe('review');
    expect(reviewWaitKind({ endedAt: at(10) }, { mergedAt: null, doneAt: at(10) })).toBe('review');
    expect(reviewWaitKind({ endedAt: at(10) }, { mergedAt: at(40), doneAt: null })).toBe('answer');
  });

  it('the median per kind, the folder’s when it has enough, else every folder’s; none without data', () => {
    const waits = (folder: string, kind: 'review' | 'answer', minutes: number[]): ReviewWaitSample[] => minutes.map((m, i) => ({ minutes: m, kind, folder, endedAt: at(i) }));
    const samples = [...waits('/a', 'review', [10, 20, 30, 40, 50]), ...waits('/b', 'review', [100, 200, 300, 400, 500]), ...waits('/a', 'answer', [5, 6, 7])];
    expect(learnReviewWaits(samples, '/a')).toMatchObject({ reviewMinutes: 30, answerMinutes: null, basis: 'folder' });
    expect(learnReviewWaits(samples, '/c')).toMatchObject({ reviewMinutes: 75, basis: 'global' });
    expect(learnReviewWaits([], '/a')).toEqual({ reviewMinutes: null, answerMinutes: null, basis: 'none', sampleSize: 0 });
  });
});
