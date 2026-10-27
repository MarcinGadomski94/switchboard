/**
 * D139 · the account needs you (`docs/accounts.md` → *The account needs you*) on the real path
 * (fake-claude simulating Claude Code's "[ACTION REQUIRED]" exit, a temp git repo, the real
 * routes, PlanService, AccountNeedsYou): a Project's steps stop starting after the first failure
 * and wait with the reason; one Inbox item with the command; new sessions on the overall choice
 * go to another account; Retry stopped agents restarts the same session once the fake accepts,
 * and the block clears on its first good turn. A failed step (an ordinary error) holds no slot and
 * the Project's Resume restarts it.
 */
import { rm, writeFile } from 'node:fs/promises';
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
import type { InboxItem } from '../../../src/core/api.ts';
import { PlanGit } from '../../../src/server/plans/git.ts';
import { PlanService } from '../../../src/server/plans/service.ts';
import { BranchMergeGit } from '../../../src/server/worktrees/branch-merge.ts';
import { TodoService } from '../../../src/server/todos/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import type { WorktreeManager } from '../../../src/server/worktrees/manager.ts';
import { fakeGhCommand } from '../../../tools/fake-gh/command.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';
import { type SupervisorWorld, makeSupervisorWorld, until } from '../../helpers/supervisor.ts';

const PORT = 4903; // inject() opens no socket; the port feeds the Host check only
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

/** A plan without a merge step whose three steps are independent, at most one at a time. */
async function threeSteps(r: Rig): Promise<Plan> {
  const created = await call('POST', '/api/plans', { sourceSessionId: r.source.id, title: 'Acme epic', maxConcurrency: 1 });
  expect(created.statusCode, created.body).toBe(201);
  const id = (created.json() as Plan).id;
  for (const key of ['PROJ-1', 'PROJ-2', 'PROJ-3']) {
    const added = await call('POST', `/api/plans/${id}/items`, { key, todo: { title: `Work ${key}`, plan: `Change ${key}.`, estimateMinutes: 20 } });
    expect(added.statusCode, added.body).toBe(201);
  }
  return plan(id);
}

async function accountItems(): Promise<InboxItem[]> {
  return ((await call('GET', '/api/inbox')).json() as InboxItem[]).filter((item) => item.systemKind === 'account-needs-you');
}

const TERMS = '[ACTION REQUIRED] An update to our Consumer Terms and Privacy Policy has taken effect on October 8, 2025. You must run `claude` to review the updated terms.';

