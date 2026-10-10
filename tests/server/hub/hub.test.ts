import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type {
  Agent,
  AgentActivity,
  BackgroundTask,
  HubEvents,
  Question,
  Session,
  SessionActivity,
  SessionEvent,
  SystemInfo,
  Worktree,
} from '../../../src/core/api.ts';
import { HUB_EVENT_NAMES } from '../../../src/core/api.ts';
import type { UserPayload } from '../../../src/core/event-payload.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { DEFAULT_KEEPALIVE_MS, DEFAULT_SYSTEM_INTERVAL_MS } from '../../../src/server/hub/hub.ts';
import type { SystemProvider } from '../../../src/server/providers.ts';
import { generateToken } from '../../../src/server/token.ts';
import { toWorktree } from '../../../src/server/worktrees/wire.ts';
import type { WorktreeManager } from '../../../src/server/worktrees/manager.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';
import { rawRequest } from '../../helpers/net.ts';
import { type HubStream, type SseParser, listenOnFreeTestPort, openHub, requestJson } from '../../helpers/sse.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, waitForEvent, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * Contract oracle for `/hub` (M2.3, D5, contracts/local-api.md → Event hub):
 * a real socket on a 4871–4879 test port, the real guard, and every event name
 * with its payload checked field by field. `sessionUpdated` / `event` come from
 * a real fake-claude session started through `POST /api/sessions`,
 * `worktreeRemovable` from a real worktree in a temp git repo with the fake gh
 * (D13, no demo data); `questionBatch`, `inboxChanged` and `scheduleRun` are
 * published on the bus the way their services (M3.1, M3.2/M3.3, M7.1) will;
 * `system` comes from a SystemProvider on the timer.
 */

// ── the contract's payload fields, checked exhaustively against src/core/api.ts ──

/** Compile-time: `Keys` lists every key of `T` (and nothing else). */
type Exhaustive<T, Keys extends readonly (keyof T)[]> = [Exclude<keyof T, Keys[number]>] extends [never] ? Keys : never;
function keys<T>() {
  return <const K extends readonly (keyof T)[]>(list: Exhaustive<T, K>): readonly string[] => [...list].map(String).sort();
}

