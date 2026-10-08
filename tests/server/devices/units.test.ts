import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PUSH_EVENTS, deviceNameFromUserAgent, mergePushEvents, readPushEvents, shortText } from '../../../src/core/devices.ts';
import { MIGRATIONS_DIR } from '../../../src/server/db/migrate.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { isLocalOnly } from '../../../src/server/devices/local-only.ts';
import { parseTailscaleStatus, servedByOther, tailscaleActionUrl } from '../../../src/server/devices/tailscale-serve.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

describe('D73 local-only routes', () => {
  it('refuses machine administration and allows the work', () => {
    const refused: Array<[string, string]> = [
      ['GET', '/api/devices'],
      ['DELETE', '/api/devices/x'],
      ['POST', '/api/machines'],
      ['POST', '/api/machines/pairing-code'],
      ['PUT', '/api/machines/self'],
      ['PUT', '/api/machines/abc/sidebar-sync'],
      ['DELETE', '/api/machines/abc'],
      ['POST', '/api/hooks/install'],
      ['POST', '/api/hooks/remove'],
      ['POST', '/api/mcp/servers'],
      ['DELETE', '/api/mcp/servers/a'],
      ['POST', '/api/mcp/servers/a/auth'],
      ['GET', '/api/mcp/auth/x'],
      ['POST', '/api/mcp/cli/codex/servers'],
      ['DELETE', '/api/mcp/cli/codex/servers/a'],
      ['POST', '/api/updates/install'],
      ['POST', '/api/updates/check'],
      ['PUT', '/api/service'],
      ['PUT', '/api/clis/claude/command'],
      ['PUT', '/api/accounts/order'],
      ['POST', '/api/accounts/profiles/a/signin'],
      ['PUT', '/api/tools'],
      ['POST', '/api/frame-helper/reveal'],
      ['POST', '/api/folders'],
      ['DELETE', '/api/folders/a'],
      ['GET', '/api/setup/folders?path=/'],
      ['POST', '/api/setup/complete'],
      ['POST', '/api/takeover'],
      ['GET', '/api/takeover/runs/a'],
      ['POST', '/api/test/peers/drop'],
      // Through a paired machine's API.
      ['POST', '/api/machines/r1/api/mcp/servers'],
      ['POST', '/api/machines/r1/api/hooks/install'],
      // Encodings and doubled slashes.
      ['POST', '/api/%64evices/pairing'],
      ['POST', '/api//hooks/install'],
      ['GET', '/api/%E0%A4%A'],
    ];
    for (const [method, url] of refused) expect(isLocalOnly(method, url), `${method} ${url}`).toBe(true);
    const allowed: Array<[string, string]> = [
      ['GET', '/api/sessions'],
      ['POST', '/api/sessions'],
      ['POST', '/api/sessions/a/messages'],
      ['POST', '/api/questions/batch/b/answers'],
      ['POST', '/api/inbox/i/actions/allow-once'],
      ['GET', '/api/machines'],
      ['POST', '/api/machines/abc/reconnect'],
      ['GET', '/api/machines/r1/api/folders'],
      ['POST', '/api/machines/r1/api/sessions'],
      ['GET', '/api/mcp'],
      ['POST', '/api/mcp/servers/a/reconnect'],
      ['PUT', '/api/clis/default'],
      ['POST', '/api/sessions/a/account'],
      ['PUT', '/api/settings'],
      ['GET', '/api/device'],
      ['PUT', '/api/device/push'],
      ['POST', '/api/schedules'],
      ['GET', '/api/updates'],
      ['GET', '/hub'],
    ];
    for (const [method, url] of allowed) expect(isLocalOnly(method, url), `${method} ${url}`).toBe(false);
  });
});

