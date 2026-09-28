/**
 * M3.1 oracle: the question + permission pipeline on the stdio control protocol,
 * driven end to end with fake-claude (no demo data, D13): sessions start through
 * `POST /api/sessions`, answers and permission actions go through the contract
 * routes, and what reaches the process is read from the fake's stdin log and
 * compared with the M0.2 recordings (`tools/fake-claude/fixtures/*.stdin.ndjson`).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { HubEvents, Question, Session } from '../../../src/core/api.ts';
import type { ToolPayload } from '../../../src/core/event-payload.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { QuestionRecord } from '../../../src/server/db/repos/questions.ts';
import { HubBus, type HubMessage } from '../../../src/server/hub/bus.ts';
import {
  DENY_MESSAGE,
  InboxError,
  QuestionPipeline,
  STALE_ANSWERS_KIND,
  answersByText,
  parseQuestions,
  staleAnswersText,
  validateAnswers,
} from '../../../src/server/inbox/pipeline.ts';
import { inboxCount, permissionItem, questionBatchItem } from '../../../src/server/inbox/wire.ts';
import type { ControlRequestHandler } from '../../../src/server/supervisor/supervisor.ts';
import { generateToken } from '../../../src/server/token.ts';
import { FIXTURES_DIR } from '../../../tools/fake-claude/fixtures.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { userLine } from '../../helpers/fake-claude.ts';
import {
  type SupervisorWorld,
  makeSupervisorWorld,
  newSession,
  readFakeLog,
  spawnedArgv,
  stdinOf,
  until,
  waitForEvent,
  waitForStatus,
} from '../../helpers/supervisor.ts';

const PORT = 4910; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

/** The exact keys of the contract's Question (src/core/api.ts). */
const QUESTION_KEYS = ['answerIndex', 'answeredAt', 'batchId', 'header', 'id', 'multiSelect', 'options', 'sessionId', 'source', 'state', 'text'];

interface Rig {
  readonly w: SupervisorWorld;
  readonly app: FastifyInstance;
  readonly pipeline: QuestionPipeline;
  readonly published: HubMessage[];
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.app.close();
  await rig?.w.cleanup();
  rig = undefined;
});

/**
 * A supervisor world whose control-request handler is the pipeline (joined the way
 * `createSessionServices` does it), and the app with the pipeline's routes.
 */
async function setup(scenario: string): Promise<Rig> {
  const holder: { pipeline?: QuestionPipeline } = {};
  const forward: ControlRequestHandler = {
    canUseTool: (context) => holder.pipeline?.canUseTool(context),
    cancelled: (sessionId, requestId) => holder.pipeline?.cancelled(sessionId, requestId),
    orphaned: (sessionId, ids) => holder.pipeline?.orphaned(sessionId, ids),
    pendingDelivered: (sessionId, messages) => holder.pipeline?.pendingDelivered(sessionId, messages),
  };
  const w = await makeSupervisorWorld({ scenario, controlHandler: forward });
  const bus = new HubBus();
  const published: HubMessage[] = [];
  bus.subscribe((message) => published.push(message));
  const pipeline = new QuestionPipeline({ store: w.store, bus }).bind(w.supervisor);
  holder.pipeline = pipeline;
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: w.root }, platform: 'linux', home: w.root, cwd: w.root });
  const config = { ...base, port: PORT };
  await seedFolder(w.store, w.workspace);
  const token = generateToken();
  const app = await buildApp({ config, token, store: w.store, webRoot: w.root, supervisor: w.supervisor, questions: pipeline, bus });
  await app.ready();
  tokens.set(app, token);
  rig = { w, app, pipeline, published };
  return rig;
}

const tokens = new WeakMap<FastifyInstance, string>();

