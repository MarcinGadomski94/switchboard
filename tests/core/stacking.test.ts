import { describe, expect, it } from 'vitest';
import { type HandoffBranching, TASK_ONLY } from '../../src/core/branching.ts';
import {
  type HandoffStack,
  type ParentMerged,
  type StackRepo,
  ambiguousParentMessage,
  branchKey,
  effectiveParent,
  handoffLines,
  parentConflict,
  parentDisplay,
  parentFromTask,
  parentMatches,
  parentMergedMessage,
  parentMergedTitle,
  parentPrSummary,
  parentStatusText,
  parentStatusWarning,
  parseParent,
  parseParentPullRequest,
  rebaseCommand,
  repoBaseLine,
  resolveRepoBase,
  storedParent,
} from '../../src/core/stacking.ts';

/** D47 (`docs/decisions.md` → *Stacked task branches*): the pure rules. */
const EPIC = 'feature/PROJ-3010-Platform-tracking-and-KPI-delivery-process-development';
const PARENT = 'PROJ-3013-configure-hubspot-opt-in-cookie-banner-across-both-domains';
const TASK = 'PROJ-3014-kpi-events';
const withEpic = { epic: { key: 'PROJ-3010', summary: 'x', branch: EPIC }, base: 'dev', bases: {} };

describe('parseParent', () => {
  it('blank = not stacked; a key in any case is upper-cased; a full name is kept; origin/ is dropped', () => {
    expect(parseParent('')).toEqual({ ok: true, parent: null });
    expect(parseParent('   ')).toEqual({ ok: true, parent: null });
    expect(parseParent(undefined)).toEqual({ ok: true, parent: null });
    expect(parseParent('PROJ-3013')).toEqual({ ok: true, parent: { kind: 'key', key: 'PROJ-3013' } });
    expect(parseParent(' proj-3013 ')).toEqual({ ok: true, parent: { kind: 'key', key: 'PROJ-3013' } });
    expect(parseParent(PARENT)).toEqual({ ok: true, parent: { kind: 'branch', name: PARENT } });
    expect(parseParent(`origin/${PARENT}`)).toEqual({ ok: true, parent: { kind: 'branch', name: PARENT } });
  });

  it('refuses what git refuses (check-ref-format)', () => {
    for (const bad of ['a..b', 'with space', 'x~1', 'end.', '-dash', 'a.lock', 'HEAD']) expect(parseParent(bad).ok, bad).toBe(false);
  });
});

describe('parent conflicts and the effective parent', () => {
  it('not the task branch, not its own key, not the epic base; the epic branch = not stacked', () => {
    const context = { task: TASK, base: 'dev', epic: EPIC };
    expect(parentConflict({ kind: 'branch', name: TASK }, context)).toBe('the parent cannot be the task branch itself');
    expect(parentConflict({ kind: 'key', key: 'PROJ-3014' }, context)).toBe("the parent cannot be the task's own key (PROJ-3014)");
    expect(parentConflict({ kind: 'branch', name: 'dev' }, context)).toBe("the parent must be a task branch, not the epic's base (dev)");
    expect(parentConflict({ kind: 'key', key: 'PROJ-3013' }, context)).toBeNull();
    expect(parentConflict({ kind: 'branch', name: 'dev' }, { task: TASK, base: 'dev', epic: null })).toBeNull();
    expect(effectiveParent({ kind: 'branch', name: EPIC }, EPIC)).toBeNull();
    expect(effectiveParent({ kind: 'key', key: 'PROJ-3013' }, EPIC)).toEqual({ kind: 'key', key: 'PROJ-3013' });
    expect(effectiveParent(null, EPIC)).toBeNull();
    expect(storedParent({ parent: 'PROJ-3013' })).toEqual({ kind: 'key', key: 'PROJ-3013' });
    expect(storedParent(TASK_ONLY)).toBeNull();
    expect(branchKey(TASK)).toBe('PROJ-3014');
    expect(branchKey('dev')).toBeNull();
  });
});

