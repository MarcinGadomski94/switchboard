import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProcessesOverview, SessionEvent, SessionProcesses } from '../../../src/core/api.ts';
import { appProcesses, buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { DEVICE_ALLOWED } from '../../../src/server/devices/local-only.ts';
import { processAlive } from '../../../src/server/hooks/terminal-stop.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { agentTokenFor } from '../../../src/server/todos/agent-token.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D127 (`docs/processes.md`; contract → *Session processes (D127)*): a supervised fake-claude
 * session leaves a process running (`[fake:leave-process]`: through a shell that exits, so the
 * process outlives its parent and carries the session's marker from the spawned CLI's
 * environment); the routes list it, the agent's `process_keep` marks it, Stop stops it and notes
 * it on the timeline, and closing the session stops what is left. Every process involved is the
 * fake's own (each ends by itself after 60 s at the latest).
 */

const PORT = 4876;
const HOST = `127.0.0.1:${PORT}`;
const POSIX = process.platform === 'darwin' || process.platform === 'linux';

let world: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';
const leftovers = new Set<number>();

afterEach(async () => {
  for (const pid of leftovers) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  leftovers.clear();
  await app?.close();
  await world?.cleanup();
  app = undefined;
  world = undefined;
});

async function setup(): Promise<SupervisorWorld> {
  world = await makeSupervisorWorld();
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: world.root }, platform: 'linux', home: world.root, cwd: world.root });
  await seedFolder(world.store, world.workspace);
  app = await buildApp({ config: { ...base, port: PORT }, token, store: world.store, webRoot: world.root, supervisor: world.supervisor });
  await app.ready();
  return world;
}

function call(method: InjectOptions['method'], url: string, payload?: unknown) {
  if (!app) throw new Error('no app');
  return app.inject({ method, url, headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
}

function agentKeep(sessionId: string, payload: unknown) {
  if (!app) throw new Error('no app');
  return app.inject({
    method: 'POST',
    url: '/agent/v1/processes/keep',
    headers: { host: HOST, 'x-switchboard-session': sessionId, authorization: `Bearer ${agentTokenFor(token, sessionId)}`, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

/** Starts a session whose first turn leaves a process running; its pid once listed. */
async function sessionWithLeftover(w: SupervisorWorld): Promise<{ readonly id: string; readonly pid: number }> {
  const started = await w.supervisor.start(newSession({ task: 'Start the dev server. [fake:leave-process 60]' }), w.place);
  await waitForStatus(w.store, started.id, ['done']);
  const view = await until(async () => {
    const answer = (await call('GET', `/api/sessions/${started.id}/processes?fresh=1`)).json() as SessionProcesses;
    return answer.processes.length > 0 ? answer : undefined;
  }, 'the leftover to be listed');
  const pid = view.processes[0]?.pid as number;
  leftovers.add(pid);
  return { id: started.id, pid };
}

describe.skipIf(!POSIX)('D127 · session processes over the API', () => {
  it('lists the leftover (marker from the spawned CLI), Keep by the agent, Stop by the developer (noted on the timeline)', async () => {
    const w = await setup();
    const { id, pid } = await sessionWithLeftover(w);
    const view = (await call('GET', `/api/sessions/${id}/processes`)).json() as SessionProcesses;
    expect(view).toMatchObject({ sessionId: id, tracking: 'marker', working: false, closed: false });
    // Only the leftover: never the CLI (the fake), never its MCP helper.
    expect(view.processes.map((p) => [p.pid, p.name, p.kind, p.keep])).toEqual([[pid, 'node -e', 'other', false]]);

    const overview = (await call('GET', '/api/processes')).json() as ProcessesOverview;
    expect(overview).toMatchObject({ count: 1, idleStopMinutes: 10 });
    expect(overview.sessions.map((s) => s.sessionId)).toEqual([id]);

    // The agent keeps it (its own session only).
    const kept = await agentKeep(id, { match: 'setTimeout', keep: true, reason: 'dev server for the review' });
    expect(kept.statusCode).toBe(200);
    expect(kept.json()).toMatchObject({ keep: true, processes: [{ pid, keep: true, keptBy: 'agent', keepReason: 'dev server for the review' }] });
    expect((await agentKeep(id, { match: 'no-such-thing', keep: true })).statusCode).toBe(404);
    expect((await agentKeep(id, { keep: true })).json()).toMatchObject({ error: 'invalid' });
    // The developer hands it back.
    expect(((await call('PUT', `/api/sessions/${id}/processes/${pid}/keep`, { keep: false })).json() as SessionProcesses).processes[0]?.keep).toBe(false);
    expect((await call('PUT', `/api/sessions/${id}/processes/${pid}/keep`, {})).statusCode).toBe(422);
    expect((await call('POST', `/api/sessions/${id}/processes/abc/stop`)).statusCode).toBe(422);
    expect((await call('GET', '/api/sessions/no-such-session/processes')).statusCode).toBe(404);

    const stopped = await call('POST', `/api/sessions/${id}/processes/${pid}/stop`);
    expect(stopped.statusCode).toBe(200);
    expect((stopped.json() as SessionProcesses).processes).toEqual([]);
    expect(processAlive(pid)).toBe(false);
    const events = (await call('GET', `/api/sessions/${id}/events`)).json() as SessionEvent[];
    const note = events.find((event) => (event.payload as { action?: string } | null)?.action === 'processes-stopped');
    expect(note?.label).toMatch(/^Stopped 1 process \(\d+ MB\) \(Stop in Processes\)$/);
    // Stopping it again: it is no longer the session's.
    expect((await call('POST', `/api/sessions/${id}/processes/${pid}/stop`)).statusCode).toBe(404);
  });

  it('closing the session stops its leftovers (the sampler)', async () => {
    const w = await setup();
    const { id, pid } = await sessionWithLeftover(w);
    expect((await call('POST', `/api/sessions/${id}/close`, { confirm: true })).statusCode).toBe(200);
    await appProcesses(app as FastifyInstance)?.sample();
    await until(async () => !processAlive(pid), 'the leftover to stop on close');
    const events = (await call('GET', `/api/sessions/${id}/events`)).json() as SessionEvent[];
    expect(events.some((event) => /when the session was closed$/.test(event.label ?? ''))).toBe(true);
  });

  it('paired machines and phones may reach the routes', () => {
    for (const [method, url] of [
      ['GET', '/api/processes'],
      ['GET', '/api/sessions/s1/processes'],
      ['POST', '/api/sessions/s1/processes/123/stop'],
      ['PUT', '/api/sessions/s1/processes/123/keep'],
    ] as const) {
      expect(peerApiAllowed(method, url), `${method} ${url}`).toBe(true);
      expect(DEVICE_ALLOWED.some(([methods, pattern]) => methods.split('|').includes(method) && pattern.test(url)), `${method} ${url}`).toBe(true);
    }
  });
});
