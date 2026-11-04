import { mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TakeoverGit } from '../../../src/server/takeover/git.ts';
import { writeFakeSsh } from '../../helpers/fake-ssh.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { gitEnv } from '../../helpers/peers.ts';
import { gitIn } from '../../helpers/takeover.ts';

/**
 * The git side of the take-over's remote check and undo (`docs/peers.md` →
 * *Reaching the remote*, *Rollback*), with real git, temp repos, a local bare repo
 * and a fake `ssh` (never a real key, host or network): `reachable` answers
 * without a prompt and with git's reason; the restore's fetch and clone run ssh in
 * batch mode; the undo of a worktree that was never made is not a leftover.
 */

let tmp: string;

beforeEach(async () => {
  tmp = await realpath(await makeTempDir('takeover-remote'));
  await writeFile(path.join(tmp, 'gitconfig'), '');
});
afterEach(async () => {
  await removeTempDir(tmp);
});

/** The service's environment without any ssh setting of the machine running the tests. */
function serviceEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...gitEnv(tmp), ...extra };
  for (const key of ['GIT_SSH_COMMAND', 'SSH_AUTH_SOCK']) delete env[key];
  if (!extra['GIT_SSH']) delete env['GIT_SSH'];
  return env;
}

async function bareWithClone(): Promise<{ bare: string; clone: string }> {
  const bare = path.join(tmp, 'remotes', 'app.git');
  await mkdir(bare, { recursive: true });
  await gitIn(tmp, bare, 'init', '-q', '--bare', '-b', 'main');
  const clone = path.join(tmp, 'code', 'app');
  await mkdir(clone, { recursive: true });
  await gitIn(tmp, clone, 'init', '-q', '-b', 'main');
  await writeFile(path.join(clone, 'README.md'), '# app\n');
  await gitIn(tmp, clone, 'add', '-A');
  await gitIn(tmp, clone, 'commit', '-q', '-m', 'init');
  await gitIn(tmp, clone, 'remote', 'add', 'origin', bare);
  await gitIn(tmp, clone, 'push', '-q', 'origin', 'main');
  return { bare, clone };
}

describe.skipIf(process.platform === 'win32')('TakeoverGit.reachable: read-only, bounded, never a prompt', () => {
  it('a reachable remote (by name and by URL) passes; a missing one fails with git\'s reason', async () => {
    const { bare, clone } = await bareWithClone();
    const git = new TakeoverGit({ log: () => undefined, env: serviceEnv() });
    expect(await git.reachable(clone, 'origin')).toEqual({ ok: true });
    expect(await git.reachable(tmp, bare)).toEqual({ ok: true });
    await gitIn(tmp, clone, 'remote', 'set-url', 'origin', path.join(tmp, 'nowhere', 'app.git'));
    const missing = await git.reachable(clone, 'origin');
    expect(missing).toMatchObject({ ok: false, timedOut: false });
    expect((missing as { reason: string }).reason).toMatch(/does not appear to be a git repository/);
    expect((missing as { reason: string }).reason).not.toMatch(/Please make sure/);
  });

  it('an ssh remote whose key the service cannot use fails at once with "Permission denied (publickey)": ssh ran in batch mode', async () => {
    const { clone } = await bareWithClone();
    const ssh = await writeFakeSsh(path.join(tmp, 'bin'));
    await gitIn(tmp, clone, 'remote', 'set-url', 'origin', 'git@example.invalid:acme/app.git');
    const git = new TakeoverGit({ log: () => undefined, env: serviceEnv(ssh.env) });
    const started = Date.now();
    const answer = await git.reachable(clone, 'origin');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(answer).toEqual({ ok: false, reason: 'Permission denied (publickey)', timedOut: false });
    const calls = await ssh.calls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.includes('-o BatchMode=yes'))).toBe(true);
    expect(calls[0]).toContain('example.invalid');
  }, 30_000);

  it("the repo's own core.sshCommand is kept and gets BatchMode", async () => {
    const { clone } = await bareWithClone();
    const ssh = await writeFakeSsh(path.join(tmp, 'bin'));
    await gitIn(tmp, clone, 'remote', 'set-url', 'origin', 'ssh://git@example.invalid/acme/app.git');
    await gitIn(tmp, clone, 'config', 'core.sshCommand', `${ssh.program} -o IdentitiesOnly=yes`);
    const git = new TakeoverGit({ log: () => undefined, env: serviceEnv({ FAKE_SSH_LOG: ssh.log }) });
    expect(await git.reachable(clone, 'origin')).toMatchObject({ ok: false, reason: 'Permission denied (publickey)' });
    expect((await ssh.calls())[0]).toMatch(/^-o IdentitiesOnly=yes -o BatchMode=yes /);
  }, 30_000);

  it('the restore\'s fetch and clone run ssh in batch mode too (they fail at once instead of waiting at a prompt)', async () => {
    const { clone } = await bareWithClone();
    const ssh = await writeFakeSsh(path.join(tmp, 'bin'));
    await gitIn(tmp, clone, 'remote', 'set-url', 'origin', 'git@example.invalid:acme/app.git');
    const git = new TakeoverGit({ log: () => undefined, env: serviceEnv(ssh.env) });
    const started = Date.now();
    await expect(git.fetchTemp(clone, 'origin', 'switchboard/takeover/abcd1234/main', 'refs/switchboard/takeover/abcd1234/app')).rejects.toThrow(/: Permission denied \(publickey\)$/);
    await expect(git.clone('git@example.invalid:acme/app.git', path.join(tmp, 'elsewhere', 'app'))).rejects.toThrow(/: Permission denied \(publickey\)$/);
    expect(Date.now() - started).toBeLessThan(15_000);
    const calls = await ssh.calls();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((call) => call.includes('-o BatchMode=yes'))).toBe(true);
  }, 30_000);
});

