/**
 * D121 · Plans: when git says an item's work is merged into the target (`PlanGit.inspect`), on
 * real temp repos. A fresh item branch (no commits of its own) is never merged, also when the
 * target moved between the recorded cut and the worktree's cut, or when the branch was
 * fast-forwarded to the target; a missing cut proves nothing; a closed PR is not merged.
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PlanGit } from '../../../src/server/plans/git.ts';
import { fakeGhCommand } from '../../../tools/fake-gh/command.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';

const TARGET = 'feature/PROJ-100-acme-epic';

let g: GitWorld | undefined;

afterEach(async () => {
  await g?.cleanup();
  g = undefined;
});

async function world(): Promise<{ g: GitWorld; repo: string; planGit: PlanGit; target: string }> {
  g = await makeGitWorld();
  const repo = await g.makeRepo(path.join(g.root, 'acme'));
  await g.git(repo, 'branch', TARGET, 'main');
  const target = path.join(g.root, 'target-checkout');
  await g.git(repo, 'worktree', 'add', '-q', target, TARGET);
  return { g, repo, planGit: new PlanGit({ gh: fakeGhCommand(), env: g.env }), target };
}

/** An item's worktree on `branch`, cut from the target's current tip (as the run's worktree is). */
async function cutItem(w: GitWorld, repo: string, branch: string): Promise<{ dir: string; cut: string }> {
  const dir = path.join(w.root, `wt-${branch}`);
  await w.git(repo, 'worktree', 'add', '-q', '-b', branch, dir, TARGET);
  return { dir, cut: await w.git(repo, 'rev-parse', branch) };
}

describe('D121 · PlanGit.inspect: merged only with commits of its own in the target', () => {
  it('a fresh branch with no commits is not merged', async () => {
    const { g: w, repo, planGit } = await world();
    const { cut } = await cutItem(w, repo, 'PROJ-1-work');
    const state = await planGit.inspect({ repo: 'acme', repoPath: repo, branch: 'PROJ-1-work', target: TARGET, cut });
    expect(state.merged).toBe(false);
    expect(state.hasWork).toBe(false);
  });

  it('the regression: the target moved between the recorded cut and the worktree cut → a fresh branch is not merged', async () => {
    const { g: w, repo, planGit, target } = await world();
    // The scheduler read the target's tip (the recorded cut) …
    const recorded = await w.git(repo, 'rev-parse', TARGET);
    // … another item's agent merged into the target before the worktree was made …
    await w.commit(target, 'other.txt', 'other\n', 'PROJ-9: other work');
    // … so the worktree was cut from the newer tip: no commits of its own.
    await cutItem(w, repo, 'PROJ-1-work');
    const state = await planGit.inspect({ repo: 'acme', repoPath: repo, branch: 'PROJ-1-work', target: TARGET, cut: recorded });
    expect(state.merged).toBe(false);
    expect(state.hasWork).toBe(false);
  });

  it('a fresh branch fast-forwarded to a newer target tip (no commits of its own) is not merged', async () => {
    const { g: w, repo, planGit, target } = await world();
    const { dir, cut } = await cutItem(w, repo, 'PROJ-1-work');
    await w.commit(target, 'other.txt', 'other\n', 'PROJ-9: other work');
    await w.git(dir, 'merge', '-q', '--ff-only', TARGET);
    const state = await planGit.inspect({ repo: 'acme', repoPath: repo, branch: 'PROJ-1-work', target: TARGET, cut });
    expect(state.merged).toBe(false);
  });

  it('commits not in the target → not merged (work, no merge)', async () => {
    const { g: w, repo, planGit } = await world();
    const { dir, cut } = await cutItem(w, repo, 'PROJ-1-work');
    await w.commit(dir, 'one.txt', 'one\n', 'PROJ-1: work');
    const state = await planGit.inspect({ repo: 'acme', repoPath: repo, branch: 'PROJ-1-work', target: TARGET, cut });
    expect(state.hasWork).toBe(true);
    expect(state.merged).toBe(false);
  });

  it('commits merged into the target → merged', async () => {
    const { g: w, repo, planGit, target } = await world();
    const { dir, cut } = await cutItem(w, repo, 'PROJ-1-work');
    await w.commit(dir, 'one.txt', 'one\n', 'PROJ-1: work');
    await w.git(target, 'merge', '-q', '--no-edit', 'PROJ-1-work');
    const state = await planGit.inspect({ repo: 'acme', repoPath: repo, branch: 'PROJ-1-work', target: TARGET, cut });
    expect(state.merged).toBe(true);
  });

  it('own commits plus a fast-forward from the target, then merged → merged', async () => {
    const { g: w, repo, planGit, target } = await world();
    const { dir, cut } = await cutItem(w, repo, 'PROJ-1-work');
    await w.commit(target, 'other.txt', 'other\n', 'PROJ-9: other work');
    await w.git(dir, 'merge', '-q', '--ff-only', TARGET);
    await w.commit(dir, 'one.txt', 'one\n', 'PROJ-1: work');
    await w.git(target, 'merge', '-q', '--no-edit', 'PROJ-1-work');
    const state = await planGit.inspect({ repo: 'acme', repoPath: repo, branch: 'PROJ-1-work', target: TARGET, cut });
    expect(state.merged).toBe(true);
  });

  it('multi-repo: each repo is judged on its own (one merged, one fresh)', async () => {
    const { g: w, repo, planGit, target } = await world();
    const other = await w.makeRepo(path.join(w.root, 'acme-api'));
    await w.git(other, 'branch', TARGET, 'main');
    const a = await cutItem(w, repo, 'PROJ-1-work');
    await w.commit(a.dir, 'one.txt', 'one\n', 'PROJ-1: work');
    await w.git(target, 'merge', '-q', '--no-edit', 'PROJ-1-work');
    const bDir = path.join(w.root, 'wt-api');
    await w.git(other, 'worktree', 'add', '-q', '-b', 'PROJ-1-work', bDir, TARGET);
    const bCut = await w.git(other, 'rev-parse', 'PROJ-1-work');
    const first = await planGit.inspect({ repo: 'acme', repoPath: repo, branch: 'PROJ-1-work', target: TARGET, cut: a.cut });
    const second = await planGit.inspect({ repo: 'acme-api', repoPath: other, branch: 'PROJ-1-work', target: TARGET, cut: bCut });
    expect(first.merged).toBe(true);
    expect(second.merged).toBe(false);
    expect(second.hasWork).toBe(false);
  });

  it('a missing cut: merged only when the branch itself proves where it started (its reflog), else not', async () => {
    const { g: w, repo, planGit, target } = await world();
    const { dir } = await cutItem(w, repo, 'PROJ-1-work');
    // Fresh, no cut recorded: not merged.
    expect((await planGit.inspect({ repo: 'acme', repoPath: repo, branch: 'PROJ-1-work', target: TARGET, cut: null })).merged).toBe(false);
    await w.commit(dir, 'one.txt', 'one\n', 'PROJ-1: work');
    await w.git(target, 'merge', '-q', '--no-edit', 'PROJ-1-work');
    // The reflog names the commit the branch was created from: its own commit is in the target.
    expect((await planGit.inspect({ repo: 'acme', repoPath: repo, branch: 'PROJ-1-work', target: TARGET, cut: null })).merged).toBe(true);
    // Without a reflog nothing proves it: not merged.
    await w.git(repo, 'reflog', 'expire', '--expire=all', '--all');
    expect((await planGit.inspect({ repo: 'acme', repoPath: repo, branch: 'PROJ-1-work', target: TARGET, cut: null })).merged).toBe(false);
  });

  it('a PR closed without a merge, or open, is not merged; a merged PR into the target is', async () => {
    const { g: w, repo, planGit } = await world();
    await w.addOrigin(repo);
    const { dir, cut } = await cutItem(w, repo, 'PROJ-1-work');
    const head = await w.commit(dir, 'one.txt', 'one\n', 'PROJ-1: work');
    const input = { repo: 'acme', repoPath: repo, branch: 'PROJ-1-work', target: TARGET, cut };
    await w.setPullRequests({ 'PROJ-1-work': { number: 7, state: 'CLOSED', url: 'https://example.invalid/pr/7', headRefOid: head, baseRefName: TARGET } });
    expect((await planGit.inspect(input)).merged).toBe(false);
    await w.setPullRequests({ 'PROJ-1-work': { number: 7, state: 'OPEN', url: 'https://example.invalid/pr/7', headRefOid: head, baseRefName: TARGET } });
    expect((await planGit.inspect(input)).merged).toBe(false);
    // Merged into another base: not into the target.
    await w.setPullRequests({ 'PROJ-1-work': { number: 7, state: 'MERGED', url: 'https://example.invalid/pr/7', headRefOid: head, baseRefName: 'main' } });
    expect((await planGit.inspect(input)).merged).toBe(false);
    await w.setPullRequests({ 'PROJ-1-work': { number: 7, state: 'MERGED', url: 'https://example.invalid/pr/7', headRefOid: head, baseRefName: TARGET } });
    expect((await planGit.inspect(input)).merged).toBe(true);
  });
});

