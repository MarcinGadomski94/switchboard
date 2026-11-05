import { describe, expect, it } from 'vitest';
import { choicesOf } from '../../src/core/moves.ts';
import type { TargetDiverged } from '../../src/core/move-overwrite.ts';
import { type PlanOptions, type SourceRepo, type TakeoverPreview, type TargetCandidate, conversationOnlyBlockers, conversationOnlyProblem, notHereReason, planRepos, staysOnSource, takeoverMessage } from '../../src/core/takeover.ts';
import { EMPTY_CHOICE, choiceBody, withoutConversationOnly } from '../../src/web/takeover/complete-move.ts';
import { conversationOnlyLabel, conversationOnlyView, stayLine } from '../../src/web/takeover/conversation-only.ts';
import { choiceOfRetry } from '../../src/web/takeover/retry-model.ts';

/**
 * D158 (`docs/peers.md` → *Conversation only (D158)*): the pure parts of a move that
 * carries only the conversation: the plan uses a checkout as it is (no checks, no
 * clone), the source's repo-only blockers do not count, an older end is refused,
 * what stays on the source, the first message and the dialog's choice plumbing.
 */

function repo(overrides: Partial<SourceRepo> = {}): SourceRepo {
  return {
    key: 'app',
    name: 'app',
    kind: 'main',
    path: 'C:\\work\\app',
    mainPath: 'C:\\work\\app',
    branch: 'feature/x',
    remoteName: 'origin',
    remoteUrl: 'git@git.example.test:acme/app.git',
    remoteKey: 'git.example.test/acme/app',
    headSha: 'a'.repeat(40),
    upstream: 'origin/feature/x',
    ahead: 2,
    dirty: { modified: 3, untracked: 1, total: 4 },
    baseRef: null,
    parentBranch: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<TargetCandidate> = {}): TargetCandidate {
  return { path: '/Users/me/code/app', folderId: 'f1', folderKind: 'repo', folderPath: '/Users/me/code/app', name: 'app', remoteKey: 'git.example.test/acme/app', remoteName: 'origin', ...overrides };
}

const worktreePathOf = (repoPath: string, sessionName: string): string => `${repoPath}-wt-${sessionName}`;

describe('D158 planRepos with conversationOnly', () => {
  it('uses the matched checkout as it is: no worktree, no checkout, none of the dirty / diverged / checked-out checks', () => {
    const diverged: TargetDiverged = { branch: 'feature/x', count: 3, commits: [], truncated: false };
    const facts: PlanOptions = {
      sessionName: 'fix',
      defaultCloneParent: '/Users/me/code',
      worktreePathOf,
      machineName: 'mac',
      dirtyTargets: new Set(['/Users/me/code/app']),
      checkedOut: new Set(['/Users/me/code/app\nfeature/x']),
      diverged: new Map([['/Users/me/code/app\nfeature/x', diverged]]),
    };
    // Without the flag the same facts block it; with it, it is used as it is (a worktree session too).
    expect(planRepos([repo()], [candidate()], facts)[0]?.action).toBe('blocked');
    const [main] = planRepos([repo()], [candidate()], { ...facts, conversationOnly: true });
    expect(main).toMatchObject({ action: 'use', matchedPath: '/Users/me/code/app', worktreePath: null, cloneTo: null, reason: null });
    expect(main?.summary).toContain('as it is');
    const [worktree] = planRepos([repo({ kind: 'worktree' })], [candidate()], { ...facts, conversationOnly: true });
    expect(worktree).toMatchObject({ action: 'use', worktreePath: null });
  });

  it('never clones: a repo the target has no checkout of (or with no remote) is blocked with the note', () => {
    const options = { sessionName: 'fix', defaultCloneParent: '/Users/me/code', worktreePathOf, machineName: 'mac', conversationOnly: true } as const;
    expect(planRepos([repo()], [], options)[0]).toMatchObject({ action: 'blocked', cloneTo: null, reason: notHereReason('mac', 'app') });
    expect(planRepos([repo({ remoteKey: '' })], [candidate()], options)[0]?.reason).toBe('mac has no checkout of app: add it there first');
  });
});

describe('D158 the checks of both ends', () => {
  const machine = { id: 'pc', name: 'pc' };
  it('the source’s repo-only blockers do not count; the others do; an older source is refused', () => {
    expect(conversationOnlyBlockers({ machine, blockers: ['D:\\ws is not in a git repository: there is nothing to carry the files through', 'Ops is closed: reopen it first'], repoBlockers: ['D:\\ws is not in a git repository: there is nothing to carry the files through'] })).toEqual(['Ops is closed: reopen it first']);
    expect(conversationOnlyBlockers({ machine, blockers: [], repoBlockers: [] })).toEqual([]);
    expect(conversationOnlyBlockers({ machine, blockers: [] })).toEqual(['pc runs an older Switchboard that cannot move only the conversation: update Switchboard there']);
  });

  it('a target plan that does not echo conversationOnly (an older Switchboard) is refused', () => {
    expect(conversationOnlyProblem({ machine: { id: 'mac', name: 'mac' } })).toContain('mac runs an older Switchboard');
    expect(conversationOnlyProblem({ machine: { id: 'mac', name: 'mac' }, conversationOnly: { leftOut: [] } })).toBeNull();
  });
});

describe('D158 what stays on the source and the first message', () => {
  it('lists each repo with uncommitted files or unpushed commits, and an uncommitted worktree that was skipped', () => {
    const stays = staysOnSource({
      repos: [repo(), repo({ key: 'clean', name: 'clean', path: '/w/clean', dirty: { modified: 0, untracked: 0, total: 0 }, ahead: 0 }), repo({ key: 'lib', name: 'lib', path: '/w/lib', dirty: { modified: 0, untracked: 0, total: 0 }, ahead: null })],
      skippedWorktrees: [{ name: 'api', path: '/w/api-wt-x', mainPath: '/w/api', branch: 'x', reason: 'no-remote-branch', text: 'no remote branch', uncommitted: 2, warning: null } as never],
    });
    expect(stays).toEqual([
      { name: 'app', path: 'C:\\work\\app', uncommitted: 4, unpushed: 2 },
      { name: 'api', path: '/w/api-wt-x', uncommitted: 2, unpushed: 0 },
    ]);
    expect(stayLine({ name: 'app', uncommitted: 4, unpushed: 1 })).toBe('app: 4 uncommitted files, 1 unpushed commit');
  });

  it('the agent is told only the conversation moved and the files are the target’s', () => {
    const text = takeoverMessage({ fromMachine: 'pc', toMachine: 'mac', changes: [], restored: false, conversationOnly: true });
    expect(text).toContain('Only the conversation moved: the files here are as they were on mac');
    expect(text).toContain('stayed there');
    expect(takeoverMessage({ fromMachine: 'pc', toMachine: 'mac', changes: [], restored: true })).toContain('The working tree was restored as it was.');
  });
});

describe('D158 the dialog’s choice', () => {
  it('goes into the request, is kept by Try again, and the tick clears it', () => {
    expect(choiceBody({ ...EMPTY_CHOICE, conversationOnly: true })).toEqual({ conversationOnly: true });
    expect(choiceBody(EMPTY_CHOICE)).toEqual({});
    expect(choicesOf({ conversationOnly: true }).conversationOnly).toBe(true);
    expect(choicesOf({})).not.toHaveProperty('conversationOnly');
    expect(choiceOfRetry(choicesOf({ conversationOnly: true })).conversationOnly).toBe(true);
    expect(withoutConversationOnly({ ...EMPTY_CHOICE, conversationOnly: true })).toEqual(EMPTY_CHOICE);
    expect(conversationOnlyLabel('mac')).toBe('Conversation only (keep the files as they are on mac)');
  });

  it('the panel shows where it continues, the checkouts used as they are, the repos left out there and what stays', () => {
    const preview = {
      source: { repos: [repo()], skippedWorktrees: [] },
      target: {
        cwd: '/Users/me/ws',
        repos: [{ key: 'app', name: 'app', action: 'use', matchedPath: '/Users/me/ws/app' }],
        conversationOnly: { leftOut: [{ key: 'lib', name: 'lib', reason: 'mac has no checkout of lib: add it there first' }] },
      },
    } as unknown as TakeoverPreview;
    expect(conversationOnlyView(preview)).toEqual({
      where: '/Users/me/ws',
      used: [{ key: 'app', name: 'app', path: '/Users/me/ws/app' }],
      leftOut: [{ key: 'lib', name: 'lib', reason: 'mac has no checkout of lib: add it there first' }],
      stays: [{ name: 'app', path: 'C:\\work\\app', line: 'app: 4 uncommitted files, 2 unpushed commits' }],
    });
  });
});
