import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session, SessionDetail, SessionEvent } from '../../../src/core/api.ts';
import type { ModelPayload } from '../../../src/core/event-payload.ts';
import { parseModelInput } from '../../../src/server/api/sessions.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { type HubMessage, HubBus } from '../../../src/server/hub/bus.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, spawnedArgv, stdinOf, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D31 oracle (server, real path: fake-claude as the CLI, no demo data):
 * `Session.model` from the `initialize` reply's models; `PUT /api/sessions/{id}/model`
 * on a live process (`set_model` / `apply_flag_settings {effortLevel}` on stdin, the
 * stored choice, the chat step line, `sessionUpdated`) and on a paused one (only
 * stored); every later spawn (resume, a message to a paused session, restart
 * recovery, attach) passes `--model` / `--effort`; 404 / 422 (body, a model or
 * effort not on offer) / 502 `model-failed` with the CLI's text verbatim and the
 * stored choice unchanged.
 */
const PORT = 4873; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

let world: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';
let messages: HubMessage[] = [];

async function setup(): Promise<SupervisorWorld> {
  world = await makeSupervisorWorld();
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

/** Starts a session with a one-turn task (so it has a transcript to resume), waits for the turn and its `initialize` reply's models. */
async function startDone(env: Record<string, string> = {}): Promise<Session> {
  const w = world as SupervisorWorld;
  Object.assign(w.env, env);
  const response = await call('POST', '/api/sessions', newSession({ name: 'model-demo', task: 'Reply with just OK.' }));
  expect(response.statusCode, response.body).toBe(201);
  const session = response.json() as Session;
  await waitForStatus(w.store, session.id, ['done']);
  if (env['FAKE_CLAUDE_MODELS'] !== 'none') await until(async () => (await w.store.sessions.get(session.id))?.modelOptions ?? undefined, 'the models from initialize');
  else await until(async () => (await w.store.sessions.get(session.id))?.remoteAvailable === true, 'the initialize reply');
  return session;
}

async function pidOf(id: string): Promise<number> {
  return until(async () => (await (world as SupervisorWorld).store.sessions.get(id))?.pid ?? undefined, 'a live pid');
}

/** The `set_model` / `apply_flag_settings` requests one process got, in order. */
async function modelLines(pid: number): Promise<Array<Record<string, unknown>>> {
  const lines = await stdinOf((world as SupervisorWorld).logFile, pid);
  return lines.filter((line) => ['set_model', 'apply_flag_settings'].includes(String((line['request'] as { subtype?: unknown } | undefined)?.subtype))).map((line) => line['request'] as Record<string, unknown>);
}

function modelEvents(events: readonly SessionEvent[]): Array<{ kind: string; label: string; payload: ModelPayload }> {
  return events.filter((event) => (event.payload as { type?: string } | null)?.type === 'model').map((event) => ({ kind: event.kind, label: event.label, payload: event.payload as ModelPayload }));
}

/** The session processes' argv (they carry `--name`), in spawn order. */
async function sessionSpawns(): Promise<string[][]> {
  return (await spawnedArgv((world as SupervisorWorld).logFile)).filter((line) => line.argv?.includes('--name')).map((line) => line.argv ?? []);
}

function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(name);
  return at === -1 ? null : (argv[at + 1] ?? null);
}

