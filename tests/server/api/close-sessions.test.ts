/**
 * D33 oracle (server): closing and reopening sessions through the contract routes
 * over the real supervisor, the real question pipeline and fake-claude (D13, no
 * demo data). `POST /api/sessions/{id}/close` stops a live / running / waiting
 * session only with `{ confirm: true }` (the way Pause stops it), closes its
 * waiting questions and permission requests ("session closed", they leave the
 * Inbox) and is idempotent; `GET /api/sessions` leaves closed sessions out unless
 * `?closed=include`; History lists them closed; `/hub` carries `closedAt`;
 * `POST /api/sessions/{id}/reopen` clears it without a process, and the next
 * message resumes the conversation (`--resume`). Recovery: recovery.test.ts; the
 * migration: migrate.test.ts.
 */
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { HubEvents, InboxItem, Session, SessionDetail } from '../../../src/core/api.ts';
import type { LifecyclePayload } from '../../../src/core/event-payload.ts';
import { SESSION_CLOSED_REASON } from '../../../src/core/session-close.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { TranscriptHistory } from '../../../src/server/history/transcripts.ts';
import { HubBus, type HubMessage } from '../../../src/server/hub/bus.ts';
import { QuestionPipeline } from '../../../src/server/inbox/pipeline.ts';
import type { ControlRequestHandler } from '../../../src/server/supervisor/supervisor.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, spawnedArgv, stdinOf, until, waitForStatus } from '../../helpers/supervisor.ts';

const PORT = 4961; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

interface Rig {
  readonly w: SupervisorWorld;
  readonly app: FastifyInstance;
  readonly token: string;
  readonly published: HubMessage[];
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.app.close();
  await rig?.w.cleanup();
  rig = undefined;
});

/** The supervisor world with the question pipeline as its control handler (as `createSessionServices` joins them) and the app. */
async function setup(): Promise<Rig> {
  const holder: { pipeline?: QuestionPipeline } = {};
  const forward: ControlRequestHandler = {
    canUseTool: (context) => holder.pipeline?.canUseTool(context),
    cancelled: (sessionId, requestId, answeredOn) => holder.pipeline?.cancelled(sessionId, requestId, answeredOn),
    orphaned: (sessionId, ids) => holder.pipeline?.orphaned(sessionId, ids),
    pendingDelivered: (sessionId, messages) => holder.pipeline?.pendingDelivered(sessionId, messages),
  };
  const w = await makeSupervisorWorld({ controlHandler: forward });
  const bus = new HubBus();
  const published: HubMessage[] = [];
  bus.subscribe((message) => published.push(message));
  const pipeline = new QuestionPipeline({ store: w.store, bus }).bind(w.supervisor);
  holder.pipeline = pipeline;
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: w.root }, platform: 'linux', home: w.root, cwd: w.root });
  await seedFolder(w.store, w.workspace);
  const token = generateToken();
  const app = await buildApp({
    config: { ...base, port: PORT },
    token,
    store: w.store,
    webRoot: w.root,
    supervisor: w.supervisor,
    questions: pipeline,
    bus,
    // History reads the world's transcripts, never ~/.claude.
    providers: { history: new TranscriptHistory({ store: w.store, configDir: w.configDir }) },
  });
  await app.ready();
  rig = { w, app, token, published };
  return rig;
}

