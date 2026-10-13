/**
 * D99-Jira-q1 · proposed order on the real path: a fake-claude source session, the real app
 * (`buildApp`, so Plans' `install.ts` installs the Jira lane), the fake Jira
 * (`tests/helpers/fake-jira.ts`; credentials saved through Settings into the in-memory keychain
 * Vitest gets). An import whose epic has an unlinked item sends the source session a message
 * asking for the missing order; the session's agent answers through the MCP helper's
 * `plan_propose_dependencies` (registered only while Plans is on); the developer accepts,
 * rejects or is refused a cycle.
 */
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Folder, Session } from '../../../src/core/api.ts';
import { PLANS_SETTING, type Plan } from '../../../src/core/plans.ts';
import type { PlanEdgeProposal } from '../../../src/core/plans-jira.ts';
import { type AgentApi, createTodoServer } from '../../../src/hook/sb-mcp.ts';
import { registerPlanToolsIfOn } from '../../../src/hook/sb-plan-tools.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { FolderService } from '../../../src/server/folders/service.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { planServiceOf } from '../../../src/server/plans/install.ts';
import { agentTokenFor } from '../../../src/server/todos/agent-token.ts';
import { generateToken } from '../../../src/server/token.ts';
import { type FakeJira, startFakeJira } from '../../helpers/fake-jira.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';
import { type SupervisorWorld, makeSupervisorWorld, until } from '../../helpers/supervisor.ts';

const PORT = 4947; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

