import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.ts';
import { type ServerConfig, loadConfig } from '../../src/server/config.ts';
import { isAllowedHost, isAllowedOrigin, readCookieValues } from '../../src/server/security.ts';
import { generateToken } from '../../src/server/token.ts';
import { UNBUILT_PAGE } from '../../src/server/web.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';

const PORT = 4871; // inject() never opens a socket; the port only feeds the Host/Origin checks
const HOST = `127.0.0.1:${PORT}`;
const INDEX_HTML = '<!doctype html><html><head><title>Switchboard</title></head><body><div id="root"></div></body></html>';
const ASSET_JS = 'console.log("asset");';
const OUTSIDE_SECRET = 'outside-web-root-secret';

let tmp: string;
let webRoot: string;
let token: string;
let app: FastifyInstance;
let config: ServerConfig;

function request(options: InjectOptions & { url: string }) {
  const headers = { host: HOST, ...(options.headers ?? {}) };
  return app.inject({ method: 'GET', ...options, headers });
}

function authed(headers: Record<string, string> = {}): Record<string, string> {
  return { cookie: `sb_token=${token}`, ...headers };
}

/** Parses a Set-Cookie header into name, value and lower-cased attributes. */
function parseSetCookie(header: string) {
  const [pair, ...attrs] = header.split(';').map((part) => part.trim());
  const eq = pair!.indexOf('=');
  const attributes = new Map<string, string>();
  for (const attr of attrs) {
    const i = attr.indexOf('=');
    attributes.set((i < 0 ? attr : attr.slice(0, i)).toLowerCase(), i < 0 ? '' : attr.slice(i + 1));
  }
  return { name: pair!.slice(0, eq), value: pair!.slice(eq + 1), attributes };
}

function setCookieOf(response: { headers: Record<string, unknown> }): string | undefined {
  const value = response.headers['set-cookie'];
  if (Array.isArray(value)) return value.join('\n');
  return typeof value === 'string' ? value : undefined;
}

