import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CrewMoveCheck, CrewMoveRun, TeamMember, TeamSummary, TeamView } from '../../../src/core/team.ts';
import { crewAdjusted } from '../../../src/server/team/service.ts';
import { makeTempDir } from '../../helpers/net.ts';
import { waitFor } from '../../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, startRepoSession, takeoverWorld } from '../../helpers/takeover.ts';

/**
 * D152 (`docs/team.md` → *Moving a whole crew*), two real Switchboards: every
 * teammate is checked before anything moves (a blocker on one stops the whole move,
 * nothing moves), then they move one by one in the crew's order; a failure stops the
 * rest, the moved ones stay moved and the run says who moved and who did not.
 */

let tmp: string;
let world: TakeoverWorld;
let teamId: string;
const ids: Record<'dev' | 'tester' | 'writer', string> = { dev: '', tester: '', writer: '' };

beforeAll(async () => {
  tmp = await makeTempDir('team-crew-move');
  world = await takeoverWorld(tmp, { aRepos: { alpha: true, gamma: true }, bRepos: { alpha: true, gamma: true } });
  const team = await world.a.call('POST', '/api/team/teams', { name: 'Ops' });
  expect(team.status, JSON.stringify(team.body)).toBe(201);
  teamId = (team.body as TeamSummary).id;
  const adopt = async (folder: string, name: string, role: string, options: { worktrees?: boolean; branch?: string } = {}): Promise<string> => {
    const session = await startRepoSession(world.a, folder, name, options);
    const adopted = await world.a.call('POST', '/api/team/members', { sessionId: session.id, name: role, teamId });
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(201);
    return (adopted.body as TeamMember).id;
  };
  ids.dev = await adopt(world.folders.a.alpha as string, 'ops-dev', 'Dev');
  ids.tester = await adopt(world.folders.a.gamma as string, 'ops-tester', 'Tester');
  ids.writer = await adopt(world.folders.a.alpha as string, 'ops-writer', 'Writer', { worktrees: true, branch: 'PROJ-0152-crew-writer' });
}, 180_000);

afterAll(async () => {
  if (world) await Promise.all([world.a.server.stop(), world.b.server.stop()]);
  await removeWorld(tmp);
});

async function machinesOf(): Promise<Record<string, string>> {
  const view = (await world.a.call('GET', `/api/team?teamId=${teamId}`)).body as TeamView;
  return Object.fromEntries(view.members.map((member) => [member.name, member.machineId]));
}

