/**
 * D138 · a Project's account (`docs/accounts.md` → *Choosing the account*) on the real path
 * (fake-claude sessions, a temp git repo, the real routes, PlanService, AccountChoice): the Start
 * dialog's account is stored on the plan, every step session starts on it and the plan's own
 * session moves to it; sessions report "from project"; the overall choice leaves them alone;
 * an edit to Automatic moves them to the overall choice; 422 for another CLI's account.
 */
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Folder, Session } from '../../../src/core/api.ts';
import { type Plan, type PlanItem } from '../../../src/core/plans.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { FolderService } from '../../../src/server/folders/service.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { SystemItemService } from '../../../src/server/inbox/system-items.ts';
import { planEnvironment } from '../../../src/server/plans/environment.ts';
import { accountChoiceOf } from '../../../src/server/accounts/choice.ts';
import type { AccountChoicePreview } from '../../../src/core/api.ts';
import { PlanGit } from '../../../src/server/plans/git.ts';
import { PlanService } from '../../../src/server/plans/service.ts';
import { BranchMergeGit } from '../../../src/server/worktrees/branch-merge.ts';
import { TodoService } from '../../../src/server/todos/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import type { WorktreeManager } from '../../../src/server/worktrees/manager.ts';
import { fakeGhCommand } from '../../../tools/fake-gh/command.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';
import { type SupervisorWorld, makeSupervisorWorld, until } from '../../helpers/supervisor.ts';

const PORT = 4902; // inject() opens no socket; the port feeds the Host check only
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
      applyProjectAccounts: async (planId) => void (await accountChoiceOf(r.s.store)?.applyProject(planId)),
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

async function start(id: string, body: Record<string, unknown>) {
  return call('POST', `/api/plans/${id}/start`, { mergeMode: 'none', ...body });
}

async function sessionOf(id: string): Promise<Session> {
  const answer = (await call('GET', `/api/sessions/${id}`)).json() as { session?: Session } & Session;
  return answer.session ?? answer;
}

describe("D138 · a Project's account", () => {
  it('the Start dialog sets it: steps start on it, the plan\'s session moves to it, both say "from project"; the overall choice leaves them; Automatic follows the overall choice', async () => {
    const r = await setup();
    const work = await r.s.accounts.create({ cli: 'claude', name: 'Work' });
    const priv = await r.s.accounts.create({ cli: 'claude', name: 'Private' });
    const codex = await r.s.accounts.create({ cli: 'codex', name: 'Other' });
    await until(async () => ((await r.s.store.sessions.get(r.source.id))?.status === 'done' ? true : undefined), 'the source\'s first turn');
    const created = await makePlan(r);
    expect(created.accounts).toEqual({});
    expect((await start(created.id, { accounts: { claude: codex.id } })).statusCode).toBe(422);
    const started = await start(created.id, { accounts: { claude: work.id } });
    expect(started.statusCode, started.body).toBe(200);
    expect((started.json() as Plan).accounts).toEqual({ claude: work.id });

    const first = (await settledItem(created.id, 'PROJ-1', 'running')).runSessionId as string;
    expect((await r.s.store.sessions.get(first))?.profileId).toBe(work.id);
    await until(async () => ((await r.s.store.sessions.get(r.source.id))?.profileId === work.id ? true : undefined), "the plan's session moved");
    expect((await sessionOf(first)).accountChoice).toEqual({ source: 'project', profileId: work.id, project: { id: created.id, title: 'Acme epic' } });
    expect((await sessionOf(r.source.id)).accountChoice).toMatchObject({ source: 'project', profileId: work.id });

    // The overall choice skips the Project's sessions.
    const preview = (await call('POST', '/api/accounts/choice/preview', { cli: 'claude', profileId: priv.id })).json() as AccountChoicePreview;
    expect(preview.move).toBe(0);
    expect(preview.skipped.project).toBeGreaterThanOrEqual(2);
    expect((await call('PUT', '/api/accounts/choice', { cli: 'claude', profileId: priv.id })).json()).toMatchObject({ moving: 0 });
    expect((await r.s.store.sessions.get(first))?.profileId).toBe(work.id);

    // The Project back on Automatic (its ⋯ → Account): its live sessions follow the overall choice.
    await until(async () => ((await r.s.store.sessions.get(first))?.status !== 'run' ? true : undefined), "the step's first turn");
    const edited = await call('PUT', `/api/plans/${created.id}`, { accounts: { claude: null } });
    expect(edited.statusCode, edited.body).toBe(200);
    expect((edited.json() as Plan).accounts).toEqual({});
    await until(async () => ((await r.s.store.sessions.get(first))?.profileId === priv.id ? true : undefined), 'the step moved to the overall choice', 20_000);
    expect((await sessionOf(first)).accountChoice).toEqual({ source: 'overall', profileId: priv.id });
    expect((await call('PUT', `/api/plans/${created.id}`, { accounts: { claude: 'nope' } })).statusCode).toBe(422);
    expect(r.s.errors).toEqual([]);
  }, 90_000);
});
