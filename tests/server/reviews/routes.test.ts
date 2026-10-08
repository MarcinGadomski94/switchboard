/**
 * D79 · the routes: `GET /api/reviews`, `POST /api/reviews/{id}/<action>` (answers and
 * refusals), the Inbox's review items and their actions through
 * `POST /api/inbox/{id}/actions/{action}`, the setting.
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { InboxItem } from '../../../src/core/api.ts';
import type { Review } from '../../../src/core/reviews.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { ReviewGit } from '../../../src/server/reviews/git.ts';
import { ReviewService } from '../../../src/server/reviews/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import { fakeGhCommand } from '../../../tools/fake-gh/command.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';

const PORT = 4910; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

let world: GitWorld | null = null;
let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  await world?.cleanup();
  world = null;
});

async function setup() {
  const w = await makeGitWorld();
  world = w;
  const bus = new HubBus();
  const manager = w.manager();
  const service = new ReviewService({
    store: w.store,
    bus,
    git: new ReviewGit({ gh: fakeGhCommand(), env: w.env }),
    resolveRepo: (solution, folder) => manager.resolveRepo(solution, folder),
    enabled: async () => true,
    send: async () => undefined,
  });
  const token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: path.join(w.root, 'data') }, platform: 'linux', home: w.root, cwd: w.root });
  app = await buildApp({ config: { ...base, port: PORT }, token, store: w.store, webRoot: w.root, bus, worktrees: manager, reviews: service, agentTools: false });
  await app.ready();
  const call = (method: InjectOptions['method'], url: string, payload?: unknown) =>
    (app as FastifyInstance).inject({
      method,
      url,
      headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  const dir = path.join(path.dirname(w.web), 'web-front-wt-routes');
  await w.git(w.web, 'worktree', 'add', '-q', '-b', 'session/routes', dir, 'main');
  const session = await w.store.sessions.create({ name: 'routes', claudeSessionId: randomUUID(), solutions: ['web-front'], worktrees: true, root: w.workspace, rootKind: 'workspace', cwd: dir });
  await w.store.worktrees.create({ repo: 'web-front', repoPath: w.web, branch: 'session/routes', path: dir, baseRef: 'main', sessionId: session.id });
  return { w, service, call, dir, session };
}

describe('the review routes (D79)', () => {
  it('lists the cards; actions answer the card; refusals answer { error, message[, conflicts] }', async () => {
    const { w, service, call, dir, session } = await setup();
    expect((await call('GET', '/api/reviews')).json()).toEqual([]);
    await w.commit(dir, 'src/app.txt', 'one\nbranch\nthree\n');
    await w.commit(w.web, 'src/app.txt', 'one\nmain\nthree\n');
    await service.evaluate(session.id);
    const listed = (await call('GET', '/api/reviews')).json() as Review[];
    expect(listed).toHaveLength(1);
    const id = listed[0]?.id as string;

    const conflict = await call('POST', `/api/reviews/${id}/merge`);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: 'conflicts', message: 'web-front: session/routes conflicts with main', conflicts: ['src/app.txt'] });
    const bad = await call('POST', `/api/reviews/${id}/send-back`, { comment: '' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: 'invalid' });
    expect((await call('POST', '/api/reviews/nope/merge')).statusCode).toBe(404);
    expect((await call('POST', `/api/reviews/${id}/explode`)).statusCode).toBe(404);

    // The Inbox lists it as a review item; its Dismiss goes through the Inbox's actions route too.
    const inbox = (await call('GET', '/api/inbox')).json() as InboxItem[];
    expect(inbox.find((item) => item.id === id)).toMatchObject({ kind: 'review', label: 'Review', review: { id, state: 'pending', conflicts: ['src/app.txt'] } });
    expect((await call('POST', `/api/inbox/${id}/actions/dismiss`)).statusCode).toBe(204);
    const after = (await call('GET', '/api/reviews')).json() as Review[];
    expect(after).toMatchObject([{ id, state: 'resolved', outcome: 'dismissed' }]);
    expect(((await call('GET', '/api/inbox')).json() as InboxItem[]).some((item) => item.id === id)).toBe(false);
  });

  it('Settings → Sessions: sessions.reviewCards is on by default and can be turned off', async () => {
    const { call, dir } = await setup();
    await writeFile(path.join(dir, 'x.txt'), 'x\n');
    expect((await call('GET', '/api/settings')).json()).toMatchObject({ 'sessions.reviewCards': true });
    expect((await call('PUT', '/api/settings', { 'sessions.reviewCards': false })).statusCode).toBe(200);
    expect((await call('GET', '/api/settings')).json()).toMatchObject({ 'sessions.reviewCards': false });
    expect((await call('PUT', '/api/settings', { 'sessions.reviewCards': 'no' })).statusCode).toBe(422);
  });
});