const SESSION_KEYS = keys<Session>()([
  'id',
  'name',
  'claudeSessionId',
  'status',
  'workType',
  'mode',
  'phase',
  'coordination',
  'qaStack',
  'ultracode',
  'worktrees',
  'solutions',
  'attached',
  'createdAt',
  'lastActivityAt',
  'agents',
  'openQuestionCount',
  // additive, M4.1 (the session header)
  'cwd',
  // additive, D14 (the session's folder)
  'folder',
  'folderPath',
  'folderKind',
  // additive, D16 (moved in from a terminal)
  'origin',
  'live',
  // additive, D19 (live activity)
  'activity',
  'resumeCommand',
  'chips',
  // additive, M7.2 (loop cards)
  'loops',
  'ownedLoops',
  // additive, D22 (session titles)
  'title',
  'displayTitle',
  // additive, D24 (Remote Control)
  'remote',
  // additive, D25 (a local copy of a remote session)
  'remoteSource',
  // additive, D31 (model and effort)
  'model',
  // additive, D33 (closed sessions)
  'closedAt',
  // additive, D49 (context window meter)
  'context',
  // additive, D48 (a peer's session: its machine; null here)
  'machine',
  // additive, D48 P4 (a hooked terminal session)
  'hooked',
  // additive, D51 (workflow runs)
  'workflows',
  // additive, D53 (a hooked session's delivery state; absent on every other session)
  'hookStatus',
  // additive, D62 (the session's CLI, a switch in progress)
  'provider',
  'providerSwitch',
  'profileId',
  'profileName',
  'profilePinned',
  'accountSwitching',
  'movedTo',
  'movedFrom',
  // additive, D68 (the session's open todos)
  'openTodoCount',
  // additive, D76 (a todo's run session)
  'todoLink',
  // additive, D83 (continued in / from a fresh session, a continuation running)
  'continuedTo',
  'continuedFrom',
  'freshContinue',
  // D91
  'instructionOutdated',
  'instructionPending',
  // additive, D95 follow-up (only on a delta stream's updates; not on this plain one)
  'agentsDelta',
]).filter((key) => key !== 'hookStatus' && key !== 'agentsDelta');
const AGENT_KEYS = keys<Agent>()([
  'id',
  'kind',
  'name',
  'description',
  'solutionPath',
  'branch',
  'status',
  'statusText',
  // additive, D36 (the call that started a subagent: its chat)
  'toolUseId',
  // additive, D51 (a workflow agent's facts; null for the others)
  'workflow',
]);
const EVENT_WRAPPER_KEYS = keys<HubEvents['event']>()(['sessionId', 'event']);
const SESSION_EVENT_KEYS = keys<SessionEvent>()(['id', 'sessionId', 'agentId', 'ts', 'endTs', 'kind', 'label', 'payload']);
const QUESTION_BATCH_KEYS = keys<HubEvents['questionBatch']>()(['sessionId', 'batchId', 'questions']);
const QUESTION_KEYS = keys<Question>()([
  'id',
  'batchId',
  'sessionId',
  'source',
  'text',
  'header',
  'options',
  'multiSelect',
  'state',
  'answerIndex',
  'answeredAt',
  // additive, D39 (own answer)
  'answerText',
  // additive, D24 (answered on claude.ai)
  'answeredOn',
  // additive, D33 (closed with its session)
  'closedReason',
  // additive, D44 (answers waiting in the outbox)
  'queued',
]);
const INBOX_CHANGED_KEYS = keys<HubEvents['inboxChanged']>()(['count']);
const ACTIVITY_EVENT_KEYS = keys<HubEvents['activity']>()(['sessionId', 'activity']);
const SESSION_ACTIVITY_KEYS = keys<SessionActivity>()([
  'turnStartedAt',
  'state',
  'since',
  'tool',
  'summary',
  'thinkingTokens',
  'agents',
  // additive, D30 (background work)
  'background',
  // additive, D53 (a hooked session's newest sign of life; absent on a supervised session)
  'quietSince',
]).filter((key) => key !== 'quietSince');
const AGENT_ACTIVITY_KEYS = keys<AgentActivity>()(['state', 'since', 'startedAt', 'tool', 'summary']);
/** D30: `wakeAt` only on a wake-up; D51: `workflow` only on a workflow whose run is known. */
const BACKGROUND_TASK_KEYS = keys<BackgroundTask>()(['id', 'toolUseId', 'kind', 'summary', 'startedAt', 'wakeAt', 'github', 'workflow']).filter((key) => key !== 'wakeAt' && key !== 'workflow');
const WORKTREE_KEYS = keys<Worktree>()(['id', 'repo', 'branch', 'path', 'sessionId', 'prNumber', 'prState', 'removable']);
const SCHEDULE_RUN_KEYS = keys<HubEvents['scheduleRun']>()(['scheduleId', 'result']);
/** The contract's `/api/system` fields; `usagePct` (and the additive `usageResetsAt`) only when known, the additive `usageWarnings` (M9.2) only when any are in force, `usageWindows` (D17) only when any is known. */
const SYSTEM_REQUIRED_KEYS = ['cli', 'cliVersion', 'signedIn', 'ghSignedIn', 'cpu', 'ramUsed', 'ramTotal', 'processes'].sort();
keys<SystemInfo>()(['cli', 'cliVersion', 'signedIn', 'ghSignedIn', 'cpu', 'ramUsed', 'ramTotal', 'processes', 'usagePct', 'usageResetsAt', 'usageWarnings', 'usageWindows', 'cliUsage', 'accountUsage', 'activeAccounts']);

function keysOf(value: unknown): string[] {
  return Object.keys(value as object).sort();
}

/** Every block the hub sent is `event: <contract name>\ndata: <one line of JSON>\n\n`. */
function expectWellFormed(parser: SseParser): void {
  expect(parser.unexpected).toEqual([]);
  for (const message of parser.messages) {
    expect(HUB_EVENT_NAMES).toContain(message.event);
    expect(message.dataLines).toBe(1);
    expect(message.raw).toBe(`event: ${message.event}\ndata: ${message.data}\n\n`);
    expect(() => JSON.parse(message.data) as unknown).not.toThrow();
  }
  for (const comment of parser.comments) expect(comment.text).toBe('keepalive');
}

