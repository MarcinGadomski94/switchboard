import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { InboxItem, Session, SessionDetail, SessionEvent } from '../../../src/core/api.ts';
import type { RemotePayload, ToolPayload } from '../../../src/core/event-payload.ts';
import { parseRemoteInput } from '../../../src/server/api/sessions.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { type HubMessage, HubBus } from '../../../src/server/hub/bus.ts';
import { QuestionPipeline } from '../../../src/server/inbox/pipeline.ts';
import type { ControlRequestHandler } from '../../../src/server/supervisor/supervisor.ts';
import { generateToken } from '../../../src/server/token.ts';
import { REMOTE_CONTROL_UNAVAILABLE } from '../../../tools/fake-claude/scenarios.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, spawnedArgv, stdinOf, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D24 oracle (server, real path: fake-claude as the CLI, no demo data):
 * `initialize` at every spawn and `Session.remote`; `PUT /api/sessions/{id}/remote`
 * on and off (the stdin `remote_control` lines, the stored link and `cse_…` id,
 * `sessionUpdated`), 404 / 422 / 409 `not-live` / 409 `remote-unavailable` / 502
 * `remote-failed` with the CLI's text verbatim; Remote stays on across pause/resume
 * and restart recovery (`reattach_session_id`), a failed reattach turns it off and
 * says why in the chat; a question answered on the phone (`control_cancel_request`
 * while Remote is on) closes as "answered on claude.ai".
 */
const PORT = 4873; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;
const TITLE = 'Remote from the phone';
const ERROR_TEXT = 'Remote Control cannot be enabled from inside a remote session';

let world: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';
let messages: HubMessage[] = [];

/** A supervisor world whose control-request handler is the question pipeline (as `createSessionServices` joins them), and the app. */
async function setup(): Promise<SupervisorWorld> {
  const holder: { pipeline?: QuestionPipeline } = {};
  const forward: ControlRequestHandler = {
    canUseTool: (context) => holder.pipeline?.canUseTool(context),
    cancelled: (sessionId, requestId, answeredOn) => holder.pipeline?.cancelled(sessionId, requestId, answeredOn),
    orphaned: (sessionId, ids) => holder.pipeline?.orphaned(sessionId, ids),
    pendingDelivered: (sessionId, pending) => holder.pipeline?.pendingDelivered(sessionId, pending),
  };
  world = await makeSupervisorWorld({ controlHandler: forward });
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: world.root }, platform: 'linux', home: world.root, cwd: world.root });
  await seedFolder(world.store, world.workspace);
  const bus = new HubBus();
  messages = [];
  bus.subscribe((message) => messages.push(message));
  const pipeline = new QuestionPipeline({ store: world.store, bus }).bind(world.supervisor);
  holder.pipeline = pipeline;
  app = await buildApp({ config: { ...base, port: PORT }, token, store: world.store, webRoot: world.root, supervisor: world.supervisor, questions: pipeline, bus });
  await app.ready();
  return world;
}

afterEach(async () => {
  await app?.close();
  await world?.cleanup();
  app = undefined;
  world = undefined;
});

