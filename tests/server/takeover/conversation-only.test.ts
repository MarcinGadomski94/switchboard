import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import type { TakeoverPreview, TakeoverRun } from '../../../src/core/takeover.ts';
import { makeTempDir } from '../../helpers/net.ts';
import { waitFor } from '../../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, sessionSpawns, startWorkspaceSession, takeoverWorld } from '../../helpers/takeover.ts';

/**
 * D158 (`docs/peers.md` → *Conversation only (D158)*), two real Switchboards (the pc
 * "a" and the mac "b"), fake CLIs, temp repos and local bare remotes. The pc's front
 * has an uncommitted file and an unpushed commit; the mac's front has a commit of its
 * own on main (diverged). A full move is blocked; with `conversationOnly` the
 * conversation resumes on the mac in its workspace, and neither repo is touched: the
 * same HEADs, branches and working trees, nothing pushed.
 */

let tmp: string;
let world: TakeoverWorld;

beforeAll(async () => {
  tmp = await makeTempDir('takeover-conversation-only');
  world = await takeoverWorld(tmp, { aRepos: { workspace: true }, bRepos: { workspace: true } });
  const onMac = world.paths.b.front;
  await writeFile(path.join(onMac, 'mac-only.txt'), 'only on the mac\n');
  await world.git(onMac, 'add', 'mac-only.txt');
  await world.git(onMac, 'commit', '-q', '-m', 'mac only work');
  const onPc = world.paths.a.front;
  await writeFile(path.join(onPc, 'pc-commit.txt'), 'committed on the pc, not pushed\n');
  await world.git(onPc, 'add', 'pc-commit.txt');
  await world.git(onPc, 'commit', '-q', '-m', 'pc only work');
  await writeFile(path.join(onPc, 'pc-wip.txt'), 'uncommitted on the pc\n');
}, 120_000);

afterAll(async () => {
  if (world) await Promise.all([world.a.server.stop(), world.b.server.stop()]);
  await removeWorld(tmp);
});

/** What a repo looks like: HEAD, the branch, the local branches, the working tree. */
async function stateOf(dir: string): Promise<Record<string, string>> {
  return {
    head: await world.git(dir, 'rev-parse', 'HEAD'),
    branch: await world.git(dir, 'branch', '--show-current'),
    branches: await world.git(dir, 'branch', '--format=%(refname:short)'),
    status: await world.git(dir, 'status', '--porcelain', '--untracked-files=all'),
  };
}

describe('D158: a move that carries only the conversation', () => {
  it('moves past the conflicts: the conversation resumes on the mac, both repos stay exactly as they were, nothing is pushed', async () => {
    const session = await startWorkspaceSession(world.a, world.folders.a.workspace as string, 'ws-conversation', ['front']);
    const base = { sessionId: session.id, targetMachine: world.bId };
    // The full move is blocked by the mac's diverged main.
    const full = (await world.a.call('POST', '/api/takeover/preview', base)).body as TakeoverPreview;
    expect(full.ok).toBe(false);
    // Conversation only: no blocker; the mac's front is used as it is.
    const answer = await world.a.call('POST', '/api/takeover/preview', { ...base, conversationOnly: true });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const preview = answer.body as TakeoverPreview;
    expect(preview.blockers, JSON.stringify(preview.blockers)).toEqual([]);
    expect(preview.conversationOnly).toBe(true);
    expect(preview.target.conversationOnly).toEqual({ leftOut: [] });
    expect(preview.target.repos.find((repo) => repo.name === 'front')).toMatchObject({ action: 'use', matchedPath: world.paths.b.front, worktreePath: null });
    expect(preview.target.folder?.kind).toBe('workspace');

    const pcBefore = await stateOf(world.paths.a.front);
    const macBefore = await stateOf(world.paths.b.front);
    const remoteBefore = await world.git(world.paths.a.front, 'ls-remote', '--heads', world.remotes.front);
    expect(pcBefore.status).toContain('pc-wip.txt');

    const started = await world.a.call('POST', '/api/takeover', { ...base, conversationOnly: true });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const id = (started.body as TakeoverRun).id;
    const run = await waitFor('the take-over to end', async () => {
      const current = (await world.a.call('GET', `/api/takeover/runs/${id}`)).body as TakeoverRun;
      return current.state === 'running' ? null : current;
    }, 90_000);
    expect(run.error, JSON.stringify(run)).toBeNull();
    expect(run.state).toBe('done');
    expect(run.steps.find((step) => step.id === 'capture')?.status).toBe('skipped');
    expect(run.leftovers).toEqual([]);

    // Neither repo was touched; nothing went to the remote.
    expect(await stateOf(world.paths.a.front)).toEqual(pcBefore);
    expect(await stateOf(world.paths.b.front)).toEqual(macBefore);
    expect(await world.git(world.paths.a.front, 'ls-remote', '--heads', world.remotes.front)).toBe(remoteBefore);

    // The conversation continues on the mac, in its workspace, from the same conversation.
    const moved = await waitFor('the moved session on the mac', async () => {
      const list = (await world.b.call('GET', '/api/sessions')).body as Session[];
      return list.find((entry) => entry.movedFrom?.sessionId === session.id && !entry.machine) ?? null;
    }, 20_000);
    expect(moved.cwd).toBe(world.paths.b.workspace);
    // The resume spawn may land just after the session is listed: wait for it.
    await waitFor('the resume spawn on the mac', async () => {
      const spawns = await sessionSpawns(world.logs.b);
      return spawns.some((entry) => (entry['argv'] as string[]).join(' ').includes(`--resume ${session.claudeSessionId}`)) ? true : null;
    }, 20_000);
    // The pc's session ends as moved; the move log's start line says conversation only.
    const old = (await world.a.call('GET', `/api/sessions/${session.id}`)).body as Session;
    expect(old.movedTo?.machineId).toBe(world.bId);
    const start = world.a.server
      .output()
      .split('\n')
      .filter((line) => line.startsWith('{') && line.includes('"msg":"move: start"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line['run'] === id);
    expect(start).toMatchObject({ conversationOnly: true });
  });
});
