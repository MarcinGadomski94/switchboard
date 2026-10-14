import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { InboxItem } from '../../../src/core/api.ts';
import type { SearchAnswer } from '../../../src/core/search.ts';
import type { TeamMember, TeamNeedsYouItem, TeamState, TeamSummary, TeamView } from '../../../src/core/team.ts';
import { TEAM_TOOLS, registerTeamToolsIfMember } from '../../../src/core/team-tools.ts';
import { type AgentApi, createTodoServer } from '../../../src/hook/sb-mcp.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { isLocalOnly } from '../../../src/server/devices/local-only.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { TEAM_DB_FILE } from '../../../src/server/team/db.ts';
import { agentTokenFor } from '../../../src/server/todos/agent-token.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D100 over the real routes (`inject`, no CLI process): the switch through
 * `PUT /api/settings`, adopting by API, the Team MCP tools only in a member's
 * session (and their routes), the Inbox / search labels, Needs you derived from the
 * Inbox, the review-merge gate, and the routes' peer / device classification.
 */

const PORT = 4904;
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

async function setup(): Promise<Rig> {
  const root = await makeTempDir('team-api');
  const dataDir = path.join(root, 'data');
  const store = await openTempStore(dataDir);
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: dataDir }, platform: 'linux', home: root, cwd: root }), port: PORT };
  const token = generateToken();
  // `agentTools: false`: no session process starts here; the MCP helper is driven over inject below.
  const app = await buildApp({ config, token, store, webRoot: root, agentTools: false });
  await app.ready();
  rig = { root, store, app, token };
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

