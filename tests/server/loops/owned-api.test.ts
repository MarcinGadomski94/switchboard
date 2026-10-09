import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { OwnedLoop, Session, SessionDetail, TerminalSession } from '../../../src/core/api.ts';
import type { TerminalAgentRow } from '../../../src/core/hooks.ts';
import type { UserPayload } from '../../../src/core/event-payload.ts';
import { mapPeerAnswer, peerAnswerKind, peerSession } from '../../../src/core/peer-wire.ts';
import { AGENT_MCP_INSTRUCTIONS } from '../../../src/core/todos.ts';
import { type AgentApi, loopAction, loopCancel, loopCreate, loopList, loopUpdate } from '../../../src/hook/sb-mcp.ts';
import { buildApp, createSessionServices } from '../../../src/server/app.ts';
import { NO_ATTACHMENTS } from '../../../src/server/attachments/service.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { isLocalOnly } from '../../../src/server/devices/local-only.ts';
import { HookService } from '../../../src/server/hooks/service.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { LoopService, PENDING_SKIP } from '../../../src/server/loops/owned.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { agentTokenFor } from '../../../src/server/todos/agent-token.ts';
import { HOOK_TOKEN_FILE, generateToken, loadOrCreateToken } from '../../../src/server/token.ts';
import { FakeClock } from '../../helpers/clock.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';
import { assistantTextLine, lastUuid, terminalUserLine, writeTranscript } from '../../helpers/transcripts.ts';

/**
 * D94 over the real routes (`inject`): the UI's loop routes, the agent's
 * (`/agent/v1/loops`, only with the session's own agent token: session A's token
 * never reaches session B's loops), the MCP helper's loop tools against those
 * routes, a hooked terminal session's firing through the hook mailbox, and the
 * peer / device classification of the routes.
 */

const PORT = 4903; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;
const CS = '0b7c3e0a-2222-4333-8444-955566667777';
const at = (hour: number, minute = 0): Date => new Date(2026, 9, 9, hour, minute, 0, 0);

interface Rig {
  readonly root: string;
  readonly store: Store;
  readonly app: FastifyInstance;
  readonly token: string;
  readonly loops: LoopService;
  readonly clock: FakeClock;
  readonly hooks: HookService;
  readonly hookToken: string;
  readonly cwd: string;
  readonly transcript: string;
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.app.close();
  await rig?.hooks.close();
  await rig?.loops.close();
  await rig?.store.close();
  if (rig) await removeTempDir(rig.root);
  rig = undefined;
});

async function setup(): Promise<Rig> {
  const root = await makeTempDir('loops-api');
  const dataDir = path.join(root, 'data');
  const configDir = path.join(root, 'claude-config');
  const cwd = path.join(root, 'project');
  await mkdir(cwd, { recursive: true });
  await mkdir(configDir, { recursive: true });
  const store = await openTempStore(dataDir);
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: dataDir }, platform: 'linux', home: root, cwd: root }), port: PORT };
  const bus = new HubBus();
  const { supervisor, questions } = createSessionServices(config, store, bus);
  const hookToken = await loadOrCreateToken(dataDir, HOOK_TOKEN_FILE);
  const rows: TerminalAgentRow[] = [{ pid: process.pid, sessionId: CS, cwd, kind: 'interactive', name: 'watcher', status: 'idle', waitingFor: null, startedAt: Date.parse('2026-10-09T07:59:00.000Z') }];
  const hooks = new HookService({
    config,
    store,
    bus,
    questions,
    hookTokenFile: path.join(dataDir, HOOK_TOKEN_FILE),
    env: { CLAUDE_CONFIG_DIR: configDir },
    listAgents: async () => rows,
    cliVersion: async () => '2.1.284 (Claude Code)',
  });
  const clock = new FakeClock(at(10));
  // As app.ts wires it, with a fake clock.
  const loops = new LoopService({
    store,
    clock,
    announce: (sessionId) => supervisor.announce(sessionId),
    deliver: async (session, text, mark) => {
      if (session.hooked) await hooks.sendMessage(session.id, text, NO_ATTACHMENTS, { origin: 'service', loop: mark });
      else await supervisor.sendMessage(session.id, text, 'service', NO_ATTACHMENTS, { loop: mark });
    },
  });
  loops.start();
  const token = generateToken();
  const app = await buildApp({ config, token, store, webRoot: root, supervisor, questions, bus, hooks, hookToken, loops });
  await app.ready();
  const lines = [terminalUserLine({ sessionId: CS, cwd, content: 'Watch the deploy.', parentUuid: null, timestamp: '2026-10-09T08:00:00.000Z' })];
  lines.push(assistantTextLine({ sessionId: CS, cwd, text: 'Watching.', parentUuid: lastUuid(lines), timestamp: '2026-10-09T08:00:05.000Z' }));
  const transcript = await writeTranscript(configDir, cwd, CS, lines);
  rig = { root, store, app, token, loops, clock, hooks, hookToken, cwd, transcript };
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

