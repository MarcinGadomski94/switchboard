/**
 * D99 · Plans on the real path: fake-claude sessions, temp git repos, the real worktree
 * manager, TodoService, ReviewService, SystemItemService and PlanService (its real git / gh
 * adapter with the fake gh), driven through the REST API. The test plays the agents: it
 * commits in an item's worktree, merges into the target branch (agent modes) or Merges the
 * Review card (the developer), then sends the session a message so its turn ends.
 */
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Folder, Session } from '../../../src/core/api.ts';
import { PLANS_SETTING, type Plan, type PlanItem, type PlanMergeMode } from '../../../src/core/plans.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { FolderService } from '../../../src/server/folders/service.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { SystemItemService } from '../../../src/server/inbox/system-items.ts';
import { planEnvironment } from '../../../src/server/plans/environment.ts';
import { PlanGit } from '../../../src/server/plans/git.ts';
import { PlanService } from '../../../src/server/plans/service.ts';
import { ReviewGit } from '../../../src/server/reviews/git.ts';
import { ReviewService } from '../../../src/server/reviews/service.ts';
import { TodoService } from '../../../src/server/todos/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import type { WorktreeManager } from '../../../src/server/worktrees/manager.ts';
import { fakeGhCommand } from '../../../tools/fake-gh/command.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';
import { type SupervisorWorld, makeSupervisorWorld, until } from '../../helpers/supervisor.ts';

const PORT = 4879; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;
const TARGET = 'feature/PROJ-100-acme-epic';

interface Rig {
  readonly s: SupervisorWorld;
  readonly g: GitWorld;
  readonly bus: HubBus;
  readonly repoPath: string;
  readonly folder: Folder;
  readonly source: Session;
  readonly reviews: ReviewService;
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
  await rig?.reviews.stop();
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

async function setup(options: { origin?: boolean } = {}): Promise<Rig> {
  const s = await makeSupervisorWorld({ scenario: 'handoff-start' });
  await s.store.settings.set(PLANS_SETTING, true);
  const g = await makeGitWorld({ root: s.root, workspace: s.workspace, store: s.store, baseEnv: s.env });
  const repoPath = await g.makeRepo(path.join(s.root, 'acme'));
  if (options.origin) await g.addOrigin(repoPath);
  const worktrees = g.manager({ sessions: s.supervisor });
  const bus = new HubBus();
  const folders = await FolderService.open({ store: s.store });
  const todos = new TodoService({ store: s.store, bus });
  const systemItems = new SystemItemService({ store: s.store, bus });
  const reviews = new ReviewService({
    store: s.store,
    bus,
    git: new ReviewGit({ gh: fakeGhCommand(), env: g.env }),
    repos: (session) => worktrees.repos.of(session),
    enabled: async () => true,
    send: async () => undefined,
    onError: (error) => s.errors.push(error),
  });
  reviews.start();
  const partial = { s, g, bus, repoPath, reviews, systemItems, todos, worktrees, folders } as unknown as Rig;
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

/** The app over the rig's services (again after a restart: its routes are the current plan service's). */
async function openApp(r: Rig): Promise<void> {
  await app?.close();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: r.s.root }, platform: 'linux', home: r.s.root, cwd: r.s.root });
  app = await buildApp({ config: { ...base, port: PORT }, token, store: r.s.store, webRoot: r.s.root, supervisor: r.s.supervisor, worktrees: r.worktrees, providers: { diff: r.worktrees }, bus: r.bus, reviews: r.reviews, folders: r.folders, todos: r.todos, systemItems: r.systemItems, plans: r.plans });
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

async function itemOf(planId: string, key: string): Promise<PlanItem> {
  const found = (await plan(planId)).items.find((item) => item.key === key);
  if (!found) throw new Error(`no item ${key}`);
  return found;
}

/** A draft plan in the source session with the given items (`key` → after keys). */
async function makePlan(r: Rig, items: Record<string, readonly string[]>, extra: Record<string, unknown> = {}, holds: readonly string[] = []): Promise<Plan> {
  const created = await call('POST', '/api/plans', { sourceSessionId: r.source.id, title: 'Acme epic', targetBranch: TARGET, baseBranch: 'main', ...extra });
  expect(created.statusCode, created.body).toBe(201);
  const id = (created.json() as Plan).id;
  for (const [key, after] of Object.entries(items)) {
    const added = await call('POST', `/api/plans/${id}/items`, { key, todo: { title: `Work ${key}`, plan: `Change ${key}. Acceptance: ${key}.txt exists.`, estimateMinutes: 20 }, after, hold: holds.includes(key) });
    expect(added.statusCode, added.body).toBe(201);
  }
  return plan(id);
}

