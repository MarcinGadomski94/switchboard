import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileDiff, Session, SessionEvent } from '../../../src/core/api.ts';
import { remoteId } from '../../../src/core/peers.ts';
import type { TakeoverPreview, TakeoverRun } from '../../../src/core/takeover.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, waitFor } from '../../helpers/peers.ts';
import { type TakeoverWorld, fakeLog, startRepoSession, startWorkspaceSession, takeoverWorld } from '../../helpers/takeover.ts';

/**
 * D65 scenarios on top of `flow.test.ts` (two real Switchboards, fake CLIs, temp
 * repos, a local bare repo as the shared remote): no changes, a move *to* the peer,
 * a session in a worktree, a workspace session with two repos, a missing repo that
 * is cloned, checks that stop before anything changes, a failure half-way that rolls
 * the source back exactly, and a temp branch the remote refuses to delete.
 */

let tmp: string;
let world: TakeoverWorld | null = null;

beforeEach(async () => {
  tmp = await makeTempDir('takeover-scenarios');
});
afterEach(async () => {
  if (world) await Promise.all([world.a.server.stop(), world.b.server.stop()]);
  world = null;
  await removeTempDir(tmp);
});

async function run(node: PeerNode, body: Record<string, unknown>): Promise<TakeoverRun> {
  const started = await node.call('POST', '/api/takeover', body);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const id = (started.body as TakeoverRun).id;
  return waitFor('the take-over to end', async () => {
    const current = (await node.call('GET', `/api/takeover/runs/${id}`)).body as TakeoverRun;
    return current.state === 'running' ? null : current;
  }, 90_000);
}

async function remoteHeads(w: TakeoverWorld, remote: string): Promise<string[]> {
  return (await w.git(w.root, 'ls-remote', '--heads', remote)).split('\n').filter((line) => line !== '').map((line) => line.split('\t')[1] as string);
}

async function snapshot(w: TakeoverWorld, repo: string): Promise<{ head: string; branch: string; status: string; index: string; refs: string }> {
  return {
    head: await w.git(repo, 'rev-parse', 'HEAD'),
    branch: await w.git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'),
    status: await w.git(repo, 'status', '--porcelain'),
    index: await w.git(repo, 'ls-files', '--stage'),
    refs: await w.git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
  };
}

async function sessionsOf(node: PeerNode): Promise<Session[]> {
  return (await node.call('GET', '/api/sessions?closed=include')).body as Session[];
}

