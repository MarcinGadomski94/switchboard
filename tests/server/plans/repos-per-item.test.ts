/**
 * D115 · the plan's agent picks the repositories: a Jira import into a workspace needs no repos.
 * The plan is made with none of its own (`reposPerItem`), its items wait ("Waiting for the plan's
 * agent to pick repositories"), and the new session's agent is asked, with the workspace's
 * solutions and the items, to call `plan_set_solutions`, which is applied at once (unknown and
 * read-only names refused), makes the plan's repos the union, and lets the scheduler start the
 * items. Real app (`buildApp`), fake claude, temp git repos (`web-front`, `mobile`, a read-only
 * `deprecated/microfrontends/old-front`), the fake Jira (`tests/helpers/fake-jira.ts`), never the real Jira.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Folder, InboxItem, Session } from '../../../src/core/api.ts';
import { PLANS_SETTING, PLAN_PICK_REPOS_REASON, type Plan } from '../../../src/core/plans.ts';
import type { PlanJiraState } from '../../../src/core/plans-jira.ts';
import { peerAnswerKind } from '../../../src/core/peer-wire.ts';
import { type AgentApi, createTodoServer } from '../../../src/hook/sb-mcp.ts';
import { registerPlanToolsIfOn } from '../../../src/hook/sb-plan-tools.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { FolderService } from '../../../src/server/folders/service.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { planServiceOf } from '../../../src/server/plans/install.ts';
import { planJiraServiceOf } from '../../../src/server/plans/jira/install.ts';
import { agentTokenFor } from '../../../src/server/todos/agent-token.ts';
import { generateToken } from '../../../src/server/token.ts';
import { type FakeJira, startFakeJira } from '../../helpers/fake-jira.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';
import { type SupervisorWorld, makeSupervisorWorld, until } from '../../helpers/supervisor.ts';

const PORT = 4946; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

interface Rig {
  s: SupervisorWorld;
  g: GitWorld;
  app: FastifyInstance;
  token: string;
  fake: FakeJira;
  repoFolder: Folder;
  workspaceFolder: Folder;
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.app.close();
  await rig?.fake.close();
  await rig?.s.cleanup();
  rig = undefined;
});

function call(r: Rig, method: InjectOptions['method'], url: string, payload?: unknown) {
  return r.app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${r.token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

/** The app over the world's store, supervisor and data folder (built again for a restart). */
async function makeApp(s: SupervisorWorld, g: GitWorld, token: string): Promise<FastifyInstance> {
  const worktrees = g.manager({ sessions: s.supervisor });
  const bus = new HubBus();
  const folders = await FolderService.open({ store: s.store });
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: s.root }, platform: 'linux', home: s.root, cwd: s.root });
  const app = await buildApp({ config: { ...base, port: PORT }, token, store: s.store, webRoot: s.root, supervisor: s.supervisor, worktrees, providers: { diff: worktrees }, bus, folders, agentTools: false });
  await app.ready();
  return app;
}

async function setup(): Promise<Rig> {
  const s = await makeSupervisorWorld({ scenario: 'handoff-start' });
  await s.store.settings.set(PLANS_SETTING, true);
  const g = await makeGitWorld({ root: s.root, workspace: s.workspace, store: s.store, baseEnv: s.env });
  await writeFile(path.join(s.workspace, 'AGENTS.md'), '# Acme workspace\n');
  // A read-only solution (the router's deprecated/ folder): never a write target.
  await g.makeRepo(path.join(s.workspace, 'deprecated', 'microfrontends', 'old-front'));
  const repoPath = await g.makeRepo(path.join(s.root, 'acme'));
  const token = generateToken();
  const app = await makeApp(s, g, token);
  const fake = await startFakeJira();
  const partial = { s, g, app, token, fake } as Rig;
  rig = partial;
  const saved = await call(partial, 'PUT', '/api/integrations/jira', { baseUrl: fake.url, email: fake.email, token: fake.token });
  expect(saved.statusCode, saved.body).toBe(200);
  partial.repoFolder = (await call(partial, 'POST', '/api/folders', { path: repoPath })).json() as Folder;
  partial.workspaceFolder = (await call(partial, 'POST', '/api/folders', { path: s.workspace })).json() as Folder;
  return partial;
}

