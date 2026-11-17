import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiffCount, DiffTargets, FileDiff } from '../../../src/core/api.ts';
import { readSessionReview } from '../../../src/core/review.ts';
import { buildApp } from '../../../src/server/app.ts';
import { CheckpointGit } from '../../../src/server/checkpoints/git.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { ReviewService } from '../../../src/server/review/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import type { WorktreeManager } from '../../../src/server/worktrees/manager.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type GitWorld, forbiddenGitCalls, makeGitWorld } from '../../helpers/git.ts';

const PORT = 4874; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

/**
 * D174 oracle (`docs/worktrees.md` → *For review (D174)*): the developer's report "review
 * sometimes is not showing anything after the agent is done". Root cause: a D166 review counts
 * the turn's edits, but every D90 view of an in-place session compares with HEAD (and a
 * worktree's default, Since last commit, too), so an agent that **committed** its work before its
 * turn ended left nothing to show. The `review` scope shows the review's turns from the first
 * turn's D80 checkpoint (else the last commit before it) to the files now.
 */
let world: GitWorld | undefined;
let app: FastifyInstance | undefined;
let reviews: ReviewService | undefined;
let token = '';

afterEach(async () => {
  await reviews?.stop();
  await app?.close();
  await world?.cleanup();
  reviews = undefined;
  app = undefined;
  world = undefined;
});

async function setup(): Promise<{ w: GitWorld; m: WorktreeManager; bus: HubBus; reviews: ReviewService }> {
  world = await makeGitWorld();
  const w = world;
  const manager = w.manager();
  const bus = new HubBus();
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: w.root }, platform: 'linux', home: w.root, cwd: w.root });
  await seedFolder(w.store, w.workspace);
  app = await buildApp({ config: { ...base, port: PORT }, token, store: w.store, webRoot: w.root, worktrees: manager, bus, providers: { diff: manager } });
  await app.ready();
  // D166's own service, following this bus (a turn's end raises the review).
  reviews = new ReviewService({ store: w.store, bus, systemItems: null, announce: async () => undefined });
  reviews.start();
  return { w, m: manager, bus, reviews };
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

async function count(url: string): Promise<DiffCount> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const answer = (await get(url)).json() as DiffCount;
    if (!answer.stale || Date.now() > deadline) return answer;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function sessionRow(w: GitWorld, name: string, solutions: string[], worktrees: boolean): Promise<string> {
  return (await w.store.sessions.create({ name, claudeSessionId: randomUUID(), solutions, worktrees, root: w.workspace, rootKind: 'workspace', cwd: w.workspace })).id;
}

/** A D80 turn checkpoint of `top` now (as the checkpoint service takes it before the turn's message). */
async function checkpoint(w: GitWorld, sessionId: string, turn: number, top: string): Promise<void> {
  const git = new CheckpointGit({ env: w.env });
  const snapshot = await git.snapshot(top);
  const sha = await git.commit(snapshot, 'test checkpoint');
  await w.store.checkpoints.create({ sessionId, kind: 'turn', turnSeq: turn, eventId: null, groupId: randomUUID(), repoPath: snapshot.top, ref: `refs/switchboard/checkpoints/${sessionId}/${turn}`, commitSha: sha, tree: snapshot.tree, indexTree: snapshot.indexTree, head: snapshot.head, branch: snapshot.branch });
}

/** One turn of the agent: (checkpoint), its message, `work` (its edits: tool events + files), its end (run → idle). */
async function turn(w: GitWorld, bus: HubBus, service: ReviewService, sessionId: string, options: { readonly checkpointOf?: string; readonly turnSeq: number }, work: () => Promise<void>): Promise<void> {
  if (options.checkpointOf) await checkpoint(w, sessionId, options.turnSeq, options.checkpointOf);
  await w.store.events.append({ sessionId, kind: 'text', payload: { type: 'user', text: `turn ${options.turnSeq}`, origin: 'user', delivered: true } });
  await w.store.sessions.update(sessionId, { status: 'run' });
  bus.publish('sessionUpdated', { id: sessionId, status: 'run', closedAt: null } as never);
  await work();
  await w.store.sessions.update(sessionId, { status: 'idle' });
  bus.publish('sessionUpdated', { id: sessionId, status: 'idle', closedAt: null } as never);
  await service.idle();
}