function call(r: Rig, method: InjectOptions['method'], url: string, payload?: unknown) {
  return r.app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${tokens.get(r.app) ?? ''}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

async function startSession(r: Rig, task = 'Go.', name = 'demo-session'): Promise<Session> {
  const response = await call(r, 'POST', '/api/sessions', newSession({ task, name }));
  expect(response.statusCode).toBe(201);
  return response.json() as Session;
}

/** The recorded `control_response` stdin line of a fixture (its second line), as text. */
async function recordedResponse(fixture: string): Promise<{ line: string; requestId: string }> {
  const text = await readFile(path.join(FIXTURES_DIR, `${fixture}.stdin.ndjson`), 'utf8');
  const line = text.split('\n').find((l) => l.includes('"control_response"'));
  if (!line) throw new Error(`no control_response in ${fixture}`);
  const requestId = (JSON.parse(line) as { response: { request_id: string } }).response.request_id;
  return { line, requestId };
}

/** The raw stdin lines one fake process received, verbatim. */
async function rawStdin(logFile: string, pid: number): Promise<string[]> {
  return (await readFakeLog(logFile)).filter((l) => l.kind === 'stdin' && l.pid === pid).map((l) => l.line as string);
}

/** The `control_response` lines the process received, once at least one arrived (the fake logs stdin as it reads it). */
async function sentResponses(logFile: string, pid: number): Promise<string[]> {
  return until(async () => {
    const lines = (await rawStdin(logFile, pid)).filter((l) => l.includes('control_response'));
    return lines.length > 0 ? lines : undefined;
  }, 'a control_response on stdin');
}

async function pidOf(r: Rig, sessionId: string): Promise<number> {
  const session = await until(async () => {
    const s = await r.w.store.sessions.get(sessionId);
    return s?.pid ? s : undefined;
  }, 'a pid');
  return session.pid as number;
}

function hub<K extends keyof HubEvents>(r: Rig, name: K): Array<HubEvents[K]> {
  return r.published.filter((m) => m.name === name).map((m) => m.payload as HubEvents[K]);
}

async function batchOf(r: Rig, sessionId: string) {
  const [batch] = await until(async () => {
    const list = await r.w.store.questions.listBatches({ sessionId });
    return list.length > 0 ? list : undefined;
  }, 'a question batch');
  const found = await r.w.store.questions.getBatchWithQuestions(batch!.id);
  return found!;
}

describe('M3.1 · question batches (AskUserQuestion → can_use_tool)', () => {
  it('ask-2q: one batch, two verbatim questions from the main agent; the control_response equals the recording (apart from request_id)', async () => {
    const r = await setup('ask-2q');
    const session = await startSession(r, 'Ask me two questions.');
    await waitForStatus(r.w.store, session.id, ['need']);
    const { batch, questions } = await batchOf(r, session.id);

    // batchId = request_id (kept on the AskUserQuestion tool event too), tool_use_id kept, input verbatim.
    const ask = await waitForEvent(r.w.store, session.id, (e) => (e.payload as ToolPayload | null)?.name === 'AskUserQuestion');
    const toolPayload = ask.payload as ToolPayload;
    expect(batch.id).toBe(toolPayload.requestId);
    expect(batch.toolUseId).toBe(toolPayload.toolUseId);
    expect(batch.state).toBe('open');
    const recorded = await recordedResponse('ask-2q');
    const recordedInput = (JSON.parse(recorded.line) as { response: { response: { updatedInput: Record<string, unknown> } } }).response.response.updatedInput;
    const { answers: recordedAnswers, ...recordedQuestions } = recordedInput;
    expect(batch.input).toEqual(recordedQuestions);

    expect(questions.map((q) => [q.position, q.source, q.text, q.header, q.options, q.multiSelect, q.answerIndex])).toEqual([
      [0, 'acme-app-front', 'Which color should the button be?', 'Color', [
        { label: 'Red', description: 'A red button' },
        { label: 'Green', description: 'A green button' },
        { label: 'Blue', description: 'A blue button' },
      ], false, null],
      [1, 'acme-app-front', 'Which size should it be?', 'Size', [
        { label: 'Small', description: 'A small button' },
        { label: 'Large', description: 'A large button' },
      ], false, null],
    ]);

    // /hub: questionBatch with contract-shaped Question rows, inboxChanged with the count.
    const [event] = hub(r, 'questionBatch');
    expect(event).toMatchObject({ sessionId: session.id, batchId: batch.id });
    expect(event?.questions).toHaveLength(2);
    for (const q of event?.questions ?? []) expect(Object.keys(q).sort()).toEqual(QUESTION_KEYS);
    expect(event?.questions.map((q: Question) => [q.id, q.state, q.text])).toEqual(questions.map((q) => [q.id, 'open', q.text]));
    expect(hub(r, 'inboxChanged').at(-1)).toEqual({ count: 1 });
    expect((await call(r, 'GET', `/api/sessions/${session.id}`)).json()).toMatchObject({ status: 'need', openQuestionCount: 2 });

    // The Inbox item of the batch (prototype copy).
    expect(await questionBatchItem(r.w.store, batch, questions)).toMatchObject({
      id: batch.id,
      kind: 'questions',
      sessionId: session.id,
      source: 'demo-session',
      status: 'need',
      title: '2 questions from acme-app-front',
      label: '2 questions',
    });

    // 400 unless every question is answered once with a valid index; 404 for an unknown batch.
    const [q0, q1] = questions as [QuestionRecord, QuestionRecord];
    const url = `/api/questions/batch/${batch.id}/answers`;
    const refused: Array<[string, unknown, number]> = [
      ['no body', undefined, 400],
      ['not an object', 'Green', 400],
      ['1 of 2', { answers: [{ questionId: q0.id, answerIndex: 1 }] }, 400],
      ['index out of range', { answers: [{ questionId: q0.id, answerIndex: 3 }, { questionId: q1.id, answerIndex: 0 }] }, 400],
      ['not an integer', { answers: [{ questionId: q0.id, answerIndex: 1.5 }, { questionId: q1.id, answerIndex: 0 }] }, 400],
      ['twice', { answers: [{ questionId: q0.id, answerIndex: 1 }, { questionId: q0.id, answerIndex: 1 }, { questionId: q1.id, answerIndex: 0 }] }, 400],
      ['unknown question', { answers: [{ questionId: 'nope', answerIndex: 0 }, { questionId: q0.id, answerIndex: 1 }, { questionId: q1.id, answerIndex: 0 }] }, 400],
    ];
    for (const [what, body, status] of refused) {
      const response = await call(r, 'POST', url, body);
      expect(response.statusCode, what).toBe(status);
      expect(response.json().error, what).toBe('invalid');
    }
    expect((await call(r, 'POST', '/api/questions/batch/nope/answers', { answers: [] })).statusCode).toBe(404);
    const pid = await pidOf(r, session.id);
    expect((await rawStdin(r.w.logFile, pid)).filter((l) => l.includes('control_response'))).toEqual([]);

    // All answered → 204 → exactly the recorded control_response (fresh request_id).
    const answered = await call(r, 'POST', url, { answers: [{ questionId: q1.id, answerIndex: 0 }, { questionId: q0.id, answerIndex: 1 }] });
    expect(answered.statusCode).toBe(204);
    const sent = await sentResponses(r.w.logFile, pid);
    expect(sent).toEqual([recorded.line.replace(recorded.requestId, batch.id)]);
    expect(recordedAnswers).toEqual({ 'Which color should the button be?': 'Green', 'Which size should it be?': 'Small' });

    await waitForStatus(r.w.store, session.id, ['done']);
    const events = await r.w.store.events.list(session.id);
    expect(events.at(-1)?.label).toBe('You chose a green button in small size.');
    const after = await r.w.store.questions.getBatchWithQuestions(batch.id);
    expect(after?.batch).toMatchObject({ state: 'answered', deliveredVia: 'control_response' });
    expect(after?.questions.map((q) => q.answerLabel)).toEqual(['Green', 'Small']);
    expect(hub(r, 'inboxChanged').at(-1)).toEqual({ count: 0 });
    expect(hub(r, 'sessionUpdated').at(-1)).toMatchObject({ id: session.id, openQuestionCount: 0 });

    // A second answer is refused.
    const again = await call(r, 'POST', url, { answers: [{ questionId: q0.id, answerIndex: 0 }, { questionId: q1.id, answerIndex: 0 }] });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('already-answered');
  });

  it('ask-multiselect: multiSelect is stored; the one answerIndex becomes that label in answers', async () => {
    const r = await setup('ask-multiselect');
    const session = await startSession(r, 'Ask me a multi-select question.');
    await waitForStatus(r.w.store, session.id, ['need']);
    const { batch, questions } = await batchOf(r, session.id);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ text: 'Which parts should I update?', header: 'Parts', multiSelect: true });
    expect(questions[0]?.options.map((o) => o.label)).toEqual(['Code', 'Tests', 'Docs']);

    const response = await call(r, 'POST', `/api/questions/batch/${batch.id}/answers`, { answers: [{ questionId: questions[0]?.id, answerIndex: 1 }] });
    expect(response.statusCode).toBe(204);
    const recorded = await recordedResponse('ask-multiselect');
    const pid = await pidOf(r, session.id);
    const sent = await sentResponses(r.w.logFile, pid);
    // The recording chose two labels ("Tests, Docs"); the contract's one answerIndex carries one.
    expect(sent).toEqual([recorded.line.replace(recorded.requestId, batch.id).replace('"Tests, Docs"', '"Tests"')]);
    await waitForStatus(r.w.store, session.id, ['done']);
  });

  it('ask-interrupt: a pause cancels the open batch (stale, nothing written); a later answer is queued and arrives as a user message after resume', async () => {
    const r = await setup('ask-interrupt');
    const session = await startSession(r, 'Ask me one question.');
    await waitForStatus(r.w.store, session.id, ['need']);
    const { batch, questions } = await batchOf(r, session.id);
    const firstPid = await pidOf(r, session.id);

    expect((await r.w.supervisor.pause(session.id)).status).toBe('paused');
    const stale = await r.w.store.questions.getBatch(batch.id);
    expect(stale).toMatchObject({ state: 'stale', answeredAt: null });
    expect((await rawStdin(r.w.logFile, firstPid)).some((l) => l.includes('"control_response"'))).toBe(false);
    // Still answerable: in the Inbox count and the session's open question count.
    expect(await inboxCount(r.w.store)).toBe(1);
    expect((await call(r, 'GET', `/api/sessions/${session.id}`)).json()).toMatchObject({ status: 'paused', openQuestionCount: 1 });

    // Answered while paused: nothing is written and no process is spawned; the answers wait in the outbox.
    const production = questions[0]?.options.findIndex((o) => o.label === 'Production') as number;
    const response = await call(r, 'POST', `/api/questions/batch/${batch.id}/answers`, { answers: [{ questionId: questions[0]?.id, answerIndex: production }] });
    expect(response.statusCode).toBe(204);
    const text = 'Answers to your earlier questions:\n"Which environment should I target?" = "Production"';
    const pending = await r.w.store.pendingMessages.pending(session.id);
    expect(pending.map((m) => [m.kind, m.text, m.batchId])).toEqual([[STALE_ANSWERS_KIND, text, batch.id]]);
    expect(await r.w.store.questions.getBatch(batch.id)).toMatchObject({ state: 'stale', deliveredVia: null });
    expect(await inboxCount(r.w.store)).toBe(0);
    expect((await spawnedArgv(r.w.logFile)).length).toBe(1);
    expect((await rawStdin(r.w.logFile, firstPid)).some((l) => l.includes('"control_response"'))).toBe(false);

    // Resume: the answers go first in the resumed process's first message (the model does not re-ask, M0.2).
    r.w.env['FAKE_CLAUDE_SCENARIO'] = 'ask-resume';
    await call(r, 'POST', `/api/sessions/${session.id}/resume`);
    const secondPid = await pidOf(r, session.id);
    expect(secondPid).not.toBe(firstPid);
    await until(async () => (await stdinOf(r.w.logFile, secondPid)).length > 0 || undefined, 'the resume message');
    expect(await stdinOf(r.w.logFile, secondPid)).toEqual([userLine(`${text}\n\nContinue.`)]);
    await waitForStatus(r.w.store, session.id, ['done']);
    expect(await r.w.store.questions.getBatch(batch.id)).toMatchObject({ state: 'stale', deliveredVia: 'user_message' });
    expect(await r.w.store.pendingMessages.pending(session.id)).toEqual([]);
  });

  it('a stale batch answered while the session runs goes out at once as a user message', async () => {
    const r = await setup('ask-interrupt');
    const session = await startSession(r, 'Ask me one question.');
    await waitForStatus(r.w.store, session.id, ['need']);
    const { batch, questions } = await batchOf(r, session.id);
    await r.w.supervisor.pause(session.id);
    // Resumed before the answer: "Continue." alone, then the process stays live and idle.
    r.w.env['FAKE_CLAUDE_SCENARIO'] = 'default';
    await r.w.supervisor.resume(session.id);
    await waitForStatus(r.w.store, session.id, ['done']);
    const pid = await pidOf(r, session.id);
    expect(await stdinOf(r.w.logFile, pid)).toEqual([userLine('Continue.')]);

    const response = await call(r, 'POST', `/api/questions/batch/${batch.id}/answers`, { answers: [{ questionId: questions[0]?.id, answerIndex: 0 }] });
    expect(response.statusCode).toBe(204);
    await until(async () => (await stdinOf(r.w.logFile, pid)).length > 1 || undefined, 'the answers message');
    expect((await stdinOf(r.w.logFile, pid))[1]).toEqual(userLine('Answers to your earlier questions:\n"Which environment should I target?" = "Staging"'));
    expect(await r.w.store.questions.getBatch(batch.id)).toMatchObject({ state: 'stale', deliveredVia: 'user_message' });
    expect(await r.w.store.pendingMessages.pending(session.id)).toEqual([]);
    expect((await spawnedArgv(r.w.logFile)).length).toBe(2);
    const userEvents = (await r.w.store.events.list(session.id)).filter((e) => (e.payload as { type?: string; origin?: string }).origin === 'service');
    expect(userEvents).toHaveLength(1);
  });
});

