import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Folder, Session } from '../../../src/core/api.ts';
import type { RepoCheck, SourceInspect, TakeoverPreview, TakeoverRun, TargetDirListing, TargetPlacement, TargetVerification } from '../../../src/core/takeover.ts';
import { makeTempDir } from '../../helpers/net.ts';
import { waitFor } from '../../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, startRepoSession, startWorkspaceSession, takeoverWorld } from '../../helpers/takeover.ts';

/**
 * D110 (`docs/peers.md` → *Target folders and verification*), two real
 * Switchboards (the pc "a" and the mac "b"), fake CLIs, temp repos and local bare
 * repos as the shared remotes. The mac keeps its clones at other paths and under
 * other folder names than the pc, unsaved: the verification finds them by remote
 * (found / on another branch / dirty / missing / several / a name-only hint), a
 * take-over to a chosen folder uses exactly that path, the choice is remembered,
 * the folder listing stays inside the allowed places, and a Team member moves to a
 * chosen folder too.
 */

let tmp: string;
let world: TakeoverWorld;
/** The mac's code folder (the parent of its saved `gamma`: an allowed place). */
let code: string;

beforeAll(async () => {
  tmp = await makeTempDir('takeover-target-folders');
  world = await takeoverWorld(tmp, { aRepos: { alpha: true, workspace: true }, bRepos: { gamma: true } });
  code = path.dirname(world.paths.b.gamma);
}, 120_000);

afterAll(async () => {
  if (world) await Promise.all([world.a.server.stop(), world.b.server.stop()]);
  await removeWorld(tmp);
});

async function cloneOn(remote: string, dir: string): Promise<string> {
  await mkdir(path.dirname(dir), { recursive: true });
  await world.git(path.dirname(dir), 'clone', '-q', remote, dir);
  return realpath(dir);
}

async function inspect(sessionId: string): Promise<SourceInspect> {
  const answer = await world.a.call('POST', '/api/takeover/source/inspect', { sessionId });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return (answer.body as { result: SourceInspect }).result;
}

