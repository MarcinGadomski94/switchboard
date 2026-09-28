import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARTIFACT_ROUTES_PENDING } from '../../../src/server/api/artifacts.ts';
import { HISTORY_ROUTES_PENDING } from '../../../src/server/api/history.ts';
import { INBOX_ROUTES_PENDING } from '../../../src/server/api/inbox.ts';
import { SCHEDULE_ROUTES_PENDING } from '../../../src/server/api/schedules.ts';
import { SESSION_ROUTES_PENDING } from '../../../src/server/api/sessions.ts';
import { SETTINGS_ROUTES_PENDING } from '../../../src/server/api/settings.ts';
import { SOLUTION_ROUTES_PENDING } from '../../../src/server/api/solutions.ts';
import { SYSTEM_ROUTES_PENDING } from '../../../src/server/api/system.ts';
import { TOOL_ROUTES_PENDING } from '../../../src/server/api/tools.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

const PORT = 4871; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

/**
 * Every REST row of contracts/local-api.md (concrete ids in place of {id}), with
 * the backlog item docs/lanes.md assigns it.
 */
const CONTRACT: ReadonlyArray<['GET' | 'POST' | 'PUT', string, string]> = [
];

/** Contract rows implemented so far (their behavior has its own tests, e.g. tests/server/api/sessions.test.ts). */
const IMPLEMENTED: ReadonlyArray<['GET' | 'POST' | 'PUT' | 'DELETE', string, string]> = [
  ['GET', '/api/sessions', 'M2.1'],
  ['POST', '/api/sessions', 'M2.1'],
  ['GET', '/api/sessions/s1', 'M2.1'],
  ['POST', '/api/sessions/s1/messages', 'M2.1'],
  ['POST', '/api/sessions/s1/pause', 'M2.1'],
  ['POST', '/api/sessions/s1/resume', 'M2.1'],
  ['POST', '/api/sessions/s1/detach', 'M2.1'],
  ['POST', '/api/sessions/s1/attach', 'M2.1'],
  ['GET', '/api/sessions/s1/events?since=2026-09-28T00:00:00.000Z', 'M2.1'],
  ['GET', '/api/sessions/s1/diff?file=a.ts', 'M4.5'],
  ['POST', '/api/solutions/mobile/isolate', 'M2.2'],
  ['GET', '/api/inbox', 'M3.2'],
  ['POST', '/api/questions/batch/b1/answers', 'M3.1'],
  ['POST', '/api/inbox/i1/actions/allow-once', 'M3.1'],
  ['GET', '/api/solutions', 'M6.1'],
  ['GET', '/api/tools', 'M8.1'],
  ['PUT', '/api/tools', 'M8.1'],
  ['POST', '/api/tools/nope/probe', 'M8.1'], // an unknown tool: nothing is fetched (tests/server/api/tools.test.ts)
  ['GET', '/api/codebase-memory', 'M8.1'], // additive (docs/tools.md)
  ['POST', '/api/codebase-memory/reindex', 'M8.1'], // additive; no saved folder here → 409 no-folder, nothing starts
  ['GET', '/api/settings', 'M8.2'],
  ['PUT', '/api/settings', 'M8.2'], // no body here → 422, nothing stored (tests/server/api/settings.test.ts)
  ['GET', '/api/artifacts?type=PR&q=x', 'M7.3'], // tests/server/api/artifacts.test.ts
  ['GET', '/api/history?q=x', 'M7.4'], // no folder here → stored sessions only (tests/server/api/history.test.ts)
  ['POST', '/api/history/bad%20id/continue', 'D16'], // additive; a malformed id → 404, nothing is read (tests/server/history/continue.test.ts)
  // M7.1 (docs/schedules.md): the scheduler.
  ['GET', '/api/schedules', 'M7.1'],
  ['POST', '/api/schedules', 'M7.1'],
  ['POST', '/api/schedules/c1/run', 'M7.1'],
  ['POST', '/api/schedules/c1/pause', 'M7.1'],
  ['POST', '/api/schedules/c1/resume', 'M7.1'],
  // M5.3: 503 here (this app has no system provider; main.ts passes the real SystemProbe).
  ['GET', '/api/system', 'M5.3'],
  // M5.3, additive to the contract (docs/setup.md): the first-run wizard.
  ['GET', '/api/setup', 'M5.3'],
  ['GET', '/api/setup/folders?path=/tmp', 'M5.3'],
  ['POST', '/api/setup/complete', 'M5.3'],
  // D14, additive to the contract (docs/folders.md): the saved folders.
  ['GET', '/api/folders', 'D14'],
  ['GET', '/api/folders/check?path=/tmp', 'D14'],
  ['POST', '/api/folders', 'D14'], // no body here → 422, nothing saved
  ['DELETE', '/api/folders/nope', 'D14'],
  ['PUT', '/api/folders/nope/default', 'D14'],
];

let tmp: string;
let store: Store;
let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  tmp = await makeTempDir('api-routes');
  store = await openTempStore(tmp);
  token = generateToken();
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT };
  app = await buildApp({ config, token, store, webRoot: tmp });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await store.close();
  await removeTempDir(tmp);
});

describe('API route registry (M1.4)', () => {
  it('registers every contract route; each answers 501 with its backlog item until implemented', async () => {
    for (const [method, url, item] of CONTRACT) {
      const response = await app.inject({ method, url, headers: { host: HOST, cookie: `sb_token=${token}` } });
      expect(response.statusCode, `${method} ${url}`).toBe(501);
      expect(response.json(), `${method} ${url}`).toEqual({ error: 'not-implemented', item });
    }
  });

  it('keeps every route behind the cookie guard', async () => {
    for (const [method, url] of [...CONTRACT, ...IMPLEMENTED]) {
      const response = await app.inject({ method, url, headers: { host: HOST } });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('no longer answers 501 on the implemented routes', async () => {
    for (const [method, url] of IMPLEMENTED) {
      const response = await app.inject({ method, url, headers: { host: HOST, cookie: `sb_token=${token}` } });
      expect(response.statusCode, `${method} ${url}`).not.toBe(501);
    }
  });

  it('lists exactly the contract routes still pending, once each', () => {
    const pending = [
      ...SESSION_ROUTES_PENDING,
      ...INBOX_ROUTES_PENDING,
      ...SOLUTION_ROUTES_PENDING,
      ...SCHEDULE_ROUTES_PENDING,
      ...ARTIFACT_ROUTES_PENDING,
      ...HISTORY_ROUTES_PENDING,
      ...SETTINGS_ROUTES_PENDING,
      ...TOOL_ROUTES_PENDING,
      ...SYSTEM_ROUTES_PENDING,
    ];
    expect(pending).toHaveLength(CONTRACT.length);
    expect(new Set(pending.map((route) => `${String(route.method)} ${route.url}`)).size).toBe(pending.length);
  });

  it('leaves unknown /api paths at 404; /hub is the SSE stream (M2.3, tests/server/hub/hub.test.ts)', async () => {
    const headers = { host: HOST, cookie: `sb_token=${token}` };
    expect((await app.inject({ method: 'GET', url: '/api/nope', headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/sessions', headers })).statusCode).toBe(404);
    const hub = await app.inject({ method: 'GET', url: '/hub', headers, payloadAsStream: true });
    expect(hub.statusCode).toBe(200);
    expect(hub.headers['content-type']).toBe('text/event-stream');
    hub.stream().destroy();
    expect((await app.inject({ method: 'GET', url: '/hub', headers: { host: HOST } })).statusCode).toBe(401);
  });
});
