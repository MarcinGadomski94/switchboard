import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.ts';
import { type ServerConfig, loadConfig } from '../../src/server/config.ts';
import type { Store } from '../../src/server/db/store.ts';
import { generateToken } from '../../src/server/token.ts';
import { APP_FILES, APP_ICONS_PREFIX } from '../../src/server/web.ts';
import { REPO_ROOT, makeTempDir, removeTempDir } from '../helpers/net.ts';
import { pngSize } from '../helpers/png.ts';
import { openTempStore } from '../helpers/store.ts';

/**
 * D34 (docs/install-app.md, docs/security.md): the installable-app files are served
 * without the `sb_token` cookie, with fixed content types, behind the Host/Origin
 * guard, and they never set the cookie. The web root is `src/web/public`, which Vite
 * copies into the build as-is, so these are the real files.
 */
const PORT = 4871; // inject() opens no socket; the port only feeds the Host/Origin checks
const HOST = `127.0.0.1:${PORT}`;
const PUBLIC_DIR = path.join(REPO_ROOT, 'src', 'web', 'public');

let tmp: string;
let token: string;
let config: ServerConfig;
let store: Store;
let app: FastifyInstance;

function get(url: string, headers: Record<string, string> = {}, target: FastifyInstance = app) {
  const options: InjectOptions = { method: 'GET', url, headers: { host: HOST, ...headers } };
  return target.inject(options);
}

interface ManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose?: string;
}

beforeAll(async () => {
  tmp = await makeTempDir('app-files');
  token = generateToken();
  config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT };
  store = await openTempStore(tmp);
  app = await buildApp({ config, token, store, webRoot: PUBLIC_DIR });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await store?.close();
  await removeTempDir(tmp);
});

describe('installable-app files without the cookie', () => {
  it.each([
    ['/manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
    ['/sw.js', 'text/javascript; charset=utf-8'],
    ['/offline.html', 'text/html; charset=utf-8'],
  ])('%s: 200, %s, no-cache, never a cookie, the file as built', async (url, type) => {
    // A cookieless fetch with the browser's own page-load headers still gets no cookie back.
    const response = await get(url, { 'sec-fetch-site': 'none' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe(type);
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.body).toBe(await readFile(path.join(PUBLIC_DIR, url.slice(1)), 'utf8'));
  });

  it('APP_FILES is exactly the manifest, the worker and the offline page', () => {
    expect(APP_FILES.map((file) => file.path)).toEqual(['/manifest.webmanifest', '/sw.js', '/offline.html']);
    expect(APP_ICONS_PREFIX).toBe('/icons/');
  });

  it.each([
    ['/icons/icon-192.png', 'image/png'],
    ['/icons/icon-512.png', 'image/png'],
    ['/icons/icon-maskable-512.png', 'image/png'],
    ['/icons/apple-touch-icon.png', 'image/png'],
    ['/icons/favicon-32.png', 'image/png'],
    ['/icons/icon.svg', 'image/svg+xml'],
    ['/icons/favicon.svg', 'image/svg+xml'],
  ])('%s: 200 %s without the cookie', async (url, type) => {
    const response = await get(url);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe(type);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('a missing icon is a 404, not the UI page', async () => {
    const response = await get('/icons/nope.png');
    expect(response.statusCode).toBe(404);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('an unbuilt UI answers 404 for them (no placeholder page, no cookie)', async () => {
    const unbuilt = await buildApp({ config, token, store, webRoot: path.join(tmp, 'not-built') });
    try {
      for (const url of ['/manifest.webmanifest', '/sw.js', '/offline.html', '/icons/icon-192.png']) {
        const response = await get(url, { 'sec-fetch-site': 'none' }, unbuilt);
        expect(response.statusCode, url).toBe(404);
        expect(response.headers['set-cookie'], url).toBeUndefined();
      }
    } finally {
      await unbuilt.close();
    }
  });

  it('the API and /hub still need the cookie', async () => {
    for (const url of ['/api/sessions', '/hub']) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(401);
      expect(response.json()).toEqual({ error: 'unauthorized' });
    }
  });
});

describe('the Host/Origin guard still applies', () => {
  const urls = ['/manifest.webmanifest', '/sw.js', '/offline.html', '/icons/icon-192.png', '/icons/icon.svg'];

  it.each(['evil.example', `evil.example:${PORT}`, '127.0.0.1:4870', `localhost:${PORT + 1}`, `192.168.1.10:${PORT}`])('Host %j → 403', async (host) => {
    for (const url of urls) {
      const response = await get(url, { host });
      expect(response.statusCode, `${url} Host=${host}`).toBe(403);
      expect(response.json()).toEqual({ error: 'forbidden-host' });
    }
  });

  it.each(['http://evil.example', 'http://127.0.0.1:13000', 'null'])('Origin %j → 403', async (origin) => {
    for (const url of urls) {
      const response = await get(url, { origin });
      expect(response.statusCode, `${url} Origin=${origin}`).toBe(403);
      expect(response.json()).toEqual({ error: 'forbidden-origin' });
    }
  });

  it('the service origin passes (a manifest fetch is a CORS request with an Origin)', async () => {
    for (const origin of [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]) {
      expect((await get('/manifest.webmanifest', { origin })).statusCode).toBe(200);
    }
    expect((await get('/manifest.webmanifest', { host: `localhost:${PORT}` })).statusCode).toBe(200);
  });
});

describe('the served manifest', () => {
  it('is valid JSON with the D34 fields, and every icon it names is served at its size', async () => {
    const response = await get('/manifest.webmanifest');
    const manifest = JSON.parse(response.body) as Record<string, unknown> & { icons: ManifestIcon[] };
    expect(manifest).toMatchObject({ name: 'Switchboard', short_name: 'Switchboard', start_url: '/', scope: '/', display: 'standalone' });
    expect(manifest['description']).toEqual(expect.any(String));
    expect(manifest['background_color']).toMatch(/^#[0-9a-f]{6}$/);
    expect(manifest['theme_color']).toMatch(/^#[0-9a-f]{6}$/);
    expect(manifest.icons.length).toBeGreaterThanOrEqual(4);
    for (const icon of manifest.icons) {
      const served = await get(icon.src);
      expect(served.statusCode, icon.src).toBe(200);
      expect(served.headers['content-type'], icon.src).toBe(icon.type);
      if (icon.type === 'image/png') {
        const [width, height] = icon.sizes.split('x').map(Number);
        expect(pngSize(served.rawPayload), icon.src).toEqual({ width, height });
      } else {
        expect(icon.sizes).toBe('any');
      }
    }
  });
});
