import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxItem } from '../../../src/core/api.ts';
import type { MoveRecord, MovesChanged } from '../../../src/core/moves.ts';
import { remoteId } from '../../../src/core/peers.ts';
import type { TakeoverRun } from '../../../src/core/takeover.ts';
import type { TeamMember } from '../../../src/core/team.ts';
import { TOKEN_FILE } from '../../../src/server/token.ts';
import { makeTempDir } from '../../helpers/net.ts';
import { type PeerNode, waitFor } from '../../helpers/peers.ts';
import { type HubStream, openHub } from '../../helpers/sse.ts';
import { type TakeoverWorld, removeWorld, startRepoSession, takeoverWorld } from '../../helpers/takeover.ts';

/**
 * D154 (`docs/peers.md` → *Following a move (D154)*) with two real Switchboards, temp repos
 * and a local bare remote: the moves list (`GET /api/moves`) on the machine that drives a
 * move and, merged, on the paired one; `movesChanged` per step on both; a failed move's
 * "Move failed" Inbox item (Try again's payload, Dismiss) and its close by a later success
 * of the same agent started from the other machine; a teammate's move held at a step is
 * listed as running with its crew on both machines; dismissing a finished move.
 */

let tmp: string;
let world: TakeoverWorld | null = null;
const streams: HubStream[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('takeover-moves');
});
afterEach(async () => {
  for (const stream of streams.splice(0)) stream.close();
  if (world) await Promise.all([world.a.server.stop(), world.b.server.stop()]);
  world = null;
  await removeWorld(tmp);
});

async function hubOf(node: PeerNode): Promise<HubStream> {
  const token = (await readFile(path.join(node.dataDir, TOKEN_FILE), 'utf8')).trim();
  const hub = await openHub({ port: node.server.port, cookie: `sb_token=${token}`, headers: { host: `127.0.0.1:${node.server.port}` } });
  streams.push(hub);
  return hub;
}

async function runToEnd(node: PeerNode, body: Record<string, unknown>): Promise<TakeoverRun> {
  const started = await node.call('POST', '/api/takeover', body);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const id = (started.body as TakeoverRun).id;
  return waitFor('the take-over to end', async () => {
    const current = (await node.call('GET', `/api/takeover/runs/${id}`)).body as TakeoverRun;
    return current.state === 'running' ? null : current;
  }, 90_000);
}

async function moves(node: PeerNode): Promise<MoveRecord[]> {
  const answer = await node.call('GET', '/api/moves');
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body as MoveRecord[];
}

async function moveItems(node: PeerNode): Promise<InboxItem[]> {
  return ((await node.call('GET', '/api/inbox')).body as InboxItem[]).filter((item) => item.kind === 'system' && item.label === 'Move failed');
}

/** The target's branch of the same name has a commit the source lacks: the restore there fails (diverged). */
async function diverge(w: TakeoverWorld): Promise<void> {
  await w.git(w.paths.a.alpha, 'checkout', '-q', '-b', 'feature/clash');
  await writeFile(path.join(w.paths.a.alpha, 'a-side.txt'), 'from a\n');
  await w.git(w.paths.a.alpha, 'add', '-A');
  await w.git(w.paths.a.alpha, 'commit', '-q', '-m', 'a commit');
  await w.git(w.paths.b.alpha, 'checkout', '-q', '-b', 'feature/clash');
  await writeFile(path.join(w.paths.b.alpha, 'b-side.txt'), 'from b\n');
  await w.git(w.paths.b.alpha, 'add', '-A');
  await w.git(w.paths.b.alpha, 'commit', '-q', '-m', 'b commit');
  await w.git(w.paths.b.alpha, 'checkout', '-q', 'main');
}

