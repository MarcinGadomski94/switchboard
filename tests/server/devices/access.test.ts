import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type DeviceWorld, startDeviceWorld } from '../../helpers/devices.ts';

/**
 * D73 device access switch (`docs/devices.md` → *Transport*): off by default; on,
 * it starts the loopback device listener and `tailscale serve --bg --https=<port>`;
 * Settings shows why HTTPS is not available. `tailscale` is the fake CLI, which logs
 * its calls (`FAKE_TAILSCALE_LOG`).
 */

let world: DeviceWorld | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

async function calls(w: DeviceWorld): Promise<string[][]> {
  try {
    return (await readFile(path.join(w.dir, 'tailscale.log'), 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
}

describe('D73 device access', () => {
  it('is off by default: no device listener, no tailscale serve', async () => {
    world = await startDeviceWorld({ accessOff: true });
    const view = (await world.ui('GET', '/api/devices')).body;
    // Nothing listens for devices (the UI listener alone).
    expect(view.access).toEqual({ enabled: false, port: 13003, httpsPort: 8443, listening: null, origin: null, https: 'off', message: null, actionUrl: null });
    expect(view.devices).toEqual([]);
  });

  it('on: listener on loopback + tailscale serve on 8443 to it; off: serve off for its own port and the listener stops', async () => {
    world = await startDeviceWorld({ accessOff: true });
    const w = world;
    process.env['FAKE_TAILSCALE_LOG'] = path.join(w.dir, 'tailscale.log');
    try {
      const on = { body: await w.enableAccess() };
      expect(on.body).toMatchObject({ enabled: true, https: 'ok', listening: `127.0.0.1:${w.devicePort}`, origin: w.origin, httpsPort: 8443 });
      expect((await calls(w)).slice(-3)).toEqual([
        ['status', '--json'],
        ['serve', 'status', '--json'],
        ['serve', '--bg', '--https=8443', `http://127.0.0.1:${w.devicePort}`],
      ]);
      const off = await w.ui('PUT', '/api/devices/access', { enabled: false });
      expect(off.body).toMatchObject({ enabled: false, https: 'off', listening: null, origin: null });
      expect((await calls(w)).at(-1)).toEqual(['serve', '--https=8443', 'off']);
      // Refused values.
      expect((await w.ui('PUT', '/api/devices/access', { httpsPort: 444 })).status).toBe(422);
      expect((await w.ui('PUT', '/api/devices/access', { port: w.uiPort })).status).toBe(422);
      expect((await w.ui('PUT', '/api/devices/access', { enabled: 'yes' })).status).toBe(422);
    } finally {
      delete process.env['FAKE_TAILSCALE_LOG'];
    }
  });

  it('explains a tailnet without HTTPS certificates and starts nothing', async () => {
    world = await startDeviceWorld({ accessOff: true, env: { FAKE_TAILSCALE_HTTPS: 'off' } });
    const state = await world.enableAccess();
    expect(state).toMatchObject({ enabled: true, https: 'no-https', listening: null, origin: null });
    expect(state.message).toContain('HTTPS Certificates');
    expect((await world.ui('POST', '/api/devices/pairing')).status).toBe(409);
  });

  it('explains a stopped Tailscale, a missing CLI, the Serve consent link and a busy HTTPS port', async () => {
    world = await startDeviceWorld({ accessOff: true, env: { FAKE_TAILSCALE_STATE: 'Stopped' } });
    let state = await world.enableAccess();
    expect(state).toMatchObject({ https: 'no-tailscale', listening: null });
    await world.close();

    world = await startDeviceWorld({ accessOff: true, env: { FAKE_TAILSCALE_STATUS: 'fail' } });
    state = await world.enableAccess();
    expect(state.https).toBe('no-tailscale');
    expect(state.message).toContain('tailscaled');
    await world.close();

    world = await startDeviceWorld({ accessOff: true, env: { FAKE_TAILSCALE_SERVE: 'consent' } });
    state = await world.enableAccess();
    expect(state).toMatchObject({ https: 'serve-failed', listening: null, actionUrl: 'https://login.tailscale.com/f/serve?node=fake123' });
    await world.close();

    world = await startDeviceWorld({ accessOff: true, env: { FAKE_TAILSCALE_SERVE_STATUS: JSON.stringify({ TCP: { '8443': { HTTPS: true } }, Web: { 'devbox.example-tailnet.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } }) } });
    state = await world.enableAccess();
    expect(state).toMatchObject({ https: 'port-busy', listening: null });
  });
});