describe('D65: no changes, and a move to the peer', () => {
  it('skips the WIP commit when nothing is uncommitted; a session of this machine moves to the peer; the link goes both ways', async () => {
    const w = (world = await takeoverWorld(tmp));
    const started = await startRepoSession(w.a, w.folders.a.alpha as string, 'tidy-docs');
    const before = await snapshot(w, w.paths.a.alpha);

    const finished = await run(w.a, { sessionId: started.id, targetMachine: w.bId });
    expect(finished.error, JSON.stringify(finished)).toBeNull();
    expect(finished.state).toBe('done');
    expect(finished.log.join('\n')).not.toContain('commit-tree');
    expect(finished.result).toMatchObject({ local: false, machineId: w.bId });
    const created = (await sessionsOf(w.b)).find((session) => session.movedFrom?.sessionId === started.id) as Session;
    expect(finished.result?.sessionId).toBe(remoteId(w.bId, created.id));
    expect(created).toMatchObject({ cwd: w.paths.b.alpha, claudeSessionId: started.claudeSessionId });
    // The mac is on the same branch, clean; the pc is as it was; the remote has no temp branch.
    expect(await w.git(w.paths.b.alpha, 'status', '--porcelain')).toBe('');
    expect(await w.git(w.paths.b.alpha, 'rev-parse', 'HEAD')).toBe(before.head);
    expect(await snapshot(w, w.paths.a.alpha)).toEqual(before);
    expect(await remoteHeads(w, w.remotes.alpha)).toEqual(['refs/heads/main']);
    // The old session shows where it went; from the mac the pc's session is a remote one with the link back.
    const old = (await w.a.call('GET', `/api/sessions/${started.id}`)).body as Session;
    expect(old).toMatchObject({ movedTo: { machineId: w.bId, sessionId: created.id } });
    const seenFromB = (await w.b.call('GET', `/api/sessions/${encodeURIComponent(remoteId(w.aId, started.id))}`)).body as Session;
    expect(seenFromB.movedTo).toMatchObject({ machineId: w.bId, sessionId: created.id });
  }, 120_000);

  it('a session that is moving cannot be taken over twice, and a closed or already moved one is refused by the checks', async () => {
    const w = (world = await takeoverWorld(tmp));
    const started = await startRepoSession(w.a, w.folders.a.alpha as string, 'once-only');
    const first = await run(w.a, { sessionId: started.id, targetMachine: w.bId });
    expect(first.state).toBe('done');
    const again = await run(w.a, { sessionId: started.id, targetMachine: w.bId });
    expect(again.state).toBe('failed');
    expect(again.error?.step).toBe('checks');
    expect(again.error?.message).toMatch(/closed|already taken over/);
    // Bad requests.
    expect((await w.a.call('POST', '/api/takeover', { sessionId: started.id })).status).toBe(422);
    expect((await w.a.call('POST', '/api/takeover', { sessionId: started.id, targetMachine: w.aId })).status).toBe(422);
    expect((await w.a.call('POST', '/api/takeover', { sessionId: started.id, targetMachine: 'zzzzzzzzzzzz' })).status).toBe(404);
    expect((await w.b.call('POST', '/api/takeover', { sessionId: remoteId(w.aId, started.id), targetMachine: w.aId })).status).toBe(422);
  }, 120_000);
});

