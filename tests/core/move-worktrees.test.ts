import { describe, expect, it } from 'vitest';
import {
  type SkippedWorktree,
  changesLine,
  dirtyTargetBlocker,
  groupByRepo,
  isSafeWorktreeLayout,
  skippedWarning,
  stashConfirmed,
  stashMessage,
  stashNote,
  stashTargetsOf,
  worktreeAtTarget,
  worktreeCarry,
  worktreeLayout,
} from '../../src/core/move-worktrees.ts';
import { type SourceRepo, type TargetCandidate, planBlockers, planRepos } from '../../src/core/takeover.ts';
import { type TakeoverPreview } from '../../src/core/takeover.ts';
import { carryGroups, stashRows, withStash, worksInLine } from '../../src/web/takeover/complete-move.ts';

/** D153: the agent's own worktrees on a move, and a target checkout's changes stashed after confirming. */

describe('D153: which of the agent own worktrees travel', () => {
  it('carries a worktree only when its branch has a remote-tracking branch and is not merged', () => {
    expect(worktreeCarry({ branch: 'feat/live', upstream: 'origin/feat/live', mergedInto: null })).toEqual({ carry: true });
    expect(worktreeCarry({ branch: 'feat/local', upstream: null, mergedInto: null })).toEqual({ carry: false, reason: 'no-remote-branch', text: 'no remote branch' });
    expect(worktreeCarry({ branch: 'feat/done', upstream: 'origin/feat/done', mergedInto: 'origin/main' })).toEqual({ carry: false, reason: 'merged', text: 'merged into origin/main' });
    expect(worktreeCarry({ branch: null, upstream: null, mergedInto: null })).toMatchObject({ carry: false, reason: 'no-remote-branch' });
    // No remote branch wins over merged (a merged branch whose remote branch was deleted).
    expect(worktreeCarry({ branch: 'feat/gone', upstream: null, mergedInto: 'origin/main' })).toMatchObject({ reason: 'no-remote-branch' });
  });

  it('warns only when a skipped worktree holds uncommitted changes', () => {
    expect(skippedWarning(0, 'pc-office')).toBeNull();
    expect(skippedWarning(1, 'pc-office')).toBe('Its 1 uncommitted file stays on pc-office.');
    expect(skippedWarning(3, 'pc-office')).toBe('Its 3 uncommitted files stay on pc-office.');
  });

  it('keeps a worktree at its place next to the checkout, on the target the target way', () => {
    expect(worktreeLayout('/Users/me/ws/front', '/Users/me/ws/front/.claude/worktrees/attest-release')).toBe('.claude/worktrees/attest-release');
    expect(worktreeLayout('/Users/me/ws/front', '/Users/me/ws/front-wt-fix')).toBe('../front-wt-fix');
    expect(worktreeLayout('/Users/me/ws/front', '/tmp/elsewhere/x')).toBeNull();
    expect(worktreeLayout('/Users/me/ws/front', '/Users/me/ws/front')).toBeNull();
    expect(worktreeAtTarget('D:\\code\\ws\\front', '.claude/worktrees/attest-release')).toBe('D:\\code\\ws\\front\\.claude\\worktrees\\attest-release');
    expect(worktreeAtTarget('D:\\code\\ws\\front', '../front-wt-fix')).toBe('D:\\code\\ws\\front-wt-fix');
    expect(worktreeAtTarget('/home/me/front', '.claude/worktrees/a')).toBe('/home/me/front/.claude/worktrees/a');
    for (const bad of ['', '..', '../..', '../a/b', 'a/../b', '.git/x', 'a//b', 'a/CON', 'a/b:c', '/abs', 'a/b.', 'x/'.repeat(9) + 'y', 42]) expect(isSafeWorktreeLayout(bad), String(bad)).toBe(false);
    for (const good of ['.claude/worktrees/attest-release', '../front-wt-fix', 'wt']) expect(isSafeWorktreeLayout(good), good).toBe(true);
  });

  it('groups rows by their main checkout: one entry per repo, worktrees nested, skipped ones under it', () => {
    const rows = [
      { name: 'front', path: '/ws/front/.claude/worktrees/a', kind: 'worktree' as const, mainPath: '/ws/front' },
      { name: 'back', path: '/ws/back', kind: 'main' as const, mainPath: '/ws/back' },
      { name: 'front', path: '/ws/front', kind: 'main' as const, mainPath: '/ws/front' },
      { name: 'front', path: '/ws/front/.claude/worktrees/b', kind: 'worktree' as const, mainPath: '/ws/front' },
    ];
    const skipped: SkippedWorktree[] = [{ name: 'front', path: '/ws/front/.claude/worktrees/c', mainPath: '/ws/front', branch: 'feat/c', reason: 'merged', text: 'merged into origin/main', uncommitted: 0, warning: null }];
    const groups = groupByRepo(rows, skipped);
    expect(groups.map((group) => [group.name, group.main?.path ?? null, group.worktrees.map((row) => row.path), group.skipped.map((entry) => entry.path)])).toEqual([
      ['front', '/ws/front', ['/ws/front/.claude/worktrees/a', '/ws/front/.claude/worktrees/b'], ['/ws/front/.claude/worktrees/c']],
      ['back', '/ws/back', [], []],
    ]);
    // Windows paths compare without case; a row without mainPath is its own repo.
    expect(groupByRepo([{ name: 'x', path: 'D:\\WS\\x', kind: 'main' }, { name: 'x', path: 'd:/ws/x/.claude/worktrees/y', kind: 'worktree', mainPath: 'd:\\ws\\X' }])).toHaveLength(1);
  });
});

