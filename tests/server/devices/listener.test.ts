import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { DEVICE_CODE_TTL_MS } from '../../../src/core/devices.ts';
import { type DeviceWorld, deviceCookieOf, startDeviceWorld } from '../../helpers/devices.ts';

/**
 * D73 device listener (`docs/devices.md`, `docs/security.md` → *Device listener*):
 * one in-process app with its UI listener and its device listener on loopback test
 * ports; `tailscale` is the fake CLI.
 */

let world: DeviceWorld | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

const HTML = { accept: 'text/html,application/xhtml+xml' };

describe('D73 device listener: unpaired requests', () => {
  it('serves only the pairing page, its exchange and the app files; everything else is 401 or a redirect to /pair', async () => {
    world = await startDeviceWorld();
    const w = world;
    for (const [method, route] of [['GET', '/api/sessions'], ['GET', '/api/inbox'], ['POST', '/api/sessions'], ['GET', '/hub'], ['GET', '/api/device'], ['GET', '/api/settings'], ['GET', '/assets/app.js']] as const) {
      const answer = await w.device(method, route);
      expect(answer.status, `${method} ${route}`).toBe(401);
      expect(answer.body).toEqual({ error: 'unauthorized' });
    }
    // Page loads go to the pairing page.
    for (const route of ['/', '/sessions/abc', '/settings/devices']) {
      const answer = await w.device('GET', route, { headers: HTML });
      expect(answer.status, route).toBe(302);
      expect(answer.headers.location).toBe('/pair');
    }
    const page = await w.device('GET', '/pair', { headers: HTML });
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.headers['content-security-policy']).toMatch(/default-src 'none'; script-src 'nonce-[^']+'/);
    expect(page.text).toContain('Pair this device');
    expect(page.text).toContain('devbox');
    // No install token is ever handed out on the device listener.
    expect(page.headers['set-cookie']).toBeUndefined();
    expect(page.text).not.toContain(w.token);
    // The installable-app files are public (browsers fetch the manifest without credentials).
    expect((await w.device('GET', '/manifest.webmanifest')).status).toBe(200);
  });

  it('never applies loopback trust: the install token does not work there, Host must be the devices origin', async () => {
    world = await startDeviceWorld();
    const w = world;
    // The UI's own cookie is worthless on the device listener.
    const withToken = await w.device('GET', '/api/sessions', { cookie: `sb_token=${w.token}` });
    expect(withToken.status).toBe(401);
    const page = await w.device('GET', '/', { cookie: `sb_token=${w.token}`, headers: HTML });
    expect(page.status).toBe(302);
    // A loopback Host (what the UI listener accepts) is refused here …
    for (const host of [`127.0.0.1:${w.devicePort}`, `localhost:${w.uiPort}`, `127.0.0.1:${w.uiPort}`, 'evil.example', `localhost:${w.devicePort}.evil.example`]) {
      const answer = await w.device('GET', '/pair', { headers: { host } });
      expect(answer.status, host).toBe(403);
      expect(answer.body).toEqual({ error: 'forbidden-host' });
    }
    // … unless it is the listener itself and X-Forwarded-Host names the devices' origin (a proxy that rewrote Host).
    expect((await w.device('GET', '/pair', { headers: { host: `127.0.0.1:${w.devicePort}`, 'x-forwarded-host': `localhost:${w.devicePort}` } })).status).toBe(200);
    expect((await w.device('GET', '/pair', { headers: { host: `127.0.0.1:${w.devicePort}`, 'x-forwarded-host': 'evil.example' } })).status).toBe(403);
    // A foreign Origin is refused; the devices' own is fine.
    expect((await w.device('POST', '/device/v1/pair', { headers: { origin: 'https://evil.example' }, body: { code: 'AAAA-AAAA' } })).body).toEqual({ error: 'forbidden-origin' });
    expect((await w.device('POST', '/device/v1/pair', { headers: { origin: `http://127.0.0.1:${w.uiPort}` }, body: { code: 'AAAA-AAAA' } })).status).toBe(403);
    // The hook and agent endpoints never answer on the device listener.
    expect((await w.device('POST', '/hook/v1/event', { headers: { authorization: 'Bearer x' } })).body).toEqual({ error: 'forbidden' });
    expect((await w.device('GET', '/agent/v1/todos')).body).toEqual({ error: 'forbidden' });
  });

  it('leaves the UI listener as it was: cookie, loopback Host, and no device pages there', async () => {
    world = await startDeviceWorld();
    const w = world;
    expect((await w.ui('GET', '/api/sessions')).status).toBe(200);
    const anonymous = await (await import('../../helpers/devices.ts')).rawCall(w.uiPort, 'GET', '/api/sessions', { host: `127.0.0.1:${w.uiPort}` });
    expect(anonymous.status).toBe(401);
    // The device listener's Host is refused on the UI listener.
    const foreign = await (await import('../../helpers/devices.ts')).rawCall(w.uiPort, 'GET', '/api/sessions', { host: `localhost:${w.devicePort}`, cookie: `sb_token=${w.token}` });
    expect(foreign.status).toBe(403);
    expect((await w.ui('GET', '/pair')).status).toBe(404);
    expect((await w.ui('POST', '/device/v1/pair', { code: 'AAAA-AAAA' })).status).toBe(404);
    // The local UI is no device.
    expect((await w.ui('GET', '/api/device')).body).toMatchObject({ device: null, vapidPublicKey: null });
    expect((await w.ui('PUT', '/api/device/push', { events: { questions: false } })).status).toBe(404);
  });
});

