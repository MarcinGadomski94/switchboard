import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiffCount, DiffTargets, FileDiff } from '../../../src/core/api.ts';
import { buildApp } from '../../../src/server/app.ts';
import { CheckpointGit } from '../../../src/server/checkpoints/git.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { isLocalOnly } from '../../../src/server/devices/local-only.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { canonicalPath, insideRelative } from '../../../src/server/worktrees/touched.ts';
import { generateToken } from '../../../src/server/token.ts';
import type { WorktreeManager } from '../../../src/server/worktrees/manager.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type GitWorld, forbiddenGitCalls, makeGitWorld } from '../../helpers/git.ts';

const PORT = 4874; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

/**
 * D90: `GET /api/sessions/{id}/diff?scope=head|branch|repo` and
 * `GET /api/sessions/{id}/diff/targets` over the real WorktreeManager and temp git
 * repos. `head` (the default) = uncommitted changes since the last commit, in place
 * only the files the session touched (its edit tools' paths; its D80 checkpoints:
 * what changed during each turn); `repo` = every uncommitted change; `branch` = the
 * behavior before D90 (a worktree against the merge-base).
 */
let world: GitWorld | undefined;
let app: FastifyInstance | undefined;
let manager: WorktreeManager | undefined;
let bus: HubBus | undefined;
let token = '';

afterEach(async () => {
  await app?.close();
  await world?.cleanup();
  app = undefined;
  world = undefined;
  manager = undefined;
  bus = undefined;
});

async function setup(): Promise<{ w: GitWorld; m: WorktreeManager; bus: HubBus }> {
  world = await makeGitWorld();
  const w = world;
  manager = w.manager();
  bus = new HubBus();
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: w.root }, platform: 'linux', home: w.root, cwd: w.root });
  await seedFolder(w.store, w.workspace);
  app = await buildApp({ config: { ...base, port: PORT }, token, store: w.store, webRoot: w.root, worktrees: manager, bus, providers: { diff: manager } });
  await app.ready();
  return { w, m: manager, bus };
}

function get(url: string) {
  if (!app) throw new Error('no app');
  return app.inject({ method: 'GET', url, headers: { host: HOST, cookie: `sb_token=${token}` } });
}

async function files(url: string): Promise<Array<Pick<FileDiff, 'solution' | 'path' | 'added' | 'removed' | 'uncommitted'>>> {
  const response = await get(url);
  expect(response.statusCode, url).toBe(200);
  return (response.json() as FileDiff[]).map(({ solution, path: file, added, removed, uncommitted }) => ({ solution, path: file, added, removed, uncommitted }));
}

async function paths(url: string): Promise<string[]> {
  return (await files(url)).map((f) => `${f.solution}:${f.path}`);
}

/** D90 ruling: the tab count's answer (`GET …/diff/count`). */
async function count(url: string): Promise<DiffCount> {
  const response = await get(url);
  expect(response.statusCode, url).toBe(200);
  return response.json() as DiffCount;
}

async function sessionRow(w: GitWorld, name: string, solutions: string[], worktrees: boolean): Promise<string> {
  return (await w.store.sessions.create({ name, claudeSessionId: randomUUID(), solutions, worktrees, root: w.workspace, rootKind: 'workspace', cwd: w.workspace })).id;
}

/** A Write / Edit tool call of the session, as the recorder stores it. */
async function toolEvent(w: GitWorld, sessionId: string, name: string, input: Record<string, unknown>): Promise<void> {
  await w.store.events.append({ sessionId, kind: 'impl', label: name, payload: { type: 'tool', name, toolUseId: randomUUID(), input } });
}

/** A D80 turn checkpoint of `top` now (the snapshot, a commit, the row; no ref needed here). */
async function checkpoint(w: GitWorld, sessionId: string, turn: number, top: string): Promise<void> {
  const git = new CheckpointGit({ env: w.env });
  const snapshot = await git.snapshot(top);
  const sha = await git.commit(snapshot, 'test checkpoint');
  await w.store.checkpoints.create({
    sessionId,
    kind: 'turn',
    turnSeq: turn,
    eventId: null,
    groupId: randomUUID(),
    repoPath: snapshot.top,
    ref: `refs/switchboard/checkpoints/${sessionId}/${turn}`,
    commitSha: sha,
    tree: snapshot.tree,
    indexTree: snapshot.indexTree,
    head: snapshot.head,
    branch: snapshot.branch,
  });
}

