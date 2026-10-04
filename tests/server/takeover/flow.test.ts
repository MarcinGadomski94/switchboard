import { readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session, SessionEvent } from '../../../src/core/api.ts';
import { remoteId } from '../../../src/core/peers.ts';
import { slugForCwd } from '../../../src/core/transcript.ts';
import type { TakeoverRun } from '../../../src/core/takeover.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, waitFor } from '../../helpers/peers.ts';
import { type TakeoverWorld, fakeLog, gitIn, startRepoSession, startWorkspaceSession, takeoverWorld } from '../../helpers/takeover.ts';

/**
 * D65 with two real Switchboard processes ("pc" = a, "mac" = b), fake CLIs, temp
 * repos and a local bare repo as the shared remote (`docs/peers.md` → *Taking a
 * session over*): the code travels through a WIP push, the conversation is copied,
 * the session resumes on the other machine and the old one is marked moved.
 */

let tmp: string;
let world: TakeoverWorld | null = null;

beforeEach(async () => {
  tmp = await makeTempDir('takeover');
});
afterEach(async () => {
  if (world) await Promise.all([world.a.server.stop(), world.b.server.stop()]);
  world = null;
  await removeTempDir(tmp);
});

/** Runs a take-over from `node`'s UI and waits for its end. */
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

async function eventsOf(node: PeerNode, id: string): Promise<SessionEvent[]> {
  return (await node.call('GET', `/api/sessions/${id}/events`)).body as SessionEvent[];
}

