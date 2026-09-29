import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BRANCH_BASE,
  TASK_ONLY,
  branchPart,
  branchingLines,
  checkBranchName,
  checkEpicKey,
  cutPoint,
  epicBranchName,
  isValidBranchName,
  parseSymrefHead,
  tidyEpicKey,
} from '../../src/core/branching.ts';
import { type SessionStartAnswers, agentWorktreesInstruction, repoWorktreeNote, sessionStartBlock } from '../../src/core/first-turn.ts';

/** D40: the epic/task branching rules (`src/core/branching.ts`) and the hand-off lines. */

const EPIC = 'feature/PROJ-3010-Platform-tracking-and-KPI-delivery-process-development';

describe('epicBranchName (D40)', () => {
  it('derives feature/<KEY>-<Summary>, keeping the summary casing, spaces → -', () => {
    expect(epicBranchName('PROJ-3010', 'Platform tracking and KPI delivery process development')).toBe(EPIC);
    expect(epicBranchName('PROJ-3010', '  Mixed CASE  summary ')).toBe('feature/PROJ-3010-Mixed-CASE-summary');
  });

  it('drops the characters git forbids, merges runs of -, trims', () => {
    expect(epicBranchName('PROJ-1', 'Fix: login ~ flow? * [beta] ^caret\\slash')).toBe('feature/PROJ-1-Fix-login-flow-beta]-caretslash');
    expect(epicBranchName('PROJ-1', 'a..b...c')).toBe('feature/PROJ-1-a.b.c');
    expect(epicBranchName('PROJ-1', 'x @{upstream}')).toBe('feature/PROJ-1-x-@upstream}');
    expect(epicBranchName('PROJ-1', 'A/B testing')).toBe('feature/PROJ-1-A-B-testing');
    expect(epicBranchName('PROJ-1', '--- lead - - trail ---')).toBe('feature/PROJ-1-lead-trail');
    expect(epicBranchName('PROJ-1', 'ends with.lock')).toBe('feature/PROJ-1-ends-with');
    expect(epicBranchName('PROJ-1', 'tab\tand\u0007bell')).toBe('feature/PROJ-1-tab-andbell');
    expect(epicBranchName('PROJ-1', 'trailing dot.')).toBe('feature/PROJ-1-trailing-dot');
    expect(epicBranchName('PROJ-1', 'Zażółć gęślą')).toBe('feature/PROJ-1-Zażółć-gęślą');
  });

  it('an empty summary is feature/<KEY>; an empty key is no epic; the key is tidied upper case', () => {
    expect(epicBranchName('PROJ-3010', '')).toBe('feature/PROJ-3010');
    expect(epicBranchName('', 'Anything')).toBe('');
    expect(epicBranchName('proj 3010', 'Summary')).toBe('feature/PROJ-3010-Summary');
    expect(tidyEpicKey(' proj-3010 ')).toBe('PROJ-3010');
  });

  it('every derived name is a valid branch name, also for hostile summaries and very long ones', () => {
    for (const summary of ['..', '.lock', '@{', '~^:?*[\\', ' . ', 'a'.repeat(400), '/leading/and/trailing/', '-']) {
      const name = epicBranchName('PROJ-1', summary);
      expect(isValidBranchName(name), `${JSON.stringify(summary)} → ${name}`).toBe(true);
    }
    expect(epicBranchName('PROJ-1', 'a'.repeat(400)).length).toBeLessThanOrEqual(200);
    expect(branchPart('..x..')).toBe('x');
  });
});