describe('M3.1 · permission items (D6: Allow once / Deny)', () => {
  it('perm-allow: an Inbox permission item with tool + input verbatim; allow-once writes the recorded reply (input unchanged, no updatedPermissions)', async () => {
    const r = await setup('perm-allow');
    const session = await startSession(r, 'Run the command.');
    await waitForStatus(r.w.store, session.id, ['need']);
    const [item] = await until(async () => {
      const list = await r.w.store.permissions.list({ sessionId: session.id });
      return list.length > 0 ? list : undefined;
    }, 'a permission item');
    expect(item).toMatchObject({
      toolName: 'Bash',
      input: { command: 'node -e "console.log(6*7)"', description: 'Run Node.js calculation' },
      description: 'Run Node.js calculation',
      decisionReason: 'This command requires approval',
      agentId: null,
      state: 'open',
    });
    expect(await r.w.store.questions.listBatches({ sessionId: session.id })).toEqual([]);
    expect(hub(r, 'questionBatch')).toEqual([]);
    expect(hub(r, 'inboxChanged').at(-1)).toEqual({ count: 1 });
    expect(await permissionItem(r.w.store, item!)).toMatchObject({
      id: item!.id,
      kind: 'permission',
      source: 'demo-session',
      status: 'need',
      title: 'Bash · node -e "console.log(6*7)"',
      label: 'Permission',
      detail: 'Run Node.js calculation',
      actions: [{ id: 'allow-once', label: 'Allow once' }, { id: 'deny', label: 'Deny' }],
      permission: { requestId: item!.requestId, toolName: 'Bash', input: item!.input, agentId: null, agent: 'acme-app-front' },
    });

    expect((await call(r, 'POST', `/api/inbox/${item!.id}/actions/always`)).statusCode).toBe(400);
    expect((await call(r, 'POST', '/api/inbox/nope/actions/allow-once')).statusCode).toBe(404);
    const response = await call(r, 'POST', `/api/inbox/${item!.id}/actions/allow-once`);
    expect(response.statusCode).toBe(204);
    const recorded = await recordedResponse('perm-allow');
    const pid = await pidOf(r, session.id);
    const sent = await sentResponses(r.w.logFile, pid);
    expect(sent).toEqual([recorded.line.replace(recorded.requestId, item!.requestId)]);
    expect(sent[0]).not.toContain('updatedPermissions');
    await waitForStatus(r.w.store, session.id, ['done']);
    expect(await r.w.store.permissions.get(item!.id)).toMatchObject({ state: 'decided', decision: 'allow-once' });
    expect(hub(r, 'inboxChanged').at(-1)).toEqual({ count: 0 });
    const again = await call(r, 'POST', `/api/inbox/${item!.id}/actions/deny`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('not-open');
  });

  it('perm-deny: deny writes the recorded reply with the fixed message; the tool fails with it verbatim', async () => {
    const r = await setup('perm-deny');
    const session = await startSession(r, 'Run the command.');
    await waitForStatus(r.w.store, session.id, ['need']);
    const [item] = await until(async () => {
      const list = await r.w.store.permissions.list({ sessionId: session.id });
      return list.length > 0 ? list : undefined;
    }, 'a permission item');
    expect((await call(r, 'POST', `/api/inbox/${item!.id}/actions/deny`)).statusCode).toBe(204);
    const recorded = await recordedResponse('perm-deny');
    expect(recorded.line).toContain(DENY_MESSAGE);
    const pid = await pidOf(r, session.id);
    const sent = await sentResponses(r.w.logFile, pid);
    expect(sent).toEqual([recorded.line.replace(recorded.requestId, item!.requestId)]);
    await waitForStatus(r.w.store, session.id, ['done']);
    expect(await r.w.store.permissions.get(item!.id)).toMatchObject({ state: 'decided', decision: 'deny' });
    const bash = (await r.w.store.events.list(session.id)).find((e) => (e.payload as ToolPayload).name === 'Bash');
    expect(bash?.payload).toMatchObject({ isError: true, result: DENY_MESSAGE });
  });

  it('subagent-perm: the request is attributed to the subagent through agent_id → task_started', async () => {
    const r = await setup('subagent-perm');
    const session = await startSession(r, 'Use a subagent.');
    const [item] = await until(async () => {
      const list = await r.w.store.permissions.list({ sessionId: session.id });
      return list.length > 0 ? list : undefined;
    }, 'a permission item');
    expect(item?.agentId).toMatch(/\S/);
    const agent = await r.w.store.agents.findByTaskId(session.id, item!.agentId as string);
    expect(agent).toMatchObject({ kind: 'subagent', name: 'general-purpose' });
    expect((await permissionItem(r.w.store, item!)).permission).toMatchObject({ agentId: item!.agentId, agent: 'general-purpose', toolName: 'Bash' });
    expect((await call(r, 'POST', `/api/inbox/${item!.id}/actions/allow-once`)).statusCode).toBe(204);
    const recorded = await recordedResponse('subagent-perm');
    const pid = await pidOf(r, session.id);
    const sent = await sentResponses(r.w.logFile, pid);
    expect(sent).toEqual([recorded.line.replace(recorded.requestId, item!.requestId)]);
    await until(async () => (await r.w.store.agents.get(agent!.id))?.status === 'done' || undefined, 'the subagent done');
    await waitForStatus(r.w.store, session.id, ['done']);
  });

  it('a request still open when the process dies is stale: the permission item closes, the batch stays answerable', async () => {
    const r = await setup('perm-allow');
    const session = await startSession(r, 'Run the command.');
    await waitForStatus(r.w.store, session.id, ['need']);
    const [item] = await r.w.store.permissions.list({ sessionId: session.id });
    process.kill(await pidOf(r, session.id), 'SIGKILL');
    await waitForStatus(r.w.store, session.id, ['fail']);
    expect(await r.w.store.permissions.get(item!.id)).toMatchObject({ state: 'stale', decision: null });
    const response = await call(r, 'POST', `/api/inbox/${item!.id}/actions/allow-once`);
    expect(response.statusCode).toBe(409);
    expect(hub(r, 'inboxChanged').at(-1)).toEqual({ count: 0 });

    r.w.env['FAKE_CLAUDE_SCENARIO'] = 'ask-2q';
    const asking = await startSession(r, 'Ask me two questions.', 'ask-session');
    await waitForStatus(r.w.store, asking.id, ['need']);
    const { batch, questions } = await batchOf(r, asking.id);
    process.kill(await pidOf(r, asking.id), 'SIGKILL');
    await waitForStatus(r.w.store, asking.id, ['fail']);
    expect(await r.w.store.questions.getBatch(batch.id)).toMatchObject({ state: 'stale', answeredAt: null });
    expect(hub(r, 'inboxChanged').at(-1)).toEqual({ count: 1 });
    const answers = { answers: questions.map((question) => ({ questionId: question.id, answerIndex: 0 })) };
    expect((await call(r, 'POST', `/api/questions/batch/${batch.id}/answers`, answers)).statusCode).toBe(204);
    // No live process: queued for the next run, never spawned by the answer itself.
    expect((await r.w.store.pendingMessages.pending(asking.id)).map((m) => m.text)).toEqual([
      'Answers to your earlier questions:\n"Which color should the button be?" = "Red"\n"Which size should it be?" = "Small"',
    ]);
    expect((await spawnedArgv(r.w.logFile)).length).toBe(2);
  });
});

describe('M3.1 · pure rules', () => {
  const q = (id: string, text: string, labels: string[], position: number): QuestionRecord => ({
    id,
    batchId: 'b',
    sessionId: 's',
    position,
    source: 'main',
    text,
    header: null,
    options: labels.map((label) => ({ label })),
    multiSelect: false,
    answerIndex: null,
    answerLabel: null,
    answeredAt: null,
  });

  it('parseQuestions keeps question, header, option label + description and multiSelect verbatim; unreadable input → null', () => {
    expect(parseQuestions({ questions: [{ question: 'Q?', header: 'H', options: [{ label: 'A', description: 'd', extra: 1 }, { label: 'B' }], multiSelect: true }] })).toEqual([
      { text: 'Q?', header: 'H', options: [{ label: 'A', description: 'd' }, { label: 'B' }], multiSelect: true },
    ]);
    for (const input of [{}, { questions: [] }, { questions: [{ question: 1, options: [{ label: 'A' }] }] }, { questions: [{ question: 'Q', options: [] }] }, { questions: [{ question: 'Q', options: [{}] }] }, null]) {
      expect(parseQuestions(input)).toBeNull();
    }
  });

  it('validateAnswers wants one valid index per question', () => {
    const questions = [q('a', 'A?', ['x', 'y'], 0), q('b', 'B?', ['z'], 1)];
    expect(validateAnswers({ answers: [{ questionId: 'b', answerIndex: 0 }, { questionId: 'a', answerIndex: 1 }] }, questions)).toEqual([
      { questionId: 'b', answerIndex: 0 },
      { questionId: 'a', answerIndex: 1 },
    ]);
    for (const body of [null, {}, { answers: {} }, { answers: [{ questionId: 'a', answerIndex: 0 }] }, { answers: [{ questionId: 'a', answerIndex: -1 }, { questionId: 'b', answerIndex: 0 }] }, { answers: [{ questionId: 'a', answerIndex: '0' }, { questionId: 'b', answerIndex: 0 }] }]) {
      expect(() => validateAnswers(body, questions)).toThrow(InboxError);
    }
  });

  it('answersByText keys by question text in order; duplicate texts join their labels like the CLI', () => {
    const questions = [q('a', 'Same?', ['x', 'y'], 0), q('b', 'Other?', ['z'], 1), q('c', 'Same?', ['x', 'y'], 2)];
    expect(answersByText(questions, [{ questionId: 'a', answerIndex: 1 }, { questionId: 'b', answerIndex: 0 }, { questionId: 'c', answerIndex: 0 }])).toEqual({ 'Same?': 'y, x', 'Other?': 'z' });
    expect(answersByText(questions, [{ questionId: 'a', answerIndex: 0 }, { questionId: 'b', answerIndex: 0 }, { questionId: 'c', answerIndex: 0 }])).toEqual({ 'Same?': 'x', 'Other?': 'z' });
  });

  it('staleAnswersText lists the questions and labels verbatim', () => {
    const questions = [{ ...q('b', 'Second "quoted"?', ['z'], 1), answerLabel: 'z' }, { ...q('a', 'First?', ['x'], 0), answerLabel: 'x' }];
    expect(staleAnswersText(questions)).toBe('Answers to your earlier questions:\n"First?" = "x"\n"Second "quoted"?" = "z"');
  });
});
