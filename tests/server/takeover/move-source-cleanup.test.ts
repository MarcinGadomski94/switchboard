import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import type { SourceCleanupReport } from '../../../src/core/source-cleanup.ts';
import type { TakeoverRun } from '../../../src/core/takeover.ts';
import { slugForCwd } from '../../../src/core/transcript.ts';
import { makeTempDir } from '../../helpers/net.ts';
import { waitFor } from '../../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, settle, startWorkspaceSession, takeoverWorld } from '../../helpers/takeover.ts';

/**
 * D156 (`docs/peers.md` → *Cleaning up the source after a move (D156)*), two real
 * Switchboards (the pc "a" and the mac "b"), fake CLIs, temp repos, local bare
 * remotes. A workspace agent works in its main checkout `front` and two of its own
 * worktrees (pushed, unmerged: both travel). With "Clean up on pc-office after a
 * successful move" the pc archives the old agent, removes the worktree that is as
 * the move captured it (and its branch, which the remote has at the same commit)
 * and the copied conversation file; the main checkout stays, and a worktree that
 * changed after the capture is kept; both are on the manual list. **Clean up on this
 * computer…** on an agent moved without the checkbox does the same.
 */

let tmp: string;
let world: TakeoverWorld;
let front: string;

beforeAll(async () => {
  tmp = await makeTempDir('takeover-source-cleanup');
  world = await takeoverWorld(tmp, { aRepos: { workspace: true }, bRepos: { workspace: true }, env: { SWITCHBOARD_PEER_TEST_HOOKS: '1' } });
  front = await realpath(world.paths.a.front);
  // Claude Code's worktrees live in the checkout; the repo ignores them (as `.claude/` would be).
  await writeFile(path.join(front, '.git', 'info', 'exclude'), '.claude/\n');
  await writeFile(path.join(world.paths.b.front, '.git', 'info', 'exclude'), '.claude/\n');
  await mkdir(path.join(front, '.claude', 'worktrees'), { recursive: true });
}, 120_000);

afterAll(async () => {
  if (world) await Promise.all([world.a.server.stop(), world.b.server.stop()]);
  await removeWorld(tmp);
});

const wt = (name: string): string => path.join(front, '.claude', 'worktrees', name);

async function exists(file: string): Promise<boolean> {
  return lstat(file).then(
    () => true,
    () => false,
  );
}

/** A worktree of `front` on a pushed branch with one commit of its own (it travels: pushed, not merged). */
async function pushedWorktree(name: string): Promise<string> {
  await world.git(front, 'worktree', 'add', '-q', '-b', `feat/${name}`, wt(name));
  await writeFile(path.join(wt(name), `${name}.txt`), `${name} work\n`);
  await world.git(wt(name), 'add', `${name}.txt`);
  await world.git(wt(name), 'commit', '-q', '-m', `${name} work`);
  await world.git(wt(name), 'push', '-q', '-u', 'origin', `feat/${name}`);
  return wt(name);
}

/** A workspace agent that read files in `front` and in each worktree (so Works in carries them). */
async function agentIn(name: string, files: readonly string[]): Promise<Session> {
  const session = await startWorkspaceSession(world.a, world.folders.a.workspace as string, name, []);
  for (const file of files) {
    const sent = await world.a.call('POST', `/api/sessions/${session.id}/messages`, { text: `Look. [fake:tool Read ${JSON.stringify({ file_path: file })}]` });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    await settle(world.a, session.id);
  }
  return session;
}

async function runOf(id: string): Promise<TakeoverRun> {
  return (await world.a.call('GET', `/api/takeover/runs/${id}`)).body as TakeoverRun;
}

const transcriptOf = (session: Session): string => path.join(world.a.configDir, 'projects', slugForCwd(world.paths.a.workspace), `${session.claudeSessionId}.jsonl`);