describe('parentMatches', () => {
  const branches = ['master', 'dev', EPIC, PARENT, 'PROJ-30130-other', TASK, 'PROJ-3013', 'x/PROJ-3013-nested'];
  it('a key: origin branches starting with <KEY>- (the task left out); a name: that branch when present', () => {
    expect(parentMatches({ kind: 'key', key: 'PROJ-3013' }, branches, TASK)).toEqual([PARENT]);
    expect(parentMatches({ kind: 'key', key: 'PROJ-3014' }, branches, TASK)).toEqual([]);
    expect(parentMatches({ kind: 'key', key: 'PROJ-3013' }, [...branches, 'PROJ-3013-second'], TASK)).toEqual([PARENT, 'PROJ-3013-second'].sort());
    expect(parentMatches({ kind: 'branch', name: PARENT }, branches, TASK)).toEqual([PARENT]);
    expect(parentMatches({ kind: 'branch', name: 'PROJ-1-missing' }, branches, TASK)).toEqual([]);
  });
});

describe('resolveRepoBase (rules 2 and 4)', () => {
  it('the parent on origin: cut from it, PR into it', () => {
    expect(resolveRepoBase(withEpic, 'acme-app-front', { parentMatches: [PARENT], epicOnOrigin: true, defaultBranch: null })).toEqual({
      ok: true,
      cut: PARENT,
      prTarget: PARENT,
      parent: PARENT,
      via: 'parent',
      epicMissing: false,
    });
  });

  it('several matches: refused with the names', () => {
    const result = resolveRepoBase(withEpic, 'a', { parentMatches: ['PROJ-3013-a', 'PROJ-3013-b'], epicOnOrigin: true, defaultBranch: null });
    expect(result).toEqual({ ok: false, message: ambiguousParentMessage('PROJ-3013', ['PROJ-3013-a', 'PROJ-3013-b']), matches: ['PROJ-3013-a', 'PROJ-3013-b'] });
    expect(ambiguousParentMessage('PROJ-3013', ['PROJ-3013-a', 'PROJ-3013-b'])).toBe('PROJ-3013 matches 2 branches on origin (PROJ-3013-a, PROJ-3013-b): type the parent\'s full branch name');
  });

  it('parent not in the repo: the epic when on origin, else origin/<base> (PR into the epic, created lazily); an override', () => {
    expect(resolveRepoBase(withEpic, 'a', { parentMatches: [], epicOnOrigin: true, defaultBranch: null })).toMatchObject({ cut: EPIC, prTarget: EPIC, parent: null, via: 'epic' });
    expect(resolveRepoBase(withEpic, 'a', { parentMatches: [], epicOnOrigin: false, defaultBranch: null })).toMatchObject({ cut: 'dev', prTarget: EPIC, via: 'epic-base', epicMissing: true });
    expect(resolveRepoBase({ ...withEpic, bases: { a: 'main' } }, 'a', { parentMatches: [], epicOnOrigin: false, defaultBranch: null })).toMatchObject({ cut: 'main', prTarget: EPIC, via: 'override' });
  });

  it('without an epic (a bug fix): the parent, else the origin default branch, PR into it', () => {
    expect(resolveRepoBase(TASK_ONLY, 'a', { parentMatches: [PARENT], epicOnOrigin: false, defaultBranch: 'master' })).toMatchObject({ cut: PARENT, prTarget: PARENT, via: 'parent', epicMissing: false });
    expect(resolveRepoBase(TASK_ONLY, 'a', { parentMatches: [], epicOnOrigin: false, defaultBranch: 'master' })).toMatchObject({ cut: 'master', prTarget: 'master', via: 'default' });
    expect(resolveRepoBase(TASK_ONLY, 'a', { parentMatches: null, epicOnOrigin: false, defaultBranch: null })).toMatchObject({ cut: null, prTarget: null });
  });
});