/** The session's status as the supervisor publishes it (`sessionUpdated`), so a turn's end is seen. */
async function setStatus(w: GitWorld, hub: HubBus, sessionId: string, status: 'run' | 'idle'): Promise<void> {
  const record = await w.store.sessions.update(sessionId, { status });
  if (!record) throw new Error('no session');
  hub.publish('sessionUpdated', { id: sessionId, status, closedAt: null } as never);
}

describe('GET /api/sessions/{id}/diff?scope= (D90)', () => {
  it('worktree session: head = only uncommitted (vs HEAD); branch = the commits too; repo = head; targets name the base and the commits', async () => {
    const { w } = await setup();
    const id = await sessionRow(w, 'scope-wt', ['web-front'], true);
    const [record] = await w.manager().createForSession('scope-wt', ['web-front'], w.folder, id);
    if (!record) throw new Error('no worktree');
    await w.commit(record.path, 'src/app.txt', 'one\nTWO\nthree\n', 'approved change');
    await writeFile(path.join(record.path, 'README.md'), 'hello\nmore\n');
    await mkdir(path.join(record.path, 'notes'));
    await writeFile(path.join(record.path, 'notes', 'new.md'), '# New\n');

    // The default is head: since the last commit, the committed app.txt is not in it.
    expect(await files(`/api/sessions/${id}/diff`)).toEqual([
      { solution: 'web-front', path: 'README.md', added: 1, removed: 0, uncommitted: true },
      { solution: 'web-front', path: 'notes/new.md', added: 1, removed: 0, uncommitted: true },
    ]);
    expect(await paths(`/api/sessions/${id}/diff?scope=head`)).toEqual(['web-front:README.md', 'web-front:notes/new.md']);
    expect(await paths(`/api/sessions/${id}/diff?scope=repo`)).toEqual(['web-front:README.md', 'web-front:notes/new.md']);
    // Whole branch: the behavior before D90 (and what the session detail's files keep).
    const branch = await files(`/api/sessions/${id}/diff?scope=branch`);
    expect(branch.map((f) => [f.path, f.uncommitted])).toEqual([
      ['README.md', true],
      ['notes/new.md', true],
      ['src/app.txt', false],
    ]);
    const detail = (await get(`/api/sessions/${id}`)).json() as { files: FileDiff[] };
    expect(detail.files.map((f) => f.path)).toEqual(['README.md', 'notes/new.md', 'src/app.txt']);
    // ?file= works in each scope.
    expect(await paths(`/api/sessions/${id}/diff?scope=branch&file=src/app.txt`)).toEqual(['web-front:src/app.txt']);
    expect(await paths(`/api/sessions/${id}/diff?scope=head&file=src/app.txt`)).toEqual([]);

    // The hunk headers are in the lines (D90).
    const readme = ((await get(`/api/sessions/${id}/diff?file=README.md`)).json() as FileDiff[])[0];
    expect(readme?.lines).toEqual(['@@ -1 +1,2 @@', ' hello', '+more']);

    const targets = (await get(`/api/sessions/${id}/diff/targets`)).json() as DiffTargets;
    expect(targets).toEqual({ worktrees: [{ solution: 'web-front', branch: 'session/scope-wt', base: 'main', commits: 1 }], inPlace: [] });
    // D90 ruling: the tab count follows the view (head by default; branch offered with a worktree; repo is not: head).
    expect(await count(`/api/sessions/${id}/diff/count`)).toEqual({ scope: 'head', files: 2 });
    expect(await count(`/api/sessions/${id}/diff/count?scope=branch`)).toEqual({ scope: 'branch', files: 3 });
    expect(await count(`/api/sessions/${id}/diff/count?scope=repo`)).toEqual({ scope: 'head', files: 2 });
    expect(forbiddenGitCalls(await w.gitCalls())).toEqual([]);
    expect(w.errors).toEqual([]);
  });

  it('in place: head = only the files the session touched (tool events); the developer\'s other edit only under repo', async () => {
    const { w } = await setup();
    const id = await sessionRow(w, 'scope-in-place', ['mobile'], false);
    // The agent edits app.txt and writes a new file (a relative path resolves against the session cwd = the workspace).
    await writeFile(path.join(w.mobile, 'src', 'app.txt'), 'one\ntwo\nthree\nfour\n');
    await toolEvent(w, id, 'Edit', { file_path: path.join(w.mobile, 'src', 'app.txt'), old_string: 'three', new_string: 'three\nfour' });
    await writeFile(path.join(w.mobile, 'agent.md'), 'by the agent\n');
    await toolEvent(w, id, 'Write', { file_path: 'mobile/agent.md', content: 'by the agent\n' });
    // Someone else changed README.md and added a file; a Read of README.md is no edit.
    await writeFile(path.join(w.mobile, 'README.md'), 'hello from the developer\n');
    await writeFile(path.join(w.mobile, 'theirs.txt'), 'not the session\n');
    await toolEvent(w, id, 'Read', { file_path: path.join(w.mobile, 'README.md') });
    // A file the session wrote outside the repo, and an edit that was undone (nothing uncommitted), do not show.
    await toolEvent(w, id, 'Write', { file_path: path.join(w.root, 'elsewhere.txt'), content: 'x' });
    await toolEvent(w, id, 'MultiEdit', { file_path: path.join(w.mobile, 'README-untouched.md'), edits: [] });

    expect(await files(`/api/sessions/${id}/diff`)).toEqual([
      { solution: 'mobile', path: 'agent.md', added: 1, removed: 0, uncommitted: true },
      { solution: 'mobile', path: 'src/app.txt', added: 1, removed: 0, uncommitted: true },
    ]);
    expect(await paths(`/api/sessions/${id}/diff?scope=repo`)).toEqual(['mobile:README.md', 'mobile:agent.md', 'mobile:src/app.txt', 'mobile:theirs.txt']);
    // In place, branch = the old behavior: every uncommitted change.
    expect(await paths(`/api/sessions/${id}/diff?scope=branch`)).toEqual(['mobile:README.md', 'mobile:agent.md', 'mobile:src/app.txt', 'mobile:theirs.txt']);
    expect((await get(`/api/sessions/${id}/diff/targets`)).json()).toEqual({ worktrees: [], inPlace: [{ solution: 'mobile', branch: 'main' }] });
    // D90 ruling: the tab count of each view (in place, Whole branch is not offered: head).
    expect(await count(`/api/sessions/${id}/diff/count`)).toEqual({ scope: 'head', files: 2 });
    expect(await count(`/api/sessions/${id}/diff/count?scope=repo`)).toEqual({ scope: 'repo', files: 4 });
    expect(await count(`/api/sessions/${id}/diff/count?scope=branch`)).toEqual({ scope: 'head', files: 2 });
    expect(w.errors).toEqual([]);
  });

  it('in place with checkpoints (D80): what changed during a turn counts (Bash-made files, deletions); edits after the turn end do not', async () => {
    const { w, m, bus: hub } = await setup();
    const id = await sessionRow(w, 'scope-checkpoints', ['mobile'], false);
    await writeFile(path.join(w.mobile, '.gitignore'), 'build/\n');
    await w.git(w.mobile, 'add', '.gitignore');
    await w.git(w.mobile, 'commit', '-q', '-m', 'ignore build');
    // A change from before the session's turn: not the session's.
    await writeFile(path.join(w.mobile, 'before.txt'), 'already there\n');

    // Turn 1 runs: the checkpoint, then "Bash" makes a file, deletes README.md and writes an ignored one.
    await checkpoint(w, id, 1, w.mobile);
    await setStatus(w, hub, id, 'run');
    await writeFile(path.join(w.mobile, 'made-by-bash.txt'), 'bash\n');
    await rm(path.join(w.mobile, 'README.md'));
    await mkdir(path.join(w.mobile, 'build'));
    await writeFile(path.join(w.mobile, 'build', 'out.js'), 'ignored\n');
    // While the turn runs, the working tree now is its end.
    expect(await paths(`/api/sessions/${id}/diff`)).toEqual(['mobile:README.md', 'mobile:made-by-bash.txt']);

    // The turn ends (run → idle): its end is snapshotted; the developer edits afterwards.
    await setStatus(w, hub, id, 'idle');
    await m.touched.idle();
    await writeFile(path.join(w.mobile, 'after.txt'), 'the developer, later\n');
    await writeFile(path.join(w.mobile, 'src', 'app.txt'), 'the developer, later\n');
    const head = await files(`/api/sessions/${id}/diff`);
    expect(head).toEqual([
      { solution: 'mobile', path: 'README.md', added: 0, removed: 1, uncommitted: true },
      { solution: 'mobile', path: 'made-by-bash.txt', added: 1, removed: 0, uncommitted: true },
    ]);
    expect(await paths(`/api/sessions/${id}/diff?scope=repo`)).toEqual(['mobile:README.md', 'mobile:after.txt', 'mobile:before.txt', 'mobile:made-by-bash.txt', 'mobile:src/app.txt']);

    // Turn 2: the next checkpoint closes turn 1 too (its end stays the snapshot); a rename by Bash = delete + add.
    await checkpoint(w, id, 2, w.mobile);
    await setStatus(w, hub, id, 'run');
    await w.git(w.mobile, 'mv', 'src/app.txt', 'src/renamed.txt');
    await setStatus(w, hub, id, 'idle');
    await m.touched.idle();
    expect(await paths(`/api/sessions/${id}/diff`)).toEqual(['mobile:README.md', 'mobile:made-by-bash.txt', 'mobile:src/app.txt', 'mobile:src/renamed.txt']);
    expect(await count(`/api/sessions/${id}/diff/count?scope=head`)).toEqual({ scope: 'head', files: 4 });
    expect(w.errors).toEqual([]);
  });

  it('after a restart (no end snapshot) the latest turn counts by its tool events only; earlier turns end at the next checkpoint', async () => {
    const { w } = await setup();
    const id = await sessionRow(w, 'scope-restart', ['mobile'], false);
    await checkpoint(w, id, 1, w.mobile);
    await writeFile(path.join(w.mobile, 'turn1.txt'), 'turn 1 by bash\n');
    await checkpoint(w, id, 2, w.mobile);
    await writeFile(path.join(w.mobile, 'turn2-bash.txt'), 'turn 2 by bash\n');
    await writeFile(path.join(w.mobile, 'turn2-write.txt'), 'turn 2 by Write\n');
    await toolEvent(w, id, 'Write', { file_path: path.join(w.mobile, 'turn2-write.txt'), content: '' });
    expect(await paths(`/api/sessions/${id}/diff`)).toEqual(['mobile:turn1.txt', 'mobile:turn2-write.txt']);
  });

  it('a bad ?scope= → 422; an unknown session → 404 on both routes', async () => {
    const { w } = await setup();
    const id = await sessionRow(w, 'scope-bad', ['mobile'], false);
    for (const bad of ['', 'all', 'HEAD']) {
      const response = await get(`/api/sessions/${id}/diff?scope=${encodeURIComponent(bad)}`);
      expect(response.statusCode, bad).toBe(422);
      expect(response.json().errors[0].field, bad).toBe('scope');
    }
    expect((await get(`/api/sessions/${id}/diff?scope=head&scope=repo`)).statusCode).toBe(422);
    expect((await get('/api/sessions/nope/diff?scope=repo')).statusCode).toBe(404);
    expect((await get('/api/sessions/nope/diff/targets')).statusCode).toBe(404);
    expect((await get(`/api/sessions/${id}/diff/count?scope=all`)).statusCode).toBe(422);
    expect((await get('/api/sessions/nope/diff/count')).statusCode).toBe(404);
  });
});