async function verify(source: SourceInspect, placement: TargetPlacement, clonePaths?: Record<string, string>): Promise<{ verification: TargetVerification; blockers: string[] }> {
  const answer = await world.b.call('POST', '/api/takeover/target/verify', { source, placement, ...(clonePaths ? { clonePaths } : {}) });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return (answer.body as { result: { verification: TargetVerification; blockers: string[] } }).result;
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

describe('D110: the verification of the chosen folders on the target', () => {
  it('finds a repo by its remote at another path and name: found, on another branch, dirty, missing, a name-only hint, several, an override, a refused folder', async () => {
    const started = await startRepoSession(world.a, world.folders.a.alpha as string, 'verify-alpha');
    const source = await inspect(started.id);
    const key = source.repos[0]?.key as string;
    const one = (result: { verification: TargetVerification }): RepoCheck => result.verification.repos[0] as RepoCheck;

    // Found: another folder, another name, the same remote (an https / scp / case variant would match too: tests/core).
    const r1 = path.join(code, 'r1');
    const onMac = await cloneOn(world.remotes.alpha, path.join(r1, 'alpha-on-mac'));
    let result = await verify(source, { roots: [r1] });
    expect(one(result)).toMatchObject({ key, state: 'found', path: onMac, ok: true, hints: [] });
    expect(one(result).note).toContain(`Use ${onMac}; check out main`);
    expect(result.blockers).toEqual([]);

    // Another branch: still fine for a main-checkout session (it checks the session's branch out).
    await world.git(onMac, 'checkout', '-q', '-b', 'other');
    result = await verify(source, { roots: [r1] });
    expect(one(result)).toMatchObject({ state: 'differs', ok: true });
    expect(one(result).note).toContain('on other, not main');
    // Dirty: a main-checkout session cannot check its branch out there (D65's rule): ✖ with the reason.
    await writeFile(path.join(onMac, 'scratch.txt'), 'local work\n');
    result = await verify(source, { roots: [r1] });
    expect(one(result)).toMatchObject({ state: 'differs', ok: false });
    expect(one(result).note).toContain('1 uncommitted file there');
    expect(result.blockers.join('\n')).toContain('has uncommitted changes on the target');
    await rm(path.join(onMac, 'scratch.txt'));
    await world.git(onMac, 'checkout', '-q', 'main');

    // Missing: offered as a clone into the chosen folder.
    const r3 = path.join(code, 'r3');
    await mkdir(r3, { recursive: true });
    result = await verify(source, { roots: [r3] });
    expect(one(result)).toMatchObject({ state: 'missing', ok: true, cloneTo: path.join(await realpath(r3), 'alpha'), matches: [] });

    // A folder named like the repo with another remote is only a hint, never used (and its path blocks the clone there).
    const r2 = path.join(code, 'r2');
    const impostor = await cloneOn(world.remotes.gamma, path.join(r2, 'alpha'));
    result = await verify(source, { roots: [r2] });
    expect(one(result)).toMatchObject({ state: 'missing', ok: false, matches: [] });
    expect(one(result).hints).toEqual([{ path: impostor, remote: world.remotes.gamma }]);
    expect(one(result).note).toContain(`${impostor} is named like it but its remote is ${world.remotes.gamma}`);

    // Several checkouts: the developer chooses (never a guess); the pick decides.
    const r4 = path.join(code, 'r4');
    const second = await cloneOn(world.remotes.alpha, path.join(r4, 'alpha'));
    result = await verify(source, { roots: [r1, r4] });
    expect(one(result)).toMatchObject({ state: 'ambiguous', ok: false, path: null });
    expect(one(result).matches.map((match) => match.path).sort()).toEqual([onMac, second].sort());
    expect(result.blockers.join('\n')).toContain('has 2 checkouts under the chosen folders: choose which one to use');
    result = await verify(source, { roots: [r1, r4], repoPaths: { [key]: second } });
    expect(one(result)).toMatchObject({ state: 'found', path: second, ok: true });

    // An override that is not a checkout of this repo, and a folder outside the allowed places, are refused.
    result = await verify(source, { roots: [r1], repoPaths: { [key]: impostor } });
    expect(result.verification.problems.join('\n')).toContain(`${impostor} is not a checkout of alpha`);
    result = await verify(source, { roots: [path.join(tmp, 'a')] });
    expect(result.verification.problems.join('\n')).toContain('is outside the home folder and the saved folders of this machine');
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it('finds a workspace session\'s repos in the chosen workspace (group folders searched), and clones a missing one into the same layout', async () => {
    const started = await startWorkspaceSession(world.a, world.folders.a.workspace as string, 'verify-ws', ['front', 'back']);
    const source = await inspect(started.id);
    const ws = path.join(code, 'projects', 'acme-ws');
    await mkdir(ws, { recursive: true });
    await writeFile(path.join(ws, 'AGENTS.md'), '# AGENTS.md (Workspace Router)\n');
    const front = await cloneOn(world.remotes.front, path.join(ws, 'microfrontends', 'web-front'));
    const result = await verify(source, { roots: [ws] });
    const realWs = await realpath(ws);
    const byName = Object.fromEntries(result.verification.repos.map((repo) => [repo.name, repo]));
    expect(byName['front']).toMatchObject({ state: 'found', path: front, ok: true });
    expect(byName['back']).toMatchObject({ state: 'missing', ok: true, cloneTo: path.join(realWs, 'back') });
    expect(result.blockers).toEqual([]);
    // The plan places the session in that (unsaved) workspace.
    const plan = await world.b.call('POST', '/api/takeover/target/plan', { source, placement: { roots: [ws] } });
    expect((plan.body as { result: { folder: unknown; cwd: string } }).result).toMatchObject({ folder: { id: null, path: realWs, kind: 'workspace' }, cwd: realWs });
    // A non-workspace folder cannot hold a workspace session.
    const plain = await verify(source, { roots: [path.join(code, 'r3')] });
    expect(plain.blockers.join('\n')).toContain('none of the chosen folders is a workspace');
  });
});

describe('D110: a take-over into a chosen folder', () => {
  it('moves the pc session to the mac checkout at another path, saves that folder, and remembers the choice for the next move', async () => {
    const r5 = path.join(code, 'r5');
    const target = await cloneOn(world.remotes.alpha, path.join(r5, 'mac-alpha'));
    const started = await startRepoSession(world.a, world.folders.a.alpha as string, 'move-alpha');
    await world.git(world.paths.a.alpha, 'checkout', '-q', '-b', 'feature/login');
    await writeFile(path.join(world.paths.a.alpha, 'tracked.txt'), 'edited on the pc\n');

    // The preview with the chosen folder: the table, and Move allowed.
    const preview = (await world.a.call('POST', '/api/takeover/preview', { sessionId: started.id, targetMachine: world.bId, placement: { roots: [r5] } })).body as TakeoverPreview;
    expect(preview.ok, JSON.stringify(preview.blockers)).toBe(true);
    expect(preview.remembered).toBe(false);
    // On main there, the session is on feature/login: ⚠, and the move checks the branch out.
    expect(preview.target.verification?.repos[0]).toMatchObject({ state: 'differs', path: target, ok: true });

    const finished = await runOn({ sessionId: started.id, targetMachine: world.bId, placement: { roots: [r5] } });
    expect(finished.error, JSON.stringify(finished)).toBeNull();
    expect(finished.state).toBe('done');
    const created = ((await world.b.call('GET', '/api/sessions')).body as Session[]).find((session) => session.movedFrom?.sessionId === started.id) as Session;
    expect(created.cwd).toBe(target);
    expect(await world.git(target, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/login');
    expect(await world.git(target, 'status', '--porcelain')).toContain('tracked.txt');
    // The chosen checkout was not a saved folder on the mac: it is now (the session lives in it).
    const folders = (await world.b.call('GET', '/api/folders')).body as Folder[];
    expect(folders.map((folder) => folder.path)).toContain(target);

    // The next move of that pc folder to the mac starts from the same folders.
    await world.git(world.paths.a.alpha, 'checkout', '-q', '--', '.');
    const next = await startRepoSession(world.a, world.folders.a.alpha as string, 'move-again');
    const again = (await world.a.call('POST', '/api/takeover/preview', { sessionId: next.id, targetMachine: world.bId })).body as TakeoverPreview;
    expect(again.remembered).toBe(true);
    expect(again.placement).toEqual({ roots: [r5] });
    expect(again.target.placement).toEqual({ roots: [r5] });
    // `placement: null` asks for the saved folders instead.
    const saved = (await world.a.call('POST', '/api/takeover/preview', { sessionId: next.id, targetMachine: world.bId, placement: null })).body as TakeoverPreview;
    expect(saved).toMatchObject({ remembered: false, placement: null });
    expect(saved.target.verification).toBeNull();
  });
});

describe('D110: the folder listing of the target', () => {
  it('lists folders only, from the saved folders and home, and refuses anything outside them (through the peer API too)', async () => {
    await writeFile(path.join(code, 'notes.txt'), 'never listed');
    const start = await world.a.call('POST', '/api/takeover/folders', { machine: world.bId });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const places = (start.body as TargetDirListing).places;
    expect(places.map((place) => place.kind)).toEqual(expect.arrayContaining(['repo', 'home']));
    expect((start.body as TargetDirListing).machine.id).toBe(world.bId);

    const listed = await world.a.call('POST', '/api/takeover/folders', { machine: world.bId, path: code });
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const listing = listed.body as TargetDirListing;
    expect(listing.path).toBe(await realpath(code));
    expect(listing.entries.map((entry) => entry.name)).toEqual(expect.arrayContaining(['gamma', 'r1', 'projects']));
    expect(listing.entries.find((entry) => entry.name === 'gamma')).toMatchObject({ repo: true });
    expect(JSON.stringify(listing)).not.toContain('notes.txt');

    // Outside the home folder and the saved folders (and their parents): refused, whichever way it is asked.
    const outside = await world.a.call('POST', '/api/takeover/folders', { machine: world.bId, path: path.join(tmp, 'a') });
    expect(outside.status).toBe(403);
    const direct = await world.a.call('POST', `/api/machines/${world.bId}/api/takeover/target/folders`, { path: path.join(tmp, 'remotes') });
    expect(direct.status).toBe(403);
    const ok = await world.a.call('POST', `/api/machines/${world.bId}/api/takeover/target/folders`, { path: code });
    expect(ok.status).toBe(200);
    // The UI's own route is not on the peer API.
    expect((await world.a.call('POST', `/api/machines/${world.bId}/api/takeover/folders`, { path: code })).status).toBe(403);
  });
});

describe('D110: a Team member moves to a chosen folder', () => {
  it('checks and moves the member with the chosen target folder; the member runs on the mac in that checkout', async () => {
    for (const node of [world.a, world.b]) expect((await node.call('PUT', '/api/settings', { 'experimental.team': true })).status).toBe(200);
    // The pc's alpha is back on a clean main for this one.
    await world.git(world.paths.a.alpha, 'checkout', '-q', 'main');
    const r6 = path.join(code, 'r6');
    const target = await cloneOn(world.remotes.alpha, path.join(r6, 'team-alpha'));
    const session = await startRepoSession(world.a, world.folders.a.alpha as string, 'tracker-run');
    const adopted = await world.a.call('POST', '/api/team/members', { sessionId: session.id, name: 'Tracker' });
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(201);
    const memberId = (adopted.body as { id: string }).id;

    const check = await world.a.call('POST', `/api/team/members/${memberId}/move/check`, { targetMachineId: world.bId, placement: { roots: [r6] } });
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    expect(check.body.blockers).toEqual([]);
    expect((check.body.preview as TakeoverPreview).target.verification?.repos[0]).toMatchObject({ state: 'found', path: target });
    expect((await world.a.call('POST', `/api/team/members/${memberId}/move/check`, { targetMachineId: world.bId, placement: { roots: 'x' } })).status).toBe(422);

    const started = await world.a.call('POST', `/api/team/members/${memberId}/move`, { targetMachineId: world.bId, placement: { roots: [r6] } });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const runId = started.body.id as string;
    const finished = await waitFor('the move to end', async () => {
      const run = (await world.a.call('GET', `/api/team/moves/${encodeURIComponent(runId)}`)).body as { state: string; error: string | null };
      return run.state === 'running' ? null : run;
    }, 90_000);
    expect(finished, JSON.stringify(finished)).toMatchObject({ state: 'done', error: null });
    const created = ((await world.b.call('GET', '/api/sessions')).body as Session[]).find((entry) => entry.movedFrom?.sessionId === session.id) as Session;
    expect(created.cwd).toBe(target);
  });
});