describe('parent status', () => {
  it('parses gh pr view --json number,state,url,baseRefName,headRefOid', () => {
    expect(parseParentPullRequest('{"number":306,"state":"OPEN","url":"https://x/306","baseRefName":"feature/PROJ-3010-x","headRefOid":"abc1234"}')).toEqual({
      number: 306,
      state: 'OPEN',
      url: 'https://x/306',
      baseRefName: 'feature/PROJ-3010-x',
      headRefOid: 'abc1234',
    });
    expect(parseParentPullRequest('{"number":1,"state":"MERGED","baseRefName":"bad..name","headRefOid":"zz"}')).toEqual({ number: 1, state: 'MERGED', url: null, baseRefName: null, headRefOid: null });
    expect(parseParentPullRequest('nope')).toBeNull();
    expect(parseParentPullRequest('{"state":"OPEN"}')).toBeNull();
  });

  it('warns on merged / closed, never on open; the short text', () => {
    const pr = (state: string) => ({ kind: 'pr' as const, pr: { number: 306, state, url: null, baseRefName: EPIC, headRefOid: null } });
    expect(parentStatusWarning(pr('MERGED'))).toBe('parent merged — base on its target instead');
    expect(parentStatusWarning(pr('CLOSED'))).toBe('parent closed — base on its target instead');
    expect(parentStatusWarning(pr('OPEN'))).toBeNull();
    expect(parentStatusWarning({ kind: 'none' })).toBeNull();
    expect(parentStatusText(pr('OPEN'))).toBe('PR #306 open');
    expect(parentStatusText({ kind: 'none' })).toBe('no PR');
    expect(parentStatusText({ kind: 'unknown', error: 'x' })).toBe('PR status unknown');
  });
});

describe('parentFromTask (pre-fill)', () => {
  it('finds the key after a stacking phrase, upper-cased', () => {
    expect(parentFromTask('Add the KPI events; create it from PROJ-3013.')).toBe('PROJ-3013');
    expect(parentFromTask('stack on PROJ-3013 please')).toBe('PROJ-3013');
    expect(parentFromTask('Stacked on proj-3013')).toBe('PROJ-3013');
    expect(parentFromTask('based on PROJ-3013-configure-hubspot')).toBe('PROJ-3013');
    expect(parentFromTask('Build it on top of PROJ-3013')).toBe('PROJ-3013');
    expect(parentFromTask('branch off the branch of PROJ-3013')).toBe('PROJ-3013');
    expect(parentFromTask('cut it from `PROJ-3013`')).toBe('PROJ-3013');
  });

  it('nothing without a phrase or a key', () => {
    expect(parentFromTask('PROJ-3014 KPI events')).toBeNull();
    expect(parentFromTask('based on the Figma frames')).toBeNull();
    expect(parentFromTask('create it from dev')).toBeNull();
    expect(parentFromTask('')).toBeNull();
  });
});

const open306 = { kind: 'pr' as const, pr: { number: 306, state: 'OPEN', url: null, baseRefName: EPIC, headRefOid: null } };
const open1080 = { kind: 'pr' as const, pr: { number: 1080, state: 'OPEN', url: null, baseRefName: EPIC, headRefOid: null } };

function repo(solution: string, facts: Parameters<typeof resolveRepoBase>[2], status: StackRepo['status'], branching: Parameters<typeof resolveRepoBase>[0] = withEpic): StackRepo {
  const base = resolveRepoBase(branching, solution, facts);
  if (!base.ok) throw new Error(base.message);
  return { solution, base, status };
}