describe('D65: a session of the other machine is taken over to this one', () => {
  it('restores uncommitted, untracked and unpushed work exactly, resumes the same conversation, marks the old session moved', async () => {
    const w = (world = await takeoverWorld(tmp));
    const alphaA = w.paths.a.alpha;
    const alphaB = w.paths.b.alpha;
    const started = await startRepoSession(w.a, w.folders.a.alpha as string, 'fix-login');
    // The pc's work: a branch with an unpushed commit, a staged and an unstaged edit, an untracked file, an ignored file.
    await w.git(alphaA, 'checkout', '-q', '-b', 'feature/login');
    await writeFile(path.join(alphaA, '.gitignore'), 'ignored.log\n');
    await writeFile(path.join(alphaA, 'unpushed.txt'), 'committed but not pushed\n');
    await w.git(alphaA, 'add', '-A');
    await w.git(alphaA, 'commit', '-q', '-m', 'an unpushed commit');
    await writeFile(path.join(alphaA, 'tracked.txt'), 'one\nTWO changed\nthree\n');
    await writeFile(path.join(alphaA, 'staged.txt'), 'staged\n');
    await w.git(alphaA, 'add', 'staged.txt');
    await writeFile(path.join(alphaA, 'untracked.txt'), 'brand new\n');
    await writeFile(path.join(alphaA, 'ignored.log'), 'never travels\n');
    const headBefore = await w.git(alphaA, 'rev-parse', 'HEAD');
    const statusBefore = await w.git(alphaA, 'status', '--porcelain');
    const indexBefore = await w.git(alphaA, 'ls-files', '--stage');

    const finished = await run(w.b, { sessionId: remoteId(w.aId, started.id) });
    expect(finished.error, JSON.stringify(finished)).toBeNull();
    expect(finished.state).toBe('done');
    expect(finished.steps.map((step) => step.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'done']);
    expect(finished.leftovers).toEqual([]);
    expect(finished.log.join('\n')).toContain('commit-tree');
    expect(finished.log.join('\n')).toContain('push origin --delete');

    // The mac: the real branch, the unpushed commit, the changes uncommitted again (staged ones unstaged), nothing ignored.
    expect(await w.git(alphaB, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/login');
    expect(await w.git(alphaB, 'log', '-1', '--format=%s')).toBe('an unpushed commit');
    expect(await w.git(alphaB, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect((await w.git(alphaB, 'status', '--porcelain')).split('\n').map((line) => line.trim()).sort()).toEqual(['?? staged.txt', '?? untracked.txt', 'M tracked.txt']);
    expect(await readFile(path.join(alphaB, 'tracked.txt'), 'utf8')).toBe('one\nTWO changed\nthree\n');
    expect(await readFile(path.join(alphaB, 'untracked.txt'), 'utf8')).toBe('brand new\n');
    await expect(stat(path.join(alphaB, 'ignored.log'))).rejects.toThrow();
    // The remote: no temp branch left, and the real branch was never pushed.
    expect(await remoteHeads(w, w.remotes.alpha)).toEqual(['refs/heads/main']);
    // The pc: exactly as it was (branch, HEAD, index, working tree).
    expect(await w.git(alphaA, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(await w.git(alphaA, 'status', '--porcelain')).toBe(statusBefore);
    expect(await w.git(alphaA, 'ls-files', '--stage')).toBe(indexBefore);
    expect(await w.git(alphaA, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/login');
    expect((await w.git(alphaA, 'for-each-ref', '--format=%(refname)')).split('\n').filter((ref) => ref.includes('takeover'))).toEqual([]);

    // The new session on the mac: the same conversation, resumed in the mac's own folder.
    const sessions = (await w.b.call('GET', '/api/sessions')).body as Session[];
    const created = sessions.find((session) => session.movedFrom?.sessionId === started.id) as Session;
    expect(created).toBeTruthy();
    expect(finished.result).toEqual({ sessionId: created.id, machineName: expect.any(String), machineId: w.bId, local: true });
    expect(created).toMatchObject({ claudeSessionId: started.claudeSessionId, cwd: alphaB, folder: w.folders.b.alpha, movedFrom: { machineId: w.aId, sessionId: started.id } });
    const transcript = path.join(w.b.configDir, 'projects', slugForCwd(alphaB), `${started.claudeSessionId}.jsonl`);
    expect((await stat(transcript)).size).toBeGreaterThan(0);
    const spawns = (await fakeLog(w.logs.b)).filter((entry) => entry['kind'] === 'argv');
    const resumed = spawns.find((entry) => (entry['argv'] as string[]).includes('--resume'));
    expect(resumed?.['cwd']).toBe(alphaB);
    expect((resumed?.['argv'] as string[])[(resumed?.['argv'] as string[]).indexOf('--resume') + 1]).toBe(started.claudeSessionId);
    const stdin = (await fakeLog(w.logs.b)).filter((entry) => entry['kind'] === 'stdin').map((entry) => String(entry['line']));
    expect(stdin.join('\n')).toContain('This session moved from');
    expect(stdin.join('\n')).toContain(`${alphaA} → ${alphaB}`);
    expect(stdin.join('\n')).toContain('The working tree was restored as it was.');
    // The chat says where it came from; the first message is a service message that is not left queued (D44).
    const events = await eventsOf(w.b, created.id);
    expect(events.some((event) => event.label.startsWith('Taken over from'))).toBe(true);
    const note = events.find((event) => (event.payload as { text?: string } | null)?.text?.startsWith('This session moved from'));
    expect(note).toBeTruthy();
    await waitFor('the first message taken up', async () => {
      const detail = (await w.b.call('GET', `/api/sessions/${created.id}`)).body as Session;
      return detail.status === 'idle' || detail.status === 'done' ? detail : null;
    });
    // The pc's session: closed, read-only, with the link to the new one; reopening it is refused.
    const old = (await w.a.call('GET', `/api/sessions/${started.id}`)).body as Session;
    expect(old.closedAt).not.toBeNull();
    expect(old.movedTo).toMatchObject({ machineId: w.bId, sessionId: created.id });
    expect((await w.a.call('POST', `/api/sessions/${started.id}/reopen`)).status).toBe(409);
    expect((await eventsOf(w.a, started.id)).some((event) => event.label.startsWith('Moved to'))).toBe(true);
  }, 120_000);
});
