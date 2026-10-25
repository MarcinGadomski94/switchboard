/**
 * D130 · the plan's runs' sidebar subfolder on the real path (fake-claude sessions, a temp git
 * repo, the real routes, the D71 layout store, PlanService): `POST /api/plans/{id}/start` with
 * `sidebarFolder` makes (or reuses) the subfolder inside the source session's sidebar folder, the
 * source stays put and every run lands in it, also after a restart; empty / omitted = the runs
 * next to the source (D99 / D76 follow-up); a folder five levels deep refuses with 422; the
 * `plan_start` tool's `sidebar_folder`; a deleted subfolder falls back to its live parent.
 */
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Folder, Session } from '../../../src/core/api.ts';
import type { SidebarLayout } from '../../../src/core/sidebar-layout.ts';
import { type Plan, type PlanItem } from '../../../src/core/plans.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { FolderService } from '../../../src/server/folders/service.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { SystemItemService } from '../../../src/server/inbox/system-items.ts';
import { planEnvironment } from '../../../src/server/plans/environment.ts';
import { PlanGit } from '../../../src/server/plans/git.ts';
import { PlanService } from '../../../src/server/plans/service.ts';
import type { AgentApi } from '../../../src/hook/sb-mcp.ts';
import { planStart } from '../../../src/hook/sb-plan-tools.ts';
import { agentTokenFor } from '../../../src/server/todos/agent-token.ts';
import { BranchMergeGit } from '../../../src/server/worktrees/branch-merge.ts';
import { TodoService } from '../../../src/server/todos/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import type { WorktreeManager } from '../../../src/server/worktrees/manager.ts';
import { fakeGhCommand } from '../../../tools/fake-gh/command.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';
import { type SupervisorWorld, makeSupervisorWorld, until } from '../../helpers/supervisor.ts';

const PORT = 4881; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

interface Rig {
  readonly s: SupervisorWorld;
  readonly g: GitWorld;
  readonly bus: HubBus;
  readonly folder: Folder;
  readonly source: Session;
  readonly systemItems: SystemItemService;
  readonly todos: TodoService;
  readonly worktrees: WorktreeManager;
  readonly folders: FolderService;
  plans: PlanService;
}

let rig: Rig | undefined;
let app: FastifyInstance | undefined;
let token = '';

afterEach(async () => {
  await app?.close();
  await rig?.plans.close();
  await rig?.systemItems.close();
  await rig?.s.cleanup();
  app = undefined;
  rig = undefined;
});

function makePlans(r: Omit<Rig, 'plans'>): PlanService {
  return new PlanService({
    dataDir: r.s.root,
    store: r.s.store,
    bus: r.bus,
    todos: r.todos,
    git: new PlanGit({ gh: fakeGhCommand(), env: r.g.env }),
    merger: new BranchMergeGit({ gh: fakeGhCommand(), env: r.g.env }),
    env: planEnvironment({
      context: { store: r.s.store, providers: { diff: r.worktrees }, supervisor: r.s.supervisor, worktrees: r.worktrees, folders: r.folders, todos: r.todos },
      accounts: r.s.accounts,
      systemItems: r.systemItems,
      send: async (sessionId, text) => {
        await r.s.supervisor.sendMessage(sessionId, text, 'service');
      },
    }),
    pollMs: 3_600_000,
    onError: (error) => r.s.errors.push(error),
  });
}

async function setup(): Promise<Rig> {
  const s = await makeSupervisorWorld({ scenario: 'handoff-start' });
  const g = await makeGitWorld({ root: s.root, workspace: s.workspace, store: s.store, baseEnv: s.env });
  const repoPath = await g.makeRepo(path.join(s.root, 'acme'));
  const worktrees = g.manager({ sessions: s.supervisor });
  const bus = new HubBus();
  const folders = await FolderService.open({ store: s.store });
  const todos = new TodoService({ store: s.store, bus });
  const systemItems = new SystemItemService({ store: s.store, bus });
  const partial = { s, g, bus, systemItems, todos, worktrees, folders } as unknown as Rig;
  partial.plans = makePlans(partial);
  token = generateToken();
  await openApp(partial);
  await partial.plans.start();
  const folder = (await call('POST', '/api/folders', { path: repoPath })).json() as Folder;
  const started = await call('POST', '/api/sessions', { simple: true, name: 'source', title: 'Source', task: 'Hello', folder: folder.id, worktrees: false });
  expect(started.statusCode, started.body).toBe(201);
  Object.assign(partial, { folder, source: started.json() as Session });
  rig = partial;
  return partial;
}

async function openApp(r: Rig): Promise<void> {
  await app?.close();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: r.s.root }, platform: 'linux', home: r.s.root, cwd: r.s.root });
  app = await buildApp({ config: { ...base, port: PORT }, token, store: r.s.store, webRoot: r.s.root, supervisor: r.s.supervisor, worktrees: r.worktrees, providers: { diff: r.worktrees }, bus: r.bus, folders: r.folders, todos: r.todos, systemItems: r.systemItems, plans: r.plans });
  await app.ready();
}