function agent(r: Rig, sessionId: string, bearer: string, method: InjectOptions['method'], url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  return r.app.inject({
    method,
    url,
    headers: { host: HOST, 'x-switchboard-session': sessionId, authorization: `Bearer ${bearer}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

/** The MCP helper's API, over `inject` as session `sessionId` with its own agent token. */
function helperApi(r: Rig, sessionId: string): AgentApi {
  return async (method, route, body) => {
    const answer = await agent(r, sessionId, agentTokenFor(r.token, sessionId), method, route, body);
    return { status: answer.statusCode, body: answer.body ? (answer.json() as unknown) : null };
  };
}

async function session(r: Rig, name: string): Promise<string> {
  return (await r.store.sessions.create({ name, claudeSessionId: randomUUID() })).id;
}

function hookCall(r: Rig, kind: 'event' | 'waiter', event: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return r.app.inject({
    method: 'POST',
    url: `/hook/v1/${kind}`,
    headers: { host: HOST, authorization: `Bearer ${r.hookToken}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ event: { session_id: CS, cwd: r.cwd, transcript_path: r.transcript, ...event }, claudePid: process.pid, entrypoint: 'cli' }),
  });
}

describe('D94 · the UI routes and the agent routes', () => {
  it('create / list / update / pause / resume / cancel; the session carries its loops', async () => {
    const r = await setup();
    const id = await session(r, 'ui-loops');
    const created = await ui(r, 'POST', `/api/sessions/${id}/loops`, { prompt: 'Check the queue.', everyMinutes: 30, label: 'Queue' });
    expect(created.statusCode, created.body).toBe(201);
    const loop = created.json() as OwnedLoop;
    expect(loop).toMatchObject({ sessionId: id, title: 'Queue', createdBy: 'developer', scheduleText: 'every 30 min', expiresAt: null, nextFireAt: at(10, 30).toISOString() });
    expect((await ui(r, 'GET', `/api/sessions/${id}/loops`)).json()).toEqual([loop]);
    const listed = ((await ui(r, 'GET', '/api/sessions')).json() as Session[]).find((s) => s.id === id);
    expect(listed?.ownedLoops?.map((l) => l.id)).toEqual([loop.id]);
    const invalid = await ui(r, 'POST', `/api/sessions/${id}/loops`, { prompt: 'x', cron: 'nope' });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({ error: 'invalid', errors: [{ field: 'cron' }] });
    expect((await ui(r, 'PUT', `/api/sessions/${id}/loops/${loop.id}`, { expiresAt: at(12).toISOString(), maxRuns: 4 })).json()).toMatchObject({ expiresAt: at(12).toISOString(), maxRuns: 4 });
    expect((await ui(r, 'POST', `/api/sessions/${id}/loops/${loop.id}/pause`)).json()).toMatchObject({ state: 'paused', nextFireAt: null });
    expect((await ui(r, 'POST', `/api/sessions/${id}/loops/${loop.id}/resume`)).json()).toMatchObject({ state: 'active', nextFireAt: at(10, 30).toISOString() });
    expect((await ui(r, 'DELETE', `/api/sessions/${id}/loops/${loop.id}`)).statusCode).toBe(204);
    expect((await ui(r, 'DELETE', `/api/sessions/${id}/loops/${loop.id}`)).statusCode).toBe(404);
    expect((await ui(r, 'GET', '/api/sessions/nope/loops')).statusCode).toBe(404);
    // The cookie is needed, as on every API route.
    expect((await r.app.inject({ method: 'GET', url: `/api/sessions/${id}/loops`, headers: { host: HOST } })).statusCode).toBe(401);
  });

  it("the agent token scopes the loops to its own session: A's token never reaches B's loops", async () => {
    const r = await setup();
    const a = await session(r, 'agent-a');
    const b = await session(r, 'agent-b');
    const tokenA = agentTokenFor(r.token, a);
    const made = await agent(r, a, tokenA, 'POST', '/agent/v1/loops', { prompt: 'From A', every_minutes: 5 });
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json()).toMatchObject({ sessionId: a, createdBy: 'agent' });
    const theirs = (await ui(r, 'POST', `/api/sessions/${b}/loops`, { prompt: 'B only', everyMinutes: 5 })).json() as OwnedLoop;
    // A's token with B's header is refused outright; A's token on B's loop id answers not found.
    expect((await agent(r, b, tokenA, 'GET', '/agent/v1/loops')).statusCode).toBe(401);
    expect((await agent(r, a, tokenA, 'POST', `/agent/v1/loops/${theirs.id}/pause`)).statusCode).toBe(404);
    expect((await agent(r, a, tokenA, 'PUT', `/agent/v1/loops/${theirs.id}`, { prompt: 'hijack' })).statusCode).toBe(404);
    expect((await agent(r, a, tokenA, 'DELETE', `/agent/v1/loops/${theirs.id}`)).statusCode).toBe(404);
    expect(((await agent(r, a, tokenA, 'GET', '/agent/v1/loops')).json() as OwnedLoop[]).map((l) => l.prompt)).toEqual(['From A']);
    expect(((await ui(r, 'GET', `/api/sessions/${b}/loops`)).json() as OwnedLoop[]).map((l) => [l.prompt, l.state])).toEqual([['B only', 'active']]);
    // Without a token at all.
    expect((await r.app.inject({ method: 'GET', url: '/agent/v1/loops', headers: { host: HOST, 'x-switchboard-session': a } })).statusCode).toBe(401);
  });

  it('the MCP helper loop tools: create (validation errors as tool errors), list, update, pause, resume, cancel', async () => {
    const r = await setup();
    const id = await session(r, 'mcp-loops');
    const api = helperApi(r, id);
    expect(AGENT_MCP_INSTRUCTIONS).toContain('use loop_create, not CronCreate');
    expect(await loopCreate(api, { every_minutes: 5 })).toMatchObject({ isError: true });
    expect(await loopCreate(api, { prompt: 'x', every_minutes: 5, cron: '* * * * *' })).toMatchObject({ isError: true });
    const refused = await loopCreate(api, { prompt: 'x', every_minutes: 0 });
    expect(refused.isError).toBe(true);
    expect((refused.content[0] as { text: string }).text).toContain('every_minutes must be a whole number of minutes');
    const pastAt = await loopCreate(api, { prompt: 'x', at: '2026-10-09T09:00:00' });
    expect((pastAt.content[0] as { text: string }).text).toContain('at must be in the future');
    const created = await loopCreate(api, { prompt: 'Check the deploy.', every_minutes: 15, label: 'Deploy watch', max_runs: 8 });
    const text = (created.content[0] as { text: string }).text;
    expect(created.isError).toBeUndefined();
    expect(text).toMatch(/^Created: \[[a-f0-9]{10}\] Deploy watch · every 15 min · next: 2026-10-09T\d\d:15:00\.000Z · expires: no expiry · runs: 0 of 8 · active\nid: [a-f0-9]{10}\nPrompt: Check the deploy\.\n/);
    const loopId = /id: ([a-f0-9]{10})/.exec(text)?.[1] as string;
    expect((await loopList(api)).content[0]).toMatchObject({ text: expect.stringContaining(`[${loopId}] Deploy watch · every 15 min`) });
    expect(((await loopUpdate(api, { id: `[${loopId}]`, cron: '0 9 * * 1-5' })).content[0] as { text: string }).text).toContain('Updated: ');
    expect(await loopUpdate(api, { id: loopId })).toMatchObject({ isError: true });
    expect(((await loopAction(api, { id: loopId }, 'pause')).content[0] as { text: string }).text).toContain('· paused');
    expect(((await loopAction(api, { id: loopId }, 'resume')).content[0] as { text: string }).text).toContain('· active');
    expect(((await loopCancel(api, { id: loopId })).content[0] as { text: string }).text).toBe(`Cancelled loop ${loopId}: it will not fire again.`);
    expect((await loopList(api)).content[0]).toMatchObject({ text: 'This session has no Switchboard loops.' });
    expect(await loopCancel(api, { id: loopId })).toMatchObject({ isError: true });
  });
});

