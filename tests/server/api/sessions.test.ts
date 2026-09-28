import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResumeCommand, Session, SessionDetail, SessionEvent } from '../../../src/core/api.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { generateToken } from '../../../src/server/token.ts';
import { delay } from '../../helpers/fake-claude.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, spawnedArgv, stdinOf, until, waitForStatus } from '../../helpers/supervisor.ts';

const PORT = 4872; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

let world: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';

async function setup(scenario: string, workspace: 'world' | 'none' = 'world'): Promise<SupervisorWorld> {
  world = await makeSupervisorWorld({ scenario });
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: world.root }, platform: 'linux', home: world.root, cwd: world.root });
  const config = { ...base, port: PORT, workspaceRoot: workspace === 'world' ? world.workspace : null };
  app = await buildApp({
    config,
    token,
    store: world.store,
    webRoot: world.root,
    ...(workspace === 'world' ? { supervisor: world.supervisor } : {}),
  });
  await app.ready();
  return world;
}

/** The fake's spawns for sessions (not the Attach warning's `claude agents --json` calls, M4.1). */
async function sessionSpawns(logFile: string) {
  return (await spawnedArgv(logFile)).filter((line) => line.argv?.[0] !== 'agents');
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

describe('POST /api/sessions · validation (contract → NewSession)', () => {
  it('422 for each invalid field; nothing is spawned', async () => {
    const w = await setup('handoff-start');
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['name not kebab-case', { name: 'Free Talk' }, 'name'],
      ['no solutions', { solutions: [] }, 'solutions'],
      ['read-only deprecated path', { solutions: ['deprecated/microfrontends/old-chat-front'] }, 'solutions'],
      ['read-only infrastructure', { solutions: ['infrastructure'] }, 'solutions'],
      ['path escape', { solutions: ['../elsewhere'] }, 'solutions'],
      ['qa without qa', { workType: 'qa', qa: null }, 'qa'],
      ['bad mode', { mode: 'solo' }, 'mode'],
      ['bad phase', { phase: 'later' }, 'phase'],
      ['bad coordination', { coordination: 'maybe' }, 'coordination'],
      ['worktrees not boolean', { worktrees: 'yes' }, 'worktrees'],
    ];
    for (const [what, patch, field] of cases) {
      const response = await call('POST', '/api/sessions', { ...newSession(), ...patch });
      expect(response.statusCode, what).toBe(422);
      expect(response.json().errors.map((e: { field: string }) => e.field), what).toContain(field);
    }
    expect((await call('POST', '/api/sessions', 'not an object')).statusCode).toBe(422);
    expect(await w.store.sessions.list()).toHaveLength(0);
    expect(await spawnedArgv(w.logFile)).toHaveLength(0);
  });

  it('a duplicate name is refused (422)', async () => {
    const w = await setup('handoff-start');
    expect((await call('POST', '/api/sessions', newSession())).statusCode).toBe(201);
    const again = await call('POST', '/api/sessions', newSession());
    expect(again.statusCode).toBe(422);
    expect(again.json().errors[0].field).toBe('name');
    await waitForStatus(w.store, (await w.store.sessions.list())[0]?.id ?? '', ['done']);
  });

  it('409 while no workspace root is configured', async () => {
    await setup('handoff-start', 'none');
    const response = await call('POST', '/api/sessions', newSession());
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('workspace-not-configured');
  });
});