describe('D65: a session in a worktree', () => {
  it('recreates the worktree on the same branch next to the target repo and restores its work in it', async () => {
    const w = (world = await takeoverWorld(tmp));
    const started = await startRepoSession(w.a, w.folders.a.alpha as string, 'wt-session', { worktrees: true, branch: 'TASK-0042-wt-session' });
    const worktreeA = started.cwd as string;
    expect(worktreeA).toContain('-wt-wt-session');
    const branch = await w.git(worktreeA, 'rev-parse', '--abbrev-ref', 'HEAD');
    expect(branch).toBe('TASK-0042-wt-session');
    await writeFile(path.join(worktreeA, 'committed.txt'), 'unpushed\n');
    await w.git(worktreeA, 'add', '-A');
    await w.git(worktreeA, 'commit', '-q', '-m', 'unpushed in the worktree');
    await writeFile(path.join(worktreeA, 'tracked.txt'), 'one\ntwo edited\nthree\n');
    await writeFile(path.join(worktreeA, 'new-file.txt'), 'new\n');
    const before = await snapshot(w, worktreeA);

    const finished = await run(w.b, { sessionId: remoteId(w.aId, started.id) });
    expect(finished.error, JSON.stringify(finished)).toBeNull();
    const created = (await sessionsOf(w.b)).find((session) => session.movedFrom?.sessionId === started.id) as Session;
    const worktreeB = path.join(path.dirname(w.paths.b.alpha), 'alpha-wt-wt-session');
    expect(created).toMatchObject({ cwd: await import('node:fs/promises').then((fs) => fs.realpath(worktreeB)), worktrees: true });
    expect(await w.git(worktreeB, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
    expect(await w.git(worktreeB, 'log', '-1', '--format=%s')).toBe('unpushed in the worktree');
    expect((await w.git(worktreeB, 'status', '--porcelain')).split('\n').map((line) => line.trim()).sort()).toEqual(['?? new-file.txt', 'M tracked.txt']);
    // The main checkout of the mac was never touched, and the pc's worktree is as it was.
    expect(await w.git(w.paths.b.alpha, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(await w.git(w.paths.b.alpha, 'status', '--porcelain')).toBe('');
    expect(await snapshot(w, worktreeA)).toEqual(before);
    expect(await remoteHeads(w, w.remotes.alpha)).toEqual(['refs/heads/main']);
    // The worktree is the new session's: its Diff shows the restored work.
    const diff = (await w.b.call('GET', `/api/sessions/${created.id}/diff`)).body as FileDiff[];
    expect(diff.map((file) => file.path).sort()).toEqual(expect.arrayContaining(['new-file.txt', 'tracked.txt']));
  }, 120_000);
});

describe('D65: a workspace session with two repos', () => {
  it('restores each repo (its branch, its unpushed commits, its uncommitted files) and places the session in the target workspace', async () => {
    const w = (world = await takeoverWorld(tmp, { aRepos: { workspace: true }, bRepos: { workspace: true } }));
    const started = await startWorkspaceSession(w.a, w.folders.a.workspace as string, 'two-repos', ['front', 'back']);
    const { front, back } = w.paths.a;
    await writeFile(path.join(front, 'tracked.txt'), 'front edit\n');
    await w.git(back, 'checkout', '-q', '-b', 'feature/back');
    await writeFile(path.join(back, 'api.txt'), 'api\n');
    await w.git(back, 'add', '-A');
    await w.git(back, 'commit', '-q', '-m', 'back: unpushed');
    await writeFile(path.join(back, 'scratch.txt'), 'untracked\n');
    const before = { front: await snapshot(w, front), back: await snapshot(w, back) };

    const preview = (await w.b.call('POST', '/api/takeover/preview', { sessionId: remoteId(w.aId, started.id) })).body as TakeoverPreview;
    expect(preview.ok, JSON.stringify(preview.blockers)).toBe(true);
    expect(preview.target.repos.map((repo) => [repo.name, repo.action, repo.uncommitted])).toEqual([
      ['front', 'use', 1],
      ['back', 'use', 1],
    ]);

    const finished = await run(w.b, { sessionId: remoteId(w.aId, started.id) });
    expect(finished.error, JSON.stringify(finished)).toBeNull();
    const created = (await sessionsOf(w.b)).find((session) => session.movedFrom?.sessionId === started.id) as Session;
    expect(created).toMatchObject({ cwd: w.paths.b.workspace, folder: w.folders.b.workspace, solutions: ['front', 'back'] });
    expect(await readFile(path.join(w.paths.b.front, 'tracked.txt'), 'utf8')).toBe('front edit\n');
    expect(await w.git(w.paths.b.back, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/back');
    expect(await w.git(w.paths.b.back, 'log', '-1', '--format=%s')).toBe('back: unpushed');
    expect(await w.git(w.paths.b.back, 'status', '--porcelain')).toBe('?? scratch.txt');
    expect({ front: await snapshot(w, front), back: await snapshot(w, back) }).toEqual(before);
    expect(await remoteHeads(w, w.remotes.front)).toEqual(['refs/heads/main']);
    expect(await remoteHeads(w, w.remotes.back)).toEqual(['refs/heads/main']);
    // The first message lists both repos' path changes.
    const stdin = (await fakeLog(w.logs.b)).filter((entry) => entry['kind'] === 'stdin').map((entry) => String(entry['line'])).join('\n');
    expect(stdin).toContain(`${front} → ${w.paths.b.front} (front)`);
    expect(stdin).toContain(`${back} → ${w.paths.b.back} (back)`);
  }, 120_000);

  it('stops before anything changes when one repo cannot be resolved and no clone folder is possible', async () => {
    const w = (world = await takeoverWorld(tmp, { aRepos: { workspace: true }, bRepos: { alpha: true } }));
    const started = await startWorkspaceSession(w.a, w.folders.a.workspace as string, 'no-workspace', ['front', 'back']);
    await writeFile(path.join(w.paths.a.front, 'tracked.txt'), 'edit\n');
    const before = await snapshot(w, w.paths.a.front);
    const preview = (await w.b.call('POST', '/api/takeover/preview', { sessionId: remoteId(w.aId, started.id) })).body as TakeoverPreview;
    expect(preview.ok).toBe(false);
    expect(preview.blockers.join(' ')).toContain('no saved workspace folder on this machine');
    const finished = await run(w.b, { sessionId: remoteId(w.aId, started.id) });
    expect(finished).toMatchObject({ state: 'failed', error: { step: 'checks' }, rolledBack: null });
    expect(await snapshot(w, w.paths.a.front)).toEqual(before);
    expect((await w.a.call('GET', `/api/sessions/${started.id}`)).body).toMatchObject({ closedAt: null, live: true });
  }, 120_000);
});

describe('D65: a repo the target does not have is cloned', () => {
  it('offers the clone next to the default folder, takes a typed path, saves the clone as a folder and continues', async () => {
    const w = (world = await takeoverWorld(tmp, { aRepos: { alpha: true, gamma: true }, bRepos: { alpha: true } }));
    const started = await startRepoSession(w.a, w.folders.a.gamma as string, 'gamma-work');
    await writeFile(path.join(w.paths.a.gamma, 'tracked.txt'), 'gamma edit\n');
    await writeFile(path.join(w.paths.a.gamma, 'notes.txt'), 'notes\n');
    const preview = (await w.b.call('POST', '/api/takeover/preview', { sessionId: remoteId(w.aId, started.id) })).body as TakeoverPreview;
    const defaultClone = path.join(path.dirname(w.paths.b.alpha), 'gamma');
    expect(preview.ok, JSON.stringify(preview.blockers)).toBe(true);
    expect(preview.target.repos[0]).toMatchObject({ action: 'clone', cloneTo: defaultClone, cloneUrl: w.remotes.gamma, uncommitted: 2 });
    expect(preview.target.defaultCloneParent).toBe(path.dirname(w.paths.b.alpha));
    // A typed path wins; one that exists blocks.
    const typed = path.join(tmp, 'elsewhere', 'gamma-clone');
    const retyped = (await w.b.call('POST', '/api/takeover/preview', { sessionId: remoteId(w.aId, started.id), clonePaths: { gamma: typed } })).body as TakeoverPreview;
    expect(retyped.target.repos[0]).toMatchObject({ action: 'clone', cloneTo: typed });
    const exists = (await w.b.call('POST', '/api/takeover/preview', { sessionId: remoteId(w.aId, started.id), clonePaths: { gamma: w.paths.b.alpha } })).body as TakeoverPreview;
    expect(exists.ok).toBe(false);
    expect(exists.target.repos[0]?.action).toBe('blocked');

    const finished = await run(w.b, { sessionId: remoteId(w.aId, started.id), clonePaths: { gamma: typed } });
    expect(finished.error, JSON.stringify(finished)).toBeNull();
    expect(finished.log.join('\n')).toContain('clone --quiet');
    expect((await stat(path.join(typed, '.git'))).isDirectory()).toBe(true);
    expect(await readFile(path.join(typed, 'tracked.txt'), 'utf8')).toBe('gamma edit\n');
    expect(await w.git(typed, 'status', '--porcelain')).toContain('?? notes.txt');
    const folders = (await w.b.call('GET', '/api/folders')).body as Array<{ path: string; kind: string }>;
    expect(folders.some((folder) => folder.path.endsWith('gamma-clone') && folder.kind === 'repo')).toBe(true);
    const created = (await sessionsOf(w.b)).find((session) => session.movedFrom?.sessionId === started.id) as Session;
    expect(created.folderPath?.endsWith('gamma-clone')).toBe(true);
    expect(await remoteHeads(w, w.remotes.gamma)).toEqual(['refs/heads/main']);
  }, 120_000);
});

describe('D65: checks that stop before anything changes, and a failure half-way', () => {
  it('a dirty checkout on the target is refused by the checks: the source session keeps running and nothing was pushed', async () => {
    const w = (world = await takeoverWorld(tmp));
    const started = await startRepoSession(w.a, w.folders.a.alpha as string, 'dirty-target');
    await writeFile(path.join(w.paths.b.alpha, 'mine.txt'), 'the mac has its own work\n');
    const finished = await run(w.b, { sessionId: remoteId(w.aId, started.id) });
    expect(finished).toMatchObject({ state: 'failed', error: { step: 'checks' }, rolledBack: null });
    expect(finished.error?.message).toContain('uncommitted changes on the target');
    expect(await remoteHeads(w, w.remotes.alpha)).toEqual(['refs/heads/main']);
    expect((await w.a.call('GET', `/api/sessions/${started.id}`)).body).toMatchObject({ closedAt: null, live: true });
    expect(await w.git(w.paths.b.alpha, 'status', '--porcelain')).toBe('?? mine.txt');
  }, 120_000);

  it('a failure after the push (a diverged branch on the target) undoes everything: the source ends exactly as it was and runs again', async () => {
    const w = (world = await takeoverWorld(tmp));
    const started = await startRepoSession(w.a, w.folders.a.alpha as string, 'will-fail');
    await w.git(w.paths.a.alpha, 'checkout', '-q', '-b', 'feature/clash');
    await writeFile(path.join(w.paths.a.alpha, 'a-side.txt'), 'from the pc\n');
    await w.git(w.paths.a.alpha, 'add', '-A');
    await w.git(w.paths.a.alpha, 'commit', '-q', '-m', 'pc commit');
    await writeFile(path.join(w.paths.a.alpha, 'tracked.txt'), 'uncommitted on the pc\n');
    // The mac has a branch of the same name with a commit the pc does not have: the take-over cannot fast-forward it.
    await w.git(w.paths.b.alpha, 'checkout', '-q', '-b', 'feature/clash');
    await writeFile(path.join(w.paths.b.alpha, 'b-side.txt'), 'from the mac\n');
    await w.git(w.paths.b.alpha, 'add', '-A');
    await w.git(w.paths.b.alpha, 'commit', '-q', '-m', 'mac commit');
    await w.git(w.paths.b.alpha, 'checkout', '-q', 'main');
    const beforeA = await snapshot(w, w.paths.a.alpha);
    const beforeB = await snapshot(w, w.paths.b.alpha);
    const spawnsBefore = (await fakeLog(w.logs.a)).filter((entry) => entry['kind'] === 'argv').length;

    const finished = await run(w.b, { sessionId: remoteId(w.aId, started.id) });
    expect(finished.state).toBe('failed');
    expect(finished.error).toMatchObject({ step: 'apply' });
    expect(finished.error?.message).toContain('has commits the original does not have');
    expect(finished.rolledBack).toBe(true);
    expect(finished.rollbackNotes).toEqual(expect.arrayContaining(['the session runs here again']));
    // The pc: branch, HEAD, index, tree and refs exactly as before (no temp ref), the remote has no temp branch.
    expect(await snapshot(w, w.paths.a.alpha)).toEqual(beforeA);
    expect(await remoteHeads(w, w.remotes.alpha)).toEqual(['refs/heads/main']);
    // The mac: untouched.
    expect(await snapshot(w, w.paths.b.alpha)).toEqual(beforeB);
    expect((await sessionsOf(w.b)).filter((session) => session.movedFrom)).toEqual([]);
    expect(await readdir(path.join(w.b.dataDir, 'takeover')).catch(() => [])).toEqual([]);
    // The pc's session runs again: started again with --resume, not closed, not marked moved.
    const old = (await w.a.call('GET', `/api/sessions/${started.id}`)).body as Session;
    expect(old).toMatchObject({ closedAt: null, movedTo: null, live: true });
    const spawns = (await fakeLog(w.logs.a)).filter((entry) => entry['kind'] === 'argv');
    expect(spawns.length).toBe(spawnsBefore + 1);
    expect(spawns.at(-1)?.['argv']).toContain('--resume');
    // And it can be taken over once the clash is gone.
    await w.git(w.paths.b.alpha, 'branch', '-q', '-D', 'feature/clash');
    const retry = await run(w.b, { sessionId: remoteId(w.aId, started.id) });
    expect(retry.error, JSON.stringify(retry)).toBeNull();
    expect(await w.git(w.paths.b.alpha, 'log', '-1', '--format=%s')).toBe('pc commit');
  }, 180_000);
});

describe('D65: a temporary branch that cannot be deleted', () => {
  it('keeps going, reports the leftover, and the one-click delete removes it', async () => {
    const w = (world = await takeoverWorld(tmp));
    // The shared remote refuses deletions: the temp branch cannot be removed by either machine.
    await w.git(w.remotes.alpha, 'config', 'receive.denyDeletes', 'true');
    const started = await startRepoSession(w.a, w.folders.a.alpha as string, 'leftover');
    await writeFile(path.join(w.paths.a.alpha, 'tracked.txt'), 'edit\n');
    const finished = await run(w.b, { sessionId: remoteId(w.aId, started.id) });
    expect(finished.error).toBeNull();
    expect(finished.state).toBe('done');
    expect(finished.steps.find((step) => step.id === 'finish')).toMatchObject({ status: 'failed' });
    expect(finished.leftovers).toHaveLength(1);
    const [leftover] = finished.leftovers;
    expect(leftover).toMatchObject({ machineId: w.aId, branch: expect.stringMatching(/^switchboard\/takeover\/[0-9a-f]{8}\/main$/) });
    expect((await remoteHeads(w, w.remotes.alpha)).some((ref) => ref.includes('switchboard/takeover'))).toBe(true);
    // The pc lists it; the mac reaches it through the proxy.
    expect(((await w.a.call('GET', '/api/takeover/leftovers')).body as Array<{ id: string }>).map((entry) => entry.id)).toEqual([leftover?.id]);
    const stillRefused = await w.b.call('POST', `/api/machines/${w.aId}/api/takeover/leftovers/${leftover?.id}/delete`);
    expect(stillRefused.status).toBe(502);
    // The remote allows deletions again: one click.
    await w.git(w.remotes.alpha, 'config', 'receive.denyDeletes', 'false');
    const deleted = await w.b.call('POST', `/api/machines/${w.aId}/api/takeover/leftovers/${leftover?.id}/delete`);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(await remoteHeads(w, w.remotes.alpha)).toEqual(['refs/heads/main']);
    expect((await w.a.call('GET', '/api/takeover/leftovers')).body).toEqual([]);
    expect((await w.a.call('POST', '/api/takeover/leftovers/nope/delete')).status).toBe(404);
  }, 120_000);
});

describe('D65: the chat and the peer API', () => {
  it('the new session shows the divider and a peer cannot start a take-over through us', async () => {
    const w = (world = await takeoverWorld(tmp));
    const started = await startRepoSession(w.a, w.folders.a.alpha as string, 'divider');
    const finished = await run(w.b, { sessionId: remoteId(w.aId, started.id) });
    expect(finished.state).toBe('done');
    const created = (await sessionsOf(w.b)).find((session) => session.movedFrom?.sessionId === started.id) as Session;
    const events = (await w.b.call('GET', `/api/sessions/${created.id}/events`)).body as SessionEvent[];
    const divider = events.find((event) => (event.payload as { action?: string } | null)?.action === 'taken-over');
    expect(divider?.label).toMatch(/^Taken over from /);
    // The orchestration routes are not part of the peer API (only each end's operations are).
    const viaPeer = await w.b.call('POST', `/api/machines/${w.aId}/api/takeover`, { sessionId: started.id, targetMachine: w.bId });
    expect(viaPeer.status).toBe(403);
    const preview = await w.b.call('POST', `/api/machines/${w.aId}/api/takeover/preview`, { sessionId: started.id, targetMachine: w.bId });
    expect(preview.status).toBe(403);
    // An end operation of a take-over nobody started is refused.
    expect((await w.b.call('POST', `/api/machines/${w.aId}/api/takeover/source/capture`, { opId: 'nobody' })).status).toBe(404);
  }, 120_000);
});
