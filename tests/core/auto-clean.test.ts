import { describe, expect, it } from 'vitest';
import { evidenceNames, worktreeAdds, worktreeEvidence } from '../../src/core/agent-worktrees.ts';
import {
  PROTECTED_BRANCH_PATTERNS,
  type AutoCleanFacts,
  EMPTY_AUTO_CLEAN_RECORD,
  autoCleanRecordText,
  cleanedText,
  decideAutoClean,
  decideRemote,
  protectedBranchReason,
  readAutoCleanRecord,
} from '../../src/core/auto-clean.ts';

/**
 * D145 (`docs/cleanup.md` → *Automatic clean-up of merged worktrees (D145)*): the decision, each
 * condition on its own; the remote branch's rules (never a protected, base or default branch);
 * the divider's words; the record; and how a tool call names a worktree its agent made.
 */

const CLEAN: AutoCleanFacts = { agent: 'idle', cwdOf: null, usedBy: [], processes: [], uncommitted: 0, merged: 'ancestor', ownWork: true, localOnly: 0, base: 'dev' };

describe('decideAutoClean (D145)', () => {
  it('removes a merged, clean worktree of an idle or archived agent', () => {
    expect(decideAutoClean(CLEAN)).toEqual({ remove: true });
    expect(decideAutoClean({ ...CLEAN, agent: 'archived' })).toEqual({ remove: true });
    // A squash-merged PR: the base does not hold the commits, the PR says merged.
    expect(decideAutoClean({ ...CLEAN, merged: 'pr', ownWork: false })).toEqual({ remove: true });
  });

  it('keeps it while the agent works', () => {
    expect(decideAutoClean({ ...CLEAN, agent: 'running' })).toEqual({ remove: false, reason: 'its agent is working' });
  });

  it('keeps it while it is the working folder of an open agent, or another session works in it', () => {
    expect(decideAutoClean({ ...CLEAN, cwdOf: 'fix-login' })).toEqual({ remove: false, reason: 'it is the working folder of fix-login (removed once that agent is archived)' });
    expect(decideAutoClean({ ...CLEAN, usedBy: ['a', 'b'] })).toEqual({ remove: false, reason: 'also used by a, b' });
  });

  it('keeps it with a process running inside, or when that cannot be checked', () => {
    expect(decideAutoClean({ ...CLEAN, processes: ['node', 'dotnet'] })).toEqual({ remove: false, reason: '2 processes still running in it (node, dotnet)' });
    expect(decideAutoClean({ ...CLEAN, processes: null })).toEqual({ remove: false, reason: 'the processes running in it cannot be checked' });
  });

  it('keeps it with uncommitted or untracked changes', () => {
    expect(decideAutoClean({ ...CLEAN, uncommitted: 1 })).toEqual({ remove: false, reason: '1 uncommitted change' });
    expect(decideAutoClean({ ...CLEAN, uncommitted: 3 })).toEqual({ remove: false, reason: '3 uncommitted changes' });
  });

  it('keeps it while not merged (or the base is unknown)', () => {
    expect(decideAutoClean({ ...CLEAN, merged: null })).toEqual({ remove: false, reason: 'not merged into dev' });
    expect(decideAutoClean({ ...CLEAN, merged: null, base: null })).toEqual({ remove: false, reason: 'not merged (its base is unknown)' });
  });

  it('a fresh branch with no commits of its own is not "merged" (D121)', () => {
    expect(decideAutoClean({ ...CLEAN, ownWork: false })).toEqual({ remove: false, reason: 'no commits of its own yet' });
  });

  it('keeps it with commits only on this computer', () => {
    expect(decideAutoClean({ ...CLEAN, merged: 'pr', localOnly: 2 })).toEqual({ remove: false, reason: '2 commits only on this computer' });
  });

  it('the agent comes first: a working agent hides every other reason', () => {
    expect(decideAutoClean({ ...CLEAN, agent: 'running', uncommitted: 4, merged: null })).toEqual({ remove: false, reason: 'its agent is working' });
  });
});