// ── the world: fake-claude supervisor + real git worktrees + a listening app ──

const SYSTEM_INFO: SystemInfo = {
  cli: '/usr/local/bin/claude',
  cliVersion: '2.1.283',
  signedIn: true,
  ghSignedIn: false,
  cpu: 12.5,
  ramUsed: 8 * 1024 ** 3,
  ramTotal: 32 * 1024 ** 3,
  processes: 2,
};

let sw: SupervisorWorld;
let gw: GitWorld;
let manager: WorktreeManager;
let bus: HubBus;
let app: FastifyInstance;
let port = 0;
let token = '';
let cookie = '';
let systemCalls = 0;
const streams: HubStream[] = [];

async function connect(): Promise<HubStream> {
  const stream = await openHub({ port, cookie });
  streams.push(stream);
  expect(stream.status).toBe(200);
  return stream;
}

beforeAll(async () => {
  sw = await makeSupervisorWorld({ scenario: 'tool-use' });
  gw = await makeGitWorld({ root: sw.root, workspace: sw.workspace, store: sw.store, baseEnv: sw.env });
  manager = gw.manager({ sessions: sw.supervisor });
  bus = new HubBus();
  token = generateToken();
  cookie = `sb_token=${token}`;
  const system: SystemProvider = {
    async system() {
      systemCalls += 1;
      return SYSTEM_INFO;
    },
  };
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: sw.root }, platform: 'linux', home: sw.root, cwd: sw.root });
  await seedFolder(sw.store, sw.workspace);
  ({ app, port } = await listenOnFreeTestPort((candidate) =>
    buildApp({
      config: { ...base, port: candidate },
      token,
      store: sw.store,
      webRoot: sw.root,
      supervisor: sw.supervisor,
      worktrees: manager,
      bus,
      providers: { system, diff: manager },
      hub: { keepaliveMs: 150, systemIntervalMs: 200 },
    }),
  ));
  // Before any client: the app's own bus listeners.
  ownListeners = bus.listenerCount;
});

let ownListeners = 0;

afterEach(() => {
  for (const stream of streams.splice(0)) stream.close();
});

afterAll(async () => {
  await app?.close();
  await sw?.cleanup();
});

describe('/hub · transport (D5)', () => {
  it('is cookie-authenticated like every API call: 401 without the cookie, 403 for a foreign Host or Origin', async () => {
    const noCookie = await rawRequest({ port, path: '/hub', headers: { accept: 'text/event-stream' } });
    expect(noCookie.status).toBe(401);
    expect(JSON.parse(noCookie.body)).toEqual({ error: 'unauthorized' });

    const wrongCookie = await rawRequest({ port, path: '/hub', headers: { cookie: `sb_token=${generateToken()}` } });
    expect(wrongCookie.status).toBe(401);

    const foreignOrigin = await rawRequest({ port, path: '/hub', headers: { cookie, origin: 'http://evil.example' } });
    expect(foreignOrigin.status).toBe(403);
    expect(JSON.parse(foreignOrigin.body)).toEqual({ error: 'forbidden-origin' });

    const foreignHost = await rawRequest({ port, path: '/hub', headers: { cookie, host: `evil.example:${port}` } });
    expect(foreignHost.status).toBe(403);
    expect(JSON.parse(foreignHost.body)).toEqual({ error: 'forbidden-host' });

    // Only GET: no HEAD stream, no other method.
    expect((await rawRequest({ port, path: '/hub', method: 'HEAD', headers: { cookie } })).status).toBe(404);
    expect((await rawRequest({ port, path: '/hub', method: 'POST', headers: { cookie } })).status).toBe(404);
  });

  it('answers 200 text/event-stream, uncached, with the service origin allowed', async () => {
    const stream = await connect();
    expect(stream.headers['content-type']).toBe('text/event-stream');
    expect(stream.headers['cache-control']).toBe('no-store');
    expect(stream.headers['set-cookie']).toBeUndefined();

    const sameOrigin = await openHub({ port, cookie, headers: { origin: `http://127.0.0.1:${port}` } });
    streams.push(sameOrigin);
    expect(sameOrigin.status).toBe(200);
  });

  it('sends a `: keepalive` comment on its interval; production interval ≤ 15 s, system every 5 s', async () => {
    expect(DEFAULT_KEEPALIVE_MS).toBeLessThanOrEqual(15_000);
    expect(DEFAULT_SYSTEM_INTERVAL_MS).toBe(5_000);
    const stream = await connect();
    const connectedAt = Date.now();
    await stream.waitFor((p) => p.comments.length >= 3, '3 keepalives');
    const times = [connectedAt, ...stream.parser.comments.map((c) => c.at)];
    for (let i = 1; i < 4; i += 1) expect(times[i]! - times[i - 1]!).toBeLessThan(150 + 250);
    expect(stream.body()).toContain(': keepalive\n\n');
    expectWellFormed(stream.parser);
  });
});