describe('D90 routes: peers and devices', () => {
  it('a peer and a paired device may read the diff with any scope and its targets', () => {
    expect(peerApiAllowed('GET', '/api/sessions/abc/diff?scope=repo')).toBe(true);
    expect(peerApiAllowed('GET', '/api/sessions/abc/diff/targets')).toBe(true);
    expect(peerApiAllowed('POST', '/api/sessions/abc/diff/targets')).toBe(false);
    expect(isLocalOnly('GET', '/api/sessions/abc/diff?scope=branch')).toBe(false);
    expect(isLocalOnly('GET', '/api/sessions/abc/diff/targets')).toBe(false);
    expect(isLocalOnly('POST', '/api/sessions/abc/diff/targets')).toBe(true);
    // D90 ruling: the tab count.
    expect(peerApiAllowed('GET', '/api/sessions/abc/diff/count?scope=branch')).toBe(true);
    expect(isLocalOnly('GET', '/api/sessions/abc/diff/count?scope=repo')).toBe(false);
    expect(isLocalOnly('DELETE', '/api/sessions/abc/diff/count')).toBe(true);
  });

  it('touched paths: a deleted file still maps into its repo; outside paths do not', async () => {
    const w = (world = await makeGitWorld());
    expect(insideRelative(w.mobile, await canonicalPath(path.join(w.mobile, 'gone', 'deep.txt')))).toBe('gone/deep.txt');
    expect(insideRelative(w.mobile, await canonicalPath(w.root))).toBeNull();
    expect(insideRelative(w.mobile, w.mobile)).toBeNull();
    expect(insideRelative(w.mobile, `${w.mobile}-other/x.txt`)).toBeNull();
  });
});
