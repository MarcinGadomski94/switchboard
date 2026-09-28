import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { switchboardOrigins } from '../../../src/server/tools/framing.ts';
import { ToolProxies } from '../../../src/server/tools/proxies.ts';
import { type ToolProxy, proxiedResponseHeaders, rewriteLocation, rewriteOriginHeader, startToolProxy, stripTokenCookie } from '../../../src/server/tools/proxy.ts';
import { type ToolStub, htmlAnswer, startToolStub } from '../../helpers/tool-stub.ts';

/**
 * D15: the embedded tools' framing proxy (src/server/tools/proxy.ts) and its
 * manager (proxies.ts), against stub tools on OS-assigned loopback ports.
 */

const SWITCHBOARD_PORT = 4961; // only named in frame-ancestors; nothing listens on it here
const FRAME_ORIGINS = switchboardOrigins(SWITCHBOARD_PORT);
const FRAME_ANCESTORS = `frame-ancestors http://127.0.0.1:${SWITCHBOARD_PORT} http://localhost:${SWITCHBOARD_PORT}`;

const stubs: ToolStub[] = [];
const proxies: ToolProxy[] = [];
const managers: ToolProxies[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  for (const proxy of proxies.splice(0)) await proxy.close();
  for (const stub of stubs.splice(0)) await stub.close();
});

async function stub(...args: Parameters<typeof startToolStub>): Promise<ToolStub> {
  const started = await startToolStub(...args);
  stubs.push(started);
  return started;
}

async function proxyFor(target: string): Promise<ToolProxy> {
  const proxy = await startToolProxy({ target, frameOrigins: FRAME_ORIGINS });
  proxies.push(proxy);
  return proxy;
}

function manager(options: Partial<ConstructorParameters<typeof ToolProxies>[0]> = {}): ToolProxies {
  const created = new ToolProxies({ switchboardPort: SWITCHBOARD_PORT, ...options });
  managers.push(created);
  return created;
}

interface Answer {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly rawHeaders: string[];
  readonly body: string;
}

/** One request over a fresh socket to 127.0.0.1:`port`, with full control of `Host` and the body. */
function send(port: number, options: { path?: string; method?: string; host?: string | null; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.host !== null) headers['host'] = options.host ?? `127.0.0.1:${port}`;
    const req = http.request(
      { host: '127.0.0.1', port, path: options.path ?? '/', method: options.method ?? 'GET', headers, setHost: false, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.once('error', reject);
    req.end(options.body);
  });
}

/** Resolves with `true` when a TCP connection to 127.0.0.1:`port` is refused. */
function refused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

/** Every value of header `name` in a raw header list. */
function all(rawHeaders: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) if (rawHeaders[i]!.toLowerCase() === name) values.push(rawHeaders[i + 1]!);
  return values;
}

describe('the framing proxy · Origin / Referer (D15 amendment 2026-09-28)', () => {
  it('a tool that refuses foreign Origins (like Codebase Memory) serves its own module scripts through the proxy', async () => {
    // The stub answers 403 to any Origin but its own, as the real Codebase Memory UI does.
    const tool = await stub((req, res) => {
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== toolOrigin) {
        res.writeHead(403).end('forbidden origin');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/javascript' }).end('export {};');
    });
    const toolOrigin = tool.origin;
    const proxy = await proxyFor(`${tool.origin}/`);
    const proxyOrigin = `http://127.0.0.1:${proxy.port}`;

    const own = await send(proxy.port, { path: '/assets/index.js', headers: { origin: proxyOrigin, referer: `${proxyOrigin}/index.html` } });
    expect(own.status).toBe(200);
    expect(tool.requests.at(-1)?.headers).toMatchObject({ origin: tool.origin, referer: `${tool.origin}/index.html` });

    // Any other Origin passes unchanged (and this tool refuses it).
    const foreign = await send(proxy.port, { path: '/assets/index.js', headers: { origin: 'http://evil.example' } });
    expect(foreign.status).toBe(403);
    expect(tool.requests.at(-1)?.headers.origin).toBe('http://evil.example');
  });

  it('rewriteOriginHeader: only values naming the proxy change', () => {
    const target = new URL('http://localhost:13000/');
    const proxy = 'http://127.0.0.1:57428';
    expect(rewriteOriginHeader('origin', proxy, proxy, target)).toBe('http://localhost:13000');
    expect(rewriteOriginHeader('origin', 'null', proxy, target)).toBe('null');
    expect(rewriteOriginHeader('origin', 'http://127.0.0.1:4870', proxy, target)).toBe('http://127.0.0.1:4870');
    expect(rewriteOriginHeader('referer', `${proxy}/graph?x=1`, proxy, target)).toBe('http://localhost:13000/graph?x=1');
    expect(rewriteOriginHeader('referer', 'http://127.0.0.1:574281/x', proxy, target)).toBe('http://127.0.0.1:574281/x');
    expect(rewriteOriginHeader('referer', undefined, proxy, target)).toBeUndefined();
  });
});