describe('/hub · events (contract, field by field)', () => {
  it('sessionUpdated + event: a real session (fake-claude) streams the same Session and Event shapes the REST API returns', async () => {
    const stream = await connect();
    const created = await requestJson(port, 'POST', '/api/sessions', cookie, newSession({ name: 'hub-contract' }));
    expect(created.status).toBe(201);
    const session = created.body as Session;
    await waitForStatus(sw.store, session.id, ['done']);
    await stream.waitFor(
      () => stream.payloads<Session>('sessionUpdated').some((s) => s.id === session.id && s.status === 'done'),
      'sessionUpdated with status done',
    );

    // sessionUpdated: exactly the Session fields; the last one equals GET /api/sessions.
    const updates = stream.payloads<Session>('sessionUpdated').filter((s) => s.id === session.id);
    expect(updates.map((s) => s.status)).toContain('run');
    for (const update of updates) {
      expect(keysOf(update)).toEqual(SESSION_KEYS);
      for (const agent of update.agents) expect(keysOf(agent)).toEqual(AGENT_KEYS);
    }
    const listed = (await requestJson(port, 'GET', '/api/sessions', cookie)).body as Session[];
    expect(updates.at(-1)).toEqual(listed.find((s) => s.id === session.id));
    // D49: the context meter arrives with sessionUpdated as the usage comes (the recorded turn: 47 780 of a reported 200 000).
    expect(updates.some((s) => s.context?.tokens === null)).toBe(true);
    expect(updates.at(-1)?.context).toMatchObject({ tokens: expect.any(Number), window: 200_000, windowSource: 'reported', band: 'ok', compaction: null });

    // event: { sessionId, event: Event }; every stored event was streamed, the last version of each equals GET …/events.
    const wrapped = stream.payloads<HubEvents['event']>('event').filter((e) => e.sessionId === session.id);
    const stored = (await requestJson(port, 'GET', `/api/sessions/${session.id}/events`, cookie)).body as SessionEvent[];
    expect(stored.length).toBeGreaterThanOrEqual(5);
    const lastById = new Map<number, SessionEvent>();
    for (const message of wrapped) {
      expect(keysOf(message)).toEqual(EVENT_WRAPPER_KEYS);
      expect(keysOf(message.event)).toEqual(SESSION_EVENT_KEYS);
      expect(message.event.sessionId).toBe(message.sessionId);
      lastById.set(message.event.id, message.event);
    }
    expect([...lastById.keys()].sort((a, b) => a - b)).toEqual(stored.map((e) => e.id));
    for (const event of stored) expect(lastById.get(event.id)).toEqual(event);
    // Tool calls are re-sent when their result closes them (same id, endTs set).
    const tools = stored.filter((e) => (e.payload as { type?: string }).type === 'tool');
    expect(tools.length).toBe(2);
    for (const tool of tools) expect(wrapped.filter((m) => m.event.id === tool.id).length).toBeGreaterThanOrEqual(2);

    expectWellFormed(stream.parser);
  });

  it('activity (D19, additive): a real turn streams { sessionId, activity }, at most one per second, ending with null like Session.activity', async () => {
    const stream = await connect();
    const created = await requestJson(port, 'POST', '/api/sessions', cookie, newSession({ name: 'hub-activity' }));
    expect(created.status).toBe(201);
    const session = created.body as Session;
    await waitForStatus(sw.store, session.id, ['done']);
    // The turn arrives in one burst: the leading value at once, the trailing one (idle) about a second later.
    await stream.waitFor(
      () => {
        const mine = stream.payloads<HubEvents['activity']>('activity').filter((a) => a.sessionId === session.id);
        return mine.length >= 2 && mine.at(-1)?.activity === null;
      },
      'the idle activity',
    );
    const messages = stream.parser.messages.filter((m) => m.event === 'activity' && (JSON.parse(m.data) as HubEvents['activity']).sessionId === session.id);
    for (let i = 1; i < messages.length; i += 1) expect(messages[i]!.at - messages[i - 1]!.at).toBeGreaterThanOrEqual(900);
    const payloads = messages.map((m) => JSON.parse(m.data) as HubEvents['activity']);
    for (const payload of payloads) {
      expect(keysOf(payload)).toEqual(ACTIVITY_EVENT_KEYS);
      if (payload.activity === null) continue;
      expect(keysOf(payload.activity)).toEqual(SESSION_ACTIVITY_KEYS);
      expect(Object.keys(payload.activity.agents).length).toBeGreaterThan(0);
      for (const agent of Object.values(payload.activity.agents)) expect(keysOf(agent)).toEqual(AGENT_ACTIVITY_KEYS);
    }
    const first = payloads[0]?.activity;
    expect(first).toMatchObject({ state: 'thinking', tool: null, summary: null });
    expect(Date.parse(first?.turnStartedAt ?? '')).not.toBeNaN();
    const main = (await sw.store.agents.listBySession(session.id)).find((a) => a.kind === 'main');
    expect(Object.keys(first?.agents ?? {})).toEqual([main?.id]);
    // Idle now: the event's last value, the REST Session and the last sessionUpdated agree.
    const listed = ((await requestJson(port, 'GET', '/api/sessions', cookie)).body as Session[]).find((s) => s.id === session.id);
    expect(listed?.activity).toBeNull();
    const detail = (await requestJson(port, 'GET', `/api/sessions/${session.id}`, cookie)).body as Session;
    expect(detail.activity).toBeNull();
    expect(stream.payloads<Session>('sessionUpdated').filter((s) => s.id === session.id).at(-1)?.activity).toBeNull();
    expectWellFormed(stream.parser);
  });

  it('activity (D30, additive): a background wait streams state `background` with its task after the turn, then null once the task ended and the CLI\'s own turn is over', async () => {
    const stream = await connect();
    const created = await requestJson(port, 'POST', '/api/sessions', cookie, newSession({ name: 'hub-background', task: 'Wait for the CI run. [fake:background-gh 4]' }));
    expect(created.status).toBe(201);
    const session = created.body as Session;
    const mine = (): Array<HubEvents['activity']> => stream.payloads<HubEvents['activity']>('activity').filter((a) => a.sessionId === session.id);
    await stream.waitFor(() => mine().some((a) => a.activity?.state === 'background'), 'the background activity');
    const waiting = mine().find((a) => a.activity?.state === 'background')?.activity as SessionActivity;
    expect(keysOf(waiting)).toEqual(SESSION_ACTIVITY_KEYS);
    const summary = 'gh run view 4242 --json status --jq .status';
    expect(waiting).toMatchObject({ state: 'background', tool: 'Bash', summary, thinkingTokens: null, since: waiting.turnStartedAt });
    expect(waiting.background).toHaveLength(1);
    const task = waiting.background[0] as BackgroundTask;
    expect(keysOf(task)).toEqual(BACKGROUND_TASK_KEYS);
    expect(task).toMatchObject({ kind: 'bash', github: true, summary, startedAt: waiting.since });
    expect(task.toolUseId).toMatch(/^toolu_/);
    const main = (await sw.store.agents.listBySession(session.id)).find((a) => a.kind === 'main');
    expect(Object.keys(waiting.agents)).toEqual([main?.id]);
    expect(keysOf(waiting.agents[main?.id ?? ''])).toEqual(AGENT_ACTIVITY_KEYS);
    // REST agrees while it waits; the session's status is the finished turn's (D30 changes the activity only).
    const detail = (await requestJson(port, 'GET', `/api/sessions/${session.id}`, cookie)).body as Session;
    expect(detail.status).toBe('done');
    expect(detail.activity).toMatchObject({ state: 'background', background: [{ id: task.id, toolUseId: task.toolUseId }] });
    // The task ends (its notification, then the CLI's own turn, a burst the throttle folds): idle again, the last event null.
    await waitForEvent(sw.store, session.id, (e) => (e.payload as { taskNotification?: boolean }).taskNotification === true, 15_000);
    await stream.waitFor(() => mine().at(-1)?.activity === null, 'the idle activity after the CLI\'s turn');
    const after = mine().slice(mine().findIndex((a) => a.activity?.state === 'background'));
    expect(after.every((a) => a.activity === null || a.activity.state === 'background' || a.activity.background.length === 0)).toBe(true);
    const listed = ((await requestJson(port, 'GET', '/api/sessions', cookie)).body as Session[]).find((s) => s.id === session.id);
    expect(listed?.activity).toBeNull();
    expectWellFormed(stream.parser);
  });

  it('event (D44, additive): a message sent while a turn waits streams its user event with `queued: "turn"`, then the same event without it once the CLI takes it up', async () => {
    const stream = await connect();
    const created = await requestJson(port, 'POST', '/api/sessions', cookie, newSession({ name: 'hub-queued', task: '[fake:hold 1.5] Think for a while.' }));
    expect(created.status).toBe(201);
    const session = created.body as Session;
    await waitForStatus(sw.store, session.id, ['run']);
    const sent = await requestJson(port, 'POST', `/api/sessions/${session.id}/messages`, cookie, { text: 'Keep it short.' });
    expect(sent.status).toBe(202);
    const message = await waitForEvent(sw.store, session.id, (e) => (e.payload as UserPayload).text === 'Keep it short.');
    const versions = (): UserPayload[] =>
      stream.payloads<HubEvents['event']>('event').filter((m) => m.event.id === message.id).map((m) => m.event.payload as UserPayload);
    await stream.waitFor(() => versions().length > 0, 'the queued message');
    expect(versions()[0]).toEqual({ type: 'user', text: 'Keep it short.', origin: 'user', delivered: false, queued: 'turn' });

    // The turn thinks without a tool boundary, ends, and the next turn starts on the message.
    await stream.waitFor(() => versions().at(-1)?.delivered === true, 'the message delivered');
    expect(versions()).toEqual([
      { type: 'user', text: 'Keep it short.', origin: 'user', delivered: false, queued: 'turn' },
      { type: 'user', text: 'Keep it short.', origin: 'user', delivered: false },
      { type: 'user', text: 'Keep it short.', origin: 'user', delivered: true },
    ]);
    for (const m of stream.payloads<HubEvents['event']>('event').filter((e) => e.event.id === message.id)) expect(keysOf(m.event)).toEqual(SESSION_EVENT_KEYS);
    // REST agrees.
    const stored = (await requestJson(port, 'GET', `/api/sessions/${session.id}/events`, cookie)).body as SessionEvent[];
    expect(stored.find((e) => e.id === message.id)?.payload).toEqual(versions().at(-1));
    await waitForStatus(sw.store, session.id, ['done']);
    expectWellFormed(stream.parser);
  });

  it('worktreeRemovable: a real worktree whose PR merged (temp git repo + fake gh) streams the Worktree', async () => {
    const stream = await connect();
    const [record] = await manager.createForSession('hub-pr', ['web-front'], gw.folder);
    if (!record) throw new Error('no worktree');
    await gw.setPullRequests({ 'session/hub-pr': { number: 7, state: 'MERGED', url: 'https://github.com/acme/web-front/pull/7' } });
    expect((await manager.checkPullRequests()).find((c) => c.worktreeId === record.id)).toMatchObject({ prState: 'MERGED', removable: true });

    const [payload] = await stream.waitFor((p) => {
      const found = p.messages.filter((m) => m.event === 'worktreeRemovable');
      return found.length > 0 ? found.map((m) => JSON.parse(m.data) as Worktree) : undefined;
    }, 'worktreeRemovable');
    expect(keysOf(payload)).toEqual(WORKTREE_KEYS);
    const row = await sw.store.worktrees.get(record.id);
    if (!row) throw new Error('worktree row gone');
    expect(payload).toEqual(toWorktree(row));
    expect(payload).toMatchObject({ repo: 'web-front', branch: 'session/hub-pr', prNumber: 7, prState: 'MERGED', removable: true });
    expectWellFormed(stream.parser);
  });

  it('questionBatch, inboxChanged, scheduleRun: what services publish on the bus reaches every client verbatim', async () => {
    const first = await connect();
    const second = await connect();
    const questions: Question[] = [
      {
        id: 'q1',
        batchId: 'req_1',
        sessionId: 's1',
        source: 'main',
        text: 'Which breakpoint first?',
        header: 'Breakpoint',
        options: [{ label: '360', description: 'phone' }, { label: '1366' }],
        multiSelect: false,
        state: 'open',
        answerIndex: null,
        answeredAt: null,
        answerText: null,
        answeredOn: null,
        closedReason: null,
        queued: null,
      },
      {
        id: 'q2',
        batchId: 'req_1',
        sessionId: 's1',
        source: 'main',
        text: 'Line one\nline two "quoted"',
        header: null,
        options: [{ label: 'Yes' }, { label: 'No' }],
        multiSelect: true,
        state: 'open',
        answerIndex: null,
        answeredAt: null,
        answerText: null,
        answeredOn: null,
        closedReason: null,
        queued: null,
      },
    ];
    const batch: HubEvents['questionBatch'] = { sessionId: 's1', batchId: 'req_1', questions };
    bus.publish('questionBatch', batch);
    bus.publish('inboxChanged', { count: 3 });
    bus.publish('scheduleRun', { scheduleId: 'nightly-reindex', result: 'fail' });

    for (const stream of [first, second]) {
      await stream.waitFor((p) => p.messages.some((m) => m.event === 'scheduleRun'), 'scheduleRun');
      // `system` runs on its timer; a trailing `activity` of the earlier tests' session may still arrive (D19, ≤ 1 s later).
      const names = stream.parser.messages.map((m) => m.event).filter((n) => n !== 'system' && n !== 'activity');
      expect(names).toEqual(['questionBatch', 'inboxChanged', 'scheduleRun']);

      const [sentBatch] = stream.payloads<HubEvents['questionBatch']>('questionBatch');
      expect(keysOf(sentBatch)).toEqual(QUESTION_BATCH_KEYS);
      for (const question of sentBatch!.questions) expect(keysOf(question)).toEqual(QUESTION_KEYS);
      expect(sentBatch).toEqual(batch);

      const [inbox] = stream.payloads<HubEvents['inboxChanged']>('inboxChanged');
      expect(keysOf(inbox)).toEqual(INBOX_CHANGED_KEYS);
      expect(inbox).toEqual({ count: 3 });

      const [run] = stream.payloads<HubEvents['scheduleRun']>('scheduleRun');
      expect(keysOf(run)).toEqual(SCHEDULE_RUN_KEYS);
      expect(run).toEqual({ scheduleId: 'nightly-reindex', result: 'fail' });
      expectWellFormed(stream.parser);
    }
  });

  it('system: the GET /api/system shape on the interval while a client is connected; usagePct omitted when unknown', async () => {
    const stream = await connect();
    await stream.waitFor((p) => p.messages.filter((m) => m.event === 'system').length >= 3, '3 system events');
    const systemMessages = stream.parser.messages.filter((m) => m.event === 'system');
    for (const message of systemMessages) {
      const payload = JSON.parse(message.data) as SystemInfo;
      expect(keysOf(payload)).toEqual(SYSTEM_REQUIRED_KEYS);
      expect(payload).toEqual(SYSTEM_INFO);
    }
    const gaps = systemMessages.slice(1).map((m, i) => m.at - systemMessages[i]!.at);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(120);
      expect(gap).toBeLessThan(600);
    }
    expectWellFormed(stream.parser);
  });
});

