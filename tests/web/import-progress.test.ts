import { describe, expect, it } from 'vitest';
import { importedItemStart, planDoneWithoutMerge } from '../../src/core/plans.ts';
import { importProgressView, newProgressId } from '../../src/web/v2/projects/import-progress.ts';

describe('D185 · a Jira import', () => {
  it('starts each item from its Jira status category; a done one is never told to Jira as merged', () => {
    expect(importedItemStart('done')).toEqual({ done: true, note: 'done in Jira' });
    expect(importedItemStart('indeterminate')).toEqual({ done: false, note: 'In progress in Jira' });
    expect(importedItemStart('new')).toEqual({ done: false, note: null });
    expect(importedItemStart(null)).toEqual({ done: false, note: null });
    expect(planDoneWithoutMerge('done in Jira')).toBe(true);
  });

  it('shows its progress in words and a bar that only moves forward', () => {
    const steps = [
      importProgressView({ step: 'reading', done: 0, total: 0 }),
      importProgressView({ step: 'creating', done: 0, total: 4 }),
      importProgressView({ step: 'creating', done: 2, total: 4 }),
      importProgressView({ step: 'creating', done: 4, total: 4 }),
      importProgressView({ step: 'statuses', done: 0, total: 4 }),
      importProgressView({ step: 'finishing', done: 4, total: 4 }),
      importProgressView({ step: 'done', done: 4, total: 4 }),
    ];
    expect(steps[2]?.text).toBe('Creating steps · 2 of 4');
    const fractions = steps.map((view) => view.fraction as number);
    for (let i = 1; i < fractions.length; i += 1) expect(fractions[i]).toBeGreaterThan(fractions[i - 1] as number);
    expect(steps.at(-1)).toMatchObject({ fraction: 1, finished: true, failed: false });
  });

  it('a failure says why, with no bar', () => {
    expect(importProgressView({ step: 'failed', done: 0, total: 0, message: 'PROJ-404 was not found' })).toEqual({ text: 'The import stopped: PROJ-404 was not found', fraction: null, failed: true, finished: true });
  });

  it('a progress id the server accepts', () => {
    expect(newProgressId()).toMatch(/^[A-Za-z0-9-]{1,64}$/);
  });
});
