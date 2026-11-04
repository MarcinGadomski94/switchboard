import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import type { TeamMember, TeamMoveRun, TeamView } from '../../../src/core/team.ts';
import { makeTempDir } from '../../helpers/net.ts';
import { machineOn, type PeerNode, waitFor } from '../../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, startRepoSession, takeoverWorld } from '../../helpers/takeover.ts';

/**
 * Moving a member to another machine (D100 × D65) when that machine is not there
 * or the take-over fails half-way: the move is refused up front for a machine that
 * is offline or reconnecting (a clear reason, nothing changes), a run that fails
 * reports the failure with its reason and leaves the member where it was, and a
 * move that succeeds is "done" only with the member's machine changed, on both
 * machines.
 */

let tmp: string;
let world: TakeoverWorld | null = null;

beforeEach(async () => {
  tmp = await makeTempDir('team-move');
});
afterEach(async () => {
  if (world) {
    await Promise.all([world.a.server.stop(), world.b.server.stop()]);
    world = null;
  }
  await removeWorld(tmp);
});

async function memberOn(node: PeerNode, id: string): Promise<TeamMember | undefined> {
  const answer = await node.call('GET', '/api/team');
  if (answer.status !== 200) throw new Error(`GET /api/team: HTTP ${answer.status} ${JSON.stringify(answer.body)}`);
  return (answer.body as TeamView).members.find((member) => member.id === id);
}

async function finished(node: PeerNode, runId: string): Promise<TeamMoveRun> {
  return waitFor('the move to end', async () => {
    const run = (await node.call('GET', `/api/team/moves/${encodeURIComponent(runId)}`)).body as TeamMoveRun;
    return run.state === 'running' ? null : run;
  }, 90_000);
}