describe('/hub · agent deltas (D95 follow-up, docs/performance.md → Agent deltas)', () => {
  it('?agents=delta: the first sessionUpdated of a session is whole, later ones carry only the changed agents; a plain stream gets every agent each time', async () => {
    const plain = await connect();
    const delta = await openHub({ port, cookie, path: '/hub?agents=delta' });
    streams.push(delta);
    expect(delta.status).toBe(200);
    const agent = (id: string, status: Agent['status']): Agent => ({ id, kind: 'subagent', name: id, description: null, solutionPath: null, branch: null, status, statusText: null, toolUseId: null, workflow: null });
    const base = { id: 'delta-s1', name: 'delta', status: 'run' } as unknown as Session;
    const many = Array.from({ length: 50 }, (_, i) => agent(`a${i}`, 'done'));
    bus.publish('sessionUpdated', { ...base, agents: [agent('main', 'run'), ...many] });
    bus.publish('sessionUpdated', { ...base, status: 'done', agents: [agent('main', 'done'), ...many] });
    for (const stream of [plain, delta]) await stream.waitFor((p) => p.messages.filter((m) => m.event === 'sessionUpdated').length >= 2, 'two updates');
    const plainSent = plain.payloads<Session>('sessionUpdated').filter((s) => s.id === 'delta-s1');
    expect(plainSent.map((s) => [s.agents.length, s.agentsDelta])).toEqual([[51, undefined], [51, undefined]]);
    const deltaSent = delta.payloads<Session>('sessionUpdated').filter((s) => s.id === 'delta-s1');
    expect(deltaSent.map((s) => [s.agents.map((a) => a.id), s.agentsDelta])).toEqual([
      [['main', ...many.map((a) => a.id)], undefined],
      [['main'], { removed: [] }],
    ]);
    expect(deltaSent[1]?.status).toBe('done');
    expectWellFormed(delta.parser);
  });
});

