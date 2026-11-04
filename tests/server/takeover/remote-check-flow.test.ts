import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import { remoteId } from '../../../src/core/peers.ts';
import type { TakeoverPreview, TakeoverRun } from '../../../src/core/takeover.ts';
import type { TeamMember } from '../../../src/core/team.ts';
import { writeFakeSsh } from '../../helpers/fake-ssh.ts';
import { makeTempDir } from '../../helpers/net.ts';
import { type PeerNode, waitFor } from '../../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, startRepoSession, takeoverWorld } from '../../helpers/takeover.ts';

/**
 * The target's remote check and the undo of a restore that failed (`docs/peers.md`
 * → *Reaching the remote*, *Rollback*), with two real Switchboards, temp repos, a
 * local bare repo and a fake `ssh` that has no usable key (never a real key, host
 * or network): a remote the target's service cannot read blocks the preview, the
 * Team move check and the run before anything is paused, with git's reason and a
 * hint; once it is reachable the next check passes (nothing cached). A restore
 * that fails before its worktree was made reports no leftover.
 */

let tmp: string;
let world: TakeoverWorld | null = null;

beforeEach(async () => {
  tmp = await makeTempDir('takeover-remote-flow');
});
afterEach(async () => {
  if (world) await Promise.all([world.a.server.stop(), world.b.server.stop()]);
  world = null;
  await removeWorld(tmp);
});

const SSH_URL = 'git@example.invalid:acme/alpha.git';

async function run(node: PeerNode, body: Record<string, unknown>): Promise<TakeoverRun> {
  const started = await node.call('POST', '/api/takeover', body);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const id = (started.body as TakeoverRun).id;
  return waitFor('the take-over to end', async () => {
    const current = (await node.call('GET', `/api/takeover/runs/${id}`)).body as TakeoverRun;
    return current.state === 'running' ? null : current;
  }, 90_000);
}

/** Both machines' alpha talk to the remote over ssh (the same repo: the keys match). */
async function useSsh(w: TakeoverWorld, nodes: ReadonlyArray<'a' | 'b'>): Promise<void> {
  for (const node of nodes) await w.git(w.paths[node].alpha, 'remote', 'set-url', 'origin', SSH_URL);
}

