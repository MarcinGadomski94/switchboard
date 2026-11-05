import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import type { SourceInspect, TakeoverPreview, TakeoverRun } from '../../../src/core/takeover.ts';
import type { SessionWorksIn } from '../../../src/core/workspace-move.ts';
import { makeTempDir } from '../../helpers/net.ts';
import { waitFor } from '../../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, settle, startWorkspaceSession, takeoverWorld } from '../../helpers/takeover.ts';

/**
 * D153 (`docs/peers.md` → *A complete move (D152)* → *A target checkout with
 * uncommitted changes* and *The agent's own worktrees*), two real Switchboards (the
 * pc "a" and the mac "b"), fake CLIs, temp repos and local bare remotes:
 * - a target checkout with uncommitted and untracked files blocks once (also when
 *   two repos of the session land in it) with its files listed; with the stash
 *   confirmed the target stashes them with the ruled message, the move succeeds and
 *   the stash stays; a move that fails after stashing is undone and keeps the stash;
 * - three worktrees of one repo: pushed and unmerged (carried, at its place), no
 *   remote branch (skipped, a warning for its uncommitted file), merged (skipped),
 *   in the inspect, the plan, the run and Works in.
 */

let tmp: string;
let world: TakeoverWorld;
let onMac: string;

beforeAll(async () => {
  tmp = await makeTempDir('takeover-stash-worktrees');
  world = await takeoverWorld(tmp, { aRepos: { workspace: true }, bRepos: { workspace: true } });
  onMac = world.paths.b.front;
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

/** Has the agent read `file` (a fake Read call), so Works in counts its repo. */
async function readIn(session: Session, file: string): Promise<void> {
  const sent = await world.a.call('POST', `/api/sessions/${session.id}/messages`, { text: `Look. [fake:tool Read ${JSON.stringify({ file_path: file })}]` });
  expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
  await settle(world.a, session.id);
}

async function stashList(dir: string): Promise<string> {
  return world.git(dir, 'stash', 'list');
}

/** Makes the mac's checkout of front dirty: a tracked change and an untracked file. */
async function dirtyMac(): Promise<void> {
  await writeFile(path.join(onMac, 'tracked.txt'), 'one\ntwo\nchanged on the mac\n');
  await writeFile(path.join(onMac, 'scratch.txt'), 'the mac has its own work\n');
}

describe('D153: a target checkout with uncommitted changes', () => {
  it('blocks once per checkout with its files, also when two repos of the session land in it', async () => {
    await dirtyMac();
    // A second checkout of front on the pc, inside the workspace: the session reads in both.
    const copy = path.join(world.paths.a.workspace, 'front-copy');
    await world.git(world.paths.a.workspace, 'clone', '-q', world.remotes.front, copy);
    const session = await startWorkspaceSession(world.a, world.folders.a.workspace as string, 'ws-two-fronts', ['front']);
    await readIn(session, path.join(await realpath(copy), 'README.md'));
    await waitFor('front-copy to count', async () => {
      const now = (await world.a.call('GET', `/api/sessions/${session.id}/works-in`)).body as SessionWorksIn;
      return now.repos.some((repo) => repo.name === 'front-copy') ? now : null;
    }, 30_000);
    const answer = await preview({ sessionId: session.id, targetMachine: world.bId });
    expect(answer.ok).toBe(false);
    const dirty = answer.blockers.filter((line) => line.includes('has uncommitted changes on the target'));
    expect(dirty).toHaveLength(1);
    expect(dirty[0]).toContain(onMac);
    expect(dirty[0]).toContain('Stash them on mac-laptop');
    // The mac's workspace is still the session's folder there while the checkout waits for the stash (the dialog shows it, not "Create a new folder").
    expect(answer.target.folder).toMatchObject({ kind: 'workspace', path: world.paths.b.workspace });
    const blocked = answer.target.repos.filter((repo) => repo.targetChanges);
    expect(blocked.length).toBe(2);
    expect(blocked[0]?.targetChanges).toMatchObject({ modified: 1, untracked: 1, total: 2, truncated: false });
    expect([...(blocked[0]?.targetChanges?.files ?? [])].sort()).toEqual(['scratch.txt', 'tracked.txt']);
    // Nothing was stashed by a preview.
    expect(await stashList(onMac)).toBe('');
  });

  it('a move that fails after stashing is undone and keeps the stash', async () => {
    // back on the mac has a commit of its own on main: the restore refuses it (diverged), after front was stashed.
    // D157: the plan would offer overwriting it up front; it cannot tell here (the pc's tip is not on the mac and the mac
    // has no remote-tracking main), so the apply's own check is what refuses it.
    await writeFile(path.join(world.paths.b.back, 'mac-only.txt'), 'only on the mac\n');
    await world.git(world.paths.b.back, 'add', 'mac-only.txt');
    await world.git(world.paths.b.back, 'commit', '-q', '-m', 'mac only');
    await world.git(world.paths.b.back, 'update-ref', '-d', 'refs/remotes/origin/main');
    await writeFile(path.join(world.paths.a.back, 'pc-only.txt'), 'only on the pc\n');
    await world.git(world.paths.a.back, 'add', 'pc-only.txt');
    await world.git(world.paths.a.back, 'commit', '-q', '-m', 'pc only');
    const session = await startWorkspaceSession(world.a, world.folders.a.workspace as string, 'ws-fails', ['front', 'back']);
    const base = { sessionId: session.id, targetMachine: world.bId };
    const blocked = await preview(base);
    expect(blocked.blockers.join('\n')).toContain('has uncommitted changes on the target');
    const confirmed = await preview({ ...base, stashTargets: [onMac] });
    expect(confirmed.blockers, JSON.stringify(confirmed.blockers)).toEqual([]);
    expect(confirmed.target.repos.find((repo) => repo.name === 'front')).toMatchObject({ action: 'use', stash: true, matchedPath: onMac });
    const run = await runOn({ ...base, stashTargets: [onMac] });
    expect(run.state).toBe('failed');
    expect(run.error?.step).toBe('apply');
    expect(run.error?.message).toContain('has commits the original does not have');
    expect(run.rolledBack, JSON.stringify(run.rollbackNotes)).toBe(true);
    // The stash stays (the undo never drops or pops it), and the run says where and how to restore it.
    expect(run.stashes).toHaveLength(1);
    expect(run.stashes?.[0]).toMatchObject({ path: onMac, machine: 'mac-laptop', files: 2 });
    expect(run.stashes?.[0]?.message).toMatch(/^switchboard: before moving ws-fails from pc-office \(\d{4}-\d\d-\d\d \d\d:\d\d\)$/);
    expect(await stashList(onMac)).toContain(run.stashes?.[0]?.message as string);
    expect(await world.git(onMac, 'status', '--porcelain')).toBe('');
    expect(run.log.join('\n')).toContain('git -C');
    // The test puts the mac back as it was: its own work, back's commit gone.
    await world.git(onMac, 'stash', 'pop', '-q');
    expect((await world.git(onMac, 'status', '--porcelain')).split('\n').map((line) => line.trim()).sort()).toEqual(['?? scratch.txt', 'M tracked.txt']);
    await world.git(world.paths.b.back, 'reset', '-q', '--hard', 'origin/main');
    await world.git(world.paths.a.back, 'reset', '-q', '--hard', 'origin/main');
    await waitFor('the session to be live again', async () => ((await world.a.call('GET', `/api/sessions/${session.id}`)).body as Session).status !== 'run', 20_000);
  });

  it('with the stash confirmed, stashes with the ruled message, restores and moves; the stash stays', async () => {
    const session = await startWorkspaceSession(world.a, world.folders.a.workspace as string, 'ws-stash', ['front']);
    const base = { sessionId: session.id, targetMachine: world.bId };
    const bad = await world.a.call('POST', '/api/takeover/preview', { ...base, stashTargets: 'yes' });
    expect(bad.status).toBe(422);
    const run = await runOn({ ...base, stashTargets: [onMac] });
    expect(run.error, JSON.stringify(run)).toBeNull();
    expect(run.state).toBe('done');
    expect(run.stashes).toHaveLength(1);
    const stash = run.stashes?.[0];
    expect(stash?.message).toMatch(/^switchboard: before moving ws-stash from pc-office \(/);
    expect(stash?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(run.log.join('\n')).toContain(`stashed 2 uncommitted files in ${onMac} on mac-laptop before the move`);
    const list = await stashList(onMac);
    expect(list).toContain(stash?.message as string);
    expect(list.split('\n')).toHaveLength(1);
    // The stash holds the mac's own work, untracked file included; the checkout has the restored branch.
    expect(await world.git(onMac, 'show', '--format=', '--name-only', 'stash@{0}^3')).toContain('scratch.txt');
    expect(await world.git(onMac, 'status', '--porcelain')).toBe('');
    expect(await readFile(path.join(onMac, 'tracked.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
    // Clean up the test repo.
    await world.git(onMac, 'stash', 'drop', '-q');
  });
});

describe('D153: the agent own worktrees, grouped under their repo', () => {
  it('carries the pushed, unmerged one at its place and skips the unpushed and the merged ones with their reasons', async () => {
    const front = await realpath(world.paths.a.front);
    // Claude Code's worktrees live in the checkout; the repo ignores them (as `.claude/` would be).
    await writeFile(path.join(front, '.git', 'info', 'exclude'), '.claude/\n');
    await mkdir(path.join(front, '.claude', 'worktrees'), { recursive: true });
    const wt = (name: string): string => path.join(front, '.claude', 'worktrees', name);
    await world.git(front, 'worktree', 'add', '-q', '-b', 'feat/live', wt('live'));
    await writeFile(path.join(wt('live'), 'live.txt'), 'pushed work\n');
    await world.git(wt('live'), 'add', 'live.txt');
    await world.git(wt('live'), 'commit', '-q', '-m', 'live work');
    await world.git(wt('live'), 'push', '-q', '-u', 'origin', 'feat/live');
    await world.git(front, 'worktree', 'add', '-q', '-b', 'feat/local', wt('local'));
    await writeFile(path.join(wt('local'), 'draft.txt'), 'never pushed\n');
    await world.git(front, 'worktree', 'add', '-q', '-b', 'feat/done', wt('done'));
    await world.git(wt('done'), 'push', '-q', '-u', 'origin', 'feat/done');

    const session = await startWorkspaceSession(world.a, world.folders.a.workspace as string, 'ws-worktrees', []);
    for (const file of [path.join(front, 'README.md'), path.join(wt('live'), 'live.txt'), path.join(wt('local'), 'draft.txt'), path.join(wt('done'), 'README.md')]) await readIn(session, file);
    // Works in: one repo, its three worktrees nested under it (named after the repo, grouped by its main checkout).
    const worksIn = await waitFor('the worktrees to count', async () => {
      const now = (await world.a.call('GET', `/api/sessions/${session.id}/works-in`)).body as SessionWorksIn;
      return now.repos.length >= 4 ? now : null;
    }, 30_000);
    expect(worksIn.repos.map((repo) => [repo.name, repo.kind, repo.mainPath]).sort()).toEqual([
      ['front', 'main', front],
      ['front', 'worktree', front],
      ['front', 'worktree', front],
      ['front', 'worktree', front],
    ]);

    // The inspect: the main checkout and the live worktree travel; the others are skipped with the reason.
    const inspected = (await world.a.call('POST', '/api/takeover/source/inspect', { sessionId: session.id })).body as { result: SourceInspect };
    const repos = inspected.result.repos;
    expect(repos.map((repo) => [repo.name, repo.kind, repo.path, repo.worktreeAt ?? null]).sort()).toEqual(
      [
        ['front', 'main', front, null],
        ['front', 'worktree', wt('live'), '.claude/worktrees/live'],
      ].sort(),
    );
    const skipped = Object.fromEntries((inspected.result.skippedWorktrees ?? []).map((entry) => [path.basename(entry.path), entry]));
    expect(Object.keys(skipped).sort()).toEqual(['done', 'local']);
    expect(skipped['local']).toMatchObject({ name: 'front', mainPath: front, branch: 'feat/local', reason: 'no-remote-branch', text: 'no remote branch', uncommitted: 1, warning: 'Its 1 uncommitted file stays on pc-office.' });
    expect(skipped['done']).toMatchObject({ reason: 'merged', text: 'merged into origin/main', uncommitted: 0, warning: null });
    expect(inspected.result.blockers).toEqual([]);

    // The plan: the mac's front used, the live worktree at the same place next to it.
    const plan = await preview({ sessionId: session.id, targetMachine: world.bId });
    expect(plan.blockers, JSON.stringify(plan.blockers)).toEqual([]);
    const liveOnMac = path.join(onMac, '.claude', 'worktrees', 'live');
    expect(plan.target.repos.map((repo) => [repo.action, repo.matchedPath, repo.worktreePath])).toEqual(
      expect.arrayContaining([
        ['use', onMac, null],
        ['use', onMac, liveOnMac],
      ]),
    );
    expect(plan.target.repos).toHaveLength(2);
    expect(plan.source.skippedWorktrees).toHaveLength(2);

    // The run: the live worktree is restored there on its branch; the skipped ones are not.
    const run = await runOn({ sessionId: session.id, targetMachine: world.bId });
    expect(run.error, JSON.stringify(run)).toBeNull();
    expect(run.state).toBe('done');
    expect(await world.git(liveOnMac, 'branch', '--show-current')).toBe('feat/live');
    expect(await readFile(path.join(liveOnMac, 'live.txt'), 'utf8')).toBe('pushed work\n');
    const listed = await world.git(onMac, 'worktree', 'list', '--porcelain');
    expect(listed).toContain('branch refs/heads/feat/live');
    expect(listed).not.toContain('feat/local');
    expect(listed).not.toContain('feat/done');
    // The skipped worktree's uncommitted file stayed on the pc.
    expect(await readFile(path.join(wt('local'), 'draft.txt'), 'utf8')).toBe('never pushed\n');
  });
});
