import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelSettings, Schedule, Session } from '../../../src/core/api.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { validateNewSession } from '../../../src/server/sessions/validate.ts';
import { MODELS_LAST_KEY, MODELS_OPTIONS_KEY } from '../../../src/server/settings/models.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, spawnedArgv, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D42 oracle (server, real path: fake-claude as the CLI, whose `initialize` lists
 * the recorded models): `GET /api/models` (`models.options` from any process's
 * `initialize`, `models.last`), `POST /api/sessions` with `model` / `effort`
 * (stored, the first spawn's `--model` / `--effort`, the last choice; 422 like
 * D31's route), D31's `PUT /api/sessions/{id}/model` updating the last choice,
 * and a schedule template carrying the choice into each run.
 */
const PORT = 4874; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

let world: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';

async function setup(env: Record<string, string> = {}): Promise<SupervisorWorld> {
  world = await makeSupervisorWorld();
  Object.assign(world.env, env);
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: world.root }, platform: 'linux', home: world.root, cwd: world.root });
  await seedFolder(world.store, world.workspace);
  app = await buildApp({ config: { ...base, port: PORT }, token, store: world.store, webRoot: world.root, supervisor: world.supervisor });
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

async function models(): Promise<ModelSettings> {
  const response = await call('GET', '/api/models');
  expect(response.statusCode).toBe(200);
  return response.json() as ModelSettings;
}

/** Starts a session (one finished turn) and waits until its process listed its models (so `models.options` is known). */
async function startDone(name: string, extra: Record<string, unknown> = {}): Promise<Session> {
  const w = world as SupervisorWorld;
  const response = await call('POST', '/api/sessions', { ...newSession({ name, task: 'Reply with just OK.' }), ...extra });
  expect(response.statusCode, response.body).toBe(201);
  const session = response.json() as Session;
  await waitForStatus(w.store, session.id, ['done']);
  await until(async () => (await w.store.sessions.get(session.id))?.modelOptions ?? undefined, 'the models from initialize');
  return session;
}

/** The argv of the session processes (they carry `--name`), in spawn order. */
async function sessionSpawns(): Promise<string[][]> {
  return (await spawnedArgv((world as SupervisorWorld).logFile)).filter((line) => line.argv?.includes('--name')).map((line) => line.argv ?? []);
}

function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(name);
  return at === -1 ? null : (argv[at + 1] ?? null);
}

describe('GET /api/models and models.options (D42)', () => {
  it('nothing until a process reports its models; then the latest list; a start without a choice leaves the last choice unset', async () => {
    const w = await setup();
    expect(await models()).toEqual({ options: null, last: null });
    await startDone('first');
    const after = await models();
    expect(after.last).toBeNull();
    expect(after.options?.map((o) => o.value)).toContain('opus');
    expect(after.options?.find((o) => o.value === 'haiku')?.efforts).toBeUndefined();
    expect(after.options?.find((o) => o.value === 'claude-sonnet-4-6')?.efforts).toEqual(['low', 'medium', 'high', 'max']);
    expect(await w.store.settings.get(MODELS_OPTIONS_KEY)).toEqual(after.options);
    // Not part of the Settings object.
    expect((await call('GET', '/api/settings')).json()).not.toHaveProperty(MODELS_OPTIONS_KEY);
  });
});