beforeAll(async () => {
  tmp = await makeTempDir('security');
  webRoot = path.join(tmp, 'web');
  await mkdir(path.join(webRoot, 'assets'), { recursive: true });
  await writeFile(path.join(webRoot, 'index.html'), INDEX_HTML);
  await writeFile(path.join(webRoot, 'assets', 'app.js'), ASSET_JS);
  await writeFile(path.join(tmp, 'secret.txt'), OUTSIDE_SECRET);
  token = generateToken();
  config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT };
  app = await buildApp({ config, token, webRoot });
  // Probe routes standing in for the API routes later items add.
  app.get('/api/_probe', async () => ({ ok: true }));
  app.post('/api/_probe', async () => ({ ok: true }));
  app.get('/hub', async () => 'hub');
  // A route under /api wrongly marked public must still need the cookie.
  app.get('/api/_public-attempt', { config: { public: true } }, async () => ({ ok: true }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await removeTempDir(tmp);
});

describe('Host guard (DNS rebinding)', () => {
  it.each([
    'evil.example',
    `evil.example:${PORT}`,
    '127.0.0.1:4870',
    `localhost:${PORT + 1}`,
    `127.0.0.2:${PORT}`,
    `0.0.0.0:${PORT}`,
    `[::1]:${PORT}`,
    `localhost.:${PORT}`,
    `127.0.0.1.evil.example:${PORT}`,
    `evil.example@127.0.0.1:${PORT}`,
    `192.168.1.10:${PORT}`,
    '',
  ])('rejects Host %j with 403 on the UI page, static files and the API', async (host) => {
    for (const url of ['/', '/assets/app.js', '/api/_probe', '/hub']) {
      const response = await request({ url, headers: authed({ host, 'sec-fetch-site': 'none' }) });
      expect(response.statusCode, `${url} Host=${host}`).toBe(403);
      expect(response.json()).toEqual({ error: 'forbidden-host' });
      expect(setCookieOf(response)).toBeUndefined();
    }
  });

  it.each([HOST, `localhost:${PORT}`, `LOCALHOST:${PORT}`])('accepts Host %j', async (host) => {
    const response = await request({ url: '/', headers: { host } });
    expect(response.statusCode).toBe(200);
  });
});

describe('Origin guard (CSRF)', () => {
  it.each([
    'http://evil.example',
    `http://evil.example:${PORT}`,
    'http://127.0.0.1:4870',
    'http://127.0.0.1:13000',
    `https://127.0.0.1:${PORT}`,
    `http://localhost.evil.example:${PORT}`,
    `http://[::1]:${PORT}`,
    'null',
    'garbage',
  ])('rejects Origin %j with 403 even with a valid cookie', async (origin) => {
    for (const [method, url] of [
      ['GET', '/api/_probe'],
      ['POST', '/api/_probe'],
      ['GET', '/hub'],
      ['GET', '/'],
    ] as const) {
      const response = await request({ method, url, headers: authed({ origin }) });
      expect(response.statusCode, `${method} ${url} Origin=${origin}`).toBe(403);
      expect(response.json()).toEqual({ error: 'forbidden-origin' });
    }
  });

  it.each([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`])('accepts the service origin %j', async (origin) => {
    const response = await request({ method: 'POST', url: '/api/_probe', headers: authed({ origin }) });
    expect(response.statusCode).toBe(200);
  });

  it('unit: isAllowedHost / isAllowedOrigin', () => {
    expect(isAllowedHost(undefined, PORT)).toBe(false);
    expect(isAllowedHost('localhost', 80)).toBe(true);
    expect(isAllowedHost('localhost', PORT)).toBe(false);
    expect(isAllowedOrigin(`http://127.0.0.1:${PORT}/`, PORT)).toBe(true);
    expect(isAllowedOrigin(`http://user@127.0.0.1:${PORT}`, PORT)).toBe(false);
  });
});

describe('sb_token cookie on /api and /hub', () => {
  it.each([
    ['GET', '/api/_probe'],
    ['POST', '/api/_probe'],
    ['GET', '/api/sessions'],
    ['GET', '/api'],
    ['GET', '/api/'],
    ['GET', '/api/_probe?x=1'],
    ['GET', '/hub'],
    ['GET', '/hub/'],
    ['GET', '/hub?x=1'],
    ['GET', '/api/_public-attempt'],
    ['POST', '/'],
    ['DELETE', '/whatever'],
  ] as const)('%s %s without the cookie → 401', async (method, url) => {
    const response = await request({ method, url });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  });

  it.each([
    ['wrong token', `sb_token=${generateToken()}`],
    ['wrong length', `sb_token=${token}x`],
    ['empty', 'sb_token='],
    ['other cookie name', `sb_token2=${token}`],
    ['name prefix', `xsb_token=${token}`],
  ])('rejects a %s cookie with 401', async (_label, cookie) => {
    const response = await request({ url: '/api/_probe', headers: { cookie } });
    expect(response.statusCode).toBe(401);
  });

  it('accepts the install token', async () => {
    for (const url of ['/api/_probe', '/api/_public-attempt']) {
      const response = await request({ url, headers: authed() });
      expect(response.statusCode, url).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    }
    expect((await request({ url: '/hub', headers: authed() })).statusCode).toBe(200);
  });

  it('accepts the token next to a stray cookie of the same name', async () => {
    const response = await request({ url: '/api/_probe', headers: { cookie: `sb_token=planted; other=1; sb_token=${token}` } });
    expect(response.statusCode).toBe(200);
  });

  it('answers an unknown /api route with 404 only after the cookie check', async () => {
    expect((await request({ url: '/api/unknown' })).statusCode).toBe(401);
    expect((await request({ url: '/api/unknown', headers: authed() })).statusCode).toBe(404);
  });

  it('unit: readCookieValues', () => {
    expect(readCookieValues('a=1; sb_token=x; b; sb_token="y"', 'sb_token')).toEqual(['x', 'y']);
    expect(readCookieValues(undefined, 'sb_token')).toEqual([]);
  });
});

describe('UI page load sets the cookie (gap #20)', () => {
  it.each(['none', 'same-origin'])('Sec-Fetch-Site: %s → HttpOnly, SameSite=Strict session cookie', async (site) => {
    const response = await request({ url: '/', headers: { 'sec-fetch-site': site } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toBe(INDEX_HTML);
    const header = setCookieOf(response);
    expect(header).toBe(`sb_token=${token}; Path=/; HttpOnly; SameSite=Strict`);
    const cookie = parseSetCookie(header!);
    expect(cookie.name).toBe('sb_token');
    expect(cookie.value).toBe(token);
    expect(cookie.attributes.has('httponly')).toBe(true);
    expect(cookie.attributes.get('samesite')).toBe('Strict');
    expect(cookie.attributes.get('path')).toBe('/');
    expect(cookie.attributes.has('domain')).toBe(false);
    expect(cookie.attributes.has('max-age')).toBe(false);
    expect(cookie.attributes.has('expires')).toBe(false);
  });

  it('the cookie from the page opens the API', async () => {
    const page = await request({ url: '/', headers: { 'sec-fetch-site': 'none' } });
    const cookie = setCookieOf(page)!.split(';')[0]!;
    expect((await request({ url: '/api/_probe', headers: { cookie } })).statusCode).toBe(200);
  });

  it.each([
    ['cross-site', 'cross-site'],
    ['same-site', 'same-site'],
    ['missing', undefined],
    ['unknown value', 'bogus'],
  ])('Sec-Fetch-Site %s → page served without a cookie', async (_label, site) => {
    const headers: Record<string, string> = site === undefined ? {} : { 'sec-fetch-site': site };
    const response = await request({ url: '/', headers });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(INDEX_HTML);
    expect(setCookieOf(response)).toBeUndefined();
  });

  it('client-side routes serve index.html and set the cookie', async () => {
    for (const url of ['/inbox', '/sessions/abc-123', '/settings/claude?tab=1', '/index.html']) {
      const response = await request({ url, headers: { 'sec-fetch-site': 'same-origin' } });
      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).toBe(INDEX_HTML);
      expect(setCookieOf(response), url).toBe(`sb_token=${token}; Path=/; HttpOnly; SameSite=Strict`);
    }
  });

  it('static files are public but never set the cookie', async () => {
    const response = await request({ url: '/assets/app.js', headers: { 'sec-fetch-site': 'none' } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(ASSET_JS);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(setCookieOf(response)).toBeUndefined();
    expect((await request({ url: '/assets/missing.js' })).statusCode).toBe(404);
  });

  it.each(['/..%2fsecret.txt', '/assets/..%2f..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt'])(
    'does not serve files outside the web root: %s',
    async (url) => {
      const response = await request({ url });
      expect(response.statusCode).not.toBe(200);
      expect(response.body).not.toContain(OUTSIDE_SECRET);
    },
  );

  it('serves a placeholder page (and the cookie) when the UI is not built', async () => {
    const unbuilt = await buildApp({ config, token, webRoot: path.join(tmp, 'not-built') });
    try {
      const response = await unbuilt.inject({ url: '/', headers: { host: HOST, 'sec-fetch-site': 'none' } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(UNBUILT_PAGE);
      expect(setCookieOf(response)).toBe(`sb_token=${token}; Path=/; HttpOnly; SameSite=Strict`);
    } finally {
      await unbuilt.close();
    }
  });
});
