/**
 * M7.1: the schedule routes (contract → `GET/POST /api/schedules`,
 * `POST /api/schedules/{id}/run · /pause · /resume`) on the app's own scheduler,
 * with fake-claude as the CLI; "Retry run" of the Inbox (M3.3) through it.
 */
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { InboxItem, NewSession, Schedule } from '../../../src/core/api.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { type HubMessage, HubBus } from '../../../src/server/hub/bus.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, until } from '../../helpers/supervisor.ts';

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
  const config = { ...base, port: PORT };
  await seedFolder(world.store, world.workspace);
  const bus = new HubBus();
  messages = [];
  bus.subscribe((message) => messages.push(message));
  app = await buildApp({ config, token, store: world.store, webRoot: world.root, supervisor: world.supervisor, bus });
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

function template(overrides: Partial<NewSession> = {}): NewSession {
  return newSession({ name: 'nightly-check', task: 'Check the build.', coordination: null, ...overrides });
}

async function schedules(): Promise<Schedule[]> {
  const response = await call('GET', '/api/schedules');
  expect(response.statusCode).toBe(200);
  return response.json() as Schedule[];
}

describe('/api/schedules (M7.1)', () => {
  it('lists nothing at first; Save schedule creates (201) and edits (200); 422 with field errors', async () => {
    await setup();
    expect(await schedules()).toEqual([]);

    const bad = await call('POST', '/api/schedules', { cron: 'every night', template: template({ task: '' }) });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toBe('invalid');
    expect(bad.json().errors.map((e: { field: string }) => e.field)).toEqual(['cron', 'template.task']);

    const created = await call('POST', '/api/schedules', { cron: '0 2 * * *', template: template() });
    expect(created.statusCode).toBe(201);
    const schedule = created.json() as Schedule;
    expect(schedule).toMatchObject({ name: 'nightly-check', description: 'Check the build.', cron: '0 2 * * *', paused: false, runs: [], running: false });
    expect(typeof schedule.nextRunAt).toBe('string');
    expect(new Date(schedule.nextRunAt!).getHours()).toBe(2);
    expect(await schedules()).toEqual([schedule]);

    const edited = await call('POST', '/api/schedules', { id: schedule.id, cron: '0 */4 * * *', template: template({ task: 'Reindex.' }) });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ id: schedule.id, cron: '0 */4 * * *', description: 'Reindex.' });
    const unknown = await call('POST', '/api/schedules', { id: 'nope', cron: '0 2 * * *', template: template({ name: 'other' }) });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'not-found', message: 'no schedule nope' });
  });

  it('Run now starts a session and answers the schedule with the run; 409 while it runs; Pause / Resume; 404s', async () => {
    const w = await setup();
    const schedule = (await call('POST', '/api/schedules', { cron: '0 2 * * *', template: template({ task: '[fake:hang] Keep going.' }) })).json() as Schedule;

    const run = await call('POST', `/api/schedules/${schedule.id}/run`);
    expect(run.statusCode).toBe(200);
    const after = run.json() as Schedule;
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]).toMatchObject({ result: 'running', triggeredBy: 'manual', finishedAt: null });
    const sessionId = after.runs[0]!.sessionId!;
    expect((await w.store.sessions.get(sessionId))?.name).toMatch(/^nightly-check-\d{4}-\d{4}$/);
    await until(async () => (await schedules())[0]?.running === true, 'running');
    expect(messages.filter((m) => m.name === 'scheduleRun').map((m) => m.payload)).toEqual([{ scheduleId: schedule.id, result: 'running' }]);

    const again = await call('POST', `/api/schedules/${schedule.id}/run`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'running', message: 'a run of this schedule is still in progress' });

    const paused = await call('POST', `/api/schedules/${schedule.id}/pause`);
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ paused: true, nextRunAt: null });
    const resumed = await call('POST', `/api/schedules/${schedule.id}/resume`);
    expect(resumed.json()).toMatchObject({ paused: false });
    expect(typeof (resumed.json() as Schedule).nextRunAt).toBe('string');

    for (const action of ['run', 'pause', 'resume']) {
      const missing = await call('POST', `/api/schedules/nope/${action}`);
      expect(missing.statusCode, action).toBe(404);
    }
    await w.supervisor.pause(sessionId);
  });

  it('a failed run raises "Scheduled run failed"; Retry run on the Inbox runs the schedule again (no longer 501)', async () => {
    const w = await setup();
    const schedule = (await call('POST', '/api/schedules', { cron: '0 2 * * *', template: template({ name: 'crashing', task: '[fake:crash] Build.' }) })).json() as Schedule;
    expect((await call('POST', `/api/schedules/${schedule.id}/run`)).statusCode).toBe(200);
    const item = await until(async () => {
      const inbox = (await call('GET', '/api/inbox')).json() as InboxItem[];
      return inbox.find((i) => i.kind === 'system' && i.source === 'crashing');
    }, 'the failed-run item');
    expect(item.label).toBe('Scheduled run failed');
    expect((await schedules())[0]?.runs.map((r) => r.result)).toEqual(['fail']);

    const retry = await call('POST', `/api/inbox/${item.id}/actions/retry-run`);
    expect(retry.statusCode).toBe(204);
    await until(async () => (await schedules())[0]?.runs.map((r) => r.result).join() === 'fail,fail', 'the retried run failing again');
    // Two sessions, one per run (a second run in the same minute gets `-2`).
    const names = (await w.store.sessions.list()).map((s) => s.name);
    expect(names).toHaveLength(2);
    for (const name of names) expect(name).toMatch(/^crashing-\d{4}-\d{4}(?:-2)?$/);
    expect(new Set(names).size).toBe(2);
  });
});