describe('D156: cleaning up the source after a move', () => {
  it('with the checkbox: archives the agent, removes the unchanged carried worktree, its branch and the conversation; keeps the main checkout and a worktree changed since the capture', async () => {
    const keep = await pushedWorktree('keep');
    const drift = await pushedWorktree('drift');
    await writeFile(path.join(drift, 'wip.txt'), 'uncommitted at the capture\n');
    const session = await agentIn('cleanup-move', [path.join(front, 'README.md'), path.join(keep, 'keep.txt'), path.join(drift, 'drift.txt')]);
    const transcript = transcriptOf(session);
    expect(await exists(transcript)).toBe(true);

    // The mac holds the restore: the capture is done, so a change now is one the move did not carry.
    expect((await world.b.call('POST', '/api/test/peers/hold-takeover', { route: 'target/apply' })).status).toBe(204);
    const started = await world.a.call('POST', '/api/takeover', { sessionId: session.id, targetMachine: world.bId, cleanupSource: true });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const id = (started.body as TakeoverRun).id;
    await waitFor('the move to reach the restore', async () => (await runOf(id)).steps.find((step) => step.id === 'apply')?.status === 'running', 60_000);
    await writeFile(path.join(drift, 'later.txt'), 'written after the capture\n');
    expect((await world.b.call('DELETE', '/api/test/peers/hold-takeover')).status).toBe(204);
    const run = await waitFor('the move to end', async () => {
      const now = await runOf(id);
      return now.state === 'running' ? null : now;
    }, 90_000);
    expect(run.state, JSON.stringify(run.error)).toBe('done');

    const report = run.sourceCleanup as SourceCleanupReport;
    expect(report, JSON.stringify(run)).toBeTruthy();
    expect(report).toMatchObject({ ran: true, derived: false, error: null, machine: 'pc-office', movedTo: 'mac-laptop' });
    const removed = report.removed.map((item) => [item.kind, item.path]);
    expect(removed).toEqual(expect.arrayContaining([['worktree', keep], ['branch', `${front} feat/keep`], ['conversation', transcript]]));
    expect(removed.some(([, at]) => at === drift || at === front)).toBe(false);
    const manual = Object.fromEntries(report.manual.map((item) => [`${item.kind} ${item.path}`, item.text]));
    expect(manual[`main-checkout ${front}`]).toContain('Switchboard never removes a main checkout');
    expect(manual[`worktree ${drift}`]).toContain('changed since the move');

    // On disk: only what travelled unchanged is gone.
    expect(await exists(keep)).toBe(false);
    expect(await world.git(front, 'branch', '--list', 'feat/keep')).toBe('');
    expect(await world.git(front, 'worktree', 'list', '--porcelain')).not.toContain(keep);
    expect(await exists(transcript)).toBe(false);
    expect(await readFile(path.join(drift, 'later.txt'), 'utf8')).toBe('written after the capture\n');
    expect(await readFile(path.join(drift, 'wip.txt'), 'utf8')).toBe('uncommitted at the capture\n');
    expect(await world.git(front, 'branch', '--list', 'feat/drift')).toContain('feat/drift');
    expect(await readFile(path.join(front, 'README.md'), 'utf8')).toBeTruthy();
    expect(await world.git(front, 'status', '--porcelain')).toBe('');

    // The old agent: archived (findable in Archived), with the clean-up's time and a note in its chat.
    const old = (await world.a.call('GET', `/api/sessions/${session.id}`)).body as Session;
    expect(old.closedAt).not.toBeNull();
    expect(old.movedTo).toMatchObject({ machineName: 'mac-laptop', cleanedAt: report.at });
    expect(old.movedTo).not.toHaveProperty('carried');
    const archived = (await world.a.call('GET', '/api/sessions?closed=only')).body as Array<{ id: string }>;
    expect(archived.map((entry) => entry.id)).toContain(session.id);
  });

  it('Clean up on this computer… on an agent moved without the checkbox: the preview lists, the run removes the same way', async () => {
    const again = await pushedWorktree('again');
    const session = await agentIn('cleanup-later', [path.join(front, 'README.md'), path.join(again, 'again.txt')]);
    const transcript = transcriptOf(session);
    const started = await world.a.call('POST', '/api/takeover', { sessionId: session.id, targetMachine: world.bId });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const run = await waitFor('the move to end', async () => {
      const now = await runOf((started.body as TakeoverRun).id);
      return now.state === 'running' ? null : now;
    }, 90_000);
    expect(run.state, JSON.stringify(run.error)).toBe('done');
    expect(run.sourceCleanup ?? null).toBeNull();
    expect(await exists(again)).toBe(true);
    expect(await exists(transcript)).toBe(true);

    // The preview changes nothing.
    const preview = await world.a.call('GET', `/api/takeover/cleanup/${session.id}`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const planned = preview.body as SourceCleanupReport;
    expect(planned.ran).toBe(false);
    expect(planned.removed.map((item) => [item.kind, item.path])).toEqual(expect.arrayContaining([['worktree', again], ['branch', `${front} feat/again`], ['conversation', transcript]]));
    expect(planned.manual.map((item) => [item.kind, item.path])).toEqual(expect.arrayContaining([['main-checkout', front]]));
    expect(await exists(again)).toBe(true);

    const cleaned = await world.a.call('POST', `/api/takeover/cleanup/${session.id}`);
    expect(cleaned.status, JSON.stringify(cleaned.body)).toBe(200);
    const report = cleaned.body as SourceCleanupReport;
    expect(report.ran).toBe(true);
    expect(report.removed.map((item) => [item.kind, item.path])).toEqual(expect.arrayContaining([['worktree', again], ['branch', `${front} feat/again`], ['conversation', transcript]]));
    expect(report.manual.map((item) => [item.kind, item.path])).toEqual(expect.arrayContaining([['main-checkout', front]]));
    expect(await exists(again)).toBe(false);
    expect(await world.git(front, 'branch', '--list', 'feat/again')).toBe('');
    expect(await exists(transcript)).toBe(false);
    expect(await exists(front)).toBe(true);
    // The first agent's changed worktree is still there; only this agent's things went.
    expect(await exists(wt('drift'))).toBe(true);

    // A session that was not moved is refused.
    const plain = await startWorkspaceSession(world.a, world.folders.a.workspace as string, 'not-moved', []);
    expect((await world.a.call('GET', `/api/takeover/cleanup/${plain.id}`)).status).toBe(409);
  });
});