async function startPlan(id: string, mergeMode: PlanMergeMode): Promise<Plan> {
  const answer = await call('POST', `/api/plans/${id}/start`, { mergeMode });
  expect(answer.statusCode, answer.body).toBe(200);
  return answer.json() as Plan;
}

/** Waits for the item to be in `state`. */
async function settledItem(planId: string, key: string, state: PlanItem['state'], timeoutMs = 20_000): Promise<PlanItem> {
  return until(
    async () => {
      const item = await itemOf(planId, key);
      return item.state === state ? item : undefined;
    },
    `${key} ${state}`,
    timeoutMs,
  );
}

async function runSession(item: PlanItem): Promise<{ id: string; cwd: string }> {
  const record = await rig!.s.store.sessions.get(item.runSessionId as string);
  if (!record?.cwd) throw new Error('no run session');
  return { id: record.id, cwd: record.cwd };
}

/** The target branch checked out in a scratch worktree (where the "agents" merge). */
async function targetCheckout(r: Rig): Promise<string> {
  const dir = path.join(r.s.root, 'target-checkout');
  try {
    await access(dir);
  } catch {
    await mkdir(path.dirname(dir), { recursive: true });
    await r.g.git(r.repoPath, 'worktree', 'add', '-q', dir, TARGET);
  }
  return dir;
}

/** The item's agent: a commit in its worktree; in agent modes it merges into the target; its turn ends. */
async function agentWorks(r: Rig, planId: string, key: string, options: { merge: boolean; file?: string; content?: string }): Promise<void> {
  const item = await settledItem(planId, key, 'running');
  const run = await runSession(item);
  // The run session's first turn (the brief) is over before the agent's "work" lands.
  await until(async () => ((await r.s.store.sessions.get(run.id))?.status !== 'run' ? true : undefined), `${key}'s first turn`);
  await r.g.commit(run.cwd, options.file ?? `${key}.txt`, options.content ?? `${key}\n`, `${key}: work`);
  if (options.merge) await r.g.git(await targetCheckout(r), 'merge', '-q', '--no-edit', item.branch as string);
  const sent = await call('POST', `/api/sessions/${run.id}/messages`, { text: 'Finished.' });
  expect(sent.statusCode, sent.body).toBeLessThan(300);
}

/** The developer Merges the item's Review card. */
async function developerMerges(r: Rig, planId: string, key: string): Promise<void> {
  const item = await itemOf(planId, key);
  const card = await r.reviews.evaluate(item.runSessionId as string);
  expect(card, `${key}'s review card`).toMatchObject({ state: 'pending' });
  await r.reviews.act(card!.id, 'merge', {});
}

async function runningKeys(planId: string): Promise<string[]> {
  return (await plan(planId)).items.filter((item) => item.state === 'running' || item.state === 'review').map((item) => item.key as string);
}

