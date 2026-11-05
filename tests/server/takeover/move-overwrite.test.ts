import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import type { TakeoverPreview, TakeoverRun } from '../../../src/core/takeover.ts';
import { makeTempDir } from '../../helpers/net.ts';
import { waitFor } from '../../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, startWorkspaceSession, takeoverWorld } from '../../helpers/takeover.ts';

/**
 * D157 (`docs/peers.md` → *A target branch with commits the source does not have
 * (D157)*), two real Switchboards (the pc "a" and the mac "b"), fake CLIs, temp
 * repos and local bare remotes: the mac's front has a commit of its own on main.
 * The preview lists it as a choice (blocked without the tick); a move that fails
 * after the overwrite puts main back on its old tip (the backup branch stays); with
 * `overwriteTargets` the move succeeds, main is at the restored commit, a backup
 * branch keeps the old tip, and nothing is pushed.
 */

let tmp: string;
let world: TakeoverWorld;
let onMac: string;
let macTip: string;

beforeAll(async () => {
  tmp = await makeTempDir('takeover-overwrite');
  world = await takeoverWorld(tmp, { aRepos: { workspace: true }, bRepos: { workspace: true } });
  onMac = world.paths.b.front;
  await writeFile(path.join(onMac, 'mac-only.txt'), 'only on the mac\n');
  await world.git(onMac, 'add', 'mac-only.txt');
  await world.git(onMac, 'commit', '-q', '-m', 'mac only work');
  macTip = await world.git(onMac, 'rev-parse', 'main');
}, 120_000);

afterAll(async () => {
  if (world) await Promise.all([world.a.server.stop(), world.b.server.stop()]);
  await removeWorld(tmp);
});

async function preview(body: Record<string, unknown>): Promise<TakeoverPreview> {
  const answer = await world.a.call('POST', '/api/takeover/preview', body);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body as TakeoverPreview;
}

async function runOn(body: Record<string, unknown>): Promise<TakeoverRun> {
  const started = await world.a.call('POST', '/api/takeover', body);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const id = (started.body as TakeoverRun).id;
  return waitFor('the take-over to end', async () => {
    const current = (await world.a.call('GET', `/api/takeover/runs/${id}`)).body as TakeoverRun;
    return current.state === 'running' ? null : current;
  }, 90_000);
}

describe('D157: a target branch with commits the source does not have', () => {
  it('the preview lists the commits as a choice; blocked without the tick', async () => {
    const session = await startWorkspaceSession(world.a, world.folders.a.workspace as string, 'ws-preview', ['front']);
    const base = { sessionId: session.id, targetMachine: world.bId };
    expect((await world.a.call('POST', '/api/takeover/preview', { ...base, overwriteTargets: 'yes' })).status).toBe(422);
    const blocked = await preview(base);
    expect(blocked.ok).toBe(false);
    const front = blocked.target.repos.find((repo) => repo.name === 'front');
    expect(front).toMatchObject({ action: 'blocked', matchedPath: onMac, targetDiverged: { branch: 'main', count: 1, truncated: false } });
    expect(front?.targetDiverged?.commits.map((commit) => commit.subject)).toEqual(['mac only work']);
    const line = blocked.blockers.find((entry) => entry.includes('Overwrite them on mac-laptop (keep a backup branch)'));
    expect(line).toContain(`mac-laptop's main in ${onMac} has 1 commit that isn't on pc-office`);
    const ticked = await preview({ ...base, overwriteTargets: [onMac] });
    expect(ticked.blockers, JSON.stringify(ticked.blockers)).toEqual([]);
    expect(ticked.target.repos.find((repo) => repo.name === 'front')).toMatchObject({ action: 'use', overwrite: true });
    // A preview changes nothing.
    expect(await world.git(onMac, 'rev-parse', 'main')).toBe(macTip);
  });

  it('a failure after the overwrite puts the branch back on its old tip; the backup stays', async () => {
    // back diverges too, in a way the plan cannot see (the pc's tip is not on the mac, the mac has no remote-tracking main): the apply refuses it after front was overwritten.
    await writeFile(path.join(world.paths.b.back, 'mac-back.txt'), 'mac\n');
    await world.git(world.paths.b.back, 'add', '-A');
    await world.git(world.paths.b.back, 'commit', '-q', '-m', 'mac back');
    await world.git(world.paths.b.back, 'update-ref', '-d', 'refs/remotes/origin/main');
    await writeFile(path.join(world.paths.a.back, 'pc-back.txt'), 'pc\n');
    await world.git(world.paths.a.back, 'add', '-A');
    await world.git(world.paths.a.back, 'commit', '-q', '-m', 'pc back');
    const session = await startWorkspaceSession(world.a, world.folders.a.workspace as string, 'ws-fails', ['front', 'back']);
    const run = await runOn({ sessionId: session.id, targetMachine: world.bId, overwriteTargets: [onMac] });
    expect(run.state).toBe('failed');
    expect(run.error?.step).toBe('apply');
    expect(run.error?.message).toContain('back: the branch main on this machine has commits the original does not have');
    expect(run.rolledBack, JSON.stringify(run.rollbackNotes)).toBe(true);
    expect(run.overwrites).toHaveLength(1);
    const backup = run.overwrites?.[0]?.backup as string;
    expect(backup).toMatch(/^switchboard\/backup\/main-\d{8}-\d{4}$/);
    expect(await world.git(onMac, 'rev-parse', 'main')).toBe(macTip);
    expect(await world.git(onMac, 'rev-parse', backup)).toBe(macTip);
    expect(await world.git(onMac, 'status', '--porcelain')).toBe('');
    // Put back as it was.
    await world.git(world.paths.b.back, 'reset', '-q', '--hard', 'origin/main');
    await world.git(world.paths.a.back, 'reset', '-q', '--hard', 'origin/main');
    await world.git(onMac, 'branch', '-q', '-D', backup);
    await waitFor('the session to be live again', async () => ((await world.a.call('GET', `/api/sessions/${session.id}`)).body as Session).status !== 'run', 20_000);
  });

  it('with the tick: the branch is at the restored commit, a backup branch keeps the old tip, nothing is pushed', async () => {
    const session = await startWorkspaceSession(world.a, world.folders.a.workspace as string, 'ws-overwrite', ['front']);
    const pcTip = await world.git(world.paths.a.front, 'rev-parse', 'main');
    const run = await runOn({ sessionId: session.id, targetMachine: world.bId, overwriteTargets: [onMac] });
    expect(run.error, JSON.stringify(run)).toBeNull();
    expect(run.state).toBe('done');
    expect(await world.git(onMac, 'rev-parse', 'main')).toBe(pcTip);
    expect(await world.git(onMac, 'branch', '--show-current')).toBe('main');
    const overwrite = run.overwrites?.[0];
    expect(overwrite).toMatchObject({ path: onMac, machine: 'mac-laptop', branch: 'main', oldTip: macTip, count: 1 });
    const backup = overwrite?.backup as string;
    expect(await world.git(onMac, 'rev-parse', backup)).toBe(macTip);
    expect(await world.git(onMac, 'log', '--format=%s', '-1', backup)).toBe('mac only work');
    expect(run.log.join('\n')).toContain(`1 commit on main was replaced on mac-laptop (${onMac}); they are kept on ${backup} (git log ${backup})`);
    // Nothing pushed: the remote has no backup branch and its main is untouched.
    const heads = await world.git(onMac, 'ls-remote', '--heads', world.remotes.front);
    expect(heads).not.toContain('switchboard/backup');
    expect(heads).toContain(`${pcTip}\trefs/heads/main`);
  });
});