describe('D73 pairing', () => {
  it('trades a one-time code for a device credential (HttpOnly, Secure, SameSite=Strict, __Host-); stored hashed; single use', async () => {
    world = await startDeviceWorld();
    const w = world;
    const code = await w.ui('POST', '/api/devices/pairing');
    expect(code.status).toBe(200);
    expect(code.body.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(code.body.url).toBe(`${w.origin}/pair#code=${code.body.code}`);
    expect(Date.parse(code.body.expiresAt) - Date.now()).toBeGreaterThan(DEVICE_CODE_TTL_MS - 5_000);
    const paired = await w.device('POST', '/device/v1/pair', { headers: { origin: w.origin, 'user-agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36' }, body: { code: code.body.code.toLowerCase() } });
    expect(paired.status).toBe(201);
    expect(paired.body.device).toMatchObject({ name: 'Android phone · Chrome', push: false });
    const setCookie = ([] as string[]).concat(paired.headers['set-cookie'] ?? [])[0] as string;
    expect(setCookie).toMatch(/^__Host-sb_device=[a-z2-7]{12}\.[A-Za-z0-9_-]{43}; /);
    for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=34560000']) expect(setCookie).toContain(attribute);
    expect(setCookie).not.toMatch(/Domain=/i);
    const cookie = deviceCookieOf(paired) as string;
    const secret = cookie.split('.')[1] as string;
    // Single use.
    const again = await w.device('POST', '/device/v1/pair', { body: { code: code.body.code } });
    expect(again.body.error).toBe('no-code');
    // Stored hashed only.
    const db = new DatabaseSync(w.store.file, { readOnly: true });
    try {
      const dump = JSON.stringify(db.prepare('SELECT * FROM devices').all());
      expect(dump).not.toContain(secret);
      expect((db.prepare('SELECT count(*) AS n FROM device_pairing_codes').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
    // The credential works.
    const sessions = await w.device('GET', '/api/sessions', { cookie });
    expect(sessions.status).toBe(200);
    const self = await w.device('GET', '/api/device', { cookie });
    expect(self.body.device).toMatchObject({ id: paired.body.device.id, name: 'Android phone · Chrome' });
    expect(self.body.vapidPublicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    // The UI page is served without the install token and refreshes the device cookie.
    const page = await w.device('GET', '/', { cookie, headers: HTML });
    expect(page.status).toBe(200);
    expect(page.text).toContain('switchboard-ui');
    const refreshed = ([] as string[]).concat(page.headers['set-cookie'] ?? []);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]).toMatch(/^__Host-sb_device=/);
    expect(refreshed.join()).not.toContain('sb_token');
    expect((await w.device('GET', '/pair', { cookie, headers: HTML })).headers.location).toBe('/');
    // A wrong secret for a real id is refused.
    const forged = `${cookie.split('.')[0]}.${'A'.repeat(43)}`;
    expect((await w.device('GET', '/api/sessions', { cookie: forged })).status).toBe(401);
    // Settings → Devices lists it.
    const view = await w.ui('GET', '/api/devices');
    expect(view.body.devices).toHaveLength(1);
    expect(JSON.stringify(view.body)).not.toContain(secret);
  });

  it('refuses a wrong code, burns it after five wrong tries, and needs device access on', async () => {
    world = await startDeviceWorld();
    const w = world;
    await w.ui('POST', '/api/devices/pairing');
    for (let i = 1; i <= 4; i++) expect((await w.device('POST', '/device/v1/pair', { body: { code: 'ZZZZ-ZZZZ' } })).body.error).toBe('wrong-code');
    expect((await w.device('POST', '/device/v1/pair', { body: { code: 'ZZZZ-ZZZZ' } })).body.error).toBe('too-many-tries');
    expect((await w.device('POST', '/device/v1/pair', { body: { code: 'ZZZZ-ZZZZ' } })).body.error).toBe('no-code');
    // Access off → no code.
    await w.ui('PUT', '/api/devices/access', { enabled: false });
    const off = await w.ui('POST', '/api/devices/pairing');
    expect(off.status).toBe(409);
    expect(off.body.error).toBe('access-off');
  });

  it('expires a code after 10 minutes and rate-limits pairing attempts (10 per 10 minutes)', async () => {
    let now = Date.now();
    world = await startDeviceWorld({ now: () => now });
    const w = world;
    await w.ui('POST', '/api/devices/pairing');
    now += DEVICE_CODE_TTL_MS + 1;
    expect((await w.device('POST', '/device/v1/pair', { body: { code: 'ZZZZ-ZZZZ' } })).body.error).toBe('expired');
    // 1 attempt so far in this window; 9 more are taken, the 11th is 429.
    for (let i = 0; i < 9; i++) expect((await w.device('POST', '/device/v1/pair', { body: { code: 'ZZZZ-ZZZZ' } })).status).toBe(400);
    const limited = await w.device('POST', '/device/v1/pair', { body: { code: 'ZZZZ-ZZZZ' } });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('rate-limited');
    // A right code is refused too while limited.
    const code = await w.ui('POST', '/api/devices/pairing');
    expect((await w.device('POST', '/device/v1/pair', { body: { code: code.body.code } })).status).toBe(429);
    // Once the window has passed, tries are taken again (with a fresh code: the old one expired meanwhile).
    now += 10 * 60_000 + 1;
    const fresh = await w.ui('POST', '/api/devices/pairing');
    expect((await w.device('POST', '/device/v1/pair', { body: { code: fresh.body.code } })).status).toBe(201);
  });

  it('checks the Tailscale login recorded at pairing', async () => {
    world = await startDeviceWorld();
    const w = world;
    const code = await w.ui('POST', '/api/devices/pairing');
    const paired = await w.device('POST', '/device/v1/pair', { headers: { 'tailscale-user-login': 'dev@example.com' }, body: { code: code.body.code, name: 'My phone' } });
    expect(paired.body.device.name).toBe('My phone');
    const cookie = deviceCookieOf(paired) as string;
    expect((await w.device('GET', '/api/sessions', { cookie, headers: { 'tailscale-user-login': 'dev@example.com' } })).status).toBe(200);
    expect((await w.device('GET', '/api/sessions', { cookie, headers: { 'tailscale-user-login': 'someone@example.com' } })).status).toBe(401);
    expect((await w.device('GET', '/api/sessions', { cookie })).status).toBe(401);
  });
});

describe('D73 paired devices', () => {
  it('are refused the local-only actions, also through a paired machine and with encoded paths', async () => {
    world = await startDeviceWorld();
    const w = world;
    const { cookie } = await w.pair();
    const refused: Array<[string, string, unknown?]> = [
      ['GET', '/api/devices'],
      ['PUT', '/api/devices/access', { enabled: false }],
      ['POST', '/api/devices/pairing'],
      ['DELETE', '/api/devices/abcdefghijkl'],
      ['POST', '/api/machines/pairing-code'],
      ['PUT', '/api/machines/listener', { enabled: true }],
      ['POST', '/api/hooks/install', {}],
      ['POST', '/api/mcp/servers', {}],
      ['PUT', '/api/mcp/servers/x', {}],
      ['POST', '/api/mcp/servers/x/toggle', {}],
      ['POST', '/api/updates/install', {}],
      ['PUT', '/api/service', { enabled: true }],
      ['PUT', '/api/clis/claude/command', { command: ['/bin/sh'] }],
      ['POST', '/api/accounts/profiles', {}],
      ['PUT', '/api/tools', []],
      ['POST', '/api/folders', { path: '/' }],
      ['GET', '/api/setup/folders'],
      ['POST', '/api/takeover/preview', {}],
      ['POST', '/api/machines/r1/api/mcp/servers', {}],
      ['POST', '/api/%64evices/pairing'],
      ['POST', '/api//hooks/install', {}],
    ];
    for (const [method, route, body] of refused) {
      const answer = await w.device(method, route, { cookie, body });
      expect(answer.status, `${method} ${route}`).toBe(403);
      expect(answer.body.error, `${method} ${route}`).toBe('local-only');
    }
    // The work itself is allowed.
    expect((await w.device('GET', '/api/machines', { cookie })).status).toBe(200);
    expect((await w.device('GET', '/api/inbox', { cookie })).status).toBe(200);
    expect((await w.device('GET', '/api/settings', { cookie })).status).toBe(200);
    // This machine's own UI still may.
    expect((await w.ui('GET', '/api/devices')).status).toBe(200);
  });

  it('revoking a device stops its access at once and closes its /hub stream', async () => {
    world = await startDeviceWorld();
    const w = world;
    const { cookie, id } = await w.pair();
    const stream = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: w.devicePort, path: '/hub', agent: false, headers: { host: `localhost:${w.devicePort}`, cookie, accept: 'text/event-stream' } }, resolve);
      req.once('error', reject);
      req.end();
    });
    expect(stream.statusCode).toBe(200);
    const ended = new Promise<void>((resolve) => {
      stream.once('close', () => resolve());
      stream.resume();
    });
    expect((await w.ui('DELETE', `/api/devices/${id}`)).status).toBe(204);
    await ended;
    expect((await w.device('GET', '/api/sessions', { cookie })).status).toBe(401);
    const page = await w.device('GET', '/', { cookie, headers: HTML });
    expect(page.status).toBe(302);
    // The stale cookie is cleared.
    expect(([] as string[]).concat(page.headers['set-cookie'] ?? []).join()).toMatch(/__Host-sb_device=; .*Max-Age=0/);
    expect((await w.ui('GET', '/api/devices')).body.devices).toEqual([]);
    expect((await w.ui('DELETE', `/api/devices/${id}`)).status).toBe(404);
  });

  it('can rename itself and is renamed from Settings → Devices', async () => {
    world = await startDeviceWorld();
    const w = world;
    const { cookie, id } = await w.pair();
    expect((await w.device('PUT', '/api/device', { cookie, body: { name: '  Kitchen   iPad ' } })).body.name).toBe('Kitchen iPad');
    expect((await w.ui('PUT', `/api/devices/${id}`, { name: 'Phone' })).body.name).toBe('Phone');
    expect((await w.ui('PUT', `/api/devices/${id}`, { name: '' })).status).toBe(422);
  });
});
