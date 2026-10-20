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
import type { Folder, Session } from '../../../src/core/api.ts';
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

async function setup(): Promise<Rig> {
  const s = await makeSupervisorWorld({ scenario: 'handoff-start' });
  await s.store.settings.set(PLANS_SETTING, true);
  const g = await makeGitWorld({ root: s.root, workspace: s.workspace, store: s.store, baseEnv: s.env });
  await writeFile(path.join(s.workspace, 'AGENTS.md'), '# Acme workspace\n');
  // A read-only solution (the router's deprecated/ folder): never a write target.
  await g.makeRepo(path.join(s.workspace, 'deprecated', 'microfrontends', 'old-front'));
  const repoPath = await g.makeRepo(path.join(s.root, 'acme'));
  const worktrees = g.manager({ sessions: s.supervisor });
  const bus = new HubBus();
  const folders = await FolderService.open({ store: s.store });
  const token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: s.root }, platform: 'linux', home: s.root, cwd: s.root });
  const app = await buildApp({ config: { ...base, port: PORT }, token, store: s.store, webRoot: s.root, supervisor: s.supervisor, worktrees, providers: { diff: worktrees }, bus, folders, agentTools: false });
  await app.ready();
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
