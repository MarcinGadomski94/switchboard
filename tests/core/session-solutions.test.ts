import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addsWorktree } from '../../src/core/derive/artifacts.ts';
import { sameSolution, withSolutions, writtenSolution } from '../../src/core/session-solutions.ts';
import { isSessionWorktree, parseWorktreeList } from '../../src/core/worktrees.ts';

/**
 * D38: a workspace session's solutions fill in from what its agents write (the
 * D21 derivation) and from the worktrees its agent creates (adopted when they are
 * on the session's branch or at `<repo>-wt-<name>`).
 */
const root = path.join(path.sep, 'ws');
const ws = { root, kind: 'workspace' as const, cwd: root };

describe('writtenSolution (D38 fill-in from a write)', () => {
  it('names the solution as the chips do; the session worktree maps to its repo', () => {
    expect(writtenSolution(ws, 'microfrontends/acme-app-front/src/a.ts', 'demo')).toBe('acme-app-front');
    expect(writtenSolution(ws, path.join(root, 'microfrontends', 'acme-app-front-wt-demo', 'a.ts'), 'demo')).toBe('acme-app-front');
    expect(writtenSolution(ws, 'mobile/App.xaml', 'demo')).toBe('mobile');
    expect(writtenSolution(ws, 'mobile-wt-demo/App.xaml', 'demo')).toBe('mobile');
    expect(writtenSolution(ws, 'other/tool/x.md', 'demo')).toBe('tool');
  });

  it('nothing for the workspace root, a path outside it, read-only solutions and repo folders', () => {
    expect(writtenSolution(ws, 'contracts/free-talk.md', 'demo')).toBeNull();
    expect(writtenSolution(ws, 'notes.md', 'demo')).toBeNull();
    expect(writtenSolution(ws, path.join(path.sep, 'elsewhere', 'x.ts'), 'demo')).toBeNull();
    expect(writtenSolution(ws, 'deprecated/microfrontends/old-front/a.ts', 'demo')).toBeNull();
    expect(writtenSolution(ws, 'infrastructure/main.tf', 'demo')).toBeNull();
    const repo = path.join(path.sep, 'src', 'app');
    expect(writtenSolution({ root: repo, kind: 'repo', cwd: repo }, 'a.ts', 'demo')).toBeNull();
  });
});

describe('withSolutions (D38)', () => {
  it('appends what is missing in order; null when nothing is new', () => {
    expect(withSolutions([], ['web-front'])).toEqual(['web-front']);
    expect(withSolutions(['web-front'], ['mobile', 'web-front', 'mobile'])).toEqual(['web-front', 'mobile']);
    expect(withSolutions(['web-front'], ['web-front'])).toBeNull();
    expect(withSolutions(['web-front'], [' '])).toBeNull();
  });

  it('a relative path and its name are the same solution', () => {
    expect(sameSolution('microfrontends/web-front', 'web-front')).toBe(true);
    expect(sameSolution('web-front', 'microfrontends/web-front')).toBe(true);
    expect(sameSolution('web-front', 'billing-front')).toBe(false);
    expect(sameSolution('front', 'web-front')).toBe(false);
    expect(withSolutions(['microfrontends/web-front'], ['web-front'])).toBeNull();
  });
});

describe('addsWorktree (D38: the Bash commands that trigger an adoption)', () => {
  it('git worktree add, with -C / -c before the subcommand, after cd, in a chain', () => {
    expect(addsWorktree('git worktree add -b PROJ-1-x ../web-front-wt-demo')).toBe(true);
    expect(addsWorktree('cd microfrontends/web-front && git worktree add -b PROJ-1-x ../web-front-wt-demo')).toBe(true);
    expect(addsWorktree('git -C microfrontends/web-front worktree add -b PROJ-1-x ../web-front-wt-demo')).toBe(true);
    expect(addsWorktree('git -c core.hooksPath=/dev/null -C "work space/mobile" worktree add ../mobile-wt-demo')).toBe(true);
    expect(addsWorktree('npm test; git --no-pager worktree add x')).toBe(true);
  });

  it('not for other git commands', () => {
    expect(addsWorktree('git worktree list --porcelain')).toBe(false);
    expect(addsWorktree('git -C x worktree remove ../y')).toBe(false);
    expect(addsWorktree('git checkout -b PROJ-1-x')).toBe(false);
    expect(addsWorktree('echo worktree add')).toBe(false);
  });
});

describe('parseWorktreeList / isSessionWorktree (D38 adoption)', () => {
  const porcelain = [
    'worktree /ws/microfrontends/web-front',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree /ws/microfrontends/web-front-wt-demo',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/PROJ-12-free-talk',
    '',
    'worktree /tmp/elsewhere',
    'HEAD 3333333333333333333333333333333333333333',
    'branch refs/heads/PROJ-12-free-talk',
    'locked because',
    '',
    'worktree /ws/microfrontends/web-front-wt-other',
    'HEAD 4444444444444444444444444444444444444444',
    'detached',
    '',
    'worktree /ws/microfrontends/gone-wt-demo',
    'HEAD 5555555555555555555555555555555555555555',
    'branch refs/heads/feature/x',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n');

  it('parses every record: path, HEAD, short branch, detached, prunable', () => {
    const list = parseWorktreeList(porcelain);
    expect(list.map((w) => [w.path, w.branch, w.prunable])).toEqual([
      ['/ws/microfrontends/web-front', 'main', false],
      ['/ws/microfrontends/web-front-wt-demo', 'PROJ-12-free-talk', false],
      ['/tmp/elsewhere', 'PROJ-12-free-talk', false],
      ['/ws/microfrontends/web-front-wt-other', null, false],
      ['/ws/microfrontends/gone-wt-demo', 'feature/x', true],
    ]);
    expect(list[0]?.head).toBe('1111111111111111111111111111111111111111');
    expect(parseWorktreeList('worktree /bare\nbare\n')).toEqual([{ path: '/bare', head: null, branch: null, bare: true, prunable: false }]);
    expect(parseWorktreeList('')).toEqual([]);
  });

  it('adopts the session branch anywhere, or <repo>-wt-<name> on any branch; never detached, bare or gone', () => {
    const [, named, elsewhere, detached, gone] = parseWorktreeList(porcelain);
    const match = { sessionName: 'demo', branch: 'PROJ-12-free-talk', repoPath: '/ws/microfrontends/web-front', solution: 'web-front' };
    expect(isSessionWorktree(named!, match)).toBe(true);
    expect(isSessionWorktree(elsewhere!, match)).toBe(true);
    expect(isSessionWorktree(detached!, match)).toBe(false);
    expect(isSessionWorktree(gone!, { ...match, repoPath: '/ws/microfrontends/gone' })).toBe(false);
    // No stored branch (a session from before D38): the path alone.
    expect(isSessionWorktree(named!, { ...match, branch: null })).toBe(true);
    expect(isSessionWorktree(elsewhere!, { ...match, branch: null })).toBe(false);
    // Another session's name does not match.
    expect(isSessionWorktree(named!, { ...match, branch: null, sessionName: 'other' })).toBe(false);
    // A nested checkout (mobile/<clone>): the solution's name counts as <repo> too.
    const nested = parseWorktreeList('worktree /ws/mobile/app\nbranch refs/heads/main\n\nworktree /ws/mobile/mobile-wt-demo\nbranch refs/heads/x\n')[1]!;
    expect(isSessionWorktree(nested, { sessionName: 'demo', branch: null, repoPath: '/ws/mobile/app', solution: 'mobile' })).toBe(true);
  });
});
