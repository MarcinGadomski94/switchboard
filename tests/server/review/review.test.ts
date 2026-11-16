import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { InboxItem, Session } from '../../../src/core/api.ts';
import { DEVICE_ALLOWED } from '../../../src/server/devices/local-only.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D166 oracle (`docs/inbox.md` → *To review*): a supervised fake-claude session whose turn writes a
 * file (the recorded `tool-use` turn: a `Write`) reads **To review** (`Session.review`) and raises
 * one "Review: <agent>" Needs-you item; Mark reviewed (the agent page's route, or the card's Inbox
 * action) clears both; the developer's next message clears them too, and a turn that only answers
 * raises nothing.
 */

const PORT = 4874;
const HOST = `127.0.0.1:${PORT}`;

let world: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';

afterEach(async () => {
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

async function session(id: string): Promise<Session> {
  return (await call('GET', `/api/sessions/${id}`)).json() as Session;
}

const reviewItems = async (sessionId: string): Promise<InboxItem[]> => ((await call('GET', '/api/inbox')).json() as InboxItem[]).filter((item) => item.systemKind === 'review' && item.sessionId === sessionId);

async function closedOutcomes(store: Store, sessionId: string): Promise<Array<string | null>> {
  return (await store.systemItems.list(['closed'])).filter((item) => item.kind === 'review' && item.sessionId === sessionId).map((item) => item.closedAction);
}

async function reviewed(sessionId: string): Promise<InboxItem> {
  return until(async () => {
    const found = await reviewItems(sessionId);
    return found.length === 1 ? found[0] : undefined;
  }, 'the Review item');
}

describe('D166 · To review (supervised session)', () => {
  it('a turn that writes a file raises one Review item and Session.review; Mark reviewed clears both; an answer-only turn raises nothing', async () => {
    const w = await setup();
    const started = await w.supervisor.start(newSession({ task: '[fake:tool-use] Write the file.' }), w.place);
    await waitForStatus(w.store, started.id, ['done']);
    const item = await reviewed(started.id);
    expect(item).toMatchObject({ kind: 'system', status: 'need', label: 'To review', actions: [{ id: 'open-changes', label: 'Open changes' }, { id: 'mark-reviewed', label: 'Mark reviewed' }] });
    expect(item.title).toMatch(/^Review: .+ · 1 file changed$/);
    expect((await session(started.id)).review).toMatchObject({ turns: 1, fileCount: 1 });

    // Mark reviewed on the agent page.
    expect((await call('POST', `/api/sessions/${started.id}/reviewed`)).statusCode).toBe(200);
    expect((await session(started.id)).review).toBeUndefined();
    expect(await reviewItems(started.id)).toEqual([]);
    expect(await closedOutcomes(w.store, started.id)).toEqual(['reviewed']);
    // Nothing pending: still fine.
    expect((await call('POST', `/api/sessions/${started.id}/reviewed`)).statusCode).toBe(200);

    // A turn that only answers raises nothing.
    expect((await call('POST', `/api/sessions/${started.id}/messages`, { text: 'Thanks, all good.' })).statusCode).toBe(202);
    await waitForStatus(w.store, started.id, ['done']);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await reviewItems(started.id)).toEqual([]);
    expect((await session(started.id)).review).toBeUndefined();
  });

  it('the developer’s message clears a pending review (replied); the card’s Mark reviewed does too', async () => {
    const w = await setup();
    const started = await w.supervisor.start(newSession({ task: '[fake:tool-use] Write the file.' }), w.place);
    await waitForStatus(w.store, started.id, ['done']);
    await reviewed(started.id);
    expect((await call('POST', `/api/sessions/${started.id}/messages`, { text: 'Looks good, now the tests.' })).statusCode).toBe(202);
    await until(async () => ((await closedOutcomes(w.store, started.id)).includes('replied') ? true : undefined), 'the item closed by the reply');
    await waitForStatus(w.store, started.id, ['done']);

    // A new episode from another file-changing turn; the card's own Mark reviewed ends it.
    expect((await call('POST', `/api/sessions/${started.id}/messages`, { text: '[fake:tool-use] Write it again.' })).statusCode).toBe(202);
    const item = await until(async () => {
      const found = await reviewItems(started.id);
      return found.length === 1 ? found[0] : undefined;
    }, 'a new Review item');
    expect((await call('POST', `/api/inbox/${encodeURIComponent(item.id)}/actions/mark-reviewed`)).statusCode).toBe(204);
    expect((await session(started.id)).review).toBeUndefined();
    expect(await reviewItems(started.id)).toEqual([]);
  });

  it('Mark reviewed is allowed to a paired phone and forwarded to a paired computer', () => {
    expect(DEVICE_ALLOWED.some(([method, pattern]) => method === 'POST' && pattern.test('/api/sessions/s1/reviewed'))).toBe(true);
    expect(peerApiAllowed('POST', '/api/sessions/s1/reviewed')).toBe(true);
  });
});