describe('the framing proxy (D15)', () => {
  it('forwards method, path and query to the tool, with the tool as Host; frame-ancestors replaced, X-Frame-Options dropped', async () => {
    const tool = await stub(
      htmlAnswer('Codebase Memory stub', {
        'content-security-policy': "default-src 'self'; frame-ancestors 'none'; img-src data:",
        'x-frame-options': 'DENY',
        'x-tool': 'kept',
        'set-cookie': ['a=1; Path=/', 'b=2; Path=/'],
      }),
    );
    const proxy = await proxyFor(`${tool.origin}/ui/?tab=graph`);
    expect(proxy.frameUrl()).toBe(`http://127.0.0.1:${proxy.port}/ui/?tab=graph`);
    expect(proxy.frameUrl('localhost')).toBe(`http://localhost:${proxy.port}/ui/?tab=graph`);
    expect(proxy.port).not.toBe(tool.port);

    const answer = await send(proxy.port, { path: '/ui/?tab=graph&q=a%20b', headers: { accept: 'text/html', 'x-custom': 'yes' } });
    expect(answer.status).toBe(200);
    expect(answer.body).toContain('Codebase Memory stub');
    expect(answer.headers['x-frame-options']).toBeUndefined();
    expect(all(answer.rawHeaders, 'content-security-policy')).toEqual([`default-src 'self'; ${FRAME_ANCESTORS}; img-src data:`]);
    expect(answer.headers['x-tool']).toBe('kept');
    expect(all(answer.rawHeaders, 'set-cookie')).toEqual(['a=1; Path=/', 'b=2; Path=/']);

    expect(tool.requests).toHaveLength(1);
    expect(tool.requests[0]).toMatchObject({ method: 'GET', url: '/ui/?tab=graph&q=a%20b' });
    expect(tool.requests[0]!.headers).toMatchObject({ host: `127.0.0.1:${tool.port}`, accept: 'text/html', 'x-custom': 'yes' });
  });

  it('adds a frame-ancestors-only CSP when the tool sends none, and rewrites each policy of every CSP header', async () => {
    const plain = await stub(htmlAnswer('plain'));
    const plainProxy = await proxyFor(plain.origin);
    const answer = await send(plainProxy.port);
    expect(all(answer.rawHeaders, 'content-security-policy')).toEqual([FRAME_ANCESTORS]);

    const many = await stub((_req, res) => {
      res.setHeader('content-security-policy', ["script-src 'self', frame-ancestors 'self'; frame-ancestors 'none'", "object-src 'none'"]);
      res.end('ok');
    });
    const manyProxy = await proxyFor(many.origin);
    const rewritten = all((await send(manyProxy.port)).rawHeaders, 'content-security-policy');
    expect(rewritten).toEqual([`script-src 'self'; ${FRAME_ANCESTORS}, ${FRAME_ANCESTORS}`, `object-src 'none'; ${FRAME_ANCESTORS}`]);
  });

  it('streams a POST body both ways and passes the status through', async () => {
    const tool = await stub((req, res, body) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, type: req.headers['content-type'], length: body.length, head: body.slice(0, 12) }));
    });
    const proxy = await proxyFor(tool.origin);
    const big = `payload:${'x'.repeat(1_000_000)}`;
    const answer = await send(proxy.port, { method: 'POST', path: '/api/query?limit=5', headers: { 'content-type': 'text/plain', 'content-length': String(big.length) }, body: big });
    expect(answer.status).toBe(201);
    expect(JSON.parse(answer.body)).toEqual({ method: 'POST', type: 'text/plain', length: big.length, head: 'payload:xxxx' });
    expect(tool.requests[0]).toMatchObject({ method: 'POST', url: '/api/query?limit=5' });

    // A chunked request body (no Content-Length) arrives whole too.
    const chunked = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'PUT', path: '/x', agent: false }, (res) => {
        let text = '';
        res.setEncoding('utf8').on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve(text));
      });
      req.once('error', reject);
      req.write('part one, ');
      setTimeout(() => req.end('part two'), 20);
    });
    expect(JSON.parse(chunked)).toMatchObject({ method: 'PUT', length: 'part one, part two'.length });
    expect(tool.requests[1]?.body).toBe('part one, part two');
  });

  it('rewrites a Location at the tool to the proxy (the host name the page used); other Locations stay', async () => {
    const tool = await stub((req, res) => {
      const where: Record<string, string> = {
        '/abs': `http://127.0.0.1:${(req.socket.address() as net.AddressInfo).port}/next?x=1#top`,
        '/rel': '/next',
        '/away': 'https://example.com/elsewhere',
      };
      res.writeHead(302, { location: where[req.url ?? ''] ?? '/' });
      res.end();
    });
    const proxy = await proxyFor(`${tool.origin}/`);
    expect((await send(proxy.port, { path: '/abs' })).headers.location).toBe(`http://127.0.0.1:${proxy.port}/next?x=1#top`);
    expect((await send(proxy.port, { path: '/abs', host: `localhost:${proxy.port}` })).headers.location).toBe(`http://localhost:${proxy.port}/next?x=1#top`);
    expect((await send(proxy.port, { path: '/rel' })).headers.location).toBe('/next');
    expect((await send(proxy.port, { path: '/away' })).headers.location).toBe('https://example.com/elsewhere');
    // Redirects are passed on, never followed by the proxy.
    expect(tool.requests.map((r) => r.url)).toEqual(['/abs', '/abs', '/rel', '/away']);
  });

  it("strips Switchboard's sb_token from the forwarded Cookie and keeps the tool's own cookies", async () => {
    const tool = await stub(htmlAnswer('ok'));
    const proxy = await proxyFor(tool.origin);
    await send(proxy.port, { headers: { cookie: 'theme=dark; sb_token=secret-token; session=abc' } });
    await send(proxy.port, { headers: { cookie: 'sb_token=secret-token' } });
    await send(proxy.port, { headers: { cookie: 'sb_token="quoted"; sb_token=second' } });
    expect(tool.requests.map((r) => r.headers.cookie)).toEqual(['theme=dark; session=abc', undefined, undefined]);
    expect(JSON.stringify(tool.requests)).not.toContain('secret-token');
  });

  it('refuses a foreign Host (DNS rebinding) or a non-path target without contacting the tool', async () => {
    const tool = await stub(htmlAnswer('ok'));
    const proxy = await proxyFor(tool.origin);
    for (const host of ['evil.example', `evil.example:${proxy.port}`, `127.0.0.1:${tool.port}`, `localhost:${SWITCHBOARD_PORT}`, `192.168.1.2:${proxy.port}`]) {
      const answer = await send(proxy.port, { host });
      expect(answer.status, host).toBe(403);
      expect(answer.body.trim(), host).toBe('forbidden host');
    }
    // No Host at all: Node's own HTTP/1.1 check (400) or the proxy's (403); either way the tool sees nothing.
    expect([400, 403]).toContain((await send(proxy.port, { host: null })).status);
    expect((await send(proxy.port, { path: 'http://evil.example/steal' })).status).toBe(400);
    expect(tool.requests).toEqual([]);
    // Its own names pass.
    expect((await send(proxy.port, { host: `LOCALHOST:${proxy.port}` })).status).toBe(200);
  });

  it('answers 502 with a short text when the tool is down', async () => {
    const gone = await stub(htmlAnswer('soon gone'));
    const port = gone.port;
    await gone.close();
    stubs.splice(stubs.indexOf(gone), 1);
    const proxy = await proxyFor(`http://127.0.0.1:${port}/`);
    const answer = await send(proxy.port);
    expect(answer.status).toBe(502);
    expect(answer.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(answer.body.trim()).toBe(`Switchboard's tool proxy could not reach 127.0.0.1:${port} (ECONNREFUSED)`);
  });

  it('proxies WebSocket upgrades (echo), with the tool as Host and without sb_token', async () => {
    const tool = await stub(htmlAnswer('ws'), { webSocketEcho: true });
    const proxy = await proxyFor(tool.origin);
    const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/live?room=1`);
    const messages: string[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('websocket error')));
    });
    const got = new Promise<void>((resolve) => {
      socket.addEventListener('message', (event) => {
        messages.push(String(event.data));
        if (messages.length === 2) resolve();
      });
    });
    socket.send('hello');
    socket.send('x'.repeat(300));
    await got;
    expect(messages).toEqual(['echo: hello', `echo: ${'x'.repeat(300)}`]);
    const closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve()));
    socket.close();
    await closed;
    expect(tool.requests[0]).toMatchObject({ method: 'GET', url: '/live?room=1' });
    expect(tool.requests[0]!.headers).toMatchObject({ host: `127.0.0.1:${tool.port}`, upgrade: 'websocket' });

    // A raw upgrade: sb_token stripped, a foreign Host refused before the tool sees it.
    const upgrade = (host: string): Promise<string> =>
      new Promise((resolve) => {
        const raw = net.connect({ host: '127.0.0.1', port: proxy.port }, () => {
          raw.write(
            `GET /raw HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: sb_token=secret; keep=1\r\n\r\n`,
          );
        });
        let text = '';
        raw.setEncoding('utf8').on('data', (chunk: string) => {
          text += chunk;
          if (text.includes('\r\n\r\n')) {
            raw.destroy();
            resolve(text.split('\r\n')[0]!);
          }
        });
      });
    expect(await upgrade(`127.0.0.1:${proxy.port}`)).toBe('HTTP/1.1 101 Switching Protocols');
    expect(tool.requests[1]!.headers.cookie).toBe('keep=1');
    expect(await upgrade(`attacker.example:${proxy.port}`)).toBe('HTTP/1.1 403 Forbidden');
    expect(tool.requests).toHaveLength(2);
  });

  it('listens on 127.0.0.1 only; close() stops it and ends open connections', async () => {
    const tool = await stub(htmlAnswer('ok'), { webSocketEcho: true });
    const proxy = await proxyFor(tool.origin);
    const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/`);
    await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
    const closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve()));
    await proxy.close();
    await closed;
    expect(await refused(proxy.port)).toBe(true);
    await proxy.close(); // twice is fine
  });

  it('refuses a non-http(s) URL', async () => {
    await expect(startToolProxy({ target: 'file:///etc/passwd', frameOrigins: FRAME_ORIGINS })).rejects.toThrow(/http/);
  });

  it('helpers: cookie stripping, Location rewrite, response headers', () => {
    expect(stripTokenCookie(undefined)).toBeUndefined();
    expect(stripTokenCookie('a=1;sb_token=x ;b=2')).toBe('a=1; b=2');
    expect(stripTokenCookie('sb_token')).toBeUndefined();
    expect(stripTokenCookie('sb_token_other=1')).toBe('sb_token_other=1');
    const target = new URL('http://localhost:13000/');
    expect(rewriteLocation('http://LOCALHOST:13000/a?b#c', target, 'http://127.0.0.1:5555')).toBe('http://127.0.0.1:5555/a?b#c');
    expect(rewriteLocation('//localhost:13000/a', target, 'http://127.0.0.1:5555')).toBe('http://127.0.0.1:5555/a');
    expect(rewriteLocation('http://localhost:13001/a', target, 'http://127.0.0.1:5555')).toBe('http://localhost:13001/a');
    expect(rewriteLocation('a/b', target, 'http://127.0.0.1:5555')).toBe('a/b');
    expect(
      proxiedResponseHeaders(
        ['Connection', 'keep-alive, X-Hop', 'X-Hop', '1', 'Keep-Alive', 'timeout=5', 'Transfer-Encoding', 'chunked', 'X-Frame-Options', 'SAMEORIGIN', 'Location', 'http://localhost:13000/x', 'X-Other', 'y'],
        target,
        'http://127.0.0.1:5555',
        ['http://127.0.0.1:4870'],
      ),
    ).toEqual(['Location', 'http://127.0.0.1:5555/x', 'X-Other', 'y', 'Content-Security-Policy', 'frame-ancestors http://127.0.0.1:4870']);
  });
});

