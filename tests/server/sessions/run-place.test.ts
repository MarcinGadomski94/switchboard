import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Folder, Session, SessionTodoList, TodoRunResult } from '../../../src/core/api.ts';
import type { SidebarLayout } from '../../../src/core/sidebar-layout.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeGitWorld } from '../../helpers/git.ts';
import { type SupervisorWorld, makeSupervisorWorld, until } from '../../helpers/supervisor.ts';

/**
 * D99 / D76 follow-up 2026-10-19 oracle (server, real path: fake-claude, a temp git repo, the
 * real routes and the D71 layout store): a todo's ▸ Run session goes to its source's sidebar
 * folder right after the source, a later run after the earlier ones; a root source keeps its
 * run at the root after it; a hidden Team member's run goes to the folder the member had
 * (`docs/sidebar.md` → *Where runs appear*). Plan item runs start through the same `runTodo`
 * (`tests/server/plans/integration.test.ts` covers a plan's).
 */
const PORT = 4877; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

let sw: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';

afterEach(async () => {
  await app?.close();
  await sw?.cleanup();
  app = undefined;
  sw = undefined;
});

function call(method: InjectOptions['method'], url: string, payload?: unknown) {
  if (!app) throw new Error('no app');
  return app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

async function setup(): Promise<Folder> {
  sw = await makeSupervisorWorld({ scenario: 'handoff-start' });
  const g = await makeGitWorld({ root: sw.root, workspace: sw.workspace, store: sw.store, baseEnv: sw.env });
  const repoPath = await g.makeRepo(path.join(sw.root, 'acme'));
  const worktrees = g.manager({ sessions: sw.supervisor });
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: sw.root }, platform: 'linux', home: sw.root, cwd: sw.root });
  app = await buildApp({ config: { ...base, port: PORT }, token, store: sw.store, webRoot: sw.root, supervisor: sw.supervisor, worktrees, providers: { diff: worktrees } });
  await app.ready();
  return (await call('POST', '/api/folders', { path: repoPath })).json() as Folder;
}

async function session(folder: Folder, name: string): Promise<string> {
  const started = await call('POST', '/api/sessions', { simple: true, name, title: name, task: 'Hello', folder: folder.id, worktrees: false });
  expect(started.statusCode, started.body).toBe(201);
  const id = (started.json() as Session).id;
  await until(async () => ((await sw?.store.sessions.get(id))?.status === 'done' ? true : undefined), `${name} idle`);
  return id;
}

async function folderOf(name: string, parentId: string | null = null): Promise<string> {
  const answer = await call('POST', '/api/sidebar/folders', { name, parentId });
  expect(answer.statusCode, answer.body).toBe(201);
  return ((answer.json() as SidebarLayout).folders.find((f) => f.name === name) as { id: string }).id;
}

async function place(body: Record<string, unknown>): Promise<void> {
  const answer = await call('POST', '/api/sidebar/place', body);
  expect(answer.statusCode, answer.body).toBe(200);
}

async function layout(): Promise<SidebarLayout> {
  return (await call('GET', '/api/sidebar')).json() as SidebarLayout;
}

/** Adds an item to `sourceId`'s list and runs it (▸ Run in new session); answers the run's id. */
async function run(sourceId: string, title: string): Promise<string> {
  const list = (await call('POST', `/api/sessions/${sourceId}/todos`, { title, plan: 'No plan', priority: 'high', estimateMinutes: 30 })).json() as SessionTodoList;
  const todoId = list.todos.find((todo) => todo.title === title)?.id as string;
  const answer = await call('POST', `/api/sessions/${sourceId}/todos/${todoId}/run`);
  expect(answer.statusCode, answer.body).toBe(201);
  return (answer.json() as TodoRunResult).session.id;
}

/** Waits until `folderId` holds `ids` in this order. */
async function folderHolds(folderId: string, ids: readonly string[]): Promise<void> {
  await until(async () => {
    const found = (await layout()).folders.find((f) => f.id === folderId);
    return JSON.stringify(found?.sessionIds) === JSON.stringify(ids) ? true : undefined;
  }, `folder ${folderId} holds ${ids.join(', ')}`);
}

describe('runs go to the source\'s sidebar folder (D99 / D76 follow-up 2026-10-19)', () => {
  it('a source in Acme / Releases: the run lands right after it there, a second run after the first; a later move wins', async () => {
    const folder = await setup();
    const before = await session(folder, 'before');
    const source = await session(folder, 'source');
    const after = await session(folder, 'after');
    const acme = await folderOf('Acme');
    const releases = await folderOf('Releases', acme);
    for (const id of [before, source, after]) await place({ sessionId: id, place: 'folder', folderId: releases });

    const first = await run(source, 'Ship the release notes');
    await folderHolds(releases, [before, source, first, after]);
    const second = await run(source, 'Tag the release');
    await folderHolds(releases, [before, source, first, second, after]);
    expect((await layout()).folders.find((f) => f.id === acme)?.sessionIds).toEqual([]);

    // The developer moves a run: it stays where it was put.
    await place({ sessionId: first, place: 'pinned' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await layout()).pinned).toEqual([first]);
  }, 60_000);

  it('a source at the root: the run stays at the root, right after it', async () => {
    const folder = await setup();
    const older = await session(folder, 'older');
    const source = await session(folder, 'source');
    const newer = await session(folder, 'newer');
    const runId = await run(source, 'Fix the flake');
    // The loose list as shown: the service's order (newest first), the run right after its source.
    await until(async () => {
      const loose = (await layout()).loose ?? [];
      return JSON.stringify(loose) === JSON.stringify([newer, source, runId, older]) ? true : undefined;
    }, 'the run after its source at the root');
    expect((await layout()).folders).toEqual([]);
  }, 60_000);

  it('a hidden Team member source: the run goes to the folder the member had', async () => {
    const folder = await setup();
    const other = await session(folder, 'other');
    const source = await session(folder, 'member');
    const ops = await folderOf('Ops');
    await place({ sessionId: other, place: 'folder', folderId: ops });
    await place({ sessionId: source, place: 'folder', folderId: ops, index: 0 });
    expect((await call('PUT', '/api/settings', { 'experimental.team': true })).statusCode).toBe(200);
    const adopted = await call('POST', '/api/team/members', { sessionId: source, name: 'Tracker' });
    expect(adopted.statusCode, adopted.body).toBe(201);
    // The member's session left the layout (e.g. the layout moved on elsewhere): its original place still counts.
    await place({ sessionId: source, place: 'loose' });
    expect((await layout()).folders.find((f) => f.id === ops)?.sessionIds).toEqual([other]);

    const runId = await run(source, 'Check the board');
    await folderHolds(ops, [runId, other]);
  }, 60_000);
});