describe('POST /api/sessions with model / effort (D42)', () => {
  it('stores them, the first spawn passes --model / --effort, and they become the last choice', async () => {
    const w = await setup();
    await startDone('first');
    expect(flag((await sessionSpawns())[0] ?? [], '--model')).toBeNull();
    const session = await startDone('chosen', { model: 'opus', effort: 'high' });
    expect(session.model).toMatchObject({ current: 'opus', effort: 'high' });
    expect(await w.store.sessions.get(session.id)).toMatchObject({ model: 'opus', effort: 'high' });
    const spawn = (await sessionSpawns())[1] ?? [];
    expect([flag(spawn, '--model'), flag(spawn, '--effort')]).toEqual(['opus', 'high']);
    expect((await models()).last).toEqual({ model: 'opus', effort: 'high' });
    // `default` / null = the CLI's defaults: no flags, and that is the last choice now.
    await startDone('back-to-default', { model: 'default', effort: null });
    const third = (await sessionSpawns())[2] ?? [];
    expect([flag(third, '--model'), flag(third, '--effort')]).toEqual([null, null]);
    expect((await models()).last).toEqual({ model: null, effort: null });
  });

  it('422 for a model or effort not on offer (the reported list) or not text; nothing starts and the last choice stays', async () => {
    const w = await setup();
    await startDone('first', { model: 'claude-sonnet-4-6', effort: 'max' });
    const spawns = (await sessionSpawns()).length;
    const cases: Array<[Record<string, unknown>, string, RegExp]> = [
      [{ model: 'gpt-4' }, 'model', /^claude does not offer the model "gpt-4" here: pick one of default, opus, /],
      [{ model: 'claude-sonnet-4-6', effort: 'xhigh' }, 'effort', /^Sonnet 4\.6 supports the effort levels low, medium, high, max: "xhigh" is not one of them$/],
      [{ model: 'haiku', effort: 'low' }, 'effort', /^Haiku 4\.5 has no effort levels/],
      [{ model: 5 }, 'model', /must be text/],
      [{ effort: ['high'] }, 'effort', /must be text/],
      [{ model: '-x' }, 'model', /is not a model name/],
    ];
    for (const [extra, field, message] of cases) {
      const response = await call('POST', '/api/sessions', { ...newSession({ name: 'refused' }), ...extra });
      expect(response.statusCode, JSON.stringify(extra)).toBe(422);
      expect(response.json()).toMatchObject({ error: 'invalid', errors: [{ field, message: expect.stringMatching(message) }] });
    }
    expect(await w.store.sessions.getByName('refused')).toBeNull();
    expect(await sessionSpawns()).toHaveLength(spawns);
    expect((await models()).last).toEqual({ model: 'claude-sonnet-4-6', effort: 'max' });
  });

  it('with no reported list, D31’s rules: any model name, one of the CLI’s effort levels', async () => {
    await setup({ FAKE_CLAUDE_MODELS: 'none' });
    const refused = await call('POST', '/api/sessions', { ...newSession({ name: 'turbo' }), effort: 'turbo' });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ errors: [{ field: 'effort' }] });
    const ok = await call('POST', '/api/sessions', { ...newSession({ name: 'any-model' }), model: 'claude-opus-4-7', effort: 'max' });
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await models()).last).toEqual({ model: 'claude-opus-4-7', effort: 'max' });
  });

  it('a repo folder takes them too (the validation of either folder kind)', async () => {
    const checks = { nameTaken: async () => false, folder: { kind: 'repo' as const, repoName: 'app' }, modelOptions: null };
    const body = { name: 'fix', task: '', worktrees: false, ultracode: false };
    expect(await validateNewSession({ ...body, model: 'opus', effort: 'high' }, checks)).toMatchObject({ ok: true, value: { model: 'opus', effort: 'high' } });
    expect(await validateNewSession({ ...body, model: 'default' }, checks)).toMatchObject({ ok: true, value: { model: null, effort: null } });
    const plain = await validateNewSession(body, checks);
    expect(plain.ok && 'model' in plain.value).toBe(false);
    expect(await validateNewSession({ ...body, effort: 'turbo' }, checks)).toMatchObject({ ok: false, errors: [{ field: 'effort' }] });
  });
});

describe('the last choice follows the header picker (D31 route, D42)', () => {
  it('PUT /api/sessions/{id}/model stores a choice → it is the last choice', async () => {
    const w = await setup();
    const session = await startDone('header', { model: 'opus', effort: 'high' });
    expect((await call('PUT', `/api/sessions/${session.id}/model`, { model: 'claude-sonnet-4-6' })).statusCode).toBe(200);
    expect((await models()).last).toEqual({ model: 'claude-sonnet-4-6', effort: 'high' });
    expect((await call('PUT', `/api/sessions/${session.id}/model`, { effort: null })).statusCode).toBe(200);
    expect(await w.store.settings.get(MODELS_LAST_KEY)).toEqual({ model: 'claude-sonnet-4-6', effort: null });
    // A refused change stores nothing and leaves the last choice.
    expect((await call('PUT', `/api/sessions/${session.id}/model`, { model: 'gpt-4' })).statusCode).toBe(422);
    expect((await models()).last).toEqual({ model: 'claude-sonnet-4-6', effort: null });
  });
});

describe('schedules carry the choice (D42)', () => {
  it('the template keeps model / effort; each run starts with them and leaves the last choice alone', async () => {
    const w = await setup();
    await startDone('first', { model: 'opus', effort: 'low' });
    const template = { ...newSession({ name: 'nightly', task: 'Reply with just OK.' }), model: 'haiku', effort: null };
    const saved = await call('POST', '/api/schedules', { cron: '0 2 * * *', template });
    expect(saved.statusCode, saved.body).toBe(201);
    const schedule = saved.json() as Schedule;
    expect(schedule.template).toMatchObject({ model: 'haiku', effort: null });
    const refused = await call('POST', '/api/schedules', { cron: '0 2 * * *', template: { ...template, name: 'other', model: 'haiku', effort: 'high' } });
    expect(refused.statusCode).toBe(422);
    const run = await call('POST', `/api/schedules/${schedule.id}/run`);
    expect(run.statusCode, run.body).toBeLessThan(300);
    const spawn = await until(async () => (await sessionSpawns())[1], 'the run’s spawn');
    expect([flag(spawn, '--model'), flag(spawn, '--effort')]).toEqual(['haiku', null]);
    const runSession = (await w.store.sessions.list()).find((s) => s.name.startsWith('nightly-'));
    expect(runSession).toMatchObject({ model: 'haiku', effort: null });
    expect((await models()).last).toEqual({ model: 'opus', effort: 'low' });
  });
});