describe('D152: moving a whole crew', () => {
  it('checks every teammate first: a blocker on one stops the move before anything moves', async () => {
    const busy = path.join(path.dirname(world.paths.b.gamma), 'busy-folder');
    await mkdir(busy, { recursive: true });
    await writeFile(path.join(busy, 'mine.txt'), 'the developer’s own file\n');
    const body = { targetMachineId: world.bId, members: { [ids.tester]: { placement: { roots: [], newWorkspace: { path: busy } } } } };
    const check = await world.a.call('POST', `/api/team/teams/${teamId}/move/check`, body);
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    const result = check.body as CrewMoveCheck;
    expect(result.ok).toBe(false);
    expect(result.members.map((member) => [member.name, member.state])).toEqual([
      ['Dev', 'ready'],
      ['Tester', 'blocked'],
      ['Writer', 'ready'],
    ]);
    expect(result.members[1]?.blockers.join('\n')).toContain('exists already and is not empty');

    const refused = await world.a.call('POST', `/api/team/teams/${teamId}/move`, body);
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string; message: string }).message).toContain('Tester: ');
    expect(await machinesOf()).toEqual({ Dev: world.aId, Tester: world.aId, Writer: world.aId });
  });

  it('moves the teammates one by one; a failure stops the rest and the run says who moved and who did not', async () => {
    // The mac's gamma has a commit the pc's does not: the check cannot see it, the restore refuses it (diverged).
    await writeFile(path.join(world.paths.b.gamma, 'mac-only.txt'), 'only on the mac\n');
    await world.git(world.paths.b.gamma, 'add', '-A');
    await world.git(world.paths.b.gamma, 'commit', '-q', '-m', 'mac only');

    const check = (await world.a.call('POST', `/api/team/teams/${teamId}/move/check`, { targetMachineId: world.bId })).body as CrewMoveCheck;
    expect(check.ok, JSON.stringify(check.members.map((member) => member.blockers))).toBe(true);
    const started = await world.a.call('POST', `/api/team/teams/${teamId}/move`, { targetMachineId: world.bId });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const runId = (started.body as CrewMoveRun).id;
    const run = await waitFor('the crew move to end', async () => {
      const current = (await world.a.call('GET', `/api/team/crew-moves/${runId}`)).body as CrewMoveRun;
      return current.state === 'running' ? null : current;
    }, 180_000);
    expect(run.state, JSON.stringify(run)).toBe('failed');
    expect(run.members.map((member) => [member.name, member.state])).toEqual([
      ['Dev', 'moved'],
      ['Tester', 'failed'],
      ['Writer', 'not-moved'],
    ]);
    expect(run.members[1]?.note).toContain('has commits the original does not have');
    expect(run.error).toContain('Tester could not move');
    expect(run.error).toContain('1 moved, 1 not moved');
    // The moved one stays moved; the others run where they were.
    await waitFor('the records to follow', async () => {
      const now = await machinesOf();
      return now['Dev'] === world.bId ? now : null;
    }, 30_000);
    expect(await machinesOf()).toEqual({ Dev: world.bId, Tester: world.aId, Writer: world.aId });
    expect((await world.a.call('GET', '/api/team/crew-moves/nope')).status).toBe(404);

    // The move log (docs/peers.md → The move log): the crew move's start and outcome, and each teammate's take-over names the member and the crew move.
    const lines = world.a.server
      .output()
      .split('\n')
      .filter((line) => line.startsWith('{') && line.includes('"msg":"move:'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.find((line) => line['msg'] === 'move: crew start' && line['run'] === runId)).toMatchObject({ crew: 'Ops', crewId: teamId, members: ['Dev', 'Tester', 'Writer'] });
    expect(lines.find((line) => line['msg'] === 'move: crew failed' && line['run'] === runId)).toMatchObject({ level: 40, moved: ['Dev'], notMoved: ['Tester', 'Writer'], reason: expect.stringContaining('Tester could not move') });
    const starts = lines.filter((line) => line['msg'] === 'move: start' && line['crewRun'] === runId);
    expect(starts.map((line) => [line['member'], line['crew'], line['initiator']])).toEqual([
      ['Dev', 'Ops', 'source'],
      ['Tester', 'Ops', 'source'],
    ]);
    const testerRun = starts[1]?.['run'];
    expect(lines.find((line) => line['run'] === testerRun && line['step'] === 'outcome')).toMatchObject({ msg: 'move: failed at apply, rolled back', failedAt: 'apply' });
  });
});

describe('D152: a teammate after the ones that moved', () => {
  it('uses the workspace root an earlier teammate created and does not clone a repo an earlier one cloned', () => {
    const preview = {
      source: { repos: [{ key: 'web', remoteKey: 'example.com/acme/web' }, { key: 'api', remoteKey: 'example.com/acme/api' }] },
      target: { repos: [] },
    } as never;
    const body = { targetMachineId: 'm', placement: { roots: [], newWorkspace: { path: 'D:\\code\\ws' }, repoModes: { web: 'clone', api: 'clone' } }, clonePaths: { web: 'D:\\code\\ws\\web', api: 'D:\\code\\ws\\api' } };
    const next = crewAdjusted(body, preview, ['d:/Code/WS'], new Set(['example.com/acme/web']));
    expect(next['placement']).toEqual({ roots: [], newWorkspace: { path: 'D:\\code\\ws', useExisting: true }, repoModes: { api: 'clone' } });
    expect(next['clonePaths']).toEqual({ api: 'D:\\code\\ws\\api' });
    // Nothing made before it: unchanged.
    expect(crewAdjusted(body, preview, [], new Set())['placement']).toMatchObject({ newWorkspace: { path: 'D:\\code\\ws' }, repoModes: { web: 'clone', api: 'clone' } });
  });
});