describe('D153: a target checkout with uncommitted changes', () => {
  const PLAN = { sessionName: 'move-me', defaultCloneParent: '/Users/me/code', worktreePathOf: (repoPath: string, name: string) => `${repoPath}-wt-${name}` };
  const repo = (patch: Partial<SourceRepo> = {}): SourceRepo => ({
    key: 'app',
    name: 'app',
    kind: 'main',
    path: '/src/app',
    mainPath: '/src/app',
    branch: 'feature/x',
    remoteName: 'origin',
    remoteUrl: 'git@github.com:acme/app.git',
    remoteKey: 'github.com/acme/app',
    headSha: 'a'.repeat(40),
    upstream: null,
    ahead: null,
    dirty: { modified: 0, untracked: 0, total: 0 },
    baseRef: null,
    parentBranch: null,
    ...patch,
  });
  const candidate: TargetCandidate = { path: '/Users/me/code/app', folderId: 'f1', folderKind: 'repo', folderPath: '/Users/me/code/app', name: 'app', remoteKey: 'github.com/acme/app', remoteName: 'origin' };
  const changes = { files: ['notes.txt', 'src/a.ts', 'new.md'], modified: 2, untracked: 1, total: 3, truncated: false };

  it('blocks with the changed files until stashing is confirmed, then uses the checkout and stashes', () => {
    const options = { ...PLAN, dirtyTargets: new Set([candidate.path]), targetChanges: new Map([[candidate.path, changes]]), machineName: 'pc-office' };
    const blocked = planRepos([repo()], [candidate], options)[0];
    expect(blocked).toMatchObject({ action: 'blocked', targetChanges: changes });
    expect(blocked?.reason).toBe('/Users/me/code/app has uncommitted changes on the target (3 files: notes.txt, src/a.ts, new.md): commit or stash them first, or choose "Stash them on pc-office"');
    const confirmed = planRepos([repo()], [candidate], { ...options, stashTargets: ['/Users/me/code/app/'] })[0];
    expect(confirmed).toMatchObject({ action: 'use', matchedPath: candidate.path, stash: true, targetChanges: changes });
    expect(confirmed?.summary).toContain('stash 3 uncommitted files there on pc-office first');
  });

  it('says one blocker once per checkout even when several repos need it', () => {
    const options = { ...PLAN, dirtyTargets: new Set([candidate.path]), targetChanges: new Map([[candidate.path, changes]]), machineName: 'pc-office' };
    const resolutions = planRepos([repo(), repo({ key: 'app-2', path: '/src/app-copy' })], [candidate], options);
    expect(resolutions.filter((entry) => entry.action === 'blocked')).toHaveLength(2);
    expect(planBlockers(resolutions)).toHaveLength(1);
  });

  it('writes the stash message, its note and the request field', () => {
    const message = stashMessage('Reviewer', 'mac-laptop', new Date(2026, 10, 5, 9, 7));
    expect(message).toBe('switchboard: before moving Reviewer from mac-laptop (2026-11-05 09:07)');
    expect(stashMessage('a\nb', 'c', new Date(2026, 0, 1))).not.toContain('\n');
    const note = stashNote({ path: 'D:\\code\\app', machine: 'pc-office', message, files: 2, commit: null });
    expect(note).toContain('Stashed 2 uncommitted files in D:\\code\\app on pc-office');
    expect(note).toContain('git stash list');
    expect(changesLine({ files: ['a', 'b'], modified: 60, untracked: 0, total: 60, truncated: true }, 2)).toBe('60 files: a, b and 58 more');
    expect(dirtyTargetBlocker('/x', 'pc', null)).toBe('/x has uncommitted changes on the target: commit or stash them first, or choose "Stash them on pc"');
    expect(stashTargetsOf(undefined)).toBeUndefined();
    expect(stashTargetsOf(['/a', '/a'])).toEqual(['/a']);
    expect(stashTargetsOf('/a')).toBeNull();
    expect(stashTargetsOf([''])).toBeNull();
    expect(stashConfirmed(['D:\\Code\\App'], 'd:/code/app')).toBe(true);
    expect(stashConfirmed(['/Users/me/App'], '/Users/me/app')).toBe(false);
  });
});

