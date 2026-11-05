import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import type { SourceRepo, TakeoverPreview, TakeoverRun } from '../../../src/core/takeover.ts';
import type { SessionWorksIn } from '../../../src/core/workspace-move.ts';
import { makeTempDir } from '../../helpers/net.ts';
import { waitFor } from '../../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, sessionSpawns, settle, startWorkspaceSession, takeoverWorld } from '../../helpers/takeover.ts';

/**
 * D152 follow-up 2026-11-05 (the 2.4.23 report; `docs/peers.md` → *Repos outside the
 * workspace*): two real Switchboards (the pc "a" and the mac "b"), fake CLIs, real git.
 * The pc's workspace agent also works in `gamma`, a repo **outside** its workspace
 * root. The move lists it as outside (carried by default when the agent edited there
 * or ran most of its commands there), clones it into a folder picked on the mac or
 * uses the mac's checkout of the same remote, and the moved session gets its folder
 * as an extra folder (`--add-dir`) on every spawn. A git repo named `.claude` the
 * agent wrote into never shows up as a repo, and leaving the outside repo out works.
 */

let tmp: string;
let world: TakeoverWorld;
/** A `~/.claude` kept in git on the pc (the agent wrote a memory note into it). */
let dotClaude: string;

beforeAll(async () => {
  tmp = await makeTempDir('takeover-outside');
  world = await takeoverWorld(tmp, { aRepos: { workspace: true, gamma: true }, bRepos: { workspace: true, gamma: true } });
  dotClaude = path.join(tmp, 'a', 'home', '.claude');
  await mkdir(dotClaude, { recursive: true });
  await world.git(dotClaude, 'init', '-q', '-b', 'main');
  dotClaude = await realpath(dotClaude);
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

/** Plays tool calls in the pc's session (the fake CLI records them; nothing is written). */
async function tools(sessionId: string, calls: ReadonlyArray<readonly [string, Record<string, unknown>]>): Promise<void> {
  for (const [name, input] of calls) {
    const sent = await world.a.call('POST', `/api/sessions/${sessionId}/messages`, { text: `Work. [fake:tool ${name} ${JSON.stringify(input)}]` });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    await settle(world.a, sessionId);
  }
}

async function worksIn(sessionId: string, until: (answer: SessionWorksIn) => boolean): Promise<SessionWorksIn> {
  return waitFor('works in', async () => {
    const answer = (await world.a.call('GET', `/api/sessions/${sessionId}/works-in`)).body as SessionWorksIn;
    return until(answer) ? answer : null;
  }, 30_000);
}

function gammaOf(repos: readonly SourceRepo[]): SourceRepo | undefined {
  return repos.find((repo) => repo.name === 'gamma');
}

async function movedOnMac(sessionId: string): Promise<Session> {
  return ((await world.b.call('GET', '/api/sessions')).body as Session[]).find((entry) => entry.movedFrom?.sessionId === sessionId) as Session;
}

/** The `--add-dir` folders of the mac's newest spawn of `session` (`--resume <its conversation>`), once there is one. */
async function addDirsOf(session: Session, after = 0): Promise<string[]> {
  const argv = await waitFor('the spawn on the mac', async () => {
    const spawns = (await sessionSpawns(world.logs.b)).slice(after).map((entry) => (entry['argv'] ?? []) as string[]);
    const mine = spawns.filter((args) => args[args.indexOf('--resume') + 1] === session.claudeSessionId);
    return mine.length > 0 ? (mine[mine.length - 1] as string[]) : null;
  }, 20_000);
  return argv.flatMap((arg, at) => (arg === '--add-dir' ? [argv[at + 1] as string] : []));
}

describe('D152 follow-up: a repo outside the workspace root', () => {
  it('an outside repo the agent edited in is listed under outside, carried by default, cloned into a folder picked on the target; the moved session can work there, also after a resume; `.claude` never appears', async () => {
    const gamma = await realpath(world.paths.a.gamma);
    const session = await startWorkspaceSession(world.a, world.folders.a.workspace as string, 'out-edit', ['front']);
    await tools(session.id, [
      ['Write', { file_path: path.join(gamma, 'notes.txt'), content: 'x' }],
      ['Write', { file_path: path.join(dotClaude, 'memory.md'), content: 'x' }],
      ['Read', { file_path: path.join(world.paths.a.workspace, '.claude', 'settings.local.json') }],
    ]);
    const answer = await worksIn(session.id, (now) => now.repos.some((repo) => repo.name === 'gamma'));
    expect(answer.repos.map((repo) => repo.name).sort()).toEqual(['front', 'gamma']);
    expect(JSON.stringify(answer)).not.toContain('.claude');

    const picked = path.join(path.dirname(world.paths.b.gamma), 'picked', 'gamma-copy');
    const base = { sessionId: session.id, targetMachine: world.bId };
    const placement = { roots: [world.paths.b.workspace], repoModes: { gamma: 'clone' } };
    // Default: carried, cloned beside the workspace (never inside it).
    const suggested = await preview({ ...base, placement });
    const source = gammaOf(suggested.source.repos);
    expect(source).toMatchObject({ outside: true, carry: true, found: 'edited', path: gamma });
    expect(suggested.source.repos.map((repo) => repo.name)).not.toContain('.claude');
    expect(suggested.source.blockers).toEqual([]);
    expect(suggested.target.repos.find((repo) => repo.name === 'gamma')).toMatchObject({ action: 'clone', cloneTo: path.join(path.dirname(world.paths.b.workspace), 'gamma') });
    expect(suggested.target.repos.find((repo) => repo.name === 'front')).toMatchObject({ action: 'use', matchedPath: world.paths.b.front });
    expect(suggested.excluded).toEqual([]);

    // The developer picks the folder: shown before Move.
    const ready = await preview({ ...base, placement, clonePaths: { gamma: picked } });
    expect(ready.blockers).toEqual([]);
    expect(ready.target.repos.find((repo) => repo.name === 'gamma')).toMatchObject({ action: 'clone', cloneTo: picked });

    const run = await runOn({ ...base, placement, clonePaths: { gamma: picked } });
    expect(run.error, JSON.stringify(run)).toBeNull();
    expect(run.state).toBe('done');
    expect(await world.git(picked, 'remote', 'get-url', 'origin')).toBe(world.remotes.gamma);
    const moved = await movedOnMac(session.id);
    expect(moved.cwd).toBe(world.paths.b.workspace);
    const real = await realpath(picked);
    expect(await addDirsOf(moved)).toEqual([real]);

    // A later resume keeps it.
    await settle(world.b, moved.id);
    expect((await world.b.call('POST', `/api/sessions/${moved.id}/pause`)).status).toBeLessThan(300);
    await waitFor('paused', async () => !((await world.b.call('GET', `/api/sessions/${moved.id}`)).body as Session).live);
    const before = (await sessionSpawns(world.logs.b)).length;
    expect((await world.b.call('POST', `/api/sessions/${moved.id}/resume`)).status).toBeLessThan(300);
    expect(await addDirsOf(moved, before)).toEqual([real]);

    // Remembered: the clone is used from its folder next time.
    const next = await startWorkspaceSession(world.a, world.folders.a.workspace as string, 'out-edit-2', ['front']);
    const again = await preview({ sessionId: next.id, targetMachine: world.bId });
    expect(again.remembered).toBe(true);
    expect(again.placement?.repoPaths).toEqual({ gamma: real });
  });

  it('an outside repo most of its commands ran in is mapped to the target’s checkout of the same remote', async () => {
    const gamma = await realpath(world.paths.a.gamma);
    const session = await startWorkspaceSession(world.a, world.folders.a.workspace as string, 'out-use', ['front']);
    await tools(session.id, [
      ['Bash', { command: `cd "${gamma}" && git status --short` }],
      ['Bash', { command: `git -C "${gamma}" log --oneline -3` }],
    ]);
    await worksIn(session.id, (now) => now.repos.some((repo) => repo.name === 'gamma'));
    // The mac has two checkouts of gamma now (its saved one, and the clone the test above made beside the workspace): the developer picks.
    const several = await preview({ sessionId: session.id, targetMachine: world.bId, placement: { roots: [world.paths.b.workspace] } });
    expect(gammaOf(several.source.repos)).toMatchObject({ outside: true, carry: true, found: 'commands' });
    expect(several.blockers).toEqual(['gamma has 2 checkouts under the chosen folders: choose which one to use']);
    expect(several.target.verification?.repos.find((repo) => repo.name === 'gamma')?.matches.map((match) => match.path)).toContain(world.paths.b.gamma);
    const base = { sessionId: session.id, targetMachine: world.bId, placement: { roots: [world.paths.b.workspace], repoPaths: { gamma: world.paths.b.gamma } } };
    const ready = await preview(base);
    expect(ready.blockers).toEqual([]);
    expect(ready.target.repos.find((repo) => repo.name === 'gamma')).toMatchObject({ action: 'use', matchedPath: world.paths.b.gamma });

    const run = await runOn(base);
    expect(run.error, JSON.stringify(run)).toBeNull();
    expect(run.state).toBe('done');
    expect(await addDirsOf(await movedOnMac(session.id))).toEqual([world.paths.b.gamma]);
  });

  it('an outside repo it ran only a few commands in is left out by default; the developer can carry it, or leave an edited one out', async () => {
    const gamma = await realpath(world.paths.a.gamma);
    const session = await startWorkspaceSession(world.a, world.folders.a.workspace as string, 'out-leave', []);
    await tools(session.id, [
      ['Bash', { command: `cd "${world.paths.a.front}" && npm test` }],
      ['Bash', { command: `cd "${world.paths.a.front}" && npm run lint` }],
      ['Bash', { command: `cd "${gamma}" && ls` }],
    ]);
    await worksIn(session.id, (now) => now.repos.some((repo) => repo.name === 'gamma'));
    const roots = [world.paths.b.workspace];
    const left = await preview({ sessionId: session.id, targetMachine: world.bId, placement: { roots } });
    expect(gammaOf(left.source.repos)).toMatchObject({ outside: true, carry: false });
    expect(left.target.repos.map((repo) => repo.name)).toEqual(['front']);
    expect(left.excluded).toEqual([gamma]);
    expect(left.blockers).toEqual([]);
    // Carried on the developer's say.
    const carried = await preview({ sessionId: session.id, targetMachine: world.bId, placement: { roots, outsideCarry: { gamma: true } } });
    expect(carried.target.repos.map((repo) => repo.name).sort()).toEqual(['front', 'gamma']);
    expect(carried.excluded).toEqual([]);
    // An edited one left out.
    const edited = await startWorkspaceSession(world.a, world.folders.a.workspace as string, 'out-leave-2', ['front']);
    await tools(edited.id, [['Write', { file_path: path.join(gamma, 'x.txt'), content: 'x' }]]);
    await worksIn(edited.id, (now) => now.repos.some((repo) => repo.name === 'gamma'));
    const out = await preview({ sessionId: edited.id, targetMachine: world.bId, placement: { roots, outsideCarry: { gamma: false } } });
    expect(gammaOf(out.source.repos)?.carry).toBe(true);
    expect(out.target.repos.map((repo) => repo.name)).toEqual(['front']);
    expect(out.excluded).toEqual([gamma]);
    expect(out.blockers).toEqual([]);
  });

  it('the 2.4.23 report: solutions named after the outside repo and `.claude` no longer block ("no git repository for … in the workspace")', async () => {
    const gamma = await realpath(world.paths.a.gamma);
    const session = await startWorkspaceSession(world.a, world.folders.a.workspace as string, 'out-named', ['front', 'gamma', '.claude']);
    await tools(session.id, [['Write', { file_path: path.join(gamma, 'named.txt'), content: 'x' }]]);
    await worksIn(session.id, (now) => now.repos.some((repo) => repo.name === 'gamma'));
    const answer = await preview({ sessionId: session.id, targetMachine: world.bId, placement: { roots: [world.paths.b.workspace], repoPaths: { gamma: world.paths.b.gamma } } });
    expect(answer.source.blockers).toEqual([]);
    expect(answer.blockers.join('\n')).not.toContain('no git repository');
    expect(answer.source.repos.map((repo) => [repo.name, repo.outside === true]).sort()).toEqual([
      ['front', false],
      ['gamma', true],
    ]);
  });

  it('a workspace agent needs its workspace root on the target, also when only an outside repo is carried: the blocker says where to choose it', async () => {
    const session = await startWorkspaceSession(world.a, world.folders.a.workspace as string, 'out-noroot', ['front']);
    const answer = await preview({ sessionId: session.id, targetMachine: world.bId, placement: { roots: [path.dirname(world.paths.b.gamma)] } });
    expect(answer.blockers.join('\n')).toContain('in "Workspace on mac-laptop" choose "A folder that is there"');
    expect(answer.blockers.join('\n')).toContain('also when you carry only repos outside it');
  });
});