describe('branch-name checks (D40)', () => {
  it('isValidBranchName follows git check-ref-format --branch', () => {
    for (const ok of ['dev', 'master', EPIC, 'release/2026.09', 'PROJ-1-a', 'a@b']) expect(isValidBranchName(ok), ok).toBe(true);
    for (const bad of ['', 'a..b', 'a b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', '/a', 'a/', 'a//b', 'a.', '.a', 'a/.b', 'a.lock', 'a/b.lock/c', '@', 'a@{b', '-a', 'HEAD', 'a\u0001b']) {
      expect(isValidBranchName(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('checkBranchName and checkEpicKey give the field messages', () => {
    expect(checkBranchName(' dev ', 'epic base branch', 'dev')).toEqual({ ok: true, name: 'dev' });
    expect(checkBranchName('', 'epic base branch', 'dev')).toEqual({ ok: false, message: 'name the epic base branch, e.g. dev' });
    expect(checkBranchName('a..b', 'epic branch', 'feature/X')).toEqual({ ok: false, message: 'the epic branch must be a valid git branch name, e.g. feature/X' });
    expect(checkEpicKey(' PROJ-3010 ')).toEqual({ ok: true, name: 'PROJ-3010' });
    expect(checkEpicKey('proj-3010')).toEqual({ ok: false, message: 'the epic key must be a ticket key and its number, e.g. PROJ-3010' });
  });

  it('parseSymrefHead reads ls-remote --symref; cutPoint picks the epic, the override, the base or the default', () => {
    expect(parseSymrefHead('ref: refs/heads/master\tHEAD\n763eb2f\tHEAD\n')).toBe('master');
    expect(parseSymrefHead('763eb2f\tHEAD\n')).toBeNull();
    const epic = { epic: { key: 'PROJ-1', summary: '', branch: 'feature/PROJ-1' }, base: 'dev', bases: { mobile: 'main' }, dropped: [] };
    expect(cutPoint(epic, 'web', { epicOnOrigin: true, defaultBranch: null })).toBe('feature/PROJ-1');
    expect(cutPoint(epic, 'web', { epicOnOrigin: false, defaultBranch: null })).toBe('dev');
    expect(cutPoint(epic, 'mobile', { epicOnOrigin: false, defaultBranch: null })).toBe('main');
    expect(cutPoint(TASK_ONLY, 'web', { epicOnOrigin: false, defaultBranch: 'master' })).toBe('master');
    expect(cutPoint(TASK_ONLY, 'web', { epicOnOrigin: false, defaultBranch: null })).toBeNull();
  });
});

describe('hand-off lines (D40)', () => {
  const RULE =
    '- Rule: create and push the epic + task branches with `git push -u origin <same name>` only in a repo at its first code change; cut the epic from the current `origin/dev` when it is missing on origin; never create either branch in repos that are not changed';

  it('the epic variant: model, Epic, Task branch and the Rule verbatim', () => {
    expect(branchingLines({ task: 'PROJ-3011-kpi', epic: { key: 'PROJ-3010', branch: EPIC }, base: 'dev', defaultBases: [], overrides: [], dropped: [] })).toEqual([
      '- Branching model: epic/task (lazy)',
      `- Epic: PROJ-3010 · ${EPIC} (base: origin/dev)`,
      `- Task branch: PROJ-3011-kpi (base: ${EPIC})`,
      RULE,
    ]);
  });

  it('the epic variant with drops and per-repo overrides', () => {
    expect(
      branchingLines({
        task: 'PROJ-3011-kpi',
        epic: { key: 'PROJ-3010', branch: EPIC },
        base: 'dev',
        defaultBases: [],
        overrides: [['mobile', 'main'], ['nugets/x-nuget', 'develop']],
        dropped: ['microfrontends/old-front', 'functions/y-func'],
      }),
    ).toEqual([
      '- Branching model: epic/task (lazy)',
      `- Epic: PROJ-3010 · ${EPIC} (base: origin/dev)`,
      `- Task branch: PROJ-3011-kpi (base: ${EPIC})`,
      RULE.replace('`origin/dev` when', "`origin/dev` (or the repo's base override below) when"),
      '- Base overrides: mobile: origin/main; nugets/x-nuget: origin/develop',
      '- Dropped repos (no base branch): microfrontends/old-front, functions/y-func',
    ]);
  });

  it('the task-only variant: the origin default branch the worktrees were cut from', () => {
    const task = { task: 'PROJ-12-fix', epic: null, base: 'dev', overrides: [], dropped: [] } as const;
    expect(branchingLines({ ...task, defaultBases: ['origin/master'] })).toEqual(['- Branching model: task only: PROJ-12-fix (base: origin/master)']);
    expect(branchingLines({ ...task, defaultBases: ['origin/main', 'origin/master'] })).toEqual([
      "- Branching model: task only: PROJ-12-fix (base: each repo's origin default branch: origin/main, origin/master)",
    ]);
    expect(branchingLines({ ...task, defaultBases: [] })).toEqual([`- Branching model: task only: PROJ-12-fix (base: ${DEFAULT_BRANCH_BASE})`]);
    expect(branchingLines({ ...task, defaultBases: ['origin/master'], overrides: [['mobile', 'main']], dropped: ['nugets/x'] })).toEqual([
      '- Branching model: task only: PROJ-12-fix (base: origin/master)',
      '- Base overrides: mobile: origin/main',
      '- Dropped repos (no base branch): nugets/x',
    ]);
  });

  it('sits before the worktrees in the answers block; each worktree names the branch it was cut from', () => {
    const answers: SessionStartAnswers = {
      session: {
        name: 'kpi',
        solutions: ['web-front'],
        coordination: null,
        qa: null,
        worktrees: true,
        ultracode: false,
        branch: 'PROJ-3011-kpi',
        workType: 'feature',
        mode: 'orchestrator',
        phase: 'ui-first',
      },
      folders: ['microfrontends/web-front'],
      worktrees: [{ folder: 'microfrontends/web-front', path: '/w/microfrontends/web-front-wt-kpi', branch: 'PROJ-3011-kpi', from: 'origin/dev' }],
      branching: { task: 'PROJ-3011-kpi', epic: { key: 'PROJ-3010', branch: EPIC }, base: 'dev', defaultBases: [], overrides: [], dropped: [] },
    };
    expect(sessionStartBlock(answers).split('\n').slice(-7)).toEqual([
      '- Ultracode: off',
      '- Branching model: epic/task (lazy)',
      `- Epic: PROJ-3010 · ${EPIC} (base: origin/dev)`,
      '- Task branch: PROJ-3011-kpi (base: ' + EPIC + ')',
      RULE,
      '- Worktrees (one per solution; make every change there, not in the main checkout):',
      '  - microfrontends/web-front: /w/microfrontends/web-front-wt-kpi (branch PROJ-3011-kpi, from origin/dev)',
    ]);
    // Without worktrees the lines are left out.
    expect(sessionStartBlock({ ...answers, session: { ...answers.session, worktrees: false }, worktrees: [] })).not.toContain('Branching model');
  });

  it('the D38 instruction names the base to cut from and the lazy push rule; a scheduled run keeps the old one', () => {
    expect(agentWorktreesInstruction('PROJ-3011-kpi', 'kpi', { epic: { key: 'PROJ-3010', branch: EPIC }, base: 'dev' })).toBe(
      "for each solution you change, run git fetch origin in its repo, then create a git worktree on branch PROJ-3011-kpi at <the solution repo's parent>/<repo>-wt-kpi, " +
        `cut from origin/${EPIC} when it exists on origin, else from origin/dev ` +
        '(git worktree add --no-track -b PROJ-3011-kpi <path> origin/<that branch>; when PROJ-3011-kpi exists already, on origin or locally, reuse it instead of creating it), ' +
        'make every change there, not in the main checkout, and follow the Rule above: push nothing before that repo\'s first code change',
    );
    expect(agentWorktreesInstruction('PROJ-12-fix', 'fix', { epic: null, base: 'dev' })).toBe(
      "for each solution you change, run git fetch origin in its repo, then create a git worktree on branch PROJ-12-fix at <the solution repo's parent>/<repo>-wt-fix, " +
        "cut from origin/master (the repo's origin default branch, origin/HEAD, where it is not master; never a local branch) " +
        '(git worktree add --no-track -b PROJ-12-fix <path> origin/master; when PROJ-12-fix exists already, on origin or locally, reuse it instead of creating it), ' +
        'make every change there, not in the main checkout, and push PROJ-12-fix (git push -u origin PROJ-12-fix) only at that repo\'s first code change',
    );
    expect(agentWorktreesInstruction('session/nightly', 'nightly')).toContain('from the repo\'s current HEAD');
  });

  it('the repo folder note ends with the Branching lines', () => {
    const note = repoWorktreeNote({
      path: '/w/solo-wt-fix',
      branch: 'PROJ-12-fix',
      base: 'origin/master',
      repoPath: '/w/solo',
      branching: { task: 'PROJ-12-fix', epic: null, base: 'dev', defaultBases: ['origin/master'], overrides: [], dropped: [] },
    });
    expect(note.split('\n').slice(1)).toEqual([
      '- Worktree: /w/solo-wt-fix (branch PROJ-12-fix, from origin/master); it is your working folder: make every change here.',
      '- Main checkout: /w/solo (leave it as it is).',
      '- Branching model: task only: PROJ-12-fix (base: origin/master)',
    ]);
  });
});