function call(r: Rig, method: InjectOptions['method'], url: string, payload?: unknown) {
  return r.app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${r.token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

async function start(r: Rig, name: string, task: string): Promise<Session> {
  const response = await call(r, 'POST', '/api/sessions', newSession({ name, task }));
  expect(response.statusCode).toBe(201);
  return response.json() as Session;
}

async function listed(r: Rig, query = ''): Promise<Session[]> {
  const response = await call(r, 'GET', `/api/sessions${query}`);
  expect(response.statusCode).toBe(200);
  return response.json() as Session[];
}

async function lifecycleActions(r: Rig, id: string): Promise<string[]> {
  return (await r.w.store.events.list(id))
    .map((event) => event.payload as LifecyclePayload)
    .filter((payload) => payload?.type === 'lifecycle')
    .map((payload) => payload.action);
}

function sessionUpdates(r: Rig, id: string): Session[] {
  return r.published.filter((m): m is Extract<HubMessage, { name: 'sessionUpdated' }> => m.name === 'sessionUpdated' && m.payload.id === id).map((m) => m.payload);
}

describe('D33 · POST /api/sessions/{id}/close', () => {
  it('closes a session without a process at once: left out of the list (?closed=include lists it), in History as closed, on /hub; idempotent', async () => {
    const r = await setup();
    const session = await start(r, 'rest-idle', 'Reply with OK.');
    await waitForStatus(r.w.store, session.id, ['done']);
    expect((await call(r, 'POST', `/api/sessions/${session.id}/pause`)).statusCode).toBe(200);
    const kept = await start(r, 'still-open', 'Reply with OK.');
    await waitForStatus(r.w.store, kept.id, ['done']);
    expect((await listed(r)).map((s) => [s.name, s.closedAt])).toEqual([
      ['still-open', null],
      ['rest-idle', null],
    ]);

    const closed = await call(r, 'POST', `/api/sessions/${session.id}/close`);
    expect(closed.statusCode).toBe(200);
    const body = closed.json() as Session;
    expect(body).toMatchObject({ id: session.id, status: 'paused', live: false });
    expect(typeof body.closedAt).toBe('string');
    expect(await r.w.store.sessions.get(session.id)).toMatchObject({ closedAt: body.closedAt, status: 'paused' });
    expect((await lifecycleActions(r, session.id)).slice(-2)).toEqual(['paused', 'closed']);

    // The sidebar's list leaves it out; ?closed=include (History, the New-session name check) lists it; anything else is refused.
    expect((await listed(r)).map((s) => s.name)).toEqual(['still-open']);
    expect((await listed(r, '?closed=include')).map((s) => [s.name, s.closedAt])).toEqual([
      ['still-open', null],
      ['rest-idle', body.closedAt],
    ]);
    expect((await listed(r, '?closed=exclude')).map((s) => s.name)).toEqual(['still-open']);
    const bad = await call(r, 'GET', '/api/sessions?closed=only');
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: 'invalid', errors: [{ field: 'closed' }] });
    // The detail still answers (the session view of a closed session, History's Reopen).
    expect(((await call(r, 'GET', `/api/sessions/${session.id}`)).json() as SessionDetail).closedAt).toBe(body.closedAt);

    // /hub: sessionUpdated carries closedAt (the sidebar reloads its list on it).
    expect(sessionUpdates(r, session.id).at(-1)).toMatchObject({ id: session.id, closedAt: body.closedAt });

    // History lists it next to the open one, with its closed state.
    const history = (await call(r, 'GET', '/api/history')).json() as Array<{ sessionId: string | null; closedAt?: string | null }>;
    expect(history.map((row) => [row.sessionId, row.closedAt])).toEqual(
      expect.arrayContaining([
        [session.id, body.closedAt],
        [kept.id, null],
      ]),
    );

    // Idempotent: the same answer, no second lifecycle event, nothing spawned.
    const spawns = (await spawnedArgv(r.w.logFile)).length;
    const again = await call(r, 'POST', `/api/sessions/${session.id}/close`, { confirm: true });
    expect(again.statusCode).toBe(200);
    expect((again.json() as Session).closedAt).toBe(body.closedAt);
    expect((await lifecycleActions(r, session.id)).filter((action) => action === 'closed')).toHaveLength(1);
    expect((await spawnedArgv(r.w.logFile)).length).toBe(spawns);

    expect((await call(r, 'POST', '/api/sessions/no-such-session/close')).statusCode).toBe(404);
    expect((await call(r, 'POST', `/api/sessions/${kept.id}/close`, { confirm: 'yes' })).statusCode).toBe(422);
    expect(r.w.errors).toEqual([]);
  });

  it('a running session: 409 close-needs-confirm without confirm (nothing changes); with it the process stops as Pause stops it, then it is closed', async () => {
    const r = await setup();
    const session = await start(r, 'long-run', '[fake:hang] Work on it.');
    await waitForStatus(r.w.store, session.id, ['run']);
    const pid = (await r.w.store.sessions.get(session.id))?.pid as number;

    const refused = await call(r, 'POST', `/api/sessions/${session.id}/close`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'close-needs-confirm', message: expect.stringContaining('long-run is running') });
    expect((await call(r, 'POST', `/api/sessions/${session.id}/close`, { confirm: false })).statusCode).toBe(409);
    expect(r.w.supervisor.isLive(session.id)).toBe(true);
    expect(await r.w.store.sessions.get(session.id)).toMatchObject({ closedAt: null, status: 'run' });

    const closed = await call(r, 'POST', `/api/sessions/${session.id}/close`, { confirm: true });
    expect(closed.statusCode).toBe(200);
    const body = closed.json() as Session;
    expect(body).toMatchObject({ status: 'paused', live: false });
    expect(typeof body.closedAt).toBe('string');
    expect(r.w.supervisor.isLive(session.id)).toBe(false);
    // Pause's stop: the interrupt control request, then EOF (the conversation stays resumable).
    const stdin = await stdinOf(r.w.logFile, pid);
    expect(stdin.some((line) => line['type'] === 'control_request' && (line['request'] as { subtype?: string }).subtype === 'interrupt')).toBe(true);
    expect((await lifecycleActions(r, session.id)).slice(-2)).toEqual(['paused', 'closed']);
    expect(await listed(r)).toEqual([]);
  });

  it('a live idle process (a finished turn) needs confirm too: closing stops it', async () => {
    const r = await setup();
    const session = await start(r, 'idle-live', 'Reply with OK.');
    await waitForStatus(r.w.store, session.id, ['done']);
    expect(r.w.supervisor.isLive(session.id)).toBe(true);
    const refused = await call(r, 'POST', `/api/sessions/${session.id}/close`, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'close-needs-confirm' });
    const closed = await call(r, 'POST', `/api/sessions/${session.id}/close`, { confirm: true });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ status: 'paused', live: false });
  });

  it('open questions and permission requests leave the Inbox ("session closed"); a closed batch cannot be answered', async () => {
    const r = await setup();
    const asking = await start(r, 'asking', '[fake:ask-2q] Ask me.');
    const permitting = await start(r, 'permitting', '[fake:perm-allow] Write it.');
    await waitForStatus(r.w.store, asking.id, ['need']);
    await waitForStatus(r.w.store, permitting.id, ['need']);
    const before = (await call(r, 'GET', '/api/inbox')).json() as InboxItem[];
    expect(before.map((item) => [item.kind, item.sessionId]).sort()).toEqual([
      ['permission', permitting.id],
      ['questions', asking.id],
    ]);
    const batchId = before.find((item) => item.kind === 'questions')?.id as string;
    const permissionId = before.find((item) => item.kind === 'permission')?.id as string;

    const waiting = await call(r, 'POST', `/api/sessions/${asking.id}/close`);
    expect(waiting.statusCode).toBe(409);
    expect(waiting.json().message).toContain('asking is waiting for you');

    for (const id of [asking.id, permitting.id]) expect((await call(r, 'POST', `/api/sessions/${id}/close`, { confirm: true })).statusCode).toBe(200);
    expect((await call(r, 'GET', '/api/inbox')).json()).toEqual([]);
    const counts = r.published.filter((m): m is Extract<HubMessage, { name: 'inboxChanged' }> => m.name === 'inboxChanged').map((m) => (m.payload as HubEvents['inboxChanged']).count);
    expect(counts.at(-1)).toBe(0);

    // The batch: stale (the stale path) with the label; the permission request: stale.
    expect(await r.w.store.questions.getBatch(batchId)).toMatchObject({ state: 'stale', answeredAt: null, closedReason: SESSION_CLOSED_REASON });
    expect(await r.w.store.permissions.get(permissionId)).toMatchObject({ state: 'stale', decision: null });
    const detail = (await call(r, 'GET', `/api/sessions/${asking.id}`)).json() as SessionDetail;
    expect(detail.openQuestionCount).toBe(0);
    expect(detail.questions.map((q) => [q.state, q.closedReason])).toEqual([
      ['stale', SESSION_CLOSED_REASON],
      ['stale', SESSION_CLOSED_REASON],
    ]);
    // Closed: answering it is refused and nothing is queued for the next run.
    const answer = await call(r, 'POST', `/api/questions/batch/${batchId}/answers`, {
      answers: detail.questions.map((q) => ({ questionId: q.id, answerIndex: 0 })),
    });
    expect(answer.statusCode).toBe(409);
    expect(answer.json()).toEqual({ error: 'not-open', message: `question batch ${batchId} was closed (session closed)` });
    expect(await r.w.store.pendingMessages.pending(asking.id)).toEqual([]);
    expect((await call(r, 'POST', `/api/inbox/${permissionId}/actions/allow-once`)).statusCode).toBe(409);
  });
});

