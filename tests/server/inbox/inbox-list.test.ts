/**
 * M3.2: `GET /api/inbox` on the real code path (no demo data, D13): sessions start
 * through `POST /api/sessions` with fake-claude as the CLI, their question batch
 * and permission request come from the recorded `ask-2q` / `perm-allow` fixtures,
 * and the list is read through the contract route. System items (raised by M3.3)
 * and branch sources (agents with a branch, M2.2 worktrees) are stored directly.
 */
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { InboxItem, Session } from '../../../src/core/api.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { QuestionPipeline } from '../../../src/server/inbox/pipeline.ts';
import { SYSTEM_ITEM_LABELS, inboxCount, questionBatchItem, sessionBranches, sourceName, systemItem } from '../../../src/server/inbox/wire.ts';
import type { ControlRequestHandler } from '../../../src/server/supervisor/supervisor.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, until, waitForStatus } from '../../helpers/supervisor.ts';

const PORT = 4911; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

/** The exact keys of an InboxItem per kind (src/core/api.ts). */
const BASE_KEYS = ['branches', 'createdAt', 'detail', 'id', 'kind', 'label', 'sessionId', 'source', 'status', 'title'];
const QUESTION_KEYS = ['answerIndex', 'answerText', 'answeredAt', 'answeredOn', 'batchId', 'closedReason', 'header', 'id', 'multiSelect', 'options', 'sessionId', 'source', 'state', 'text'];

interface Rig {
  readonly w: SupervisorWorld;
  readonly app: FastifyInstance;
  readonly token: string;
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.app.close();
  await rig?.w.cleanup();
  rig = undefined;
});

/** A supervisor world whose control-request handler is the pipeline, and the app with the real routes. */
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
  const pipeline = new QuestionPipeline({ store: w.store, bus }).bind(w.supervisor);
  holder.pipeline = pipeline;
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: w.root }, platform: 'linux', home: w.root, cwd: w.root });
  const config = { ...base, port: PORT };
  await seedFolder(w.store, w.workspace);
  const token = generateToken();
  const app = await buildApp({ config, token, store: w.store, webRoot: w.root, supervisor: w.supervisor, questions: pipeline, bus });
  await app.ready();
  rig = { w, app, token };
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

async function startSession(r: Rig, name: string, task: string): Promise<Session> {
  const response = await call(r, 'POST', '/api/sessions', newSession({ name, task }));
  expect(response.statusCode).toBe(201);
  return response.json() as Session;
}

async function list(r: Rig): Promise<InboxItem[]> {
  const response = await call(r, 'GET', '/api/inbox');
  expect(response.statusCode).toBe(200);
  return response.json() as InboxItem[];
}

