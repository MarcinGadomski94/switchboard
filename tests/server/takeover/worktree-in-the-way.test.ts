import { mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import { remoteId } from '../../../src/core/peers.ts';
import type { TakeoverPreview, TakeoverRun } from '../../../src/core/takeover.ts';
import type { TeamMember } from '../../../src/core/team.ts';
import { makeTempDir } from '../../helpers/net.ts';
import { type PeerNode, waitFor } from '../../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, startRepoSession, takeoverWorld } from '../../helpers/takeover.ts';

/**
 * A worktree folder in the way on the target (`docs/peers.md` → *A worktree folder
 * in the way*; developer report 2026-11-04: a move failed at the restore with
 * "git worktree add … already exists" because an earlier failed attempt had left
 * the folder), with two real Switchboards, temp repos and a local bare remote: a
 * non-empty leftover folder blocks the preview, the Team move check, the move (409)
 * and the run before anything is paused, and is never deleted; an empty folder and a
 * stale (prunable) worktree entry do not block and the move succeeds; a live
 * worktree at the path blocks.
 */

let tmp: string;
let world: TakeoverWorld | null = null;

beforeEach(async () => {
  tmp = await makeTempDir('takeover-wt-way');
});
afterEach(async () => {
  if (world) await Promise.all([world.a.server.stop(), world.b.server.stop()]);
  world = null;
  await removeWorld(tmp);
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

const leftoverText = (at: string): string =>
  `mac-laptop already has a folder at ${at} (not a git worktree; likely left over from an earlier move). Remove it there, or pick another target folder, then check again.`;

/** A worktree session on a (pc-office); b (mac-laptop) would make its worktree at `planned`. */
async function worktreeSession(w: TakeoverWorld, name: string, branch: string): Promise<{ session: Session; planned: string }> {
  const session = await startRepoSession(w.a, w.folders.a.alpha as string, name, { worktrees: true, branch });
  return { session, planned: path.join(path.dirname(w.paths.b.alpha), `alpha-wt-${name}`) };
}

async function expectUntouched(w: TakeoverWorld, session: Session, before: Session): Promise<void> {
  const after = (await w.a.call('GET', `/api/sessions/${session.id}`)).body as Session;
  expect([after.status, after.live, after.closedAt, after.movedTo]).toEqual([before.status, before.live, null, null]);
  expect(await w.git(w.root, 'ls-remote', '--heads', w.remotes.alpha)).not.toContain('switchboard/takeover');
}

describe('a worktree folder in the way on the target', () => {
  it('a non-empty leftover folder blocks the preview, the Team move check, the move and the run before anything is paused; it is never deleted', async () => {
    const w = (world = await takeoverWorld(tmp));
    const { session, planned } = await worktreeSession(w, 'leftover', 'TASK-0042-leftover');
    const adopted = await w.a.call('POST', '/api/team/members', { sessionId: session.id, name: 'Developer' });
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(201);
    const memberId = (adopted.body as TeamMember).id;
    await mkdir(planned, { recursive: true });
    await writeFile(path.join(planned, 'half-restored.txt'), 'from an earlier attempt\n');
    const before = (await w.a.call('GET', `/api/sessions/${session.id}`)).body as Session;
    const text = leftoverText(planned);

    const toB = (await w.b.call('POST', '/api/takeover/preview', { sessionId: remoteId(w.aId, session.id) })).body as TakeoverPreview;
    expect(toB.ok).toBe(false);
    expect(toB.blockers).toEqual([text]);
    expect(toB.target.repos[0]).toMatchObject({ name: 'alpha', action: 'blocked', reason: text });
    const fromA = (await w.a.call('POST', '/api/takeover/preview', { sessionId: session.id, targetMachine: w.bId })).body as TakeoverPreview;
    expect(fromA.blockers).toEqual([text]);
    const check = await w.a.call('POST', `/api/team/members/${memberId}/move/check`, { targetMachineId: w.bId });
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    expect(check.body).toMatchObject({ ok: false });
    expect(check.body.blockers).toContain(text);
    const refused = await w.a.call('POST', `/api/team/members/${memberId}/move`, { targetMachineId: w.bId });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain(JSON.stringify(text).slice(1, -1));

    const failed = await run(w.a, { sessionId: session.id, targetMachine: w.bId });
    expect(failed).toMatchObject({ state: 'failed', error: { step: 'checks' } });
    expect(failed.error?.message).toContain(text);
    expect(failed.steps.find((step) => step.id === 'stop')?.status).toBe('pending');
    await expectUntouched(w, session, before);
    expect(await readdir(planned)).toEqual(['half-restored.txt']);
    expect(await w.git(w.paths.b.alpha, 'worktree', 'list', '--porcelain')).not.toContain('alpha-wt-leftover');

    // Removed there: check again passes.
    await rm(planned, { recursive: true, force: true });
    const again = (await w.b.call('POST', '/api/takeover/preview', { sessionId: remoteId(w.aId, session.id) })).body as TakeoverPreview;
    expect(again.blockers).toEqual([]);
  }, 120_000);

  it('a non-empty leftover where a repo to be cloned gets its worktree blocks too (before the fix the restore failed at `git worktree add`)', async () => {
    const w = (world = await takeoverWorld(tmp, { bRepos: { gamma: true } }));
    const session = await startRepoSession(w.a, w.folders.a.alpha as string, 'clone-left', { worktrees: true, branch: 'TASK-0043-clone-left' });
    const planned = path.join(path.dirname(w.paths.b.gamma), 'alpha-wt-clone-left');
    await mkdir(planned, { recursive: true });
    await writeFile(path.join(planned, 'half-restored.txt'), 'from an earlier attempt\n');
    const before = (await w.a.call('GET', `/api/sessions/${session.id}`)).body as Session;
    const preview = (await w.b.call('POST', '/api/takeover/preview', { sessionId: remoteId(w.aId, session.id) })).body as TakeoverPreview;
    expect(preview.blockers).toEqual([leftoverText(planned)]);
    const failed = await run(w.b, { sessionId: remoteId(w.aId, session.id) });
    expect(failed).toMatchObject({ state: 'failed', error: { step: 'checks' } });
    await expectUntouched(w, session, before);
    expect(await stat(path.join(path.dirname(w.paths.b.gamma), 'alpha')).catch(() => null)).toBeNull();
    expect(await readdir(planned)).toEqual(['half-restored.txt']);
  }, 120_000);

  it('a live worktree of the repo at the path blocks with the path and a hint', async () => {
    const w = (world = await takeoverWorld(tmp));
    const { session, planned } = await worktreeSession(w, 'live-one', 'TASK-0044-live-one');
    await w.git(w.paths.b.alpha, 'worktree', 'add', '-q', '-b', 'someone-else', planned, 'main');
    const preview = (await w.b.call('POST', '/api/takeover/preview', { sessionId: remoteId(w.aId, session.id) })).body as TakeoverPreview;
    expect(preview.blockers).toEqual([
      `mac-laptop already has a git worktree of alpha at ${planned} (on someone-else). Remove it there if it is not in use (git worktree remove), or pick another target folder, then check again.`,
    ]);
  }, 120_000);

  it('an empty leftover folder does not block: the restore removes it and the move succeeds', async () => {
    const w = (world = await takeoverWorld(tmp));
    const branch = 'TASK-0045-empty-left';
    const { session, planned } = await worktreeSession(w, 'empty-left', branch);
    await mkdir(planned, { recursive: true });
    const preview = (await w.b.call('POST', '/api/takeover/preview', { sessionId: remoteId(w.aId, session.id) })).body as TakeoverPreview;
    expect(preview.blockers).toEqual([]);
    expect(preview.ok).toBe(true);
    const done = await run(w.a, { sessionId: session.id, targetMachine: w.bId });
    expect(done.state, JSON.stringify(done.error)).toBe('done');
    expect(await w.git(planned, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
    expect(await w.git(w.paths.b.alpha, 'worktree', 'list', '--porcelain')).toContain(`worktree ${await realpath(planned)}`);
  }, 120_000);

  it('a stale (prunable) worktree entry at the path, on the session\'s branch, does not block: the restore removes that entry and the move succeeds', async () => {
    const w = (world = await takeoverWorld(tmp));
    const branch = 'TASK-0046-stale-entry';
    const { session, planned } = await worktreeSession(w, 'stale-entry', branch);
    // An earlier attempt's worktree whose folder was deleted by hand: git still lists it (prunable) and it holds the branch.
    await w.git(w.paths.b.alpha, 'worktree', 'add', '-q', '-b', branch, planned, 'main');
    await rm(planned, { recursive: true, force: true });
    expect(await w.git(w.paths.b.alpha, 'worktree', 'list', '--porcelain')).toContain('prunable');
    const preview = (await w.b.call('POST', '/api/takeover/preview', { sessionId: remoteId(w.aId, session.id) })).body as TakeoverPreview;
    expect(preview.blockers).toEqual([]);
    const done = await run(w.b, { sessionId: remoteId(w.aId, session.id) });
    expect(done.state, JSON.stringify(done.error)).toBe('done');
    expect(await w.git(planned, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
    expect(await w.git(w.paths.b.alpha, 'worktree', 'list', '--porcelain')).not.toContain('prunable');
  }, 120_000);
});