describe('TakeoverGit.removePlannedWorktree: only what the restore made is undone', () => {
  it('a worktree that was made is removed', async () => {
    const { clone } = await bareWithClone();
    const git = new TakeoverGit({ log: () => undefined, env: serviceEnv() });
    const worktree = path.join(tmp, 'code', 'app-wt-made');
    await gitIn(tmp, clone, 'worktree', 'add', '-q', '-b', 'feature/made', worktree);
    expect(await git.removePlannedWorktree(clone, worktree, true)).toEqual({ outcome: 'removed' });
    expect(await stat(worktree).catch(() => null)).toBeNull();
  });

  it('a worktree that was never made is nothing to undo', async () => {
    const { clone } = await bareWithClone();
    const git = new TakeoverGit({ log: () => undefined, env: serviceEnv() });
    expect(await git.removePlannedWorktree(clone, path.join(tmp, 'code', 'app-wt-never'), false)).toEqual({ outcome: 'not-created' });
    // Its repo was never cloned either: still nothing to undo.
    expect(await git.removePlannedWorktree(path.join(tmp, 'code', 'not-cloned'), path.join(tmp, 'code', 'not-cloned-wt-x'), false)).toEqual({ outcome: 'not-created' });
  });

  it('an empty folder at the planned path is removed; a non-empty folder that is not a worktree is reported, never deleted', async () => {
    const { clone } = await bareWithClone();
    const git = new TakeoverGit({ log: () => undefined, env: serviceEnv() });
    const empty = path.join(tmp, 'code', 'app-wt-empty');
    await mkdir(empty, { recursive: true });
    expect(await git.removePlannedWorktree(clone, empty, false)).toEqual({ outcome: 'removed-empty-folder' });
    expect(await stat(empty).catch(() => null)).toBeNull();
    const full = path.join(tmp, 'code', 'app-wt-full');
    await mkdir(full, { recursive: true });
    await writeFile(path.join(full, 'notes.txt'), 'mine\n');
    const answer = await git.removePlannedWorktree(clone, full, false);
    expect(answer).toEqual({ outcome: 'left', note: `${full} was left behind: it is not a worktree of ${clone} and is not empty, so it was not deleted` });
    expect(await readdir(full)).toEqual(['notes.txt']);
  });

  it('never runs `git worktree prune`: another worktree\'s stale entry (an unplugged drive) survives the undo; a stale entry at the path is removed alone', async () => {
    const { clone } = await bareWithClone();
    const log: string[] = [];
    const git = new TakeoverGit({ log: (line) => log.push(line), env: serviceEnv() });
    const unplugged = path.join(tmp, 'code', 'app-wt-on-a-drive');
    await gitIn(tmp, clone, 'worktree', 'add', '-q', '-b', 'feature/drive', unplugged);
    await rm(unplugged, { recursive: true, force: true });
    const planned = path.join(tmp, 'code', 'app-wt-planned');
    await gitIn(tmp, clone, 'worktree', 'add', '-q', '-b', 'feature/planned', planned);
    await rm(planned, { recursive: true, force: true });
    expect(await git.removePlannedWorktree(clone, planned, true)).toEqual({ outcome: 'removed' });
    expect(await git.removePlannedWorktree(clone, path.join(tmp, 'code', 'app-wt-never'), false)).toEqual({ outcome: 'not-created' });
    const list = await gitIn(tmp, clone, 'worktree', 'list', '--porcelain');
    expect(list).toContain('app-wt-on-a-drive');
    expect(list).not.toContain('app-wt-planned');
    expect(log.some((line) => / worktree prune/.test(line))).toBe(false);
  });

  it('a live worktree at the path that this restore did not make is never forced: its files stay', async () => {
    const { clone } = await bareWithClone();
    const git = new TakeoverGit({ log: () => undefined, env: serviceEnv() });
    const theirs = path.join(tmp, 'code', 'app-wt-theirs');
    await gitIn(tmp, clone, 'worktree', 'add', '-q', '-b', 'feature/theirs', theirs);
    await writeFile(path.join(theirs, 'work.txt'), 'uncommitted\n');
    expect(await git.removePlannedWorktree(clone, theirs, false)).toEqual({ outcome: 'left', note: `${theirs} was left as it is: it is a worktree of ${clone} this move did not make` });
    expect(await readdir(theirs)).toContain('work.txt');
    expect(await gitIn(tmp, clone, 'worktree', 'list', '--porcelain')).toContain('app-wt-theirs');
  });
});