describe('hand-off lines', () => {
  const stack: HandoffStack = {
    parent: 'PROJ-3013',
    repos: [
      repo('acme-app-front', { parentMatches: [PARENT], epicOnOrigin: true, defaultBranch: null }, open306),
      repo('static-front', { parentMatches: [PARENT], epicOnOrigin: false, defaultBranch: null }, open1080),
      repo('quizzes-front', { parentMatches: [], epicOnOrigin: false, defaultBranch: null }, null),
    ],
  };
  const handoff: HandoffBranching = { task: TASK, epic: { key: 'PROJ-3010', branch: EPIC }, base: 'dev', defaultBases: [], overrides: [], dropped: [], stack };

  it('the stacked block (the spec example)', () => {
    expect(handoffLines(handoff)).toEqual([
      '- Branching model: epic/task (lazy), stacked',
      `  - Epic: PROJ-3010 — ${EPIC} (base: origin/dev)`,
      `  - Task branch: ${TASK}`,
      `  - Parent: ${PARENT} (stacked; PR #306/#1080 open)`,
      '  - Per-repo base / PR target:',
      `    - acme-app-front: origin/${PARENT} → PR into ${PARENT}`,
      `    - static-front: origin/${PARENT} → PR into ${PARENT}`,
      `    - quizzes-front: origin/dev (epic missing; parent not in repo) → PR into ${EPIC} (epic, created lazily)`,
      "  - Rule: push the task branch with `git push -u origin <same name>` only in a repo at its first code change; in a repo where the parent is not on origin, create and push the epic too (cut from the current `origin/dev` when it is missing on origin); never create a branch in repos that are not changed; open each repo's PR into its PR target above",
      `  - When the parent merges: Switchboard watches the parent's PR in each repo and tells you when it merges; then retarget this task's PR to the parent's own base (\`gh pr edit ${TASK} --base <parent's base>\`) and rebase ${TASK} onto \`origin/<parent's base>\` (\`git rebase --onto origin/<parent's base> <old parent tip> ${TASK}\` when the parent was squash-merged, else a normal rebase), then report; ask the developer before force-pushing a rebased branch`,
    ]);
  });

  it('not stacked: D40 lines unchanged', () => {
    const { stack: _stack, ...plain } = handoff;
    expect(handoffLines(plain)[0]).toBe('- Branching model: epic/task (lazy)');
    expect(handoffLines({ ...plain, stack: null })[1]).toBe(`- Epic: PROJ-3010 · ${EPIC} (base: origin/dev)`);
  });

  it('without an epic: task only, stacked; PR into the default branch where the parent is missing; no Epic line', () => {
    const lines = handoffLines({
      task: TASK,
      epic: null,
      base: 'dev',
      defaultBases: [],
      overrides: [],
      dropped: ['mobile'],
      stack: {
        parent: PARENT,
        repos: [
          repo('web-front', { parentMatches: [PARENT], epicOnOrigin: false, defaultBranch: 'master' }, { kind: 'none' }, TASK_ONLY),
          repo('api', { parentMatches: [], epicOnOrigin: false, defaultBranch: 'master' }, null, TASK_ONLY),
          { solution: 'local-only', base: null, status: null },
        ],
      },
    });
    expect(lines.slice(0, 7)).toEqual([
      '- Branching model: task only, stacked',
      `  - Task branch: ${TASK}`,
      `  - Parent: ${PARENT} (stacked; no PR)`,
      '  - Per-repo base / PR target:',
      `    - web-front: origin/${PARENT} → PR into ${PARENT}`,
      '    - api: origin/master (parent not in repo) → PR into master',
      '    - local-only: its current HEAD (no origin remote) → no PR target (no origin remote)',
    ]);
    expect(lines.at(-1)).toBe('- Dropped repos (no base branch): mobile');
  });

  it('no worktree up front (D38): the per-repo rule instead of the table', () => {
    const lines = handoffLines({ ...handoff, stack: { parent: 'PROJ-3013', repos: [] } });
    expect(lines[3]).toBe('  - Parent: PROJ-3013 (stacked; resolved per repo)');
    expect(lines[4]).toBe(
      `  - Per-repo base / PR target: in each repo you change, after git fetch origin --prune: origin/<parent> when the origin branch whose name starts with PROJ-3013- (ask if there are several) is on origin there (PR into it), else origin/${EPIC} when it is on origin, else origin/dev (PR into ${EPIC}, the epic, created lazily)`,
    );
  });

  it('parent display and PR summary: mixed states, no PR, unknown, differing names', () => {
    const mixed: HandoffStack = {
      parent: 'PROJ-3013',
      repos: [
        { ...repo('a', { parentMatches: [PARENT], epicOnOrigin: true, defaultBranch: null }, open306) },
        { ...repo('b', { parentMatches: ['PROJ-3013-other'], epicOnOrigin: true, defaultBranch: null }, { kind: 'pr', pr: { ...open1080.pr, state: 'MERGED' } }) },
        { ...repo('c', { parentMatches: [PARENT], epicOnOrigin: true, defaultBranch: null }, { kind: 'none' }) },
        { ...repo('d', { parentMatches: [PARENT], epicOnOrigin: true, defaultBranch: null }, { kind: 'unknown', error: 'offline' }) },
      ],
    };
    expect(parentDisplay(mixed)).toBe(`PROJ-3013 (${PARENT}, PROJ-3013-other)`);
    expect(parentPrSummary(mixed)).toBe('PR #306 open, PR #1080 merged, no PR in c, PR status unknown in d');
    expect(parentPrSummary({ parent: 'PROJ-3013', repos: [repo('x', { parentMatches: [], epicOnOrigin: true, defaultBranch: null }, null)] })).toBe('not on origin in any repo');
    expect(parentDisplay({ parent: 'PROJ-3013', repos: [] })).toBe('PROJ-3013');
    expect(repoBaseLine(repo('x', { parentMatches: [], epicOnOrigin: true, defaultBranch: null }, null), EPIC)).toBe(`origin/${EPIC} (parent not in repo) → PR into ${EPIC} (epic)`);
  });
});

