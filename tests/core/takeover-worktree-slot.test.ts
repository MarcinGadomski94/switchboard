import { describe, expect, it } from 'vitest';
import { type SourceRepo, type TargetCandidate, parseWorktreeList, planRepos, worktreeSlotBlocker } from '../../src/core/takeover.ts';
import { worktreePath } from '../../src/core/worktrees.ts';
import { comparablePathText } from '../../src/server/takeover/git.ts';

/**
 * The worktree path on the target (`docs/peers.md` → *A worktree folder in the
 * way*): git's worktree list parsed (Windows paths and CRLF too), the blocker texts
 * per state, and the plan blocking a worktree path in the way for a matched repo
 * and for a clone.
 */

function repo(overrides: Partial<SourceRepo> = {}): SourceRepo {
  return {
    key: 'app',
    name: 'app',
    kind: 'worktree',
    path: 'C:\\work\\app-wt-fix-login',
    mainPath: 'C:\\work\\app',
    branch: 'fix-login',
    remoteName: 'origin',
    remoteUrl: 'git@git.acme.example:acme/app.git',
    remoteKey: 'git.acme.example/acme/app',
    headSha: '1111111111111111111111111111111111111111',
    upstream: null,
    ahead: null,
    dirty: { modified: 0, untracked: 0, total: 0 },
    baseRef: null,
    parentBranch: null,
    ...overrides,
  };
}

const candidate: TargetCandidate = { path: 'D:\\code\\app', folderId: 'f1', folderKind: 'repo', folderPath: 'D:\\code\\app', name: 'app', remoteKey: 'git.acme.example/acme/app', remoteName: 'origin' };
const winWorktreePath = (repoPath: string, name: string): string => `${repoPath}-wt-${name}`;

describe('parseWorktreeList', () => {
  it('reads paths, branches, locked and prunable entries (Windows paths, CRLF)', () => {
    const out = [
      'worktree D:/code/app',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree D:/code/app-wt-old',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/feature/x',
      'prunable gitdir file points to non-existent location',
      '',
      'worktree D:/code/app-wt-usb',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      'locked on a stick',
      '',
    ].join('\r\n');
    expect(parseWorktreeList(out)).toEqual([
      { path: 'D:/code/app', branch: 'main', locked: false, prunable: false },
      { path: 'D:/code/app-wt-old', branch: 'feature/x', locked: false, prunable: true },
      { path: 'D:/code/app-wt-usb', branch: null, locked: true, prunable: false },
    ]);
    expect(parseWorktreeList('')).toEqual([]);
  });

  it('git\'s Windows path and the plan\'s spelling compare equal', () => {
    expect(comparablePathText('D:/Code/App-wt-x', 'win32')).toBe(comparablePathText('d:\\code\\app-wt-x\\', 'win32'));
    expect(comparablePathText('/Users/me/App-wt-x', 'darwin')).not.toBe(comparablePathText('/Users/me/app-wt-x', 'darwin'));
  });
});

describe('worktreeSlotBlocker', () => {
  const input = { machine: 'PC', path: 'D:\\code\\app-wt-fix-login', repo: 'app' };
  it('lets a free path, an empty folder and a stale entry through', () => {
    for (const kind of ['free', 'empty-folder', 'stale-entry'] as const) expect(worktreeSlotBlocker({ kind }, input)).toBeNull();
  });
  it('blocks a non-empty folder that is not a worktree, without deleting it', () => {
    expect(worktreeSlotBlocker({ kind: 'folder' }, input)).toBe(
      'PC already has a folder at D:\\code\\app-wt-fix-login (not a git worktree; likely left over from an earlier move). Remove it there, or pick another target folder, then check again.',
    );
  });
  it('blocks a live or locked worktree with a hint, a file and an unreadable path', () => {
    expect(worktreeSlotBlocker({ kind: 'worktree', branch: 'fix-login', locked: false }, input)).toBe(
      'PC already has a git worktree of app at D:\\code\\app-wt-fix-login (on fix-login). Remove it there if it is not in use (git worktree remove), or pick another target folder, then check again.',
    );
    expect(worktreeSlotBlocker({ kind: 'worktree', branch: null, locked: true }, input)).toBe(
      'PC has a locked git worktree of app at D:\\code\\app-wt-fix-login. Unlock and remove it there if it is not in use (git worktree unlock, then git worktree remove), or pick another target folder, then check again.',
    );
    expect(worktreeSlotBlocker({ kind: 'file' }, input)).toBe('PC already has a file at D:\\code\\app-wt-fix-login where the worktree of app goes. Remove it there, or pick another target folder, then check again.');
    expect(worktreeSlotBlocker({ kind: 'unreadable', error: 'EPERM: operation not permitted' }, input)).toBe(
      'PC could not check D:\\code\\app-wt-fix-login, where the worktree of app goes (EPERM: operation not permitted). Make sure it is free there, or pick another target folder, then check again.',
    );
  });
});

describe('planRepos with a worktree path in the way', () => {
  it('blocks a matched repo whose worktree path is in the way, with the text', () => {
    const blockers = new Map([['D:\\code\\app-wt-fix-login', 'in the way']]);
    expect(planRepos([repo()], [candidate], { sessionName: 'fix-login', defaultCloneParent: null, worktreePathOf: winWorktreePath, worktreeBlockers: blockers })[0]).toMatchObject({
      action: 'blocked',
      reason: 'in the way',
      matchedPath: 'D:\\code\\app',
    });
    expect(planRepos([repo()], [candidate], { sessionName: 'fix-login', defaultCloneParent: null, worktreePathOf: winWorktreePath })[0]).toMatchObject({ action: 'use', worktreePath: 'D:\\code\\app-wt-fix-login' });
  });
  it('blocks a clone whose worktree path is in the way (before 2026-11-04 only the clone path was checked)', () => {
    const blockers = new Map([['/Users/me/code/app-wt-fix-login', 'in the way']]);
    const options = { sessionName: 'fix-login', defaultCloneParent: '/Users/me/code', worktreePathOf: worktreePath } as const;
    expect(planRepos([repo()], [], { ...options, worktreeBlockers: blockers })[0]).toMatchObject({ action: 'blocked', reason: 'in the way', cloneTo: '/Users/me/code/app' });
    expect(planRepos([repo()], [], options)[0]).toMatchObject({ action: 'clone', worktreePath: '/Users/me/code/app-wt-fix-login' });
  });
});