describe('D73 helpers', () => {
  it('names devices from their user agent', () => {
    expect(deviceNameFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari');
    expect(deviceNameFromUserAgent('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1')).toBe('iPad · Chrome');
    expect(deviceNameFromUserAgent('Mozilla/5.0 (Linux; Android 15; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36')).toBe('Android tablet · Chrome');
    expect(deviceNameFromUserAgent(undefined)).toBe('Device');
  });

  it('merges push toggles strictly and reads stored ones leniently', () => {
    expect(mergePushEvents(DEFAULT_PUSH_EVENTS, { turnFinished: false })).toEqual({ ...DEFAULT_PUSH_EVENTS, turnFinished: false });
    expect(mergePushEvents(DEFAULT_PUSH_EVENTS, { nope: true })).toBeNull();
    expect(mergePushEvents(DEFAULT_PUSH_EVENTS, { errors: 'no' })).toBeNull();
    expect(readPushEvents({ inbox: false, junk: 1 })).toEqual({ ...DEFAULT_PUSH_EVENTS, inbox: false });
    expect(shortText('a  b\n c', 140)).toBe('a b c');
    expect(shortText('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('reads tailscale status and serve status', () => {
    const status = parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'DevBox.Example-Tailnet.ts.net.' }, CertDomains: ['devbox.example-tailnet.ts.net'], CurrentTailnet: { MagicDNSEnabled: true } }));
    expect(status).toEqual({ backendState: 'Running', dnsName: 'devbox.example-tailnet.ts.net', certDomains: ['devbox.example-tailnet.ts.net'], magicDns: true });
    expect(parseTailscaleStatus('{"Self":{"DNSName":"bad name;"},"CertDomains":null}')).toMatchObject({ dnsName: null, certDomains: [] });
    expect(parseTailscaleStatus('not json')).toBeNull();
    const ours = 'http://127.0.0.1:13003';
    expect(servedByOther('{}', 8443, ours)).toBe(false);
    expect(servedByOther(JSON.stringify({ TCP: { '443': { HTTPS: true } } }), 8443, ours)).toBe(false);
    expect(servedByOther(JSON.stringify({ TCP: { '8443': { HTTPS: true } }, Web: { 'h.ts.net:8443': { Handlers: { '/': { Proxy: ours } } } } }), 8443, ours)).toBe(false);
    expect(servedByOther(JSON.stringify({ TCP: { '8443': { HTTPS: true } }, Web: { 'h.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } }), 8443, ours)).toBe(true);
    expect(servedByOther(JSON.stringify({ TCP: { '8443': { TCPForward: '127.0.0.1:22' } } }), 8443, ours)).toBe(true);
    expect(tailscaleActionUrl('To enable, visit:\n  https://login.tailscale.com/f/serve?node=abc\n')).toBe('https://login.tailscale.com/f/serve?node=abc');
  });
});

describe('D73 migration 0030', () => {
  let tmp: string;
  let store: Store;
  beforeEach(async () => {
    tmp = await makeTempDir('devices-db');
    store = await openTempStore(tmp);
  });
  afterEach(async () => {
    await store.close();
    await removeTempDir(tmp);
  });

  it('adds devices, pairing codes and push subscriptions; revoking deletes the subscription', async () => {
    expect(store.migrations.applied).toContain(30);
    const sql = await readFile(path.join(MIGRATIONS_DIR, '0030_devices.sql'), 'utf8');
    expect(sql).toContain('CREATE TABLE devices');
    const device = await store.devices.create({ id: 'abcdefghijkl', name: 'Phone', credentialHash: 'h'.repeat(43) });
    expect(device).toMatchObject({ name: 'Phone', userAgent: null, tailscaleLogin: null, lastSeenAt: null });
    await store.devices.savePush({ deviceId: device.id, endpoint: 'https://web.push.apple.com/x', p256dh: 'p', auth: 'a', events: { questions: true } });
    expect((await store.devices.push(device.id))?.events).toEqual({ questions: true });
    await store.devices.replaceCode({ id: 'c1', codeHash: 'x', expiresAt: '2026-10-08T00:00:00.000Z' });
    await store.devices.replaceCode({ id: 'c2', codeHash: 'y', expiresAt: '2026-10-08T00:00:00.000Z' });
    expect((await store.devices.currentCode())?.id).toBe('c2');
    expect(store.db.prepare('SELECT count(*) AS n FROM device_pairing_codes').get()).toEqual({ n: 1 });
    expect(() => store.db.prepare("INSERT INTO devices (id, name, credential_hash, paired_at) VALUES ('b', '', 'z', 'now')").run()).toThrow();
    expect(await store.devices.delete(device.id)).toBe(true);
    expect(await store.devices.push(device.id)).toBeNull();
  });
});