describe('D100 · moving a member to a machine that is away, or a move that fails', () => {
  it('refuses an offline or reconnecting machine up front, reports a failed run with its reason (the member stays), and shows a done move on both machines', async () => {
    const w = (world = await takeoverWorld(tmp, { env: { SWITCHBOARD_PEER_TEST_HOOKS: '1', SWITCHBOARD_PEER_GRACE_MS: '6000' } }));
    const session = await startRepoSession(w.a, w.folders.a.alpha as string, 'dev-run');
    const adopted = await w.a.call('POST', '/api/team/members', { sessionId: session.id, name: 'Developer' });
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(201);
    const id = (adopted.body as TeamMember).id;
    await waitFor('B sees the member', async () => (await memberOn(w.b, id))?.machineId === w.aId);

    // ── A take-over that fails half-way (the target's branch has diverged): a failure with its reason; nothing changes.
    await w.git(w.paths.a.alpha, 'checkout', '-q', '-b', 'feature/clash');
    await writeFile(path.join(w.paths.a.alpha, 'a-side.txt'), 'from a\n');
    await w.git(w.paths.a.alpha, 'add', '-A');
    await w.git(w.paths.a.alpha, 'commit', '-q', '-m', 'a commit');
    await w.git(w.paths.b.alpha, 'checkout', '-q', '-b', 'feature/clash');
    await writeFile(path.join(w.paths.b.alpha, 'b-side.txt'), 'from b\n');
    await w.git(w.paths.b.alpha, 'add', '-A');
    await w.git(w.paths.b.alpha, 'commit', '-q', '-m', 'b commit');
    await w.git(w.paths.b.alpha, 'checkout', '-q', 'main');
    const check = await w.a.call('POST', `/api/team/members/${id}/move/check`, { targetMachineId: w.bId });
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    expect(check.body.ok, JSON.stringify(check.body)).toBe(true);
    const started = await w.a.call('POST', `/api/team/members/${id}/move`, { targetMachineId: w.bId });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const failed = await finished(w.a, (started.body as TeamMoveRun).id);
    expect(failed.state).toBe('failed');
    // The reason names the step and the take-over's message, and says the member stays.
    expect(failed.error).toContain('Restoring the working tree');
    expect(failed.error).toContain('has commits the original does not have');
    expect(failed.error).toContain('Developer still runs on pc-office');
    expect(failed.machineId).toBe(w.aId);
    const stayed = await memberOn(w.a, id);
    expect([stayed?.machineId, stayed?.sessionId]).toEqual([w.aId, session.id]);
    expect(((await w.a.call('GET', `/api/sessions/${session.id}`)).body as Session).movedTo).toBeNull();
    expect((await memberOn(w.b, id))?.machineId).toBe(w.aId);
    await w.git(w.paths.b.alpha, 'branch', '-q', '-D', 'feature/clash');

    // ── B is reconnecting: refused at once with that reason (no hold), and Move is refused too.
    expect((await w.b.call('POST', '/api/test/peers/outage', { ms: 120_000 })).status).toBe(204);
    await waitFor('A sees B reconnecting', async () => (await machineOn(w.a, w.bId))?.state === 'reconnecting', 10_000);
    const t0 = Date.now();
    const reconnecting = await w.a.call('POST', `/api/team/members/${id}/move/check`, { targetMachineId: w.bId });
    expect(reconnecting.status, JSON.stringify(reconnecting.body)).toBe(200);
    expect(reconnecting.body.ok).toBe(false);
    expect(reconnecting.body.blockers).toEqual(['mac-laptop is reconnecting: move Developer when it is back online']);
    expect(Date.now() - t0).toBeLessThan(3_000);
    const refusedWhileReconnecting = await w.a.call('POST', `/api/team/members/${id}/move`, { targetMachineId: w.bId });
    expect(refusedWhileReconnecting.status).toBe(409);

    // ── B is offline: refused with that reason.
    await waitFor('A sees B offline', async () => (await machineOn(w.a, w.bId))?.state === 'offline', 30_000);
    const offline = await w.a.call('POST', `/api/team/members/${id}/move/check`, { targetMachineId: w.bId });
    expect(offline.body.ok).toBe(false);
    expect(offline.body.blockers).toEqual(['mac-laptop is offline: move Developer when it is back online']);
    const refused = await w.a.call('POST', `/api/team/members/${id}/move`, { targetMachineId: w.bId });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toBe('mac-laptop is offline: move Developer when it is back online');
    expect((await memberOn(w.a, id))?.machineId).toBe(w.aId);

    // ── B is back: the move succeeds; done means the member's machine changed, on both machines.
    expect((await w.b.call('DELETE', '/api/test/peers/outage')).status).toBe(204);
    await waitFor('A sees B online', async () => (await machineOn(w.a, w.bId))?.state === 'online', 30_000);
    const go = await w.a.call('POST', `/api/team/members/${id}/move`, { targetMachineId: w.bId });
    expect(go.status, JSON.stringify(go.body)).toBe(202);
    const done = await finished(w.a, (go.body as TeamMoveRun).id);
    expect(done, JSON.stringify(done)).toMatchObject({ state: 'done', error: null, machineId: w.bId });
    // At once on A (the run is done only after the record changed) …
    const onA = await memberOn(w.a, id);
    expect([onA?.machineId, onA?.local, onA?.machineName]).toEqual([w.bId, false, 'mac-laptop']);
    // … and on B once the sync arrives.
    const onB = await waitFor('B runs the member', async () => {
      const member = await memberOn(w.b, id);
      return member?.machineId === w.bId ? member : null;
    }, 20_000);
    expect(onB.local).toBe(true);
    expect(((await w.a.call('GET', `/api/sessions/${session.id}`)).body as Session).movedTo).not.toBeNull();
  }, 240_000);

  it('a teammate moved by the plain take-over (the agent view’s Move to computer) is followed: its record names the new computer on both machines', async () => {
    const w = (world = await takeoverWorld(tmp));
    const session = await startRepoSession(w.a, w.folders.a.alpha as string, 'plain-run');
    const adopted = await w.a.call('POST', '/api/team/members', { sessionId: session.id, name: 'Reviewer' });
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(201);
    const id = (adopted.body as TeamMember).id;
    const started = await w.a.call('POST', '/api/takeover', { sessionId: session.id, targetMachine: w.bId });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const runId = (started.body as { id: string }).id;
    const run = await waitFor('the take-over to end', async () => {
      const now = (await w.a.call('GET', `/api/takeover/runs/${runId}`)).body as { state: string; error: unknown };
      return now.state === 'running' ? null : now;
    }, 90_000);
    expect(run, JSON.stringify(run)).toMatchObject({ state: 'done', error: null });
    const onA = await waitFor('A follows the move', async () => {
      const member = await memberOn(w.a, id);
      return member?.machineId === w.bId ? member : null;
    }, 20_000);
    expect(onA.sessionId).not.toBe(session.id);
    const onB = await waitFor('B runs the member', async () => {
      const member = await memberOn(w.b, id);
      return member?.machineId === w.bId ? member : null;
    }, 20_000);
    expect([onB.local, onB.sessionId]).toEqual([true, onA.sessionId]);
    expect(((await w.b.call('GET', `/api/sessions/${onB.sessionId}`)).status)).toBe(200);
    const activity = ((await w.a.call('GET', '/api/team')).body as TeamView).activity.map((entry) => entry.text);
    expect(activity).toEqual(expect.arrayContaining(['moved from pc-office to mac-laptop']));
  }, 180_000);
});
