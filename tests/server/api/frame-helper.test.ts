import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FrameHelperInfo } from '../../../src/core/api.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import type { Providers } from '../../../src/server/providers.ts';
import { createFrameHelperOpener } from '../../../src/server/tools/frame-helper.ts';
import { generateToken } from '../../../src/server/token.ts';
import { fakeOpenerCommand } from '../../../tools/fake-opener/command.ts';
import { REPO_ROOT, makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D35 (docs/frame-helper.md → Guided setup): `GET /api/frame-helper`, `POST
 * /api/frame-helper/reveal` and `/open-extensions` through the app, with the opener
 * run through tools/fake-opener (the platform injected): the exact argv per
 * platform, fixed whatever the request carries, 502 with the opener's error, 501
 * without an opener, and the cookie / Origin guard on all three.
 */

const PORT = 4933; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;
const DIR = path.join(REPO_ROOT, 'tools', 'frame-helper');

let tmp: string;
let log: string;
let store: Store;
let token: string;
let app: FastifyInstance | null = null;

beforeEach(async () => {
  tmp = await makeTempDir('api-frame-helper');
  log = path.join(tmp, 'opener.log');
  store = await openTempStore(tmp);
  token = generateToken();
});

afterEach(async () => {
  await app?.close();
  app = null;
  await store.close();
  await removeTempDir(tmp);
});

async function start(providers: Providers = {}): Promise<FastifyInstance> {
  await app?.close();
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT };
  app = await buildApp({ config, token, store, webRoot: tmp, providers });
  await app.ready();
  return app;
}

/** The opener as main.ts builds it, for `platform`, with the fake opener in front (`SWITCHBOARD_OPEN_COMMAND`). */
function fakeOpener(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}): Providers {
  return {
    frameHelperOpener: createFrameHelperOpener({
      platform,
      prefix: fakeOpenerCommand(),
      env: { ...process.env, FAKE_OPENER_LOG: log, ...env },
      exists: async () => false,
    }),
  };
}

function call(method: InjectOptions['method'], url: string, extra: Partial<InjectOptions> = {}) {
  if (!app) throw new Error('no app');
  return app.inject({ method, url, ...extra, headers: { host: HOST, cookie: `sb_token=${token}`, ...(extra.headers ?? {}) } });
}

async function calls(): Promise<string[][]> {
  try {
    return (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { argv: string[] }).argv);
  } catch {
    return [];
  }
}

describe('GET /api/frame-helper', () => {
  it('answers the real folder of this checkout and its manifest version', async () => {
    await start();
    const manifest = JSON.parse(await readFile(path.join(DIR, 'manifest.json'), 'utf8')) as { version: string };
    const response = await call('GET', '/api/frame-helper');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ path: DIR, version: manifest.version } satisfies FrameHelperInfo);
    expect(manifest.version).toBe('2.0.0');
  });
});

describe('POST /api/frame-helper/reveal and /open-extensions', () => {
  it('run the fake opener with the exact argv of each platform; 204', async () => {
    const expected: Record<string, string[][]> = {
      darwin: [
        ['open', '-R', `${DIR}/manifest.json`],
        ['open', '-a', 'Google Chrome', 'chrome://extensions'],
      ],
      linux: [
        ['xdg-open', DIR],
        ['google-chrome', 'chrome://extensions'],
      ],
      // No chrome.exe at the usual paths here (exists → false): `cmd /c start` in an argv array.
      win32: [
        ['explorer', '/select,', path.win32.join(DIR, 'manifest.json')],
        ['cmd', '/c', 'start', '', 'chrome', 'chrome://extensions'],
      ],
    };
    for (const [platform, argv] of Object.entries(expected)) {
      await rm(log, { force: true });
      await start(fakeOpener(platform as NodeJS.Platform));
      const reveal = await call('POST', '/api/frame-helper/reveal');
      expect(reveal.statusCode, platform).toBe(204);
      expect(reveal.body).toBe('');
      const open = await call('POST', '/api/frame-helper/open-extensions');
      expect(open.statusCode, platform).toBe(204);
      expect(await calls(), platform).toEqual(argv);
    }
  });

  it('never takes input from the request: a body and a query change nothing', async () => {
    await start(fakeOpener('darwin'));
    const withBody = await call('POST', '/api/frame-helper/reveal?path=/etc&cmd=rm', {
      payload: JSON.stringify({ path: '/etc/passwd', argv: ['rm', '-rf', '/'], url: 'file:///etc' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(withBody.statusCode).toBe(204);
    const open = await call('POST', '/api/frame-helper/open-extensions?url=https://evil.test', {
      payload: JSON.stringify({ url: 'https://evil.test' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(open.statusCode).toBe(204);
    expect(await calls()).toEqual([
      ['open', '-R', `${DIR}/manifest.json`],
      ['open', '-a', 'Google Chrome', 'chrome://extensions'],
    ]);
  });

  it('502 open-failed with the opener error when it fails (the UI then says to type chrome://extensions)', async () => {
    await start(fakeOpener('darwin', { FAKE_OPENER_FAIL: 'chrome://extensions' }));
    const open = await call('POST', '/api/frame-helper/open-extensions');
    expect(open.statusCode).toBe(502);
    expect(open.json()).toEqual({
      error: 'open-failed',
      message: 'open -a Google Chrome chrome://extensions: fake-opener: open -a Google Chrome chrome://extensions failed',
    });
    await start(fakeOpener('darwin', { FAKE_OPENER_FAIL: '-R' }));
    const reveal = await call('POST', '/api/frame-helper/reveal');
    expect(reveal.statusCode).toBe(502);
    expect(reveal.json()).toMatchObject({ error: 'open-failed', message: expect.stringContaining('open -R ') });
  });

  it('501 without an opener (a bare app): nothing can open a real app by accident', async () => {
    await start();
    for (const url of ['/api/frame-helper/reveal', '/api/frame-helper/open-extensions']) {
      const response = await call('POST', url);
      expect(response.statusCode, url).toBe(501);
      expect(response.json()).toEqual({ error: 'not-implemented', item: 'D35' });
    }
  });
});

describe('the guard', () => {
  it('all three need the token cookie and refuse a foreign Origin or Host; nothing runs', async () => {
    await start(fakeOpener('darwin'));
    const routes: Array<[InjectOptions['method'], string]> = [
      ['GET', '/api/frame-helper'],
      ['POST', '/api/frame-helper/reveal'],
      ['POST', '/api/frame-helper/open-extensions'],
    ];
    for (const [method, url] of routes) {
      const noCookie = await app!.inject({ method, url, headers: { host: HOST } });
      expect(noCookie.statusCode, `${method} ${url}`).toBe(401);
      const wrongCookie = await app!.inject({ method, url, headers: { host: HOST, cookie: 'sb_token=nope' } });
      expect(wrongCookie.statusCode, `${method} ${url}`).toBe(401);
      const foreignOrigin = await call(method, url, { headers: { origin: 'http://127.0.0.1:13000' } });
      expect(foreignOrigin.statusCode, `${method} ${url}`).toBe(403);
      const foreignHost = await app!.inject({ method, url, headers: { host: `evil.test:${PORT}`, cookie: `sb_token=${token}` } });
      expect(foreignHost.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(await calls()).toEqual([]);
    // The page's own origin passes.
    expect((await call('POST', '/api/frame-helper/reveal', { headers: { origin: `http://${HOST}` } })).statusCode).toBe(204);
  });
});