function call(method: InjectOptions['method'], url: string, payload?: unknown) {
  if (!app) throw new Error('no app');
  return app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

async function detail(id: string): Promise<SessionDetail> {
  const response = await call('GET', `/api/sessions/${id}`);
  expect(response.statusCode).toBe(200);
  return response.json() as SessionDetail;
}

/**
 * Starts a session with a title and a one-turn task (a session with no turn has no
 * transcript, so it could not be resumed), waits for the turn and for its
 * `initialize` reply.
 */
async function startIdle(env: Record<string, string> = {}): Promise<Session> {
  const w = world as SupervisorWorld;
  Object.assign(w.env, env);
  const response = await call('POST', '/api/sessions', newSession({ name: 'remote-demo', title: TITLE, task: 'Reply with just OK.' }));
  expect(response.statusCode, response.body).toBe(201);
  const session = response.json() as Session;
  await waitForStatus(w.store, session.id, ['done']);
  await until(async () => (await w.store.sessions.get(session.id))?.remoteAvailable !== false || (env['FAKE_CLAUDE_REMOTE_CONTROL'] === 'unavailable' && (await initializeAnswered(session.id))), 'the initialize reply');
  return session;
}

/** `true` once the process's `initialize` was written and a reply could have been read (the fake answers at once). */
async function initializeAnswered(id: string): Promise<boolean> {
  const w = world as SupervisorWorld;
  const pid = (await w.store.sessions.get(id))?.pid;
  if (!pid) return false;
  const lines = await stdinOf(w.logFile, pid, { all: true });
  return lines.some((line) => (line['request'] as { subtype?: string } | undefined)?.subtype === 'initialize');
}

async function remoteLines(pid: number): Promise<Array<Record<string, unknown>>> {
  return (await stdinOf((world as SupervisorWorld).logFile, pid)).filter((line) => (line['request'] as { subtype?: string } | undefined)?.subtype === 'remote_control');
}

function remoteEvents(events: readonly SessionEvent[]): Array<{ kind: string; label: string; payload: RemotePayload }> {
  return events
    .filter((event) => (event.payload as { type?: string } | null)?.type === 'remote')
    .map((event) => ({ kind: event.kind, label: event.label, payload: event.payload as RemotePayload }));
}

function sessionUpdates(id: string): Session[] {
  return messages.flatMap((m) => (m.name === 'sessionUpdated' && m.payload.id === id ? [m.payload] : []));
}

describe('PUT /api/sessions/{id}/remote · on and off (D24)', () => {
  it('initialize first, then on: remote_control with the display title, the link and cse_ id stored; off keeps them; on again reattaches', async () => {
    const w = await setup();
    const session = await startIdle();
    const record = await w.store.sessions.get(session.id);
    const pid = record?.pid as number;
    // Every process gets `initialize` first (the handshake), with no user message yet.
    const handshake = await stdinOf(w.logFile, pid, { all: true });
    expect(handshake[0]).toMatchObject({ type: 'control_request', request: { subtype: 'initialize', hooks: null } });
    expect((await detail(session.id)).remote).toEqual({ available: true, enabled: false, url: null });

    const on = await call('PUT', `/api/sessions/${session.id}/remote`, { enabled: true });
    expect(on.statusCode, on.body).toBe(200);
    const id = `FAKE${session.claudeSessionId.replace(/-/g, '')}`;
    const url = `https://claude.ai/code/session_${id}`;
    expect((on.json() as Session).remote).toEqual({ available: true, enabled: true, url });
    expect(await w.store.sessions.get(session.id)).toMatchObject({ remoteEnabled: true, remoteSessionUrl: url, remoteBridgeId: `cse_${id}`, remoteAvailable: true });
    const [first] = await remoteLines(pid);
    expect(first?.['request']).toEqual({ subtype: 'remote_control', enabled: true, name: TITLE, keep_session_on_exit: true });
    expect(sessionUpdates(session.id).some((s) => s.remote?.enabled === true && s.remote.url === url)).toBe(true);

    // Already on: nothing is sent.
    expect((await call('PUT', `/api/sessions/${session.id}/remote`, { enabled: true })).statusCode).toBe(200);
    expect(await remoteLines(pid)).toHaveLength(1);

    const off = await call('PUT', `/api/sessions/${session.id}/remote`, { enabled: false });
    expect(off.statusCode, off.body).toBe(200);
    expect((off.json() as Session).remote).toEqual({ available: true, enabled: false, url });
    expect(await w.store.sessions.get(session.id)).toMatchObject({ remoteEnabled: false, remoteSessionUrl: url, remoteBridgeId: `cse_${id}` });
    expect((await remoteLines(pid))[1]?.['request']).toEqual({ subtype: 'remote_control', enabled: false });
    // Already off: nothing is sent.
    expect((await call('PUT', `/api/sessions/${session.id}/remote`, { enabled: false })).statusCode).toBe(200);
    expect(await remoteLines(pid)).toHaveLength(2);

    // On again: the stored cse_ id is reattached, so the claude.ai entry (and link) stay the same.
    const again = await call('PUT', `/api/sessions/${session.id}/remote`, { enabled: true });
    expect((again.json() as Session).remote).toEqual({ available: true, enabled: true, url });
    expect((await remoteLines(pid))[2]?.['request']).toEqual({ subtype: 'remote_control', enabled: true, name: TITLE, reattach_session_id: `cse_${id}`, keep_session_on_exit: true });

    // The chat records each step (`remote` events: on · off · on).
    expect(remoteEvents((await detail(session.id)).events)).toEqual([
      { kind: 'text', label: `Remote Control on · ${url}`, payload: { type: 'remote', action: 'on', reattach: false, url } },
      { kind: 'text', label: 'Remote Control off', payload: { type: 'remote', action: 'off' } },
      { kind: 'text', label: `Remote Control on · ${url}`, payload: { type: 'remote', action: 'on', reattach: true, url } },
    ]);
  });

  it('404 for an unknown session, 422 for a body that is not { enabled: boolean }', async () => {
    await setup();
    const session = await startIdle();
    expect((await call('PUT', '/api/sessions/nope/remote', { enabled: true })).statusCode).toBe(404);
    for (const body of [{}, { enabled: 'yes' }, { enabled: 1 }, [true], null]) {
      const response = await call('PUT', `/api/sessions/${session.id}/remote`, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(422);
      expect(response.json()).toMatchObject({ error: 'invalid', errors: [{ field: 'enabled' }] });
    }
    expect(parseRemoteInput({ enabled: true })).toBe(true);
    expect(parseRemoteInput({ enabled: false })).toBe(false);
    expect(parseRemoteInput({ enabled: null })).toBeNull();
  });

  it('409 not-live without a live process (paused), 409 remote-unavailable when initialize said false; nothing is written', async () => {
    const w = await setup();
    const session = await startIdle({ FAKE_CLAUDE_REMOTE_CONTROL: 'unavailable' });
    const pid = (await w.store.sessions.get(session.id))?.pid as number;
    expect((await detail(session.id)).remote).toEqual({ available: false, enabled: false, url: null });
    const refused = await call('PUT', `/api/sessions/${session.id}/remote`, { enabled: true });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({
      error: 'remote-unavailable',
      message: 'claude reports that Remote Control is not available for this session (its initialize reply did not say remote_control_available: true)',
    });
    expect(await remoteLines(pid)).toEqual([]);

    expect((await call('POST', `/api/sessions/${session.id}/pause`)).statusCode).toBe(200);
    const paused = await call('PUT', `/api/sessions/${session.id}/remote`, { enabled: true });
    expect(paused.statusCode).toBe(409);
    expect(paused.json()).toEqual({ error: 'not-live', message: 'Remote Control needs a running claude process: resume the session first' });
    expect((await detail(session.id)).remote).toEqual({ available: false, enabled: false, url: null });
  });

  it('502 with the CLI error text verbatim; Remote stays off; the chat says why', async () => {
    const w = await setup();
    const session = await startIdle({ FAKE_CLAUDE_REMOTE_CONTROL_ERROR: ERROR_TEXT });
    const failed = await call('PUT', `/api/sessions/${session.id}/remote`, { enabled: true });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({ error: 'remote-failed', message: ERROR_TEXT });
    expect(await w.store.sessions.get(session.id)).toMatchObject({ remoteEnabled: false, remoteSessionUrl: null, remoteBridgeId: null });
    expect(remoteEvents((await detail(session.id)).events)).toEqual([
      {
        kind: 'error',
        label: `Remote Control could not be turned on: ${ERROR_TEXT}`,
        payload: { type: 'remote', action: 'failed', enabled: true, reattach: false, error: ERROR_TEXT },
      },
    ]);
  });

  it('502 when the success reply has no session_url (it counts as an error)', async () => {
    const w = await setup();
    const session = await startIdle({ FAKE_CLAUDE_REMOTE_CONTROL: 'no-url' });
    const failed = await call('PUT', `/api/sessions/${session.id}/remote`, { enabled: true });
    expect(failed.statusCode).toBe(502);
    const body = failed.json() as { error: string; message: string };
    expect(body.error).toBe('remote-failed');
    expect(body.message).toMatch(/^claude's remote_control reply has no session_url: \{"bridge_session_id":"cse_FAKE/);
    expect((await w.store.sessions.get(session.id))?.remoteEnabled).toBe(false);
  });

  it('a session Switchboard never ran a process for (the demo seed) has remote: null', async () => {
    const w = await setup();
    const stored = await w.store.sessions.create({ name: 'seeded', claudeSessionId: 'c-seeded' });
    expect((await detail(stored.id)).remote).toBeNull();
    const list = (await call('GET', '/api/sessions')).json() as Session[];
    expect(list.find((s) => s.id === stored.id)?.remote).toBeNull();
  });
});

describe('Remote across a new process (D24, D7)', () => {
  it('pause keeps Remote on (not available while paused); resume reattaches with reattach_session_id: same link', async () => {
    const w = await setup();
    const session = await startIdle();
    expect((await call('PUT', `/api/sessions/${session.id}/remote`, { enabled: true })).statusCode).toBe(200);
    const url = (await detail(session.id)).remote?.url;
    const bridgeId = (await w.store.sessions.get(session.id))?.remoteBridgeId;

    expect((await call('POST', `/api/sessions/${session.id}/pause`)).statusCode).toBe(200);
    expect((await detail(session.id)).remote).toEqual({ available: false, enabled: true, url });

    expect((await call('POST', `/api/sessions/${session.id}/resume`)).statusCode).toBe(200);
    const pid = (await w.store.sessions.get(session.id))?.pid as number;
    const lines = await until(async () => {
      const all = await stdinOf(w.logFile, pid, { all: true });
      return all.some((line) => (line['request'] as { subtype?: string } | undefined)?.subtype === 'remote_control') ? all : undefined;
    }, 'the reattach');
    // initialize first, then the reattach once it answered (the "Continue." message goes out meanwhile).
    expect((lines[0]?.['request'] as { subtype?: string }).subtype).toBe('initialize');
    const reattach = lines.find((line) => (line['request'] as { subtype?: string } | undefined)?.subtype === 'remote_control');
    expect(reattach?.['request']).toEqual({ subtype: 'remote_control', enabled: true, name: TITLE, reattach_session_id: bridgeId, keep_session_on_exit: true });
    await until(async () => (await detail(session.id)).remote?.available === true, 'available again');
    expect((await detail(session.id)).remote).toEqual({ available: true, enabled: true, url });
    await until(async () => remoteEvents((await detail(session.id)).events).length === 2, 'the reconnect event');
    expect(remoteEvents((await detail(session.id)).events).at(-1)).toEqual({
      kind: 'text',
      label: `Remote Control on again · ${url}`,
      payload: { type: 'remote', action: 'on', reattach: true, url },
    });
  });

  it('restart recovery (resumeAfterRestart) reattaches too', async () => {
    const w = await setup();
    const session = await startIdle();
    await call('PUT', `/api/sessions/${session.id}/remote`, { enabled: true });
    const bridgeId = (await w.store.sessions.get(session.id))?.remoteBridgeId;
    await w.supervisor.pause(session.id);
    await w.supervisor.resumeAfterRestart(session.id, null);
    const pid = (await w.store.sessions.get(session.id))?.pid as number;
    const reattach = await until(async () => (await remoteLines(pid))[0], 'the reattach after the restart');
    expect(reattach['request']).toMatchObject({ enabled: true, reattach_session_id: bridgeId });
    await until(async () => (await detail(session.id)).remote?.available === true, 'available again');
    expect((await detail(session.id)).remote?.enabled).toBe(true);
  });

  it('a failed reattach turns Remote off, records the CLI text in the chat and publishes it; the stored id stays', async () => {
    const w = await setup();
    const session = await startIdle();
    await call('PUT', `/api/sessions/${session.id}/remote`, { enabled: true });
    const stored = await w.store.sessions.get(session.id);
    await call('POST', `/api/sessions/${session.id}/pause`);
    w.env['FAKE_CLAUDE_REMOTE_CONTROL_ERROR'] = ERROR_TEXT;
    messages = [];
    expect((await call('POST', `/api/sessions/${session.id}/resume`)).statusCode).toBe(200);
    await until(async () => (await w.store.sessions.get(session.id))?.remoteEnabled === false, 'Remote off after the failed reattach');
    expect(await w.store.sessions.get(session.id)).toMatchObject({ remoteBridgeId: stored?.remoteBridgeId, remoteSessionUrl: stored?.remoteSessionUrl });
    const events = remoteEvents((await detail(session.id)).events);
    expect(events.at(-1)).toEqual({
      kind: 'error',
      label: `Remote Control could not reconnect: ${ERROR_TEXT}`,
      payload: { type: 'remote', action: 'failed', enabled: true, reattach: true, error: ERROR_TEXT },
    });
    await until(async () => sessionUpdates(session.id).some((s) => s.remote?.enabled === false && s.remote.available), 'the published session');
    expect((await detail(session.id)).remote).toMatchObject({ enabled: false, available: true });
  });

  it('Remote unavailable in the new process: the reattach is not sent, Remote turns off with the reason', async () => {
    const w = await setup();
    const session = await startIdle();
    await call('PUT', `/api/sessions/${session.id}/remote`, { enabled: true });
    await call('POST', `/api/sessions/${session.id}/pause`);
    w.env['FAKE_CLAUDE_REMOTE_CONTROL'] = 'unavailable';
    await call('POST', `/api/sessions/${session.id}/resume`);
    await until(async () => (await w.store.sessions.get(session.id))?.remoteEnabled === false, 'Remote off');
    const pid = (await w.store.sessions.get(session.id))?.pid as number;
    expect(await remoteLines(pid)).toEqual([]);
    expect(remoteEvents((await detail(session.id)).events).at(-1)).toMatchObject({
      kind: 'error',
      label: 'Remote Control could not reconnect: Remote Control is not available in the new claude process (its initialize reply did not say remote_control_available: true)',
    });
    expect(REMOTE_CONTROL_UNAVAILABLE).toContain('not available');
  });
});

describe('a question answered on the phone (D24, control_cancel_request)', () => {
  it('with Remote on the batch closes as answered on claude.ai: out of the Inbox, not answerable here, the chat event says so', async () => {
    const w = await setup();
    const session = await startIdle();
    await call('PUT', `/api/sessions/${session.id}/remote`, { enabled: true });
    expect((await call('POST', `/api/sessions/${session.id}/messages`, { text: '[fake:ask-2q] [fake:remote-answer 150] Ask me two questions.' })).statusCode).toBe(202);
    const batch = await until(async () => (await w.store.questions.listBatches({ sessionId: session.id }))[0], 'the batch');
    await until(async () => (await w.store.questions.getBatch(batch.id))?.answeredOn === 'claude.ai', 'answered on claude.ai');
    expect(await w.store.questions.getBatch(batch.id)).toMatchObject({ state: 'answered', answeredOn: 'claude.ai', deliveredVia: null });
    await waitForStatus(w.store, session.id, ['done', 'idle']);

    const questions = (await detail(session.id)).questions;
    expect(questions.map((q) => [q.state, q.answeredOn, q.answerIndex])).toEqual([
      ['answered', 'claude.ai', null],
      ['answered', 'claude.ai', null],
    ]);
    expect((await detail(session.id)).openQuestionCount).toBe(0);
    const inbox = (await call('GET', '/api/inbox')).json() as InboxItem[];
    expect(inbox.filter((item) => item.kind === 'questions')).toEqual([]);
    const late = await call('POST', `/api/questions/batch/${batch.id}/answers`, { answers: questions.map((q) => ({ questionId: q.id, answerIndex: 0 })) });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ error: 'already-answered', message: `question batch ${batch.id} is already answered on claude.ai` });

    const ask = (await detail(session.id)).events.find((event) => (event.payload as ToolPayload | null)?.type === 'tool' && (event.payload as ToolPayload).name === 'AskUserQuestion');
    expect(ask?.payload).toMatchObject({ requestState: 'cancelled', answeredOn: 'claude.ai' });
    // Nothing was written back for that request (the phone answered it).
    const pid = (await w.store.sessions.get(session.id))?.pid as number;
    expect((await stdinOf(w.logFile, pid)).filter((line) => line['type'] === 'control_response')).toEqual([]);
  });

  it('a pause withdraws an open question as before (stale, answerable), even with Remote on', async () => {
    const w = await setup();
    const session = await startIdle();
    await call('PUT', `/api/sessions/${session.id}/remote`, { enabled: true });
    await call('POST', `/api/sessions/${session.id}/messages`, { text: '[fake:ask-2q] Ask me two questions.' });
    const batch = await until(async () => (await w.store.questions.listBatches({ sessionId: session.id }))[0], 'the batch');
    await waitForStatus(w.store, session.id, ['need']);
    expect((await call('POST', `/api/sessions/${session.id}/pause`)).statusCode).toBe(200);
    expect(await w.store.questions.getBatch(batch.id)).toMatchObject({ state: 'stale', answeredOn: null, answeredAt: null });
    expect((await detail(session.id)).openQuestionCount).toBe(2);
  });
});

describe('spawns stay as they were (D24 adds no CLI flag)', () => {
  it('the argv has no remote-control flag; the prefix option is not passed', async () => {
    const w = await setup();
    await startIdle();
    const [spawn] = await spawnedArgv(w.logFile);
    expect(spawn?.argv?.some((arg) => arg.includes('remote-control'))).toBe(false);
  });
});
