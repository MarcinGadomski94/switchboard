import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OwnedLoop } from '../../../src/core/api.ts';
import { remoteId } from '../../../src/core/peers.ts';
import type { TeamMember, TeamState, TeamView } from '../../../src/core/team.ts';
import { makeTempDir } from '../../helpers/net.ts';
import { type PeerNode, waitFor } from '../../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, startRepoSession, takeoverWorld } from '../../helpers/takeover.ts';

/**
 * D100 × D48 / D65 with two real Switchboard processes (fake CLIs, temp repos and a
 * shared bare remote): the team definition syncs both ways; a member that runs on B
 * is visible on A, paused from A (through the peer API, on B), moved from B to A
 * with the D65 take-over (its loops re-created on A and its record pointing at A),
 * and shown offline on A once B is gone.
 */

let tmp: string;
let world: TakeoverWorld | null = null;

beforeEach(async () => {
  tmp = await makeTempDir('team-peers');
});
afterEach(async () => {
  if (world) {
    await Promise.all([world.a.server.stop(), world.b.server.stop()]);
    world = null;
    await removeWorld(tmp);
  }
});

async function team(node: PeerNode): Promise<TeamView> {
  const answer = await node.call('GET', '/api/team');
  if (answer.status !== 200) throw new Error(`GET /api/team: HTTP ${answer.status} ${JSON.stringify(answer.body)}`);
  return answer.body as TeamView;
}

async function memberOn(node: PeerNode, name: string): Promise<TeamMember | undefined> {
  return (await team(node)).members.find((member) => member.name === name);
}

describe('D100 · Team between paired machines', () => {
  it('a member on B is visible and pausable from A, moves from B to A with the take-over, and B\'s members show offline when B is away', async () => {
    const w = (world = await takeoverWorld(tmp));
    for (const node of [w.a, w.b]) expect((await node.call('PUT', '/api/settings', { 'experimental.team': true })).status).toBe(200);
    const tracker = await startRepoSession(w.b, w.folders.b.alpha as string, 'tracker-run');
    const builder = await startRepoSession(w.b, w.folders.b.alpha as string, 'builder-run');
    const loop = await w.b.call('POST', `/api/sessions/${tracker.id}/loops`, { prompt: 'Sweep the board.', everyMinutes: 30, label: 'Sweep' });
    expect(loop.status, JSON.stringify(loop.body)).toBe(201);
    const loopId = (loop.body as OwnedLoop).id;

    // A adopts B's session (the adoption runs on B, which runs it).
    const adopted = await w.a.call('POST', '/api/team/members', { sessionId: remoteId(w.bId, tracker.id), name: 'Tracker', rhythm: { loopIds: [loopId], onHandoff: true } });
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(201);
    expect((await w.b.call('POST', '/api/team/members', { sessionId: builder.id, name: 'Builder' })).status).toBe(201);

    // Synced to A: B runs them, A shows them with B's name and hides them from its sidebar too.
    const seen = await waitFor('A sees both members', async () => {
      const view = await team(w.a);
      return view.members.length === 2 && view.members.every((m) => m.status !== 'offline') ? view : null;
    });
    const onA = seen.members.find((m) => m.name === 'Tracker') as TeamMember;
    expect([onA.machineId, onA.local, onA.sessionRef]).toEqual([w.bId, false, remoteId(w.bId, tracker.id)]);
    const stateA = (await w.a.call('GET', '/api/team/state')).body as TeamState;
    expect([...stateA.hiddenSessionIds].sort()).toEqual([remoteId(w.bId, tracker.id), remoteId(w.bId, builder.id)].sort());

    // Pause from A: it runs on B (B's loop is paused there), and A sees it.
    const paused = await w.a.call('POST', `/api/team/members/${onA.id}/pause`);
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    expect(((await w.b.call('GET', `/api/sessions/${tracker.id}/loops`)).body as OwnedLoop[]).map((l) => l.state)).toEqual(['paused']);
    expect((await memberOn(w.b, 'Tracker'))?.paused).toBe(true);
    await waitFor('A sees the pause', async () => (await memberOn(w.a, 'Tracker'))?.status === 'paused');

    // Move Tracker from B to A: the checks first, then the take-over.
    const check = await w.a.call('POST', `/api/team/members/${onA.id}/move/check`, { targetMachineId: w.aId });
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    expect(check.body.blockers).toEqual([]);
    const started = await w.a.call('POST', `/api/team/members/${onA.id}/move`, { targetMachineId: w.aId });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const runId = started.body.id as string;
    const finished = await waitFor('the move to end', async () => {
      const run = (await w.a.call('GET', `/api/team/moves/${encodeURIComponent(runId)}`)).body as { state: string; error: string | null };
      return run.state === 'running' ? null : run;
    }, 90_000);
    expect(finished, JSON.stringify(finished)).toMatchObject({ state: 'done', error: null });
    const moved = await waitFor('A runs Tracker', async () => {
      const member = await memberOn(w.a, 'Tracker');
      return member?.machineId === w.aId ? member : null;
    }, 20_000);
    expect(moved.local).toBe(true);
    // Everything else is kept: charter, rhythm (its loop now A's, by id), the pause.
    const loopsOnA = (await w.a.call('GET', `/api/sessions/${moved.sessionId}/loops`)).body as OwnedLoop[];
    expect(loopsOnA.map((l) => [l.prompt, l.state])).toEqual([['Sweep the board.', 'paused']]);
    expect(moved.rhythm.loops.map((l) => l.loopId)).toEqual([loopsOnA[0]?.id]);
    expect(moved.paused).toBe(true);
    // The source's loop ended with the move (no double firing).
    expect(((await w.b.call('GET', `/api/sessions/${tracker.id}/loops`)).body as OwnedLoop[]).map((l) => l.state)).toEqual(['ended']);
    expect((await team(w.a)).activity.map((a) => a.text)).toEqual(expect.arrayContaining([expect.stringMatching(/^moved from .+ to .+$/)]));
    await waitFor('B sees Tracker on A', async () => (await memberOn(w.b, 'Tracker'))?.machineId === w.aId);
    // Resume on A (where it runs now): its loop runs again.
    expect((await w.a.call('POST', `/api/team/members/${moved.id}/resume`)).status).toBe(200);
    expect(((await w.a.call('GET', `/api/sessions/${moved.sessionId}/loops`)).body as OwnedLoop[]).map((l) => l.state)).toEqual(['active']);

    // B goes away: its member shows offline on A (the last known record stays).
    await w.b.server.stop();
    await waitFor('Builder offline on A', async () => (await memberOn(w.a, 'Builder'))?.status === 'offline', 30_000);
    expect((await memberOn(w.a, 'Tracker'))?.status).not.toBe('offline');
  }, 180_000);
});
