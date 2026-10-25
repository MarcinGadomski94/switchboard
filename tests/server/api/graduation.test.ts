import path from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY_TOOLS } from '../../../src/core/memory.ts';
import { PLAN_TOOLS } from '../../../src/core/plans.ts';
import { TEAM_TOOLS } from '../../../src/core/team-tools.ts';
import { FeatureTools } from '../../../src/hook/sb-feature-tools.ts';
import { type AgentApi, createTodoServer } from '../../../src/hook/sb-mcp.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { GRADUATED_SWITCH_KEYS, forgetGraduatedSwitches } from '../../../src/server/settings/graduated.ts';
import { agentTokenFor } from '../../../src/server/todos/agent-token.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D132 · Team, Plans and Project memory graduated in 2.0: always on, whatever a 1.x install
 * stored for their Settings → Experimental switches (deleted at start). With no team members,
 * no plans and no memory entries nothing changes for sessions: every session is listed, none is
 * hidden, no Inbox item appears. The feature tools register per session as their probes say.
 * Over the real app (`inject`).
 */

const PORT = 4948; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

interface Rig {
  readonly root: string;
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

async function setup(stored?: Record<string, unknown>): Promise<Rig> {
  const root = await makeTempDir('graduation');
  const dataDir = path.join(root, 'data');
  const store = await openTempStore(dataDir);
  if (stored) await store.settings.setMany(stored);
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: dataDir }, platform: 'linux', home: root, cwd: root }), port: PORT };
  const token = generateToken();
  const app = await buildApp({ config, token, store, webRoot: root, agentTools: false });
  await app.ready();
  rig = { root, store, app, token };
  return rig;
}

function ui(r: Rig, method: InjectOptions['method'], url: string): Promise<LightMyRequestResponse> {
  return r.app.inject({ method, url, headers: { host: HOST, cookie: `sb_token=${r.token}` } });
}

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

async function states(r: Rig): Promise<unknown[]> {
  return Promise.all(['/api/team/state', '/api/plans/state', '/api/memory/state'].map(async (url) => (await ui(r, 'GET', url)).json()));
}

describe('D132 · Team, Plans and Project memory are always on', () => {
  it('a fresh install: all three available, no Experimental switch in Settings', async () => {
    const r = await setup();
    expect(await states(r)).toEqual([
      expect.objectContaining({ enabled: true, available: true, problem: null, hiddenSessionIds: [] }),
      { enabled: true, available: true, problem: null },
      expect.objectContaining({ enabled: true, available: true, problem: null }),
    ]);
    const settings = (await ui(r, 'GET', '/api/settings')).json() as Record<string, unknown>;
    expect(Object.keys(settings).filter((key) => key.startsWith('experimental.'))).toEqual([]);
  });

  it('an install with the 1.x switches off (or on): all three available after the start, the stored switches deleted', async () => {
    for (const value of [false, true]) {
      const r = await setup({ 'experimental.team': value, 'experimental.plans': value, 'experimental.memory': value, 'ui.sidebarHidden': true });
      for (const key of GRADUATED_SWITCH_KEYS) expect(await r.store.settings.get(key)).toBeUndefined();
      // Other settings are untouched.
      expect(await r.store.settings.get('ui.sidebarHidden')).toBe(true);
      expect((await states(r)).map((state) => (state as { available: boolean }).available)).toEqual([true, true, true]);
      await rig?.app.close();
      await rig?.store.close();
      if (rig) await removeTempDir(rig.root);
      rig = undefined;
    }
  });

  it('forgetGraduatedSwitches deletes only the three keys, answers the ones it found and never throws', async () => {
    const rows = new Map<string, unknown>([['experimental.plans', false], ['ui.sidebarHidden', true]]);
    const removed = await forgetGraduatedSwitches({ delete: async (key) => rows.delete(key) });
    expect(removed).toEqual(['experimental.plans']);
    expect([...rows.keys()]).toEqual(['ui.sidebarHidden']);
    expect(await forgetGraduatedSwitches({ delete: async () => Promise.reject(new Error('locked')) })).toEqual([]);
  });

  it('no teams, plans or notes: nothing changes for sessions (none hidden, no Inbox item, no memory block)', async () => {
    const r = await setup({ 'experimental.team': false, 'experimental.plans': false, 'experimental.memory': false });
    const workspace = path.join(r.root, 'acme-workspace');
    const a = await r.store.sessions.create({ name: 'acme-one', claudeSessionId: 'c-acme-one', attached: true, root: workspace, rootKind: 'workspace', cwd: workspace });
    const b = await r.store.sessions.create({ name: 'acme-two', claudeSessionId: 'c-acme-two', attached: true });
    const listed = ((await ui(r, 'GET', '/api/sessions')).json() as Array<{ id: string }>).map((session) => session.id);
    expect(listed.sort()).toEqual([a.id, b.id].sort());
    expect(((await ui(r, 'GET', '/api/team/state')).json() as { hiddenSessionIds: string[] }).hiddenSessionIds).toEqual([]);
    expect((await ui(r, 'GET', '/api/inbox')).json()).toEqual([]);
    expect((await ui(r, 'GET', '/api/plans')).json()).toEqual([]);
    expect((await ui(r, 'GET', '/api/memory/entries')).json()).toEqual([]);
    // The agent's memory list is empty: nothing to inject.
    expect((await helperApi(r, a.id)('GET', '/agent/v1/memory')).body).toMatchObject({ entries: [] });
  });

  it('the feature tools register as their probes say: plans and memory for a session with a folder, team only for a member', async () => {
    const r = await setup({ 'experimental.team': false, 'experimental.plans': false, 'experimental.memory': false });
    const workspace = path.join(r.root, 'acme-workspace');
    const session = await r.store.sessions.create({ name: 'acme-agent', claudeSessionId: 'c-acme-agent', attached: true, root: workspace, rootKind: 'workspace', cwd: workspace });
    const api = helperApi(r, session.id);
    const features = new FeatureTools(createTodoServer(api), api);
    await features.refresh();
    expect(features.active()).toEqual(['plans', 'memory']);
    expect(features.unavailable(TEAM_TOOLS[0]!.name)).toMatch(/not a team member/);
    expect(features.unavailable(PLAN_TOOLS[0]!.name)).toBeNull();
    expect(features.unavailable(MEMORY_TOOLS[0]!.name)).toBeNull();
  });
});