describe('protectedBranchReason (D145)', () => {
  it('the protected patterns are one list: long-lived names, release and feature branches', () => {
    expect(PROTECTED_BRANCH_PATTERNS).toEqual(['main', 'master', 'dev', 'develop', 'development', 'trunk', 'staging', 'production', 'HEAD', 'release', 'release/*', 'release-*', 'release_*', 'releases/*', 'feature/*']);
  });

  it('never main, master, dev, develop, release branches, the base or the default branch', () => {
    for (const name of ['main', 'master', 'dev', 'develop', 'origin/dev', 'refs/heads/main']) expect(protectedBranchReason(name), name).not.toBeNull();
    expect(protectedBranchReason('release/2.4')).toBe('release/2.4 is a protected branch (release/*)');
    expect(protectedBranchReason('release-2.4')).toBe('release-2.4 is a protected branch (release-*)');
    expect(protectedBranchReason('releases/2.4')).toBe('releases/2.4 is a protected branch (releases/*)');
    // The developer's addition (2026-10-28): feature/* are epic branches, never deleted.
    expect(protectedBranchReason('feature/checkout')).toBe('feature/checkout is a protected branch (feature/*)');
    expect(protectedBranchReason('origin/feature/SLIT-1/pay')).toBe('feature/SLIT-1/pay is a protected branch (feature/*)');
    expect(protectedBranchReason('epic/checkout', { base: 'origin/epic/checkout' })).toBe('epic/checkout is the base branch');
    expect(protectedBranchReason('trunk-next', { defaultBranch: 'trunk-next' })).toBe("trunk-next is the repository's default branch");
    expect(protectedBranchReason('upstream/stable', { defaultBranch: 'stable', remotes: ['upstream'] })).toBe("stable is the repository's default branch");
  });

  it('an agent branch is not protected', () => {
    expect(protectedBranchReason('worktree-x', { base: 'dev', defaultBranch: 'main' })).toBeNull();
    expect(protectedBranchReason('session/fix-login')).toBeNull();
    expect(protectedBranchReason('releasenotes-fix')).toBeNull();
    expect(protectedBranchReason('features/x')).toBeNull();
    expect(protectedBranchReason('my-feature/x')).toBeNull();
  });
});

describe('decideRemote (D145)', () => {
  const REMOTE = { enabled: true, remote: 'origin', branch: 'worktree-x', tip: 'abc', tipMerged: true, protectedReason: null, tracking: false } as const;

  it('deletes a merged branch the agent pushed', () => {
    expect(decideRemote(REMOTE)).toEqual({ delete: true });
  });

  it('says nothing when off, without a remote, or when the branch is not there', () => {
    expect(decideRemote({ ...REMOTE, enabled: false })).toEqual({ delete: false, reason: null });
    expect(decideRemote({ ...REMOTE, remote: null })).toEqual({ delete: false, reason: null });
    expect(decideRemote({ ...REMOTE, tip: null })).toEqual({ delete: false, reason: null });
  });

  it('never a protected, base or default branch; never one that was on the remote before; never unmerged commits', () => {
    expect(decideRemote({ ...REMOTE, protectedReason: 'dev is a protected branch' })).toEqual({ delete: false, reason: 'dev is a protected branch' });
    expect(decideRemote({ ...REMOTE, tracking: true })).toEqual({ delete: false, reason: "it was on origin before Switchboard's agent used it" });
    expect(decideRemote({ ...REMOTE, tipMerged: false })).toEqual({ delete: false, reason: 'origin/worktree-x has commits that are not merged' });
    expect(decideRemote({ ...REMOTE, tip: undefined })).toEqual({ delete: false, reason: 'origin could not be read' });
  });
});

describe('the divider and the record (D145)', () => {
  it('says what went and what stayed', () => {
    expect(cleanedText({ name: 'x', how: 'merged into dev', localBranch: true, localKept: null, remote: 'origin/worktree-x', remoteKept: null })).toBe(
      'Cleaned up worktree x: merged into dev; removed the folder, the local branch and origin/worktree-x',
    );
    expect(cleanedText({ name: 'x', how: 'PR #12 merged', localBranch: true, localKept: null, remote: null, remoteKept: 'origin/worktree-x (the remote refused: protected)' })).toBe(
      'Cleaned up worktree x: PR #12 merged; removed the folder and the local branch; kept origin/worktree-x (the remote refused: protected)',
    );
    expect(cleanedText({ name: 'x', how: 'merged into dev', localBranch: false, localKept: 'release/1 is a protected branch (release/*)', remote: null, remoteKept: null })).toBe(
      'Cleaned up worktree x: merged into dev; removed the folder; kept the local branch (release/1 is a protected branch (release/*))',
    );
  });

  it('reads a stored record and words it', () => {
    expect(readAutoCleanRecord(null)).toEqual(EMPTY_AUTO_CLEAN_RECORD);
    expect(readAutoCleanRecord({ cleaned: 'x', recent: [{ at: 1 }], kept: 'no' })).toEqual(EMPTY_AUTO_CLEAN_RECORD);
    expect(autoCleanRecordText(EMPTY_AUTO_CLEAN_RECORD)).toBeNull();
    const now = new Date(2026, 9, 28, 15, 0);
    const at = new Date(2026, 9, 28, 14, 2).toISOString();
    const record = readAutoCleanRecord({ cleaned: 3, lastCleanedAt: at, recent: [{ at, path: '/r/x', text: 't' }], kept: [{ path: '/r/y', reason: 'not merged into dev' }] });
    expect(autoCleanRecordText(record, now)).toMatch(/^Cleaned up 3 worktrees so far, the last today .+ · 1 kept for now \(see Clean-up\)$/);
    expect(autoCleanRecordText({ ...EMPTY_AUTO_CLEAN_RECORD, kept: [{ path: '/r/y', reason: 'r' }] }, now)).toBe('Nothing cleaned up yet · 1 kept for now (see Clean-up)');
  });
});