describe('D121 · PlanGit.inspect: the remote target counts, unknown readings are flagged', () => {
  it('merged into origin/<target> only (the local target is behind) → merged', async () => {
    const { g: w, repo, planGit } = await world();
    const bare = await w.addOrigin(repo);
    await w.git(repo, 'push', '-q', 'origin', TARGET);
    await w.git(repo, 'fetch', '-q', 'origin');
    const { dir, cut } = await cutItem(w, repo, 'PROJ-1-work');
    const head = await w.commit(dir, 'one.txt', 'one\n', 'PROJ-1: work');
    // The merge happens on the remote (a second clone pushes it); the local target stays behind.
    const other = path.join(w.root, 'other-clone');
    await w.git(w.root, 'clone', '-q', bare, other);
    await w.git(repo, 'push', '-q', 'origin', 'PROJ-1-work');
    await w.git(other, 'fetch', '-q', 'origin');
    await w.git(other, 'checkout', '-q', TARGET);
    await w.git(other, 'merge', '-q', '--no-edit', 'origin/PROJ-1-work');
    await w.git(other, 'push', '-q', 'origin', TARGET);
    await w.git(repo, 'fetch', '-q', 'origin');
    expect(await w.git(repo, 'merge-base', '--is-ancestor', head, TARGET).then(() => true, () => false)).toBe(false);
    await w.setPullRequests({});
    const state = await planGit.inspect({ repo: 'acme', repoPath: repo, branch: 'PROJ-1-work', target: TARGET, cut });
    expect(state.merged).toBe(true);
  });

  it('a branch that is gone is unknown, not proven unmerged', async () => {
    const { g: w, repo, planGit } = await world();
    const { dir, cut } = await cutItem(w, repo, 'PROJ-1-work');
    await w.git(repo, 'worktree', 'remove', '--force', dir);
    await w.git(repo, 'branch', '-D', 'PROJ-1-work');
    const state = await planGit.inspect({ repo: 'acme', repoPath: repo, branch: 'PROJ-1-work', target: TARGET, cut });
    expect(state.merged).toBe(false);
    expect(state.unknown).toBe(true);
  });
});