describe('D99 · a plan on the real path', () => {
  for (const mode of ['agents', 'agents-with-holds', 'developer'] as const) {
    it(`A → B, A → C, B + C → D in ${mode} mode: A, then B ∥ C, then D; the plan ends with "Plan ready"`, async () => {
      const r = await setup();
      const created = await makePlan(r, { 'PROJ-1': [], 'PROJ-2': ['PROJ-1'], 'PROJ-3': ['PROJ-1'], 'PROJ-4': ['PROJ-2', 'PROJ-3'] });
      await startPlan(created.id, mode);
      const finish = async (key: string): Promise<void> => {
        await agentWorks(r, created.id, key, { merge: mode !== 'developer' });
        if (mode === 'developer') {
          await settledItem(created.id, key, 'review');
          await developerMerges(r, created.id, key);
        }
        await settledItem(created.id, key, 'done');
      };
      await settledItem(created.id, 'PROJ-1', 'running');
      expect(await runningKeys(created.id)).toEqual(['PROJ-1']);
      // The run: its own worktree on PROJ-1-<slug>, cut from the target branch.
      const first = await itemOf(created.id, 'PROJ-1');
      expect(first.branch).toBe('PROJ-1-work-proj-1');
      expect(await r.g.git(r.repoPath, 'rev-parse', TARGET)).toBe(await r.g.git(r.repoPath, 'rev-parse', 'main'));
      await finish('PROJ-1');
      await until(async () => ((await runningKeys(created.id)).length === 2 ? true : undefined), 'B and C running');
      expect(await runningKeys(created.id)).toEqual(['PROJ-2', 'PROJ-3']);
      expect((await itemOf(created.id, 'PROJ-4')).state).toBe('waiting');
      await finish('PROJ-2');
      expect((await itemOf(created.id, 'PROJ-4')).state).toBe('waiting');
      await finish('PROJ-3');
      await finish('PROJ-4');
      await until(async () => ((await plan(created.id)).state === 'done' ? true : undefined), 'the plan done');
      for (const key of ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4']) expect(await r.g.git(r.repoPath, 'show', `${TARGET}:${key}.txt`)).toBe(key);
      const ready = (await r.s.store.systemItems.list(['open'])).filter((item) => item.kind === 'plan-ready');
      expect(ready.map((item) => item.title)).toEqual([`Plan ready: ${TARGET} → main`]);
      expect(r.s.errors).toEqual([]);
    }, 120_000);
  }

  it('agents-with-holds: a held item waits for the developer’s Merge', async () => {
    const r = await setup();
    const created = await makePlan(r, { 'PROJ-1': [], 'PROJ-2': ['PROJ-1'] }, {}, ['PROJ-1']);
    await startPlan(created.id, 'agents-with-holds');
    await agentWorks(r, created.id, 'PROJ-1', { merge: false });
    await settledItem(created.id, 'PROJ-1', 'review');
    expect((await itemOf(created.id, 'PROJ-2')).state).toBe('waiting');
    await developerMerges(r, created.id, 'PROJ-1');
    await settledItem(created.id, 'PROJ-1', 'done');
    await settledItem(created.id, 'PROJ-2', 'running');
  }, 60_000);

  it('keeps to the concurrency limit, and holds new starts while the account is above the usage threshold', async () => {
    const r = await setup();
    // The source's first turn reports its own (low) reading: the high one comes after it.
    await until(async () => ((await r.s.store.sessions.get(r.source.id))?.status !== 'run' ? true : undefined), "the source's first turn");
    await r.s.store.usage.add({ source: 'get_usage', fiveHourPct: 91, sevenDayPct: 40, profileId: 'default-claude' });
    const created = await makePlan(r, { 'PROJ-1': [], 'PROJ-2': [], 'PROJ-3': [] }, { maxConcurrency: 2 });
    const started = await startPlan(created.id, 'agents');
    await r.plans.idle();
    expect((await plan(created.id)).held).toMatch(/at 91% of its 5-hour limit/);
    expect(await runningKeys(created.id)).toEqual([]);
    expect(started.items.map((item) => item.state)).toEqual(['ready', 'ready', 'ready']);
    // The reading drops; a usage update (`system`) lets the plan go on, two at a time.
    await r.s.store.usage.add({ source: 'get_usage', fiveHourPct: 20, sevenDayPct: 40, profileId: 'default-claude' });
    r.bus.publish('system', {} as never);
    await until(async () => ((await runningKeys(created.id)).length === 2 ? true : undefined), 'two running');
    expect((await plan(created.id)).held).toBeNull();
    expect((await itemOf(created.id, 'PROJ-3')).state).toBe('ready');
    await agentWorks(r, created.id, 'PROJ-1', { merge: true });
    await settledItem(created.id, 'PROJ-1', 'done');
    await settledItem(created.id, 'PROJ-3', 'running');
  }, 60_000);

  it('a discarded item blocks its dependents with a reason', async () => {
    const r = await setup();
    const created = await makePlan(r, { 'PROJ-1': [], 'PROJ-2': ['PROJ-1'] });
    await startPlan(created.id, 'developer');
    await agentWorks(r, created.id, 'PROJ-1', { merge: false });
    const item = await settledItem(created.id, 'PROJ-1', 'review');
    const card = await r.reviews.evaluate(item.runSessionId as string);
    await r.reviews.act(card!.id, 'discard', { confirm: true });
    await settledItem(created.id, 'PROJ-1', 'blocked');
    expect(await itemOf(created.id, 'PROJ-2')).toMatchObject({ state: 'blocked', reason: 'waiting on PROJ-1, which was discarded' });
  }, 60_000);

  it('red checks (fake gh): the session is told, its dependents wait; green and merged → done', async () => {
    const r = await setup({ origin: true });
    const created = await makePlan(r, { 'PROJ-1': [], 'PROJ-2': ['PROJ-1'] });
    await startPlan(created.id, 'agents');
    const item = await settledItem(created.id, 'PROJ-1', 'running');
    const branch = item.branch as string;
    await r.g.setPullRequests({ [branch]: { number: 7, state: 'OPEN', url: 'https://github.com/fake/acme/pull/7', baseRefName: TARGET, headRefOid: 'aaa', mergeable: 'MERGEABLE', statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit-tests', status: 'COMPLETED', conclusion: 'FAILURE' }] } });
    await agentWorks(r, created.id, 'PROJ-1', { merge: false });
    await until(async () => ((await itemOf(created.id, 'PROJ-1')).waitingOn === 'checks' ? true : undefined), 'waiting on checks');
    expect(await itemOf(created.id, 'PROJ-1')).toMatchObject({ state: 'running', note: 'checks failed: unit-tests', prUrl: 'https://github.com/fake/acme/pull/7' });
    const run = await runSession(item);
    await until(async () => ((await r.s.store.events.list(run.id)).some((event) => JSON.stringify(event.payload).includes('failed: unit-tests')) ? true : undefined), 'the failure sent to the session');
    expect((await itemOf(created.id, 'PROJ-2')).state).toBe('waiting');
    // Fixed and merged (gh says MERGED, checks green); the poll sees it.
    await r.g.setPullRequests({ [branch]: { number: 7, state: 'MERGED', url: 'https://github.com/fake/acme/pull/7', baseRefName: TARGET, headRefOid: 'bbb', mergeable: 'UNKNOWN', statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit-tests', status: 'COMPLETED', conclusion: 'SUCCESS' }] } });
    r.plans.pollChecks();
    await settledItem(created.id, 'PROJ-1', 'done');
    await settledItem(created.id, 'PROJ-2', 'running');
  }, 60_000);

  it('a second conflict with the target becomes an Inbox item', async () => {
    const r = await setup();
    const created = await makePlan(r, { 'PROJ-1': [], 'PROJ-2': [] });
    await startPlan(created.id, 'agents');
    await settledItem(created.id, 'PROJ-2', 'running');
    // Both change the same line; PROJ-1 is merged first.
    await agentWorks(r, created.id, 'PROJ-1', { merge: true, file: 'src/app.txt', content: 'one\nTWO from PROJ-1\nthree\n' });
    await settledItem(created.id, 'PROJ-1', 'done');
    await agentWorks(r, created.id, 'PROJ-2', { merge: false, file: 'src/app.txt', content: 'one\nTWO from PROJ-2\nthree\n' });
    // First conflict: the agent is asked to rebase (a message: another turn); it does not, so the second becomes an Inbox item.
    const items = await until(
      async () => {
        const open = (await r.s.store.systemItems.list(['open'])).filter((entry) => entry.kind === 'plan-conflict');
        return open.length > 0 ? open : undefined;
      },
      'the conflict Inbox item',
      30_000,
    );
    expect(items.map((entry) => entry.title)).toEqual([`Plan "Acme epic": PROJ-2 conflicts with ${TARGET} again`]);
    const run = await runSession(await itemOf(created.id, 'PROJ-2'));
    expect((await r.s.store.events.list(run.id)).filter((event) => JSON.stringify(event.payload).includes(`Rebase onto ${TARGET}`))).toHaveLength(1);
    expect(await itemOf(created.id, 'PROJ-2')).toMatchObject({ state: 'blocked', waitingOn: 'conflict' });
  }, 60_000);

  it('refuses a cycle, a start without mergeMode, and an agent-mode plan targeting master', async () => {
    const r = await setup();
    const created = await makePlan(r, { 'PROJ-1': [], 'PROJ-2': ['PROJ-1'] });
    const cycle = await call('POST', `/api/plans/${created.id}/edges`, { from: 'PROJ-2', to: 'PROJ-1' });
    expect(cycle.statusCode).toBe(409);
    expect(cycle.json()).toEqual({ error: 'cycle', message: 'that dependency would make a cycle: PROJ-2 → PROJ-1 → PROJ-2 (each waits for the next)' });
    const noMode = await call('POST', `/api/plans/${created.id}/start`, {});
    expect(noMode.statusCode).toBe(422);
    expect(noMode.json()).toMatchObject({ error: 'merge-mode-required', errors: [{ field: 'mergeMode' }] });
    expect((await plan(created.id)).state).toBe('draft');
    const master = await call('POST', '/api/plans', { sourceSessionId: r.source.id, title: 'Straight to master', targetBranch: 'master', baseBranch: 'main' });
    const masterId = (master.json() as Plan).id;
    await call('POST', `/api/plans/${masterId}/items`, { todo: { title: 'Anything' } });
    const refused = await call('POST', `/api/plans/${masterId}/start`, { mergeMode: 'agents' });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: 'target-forbidden' });
    // The repo's default branch (main) too.
    const main = await call('POST', '/api/plans', { sourceSessionId: r.source.id, title: 'Into main', targetBranch: 'main', baseBranch: 'dev' });
    const mainId = (main.json() as Plan).id;
    await call('POST', `/api/plans/${mainId}/items`, { todo: { title: 'Else' } });
    expect((await call('POST', `/api/plans/${mainId}/start`, { mergeMode: 'agents-with-holds' })).json()).toMatchObject({ error: 'target-forbidden' });
  }, 60_000);

  it('restart: a running plan resumes (work merged while Switchboard was down is picked up)', async () => {
    const r = await setup();
    const created = await makePlan(r, { 'PROJ-1': [], 'PROJ-2': ['PROJ-1'] });
    await startPlan(created.id, 'agents');
    const item = await settledItem(created.id, 'PROJ-1', 'running');
    const run = await runSession(item);
    await until(async () => ((await r.s.store.sessions.get(run.id))?.status !== 'run' ? true : undefined), 'the first turn');
    await r.plans.close();
    // While the scheduler is down, the agent's work lands in the target.
    await r.g.commit(run.cwd, 'PROJ-1.txt', 'PROJ-1\n', 'PROJ-1: work');
    await r.g.git(await targetCheckout(r), 'merge', '-q', '--no-edit', item.branch as string);
    r.plans = makePlans(r);
    await openApp(r);
    await r.plans.start();
    await r.plans.idle();
    await until(async () => ((await itemOf(created.id, 'PROJ-1')).state === 'done' ? true : undefined), 'PROJ-1 done after the restart');
    await settledItem(created.id, 'PROJ-2', 'running');
  }, 60_000);
  it('continue the source in a fresh session (D83): the plan follows it, its pending items keep their todos and still start', async () => {
    const r = await setup();
    const created = await makePlan(r, { 'PROJ-1': [], 'PROJ-2': ['PROJ-1'] });
    await startPlan(created.id, 'agents');
    await settledItem(created.id, 'PROJ-1', 'running');
    await until(async () => ((await r.s.store.sessions.get(r.source.id))?.status !== 'run' ? true : undefined), "the source's first turn");
    const pending = await itemOf(created.id, 'PROJ-2');
    const fresh = await call('POST', `/api/sessions/${r.source.id}/fresh`);
    expect(fresh.statusCode, fresh.body).toBe(202);
    const freshId = await until(async () => {
      const old = await r.s.store.sessions.get(r.source.id);
      return old?.continuedTo && old.closedAt !== null ? old.continuedTo : undefined;
    }, 'the fresh session', 30_000);
    const moved = await plan(created.id);
    expect(moved.sourceSessionId).toBe(freshId);
    expect((await r.s.store.todos.get(pending.todoId))?.sessionId).toBe(freshId);
    expect(moved.items.find((item) => item.key === 'PROJ-2')).toMatchObject({ todoId: pending.todoId, state: 'waiting' });
    await agentWorks(r, created.id, 'PROJ-1', { merge: true });
    await settledItem(created.id, 'PROJ-1', 'done');
    const second = await settledItem(created.id, 'PROJ-2', 'running');
    expect(second.reason).toBeNull();
    expect((await r.s.store.sessions.get(second.runSessionId as string))?.todoLink?.sourceSessionId).toBe(freshId);
    expect(r.s.errors).toEqual([]);
  }, 90_000);
});
