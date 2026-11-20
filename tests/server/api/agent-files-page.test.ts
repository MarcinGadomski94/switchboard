import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pageMetaTag, pagePolicy } from '../../../src/server/agent-files/page.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * SPIKE · side panel Files: an HTML file served as a page (`GET …/files/page`) and
 * what it is shown with (`GET …/files/page/info`): the headers that close it off,
 * scripts only when asked for, and the refusals.
 */

const PORT = 4917; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

let tmp: string;
let store: Store;
let app: FastifyInstance;
let token: string;
let session: string;

async function get(url: string) {
  const response = await app.inject({ method: 'GET', url, headers: { host: HOST, cookie: `sb_token=${token}` } });
  return { status: response.statusCode, headers: response.headers, text: response.body, json: () => response.json() as unknown };
}

/** The page a frame document carries, and whether it lets the page's scripts run. */
function carried(frame: string): { readonly scripts: string | undefined; readonly html: string } {
  const block = /<script type="application\/json" id="page" data-scripts="([01])">([^<]*)<\/script>/.exec(frame);
  return { scripts: block?.[1], html: JSON.parse(block?.[2] ?? '""') as string };
}

beforeAll(async () => {
  tmp = await makeTempDir('api-agent-files-page');
  const work = path.join(tmp, 'work');
  await mkdir(path.join(work, 'site'), { recursive: true });
  await writeFile(path.join(work, 'site', 'styles.css'), 'h1 { color: teal; }\n');
  await writeFile(path.join(work, 'site', 'app.js'), 'document.title = "Acme";\n');
  await writeFile(path.join(work, 'site', 'index.html'), '<!doctype html>\n<link rel="stylesheet" href="styles.css">\n<h1>Acme</h1>\n<script src="app.js"></script>\n<script src="https://cdn.example.com/lib.js"></script>\n');
  await writeFile(path.join(work, 'README.md'), '# Acme\n');
  await writeFile(path.join(tmp, 'elsewhere.html'), '<!doctype html><p>not for this agent</p>');
  store = await openTempStore(tmp);
  token = generateToken();
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT };
  app = await buildApp({ config, token, store, webRoot: tmp, bus: new HubBus() });
  await app.ready();
  session = (await store.sessions.create({ name: 'acme-site', claudeSessionId: '00000000-0000-4000-8000-000000000011', root: work, cwd: work })).id;
});

afterAll(async () => {
  await app?.close();
  await store?.close();
  await removeTempDir(tmp);
});

describe('an HTML file as a page', () => {
  const page = (query: string): string => `/api/sessions/${session}/files/page?path=${encodeURIComponent('site/index.html')}${query}`;

  it('is served as a page that is closed off, without its scripts: sandboxed, nothing fetched, framed by this app only', async () => {
    const answer = await get(page(''));
    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(answer.headers['content-security-policy']).toBe(pagePolicy(false).header);
    expect(answer.headers['x-content-type-options']).toBe('nosniff');
    expect(answer.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(answer.headers['referrer-policy']).toBe('no-referrer');
    expect(answer.headers['cache-control']).toBe('no-store');
    // The page stands in the frame document as data: with its rules and its stylesheet in it, its scripts as they were written.
    const { scripts, html } = carried(answer.text);
    expect(scripts).toBe('0');
    expect(html.startsWith(`<!doctype html>${pageMetaTag(false)}`)).toBe(true);
    const css = /<link rel="stylesheet" href="data:text\/css;charset=utf-8;base64,([^"]+)">/.exec(html);
    expect(Buffer.from(css?.[1] ?? '', 'base64').toString('utf8')).toBe('h1 { color: teal; }\n');
    expect(html).toContain('<h1>Acme</h1>');
    expect(html).toContain('<script src="app.js"></script>');
    expect(html).toContain('<script src="https://cdn.example.com/lib.js"></script>');
  });

  it('lets its scripts run only when that is asked for, under the rules for that', async () => {
    const answer = await get(page('&scripts=1'));
    expect(answer.headers['content-security-policy']).toBe(pagePolicy(true).header);
    expect(pagePolicy(true).header).not.toBe(pagePolicy(false).header);
    const { scripts, html } = carried(answer.text);
    expect(scripts).toBe('1');
    expect(html.startsWith(`<!doctype html>${pageMetaTag(true)}`)).toBe(true);
    const js = /<script src="data:text\/javascript;charset=utf-8;base64,([^"]+)"><\/script>/.exec(html);
    expect(Buffer.from(js?.[1] ?? '', 'base64').toString('utf8')).toBe('document.title = "Acme";\n');
    // Anything but `1` is not asking.
    expect((await get(page('&scripts=true'))).headers['content-security-policy']).toBe(pagePolicy(false).header);
  });

  it('says what the page is shown with and what was left out', async () => {
    const info = (query: string) => get(`/api/sessions/${session}/files/page/info?path=${encodeURIComponent('site/index.html')}${query}`);
    const off = await info('');
    expect(off.status).toBe(200);
    expect(off.json()).toEqual({ loaded: 1, left: [], leftMore: 0, scripted: true });
    expect((await info('&scripts=1')).json()).toEqual({ loaded: 2, left: [{ ref: 'https://cdn.example.com/lib.js', why: 'remote' }], leftMore: 0, scripted: true });
  });

  it("refuses what is not an HTML file, a file outside the agent's folders, a missing file and an unknown agent", async () => {
    for (const route of ['page', 'page/info']) {
      const notHtml = await get(`/api/sessions/${session}/files/${route}?path=README.md`);
      expect([notHtml.status, (notHtml.json() as { error: string }).error], route).toEqual([422, 'invalid']);
      const outside = await get(`/api/sessions/${session}/files/${route}?path=${encodeURIComponent(path.join(tmp, 'elsewhere.html'))}`);
      expect([outside.status, (outside.json() as { error: string }).error], route).toEqual([403, 'outside']);
      const missing = await get(`/api/sessions/${session}/files/${route}?path=site/none.html`);
      expect([missing.status, (missing.json() as { error: string }).error], route).toEqual([404, 'missing']);
      expect((await get(`/api/sessions/no-such-agent/files/${route}?path=site/index.html`)).status, route).toBe(404);
      // A refusal is never a page.
      expect(notHtml.headers['content-type']).toContain('application/json');
    }
  });

  it("stays behind this browser's sign-in like every route of the app (it is not one of the open ones)", async () => {
    const response = await app.inject({ method: 'GET', url: page('&scripts=1'), headers: { host: HOST } });
    expect(response.statusCode).toBe(401);
  });
});