describe('worktrees an agent made: the evidence (D145, D38 extended)', () => {
  const tool = (name: string, input: Record<string, unknown>, result?: string, isError = false): unknown => ({ type: 'tool', name, toolUseId: 't', input, ...(result === undefined ? {} : { result }), ...(isError ? { isError } : {}) });

  it("Claude Code's EnterWorktree: its name, and the path its result names", () => {
    expect(worktreeEvidence(tool('EnterWorktree', { name: 'fix-login' }))).toEqual({ kind: 'enter', paths: [], names: ['fix-login'], branches: [], complete: true });
    expect(worktreeEvidence(tool('EnterWorktree', {}, 'Created worktree at /r/app/.claude/worktrees/bold-fox on branch worktree-bold-fox.'))).toEqual({
      kind: 'enter',
      paths: ['/r/app/.claude/worktrees/bold-fox'],
      names: ['bold-fox'],
      branches: [],
      complete: true,
    });
    // No name and no result yet: read again later.
    expect(worktreeEvidence(tool('EnterWorktree', {}))?.complete).toBe(false);
    expect(worktreeEvidence(tool('EnterWorktree', { name: 'x' }, 'fatal', true))).toBeNull();
    // A Windows path (JSON-escaped).
    expect(worktreeEvidence(tool('EnterWorktree', {}, 'at C:\\\\code\\\\app\\\\.claude\\\\worktrees\\\\w1'))?.paths).toEqual(['C:\\code\\app\\.claude\\worktrees\\w1']);
  });

  it('an Agent / Task run with isolation "worktree": the worktree its result names', () => {
    const pending = worktreeEvidence(tool('Agent', { prompt: 'p', isolation: 'worktree' }));
    expect(pending).toEqual({ kind: 'agent', paths: [], names: [], branches: [], complete: false });
    const done = worktreeEvidence(tool('Task', { prompt: 'p', isolation: 'worktree' }, 'Done. worktreePath: /r/app/.claude/worktrees/agent-a1b2 (branch worktree-agent-a1b2)'));
    expect(done).toEqual({ kind: 'agent', paths: ['/r/app/.claude/worktrees/agent-a1b2'], names: ['agent-a1b2'], branches: [], complete: true });
    expect(worktreeEvidence(tool('Agent', { prompt: 'p' }, 'done'))).toBeNull();
  });

  it('a Bash git worktree add: its path and -b branch', () => {
    expect(worktreeAdds('cd mobile && git worktree add -b PROJ-1-x ../mobile-wt-x origin/dev')).toEqual([{ path: '../mobile-wt-x', branch: 'PROJ-1-x' }]);
    expect(worktreeAdds('git -C /r/app worktree add --detach /tmp/w')).toEqual([{ path: '/tmp/w', branch: null }]);
    expect(worktreeAdds('git status')).toEqual([]);
    expect(worktreeEvidence(tool('Bash', { command: 'git worktree add -b t /r/app-wt-t' }, ''))).toEqual({ kind: 'bash', paths: ['/r/app-wt-t'], names: ['app-wt-t'], branches: ['t'], complete: true });
    // Before its result (it may still fail): nothing yet.
    expect(worktreeEvidence(tool('Bash', { command: 'git worktree add -b t ../w' }))).toBeNull();
    expect(worktreeEvidence(tool('Bash', { command: 'ls' }, ''))).toBeNull();
  });

  it('names a listed worktree only by its path, its .claude/worktrees name in this repo, or its add command', () => {
    const repo = ['/r/app'];
    const enter = worktreeEvidence(tool('EnterWorktree', { name: 'x' })) as NonNullable<ReturnType<typeof worktreeEvidence>>;
    expect(evidenceNames(enter, { paths: ['/r/app/.claude/worktrees/x'], branch: 'worktree-x' }, repo)).toBe(true);
    expect(evidenceNames(enter, { paths: ['/r/other/.claude/worktrees/x'], branch: 'worktree-x' }, repo)).toBe(false);
    expect(evidenceNames(enter, { paths: ['/r/app-wt-x'], branch: 'x' }, repo)).toBe(false);
    const bash = worktreeEvidence(tool('Bash', { command: 'git worktree add -b PROJ-1-x ../app-wt-x' }, '')) as NonNullable<ReturnType<typeof worktreeEvidence>>;
    expect(evidenceNames(bash, { paths: ['/r/app-wt-x'], branch: 'other' }, repo)).toBe(true);
    expect(evidenceNames(bash, { paths: ['/r/elsewhere'], branch: 'PROJ-1-x' }, repo)).toBe(true);
    expect(evidenceNames(bash, { paths: ['/r/handmade'], branch: 'handmade' }, repo)).toBe(false);
  });
});
