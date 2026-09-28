import http from 'node:http';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Tool } from '../../../src/core/api.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import type { Providers } from '../../../src/server/providers.ts';
import { FRAME_CHECK_PAGE } from '../../../src/server/api/tools.ts';
import { generateToken } from '../../../src/server/token.ts';
import { ToolProxies } from '../../../src/server/tools/proxies.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';
import { type ToolStub, htmlAnswer, startToolStub } from '../../helpers/tool-stub.ts';

/**
 * D15 through the API: `Tool.frameUrl` from the framing proxies
 * (`providers.toolFrames`), `PUT /api/tools` restarting a changed tool's proxy, and
 * the probe's `framing: "refused"` when a tool refuses framing and no proxy runs.
 */
const PORT = 4962; // inject() opens no socket; the port feeds the Host check and frame-ancestors only
const HOST = `127.0.0.1:${PORT}`;

let tmp: string | undefined;
let store: Store | undefined;
let app: FastifyInstance | undefined;
let proxies: ToolProxies | undefined;
let token = '';
const stubs: ToolStub[] = [];

afterEach(async () => {
  await app?.close();
  await proxies?.close();
  await store?.close();
  for (const stub of stubs.splice(0)) await stub.close();
  if (tmp) await removeTempDir(tmp);
  app = undefined;
  proxies = undefined;
  store = undefined;
  tmp = undefined;
});

/** The app with framing proxies (as main.ts wires them: synced with the saved tools first), or without; `extra` adds providers. */
async function setup(withProxies: boolean, extra: Providers = {}): Promise<void> {
  tmp = await makeTempDir('tool-frames');
  store = await openTempStore(tmp);
  token = generateToken();
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT };
  let providers: Providers = { ...extra };
  if (withProxies) {
    proxies = new ToolProxies({ switchboardPort: PORT });
    await proxies.sync(await store.tools.list());
    providers = { ...providers, toolFrames: proxies };
  }
  app = await buildApp({ config, token, store, webRoot: tmp, providers });
  await app.ready();
}

async function stub(...args: Parameters<typeof startToolStub>): Promise<ToolStub> {
  const started = await startToolStub(...args);
  stubs.push(started);
  return started;
}

function call(method: InjectOptions['method'], url: string, payload?: unknown, host = HOST) {
  if (!app) throw new Error('no app');
  return app.inject({
    method,
    url,
    headers: { host, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

/** GET `url` over a real socket (the proxy), with the cookies a browser would send. */
function fetchThrough(url: string, cookie: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers: { cookie }, agent: false }, (res) => {
        let body = '';
        res.setEncoding('utf8').on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      })
      .once('error', reject);
  });
}

describe('Tool.frameUrl (D15)', () => {
  it('every tool with a URL is framed through its proxy; PUT restarts a changed one; no URL = null', async () => {
    await setup(true);
    const before = (await call('GET', '/api/tools')).json() as Tool[];
    const cmProxy = proxies!.proxy('cm')!;
    // The default Codebase Memory URL gets a proxy at startup (nothing is fetched until the frame loads).
    expect(before.map((t) => [t.id, t.url, t.frameUrl])).toEqual([
      ['cm', 'http://localhost:13000', `http://127.0.0.1:${cmProxy.port}/`],
      ['sw', null, null],
    ]);
    // A page on localhost gets the proxy on localhost too (same site as the page).
    expect(((await call('GET', '/api/tools', undefined, `localhost:${PORT}`)).json() as Tool[])[0]?.frameUrl).toBe(`http://localhost:${cmProxy.port}/`);

    const tool = await stub(
      htmlAnswer('Codebase Memory stub', { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'x-frame-options': 'DENY' }),
    );
    const put = await call('PUT', '/api/tools', [
      { ...before[0], url: `${tool.origin}/graph?x=1` },
      { ...before[1], url: tool.origin },
    ]);
    expect(put.statusCode).toBe(200);
    const after = put.json() as Tool[];
    const cm = proxies!.proxy('cm')!;
    const sw = proxies!.proxy('sw')!;
    expect(cm).not.toBe(cmProxy); // the URL changed: restarted
    expect(after.map((t) => t.frameUrl)).toEqual([`http://127.0.0.1:${cm.port}/graph?x=1`, `http://127.0.0.1:${sw.port}/`]);
    expect((await call('GET', '/api/tools')).json()).toEqual(after);

    // Through the proxy: the tool's page, frameable by Switchboard only, sb_token never reaching the tool.
    const framed = await fetchThrough(after[0]!.frameUrl!, `sb_token=${token}; tool=1`);
    expect(framed.status).toBe(200);
    expect(framed.body).toContain('Codebase Memory stub');
    expect(framed.headers['x-frame-options']).toBeUndefined();
    expect(framed.headers['content-security-policy']).toBe(`default-src 'self'; frame-ancestors http://127.0.0.1:${PORT} http://localhost:${PORT}`);
    expect(tool.requests.at(-1)).toMatchObject({ url: '/graph?x=1' });
    expect(tool.requests.at(-1)!.headers.cookie).toBe('tool=1');

    // Unchanged URLs keep their proxy; a cleared URL loses it.
    const kept = await call('PUT', '/api/tools', [{ ...after[0], url: after[0]!.url }, { ...after[1], url: null }]);
    expect((kept.json() as Tool[]).map((t) => t.frameUrl)).toEqual([after[0]!.frameUrl, null]);
    expect(proxies!.proxy('cm')).toBe(cm);
    expect(proxies!.proxy('sw')).toBeNull();

    // A refused PUT changes nothing.
    expect((await call('PUT', '/api/tools', [{ name: '' }])).statusCode).toBe(422);
    expect(proxies!.proxy('cm')).toBe(cm);
  });

  it('without framing proxies (demo mode) every frameUrl is null', async () => {
    await setup(false);
    const tools = (await call('GET', '/api/tools')).json() as Tool[];
    expect(tools.map((t) => t.frameUrl)).toEqual([null, null]);
  });
});

