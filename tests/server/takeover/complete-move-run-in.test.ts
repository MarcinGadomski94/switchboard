import { readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import type { TakeoverPreview, TakeoverRun } from '../../../src/core/takeover.ts';
import { slugForCwd } from '../../../src/core/transcript.ts';
import { overwriteRows } from '../../../src/web/takeover/complete-move.ts';
import type { SessionWorksIn } from '../../../src/core/workspace-move.ts';
import { makeTempDir } from '../../helpers/net.ts';
import { waitFor } from '../../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, sessionSpawns, settle, startWorkspaceSession, takeoverWorld } from '../../helpers/takeover.ts';

/**
 * D152 follow-up (*Where it runs*, `docs/peers.md` → *Running in a carried repo*): two
 * real Switchboards, fake CLIs, real git. The pc's workspace agent works in `gamma`,
 * a repo outside its workspace root; the mac has `gamma` and no workspace at all. With
 * `placement.runIn` = gamma the move needs no workspace there: the agent continues as
 * a repo session rooted at the mac's gamma, its conversation resumed from the project
 * folder of that new cwd, and the other carried repo (`front`, cloned) is its extra folder.
 */

let tmp: string;
let world: TakeoverWorld;

beforeAll(async () => {
  tmp = await makeTempDir('takeover-run-in');
  world = await takeoverWorld(tmp, { aRepos: { workspace: true, gamma: true }, bRepos: { gamma: true } });
}, 120_000);

afterAll(async () => {
  if (world) await Promise.all([world.a.server.stop(), world.b.server.stop()]);
  await removeWorld(tmp);
});

describe('D152 follow-up: a workspace agent runs in a carried repo on the target', () => {
  it('moves with runIn = the outside repo: a repo session in that folder there, no workspace created, the same conversation resumed', async () => {
    const gamma = await realpath(world.paths.a.gamma);
    const session = await startWorkspaceSession(world.a, world.folders.a.workspace as string, 'run-in', ['front']);
    const sent = await world.a.call('POST', `/api/sessions/${session.id}/messages`, { text: `Work. [fake:tool Write ${JSON.stringify({ file_path: path.join(gamma, 'notes.txt'), content: 'x' })}]` });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    await settle(world.a, session.id);
    await waitFor('works in gamma', async () => ((await world.a.call('GET', `/api/sessions/${session.id}/works-in`)).body as SessionWorksIn).repos.some((repo) => repo.name === 'gamma'), 30_000);

    const base = { sessionId: session.id, targetMachine: world.bId };
    // Without runIn the workspace root is required (the mac has none).
    const rooted = (await world.a.call('POST', '/api/takeover/preview', { ...base, placement: { roots: [] } })).body as TakeoverPreview;
    expect(rooted.blockers.join('\n')).toMatch(/workspace folder/);

    const placement = { roots: [], runIn: { repo: gamma } };
    const preview = (await world.a.call('POST', '/api/takeover/preview', { ...base, placement })).body as TakeoverPreview;
    expect(preview.blockers).toEqual([]);
    expect(preview.target.runIn).toMatchObject({ name: 'gamma', path: world.paths.b.gamma });
    expect(preview.target.folder).toMatchObject({ kind: 'repo', path: world.paths.b.gamma });
    expect(preview.target.workspaceRoot ?? null).toBeNull();
    // A repo that is not carried is refused up front.
    const wrong = (await world.a.call('POST', '/api/takeover/preview', { ...base, placement: { roots: [], runIn: { repo: path.join(tmp, 'nowhere') } } })).body as TakeoverPreview;
    expect(wrong.blockers.join('\n')).toContain('is not one of the repos this move carries');

    const started = await world.a.call('POST', '/api/takeover', { ...base, placement });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const id = (started.body as TakeoverRun).id;
    const run = await waitFor('the take-over to end', async () => {
      const current = (await world.a.call('GET', `/api/takeover/runs/${id}`)).body as TakeoverRun;
      return current.state === 'running' ? null : current;
    }, 90_000);
    expect(run.error, JSON.stringify(run)).toBeNull();
    expect(run.state).toBe('done');

    const moved = ((await world.b.call('GET', '/api/sessions')).body as Session[]).find((entry) => entry.movedFrom?.sessionId === session.id) as Session;
    expect(moved).toMatchObject({ claudeSessionId: session.claudeSessionId, cwd: world.paths.b.gamma, folder: world.folders.b.gamma, solutions: ['gamma'] });
    // No workspace on the mac: no folder was made for one and none is saved.
    await expect(stat(world.paths.b.workspace)).rejects.toThrow();
    const folders = (await world.b.call('GET', '/api/folders')).body as Array<{ kind: string }>;
    expect(folders.some((folder) => folder.kind === 'workspace')).toBe(false);
    // The conversation sits in the project folder of the new cwd, and the spawn resumes it there.
    const transcript = path.join(world.b.configDir, 'projects', slugForCwd(world.paths.b.gamma), `${session.claudeSessionId}.jsonl`);
    expect((await stat(transcript)).size).toBeGreaterThan(0);
    const spawn = await waitFor('the resumed spawn on the mac', async () => (await sessionSpawns(world.logs.b)).find((entry) => {
      const argv = (entry['argv'] ?? []) as string[];
      return argv[argv.indexOf('--resume') + 1] === session.claudeSessionId;
    }), 20_000);
    expect(spawn?.['cwd']).toBe(world.paths.b.gamma);
    // The other carried repo (front, cloned beside gamma) is its extra folder.
    const argv = spawn?.['argv'] as string[];
    const addDirs = argv.flatMap((arg, at) => (arg === '--add-dir' ? [argv[at + 1] as string] : []));
    const front = await realpath(path.join(path.dirname(world.paths.b.gamma), 'front'));
    expect(addDirs).toEqual([front]);
    expect(await readdir(front)).toContain('.git');
  });
});

/**
 * D157 with *Where it runs*: the 2.4.26 report. The mac's gamma (outside the workspace,
 * the repo the agent runs in there) has a commit of its own on main. The preview carries
 * `targetDiverged` + `matchedPath` for gamma (the dialog's "Commits only on <PC>" needs
 * both); with `overwriteTargets` = that path the move succeeds and a backup branch keeps
 * the old tip.
 */
describe('D157 + D152 run-in: a diverged checkout of the outside repo the agent runs in', () => {
  let tmp2: string;
  let world2: TakeoverWorld;
  let onMac: string;
  let macTip: string;

  beforeAll(async () => {
    tmp2 = await makeTempDir('takeover-run-in-overwrite');
    world2 = await takeoverWorld(tmp2, { aRepos: { workspace: true, gamma: true }, bRepos: { workspace: true, gamma: true } });
    onMac = world2.paths.b.gamma;
    await writeFile(path.join(onMac, 'mac-only.txt'), 'only on the mac\n');
    await world2.git(onMac, 'add', 'mac-only.txt');
    await world2.git(onMac, 'commit', '-q', '-m', 'mac only work');
    macTip = await world2.git(onMac, 'rev-parse', 'main');
  }, 120_000);

  afterAll(async () => {
    if (world2) await Promise.all([world2.a.server.stop(), world2.b.server.stop()]);
    if (tmp2) await removeWorld(tmp2);
  });

  it('the preview lists the overwrite choice for the run-in repo; with the tick the move succeeds and keeps a backup', async () => {
    const gamma = await realpath(world2.paths.a.gamma);
    const session = await startWorkspaceSession(world2.a, world2.folders.a.workspace as string, 'run-in-ow', ['front']);
    const sent = await world2.a.call('POST', `/api/sessions/${session.id}/messages`, { text: `Work. [fake:tool Write ${JSON.stringify({ file_path: path.join(gamma, 'notes.txt'), content: 'x' })}]` });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    await settle(world2.a, session.id);
    await waitFor('works in gamma', async () => ((await world2.a.call('GET', `/api/sessions/${session.id}/works-in`)).body as SessionWorksIn).repos.some((repo) => repo.name === 'gamma'), 30_000);

    // "Use a folder there" for gamma (the default), gamma is where it runs, the mac's workspace chosen as before.
    const placement = { roots: [world2.paths.b.workspace], runIn: { repo: gamma }, outsideCarry: { gamma: true } };
    const base = { sessionId: session.id, targetMachine: world2.bId, placement };
    const blocked = (await world2.a.call('POST', '/api/takeover/preview', base)).body as TakeoverPreview;
    expect(blocked.ok).toBe(false);
    expect(blocked.blockers.join('\n')).toContain('Overwrite them on mac-laptop (keep a backup branch)');
    const row = blocked.target.repos.find((repo) => repo.name === 'gamma');
    expect(row, JSON.stringify(blocked.target.repos)).toMatchObject({ action: 'blocked', matchedPath: onMac, targetDiverged: { branch: 'main', count: 1 } });
    // The dialog's "Commits only on <PC>" section reads exactly this: one row, its path the one the target compares.
    expect(overwriteRows(blocked, { placement: blocked.placement, clonePaths: {}, files: null }).map((entry) => [entry.path, entry.confirmed])).toEqual([[onMac, false]]);

    const ticked = (await world2.a.call('POST', '/api/takeover/preview', { ...base, overwriteTargets: [onMac] })).body as TakeoverPreview;
    expect(ticked.blockers, JSON.stringify(ticked.blockers)).toEqual([]);
    expect(ticked.target.repos.find((repo) => repo.name === 'gamma')).toMatchObject({ action: 'use', overwrite: true, matchedPath: onMac });

    const started = await world2.a.call('POST', '/api/takeover', { ...base, overwriteTargets: [onMac] });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const id = (started.body as TakeoverRun).id;
    const run = await waitFor('the take-over to end', async () => {
      const current = (await world2.a.call('GET', `/api/takeover/runs/${id}`)).body as TakeoverRun;
      return current.state === 'running' ? null : current;
    }, 90_000);
    expect(run.error, JSON.stringify(run)).toBeNull();
    expect(run.state).toBe('done');
    const pcTip = await world2.git(world2.paths.a.gamma, 'rev-parse', 'main');
    expect(await world2.git(onMac, 'rev-parse', 'main')).toBe(pcTip);
    const backup = run.overwrites?.[0]?.backup as string;
    expect(backup).toMatch(/^switchboard\/backup\/main-/);
    expect(await world2.git(onMac, 'rev-parse', backup)).toBe(macTip);
  });
});
