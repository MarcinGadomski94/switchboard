import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { InboxItem } from '../../../src/core/api.ts';
import type { SearchAnswer } from '../../../src/core/search.ts';
import type { TeamMember, TeamNeedsYouItem, TeamState, TeamView } from '../../../src/core/team.ts';
import { TEAM_TOOLS, registerTeamToolsIfMember } from '../../../src/core/team-tools.ts';
import { type AgentApi, createTodoServer } from '../../../src/hook/sb-mcp.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { isLocalOnly } from '../../../src/server/devices/local-only.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { TEAM_DB_FILE } from '../../../src/server/team/db.ts';
import { teamReviewGate } from '../../../src/server/team/hooks.ts';
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
    expect(view.activity.map((a) => a.text)).toEqual(expect.arrayContaining(['Tracker: Board triaged: 3 new.', 'Tracker handed off to Builder: Fix the flaky test.']));

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

  it('a member\'s review-card merge into the default branch waits for the developer (a Needs-you request)', async () => {
    const r = await setup();
    await ui(r, 'PUT', '/api/settings', { 'experimental.team': true });
    const dev = await session(r, 'dev-session');
    const member = (await ui(r, 'POST', '/api/team/members', { sessionId: dev, name: 'Developer', gates: ['merge-default-branch'] })).json() as TeamMember;
    expect(member.gates).toEqual(['outward-facing', 'merge-default-branch']);
    // A work branch merges freely; main waits.
    expect(await teamReviewGate(r.store, { reviewId: 'rev-1', sessionId: dev, action: 'merge', body: {}, bases: ['feature/x'] })).toBeNull();
    const refusal = await teamReviewGate(r.store, { reviewId: 'rev-1', sessionId: dev, action: 'merge', body: {}, bases: ['main'] });
    expect(refusal).toMatch(/Developer needs your approval to merge into main/);
    const needs = (await ui(r, 'GET', '/api/team/needs-you')).json() as TeamNeedsYouItem[];
    expect(needs.map((item) => [item.kind, item.title, item.request?.action])).toEqual([['gate', "Merge Developer's changes into main", { type: 'review-merge', reviewId: 'rev-1' }]]);
    // Asking again reuses the open request; Open PR or a plain session is never held.
    await teamReviewGate(r.store, { reviewId: 'rev-1', sessionId: dev, action: 'merge', body: {}, bases: ['main'] });
    expect(((await ui(r, 'GET', '/api/team/needs-you')).json() as unknown[]).length).toBe(1);
    expect(await teamReviewGate(r.store, { reviewId: 'rev-1', sessionId: dev, action: 'open-pr', body: {}, bases: ['main'] })).toBeNull();
    // Declined: closed, and the member is told.
    const declined = await ui(r, 'POST', `/api/team/requests/${needs[0]?.id}/decline`);
    expect(declined.json().state).toBe('declined');
    // Without the gate (removed), the merge goes ahead.
    await ui(r, 'PUT', `/api/team/members/${member.id}`, { gates: [] });
    expect(await teamReviewGate(r.store, { reviewId: 'rev-1', sessionId: dev, action: 'merge', body: {}, bases: ['main'] })).toBeNull();
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
      // D100 follow-up 2026-10-14: phones may reorder.
      ['PUT', '/api/team/order'],
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
    ] as const) {
      expect(peerApiAllowed(method, url), `${method} ${url}`).toBe(true);
    }
    // Never the state or Needs you (each machine derives its own).
    expect(peerApiAllowed('GET', '/api/team/needs-you')).toBe(false);
  });
});