describe('/hub · disconnects', () => {
  it('a client that goes away is dropped: the hub leaves the bus and stops asking for system info', async () => {
    // The app's own listeners (D75's todo reminder, D76's review link, D79's review cards, D80's checkpoints, D81's enricher, D83's fresh-session places) stay; the hub's comes and goes.
    const own = ownListeners;
    const stream = await connect();
    expect(bus.listenerCount).toBe(own + 1);
    stream.close();
    streams.length = 0;
    await openHub({ port, cookie }).then((probe) => {
      // A second client proves the hub still serves after a drop, then leaves too.
      expect(probe.status).toBe(200);
      probe.close();
    });
    const deadline = Date.now() + 5_000;
    while (bus.listenerCount !== own && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(bus.listenerCount).toBe(own);
    const calls = systemCalls;
    await new Promise((r) => setTimeout(r, 600));
    expect(systemCalls).toBe(calls);
    // Nothing is buffered for absent clients: publishing with nobody connected is a no-op.
    bus.publish('inboxChanged', { count: 1 });
  });
});

describe('/hub · shutdown', () => {
  let own: FastifyInstance | undefined;
  let world: SupervisorWorld | undefined;

  afterAll(async () => {
    await own?.close();
    await world?.cleanup();
  });

  it('closing the app ends open streams cleanly and does not hang on them; no system provider → no system event', async () => {
    world = await makeSupervisorWorld({ scenario: 'handoff-start' });
    const ownToken = generateToken();
    const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: world.root }, platform: 'linux', home: world.root, cwd: world.root });
    const w = world;
    const listening = await listenOnFreeTestPort((candidate) =>
      buildApp({
        config: { ...base, port: candidate },
        token: ownToken,
        store: w.store,
        webRoot: w.root,
        supervisor: w.supervisor,
        hub: { keepaliveMs: 100, systemIntervalMs: 100 },
      }),
    );
    own = listening.app;
    const stream = await openHub({ port: listening.port, cookie: `sb_token=${ownToken}` });
    expect(stream.status).toBe(200);
    await stream.waitFor((p) => p.comments.length >= 2, 'keepalives');
    expect(stream.parser.messages.filter((m) => m.event === 'system')).toEqual([]);

    const started = Date.now();
    await own.close();
    own = undefined;
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await stream.ended).toBe('end');
    expectWellFormed(stream.parser);
  });
});