describe('M3.2 · GET /api/inbox (real path: fake-claude, no demo data)', () => {
  it('lists waiting batches and permission items newest first, then open system items oldest first; shapes, branches and count', async () => {
    const r = await setup('ask-2q');
    expect(await list(r)).toEqual([]);

    const asker = await startSession(r, 'asker', 'Ask me two questions.');
    await waitForStatus(r.w.store, asker.id, ['need']);
    const [batch] = await until(async () => {
      const found = await r.w.store.questions.listBatches({ sessionId: asker.id });
      return found.length > 0 ? found : undefined;
    }, 'a question batch');

    r.w.env['FAKE_CLAUDE_SCENARIO'] = 'perm-allow';
    const runner = await startSession(r, 'runner', 'Run the command.');
    await waitForStatus(r.w.store, runner.id, ['need']);
    const [permission] = await until(async () => {
      const found = await r.w.store.permissions.list({ sessionId: runner.id });
      return found.length > 0 ? found : undefined;
    }, 'a permission item');

    // Branch sources of the asker: an agent with a branch, a worktree on the same branch (deduped), another worktree.
    await r.w.store.agents.create({ sessionId: asker.id, kind: 'subagent', name: 'web', solutionPath: 'microfrontends/acme-app-front', branch: 'feature/x' });
    await r.w.store.agents.create({ sessionId: asker.id, kind: 'subagent', name: 'reader', solutionPath: 'deprecated/old-front', branch: null });
    await r.w.store.worktrees.create({ repo: 'acme-app-front', repoPath: '/w/acme-app-front', branch: 'feature/x', path: '/w/acme-app-front-wt-asker', sessionId: asker.id });
    await r.w.store.worktrees.create({ repo: 'mobile', repoPath: '/w/mobile', branch: 'session/asker', path: '/w/mobile-wt-asker', sessionId: asker.id });
    const removed = await r.w.store.worktrees.create({ repo: 'gone', repoPath: '/w/gone', branch: 'old', path: '/w/gone-wt', sessionId: asker.id });
    await r.w.store.worktrees.markRemoved(removed.id);

    // System items (M3.3 raises them): two open (older first), one closed.
    await r.w.store.systemItems.create({
      id: 'sys-older',
      kind: 'schedule-run-failed',
      source: 'nightly-check',
      status: 'fail',
      title: 'Build failed',
      detail: 'exit 1',
      branches: [{ solution: 'mobile/', branch: 'main' }],
      actions: [
        { id: 'retry-run', label: 'Retry run' },
        { id: 'dismiss', label: 'Dismiss' },
      ],
      createdAt: '2026-09-28T00:00:00.000Z',
    });
    await r.w.store.systemItems.create({
      id: 'sys-newer',
      kind: 'something-else',
      source: 'worktrees',
      status: 'done',
      title: 'Another notice',
      detail: '',
      branches: [],
      actions: [{ id: 'keep', label: 'Keep' }],
      createdAt: '2026-09-28T00:05:00.000Z',
    });
    await r.w.store.systemItems.create({ id: 'sys-closed', kind: 'x', source: 'x', title: 'closed', detail: '', branches: [], actions: [] });
    await r.w.store.systemItems.close('sys-closed', 'dismiss');

    const items = await list(r);
    expect(items.map((item) => [item.kind, item.id])).toEqual([
      ['permission', permission!.id],
      ['questions', batch!.id],
      ['system', 'sys-older'],
      ['system', 'sys-newer'],
    ]);
    expect(items).toHaveLength(await inboxCount(r.w.store));

    const [perm, questions, older, newer] = items as [InboxItem, InboxItem, InboxItem, InboxItem];
    // D22: session items also carry `sourceTitle` (the session's title, else its name).
    expect(Object.keys(perm).sort()).toEqual([...BASE_KEYS, 'actions', 'permission', 'sourceTitle'].sort());
    expect(perm).toMatchObject({
      sessionId: runner.id,
      source: 'runner',
      status: 'need',
      title: 'Bash · node -e "console.log(6*7)"',
      label: 'Permission',
      detail: 'Run Node.js calculation',
      branches: [],
      actions: [
        { id: 'allow-once', label: 'Allow once' },
        { id: 'deny', label: 'Deny' },
      ],
      permission: { toolName: 'Bash', input: { command: 'node -e "console.log(6*7)"', description: 'Run Node.js calculation' }, agent: 'acme-app-front' },
    });

    expect(Object.keys(questions).sort()).toEqual([...BASE_KEYS, 'questions', 'sourceTitle'].sort());
    expect(questions).toMatchObject({
      sessionId: asker.id,
      source: 'asker',
      status: 'need',
      title: '2 questions from acme-app-front',
      label: '2 questions',
      detail: '',
      createdAt: batch!.createdAt,
      branches: [
        { solution: 'acme-app-front', branch: 'feature/x' },
        { solution: 'mobile', branch: 'session/asker' },
      ],
    });
    expect(questions.questions?.map((q) => [q.text, q.state, q.answerIndex])).toEqual([
      ['Which color should the button be?', 'open', null],
      ['Which size should it be?', 'open', null],
    ]);
    for (const q of questions.questions ?? []) expect(Object.keys(q).sort()).toEqual(QUESTION_KEYS);

    expect(older).toEqual({
      id: 'sys-older',
      kind: 'system',
      sessionId: null,
      source: 'nightly-check',
      status: 'fail',
      title: 'Build failed',
      label: 'Scheduled run failed',
      detail: 'exit 1',
      createdAt: '2026-09-28T00:00:00.000Z',
      branches: [{ solution: 'mobile/', branch: 'main' }],
      actions: [
        { id: 'retry-run', label: 'Retry run' },
        { id: 'dismiss', label: 'Dismiss' },
      ],
    });
    expect(newer).toMatchObject({ id: 'sys-newer', label: 'something-else', status: 'done', actions: [{ id: 'keep', label: 'Keep' }] });

    // Answered through the contract route → it leaves the list; the count follows.
    const [q0, q1] = questions.questions ?? [];
    const answered = await call(r, 'POST', `/api/questions/batch/${batch!.id}/answers`, {
      answers: [
        { questionId: q0?.id, answerIndex: 1 },
        { questionId: q1?.id, answerIndex: 0 },
      ],
    });
    expect(answered.statusCode).toBe(204);
    // The permission item is decided through the Inbox action.
    expect((await call(r, 'POST', `/api/inbox/${perm.id}/actions/allow-once`)).statusCode).toBe(204);
    const after = await list(r);
    expect(after.map((item) => item.id)).toEqual(['sys-older', 'sys-newer']);
    expect(after).toHaveLength(await inboxCount(r.w.store));
    await waitForStatus(r.w.store, asker.id, ['done']);
    await waitForStatus(r.w.store, runner.id, ['done']);
  });

  it('keeps a stale, unanswered batch in the list (still answerable) and drops it once answered', async () => {
    const r = await setup('ask-interrupt');
    const session = await startSession(r, 'pauser', 'Ask me one question.');
    await waitForStatus(r.w.store, session.id, ['need']);
    await r.w.supervisor.pause(session.id);
    const [item] = await list(r);
    expect(item).toMatchObject({ kind: 'questions', sessionId: session.id, title: 'Which environment should I target?', label: 'Question' });
    expect(item?.questions?.[0]?.state).toBe('stale');
    const response = await call(r, 'POST', `/api/questions/batch/${item!.id}/answers`, { answers: [{ questionId: item?.questions?.[0]?.id, answerIndex: 0 }] });
    expect(response.statusCode).toBe(204);
    expect(await list(r)).toEqual([]);
  });
});

