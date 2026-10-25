import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { PLAN_TOOLS, type PlansState } from '../../../src/core/plans.ts';
import { PLAN_PROPOSE_TOOL } from '../../../src/core/plans-jira.ts';
import { PLAN_JIRA_CONTEXT_TOOL } from '../../../src/core/plans-jira-context.ts';
import { type AgentApi, createTodoServer } from '../../../src/hook/sb-mcp.ts';
import { registerPlanToolsIfOn } from '../../../src/hook/sb-plan-tools.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { isLocalOnly } from '../../../src/server/devices/local-only.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { PLANS_DB_FILE } from '../../../src/server/plans/db.ts';
import { planServiceOf } from '../../../src/server/plans/install.ts';
import { agentTokenFor } from '../../../src/server/todos/agent-token.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D132 · Plans graduated in 2.0 (`docs/plans-removal.md`): always on, no switch. A fresh install
 * opens `plans.db` at start (timers, MCP plan tools); an install whose 1.x switch was off gets
 * Plans all the same and its stored switch is deleted; a broken `plans.db` answers 503 on the
 * plan routes while the rest of Switchboard works. Over the real app (`inject`).
 */

const PORT = 4946; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

interface Rig {
  readonly root: string;
  readonly dataDir: string;
  readonly store: Store;
  readonly app: FastifyInstance;
  readonly token: string;
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.app.close();
  await rig?.store.close();
  if (rig) await removeTempDir(rig.root);
  rig = undefined;
});

async function setup(before?: (dataDir: string, store: Store) => Promise<void>): Promise<Rig> {
  const root = await makeTempDir('plans-switch');
  const dataDir = path.join(root, 'data');
  const store = await openTempStore(dataDir);
  await before?.(dataDir, store);
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: dataDir }, platform: 'linux', home: root, cwd: root }), port: PORT };
  const token = generateToken();
  const app = await buildApp({ config, token, store, webRoot: root, agentTools: false });
  await app.ready();
  rig = { root, dataDir, store, app, token };
  return rig;
}

function ui(r: Rig, method: InjectOptions['method'], url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  return r.app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${r.token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

/** The MCP helper's API over `inject`, as session `sessionId` with its own agent token. */
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

/** The helper's tool names for a session, with the Plans hook as `sb-mcp.ts` runs it. */
async function toolsOf(api: AgentApi): Promise<string[]> {
  const server = createTodoServer(api);
  await registerPlanToolsIfOn(server, api);
  const [client, transport] = InMemoryTransport.createLinkedPair();
  await server.connect(transport);
  const answered = new Promise<Record<string, unknown>>((resolve) => {
    client.onmessage = (message: JSONRPCMessage) => {
      const answer = message as Record<string, unknown>;
      if (answer['id'] === 1) resolve(answer);
    };
  });
  await client.start();
  await client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' } as JSONRPCMessage);
  const result = (await answered)['result'] as { tools: Array<{ name: string }> };
  await server.close();
  return result.tools.map((tool) => tool.name);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

describe('D132 · Plans is always on', () => {
  it('a fresh install: plans.db appears, the scheduler listens, the plan tools are registered, no switch in Settings', async () => {
    const r = await setup();
    expect('experimental.plans' in (await ui(r, 'GET', '/api/settings')).json()).toBe(false);
    expect((await ui(r, 'GET', '/api/plans/state')).json()).toEqual<PlansState>({ enabled: true, available: true, problem: null });
    expect(await exists(path.join(r.dataDir, PLANS_DB_FILE))).toBe(true);
    expect(planServiceOf(r.app)?.activeTimers()).toBe(2);
    expect((await ui(r, 'GET', '/api/plans')).json()).toEqual([]);
    const sessionId = (await r.store.sessions.create({ name: 'agent', claudeSessionId: 'c-agent', attached: true })).id;
    expect((await helperApi(r, sessionId)('GET', '/agent/v1/plans')).status).toBe(200);
    expect((await toolsOf(helperApi(r, sessionId))).filter((name) => name.startsWith('plan_'))).toEqual([...PLAN_TOOLS.map((tool) => tool.name), PLAN_PROPOSE_TOOL.name, PLAN_JIRA_CONTEXT_TOOL.name]);
    // The old switch is no setting any more.
    expect((await ui(r, 'PUT', '/api/settings', { 'experimental.plans': false })).statusCode).toBe(422);
    // The state route is classified like the others (phones and paired machines may read it).
    expect(isLocalOnly('GET', '/api/plans/state')).toBe(false);
    expect(peerApiAllowed('GET', '/api/plans/state')).toBe(true);
    // D131 (lane X): a paired computer's project reads its epic's Jira text through the proxy.
    expect(isLocalOnly('GET', '/api/plans/p1/jira/context')).toBe(false);
    expect(peerApiAllowed('GET', '/api/plans/p1/jira/context?item=i1&part=description')).toBe(true);
  });

  it('an install whose 1.x switch was off: Plans is on after the start and the stored switch is gone', async () => {
    const r = await setup(async (_dataDir, store) => {
      await store.settings.set('experimental.plans', false);
    });
    expect(await r.store.settings.get('experimental.plans')).toBeUndefined();
    expect((await ui(r, 'GET', '/api/plans/state')).json()).toEqual<PlansState>({ enabled: true, available: true, problem: null });
    expect((await ui(r, 'GET', '/api/plans')).statusCode).toBe(200);
    expect(planServiceOf(r.app)?.activeTimers()).toBe(2);
  });

  it('no plans: nothing changes for sessions (no Inbox items, every session listed)', async () => {
    const r = await setup();
    await r.store.sessions.create({ name: 'acme', claudeSessionId: 'c-acme', attached: true });
    expect(((await ui(r, 'GET', '/api/sessions')).json() as unknown[]).length).toBe(1);
    expect((await ui(r, 'GET', '/api/inbox')).json()).toEqual([]);
  });

  it('a broken plans.db: the plan routes answer 503, everything else works', async () => {
    const r = await setup(async (dataDir) => {
      await writeFile(path.join(dataDir, PLANS_DB_FILE), 'this is not a database, just Acme notes\n'.repeat(200));
    });
    const state = (await ui(r, 'GET', '/api/plans/state')).json() as PlansState;
    expect(state).toMatchObject({ enabled: true, available: false });
    expect(state.problem).toMatch(/^plans\.db could not be opened: /);
    const list = await ui(r, 'GET', '/api/plans');
    expect([list.statusCode, list.json().error]).toEqual([503, 'plans-unavailable']);
    expect(planServiceOf(r.app)?.activeTimers()).toBe(0);
    // The rest of Switchboard.
    expect((await ui(r, 'GET', '/api/sessions')).statusCode).toBe(200);
    expect((await ui(r, 'GET', '/api/settings')).statusCode).toBe(200);
    expect((await ui(r, 'GET', '/api/todos')).statusCode).toBe(200);
    const sessionId = (await r.store.sessions.create({ name: 'agent', claudeSessionId: 'c-agent', attached: true })).id;
    expect((await toolsOf(helperApi(r, sessionId))).filter((name) => name.startsWith('plan_'))).toEqual([]);
  });
});
