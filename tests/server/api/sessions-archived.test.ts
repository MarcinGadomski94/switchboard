import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import { ARCHIVE_PEER_LIMIT } from '../../../src/core/session-archive.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { PEER_REQUEST_HEADER } from '../../../src/server/peers/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D137 follow-up 2026-10-26: `GET /api/sessions?closed=only` (this computer's archived
 * sessions only) and the cap a paired computer gets (the newest ARCHIVE_PEER_LIMIT, newest
 * first, without agents), each with `deletesAt` / `keptReason`.
 */
const PORT = 4877; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

let tmp: string | undefined;
let store: Store | undefined;
let app: FastifyInstance | undefined;
let token = '';

afterEach(async () => {
  await app?.close();
  await store?.close();
  if (tmp) await removeTempDir(tmp);
  app = undefined;
  store = undefined;
  tmp = undefined;
});

async function setup(): Promise<void> {
  tmp = await makeTempDir('api-sessions-archived');
  store = await openTempStore(path.join(tmp, 'data'));
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: path.join(tmp, 'data') }, platform: 'linux', home: tmp, cwd: tmp });
  app = await buildApp({ config: { ...base, port: PORT }, token, store, webRoot: tmp });
  await app.ready();
}

function call(method: InjectOptions['method'], url: string, headers: Record<string, string> = {}) {
  if (!app) throw new Error('no app');
  return app.inject({ method, url, headers: { host: HOST, cookie: `sb_token=${token}`, ...headers } });
}

async function session(name: string, closedAt: number | null): Promise<string> {
  const created = await store!.sessions.create({ name, claudeSessionId: randomUUID(), solutions: [], worktrees: false, root: tmp as string, rootKind: 'workspace', cwd: tmp as string });
  if (closedAt !== null) await store!.sessions.update(created.id, { closedAt: new Date(closedAt).toISOString() });
  return created.id;
}

describe('GET /api/sessions?closed=only (D137 follow-up)', () => {
  it('lists the archived sessions only; a peer gets the newest ARCHIVE_PEER_LIMIT, newest first, without agents', async () => {
    await setup();
    const now = Date.now();
    const open = await session('still-open', null);
    const ids: string[] = [];
    for (let i = 0; i <= ARCHIVE_PEER_LIMIT; i++) ids.push(await session(`archived-${i}`, now - (i + 1) * 60_000));
    const ui = (await call('GET', '/api/sessions?closed=only')).json<Session[]>();
    expect(ui).toHaveLength(ARCHIVE_PEER_LIMIT + 1);
    expect(ui.some((s) => s.id === open)).toBe(false);
    expect(ui.every((s) => typeof s.closedAt === 'string' && typeof s.deletesAt === 'string')).toBe(true);
    const peer = (await call('GET', '/api/sessions?closed=only', { [PEER_REQUEST_HEADER]: 'm1' })).json<Session[]>();
    expect(peer.map((s) => s.id)).toEqual(ids.slice(0, ARCHIVE_PEER_LIMIT));
    expect(peer.every((s) => s.agents === undefined)).toBe(true);
    // The other filters are unchanged; a bad one names every value.
    expect((await call('GET', '/api/sessions')).json<Session[]>().map((s) => s.id)).toEqual([open]);
    expect((await call('GET', '/api/sessions?closed=include')).json<Session[]>()).toHaveLength(ARCHIVE_PEER_LIMIT + 2);
    const bad = await call('GET', '/api/sessions?closed=closed');
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors[0].message).toContain('only');
  });
});