describe('session routes over the real supervisor + fake-claude', () => {
  it('create → list/detail → events?since → detach → attach → message', async () => {
    const w = await setup('handoff-start');
    const created = await call('POST', '/api/sessions', newSession({ mode: 'orchestrator', solutions: ['acme-app-front', 'mobile'] }));
    expect(created.statusCode).toBe(201);
    const session = created.json() as Session;
    expect(session).toMatchObject({ name: 'demo-session', status: 'run', attached: true, mode: 'orchestrator', openQuestionCount: 0 });
    expect(session.agents.map((a) => [a.kind, a.name])).toEqual([['main', 'orchestrator']]);
    await waitForStatus(w.store, session.id, ['done']);

    const list = (await call('GET', '/api/sessions')).json() as Session[];
    expect(list.map((s) => [s.id, s.status])).toEqual([[session.id, 'done']]);

    const detail = (await call('GET', `/api/sessions/${session.id}`)).json() as SessionDetail;
    expect(detail.task).toBe(newSession().task);
    expect(detail.events.map((e) => e.kind)).toEqual(['text', 'text', 'text', 'ok']);
    expect(detail.files).toEqual([]);
    expect(detail.artifacts).toEqual([]);

    const all = (await call('GET', `/api/sessions/${session.id}/events`)).json() as SessionEvent[];
    expect(all).toHaveLength(4);
    const since = all[1]?.ts ?? '';
    const newer = (await call('GET', `/api/sessions/${session.id}/events?since=${encodeURIComponent(since)}`)).json() as SessionEvent[];
    expect(newer.every((e) => e.ts > since)).toBe(true);
    expect((await call('GET', `/api/sessions/${session.id}/events?since=yesterday`)).statusCode).toBe(422);

    const detached = await call('POST', `/api/sessions/${session.id}/detach`);
    expect(detached.statusCode).toBe(200);
    expect(detached.json()).toEqual({ resumeCommand: `claude --resume ${session.claudeSessionId}` } satisfies ResumeCommand);
    const afterDetach = (await call('GET', `/api/sessions/${session.id}`)).json() as SessionDetail;
    expect(afterDetach).toMatchObject({ attached: false, status: 'paused' });
    expect((await call('POST', `/api/sessions/${session.id}/resume`)).statusCode).toBe(409);
    expect((await call('POST', `/api/sessions/${session.id}/messages`, { text: 'hi' })).statusCode).toBe(409);

    // M4.1: the transcript changed moments ago, so Attach warns first (409, nothing spawned) until confirmed.
    const warned = await call('POST', `/api/sessions/${session.id}/attach`);
    expect(warned.statusCode).toBe(409);
    expect(warned.json()).toMatchObject({ error: 'attach-warning', reasons: [{ kind: 'transcript-recent' }] });
    expect(await sessionSpawns(w.logFile)).toHaveLength(1);
    const attached = await call('POST', `/api/sessions/${session.id}/attach`, { confirm: true });
    expect(attached.json()).toEqual({ resumeCommand: `claude --resume ${session.claudeSessionId}` });
    const idle = await waitForStatus(w.store, session.id, ['idle']);
    expect(idle.attached).toBe(true);
    // The fake logs its argv asynchronously after it starts.
    const spawns = await until(async () => {
      const logged = await sessionSpawns(w.logFile);
      return logged.length === 2 ? logged : undefined;
    }, 'the attach spawn in the fake log');
    expect(spawns[1]?.pid).toBe((await w.store.sessions.get(session.id))?.pid);
    expect(spawns[1]?.argv).toContain('--resume');
    expect(spawns[1]?.argv).toContain('auto');
    await delay(300);
    expect(await stdinOf(w.logFile, spawns[1]?.pid ?? -1)).toEqual([]);

    expect((await call('POST', `/api/sessions/${session.id}/messages`, { text: '  ' })).statusCode).toBe(422);
    const sent = await call('POST', `/api/sessions/${session.id}/messages`, { text: 'Remember the code word: tangerine. Reply with just OK.' });
    expect(sent.statusCode).toBe(202);
    await until(async () => (await w.store.events.list(session.id)).filter((e) => e.kind === 'ok').length === 2, 'the second ok');

    const paused = await call('POST', `/api/sessions/${session.id}/pause`);
    expect((paused.json() as Session).status).toBe('paused');
    const resumed = await call('POST', `/api/sessions/${session.id}/resume`);
    expect((resumed.json() as Session).status).toBe('run');
    await waitForStatus(w.store, session.id, ['done']);
  });

  it('404 for an unknown session on every id route', async () => {
    await setup('handoff-start');
    for (const [method, url] of [
      ['GET', '/api/sessions/nope'],
      ['GET', '/api/sessions/nope/events'],
      ['POST', '/api/sessions/nope/pause'],
      ['POST', '/api/sessions/nope/resume'],
      ['POST', '/api/sessions/nope/detach'],
      ['POST', '/api/sessions/nope/attach'],
    ] as const) {
      const response = await call(method, url);
      expect(response.statusCode, url).toBe(404);
      expect(response.json().error, url).toBe('not-found');
    }
    expect((await call('POST', '/api/sessions/nope/messages', { text: 'x' })).statusCode).toBe(404);
  });
});