describe.skipIf(process.platform === 'win32')('the moves list across paired machines (D154)', () => {
  it('a failed move is listed on both machines with its outcome, raises a Needs-you item with Try again; a later success from the other machine closes it', async () => {
    const w = (world = await takeoverWorld(tmp));
    const hubA = await hubOf(w.a);
    const hubB = await hubOf(w.b);
    await diverge(w);
    const session = await startRepoSession(w.a, w.folders.a.alpha as string, 'clash-run');

    // 1 · A moves its agent to B; the restore there fails.
    const failed = await runToEnd(w.a, { sessionId: session.id, targetMachine: w.bId, excludeRepos: [] });
    expect(failed.state).toBe('failed');
    const [onA] = await moves(w.a);
    expect(onA).toMatchObject({
      id: failed.id,
      kind: 'agent',
      title: 'clash-run',
      member: null,
      state: 'failed',
      step: { id: 'apply' },
      error: { step: 'apply' },
      rolledBack: true,
      interrupted: false,
      source: { id: w.aId, name: 'pc-office', sessionId: session.id },
      target: { id: w.bId, name: 'mac-laptop', sessionId: null },
      agentSessionId: session.id,
    });
    expect(onA?.machine).toBeUndefined();
    expect(onA?.endedAt).not.toBeNull();
    expect(onA?.error?.message).toContain('has commits the original does not have');
    expect(onA?.steps.map((step) => step.status)).toEqual(['done', 'done', 'done', 'done', 'failed', 'pending', 'pending']);
    // One movesChanged per step change (no duplicates of the same step state), the last one the failure.
    const published = hubA.payloads<MovesChanged>('movesChanged').filter((event) => event.move.id === failed.id);
    expect(published.length).toBeGreaterThanOrEqual(7);
    expect(published.map((event) => event.move.step?.id)).toEqual(expect.arrayContaining(['checks', 'stop', 'capture', 'transfer', 'apply']));
    expect(published.at(-1)?.move).toMatchObject({ state: 'failed', step: { id: 'apply' } });

    // B lists A's move, merged: its remote id, the machine, the agent in B's addressing; and gets the event.
    const merged = await waitFor('B lists A’s move', async () => (await moves(w.b)).find((move) => move.id === remoteId(w.aId, failed.id) && move.state === 'failed') ?? null, 20_000);
    expect(merged).toMatchObject({ machine: { id: w.aId, name: 'pc-office' }, agentSessionId: remoteId(w.aId, session.id), source: { id: w.aId }, target: { id: w.bId } });
    await hubB.waitFor(() => hubB.payloads<MovesChanged>('movesChanged').find((event) => event.move.id === remoteId(w.aId, failed.id) && event.move.state === 'failed'), 'B’s movesChanged', 20_000);
    // A paired machine asks for A's own moves only.
    const detail = await w.b.call('GET', `/api/moves/${encodeURIComponent(remoteId(w.aId, failed.id))}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body).toMatchObject({ id: remoteId(w.aId, failed.id), state: 'failed' });
    expect((detail.body as { log: string[] }).log.some((line) => line.includes('git'))).toBe(true);

    // The Needs-you item on A: the reason, the step, what was undone; Try again (a link) and Dismiss; merged into B's Inbox.
    const [item] = await moveItems(w.a);
    expect(item).toMatchObject({ title: 'Couldn’t move clash-run to mac-laptop', source: 'clash-run', status: 'fail', sessionId: session.id, actions: [{ id: 'move-try-again', label: 'Try again' }, { id: 'dismiss', label: 'Dismiss' }] });
    expect(item?.detail).toContain('Restoring the working tree here failed: alpha:');
    expect(item?.detail).toContain('Everything was undone. clash-run still runs on pc-office.');
    expect(item?.move).toMatchObject({ id: failed.id, kind: 'agent', title: 'clash-run', source: { id: w.aId, sessionId: session.id }, target: { id: w.bId, name: 'mac-laptop' }, choices: { placement: null, clonePaths: {}, workspaceFiles: null, excludeRepos: [], stashTargets: [] } });
    expect((await w.a.call('POST', `/api/inbox/${item?.id}/actions/move-try-again`)).status).toBe(409);
    const onB = await waitFor('B’s Inbox has A’s item', async () => (await moveItems(w.b))[0] ?? null, 20_000);
    expect(onB.move?.id).toBe(remoteId(w.aId, failed.id));

    // 2 · B takes the agent over itself: the clash is gone, the move succeeds; A's item closes by itself.
    await w.git(w.paths.b.alpha, 'branch', '-q', '-D', 'feature/clash');
    const done = await runToEnd(w.b, { sessionId: remoteId(w.aId, session.id) });
    expect(done.state, JSON.stringify(done.error)).toBe('done');
    await waitFor('A’s failure item closes', async () => (await moveItems(w.a)).length === 0, 20_000);
    const onBNow = await moves(w.b);
    expect(onBNow.find((move) => move.id === done.id)).toMatchObject({ state: 'done', step: null, source: { id: w.aId }, target: { id: w.bId }, agentSessionId: done.result?.sessionId });
    const fromA = await waitFor('A lists B’s move', async () => (await moves(w.a)).find((move) => move.id === remoteId(w.bId, done.id) && move.state === 'done') ?? null, 20_000);
    expect(fromA.agentSessionId).toBe(remoteId(w.bId, done.result?.sessionId as string));

    // 3 · Dismiss: A's failed move, from B (forwarded); gone on both.
    expect((await w.b.call('POST', `/api/moves/${encodeURIComponent(remoteId(w.aId, failed.id))}/dismiss`)).status).toBe(204);
    expect((await moves(w.a)).some((move) => move.id === failed.id)).toBe(false);
    await waitFor('B drops it', async () => !(await moves(w.b)).some((move) => move.id === remoteId(w.aId, failed.id)), 20_000);
  });

  it('a failed move’s item is dismissed like any item; a teammate’s move held at a step is listed as running with its crew on both machines', async () => {
    const w = (world = await takeoverWorld(tmp, { env: { SWITCHBOARD_PEER_TEST_HOOKS: '1' } }));
    const session = await startRepoSession(w.a, w.folders.a.alpha as string, 'dev-run');
    const adopted = await w.a.call('POST', '/api/team/members', { sessionId: session.id, name: 'Developer' });
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(201);
    const member = adopted.body as TeamMember;

    // B holds the take-over's restore: the move waits at that step.
    expect((await w.b.call('POST', '/api/test/peers/hold-takeover', { route: 'target/apply' })).status).toBe(204);
    const started = await w.a.call('POST', `/api/team/members/${member.id}/move`, { targetMachineId: w.bId });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const running = await waitFor('A lists the move at the restore', async () => (await moves(w.a)).find((move) => move.state === 'running' && move.step?.id === 'apply') ?? null, 60_000);
    expect(running).toMatchObject({ kind: 'teammate', title: 'dev-run', member: { id: member.id, name: 'Developer', teamName: expect.any(String) }, source: { id: w.aId }, target: { id: w.bId, name: 'mac-laptop' }, endedAt: null, error: null });
    expect(running.member?.teamId).toBe(member.teamId);
    const onB = await waitFor('B lists it running', async () => (await moves(w.b)).find((move) => move.id === remoteId(w.aId, running.id) && move.state === 'running') ?? null, 20_000);
    expect(onB).toMatchObject({ step: { id: 'apply' }, member: { id: member.id }, agentSessionId: remoteId(w.aId, session.id) });
    // A running move cannot be dismissed.
    expect((await w.a.call('POST', `/api/moves/${running.id}/dismiss`)).status).toBe(409);

    expect((await w.b.call('DELETE', '/api/test/peers/hold-takeover')).status).toBe(204);
    const finished = await waitFor('the move ends', async () => (await moves(w.a)).find((move) => move.id === running.id && move.state !== 'running') ?? null, 90_000);
    expect(finished.state, JSON.stringify(finished.error)).toBe('done');
    expect(await moveItems(w.a)).toEqual([]);
  });

  it('Dismiss closes a failed move’s item', async () => {
    const w = (world = await takeoverWorld(tmp));
    await diverge(w);
    const session = await startRepoSession(w.a, w.folders.a.alpha as string, 'clash-run');
    const failed = await runToEnd(w.a, { sessionId: session.id, targetMachine: w.bId });
    expect(failed.state).toBe('failed');
    const [item] = await moveItems(w.a);
    expect(item).toBeDefined();
    expect((await w.a.call('POST', `/api/inbox/${item?.id}/actions/dismiss`)).status).toBe(204);
    expect(await moveItems(w.a)).toEqual([]);
    // The move stays listed (Home shows it) until it is dismissed there or 24 hours pass.
    expect((await moves(w.a)).map((move) => move.id)).toEqual([failed.id]);
  });
});
