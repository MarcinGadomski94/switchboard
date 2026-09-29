/**
 * D50 · Stop through the route (`POST /api/sessions/{id}/interrupt`) with the
 * question pipeline as the supervisor's control handler (as `createSessionServices`
 * joins them): an open question batch or permission request the CLI withdraws on
 * the Stop leaves the Inbox (the batch closes "turn stopped", the permission goes
 * stale); the reply carries the outcome, the session (idle) and the texts of the
 * messages the Stop took back. fake-claude, no demo data.
 */
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { InterruptResult, Session, SessionDetail } from '../../../src/core/api.ts';
import { TURN_STOPPED_REASON } from '../../../src/core/session-close.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { HubBus, type HubMessage } from '../../../src/server/hub/bus.ts';
import { QuestionPipeline } from '../../../src/server/inbox/pipeline.ts';
import { inboxCount } from '../../../src/server/inbox/wire.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, waitForStatus } from '../../helpers/supervisor.ts';

const PORT = 4911;
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

async function setup(scenario?: string): Promise<Rig> {
  const holder: { pipeline?: QuestionPipeline } = {};
  const w = await makeSupervisorWorld({
    ...(scenario ? { scenario } : {}),
    controlHandler: {
      canUseTool: (context) => holder.pipeline?.canUseTool(context),
      cancelled: (sessionId, requestId, answeredOn) => holder.pipeline?.cancelled(sessionId, requestId, answeredOn),
      orphaned: (sessionId, ids) => holder.pipeline?.orphaned(sessionId, ids),
      stopped: (sessionId, ids) => holder.pipeline?.stopped(sessionId, ids),
    },
  });
  const bus = new HubBus();
  const published: HubMessage[] = [];
  bus.subscribe((message) => published.push(message));
  const pipeline = new QuestionPipeline({ store: w.store, bus }).bind(w.supervisor);
  holder.pipeline = pipeline;
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: w.root }, platform: 'linux', home: w.root, cwd: w.root });
  await seedFolder(w.store, w.workspace);
  const token = generateToken();
  const app = await buildApp({ config: { ...base, port: PORT }, token, store: w.store, webRoot: w.root, supervisor: w.supervisor, questions: pipeline, bus });
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

async function startSession(r: Rig, task: string): Promise<Session> {
  const response = await call(r, 'POST', '/api/sessions', newSession({ task }));
  expect(response.statusCode).toBe(201);
  return response.json() as Session;
}

describe('POST /api/sessions/{id}/interrupt (D50)', () => {
  it('a question open: the batch closes "turn stopped" and leaves the Inbox; a queued message comes back; the session is idle', async () => {
    const r = await setup('ask-2q');
    const session = await startSession(r, 'Ask me two questions.');
    await waitForStatus(r.w.store, session.id, ['need']);
    expect(await inboxCount(r.w.store)).toBe(1);
    expect((await call(r, 'POST', `/api/sessions/${session.id}/messages`, { text: 'Also: keep it short.' })).statusCode).toBe(202);

    const response = await call(r, 'POST', `/api/sessions/${session.id}/interrupt`);
    expect(response.statusCode).toBe(200);
    const body = response.json() as InterruptResult;
    expect(body.outcome).toBe('stopped');
    expect(body.withdrawn).toEqual(['Also: keep it short.']);
    expect(body.session).toMatchObject({ id: session.id, status: 'idle', live: true, activity: null, openQuestionCount: 0 });

    const [batch] = await r.w.store.questions.listBatches({ sessionId: session.id });
    expect(batch).toMatchObject({ state: 'stale', closedReason: TURN_STOPPED_REASON, answeredAt: null });
    expect(await inboxCount(r.w.store)).toBe(0);
    expect(r.published.filter((m) => m.name === 'inboxChanged').at(-1)?.payload).toEqual({ count: 0 });
    // The closed batch can no longer be answered.
    const { questions } = (await call(r, 'GET', `/api/sessions/${session.id}`)).json() as SessionDetail;
    expect(questions.every((q) => q.closedReason === TURN_STOPPED_REASON)).toBe(true);
    const answer = await call(r, 'POST', `/api/questions/batch/${batch?.id ?? ''}/answers`, { answers: questions.map((q) => ({ questionId: q.id, answerIndex: 0 })) });
    expect(answer.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('a permission request open: it goes stale and leaves the Inbox', async () => {
    const r = await setup('perm-allow');
    const session = await startSession(r, 'Run ls.');
    await waitForStatus(r.w.store, session.id, ['need']);
    expect(await inboxCount(r.w.store)).toBe(1);
    const body = (await call(r, 'POST', `/api/sessions/${session.id}/interrupt`)).json() as InterruptResult;
    expect(body).toMatchObject({ outcome: 'stopped', withdrawn: [] });
    expect(body.session.status).toBe('idle');
    const [permission] = await r.w.store.permissions.list({ sessionId: session.id });
    expect(permission?.state).toBe('stale');
    expect(await inboxCount(r.w.store)).toBe(0);
  });

  it('nothing running → `idle`; an unknown session → 404', async () => {
    const r = await setup();
    const session = await startSession(r, 'Remember the code word: zeppelin. Reply with just OK.');
    await waitForStatus(r.w.store, session.id, ['done']);
    const body = (await call(r, 'POST', `/api/sessions/${session.id}/interrupt`)).json() as InterruptResult;
    expect(body).toMatchObject({ outcome: 'idle', withdrawn: [] });
    expect(body.session.status).toBe('done');
    expect((await call(r, 'POST', '/api/sessions/no-such/interrupt')).statusCode).toBe(404);
  });
});
