/**
 * D122 · Plan PRs and commits reference only their own ticket, and D121's done classification:
 * the brief's rule next to the D118 context, the key filter for PR titles / branch slugs, the
 * developer's Merge commit message; which done items the auto-repair re-checks.
 */
import { describe, expect, it } from 'vitest';
import { doneByGitDetection, otherKeysIn, planItemBrief, planMergeMessage, planOwnKeyRule, withoutOtherKeys } from '../../src/core/plans.ts';

const base = { planTitle: 'PROJ-10 Acme epic', targetBranch: 'feature/PROJ-10-acme-epic', notes: null, key: 'PROJ-1', branch: 'PROJ-1-cart', developerMerges: false, todo: { id: 't1', title: 'Cart', description: null, plan: null } } as const;

describe('D122 · the brief: only the own ticket key in PRs, branches and commits', () => {
  it('states the rule for the item key, right after the D118 context (which keeps the other keys)', () => {
    const context = 'Jira context\nEpic PROJ-10 Acme epic. Depends on PROJ-2 (Cart API).';
    const brief = planItemBrief({ ...base, context });
    const rule = planOwnKeyRule('PROJ-1');
    expect(rule).toContain("only this item's own ticket key, PROJ-1");
    for (const words of ['pull request title', 'pull request description', 'branch name', 'commit message', 'not the epic, not a dependency, not a related ticket', 'without its key']) expect(rule).toContain(words);
    expect(brief).toContain(`${context}\n\n${rule}`);
    // The context's keys stay (the agent needs them).
    expect(brief).toContain('PROJ-2 (Cart API)');
    expect(brief.split(rule)).toHaveLength(2);
  });

  it('is in the brief without a context, also for a plan without a merge step, and says "no key" for an item without one', () => {
    expect(planItemBrief(base)).toContain(planOwnKeyRule('PROJ-1'));
    expect(planItemBrief({ ...base, targetBranch: null, noMerge: true, branch: null })).toContain(planOwnKeyRule('PROJ-1'));
    expect(planItemBrief({ ...base, key: null })).toContain('may name no ticket key at all');
  });

  it("the developer's Merge commit message names only the item's key", () => {
    expect(planMergeMessage('PROJ-1')).toBe("Merge PROJ-1 into the plan's target");
    expect(otherKeysIn(planMergeMessage('PROJ-1'), 'PROJ-1')).toEqual([]);
    expect(otherKeysIn(planMergeMessage(null), null)).toEqual([]);
  });

  it('withoutOtherKeys drops every other key and keeps the own one', () => {
    expect(withoutOtherKeys('Cart page (follow-up of PROJ-2)', 'PROJ-1')).toBe('Cart page (follow-up of)');
    expect(withoutOtherKeys('PROJ-1 Cart page for PROJ-10', 'PROJ-1')).toBe('PROJ-1 Cart page for');
    expect(withoutOtherKeys('PROJ-10: Cart page', 'PROJ-1')).toBe('Cart page');
    expect(withoutOtherKeys('Cart page', 'PROJ-1')).toBe('Cart page');
    expect(otherKeysIn('PROJ-1 Cart page for PROJ-10 and ACME-7', 'PROJ-1')).toEqual(['PROJ-10', 'ACME-7']);
  });
});

describe('D121 · which done items the auto-repair re-checks', () => {
  it("git-detected done items only: not the developer's Merge, not Mark done", () => {
    expect(doneByGitDetection({ state: 'done', note: null })).toBe(true);
    expect(doneByGitDetection({ state: 'done', note: 'merged into feature/PROJ-10-acme-epic without your Merge' })).toBe(true);
    expect(doneByGitDetection({ state: 'done', note: 'no remote or gh: counted as merged into feature/x without reading checks' })).toBe(true);
    expect(doneByGitDetection({ state: 'done', note: 'merged by you into feature/PROJ-10-acme-epic' })).toBe(false);
    expect(doneByGitDetection({ state: 'done', note: 'marked done by the developer' })).toBe(false);
    expect(doneByGitDetection({ state: 'running', note: null })).toBe(false);
  });
});
