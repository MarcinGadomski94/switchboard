import { describe, expect, it } from 'vitest';
import {
  type SourceRepo,
  type TargetCandidate,
  isTempBranch,
  matchingCandidates,
  moveLinkId,
  normalizeRemoteUrl,
  planBlockers,
  planRepos,
  redactUrl,
  rollbackActions,
  sessionShortId,
  takeoverMessage,
  tempBranchName,
} from '../../src/core/takeover.ts';
import { worktreePath } from '../../src/core/worktrees.ts';

/**
 * D65 (`docs/peers.md` → *Taking a session over*): the pure planning: remote URLs
 * normalised so two clones match, matching a session's repos to the target's saved
 * repos, the clone decision, the blocks, the rollback plan and the texts.
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
  return {
    path: '/Users/me/code/app',
    folderId: 'f1',
    folderKind: 'repo',
    folderPath: '/Users/me/code/app',
    name: 'app',
    remoteKey: 'git.example.test/acme/app',
    remoteName: 'origin',
    ...overrides,
  };
}

const PLAN = { sessionName: 'fix-login', defaultCloneParent: '/Users/me/code', worktreePathOf: worktreePath } as const;

describe('D65 remote URLs', () => {
  it('gives two clones of one repo the same key whatever the URL shape', () => {
    const urls = [
      'git@github.com:acme/app.git',
      'https://github.com/acme/app',
      'https://user:secret@GitHub.com/acme/app.git/',
      'ssh://git@github.com:22/acme/app.git',
      'https://github.com:443/acme/app.git',
    ];
    expect(new Set(urls.map(normalizeRemoteUrl))).toEqual(new Set(['github.com/acme/app']));
  });

  it('keeps different repos, hosts and non-default ports apart', () => {
    expect(normalizeRemoteUrl('https://github.com/acme/app')).not.toBe(normalizeRemoteUrl('https://github.com/acme/api'));
    expect(normalizeRemoteUrl('https://github.com/acme/app')).not.toBe(normalizeRemoteUrl('https://gitlab.com/acme/app'));
    expect(normalizeRemoteUrl('ssh://git@host:2222/a/b.git')).toBe('host:2222/a/b');
  });

  it('normalises local bare repos (a path, file://, a Windows drive path)', () => {
    expect(normalizeRemoteUrl('/tmp/remotes/app.git')).toBe('/tmp/remotes/app');
    expect(normalizeRemoteUrl('file:///tmp/remotes/app.git/')).toBe('/tmp/remotes/app');
    expect(normalizeRemoteUrl('C:\\repos\\App.git')).toBe('c:/repos/App');
    expect(normalizeRemoteUrl('')).toBe('');
  });

  it('removes http credentials from a URL that is shown or sent, and keeps the ssh user', () => {
    expect(redactUrl('https://user:token@host.test/acme/app.git')).toBe('https://host.test/acme/app.git');
    expect(redactUrl('git@host.test:acme/app.git')).toBe('git@host.test:acme/app.git');
    expect(redactUrl('ssh://git@host.test/acme/app.git')).toBe('ssh://git@host.test/acme/app.git');
  });
});

describe('D65 temporary branch names', () => {
  it('lives under switchboard/takeover/<session short id>/<branch>', () => {
    expect(sessionShortId('0B7C3E0A-1111-4222-8333-944455556666')).toBe('0b7c3e0a');
    expect(tempBranchName('0b7c3e0a-1111', 'feature/login')).toBe('switchboard/takeover/0b7c3e0a/feature/login');
    expect(isTempBranch('switchboard/takeover/0b7c3e0a/feature/login')).toBe(true);
    expect(isTempBranch('feature/login')).toBe(false);
    expect(isTempBranch('switchboard/takeover/../main')).toBe(false);
  });
});

describe('D65 matching and the clone decision', () => {
  it('uses the saved repo with the same remote and checks the branch out', () => {
    const [one] = planRepos([repo()], [candidate()], PLAN);
    expect(one).toMatchObject({ action: 'use', matchedPath: '/Users/me/code/app', cloneTo: null, worktreePath: null, reason: null, uncommitted: 4, ahead: 2 });
    expect(one?.summary).toBe('Use /Users/me/code/app; check out feature/x');
  });

  it('prefers the candidate named like the repo, then the lowest path', () => {
    const matches = matchingCandidates(repo(), [candidate({ path: '/z/other', name: 'other' }), candidate({ path: '/b/app' }), candidate({ path: '/a/app' })]);
    expect(matches.map((entry) => entry.path)).toEqual(['/a/app', '/b/app', '/z/other']);
    expect(matchingCandidates(repo(), [candidate({ remoteKey: 'elsewhere/x' }), candidate({ remoteKey: null })])).toEqual([]);
  });

  it('a worktree session gets ../<repo>-wt-<name> next to the matched checkout', () => {
    const [one] = planRepos([repo({ kind: 'worktree', path: 'C:\\work\\app-wt-fix-login' })], [candidate()], PLAN);
    expect(one).toMatchObject({ action: 'use', worktreePath: '/Users/me/code/app-wt-fix-login' });
    expect(one?.summary).toContain('new worktree /Users/me/code/app-wt-fix-login on feature/x');
  });

  it('offers to clone a repo the target does not have: the default is next to the default folder, a typed path wins', () => {
    const [byDefault] = planRepos([repo()], [candidate({ remoteKey: 'elsewhere/x' })], PLAN);
    expect(byDefault).toMatchObject({ action: 'clone', cloneTo: '/Users/me/code/app', cloneUrl: 'git@git.example.test:acme/app.git', matchedPath: null });
    const [typed] = planRepos([repo()], [], { ...PLAN, clonePaths: { app: '/data/repos/app' } });
    expect(typed).toMatchObject({ action: 'clone', cloneTo: '/data/repos/app' });
    const [worktree] = planRepos([repo({ kind: 'worktree' })], [], PLAN);
    expect(worktree).toMatchObject({ action: 'clone', worktreePath: '/Users/me/code/app-wt-fix-login' });
  });

  it('blocks instead of guessing: no remote, no clone folder, a clone path that exists, a worktree path that exists', () => {
    expect(planRepos([repo({ remoteKey: '' })], [candidate()], PLAN)[0]).toMatchObject({ action: 'blocked', reason: expect.stringContaining('has no remote') });
    expect(planRepos([repo()], [], { ...PLAN, defaultCloneParent: null })[0]).toMatchObject({ action: 'blocked', reason: expect.stringContaining('type one') });
    expect(planRepos([repo()], [], { ...PLAN, exists: new Set(['/Users/me/code/app']) })[0]).toMatchObject({ action: 'blocked', reason: expect.stringContaining('exists already') });
    expect(planRepos([repo({ kind: 'worktree' })], [candidate()], { ...PLAN, exists: new Set(['/Users/me/code/app-wt-fix-login']) })[0]).toMatchObject({
      action: 'blocked',
      reason: expect.stringContaining('exists already on the target'),
    });
  });

  it('blocks a branch checked out in another worktree and a dirty checkout a main-checkout session would need', () => {
    expect(planRepos([repo()], [candidate()], { ...PLAN, checkedOut: new Set(['/Users/me/code/app\nfeature/x']) })[0]).toMatchObject({ action: 'blocked', reason: expect.stringContaining('checked out in another worktree') });
    expect(planRepos([repo()], [candidate()], { ...PLAN, dirtyTargets: new Set(['/Users/me/code/app']) })[0]).toMatchObject({ action: 'blocked', reason: expect.stringContaining('uncommitted changes on the target') });
    // A worktree session never touches the main checkout's tree.
    expect(planRepos([repo({ kind: 'worktree' })], [candidate()], { ...PLAN, dirtyTargets: new Set(['/Users/me/code/app']) })[0]?.action).toBe('use');
  });

  it('a workspace session resolves or clones every repo, else the take-over is blocked before anything changes', () => {
    const front = repo({ key: 'front', name: 'front', remoteKey: 'h/acme/front', remoteUrl: 'https://h/acme/front.git' });
    const back = repo({ key: 'back', name: 'back', remoteKey: 'h/acme/back', remoteUrl: 'https://h/acme/back.git' });
    const resolutions = planRepos([front, back], [candidate({ path: '/ws/front', name: 'front', remoteKey: 'h/acme/front', folderKind: 'workspace', folderPath: '/ws' })], {
      ...PLAN,
      clonePaths: { back: '/ws/back' },
    });
    expect(resolutions.map((entry) => entry.action)).toEqual(['use', 'clone']);
    expect(planBlockers(resolutions)).toEqual([]);
    const stuck = planRepos([front, back], [], { ...PLAN, defaultCloneParent: null });
    expect(planBlockers(stuck)).toHaveLength(2);
  });
});

describe('D65 rollback plan', () => {
  it('undoes nothing before the capture, then the temp branches, then the target, newest first', () => {
    expect(rollbackActions({ done: ['checks'], stoppedLive: false, hooked: false, terminalStopped: false })).toEqual([]);
    expect(rollbackActions({ done: ['checks', 'stop'], stoppedLive: true, hooked: false, terminalStopped: false })).toEqual(['source-resume']);
    expect(rollbackActions({ done: ['checks', 'stop', 'capture'], stoppedLive: true, hooked: false, terminalStopped: false })).toEqual(['source-delete-temp-branches', 'source-resume']);
    expect(rollbackActions({ done: ['checks', 'stop', 'capture', 'transfer'], stoppedLive: true, hooked: false, terminalStopped: false })).toEqual([
      'target-remove-files',
      'source-delete-temp-branches',
      'source-resume',
    ]);
    expect(rollbackActions({ done: ['checks', 'stop', 'capture', 'transfer', 'apply'], stoppedLive: false, hooked: false, terminalStopped: false })).toEqual([
      'target-undo-apply',
      'target-remove-files',
      'source-delete-temp-branches',
    ]);
  });

  it('a hooked terminal that was stopped cannot be resumed from here: it is noted instead', () => {
    expect(rollbackActions({ done: ['checks', 'stop', 'capture', 'transfer'], stoppedLive: false, hooked: true, terminalStopped: true })).toEqual([
      'target-remove-files',
      'source-delete-temp-branches',
      'source-note-terminal-stopped',
    ]);
    // A hooked session whose terminal was not stopped yet has nothing to resume either.
    expect(rollbackActions({ done: ['checks', 'stop', 'capture'], stoppedLive: false, hooked: true, terminalStopped: false })).toEqual(['source-delete-temp-branches']);
  });
});

describe('D65 texts', () => {
  it('the agent\'s first message names both machines, the paths that changed and that the tree is as it was', () => {
    expect(takeoverMessage({ fromMachine: 'office-pc', toMachine: 'laptop', changes: [{ name: 'app', from: 'C:\\work\\app', to: '/Users/me/code/app' }], restored: true })).toBe(
      'This session moved from office-pc to laptop. Paths changed: C:\\work\\app → /Users/me/code/app. The working tree was restored as it was.',
    );
    const two = takeoverMessage({
      fromMachine: 'a',
      toMachine: 'b',
      changes: [
        { name: 'front', from: '/x/front', to: '/y/front' },
        { name: 'back', from: '/x/back', to: '/y/back' },
      ],
      restored: true,
    });
    expect(two).toContain('/x/front → /y/front (front); /x/back → /y/back (back)');
  });

  it('links the other machine\'s session as a remote id unless it is on this machine', () => {
    expect(moveLinkId({ machineId: 'abcdefghijkl', sessionId: 'sid' }, 'mnopqrstuvwx')).toBe('r~abcdefghijkl~sid');
    expect(moveLinkId({ machineId: 'abcdefghijkl', sessionId: 'sid' }, 'abcdefghijkl')).toBe('sid');
  });
});
