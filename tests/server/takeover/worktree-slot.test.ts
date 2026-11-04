import { mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TakeoverGit } from '../../../src/server/takeover/git.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { gitEnv } from '../../helpers/peers.ts';
import { gitIn } from '../../helpers/takeover.ts';

/**
 * What is at the path where the restore creates a worktree, with real git and temp
 * repos (`docs/peers.md` → *A worktree folder in the way*): free, an empty folder,
 * a stale (prunable) entry, a live or locked worktree, a non-empty folder, a file;
 * a stale entry whose folder is gone no longer counts as holding its branch; the
 * restore's clearing removes only the stale entry in its way (never `git worktree
 * prune`) and only an empty folder.
 */

let tmp: string;

beforeEach(async () => {
  tmp = await realpath(await makeTempDir('takeover-wt-slot'));
  await writeFile(path.join(tmp, 'gitconfig'), '');
});
afterEach(async () => {
  await removeTempDir(tmp);
});

async function repo(): Promise<string> {
  const dir = path.join(tmp, 'code', 'app');
  await mkdir(dir, { recursive: true });
  await gitIn(tmp, dir, 'init', '-q', '-b', 'main');
  await writeFile(path.join(dir, 'README.md'), '# app\n');
  await gitIn(tmp, dir, 'add', '-A');
  await gitIn(tmp, dir, 'commit', '-q', '-m', 'init');
  await gitIn(tmp, dir, 'branch', 'feature');
  return dir;
}

const git = (): TakeoverGit => new TakeoverGit({ log: () => undefined, env: { ...process.env, ...gitEnv(tmp) } });

describe('TakeoverGit.worktreeSlot', () => {
  it('free, empty folder, non-empty folder, file', async () => {
    const main = await repo();
    const at = path.join(tmp, 'code', 'app-wt-x');
    expect(await git().worktreeSlot(main, at)).toEqual({ kind: 'free' });
    expect(await git().worktreeSlot(null, at)).toEqual({ kind: 'free' });
    await mkdir(at);
    expect(await git().worktreeSlot(main, at)).toEqual({ kind: 'empty-folder' });
    await writeFile(path.join(at, 'left.txt'), 'from an earlier move\n');
    expect(await git().worktreeSlot(main, at)).toEqual({ kind: 'folder' });
    expect(await git().worktreeSlot(null, at)).toEqual({ kind: 'folder' });
    await rm(at, { recursive: true });
    await writeFile(at, 'a file\n');
    expect(await git().worktreeSlot(main, at)).toEqual({ kind: 'file' });
  });

  it('a live worktree, a locked one, and a stale entry whose folder is gone', async () => {
    const main = await repo();
    const at = path.join(tmp, 'code', 'app-wt-x');
    await gitIn(tmp, main, 'worktree', 'add', '-q', at, 'feature');
    expect(await git().worktreeSlot(main, at)).toEqual({ kind: 'worktree', branch: 'feature', locked: false });
    // Another spelling of the same path (a trailing separator) is the same worktree.
    expect(await git().worktreeSlot(main, `${at}${path.sep}`)).toEqual({ kind: 'worktree', branch: 'feature', locked: false });
    expect((await git().checkedOutBranches(main)).get('feature')).toBeDefined();
    await rm(at, { recursive: true, force: true });
    expect(await git().worktreeSlot(main, at)).toEqual({ kind: 'stale-entry' });
    // A stale entry does not hold its branch for the plan (the restore prunes it first).
    expect((await git().checkedOutBranches(main)).has('feature')).toBe(false);
    await mkdir(at);
    expect(await git().worktreeSlot(main, at)).toEqual({ kind: 'stale-entry' });
    await gitIn(tmp, main, 'worktree', 'lock', at);
    await rm(at, { recursive: true, force: true });
    expect(await git().worktreeSlot(main, at)).toEqual({ kind: 'worktree', branch: 'feature', locked: true });
    expect((await git().checkedOutBranches(main)).has('feature')).toBe(true);
  });
});

describe('TakeoverGit.clearWorktreeSlot', () => {
  it('removes an empty folder, then the stale entry at the path or on the branch (that entry only); a worktree add works after', async () => {
    const main = await repo();
    const at = path.join(tmp, 'code', 'app-wt-x');
    await gitIn(tmp, main, 'worktree', 'add', '-q', at, 'feature');
    await rm(at, { recursive: true, force: true });
    await mkdir(at);
    // Another stale entry (its folder gone, another branch) is not this take-over's business: it stays.
    const unrelated = path.join(tmp, 'code', 'app-wt-unrelated');
    await gitIn(tmp, main, 'worktree', 'add', '-q', '-b', 'unrelated', unrelated);
    await rm(unrelated, { recursive: true, force: true });
    const cleared = await git().clearWorktreeSlot(main, at, 'feature');
    expect(cleared.removedEmptyFolder).toBe(true);
    expect(cleared.removedEntries).toHaveLength(1);
    expect(await gitIn(tmp, main, 'worktree', 'list', '--porcelain')).toContain('app-wt-unrelated');
    expect(await gitIn(tmp, main, 'worktree', 'list', '--porcelain')).not.toContain('app-wt-x');
    await gitIn(tmp, main, 'worktree', 'add', '-q', at, 'feature');
    expect(await gitIn(tmp, at, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature');

    // A stale entry elsewhere that holds the branch a main checkout needs.
    const other = path.join(tmp, 'code', 'app-wt-elsewhere');
    await gitIn(tmp, main, 'worktree', 'remove', '--force', at);
    await gitIn(tmp, main, 'worktree', 'add', '-q', other, 'feature');
    await rm(other, { recursive: true, force: true });
    expect(await git().clearWorktreeSlot(main, null, 'feature')).toMatchObject({ removedEntries: [expect.stringContaining('app-wt-elsewhere')], removedEmptyFolder: false });
    await gitIn(tmp, main, 'checkout', '-q', 'feature');
  });

  it('never touches a live worktree, a locked entry or a non-empty folder', async () => {
    const main = await repo();
    const live = path.join(tmp, 'code', 'app-wt-live');
    await gitIn(tmp, main, 'worktree', 'add', '-q', live, 'feature');
    await writeFile(path.join(live, 'work.txt'), 'uncommitted\n');
    const locked = path.join(tmp, 'code', 'app-wt-locked');
    await gitIn(tmp, main, 'worktree', 'add', '-q', '-b', 'other', locked);
    await gitIn(tmp, main, 'worktree', 'lock', locked);
    await rm(locked, { recursive: true, force: true });
    const leftover = path.join(tmp, 'code', 'app-wt-left');
    await mkdir(leftover);
    await writeFile(path.join(leftover, 'keep.txt'), 'keep\n');
    expect(await git().clearWorktreeSlot(main, leftover, 'feature')).toEqual({ removedEntries: [], removedEmptyFolder: false });
    expect(await git().clearWorktreeSlot(main, locked, 'other')).toEqual({ removedEntries: [], removedEmptyFolder: false });
    expect(await readdir(leftover)).toEqual(['keep.txt']);
    expect(await stat(path.join(live, 'work.txt'))).toBeTruthy();
    const list = await gitIn(tmp, main, 'worktree', 'list', '--porcelain');
    expect(list).toContain('app-wt-live');
    expect(list).toContain('app-wt-locked');
  });
});
