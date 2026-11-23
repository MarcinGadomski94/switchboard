import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import type { SidebarLayout } from '../../../src/core/sidebar-layout.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { generateToken } from '../../../src/server/token.ts';
import { type SupervisorWorld, makeSupervisorWorld, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D175 · a conversation (D106 chat) is pinned to the sidebar like an agent (`docs/sidebar.md` →
 * *Pinned conversations (D175)*): `POST /api/sidebar/place` pins it, the layout keeps it (the
 * database: a new app on the same store reads it back), Undo's indexed pin and Unpin work.
 */

const PORT = 4963; // inject() opens no socket; the port feeds the Host check only

let world: SupervisorWorld | undefined;
const apps: FastifyInstance[] = [];
let token = '';

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps.length = 0;
  await world?.cleanup();
  world = undefined;
});

async function newApp(w: SupervisorWorld): Promise<FastifyInstance> {
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: w.root }, platform: 'linux', home: w.root, cwd: w.root });
  const app = await buildApp({ config: { ...base, port: PORT }, token, store: w.store, webRoot: w.root, supervisor: w.supervisor, bus: new HubBus() });
  await app.ready();
  apps.push(app);
  return app;
}

function call(app: FastifyInstance, method: InjectOptions['method'], url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { host: `127.0.0.1:${PORT}`, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

describe('D175 · pinned conversations', () => {
  it('a conversation is pinned and unpinned like an agent, and the pin is kept in the database', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    token = generateToken();
    const app = await newApp(w);
    const started = await call(app, 'POST', '/api/chats', { message: 'Which queue should we use?' });
    expect(started.statusCode, started.body).toBe(201);
    const chat = started.json() as Session;
    expect(chat.kind).toBe('chat');
    await waitForStatus(w.store, chat.id, ['done']);

    const pinned = await call(app, 'POST', '/api/sidebar/place', { sessionId: chat.id, place: 'pinned' });
    expect(pinned.statusCode, pinned.body).toBe(200);
    expect((pinned.json() as SidebarLayout).pinned).toEqual([chat.id]);

    // Kept: another app on the same database (a restart) reads the pin back.
    const again = await newApp(w);
    expect(((await call(again, 'GET', '/api/sidebar')).json() as SidebarLayout).pinned).toEqual([chat.id]);

    // Unpin (D186: `unpinned` takes it out of Pinned only; `loose` moves it and keeps the pin); Undo pins it back at its place.
    const unpinned = await call(again, 'POST', '/api/sidebar/place', { sessionId: chat.id, place: 'unpinned' });
    expect(unpinned.statusCode, unpinned.body).toBe(200);
    expect((unpinned.json() as SidebarLayout).pinned).toEqual([]);
    const undo = await call(again, 'POST', '/api/sidebar/place', { sessionId: chat.id, place: 'pinned', index: 0 });
    expect((undo.json() as SidebarLayout).pinned).toEqual([chat.id]);
  }, 60_000);
});