describe('D139 · the account needs you', () => {
  it("a Project's steps stop starting on its blocked account; one Inbox item with the command; Retry restarts the same session and the block clears", async () => {
    const r = await setup();
    const work = await r.s.accounts.create({ cli: 'claude', name: 'Work' });
    const personal = await r.s.accounts.create({ cli: 'claude', name: 'Personal' });
    await until(async () => ((await r.s.store.sessions.get(r.source.id))?.status === 'done' ? true : undefined), "the source's first turn");
    // The plan's own session stays where it is (pinned: D138 moves no pinned session).
    await r.s.supervisor.setProfilePinned(r.source.id, true);
    // The fake's Work login now refuses to run until its terms are accepted (an empty file = the incident's text).
    const marker = path.join(work.dir as string, '.fake-action-required');
    await writeFile(marker, '');
    const created = await threeSteps(r);
    const started = await start(created.id, { accounts: { claude: work.id } });
    expect(started.statusCode, started.body).toBe(200);

    // The first step fails at once: "Stopped (account needs you)", and the plan waits with the reason.
    const first = await settledItem(created.id, 'PROJ-1', 'stopped');
    expect(first.stoppedBy).toBe('account');
    expect(first.reason).toBe("Stopped (account needs you): the account Work needs you — accept Anthropic's updated terms");
    const failedId = first.runSessionId as string;
    expect((await r.s.store.sessions.get(failedId))?.status).toBe('fail');
    const waiting = await until(async () => {
      const p = await plan(created.id);
      return p.held === 'the account Work needs you' ? p : undefined;
    }, 'the plan waits for the account');
    // No other step started on the blocked account (the failed one holds no slot, the account does).
    expect(waiting.items.filter((item) => item.runSessionId !== null).map((item) => item.key)).toEqual(['PROJ-1']);
    expect((await r.s.accounts.blockOf(work.id))).toMatchObject({ kind: 'terms', text: TERMS, sessionIds: [failedId] });
    expect((await r.s.accounts.list({ check: false })).find((p) => p.id === work.id)?.needsYou?.kind).toBe('terms');

    // One Inbox item, with the CLI's text and the command.
    const items = await until(async () => {
      const found = await accountItems();
      return found.length > 0 ? found : undefined;
    }, 'the Inbox item');
    expect(items).toHaveLength(1);
    const item = items[0] as InboxItem;
    expect(item.title).toBe("Work (Claude Code) needs you: accept Anthropic's updated terms");
    expect(item.detail).toContain(TERMS);
    expect(item.command).toBe(`CLAUDE_CONFIG_DIR="${work.dir}" claude`);
    expect(item.actions?.map((action) => action.id)).toEqual(['retry-stopped', 'dismiss']);
    // The failed session's chat says why, with the command.
    const divider = (await r.s.store.events.list(failedId)).find((event) => (event.payload as { action?: string } | null)?.action === 'account-needs-you');
    expect(divider?.label).toBe("Stopped: the account Work needs you — accept Anthropic's updated terms");
    expect(divider?.payload).toMatchObject({ command: `CLAUDE_CONFIG_DIR="${work.dir}" claude`, message: TERMS });

    // Restarting the step by hand while the account still waits: refused with the reason.
    const early = await call('POST', `/api/plans/${created.id}/items/${first.id}/restart`);
    expect(early.statusCode, early.body).toBe(409);
    expect(early.json()).toMatchObject({ error: 'account' });

    // The overall choice on Work: a new session starts on the first other account with allowance (Work is treated like spent).
    await r.s.accounts.setSettings({ choice: { claude: work.id } });
    const other = await call('POST', '/api/sessions', { simple: true, name: 'other', title: 'Other', task: 'Hello', folder: r.folder.id, worktrees: false });
    expect(other.statusCode, other.body).toBe(201);
    expect((other.json() as Session).profileId).not.toBe(work.id);
    expect([personal.id, 'default-claude']).toContain((other.json() as Session).profileId);

    // The developer accepts the terms (the fake stops refusing) and chooses Retry stopped agents.
    await rm(marker);
    const retried = await call('POST', `/api/inbox/${item.id}/actions/retry-stopped`);
    expect(retried.statusCode, retried.body).toBeLessThan(300);
    expect(await accountItems()).toEqual([]);
    // The same session runs again, on Work; its first good turn ends the block for good.
    const back = await settledItem(created.id, 'PROJ-1', 'running');
    expect(back.runSessionId).toBe(failedId);
    expect((await r.s.store.sessions.get(failedId))?.profileId).toBe(work.id);
    await until(async () => ((await r.s.store.sessions.get(failedId))?.status === 'done' || (await r.s.store.sessions.get(failedId))?.status === 'idle' ? true : undefined), 'the restarted turn', 20_000);
    expect(await r.s.accounts.blockOf(work.id)).toBeNull();
    await until(async () => ((await plan(created.id)).held === null ? true : undefined), 'the plan no longer waits');
    expect(r.s.errors).toEqual([]);
  }, 120_000);

  it('a step that failed with an ordinary error holds no slot, shows Stopped, and the Project\'s Resume restarts it once the failure is gone', async () => {
    const r = await setup();
    await until(async () => ((await r.s.store.sessions.get(r.source.id))?.status === 'done' ? true : undefined), "the source's first turn");
    // The Default's config folder: the fake fails every start with an ordinary error (not "needs you").
    const marker = path.join(r.s.configDir, '.fake-action-required');
    await writeFile(marker, 'boom: something else broke');
    const created = await threeSteps(r);
    const started = await start(created.id, {});
    expect(started.statusCode, started.body).toBe(200);
    const first = await settledItem(created.id, 'PROJ-1', 'stopped');
    expect(first).toMatchObject({ stoppedBy: 'error', reason: 'its session stopped with an error' });
    expect(await accountItems()).toEqual([]);
    // Its slot is free: the next step starts (and fails the same way) — no hold, the steps are stopped one by one.
    await settledItem(created.id, 'PROJ-2', 'stopped');
    await rm(marker);
    const resumed = await call('POST', `/api/plans/${created.id}/resume`);
    expect(resumed.statusCode, resumed.body).toBe(200);
    const again = await settledItem(created.id, 'PROJ-1', 'running');
    expect(again.runSessionId).toBe(first.runSessionId);
    // Nothing stopped any more: a second Resume of the running plan is the usual 409.
    await until(async () => ((await plan(created.id)).items.every((item) => item.state !== 'stopped') ? true : undefined), 'no stopped step', 20_000);
    expect((await call('POST', `/api/plans/${created.id}/resume`)).statusCode).toBe(409);
    expect(r.s.errors).toEqual([]);
  }, 120_000);
});