describe.skipIf(process.platform === 'win32')("the target checks that its service can reach each repo's remote", () => {
  it('an ssh remote without a usable key blocks the preview, the Team move check and the run before anything is paused; reachable again, the check passes', async () => {
    const ssh = await writeFakeSsh(path.join(tmp, 'fake-ssh'));
    // GIT_SSH_COMMAND rather than GIT_SSH: a value in the test runner's own environment cannot win over the fake.
    const w = (world = await takeoverWorld(tmp, { env: { GIT_SSH_COMMAND: `"${ssh.program}"`, FAKE_SSH_LOG: ssh.log } }));
    const session = await startRepoSession(w.a, w.folders.a.alpha as string, 'ssh-only');
    const adopted = await w.a.call('POST', '/api/team/members', { sessionId: session.id, name: 'Developer' });
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(201);
    const memberId = (adopted.body as TeamMember).id;
    await useSsh(w, ['a', 'b']);
    const before = (await w.a.call('GET', `/api/sessions/${session.id}`)).body as Session;

    const blocker =
      "mac-laptop can't reach alpha's remote (git@example.invalid:acme/alpha.git) from Switchboard's service: Permission denied (publickey). Its SSH key isn't available to the background service — switch this repo's origin to HTTPS (Git Credential Manager) or make the key usable without a prompt, then check again.";
    // The take-over to this machine (b), and the move from a: both ask b.
    const toB = (await w.b.call('POST', '/api/takeover/preview', { sessionId: remoteId(w.aId, session.id) })).body as TakeoverPreview;
    expect(toB.ok).toBe(false);
    expect(toB.blockers).toEqual([blocker]);
    expect(toB.target.repos[0]).toMatchObject({ name: 'alpha', action: 'blocked', reason: blocker });
    const fromA = (await w.a.call('POST', '/api/takeover/preview', { sessionId: session.id, targetMachine: w.bId })).body as TakeoverPreview;
    expect(fromA.blockers).toEqual([blocker]);
    const check = await w.a.call('POST', `/api/team/members/${memberId}/move/check`, { targetMachineId: w.bId });
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    expect(check.body).toMatchObject({ ok: false });
    expect(check.body.blockers).toContain(blocker);
    const refused = await w.a.call('POST', `/api/team/members/${memberId}/move`, { targetMachineId: w.bId });
    expect(refused.status).toBe(409);

    // The run stops at the checks: the session was not paused, nothing was pushed.
    const failed = await run(w.a, { sessionId: session.id, targetMachine: w.bId });
    expect(failed).toMatchObject({ state: 'failed', error: { step: 'checks' } });
    expect(failed.error?.message).toContain(blocker);
    expect(failed.steps.find((step) => step.id === 'stop')?.status).toBe('pending');
    const after = (await w.a.call('GET', `/api/sessions/${session.id}`)).body as Session;
    expect([after.status, after.live, after.closedAt, after.movedTo]).toEqual([before.status, before.live, null, null]);
    expect(await w.git(w.root, 'ls-remote', '--heads', w.remotes.alpha)).not.toContain('switchboard/takeover');
    // Every ssh call ran in batch mode (no prompt to hang on).
    const calls = await ssh.calls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.includes('-o BatchMode=yes'))).toBe(true);

    // Fixed on b (back to a remote the service can read): "check again" asks again and passes.
    await w.git(w.paths.b.alpha, 'remote', 'set-url', 'origin', w.remotes.alpha);
    await w.git(w.paths.a.alpha, 'remote', 'set-url', 'origin', w.remotes.alpha);
    const again = (await w.b.call('POST', '/api/takeover/preview', { sessionId: remoteId(w.aId, session.id) })).body as TakeoverPreview;
    expect(again.blockers).toEqual([]);
    expect(again.ok).toBe(true);
    const checkAgain = await w.a.call('POST', `/api/team/members/${memberId}/move/check`, { targetMachineId: w.bId });
    expect(checkAgain.body).toMatchObject({ ok: true });
  }, 120_000);

  it('a repo to be cloned is checked on its clone URL', async () => {
    const ssh = await writeFakeSsh(path.join(tmp, 'fake-ssh'));
    const w = (world = await takeoverWorld(tmp, { bRepos: { gamma: true }, env: { GIT_SSH_COMMAND: `"${ssh.program}"`, FAKE_SSH_LOG: ssh.log } }));
    const session = await startRepoSession(w.a, w.folders.a.alpha as string, 'clone-me');
    await useSsh(w, ['a']);
    const preview = (await w.b.call('POST', '/api/takeover/preview', { sessionId: remoteId(w.aId, session.id) })).body as TakeoverPreview;
    expect(preview.ok).toBe(false);
    expect(preview.blockers).toEqual([
      "mac-laptop can't reach alpha's remote (git@example.invalid:acme/alpha.git) from Switchboard's service: Permission denied (publickey). Its SSH key isn't available to the background service — clone it here over HTTPS (Git Credential Manager) and choose that folder, or make the key usable without a prompt, then check again.",
    ]);
    expect(await stat(path.join(path.dirname(w.paths.b.gamma), 'alpha')).catch(() => null)).toBeNull();
    expect((await ssh.calls()).every((call) => call.includes('-o BatchMode=yes'))).toBe(true);
  }, 120_000);
});

describe('the undo of a restore that failed before its worktree was made', () => {
  it('reports no leftover for the worktree it never created, and everything is undone', async () => {
    const w = (world = await takeoverWorld(tmp));
    const branch = 'TASK-0042-never-made';
    const started = await startRepoSession(w.a, w.folders.a.alpha as string, 'never-made', { worktrees: true, branch });
    await writeFile(path.join(started.cwd as string, 'a-side.txt'), 'from a\n');
    await w.git(started.cwd as string, 'add', '-A');
    await w.git(started.cwd as string, 'commit', '-q', '-m', 'a commit');
    // b has the branch with a commit a does not have (not checked out): the restore stops at "diverged", after the fetch, before `worktree add`.
    await w.git(w.paths.b.alpha, 'branch', '-q', branch, 'main');
    await w.git(w.paths.b.alpha, 'checkout', '-q', branch);
    await writeFile(path.join(w.paths.b.alpha, 'b-side.txt'), 'from b\n');
    await w.git(w.paths.b.alpha, 'add', '-A');
    await w.git(w.paths.b.alpha, 'commit', '-q', '-m', 'b commit');
    await w.git(w.paths.b.alpha, 'checkout', '-q', 'main');
    const tipB = await w.git(w.paths.b.alpha, 'rev-parse', branch);

    const failed = await run(w.b, { sessionId: remoteId(w.aId, started.id) });
    expect(failed).toMatchObject({ state: 'failed', error: { step: 'apply' } });
    expect(failed.error?.message).toContain('has commits the original does not have');
    // Only the source's "runs here again": no worktree reported as left behind.
    expect(failed.rollbackNotes).toEqual(['the session runs here again']);
    expect(failed.rolledBack).toBe(true);
    const planned = path.join(path.dirname(w.paths.b.alpha), 'alpha-wt-never-made');
    expect(await stat(planned).catch(() => null)).toBeNull();
    expect(await w.git(w.paths.b.alpha, 'rev-parse', branch)).toBe(tipB);
    expect(await w.git(w.root, 'ls-remote', '--heads', w.remotes.alpha)).not.toContain('switchboard/takeover');
  }, 120_000);
});