function call(method: InjectOptions['method'], url: string, payload?: unknown) {
  if (!app) throw new Error('no app');
  return app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

function helperApi(sessionId: string): AgentApi {
  return async (method, url, body) => {
    if (!app) throw new Error('no app');
    const answer = await app.inject({
      method,
      url,
      headers: { host: HOST, 'x-switchboard-session': sessionId, authorization: `Bearer ${agentTokenFor(token, sessionId)}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    return { status: answer.statusCode, body: answer.body ? (answer.json() as unknown) : null };
  };
}

async function plan(id: string): Promise<Plan> {
  const answer = await call('GET', `/api/plans/${id}`);
  expect(answer.statusCode, answer.body).toBe(200);
  return answer.json() as Plan;
}

/** A draft plan without a target branch (merge mode none): PROJ-1, then PROJ-2 after it. */
async function makePlan(r: Rig, title = 'Acme epic'): Promise<Plan> {
  const created = await call('POST', '/api/plans', { sourceSessionId: r.source.id, title });
  expect(created.statusCode, created.body).toBe(201);
  const id = (created.json() as Plan).id;
  for (const [key, after] of [['PROJ-1', []], ['PROJ-2', ['PROJ-1']]] as const) {
    const added = await call('POST', `/api/plans/${id}/items`, { key, todo: { title: `Work ${key}`, plan: `Change ${key}.`, estimateMinutes: 20 }, after });
    expect(added.statusCode, added.body).toBe(201);
  }
  return plan(id);
}

async function settledItem(planId: string, key: string, state: PlanItem['state']): Promise<PlanItem> {
  return until(
    async () => {
      const item = (await plan(planId)).items.find((candidate) => candidate.key === key);
      return item?.state === state ? item : undefined;
    },
    `${key} ${state}`,
    20_000,
  );
}

/** The item's agent marks its todo done (a plan without a merge step) and its turn ends. */
async function agentFinishes(r: Rig, planId: string, key: string): Promise<void> {
  const item = await settledItem(planId, key, 'running');
  const runId = item.runSessionId as string;
  await until(async () => ((await r.s.store.sessions.get(runId))?.status !== 'run' ? true : undefined), `${key}'s first turn`);
  await r.todos.update(r.source.id, item.todoId, { state: 'done' }, 'agent');
  const sent = await call('POST', `/api/sessions/${runId}/messages`, { text: 'Finished.' });
  expect(sent.statusCode, sent.body).toBeLessThan(300);
  await until(async () => ((await r.s.store.sessions.get(runId))?.status !== 'run' ? true : undefined), `${key}'s last turn`);
}

async function layout(): Promise<SidebarLayout> {
  return (await call('GET', '/api/sidebar')).json() as SidebarLayout;
}

async function folderId(name: string, parentId: string | null): Promise<string> {
  const answer = await call('POST', '/api/sidebar/folders', { name, parentId });
  expect(answer.statusCode, answer.body).toBe(201);
  return ((answer.json() as SidebarLayout).folders.find((f) => f.name === name && (f.parentId ?? null) === parentId) as { id: string }).id;
}

async function placeSource(r: Rig, folder: string): Promise<void> {
  expect((await call('POST', '/api/sidebar/place', { sessionId: r.source.id, place: 'folder', folderId: folder })).statusCode).toBe(200);
}

async function holds(folder: string, ids: readonly string[]): Promise<void> {
  await until(async () => (JSON.stringify((await layout()).folders.find((f) => f.id === folder)?.sessionIds) === JSON.stringify(ids) ? true : undefined), `folder holds ${ids.join(', ')}`);
}

async function start(id: string, body: Record<string, unknown>): Promise<Plan> {
  const answer = await call('POST', `/api/plans/${id}/start`, { mergeMode: 'none', ...body });
  expect(answer.statusCode, answer.body).toBe(200);
  return answer.json() as Plan;
}

describe('D130 · the plan\'s runs\' sidebar subfolder', () => {
  it('makes the subfolder inside the source\'s folder; the source stays put; the first run lands in it, and a later run after a restart too', async () => {
    const r = await setup();
    const releases = await folderId('Releases', await folderId('Acme', null));
    await placeSource(r, releases);
    const created = await makePlan(r);
    const events: string[] = [];
    const off = r.bus.subscribe((message) => {
      if (message.name === 'sidebarLayoutChanged') events.push(message.name);
    });
    const started = await start(created.id, { sidebarFolder: '  Acme epic  ' });
    off();
    expect(events.length).toBeGreaterThan(0);
    const sub = (await layout()).folders.find((f) => f.name === 'Acme epic');
    expect(sub).toMatchObject({ parentId: releases });
    expect(started.sidebarFolder).toEqual({ id: sub?.id, name: 'Acme epic' });
    const first = (await settledItem(created.id, 'PROJ-1', 'running')).runSessionId as string;
    await holds(sub?.id as string, [first]);
    await holds(releases, [r.source.id]);
    expect((await r.s.store.sessions.get(first))?.todoLink?.sidebarFolder).toEqual({ id: sub?.id, name: 'Acme epic' });

    // A restart: the folder comes from plans.db.
    await r.plans.close();
    r.plans = makePlans(r);
    await openApp(r);
    await r.plans.start();
    expect((await plan(created.id)).sidebarFolder).toEqual({ id: sub?.id, name: 'Acme epic' });
    await agentFinishes(r, created.id, 'PROJ-1');
    const second = (await settledItem(created.id, 'PROJ-2', 'running')).runSessionId as string;
    await holds(sub?.id as string, [first, second]);
    await holds(releases, [r.source.id]);
    expect(r.s.errors).toEqual([]);
  }, 90_000);

  it('reuses a folder with that exact name at that level (no " (2)")', async () => {
    const r = await setup();
    const releases = await folderId('Releases', null);
    await placeSource(r, releases);
    const existing = await folderId('Acme epic', releases);
    const created = await makePlan(r);
    const started = await start(created.id, { sidebarFolder: 'Acme epic' });
    expect(started.sidebarFolder).toEqual({ id: existing, name: 'Acme epic' });
    expect((await layout()).folders.filter((f) => f.name.startsWith('Acme epic')).map((f) => f.id)).toEqual([existing]);
    const first = (await settledItem(created.id, 'PROJ-1', 'running')).runSessionId as string;
    await holds(existing, [first]);
  }, 60_000);

  it('empty and omitted: no subfolder, the runs go next to the source as before', async () => {
    const r = await setup();
    const releases = await folderId('Releases', null);
    await placeSource(r, releases);
    const empty = await makePlan(r, 'Empty');
    expect((await start(empty.id, { sidebarFolder: '' })).sidebarFolder).toBeNull();
    const first = (await settledItem(empty.id, 'PROJ-1', 'running')).runSessionId as string;
    await holds(releases, [r.source.id, first]);
    const omitted = await makePlan(r, 'Omitted');
    expect((await start(omitted.id, {})).sidebarFolder).toBeNull();
    const second = (await settledItem(omitted.id, 'PROJ-1', 'running')).runSessionId as string;
    await holds(releases, [r.source.id, first, second]);
    expect((await layout()).folders.map((f) => f.name)).toEqual(['Releases']);
  }, 60_000);

  it('refuses 422 on sidebarFolder when the source\'s folder is five levels deep (or the name too long); nothing changes', async () => {
    const r = await setup();
    let parent: string | null = null;
    for (const name of ['L1', 'L2', 'L3', 'L4', 'L5']) parent = await folderId(name, parent);
    await placeSource(r, parent as string);
    const created = await makePlan(r);
    for (const sidebarFolder of ['Acme epic', 'x'.repeat(61)]) {
      const refused = await call('POST', `/api/plans/${created.id}/start`, { mergeMode: 'none', sidebarFolder });
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.json()).toMatchObject({ errors: [{ field: 'sidebarFolder' }] });
    }
    expect((await plan(created.id)).state).toBe('draft');
    expect((await layout()).folders).toHaveLength(5);
  }, 60_000);

  it('plan_start with sidebar_folder; the source at the root gets a top-level subfolder', async () => {
    const r = await setup();
    const created = await makePlan(r);
    const answer = await planStart(helperApi(r.source.id), { plan_id: created.id, sidebar_folder: 'Acme epic' });
    expect(answer.isError, (answer.content[0] as { text: string }).text).toBeFalsy();
    const sub = (await layout()).folders.find((f) => f.name === 'Acme epic');
    expect(sub?.parentId ?? null).toBeNull();
    const first = (await settledItem(created.id, 'PROJ-1', 'running')).runSessionId as string;
    await holds(sub?.id as string, [first]);
  }, 60_000);

  it('a deleted subfolder: the next run lands in its nearest live parent', async () => {
    const r = await setup();
    const releases = await folderId('Releases', null);
    await placeSource(r, releases);
    const created = await makePlan(r);
    const started = await start(created.id, { sidebarFolder: 'Acme epic' });
    const sub = started.sidebarFolder?.id as string;
    const first = (await settledItem(created.id, 'PROJ-1', 'running')).runSessionId as string;
    await holds(sub, [first]);
    expect((await call('DELETE', `/api/sidebar/folders/${sub}`)).statusCode).toBe(200);
    await agentFinishes(r, created.id, 'PROJ-1');
    const second = (await settledItem(created.id, 'PROJ-2', 'running')).runSessionId as string;
    await until(async () => ((await layout()).folders.find((f) => f.id === releases)?.sessionIds.includes(second) ? true : undefined), 'the second run in Releases');
    expect((await layout()).folders.map((f) => f.name)).toEqual(['Releases']);
  }, 90_000);
});