/** The helper's server for a session (with the Team hook as `sb-mcp.ts` runs it) and its tool names. */
async function toolsOf(api: AgentApi): Promise<string[]> {
  const server = createTodoServer(api);
  await registerTeamToolsIfMember(server, api);
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

async function session(r: Rig, name: string): Promise<string> {
  return (await r.store.sessions.create({ name, title: name, claudeSessionId: randomUUID(), attached: true })).id;
}

describe('D100 · the routes', () => {
  it('off: only the state answers; PUT /api/settings switches it on and team.db appears', async () => {
    const r = await setup();
    expect((await ui(r, 'GET', '/api/team/state')).json()).toEqual<TeamState>({ enabled: false, available: false, problem: null, hiddenSessionIds: [], roles: {} });
    const off = await ui(r, 'GET', '/api/team');
    expect([off.statusCode, off.json().error]).toEqual([404, 'team-off']);
    expect((await ui(r, 'GET', '/api/settings')).json()['experimental.team']).toBe(false);
    await expect(access(path.join(r.root, 'data', TEAM_DB_FILE))).rejects.toThrow();

    expect((await ui(r, 'PUT', '/api/settings', { 'experimental.team': true })).statusCode).toBe(200);
    expect((await ui(r, 'GET', '/api/team/state')).json()).toMatchObject({ enabled: true, available: true });
    await access(path.join(r.root, 'data', TEAM_DB_FILE));
    const view = (await ui(r, 'GET', '/api/team')).json() as TeamView;
    expect(view.team).toEqual({ id: 'team', name: 'Team' });
    expect(((await ui(r, 'GET', '/api/team/templates')).json() as Array<{ id: string }>).map((t) => t.id)).toEqual([
      'planner',
      'developer',
      'reviewer',
      'release-manager',
      'on-call',
      'delivery-tracking',
      'marketing-monitoring',
    ]);
  });

  it('the Team MCP tools exist only in a member\'s session, only while Team is on; they hand off, list and report', async () => {
    const r = await setup();
    const tracker = await session(r, 'tracker-session');
    const builder = await session(r, 'builder-session');
    const plain = await session(r, 'plain-session');
    // Off: nobody gets them.
    expect((await toolsOf(helperApi(r, tracker))).filter((name) => name.startsWith('team_'))).toEqual([]);
    await ui(r, 'PUT', '/api/settings', { 'experimental.team': true });
    const adopted = await ui(r, 'POST', '/api/team/members', { sessionId: tracker, name: 'Tracker', charter: { owns: 'the board' } });
    expect(adopted.statusCode, adopted.body).toBe(201);
    expect((await ui(r, 'POST', '/api/team/members', { sessionId: builder, name: 'Builder', rhythm: { onHandoff: false } })).statusCode).toBe(201);

    expect((await toolsOf(helperApi(r, tracker))).filter((name) => name.startsWith('team_'))).toEqual(TEAM_TOOLS.map((tool) => tool.name));
    expect((await toolsOf(helperApi(r, plain))).filter((name) => name.startsWith('team_'))).toEqual([]);
    // A plain session's token gets 404 from the agent routes too.
    expect((await helperApi(r, plain)('GET', '/agent/v1/team/members')).status).toBe(404);

    const api = helperApi(r, tracker);
    const listed = await api('GET', '/agent/v1/team/members');
    expect(String((listed.body as { text: string }).text)).toMatch(/- Tracker \(you\) · (idle|offline)/);
    const handed = await api('POST', '/agent/v1/team/handoffs', { to: 'Builder', brief: 'Fix the flaky test.', expected: 'Green CI.' });
    expect(handed.status).toBe(201);
    const todos = (await ui(r, 'GET', `/api/sessions/${builder}/todos`)).json() as { todos: Array<{ title: string }> };
    expect(todos.todos.map((t) => t.title)).toEqual(['Hand-off from Tracker: Fix the flaky test.']);
    expect((await api('POST', '/agent/v1/team/reports', { text: 'Board triaged: 3 new.' })).status).toBe(201);
    const view = (await ui(r, 'GET', '/api/team')).json() as TeamView;
    expect(view.activity.map((a) => a.text)).toEqual(expect.arrayContaining(['Board triaged: 3 new.', 'handed off to Builder: Fix the flaky test.']));

    // Off again: the tools go (the next start of the helper registers none) and the routes refuse.
    await ui(r, 'PUT', '/api/settings', { 'experimental.team': false });
    expect((await toolsOf(helperApi(r, tracker))).filter((name) => name.startsWith('team_'))).toEqual([]);
  });

  it('the Inbox and search label member sessions with the role; Needs you derives the members\' Inbox items', async () => {
    const r = await setup();
    await ui(r, 'PUT', '/api/settings', { 'experimental.team': true });
    const tracker = await session(r, 'tracker-session');
    const plain = await session(r, 'plain-session');
    const member = (await ui(r, 'POST', '/api/team/members', { sessionId: tracker, name: 'Tracker' })).json() as TeamMember;
    for (const sessionId of [tracker, plain]) {
      await r.store.permissions.create({ sessionId, requestId: `req-${sessionId}`, toolUseId: null, toolName: 'Bash', input: { command: 'ls' }, description: 'List files', decisionReason: null, agentId: null });
    }
    const inbox = (await ui(r, 'GET', '/api/inbox')).json() as InboxItem[];
    expect(inbox.map((item) => [item.sessionId === tracker ? 'tracker' : 'plain', item.sourceTitle, item.teamRole ?? null]).sort()).toEqual([
      ['plain', 'plain-session', null],
      ['tracker', 'Tracker', 'Tracker'],
    ]);
    const needs = (await ui(r, 'GET', '/api/team/needs-you')).json() as TeamNeedsYouItem[];
    expect(needs.map((item) => [item.source, item.kind, item.label, item.memberId])).toEqual([['inbox', 'permission', 'Tracker · permission', member.id]]);
    const found = (await ui(r, 'GET', '/api/search?q=tracker&scope=conversations')).json() as SearchAnswer;
    const titles = found.groups.flatMap((g) => g.results).filter((result) => 'sessionId' in result.target && result.target.sessionId === tracker);
    expect(titles.length).toBeGreaterThan(0);
    for (const result of titles) expect([result.teamRole, result.sessionTitle]).toEqual(['Tracker', 'Tracker']);
  });

  it('D102: a plan\'s "Ready to merge" item of a member\'s session shows in Needs you with Merge / Open plan; no review-merge gate is raised', async () => {
    const r = await setup();
    await ui(r, 'PUT', '/api/settings', { 'experimental.team': true });
    const dev = await session(r, 'dev-session');
    const member = (await ui(r, 'POST', '/api/team/members', { sessionId: dev, name: 'Developer', gates: ['merge-default-branch'] })).json() as TeamMember;
    expect(member.gates).toEqual(['outward-facing', 'merge-default-branch']);
    await r.store.systemItems.createOnceByPayload(
      {
        kind: 'plan-ready-to-merge',
        source: 'plans',
        status: 'need',
        title: 'Ready to merge: Fix the login (Acme epic)',
        detail: 'PROJ-1-fix → feature/PROJ-100',
        branches: [],
        actions: [
          { id: 'plan-merge', label: 'Merge' },
          { id: 'open-plan', label: 'Open plan' },
        ],
        sessionId: dev,
        payload: { dedupe: 'plan-merge:i1:t', planId: 'p1', itemId: 'i1', route: '/plans/p1' },
      },
      'dedupe',
      'plan-merge:i1:t',
    );
    const needs = (await ui(r, 'GET', '/api/team/needs-you')).json() as TeamNeedsYouItem[];
    expect(needs.map((item) => [item.source, item.kind, item.title])).toEqual([['inbox', 'system', 'Ready to merge: Fix the login (Acme epic)']]);
    expect((needs[0]?.inbox as { route?: string }).route).toBe('/plans/p1');
    // D100 follow-up 2026-10-14: a member of another team: its plan item shows in that team's Needs you and in All teams, labelled.
    const growth = (await ui(r, 'POST', '/api/team/teams', { name: 'Growth' })).json() as TeamSummary;
    expect((await ui(r, 'POST', `/api/team/members/${member.id}/team`, { teamId: growth.id })).statusCode).toBe(200);
    expect((await ui(r, 'GET', '/api/team/needs-you')).json()).toEqual([]);
    const ofGrowth = (await ui(r, 'GET', `/api/team/needs-you?teamId=${growth.id}`)).json() as TeamNeedsYouItem[];
    expect(ofGrowth.map((item) => [item.kind, item.title, item.teamName])).toEqual([['system', 'Ready to merge: Fix the login (Acme epic)', 'Growth']]);
    const all = (await ui(r, 'GET', '/api/team/needs-you?teamId=all')).json() as TeamNeedsYouItem[];
    expect(all.map((item) => [item.kind, item.title, item.teamName])).toEqual([['system', 'Ready to merge: Fix the login (Acme epic)', 'Growth']]);
  });

  it('D100 follow-up 2026-10-14: the members\' order is stored, a new member goes last, PUT /api/team/order reorders and survives a reopen', async () => {
    const r = await setup();
    await ui(r, 'PUT', '/api/settings', { 'experimental.team': true });
    const ids: string[] = [];
    for (const name of ['Alpha', 'Bravo', 'Charlie']) {
      const answer = await ui(r, 'POST', '/api/team/members', { sessionId: await session(r, `${name.toLowerCase()}-session`), name });
      expect(answer.statusCode, answer.body).toBe(201);
      ids.push((answer.json() as TeamMember).id);
    }
    const names = async (): Promise<string[]> => ((await ui(r, 'GET', '/api/team')).json() as TeamView).members.map((m) => m.name);
    expect(await names()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(((await ui(r, 'GET', '/api/team')).json() as TeamView).members.map((m) => m.order)).toEqual([0, 1, 2]);

    // Charlie first; the ids left out keep their relative order after it.
    const reordered = await ui(r, 'PUT', '/api/team/order', { memberIds: [ids[2]] });
    expect(reordered.statusCode, reordered.body).toBe(200);
    expect((reordered.json() as TeamView).members.map((m) => m.name)).toEqual(['Charlie', 'Alpha', 'Bravo']);
    // Unknown or repeated ids are refused, nothing changes.
    expect((await ui(r, 'PUT', '/api/team/order', { memberIds: ['nope'] })).statusCode).toBe(422);
    expect((await ui(r, 'PUT', '/api/team/order', { memberIds: [ids[0], ids[0]] })).statusCode).toBe(422);
    expect(await names()).toEqual(['Charlie', 'Alpha', 'Bravo']);

    // A new member goes to the end.
    expect((await ui(r, 'POST', '/api/team/members', { sessionId: await session(r, 'delta-session'), name: 'Delta' })).statusCode).toBe(201);
    expect(await names()).toEqual(['Charlie', 'Alpha', 'Bravo', 'Delta']);

    // Stored in team.db: switching Team off closes the file, on again reads the same order.
    await ui(r, 'PUT', '/api/settings', { 'experimental.team': false });
    await ui(r, 'PUT', '/api/settings', { 'experimental.team': true });
    expect(await names()).toEqual(['Charlie', 'Alpha', 'Bravo', 'Delta']);
    // The sync message carries it (part of the team definition).
    const message = (await ui(r, 'POST', '/api/team/sync', {})).json() as { snapshot: { members: Array<{ name: string; order: number | null }> } };
    expect(message.snapshot.members.map((m) => [m.name, m.order]).sort()).toEqual([['Alpha', 1], ['Bravo', 2], ['Charlie', 0], ['Delta', 3]]);
  });

  it('D100 follow-up 2026-10-14 · teams: create, rename, reorder, delete (its members return); the first team stays and the old routes act on it', async () => {
    const r = await setup();
    await ui(r, 'PUT', '/api/settings', { 'experimental.team': true });
    const teams = async (): Promise<TeamSummary[]> => (await ui(r, 'GET', '/api/team/teams')).json() as TeamSummary[];
    expect((await teams()).map((t) => [t.id, t.name, t.members])).toEqual([['team', 'Team', 0]]);

    const made = await ui(r, 'POST', '/api/team/teams', { name: 'Growth' });
    expect(made.statusCode, made.body).toBe(201);
    const growth = made.json() as TeamSummary;
    expect((await ui(r, 'POST', '/api/team/teams', { name: 'growth' })).json().error).toBe('name-taken');
    expect((await ui(r, 'POST', '/api/team/teams', { name: '' })).statusCode).toBe(422);

    // Members join a team by id; without one, the first team (the old body).
    const seo = (await ui(r, 'POST', '/api/team/members', { sessionId: await session(r, 'seo-session'), name: 'SEO', teamId: growth.id })).json() as TeamMember;
    const ads = (await ui(r, 'POST', '/api/team/members', { sessionId: await session(r, 'ads-session'), name: 'Ads', teamId: growth.id })).json() as TeamMember;
    const devSession = await session(r, 'dev-session');
    const dev = (await ui(r, 'POST', '/api/team/members', { sessionId: devSession, name: 'Developer' })).json() as TeamMember;
    expect([seo.teamId, ads.teamId, dev.teamId]).toEqual([growth.id, growth.id, 'team']);
    expect((await ui(r, 'POST', '/api/team/members', { sessionId: await session(r, 'x'), name: 'X', teamId: 'nope' })).statusCode).toBe(422);
    expect((await teams()).map((t) => [t.name, t.members])).toEqual([['Team', 1], ['Growth', 2]]);

    // The old routes: the first team.
    expect(((await ui(r, 'GET', '/api/team')).json() as TeamView).members.map((m) => m.name)).toEqual(['Developer']);
    expect(((await ui(r, 'GET', `/api/team?teamId=${growth.id}`)).json() as TeamView).members.map((m) => m.name)).toEqual(['SEO', 'Ads']);
    expect((await ui(r, 'PUT', '/api/team', { name: 'Core' })).json().team).toEqual({ id: 'team', name: 'Core' });
    expect((await ui(r, 'PUT', `/api/team/teams/${growth.id}`, { name: 'Growth squad' })).json().team).toEqual({ id: growth.id, name: 'Growth squad' });
    expect((await ui(r, 'GET', '/api/team?teamId=nope')).statusCode).toBe(404);
    // Reorder the members within Growth, and the teams.
    expect(((await ui(r, 'PUT', '/api/team/order', { teamId: growth.id, memberIds: [ads.id, seo.id] })).json() as TeamView).members.map((m) => m.name)).toEqual(['Ads', 'SEO']);
    expect(((await ui(r, 'PUT', '/api/team/teams/order', { teamIds: [growth.id] })).json() as TeamSummary[]).map((t) => t.name)).toEqual(['Growth squad', 'Core']);

    // Every member's session is hidden, whatever its team.
    expect([...((await ui(r, 'GET', '/api/team/state')).json() as TeamState).hiddenSessionIds].sort()).toEqual([seo.sessionId, ads.sessionId, dev.sessionId].sort());
    // Growth is deleted: its members go back to the list, no session is deleted.
    const deleted = await ui(r, 'DELETE', `/api/team/teams/${growth.id}`);
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json()).toEqual({ ok: true, returned: 2 });
    expect((await teams()).map((t) => t.name)).toEqual(['Core']);
    expect(((await ui(r, 'GET', '/api/team/state')).json() as TeamState).hiddenSessionIds).toEqual([dev.sessionId]);
    for (const id of [seo.sessionId, ads.sessionId]) expect((await r.store.sessions.get(id))?.closedAt).toBeNull();
    expect((await ui(r, 'GET', `/api/team?teamId=${growth.id}`)).statusCode).toBe(404);
    // The last team cannot be deleted.
    expect((await ui(r, 'DELETE', '/api/team/teams/team')).json().error).toBe('last-team');
  });

  it('D100 follow-up 2026-10-14 · the first team is deletable once another exists; the old routes then act on the first remaining team', async () => {
    const r = await setup();
    await ui(r, 'PUT', '/api/settings', { 'experimental.team': true });
    const devSession = await session(r, 'dev-session');
    const dev = (await ui(r, 'POST', '/api/team/members', { sessionId: devSession, name: 'Developer' })).json() as TeamMember;
    const ops = (await ui(r, 'POST', '/api/team/teams', { name: 'Ops' })).json() as TeamSummary;
    const growth = (await ui(r, 'POST', '/api/team/teams', { name: 'Growth' })).json() as TeamSummary;
    // Growth before Ops: the first remaining team after `team` is Growth.
    await ui(r, 'PUT', '/api/team/teams/order', { teamIds: ['team', growth.id, ops.id] });

    const deleted = await ui(r, 'DELETE', '/api/team/teams/team');
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json()).toEqual({ ok: true, returned: 1 });
    expect(((await ui(r, 'GET', '/api/team/teams')).json() as TeamSummary[]).map((t) => t.name)).toEqual(['Growth', 'Ops']);
    // Its member is back in the session list (not hidden, the session kept).
    expect(((await ui(r, 'GET', '/api/team/state')).json() as TeamState).hiddenSessionIds).toEqual([]);
    expect((await r.store.sessions.get(dev.sessionId))?.closedAt).toBeNull();
    // The old single-team routes: the first remaining team.
    expect(((await ui(r, 'GET', '/api/team')).json() as TeamView).team).toEqual({ id: growth.id, name: 'Growth' });
    expect((await ui(r, 'POST', '/api/team/members', { sessionId: devSession, name: 'Developer' })).json().teamId).toBe(growth.id);
    expect(((await ui(r, 'PUT', '/api/team', { name: 'Growth squad' })).json() as TeamView).team).toEqual({ id: growth.id, name: 'Growth squad' });
    expect(((await ui(r, 'GET', '/api/team/needs-you')).json() as unknown[]).length).toBe(0);
    expect((await ui(r, 'GET', '/api/team?teamId=team')).statusCode).toBe(404);
    // Reordered, the old routes follow the order.
    await ui(r, 'PUT', '/api/team/teams/order', { teamIds: [ops.id] });
    expect(((await ui(r, 'GET', '/api/team')).json() as TeamView).team.id).toBe(ops.id);
    // Switching Team off and on again does not bring the deleted first team back.
    await ui(r, 'PUT', '/api/settings', { 'experimental.team': false });
    await ui(r, 'PUT', '/api/settings', { 'experimental.team': true });
    expect(((await ui(r, 'GET', '/api/team/teams')).json() as TeamSummary[]).map((t) => t.name)).toEqual(['Ops', 'Growth squad']);
  });

  it('D100 follow-up 2026-10-14 · a model chosen in a member\'s session header becomes the member\'s saved model (and syncs); a plain session\'s does nothing', async () => {
    const r = await setup();
    await ui(r, 'PUT', '/api/settings', { 'experimental.team': true });
    const devSession = await session(r, 'dev-session');
    const plain = await session(r, 'plain-session');
    const dev = (await ui(r, 'POST', '/api/team/members', { sessionId: devSession, name: 'Developer' })).json() as TeamMember;
    const changed = await ui(r, 'PUT', `/api/sessions/${devSession}/model`, { model: 'opus', effort: 'high' });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((await ui(r, 'GET', `/api/team/members/${dev.id}`)).json()).toMatchObject({ model: 'opus', effort: 'high' });
    // Back to the CLI's default: saved as `default`.
    await ui(r, 'PUT', `/api/sessions/${devSession}/model`, { model: 'default', effort: null });
    expect((await ui(r, 'GET', `/api/team/members/${dev.id}`)).json()).toMatchObject({ model: 'default', effort: null });
    // It is the synced record (the paired machine gets it with the next exchange).
    const message = (await ui(r, 'POST', '/api/team/sync', {})).json() as { snapshot: { members: Array<{ id: string; model: string | null }> } };
    expect(message.snapshot.members.find((m) => m.id === dev.id)?.model).toBe('default');
    expect((await ui(r, 'PUT', `/api/sessions/${plain}/model`, { model: 'opus' })).statusCode).toBe(200);
    expect(((await ui(r, 'GET', '/api/team')).json() as TeamView).members.map((m) => m.model)).toEqual(['default']);
  });

  it('D100 follow-up 2026-10-14 · one team per session; a member moves to another team keeping its setup; Needs you per team and for all', async () => {
    const r = await setup();
    await ui(r, 'PUT', '/api/settings', { 'experimental.team': true });
    const growth = (await ui(r, 'POST', '/api/team/teams', { name: 'Growth' })).json() as TeamSummary;
    const trackerSession = await session(r, 'tracker-session');
    const tracker = (await ui(r, 'POST', '/api/team/members', { sessionId: trackerSession, name: 'Tracker', charter: { owns: 'the board' }, budget: { dailyPct: 20, profileId: null } })).json() as TeamMember;
    const again = await ui(r, 'POST', '/api/team/members', { sessionId: trackerSession, name: 'Tracker 2', teamId: growth.id });
    expect([again.statusCode, again.json().error]).toEqual([409, 'already-member']);
    expect(again.json().message).toContain('team Team');

    // Move to Growth: the end of its order, charter and budget kept, the activity in both teams.
    const ads = (await ui(r, 'POST', '/api/team/members', { sessionId: await session(r, 'ads-session'), name: 'Ads', teamId: growth.id })).json() as TeamMember;
    const moved = await ui(r, 'POST', `/api/team/members/${tracker.id}/team`, { teamId: growth.id });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({ teamId: growth.id, order: 1, charter: { owns: 'the board' }, budget: { dailyPct: 20 } });
    expect(((await ui(r, 'GET', `/api/team?teamId=${growth.id}`)).json() as TeamView).members.map((m) => m.name)).toEqual(['Ads', 'Tracker']);
    expect(((await ui(r, 'GET', '/api/team')).json() as TeamView).members).toEqual([]);
    expect(((await ui(r, 'GET', '/api/team')).json() as TeamView).activity.map((a) => a.text)).toContain('moved to team Growth');
    expect(((await ui(r, 'GET', `/api/team?teamId=${growth.id}`)).json() as TeamView).activity.map((a) => a.text)).toContain('joined from team Team');
    expect((await ui(r, 'POST', `/api/team/members/${tracker.id}/team`, { teamId: 'nope' })).statusCode).toBe(404);

    // Needs you: per team, and every team's with `all` (labelled with the team).
    const devSession = await session(r, 'dev-session');
    const dev = (await ui(r, 'POST', '/api/team/members', { sessionId: devSession, name: 'Developer' })).json() as TeamMember;
    for (const sessionId of [trackerSession, devSession]) {
      await r.store.permissions.create({ sessionId, requestId: `req-${sessionId}`, toolUseId: null, toolName: 'Bash', input: { command: 'ls' }, description: 'List files', decisionReason: null, agentId: null });
    }
    const of = async (query: string) => ((await ui(r, 'GET', `/api/team/needs-you${query}`)).json() as TeamNeedsYouItem[]).map((item) => [item.memberName, item.teamName]);
    expect(await of('')).toEqual([['Developer', 'Team']]);
    expect(await of(`?teamId=${growth.id}`)).toEqual([['Tracker', 'Growth']]);
    expect((await of('?teamId=all')).sort()).toEqual([['Developer', 'Team'], ['Tracker', 'Growth']]);
    expect(((await ui(r, 'GET', '/api/team/teams')).json() as TeamSummary[]).map((t) => [t.name, t.needsYou])).toEqual([['Team', 1], ['Growth', 1]]);

    // Hand-offs: within the sender's team by default; another team's member as "Role (Team)" or with `team`.
    const api = helperApi(r, devSession);
    const own = await api('POST', '/agent/v1/team/handoffs', { to: 'Ads', brief: 'Check the campaign.' });
    expect(own.status).toBe(404);
    expect(String((own.body as { message: string }).message)).toContain('"Ads (Growth)"');
    expect((await api('POST', '/agent/v1/team/handoffs', { to: 'Ads (Growth)', brief: 'Check the campaign.', expected: 'Numbers.' })).status).toBe(201);
    expect((await api('POST', '/agent/v1/team/handoffs', { to: 'Tracker', team: 'growth', brief: 'Track it.', expected: '' })).status).toBe(201);
    const growthView = (await ui(r, 'GET', `/api/team?teamId=${growth.id}`)).json() as TeamView;
    expect(growthView.handoffs.map((h) => [h.fromMemberId, h.toMemberId, h.teamId]).sort()).toEqual([[dev.id, ads.id, growth.id], [dev.id, tracker.id, growth.id]].sort());
    expect(growthView.activity.map((a) => a.text)).toContain('got a hand-off from Developer (Team): Check the campaign.');
    const listed = String(((await api('GET', '/agent/v1/team/members')).body as { text: string }).text);
    expect(listed).toContain('Team Team: 1 member.');
    expect(listed).toContain('Other teams: Growth (2)');
    expect(String(((await api('GET', '/agent/v1/team/members?team=Growth')).body as { text: string }).text)).toContain('Team Growth: 2 members.');
    // Suggestions leave out every team's sessions.
    const suggested = ((await ui(r, 'GET', '/api/team/suggestions')).json() as Array<{ sessionId: string }>).map((s) => s.sessionId);
    for (const id of [trackerSession, devSession, ads.sessionId]) expect(suggested).not.toContain(id);
  });

  it('D100 follow-up 2026-10-14 · drag to move between teams: Undo (move back, then the old order) restores the team and the place; its own team is a no-op', async () => {
    const r = await setup();
    await ui(r, 'PUT', '/api/settings', { 'experimental.team': true });
    const growth = (await ui(r, 'POST', '/api/team/teams', { name: 'Growth' })).json() as TeamSummary;
    const ids: string[] = [];
    for (const name of ['Alpha', 'Bravo', 'Charlie']) ids.push(((await ui(r, 'POST', '/api/team/members', { sessionId: await session(r, `${name.toLowerCase()}-move`), name })).json() as TeamMember).id);
    const names = async (teamId?: string): Promise<string[]> => ((await ui(r, 'GET', teamId ? `/api/team?teamId=${teamId}` : '/api/team')).json() as TeamView).members.map((m) => m.name);
    const before = [...ids];

    // Bravo dropped on Growth's tab; its own team is no move (nothing changes, no activity line).
    expect((await ui(r, 'POST', `/api/team/members/${ids[1]}/team`, { teamId: growth.id })).statusCode).toBe(200);
    expect(await names()).toEqual(['Alpha', 'Charlie']);
    expect(await names(growth.id)).toEqual(['Bravo']);
    const lines = ((await ui(r, 'GET', `/api/team?teamId=${growth.id}`)).json() as TeamView).activity.length;
    const same = await ui(r, 'POST', `/api/team/members/${ids[1]}/team`, { teamId: growth.id });
    expect(same.json()).toMatchObject({ teamId: growth.id });
    expect(((await ui(r, 'GET', `/api/team?teamId=${growth.id}`)).json() as TeamView).activity.length).toBe(lines);

    // Undo: back to Team (at its end), then Team's order as it was.
    expect((await ui(r, 'POST', `/api/team/members/${ids[1]}/team`, { teamId: 'team' })).statusCode).toBe(200);
    expect(await names()).toEqual(['Alpha', 'Charlie', 'Bravo']);
    expect((await ui(r, 'PUT', '/api/team/order', { memberIds: before, teamId: 'team' })).statusCode).toBe(200);
    expect(await names()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(await names(growth.id)).toEqual([]);
    expect(((await ui(r, 'GET', '/api/team')).json() as TeamView).members.map((m) => m.order)).toEqual([0, 1, 2]);
  });

  it('every Team route is classified for devices; the peer API serves what a paired machine needs', () => {
    // Phones read, answer, pause / resume, give tasks, adopt / return / remove.
    for (const [method, url] of [
      ['GET', '/api/team/state'],
      ['GET', '/api/team'],
      ['GET', '/api/team/needs-you'],
      ['POST', '/api/team/members'],
      ['POST', '/api/team/members/m1/pause'],
      ['POST', '/api/team/members/m1/resume'],
      ['POST', '/api/team/members/m1/return'],
      ['DELETE', '/api/team/members/m1'],
      ['POST', '/api/team/handoffs'],
      ['POST', '/api/team/requests/q1/approve'],
      // D100 follow-up 2026-10-14: phones may reorder, and list / create / order / delete teams and move a member between them.
      ['PUT', '/api/team/order'],
      ['GET', '/api/team/teams'],
      ['POST', '/api/team/teams'],
      ['PUT', '/api/team/teams/order'],
      ['DELETE', '/api/team/teams/t1'],
      ['POST', '/api/team/members/m1/team'],
      ['GET', '/api/team/needs-you?teamId=all'],
    ] as const) {
      expect(isLocalOnly(method, url), `${method} ${url}`).toBe(false);
    }
    // Configuration, moves (take-over: desktop only) and the machines' exchange are not for phones.
    for (const [method, url] of [
      ['PUT', '/api/team'],
      ['PUT', '/api/team/members/m1'],
      ['POST', '/api/team/members/m1/move'],
      ['POST', '/api/team/members/m1/move/check'],
      ['POST', '/api/team/sync'],
      // Renaming a team stays a desktop setting, like renaming the first one.
      ['PUT', '/api/team/teams/t1'],
    ] as const) {
      expect(isLocalOnly(method, url), `${method} ${url}`).toBe(true);
    }
    for (const [method, url] of [
      ['POST', '/api/team/sync'],
      ['POST', '/api/team/members/m1/pause'],
      ['POST', '/api/team/members/m1/move'],
      ['POST', '/api/team/requests/q1/approve'],
      ['GET', '/api/team/moves/r1'],
      ['PUT', '/api/team/order'],
      ['GET', '/api/team/teams'],
      ['POST', '/api/team/teams'],
      ['PUT', '/api/team/teams/t1'],
      ['DELETE', '/api/team/teams/t1'],
      ['POST', '/api/team/members/m1/team'],
    ] as const) {
      expect(peerApiAllowed(method, url), `${method} ${url}`).toBe(true);
    }
    // Never the state or Needs you (each machine derives its own).
    expect(peerApiAllowed('GET', '/api/team/needs-you')).toBe(false);
  });
});
