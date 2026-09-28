import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactListItem, HistoryItem, InboxItem, Session, SessionDetail } from '../../../src/core/api.ts';
import { TITLE_RULE } from '../../../src/core/session-title.ts';
import { parseTitleInput } from '../../../src/server/api/sessions.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { type HubMessage, HubBus } from '../../../src/server/hub/bus.ts';
import { validateNewSession } from '../../../src/server/sessions/validate.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, spawnedArgv, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D22 oracle (server, real path: fake-claude as the CLI, no demo data): sessions
 * carry a free-text title on top of their short name. `POST /api/sessions` takes
 * an optional `title` (1–80 characters once trimmed, else 422 on `title`);
 * `PUT /api/sessions/{id}/title` renames (404 / 422, `null` or empty clears it)
 * and publishes `sessionUpdated`; every spawn from then on passes the title (else
 * the name) as `--name`; the Inbox, Artifacts and History rows carry the title.
 */
const PORT = 4873; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;
const LONG = 'x'.repeat(81);

let world: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';
let messages: HubMessage[] = [];

async function setup(): Promise<SupervisorWorld> {
  world = await makeSupervisorWorld({ scenario: 'handoff-start' });
  // History reads the transcripts under CLAUDE_CONFIG_DIR (the world's own, never the developer's).
  vi.stubEnv('CLAUDE_CONFIG_DIR', world.configDir);
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: world.root }, platform: 'linux', home: world.root, cwd: world.root });
  await seedFolder(world.store, world.workspace);
  const bus = new HubBus();
  messages = [];
  bus.subscribe((message) => messages.push(message));
  app = await buildApp({ config: { ...base, port: PORT }, token, store: world.store, webRoot: world.root, supervisor: world.supervisor, bus });
  await app.ready();
  return world;
}