describe('probe: framing "refused" only when the tool refuses framing and no proxy runs (D15)', () => {
  it('reported without a proxy for frame-ancestors / X-Frame-Options refusals; not for tools that allow Switchboard', async () => {
    await setup(false);
    const none = await stub(htmlAnswer('none', { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }));
    const deny = await stub(htmlAnswer('deny', { 'x-frame-options': 'DENY' }));
    const allowed = await stub(htmlAnswer('allowed', { 'content-security-policy': `frame-ancestors http://127.0.0.1:${PORT}`, 'x-frame-options': 'DENY' }));
    const plain = await stub(htmlAnswer('plain'));
    await call('PUT', '/api/tools', [
      { id: 'none', name: 'None', url: none.origin },
      { id: 'deny', name: 'Deny', url: deny.origin },
      { id: 'allowed', name: 'Allowed', url: allowed.origin },
      { id: 'plain', name: 'Plain', url: plain.origin },
    ]);
    expect((await call('POST', '/api/tools/none/probe')).json()).toEqual({ state: 'up', framing: 'refused' });
    expect((await call('POST', '/api/tools/deny/probe')).json()).toEqual({ state: 'up', framing: 'refused' });
    expect((await call('POST', '/api/tools/allowed/probe')).json()).toEqual({ state: 'up' });
    // The same answer, seen by a page on localhost: its origin is not listed, so it is refused.
    expect((await call('POST', '/api/tools/allowed/probe', undefined, `localhost:${PORT}`)).json()).toEqual({ state: 'up', framing: 'refused' });
    expect((await call('POST', '/api/tools/plain/probe')).json()).toEqual({ state: 'up' });
    await none.close();
    stubs.splice(stubs.indexOf(none), 1);
    expect((await call('POST', '/api/tools/none/probe')).json()).toEqual({ state: 'down' });
  });

  it('not reported while the proxy frames the tool', async () => {
    await setup(true);
    const none = await stub(htmlAnswer('none', { 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY' }));
    await call('PUT', '/api/tools', [{ id: 'none', name: 'None', url: none.origin }]);
    expect((await call('POST', '/api/tools/none/probe')).json()).toEqual({ state: 'up' });
  });
});

describe('signed-in sites (D28, docs/frame-helper.md)', () => {
  const JIRA = 'https://acme.atlassian.net/jira/software/c/projects/PROJ/boards/1';

  it('a site tool gets no framing proxy (frameUrl null); the probe stays as it is, refusal included', async () => {
    const probed: string[] = [];
    await setup(true, {
      toolProbe: {
        probe: async (url) => {
          probed.push(url);
          // What the real Jira board answers: up, framed only by Atlassian's own sites.
          return { state: 'up', framing: { xFrameOptions: null, csp: ["frame-ancestors 'self' *.atlassian.net *.jira.com trello.com"] } };
        },
      },
    });
    const put = await call('PUT', '/api/tools', [{ id: 'jira', name: 'Jira', url: JIRA }]);
    expect(put.statusCode).toBe(200);
    expect((put.json() as Tool[]).map((t) => [t.id, t.url, t.frameUrl])).toEqual([['jira', JIRA, null]]);
    expect(proxies!.proxy('jira')).toBeNull();
    expect(probed).toEqual([]); // saving a site fetches nothing
    expect((await call('POST', '/api/tools/jira/probe')).json()).toEqual({ state: 'up', framing: 'refused' });
    expect(probed).toEqual([JIRA]);
  });

  it('GET /api/frame-helper/check: a page that refuses every frame, behind the cookie guard', async () => {
    await setup(false);
    const check = await call('GET', '/api/frame-helper/check');
    expect(check.statusCode).toBe(200);
    expect(check.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(check.headers['x-frame-options']).toBe('DENY');
    expect(check.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(check.headers['cache-control']).toBe('no-store');
    expect(check.body).toBe(FRAME_CHECK_PAGE);
    expect(check.body).toContain('<html data-sb-frame-check="ok">');
    expect((await app!.inject({ method: 'GET', url: '/api/frame-helper/check', headers: { host: HOST } })).statusCode).toBe(401);
  });
});
