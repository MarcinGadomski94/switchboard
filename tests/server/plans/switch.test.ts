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
 * D99 · Plans is experimental (`docs/plans.md` → *The switch*): off by default (no
 * `plans.db`, no timers, 404 `plans-off`, no MCP plan tools), switched on through
 * `PUT /api/settings` (the file appears, the tools appear), and a broken `plans.db` answers
 * 503 on the plan routes while the rest of Switchboard works. Over the real app (`inject`).
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

async function setup(before?: (dataDir: string) => Promise<void>): Promise<Rig> {
  const root = await makeTempDir('plans-switch');
  const dataDir = path.join(root, 'data');
  const store = await openTempStore(dataDir);
  await before?.(dataDir);
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

describe('D99 · the Plans switch', () => {
  it('off by default: only the state answers, no plans.db, no timers, no plan tools', async () => {
    const r = await setup();
    expect((await ui(r, 'GET', '/api/settings')).json()['experimental.plans']).toBe(false);
    expect((await ui(r, 'GET', '/api/plans/state')).json()).toEqual<PlansState>({ enabled: false, available: false, problem: null });
    for (const [method, url] of [
      ['GET', '/api/plans'],
      ['POST', '/api/plans'],
      ['GET', '/api/plans/abc'],
      ['POST', '/api/plans/abc/start'],
    ] as const) {
      const answer = await ui(r, method, url, method === 'POST' ? {} : undefined);
      expect([method, url, answer.statusCode, answer.json().error]).toEqual([method, url, 404, 'plans-off']);
    }
    expect(await exists(path.join(r.dataDir, PLANS_DB_FILE))).toBe(false);
    expect(planServiceOf(r.app)?.activeTimers()).toBe(0);
    const sessionId = (await r.store.sessions.create({ name: 'agent', claudeSessionId: 'c-agent', attached: true })).id;
    expect((await helperApi(r, sessionId)('GET', '/agent/v1/plans')).status).toBe(404);
    expect((await toolsOf(helperApi(r, sessionId))).filter((name) => name.startsWith('plan_'))).toEqual([]);
    // The state route is classified like the others (phones and paired machines may read it).
    expect(isLocalOnly('GET', '/api/plans/state')).toBe(false);
    expect(peerApiAllowed('GET', '/api/plans/state')).toBe(true);
  });

  it('on: plans.db appears, the scheduler listens, the plan tools are registered; off again: they go', async () => {
    const r = await setup();
    expect((await ui(r, 'PUT', '/api/settings', { 'experimental.plans': true })).statusCode).toBe(200);
    expect((await ui(r, 'GET', '/api/plans/state')).json()).toEqual<PlansState>({ enabled: true, available: true, problem: null });
    expect(await exists(path.join(r.dataDir, PLANS_DB_FILE))).toBe(true);
    expect(planServiceOf(r.app)?.activeTimers()).toBe(2);
    expect((await ui(r, 'GET', '/api/plans')).json()).toEqual([]);
    const sessionId = (await r.store.sessions.create({ name: 'agent', claudeSessionId: 'c-agent', attached: true })).id;
    expect((await toolsOf(helperApi(r, sessionId))).filter((name) => name.startsWith('plan_'))).toEqual([...PLAN_TOOLS.map((tool) => tool.name), PLAN_PROPOSE_TOOL.name, PLAN_JIRA_CONTEXT_TOOL.name]);

    expect((await ui(r, 'PUT', '/api/settings', { 'experimental.plans': false })).statusCode).toBe(200);
    expect(planServiceOf(r.app)?.activeTimers()).toBe(0);
    expect((await ui(r, 'GET', '/api/plans')).statusCode).toBe(404);
    expect((await toolsOf(helperApi(r, sessionId))).filter((name) => name.startsWith('plan_'))).toEqual([]);
    // The file stays on disk (switching on again shows the plans as they were).
    expect(await exists(path.join(r.dataDir, PLANS_DB_FILE))).toBe(true);
  });

  it('a broken plans.db: the plan routes answer 503, everything else works', async () => {
    const r = await setup(async (dataDir) => {
      await writeFile(path.join(dataDir, PLANS_DB_FILE), 'this is not a database, just Acme notes\n'.repeat(200));
    });
    expect((await ui(r, 'PUT', '/api/settings', { 'experimental.plans': true })).statusCode).toBe(200);
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