describe('ToolProxies: one proxy per tool with a URL (D15)', () => {
  it('starts proxies for tools with URLs, keeps them while the URL stays, restarts on a URL change, stops removed ones', async () => {
    const first = await stub(htmlAnswer('first'));
    const second = await stub(htmlAnswer('second'));
    const proxies = manager();
    await proxies.sync([
      { id: 'cm', url: `${first.origin}/` },
      { id: 'sw', url: null },
    ]);
    const cm = proxies.proxy('cm');
    expect(cm).not.toBeNull();
    expect(proxies.frameUrl('cm')).toBe(`http://127.0.0.1:${cm!.port}/`);
    expect(proxies.frameUrl('cm', 'localhost')).toBe(`http://localhost:${cm!.port}/`);
    expect(proxies.frameUrl('sw')).toBeNull();
    expect(proxies.frameUrl('nope')).toBeNull();
    expect((await send(cm!.port)).body).toContain('first');

    // Same URL: the same proxy (and port).
    await proxies.sync([{ id: 'cm', url: `${first.origin}/` }]);
    expect(proxies.proxy('cm')).toBe(cm);

    // A changed URL restarts it: the old port closes, the new one forwards to the new tool.
    await proxies.sync([{ id: 'cm', url: `${second.origin}/` }]);
    const restarted = proxies.proxy('cm');
    expect(restarted).not.toBe(cm);
    expect(await refused(cm!.port)).toBe(true);
    expect((await send(restarted!.port)).body).toContain('second');

    // Removed (or cleared) tools lose their proxy.
    await proxies.sync([{ id: 'cm', url: null }]);
    expect(proxies.frameUrl('cm')).toBeNull();
    expect(await refused(restarted!.port)).toBe(true);
  });

  it('close() stops every proxy and later syncs do nothing', async () => {
    const tool = await stub(htmlAnswer('ok'));
    const proxies = manager();
    await proxies.sync([
      { id: 'a', url: tool.origin },
      { id: 'b', url: `${tool.origin}/b` },
    ]);
    const ports = [proxies.proxy('a')!.port, proxies.proxy('b')!.port];
    await proxies.close();
    for (const port of ports) expect(await refused(port)).toBe(true);
    await proxies.sync([{ id: 'a', url: tool.origin }]);
    expect(proxies.frameUrl('a')).toBeNull();
  });

  it('overlapping syncs run one at a time; a proxy that cannot start is reported and left out', async () => {
    const tool = await stub(htmlAnswer('ok'));
    const errors: Array<[string, string]> = [];
    const proxies = manager({
      start: async (options) => {
        if (options.target.includes('/broken')) throw new Error('no port for you');
        return startToolProxy(options);
      },
      onError: (error, id) => errors.push([id, (error as Error).message]),
    });
    await Promise.all([
      proxies.sync([{ id: 'a', url: tool.origin }]),
      proxies.sync([
        { id: 'a', url: tool.origin },
        { id: 'broken', url: `${tool.origin}/broken` },
      ]),
    ]);
    expect(proxies.frameUrl('a')).not.toBeNull();
    expect(proxies.frameUrl('broken')).toBeNull();
    expect(errors).toEqual([['broken', 'no port for you']]);
  });
});