describe('D153: the move dialog model', () => {
  const sourceRepo = (name: string, at: string, kind: 'main' | 'worktree', mainPath: string): SourceRepo => ({
    key: `${name}-${at.length}`,
    name,
    kind,
    path: at,
    mainPath,
    branch: 'feat',
    remoteName: 'origin',
    remoteUrl: `https://example.com/acme/${name}.git`,
    remoteKey: `example.com/acme/${name}`,
    headSha: 'a'.repeat(40),
    upstream: null,
    ahead: null,
    dirty: { modified: 0, untracked: 0, total: 0 },
    baseRef: null,
    parentBranch: null,
    evidence: ['commands'],
  });
  const preview = (): TakeoverPreview =>
    ({
      source: {
        repos: [sourceRepo('front', '/ws/front', 'main', '/ws/front'), sourceRepo('front', '/ws/front/.claude/worktrees/live', 'worktree', '/ws/front')],
        skippedWorktrees: [
          { name: 'front', path: '/ws/front/.claude/worktrees/local', mainPath: '/ws/front', branch: 'feat/local', reason: 'no-remote-branch', text: 'no remote branch', uncommitted: 2, warning: 'Its 2 uncommitted files stay on pc-office.' },
          { name: 'front', path: '/ws/front/.claude/worktrees/done', mainPath: '/ws/front', branch: 'feat/done', reason: 'merged', text: 'merged into origin/main', uncommitted: 0, warning: null },
        ],
      },
      target: {
        repos: [
          { key: 'a', name: 'front', matchedPath: 'D:\\ws\\front', targetChanges: { files: ['x.txt'], modified: 0, untracked: 1, total: 1, truncated: false }, action: 'blocked' },
          { key: 'b', name: 'front', matchedPath: 'D:\\ws\\front', targetChanges: { files: ['x.txt'], modified: 0, untracked: 1, total: 1, truncated: false }, action: 'blocked' },
        ],
      },
    }) as unknown as TakeoverPreview;

  it('shows one repo entry with its worktrees and the skipped ones', () => {
    expect(worksInLine(preview())).toBe('front (/ws/front; commands; 1 worktree carried; 2 skipped)');
    const groups = carryGroups(preview(), { placement: null, clonePaths: {}, files: null });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.main?.path).toBe('/ws/front');
    expect(groups[0]?.worktrees.map((row) => row.label)).toEqual(['live']);
    expect(groups[0]?.skipped.map((entry) => [entry.label, entry.reason, entry.warning])).toEqual([
      ['local', 'no-remote-branch', 'Its 2 uncommitted files stay on pc-office.'],
      ['done', 'merged', null],
    ]);
  });

  it('lists a dirty target checkout once, and the stash choice travels in the body', () => {
    const empty = { placement: null, clonePaths: {}, files: null };
    expect(stashRows(preview(), empty)).toEqual([{ path: 'D:\\ws\\front', names: ['front'], changes: expect.objectContaining({ total: 1 }), confirmed: false }]);
    const chosen = withStash(empty, 'D:\\ws\\front', true);
    expect(chosen.stashTargets).toEqual(['D:\\ws\\front']);
    expect(stashRows(preview(), chosen)[0]?.confirmed).toBe(true);
    expect(withStash(chosen, 'D:\\ws\\front', false).stashTargets).toBeUndefined();
  });
});