describe('D94 · a hooked terminal session', () => {
  it('fires through the hook mailbox (waits for the waiter); a second due time is skipped while it waits', async () => {
    const r = await setup();
    const listed = await ui(r, 'GET', '/api/terminal-sessions');
    expect((listed.json() as TerminalSession[]).map((row) => row.id)).toEqual([CS]);
    const hooked = (await ui(r, 'POST', `/api/terminal-sessions/${CS}/hook`)).json() as Session;
    const loop = (await ui(r, 'POST', `/api/sessions/${hooked.id}/loops`, { prompt: 'Is the deploy done?', everyMinutes: 1, label: 'Deploy' })).json() as OwnedLoop;
    await r.clock.advanceTo(at(10, 1), () => r.loops.settled());
    const detail = (await ui(r, 'GET', `/api/sessions/${hooked.id}`)).json() as SessionDetail;
    const firing = detail.events.map((event) => event.payload as UserPayload).find((payload) => payload.type === 'user' && payload.loop);
    expect(firing).toMatchObject({ text: 'Is the deploy done?', origin: 'service', queued: 'turn', delivered: false, loop: { id: loop.id, label: 'Deploy', run: 1 } });
    // No waiter yet: the next due time is skipped (one pending firing at most).
    await r.clock.advanceTo(at(10, 2), () => r.loops.settled());
    expect(((await ui(r, 'GET', `/api/sessions/${hooked.id}/loops`)).json() as OwnedLoop[])[0]).toMatchObject({ runs: 1, skipped: 1, lastError: PENDING_SKIP });
    // The terminal's waiter takes it.
    const waiter = await hookCall(r, 'waiter', { hook_event_name: 'SessionStart', source: 'startup' });
    expect(waiter.statusCode).toBe(200);
    expect(JSON.stringify(waiter.json())).toContain('Is the deploy done?');
    // The woken turn runs (the hook service marks it before the test ends).
    for (let i = 0; i < 100 && ((await ui(r, 'GET', `/api/sessions/${hooked.id}`)).json() as Session).status !== 'run'; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  });
});

describe('D94 · peers and devices', () => {
  it('the routes are on the peer API and allowed to paired devices; the answers map the session id', () => {
    for (const [method, url] of [
      ['GET', '/api/sessions/s1/loops'],
      ['POST', '/api/sessions/s1/loops'],
      ['PUT', '/api/sessions/s1/loops/0123456789'],
      ['POST', '/api/sessions/s1/loops/0123456789/pause'],
      ['POST', '/api/sessions/s1/loops/0123456789/resume'],
      ['POST', '/api/sessions/s1/loops/0123456789/run'],
      ['DELETE', '/api/sessions/s1/loops/0123456789'],
    ] as const) {
      expect(peerApiAllowed(method, url), `${method} ${url}`).toBe(true);
      expect(isLocalOnly(method, url), `${method} ${url}`).toBe(false);
    }
    const machine = { id: 'abcdefghijkl', name: 'studio-pc', state: 'online' as const };
    const loop = { id: '0123456789', sessionId: 's1', prompt: 'p' } as OwnedLoop;
    expect(peerAnswerKind('GET', '/api/sessions/s1/loops')).toBe('owned-loops');
    expect(peerAnswerKind('POST', '/api/sessions/s1/loops')).toBe('owned-loop');
    expect(peerAnswerKind('POST', '/api/sessions/s1/loops/0123456789/run')).toBe('owned-loop');
    expect(peerAnswerKind('DELETE', '/api/sessions/s1/loops/0123456789')).toBe('none');
    expect(mapPeerAnswer(machine, 'owned-loops', [loop])).toEqual([{ ...loop, sessionId: 'r~abcdefghijkl~s1' }]);
    expect(mapPeerAnswer(machine, 'owned-loop', loop)).toEqual({ ...loop, sessionId: 'r~abcdefghijkl~s1' });
    const mapped = peerSession(machine, { id: 's1', loops: [], ownedLoops: [loop] } as unknown as Session);
    expect(mapped.ownedLoops).toEqual([{ ...loop, sessionId: 'r~abcdefghijkl~s1' }]);
  });
});