async function edit(w: GitWorld, sessionId: string, file: string, content: string): Promise<void> {
  await writeFile(file, content);
  await w.store.events.append({ sessionId, kind: 'impl', label: 'Write', payload: { type: 'tool', name: 'Write', toolUseId: randomUUID(), input: { file_path: file, content } } });
}

describe('D174 · the For review view', () => {
  it('in place: a turn that writes AND commits raises the review; every older view is empty, For review shows the file; a second turn adds to it; Mark reviewed ends it', async () => {
    const { w, m, bus, reviews: service } = await setup();
    const id = await sessionRow(w, 'review-in-place', ['mobile'], false);
    // Someone else's uncommitted edit from before: never the session's.
    await writeFile(path.join(w.mobile, 'README.md'), 'hello from the developer\n');

    await turn(w, bus, service, id, { checkpointOf: w.mobile, turnSeq: 1 }, async () => {
      await edit(w, id, path.join(w.mobile, 'src', 'app.txt'), 'one\ntwo\nthree\nfour\n');
      // The agent commits its work before its turn ends (Bash: git commit).
      await w.git(w.mobile, 'add', 'src/app.txt');
      await w.git(w.mobile, 'commit', '-q', '-m', 'agent: four');
    });
    await m.touched.idle();
    const stored = readSessionReview((await w.store.sessions.get(id))?.review).pending;
    expect(stored).toMatchObject({ turns: 1, fileCount: 1, turn: 1 });
    expect(typeof stored?.startedAt).toBe('string');

    // The report: before D174 every view was empty (all against HEAD in place).
    expect(await paths(`/api/sessions/${id}/diff?scope=head`)).toEqual([]);
    expect(await paths(`/api/sessions/${id}/diff?scope=branch`)).toEqual(['mobile:README.md']);
    // D174: For review is offered and shows the committed change (committed: not uncommitted).
    expect(((await get(`/api/sessions/${id}/diff/targets`)).json() as DiffTargets).review).toEqual({ since: stored?.since });
    const review = (await get(`/api/sessions/${id}/diff?scope=review`)).json() as FileDiff[];
    expect(review.map((f) => [f.path, f.added, f.removed, f.uncommitted])).toEqual([['src/app.txt', 1, 0, false]]);
    expect(review[0]?.lines).toContain('+four');
    expect(await count(`/api/sessions/${id}/diff/count?scope=review`)).toEqual({ scope: 'review', files: 1 });

    // A second file-changing turn (uncommitted this time) adds to the same review.
    await turn(w, bus, service, id, { checkpointOf: w.mobile, turnSeq: 2 }, async () => {
      await edit(w, id, path.join(w.mobile, 'notes.md'), '# Notes\n');
    });
    await m.touched.idle();
    expect(readSessionReview((await w.store.sessions.get(id))?.review).pending).toMatchObject({ turns: 2, fileCount: 2, turn: 1 });
    expect(await files(`/api/sessions/${id}/diff?scope=review`)).toEqual([
      { solution: 'mobile', path: 'notes.md', added: 1, removed: 0, uncommitted: true },
      { solution: 'mobile', path: 'src/app.txt', added: 1, removed: 0, uncommitted: false },
    ]);
    expect(await paths(`/api/sessions/${id}/diff?scope=review&file=notes.md`)).toEqual(['mobile:notes.md']);

    // Mark reviewed: the view is gone (the targets do not offer it; asked anyway: Since last commit).
    expect(await service.clear(id)).toBe(true);
    expect(((await get(`/api/sessions/${id}/diff/targets`)).json() as DiffTargets).review).toBeUndefined();
    expect(await paths(`/api/sessions/${id}/diff?scope=review`)).toEqual(['mobile:notes.md']);
    expect(await count(`/api/sessions/${id}/diff/count?scope=review`)).toEqual({ scope: 'head', files: 1 });
    expect(forbiddenGitCalls(await w.gitCalls())).toEqual([]);
    expect(w.errors).toEqual([]);
  });

  it('worktree: Since last commit is empty after the agent committed; For review shows the commit; the developer’s files are untouched', async () => {
    const { w, m, bus, reviews: service } = await setup();
    const id = await sessionRow(w, 'review-wt', ['web-front'], true);
    const [record] = await m.createForSession('review-wt', ['web-front'], w.folder, id);
    if (!record) throw new Error('no worktree');
    // An earlier commit on the branch (before the review): not part of it.
    await w.commit(record.path, 'src/earlier.txt', 'earlier\n', 'earlier work');
    const statusBefore = await w.git(record.path, 'status', '--porcelain');

    await turn(w, bus, service, id, { checkpointOf: record.path, turnSeq: 1 }, async () => {
      await edit(w, id, path.join(record.path, 'src', 'app.txt'), 'one\nTWO\nthree\n');
      await w.git(record.path, 'commit', '-q', '-am', 'agent: TWO');
    });
    expect(await paths(`/api/sessions/${id}/diff?scope=head`)).toEqual([]);
    expect(await paths(`/api/sessions/${id}/diff?scope=branch`)).toEqual(['web-front:src/app.txt', 'web-front:src/earlier.txt']);
    expect(await paths(`/api/sessions/${id}/diff?scope=review`)).toEqual(['web-front:src/app.txt']);
    // Reading never changed the working tree or the index.
    expect(await w.git(record.path, 'status', '--porcelain')).toBe(statusBefore);
    expect(w.errors).toEqual([]);
  });

  it('no checkpoint for the turn: the last commit before the turn started is the base (the fallback)', async () => {
    const { w, bus, reviews: service } = await setup();
    const id = await sessionRow(w, 'review-fallback', ['mobile'], false);
    await w.commit(w.mobile, 'old.txt', 'old\n', 'before the review');
    // Commit times are whole seconds (and the base is the last commit a second before the turn): the turn starts 2 s later.
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    await turn(w, bus, service, id, { turnSeq: 1 }, async () => {
      await edit(w, id, path.join(w.mobile, 'new.txt'), 'new\n');
      await w.git(w.mobile, 'add', 'new.txt');
      await w.git(w.mobile, 'commit', '-q', '-m', 'agent: new');
      await edit(w, id, path.join(w.mobile, 'src', 'app.txt'), 'changed\n');
    });
    expect(await files(`/api/sessions/${id}/diff?scope=review`)).toEqual([
      { solution: 'mobile', path: 'new.txt', added: 1, removed: 0, uncommitted: false },
      { solution: 'mobile', path: 'src/app.txt', added: 1, removed: 3, uncommitted: true },
    ]);
    expect(w.errors).toEqual([]);
  });

  it('a review stored before D174 (no turn): the newest checkpoint before its first turn ended is the base', async () => {
    const { w } = await setup();
    const id = await sessionRow(w, 'review-old', ['mobile'], false);
    await checkpoint(w, id, 1, w.mobile);
    await writeFile(path.join(w.mobile, 'agent.txt'), 'by the agent\n');
    await w.store.events.append({ sessionId: id, kind: 'impl', label: 'Write', payload: { type: 'tool', name: 'Write', toolUseId: randomUUID(), input: { file_path: path.join(w.mobile, 'agent.txt'), content: '' } } });
    await w.git(w.mobile, 'add', 'agent.txt');
    await w.git(w.mobile, 'commit', '-q', '-m', 'agent');
    await w.store.sessions.update(id, { review: { pending: { since: new Date(Date.now() + 1_000).toISOString(), turns: 1, fileCount: 1, files: ['agent.txt'] }, cursor: null } });
    expect(await paths(`/api/sessions/${id}/diff?scope=review`)).toEqual(['mobile:agent.txt']);
  });
});