describe('D33 · POST /api/sessions/{id}/reopen', () => {
  it('a closed session refuses messages, Resume and Attach; reopen lists it again without a process; the next message resumes it', async () => {
    const r = await setup();
    const session = await start(r, 'come-back', 'Reply with OK.');
    await waitForStatus(r.w.store, session.id, ['done']);
    expect((await call(r, 'POST', `/api/sessions/${session.id}/close`, { confirm: true })).statusCode).toBe(200);

    for (const [route, payload] of [
      ['messages', { text: 'Anything new?' }],
      ['resume', undefined],
      ['attach', undefined],
    ] as const) {
      const refused = await call(r, 'POST', `/api/sessions/${session.id}/${route}`, payload);
      expect(refused.statusCode, route).toBe(409);
      expect(refused.json(), route).toEqual({ error: 'closed', message: 'the session come-back is closed: reopen it from History first' });
    }
    const spawns = (await spawnedArgv(r.w.logFile)).filter((line) => line.argv?.includes('-p')).length;

    const reopened = await call(r, 'POST', `/api/sessions/${session.id}/reopen`);
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json()).toMatchObject({ id: session.id, closedAt: null, live: false, status: 'paused' });
    expect((await lifecycleActions(r, session.id)).at(-1)).toBe('reopened');
    expect((await listed(r)).map((s) => s.id)).toEqual([session.id]);
    expect(sessionUpdates(r, session.id).at(-1)).toMatchObject({ closedAt: null });
    // Idempotent, and no process was started.
    expect((await call(r, 'POST', `/api/sessions/${session.id}/reopen`)).statusCode).toBe(200);
    expect((await lifecycleActions(r, session.id)).filter((action) => action === 'reopened')).toHaveLength(1);
    expect((await spawnedArgv(r.w.logFile)).filter((line) => line.argv?.includes('-p')).length).toBe(spawns);
    expect(r.w.supervisor.isLive(session.id)).toBe(false);

    // The next message resumes the same conversation.
    expect((await call(r, 'POST', `/api/sessions/${session.id}/messages`, { text: 'What was the code word?' })).statusCode).toBe(202);
    const resumed = await until(async () => {
      const lines = (await spawnedArgv(r.w.logFile)).filter((line) => line.argv?.includes('-p'));
      return lines.length > spawns ? lines.at(-1) : undefined;
    }, 'the resumed process');
    const argv = resumed.argv ?? [];
    expect(argv[argv.indexOf('--resume') + 1]).toBe(session.claudeSessionId);
    await waitForStatus(r.w.store, session.id, ['done']);
    expect((await call(r, 'POST', '/api/sessions/no-such-session/reopen')).statusCode).toBe(404);
    expect(r.w.errors).toEqual([]);
  });
});