describe('M3.2 · Inbox item rules (prototype copy)', () => {
  it('names a source by the part before " · " (prototype title "n questions from web, mobile, (orchestrator)")', async () => {
    expect(sourceName('web · microfrontends/acme-app-front')).toBe('web');
    expect(sourceName('qa-web-playwright · acme-app-front')).toBe('qa-web-playwright');
    expect(sourceName('(orchestrator)')).toBe('(orchestrator)');
    expect(sourceName('orchestrator')).toBe('orchestrator');

    const r = await setup('default');
    const session = await r.w.store.sessions.create({ name: 'three-sources', task: 't', claudeSessionId: 'c1', status: 'need', solutions: [] });
    const created = await r.w.store.questions.createBatch({ id: 'b-3', sessionId: session.id, input: { questions: [] } }, [
      { source: 'web · microfrontends/acme-app-front', text: 'A?', options: [{ label: 'a' }] },
      { source: 'mobile · mobile/', text: 'B?', options: [{ label: 'b' }] },
      { source: '(orchestrator)', text: 'C?', options: [{ label: 'c' }] },
      { source: 'web · microfrontends/acme-app-front', text: 'D?', options: [{ label: 'd' }] },
    ]);
    const item = await questionBatchItem(r.w.store, created.batch, created.questions);
    expect(item.title).toBe('4 questions from web, mobile, (orchestrator)');
    expect(item.label).toBe('4 questions');
    // The questions keep their full source (shown in mono blue on the card).
    expect(item.questions?.map((q) => q.source)).toEqual(['web · microfrontends/acme-app-front', 'mobile · mobile/', '(orchestrator)', 'web · microfrontends/acme-app-front']);
  });

  it('branch chips: agents with a branch in agent order (last folder of the path), then live worktrees not already named', async () => {
    const r = await setup('default');
    const session = await r.w.store.sessions.create({ name: 'chips', task: 't', claudeSessionId: 'c2', status: 'need', solutions: [] });
    await r.w.store.agents.create({ sessionId: session.id, kind: 'main', name: 'orchestrator', solutionPath: 'workspace root', branch: null });
    await r.w.store.agents.create({ sessionId: session.id, name: 'web', solutionPath: 'microfrontends/acme-app-front', branch: 'feature/free-talk-360' });
    await r.w.store.agents.create({ sessionId: session.id, name: 'mobile', solutionPath: 'mobile/', branch: 'feature/free-talk-360' });
    await r.w.store.agents.create({ sessionId: session.id, name: 'mobile-2', solutionPath: 'mobile', branch: 'feature/free-talk-360' });
    await r.w.store.worktrees.create({ repo: 'mobile', repoPath: '/w/mobile', branch: 'feature/free-talk-360', path: '/w/mobile-wt', sessionId: session.id });
    await r.w.store.worktrees.create({ repo: 'calendar-func', repoPath: '/w/calendar-func', branch: 'session/chips', path: '/w/cf-wt', sessionId: session.id });
    expect(await sessionBranches(r.w.store, session.id)).toEqual([
      { solution: 'acme-app-front', branch: 'feature/free-talk-360' },
      { solution: 'mobile', branch: 'feature/free-talk-360' },
      { solution: 'calendar-func', branch: 'session/chips' },
    ]);
  });

  it('system items: the kind label of the known kinds, else the stored kind', () => {
    expect(SYSTEM_ITEM_LABELS).toEqual({ 'schedule-run-failed': 'Scheduled run failed', 'worktree-removable': 'PR merged' });
    const record = {
      id: 's',
      kind: 'worktree-removable',
      source: 'worktrees',
      status: 'done' as const,
      title: 'PR merged',
      detail: 'd',
      branches: [],
      actions: [],
      sessionId: 'x',
      scheduleId: null,
      scheduleRunId: null,
      worktreeId: 'w',
      payload: null,
      state: 'open' as const,
      closedAction: null,
      createdAt: '2026-09-28T00:00:00.000Z',
      closedAt: null,
    };
    expect(systemItem(record)).toMatchObject({ kind: 'system', label: 'PR merged', sessionId: 'x' });
    expect(systemItem({ ...record, kind: 'Scheduled run failed' }).label).toBe('Scheduled run failed');
  });
});