describe('parent merged (rule 5)', () => {
  const merged: ParentMerged = {
    solution: 'acme-app-front',
    task: TASK,
    parent: PARENT,
    parentBase: EPIC,
    parentPr: 306,
    oldTip: 'abc1234',
    merge: 'squash',
    childPr: 412,
    worktreePath: '/w/acme-app-front-wt-kpi',
  };

  it('title and rebase command per merge kind', () => {
    expect(parentMergedTitle(merged)).toBe(`Parent ${PARENT} merged — retarget and rebase ${TASK}`);
    expect(rebaseCommand(merged)).toBe(`git rebase --onto origin/${EPIC} abc1234 ${TASK}`);
    expect(rebaseCommand({ ...merged, merge: 'merge' })).toBe(`git rebase origin/${EPIC} ${TASK}`);
    expect(rebaseCommand({ ...merged, merge: 'unknown', oldTip: null })).toBe(`git rebase --onto origin/${EPIC} <old parent tip> ${TASK}`);
  });

  it('the message asks to retarget, rebase and report (never done by Switchboard)', () => {
    expect(parentMergedMessage(merged)).toBe(
      [
        `Switchboard: the parent branch ${PARENT} (PR #306) was merged into ${EPIC} in acme-app-front; it was squash-merged (its old tip abc1234 is not in origin/${EPIC}), so rebase with --onto.`,
        'In /w/acme-app-front-wt-kpi:',
        `1. Retarget your PR #412 to ${EPIC}: \`gh pr edit ${TASK} --base ${EPIC}\`.`,
        `2. \`git fetch origin --prune\`, then rebase ${TASK} onto origin/${EPIC}: \`git rebase --onto origin/${EPIC} abc1234 ${TASK}\`.`,
        '3. Report what you did. Ask the developer before force-pushing the rebased branch.',
      ].join('\n'),
    );
    const unknown = parentMergedMessage({ ...merged, merge: 'unknown', childPr: null, parentPr: null });
    expect(unknown).toContain(`check with \`git merge-base --is-ancestor abc1234 origin/${EPIC}\` whether it was squash-merged`);
    expect(unknown).toContain(`1. Retarget your PR for ${TASK}, if you have opened one, to ${EPIC}`);
  });
});