describe('Session.model (D31)', () => {
  it('the models of the initialize reply, no choice yet: the first spawn has no --model / --effort', async () => {
    await setup();
    const session = await startDone();
    const model = (await detail(session.id)).model;
    expect(model?.current).toBeNull();
    expect(model?.effort).toBeNull();
    expect(model?.available?.find((option) => option.value === 'opus')).toEqual({
      value: 'opus',
      label: 'Opus 5.5',
      description: 'Most capable for ambitious work',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
    expect(model?.available?.find((option) => option.value === 'haiku')?.efforts).toBeUndefined();
    const [spawn] = await sessionSpawns();
    expect(spawn).not.toContain('--model');
    expect(spawn).not.toContain('--effort');
  });

  it('null for a session Switchboard never ran a process for (the demo seed); unknown models when initialize lists none', async () => {
    const w = await setup();
    const seeded = await w.store.sessions.create({ name: 'seeded', claudeSessionId: 'c-seeded' });
    expect((await detail(seeded.id)).model).toBeNull();
    expect(((await call('GET', '/api/sessions')).json() as Session[]).find((s) => s.id === seeded.id)?.model).toBeNull();
    const session = await startDone({ FAKE_CLAUDE_MODELS: 'none' });
    expect((await detail(session.id)).model).toEqual({ current: null, effort: null, available: null });
  });
});

describe('PUT /api/sessions/{id}/model · live (D31)', () => {
  it('model + effort: set_model then apply_flag_settings on stdin, stored, a chat step line, sessionUpdated', async () => {
    const w = await setup();
    const session = await startDone();
    const pid = await pidOf(session.id);
    messages = [];
    const changed = await call('PUT', `/api/sessions/${session.id}/model`, { model: 'opus', effort: 'high' });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((changed.json() as Session).model).toMatchObject({ current: 'opus', effort: 'high' });
    expect(await modelLines(pid)).toEqual([
      { subtype: 'set_model', model: 'opus' },
      { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } },
    ]);
    expect(await w.store.sessions.get(session.id)).toMatchObject({ model: 'opus', effort: 'high' });
    expect(modelEvents((await detail(session.id)).events)).toEqual([
      { kind: 'text', label: 'Model: Opus 5.5 · effort: high', payload: { type: 'model', action: 'changed', model: 'opus', effort: 'high', live: true } },
    ]);
    expect(messages.some((m) => m.name === 'sessionUpdated' && m.payload.id === session.id && m.payload.model?.current === 'opus')).toBe(true);
    expect(messages.some((m) => m.name === 'event' && m.payload.sessionId === session.id && m.payload.event.label === 'Model: Opus 5.5 · effort: high')).toBe(true);
    // The process was not restarted: the change went to the running one.
    expect(await pidOf(session.id)).toBe(pid);
    expect(await sessionSpawns()).toHaveLength(1);
  });

  it('only the part that changed is sent: effort alone, then the model alone; the same choice again sends nothing', async () => {
    const w = await setup();
    const session = await startDone();
    const pid = await pidOf(session.id);
    expect((await call('PUT', `/api/sessions/${session.id}/model`, { effort: 'low' })).statusCode).toBe(200);
    expect((await call('PUT', `/api/sessions/${session.id}/model`, { model: 'claude-opus-4-7' })).statusCode).toBe(200);
    expect((await call('PUT', `/api/sessions/${session.id}/model`, { model: 'claude-opus-4-7', effort: 'low' })).statusCode).toBe(200);
    expect(await modelLines(pid)).toEqual([
      { subtype: 'apply_flag_settings', settings: { effortLevel: 'low' } },
      { subtype: 'set_model', model: 'claude-opus-4-7' },
    ]);
    // Back to the CLI's defaults: default = set_model "default", effort null = effortLevel null; stored as null.
    const reset = await call('PUT', `/api/sessions/${session.id}/model`, { model: 'default', effort: null });
    expect((reset.json() as Session).model).toMatchObject({ current: null, effort: null });
    expect((await modelLines(pid)).slice(2)).toEqual([
      { subtype: 'set_model', model: 'default' },
      { subtype: 'apply_flag_settings', settings: { effortLevel: null } },
    ]);
    expect(modelEvents((await detail(session.id)).events).map((e) => e.label)).toEqual([
      'Model: Default (recommended) · effort: low',
      'Model: Opus 4.7 · effort: low',
      'Model: Default (recommended) · effort: default',
    ]);
    expect(await w.store.sessions.get(session.id)).toMatchObject({ model: null, effort: null });
  });
});

describe('PUT /api/sessions/{id}/model · not live, and every later spawn (D31)', () => {
  it('paused: only stored (no process gets anything); resume passes --model / --effort; the new process gets no set_model', async () => {
    const w = await setup();
    const session = await startDone();
    expect((await call('POST', `/api/sessions/${session.id}/pause`)).statusCode).toBe(200);
    const changed = await call('PUT', `/api/sessions/${session.id}/model`, { model: 'claude-sonnet-4-6', effort: 'max' });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((changed.json() as Session).model).toMatchObject({ current: 'claude-sonnet-4-6', effort: 'max' });
    expect(modelEvents((await detail(session.id)).events)).toEqual([
      { kind: 'text', label: 'Model: Sonnet 4.6 · effort: max', payload: { type: 'model', action: 'changed', model: 'claude-sonnet-4-6', effort: 'max', live: false } },
    ]);
    expect((await call('POST', `/api/sessions/${session.id}/resume`)).statusCode).toBe(200);
    const spawns = await until(async () => {
      const all = await sessionSpawns();
      return all.length === 2 ? all : undefined;
    }, 'the resumed spawn');
    const resumed = spawns[1] ?? [];
    expect(resumed).toContain('--resume');
    expect(flag(resumed, '--model')).toBe('claude-sonnet-4-6');
    expect(flag(resumed, '--effort')).toBe('max');
    expect(await modelLines(await pidOf(session.id))).toEqual([]);
    await waitForStatus(w.store, session.id, ['done']);
  });

  it('a message to a paused session, restart recovery and attach spawn with the flags too', async () => {
    const w = await setup();
    const session = await startDone();
    await call('PUT', `/api/sessions/${session.id}/model`, { model: 'opus', effort: 'xhigh' });
    // A message to a paused session resumes it.
    await call('POST', `/api/sessions/${session.id}/pause`);
    await call('POST', `/api/sessions/${session.id}/messages`, { text: 'Reply with just OK.' });
    await waitForStatus(w.store, session.id, ['done']);
    // Restart recovery.
    await w.supervisor.pause(session.id);
    await w.supervisor.resumeAfterRestart(session.id, null);
    // Continue in terminal, then Attach here.
    await w.supervisor.detach(session.id);
    await w.supervisor.attach(session.id, { confirm: true });
    const spawns = await until(async () => {
      const all = await sessionSpawns();
      return all.length === 4 ? all : undefined;
    }, 'four spawns');
    expect(flag(spawns[0] ?? [], '--model')).toBeNull();
    for (const argv of spawns.slice(1)) {
      expect(argv).toContain('--resume');
      expect([flag(argv, '--model'), flag(argv, '--effort')]).toEqual(['opus', 'xhigh']);
    }
  });
});

describe('PUT /api/sessions/{id}/model · refusals (D31)', () => {
  it('404 for an unknown session; 422 for a body that is not { model?, effort? }', async () => {
    await setup();
    const session = await startDone();
    expect((await call('PUT', '/api/sessions/nope/model', { model: 'opus' })).statusCode).toBe(404);
    for (const [body, field] of [
      [{}, 'model'],
      [null, 'model'],
      [['opus'], 'model'],
      [{ model: 5 }, 'model'],
      [{ effort: true }, 'effort'],
      [{ model: 'x'.repeat(101) }, 'model'],
    ] as const) {
      const response = await call('PUT', `/api/sessions/${session.id}/model`, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(422);
      expect(response.json()).toMatchObject({ error: 'invalid', errors: [{ field }] });
    }
    expect(parseModelInput({ model: null })).toEqual({ ok: true, input: { model: null } });
    expect(parseModelInput({ effort: 'high', other: 1 })).toEqual({ ok: true, input: { effort: 'high' } });
  });

  it('422 for a model or effort not on offer (the reported list); nothing is sent or stored', async () => {
    const w = await setup();
    const session = await startDone();
    const pid = await pidOf(session.id);
    const unknown = await call('PUT', `/api/sessions/${session.id}/model`, { model: 'gpt-4' });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toMatchObject({ error: 'invalid', errors: [{ field: 'model', message: expect.stringMatching(/^claude does not offer the model "gpt-4" here: pick one of default, opus, /) }] });
    const effort = await call('PUT', `/api/sessions/${session.id}/model`, { model: 'claude-sonnet-4-6', effort: 'xhigh' });
    expect(effort.statusCode).toBe(422);
    expect(effort.json()).toEqual({
      error: 'invalid',
      errors: [{ field: 'effort', message: 'Sonnet 4.6 supports the effort levels low, medium, high, max: "xhigh" is not one of them' }],
    });
    const haiku = await call('PUT', `/api/sessions/${session.id}/model`, { model: 'haiku', effort: 'low' });
    expect(haiku.json()).toMatchObject({ errors: [{ field: 'effort', message: "Haiku 4.5 has no effort levels: set the effort to null (the CLI's default)" }] });
    expect(await modelLines(pid)).toEqual([]);
    expect(await w.store.sessions.get(session.id)).toMatchObject({ model: null, effort: null });
    expect(modelEvents((await detail(session.id)).events)).toEqual([]);
  });

  it('with no reported list any model name is taken (the CLI decides); the effort must be one of the CLI’s levels', async () => {
    await setup();
    const session = await startDone({ FAKE_CLAUDE_MODELS: 'none' });
    expect((await call('PUT', `/api/sessions/${session.id}/model`, { effort: 'turbo' })).statusCode).toBe(422);
    const ok = await call('PUT', `/api/sessions/${session.id}/model`, { model: 'opus', effort: 'max' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((ok.json() as Session).model).toEqual({ current: 'opus', effort: 'max', available: null });
  });

  it('502 with the CLI text verbatim when set_model is refused: nothing stored, the chat says why', async () => {
    const w = await setup();
    const text = 'Model switch blocked by a PreModelSwitch hook: not during release week';
    const session = await startDone({ FAKE_CLAUDE_SET_MODEL_ERROR: text });
    const failed = await call('PUT', `/api/sessions/${session.id}/model`, { model: 'opus', effort: 'high' });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({ error: 'model-failed', message: text });
    const pid = await pidOf(session.id);
    // The effort was not sent once the model was refused.
    expect(await modelLines(pid)).toEqual([{ subtype: 'set_model', model: 'opus' }]);
    expect(await w.store.sessions.get(session.id)).toMatchObject({ model: null, effort: null });
    expect(modelEvents((await detail(session.id)).events)).toEqual([
      {
        kind: 'error',
        label: `Could not change the model: ${text}`,
        payload: { type: 'model', action: 'failed', model: 'opus', effort: 'high', request: 'set_model', error: text },
      },
    ]);
  });

  it('502 when the effort is refused after the model was taken: the model is stored (the process runs on it), the effort is not', async () => {
    const w = await setup();
    const text = 'apply_flag_settings: CLAUDE_CODE_EFFORT_LEVEL overrides effort for this session';
    const session = await startDone({ FAKE_CLAUDE_EFFORT_ERROR: text });
    const failed = await call('PUT', `/api/sessions/${session.id}/model`, { model: 'opus', effort: 'high' });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({ error: 'model-failed', message: text });
    expect(await w.store.sessions.get(session.id)).toMatchObject({ model: 'opus', effort: null });
    expect(modelEvents((await detail(session.id)).events).map((e) => [e.kind, e.label])).toEqual([
      ['text', 'Model: Opus 5.5 · effort: default'],
      ['error', `Could not change the effort: ${text}`],
    ]);
    // An effort-only change is refused the same way and changes nothing.
    const again = await call('PUT', `/api/sessions/${session.id}/model`, { effort: 'low' });
    expect(again.statusCode).toBe(502);
    expect(await w.store.sessions.get(session.id)).toMatchObject({ model: 'opus', effort: null });
  });
});
