import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
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
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';

const PORT = 4875;
const HOST = `127.0.0.1:${PORT}`;

/**
 * D174 follow-up (2026-11-20): "the To review notification's Open changes doesn't show any
 * changes" for a crew member working in place in a WORKSPACE (a folder of several repos, no
 * declared solution), moved earlier from another computer with a conversation-only move.
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
  reviews = new ReviewService({ store: w.store, bus, systemItems: null, announce: async () => undefined });
  reviews.start();
  return { w, m: manager, bus, reviews };
}

function get(url: string) {
  if (!app) throw new Error('no app');
  return app.inject({ method: 'GET', url, headers: { host: HOST, cookie: `sb_token=${token}` } });
}

async function paths(url: string): Promise<string[]> {
  const response = await get(url);
  expect(response.statusCode, url).toBe(200);
  return (response.json() as FileDiff[]).map((f) => `${f.solution}:${f.path}`);
}

async function count(url: string): Promise<DiffCount> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const answer = (await get(url)).json() as DiffCount;
    if (!answer.stale || Date.now() > deadline) return answer;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A crew member's session: in place in the workspace, no declared solution. */
async function memberSession(w: GitWorld, name: string): Promise<string> {
  return (await w.store.sessions.create({ name, claudeSessionId: randomUUID(), solutions: [], worktrees: false, root: w.workspace, rootKind: 'workspace', cwd: w.workspace })).id;
}

async function checkpoint(w: GitWorld, sessionId: string, turn: number, top: string): Promise<void> {
  const git = new CheckpointGit({ env: w.env });
  const snapshot = await git.snapshot(top);
  const sha = await git.commit(snapshot, 'test checkpoint');
  await w.store.checkpoints.create({ sessionId, kind: 'turn', turnSeq: turn, eventId: null, groupId: randomUUID(), repoPath: snapshot.top, ref: `refs/switchboard/checkpoints/${sessionId}/${turn}`, commitSha: sha, tree: snapshot.tree, indexTree: snapshot.indexTree, head: snapshot.head, branch: snapshot.branch });
}

async function turn(w: GitWorld, bus: HubBus, service: ReviewService, sessionId: string, options: { readonly checkpointOf?: readonly string[]; readonly turnSeq: number }, work: () => Promise<void>): Promise<void> {
  for (const top of options.checkpointOf ?? []) await checkpoint(w, sessionId, options.turnSeq, top);
  await w.store.events.append({ sessionId, kind: 'text', payload: { type: 'user', text: `turn ${options.turnSeq}`, origin: 'user', delivered: true } });
  await w.store.sessions.update(sessionId, { status: 'run' });
  bus.publish('sessionUpdated', { id: sessionId, status: 'run', closedAt: null } as never);
  await work();
  await w.store.sessions.update(sessionId, { status: 'idle' });
  bus.publish('sessionUpdated', { id: sessionId, status: 'idle', closedAt: null } as never);
  await service.idle();
}

async function toolEdit(w: GitWorld, sessionId: string, written: string): Promise<void> {
  await w.store.events.append({ sessionId, kind: 'impl', label: 'Edit', payload: { type: 'tool', name: 'Edit', toolUseId: randomUUID(), input: { file_path: written, old_string: 'a', new_string: 'b' } } });
}

async function edit(w: GitWorld, sessionId: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  await toolEdit(w, sessionId, file);
}

describe('D174 follow-up · For review in a workspace', () => {
  it('a member with no declared solution edits repo B by an absolute path and commits; checkpoints only of repo A: For review lists B’s file, the count agrees', async () => {
    const { w, m, bus, reviews: service } = await setup();
    const id = await memberSession(w, 'on-call');
    // Earlier work in repo A (mobile) made A a repo the session works in (and the turn's checkpoint is taken there only).
    await turn(w, bus, service, id, { turnSeq: 1 }, async () => {
      await edit(w, id, path.join(w.mobile, 'notes.md'), '# notes\n');
    });
    expect(await service.clear(id)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await turn(w, bus, service, id, { turnSeq: 2, checkpointOf: [w.mobile] }, async () => {
      await edit(w, id, path.join(w.web, 'src', 'app.txt'), 'one\nTWO\nthree\n');
      await w.git(w.web, 'commit', '-q', '-am', 'agent: TWO');
    });
    await m.touched.idle();
    expect(readSessionReview((await w.store.sessions.get(id))?.review).pending).toMatchObject({ turns: 1, fileCount: 1 });
    expect(((await get(`/api/sessions/${id}/diff/targets`)).json() as DiffTargets).review).toBeDefined();
    expect(await paths(`/api/sessions/${id}/diff?scope=review`)).toEqual(['web-front:src/app.txt']);
    expect(await count(`/api/sessions/${id}/diff/count?scope=review`)).toEqual({ scope: 'review', files: 1 });
    expect(w.errors).toEqual([]);
  });

  it('a session moved here with a conversation-only move: its earlier edits name another computer’s paths; its new edit still shows For review', async () => {
    const { w, bus, reviews: service } = await setup();
    const id = await memberSession(w, 'moved');
    // The conversation's history from the other computer (its paths do not exist here).
    const foreign = process.platform === 'win32' ? '/Users/someone/work/web-front/src/app.txt' : 'D:\\work\\web-front\\src\\app.txt';
    await toolEdit(w, id, foreign);
    await toolEdit(w, id, process.platform === 'win32' ? '/Users/someone/work/mobile/README.md' : 'C:\\work\\mobile\\README.md');
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await turn(w, bus, service, id, { turnSeq: 1 }, async () => {
      await edit(w, id, path.join(w.web, 'src', 'app.txt'), 'one\nTWO\nthree\n');
    });
    expect(readSessionReview((await w.store.sessions.get(id))?.review).pending).toBeTruthy();
    expect(await paths(`/api/sessions/${id}/diff?scope=review`)).toEqual(['web-front:src/app.txt']);
    expect(w.errors).toEqual([]);
  });

  it('a file the agent wrote in the workspace folder itself (in no repo) is shown For review as a new file', async () => {
    const { w, bus, reviews: service } = await setup();
    const id = await memberSession(w, 'notes-writer');
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await turn(w, bus, service, id, { turnSeq: 1 }, async () => {
      await edit(w, id, path.join(w.workspace, 'reports', 'incident.md'), '# Incident\nAll good.\n');
    });
    const pending = readSessionReview((await w.store.sessions.get(id))?.review).pending;
    expect(pending).toMatchObject({ fileCount: 1 });
    const review = (await get(`/api/sessions/${id}/diff?scope=review`)).json() as FileDiff[];
    expect(review.map((f) => [f.path, f.added, f.removed])).toEqual([['reports/incident.md', 2, 0]]);
    expect(review[0]?.lines).toContain('+All good.');
    expect(await count(`/api/sessions/${id}/diff/count?scope=review`)).toEqual({ scope: 'review', files: 1 });
  });
});