/** The MCP helper's API over `inject`, as the session with its own agent token. */
function helperApi(r: Rig, sessionId: string): AgentApi {
  return async (method, url, body) => {
    const answer = await r.app.inject({
      method,
      url,
      headers: { host: HOST, 'x-switchboard-session': sessionId, authorization: `Bearer ${agentTokenFor(r.token, sessionId)}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    return { status: answer.statusCode, body: answer.body ? (answer.json() as unknown) : null };
  };
}

/** Connects the helper's server (with the Plans hook as `sb-mcp.ts` runs it) and makes MCP calls. */
async function helper(api: AgentApi): Promise<{ list(): Promise<string[]>; callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>; close(): Promise<void> }> {
  const server = createTodoServer(api);
  await registerPlanToolsIfOn(server, api);
  const [client, transport] = InMemoryTransport.createLinkedPair();
  await server.connect(transport);
  let id = 0;
  const waiting = new Map<number, (answer: Record<string, unknown>) => void>();
  client.onmessage = (message: JSONRPCMessage) => {
    const answer = message as Record<string, unknown>;
    waiting.get(answer['id'] as number)?.(answer);
  };
  await client.start();
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      id += 1;
      waiting.set(id, resolve);
      void client.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage);
    });
  return {
    list: async () => (((await send('tools/list'))['result'] as { tools: Array<{ name: string }> }).tools ?? []).map((tool) => tool.name),
    callTool: async (name, args) => {
      const result = (await send('tools/call', { name, arguments: args }))['result'] as { content: Array<{ text: string }>; isError?: boolean };
      return { text: result.content.map((entry) => entry.text).join('\n'), isError: result.isError === true };
    },
    close: () => server.close(),
  };
}

const IMPORT = { epic: 'PROJ-10', targetBranch: 'feature/PROJ-10-acme-checkout', baseBranch: 'main' };

/** The text of every user message the session got. */
async function messagesOf(r: Rig, sessionId: string): Promise<string> {
  return (await r.s.store.events.list(sessionId)).map((event) => JSON.stringify(event.payload)).join('\n');
}

async function getPlan(r: Rig, planId: string): Promise<Plan> {
  return (await call(r, 'GET', `/api/plans/${planId}`)).json() as Plan;
}

describe('D115 · the plan\'s agent picks the repositories', () => {
  it('a workspace import without repos makes the plan and its session, and asks the agent with the solutions and the items', async () => {
    const r = await setup();
    const answer = await call(r, 'POST', '/api/plans/jira/import', { ...IMPORT, folder: r.workspaceFolder.id });
    expect(answer.statusCode, answer.body).toBe(201);
    const { plan, session, askedForOrder, askedForRepos } = answer.json() as { plan: Plan; session: Session; askedForOrder: boolean; askedForRepos: boolean };
    expect(session.folder).toBe(r.workspaceFolder.id);
    expect(session.solutions).toEqual([]);
    expect(plan.sourceSessionId).toBe(session.id);
    expect(plan.reposPerItem).toBe(true);
    expect(plan.repos).toEqual([]);
    expect(plan.items).toHaveLength(5);
    for (const item of plan.items) {
      expect(item.solutions).toEqual([]);
      expect(item.state).toBe('waiting');
      expect(item.reason).toBe(PLAN_PICK_REPOS_REASON);
    }
    // One message asks for both: the missing order (PROJ-15 has no links) and the repositories.
    expect(askedForOrder).toBe(true);
    expect(askedForRepos).toBe(true);
    const text = await until(async () => {
      const all = await messagesOf(r, session.id);
      return all.includes('Also pick the repositories') ? all : undefined;
    }, 'the ask in the new session', 20_000);
    expect(text).toContain('Please propose the missing order');
    expect(text).toContain('plan_set_solutions');
    // The workspace's solutions (the read-only one left out) and the items' keys, titles and descriptions.
    expect(text).toMatch(/solutions you can pick from: [^.]*web-front/);
    expect(text).toMatch(/solutions you can pick from: [^.]*mobile/);
    expect(text).not.toMatch(/solutions you can pick from: [^.]*old-front/);
    for (const key of ['PROJ-11', 'PROJ-12', 'PROJ-13', 'PROJ-14', 'PROJ-15']) expect(text).toContain(key);
    expect(text).toContain('Cart API');
    expect(text).toContain('Expose the cart.');
    const jira = (await call(r, 'GET', `/api/plans/${plan.id}/jira`)).json() as PlanJiraState;
    expect(jira.activity.some((line) => line.kind === 'ask-repos')).toBe(true);
  });

  it('plan_set_solutions applies at once, refuses unknown and read-only names, and makes the plan\'s repos the union; the items start only then', async () => {
    const r = await setup();
    const answer = await call(r, 'POST', '/api/plans/jira/import', { ...IMPORT, folder: r.workspaceFolder.id });
    expect(answer.statusCode, answer.body).toBe(201);
    const { plan, session } = answer.json() as { plan: Plan; session: Session };
    const tools = await helper(helperApi(r, session.id));
    try {
      expect(await tools.list()).toContain('plan_set_solutions');

      // Start the plan (the developer merges): nothing starts while no item has repositories.
      const started = await call(r, 'POST', `/api/plans/${plan.id}/start`, { mergeMode: 'developer' });
      expect(started.statusCode, started.body).toBe(200);
      const service = planServiceOf(r.app);
      service?.kick();
      await service?.idle();
      let now = await getPlan(r, plan.id);
      expect(now.state).toBe('running');
      expect(now.items.every((item) => item.storedState === 'pending' && item.runSessionId === null)).toBe(true);
      expect(now.items.find((item) => item.key === 'PROJ-11')?.reason).toBe(PLAN_PICK_REPOS_REASON);

      // Unknown and read-only names refuse the whole call; nothing changes.
      const unknown = await tools.callTool('plan_set_solutions', { plan_id: plan.id, items: [{ item: 'PROJ-11', solutions: ['web-front'] }, { item: 'PROJ-15', solutions: ['nope'] }] });
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toContain('not a solution of this workspace: nope');
      const readOnly = await tools.callTool('plan_set_solutions', { plan_id: plan.id, items: [{ item: 'PROJ-11', solutions: ['old-front'] }] });
      expect(readOnly.isError).toBe(true);
      expect(readOnly.text).toContain('read-only');
      const noItem = await tools.callTool('plan_set_solutions', { plan_id: plan.id, items: [{ item: 'PROJ-404', solutions: ['mobile'] }] });
      expect(noItem.isError).toBe(true);
      expect(noItem.text).toContain('no item PROJ-404');
      now = await getPlan(r, plan.id);
      expect(now.items.every((item) => item.solutions.length === 0)).toBe(true);
      expect(now.repos).toEqual([]);

      // Applied at once: PROJ-11 (ready, no dependency) starts; PROJ-15 too; the plan's repos are the union.
      const set = await tools.callTool('plan_set_solutions', { plan_id: plan.id, items: [{ item: 'PROJ-11', solutions: ['web-front'] }, { item: 'PROJ-15', solutions: ['mobile', 'web-front'] }, { item: 'PROJ-12', solutions: ['web-front'] }] });
      expect(set.isError, set.text).toBe(false);
      expect(set.text).toContain('Set the repositories (applied)');
      now = await until(async () => {
        const fresh = await getPlan(r, plan.id);
        return fresh.items.find((item) => item.key === 'PROJ-11')?.runSessionId ? fresh : undefined;
      }, 'PROJ-11 started', 30_000);
      expect(now.repos).toEqual(['web-front', 'mobile']);
      expect(now.items.find((item) => item.key === 'PROJ-11')?.solutions).toEqual(['web-front']);
      // PROJ-12 has repositories but waits on PROJ-11; PROJ-13 and PROJ-14 still wait for theirs.
      expect(now.items.find((item) => item.key === 'PROJ-12')?.state).toBe('waiting');
      expect(now.items.find((item) => item.key === 'PROJ-12')?.reason).not.toBe(PLAN_PICK_REPOS_REASON);
      expect(now.items.find((item) => item.key === 'PROJ-13')?.reason).toBe(PLAN_PICK_REPOS_REASON);
      // The run works in its own repository: a worktree of web-front on the item's branch, cut from the target.
      const runId = now.items.find((item) => item.key === 'PROJ-11')?.runSessionId as string;
      const worktrees = await r.s.store.worktrees.list({ sessionId: runId });
      expect(worktrees.map((worktree) => worktree.repo)).toEqual(['web-front']);
      expect(await r.g.git(r.g.web, 'branch', '--list', 'feature/PROJ-10-acme-checkout')).toContain('feature/PROJ-10-acme-checkout');

      // An item that started keeps its repositories.
      const again = await tools.callTool('plan_set_solutions', { plan_id: plan.id, items: [{ item: 'PROJ-11', solutions: ['mobile'] }] });
      expect(again.isError).toBe(true);
      expect(again.text).toContain('has started');

      // The developer can still change a pending item's repositories (the item edit).
      const item13 = now.items.find((item) => item.key === 'PROJ-13')?.id as string;
      const edited = await call(r, 'PUT', `/api/plans/${plan.id}/items/${item13}`, { solutions: ['mobile'] });
      expect(edited.statusCode, edited.body).toBe(200);
      expect((edited.json() as Plan).items.find((item) => item.id === item13)?.solutions).toEqual(['mobile']);
      const refused = await call(r, 'PUT', `/api/plans/${plan.id}/items/${item13}`, { solutions: ['old-front'] });
      expect(refused.statusCode).toBe(422);
    } finally {
      await tools.close();
    }
  });

  it('a failed ask surfaces in the plan\'s activity; Ask again; no answer in time is noted', async () => {
    const r = await setup();
    const answer = await call(r, 'POST', '/api/plans/jira/import', { ...IMPORT, folder: r.workspaceFolder.id });
    const { plan, session } = answer.json() as { plan: Plan; session: Session };
    expect(peerAnswerKind('POST', `/api/plans/${plan.id}/solutions/ask`)).toBe('none');

    // Ask again while the session is open: asked.
    const asked = await call(r, 'POST', `/api/plans/${plan.id}/solutions/ask`);
    expect(asked.statusCode, asked.body).toBe(200);
    expect(asked.json()).toMatchObject({ asked: true, sessionId: session.id, items: 5 });

    // No answer in time (the check the timer runs): a line of the plan's activity.
    expect(await planJiraServiceOf(r.app)?.checkRepos(plan.id)).toBe(5);
    let jira = (await call(r, 'GET', `/api/plans/${plan.id}/jira`)).json() as PlanJiraState;
    expect(jira.activity.some((line) => line.kind === 'error' && line.text.includes('has not picked the repositories of 5 item(s)'))).toBe(true);

    // The session closed: the ask cannot be sent; the refusal says so and the activity keeps it.
    expect((await call(r, 'POST', `/api/sessions/${session.id}/close`, { confirm: true })).statusCode).toBe(200);
    const failed = await call(r, 'POST', `/api/plans/${plan.id}/solutions/ask`);
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error).toBe('not-sent');
    jira = (await call(r, 'GET', `/api/plans/${plan.id}/jira`)).json() as PlanJiraState;
    expect(jira.activity.some((line) => line.kind === 'error' && line.text.startsWith('Could not ask the session to pick the repositories'))).toBe(true);
  });

  it('a session import from a workspace session without solutions is the same; a plan with repos (or a repo folder) asks nothing and runs as before', async () => {
    const r = await setup();
    // A repo-folder import: the repo is the plan's, no picking.
    const repo = await call(r, 'POST', '/api/plans/jira/import', { ...IMPORT, folder: r.repoFolder.id });
    expect(repo.statusCode, repo.body).toBe(201);
    const repoAnswer = repo.json() as { plan: Plan; askedForRepos: boolean };
    expect(repoAnswer.plan.repos).toEqual(['acme']);
    expect(repoAnswer.plan.reposPerItem).toBe(false);
    expect(repoAnswer.askedForRepos).toBe(false);
    expect(repoAnswer.plan.items.some((item) => item.reason === PLAN_PICK_REPOS_REASON)).toBe(false);

    // The developer limits the repositories: every item works in them (no ask for repositories).
    const limited = await call(r, 'POST', '/api/plans/jira/import', { ...IMPORT, folder: r.workspaceFolder.id, repos: ['mobile'] });
    expect(limited.statusCode, limited.body).toBe(201);
    const limitedAnswer = limited.json() as { plan: Plan; askedForRepos: boolean };
    expect(limitedAnswer.plan.repos).toEqual(['mobile']);
    expect(limitedAnswer.plan.reposPerItem).toBe(false);
    expect(limitedAnswer.askedForRepos).toBe(false);

    // An existing workspace session without solutions: its import picks per item too.
    const started = await call(r, 'POST', '/api/sessions', { simple: true, name: 'source', title: 'Source', task: 'Hello', folder: r.workspaceFolder.id, worktrees: false });
    expect(started.statusCode, started.body).toBe(201);
    const source = started.json() as Session;
    const own = await call(r, 'POST', `/api/sessions/${source.id}/plans/jira/import`, IMPORT);
    expect(own.statusCode, own.body).toBe(201);
    expect((own.json() as { plan: Plan; askedForRepos: boolean }).plan.reposPerItem).toBe(true);
    expect((own.json() as { plan: Plan; askedForRepos: boolean }).askedForRepos).toBe(true);

    // The generic New plan: a workspace session without solutions may make a plan with a target too.
    const generic = await call(r, 'POST', '/api/plans', { sourceSessionId: source.id, title: 'Acme cleanup', targetBranch: 'feature/acme-cleanup' });
    expect(generic.statusCode, generic.body).toBe(201);
    expect((generic.json() as Plan).reposPerItem).toBe(true);
  });
});

// ── D115 follow-ups 2026-10-20: the ask goes out by itself, and a late or failed one reaches the Inbox ──

const ASK = 'Please pick the repositories of the plan';

/** A session started in `folder` (a Simple start with a first message). */
async function startSession(r: Rig, folder: Folder, name: string): Promise<Session> {
  const started = await call(r, 'POST', '/api/sessions', { simple: true, name, title: name, task: 'Hello', folder: folder.id, worktrees: false });
  expect(started.statusCode, started.body).toBe(201);
  return started.json() as Session;
}

/** How many times the session was sent the repositories ask. */
async function asksOf(r: Rig, sessionId: string): Promise<number> {
  const texts = (await r.s.store.events.list(sessionId)).map((event) => JSON.stringify(event.payload));
  return texts.filter((text) => text.includes(ASK)).length;
}

/** The open "wait for repositories" Inbox items of plan `planId`. */
async function pickItems(r: Rig, planId: string): Promise<InboxItem[]> {
  const inbox = (await call(r, 'GET', '/api/inbox')).json() as InboxItem[];
  return inbox.filter((item) => item.kind === 'system' && item.label === 'Pick repositories' && item.route === `/plans/${planId}`);
}

describe('D115 follow-ups · the repositories ask goes out by itself and never stalls silently', () => {
  it('New plan in a workspace without repos: the items added in a row are asked about in one message', async () => {
    const r = await setup();
    const source = await startSession(r, r.workspaceFolder, 'source');
    const created = await call(r, 'POST', '/api/plans', { sourceSessionId: source.id, title: 'Acme checkout', targetBranch: 'feature/PROJ-10-acme-checkout' });
    expect(created.statusCode, created.body).toBe(201);
    const plan = created.json() as Plan;
    expect(plan.reposPerItem).toBe(true);
    for (const title of ['Cart API', 'Checkout page', 'Receipt email']) {
      const added = await call(r, 'POST', `/api/plans/${plan.id}/items`, { todo: { title } });
      expect(added.statusCode, added.body).toBe(201);
    }
    // The burst ends (the service waits PICK_REPOS_DEBOUNCE_MS; the test runs it now): one message for all three.
    const service = planServiceOf(r.app);
    await service?.flushReposAsks();
    const text = await until(async () => {
      const all = await messagesOf(r, source.id);
      return all.includes(ASK) ? all : undefined;
    }, 'the ask in the source session', 20_000);
    for (const title of ['Cart API', 'Checkout page', 'Receipt email']) expect(text).toContain(title);
    expect(text).toContain('plan_set_solutions');
    expect(await asksOf(r, source.id)).toBe(1);
    // No Inbox item while the agent still has time.
    expect(await pickItems(r, plan.id)).toEqual([]);
  });

  it('plan_create and plan_add_item from the plan\'s own agent: the tool\'s answer is the ask (no message), and the check is armed', async () => {
    const r = await setup();
    const source = await startSession(r, r.workspaceFolder, 'source');
    const tools = await helper(helperApi(r, source.id));
    try {
      const created = await tools.callTool('plan_create', { title: 'Acme checkout', target_branch: 'feature/PROJ-10-acme-checkout', base_branch: 'main' });
      expect(created.isError, created.text).toBe(false);
      expect(created.text).toContain('picked per item, by you');
      expect(created.text).toMatch(/solutions you can pick from: [^.]*web-front/);
      expect(created.text).not.toMatch(/solutions you can pick from: [^.]*old-front/);
      const planId = /\[([0-9a-f]+)\]/.exec(created.text)?.[1] as string;
      const added = await tools.callTool('plan_add_item', { plan_id: planId, title: 'Cart API' });
      expect(added.isError, added.text).toBe(false);
      expect(added.text).toContain('plan_set_solutions');
      expect(added.text).toMatch(/solutions you can pick from: [^.]*mobile/);
      // With solutions given, nothing to pick.
      const picked = await tools.callTool('plan_add_item', { plan_id: planId, title: 'Checkout page', solutions: ['web-front'] });
      expect(picked.isError, picked.text).toBe(false);
      expect(picked.text).not.toContain('picked per item, by you');
      const service = planServiceOf(r.app);
      await service?.flushReposAsks();
      expect(await asksOf(r, source.id)).toBe(0);
      // The check is armed all the same: when it is due, the Inbox says so.
      expect(await service?.checkReposAsk(planId, true)).toBe(1);
      const items = await pickItems(r, planId);
      expect(items).toHaveLength(1);
      expect(items[0]?.title).toBe('1 item of "Acme checkout" waits for repositories');
    } finally {
      await tools.close();
    }
  });

  it('no ask for a plan with repos of its own or a repo folder\'s plan', async () => {
    const r = await setup();
    const source = await startSession(r, r.workspaceFolder, 'source');
    const limited = await call(r, 'POST', '/api/plans', { sourceSessionId: source.id, title: 'Mobile only', targetBranch: 'feature/PROJ-20-mobile', repos: ['mobile'] });
    expect(limited.statusCode, limited.body).toBe(201);
    expect((limited.json() as Plan).reposPerItem).toBe(false);
    expect((await call(r, 'POST', `/api/plans/${(limited.json() as Plan).id}/items`, { todo: { title: 'Push tokens' } })).statusCode).toBe(201);
    const repoSource = await startSession(r, r.repoFolder, 'repo-source');
    const repoPlan = await call(r, 'POST', '/api/plans', { sourceSessionId: repoSource.id, title: 'Acme repo', targetBranch: 'feature/PROJ-30-acme' });
    expect(repoPlan.statusCode, repoPlan.body).toBe(201);
    expect((repoPlan.json() as Plan).reposPerItem).toBe(false);
    expect((await call(r, 'POST', `/api/plans/${(repoPlan.json() as Plan).id}/items`, { todo: { title: 'Readme' } })).statusCode).toBe(201);
    const service = planServiceOf(r.app);
    expect(service?.activeTimers()).toBe(2); // the bus listener and the checks' poll: no ask, no check
    await service?.flushReposAsks();
    expect(await asksOf(r, source.id)).toBe(0);
    expect(await asksOf(r, repoSource.id)).toBe(0);
  });

  it('not picked in time → a Needs-you Inbox item with Ask again, which re-arms the check; it goes once every item has repositories', async () => {
    const r = await setup();
    const source = await startSession(r, r.workspaceFolder, 'source');
    const plan = (await call(r, 'POST', '/api/plans', { sourceSessionId: source.id, title: 'Acme checkout', targetBranch: 'feature/PROJ-10-acme-checkout' })).json() as Plan;
    const first = ((await call(r, 'POST', `/api/plans/${plan.id}/items`, { todo: { title: 'Cart API' } })).json() as { itemId: string }).itemId;
    const second = ((await call(r, 'POST', `/api/plans/${plan.id}/items`, { todo: { title: 'Checkout page' } })).json() as { itemId: string }).itemId;
    const service = planServiceOf(r.app);
    await service?.flushReposAsks();
    expect(await asksOf(r, source.id)).toBe(1);
    // Not due yet: nothing.
    expect(await service?.checkReposAsk(plan.id)).toBe(0);
    expect(await pickItems(r, plan.id)).toEqual([]);
    // Due: the Inbox item says which plan and how many items wait.
    expect(await service?.checkReposAsk(plan.id, true)).toBe(2);
    let items = await pickItems(r, plan.id);
    expect(items).toHaveLength(1);
    const notice = items[0] as InboxItem;
    expect(notice).toMatchObject({ source: 'plans', status: 'need', title: '2 items of "Acme checkout" wait for repositories', sessionId: source.id });
    expect(notice.detail).toContain('"Cart API", "Checkout page"');
    expect(notice.actions?.map((action) => action.label)).toEqual(['Ask again', 'Open plan', 'Dismiss']);

    // Ask again (from the Inbox, as a phone or a paired machine would through the same route): asked, the item closes, the check is armed again.
    const again = await call(r, 'POST', `/api/inbox/${notice.id}/actions/plan-ask-repos`);
    expect(again.statusCode, again.body).toBe(204);
    expect(await pickItems(r, plan.id)).toEqual([]);
    await until(async () => ((await asksOf(r, source.id)) === 2 ? true : undefined), 'the second ask', 20_000);
    expect(await service?.checkReposAsk(plan.id)).toBe(0); // armed again: not due
    expect(await service?.checkReposAsk(plan.id, true)).toBe(2);
    items = await pickItems(r, plan.id);
    expect(items).toHaveLength(1);

    // One item gets its repositories: still one waits, the item stays.
    expect((await call(r, 'PUT', `/api/plans/${plan.id}/items/${first}`, { solutions: ['web-front'] })).statusCode).toBe(200);
    expect(await pickItems(r, plan.id)).toHaveLength(1);
    // The agent picks the rest: the item goes.
    const tools = await helper(helperApi(r, source.id));
    try {
      const set = await tools.callTool('plan_set_solutions', { plan_id: plan.id, items: [{ item: second, solutions: ['mobile'] }] });
      expect(set.isError, set.text).toBe(false);
    } finally {
      await tools.close();
    }
    expect(await pickItems(r, plan.id)).toEqual([]);
    expect(await service?.checkReposAsk(plan.id, true)).toBe(0);
  });

  it('a failed send → the Inbox item at once (every plan, and the Jira plan\'s activity too)', async () => {
    const r = await setup();
    const source = await startSession(r, r.workspaceFolder, 'source');
    const plan = (await call(r, 'POST', '/api/plans', { sourceSessionId: source.id, title: 'Acme checkout', targetBranch: 'feature/PROJ-10-acme-checkout' })).json() as Plan;
    expect((await call(r, 'POST', `/api/plans/${plan.id}/items`, { todo: { title: 'Cart API' } })).statusCode).toBe(201);
    expect((await call(r, 'POST', `/api/sessions/${source.id}/close`, { confirm: true })).statusCode).toBe(200);
    await planServiceOf(r.app)?.flushReposAsks();
    const items = await pickItems(r, plan.id);
    expect(items).toHaveLength(1);
    expect(items[0]?.detail).toContain('could not be asked');
    // Ask again from the plan page: refused (not sent); still one item (the newer one).
    const failed = await call(r, 'POST', `/api/plans/${plan.id}/solutions/ask`);
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error).toBe('not-sent');
    expect(await pickItems(r, plan.id)).toHaveLength(1);
  });

  it('the asked time is kept in plans.db: after a restart the check still runs and raises the Inbox item', async () => {
    const r = await setup();
    const source = await startSession(r, r.workspaceFolder, 'source');
    const plan = (await call(r, 'POST', '/api/plans', { sourceSessionId: source.id, title: 'Acme checkout', targetBranch: 'feature/PROJ-10-acme-checkout' })).json() as Plan;
    expect((await call(r, 'POST', `/api/plans/${plan.id}/items`, { todo: { title: 'Cart API' } })).statusCode).toBe(201);
    await planServiceOf(r.app)?.flushReposAsks();
    expect(await asksOf(r, source.id)).toBe(1);
    // Switchboard stops (the in-memory timer goes with it) and starts again on the same data folder, with a short wait.
    await r.app.close();
    process.env['SWITCHBOARD_PLAN_PICK_REPOS_MS'] = '300';
    try {
      r.app = await makeApp(r.s, r.g, r.token);
    } finally {
      delete process.env['SWITCHBOARD_PLAN_PICK_REPOS_MS'];
    }
    const items = await until(async () => {
      const found = await pickItems(r, plan.id);
      return found.length > 0 ? found : undefined;
    }, 'the Inbox item after the restart', 20_000);
    expect(items[0]?.title).toBe('1 item of "Acme checkout" waits for repositories');
  });

  it('a Jira plan: Ask again and the late check are lines of its activity; the Inbox item is raised too', async () => {
    const r = await setup();
    const answer = await call(r, 'POST', '/api/plans/jira/import', { ...IMPORT, folder: r.workspaceFolder.id });
    const { plan } = answer.json() as { plan: Plan };
    expect(await planServiceOf(r.app)?.checkReposAsk(plan.id, true)).toBe(5);
    const jira = (await call(r, 'GET', `/api/plans/${plan.id}/jira`)).json() as PlanJiraState;
    expect(jira.activity.some((line) => line.kind === 'error' && line.text.includes('has not picked the repositories of 5 item(s)'))).toBe(true);
    const items = await pickItems(r, plan.id);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe(`5 items of "${plan.title}" wait for repositories`);
  });
});