interface Rig {
  s: SupervisorWorld;
  g: GitWorld;
  app: FastifyInstance;
  token: string;
  fake: FakeJira;
  source: Session;
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
  const folder = (await call(partial, 'POST', '/api/folders', { path: repoPath })).json() as Folder;
  const started = await call(partial, 'POST', '/api/sessions', { simple: true, name: 'source', title: 'Source', task: 'Hello', folder: folder.id, worktrees: false });
  expect(started.statusCode, started.body).toBe(201);
  partial.source = started.json() as Session;
  await until(async () => ((await s.store.sessions.get(partial.source.id))?.status === 'done' ? true : undefined), 'the source session settled', 20_000);
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

describe('D99-Jira-q1 · proposed order', () => {
  it('asks the source session after an import, takes the tool\'s proposals, accepts, refuses a cycle, rejects', async () => {
    const r = await setup();
    const imported = await call(r, 'POST', `/api/sessions/${r.source.id}/plans/jira/import`, { epic: 'PROJ-10', targetBranch: 'feature/PROJ-10-acme-checkout', baseBranch: 'main' });
    expect(imported.statusCode, imported.body).toBe(201);
    const planId = (imported.json() as { plan: Plan }).plan.id;
    expect((imported.json() as { askedForOrder: boolean }).askedForOrder).toBe(true);

    // The source session got the ask through the normal message path (fake-claude records the user turn).
    const asked = await until(
      async () => (await r.s.store.events.list(r.source.id)).find((event) => JSON.stringify(event.payload).includes('Please propose the missing order')) ?? undefined,
      'the ask in the source session',
      20_000,
    );
    const text = JSON.stringify(asked.payload);
    expect(text).toContain(`[${planId}]`);
    expect(text).toContain('These items have no dependency yet: PROJ-15');
    expect(text).toContain('plan_propose_dependencies');

    // The session's agent proposes through the MCP tool (present while Plans is on).
    const mcp = await helper(helperApi(r, r.source.id));
    try {
      expect(await mcp.list()).toContain('plan_propose_dependencies');
      const answer = await mcp.callTool('plan_propose_dependencies', {
        plan_id: planId,
        proposals: [
          { from: 'PROJ-14', to: 'PROJ-15', reason: 'the receipt needs the payment provider' },
          { from: 'PROJ-13', to: 'PROJ-11', reason: 'a made-up order that closes a cycle' },
          { from: 'PROJ-11', to: 'PROJ-12', reason: 'already there' },
          { from: 'PROJ-12', to: 'PROJ-15', reason: 'the receipt links to the cart' },
          { from: 'PROJ-77', to: 'PROJ-15', reason: 'no such item' },
        ],
      });
      expect(answer.isError).toBe(false);
      expect(answer.text).toContain('Proposed to the developer (nothing changes until they accept on the plan)');
      expect(answer.text).toContain('PROJ-12 after PROJ-11: the plan has this dependency already');
      expect(answer.text).toContain('PROJ-15 after PROJ-77: no item PROJ-77 in the plan');
    } finally {
      await mcp.close();
    }
    // Nothing changed in the plan yet.
    expect(((await call(r, 'GET', `/api/plans/${planId}`)).json() as Plan).edges).toHaveLength(3);
    const listed = (await call(r, 'GET', `/api/plans/${planId}/proposals`)).json() as PlanEdgeProposal[];
    expect(listed.map((entry) => [entry.text, entry.state])).toEqual([
      ['PROJ-15 should wait on PROJ-14', 'pending'],
      ['PROJ-11 should wait on PROJ-13', 'pending'],
      ['PROJ-15 should wait on PROJ-12', 'pending'],
    ]);
    const byText = (want: string) => listed.find((entry) => entry.text === want) as PlanEdgeProposal;

    // Accept: the dependency is added through the plan.
    const accepted = await call(r, 'POST', `/api/plans/${planId}/proposals/${byText('PROJ-15 should wait on PROJ-14').id}/accept`);
    expect(accepted.statusCode, accepted.body).toBe(200);
    const plan = (await call(r, 'GET', `/api/plans/${planId}`)).json() as Plan;
    const id = (key: string) => plan.items.find((item) => item.key === key)?.id;
    expect(plan.edges).toContainEqual({ from: id('PROJ-14'), to: id('PROJ-15') });

    // A cycle is refused by the core, with the reason; the proposal stays pending with it.
    const cyclic = await call(r, 'POST', `/api/plans/${planId}/proposals/${byText('PROJ-11 should wait on PROJ-13').id}/accept`);
    expect(cyclic.statusCode).toBe(409);
    expect(cyclic.json()).toMatchObject({ error: 'cycle' });
    expect(cyclic.json().message).toContain('cycle');
    const after = (await call(r, 'GET', `/api/plans/${planId}/proposals`)).json() as PlanEdgeProposal[];
    expect(after.find((entry) => entry.text === 'PROJ-11 should wait on PROJ-13')).toMatchObject({ state: 'pending', note: expect.stringContaining('cycle') });

    // Reject one; reject-all clears the rest.
    expect((await call(r, 'POST', `/api/plans/${planId}/proposals/${byText('PROJ-15 should wait on PROJ-12').id}/reject`)).statusCode).toBe(200);
    const cleared = (await call(r, 'POST', `/api/plans/${planId}/proposals/reject-all`)).json() as { proposals: PlanEdgeProposal[] };
    expect(cleared.proposals.map((entry) => entry.state)).toEqual(['accepted', 'rejected', 'rejected']);
    expect(((await call(r, 'GET', `/api/plans/${planId}`)).json() as Plan).edges).toHaveLength(4);

    // Propose order on demand (a draft plan): the session is asked again.
    expect((await call(r, 'POST', `/api/plans/${planId}/proposals/ask`)).json()).toEqual({ asked: true, sessionId: r.source.id });
    await until(async () => ((await r.s.store.events.list(r.source.id)).filter((event) => JSON.stringify(event.payload).includes('Please propose the missing order')).length === 2 ? true : undefined), 'the second ask', 20_000);
  });

  it('the tool is registered only while Plans is on', async () => {
    const r = await setup();
    const on = await helper(helperApi(r, r.source.id));
    expect(await on.list()).toContain('plan_propose_dependencies');
    await on.close();
    expect((await call(r, 'PUT', '/api/settings', { 'experimental.plans': false })).statusCode).toBe(200);
    await planServiceOf(r.app)?.switchChanged();
    const off = await helper(helperApi(r, r.source.id));
    expect((await off.list()).filter((name) => name.startsWith('plan_'))).toEqual([]);
    await off.close();
    expect((await call(r, 'GET', '/api/plans/x/proposals')).json().error).toBe('plans-off');
  });
});