afterEach(async () => {
  await app?.close();
  await world?.cleanup();
  app = undefined;
  world = undefined;
  vi.unstubAllEnvs();
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

/** The fake's spawns for sessions (they carry `--name`), in order. */
async function sessionSpawns(w: SupervisorWorld) {
  return (await spawnedArgv(w.logFile)).filter((line) => line.argv?.includes('--name'));
}

/** The value after `--name` in a spawn's argv. */
function nameArg(argv: readonly string[] | undefined): string | undefined {
  const at = argv?.indexOf('--name') ?? -1;
  return at === -1 ? undefined : argv?.[at + 1];
}

async function spawnCount(w: SupervisorWorld, count: number) {
  return until(async () => {
    const spawns = await sessionSpawns(w);
    return spawns.length >= count ? spawns : undefined;
  }, `${count} spawn(s) in the fake log`);
}

async function create(body: Record<string, unknown>): Promise<Session> {
  const response = await call('POST', '/api/sessions', newSession(body));
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as Session;
}

describe('POST /api/sessions · title (D22)', () => {
  it('stores the trimmed title next to the kebab-case name; displayTitle; the spawn passes the title as --name', async () => {
    const w = await setup();
    const titled = await create({ name: 'jira-ticket-handling', title: '  JIRA Ticket handling  ' });
    expect(titled).toMatchObject({ name: 'jira-ticket-handling', title: 'JIRA Ticket handling', displayTitle: 'JIRA Ticket handling' });
    expect((await w.store.sessions.get(titled.id))?.title).toBe('JIRA Ticket handling');
    const [first] = await spawnCount(w, 1);
    expect(nameArg(first?.argv)).toBe('JIRA Ticket handling');
    await waitForStatus(w.store, titled.id, ['done']);

    // Without a title (omitted or null) the name is what is shown and passed.
    const plain = await create({ name: 'free-talk-640', title: null });
    expect(plain).toMatchObject({ name: 'free-talk-640', title: null, displayTitle: 'free-talk-640' });
    const spawns = await spawnCount(w, 2);
    expect(nameArg(spawns[1]?.argv)).toBe('free-talk-640');
    await waitForStatus(w.store, plain.id, ['done']);

    const list = (await call('GET', '/api/sessions')).json() as Session[];
    expect(list.map((s) => [s.name, s.title, s.displayTitle])).toEqual([
      ['free-talk-640', null, 'free-talk-640'],
      ['jira-ticket-handling', 'JIRA Ticket handling', 'JIRA Ticket handling'],
    ]);
    const detail = (await call('GET', `/api/sessions/${titled.id}`)).json() as SessionDetail;
    expect(detail).toMatchObject({ title: 'JIRA Ticket handling', displayTitle: 'JIRA Ticket handling' });
  });

  it('422 on field title for an empty, blank, 81-character or non-text title; the name keeps its rules; nothing is spawned', async () => {
    const w = await setup();
    for (const title of ['', '   ', LONG, 42, ['a']]) {
      const response = await call('POST', '/api/sessions', newSession({ title } as never));
      expect(response.statusCode, JSON.stringify(title)).toBe(422);
      expect(response.json().errors, JSON.stringify(title)).toEqual([{ field: 'title', message: TITLE_RULE }]);
    }
    // A title does not relax the name: still kebab-case.
    const bad = await call('POST', '/api/sessions', newSession({ name: 'JIRA Ticket handling', title: 'JIRA Ticket handling' }));
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors.map((e: { field: string }) => e.field)).toEqual(['name']);
    expect(await w.store.sessions.list()).toHaveLength(0);
    expect(await spawnedArgv(w.logFile)).toHaveLength(0);
    // 80 characters are fine.
    const max = await create({ name: 'long-title', title: `${'y'.repeat(80)}  ` });
    expect(max.title).toBe('y'.repeat(80));
    await waitForStatus(w.store, max.id, ['done']);
  });

  it('validates the title the same way for a repo folder (NewRepoSession) and keeps it out when absent', async () => {
    const checks = { nameTaken: async () => false, folder: { kind: 'repo' as const, repoName: 'switchboard' } };
    const repo = { name: 'fix', task: '', folder: 'f', worktrees: false, ultracode: false };
    expect(await validateNewSession({ ...repo, title: ' Fix the build ' }, checks)).toMatchObject({ ok: true, value: { name: 'fix', title: 'Fix the build' } });
    expect(await validateNewSession({ ...repo, title: LONG }, checks)).toEqual({ ok: false, errors: [{ field: 'title', message: TITLE_RULE }] });
    const plain = await validateNewSession(repo, checks);
    expect(plain.ok && 'title' in plain.value).toBe(false);
    const workspace = await validateNewSession(newSession(), { nameTaken: async () => false });
    expect(workspace.ok && 'title' in workspace.value).toBe(false);
  });
});

describe('PUT /api/sessions/{id}/title (D22)', () => {
  it('renames: only the title changes, sessionUpdated is published, the next spawn passes it as --name; null or empty clears it', async () => {
    const w = await setup();
    const session = await create({ name: 'jira-ticket-handling', title: 'JIRA Ticket handling' });
    await waitForStatus(w.store, session.id, ['done']);
    messages = [];

    const renamed = await call('PUT', `/api/sessions/${session.id}/title`, { title: '  Billing: fix invoices  ' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toMatchObject({ id: session.id, name: 'jira-ticket-handling', title: 'Billing: fix invoices', displayTitle: 'Billing: fix invoices' });
    const updates = messages.filter((m) => m.name === 'sessionUpdated').map((m) => m.payload as Session);
    expect(updates.map((s) => [s.id, s.title, s.displayTitle])).toEqual([[session.id, 'Billing: fix invoices', 'Billing: fix invoices']]);
    const stored = await w.store.sessions.get(session.id);
    expect(stored).toMatchObject({ name: 'jira-ticket-handling', title: 'Billing: fix invoices', claudeSessionId: session.claudeSessionId });

    // The live process keeps its name; the next spawn (Pause, then Resume: --resume + "Continue.") carries the new title.
    expect((await call('POST', `/api/sessions/${session.id}/pause`)).statusCode).toBe(200);
    expect((await call('POST', `/api/sessions/${session.id}/resume`)).statusCode).toBe(200);
    const spawns = await spawnCount(w, 2);
    expect(spawns[1]?.argv).toContain('--resume');
    expect(nameArg(spawns[1]?.argv)).toBe('Billing: fix invoices');
    await waitForStatus(w.store, session.id, ['done']);

    // null clears it: the name is shown and passed again; an empty title does the same.
    const cleared = await call('PUT', `/api/sessions/${session.id}/title`, { title: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ title: null, displayTitle: 'jira-ticket-handling' });
    await call('PUT', `/api/sessions/${session.id}/title`, { title: 'Again' });
    const blank = await call('PUT', `/api/sessions/${session.id}/title`, { title: '   ' });
    expect(blank.json()).toMatchObject({ title: null, displayTitle: 'jira-ticket-handling' });
    expect((await call('POST', `/api/sessions/${session.id}/pause`)).statusCode).toBe(200);
    expect((await call('POST', `/api/sessions/${session.id}/resume`)).statusCode).toBe(200);
    const third = await spawnCount(w, 3);
    expect(nameArg(third[2]?.argv)).toBe('jira-ticket-handling');
    await waitForStatus(w.store, session.id, ['done']);
  });

  it('422 on field title for an 81-character, non-text or missing title (the title stays); 404 for an unknown session', async () => {
    const w = await setup();
    const session = await create({ name: 'kept', title: 'Kept title' });
    for (const body of [{ title: LONG }, { title: 42 }, {}, 'not an object', [{ title: 'x' }]]) {
      const response = await call('PUT', `/api/sessions/${session.id}/title`, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(422);
      expect(response.json().errors.map((e: { field: string }) => e.field), JSON.stringify(body)).toEqual(['title']);
    }
    expect((await call('PUT', `/api/sessions/${session.id}/title`, { title: LONG })).json().errors[0].message).toBe(TITLE_RULE);
    expect((await w.store.sessions.get(session.id))?.title).toBe('Kept title');

    const missing = await call('PUT', '/api/sessions/nope/title', { title: 'x' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('not-found');
    await waitForStatus(w.store, session.id, ['done']);
  });

  it('parses the body like the create path', () => {
    expect(parseTitleInput({ title: ' a ' })).toEqual({ ok: true, title: 'a' });
    expect(parseTitleInput({ title: null })).toEqual({ ok: true, title: null });
    expect(parseTitleInput({ title: '' })).toEqual({ ok: true, title: null });
    expect(parseTitleInput({ title: 'x'.repeat(80) })).toEqual({ ok: true, title: 'x'.repeat(80) });
    expect(parseTitleInput({ title: LONG })).toEqual({ ok: false, message: TITLE_RULE });
    expect(parseTitleInput(null).ok).toBe(false);
    expect(parseTitleInput({}).ok).toBe(false);
  });
});

describe('where a session is named (D22)', () => {
  it('the Inbox, Artifacts and History rows carry its title', async () => {
    const w = await setup();
    const session = await create({ name: 'jira-ticket-handling', title: 'JIRA Ticket handling' });
    await waitForStatus(w.store, session.id, ['done']);
    await w.store.questions.createBatch({ id: 'batch-1', sessionId: session.id, input: { questions: [] } }, [
      { source: 'web · microfrontends/acme-app-front', text: 'Which one?', options: [{ label: 'a' }, { label: 'b' }] },
    ]);
    await w.store.artifacts.create({ type: 'DOC', name: 'notes.md', sessionId: session.id });

    const inbox = (await call('GET', '/api/inbox')).json() as InboxItem[];
    expect(inbox.find((item) => item.id === 'batch-1')).toMatchObject({ source: 'jira-ticket-handling', sourceTitle: 'JIRA Ticket handling' });
    const artifacts = (await call('GET', '/api/artifacts')).json() as ArtifactListItem[];
    expect(artifacts.find((a) => a.name === 'notes.md')).toMatchObject({ sessionName: 'jira-ticket-handling', sessionTitle: 'JIRA Ticket handling' });
    expect(((await call('GET', '/api/artifacts?q=ticket%20handl')).json() as ArtifactListItem[]).map((a) => a.name)).toEqual(['notes.md']);
    const history = (await call('GET', '/api/history')).json() as HistoryItem[];
    expect(history.find((row) => row.sessionId === session.id)).toMatchObject({ name: 'jira-ticket-handling', displayTitle: 'JIRA Ticket handling' });
    // History searches the title too.
    expect(((await call('GET', '/api/history?q=JIRA%20Ticket')).json() as HistoryItem[]).map((row) => row.sessionId)).toEqual([session.id]);
  });
});
